// LlmClient adapter — the only runtime seam through which core talks to
// @researchcomputer/ai-provider. Hosts that cannot run ai-provider directly
// (WASM, Python embedding, deterministic replay) supply their own impl.

import type { StreamFn } from '@mariozechner/pi-agent-core';
import type {
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
} from '@researchcomputer/ai-provider';

export interface LlmClient {
  /**
   * Stream a single completion. Shape matches pi-agent-core's StreamFn so
   * it can be passed straight into Agent({ streamFn }) without adaptation.
   */
  stream: StreamFn;

  /**
   * Request N completions for the same context. Used by fork() best-of-N.
   * Providers that support native n>1 (OpenAI) answer in one request;
   * others fan out to parallel stream() calls internally.
   */
  completeN(
    model: Model<any>,
    context: Context,
    n: number,
    options?: ProviderStreamOptions,
  ): Promise<AssistantMessage[]>;
}
