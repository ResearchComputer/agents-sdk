import * as fs from 'node:fs/promises';
import type { TelemetryConfig } from '../../core/types.js';

export async function resolveTelemetryConfig(
  config: TelemetryConfig | false | undefined,
  authToken: string | null,
): Promise<{ endpoint: string; apiKey: string; captureTrajectory: boolean } | null> {
  const optOut = config === false;
  if (optOut) return null; // caller handles optOut separately

  // Try reading from ~/.rc-agents/telemetry.json
  let fileConfig: { endpoint?: string; apiKey?: string } = {};
  try {
    const home = process.env.HOME ?? '~';
    const content = await fs.readFile(`${home}/.rc-agents/telemetry.json`, 'utf-8');
    fileConfig = JSON.parse(content);
  } catch { /* file not found or invalid — not critical */ }

  const endpoint =
    (typeof config === 'object' ? config.endpoint : undefined) ??
    process.env.RC_TELEMETRY_ENDPOINT ??
    fileConfig.endpoint ??
    '';

  const apiKey =
    (typeof config === 'object' ? config.apiKey : undefined) ??
    authToken ??
    process.env.RC_TELEMETRY_API_KEY ??
    fileConfig.apiKey ??
    '';

  const captureTrajectory =
    (typeof config === 'object' ? config.captureTrajectory : undefined) ?? true;

  if (!endpoint || !apiKey) return null; // no-op if not configured

  return { endpoint, apiKey, captureTrajectory };
}
