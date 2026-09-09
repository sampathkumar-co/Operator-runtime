export class OperatorError extends Error {
  code: string;
  retryable: boolean;
  details?: Record<string, unknown>;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = 'OperatorError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

export class PolicyError extends OperatorError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, { retryable: false, details });
    this.name = 'PolicyError';
  }
}
