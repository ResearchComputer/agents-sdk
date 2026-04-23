declare module "research-computer:flash-agents/host-llm@0.1.0" {
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
    next(): Promise<string | undefined>;
  }

  export function streamLlm(req: LlmRequest): LlmStreamHandle;
}

declare module "research-computer:flash-agents/host-tools@0.1.0" {
  export interface ToolCall {
    callId: string;
    toolName: string;
    inputJson: string;
  }

  export interface ToolResult {
    callId: string;
    isError: boolean;
    outputJson: string;
  }

  export function listTools(): string;
  export function executeTool(call: ToolCall): ToolResult;
}
