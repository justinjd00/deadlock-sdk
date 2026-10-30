/**
 * Contract tests against the live Deadlock API. They check the parts the SDK
 * relies on beyond the generated types: real response shapes, the match
 * metadata layout (which the spec leaves untyped) and the derived numbers.
 *
 *   npm run test:contract
 */
import { describe, expect, it } from 'vitest';
import { DeadlockClient, LEADERBOARD_REGIONS, RANK_NAMES } from '../src';

const dl = new DeadlockClient({
  cache: { ttl: 10 * 60_000 },
  userAgent: 'deadlock-sdk contract tests',
});
const lastWeek = () => ({ min_unix_timestamp: Math.floor(Date.now() / 1000) - 7 * 86400 });

describe('Deadlock API contract', () => {
  it('assets: heroes, items and ranks', async () => {
    const heroes = await dl.heroes.list();
    expect(heroes.length).toBeGreaterThan(20);
    expect(heroes[0]).toMatchObject({
      id: expect.any(Number),
      name: expect.any(String),
      class_name: expect.any(String),
    });

    const shop = await dl.items.shop();
    expect(shop.length).toBeGreaterThan(80);
    expect(new Set(shop.map((i) => i.item_slot_type))).toEqual(
      new Set(['weapon', 'vitality', 'spirit'])
    );

    const ranks = await dl.ranks.list();
    // The built-in fallback table must stay in sync with the live names.
    for (const r of ranks) expect(RANK_NAMES[r.tier]).toBe(r.name);
  });

  it('analytics: hero stats add up to 12 heroes per match', async () => {
    const stats = await dl.heroes.stats(lastWeek());
    const picks = stats.reduce((n, s) => n + s.pickRate, 0);
    expect(picks).toBeGreaterThan(11.5);
    expect(picks).toBeLessThan(12.5);
    const tiers = await dl.heroes.tierList(lastWeek());
    expect(tiers.filter((t) => t.tier === 'S').length).toBeGreaterThan(0);
  });

  it('matchups for one hero', async () => {
    const [hero] = await dl.heroes.list();
    const counters = await dl.heroes.counters(hero!.id, lastWeek());
    const mates = await dl.heroes.synergies(hero!.id, lastWeek());
    expect(counters.length).toBeGreaterThan(10);
    expect(mates.length).toBeGreaterThan(10);
  });

  it('leaderboard, live matches and player data', async () => {
    const board = await dl.leaderboard.get(LEADERBOARD_REGIONS[0], { limit: 20 });
    expect(board.length).toBe(20);
    expect(board[0]!.rank).toBe(1);

    const live = await dl.matches.active();
    expect(Array.isArray(live)).toBe(true);

    // Pick a real, public player from the leaderboard instead of a hardcoded id.
    const accountId = board.flatMap((r) => r.accountIds)[0]!;
    const history = await dl.players.matchHistory(accountId, { limit: 20 });
    expect(history.length).toBeGreaterThan(0);
    expect(history[0]).toMatchObject({
      match_id: expect.any(Number),
      hero_id: expect.any(Number),
      start_time: expect.any(Number),
      player_team: expect.any(Number),
      match_result: expect.any(Number),
    });

    // The match metadata response is untyped in the spec, check what the scoreboard reads.
    const board2 = await dl.matches.scoreboard(history[0]!.match_id);
    expect(board2.teams[0].length + board2.teams[1].length).toBe(12);
    const me = [...board2.teams[0], ...board2.teams[1]].find((p) => p.accountId === accountId);
    expect(me?.heroId).toBe(history[0]!.hero_id);
    expect(me?.kills).toBe(history[0]!.player_kills);
    expect(me?.finalItems.length).toBeGreaterThan(0);
  });

  it('patches and SQL', async () => {
    const latest = await dl.patches.latest();
    expect(latest?.url).toMatch(/^https:\/\//);
    const tables = await dl.sql.tables();
    expect(tables).toContain('match_player');
    const columns = await dl.sql.schema('match_player');
    expect(columns.map((c) => c.name)).toEqual(
      expect.arrayContaining(['match_id', 'hero_id', 'account_id'])
    );
  });
});
