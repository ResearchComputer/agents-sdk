# WASM Component Embedding ABI — `world.wit`

The contract between a host process and the `core.wasm` component built from `@researchcomputer/agents-sdk/core`. Use this file when:

- you are embedding the agent loop in a non-JS host (Rust, Python, Go, …) and want a stable, language-neutral ABI, or
- you are writing a new reference host alongside the `flash-agents` Python SDK.

The authoritative ABI lives at [`../../src/python/wit/world.wit`](../../src/python/wit/world.wit). When this file and `world.wit` disagree, `world.wit` wins; please open an issue so the prose can catch up.

For the how-to side — "walk me through embedding the core end-to-end" — see [`../embedding-core.md`](../embedding-core.md). This file is the ABI reference; that one is the guide.

## Component Model primer

The SDK's core is compiled to a [WebAssembly Component](https://component-model.bytecodealliance.org/). A component is a WASM module with a declared, language-independent interface written in [WIT](https://component-model.bytecodealliance.org/design/wit.html). Any host that speaks the Component Model can load the `core.wasm` artifact and call it through the generated bindings.

Build the artifact once from the repo root:

```bash
bun run build:wasm
# → src/python/flash_agents/wasm/core.wasm
```

Under the hood, `build:wasm` is a three-step pipeline (`build:wasm:python:bundle` + `build:wasm:python:componentize` + `build:wasm:python:sha`):

1. `bundle` invokes `Bun.build()` (via `src/python/wasm-guest/bun-build.ts`) over the guest shim at `src/python/wasm-guest/entrypoint.ts` plus `src/core/` and its ES-module dependencies, producing `core.bundle.js`.
2. `componentize` wraps the bundle with [`jco componentize`](https://github.com/bytecodealliance/jco) using the WIT world declared below, emitting `core.wasm`.
3. `sha` writes a JSON `CORE_WASM_SHA256.txt` sidecar used by the Python host to detect build-artifact staleness.

## The `world.wit` contract

Copied verbatim from `src/python/wit/world.wit`. If the snippet below differs from the source file, treat the source file as authoritative.

```wit
package research-computer:flash-agents@0.1.0;

interface host-llm {
  record llm-request {
    model-id:      string,
    provider:      string,
    api:           string,
    system-prompt: string,
    messages-json: string,
    tools-json:    string,
    options-json:  string,
  }

  resource llm-stream {
    next: func() -> option<string>;
  }

  stream-llm: func(req: llm-request) -> llm-stream;
}

interface host-tools {
  record tool-call {
    call-id:    string,
    tool-name:  string,
    input-json: string,
  }

  record tool-result {
    call-id:    string,
    is-error:   bool,
    output-json: string,
  }

  list-tools: func() -> string;

  execute-tool: func(call: tool-call) -> tool-result;
}

interface agent {
  resource agent {
    constructor(config-json: string);
    prompt: func(message: string, extra-system: option<string>) -> event-stream;
  }

  resource event-stream {
    next: func() -> option<string>;
  }
}

world flash-agent-core {
  import host-llm;
  import host-tools;
  export agent;
}
```

Three interfaces cross the boundary: `host-llm` (host → guest), `host-tools` (host → guest), and `agent` (guest → host).

### `host-llm` interface (host provides, guest imports)

**Semantics:**

- The guest calls `stream-llm(req)` once per LLM turn. The host returns a `llm-stream` resource.
- The guest calls `next()` on the stream in a loop. Each call returns one SSE-shaped chunk as a JSON string, or `none` when the stream is exhausted.
- All complex fields (`messages-json`, `tools-json`, `options-json`, and the per-chunk payloads) are JSON strings conforming to the `pi-ai` wire format. The Python SDK's `src/python/flash_agents/llm/message_translate.py` is a reference translator between `pi-ai` and OpenAI chat-completions format.
- `stream-llm` and `next` are synchronous at the WIT level. Hosts with async internals (e.g., `aiohttp`, `reqwest`) must synchronize before returning. The reference Python host does this by running async code on a wasmtime-driven tokio runtime via PyO3; see `src/python/wasm-host/src/host_llm.rs`.

**Error propagation:** to signal an LLM error, the host returns a chunk whose JSON shape matches pi-ai's error event. The guest surfaces this as an assistant message with `stopReason: "error"` and closes the turn cleanly. The guest never panics on a malformed chunk — it treats it as an error chunk and ends the turn. The reference Python host decoder (`src/python/flash_agents/llm/message_translate.py`) no-ops `make_error_event` when a terminal event (`done` or `error`) has already been emitted, matching pi-ai's "one terminal event per stream" contract.

### `host-tools` interface (host provides, guest imports)

**Semantics:**

- `list-tools()` is called once at agent-construction time. It returns a JSON array of tool declarations (name, description, parameters schema). The guest uses this list to wire the tool surface into the LLM prompt.
- `execute-tool(call)` is called whenever the guest executes a tool call. The input carries a `call-id` (echoed back), the tool name, and a JSON string of input args. The host returns a `tool-result` with the echoed `call-id`, an `is-error` flag, and an `output-json` string containing the pi-ai-shaped tool result content.
- Both functions are synchronous at the WIT level. Async hosts marshal through their own runtime before returning.

### `agent` interface (guest provides, host imports)

**Semantics:**

- The host constructs an `agent` with a JSON config. The config matches `AgentCoreConfig` (see [`../api-reference.md#core-factory`](../api-reference.md#core-factory)) plus a `systemPromptHash` field the host computed ahead of time (Web Crypto / `SubtleCrypto.digest`, since `node:crypto` is not available inside the component).
- The host calls `prompt(message, extra-system)` per user turn. The second parameter is an optional extra system-prompt block appended for that turn only (the reference Python host uses this to inject memory fragments without mutating the agent's base system prompt). The guest returns an `event-stream` resource.
- The host calls `next()` on the stream in a loop. Each call returns one `AgentEvent` as a JSON string, or `none` when the turn is done.
- Events match the `AgentEvent` union re-exported from `pi-agent-core` (`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, plus tool events when tools are wired). See `src/python/wasm-guest/entrypoint.ts` for the canonical serializer.

### Resource lifecycle and ownership

- `llm-stream`, `event-stream`, and `agent` are all resources owned by their producer. The consumer (opposite side) iterates with `next()` until `none`, then drops the handle.
- Dropping a stream before it returns `none` cancels the in-progress operation on the producer side.
- The WIT-level contract is **one-shot per turn**: one `constructor(config-json)` followed by repeated `prompt(message, extra-system)` calls. The agent resource is long-lived across turns — only the returned `event-stream` is per-turn. The reference Python host holds the agent resource inside wasmtime for the session lifetime and dispatches each `prompt()` call against it. Third-party hosts implementing their own binding must replicate this pattern if they want multi-turn sessions.

## Bindings in other languages

### Rust (`wasmtime`)

The reference Python SDK uses Rust as a shim between wasmtime and PyO3. A pure Rust host follows the same pattern without the PyO3 layer:

```rust
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

// `wasmtime::component::bindgen!` generates the trait and type names from
// the WIT world. Concrete paths below are illustrative — see
// src/python/wasm-host/src/bindings.rs for the real invocation.
wasmtime::component::bindgen!({
    path: "src/python/wit/world.wit",
    world: "flash-agent-core",
    async: true,
});

let engine = Engine::new(Config::new().async_support(true).wasm_component_model(true))?;
let component = Component::from_file(&engine, "core.wasm")?;

let mut linker = Linker::new(&engine);
// Implement the `host-llm` and `host-tools` imports by linking them to
// your HostState. wasmtime_wasi::p2::add_to_linker_async provides WASI
// preview2. Do NOT add wasi-http — core.wasm is componentized with
// --disable http --disable fetch-event.
wasmtime_wasi::p2::add_to_linker_async(&mut linker)?;
FlashAgentCore::add_to_linker::<_, wasmtime::component::HasSelf<_>>(&mut linker, |s| s)?;

let mut store = Store::new(&engine, HostState::new());
let (agent, _) = FlashAgentCore::instantiate_async(&mut store, &component, &linker).await?;
```

Generate bindings with `wasmtime::component::bindgen!` against `src/python/wit/world.wit`. See `src/python/wasm-host/src/bindings.rs` and `src/python/wasm-host/src/agent.rs` for the full pattern.

### Python (`wasmtime-py`)

Generate component-model bindings from the WIT world using the `wasmtime` package's bindgen tooling (exact entry point depends on the installed version — consult `python -m wasmtime.bindgen --help` or the [wasmtime-py docs](https://wasmtime-py.readthedocs.io) for the current interface):

```bash
python -m wasmtime.bindgen src/python/wit/world.wit \
  --out-dir bindings
```

`wasmtime-py`'s component-model support is the newest of the three runtimes listed here. The reference `flash-agents` SDK goes through Rust + PyO3 + wasmtime instead and exposes a smaller, bespoke Python API; that approach is documented under `src/python/wasm-host/`.

### Go (`wazero`)

`wazero` is the leading CM-capable Go runtime. Generate bindings from `world.wit` with `wit-bindgen-go`, then wire the `host-llm` and `host-tools` interfaces to your HTTP client and tool dispatcher.

Go bindings for the component model are newer than Rust's; see the `wazero` and `wit-bindgen-go` project docs for the current state.

## Versioning

- The WIT package line (`package research-computer:flash-agents@0.1.0;`) carries the ABI version. Breaking changes bump the minor until 1.0, then the major.
- A change is breaking if it removes a function, renames a field, changes a field type, or reorders record fields without a rename.
- Adding a new optional record field, a new function, or a new interface is additive and does not bump.
- Hosts built against an older minor version will fail to instantiate against a newer component that breaks the ABI. Pin your `build:wasm` output to a known-good SDK version if you need strict compatibility.

## Reporting drift

If this prose disagrees with `world.wit`, `world.wit` wins. Open an issue with the section name and the WIT snippet that conflicts.
