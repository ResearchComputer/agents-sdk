import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { uploadSession } from './uploader.js';
import type { SessionSnapshot } from '../../core/types.js';

vi.mock('node:fs/promises');
const mockFs = vi.mocked(fs);

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.rename.mockResolvedValue(undefined);
});

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 2,
    id: 'sess-1',
    trajectoryId: '01J9ZSZABCDEFGHJKMNPQRSTVW',
    lastEventId: null,
    modelId: 'gpt-4o',
    providerName: 'openai',
    systemPromptHash: 'abc',
    memoryRefs: [],
    telemetry: {
      schemaVersion: 1,
      optOut: false,
      llmCalls: [],
      toolEvents: [],
      totalCost: 0,
      totalTokens: 0,
    },
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('uploadSession', () => {
  it('POSTs to endpoint with Authorization header', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    const ok = await uploadSession(makeSnapshot(), {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.example.com/ingest',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer sk-test' }),
      }),
    );
  });

  it('writes syncedAt atomically to session file on success', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await uploadSession(makeSnapshot(), {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    const writtenContent = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
    expect(writtenContent.telemetry.syncedAt).toBeTypeOf('number');
    expect(mockFs.rename).toHaveBeenCalledWith(
      '/tmp/sessions/sess-1.json.tmp',
      '/tmp/sessions/sess-1.json',
    );
  });

  it('returns false and does not write syncedAt on HTTP error', async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500 });

    const ok = await uploadSession(makeSnapshot(), {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    expect(ok).toBe(false);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('returns false silently on fetch error', async () => {
    mockFetch.mockRejectedValue(new Error('network error'));

    const ok = await uploadSession(makeSnapshot(), {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    expect(ok).toBe(false);
  });

  it('returns false when syncedAt write fails after successful HTTP upload', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    mockFs.writeFile.mockRejectedValue(new Error('disk full'));

    const ok = await uploadSession(makeSnapshot(), {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    // Server received the session but local syncedAt write failed — returns false
    // so the daemon will retry (server deduplicates on sessionId)
    expect(ok).toBe(false);
  });

  it('uploads a v2 snapshot without stripping (no inline messages field)', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const v2Snapshot = {
      version: 2 as const,
      id: 'v2-sess',
      trajectoryId: '01J9ZSZABCDEFGHJKMNPQRSTVW',
      lastEventId: '01J9ZSZABCDEFGHJKMNPQRSTVX',
      modelId: 'gpt-4o',
      providerName: 'openai',
      systemPromptHash: 'abc',
      memoryRefs: [],
      contextState: {
        selectedMemories: [],
        costState: { totalTokens: 0, totalCost: 0, perModel: [] },
        interruptedToolCallIds: [],
      },
      telemetry: {
        schemaVersion: 1,
        optOut: false,
        llmCalls: [],
        toolEvents: [],
        totalCost: 0,
        totalTokens: 0,
      },
      createdAt: 1000,
      updatedAt: 2000,
    };

    const ok = await uploadSession(v2Snapshot as any, {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: false,
      sessionFilePath: '/tmp/sessions/v2.json',
    });

    expect(ok).toBe(true);
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sessions[0].version).toBe(2);
  });

  it('skips upload and returns false when even the stripped payload exceeds 5MB', async () => {
    // Non-messages fields (telemetry events) > 5MB so the retry without messages
    // still exceeds the limit.
    const bigLlmCalls = Array.from({ length: 3000 }, (_, i) => ({
      id: `call-${i}`,
      model: 'gpt-4o',
      prompt: 'x'.repeat(2000),
    })) as any[];
    const snapshot = makeSnapshot({
      telemetry: {
        schemaVersion: 1,
        optOut: false,
        llmCalls: bigLlmCalls,
        toolEvents: [],
        totalCost: 0,
        totalTokens: 0,
      },
    });

    const ok = await uploadSession(snapshot, {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    expect(ok).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('leaves telemetry unset on the session file when the snapshot never had one', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    const snapshot = makeSnapshot({ telemetry: undefined });

    const ok = await uploadSession(snapshot, {
      endpoint: 'https://ingest.example.com',
      apiKey: 'sk-test',
      captureTrajectory: true,
      sessionFilePath: '/tmp/sessions/sess-1.json',
    });

    expect(ok).toBe(true);
    const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
    expect(written.telemetry).toBeUndefined();
  });

  it('captureTrajectory=false nulls trajectoryId and lastEventId in the uploaded body', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await uploadSession(
      makeSnapshot({ trajectoryId: 'traj-abc', lastEventId: 'ev-1' }),
      {
        endpoint: 'https://ingest.example.com',
        apiKey: 'sk-test',
        captureTrajectory: false,
        sessionFilePath: '/tmp/sessions/sess-1.json',
      },
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sessions[0].trajectoryId).toBeNull();
    expect(body.sessions[0].lastEventId).toBeNull();
  });

  it('captureTrajectory=true preserves trajectoryId and lastEventId', async () => {
    mockFetch.mockResolvedValue({ ok: true, status: 200 });

    await uploadSession(
      makeSnapshot({ trajectoryId: 'traj-abc', lastEventId: 'ev-1' }),
      {
        endpoint: 'https://ingest.example.com',
        apiKey: 'sk-test',
        captureTrajectory: true,
        sessionFilePath: '/tmp/sessions/sess-1.json',
      },
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.sessions[0].trajectoryId).toBe('traj-abc');
    expect(body.sessions[0].lastEventId).toBe('ev-1');
  });
});
