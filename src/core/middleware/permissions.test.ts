import { describe, it, expect } from 'vitest';
import { matchRule, findMatchingRule, evaluatePermission } from './permissions.js';
import type { PermissionRule, Capability } from '../types.js';

describe('matchRule', () => {
  it('matches exact tool name', () => {
    const rule: PermissionRule = { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'ReadFile', {}, [])).toBe(true);
    expect(matchRule(rule, 'WriteFile', {}, [])).toBe(false);
  });

  it('matches tool name with glob pattern on args.command', () => {
    const rule: PermissionRule = { target: { type: 'tool', name: 'Bash', pattern: 'git *' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'Bash', { command: 'git status' }, [])).toBe(true);
    expect(matchRule(rule, 'Bash', { command: 'git push origin main' }, [])).toBe(true);
    expect(matchRule(rule, 'Bash', { command: 'rm -rf /' }, [])).toBe(false);
    // tool name must also match
    expect(matchRule(rule, 'Other', { command: 'git status' }, [])).toBe(false);
  });

  it('matches tool name with pattern but no command in args', () => {
    const rule: PermissionRule = { target: { type: 'tool', name: 'Bash', pattern: 'git *' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'Bash', {}, [])).toBe(false);
    expect(matchRule(rule, 'Bash', undefined, [])).toBe(false);
  });

  it('matches a literal-only pattern (no wildcards) by exact equality', () => {
    const rule: PermissionRule = {
      target: { type: 'tool', name: 'Bash', pattern: 'git status' },
      behavior: 'allow',
      source: 'user',
    };
    expect(matchRule(rule, 'Bash', { command: 'git status' }, [])).toBe(true);
    expect(matchRule(rule, 'Bash', { command: 'git pull' }, [])).toBe(false);
  });

  it('matches a bare "*" pattern against any command', () => {
    const rule: PermissionRule = {
      target: { type: 'tool', name: 'Bash', pattern: '*' },
      behavior: 'allow',
      source: 'user',
    };
    expect(matchRule(rule, 'Bash', { command: 'anything at all' }, [])).toBe(true);
  });

  it('matches capability', () => {
    const rule: PermissionRule = { target: { type: 'capability', capability: 'fs:read' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'ReadFile', {}, ['fs:read'])).toBe(true);
    expect(matchRule(rule, 'ReadFile', {}, ['fs:write'])).toBe(false);
    expect(matchRule(rule, 'ReadFile', {}, [])).toBe(false);
  });

  it('matches mcp server without tool', () => {
    const rule: PermissionRule = { target: { type: 'mcp', server: 'myserver' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'mcp__myserver__sometool', {}, [])).toBe(true);
    expect(matchRule(rule, 'mcp__other__sometool', {}, [])).toBe(false);
    expect(matchRule(rule, 'ReadFile', {}, [])).toBe(false);
  });

  it('matches mcp server with specific tool', () => {
    const rule: PermissionRule = { target: { type: 'mcp', server: 'myserver', tool: 'list' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'mcp__myserver__list', {}, [])).toBe(true);
    expect(matchRule(rule, 'mcp__myserver__other', {}, [])).toBe(false);
  });

  it('matches wildcard (all)', () => {
    const rule: PermissionRule = { target: { type: 'all' }, behavior: 'allow', source: 'user' };
    expect(matchRule(rule, 'anything', {}, [])).toBe(true);
    expect(matchRule(rule, 'ReadFile', {}, ['fs:read'])).toBe(true);
  });
});

describe('findMatchingRule', () => {
  it('returns null when no rules match', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'Other' }, behavior: 'allow', source: 'user' },
    ];
    expect(findMatchingRule(rules, 'ReadFile', {}, [])).toBeNull();
  });

  it('prefers tool+pattern (6) over tool (5)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'Bash' }, behavior: 'deny', source: 'user' },
      { target: { type: 'tool', name: 'Bash', pattern: 'git *' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'Bash', { command: 'git status' }, []);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('prefers tool (5) over mcp+tool (4)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'mcp', server: 'myserver', tool: 'list' }, behavior: 'deny', source: 'user' },
      { target: { type: 'tool', name: 'mcp__myserver__list' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'mcp__myserver__list', {}, []);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('prefers mcp+tool (4) over mcp (3)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'mcp', server: 'myserver' }, behavior: 'deny', source: 'user' },
      { target: { type: 'mcp', server: 'myserver', tool: 'list' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'mcp__myserver__list', {}, []);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('prefers mcp (3) over capability (2)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'capability', capability: 'mcp:call' }, behavior: 'deny', source: 'user' },
      { target: { type: 'mcp', server: 'myserver' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'mcp__myserver__list', {}, ['mcp:call']);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('prefers capability (2) over wildcard (1)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'all' }, behavior: 'deny', source: 'user' },
      { target: { type: 'capability', capability: 'fs:read' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'ReadFile', {}, ['fs:read']);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('uses source priority as tiebreaker: user (3) > session (2) > project (1)', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'deny', source: 'project' },
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'user' },
    ];
    const result = findMatchingRule(rules, 'ReadFile', {}, []);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
    expect(result!.source).toBe('user');
  });

  it('project source beats session source', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'deny', source: 'project' },
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'session' },
    ];
    const result = findMatchingRule(rules, 'ReadFile', {}, []);
    expect(result!.source).toBe('project');
  });

  it('treats unknown source values as priority 0', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'weird' as any },
    ];
    const result = findMatchingRule(rules, 'ReadFile', {}, []);
    expect(result).not.toBeNull();
    expect(result!.behavior).toBe('allow');
  });

  it('combined score: specificity * 10 + source_priority', () => {
    // A wildcard from user (score: 1*10+3=13) should lose to a tool match from project (score: 5*10+1=51)
    const rules: PermissionRule[] = [
      { target: { type: 'all' }, behavior: 'deny', source: 'user' },
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'project' },
    ];
    const result = findMatchingRule(rules, 'ReadFile', {}, []);
    expect(result!.behavior).toBe('allow');
  });
});

describe('evaluatePermission', () => {
  const MUTATION_CAPS: Capability[] = ['fs:write', 'process:spawn', 'network:egress', 'git:mutate', 'mcp:call'];
  const READ_ONLY_CAPS: Capability[] = ['fs:read'];

  it('allowAll mode always returns allow', () => {
    const result = evaluatePermission('allowAll', [], 'anything', {}, []);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('rulesOnly mode returns deny when no rules match', () => {
    const result = evaluatePermission('rulesOnly', [], 'ReadFile', {}, ['fs:read']);
    expect(result).toEqual({ behavior: 'deny', reason: 'No matching rule found (rulesOnly mode)' });
  });

  it('rulesOnly mode returns matched rule behavior when rule matches', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'allow', source: 'user' },
    ];
    const result = evaluatePermission('rulesOnly', rules, 'ReadFile', {}, ['fs:read']);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('rulesOnly mode returns deny with reason when matched rule denies', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'deny', source: 'user' },
    ];
    const result = evaluatePermission('rulesOnly', rules, 'ReadFile', {}, ['fs:read']);
    expect(result.behavior).toBe('deny');
  });

  it('default mode returns allow for read-only capabilities when no rules match', () => {
    const result = evaluatePermission('default', [], 'ReadFile', {}, READ_ONLY_CAPS);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('default mode returns ask for mutation capabilities when no rules match', () => {
    for (const cap of MUTATION_CAPS) {
      const result = evaluatePermission('default', [], 'WriteFile', {}, [cap]);
      expect(result.behavior).toBe('ask');
    }
  });

  it('default mode returns allow for empty capabilities (unknown tool)', () => {
    const result = evaluatePermission('default', [], 'UnknownTool', {}, []);
    expect(result.behavior).toBe('allow');
  });

  it('default mode returns allow when only fs:read capability and no mutation caps', () => {
    const result = evaluatePermission('default', [], 'ReadFile', {}, ['fs:read']);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('default mode returns ask when tool has both read and mutation capabilities', () => {
    const result = evaluatePermission('default', [], 'ReadWrite', {}, ['fs:read', 'fs:write']);
    expect(result.behavior).toBe('ask');
  });

  it('default mode with matching allow rule returns allow even for mutation', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'WriteFile' }, behavior: 'allow', source: 'user' },
    ];
    const result = evaluatePermission('default', rules, 'WriteFile', {}, ['fs:write']);
    expect(result).toEqual({ behavior: 'allow' });
  });

  it('default mode with matching deny rule returns deny', () => {
    const rules: PermissionRule[] = [
      { target: { type: 'tool', name: 'ReadFile' }, behavior: 'deny', source: 'user' },
    ];
    const result = evaluatePermission('default', rules, 'ReadFile', {}, ['fs:read']);
    expect(result.behavior).toBe('deny');
  });
});
