import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveTelemetryConfig } from './resolve-config.js';

describe('resolveTelemetryConfig', () => {
  const origEndpoint = process.env.RC_TELEMETRY_ENDPOINT;
  const origApiKey = process.env.RC_TELEMETRY_API_KEY;
  const origHome = process.env.HOME;

  afterEach(() => {
    if (origEndpoint === undefined) delete process.env.RC_TELEMETRY_ENDPOINT;
    else process.env.RC_TELEMETRY_ENDPOINT = origEndpoint;
    if (origApiKey === undefined) delete process.env.RC_TELEMETRY_API_KEY;
    else process.env.RC_TELEMETRY_API_KEY = origApiKey;
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    vi.restoreAllMocks();
  });

  it('returns null when config is false (opt out)', async () => {
    expect(await resolveTelemetryConfig(false, 'tok')).toBeNull();
  });

  it('returns null when no endpoint/apiKey is configured anywhere', async () => {
    delete process.env.RC_TELEMETRY_ENDPOINT;
    delete process.env.RC_TELEMETRY_API_KEY;
    // Point HOME at a directory with no telemetry.json.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-home-'));
    process.env.HOME = tmp;
    expect(await resolveTelemetryConfig(undefined, null)).toBeNull();
  });

  it('builds an upload config from explicit config + authToken', async () => {
    const result = await resolveTelemetryConfig(
      { endpoint: 'https://example.test/ingest', captureTrajectory: false },
      'the-auth-token',
    );
    expect(result).toEqual({
      endpoint: 'https://example.test/ingest',
      apiKey: 'the-auth-token',
      captureTrajectory: false,
    });
  });

  it('reads endpoint and apiKey from ~/.rc-agents/telemetry.json as a fallback', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-home-'));
    await fs.mkdir(path.join(tmp, '.rc-agents'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, '.rc-agents', 'telemetry.json'),
      JSON.stringify({ endpoint: 'https://from-file/ingest', apiKey: 'file-key' }),
      'utf-8',
    );
    process.env.HOME = tmp;
    delete process.env.RC_TELEMETRY_ENDPOINT;
    delete process.env.RC_TELEMETRY_API_KEY;

    const result = await resolveTelemetryConfig(undefined, null);
    expect(result).toEqual({
      endpoint: 'https://from-file/ingest',
      apiKey: 'file-key',
      captureTrajectory: true,
    });
  });

  it('falls back to ~ when HOME is unset and still works (file not found path)', async () => {
    delete process.env.HOME;
    delete process.env.RC_TELEMETRY_ENDPOINT;
    delete process.env.RC_TELEMETRY_API_KEY;
    const result = await resolveTelemetryConfig(undefined, null);
    expect(result).toBeNull();
  });

  it('tolerates a malformed telemetry.json without throwing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'rc-home-'));
    await fs.mkdir(path.join(tmp, '.rc-agents'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.rc-agents', 'telemetry.json'), '{{ bad', 'utf-8');
    process.env.HOME = tmp;
    delete process.env.RC_TELEMETRY_ENDPOINT;
    delete process.env.RC_TELEMETRY_API_KEY;

    const result = await resolveTelemetryConfig(undefined, null);
    expect(result).toBeNull();
  });
});
