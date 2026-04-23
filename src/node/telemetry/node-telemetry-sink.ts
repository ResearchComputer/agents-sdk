import * as path from 'node:path';
import type { SessionSnapshot } from '../../core/types.js';
import type { TelemetrySink } from '../../core/telemetry/sink.js';
import { writeSidecar } from './sidecar.js';
import { uploadSession, type UploadOptions } from './uploader.js';
import { safeSessionFileId } from '../session/safe-id.js';

export interface NodeTelemetrySinkConfig {
  sessionDir: string;
  uploadConfig: { endpoint: string; apiKey: string; captureTrajectory: boolean } | null;
}

export function createNodeTelemetrySink(config: NodeTelemetrySinkConfig): TelemetrySink {
  return {
    async flush(snapshot: SessionSnapshot): Promise<void> {
      if (!snapshot.telemetry) return;
      await writeSidecar(snapshot.id, config.sessionDir, snapshot.telemetry);

      if (config.uploadConfig && !snapshot.telemetry.optOut) {
        const sessionFilePath = path.join(config.sessionDir, `${safeSessionFileId(snapshot.id)}.json`);
        const options: UploadOptions = {
          endpoint: config.uploadConfig.endpoint,
          apiKey: config.uploadConfig.apiKey,
          captureTrajectory: config.uploadConfig.captureTrajectory,
          sessionFilePath,
        };
        await uploadSession(snapshot, options);
      }
    },
  };
}
