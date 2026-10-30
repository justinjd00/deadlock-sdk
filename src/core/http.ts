import { VERSION } from '../version';
import { DeadlockError, type DeadlockErrorCode } from './errors';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type QueryValue =
  string | number | boolean | null | undefined | readonly (string | number)[];
export type Query = Record<string, QueryValue>;

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';
export type ParseAs = 'json' | 'text' | 'arrayBuffer';

export interface RetryOptions {
  /** Extra attempts after the first one. Default 2. */
  retries: number;
  /** Base delay for exponential backoff in ms. Default 400. */
  minDelay: number;
  /** Longest single wait in ms, also caps `Retry-After`. Default 15000. */
  maxDelay: number;
}

export interface RateLimitState {
  limit?: number;
  remaining?: number;
  /** Epoch ms when the window resets. */
  resetAt?: number;
}

export interface RequestEvent {
  method: HttpMethod;
  url: string;
  attempt: number;
}

export interface ResponseEvent extends RequestEvent {
  status: number;
  durationMs: number;
  rateLimit?: RateLimitState;
}

export interface RetryEvent extends RequestEvent {
  error: DeadlockError;
  delayMs: number;
}

export interface ThrottleEvent {
  url: string;
  delayMs: number;
}

/** Observability hooks for logging and metrics. */
export interface Hooks {
  onRequest?: (event: RequestEvent) => void;
  onResponse?: (event: ResponseEvent) => void;
  onRetry?: (event: RetryEvent) => void;
  /** Fired when a request waits because the rate limit window is used up. */
  onThrottle?: (event: ThrottleEvent) => void;
}

export interface HttpClientOptions {
  /** Default `https://api.deadlock-api.com`. */
  baseURL?: string;
  /**
   * Deadlock API key. Sent as `X-API-KEY`, never in the URL. Gives higher
   * rate limits and a larger share of the query queue.
   */
  apiKey?: string;
  /** Per attempt timeout in ms. Default 30000. */
  timeout?: number;
  /** Retry policy, or `false` to disable retries. */
  retry?: Partial<RetryOptions> | false;
  /**
   * Wait for the rate limit window to reset instead of running into a 429,
   * based on the `RateLimit-*` headers. Default `true`.
   */
  throttle?: boolean;
  /** Custom fetch for proxies, tests or edge runtimes. */
  fetch?: FetchLike;
  headers?: Record<string, string>;
  /** User-Agent for server runtimes. Browsers ignore it. `false` sends none. */
  userAgent?: string | false;
  hooks?: Hooks;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  parseAs?: ParseAs;
}

export const DEFAULT_BASE_URL = 'https://api.deadlock-api.com';
export const DEFAULT_USER_AGENT = `deadlock-sdk/${VERSION} (+https://github.com/justinjd00/deadlock-sdk)`;

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503]);
const isBrowser = typeof (globalThis as { document?: unknown }).document !== 'undefined';

export class HttpClient {
  readonly baseURL: string;
  private readonly timeout: number;
  private readonly retry: RetryOptions | false;
  private readonly throttle: boolean;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;
  private readonly hooks: Hooks;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly limits = new Map<string, RateLimitState>();

  constructor(options: HttpClientOptions = {}) {
    this.baseURL = (options.baseURL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = options.timeout ?? 30_000;
    this.retry =
      options.retry === false
        ? false
        : { retries: 2, minDelay: 400, maxDelay: 15_000, ...options.retry };
    this.throttle = options.throttle !== false;
    this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.hooks = options.hooks ?? {};

    const ua = options.userAgent === undefined ? DEFAULT_USER_AGENT : options.userAgent;
    this.headers = {
      Accept: 'application/json',
      ...(ua && !isBrowser ? { 'User-Agent': ua } : {}),
      ...(options.apiKey ? { 'X-API-KEY': options.apiKey } : {}),
      ...options.headers,
    };
  }

  /** Builds a URL. Arrays become comma separated lists, as the API expects. */
  buildUrl(path: string, query?: Query): string {
    const base = /^https?:\/\//i.test(path) ? path : `${this.baseURL}/${path.replace(/^\/+/, '')}`;
    const url = new URL(base);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        if (value.length) url.searchParams.set(key, value.join(','));
      } else {
        url.searchParams.set(key, String(value));
      }
    }
    return url.toString();
  }

  /** Last seen rate limit state for a path, if the API reported one. */
  rateLimit(path: string): RateLimitState | undefined {
    return this.limits.get(limitKey(this.buildUrl(path)));
  }

  /**
   * Sends a request. Identical concurrent GETs share one network call
   * (unless they pass their own `signal`).
   */
  request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    if (method !== 'GET' || options.signal) return this.execute<T>(method, url, options);

    const key = `${options.parseAs ?? 'json'} ${url}`;
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;
    const promise = this.execute<T>(method, url, options).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  get<T>(path: string, options: Omit<RequestOptions, 'body'> = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  private async execute<T>(method: HttpMethod, url: string, options: RequestOptions): Promise<T> {
    // Retrying writes could apply them twice.
    const maxAttempts = this.retry && method === 'GET' ? this.retry.retries + 1 : 1;
    let attempt = 0;

    for (;;) {
      attempt++;
      await this.waitForWindow(url, options.signal);
      try {
        return await this.attempt<T>(method, url, options, attempt);
      } catch (raw) {
        const error =
          raw instanceof DeadlockError
            ? raw
            : new DeadlockError(`Request to ${url} failed`, {
                code: 'NETWORK_ERROR',
                url,
                retryable: true,
                cause: raw,
              });

        const delay = this.retryDelay(error, attempt);
        if (!error.retryable || attempt >= maxAttempts || delay === undefined) {
          throw error.withAttempts(attempt);
        }
        this.hooks.onRetry?.({ method, url, attempt, error, delayMs: delay });
        await sleep(delay, options.signal, url);
      }
    }
  }

  private async attempt<T>(
    method: HttpMethod,
    url: string,
    options: RequestOptions,
    attempt: number
  ): Promise<T> {
    if (options.signal?.aborted) {
      throw new DeadlockError('Request aborted', {
        code: 'ABORTED',
        url,
        cause: options.signal.reason,
      });
    }

    const timeoutMs = options.timeout ?? this.timeout;
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), timeoutMs);
    const signal = anySignal([options.signal, timeoutController.signal]);
    const startedAt = Date.now();
    const hasBody = options.body !== undefined;

    this.hooks.onRequest?.({ method, url, attempt });

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: hasBody ? { ...this.headers, 'Content-Type': 'application/json' } : this.headers,
        body: hasBody ? JSON.stringify(options.body) : undefined,
        signal,
      });
    } catch (cause) {
      clearTimeout(timer);
      if (options.signal?.aborted) {
        throw new DeadlockError('Request aborted', { code: 'ABORTED', url, cause });
      }
      if (timeoutController.signal.aborted) {
        throw new DeadlockError(`Request timed out after ${timeoutMs}ms`, {
          code: 'TIMEOUT',
          url,
          retryable: true,
          cause,
        });
      }
      throw new DeadlockError(`Network error while requesting ${url}`, {
        code: 'NETWORK_ERROR',
        url,
        retryable: true,
        cause,
      });
    }

    try {
      const rateLimit = this.recordRateLimit(url, response.headers);
      this.hooks.onResponse?.({
        method,
        url,
        attempt,
        status: response.status,
        durationMs: Date.now() - startedAt,
        rateLimit,
      });

      if (!response.ok) {
        const text = await response.text();
        throw httpError(url, response, parseJson(text), text);
      }

      const parseAs = options.parseAs ?? 'json';
      if (parseAs === 'arrayBuffer') return (await response.arrayBuffer()) as T;
      const text = await response.text();
      if (parseAs === 'text') return text as T;
      if (response.status === 204 || text === '') return undefined as T;
      const body = parseJson(text);
      if (body === undefined) {
        throw new DeadlockError('Expected a JSON response', {
          code: 'INVALID_RESPONSE',
          url,
          status: response.status,
          body: text.slice(0, 500),
        });
      }
      return body as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private recordRateLimit(url: string, headers: Headers): RateLimitState | undefined {
    const limit = num(headers.get('ratelimit-limit') ?? headers.get('x-ratelimit-limit'));
    const remaining = num(
      headers.get('ratelimit-remaining') ?? headers.get('x-ratelimit-remaining')
    );
    const reset = num(headers.get('ratelimit-reset') ?? headers.get('x-ratelimit-reset'));
    if (limit === undefined && remaining === undefined) return undefined;
    const state: RateLimitState = {
      limit,
      remaining,
      // `RateLimit-Reset` is delta seconds per the IETF draft.
      resetAt: reset !== undefined ? Date.now() + reset * 1000 : undefined,
    };
    this.limits.set(limitKey(url), state);
    return state;
  }

  private async waitForWindow(url: string, signal?: AbortSignal): Promise<void> {
    if (!this.throttle) return;
    const state = this.limits.get(limitKey(url));
    if (!state || state.remaining === undefined || state.remaining > 0 || !state.resetAt) return;
    const delayMs = state.resetAt - Date.now();
    if (delayMs <= 0) return;
    const maxDelay = this.retry ? this.retry.maxDelay : 15_000;
    if (delayMs > maxDelay) return; // let the request fail with a clear 429 instead of hanging
    this.hooks.onThrottle?.({ url, delayMs });
    await sleep(delayMs, signal, url);
    state.remaining = undefined;
  }

  private retryDelay(error: DeadlockError, attempt: number): number | undefined {
    if (!this.retry) return undefined;
    const { minDelay, maxDelay } = this.retry;
    if (error.retryAfterMs !== undefined) {
      return error.retryAfterMs <= maxDelay ? error.retryAfterMs : undefined;
    }
    const exp = Math.min(maxDelay, minDelay * 2 ** (attempt - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2));
  }
}

function httpError(url: string, response: Response, body: unknown, text: string): DeadlockError {
  const status = response.status;
  const serverMessage =
    extractMessage(body) ?? (text && text.length < 300 && !/<html/i.test(text) ? text : undefined);
  const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));

  let code: DeadlockErrorCode = 'HTTP_ERROR';
  let message = `Deadlock API responded with ${status}${serverMessage ? `: ${serverMessage}` : ''}`;
  let retryable = RETRYABLE_STATUS.has(status);

  if (status === 400) code = 'BAD_REQUEST';
  if (status === 404) code = 'NOT_FOUND';
  if (status === 429) code = 'RATE_LIMITED';
  if (status === 503) code = 'SERVICE_BUSY';
  if (status === 504) {
    code = 'QUERY_TIMEOUT';
    retryable = false;
    message = `The query hit the API time limit${retryAfterMs ? ` and is blocked for ${Math.ceil(retryAfterMs / 1000)}s` : ''}. Narrow the filters instead of retrying.`;
  }
  if (status === 403) {
    const cloudflare =
      response.headers.has('cf-mitigated') ||
      (/<html/i.test(text) && /cloudflare|just a moment/i.test(text));
    code = cloudflare ? 'BLOCKED' : 'FORBIDDEN';
    if (!serverMessage && !cloudflare)
      message = 'Forbidden. The player may have opted out of public data.';
    if (cloudflare)
      message = 'Blocked by Cloudflare. Send an identifiable userAgent or use an API key.';
  }

  return new DeadlockError(message, {
    code,
    url,
    status,
    body: body ?? text.slice(0, 500),
    retryable,
    retryAfterMs,
  });
}

function extractMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  for (const key of ['message', 'error', 'detail']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function num(value: string | null): number | undefined {
  if (value === null || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Rate limits are tracked per endpoint path, ignoring the query string. */
function limitKey(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function anySignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const list = signals.filter((s): s is AbortSignal => s !== undefined);
  if (list.length === 1) return list[0]!;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(list);
  const controller = new AbortController();
  for (const signal of list) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller.signal;
}

function sleep(ms: number, signal: AbortSignal | undefined, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () =>
      new DeadlockError('Request aborted', { code: 'ABORTED', url, cause: signal?.reason });
    if (signal?.aborted) return reject(aborted());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(aborted());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
