//! host-tools interface: list_tools + execute_tool, both delegating to
//! Python-supplied callbacks stored on State.

use pyo3::prelude::*;
use pyo3::types::PyDict;

use crate::bindings::research_computer::flash_agents::host_tools::{
    Host, ToolCall, ToolResult,
};
use crate::state::State;

impl Host for State {
    async fn list_tools(&mut self) -> wasmtime::Result<String> {
        let result = Python::attach(|py| -> PyResult<String> {
            let cb = self.list_tools_callback.clone_ref(py);
            let out = cb.call0(py)?;
            out.extract::<String>(py)
        })?;
        Ok(result)
    }

    async fn execute_tool(&mut self, call: ToolCall) -> wasmtime::Result<ToolResult> {
        // Call the Python async def execute_tool_callback with a dict
        // matching the WIT record, then await the coroutine.
        let fut = Python::attach(|py| -> PyResult<_> {
            let cb = self.execute_tool_callback.clone_ref(py);
            let kwargs = PyDict::new(py);
            kwargs.set_item("callId", &call.call_id)?;
            kwargs.set_item("toolName", &call.tool_name)?;
            kwargs.set_item("inputJson", &call.input_json)?;
            let awaitable = cb.call(py, (), Some(&kwargs))?;
            pyo3_async_runtimes::tokio::into_future(awaitable.into_bound(py))
        })?;
        let py_result = fut.await?;
        let (call_id, is_error, output_json) = Python::attach(|py| -> PyResult<_> {
            let d = py_result.bind(py).cast::<PyDict>()?;
            let call_id: String = d
                .get_item("callId")?
                .ok_or_else(|| pyo3::exceptions::PyValueError::new_err("missing callId"))?
                .extract()?;
            let is_error: bool = d
                .get_item("isError")?
                .ok_or_else(|| pyo3::exceptions::PyValueError::new_err("missing isError"))?
                .extract()?;
            let output_json: String = d
                .get_item("outputJson")?
                .ok_or_else(|| pyo3::exceptions::PyValueError::new_err("missing outputJson"))?
                .extract()?;
            Ok((call_id, is_error, output_json))
        })?;
        Ok(ToolResult {
            call_id,
            is_error,
            output_json,
        })
    }
}
