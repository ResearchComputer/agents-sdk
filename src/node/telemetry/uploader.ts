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
    // When captureTrajectory=false, strip trajectory pointers from the
    // uploaded payload so the ingest worker does not attempt to fetch the
    // sidecar or embed trajectory content. The local .trajectory.jsonl file
    // is unaffected — users still get full local debugging.
    // Cast because the wire shape allows nullable pointers while the
    // in-memory SessionSnapshot type requires a non-null trajectoryId for
    // replay; the upload is a one-way view, never deserialized back.
    const uploadSnapshot: unknown = options.captureTrajectory
      ? snapshot
      : { ...snapshot, trajectoryId: null, lastEventId: null };
    const serialized = JSON.stringify({ sessions: [uploadSnapshot] });
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
