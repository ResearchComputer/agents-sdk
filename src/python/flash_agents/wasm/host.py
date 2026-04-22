"""WASM host: load core.wasm, verify its SHA, instantiate the component,
bind host imports.

Concurrency contract (for future use):
- Every guest call runs on a worker thread via asyncio.to_thread(...).
- The agent captures its creator loop at Agent.create() time.
- Tool dispatch bridges worker thread -> main loop via
  asyncio.run_coroutine_threadsafe(..., captured_loop).result().

Status: SHA verification + component instantiation + host-imports binding
are wired. Calling the exported `[method]agent.prompt` currently hits a
wasmtime-py 44.0.0 borrow-handle limitation in its Component Model
bindings (see WasmHost.prompt_once for details). That last mile needs
either a wasmtime-py upgrade or a Rust+PyO3 host shim.
"""

from __future__ import annotations

import hashlib
import pathlib
from typing import Any, Callable

import wasmtime
from wasmtime import Engine, Store, WasiConfig, WasmtimeError
from wasmtime.component import (
    Component,
    Linker,
    ResourceType,
    ResourceHost,
)

from flash_agents.errors import WasmHostError


_WASM_DIR = pathlib.Path(__file__).parent
_CORE_WASM = _WASM_DIR / "core.wasm"
_SHA_FILE = _WASM_DIR / "CORE_WASM_SHA256.txt"

# Host resource type identifier we assign to llm-stream; wasmtime-py
# needs an integer to uniquely identify the host-defined resource type.
_LLM_STREAM_TYPE_ID = 1


def _verify_sha256(wasm_path: pathlib.Path, sha_file: pathlib.Path) -> None:
    if not wasm_path.exists():
        raise WasmHostError(
            f"core.wasm not found at {wasm_path}. Run `bun run build:wasm:python` "
            f"from the repo root before installing flash-agents from source."
        )
    if not sha_file.exists():
        raise WasmHostError(
            f"CORE_WASM_SHA256.txt not found at {sha_file}. Rebuild core.wasm."
        )
    expected = sha_file.read_text().strip().lower()
    actual = hashlib.sha256(wasm_path.read_bytes()).hexdigest().lower()
    if expected != actual:
        raise WasmHostError(
            f"SHA256 mismatch on core.wasm: expected {expected}, got {actual}. "
            f"Rebuild via `bun run build:wasm:python`."
        )


class WasmHost:
    """Loads core.wasm and binds host imports. One host per Agent instance.

    Responsibilities covered:
      - SHA256 verification of core.wasm.
      - wasmtime Engine/Store/Component setup with WasiConfig.
      - Linker with WASIp2 + host-llm (llm-stream resource + stream-llm +
        [method]llm-stream.next) + host-tools (list-tools + execute-tool).
      - Export lookup for [constructor]agent, [method]agent.prompt, and
        [method]event-stream.next.

    Known gap: calling [method]agent.prompt triggers a wasmtime-py 44.0.0
    borrow-handle issue where the method's `self: borrow<agent>` clone
    lingers past the call. See prompt_once().
    """

    def __init__(
        self,
        *,
        host_llm_stream: Callable[[dict], Any],
        host_llm_stream_next: Callable[[], Any],
        host_tools_list: Callable[[], str],
        host_tools_execute: Callable[[dict], dict],
    ) -> None:
        _verify_sha256(_CORE_WASM, _SHA_FILE)
        self._engine = Engine()
        self._store = Store(self._engine)
        wasi = WasiConfig()
        wasi.inherit_stdout()
        wasi.inherit_stderr()
        self._store.set_wasi(wasi)
        self._component = Component.from_file(self._engine, str(_CORE_WASM))

        linker = Linker(self._engine)
        linker.add_wasip2()

        llm_stream_ty = ResourceType.host(_LLM_STREAM_TYPE_ID)

        def _llm_stream_dtor(_store: Any, _rep: int) -> None:
            # wasmtime calls this when the guest drops its llm-stream. We
            # don't keep per-stream state on the Python side (each stream
            # owns its own async iterator captured in the closure of
            # host_llm_stream_next).
            return None

        def _stream_llm_trampoline(store: Any, req: Any) -> ResourceHost:
            # wasmtime hands us an opaque Record object whose attributes
            # match the WIT field names (kebab-case). Convert to dict.
            req_dict = {
                name: getattr(req, name)
                for name in (
                    "model-id", "provider", "api", "system-prompt",
                    "messages-json", "tools-json", "options-json",
                )
            }
            host_llm_stream(req_dict)
            # rep is unused in this design; we only drive one stream at a
            # time per agent and the host function carries all state.
            return ResourceHost.own(0, _LLM_STREAM_TYPE_ID)

        def _llm_stream_next_trampoline(_store: Any, self_r: Any) -> Any:
            # Explicitly release the incoming borrow handle to help wasmtime
            # reconcile refcounts. (See known-issue in docstring; this
            # alone does not resolve the borrow-leak on the prompt path.)
            try:
                self_r.close()
            except Exception:
                pass
            return host_llm_stream_next()

        def _list_tools_trampoline(_store: Any) -> str:
            return host_tools_list()

        def _execute_tool_trampoline(_store: Any, call_record: Any) -> Any:
            call_dict = {
                "callId": getattr(call_record, "call-id"),
                "toolName": getattr(call_record, "tool-name"),
                "inputJson": getattr(call_record, "input-json"),
            }
            result = host_tools_execute(call_dict)
            # Build the tool-result WIT record expected by the guest.
            r = type("ToolResultRecord", (), {})()
            setattr(r, "call-id", result.get("callId", ""))
            setattr(r, "is-error", bool(result.get("isError", False)))
            setattr(r, "output-json", result.get("outputJson", ""))
            return r

        with linker.root() as root:
            with root.add_instance("research-computer:flash-agents/host-llm@0.1.0") as iface:
                iface.add_resource("llm-stream", llm_stream_ty, _llm_stream_dtor)
                iface.add_func("stream-llm", _stream_llm_trampoline)
                iface.add_func("[method]llm-stream.next", _llm_stream_next_trampoline)
            with root.add_instance("research-computer:flash-agents/host-tools@0.1.0") as iface:
                iface.add_func("list-tools", _list_tools_trampoline)
                iface.add_func("execute-tool", _execute_tool_trampoline)

        self._instance = linker.instantiate(self._store, self._component)

        iface_idx = self._instance.get_export_index(
            self._store, "research-computer:flash-agents/agent@0.1.0",
        )
        if iface_idx is None:
            raise WasmHostError("component does not export research-computer:flash-agents/agent")

        ctor_idx = self._instance.get_export_index(self._store, "[constructor]agent", iface_idx)
        prompt_idx = self._instance.get_export_index(self._store, "[method]agent.prompt", iface_idx)
        next_idx = self._instance.get_export_index(self._store, "[method]event-stream.next", iface_idx)

        self._ctor = self._instance.get_func(self._store, ctor_idx)
        self._prompt = self._instance.get_func(self._store, prompt_idx)
        self._event_stream_next = self._instance.get_func(self._store, next_idx)

        if not (self._ctor and self._prompt and self._event_stream_next):
            raise WasmHostError("expected agent/event-stream exports missing from component")

        self._agent_resource: Any | None = None

    def new_agent(self, config_json: str) -> None:
        """Call [constructor]agent(config-json). Must be called once before prompt_once."""
        if self._agent_resource is not None:
            raise WasmHostError("agent already constructed in this host")
        self._agent_resource = self._ctor(self._store, config_json)

    def prompt_once(self, message: str, extra_system: str | None) -> Any:
        """Call [method]agent.prompt. Returns the event-stream resource.

        Known wasmtime-py 44.0.0 limitation: this call surfaces the
        "borrow handles still remain at the end of the call" error from
        wasmtime-c-api because BorrowType.convert_to_c uses
        `wasmtime_component_resource_any_clone` without a corresponding
        drop at call exit. Upstream fix (or a Rust+PyO3 shim) is needed
        before this path lights up.
        """
        if self._agent_resource is None:
            raise WasmHostError("agent not constructed; call new_agent() first")
        return self._prompt(self._store, self._agent_resource, message, extra_system)

    def event_stream_next(self, stream_handle: Any) -> str | None:
        return self._event_stream_next(self._store, stream_handle)
