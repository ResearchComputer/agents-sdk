//! Per-instance wasmtime store data.

use pyo3::prelude::*;
use wasmtime::component::ResourceTable;
use wasmtime_wasi::{WasiCtx, WasiCtxView, WasiView};
use wasmtime_wasi_http::p2::{WasiHttpCtxView, WasiHttpView};
use wasmtime_wasi_http::WasiHttpCtx;

pub struct State {
    pub wasi: WasiCtx,
    pub http: WasiHttpCtx,
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
    pub http_hooks: [(); 0],
}

impl WasiView for State {
    fn ctx(&mut self) -> WasiCtxView<'_> {
        WasiCtxView {
            ctx: &mut self.wasi,
            table: &mut self.table,
        }
    }
}

impl WasiHttpView for State {
    fn http(&mut self) -> WasiHttpCtxView<'_> {
        WasiHttpCtxView {
            ctx: &mut self.http,
            table: &mut self.table,
            hooks: &mut self.http_hooks,
        }
    }
}
