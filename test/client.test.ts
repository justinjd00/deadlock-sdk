import { describe, expect, it, vi } from 'vitest';
import { ATTRIBUTION, DeadlockClient, MemoryCache, didWin, type MatchHistoryEntry } from '../src';
import { MATCH_ID, SUBJECT, fixture, json, requested, testClient } from './helpers';

const history = fixture<MatchHistoryEntry[]>('match-history');

describe('typed api', () => {
  it('fills path parameters and sends query arrays comma separated', async () => {
    const { client, fetch } = testClient();
    await client.api.get('/v1/players/{account_id}/rank', { path: { account_id: SUBJECT } });
    await client.api.get('/v1/players/rank', { query: { account_ids: [1, 2] } });
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe(`https://api.deadlock-api.com/v1/players/${SUBJECT}/rank`);
    expect(urls[1]).toContain('account_ids=1%2C2');
  });

  it('rejects unfilled path parameters before hitting the network', async () => {
    const { client, fetch } = testClient();
    await expect(
      client.api.get('/v1/players/{account_id}/rank', { path: {} as never })
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('cache', () => {
  it('serves repeated asset calls from the cache and bypasses it with fresh', async () => {
    const { client, fetch } = testClient();
    await client.heroes.list();
    await client.heroes.list();
    expect(fetch).toHaveBeenCalledTimes(1);
    await client.heroes.list({}, { fresh: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('keys by full URL so filters never collide', async () => {
    const { client } = testClient();
    const active = await client.heroes.list();
    const all = await client.heroes.list({ onlyActive: false });
    expect(all.length).toBeGreaterThan(active.length);
  });

  it('can be disabled', async () => {
    const { client, fetch } = testClient({ cache: false });
    await client.heroes.list();
    await client.heroes.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('serves stale data while revalidating in the background', async () => {
    const store = new MemoryCache();
    const { client, fetch } = testClient({
      cache: { store, ttl: 1, staleWhileRevalidate: 60_000 },
    });
    await client.patches.list();
    await new Promise((r) => setTimeout(r, 5));
    await client.patches.list();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  });

  it('clears everything', async () => {
    const { client, fetch } = testClient();
    await client.heroes.list();
    await client.clearCache();
    await client.heroes.list();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe('players', () => {
  it('builds a profile summary from rank, history, profile and heroes', async () => {
    const { client, fetch } = testClient();
    const s = await client.players.summary(`[U:1:${SUBJECT}]`, { matches: 20 });
    expect(s.accountId).toBe(SUBJECT);
    expect(s.steamId64).toBe(String(76561197960265728n + BigInt(SUBJECT)));
    expect(s.profile?.personaname).toBe('Test Player');
    expect(s.rank?.label).toMatch(/^[A-Z][a-z]+ \d$/);
    expect(s.recent.matches).toBe(20);
    expect(s.topHeroes.length).toBeGreaterThan(0);
    expect(s.topHeroes.every((h) => !h.name.startsWith('Hero '))).toBe(true);
    // Rank, history, profile and assets run in parallel, no duplicate calls.
    const paths = requested(fetch);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('tolerates private players', async () => {
    const fetch = vi.fn(async (url: string) =>
      /rank|steam/.test(url)
        ? json({ error: 'protected' }, { status: 403 })
        : url.includes('match-history')
          ? json([])
          : json([])
    );
    const client = new DeadlockClient({ fetch, retry: false });
    const s = await client.players.summary(SUBJECT);
    expect(s.rank).toBeUndefined();
    expect(s.profile).toBeUndefined();
    expect(s.recent.matches).toBe(0);
  });

  it('filters match history locally and sorts newest first', async () => {
    const { client } = testClient();
    const heroId = history[0]!.hero_id;
    const since = history[5]!.start_time;
    const rows = await client.players.matchHistory(SUBJECT, { heroId, since, limit: 3 });
    expect(rows.length).toBeLessThanOrEqual(3);
    expect(rows.every((r) => r.hero_id === heroId && r.start_time >= since)).toBe(true);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i - 1]!.start_time).toBeGreaterThanOrEqual(rows[i]!.start_time);
    const ranked = await client.players.matchHistory(SUBJECT, { matchModes: [4] });
    expect(ranked.every((r) => r.match_mode === 4)).toBe(true);
  });

  it('splits rank lookups into batches of 1000', async () => {
    const fetch = vi.fn(async (url: string) => {
      if (url.includes('/assets/ranks')) return json(fixture('ranks'));
      const ids = new URL(url).searchParams.get('account_ids')!.split(',');
      return json(ids.map((id) => ({ account_id: Number(id), badge: 81 })));
    });
    const client = new DeadlockClient({ fetch, retry: false });
    const ids = Array.from({ length: 2500 }, (_, i) => i + 1);
    const ranks = await client.players.ranks([...ids, 1, 2]);
    expect(ranks).toHaveLength(2500);
    expect(ranks[0]).toMatchObject({ label: 'Oracle 1' });
    expect(fetch.mock.calls.filter(([u]) => u.includes('/players/rank'))).toHaveLength(3);
  });
});

describe('matches', () => {
  it('builds a scoreboard with names, teams and final items', async () => {
    const { client } = testClient();
    const meta = fixture('match-metadata').match_info;
    const s = await client.matches.scoreboard(MATCH_ID);
    expect(s.matchId).toBe(MATCH_ID);
    expect(s.teams[0]).toHaveLength(6);
    expect(s.teams[1]).toHaveLength(6);
    const winners = s.teams[s.winningTeam]!;
    expect(winners.every((p) => p.won)).toBe(true);
    expect(s.teams[1 - s.winningTeam]!.every((p) => !p.won)).toBe(true);
    const all = [...s.teams[0], ...s.teams[1]];
    expect(all.every((p) => !p.heroName.startsWith('Hero '))).toBe(true);
    expect(all.some((p) => p.finalItems.length > 0)).toBe(true);
    expect(all.reduce((n, p) => n + p.kills, 0)).toBe(
      meta.players.reduce((n: number, p: { kills: number }) => n + p.kills, 0)
    );
    // Sorted by net worth within each team.
    for (const team of s.teams)
      for (let i = 1; i < team.length; i++)
        expect(team[i - 1]!.netWorth).toBeGreaterThanOrEqual(team[i]!.netWorth);
  });

  it('splits bulk metadata into requests of 1000 ids', async () => {
    const fetch = vi.fn(async (url: string) => {
      const ids = new URL(url).searchParams.get('match_ids')!.split(',');
      return json(ids.map((id) => ({ match_id: Number(id) })));
    });
    const client = new DeadlockClient({ fetch, retry: false });
    const rows = await client.matches.getMany(Array.from({ length: 1500 }, (_, i) => i));
    expect(rows).toHaveLength(1500);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(String(fetch.mock.calls[0]![0])).toContain('include_info=true');
  });

  it('lists active matches for one or many players', async () => {
    const { client, fetch } = testClient();
    expect((await client.matches.active()).length).toBeGreaterThan(0);
    await client.matches.active({ players: [SUBJECT] });
    await client.matches.active({ players: [SUBJECT, 1002] });
    const urls = fetch.mock.calls.map(([u]) => String(u));
    expect(urls[1]).toContain(`account_id=${SUBJECT}`);
    expect(urls[2]).toContain('account_ids=1001%2C1002');
  });
});

describe('heroes and items', () => {
  it('finds heroes by id, name and class name', async () => {
    const { client } = testClient();
    const heroes = await client.heroes.list({ onlyActive: false });
    const hero = heroes.find((h) => h.name.includes(' ')) ?? heroes[0]!;
    expect((await client.heroes.get(hero.id))?.id).toBe(hero.id);
    expect((await client.heroes.get(hero.name.toUpperCase()))?.id).toBe(hero.id);
    expect((await client.heroes.get(hero.class_name))?.id).toBe(hero.id);
    expect(await client.heroes.get('definitely not a hero')).toBeUndefined();
    await expect(client.heroes.require('nope')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('computes hero stats that add up', async () => {
    const { client } = testClient();
    const stats = await client.heroes.stats();
    const pickSum = stats.reduce((n, s) => n + s.pickRate, 0);
    // 12 heroes per match, so pick rates sum to about 12.
    expect(pickSum).toBeGreaterThan(11.9);
    expect(pickSum).toBeLessThan(12.1);
    expect(stats.every((s) => s.confidence <= s.winRate)).toBe(true);
  });

  it('builds a tier list ranked by confidence', async () => {
    const { client } = testClient();
    const tiers = await client.heroes.tierList({}, { minMatches: 1 });
    expect(tiers[0]!.tier).toBe('S');
    expect(tiers.at(-1)!.tier).toBe('D');
    expect(tiers.map((t) => t.position)).toEqual(tiers.map((_, i) => i + 1));
    for (let i = 1; i < tiers.length; i++)
      expect(tiers[i - 1]!.confidence).toBeGreaterThanOrEqual(tiers[i]!.confidence);
  });

  it('returns counters and synergies for the asked hero only', async () => {
    const { client } = testClient();
    const heroId = fixture('hero-counter-stats')[0].hero_id as number;
    const counters = await client.heroes.counters(heroId, {}, { minMatches: 1 });
    const mates = await client.heroes.synergies(heroId, {}, { minMatches: 1 });
    expect(counters.length).toBeGreaterThan(5);
    expect(counters.some((c) => c.heroId === heroId)).toBe(false);
    expect(mates.length).toBeGreaterThan(5);
    expect(mates.every((m) => m.heroId !== heroId)).toBe(true);
  });

  it('filters shop items and joins item stats with names', async () => {
    const { client } = testClient();
    const shop = await client.items.shop({ tier: 1 });
    expect(shop.length).toBeGreaterThan(0);
    expect(shop.every((i) => i.item_tier === 1 && i.shopable)).toBe(true);
    const vitality = await client.items.list({ type: 'upgrade', slot: 'vitality' });
    expect(
      vitality.every((i) => (i as { item_slot_type?: string }).item_slot_type === 'vitality')
    ).toBe(true);
    const stats = await client.items.stats({}, { minMatches: 1 });
    expect(stats.length).toBeGreaterThan(0);
    expect(stats.every((s) => s.name !== String(s.itemId))).toBe(true);
  });

  it('searches heroes and items with typos', async () => {
    const { client } = testClient();
    const hero = (await client.heroes.list())[0]!;
    const typo = hero.name.slice(0, -1) + (hero.name.endsWith('x') ? 'y' : 'x');
    const hits = await client.search(typo, { in: ['heroes'] });
    expect(hits[0]?.value).toMatchObject({ type: 'hero', data: { id: hero.id } });
  });
});

describe('meta', () => {
  it('normalizes leaderboard regions and resolves hero names', async () => {
    const { client, fetch } = testClient();
    const rows = await client.leaderboard.get('eu', { limit: 5 });
    expect(rows).toHaveLength(5);
    expect(rows[0]!.rank).toBe(1);
    expect(requested(fetch)).toContain('/v1/leaderboard/Europe');
    const withHeroes = rows.find((r) => r.topHeroIds.length);
    expect(withHeroes?.topHeroes[0]).not.toMatch(/^Hero /);
    await expect(client.leaderboard.get('mars')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('finds a player on the leaderboard by name', async () => {
    const { client } = testClient();
    expect((await client.leaderboard.find('player 2', 'eu'))?.rank).toBe(2);
  });

  it('returns patch notes newest first with dates', async () => {
    const { client } = testClient();
    const patches = await client.patches.list();
    expect(patches[0]!.publishedAt).toBeInstanceOf(Date);
    expect(patches[0]!.url).toMatch(/^https:\/\//);
    expect((await client.patches.latest())?.title).toBe(patches[0]!.title);
  });

  it('runs SQL and parses the JSON rows', async () => {
    const { client, fetch } = testClient();
    const rows = await client.sql.query<{ hero_id: number }>('SELECT 1');
    expect(rows[0]!.hero_id).toBe(1);
    expect(String(fetch.mock.calls[0]![0])).toContain('query=SELECT+1');
    await expect(client.sql.query('  ')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('exposes an attribution line', () => {
    expect(ATTRIBUTION.url).toBe('https://deadlock-api.com');
  });
});

describe('fixtures', () => {
  it('contain no real account ids', () => {
    const ids = new Set(history.map((m) => m.account_id));
    expect([...ids]).toEqual([SUBJECT]);
    expect(history.some(didWin)).toBe(true);
  });
});
