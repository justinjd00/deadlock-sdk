import { describe, expect, it, vi } from 'vitest';
import { DeadlockError, HttpClient, isDeadlockError } from '../src';
import { json } from './helpers';

const BASE = 'https://api.deadlock-api.com';

function client(
  responses: Array<Response | Error>,
  options: ConstructorParameters<typeof HttpClient>[0] = {}
) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => {
    const next = responses.shift();
    if (!next) throw new Error('no more responses');
    if (next instanceof Error) throw next;
    return next;
  });
  const http = new HttpClient({
    fetch,
    retry: { minDelay: 1, maxDelay: 50 },
    userAgent: false,
    ...options,
  });
  return { http, fetch };
}

const caught = async (p: Promise<unknown>): Promise<DeadlockError> => {
  try {
    await p;
  } catch (e) {
    if (isDeadlockError(e)) return e;
    throw e;
  }
  throw new Error('expected a rejection');
};

describe('HttpClient', () => {
  it('builds URLs with comma separated arrays and skips empty values', () => {
    const { http } = client([]);
    const url = http.buildUrl('/v1/players/rank', {
      account_ids: [1, 2, 3],
      hero_id: undefined,
      a: '',
      b: 0,
      c: false,
    });
    expect(url).toBe(`${BASE}/v1/players/rank?account_ids=1%2C2%2C3&b=0&c=false`);
    expect(http.buildUrl('https://other.example/x')).toBe('https://other.example/x');
  });

  it('sends the API key and a user agent', async () => {
    const { http, fetch } = client([json({})], { apiKey: 'secret', userAgent: 'test-agent' });
    await http.get('/v1/info');
    const headers = fetch.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers['X-API-KEY']).toBe('secret');
    expect(headers['User-Agent']).toBe('test-agent');
  });

  it('retries a busy server and honors Retry-After', async () => {
    const onRetry = vi.fn();
    const { http, fetch } = client(
      [new Response('busy', { status: 503, headers: { 'retry-after': '0' } }), json({ ok: true })],
      { hooks: { onRetry } }
    );
    await expect(http.get('/v1/info')).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatchObject({ attempt: 1, delayMs: 0 });
  });

  it('never retries a 504 query timeout, the same query would time out again', async () => {
    const { http, fetch } = client([
      new Response('Query timed out', { status: 504, headers: { 'retry-after': '1' } }),
    ]);
    const error = await caught(http.get('/v1/sql'));
    expect(error.code).toBe('QUERY_TIMEOUT');
    expect(error.retryable).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('maps status codes to error codes with the server message', async () => {
    const cases: Array<[number, string]> = [
      [400, 'BAD_REQUEST'],
      [403, 'FORBIDDEN'],
      [404, 'NOT_FOUND'],
    ];
    for (const [status, code] of cases) {
      const { http } = client([json({ error: 'nope' }, { status })]);
      const error = await caught(http.get('/v1/x'));
      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).toContain('nope');
      expect(error.attempts).toBe(1);
    }
  });

  it('gives up after the configured retries and reports the attempts', async () => {
    const { http, fetch } = client([
      new Response('', { status: 502 }),
      new Response('', { status: 502 }),
      new Response('', { status: 502 }),
    ]);
    const error = await caught(http.get('/v1/x'));
    expect(error.attempts).toBe(3);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('does not retry writes', async () => {
    const { http, fetch } = client([new Response('', { status: 503 })]);
    await caught(http.request('POST', '/v1/x', { body: { a: 1 } }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![1]!.body).toBe('{"a":1}');
  });

  it('wraps network failures and retries them', async () => {
    const { http, fetch } = client([new TypeError('fetch failed'), json([1])]);
    await expect(http.get('/v1/x')).resolves.toEqual([1]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('times out slow requests', async () => {
    const fetch = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_, reject) =>
          init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        )
    );
    const http = new HttpClient({ fetch, retry: false, timeout: 20 });
    expect((await caught(http.get('/v1/x'))).code).toBe('TIMEOUT');
  });

  it('aborts with the caller signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const { http, fetch } = client([json({})]);
    expect((await caught(http.get('/v1/x', { signal: controller.signal }))).code).toBe('ABORTED');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shares one request between identical concurrent GETs', async () => {
    const { http, fetch } = client([json({ n: 1 })]);
    const [a, b] = await Promise.all([http.get('/v1/x'), http.get('/v1/x')]);
    expect(a).toEqual(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('waits for the rate limit window instead of running into a 429', async () => {
    vi.useFakeTimers();
    try {
      const onThrottle = vi.fn();
      const { http, fetch } = client(
        [
          json(
            {},
            {
              headers: {
                'content-type': 'application/json',
                'ratelimit-limit': '200',
                'ratelimit-remaining': '0',
                'ratelimit-reset': '1',
              },
            }
          ),
          json({ second: true }),
        ],
        { hooks: { onThrottle }, retry: { maxDelay: 5000 } }
      );
      await http.get('/v1/x');
      expect(http.rateLimit('/v1/x')).toMatchObject({ limit: 200, remaining: 0 });
      const second = http.get('/v1/x');
      await vi.advanceTimersByTimeAsync(0);
      expect(onThrottle).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      await expect(second).resolves.toEqual({ second: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects non JSON bodies when JSON was expected', async () => {
    const { http } = client([new Response('<html>oops</html>', { status: 200 })]);
    expect((await caught(http.get('/v1/x'))).code).toBe('INVALID_RESPONSE');
  });

  it('returns text and binary when asked', async () => {
    const { http } = client([new Response('plain'), new Response(new Uint8Array([1, 2]))]);
    await expect(http.get('/v1/x', { parseAs: 'text' })).resolves.toBe('plain');
    const buf = await http.get<ArrayBuffer>('/v1/y', { parseAs: 'arrayBuffer' });
    expect(new Uint8Array(buf)).toEqual(new Uint8Array([1, 2]));
  });
});
