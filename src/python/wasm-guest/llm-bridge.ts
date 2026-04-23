import type { LlmClient } from "../../../src/core/index.js";
import type {
  AssistantMessageEvent,
  AssistantMessage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";

// The import shape below matches what jco generates for the host-llm
// interface. Names follow the kebab-to-camel rule jco applies. If the
// probe-generated binding differs, adjust this declaration.
export interface HostLlmImport {
  streamLlm: (req: LlmRequest) => LlmStreamHandle;
}

export interface LlmRequest {
  modelId: string;
  provider: string;
  api: string;
  systemPrompt: string;
  messagesJson: string;
  toolsJson: string;
  optionsJson: string;
}

export interface LlmStreamHandle {
  /// Returns next event as JSON string, or undefined when stream ends.
  next(): Promise<string | undefined>;
}

/**
 * Wrap the host-llm import as an LlmClient the core expects.
 * Converts the host's JSON-per-event pull-stream into pi-ai's
 * AssistantMessageEventStream push-stream that pi-agent-core's
 * streamFn contract consumes.
 */
export function makeHostLlmClient(host: HostLlmImport): LlmClient {
  return {
    stream: ((model: any, ctx: any, opts: any) => {
      const req: LlmRequest = {
        modelId: model.id,
        provider: model.provider,
        api: model.api,
        systemPrompt: ctx.systemPrompt,
        messagesJson: JSON.stringify(ctx.messages),
        toolsJson: JSON.stringify(ctx.tools ?? []),
        optionsJson: JSON.stringify(opts ?? {}),
      };
      const handle = host.streamLlm(req);

      // Use pi-ai's canonical AssistantMessageEventStream so pi-agent-core
      // can call `response.result()` to extract the final AssistantMessage.
      // Contract:
      //  - push(event) delivers to the agent loop
      //  - The stream finalizes when a "done" or "error" event is pushed
      //  - We never throw from here; transport failures become final events.
      const stream = createAssistantMessageEventStream();

      (async () => {
        try {
          while (true) {
            const json = await handle.next();
            if (json === undefined) break;
            const event = JSON.parse(json) as AssistantMessageEvent;
            stream.push(event);
            if (event.type === "done" || event.type === "error") return;
          }
          // Host exhausted without emitting "done" → synthesize an error end.
          stream.push(makeErrorEvent(model, "host stream ended without done event"));
        } catch (err) {
          stream.push(makeErrorEvent(model, err instanceof Error ? err.message : String(err)));
        }
      })();

      return stream as any;
    }) as LlmClient["stream"],
    completeN: async () => {
      throw new Error("completeN not supported in wasm M1");
    },
  };
}

function makeErrorEvent(model: { id: string; provider: string; api: string }, message: string): AssistantMessageEvent {
  const errorMsg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    stopReason: "error",
    errorMessage: message,
    api: model.api as AssistantMessage["api"],
    provider: model.provider,
    model: model.id,
    timestamp: Date.now(),
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
  return { type: "error", reason: "error", error: errorMsg };
}
