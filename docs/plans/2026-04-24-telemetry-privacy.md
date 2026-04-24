# Telemetry Privacy Hardening Implementation Plan

> Note for agentic workers: This plan is designed for execution via
> superpowers:executing-plans or subagent-driven-development. Each task is
> independent unless its "Depends on" field says otherwise. Write the failing
> test first, make the minimal change to pass it, then commit. Do NOT modify
> files outside the listed scope for each task.

## Goal

Eliminate two privacy gaps in the telemetry pipeline: the silently-ignored
`captureTrajectory` flag that ships full conversation payloads regardless of
user intent, and the O(n²) full-history dump in `llm_api_call.request_messages`
that causes secrets typed in prompts to be persisted and uploaded.

## Architecture

The fix lives across three layers that are already cleanly separated. The core
factory (`src/core/factory.ts`) owns trajectory emit logic; a new
`redactMessages` adapter hook threads through `CoreAdapters` and `AgentConfig`
exactly as `redactArgs` does today. The node uploader (`src/node/telemetry/uploader.ts`)
receives the `captureTrajectory` flag that is already plumbed through
`resolve-config.ts` and `node-telemetry-sink.ts` but is never acted upon.
A new opt-in `createContentRedactor` helper in the existing
`src/core/trajectory/redactors.ts` module gives users a composable default that
scans for well-known secret patterns without being enabled by default.

## Tech Stack

- TypeScript (strict mode, ES modules, `"type": "module"`)
- Vitest (test runner; follow patterns in `src/node/factory-trajectory.test.ts`)
- Existing telemetry uploader (`src/node/telemetry/uploader.ts`)
- `@mariozechner/pi-agent-core` AgentMessage type

---

## Task 1 — Add `redactMessages` to `CoreAdapters` and `AgentConfig`

**Files:**
- Modify: `src/core/types.ts` (`AgentConfig`, after existing `redactArgs`)
- Modify: `src/core/factory.ts` (`CoreAdapters`, after existing `redactArgs`)

**Add to `AgentConfig`:**

```ts
/**
 * Optional redactor applied to AgentMessage arrays before they are written
 * to trajectory events (`llm_api_call.request_messages`, `agent_message.content`)
 * and before upload. Return a new array with sensitive content replaced.
 * A throwing redactor falls back to the original messages with a warning.
 * Default: passthrough.
 */
redactMessages?: (messages: AgentMessage[]) => AgentMessage[];
```

**Add to `CoreAdapters`:**

```ts
/** Mirror of AgentConfig.redactMessages — threaded through by the node factory. */
redactMessages?: (messages: AgentMessage[]) => AgentMessage[];
```

**Test:** none needed for pure type addition. Verify with `bun run lint`.

**Commit:** `feat(core/types): add redactMessages adapter hook to CoreAdapters and AgentConfig`

---

## Task 2 — Capture per-turn "messages sent" at `message_start`, emit delta at `message_end`

**Files:**
- Modify: `src/core/factory.ts` lines 480–541

**Context:** the subscriber at line 506–522 emits `request_messages:
agent.state.messages`, which by `message_end` includes every message
accumulated across all turns — O(n²) growth, and includes the just-appended
assistant reply (the "request" becomes response-time state).

**Minimal change:** declare a per-turn FIFO mirror alongside `llmCallStartTimes`:

```ts
const llmRequestSnapshots: unknown[][] = [];
```

In the `message_start` branch (alongside the existing `llmCallStartTimes.push`):

```ts
llmRequestSnapshots.push([...agent.state.messages]);
```

In the `message_end` branch:

```ts
const requestMessages = llmRequestSnapshots.shift() ?? [];
```

Replace `request_messages: agent.state.messages as unknown[]` with
`request_messages: requestMessages`.

**Note:** this FIFO pattern matches the existing `llmCallStartTimes` pattern
and is safe because pi-agent-core guarantees paired message_start/message_end
per assistant turn.

**Failing test (add to `src/node/factory-redact.test.ts` or a new file):**

```ts
it('llm_api_call request_messages contains only the turn input, not full history', async () => {
  const model = getModel('openai', 'gpt-4o-mini');
  let turn = 0;
  const streamFn: StreamFn = (m) => {
    turn++;
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content: [{ type: 'text' as const, text: `turn ${turn}` }],
      stopReason: 'stop' as const,
      api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'done', reason: 'stop', message: msg });
    return stream;
  };
  const agent = await createAgent({ model, permissionMode: 'allowAll',
    authToken: 't', sessionDir, memoryDir, streamFn });
  await agent.prompt('first message');
  await agent.prompt('second message');
  await agent.dispose();

  const entries = await fs.readdir(sessionDir);
  const trajFile = entries.find(e => e.endsWith('.trajectory.jsonl'))!;
  const events = (await fs.readFile(path.join(sessionDir, trajFile), 'utf-8'))
    .trim().split('\n').map(l => JSON.parse(l));
  const llmCalls = events.filter(e => e.event_type === 'llm_api_call');
  expect(llmCalls).toHaveLength(2);
  const turn2Messages: unknown[] = llmCalls[1].payload.request_messages;
  // Assistant reply for turn 2 must NOT be in turn 2's request (it's the response)
  const hasAssistantTurn2Reply = turn2Messages.some(
    (m: any) => m.role === 'assistant' && m.content?.[0]?.text === 'turn 2'
  );
  expect(hasAssistantTurn2Reply).toBe(false);
  expect(llmCalls[0].payload.request_messages.length)
    .toBeLessThan(llmCalls[1].payload.request_messages.length);
});
```

**Commit:** `fix(core/factory): emit per-turn request_messages delta instead of full history`

---

## Task 3 — Wire `redactMessages` into the trajectory emit path

**Files:**
- Modify: `src/core/factory.ts` lines 293–309 (after `redactArgs` wiring); lines 506–541 (trajectory subscriber)

**After `redactArgs` wiring, add:**

```ts
const redactMessages: (messages: AgentMessage[]) => AgentMessage[] =
  adapters.redactMessages
    ? (messages) => {
        try {
          return adapters.redactMessages!(messages);
        } catch (err) {
          addWarning(
            'redact_messages_failed',
            `redactMessages threw: ${(err as Error).message}`,
            err,
          );
          return messages;
        }
      }
    : (messages) => messages;
```

**At the `llm_api_call` emit (around line 513):**

```ts
request_messages: redactMessages(requestMessages as AgentMessage[]) as unknown[],
```

**At the `agent_message` emit (around line 531):**

```ts
if (trajectoryWriter && AGENT_MESSAGE_ROLES.has(msg.role)) {
  const trajRole = msg.role === 'toolResult' ? 'tool' : msg.role;
  const [redacted] = redactMessages([msg as unknown as AgentMessage]);
  const content = (redacted as unknown as { content?: unknown }).content;
  trajectoryWriter.append({
    event_type: 'agent_message',
    payload: {
      role: trajRole,
      content: content ?? null,
      ...(typeof msg.timestamp === 'number' ? { timestamp: msg.timestamp } : {}),
    },
  });
}
```

**Failing test:**

```ts
it('redactMessages scrubs message content in llm_api_call trajectory events', async () => {
  const streamFn: StreamFn = /* minimal stream returning one assistant turn */ ...;
  const agent = await createAgent({
    model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir, streamFn,
    redactMessages: (msgs) => msgs.map(m => ({
      ...m,
      content: Array.isArray((m as any).content)
        ? (m as any).content.map((c: any) =>
            c.type === 'text' ? { ...c, text: '[redacted]' } : c)
        : '[redacted]',
    })) as any,
  });
  await agent.prompt('SECRET_KEY=abc123');
  await agent.dispose();
  // Read JSONL, find llm_api_call, assert no 'SECRET_KEY' appears in request_messages texts
});
```

**Commit:** `feat(core/factory): apply redactMessages to trajectory llm_api_call and agent_message emits`

---

## Task 4 — Thread `redactMessages` through the node factory

**Files:**
- Modify: `src/node/factory.ts` — wherever `redactArgs: config.redactArgs` is forwarded

**Add:** `redactMessages: config.redactMessages,`

**Test:** the test from Task 3 already covers this since it goes through `createAgent`.

**Commit:** `feat(node/factory): thread redactMessages from AgentConfig through to CoreAdapters`

---

## Task 5 — Honor `captureTrajectory` in `uploader.ts`

**Files:**
- Modify: `src/node/telemetry/uploader.ts` lines 33–47

**Current behavior:** `doUpload` receives `options.captureTrajectory` but never reads it.

**Fix:** strip `trajectoryId` and `lastEventId` from the POST body when `captureTrajectory=false`:

```ts
async function doUpload(snapshot: SessionSnapshot, options: UploadOptions): Promise<boolean> {
  const uploadSnapshot = options.captureTrajectory
    ? snapshot
    : { ...snapshot, trajectoryId: null, lastEventId: null };
  const serialized = JSON.stringify({ sessions: [uploadSnapshot] });
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_PAYLOAD_BYTES) return false;
  const res = await fetch(`${options.endpoint}/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
    body: serialized,
  });
  if (!res.ok) return false;
  // ... existing syncedAt write unchanged
}
```

Move serialization inside `doUpload` (remove the pre-serialized `body` parameter).

**Failing test (add `src/node/telemetry/uploader.test.ts`):**

```ts
import { describe, it, expect, vi } from 'vitest';
import { uploadSession } from './uploader.js';
import type { SessionSnapshot } from '../../core/types.js';

describe('uploadSession captureTrajectory=false', () => {
  it('nulls trajectoryId in the POST body', async () => {
    const captured: string[] = [];
    global.fetch = vi.fn().mockImplementation(async (_url, init: RequestInit) => {
      captured.push(init.body as string);
      return { ok: true } as Response;
    });
    const snapshot = { /* minimal SessionSnapshot with trajectoryId: 'traj-abc' */ } as SessionSnapshot;
    await uploadSession(snapshot, { endpoint: 'http://fake', apiKey: 'k',
      captureTrajectory: false, sessionFilePath: '/tmp/fake.json' });
    const body = JSON.parse(captured[0]);
    expect(body.sessions[0].trajectoryId).toBeNull();
    expect(body.sessions[0].lastEventId).toBeNull();
  });
});
```

**Commit:** `fix(node/telemetry): honor captureTrajectory flag — strip trajectoryId from upload when false`

---

## Task 6 — Add opt-in `createContentRedactor` to redactors.ts

**Files:**
- Modify: `src/core/trajectory/redactors.ts` — append new export

```ts
export interface ContentRedactorOptions {
  replacement?: string;
}

/**
 * Build a redactMessages function that scans text content in each
 * AgentMessage and replaces well-known secret patterns with a sentinel.
 *
 * Patterns:
 *   - AWS access key IDs:  AKIA[A-Z0-9]{16}
 *   - OpenAI-style keys:   sk-[A-Za-z0-9]{20,}
 *   - JWT-shaped tokens:   three base64url segments separated by dots
 *
 * Opt-in only; not enabled by default in the factory.
 */
export function createContentRedactor(
  options: ContentRedactorOptions = {},
): (messages: AgentMessage[]) => AgentMessage[] {
  const replacement = options.replacement ?? '[redacted]';
  const patterns: RegExp[] = [
    /AKIA[A-Z0-9]{16}/g,
    /sk-[A-Za-z0-9]{20,}/g,
    /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  ];
  const scrubText = (text: string) => patterns.reduce((t, p) => t.replace(p, replacement), text);
  const scrubContent = (content: unknown): unknown => {
    if (typeof content === 'string') return scrubText(content);
    if (Array.isArray(content)) {
      return content.map((c) =>
        c && typeof c === 'object' && 'type' in c && c.type === 'text' && 'text' in c
          ? { ...c, text: scrubText(String((c as { text: unknown }).text)) }
          : c
      );
    }
    return content;
  };
  return (messages) =>
    messages.map((msg) => ({ ...msg, content: scrubContent((msg as any).content) } as any));
}
```

**Failing test (add to `src/core/trajectory/redactors.test.ts`):**

```ts
import { describe, it, expect } from 'vitest';
import { createContentRedactor } from './redactors.js';

describe('createContentRedactor', () => {
  const redact = createContentRedactor();
  it('replaces AWS key IDs', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'key is AKIAIOSFODNN7EXAMPLE' }] }] as any;
    expect(redact(msgs)[0].content[0].text).not.toContain('AKIA');
  });
  it('replaces sk- keys', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'sk-abcdefghijklmnopqrst' }] }] as any;
    expect(redact(msgs)[0].content[0].text).not.toContain('sk-abc');
  });
  it('passes clean messages through', () => {
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'hello world' }] }] as any;
    expect(redact(msgs)[0].content[0].text).toBe('hello world');
  });
});
```

**Commit:** `feat(core/trajectory): add opt-in createContentRedactor for common secret patterns`

---

## Task 7 — Replace tautological tests in `factory-redact.test.ts`

**Files:**
- Modify: `src/node/factory-redact.test.ts` — replace the three tests

**Problem:** existing tests assert `snap.version === 2` and `getWarnings()` is empty, without ever driving a tool call that exercises the redaction path.

**Replacement 1 — real tool-call redaction:**

```ts
it('redactArgs scrubs tool args written to the trajectory for a real tool call', async () => {
  const model = getModel('openai', 'gpt-4o-mini');
  let turn = 0;
  const streamFn: StreamFn = (m) => {
    turn++;
    const stream = createAssistantMessageEventStream();
    const msg = {
      role: 'assistant' as const,
      content: turn === 1
        ? [{ type: 'toolCall' as const, id: 'tc-1', name: 'SecretTool',
             arguments: { command: 'echo', password: 'hunter2' } }]
        : [{ type: 'text' as const, text: 'done' }],
      stopReason: turn === 1 ? 'toolUse' as const : 'stop' as const,
      api: m.api, provider: m.provider, model: m.id, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
               cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    stream.push({ type: 'start', partial: msg });
    stream.push({ type: 'done', reason: msg.stopReason === 'toolUse' ? 'toolUse' : 'stop', message: msg });
    return stream;
  };
  const secretTool = {
    name: 'SecretTool', label: 'Secret Tool', description: 'Takes a password',
    parameters: Type.Object({ command: Type.String(), password: Type.String() }),
    capabilities: [] as Capability[],
    async execute() {
      return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
    },
  };
  const agent = await createAgent({
    model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir,
    tools: [secretTool], streamFn,
    redactArgs: createKeyRedactor(['password']),
  });
  await agent.prompt('run it');
  await agent.dispose();

  const entries = await fs.readdir(sessionDir);
  const trajFile = entries.find(e => e.endsWith('.trajectory.jsonl'))!;
  const events = (await fs.readFile(path.join(sessionDir, trajFile), 'utf-8'))
    .trim().split('\n').map(l => JSON.parse(l));
  const toolCall = events.find(e => e.event_type === 'tool_call' && e.payload.tool_call_id === 'tc-1');
  expect(toolCall).toBeDefined();
  expect(toolCall.payload.args.password).toBe('[redacted]');
  expect(toolCall.payload.args.command).toBe('echo');
});
```

**Replacement 2 — upload-body stripping:**

```ts
it('uploader nulls trajectoryId when captureTrajectory=false', async () => {
  const fetchCalls: { body: string }[] = [];
  const originalFetch = global.fetch;
  global.fetch = (async (_url: any, init?: RequestInit) => {
    fetchCalls.push({ body: (init?.body as string) ?? '' });
    return { ok: false } as Response;
  }) as any;
  try {
    const agent = await createAgent({
      model, permissionMode: 'allowAll', authToken: 't', sessionDir, memoryDir,
      telemetry: { endpoint: 'http://fake-telemetry', apiKey: 'k', captureTrajectory: false },
    });
    await agent.dispose();
    if (fetchCalls.length > 0) {
      const body = JSON.parse(fetchCalls[0].body);
      expect(body.sessions[0].trajectoryId).toBeNull();
    }
  } finally {
    global.fetch = originalFetch;
  }
});
```

Keep the third test (throwing-redactor → warning) as-is since it's the one meaningful assertion in the current file.

**Commit:** `test(node/factory-redact): replace tautological stubs with real tool-call and upload assertions`

---

## Task 8 — Document the hooks

**Files:**
- Modify: `docs/concepts.md` OR `docs/api-reference.md` — add a "Telemetry Privacy" section (~50 lines)

**Cover:**
1. `redactArgs` (existing) — field-name-based scrubbing for tool args
2. `redactMessages` (new) — message-content scrubbing for LLM turns
3. `createContentRedactor` opt-in helper — patterns covered; NOT default-on
4. `captureTrajectory: false` — strips `trajectoryId` from upload body. The
   local `.trajectory.jsonl` sidecar is unaffected (intentional: local debug
   still works). Only upload behavior changes.
5. Per-turn delta emission (Task 2) — note that this also reduces the risk of
   the 5 MB upload guard silently dropping long sessions.

**Commit:** `docs: document redactMessages hook, captureTrajectory flag, and createContentRedactor helper`

---

## Build Sequence

- [ ] Task 1 — Type additions; `bun run lint` passes
- [ ] Task 2 — Per-turn delta; failing test + fix; `bun run test` passes
- [ ] Task 3 — `redactMessages` in trajectory emits; failing test + fix
- [ ] Task 4 — Node factory threads `redactMessages`
- [ ] Task 5 — `captureTrajectory` honored in uploader; failing test + fix
- [ ] Task 6 — `createContentRedactor`; unit tests pass
- [ ] Task 7 — Replace `factory-redact.test.ts`; full suite passes
- [ ] Task 8 — Docs

---

## Critical Details

**Error handling.** `redactMessages` throws → `SdkWarning` + raw messages returned. A throwing redactor must not kill a session.

**No-op default.** Both `redactMessages` and `createContentRedactor` are opt-in; factory ships no built-in secret scanner.

**Local trajectory unaffected by `captureTrajectory`.** The flag controls upload only; local JSONL still gets the full (redacted) trajectory. Document this boundary clearly (Task 8).

**FIFO safety.** `llmRequestSnapshots` push/shift pairs are safe because pi-agent-core guarantees paired message_start/message_end per subscriber. Document the assumption in a short comment.

**`src/core/` purity.** `createContentRedactor` must not import `node:*`. `AgentMessage` from `@mariozechner/pi-agent-core` is already under the documented exception.
