import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { writeSidecar } from './sidecar.js';
import { createNodeTelemetrySink } from './node-telemetry-sink.js';
import type { SessionSnapshot, SessionTelemetry } from '../../core/types.js';

vi.mock('node:fs/promises');

const mockFs = vi.mocked(fs);

beforeEach(() => {
  vi.clearAllMocks();
  mockFs.mkdir.mockResolvedValue(undefined);
  mockFs.writeFile.mockResolvedValue(undefined);
  mockFs.rename.mockResolvedValue(undefined);
  mockFs.unlink.mockResolvedValue(undefined);
});

function makeTelemetry(overrides: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return {
    schemaVersion: 1,
    optOut: false,
    llmCalls: [],
    toolEvents: [],
    totalCost: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    version: 2,
    id: 'sess-test',
    trajectoryId: '01J9ZSZABCDEFGHJKMNPQRSTVW',
    lastEventId: null,
    modelId: 'gpt-4o',
    providerName: 'openai',
    systemPromptHash: 'abc',
    memoryRefs: [],
    telemetry: makeTelemetry(),
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('writeSidecar', () => {
  it('writes sidecar atomically via tmp+rename', async () => {
    const telemetry = makeTelemetry();
    await writeSidecar('abc', '/tmp/sessions', telemetry);

    expect(mockFs.mkdir).toHaveBeenCalledWith('/tmp/sessions', { recursive: true });
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/tmp/sessions/abc.telemetry.json.tmp',
      expect.any(String),
      'utf-8',
    );
    expect(mockFs.rename).toHaveBeenCalledWith(
      '/tmp/sessions/abc.telemetry.json.tmp',
      '/tmp/sessions/abc.telemetry.json',
    );
  });

  it('serializes telemetry JSON correctly', async () => {
    const telemetry = makeTelemetry({ totalTokens: 42, totalCost: 0.5 });
    await writeSidecar('abc', '/tmp/sessions', telemetry);

    const written = JSON.parse(mockFs.writeFile.mock.calls[0][1] as string);
    expect(written.totalTokens).toBe(42);
    expect(written.totalCost).toBe(0.5);
  });

  it('sanitizes session ids before constructing sidecar paths', async () => {
    const telemetry = makeTelemetry();
    await writeSidecar('../escape/session', '/tmp/sessions', telemetry);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/tmp/sessions/___escape_session.telemetry.json.tmp',
      expect.any(String),
      'utf-8',
    );
    expect(mockFs.rename).toHaveBeenCalledWith(
      '/tmp/sessions/___escape_session.telemetry.json.tmp',
      '/tmp/sessions/___escape_session.telemetry.json',
    );
  });
});

describe('createNodeTelemetrySink', () => {
  it('calls writeSidecar on flush when telemetry present', async () => {
    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: null,
    });
    const snapshot = makeSnapshot();
    await sink.flush(snapshot);

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/tmp/sessions/sess-test.telemetry.json.tmp',
      expect.any(String),
      'utf-8',
    );
    expect(mockFs.rename).toHaveBeenCalledWith(
      '/tmp/sessions/sess-test.telemetry.json.tmp',
      '/tmp/sessions/sess-test.telemetry.json',
    );
  });

  it('uses sanitized session ids for upload session-file paths', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: {
        endpoint: 'https://ingest.example.com',
        apiKey: 'sk-test',
        captureTrajectory: true,
      },
    });
    await sink.flush(makeSnapshot({ id: '../escape/session' }));

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      '/tmp/sessions/___escape_session.json.tmp',
      expect.any(String),
      'utf-8',
    );
  });

  it('does nothing when snapshot has no telemetry', async () => {
    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: null,
    });
    const snapshot = makeSnapshot({ telemetry: undefined });
    await sink.flush(snapshot);

    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('does not upload when uploadConfig is null', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: null,
    });
    await sink.flush(makeSnapshot());

    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uploads when uploadConfig is set and optOut is false', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: {
        endpoint: 'https://ingest.example.com',
        apiKey: 'sk-test',
        captureTrajectory: true,
      },
    });
    await sink.flush(makeSnapshot());

    expect(mockFetch).toHaveBeenCalledWith(
      'https://ingest.example.com/ingest',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('does not upload when optOut is true even if uploadConfig is set', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const sink = createNodeTelemetrySink({
      sessionDir: '/tmp/sessions',
      uploadConfig: {
        endpoint: 'https://ingest.example.com',
        apiKey: 'sk-test',
        captureTrajectory: true,
      },
    });
    await sink.flush(makeSnapshot({ telemetry: makeTelemetry({ optOut: true }) }));

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
