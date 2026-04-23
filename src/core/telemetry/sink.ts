import type { SessionSnapshot } from '../types.js';

export interface TelemetrySink {
  flush(snapshot: SessionSnapshot): Promise<void>;
}
