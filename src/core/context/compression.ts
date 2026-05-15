import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { complete, type Context, type Message, type TextContent } from '@researchcomputer/ai-provider';
import type { CompactionSummaryMessage, CompressionConfig, SegmentType, TranscriptSegment } from '../types.js';
import { convertToLlm } from './converter.js';

/**
 * Estimates token count as ceil(text.length / 4).
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Extracts text content from an AgentMessage.
 * Handles string content, array of TextContent, or falls back to JSON.stringify.
 */
export function messageText(msg: AgentMessage): string {
  if (msg === null || typeof msg !== 'object') return '';
  const m = msg as unknown as Record<string, unknown>;
  const content = m.content;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const c of content) {
      if (c && typeof c === 'object' && (c as { type?: unknown }).type === 'text') {
        const text = (c as TextContent).text;
        if (typeof text === 'string') texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join('\n');
    }
  }

  return JSON.stringify(m);
}

function roleToSegmentType(role: string): SegmentType {
  switch (role) {
    case 'user': return 'user';
    case 'assistant': return 'assistant';
    case 'toolResult': return 'toolIO';
    case 'memory': return 'memory';
    case 'summary': return 'summary';
    default: return 'user'; // fallback
  }
}

/**
 * Groups messages into TranscriptSegments by consecutive role type.
 */
export function segmentMessages(messages: AgentMessage[]): TranscriptSegment[] {
  if (messages.length === 0) return [];

  const segments: TranscriptSegment[] = [];
  let currentType: SegmentType | null = null;
  let currentMessages: AgentMessage[] = [];

  for (const msg of messages) {
    const role = msg && typeof msg === 'object' ? (msg as { role?: unknown }).role : undefined;
    if (typeof role !== 'string') continue;
    const type = roleToSegmentType(role);

    if (type === currentType) {
      currentMessages.push(msg);
    } else {
      if (currentType !== null) {
        segments.push({ type: currentType, protected: false, messages: currentMessages });
      }
      currentType = type;
      currentMessages = [msg];
    }
  }

  if (currentType !== null) {
    segments.push({ type: currentType, protected: false, messages: currentMessages });
  }

  return segments;
}

/**
 * Creates a transformContext middleware for context compression.
 *
 * Truncate strategy:
 * - Protects the most recent N turns (protectedRecentTurns * 3 messages)
 * - If total tokens are under 80% of maxTokens, returns unchanged
 * - Otherwise keeps as many older messages as fit in budget, starting from most recent older ones
 *
 * Summarize strategy:
 * - Same trigger as truncate
 * - Asks `config.model` to summarize the older slice into a single
 *   `CompactionSummaryMessage` and prepends it to the protected recent turns.
 * - Falls back to truncate when the model/getApiKey is missing or the
 *   summarization call fails.
 */
export function createCompressionMiddleware(
  config: CompressionConfig,
): (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]> {
  const protectedRecentTurns = config.protectedRecentTurns ?? 3;
  const protectedMessageCount = protectedRecentTurns * 3;
  const summaryMaxTokens = config.summaryMaxTokens ?? 2048;

  return async (messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> => {
    // Compute messageText exactly once per message. At long histories the
    // previous version called messageText on each message 3–4 times (total
    // scan, recent scan, per-segment scan), trending toward O(N²) per turn
    // because JSON.stringify fallback serializes the whole message object.
    const texts = new Array<string>(messages.length);
    const tokens = new Array<number>(messages.length);
    let totalTokens = 0;
    for (let i = 0; i < messages.length; i++) {
      const t = messageText(messages[i]);
      texts[i] = t;
      const tok = estimateTokens(t);
      tokens[i] = tok;
      totalTokens += tok;
    }

    // If under 80% of budget, return unchanged
    if (totalTokens <= config.maxTokens * 0.8) {
      return messages;
    }

    // Split into older and protected recent messages
    const protectedCount = Math.min(protectedMessageCount, messages.length);
    const splitIndex = messages.length - protectedCount;
    const olderMessages = messages.slice(0, splitIndex);
    const recentMessages = messages.slice(splitIndex);

    // Reuse cached per-message tokens instead of re-running messageText.
    let recentTokens = 0;
    for (let i = splitIndex; i < messages.length; i++) recentTokens += tokens[i];
    const olderBudget = config.maxTokens - recentTokens;

    if (olderBudget <= 0) {
      // Only recent messages fit
      return recentMessages;
    }

    if (config.strategy === 'summarize' && olderMessages.length > 0) {
      const summary = await summarizeOlderMessages(
        olderMessages,
        config,
        summaryMaxTokens,
        signal,
      );
      if (summary !== null) {
        return [summary, ...recentMessages];
      }
      // Fall through to truncate on failure.
    }

    // Use segment-based truncation to avoid splitting mid-turn. Segment
    // objects retain the original AgentMessage references, so we map back
    // to the cached token counts via index identity.
    const indexByMessage = new Map<AgentMessage, number>();
    for (let i = 0; i < olderMessages.length; i++) indexByMessage.set(olderMessages[i], i);

    const segments = segmentMessages(olderMessages);
    const kept: AgentMessage[] = [];
    let usedTokens = 0;

    for (let i = segments.length - 1; i >= 0; i--) {
      let segTokens = 0;
      for (const m of segments[i].messages) {
        const idx = indexByMessage.get(m);
        segTokens += idx === undefined ? estimateTokens(messageText(m)) : tokens[idx];
      }
      if (usedTokens + segTokens <= olderBudget) {
        kept.unshift(...segments[i].messages);
        usedTokens += segTokens;
      } else {
        break;
      }
    }

    return [...kept, ...recentMessages];
  };
}

const SUMMARY_SYSTEM_PROMPT = [
  'You are a transcript summarizer for a coding-agent session.',
  'Produce a concise but information-dense summary of the conversation so the agent can resume work after older turns are dropped from context.',
  'Preserve, in this order:',
  '1. The user\'s goals, requirements, and constraints (verbatim wording when load-bearing).',
  '2. Decisions made and their rationale.',
  '3. Concrete identifiers: file paths, function/class names, env vars, commands run, and key inputs/outputs.',
  '4. Outstanding questions, TODOs, and known failures.',
  'Use compact bullet form grouped under short headings. Do not invent facts. Do not include greetings, sign-offs, or meta-commentary.',
].join(' ');

async function summarizeOlderMessages(
  olderMessages: AgentMessage[],
  config: CompressionConfig,
  summaryMaxTokens: number,
  signal?: AbortSignal,
): Promise<CompactionSummaryMessage | null> {
  if (!config.model || !config.getApiKey) return null;

  let apiKey: string | undefined;
  try {
    apiKey = await config.getApiKey(config.model.provider);
  } catch (err) {
    logSummarizeFallback('failed to resolve API key', err);
    return null;
  }
  if (!apiKey) {
    logSummarizeFallback(`no API key for provider "${config.model.provider}"`);
    return null;
  }

  const transcript = renderTranscript(olderMessages);
  const userPrompt = [
    'Summarize the following conversation transcript so the assistant can continue without it.',
    'Keep concrete identifiers (file paths, function/symbol names, IDs, commands).',
    '',
    '--- TRANSCRIPT START ---',
    transcript,
    '--- TRANSCRIPT END ---',
  ].join('\n');

  const ctx: Context = {
    systemPrompt: SUMMARY_SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt, timestamp: Date.now() },
    ],
  };

  let result;
  try {
    result = await complete(config.model, ctx, {
      apiKey,
      signal,
      maxTokens: summaryMaxTokens,
      temperature: 0,
    });
  } catch (err) {
    logSummarizeFallback('model call threw', err);
    return null;
  }

  if (result.stopReason === 'error' || result.stopReason === 'aborted') {
    logSummarizeFallback(`model stop reason "${result.stopReason}"`, result.errorMessage);
    return null;
  }

  const text = extractText(result.content).trim();
  if (text.length === 0) {
    logSummarizeFallback('model returned empty summary');
    return null;
  }

  return {
    role: 'summary',
    content: text,
    compactedCount: olderMessages.length,
    timestamp: Date.now(),
  };
}

function renderTranscript(messages: AgentMessage[]): string {
  // Reuse the standard converter so memory/summary/swarmReport messages get
  // their human-readable prefixes; then format each LLM Message into a single
  // text block. Tool calls and results are flattened to text so the
  // summarizer can see them.
  const llmMessages = convertToLlm(messages);
  const lines: string[] = [];
  for (let i = 0; i < llmMessages.length; i++) {
    const m = llmMessages[i];
    lines.push(`[${i}] ${m.role}:`);
    lines.push(formatMessageContent(m));
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

function formatMessageContent(msg: Message): string {
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    const type = (part as { type?: unknown }).type;
    switch (type) {
      case 'text': {
        const text = (part as TextContent).text;
        if (typeof text === 'string') parts.push(text);
        break;
      }
      case 'thinking':
        // Drop chain-of-thought from the summarization input.
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'toolCall': {
        const tc = part as { name?: unknown; arguments?: unknown };
        const name = typeof tc.name === 'string' ? tc.name : 'tool';
        let args = '';
        try {
          args = JSON.stringify(tc.arguments ?? {});
        } catch {
          args = '[unserializable]';
        }
        parts.push(`[toolCall ${name}] ${args}`);
        break;
      }
      default: {
        // Best-effort: stringify unknown content shapes.
        try { parts.push(JSON.stringify(part)); } catch { /* ignore */ }
      }
    }
  }
  return parts.join('\n');
}

function extractText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && (part as { type?: unknown }).type === 'text') {
      const text = (part as TextContent).text;
      if (typeof text === 'string') parts.push(text);
    }
  }
  return parts.join('\n');
}

function logSummarizeFallback(reason: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err !== undefined ? String(err) : '';
  // eslint-disable-next-line no-console
  console.warn(
    `[agents-sdk] compressionStrategy "summarize" falling back to "truncate": ${reason}${detail ? ` (${detail})` : ''}`,
  );
}
