import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { newUlid, isUlid, nowIso } from '../../core/spec/ids.js';
import type {
  TrajectoryWriter,
  TrajectoryEvent,
  AppendInput,
  ReadOptions,
} from '../../core/trajectory/writer.js';
import { iterateFromCursor } from '../../core/trajectory/writer.js';

export interface NodeTrajectoryWriterOptions {
  /** Directory where <trajectoryId>.trajectory.jsonl is written. */
  dir: string;
  /** Override the generated trajectory ULID. Useful for resumption in Phase 2. */
  trajectoryId?: string;
}

/**
 * Filesystem-backed trajectory writer. Buffers events in-memory and flushes
 * as JSONL appends. Single-writer — concurrent processes are not protected
 * against and should supply their own `TrajectoryWriter` if needed.
 */
export function createNodeTrajectoryWriter(
  options: NodeTrajectoryWriterOptions,
): TrajectoryWriter {
  const trajectoryId = options.trajectoryId ?? newUlid();
  if (!isUlid(trajectoryId)) {
    throw new Error(
      `createNodeTrajectoryWriter: trajectoryId must be a 26-char Crockford Base32 ULID (got ${JSON.stringify(trajectoryId)})`,
    );
  }

  const filePath = path.join(options.dir, `${trajectoryId}.trajectory.jsonl`);
  const pendingBuffer: TrajectoryEvent[] = [];
  const flushedBuffer: TrajectoryEvent[] = [];
  let lastEventId: string | null = null;
  let closed = false;
  let dirEnsured = false;

  // Serializes flushes. All flush() calls await whatever flush is currently
  // in progress, so concurrent callers see a single I/O queue — no torn
  // writes, no lost events.
  let flushChain: Promise<void> = Promise.resolve();

  async function ensureDir(): Promise<void> {
    if (dirEnsured) return;
    await fs.mkdir(options.dir, { recursive: true });
    dirEnsured = true;
  }

  function doFlush(): Promise<void> {
    flushChain = flushChain.then(async () => {
      if (pendingBuffer.length === 0) return;
      await ensureDir();
      const batch = pendingBuffer.splice(0, pendingBuffer.length);
      const payload = batch.map((e) => JSON.stringify(e)).join('\n') + '\n';
      await fs.appendFile(filePath, payload, 'utf-8');
      flushedBuffer.push(...batch);
    });
    return flushChain;
  }

  return {
    trajectoryId,
    append(input: AppendInput): string {
      if (closed) throw new Error('TrajectoryWriter: writer is closed');
      const eventId = newUlid();
      const event: TrajectoryEvent = {
        schema_version: '1',
        trajectory_id: trajectoryId,
        event_id: eventId,
        parent_event_id:
          input.parent_event_id === undefined ? lastEventId : input.parent_event_id,
        event_type: input.event_type,
        timestamp: nowIso(),
        agent_id: input.agent_id ?? 'leader',
        payload: input.payload,
        ...(input.ext ? { ext: input.ext } : {}),
      };
      pendingBuffer.push(event);
      lastEventId = eventId;
      return eventId;
    },
    flush(): Promise<void> {
      return doFlush();
    },
    currentEventId(): string | null {
      return lastEventId;
    },
    async close(): Promise<void> {
      if (closed) return;
      await doFlush();
      closed = true;
    },
    events(): TrajectoryEvent[] {
      return [...flushedBuffer, ...pendingBuffer];
    },
    async *read(options: ReadOptions = {}): AsyncIterable<TrajectoryEvent> {
      yield* iterateFromCursor([...flushedBuffer, ...pendingBuffer], options.sinceEventId);
    },
  };
}
