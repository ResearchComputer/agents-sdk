# Repo & Docs Repair Implementation Plan

> Execute via superpowers:executing-plans or subagent-driven-development. Tasks grouped (A–H); most groups can be done in parallel.

**Goal:** Fix all documented-but-broken paths so external users and contributors can install, build, run examples, and publish without dead ends.

**Architecture:** Low-effort, high-leverage fixes spanning scripts, examples, docs, and `package.json`. No new subsystems.

**Tech Stack:** TypeScript, bun/npm scripts, Markdown, `npm pack`, GitHub Actions.

---

## Group A — Examples Repair

### A-1  Fix 5 tracked example imports

**Files:** `examples/auto-fork.ts:13,15`, `custom-endpoint.ts:15`, `fork-best-of-n.ts:12`, `fork-from-snapshot.ts:13`, `snapshot-restore.ts:12`

Replace `from '../src/index.js'` with `from '../src/node/index.js'`.

Verify: `grep -rn "from '../src/index.js'" examples/` returns nothing.

### A-2  Resolve 9 untracked example files

From `git status`: `quickstart.ts`, `swarm.ts`, `custom-tool.ts`, `hooks.ts`, `mcp-integration.ts`, `memory-and-session.ts`, `read-only.ts`, `cost-budget.ts`, `_model.ts`.

Per file: fix `../src/index.js` imports and `git add`; or delete if duplicate.

### A-3  `examples/tsconfig.json` + CI typecheck

Create `examples/tsconfig.json`:

```json
{
  "extends": "../tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "allowImportingTsExtensions": true,
    "moduleResolution": "bundler"
  },
  "include": ["./**/*.ts"],
  "exclude": ["../**/*.test.ts"]
}
```

Add CI step in `.github/workflows/ci.yml` after existing `Typecheck`:

```yaml
- name: Typecheck examples
  run: bun x tsc -p examples/tsconfig.json
```

---

## Group B — `build:wasm` Alias + Doc Sweep

### B-1  Add alias to `package.json` scripts

```json
"build:wasm": "bun run build:wasm:python"
```

### B-2  Update docs

| File | Change |
|---|---|
| `README.md:154` | `examples/python-stub/wasm/bun-build.ts` → `src/python/wasm-guest/bun-build.ts` |
| `INTEGRATIONS.md:34` | `npm run build:wasm` → `bun run build:wasm` |
| `docs/embedding-core.md:215,220-221` | fix output path `examples/python-stub/dist/core.wasm` → `src/python/flash_agents/wasm/core.wasm`; fix pipeline description |
| `docs/examples.md:632` | `npm run build:wasm` → `bun run build:wasm`; fix python-stub path |

---

## Group C — `python-stub` Doc Sweep

### C-1  Audit

```bash
grep -rn "examples/python-stub" docs/ INTEGRATIONS.md README.md CLAUDE.md
```

### C-2  Fix WIT identifiers

All docs referencing `research-computer:rc-agents@0.1.0` or world `rc-agent-core` → `research-computer:flash-agents@0.1.0` / `flash-agent-core` (matches `src/python/wit/world.wit`).

### C-3  Repoint file paths

`docs/embedding-core.md` file map (lines 236–248):

| Old | New |
|---|---|
| `wasm/world.wit` | `src/python/wit/world.wit` |
| `wasm/entrypoint.ts` | `src/python/wasm-guest/entrypoint.ts` |
| `wasm/adapters.ts` | `src/python/wasm-guest/adapters.ts` |
| `wasm/llm-bridge.ts` | `src/python/wasm-guest/llm-bridge.ts` |
| `rust/Cargo.toml` | `src/python/wasm-host/Cargo.toml` |
| `py/rc_agents/agent.py` | `src/python/flash_agents/agent.py` |

Also update `INTEGRATIONS.md:35-36`, `docs/README.md:20`, `docs/concepts.md:27,72`.

Verify: `grep -rn "examples/python-stub" docs/ README.md INTEGRATIONS.md` → zero.

### C-4  Update CLAUDE.md python-stub references

Update the "Python SDK — `flash-agents`" paragraph to use `src/python/` paths.

### C-5  Fix `docs/spec/wasm.md:8` header link (→ `../../src/python/wit/world.wit`)

---

## Group D — `docs/spec/wasm.md` Rewrite

### D-1  Full rewrite

Current doc has 7 errors:
1. Wrong package identifier (`rc-agents` → `flash-agents`)
2. Wrong world name (`rc-agent-core` → `flash-agent-core`)
3. Missing `host-tools` interface
4. Wrong `agent.prompt` signature (actual: `func(message: string, extra-system: option<string>) -> event-stream`)
5. Stale file paths (`examples/python-stub/…`)
6. Stale build-output path
7. Rust `bindgen!` snippet wrong world/WIT path

**Approach:** open `src/python/wit/world.wit` as source of truth. Copy WIT verbatim into fenced blocks. Fix Rust bindgen: `path: "src/python/wit/world.wit"`, `world: "flash-agent-core"`. Update `agent.prompt` semantics section for `extra-system`. Remove "authoritative lives at `examples/python-stub/`" header.

Verify: WIT snippets match `cat src/python/wit/world.wit`. `grep -n "rc-agent\|rc-agents\|python-stub" docs/spec/wasm.md` → zero.

---

## Group E — Ship Schemas in Tarball

### E-1  Copy schemas into dist at build time

Modify `package.json` `files`:

```json
"files": [
  "dist",
  "!dist/**/*.test.*",
  "docs/spec/schemas",
  "docs/spec/examples",
  "LICENSE"
]
```

Create `scripts/copy-spec.ts`:

```typescript
#!/usr/bin/env bun
import { cpSync, existsSync } from 'node:fs';
for (const dir of ['schemas', 'examples']) {
  const src = `docs/spec/${dir}`;
  if (existsSync(src)) cpSync(src, `dist/spec/${dir}`, { recursive: true });
}
console.log('[copy-spec] done');
```

Modify `package.json` `build`:

```json
"build": "tsc -b && bun run scripts/copy-spec.ts"
```

### E-2  Update `loader.ts` in-package fast-path

Modify `src/node/spec/loader.ts`: before the filesystem walker, check `path.join(import.meta.dirname, '..', 'spec')` for schemas.

### E-3  Tarball install integration test

Create `scripts/test-tarball-install.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT
bun run build
TARBALL=$(npm pack --json | jq -r '.[0].filename')
CONTENTS=$(tar -tzf "$TARBALL")
for f in "dist/node/index.js" "dist/core/index.js" "docs/spec/schemas"; do
  echo "$CONTENTS" | grep -q "$f" || { echo "MISSING: $f"; exit 1; }
done
cp "$TARBALL" "$TMPDIR/"
cd "$TMPDIR"
npm init -y
npm install "./$TARBALL" --no-package-lock
node --input-type=module <<'EOF'
import { loadSchema } from '@researchcomputer/agents-sdk';
const s = await loadSchema('agentConfig', '1');
if (!s) throw new Error('schema is null');
console.log('loadSchema OK');
EOF
echo "Tarball install test PASSED"
```

Add to CI:

```yaml
- name: Tarball install test
  run: bash scripts/test-tarball-install.sh
```

---

## Group F — Harden `prepublishOnly`

### F-1  Create `scripts/prepublish-guard.ts`

Use `execFileSync` (not `exec`) for safety:

```typescript
#!/usr/bin/env bun
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));

// 1. No file: deps
const depsStr = JSON.stringify({ ...pkg.dependencies, ...pkg.devDependencies });
if (depsStr.includes('file:')) {
  console.error('ERROR: file: dependencies found');
  process.exit(1);
}

// 2. dist/ exists + populated
if (!existsSync('dist') || readdirSync('dist').length === 0) {
  console.error('ERROR: dist/ missing or empty — run bun run build');
  process.exit(1);
}

// 3. schemas present
if (!existsSync('dist/spec/schemas')) {
  console.error('ERROR: dist/spec/schemas/ missing');
  process.exit(1);
}

// 4. npm pack --dry-run contents
const packOut = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf-8' });
const packJson = JSON.parse(packOut);
const files: string[] = packJson[0].files.map((f: { path: string }) => f.path);
for (const r of ['dist/node/index.js', 'dist/core/index.js', 'docs/spec/schemas']) {
  if (!files.some((f) => f.startsWith(r))) {
    console.error(`ERROR: npm pack missing ${r}`);
    process.exit(1);
  }
}

// 5. dist mtime vs src mtime
if (statSync('src').mtimeMs > statSync('dist').mtimeMs) {
  console.error('ERROR: src/ newer than dist/ — rebuild');
  process.exit(1);
}

// 6. Warn about overrides
if (pkg.overrides && Object.keys(pkg.overrides).length > 0) {
  console.warn('WARN: package.json overrides do NOT propagate to consumers.');
  console.warn('      See docs/publishing.md.');
}

console.log('[prepublish-guard] all checks passed');
```

### F-2  Wire into `prepublishOnly`

```json
"prepublishOnly": "bun run scripts/prepublish-guard.ts"
```

### F-3  Document overrides propagation in `docs/publishing.md`

Sections:
1. The `overrides` problem — only affects in-repo dev installs.
2. Current state — `pi-ai` forced to `@researchcomputer/ai-provider@^0.1.0` locally; consumers get upstream.
3. Near-term mitigation — add `@researchcomputer/ai-provider` as a direct peer dep.
4. Long-term — replace or fork `pi-agent-core` under `@researchcomputer`.

---

## Group H — Repo Hygiene

### H-1  LICENSE, SECURITY.md, CHANGELOG.md, CONTRIBUTING.md

Standard MIT LICENSE (`Copyright (c) 2024 Research Computer`). Minimal SECURITY.md (email + response SLA). CHANGELOG scaffold (Keep-a-Changelog format). CONTRIBUTING with the `bun install && bun run lint && bun run test` flow.

Add `LICENSE` to `package.json` `files` array (already covered in E-1).

---

## Build Sequence

### Phase 1 — Unblock examples
- [ ] A-1, A-2, A-3

### Phase 2 — Build script alignment
- [ ] B-1, B-2

### Phase 3 — python-stub sweep
- [ ] C-1, C-2, C-3, C-4, C-5

### Phase 4 — wasm.md rewrite
- [ ] D-1

### Phase 5 — Ship schemas
- [ ] E-1, E-2, E-3

### Phase 6 — Harden publish
- [ ] F-1, F-2, F-3

### Phase 7 — Hygiene
- [ ] H-1
