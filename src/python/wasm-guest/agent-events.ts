import type { Agent, AgentEvent } from "@mariozechner/pi-agent-core";

/**
 * Bridge Agent's subscribe() callback into an AsyncIterable that the
 * WIT `event-stream.next()` export can pull from one event at a time.
 *
 * Termination on `agent_end` (not `turn_end`) is intentional: pi-agent-core
 * always emits `agent_end` after the final `turn_end`, and consumers
 * typically want the `agent_end` event to reach them (not be swallowed).
 */
export interface AgentEventCursor {
  next(): Promise<AgentEvent | undefined>;
  close(): void;
}

export function createAgentEventCursor(agent: Agent): AgentEventCursor {
  const buffer: AgentEvent[] = [];
  const waiters: Array<(e: AgentEvent | undefined) => void> = [];
  let closed = false;

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      buffer.push(event);
    }
    if (event.type === "agent_end") {
      closed = true;
      unsubscribe();
      for (const w of waiters.splice(0)) w(undefined);
    }
  });

  return {
    next() {
      if (buffer.length > 0) {
        return Promise.resolve(buffer.shift());
      }
      if (closed) {
        return Promise.resolve(undefined);
      }
      return new Promise<AgentEvent | undefined>((resolve) => {
        waiters.push(resolve);
      });
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      for (const w of waiters.splice(0)) w(undefined);
    },
  };
}
