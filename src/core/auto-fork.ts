/**
 * Helpers for the autoFork subscriber in createAgent.
 * Kept separate for unit-testability.
 */

/**
 * Extract text from a UserMessage's content, which per the ai-provider type
 * can be either a plain string or an array of content parts. Returns undefined
 * if no text is present.
 */
export function extractUserText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const textPart = content.find(
      (p): p is { type: 'text'; text: string } =>
        typeof p === 'object' && p !== null && (p as { type?: unknown }).type === 'text',
    );
    return textPart?.text;
  }
  return undefined;
}
