//! PyO3 Agent + EventStream classes.

use std::sync::Arc;

use pyo3::exceptions::PyRuntimeError;
use pyo3::prelude::*;
use tokio::sync::Mutex;
use wasmtime::component::{Component, HasSelf, Linker, ResourceAny, ResourceTable};
use wasmtime::{Config, Engine, Store};
use wasmtime_wasi::WasiCtxBuilder;

use crate::bindings::FlashAgentCore;
use crate::state::State;

struct Core {
    store: Store<State>,
    bindings: FlashAgentCore,
    agent: ResourceAny,
}

type Shared = Arc<Mutex<Option<Core>>>;

#[pyclass]
pub struct Agent {
    inner: Shared,
}

#[pymethods]
impl Agent {
    #[staticmethod]
    #[pyo3(signature = (wasm_path, llm_stream_factory, list_tools_callback, execute_tool_callback, config_json))]
    fn create<'py>(
        py: Python<'py>,
        wasm_path: String,
        llm_stream_factory: Py<PyAny>,
        list_tools_callback: Py<PyAny>,
        execute_tool_callback: Py<PyAny>,
        config_json: String,
    ) -> PyResult<Bound<'py, PyAny>> {
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let core = build_core(
                wasm_path,
                llm_stream_factory,
                list_tools_callback,
                execute_tool_callback,
                config_json,
            )
            .await
            .map_err(wasmtime_to_py)?;
            let agent = Agent {
                inner: Arc::new(Mutex::new(Some(core))),
            };
            Python::attach(|py| Py::new(py, agent).map(|obj| obj.into_any()))
        })
    }

    #[pyo3(signature = (message, extra_system=None))]
    fn prompt<'py>(
        &self,
        py: Python<'py>,
        message: String,
        extra_system: Option<String>,
    ) -> PyResult<Bound<'py, PyAny>> {
        let inner = Arc::clone(&self.inner);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let event_stream = {
                let mut guard = inner.lock().await;
                let core = guard
                    .as_mut()
                    .ok_or_else(|| PyRuntimeError::new_err("Agent disposed"))?;
                let handle = core
                    .bindings
                    .research_computer_flash_agents_agent()
                    .agent()
                    .call_prompt(&mut core.store, core.agent, &message, extra_system.as_deref())
                    .await
                    .map_err(wasmtime_to_py)?;
                EventStream {
                    inner: Arc::clone(&inner),
                    resource: handle,
                    dropped: false,
                }
            };
            Python::attach(|py| Py::new(py, event_stream).map(|obj| obj.into_any()))
        })
    }

    fn dispose<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = Arc::clone(&self.inner);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = inner.lock().await;
            if let Some(mut core) = guard.take() {
                let _ = core.agent.resource_drop_async(&mut core.store).await;
            }
            Python::attach(|py| Ok::<Py<PyAny>, PyErr>(py.None()))
        })
    }

    fn __repr__(&self) -> String {
        "<flash_agents_wasm.Agent>".to_string()
    }
}

#[pyclass]
pub struct EventStream {
    inner: Shared,
    resource: ResourceAny,
    dropped: bool,
}

#[pymethods]
impl EventStream {
    fn next<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = Arc::clone(&self.inner);
        let resource = self.resource;
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            let mut guard = inner.lock().await;
            let core = guard
                .as_mut()
                .ok_or_else(|| PyRuntimeError::new_err("agent disposed"))?;
            let event = core
                .bindings
                .research_computer_flash_agents_agent()
                .event_stream()
                .call_next(&mut core.store, resource)
                .await
                .map_err(wasmtime_to_py)?;
            Python::attach(|py| -> PyResult<Py<PyAny>> {
                match event {
                    Some(s) => Ok(s.into_pyobject(py)?.into_any().unbind()),
                    None => Ok(py.None()),
                }
            })
        })
    }

    fn close<'py>(&mut self, py: Python<'py>) -> PyResult<Bound<'py, PyAny>> {
        let inner = Arc::clone(&self.inner);
        let resource = self.resource;
        let already_dropped = std::mem::replace(&mut self.dropped, true);
        pyo3_async_runtimes::tokio::future_into_py(py, async move {
            if already_dropped {
                return Python::attach(|py| Ok::<Py<PyAny>, PyErr>(py.None()));
            }
            let mut guard = inner.lock().await;
            if let Some(core) = guard.as_mut() {
                let _ = resource.resource_drop_async(&mut core.store).await;
            }
            Python::attach(|py| Ok::<Py<PyAny>, PyErr>(py.None()))
        })
    }
}

async fn build_core(
    wasm_path: String,
    stream_llm_factory: Py<PyAny>,
    list_tools_callback: Py<PyAny>,
    execute_tool_callback: Py<PyAny>,
    config_json: String,
) -> wasmtime::Result<Core> {
    use wasmtime::error::Context as _;

    let cfg = Config::new();
    let engine = Engine::new(&cfg).context("construct wasmtime Engine")?;

    let component = Component::from_file(&engine, &wasm_path)
        .with_context(|| format!("load component from {wasm_path}"))?;

    let mut linker: Linker<State> = Linker::new(&engine);
    wasmtime_wasi::p2::add_to_linker_async(&mut linker).context("add wasi to linker")?;
    // wasmtime_wasi_http intentionally NOT added: core.wasm is built with
    // --disable http --disable fetch-event so no guest import references it.
    // Keeping it in the linker pulled ~15MB of hyper/rustls surface into
    // the Rust extension for zero benefit.
    FlashAgentCore::add_to_linker::<_, HasSelf<_>>(&mut linker, |state: &mut State| state)
        .context("add host imports to linker")?;

    let state = State {
        wasi: WasiCtxBuilder::new().inherit_stdio().build(),
        table: ResourceTable::new(),
        stream_llm_factory,
        list_tools_callback,
        execute_tool_callback,
    };
    let mut store = Store::new(&engine, state);

    let bindings = FlashAgentCore::instantiate_async(&mut store, &component, &linker)
        .await
        .context("instantiate component")?;

    let agent = bindings
        .research_computer_flash_agents_agent()
        .agent()
        .call_constructor(&mut store, &config_json)
        .await
        .context("call agent constructor")?;

    Ok(Core {
        store,
        bindings,
        agent,
    })
}

fn wasmtime_to_py(err: wasmtime::Error) -> PyErr {
    let anyhow_err: anyhow::Error = err.into();
    PyRuntimeError::new_err(format!("{anyhow_err:?}"))
}
