export class SdkError extends Error {
  constructor(message: string, public readonly code: string, public readonly retryable: boolean, options?: { cause?: unknown }) {
    super(message, options as any);
    this.name = 'SdkError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export class ToolExecutionError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TOOL_EXECUTION_ERROR', true, options);
    this.name = 'ToolExecutionError';
  }
}

export class PermissionDeniedError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'PERMISSION_DENIED', false, options);
    this.name = 'PermissionDeniedError';
  }
}

export class BudgetExhaustedError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'BUDGET_EXHAUSTED', false, options);
    this.name = 'BudgetExhaustedError';
  }
}

export class McpConnectionError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MCP_CONNECTION_ERROR', true, options);
    this.name = 'McpConnectionError';
  }
}

export class SessionLoadError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'SESSION_LOAD_ERROR', false, options);
    this.name = 'SessionLoadError';
  }
}

export class CompressionError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'COMPRESSION_ERROR', true, options);
    this.name = 'CompressionError';
  }
}

export class AuthRequiredError extends SdkError {
  constructor() {
    super('No authentication found. Call initiateLogin() to authenticate.', 'AUTH_REQUIRED', false);
    this.name = 'AuthRequiredError';
  }
}

export class TrajectoryReadError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TRAJECTORY_READ_FAILED', false, options);
    this.name = 'TrajectoryReadError';
  }
}

export class SessionResumeError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'SESSION_RESUME_FAILED', false, options);
    this.name = 'SessionResumeError';
  }
}

export class MemoryLoadError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MEMORY_LOAD_FAILED', false, options);
    this.name = 'MemoryLoadError';
  }
}

export class AuthResolveError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'AUTH_RESOLVE_FAILED', false, options);
    this.name = 'AuthResolveError';
  }
}

export class TelemetryFlushError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TELEMETRY_FLUSH_FAILED', false, options);
    this.name = 'TelemetryFlushError';
  }
}

export class McpDisconnectError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'MCP_DISCONNECT_FAILED', false, options);
    this.name = 'McpDisconnectError';
  }
}

export class SwarmCleanupError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'SWARM_CLEANUP_FAILED', false, options);
    this.name = 'SwarmCleanupError';
  }
}

export class TrajectoryFlushError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'TRAJECTORY_FLUSH_FAILED', false, options);
    this.name = 'TrajectoryFlushError';
  }
}

export class SessionSaveError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'SESSION_SAVE_FAILED', false, options);
    this.name = 'SessionSaveError';
  }
}

export class RedactArgsError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'REDACT_ARGS_FAILED', false, options);
    this.name = 'RedactArgsError';
  }
}

export class RedactMessagesError extends SdkError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'REDACT_MESSAGES_FAILED', false, options);
    this.name = 'RedactMessagesError';
  }
}
