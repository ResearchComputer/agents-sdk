import type { PermissionRule, PermissionResult, PermissionMode, Capability } from '../types.js';

const MUTATION_CAPABILITIES: Capability[] = ['fs:write', 'process:spawn', 'network:egress', 'git:mutate', 'mcp:call'];

const SOURCE_PRIORITY: Record<string, number> = { user: 3, project: 2, session: 1 };

// Compiled glob cache keyed by the raw pattern. Rule lists are stable across
// a session but the hot path evaluates them on every tool call, so we avoid
// rebuilding the same regex per invocation.
const globRegexCache = new Map<string, RegExp | null>();

function compileGlob(pattern: string): RegExp | null {
  if (pattern === '*' || !pattern.includes('*')) return null;
  const cached = globRegexCache.get(pattern);
  if (cached !== undefined) return cached;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const re = new RegExp(`^${escaped}$`);
  globRegexCache.set(pattern, re);
  return re;
}

/**
 * Simple glob match supporting only trailing `*` wildcard patterns.
 * e.g. "git *" matches "git status", "git push origin main"
 */
function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = compileGlob(pattern);
  if (re === null) return pattern === value;
  return re.test(value);
}

/**
 * Parse mcp__<server>__<tool> naming convention.
 * Returns null if the name doesn't follow this pattern.
 */
function parseMcpToolName(toolName: string): { server: string; tool: string } | null {
  const match = toolName.match(/^mcp__([^_]+(?:_[^_]+)*)__(.+)$/);
  if (!match) return null;
  return { server: match[1], tool: match[2] };
}

/**
 * Get specificity score for a matching rule.
 * tool+pattern(6) > tool(5) > mcp+tool(4) > mcp(3) > capability(2) > wildcard(1)
 */
function getSpecificity(rule: PermissionRule): number {
  const target = rule.target;
  switch (target.type) {
    case 'tool':
      return target.pattern ? 6 : 5;
    case 'mcp':
      return target.tool ? 4 : 3;
    case 'capability':
      return 2;
    case 'all':
      return 1;
  }
}

/**
 * Check if a rule matches a tool invocation.
 */
export function matchRule(
  rule: PermissionRule,
  toolName: string,
  args: unknown,
  capabilities: Capability[],
): boolean {
  const target = rule.target;
  switch (target.type) {
    case 'tool': {
      if (target.name !== toolName) return false;
      if (target.pattern) {
        const command = (args as Record<string, unknown> | undefined)?.command;
        if (typeof command !== 'string') return false;
        return globMatch(target.pattern, command);
      }
      return true;
    }
    case 'capability':
      return capabilities.includes(target.capability);
    case 'mcp': {
      const parsed = parseMcpToolName(toolName);
      if (!parsed) return false;
      if (parsed.server !== target.server) return false;
      if (target.tool && parsed.tool !== target.tool) return false;
      return true;
    }
    case 'all':
      return true;
  }
}

/**
 * Find the best matching rule by combined score (specificity * 10 + source_priority).
 */
export function findMatchingRule(
  rules: PermissionRule[],
  toolName: string,
  args: unknown,
  capabilities: Capability[],
): PermissionRule | null {
  let bestRule: PermissionRule | null = null;
  let bestScore = -1;

  for (const rule of rules) {
    if (!matchRule(rule, toolName, args, capabilities)) continue;
    const score = getSpecificity(rule) * 10 + (SOURCE_PRIORITY[rule.source] ?? 0);
    if (score > bestScore) {
      bestScore = score;
      bestRule = rule;
    }
  }

  return bestRule;
}

/**
 * Evaluate permission result based on mode, rules, and capabilities.
 */
export function evaluatePermission(
  mode: PermissionMode,
  rules: PermissionRule[],
  toolName: string,
  args: unknown,
  capabilities: Capability[],
): PermissionResult {
  if (mode === 'allowAll') {
    return { behavior: 'allow' };
  }

  const matchedRule = findMatchingRule(rules, toolName, args, capabilities);

  if (matchedRule) {
    if (matchedRule.behavior === 'allow') {
      return { behavior: 'allow' };
    }
    return { behavior: 'deny', reason: `Denied by ${matchedRule.source} rule` };
  }

  if (mode === 'rulesOnly') {
    return { behavior: 'deny', reason: 'No matching rule found (rulesOnly mode)' };
  }

  // Default mode: allow read-only, ask for mutations
  const hasMutation = capabilities.some(cap => MUTATION_CAPABILITIES.includes(cap));
  // Allow tools with no capabilities (e.g., AskUser) or read-only tools
  if (!hasMutation) {
    return { behavior: 'allow' };
  }

  return { behavior: 'ask', prompt: `Tool "${toolName}" requires permission` };
}
