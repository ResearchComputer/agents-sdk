//! Host-owned `llm-stream` resource and the free-function `stream-llm` that
//! manufactures it.
//!
//! The guest (componentize-js JavaScript) holds an opaque
//! `Resource<LlmStream>` and calls `.next()` on it in a loop. Each call
//! round-trips through wasmtime into our async trait impl here, which in
//! turn drives a Python async iterator via `pyo3-async-runtimes`.
//!
//! Key implementation notes:
//! * WIT-level `next: func() -> option<string>` is sync, but wasmtime can
//!   still drive an async Rust impl — it parks the guest task on the future
//!   and resumes when it resolves. This is the Q1-fallback behaviour the
//!   plan was designed around.
//! * StopAsyncIteration from Python maps cleanly to `None` (end of stream).
//! * The Python iterator lives in the wasmtime `ResourceTable`, keyed by
//!   the guest-facing handle, so drops are explicit and deterministic.

use pyo3::exceptions::PyStopAsyncIteration;
use pyo3::prelude::*;
use pyo3::types::PyDict;
use wasmtime::component::Resource;

use crate::bindings::research_computer::flash_agents::host_llm::{
    Host, HostLlmStream as HostLlmStreamTrait, LlmRequest, LlmStream,
};
use crate::state::State;

/// The actual storage cell for an in-flight LLM stream. The Python side
/// constructs an async iterator once and we keep a strong reference for
/// the lifetime of the guest's handle.
pub struct HostLlmStream {
    /// Python `async def` iterator; `__anext__` yields JSON strings.
    pub iterator: Py<PyAny>,
}

impl HostLlmStream {
    pub fn new(iterator: Py<PyAny>) -> Self {
        Self { iterator }
    }
}

// All bindgen-generated host traits return `wasmtime::Result<T>`, which is a
// distinct alias from `anyhow::Result<T>`. We build our own Results with
// `anyhow::Error` and let `?` / `map_err` convert into `wasmtime::Error`
// (which wraps `anyhow`).

impl HostLlmStreamTrait for State {
    async fn next(&mut self, handle: Resource<LlmStream>) -> wasmtime::Result<Option<String>> {
        // Pull the Python iterator out of the table, then drop the borrow
        // before awaiting — pyo3 callbacks must not hold &mut self across
        // .await.
        let iter: Py<PyAny> = {
            let entry = self.table.get(&handle)?;
            Python::attach(|py| entry.iterator.clone_ref(py))
        };

        // Call Python's `__anext__` and convert the awaitable into a Rust
        // future via pyo3-async-runtimes.
        let fut = Python::attach(|py| -> PyResult<_> {
            let awaitable = iter.call_method0(py, "__anext__")?;
            pyo3_async_runtimes::tokio::into_future(awaitable.into_bound(py))
        })?;

        match fut.await {
            Ok(val) => {
                let s: String = Python::attach(|py| val.extract::<String>(py))?;
                Ok(Some(s))
            }
            Err(err) => {
                let is_stop = Python::attach(|py| err.is_instance_of::<PyStopAsyncIteration>(py));
                if is_stop {
                    Ok(None)
                } else {
                    Err(err.into())
                }
            }
        }
    }

    async fn drop(&mut self, handle: Resource<LlmStream>) -> wasmtime::Result<()> {
        // Releasing the Py<PyAny> requires the GIL; grab one and drop it
        // there. `table.delete` would otherwise drop the iterator on the
        // current thread without the GIL, which panics.
        let stream = self.table.delete(handle)?;
        Python::attach(|_py| {
            drop(stream);
        });
        Ok(())
    }
}

impl Host for State {
    async fn stream_llm(&mut self, req: LlmRequest) -> wasmtime::Result<Resource<LlmStream>> {
        // Hand the decoded WIT record off to the Python-provided factory,
        // which returns an async iterator we store in the ResourceTable.
        let iterator = Python::attach(|py| -> PyResult<Py<PyAny>> {
            let factory = self.stream_llm_factory.clone_ref(py);
            let kwargs = PyDict::new(py);
            kwargs.set_item("model_id", &req.model_id)?;
            kwargs.set_item("provider", &req.provider)?;
            kwargs.set_item("api", &req.api)?;
            kwargs.set_item("system_prompt", &req.system_prompt)?;
            kwargs.set_item("messages_json", &req.messages_json)?;
            kwargs.set_item("tools_json", &req.tools_json)?;
            kwargs.set_item("options_json", &req.options_json)?;
            // The factory is an `async def` that returns an async iterator
            // (possibly after awaiting). We delegate the unwrapping of
            // that to Task 2.5.4 / the Python side — for now we keep a
            // reference to whatever Python returned and call `__anext__`
            // on it when the guest next polls.
            let result = factory.call(py, (), Some(&kwargs))?;
            Ok(result.into())
        })?;

        let handle = self.table.push(HostLlmStream::new(iterator))?;
        Ok(handle)
    }
}
