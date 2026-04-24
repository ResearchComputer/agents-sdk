# Python SDK Fixes Implementation Plan

> Execute via superpowers:executing-plans or subagent-driven-development.

**Goal:** Ship a Python SDK that installs cleanly from pip, removes the busy-poll event-loop shim, documents its parity gap with the Node SDK explicitly, and applies basic wasmtime resource limits.

**Architecture:** Targeted fixes across packaging metadata, the pyo3-async-runtimes init path, the `Agent.create()` hot path, WIT guest stubs, and README documentation.

**Tech Stack:** Python 3.11+, aiohttp, pyo3 0.28, pyo3-async-runtimes 0.28 (tokio-runtime feature), wasmtime 43, hatchling, maturin.

---

## Phase 1 — Critical: install + no polling shim + SHA versioning

### Task 1.1 — Remove `_await_wasm` polling shim

**File:** `src/python/flash_agents/agent.py:43–50` and all callers

**Root cause analysis:** `pyo3_async_runtimes::tokio::future_into_py` returns a Python-awaitable coroutine backed by the embedded tokio multi-thread runtime (enabled by `tokio-runtime` feature in `Cargo.toml:22`). The runtime is lazily initialized on first `future_into_py` call. The existing comment in `agent.py:45` about "stranded futures" is no longer accurate under pyo3-async-runtimes 0.28 with `tokio-runtime`.

**Fix:**
1. Delete `_await_wasm` function.
2. Replace all `await _await_wasm(expr)` with `await expr`. Call sites:
   - `agent.py:217` — `wasm_ext.Agent.create(...)`
   - `agent.py:260` — `self._inner.prompt(...)`
   - `agent.py:265` — `stream.next()`
   - `agent.py:271` — `stream.close()`
   - `agent.py:282` — `self._inner.dispose()`
3. Verify no `init_with_runtime` is needed in the `pymodule` fn — lazy init is automatic.

**Tests:** run existing pytest suite; no stranded-future errors.

**Commit:** `fix(python): remove _await_wasm polling shim (pyo3-async-runtimes 0.28)`

---

### Task 1.2 — Ship `CORE_WASM_SHA256.txt` in wheel

**File:** `src/python/pyproject.toml:27–28`

```toml
[tool.hatch.build.targets.wheel.force-include]
"flash_agents/wasm/core.wasm"             = "flash_agents/wasm/core.wasm"
"flash_agents/wasm/CORE_WASM_SHA256.txt"  = "flash_agents/wasm/CORE_WASM_SHA256.txt"
```

**Tests:** build wheel, install into throwaway venv, import `flash_agents`, call `wasm_path()` — exits 0.

**Commit:** `fix(python): include CORE_WASM_SHA256.txt in wheel force-include`

---

### Task 1.3 — Versioned SHA format + cached verification

**Files:** `scripts/build-sha256.ts`, `src/python/flash_agents/wasm/host.py`

**Fix — `build-sha256.ts`:**

```typescript
const payload = JSON.stringify({ version: 1, alg: "sha256", digest: hex });
writeFileSync(shaPath, payload + "\n");
```

**Fix — `host.py`:** accept both legacy and v1 formats (migration window):

```python
def _parse_sha_file(sha_file: pathlib.Path) -> str:
    raw = sha_file.read_text().strip()
    if raw.startswith("{"):
        import json
        obj = json.loads(raw)
        if obj.get("version") != 1:
            raise WasmHostError(
                f"Unsupported CORE_WASM_SHA256.txt version: {obj.get('version')!r}"
            )
        return obj["digest"].lower()
    return raw.lower()  # legacy bare-hex

import functools

@functools.lru_cache(maxsize=1)
def _cached_wasm_path() -> str:
    _verify_sha256(_CORE_WASM, _SHA_FILE)
    return str(_CORE_WASM)

def wasm_path() -> str:
    """Return verified core.wasm path. Detects build artifact staleness (not tampering)."""
    return _cached_wasm_path()
```

**Tests:** unit test both bare-hex and JSON-v1 parse paths.

**Commit:** `fix(python): versioned SHA format, cache verification`

---

## Phase 2 — Resource limits + LLM bridge correctness

### Task 2.1 — Remove unused `wasmtime-wasi-http`

**Files:** `src/python/wasm-host/Cargo.toml`, `state.rs`, `agent.rs`

WASM is componentized with `--disable http --disable fetch-event`, so HTTP import is unreachable dead weight.

**Fix:**
- `Cargo.toml`: remove `wasmtime-wasi-http = "43"`
- `state.rs`: remove `WasiHttpCtx` field, `WasiHttpView` impl, `http_hooks` field
- `agent.rs`: remove linker `add_only_http_to_linker_async` call, `http` field in State literal

**Commit:** `chore(python/wasm-host): remove unused wasmtime-wasi-http dep`

---

### Task 2.2 — wasmtime epoch/fuel + CancelledError wiring

**Files:** `src/python/wasm-host/src/agent.rs`, `src/python/flash_agents/agent.py`

**Fix — `agent.rs`:**

```rust
async fn build_core(..., timeout_ms: Option<u64>, max_fuel: Option<u64>) -> wasmtime::Result<Core> {
    let mut cfg = Config::new();
    cfg.async_support(true);
    cfg.epoch_interruption(true);
    if max_fuel.is_some() {
        cfg.consume_fuel(true);
    }
    let engine = Engine::new(&cfg).context("construct Engine")?;
    // ... existing component/linker/state construction ...
    let mut store = Store::new(&engine, state);
    store.set_epoch_deadline(1);
    if let Some(fuel) = max_fuel {
        store.set_fuel(fuel)?;
    }
    Ok(Core { store, bindings, agent, engine: engine.clone(), timeout_ms })
}
```

Add `interrupt()` method to PyO3 Agent struct. Store `Arc<Engine>` as second field so `interrupt()` doesn't contend with the tokio Mutex:

```rust
fn interrupt(&self) -> PyResult<()> {
    self.engine.increment_epoch();
    Ok(())
}
```

Expose `timeout_ms`/`max_fuel` via Python `Agent.create()` signature; propagate through `config_json`.

**Fix — `agent.py`:** wire `asyncio.CancelledError`:

```python
async def iterator() -> AsyncIterator[dict]:
    async with self._call_lock:
        extra_system = await _compose_memory_block(memory, message, memory_top_k)
        try:
            stream = await self._inner.prompt(message, extra_system)
        except RuntimeError as err:
            raise WasmHostError(str(err)) from err
        try:
            while True:
                raw = await stream.next()
                if raw is None:
                    return
                yield json.loads(raw)
        except asyncio.CancelledError:
            self._inner.interrupt()  # bump epoch → guest traps
            raise
        finally:
            try:
                await stream.close()
            except RuntimeError:
                pass
```

Also add `ResourceLimiter` impl to `State` setting max linear memory (default 256 MiB).

**Tests:** `src/python/tests/test_resource_limits.py` — fuel-exhausted guest raises `WasmHostError`; `asyncio.CancelledError` propagates cleanly.

**Commit:** `feat(python): wasmtime epoch/fuel limits, CancelledError → engine interrupt`

---

### Task 2.3 — Fix `make_error_event` double-terminal

**Files:** `src/python/flash_agents/llm/message_translate.py`, `openai_compat.py`

`make_error_event` can emit a second terminal event after a normal `done`. Fix to no-op when `_done_emitted`:

```python
def make_error_event(self, error_message: str) -> dict | None:
    if self._done_emitted:
        return None
    self._done_emitted = True
    return {
        "type": "error",
        "reason": "error",
        "error": self._snapshot_message(final=True, stop_reason="error", error_message=error_message),
    }
```

Update 3 call sites in `openai_compat.py` to handle `None`:

```python
event = self._decoder.make_error_event(f"...")
if event is not None:
    return json.dumps(event)
raise StopAsyncIteration
```

**Tests:** unit test asserting second call returns None.

**Commit:** `fix(python/llm): make_error_event no-op after done; handle None at call sites`

---

### Task 2.4 — Fix quadratic snapshot + dropped non-text blocks

**File:** `src/python/flash_agents/llm/message_translate.py`

**2.4a — toolcall_delta snapshot:** omit `partial` from `toolcall_delta` yields (pi-agent-core doesn't require it on deltas). Eliminates O(n_deltas × n_toolcalls) allocation loop.

**2.4b — `_flatten_text_content`:** handle image blocks via OpenAI vision format:

```python
def _flatten_text_content(content: Any) -> str | list[dict]:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    parts: list[dict] = []
    for item in content:
        if not isinstance(item, dict):
            continue
        t = item.get("type")
        if t == "text":
            parts.append({"type": "text", "text": item.get("text", "")})
        elif t == "image":
            url = item.get("url") or item.get("data")
            if url:
                parts.append({"type": "image_url", "image_url": {"url": url}})
        # toolCall / toolResult / thinking omitted (handled separately)
    if not parts:
        return ""
    if all(p["type"] == "text" for p in parts):
        return "".join(p["text"] for p in parts)
    return parts
```

**Tests:** image block produces `image_url` in OpenAI payload; 100-delta tool call completes in < 5ms.

**Commit:** `fix(python/llm): skip toolcall_delta snapshot rebuild; handle image blocks`

---

## Phase 3 — Parity matrix + config_ignored warnings

### Task 3.1 — Parity matrix in `src/python/README.md`

Add section after "Features (v1)":

```markdown
## Node SDK Parity Matrix (v1)

| Feature                        | Node | flash-agents v1 | Notes |
|--------------------------------|------|-----------------|-------|
| Multi-turn `prompt()`          | Yes  | Yes             |       |
| Custom `@tool` / `Tool`        | Yes  | Yes             |       |
| Filesystem memory store        | Yes  | Yes             | Default path differs |
| MCP server registration        | Yes  | Accepted, not dispatched | Future release |
| OpenAI-compat LLM client       | Indirect | Yes         |       |
| Sessions (persist/restore)     | Yes  | No              | sessionStore no-op |
| Snapshot / fork / autoFork     | Yes  | No              | parseConfig drops |
| Skills                         | Yes  | No              | parseConfig drops |
| Hooks (before/after turn)      | Yes  | No              | parseConfig drops |
| Permission rules               | Yes  | No (allowAll)   | parseConfig drops |
| Swarm / multi-agent            | Yes  | No              | SwarmManager not exposed |
| MCP tool dispatch              | Yes  | No              | Host throws on connect |
| Telemetry                      | Yes  | No              | telemetryOptOut: true |
| Auth token resolver            | Yes  | Stub            | Returns fixed token |
| `allowedRoots` sandbox         | Yes  | No              | parseConfig drops |
```

Add 1–2 sentence mention in top-level `README.md` linking to the matrix.

**Commit:** `docs(python): parity matrix in README`

---

### Task 3.2 — `config_ignored` warnings

**Files:** `src/python/flash_agents/agent.py`, `src/python/wasm-guest/entrypoint.ts`

**Fix — `agent.py`:** add `**_ignored_kwargs` guard to `Agent.create`:

```python
@classmethod
async def create(cls, *, llm, model, system_prompt="", cwd=None, tools=None,
                 memory=_MEMORY_UNSET, memory_top_k=5, mcp_servers=None,
                 timeout_ms=None, max_fuel=None, **_ignored_kwargs):
    if _ignored_kwargs:
        import warnings
        warnings.warn(
            f"flash-agents v1 ignores: {sorted(_ignored_kwargs)!r}. See parity matrix.",
            UserWarning, stacklevel=2,
        )
    # Also warn for unknown `model` dict keys
    unsupported_model = set(model.keys()) - {"id", "provider", "api", "options"}
    if unsupported_model:
        warnings.warn(
            f"flash-agents v1 ignores model keys: {sorted(unsupported_model)!r}",
            UserWarning, stacklevel=2,
        )
```

**Fix — `entrypoint.ts` `parseConfig`:**

```typescript
const known = new Set(["model", "systemPrompt", "system-prompt", "cwd"]);
const dropped = Object.keys(raw).filter(k => !known.has(k));
if (dropped.length > 0) {
  console.warn(`[flash-agents] ignored config fields: ${dropped.join(", ")}`);
}
```

**Tests:** passing `skills=...` emits `UserWarning`.

**Commit:** `feat(python): warn on unsupported config fields`

---

### Task 3.3 — Unify memory default path

**File:** `src/python/flash_agents/memory/filesystem.py:73`

```python
root = pathlib.Path("~/.rc-agents/memory").expanduser()
```

Update docstring + parity matrix row.

**Commit:** `fix(python/memory): default path ~/.rc-agents/memory (match Node SDK)`

---

## Phase 4 — Schema + packaging

### Task 4.1 — `Union` → `anyOf`

**File:** `src/python/flash_agents/tools/schema.py:53–69`

```python
if _is_union(origin):
    non_none = [a for a in args if a is not type(None)]
    nullable = any(a is type(None) for a in args)
    if len(non_none) == 1:
        inner = type_to_schema(non_none[0], path)
        if nullable:
            # existing nullable handling
            ...
        return inner
    # Multi-arm: emit anyOf
    schemas = [type_to_schema(a, f"{path}[{i}]") for i, a in enumerate(non_none)]
    result: dict = {"anyOf": schemas}
    if nullable:
        result["anyOf"].append({"type": "null"})
    return result
```

**Tests:** `int | str`, `int | str | None`, `int | str | float` produce correct schemas.

**Commit:** `feat(python/tools): anyOf for multi-arm Union types`

---

### Task 4.2 — Validate default values at decoration time

**File:** `src/python/flash_agents/tools/schema.py:112–117`

```python
if param.default is not inspect.Parameter.empty:
    try:
        json.dumps(param.default)
    except (TypeError, ValueError) as exc:
        raise ConfigError(
            f"default for parameter {name!r} in {fn.__name__!r} not JSON-serializable: {exc}"
        ) from exc
    schema["default"] = param.default
```

**Tests:** non-serializable default raises `ConfigError` at decoration.

**Commit:** `fix(python/tools): validate JSON-serializability of @tool defaults at decoration`

---

### Task 4.3 — macOS wheels

**File:** `.github/workflows/publish.yml`

Add macOS targets to `python-wasm-wheels` matrix:

```yaml
- os: macos-13
  target: x86_64-apple-darwin
  maturin_args: ""
- os: macos-latest
  target: aarch64-apple-darwin
  maturin_args: ""
```

Add "Developer Install" section in `src/python/README.md` with `maturin develop` instructions.

**Commit:** `ci(python): macOS wheel publish targets`

---

### Task 4.4 — WIT comment + multi-turn docs

**File:** `src/python/wit/world.wit`, `src/python/README.md`

Add comment to WIT explaining close-by-drop and multi-turn pattern. Add "Architecture" paragraph in README:

> WIT `agent.prompt` is one-shot per turn. Multi-turn is implemented by the Python host calling `prompt()` repeatedly on the same agent resource (which holds message history inside wasmtime). Third-party hosts must replicate this message-replay pattern.

**Commit:** `docs(python): WIT multi-turn semantics, close-by-drop`

---

## Build Sequence

```
Phase 1 — unblock installs:
  [ ] 1.1 remove _await_wasm
  [ ] 1.2 ship SHA file in wheel
  [ ] 1.3 versioned SHA format + cached verification

Phase 2 — resource limits + LLM correctness:
  [ ] 2.1 remove wasmtime-wasi-http
  [ ] 2.2 epoch/fuel + CancelledError wiring
  [ ] 2.3 make_error_event double-terminal fix
  [ ] 2.4 quadratic snapshot + image blocks

Phase 3 — docs + warnings:
  [ ] 3.1 parity matrix
  [ ] 3.2 config_ignored warnings
  [ ] 3.3 unify memory default

Phase 4 — schema + packaging:
  [ ] 4.1 anyOf for Union
  [ ] 4.2 validate defaults
  [ ] 4.3 macOS wheels
  [ ] 4.4 WIT comments
```

---

## Critical Details

**Error handling:** Rust errors surface as `PyRuntimeError` → `WasmHostError`. Consider follow-up `WasmTimeoutError(WasmHostError)` subclass once epoch interruption ships.

**State:** `lru_cache(maxsize=1)` on `_cached_wasm_path` is process-global. Tests mutating `core.wasm` must `importlib.reload` or `cache_clear()`.

**Performance:** removing `_await_wasm` kills ~1ms overhead per Rust await × 3 awaits × ~50 events per turn = ~150ms saved per turn. Top-priority latency fix.

**Security:** SHA verification is staleness detection, not tamper protection — docstring must say so. wasmtime fuel/epoch are correct DoS mitigation; defaults = no limit (OK for v1 trusted builds) but knobs must exist before multi-tenant deployment.
