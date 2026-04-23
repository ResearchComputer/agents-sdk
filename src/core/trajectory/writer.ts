import { newUlid, isUlid, nowIso } from '../spec/ids.js';

export type TrajectoryEventType =
  | 'session_start'
  | 'session_end'
  | 'llm_api_call'
  | 'llm_turn'
  | 'agent_message'
  | 'tool_call'
  | 'tool_result'
  | 'hook_fire'
  | 'permission_decision'
  | 'compaction'
  | 'error';

/**
 * A serialized trajectory event. Matches spec/schemas/trajectory-event.v1.schema.json
 * field-for-field so produced JSONL files validate against the canonical spec.
 */
export interface TrajectoryEvent {
  schema_version: '1';
  trajectory_id: string;
  event_id: string;
  parent_event_id: string | null;
  event_type: TrajectoryEventType;
  timestamp: string;
  agent_id: string;
  payload: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

/**
 * Input to TrajectoryWriter.append(). IDs and timestamps are filled in by the
 * writer so callers only supply the payload-level information.
 */
export interface AppendInput {
  event_type: TrajectoryEventType;
  payload: Record<string, unknown>;
  /** Override chaining; default is the previous event's id (or null if first). */
  parent_event_id?: string | null;
  /** 'leader' or 'teammate:<name>'. Default: 'leader'. */
  agent_id?: string;
  ext?: Record<string, unknown>;
}

export interface ReadOptions {
  /** Skip events up to and including this event_id. Defaults to reading from
   *  the start of the trajectory. */
  sinceEventId?: string;
}

export interface TrajectoryWriter {
  readonly trajectoryId: string;
  append(input: AppendInput): string;
  flush(): Promise<void>;
  currentEventId(): string | null;
  close(): Promise<void>;
  /** Enumerate events written so far. In-memory writers return the in-memory
   *  buffer; node writers return both flushed and pending events. */
  events(): TrajectoryEvent[];
  /** Stream events in write order. Includes pending (unflushed) events so
   *  callers can iterate without forcing a flush. */
  read(options?: ReadOptions): AsyncIterable<TrajectoryEvent>;
}

export interface InMemoryTrajectoryWriterOptions {
  trajectoryId?: string;
}

export function createInMemoryTrajectoryWriter(
  options: InMemoryTrajectoryWriterOptions = {},
): TrajectoryWriter {
  const trajectoryId = options.trajectoryId ?? newUlid();
  if (!isUlid(trajectoryId)) {
    throw new Error(
      `createInMemoryTrajectoryWriter: trajectoryId must be a 26-char Crockford Base32 ULID (got ${JSON.stringify(trajectoryId)})`,
    );
  }
  const buffer: TrajectoryEvent[] = [];
  let lastEventId: string | null = null;
  let closed = false;

  return {
    trajectoryId,
    append(input: AppendInput): string {
      if (closed) throw new Error('TrajectoryWriter: writer is closed');
      const eventId = newUlid();
      const event: TrajectoryEvent = {
        schema_version: '1',
        trajectory_id: trajectoryId,
        event_id: eventId,
        parent_event_id: input.parent_event_id === undefined ? lastEventId : input.parent_event_id,
        event_type: input.event_type,
        timestamp: nowIso(),
        agent_id: input.agent_id ?? 'leader',
        payload: input.payload,
        ...(input.ext ? { ext: input.ext } : {}),
      };
      buffer.push(event);
      lastEventId = eventId;
      return eventId;
    },
    async flush(): Promise<void> {
      // In-memory writer is already durable-in-process.
    },
    currentEventId(): string | null {
      return lastEventId;
    },
    async close(): Promise<void> {
      closed = true;
    },
    events(): TrajectoryEvent[] {
      return buffer;
    },
    async *read(options: ReadOptions = {}): AsyncIterable<TrajectoryEvent> {
      yield* iterateFromCursor(buffer, options.sinceEventId);
    },
  };
}

/**
 * Shared helper: iterate events, skipping everything up to and including
 * `sinceEventId` if provided. A missing `sinceEventId` yields the whole list.
 * If `sinceEventId` is not present in the buffer, nothing is yielded (treat
 * as "cursor out of range" rather than falling back to the start — that
 * silent fallback would mask a real bug in the caller).
 */
export function* iterateFromCursor(
  events: TrajectoryEvent[],
  sinceEventId: string | undefined,
): IterableIterator<TrajectoryEvent> {
  if (!sinceEventId) {
    yield* events;
    return;
  }
  let passed = false;
  for (const e of events) {
    if (!passed) {
      if (e.event_id === sinceEventId) passed = true;
      continue;
    }
    yield e;
  }
}
