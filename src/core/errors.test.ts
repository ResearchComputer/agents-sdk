import { describe, it, expect } from 'vitest';
import {
  SdkError,
  ToolExecutionError,
  PermissionDeniedError,
  BudgetExhaustedError,
  McpConnectionError,
  SessionLoadError,
  CompressionError,
} from './errors.js';

describe('SdkError', () => {
  it('has correct name, code, and retryable', () => {
    const err = new SdkError('test', 'TEST_CODE', true);
    expect(err.name).toBe('SdkError');
    expect(err.message).toBe('test');
    expect(err.code).toBe('TEST_CODE');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('ToolExecutionError', () => {
  it('has correct defaults', () => {
    const err = new ToolExecutionError('tool failed');
    expect(err.name).toBe('ToolExecutionError');
    expect(err.code).toBe('TOOL_EXECUTION_ERROR');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('PermissionDeniedError', () => {
  it('has correct defaults', () => {
    const err = new PermissionDeniedError('denied');
    expect(err.name).toBe('PermissionDeniedError');
    expect(err.code).toBe('PERMISSION_DENIED');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('BudgetExhaustedError', () => {
  it('has correct defaults', () => {
    const err = new BudgetExhaustedError('no budget');
    expect(err.name).toBe('BudgetExhaustedError');
    expect(err.code).toBe('BUDGET_EXHAUSTED');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('McpConnectionError', () => {
  it('has correct defaults', () => {
    const err = new McpConnectionError('connection failed');
    expect(err.name).toBe('McpConnectionError');
    expect(err.code).toBe('MCP_CONNECTION_ERROR');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('SessionLoadError', () => {
  it('has correct defaults', () => {
    const err = new SessionLoadError('load failed');
    expect(err.name).toBe('SessionLoadError');
    expect(err.code).toBe('SESSION_LOAD_ERROR');
    expect(err.retryable).toBe(false);
    expect(err).toBeInstanceOf(SdkError);
  });
});

describe('CompressionError', () => {
  it('has correct defaults', () => {
    const err = new CompressionError('compress failed');
    expect(err.name).toBe('CompressionError');
    expect(err.code).toBe('COMPRESSION_ERROR');
    expect(err.retryable).toBe(true);
    expect(err).toBeInstanceOf(SdkError);
  });
});
