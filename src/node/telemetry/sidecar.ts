import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionTelemetry } from '../../core/types.js';
import { safeSessionFileId } from '../session/safe-id.js';

export async function writeSidecar(sessionId: string, dir: string, telemetry: SessionTelemetry): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  const safeId = safeSessionFileId(sessionId);
  const file = path.join(dir, `${safeId}.telemetry.json`);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(telemetry), 'utf-8');
  await fs.rename(tmp, file);
}
