"""Smoke: WasmHost loads core.wasm, instantiates with no-op hosts,
constructs an agent, and resolves exports.

prompt_once is expected to fail against wasmtime-py 44.0.0 due to the
borrow-handle leak documented on WasmHost.prompt_once. That case is
asserted explicitly so future wasmtime-py upgrades flip this test
from asserting failure to asserting success.
"""
from __future__ import annotations

import json

import pytest

from flash_agents.errors import WasmHostError
from flash_agents.wasm.host import WasmHost


def _make_host(stream_fn, stream_next_fn) -> WasmHost:
    return WasmHost(
        host_llm_stream=stream_fn,
        host_llm_stream_next=stream_next_fn,
        host_tools_list=lambda: "[]",
        host_tools_execute=lambda call: {
            "callId": call.get("callId", ""),
            "isError": True,
            "outputJson": json.dumps({"error": "no tools", "type": "NoopHost"}),
        },
    )


def test_component_instantiates_and_constructs_agent() -> None:
    host = _make_host(lambda req: None, lambda: None)
    config = json.dumps({
        "model": {"id": "mock", "provider": "openai", "api": "openai-completions"},
        "systemPrompt": "SYS",
    })
    host.new_agent(config)


def test_prompt_currently_blocked_by_wasmtime_py_borrow_leak() -> None:
    """Documents the known wasmtime-py 44.0.0 limitation.

    When this test starts FAILING (i.e. prompt succeeds), upgrade the
    host to actually drive turns and flip this assertion.
    """
    events = iter([
        json.dumps({
            "type": "done",
            "reason": "stop",
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "ok"}],
                "api": "openai-completions", "provider": "openai", "model": "mock",
                "timestamp": 0,
                "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0,
                          "totalTokens": 0,
                          "cost": {"input": 0, "output": 0, "cacheRead": 0,
                                   "cacheWrite": 0, "total": 0}},
                "stopReason": "stop",
            },
        }),
    ])
    host = _make_host(
        stream_fn=lambda req: None,
        stream_next_fn=lambda: next(events, None),
    )
    host.new_agent(json.dumps({
        "model": {"id": "mock", "provider": "openai", "api": "openai-completions"},
        "systemPrompt": "",
    }))
    # wasmtime-py 44.0.0 raises "borrow handles still remain at the end of the call"
    # from the underlying wasmtime Rust runtime. When this expectation stops holding,
    # replace with a real event-drain assertion.
    with pytest.raises(Exception) as excinfo:
        host.prompt_once("hello", None)
    assert "borrow handles still remain" in str(excinfo.value)
