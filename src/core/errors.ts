export class SdkError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean) {
    super(message);
    this.name = 'SdkError';
  }
}

export class ToolExecutionError extends SdkError {
  constructor(message: string) {
    super(message, 'TOOL_EXECUTION_ERROR', true);
    this.name = 'ToolExecutionError';
  }
}

export class PermissionDeniedError extends SdkError {
  constructor(message: string) {
    super(message, 'PERMISSION_DENIED', false);
    this.name = 'PermissionDeniedError';
  }
}

export class BudgetExhaustedError extends SdkError {
  constructor(message: string) {
    super(message, 'BUDGET_EXHAUSTED', false);
    this.name = 'BudgetExhaustedError';
  }
}

export class McpConnectionError extends SdkError {
  constructor(message: string) {
    super(message, 'MCP_CONNECTION_ERROR', true);
    this.name = 'McpConnectionError';
  }
}

export class SessionLoadError extends SdkError {
  constructor(message: string) {
    super(message, 'SESSION_LOAD_ERROR', false);
    this.name = 'SessionLoadError';
  }
}

export class CompressionError extends SdkError {
  constructor(message: string) {
    super(message, 'COMPRESSION_ERROR', true);
    this.name = 'CompressionError';
  }
}

export class AuthRequiredError extends SdkError {
  constructor() {
    super('No authentication found. Call initiateLogin() to authenticate.', 'AUTH_REQUIRED', false);
    this.name = 'AuthRequiredError';
  }
}
