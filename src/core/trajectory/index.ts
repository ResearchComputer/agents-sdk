export { createInMemoryTrajectoryWriter } from './writer.js';
export type {
  TrajectoryWriter,
  TrajectoryEvent,
  TrajectoryEventType,
  AppendInput,
  ReadOptions,
  InMemoryTrajectoryWriterOptions,
} from './writer.js';

export { replayTrajectory } from './replay.js';
export type { ReplayResult, InterruptedToolCall } from './replay.js';

export { createKeyRedactor, createContentRedactor } from './redactors.js';
export type {
  RedactArgsFn,
  RedactMessagesFn,
  KeyRedactorOptions,
  ContentRedactorOptions,
} from './redactors.js';
