import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { vi } from 'vitest';
import { DeadlockClient, type DeadlockClientOptions } from '../src';

// Real API responses, trimmed and anonymized by scripts/capture-fixtures.mjs.
// Resolved from the project root so it also works in the jsdom environment.
export const fixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(join(process.cwd(), 'test', 'fixtures', `${name}.json`), 'utf8')) as T;

export const SUBJECT = 1001;
export const MATCH_ID: number = fixture('match-metadata').match_info.match_id;

export function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

type Route = [RegExp, (url: URL) => unknown];

const routes: Route[] = [
  [
    /^\/v1\/assets\/heroes$/,
    (u) => {
      const heroes = fixture<Array<{ player_selectable: boolean; disabled: boolean }>>('heroes');
      return u.searchParams.get('only_active') === 'true'
        ? heroes.filter((h) => h.player_selectable && !h.disabled)
        : heroes;
    },
  ],
  [/^\/v1\/assets\/items$/, () => fixture('items')],
  [/^\/v1\/assets\/ranks$/, () => fixture('ranks')],
  [/^\/v1\/analytics\/hero-stats$/, () => fixture('hero-stats')],
  [/^\/v1\/analytics\/hero-counter-stats$/, () => fixture('hero-counter-stats')],
  [/^\/v1\/analytics\/hero-synergy-stats$/, () => fixture('hero-synergy-stats')],
  [/^\/v1\/analytics\/item-stats$/, () => fixture('item-stats')],
  [/^\/v1\/matches\/\d+\/metadata$/, () => fixture('match-metadata')],
  [/^\/v1\/matches\/active$/, () => fixture('active')],
  [/^\/v1\/players\/\d+\/match-history$/, () => fixture('match-history')],
  [/^\/v1\/players\/\d+\/rank$/, () => fixture('rank')],
  [
    /^\/v1\/players\/rank$/,
    (u) =>
      u.searchParams
        .get('account_ids')!
        .split(',')
        .map((id) => ({ account_id: Number(id), badge: 81 })),
  ],
  [/^\/v1\/players\/steam$/, () => fixture('steam')],
  [/^\/v1\/players\/steam-search$/, () => fixture('steam')],
  [/^\/v1\/leaderboard\/[A-Za-z]+$/, () => fixture('leaderboard')],
  [/^\/v1\/patches$/, () => fixture('patches')],
  [/^\/v1\/sql\/tables$/, () => ['match_info', 'match_player']],
  [/^\/v1\/sql$/, () => [{ hero_id: 1, games: 10 }]],
];

/** A fetch that answers like the real API from fixtures, 404 for anything else. */
export function fakeApi() {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    const route = routes.find(([re]) => re.test(url.pathname));
    if (!route) return new Response('Not Found', { status: 404 });
    return json(route[1](url));
  });
}

export function testClient(options: DeadlockClientOptions = {}) {
  const fetch = fakeApi();
  const client = new DeadlockClient({
    fetch,
    retry: false,
    throttle: false,
    userAgent: false,
    ...options,
  });
  return { client, fetch };
}

/** Paths of every request a mocked fetch received. */
export const requested = (fetch: ReturnType<typeof fakeApi>) =>
  fetch.mock.calls.map(([input]) => new URL(String(input)).pathname);
