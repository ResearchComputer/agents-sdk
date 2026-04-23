# WASM Component Embedding ABI — `world.wit`

The contract between a host process and the `core.wasm` component built from `@researchcomputer/agents-sdk/core`. Use this file when:

- you are embedding the agent loop in a non-JS host (Rust, Python, Go, …) and want a stable, language-neutral ABI, or
- you are writing a new reference host alongside the Python stub.

The authoritative ABI lives at [`../../examples/python-stub/wasm/world.wit`](../../examples/python-stub/wasm/world.wit). When this file and `world.wit` disagree, `world.wit` wins; please open an issue so the prose can catch up.

For the how-to side — "walk me through embedding the core end-to-end" — see [`../embedding-core.md`](../embedding-core.md). This file is the ABI reference; that one is the guide.

## Component Model primer

The SDK's core is compiled to a [WebAssembly Component](https://component-model.bytecodealliance.org/). A component is a WASM module with a declared, language-independent interface written in [WIT](https://component-model.bytecodealliance.org/design/wit.html). Any host that speaks the Component Model can load the `core.wasm` artifact and call it through the generated bindings.

Build the artifact once from the repo root:

```bash
npm run build:wasm
# → examples/python-stub/dist/core.wasm
```

Under the hood, `build:wasm` runs an esbuild bundle over `src/core/` plus its ES-module dependencies, then wraps the bundle with [`jco componentize`](https://github.com/bytecodealliance/jco) using the WIT world declared below.

## The `world.wit` contract

```wit
package research-computer:rc-agents@0.1.0;

world rc-agent-core {
  import host-llm;
  export agent;
}
```

Two interfaces cross the boundary: `host-llm` (host → guest) and `agent` (guest → host).

### `host-llm` interface (host provides, guest imports)

```wit
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
```

**Semantics:**

- The guest calls `stream-llm(req)` once per LLM turn. The host returns a `llm-stream` resource.
- The guest calls `next()` on the stream in a loop. Each call returns one SSE-shaped chunk as a JSON string, or `none` when the stream is exhausted.
- All complex fields (`messages-json`, `tools-json`, `options-json`, and the per-chunk payloads) are JSON strings conforming to the `pi-ai` wire format. The Python stub's `py/rc_agents/message_translate.py` is a reference translator between `pi-ai` and OpenAI chat-completions format.
- `stream-llm` and `next` are synchronous at the WIT level. Hosts with async internals (e.g., `aiohttp`, `reqwest`) must synchronize before returning. The Python stub does this by running async code on a wasmtime-driven event loop; see `rust/src/lib.rs`.

**Error propagation:** to signal an LLM error, the host returns a chunk whose JSON shape matches pi-ai's error event. The guest surfaces this as an assistant message with `stopReason: "error"` and closes the turn cleanly. The guest never panics on a malformed chunk — it treats it as an error chunk and ends the turn. See [`../../examples/python-stub/py/tests/test_e2e.py`](../../examples/python-stub/py/tests/test_e2e.py) for a worked HTTP-500 case.

### `agent` interface (guest provides, host imports)

```wit
interface agent {
  resource agent {
    constructor(config-json: string);
    prompt: func(message: string) -> event-stream;
  }

  resource event-stream {
    next: func() -> option<string>;
  }
}
```

**Semantics:**

- The host constructs a `agent` with a JSON config. The config matches `AgentCoreConfig` (see [`../api-reference.md#core-factory`](../api-reference.md#core-factory)) plus a `systemPromptHash` field the host computed ahead of time (Web Crypto / `SubtleCrypto.digest`, since `node:crypto` is not available inside the component).
- The host calls `prompt(message)` once per user turn. The guest returns an `event-stream` resource.
- The host calls `next()` on the stream in a loop. Each call returns one `AgentEvent` as a JSON string, or `none` when the turn is done.
- Events match the `AgentEvent` union re-exported from `pi-agent-core` (`agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`, `turn_end`, `agent_end`, plus tool events when tools are wired). See [`../../examples/python-stub/wasm/entrypoint.ts`](../../examples/python-stub/wasm/entrypoint.ts) for the canonical serializer.

### Resource lifecycle and ownership

- Both `llm-stream` and `event-stream` are owned by their producer. The consumer (opposite side) iterates with `next()` until `none`, then drops the handle.
- Dropping a stream before it returns `none` cancels the in-progress operation on the producer side.
- A single `agent` is one-shot in this milestone: one `constructor` → one `prompt` → one `event-stream` → drop. Multi-turn conversations require reconstructing the agent with the prior messages replayed via config.

## Bindings in other languages

### Rust (`wasmtime`)

The Python stub uses Rust as a shim between wasmtime and PyO3. A pure Rust host follows the same pattern without the PyO3 layer:

```rust
use wasmtime::component::{Component, Linker};
use wasmtime::{Config, Engine, Store};

// `wasmtime::component::bindgen!` generates the trait and type names from the
// WIT world. Concrete paths below are illustrative — the exact identifiers
// your code sees depend on where you invoke bindgen! and with what options.
// See examples/python-stub/rust/src/lib.rs for the real invocation.
wasmtime::component::bindgen!({
    path: "../examples/python-stub/wasm/world.wit",
    world: "rc-agent-core",
    async: true,
});

let engine = Engine::new(Config::new().async_support(true).wasm_component_model(true))?;
let component = Component::from_file(&engine, "core.wasm")?;

let mut linker = Linker::new(&engine);
// Implement the `host-llm` import by linking it to your HostState.
RcAgentCore::add_to_linker(&mut linker, |state: &mut HostState| state)?;

let mut store = Store::new(&engine, HostState::new());
let (agent, _) = RcAgentCore::instantiate_async(&mut store, &component, &linker).await?;
```

Generate bindings with `wasmtime::component::bindgen!` against `world.wit`. See `examples/python-stub/rust/src/lib.rs` for the full pattern.

### Python (`wasmtime-py`)

Generate component-model bindings from the WIT world using the `wasmtime` package's bindgen tooling (exact entry point depends on the installed version — consult `python -m wasmtime.bindgen --help` or the [wasmtime-py docs](https://wasmtime-py.readthedocs.io) for the current interface):

```bash
python -m wasmtime.bindgen examples/python-stub/wasm/world.wit \
  --out-dir bindings
```

`wasmtime-py`'s component-model support is the newest of the three runtimes here. An alternative is to go through Rust (as the reference Python stub does) and expose a smaller, bespoke Python API via PyO3.

### Go (`wazero`)

`wazero` is the leading CM-capable Go runtime. Generate bindings from `world.wit` with `wit-bindgen-go`, then wire the `host-llm` interface to your HTTP client of choice.

Go bindings for the component model are newer than Rust's; see the `wazero` and `wit-bindgen-go` project docs for the current state.

## Versioning

- The WIT package line (`package research-computer:rc-agents@0.1.0;`) carries the ABI version. Breaking changes bump the minor until 1.0, then the major.
- A change is breaking if it removes a function, renames a field, changes a field type, or reorders record fields without a rename.
- Adding a new optional record field, a new function, or a new interface is additive and does not bump.
- Hosts built against an older minor version will fail to instantiate against a newer component that breaks the ABI. Pin your `build:wasm` output to a known-good SDK version if you need strict compatibility.

## Reporting drift

If this prose disagrees with `world.wit`, `world.wit` wins. Open an issue with the section name and the WIT snippet that conflicts.
