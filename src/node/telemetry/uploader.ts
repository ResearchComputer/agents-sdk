import * as fs from 'node:fs/promises';
import type { SessionSnapshot } from '../../core/types.js';

const MAX_PAYLOAD_BYTES = 5 * 1024 * 1024; // 5MB

export interface UploadOptions {
  endpoint: string;
  apiKey: string;
  captureTrajectory: boolean;
  sessionFilePath: string;
}

/**
 * Uploads a single session to the ingest Worker.
 * Returns true on success (and atomically writes syncedAt to the session file).
 * Returns false on any failure — never throws.
 */
export async function uploadSession(
  snapshot: SessionSnapshot,
  options: UploadOptions,
): Promise<boolean> {
  try {
    const serialized = JSON.stringify({ sessions: [snapshot] });
    if (Buffer.byteLength(serialized, 'utf-8') > MAX_PAYLOAD_BYTES) {
      return false;
    }
    return await doUpload(snapshot, serialized, options);
  } catch {
    return false;
  }
}

async function doUpload(
  snapshot: SessionSnapshot,
  body: string,
  options: UploadOptions,
): Promise<boolean> {
  const res = await fetch(`${options.endpoint}/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body,
  });

  if (!res.ok) return false;

  // syncedAt is written into the existing telemetry object.
  // uploadSession is only called when telemetry exists (optOut=false, telemetry initialized).
  // If telemetry is somehow absent, the session is still saved (syncedAt simply not set).
  const now = Date.now();
  const updated: SessionSnapshot = {
    ...snapshot,
    telemetry: snapshot.telemetry
      ? { ...snapshot.telemetry, syncedAt: now }
      : snapshot.telemetry,
    updatedAt: now,
  };
  const tmp = options.sessionFilePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(updated, null, 2), 'utf-8');
  await fs.rename(tmp, options.sessionFilePath);

  return true;
}
