# Node Tool Sandbox Hardening Implementation Plan

> Execute via superpowers:executing-plans or subagent-driven-development.

**Goal:** Close sandbox-escape vectors in built-in Node tools so permission rules, path restrictions, and capability declarations are genuinely enforced against an LLM attacker.

**Architecture:** Add `shell:exec` capability; tighten path/URL validators; introduce per-path `PathMutex` for writes; add `safeToolError` helper that strips LLM-controlled strings from error messages; fix symlink and redirect handling. New shared module: `src/node/security/`.

**Tech Stack:** TypeScript, vitest, Node 20+ fs/http APIs, `undici` (bundled in Node 20).

---

## New Files

| File | Purpose |
|---|---|
| `src/node/security/path-mutex.ts` | `PathMutex` — serialize writes per absolute path |
| `src/node/security/safe-error.ts` | `safeToolError`, `safePathError`, `ToolErrorCode` enum |
| `src/node/security/index.ts` | Re-exports |
| `src/node/security/*.test.ts` | Unit tests |

---

## Finding 1 — Bash bypass (Critical)

**File:** `src/node/tools/bash.ts`

**Problems:**
- Declares `['process:spawn', 'fs:write', 'network:egress']` — no dedicated capability a rule can target
- Runs `bash -c <raw LLM string>` with full inherited env (leaks `RC_AUTH_TOKEN`, `STYTCH_PUBLIC_TOKEN`, etc.)
- `child.kill('SIGTERM')` only hits direct child, not process group → backgrounded subprocesses orphan

**Fixes:**

1. Add `'shell:exec'` to `Capability` union in `src/core/types.ts`; add to `MUTATION_CAPABILITIES` in `permissions.ts`.
2. Change `bash.ts:27` capabilities to `['shell:exec']`.
3. Extend `BashToolOptions` with `envAllowlist?: string[]`. Default: `['PATH','HOME','LANG','TERM','USER','SHELL','LC_ALL','TMPDIR']`. Scrub: start from `{}`, copy only allowlisted, then explicitly delete anything matching `/TOKEN|KEY|SECRET|PASSWORD|AUTH|STYTCH|RC_/i`.
4. Spawn with `{ detached: true, env: scrubbedEnv, cwd, signal }`. On Linux/macOS group-kill via `process.kill(-child.pid, signal)`. On Windows keep single-PID kill.
5. Add `truncKilled` boolean guard so size-cap doesn't SIGTERM repeatedly.
6. Add `permissionCheck?: (command: string) => PermissionResult` option for command-pattern ACLs.

**Tests** (`bash.test.ts`):
- `capabilities` equals `['shell:exec']`
- `echo $RC_AUTH_TOKEN` with `RC_AUTH_TOKEN=secret` in parent → output doesn't contain `secret`
- `sleep 60 &` backgrounded child killed on truncation (process-group kill verified)
- Command that truncates AND exits non-zero still resolves with `truncated: true`

**Commit:** `security(bash): shell:exec capability, env scrub, process-group kill`

---

## Finding 2 — WebFetch SSRF (Critical)

**File:** `src/node/tools/web-fetch.ts`

**Problems:** no scheme/IP check, follows redirects, buffers full body, echoes URL in errors.

**Fixes:**

1. `new URL(params.url)`; reject if `protocol` not in `{'http:', 'https:'}`.
2. `dns.promises.lookup(hostname, { all: true })`; reject if any address is loopback (127/8, ::1), link-local (169.254/16, fe80::/10), private (10/8, 172.16/12, 192.168/16), or multicast.
3. Use `undici.fetch` with a custom `Agent` that has a `connect` hook locking the TCP connection to the resolved IP (anti DNS-rebinding). Pass original hostname as `Host` header.
4. `redirect: 'manual'`. Follow up to 5 hops manually; re-validate scheme + IP on each `Location`.
5. Stream body via `response.body` `ReadableStream`; accumulate with byte counter; once `maxBytes` exceeded, cancel and resolve with `{ truncated: true, text: accumulated }` — do not reject.
6. Content-type check: allow `text/*`, `application/json`, `application/xml` by default. Add `contentTypeAllowlist?: string[]` option.
7. Replace error messages with `safeToolError(err, 'fetch_failed')`.

**Tests:**
- `file://`, `data:`, `blob:` rejected
- loopback URL rejected
- redirect to 169.254.169.254 rejected
- streaming body truncation (mock undici)
- URL not in error message

**Commit:** `security(web-fetch): scheme check, SSRF guard, streaming body cap, manual redirect`

---

## Finding 3 — Edit TOCTOU + binary corruption + overlap scan (Critical)

**Files:** `src/node/tools/edit.ts`, `write.ts`, `notebook-edit.ts`, `util.ts`

**Problems:**
- `toolExecution` defaults to `'parallel'`; concurrent Edits race → last-write-wins silently
- `fs.writeFile` is non-atomic
- UTF-16 surrogate pair corruption
- `fs.readFile(..., 'utf-8')` silently mojibakes binaries
- `replace_all=false` fast-path misses overlapping matches (`'aa'` in `'aaa'`)

**Fixes:**

1. Create `src/node/security/path-mutex.ts`:

```ts
export class PathMutex {
  private chains = new Map<string, Promise<void>>();
  async acquire(absPath: string): Promise<() => void> {
    const prev = this.chains.get(absPath) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    this.chains.set(absPath, prev.then(() => next));
    await prev;
    return () => {
      release();
      if (this.chains.get(absPath) === next) this.chains.delete(absPath);
    };
  }
}
export const pathMutex = new PathMutex();
```

2. Wrap read-modify-write in Edit, Write, NotebookEdit with `pathMutex.acquire(absPath)`. Atomic write: write to `absPath + '.tmp'`, then `fs.rename(tmpPath, absPath)`.

3. Binary guard: after `isRealPathAllowed` passes, call `isBinaryContent` on first 8KB (Edit) or input buffer (Write). Throw `safeToolError('io_error')` unless caller opted in with `binary?: true` flag.

4. Fix overlap scan:

```ts
let pos = 0, count = 0;
while (true) {
  const idx = content.indexOf(params.old_string, pos);
  if (idx === -1) break;
  count++;
  if (!replaceAll && count > 1) break;
  pos = idx + 1;  // advance by 1 for overlap detection
}
```

5. NFC-normalize `old_string`/`new_string` via `.normalize('NFC')`. Reject lone surrogates: `/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/`.

**Tests:**
- Two concurrent `tool.execute` on same file → both edits present
- Overlap detection: `'aa'` in `'aaa'` correctly counted as 2 matches
- Binary file rejected without `binary: true`
- Atomic write: intercept `fs.writeFile` mid-write, no partial content ever observed

**Commit:** `security(edit/write): PathMutex, atomic writes, binary guard, overlap fix`

---

## Finding 4 — isRealPathAllowed symlink-swap TOCTOU (Critical)

**Files:** `src/node/tools/util.ts`, tools that read/write files

**Fix:**

1. `isRealPathAllowed` returns `{ allowed: boolean; realPath: string }` (or expose a parallel `resolveRealPath`). Store `realPath` from the check; use it for I/O, not the original `absPath`.

2. Add `openSafe(realPath, cwd, allowedRoots, flags)` helper in `util.ts`. On Linux/macOS use `fs.open(realPath, flags | O_NOFOLLOW)`. On Windows skip `O_NOFOLLOW` (best-effort).

3. For Write: run `isRealPathAllowed` on `path.dirname(absPath)` BEFORE `mkdir`. If dirname realpath escapes sandbox, reject.

**Tests:**
- Create symlink pointing outside sandbox; Read rejects
- Symlink-swap race test (mock `fs.open` between check and open)

**Commit:** `security(util/tools): O_NOFOLLOW open, use realpath for I/O, dirname check before mkdir`

---

## Finding 5 — Grep/rg/Glob symlink escape (Critical/High)

**Files:** `src/node/tools/grep.ts`, `glob.ts`

**Fixes:**

1. rg: confirm `--follow`/`-L` not passed (rg default is no-follow). Document.
2. grep fallback: add `--no-dereference` to args.
3. Reject `params.pattern` or `params.glob` starting with `-` (arg injection).
4. rg args: use fused form `--glob=<value>` (before `--`).
5. Glob JS fallback: check `!item.isSymbolicLink()` before recursing. Re-validate each discovered path with `isRealPathAllowed`.

**Tests:** symlink in tree pointing outside sandbox — grep/glob results don't include outside content.

**Commit:** `security(grep/glob): --no-dereference, fused glob arg, reject dash-prefixed, symlink filter`

---

## Finding 6 — Auth hardening (Critical)

**Files:** `src/node/auth/login.ts`, `resolver.ts`

**Fixes:**

1. Callback server: return `404` uniformly for all non-matching paths (remove `400 Invalid state` oracle).
2. `exchangeToken`: decode JWT (no-verify), assert `exp * 1000 > Date.now()` and `exp * 1000 < Date.now() + 31 days`. Log warning if `RC_LLM_PROXY_URL` is not default.
3. `resolver.ts`: remove telemetry-key fallback (`config.telemetry.apiKey`, `RC_TELEMETRY_API_KEY`). Resolution chain: `config.authToken` → `RC_AUTH_TOKEN` → `getSession()` → null.
4. Warn loudly at login if `RC_LLM_PROXY_URL` is not the default production URL.

**Tests:** wrong-state path returns 404; expired JWT rejected; `RC_TELEMETRY_API_KEY` alone doesn't authenticate LLM calls.

**Commit:** `security(auth): uniform 404, JWT exp check, remove telemetry key fallback`

---

## Finding 7 — Bash truncation reject path

**File:** `src/node/tools/bash.ts`

**Fix:** Single truncation kill guard (`truncKilled` boolean); resolve on truncation+non-zero (don't reject).

**Commit:** (included in Finding 1)

---

## Finding 8 — Error message sanitization (High)

**Files:** all tools

**Fix:** Create `src/node/security/safe-error.ts`:

```ts
export type ToolErrorCode =
  | 'path_not_allowed' | 'not_found' | 'permission_denied'
  | 'io_error' | 'fetch_failed' | 'spawn_failed' | 'invalid_input';

export function safeToolError(err: unknown, fallbackCode: ToolErrorCode): ToolExecutionError {
  const code = mapErrnoToCode(err, fallbackCode);
  return new ToolExecutionError(`[${code}] operation failed`);
}

export function safePathError(operation: string): ToolExecutionError {
  return new ToolExecutionError(`[path_not_allowed] ${operation} denied`);
}

function mapErrnoToCode(err: unknown, fallback: ToolErrorCode): ToolErrorCode {
  const code = (err as { code?: string })?.code;
  if (code === 'ENOENT') return 'not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  return fallback;
}
```

Replace all `throw new ToolExecutionError(\`...${params.file_path}...\`)` with `safeToolError` / `safePathError`. Never embed LLM-controlled strings.

**Commit:** `security(tools): safeToolError helper, strip LLM-controlled strings from errors`

---

## Finding 9 — Grep --glob arg injection (High)

**File:** `src/node/tools/grep.ts:55–59`

**Fix:** Reject dash-prefixed `pattern` or `glob`; fused form `--glob=<value>`.

**Commit:** (included in Finding 5)

---

## Finding 10 — MCP trust + capability (High)

**Files:** `src/node/mcp/manager.ts`, `src/core/mcp/tools.ts`, `src/core/types.ts`

**Fixes:**

1. `manager.ts`: before `StdioClientTransport`, check `config.trustLevel === 'trusted'`. Else throw `McpConnectionError`.
2. Sanitize env: start from `config.env ?? {}` (not full `process.env`), delete `LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH`, `NODE_OPTIONS`, `NODE_PATH`.
3. `wrapMcpTool` accepts optional `capabilities?: Capability[]` (defaults `['mcp:call']`). Add to `McpServerConfig` type. Manager forwards per-server capabilities.

**Tests:** stdio without trustLevel throws; trusted server env is sanitized.

**Commit:** `security(mcp): stdio requires trusted, sanitize env, per-server capabilities`

---

## Finding 11 — File permissions (Important)

**Files:** `src/node/session/node-session-store.ts`, `memory/node-memory-store.ts`

**Fix:** `{ mode: 0o600 }` on file writes; `{ mode: 0o700 }` on dir creation; `chmod 0o600` after rename (wrap in try/catch with warning for FSes that don't support it).

**Tests:** after save, `fs.stat(filePath).mode & 0o777 === 0o600` (skip on Windows).

**Commit:** `security(session/memory): 0o600 file mode, 0o700 dir mode`

---

## Build Sequence

### Phase 1 — Security module (no functional change)
- [ ] `src/node/security/path-mutex.ts` + test
- [ ] `src/node/security/safe-error.ts` + test
- [ ] `src/node/security/index.ts` re-exports

### Phase 2 — Core type additions
- [ ] `shell:exec` in Capability + MUTATION_CAPABILITIES
- [ ] `McpServerConfig.capabilities`

### Phase 3 — Bash (Finding 1, 7)
- [ ] env scrub, group-kill, truncKilled guard, shell:exec cap

### Phase 4 — WebFetch SSRF (Finding 2)
- [ ] scheme + IP check, manual redirect, streaming body cap

### Phase 5 — Edit/Write race + binary (Finding 3)
- [ ] PathMutex, atomic rename, binary guard, overlap fix

### Phase 6 — Read O_NOFOLLOW (Finding 4)
- [ ] openSafe helper, realpath-based I/O

### Phase 7 — Grep/Glob (Findings 5, 9)
- [ ] --no-dereference, fused glob, reject dash-prefixed, lstat filter

### Phase 8 — Error sanitization (Finding 8)
- [ ] safeToolError everywhere; invert tests that assert paths appear

### Phase 9 — Auth (Finding 6)
- [ ] uniform 404, JWT exp, remove telemetry fallback

### Phase 10 — MCP (Finding 10)
- [ ] trustLevel enforcement, env sanitization, per-server caps

### Phase 11 — File perms (Finding 11)
- [ ] 0o600/0o700 across session + memory stores

### Phase 12 — Integration
- [ ] Full `bun run test && bun run lint`
- [ ] Exploit smoke: symlink dir + crafted `file://` + concurrent Edit + secret-leaking Bash cmd — all blocked/scrubbed

---

## Critical Details

**Out of scope:**
- Process-level sandboxing (seccomp, namespaces) — infra-level
- Full DNSSEC — IP-locking mitigates DNS-rebinding for the fetch duration only
- `shell:exec` is a breaking change for users with rules targeting `'process:spawn'` for Bash — call out in CHANGELOG

**Testing:**
- Symlink tests skip with `test.skip` if `fs.symlinkSync` throws `EPERM` (CI permission restrictions)
- Concurrent edit tests use `Promise.all([tool.execute(...), tool.execute(...)])`
- `O_NOFOLLOW` tests skip on Windows (`process.platform === 'win32'`)

**Performance:**
- PathMutex serializes same-file writes. Different files unaffected.
- DNS in WebFetch adds one RTT per request; cache resolved IP for redirect chain only
- `undici` already bundled in Node 20

**State:**
- PathMutex module-level singleton; tests needing isolation instantiate a fresh one
- Env scrub in Bash executes at `execute()` time, not factory time (captures process.env at invocation)
