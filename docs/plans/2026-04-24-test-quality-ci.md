# Test Quality & CI Hardening Implementation Plan

> Execute via superpowers:executing-plans or subagent-driven-development.

**Goal:** Replace tautological tests with real integration coverage, and add CI jobs that would have caught the doc/examples/publish drift found in the code review.

**Architecture:** New `tests/integration/` layer for tarball + examples smoke; rewrite of Phase-5 redaction tests; GitHub Actions additions for examples-typecheck, wasm smoke, and publish-dry-run.

**Tech Stack:** vitest, pytest, GitHub Actions, `npm pack`.

---

## Patterns Found

- **streamFn injection** (`src/node/factory-trajectory.test.ts:109–172`): canonical way to drive tool calls without network.
- **Temp-dir lifecycle** (`factory-redact.test.ts:14–21`): `beforeEach` `fs.mkdtemp`, `afterEach` `fs.rm({ recursive: true, force: true })`.
- **JSONL after dispose**: read synchronously after `await agent.dispose()`; no wait needed (writer flushes on close).
- **Adapter injection for LLM mocking** (`src/core/llm/client.test.ts:109–139`): preferred over module-level `vi.mock`.
- **Python mock server** (`src/python/tests/e2e/mock_server.py`): aiohttp, port via `socket.bind(0)`.

---

## Group A — Replace Tautological Redaction Tests

### A-1  Audit + replacement contracts

**File:** `src/node/factory-redact.test.ts`

Current tests assert `snap.version === 2` and `getWarnings()` empty — neither exercises the redaction path.

**Replacements:**
- **A-1a**: "redactArgs scrubs `permission_decision` payloads in trajectory JSONL" — drive a tool call via `streamFn` with `args: { command: 'echo hello', apiKey: 'sk-secret' }`, parse JSONL after dispose, assert `payload.args.apiKey === '[redacted]'` and `payload.args.command === 'echo hello'`.
- **A-1b**: "in-memory `permissionDecisions` retains raw args" — same drive, inspect decisions in-memory, assert `apiKey === 'sk-secret'` is preserved in memory (confirms redaction is write-only to disk).
- **A-1c**: "throwing redactor emits `redact_args_failed` warning, does NOT abort the tool call" — redactor throws; assert warning emitted AND trajectory has a `tool_result` event.

### A-2  Shared fixture helpers

**Files:** `src/node/__fixtures__/redact-stream.ts`, `src/node/__fixtures__/echo-tool.ts`

```ts
// redact-stream.ts
export function makeToolCallStream(toolName: string, args: Record<string, unknown>): StreamFn {
  // Two-turn pattern from factory-trajectory.test.ts:112–137
  // Turn 1: toolCall event; Turn 2: text 'done' stop
}

// echo-tool.ts
export const echoTool: SdkTool = {
  name: 'EchoTool',
  label: 'Echo Tool',
  description: 'Echoes command',
  parameters: Type.Object({
    command: Type.String(),
    apiKey: Type.Optional(Type.String()),
  }),
  capabilities: [],
  async execute() {
    return { content: [{ type: 'text', text: 'ok' }], details: {} };
  },
};
```

### A-3  Wire new tests

Rewrite `src/node/factory-redact.test.ts` using the new helpers. Remove all three tautological tests.

**Commit:** `test(node): replace tautological redaction tests with end-to-end assertions`

---

## Group B — Examples Typecheck CI Job

### B-1  `tsconfig.examples.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "paths": {
      "../src/index.js": ["./src/node/index.ts"],
      "../src/index.ts": ["./src/node/index.ts"]
    }
  },
  "include": ["examples/**/*.ts"],
  "exclude": ["examples/_model.ts"]
}
```

### B-2  CI job

```yaml
examples-typecheck:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: 1.3.2 }
    - run: bun install --frozen-lockfile
    - run: bun x tsc -p tsconfig.examples.json
```

**Commit:** `ci: examples-typecheck job catches broken example imports`

---

## Group C — WASM Smoke CI Job

```yaml
wasm-smoke:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: 1.3.2 }
    - run: bun install --frozen-lockfile
    - run: bun run build:wasm:python
    - name: Verify WASM artifact
      run: |
        test -f src/python/flash_agents/wasm/core.wasm
        test -s src/python/flash_agents/wasm/core.wasm
        test -f src/python/flash_agents/wasm/CORE_WASM_SHA256.txt
```

**Commit:** `ci: wasm-smoke job runs build:wasm:python and verifies artifacts`

---

## Group D — Tarball Install Smoke (TS + Python)

### D-1  TS smoke script

**File:** `scripts/smoke-tarball.sh` (chmod +x)

```bash
#!/usr/bin/env bash
set -euo pipefail
bun run build
TARBALL=$(npm pack --json | jq -r '.[0].filename')
SCRATCH=$(mktemp -d)
tar -xzf "$TARBALL" -C "$SCRATCH"
cd "$SCRATCH/package"
npm install --ignore-scripts
node --input-type=module <<'EOF'
import { createAgent } from './dist/node/index.js';
if (typeof createAgent !== 'function') process.exit(1);
console.log('TS tarball smoke: OK');
EOF
node --input-type=module <<'EOF'
import { loadSchema } from './dist/node/spec/loader.js';
const s = await loadSchema('session.v1');
if (!s || !s.$schema) process.exit(1);
console.log('loadSchema smoke: OK');
EOF
```

### D-2  Python wheel smoke

Add to `python-sdk` job in `ci.yml` after `Run Python tests`:

```yaml
- name: Build Python wheel
  working-directory: src/python
  run: maturin build --release --out dist/
- name: Install wheel into fresh venv and import
  run: |
    python -m venv /tmp/smoke-venv
    /tmp/smoke-venv/bin/pip install src/python/dist/*.whl
    /tmp/smoke-venv/bin/python -c "from flash_agents import Agent; assert callable(Agent.create); print('OK')"
```

### D-3  Tarball smoke CI job

```yaml
tarball-smoke:
  runs-on: ubuntu-latest
  needs: [test]
  steps:
    - uses: actions/checkout@v4
    - uses: oven-sh/setup-bun@v2
      with: { bun-version: 1.3.2 }
    - uses: actions/setup-node@v4
      with: { node-version: '20' }
    - run: bun install --frozen-lockfile
    - run: bash scripts/smoke-tarball.sh
```

### D-4  Add `docs/spec/schemas` to `files` array

```json
"files": [
  "dist",
  "docs/spec/schemas",
  "!dist/**/*.test.*"
]
```

**Commit:** `ci: tarball-smoke (TS+Python) catches packaging regressions`

---

## Group E — Coverage Thresholds

### E-1  `vitest.config.ts`

```ts
thresholds: {
  lines: 70,
  branches: 60,
  functions: 70,
  statements: 70,
  perFile: true,
  'src/core/middleware/permission-middleware.ts': { lines: 90, branches: 80 },
  'src/core/trajectory/redactors.ts': { lines: 90, branches: 85 },
},
```

### E-2  Verify locally

`bun run test:coverage` exits 0. If a module falls below, either cover it or exclude with documented reason.

**Commit:** `test: coverage thresholds (70/60 global, 90/80 for security-critical)`

---

## Group F — Refactor `doc-verify.test.ts`

**File:** `src/node/doc-verify.test.ts`

Replace module-level `vi.mock('@researchcomputer/ai-provider', ...)` with adapter injection (pattern from `src/core/llm/client.test.ts:109–139`):

1. Remove top-level `vi.mock` and `mockCompleteN`.
2. Import `createAgentCore` and pass a hand-rolled `LlmClient` via `adapters.llmClient`.
3. `mockLlmClient.stream()` returns deterministic event stream; `completeN()` returns mock assistant messages.
4. Remove `authToken: 'test-jwt'` workaround.
5. Rewrite fork-tests: assertion becomes a closure counter `let calls = 0`.

**Commit:** `test(node/doc-verify): switch from vi.mock to adapter injection`

---

## Build Sequence

- [ ] F — refactor doc-verify (safest first; no new functionality)
- [ ] A-2, A-3 — fixture helpers + echoTool
- [ ] A-1, A-4 — rewrite factory-redact.test.ts; verify `bun x vitest run src/node/factory-redact.test.ts` passes
- [ ] E — coverage thresholds; resolve modules below floor
- [ ] D-4 — `docs/spec/schemas` in files array
- [ ] D-1 — write smoke-tarball.sh; test locally
- [ ] B-1 — tsconfig.examples.json; test locally
- [ ] C — wasm-smoke CI job
- [ ] B-2 — examples-typecheck CI job
- [ ] D-2 — Python wheel smoke in python-sdk job
- [ ] D-3 — tarball-smoke CI job
- [ ] Open PR; all new CI jobs green before merge

---

## Critical Details

**Error handling:** `set -euo pipefail` in shell scripts. If `jq` unavailable, substitute `grep -oP '"filename":\s*"\K[^"']+'`.

**Redaction test timing:** `dispose()` flushes the trajectory writer synchronously. No fsync waits needed.

**`allowImportingTsExtensions`:** requires `noEmit: true` (already set) and TS ≥ 5.0. Project uses ^5.7.0.

**Python wheel cache:** `maturin build --release` is 2–4 min. Cache Rust target dir keyed on `Cargo.lock` to keep job under 10 min.

**Coverage `perFile`:** every file must meet global threshold. Small utility files (1–2 fns) may need explicit exclusion. Audit first coverage run before committing thresholds.

**`completeN` in doc-verify:** confirm `completeN` is on the `LlmClient` interface in `src/core/llm/client.ts` before adapter-injecting. If only on ai-provider directly, add it to the interface first.
