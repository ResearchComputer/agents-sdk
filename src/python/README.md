# flash-agents

Python SDK for `@researchcomputer/agents-sdk`. Runs the agent core as a
WebAssembly Component via `wasmtime-py` — no Rust extension, no Node at
runtime.

See the spec: `docs/superpowers/specs/2026-04-22-flash-agents-python-sdk-design.md`

## Install (development)

```bash
bun install
bun run build:wasm:python

cd src/python
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
pytest
```
