# Core Concurrency & Lifecycle Fixes Implementation Plan

> Execute via superpowers:executing-plans or subagent-driven-development.

**Goal:** Eliminate the cluster of lifecycle / tiebreaker / leak bugs in core runtime so long-running processes and fork/autoFork/swarm semantics are deterministic.

**Architecture:** Localized edits across factory, middleware, swarm, run-context. New explicit `AutoForkState` machine replaces two loose booleans. Per-agent adapter scoping via `scopeAdaptersForChild()` helper eliminates shared-mutable-state across fork boundaries. Bounded LRU replaces module-level unbounded caches.

**Tech Stack:** TypeScript (strict), Vitest, Bun ≥ 1.3.0.

---

## Findings Summary (priority order)

| # | File(s) | Severity | Kind |
|---|---------|----------|------|
| 1 | `src/core/middleware/permissions.ts:107–114` | Critical | deny-beats-allow tiebreaker missing |
| 2 | `src/core/factory.ts:755–776` | Critical | Shared mutable adapters in fork children |
| 3 | `src/core/factory.ts:976–1001` | Critical | autoFork TOCTOU with dispose |
| 4 | `src/core/agents/tools.ts` | High | Swarm tools have no capability → unguarded spawn |
| 5 | `src/core/factory.ts:480–541` | High | llmCallStartTimes FIFO desyncs on stream errors |
| 6 | `src/core/context/run-context.ts:19` | High | 24-day un-unref timer keeps event loop alive |
| 7 | `src/core/agents/swarm.ts:127,146–160` | Medium | Timeout listener leak + error string matching |
| 8 | `src/core/middleware/permissions.ts:10` | Medium | Unbounded glob regex cache |
| 9 | `src/core/mcp/tools.ts:39–48` | Medium | Unbounded MCP schema cache |
| 10 | `src/core/agents/messages.ts`, `swarm.ts` | Low | Mailbox allocated but never read |
| 11 | `src/core/factory.ts:509–522` | Low | llm_api_call captures post-append messages (cross-ref telemetry plan) |
| 12 | `src/core/factory.ts:755–776` | Needs upstream | completeN drops pre-fetched responses on tool calls |

---

## Phase 1 — Safety-Critical

### Task 1.1 — deny-beats-allow tiebreaker

**File:** `src/core/middleware/permissions.ts:107–114`

**Problem:** `findMatchingRule` uses `>` not `>=`. At equal score (specificity × 10 + source_priority), first-seen wins. `composeAgentConfig` concatenates skill rules before user rules (`src/core/skills.ts:33`), so a skill `deny` silently beats a user `allow` at the same specificity+source.

**Fix:**

```ts
const score = getSpecificity(rule) * 10 + (SOURCE_PRIORITY[rule.source] ?? 0);
if (score > bestScore || (score === bestScore && rule.behavior === 'deny')) {
  bestScore = score;
  bestRule = rule;
}
```

**Tests** (`permissions.test.ts`):
- Equal specificity + source: `deny` beats `allow` regardless of array order
- Skill `deny` vs user `allow` at equal specificity but different source: user wins on source_priority (no tie)
- Skill `deny` vs user `deny` at exact equal score: idempotent

**Commit:** `fix(permissions): deny beats allow on score tie`

---

### Task 1.2 — `scopeAdaptersForChild()` helper

**Files:** `src/core/factory.ts:755–776`, new `src/core/adapters/child-scope.ts`

**Problem:** `_spawnChildren` passes parent's `adapters` directly to children. Each child's `dispose()` calls `mcp.disconnect()` on parent connections; telemetry is double-counted; session IDs can collide.

**Fix:** Create `src/core/adapters/child-scope.ts` exporting:

```ts
export function scopeAdaptersForChild(
  adapters: CoreAdapters,
  parentSessionId: string,
  childIndex: number,
): CoreAdapters {
  return {
    ...adapters,
    mcpManager: wrapMcpManagerReadOnly(adapters.mcpManager),
    telemetryCollector: createChildTelemetryCollector(adapters.telemetryCollector, {
      parentSessionId, childIndex,
    }),
  };
}
```

`wrapMcpManagerReadOnly` forwards `listTools`/`callTool`/`getTools`/`getConnections`; turns `disconnect` and destructive methods into no-ops.

`createChildTelemetryCollector` is fresh per-child; on `flush`/`finalize` it does a write-through to parent's sink (tagged with `parentSessionId`, `childIndex`) but doesn't double-count parent totals.

In `_spawnChildren` replace:
```ts
createAgentCore(childConfig, adapters)
```
with:
```ts
createAgentCore(
  { ...childConfig, sessionId: `${runContext.sessionId}-child-${i}` },
  scopeAdaptersForChild(adapters, runContext.sessionId, i),
)
```

**Tests:**
- Child `dispose()` does not call parent `mcpManager.disconnect()`
- Child telemetry tagged with parent ID; parent totals unchanged
- Two children get distinct session IDs

**Commit:** `feat(core): scopeAdaptersForChild — isolate fork children from parent adapters`

---

### Task 1.3 — AutoForkState machine

**File:** `src/core/factory.ts:699–701, 976–1001`

**Problem:** `isDisposing` and `inFlightAutoFork` are two booleans with TOCTOU between check and `fork()` await. `lastUserMessage` can be stale if turns overlap.

**Fix:**

```ts
type AutoForkState = 'idle' | 'forking' | 'disposing';
let autoForkState: AutoForkState = 'idle';
let inFlightAutoForkPromise: Promise<void> | null = null;

// dispose():
if (autoForkState === 'disposing') return;
if (autoForkState === 'forking') {
  autoForkState = 'disposing';
  await inFlightAutoForkPromise;
} else {
  autoForkState = 'disposing';
}
// ... proceed teardown

// turn_end subscriber:
if (autoForkState !== 'idle' || !lastUserMessage) return;
autoForkState = 'forking';
const message = lastUserMessage;
lastUserMessage = undefined;
inFlightAutoForkPromise = sdkAgent
  .fork(message, autoFork.branches)
  .then(children => {
    if (autoForkState !== 'disposing') {
      return autoFork.onBranches(children);
    }
  })
  .catch(err => autoFork.onError?.(err instanceof Error ? err : new Error(String(err))))
  .finally(() => {
    if (autoForkState === 'forking') autoForkState = 'idle';
    inFlightAutoForkPromise = null;
  });
```

**State transition table:**

| State | Event | → State | Action |
|---|---|---|---|
| `idle` | `turn_end` + msg | `forking` | start fork |
| `idle` | `dispose()` | `disposing` | proceed teardown |
| `forking` | fork resolves | `idle` | clear promise |
| `forking` | `dispose()` | `disposing` | await promise |
| `forking` | fork resolves in `disposing` | `disposing` | skip onBranches |
| `disposing` | any | `disposing` | guard early |

**Tests:**
- `dispose()` while forking: awaits fork, then tears down
- Double dispose: second is no-op
- `turn_end` while forking: no second fork
- `onBranches` not called when dispose wins the race

**Commit:** `fix(core): replace autoFork booleans with AutoForkState machine`

---

### Task 1.4 — `swarm:mutate` capability

**Files:** `src/core/agents/tools.ts`, `src/core/types.ts`, `src/core/middleware/permissions.ts`

**Problem:** Swarm tools declare `capabilities: []`. In default mode, no-cap tools run unconditionally.

**Fix:**

1. Add `'swarm:mutate'` to `Capability` union in `types.ts`
2. Add to `MUTATION_CAPABILITIES` in `permissions.ts`
3. Update `SpawnTeammate`, `SendMessage`, `DismissTeammate` in `agents/tools.ts`:
   ```ts
   capabilities: ['swarm:mutate']
   ```

**Tests:** default mode with no rules → `SpawnTeammate` returns `ask`.

**Commit:** `feat(core): add swarm:mutate capability, gate swarm tools`

---

## Phase 2 — Correctness Leaks

### Task 2.1 — Key `llmCallStartTimes` by seq; capture request_messages pre-append

**File:** `src/core/factory.ts:480–541`

**Problem:** `number[]` FIFO desyncs on stream errors. Also: `llm_api_call.request_messages` captures post-append state.

**Fix:**

```ts
let llmCallSeq = 0;
const llmCallStartTimes = new Map<number, number>();
const llmCallRequestMessages = new Map<number, unknown[]>();

// message_start:
const seq = ++llmCallSeq;
(event as unknown as { _seq: number })._seq = seq;
llmCallStartTimes.set(seq, Date.now());
llmCallRequestMessages.set(seq, structuredClone(agent.state.messages));

// message_end:
const seq = (event as unknown as { _seq?: number })._seq ?? 0;
const startTime = llmCallStartTimes.get(seq) ?? Date.now();
const requestMessages = llmCallRequestMessages.get(seq) ?? [];
llmCallStartTimes.delete(seq);
llmCallRequestMessages.delete(seq);
// use requestMessages in trajectoryWriter.append(...)
```

If event objects aren't stable across start/end, use a `WeakMap<object, number>` keyed by the `message` reference (confirm pi-agent-core's contract).

**Tests:**
- Stream error mid-call: subsequent call's latency is correct
- `llm_api_call` `request_messages` does not include the just-emitted assistant reply

**Commit:** `fix(core): key llmCallStartTimes by seq; capture request_messages before reply`

---

### Task 2.2 — Replace 24-day timeout in run-context

**File:** `src/core/context/run-context.ts:19`

**Fix:**

```ts
signal: options.signal ?? new AbortController().signal,
```

**Tests:** `createRunContext({cwd:'.'}).signal` is not aborted; provided signal is forwarded unchanged.

**Commit:** `fix(core): replace AbortSignal.timeout(MAX_INT) with AbortController`

---

### Task 2.3 — Swarm timeout listener leak + error classification

**File:** `src/core/agents/swarm.ts:124–131, 146–160`

**Fix:**

```ts
let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
if (config.budget.timeoutMs) {
  timeoutHandle = setTimeout(() => {
    abortController.abort();
    agent.abort();
  }, config.budget.timeoutMs);
}

agent.prompt(config.prompt).then(
  () => {
    clearTimeout(timeoutHandle);
    teammate.status = 'idle';
    teammate.terminationReason = 'taskComplete';
  },
  (err) => {
    clearTimeout(timeoutHandle);
    teammate.status = 'stopped';
    if (abortController.signal.aborted) {
      teammate.terminationReason = 'budgetExhausted';
    } else {
      teammate.terminationReason = 'error';
      teammate.error = err instanceof Error ? err.message : String(err);
    }
  },
);
```

**Tests:**
- Normal completion: `clearTimeout` fires, no leak
- Timeout: `terminationReason === 'budgetExhausted'`
- Error containing word "aborted" but not actually aborted: `terminationReason === 'error'`

**Commit:** `fix(core): swarm timeout uses setTimeout/clearTimeout; classify via signal.aborted`

---

## Phase 3 — Resource Bounds

### Task 3.1 — BoundedMap for glob regex cache

**Files:** new `src/core/util/bounded-map.ts`, modify `src/core/middleware/permissions.ts:10`

**New file:**

```ts
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maxSize: number) { super(); }
  set(key: K, value: V): this {
    if (!this.has(key) && this.size >= this.maxSize) {
      this.delete(this.keys().next().value!);
    }
    return super.set(key, value);
  }
}
```

Replace:
```ts
import { BoundedMap } from '../util/bounded-map.js';
const globRegexCache = new BoundedMap<string, RegExp | null>(1000);
```

**Tests** (`bounded-map.test.ts`): cap enforcement, hit path doesn't evict.

**Commit:** `fix(core): BoundedMap for globRegexCache`

---

### Task 3.2 — BoundedMap for MCP schema cache

**File:** `src/core/mcp/tools.ts:39–48`

Reuse `BoundedMap(1000)`.

**Commit:** `fix(core): BoundedMap for MCP schemaCache`

---

### Task 3.3 — Remove unused AsyncQueue mailbox

**Files:** `src/core/agents/swarm.ts`

Remove `mailbox` field from `InternalTeamAgent`; remove allocation for leader and teammates; remove `mailbox.clear()` calls from `removeTeammate`/`destroyTeam`. Keep `AsyncQueue` class in `messages.ts` (independent value).

**Commit:** `refactor(core): remove unused AsyncQueue mailbox from swarm teammates`

---

## Phase 4 — Upstream Coordination

### Task 4.1 — `completeN` fallback when any child has tool calls

**File:** `src/core/factory.ts:759–776`

**Option A (ship now):** fall back to sequential path when any response has tool calls:

```ts
const anyHasToolCalls = firstResponses.some(r =>
  r.content.some(b => b.type === 'toolCall')
);
if (anyHasToolCalls) {
  // fall through to non-completeN path
}
```

**Option B (upstream):** file `@mariozechner/pi-agent-core` issue requesting `promptWithSeed` API so children can continue from a pre-fetched response.

**Tests** (`src/node/fork.test.ts`): fork with `completeN`, mock any response with a tool call, assert all children complete the same number of LLM turns.

**Commit:** `fix(core): completeN falls back to sequential when any child has tool calls`

---

## Build Sequence

### Phase 1 — Safety-critical (ship together)
- [ ] 1.1 deny-beats-allow tiebreaker
- [ ] 1.2 scopeAdaptersForChild + wire into _spawnChildren
- [ ] 1.3 AutoForkState machine
- [ ] 1.4 swarm:mutate capability

### Phase 2 — Correctness leaks
- [ ] 2.1 llmCallStartTimes by seq + request_messages snapshot
- [ ] 2.2 AbortController for run-context signal
- [ ] 2.3 swarm timeout listener leak

### Phase 3 — Resource bounds
- [ ] 3.1 BoundedMap + permissions cache
- [ ] 3.2 BoundedMap for MCP cache
- [ ] 3.3 remove unused mailbox

### Phase 4 — Upstream coordination
- [ ] 4.1 completeN fallback + file upstream issue

---

## Critical Details

**Error handling:** `scopeAdaptersForChild` MCP facade must swallow errors from no-op methods, not throw.

**Testing:** All new tests go under existing Vitest suite. `src/core/` tests must not import `node:*` (enforced). Mock `adapters.llmClient.completeN` in fork tests.

**Performance:** `BoundedMap` eviction is O(1) amortized. `AutoForkState` adds zero overhead (string comparison).

**Backwards compatibility:** `Capability` union adding `'swarm:mutate'` is additive. `AutoForkState` is internal. `scopeAdaptersForChild` not exported publicly.
