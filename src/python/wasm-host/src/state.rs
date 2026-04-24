//! Per-instance wasmtime store data.

use pyo3::prelude::*;
use wasmtime::component::ResourceTable;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};

pub struct State {
    pub wasi: WasiCtx,
    pub table: ResourceTable,
    /// Python `async def` callable returning an AsyncIterator[str] of
    /// pi-ai AssistantMessageEvent JSON strings.
    pub stream_llm_factory: Py<PyAny>,
    /// Python callable returning a JSON array of tool declarations.
    /// Called once at Agent construction time.
    pub list_tools_callback: Py<PyAny>,
    /// Python `async def` callable invoked when the core runs a tool.
    /// Receives a dict with callId/toolName/inputJson; returns a dict
    /// with callId/isError/outputJson.
    pub execute_tool_callback: Py<PyAny>,
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}
