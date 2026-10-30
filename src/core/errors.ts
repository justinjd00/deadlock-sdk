export type DeadlockErrorCode =
  /** 400, the API rejected the parameters. `message` contains its reason. */
  | 'BAD_REQUEST'
  /** 403, usually a player who opted out of public data. */
  | 'FORBIDDEN'
  /** 404 */
  | 'NOT_FOUND'
  /** 429, still limited after all retries. See `retryAfterMs`. */
  | 'RATE_LIMITED'
  /** 503, the API shed load and all retries were used. See `retryAfterMs`. */
  | 'SERVICE_BUSY'
  /**
   * 504, the query hit the server time limit. The API rejects the same
   * request for a few minutes, so it is never retried: narrow the filters.
   */
  | 'QUERY_TIMEOUT'
  /** 403 from Cloudflare's bot protection. */
  | 'BLOCKED'
  /** Any other non 2xx response. */
  | 'HTTP_ERROR'
  /** DNS, TLS, connection reset and similar. */
  | 'NETWORK_ERROR'
  /** The request took longer than `timeout`. */
  | 'TIMEOUT'
  /** The caller aborted via `signal`. */
  | 'ABORTED'
  /** The body was not what the endpoint promises. */
  | 'INVALID_RESPONSE'
  /** The SDK could not make sense of an input, e.g. a malformed Steam ID. */
  | 'INVALID_INPUT';

export interface DeadlockErrorInit {
  code: DeadlockErrorCode;
  url: string;
  status?: number;
  body?: unknown;
  retryable?: boolean;
  attempts?: number;
  retryAfterMs?: number;
  cause?: unknown;
}

/** The single error type this library throws. Switch on `code`. */
export class DeadlockError extends Error {
  override readonly name = 'DeadlockError';
  readonly code: DeadlockErrorCode;
  readonly url: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly retryable: boolean;
  /** How many attempts were made before giving up. */
  readonly attempts: number;
  /** How long the API asked to wait (from `Retry-After`), if it said so. */
  readonly retryAfterMs?: number;

  constructor(message: string, init: DeadlockErrorInit) {
    super(message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.code = init.code;
    this.url = init.url;
    this.status = init.status;
    this.body = init.body;
    this.retryable = init.retryable ?? false;
    this.attempts = init.attempts ?? 1;
    this.retryAfterMs = init.retryAfterMs;
  }

  /** Copy with a different attempt count. */
  withAttempts(attempts: number): DeadlockError {
    if (attempts === this.attempts) return this;
    const copy = new DeadlockError(this.message, { ...this, cause: this.cause, attempts });
    copy.stack = this.stack;
    return copy;
  }
}

/**
 * Type guard. Also recognizes errors from a second copy of this package
 * (ESM and CJS side by side), where `instanceof` fails.
 */
export function isDeadlockError(error: unknown): error is DeadlockError {
  return (
    error instanceof DeadlockError ||
    (error instanceof Error &&
      error.name === 'DeadlockError' &&
      typeof (error as DeadlockError).code === 'string')
  );
}
