import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TrajectoryEvent } from '../../core/trajectory/writer.js';

/**
 * Read all events from an existing on-disk trajectory file. Returns an empty
 * array if the file does not exist. Malformed lines are skipped with a
 * console.warn rather than thrown — a single corrupt line shouldn't prevent
 * resumption from the remainder of the trajectory.
 */
export async function readNodeTrajectoryFile(
  dir: string,
  trajectoryId: string,
): Promise<TrajectoryEvent[]> {
  const filePath = path.join(dir, `${trajectoryId}.trajectory.jsonl`);
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw err;
  }
  const events: TrajectoryEvent[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as TrajectoryEvent);
    } catch {
      // eslint-disable-next-line no-console
      console.warn(`[agents-sdk] skipping malformed trajectory line in ${filePath}`);
    }
  }
  return events;
}
