import {
  type AgentCoreConfig,
  createAgentCore,
} from "../../core/factory.js";
import type { Model } from "@researchcomputer/ai-provider";
import { makeStubAdapters, makeHostTools } from "./adapters.js";
import { makeHostLlmClient } from "./llm-bridge.js";
import { createAgentEventCursor, type AgentEventCursor } from "./agent-events.js";
import * as hostLlm from "research-computer:flash-agents/host-llm@0.1.0";

class Agent {
  private _initPromise: Promise<Awaited<ReturnType<typeof createAgentCore>>>;

  constructor(configJson: string) {
    const parsed = parseConfig(configJson);
    const llmClient = makeHostLlmClient(hostLlm);
    const tools = makeHostTools();
    this._initPromise = createAgentCore(
      {
        model: parsed.model,
        systemPrompt: parsed.systemPrompt,
        cwd: parsed.cwd ?? "/wasm-stub",
        enableMemory: false,
        permissionMode: "allowAll",
        tools,
        systemPromptHash: "sha256:flash-agents",
      } as AgentCoreConfig,
      makeStubAdapters(llmClient),
    );
  }

  prompt(message: string, extraSystem: string | undefined): EventStream {
    return new EventStream(async (self) => {
      const core = await self._initPromise;
      const cursor = createAgentEventCursor(core.agent);
      const donePromise = core.prompt(message, undefined, extraSystem);
      return { cursor, donePromise };
    }, this);
  }

  async dispose(): Promise<void> {
    const core = await this._initPromise;
    await core.dispose();
  }
}

class EventStream {
  private _cursor: Promise<AgentEventCursor>;
  private _donePromise: Promise<unknown>;
  private _closed = false;

  constructor(
    init: (self: Agent) => Promise<{ cursor: AgentEventCursor; donePromise: Promise<unknown> }>,
    self: Agent,
  ) {
    const initialized = init(self);
    this._cursor = initialized.then((x) => x.cursor);
    this._donePromise = initialized.then((x) => x.donePromise);
  }

  async next(): Promise<string | undefined> {
    if (this._closed) return undefined;
    const cursor = await this._cursor;
    const event = await cursor.next();
    if (event === undefined) {
      try { await this._donePromise; } catch { /* errors surface through event stream */ }
      this._closed = true;
      return undefined;
    }
    return JSON.stringify(event);
  }
}

function parseConfig(json: string): {
  model: Model<any>;
  systemPrompt?: string;
  cwd?: string;
} {
  const raw = JSON.parse(json) as {
    model: Model<any>;
    systemPrompt?: string;
    "system-prompt"?: string;
    cwd?: string;
  };
  if (!raw.model?.id || !raw.model?.provider || !raw.model?.api) {
    throw new Error("config-json must include { model: { id, provider, api, ... } }");
  }
  return {
    model: raw.model,
    systemPrompt: raw.systemPrompt ?? raw["system-prompt"],
    cwd: raw.cwd,
  };
}

export const agent = { Agent, EventStream };
