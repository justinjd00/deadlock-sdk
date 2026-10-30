import { describe, expect, it } from 'vitest';
import {
  chunk,
  decodeBadge,
  didWin,
  encodeBadge,
  gameModeName,
  isPlayerInput,
  kda,
  matchModeName,
  normalizeRegion,
  parseBadge,
  parseRetryAfter,
  steamProfileUrl,
  summarizeHistory,
  toAccountId,
  toCSV,
  toSteamId2,
  toSteamId3,
  toSteamId64,
  wilsonLowerBound,
  winRate,
  type MatchHistoryEntry,
} from '../src';
import { fixture } from './helpers';

describe('steam ids', () => {
  // Valve's documented example account.
  const id = 22202;
  const forms = [
    '22202',
    '76561197960287930',
    '[U:1:22202]',
    'U:1:22202',
    'STEAM_1:0:11101',
    'STEAM_0:0:11101',
  ];

  it.each(forms)('reads %s', (input) => expect(toAccountId(input)).toBe(id));

  it('reads numbers, bigints and profile URLs', () => {
    expect(toAccountId(id)).toBe(id);
    expect(toAccountId(76561197960287930n)).toBe(id);
    expect(toAccountId('https://steamcommunity.com/profiles/76561197960287930/')).toBe(id);
    expect(toAccountId(' 76561197960287930 ')).toBe(id);
  });

  it('converts to every format', () => {
    expect(toSteamId64(id)).toBe('76561197960287930');
    expect(toSteamId3(id)).toBe('[U:1:22202]');
    expect(toSteamId2(id)).toBe('STEAM_1:0:11101');
    expect(toSteamId2(22203)).toBe('STEAM_1:1:11101');
    expect(steamProfileUrl(id)).toBe('https://steamcommunity.com/profiles/76561197960287930');
  });

  it('explains vanity URLs and rejects garbage', () => {
    expect(() => toAccountId('https://steamcommunity.com/id/gaben')).toThrow(/vanity/i);
    for (const bad of ['', 'abc', '-5', '1.5', 'STEAM_1:2:3'])
      expect(() => toAccountId(bad)).toThrow();
    expect(isPlayerInput('[U:1:5]')).toBe(true);
    expect(isPlayerInput('nope')).toBe(false);
    expect(isPlayerInput({})).toBe(false);
  });
});

describe('ranks', () => {
  const ranks = fixture('ranks');

  it('decodes badges', () => {
    expect(decodeBadge(115)).toMatchObject({
      tier: 11,
      subrank: 5,
      name: 'Eternus',
      label: 'Eternus 5',
    });
    expect(decodeBadge(0)).toMatchObject({ tier: 0, label: 'Obscurus' });
    expect(decodeBadge(-3).badge).toBe(0);
  });

  it('uses live rank assets for names and icons', () => {
    const d = decodeBadge(115, ranks);
    expect(d.name).toBe('Eternus');
    expect(d.image).toMatch(/^https:\/\//);
    expect(d.color).toMatch(/^#/);
  });

  it('parses what people type', () => {
    expect(parseBadge('oracle')).toBe(81);
    expect(parseBadge('Oracle 3')).toBe(83);
    expect(parseBadge('eternus6')).toBe(116);
    expect(parseBadge('obscurus')).toBe(0);
    expect(parseBadge('81')).toBe(81);
    expect(parseBadge(95.7)).toBe(95);
    expect(encodeBadge(8, 1)).toBe(81);
    expect(() => parseBadge('diamond')).toThrow(RangeError);
    expect(() => parseBadge('oracle 7')).toThrow(RangeError);
  });
});

describe('stats', () => {
  it('computes win rate and KDA without dividing by zero', () => {
    expect(winRate(3, 4)).toBe(0.75);
    expect(winRate(0, 0)).toBe(0);
    expect(kda(10, 0, 5)).toBe(15);
    expect(kda(10, 5, 5)).toBe(3);
  });

  it('ranks big samples above lucky small ones', () => {
    // 6/10 has the higher raw win rate but far less evidence than 550/1000.
    expect(wilsonLowerBound(550, 1000)).toBeGreaterThan(wilsonLowerBound(6, 10));
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(500, 1000)).toBeCloseTo(0.469, 3);
  });

  it('chunks lists', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });
});

describe('modes and regions', () => {
  it('names modes', () => {
    expect(gameModeName(1)).toBe('Normal');
    expect(matchModeName(4)).toBe('Ranked');
    expect(matchModeName(99)).toBe('Mode 99');
  });

  it('normalizes regions and rejects unknown ones', () => {
    expect(normalizeRegion('eu')).toBe('Europe');
    expect(normalizeRegion('North America')).toBe('NAmerica');
    expect(normalizeRegion('oce')).toBe('Oceania');
    expect(normalizeRegion('SAMERICA')).toBe('SAmerica');
    expect(() => normalizeRegion('mars')).toThrow(/Unknown region/);
  });
});

describe('match history', () => {
  const history = fixture<MatchHistoryEntry[]>('match-history');

  it('agrees with a manual count', () => {
    const s = summarizeHistory(history);
    const wins = history.filter((m) => m.match_result === m.player_team).length;
    expect(s.matches).toBe(history.length);
    expect(s.wins).toBe(wins);
    expect(s.losses).toBe(history.length - wins);
    expect(s.winRate).toBeCloseTo(wins / history.length, 3);
    expect(s.heroes.reduce((n, h) => n + h.matches, 0)).toBe(history.length);
    expect(s.heroes[0]!.matches).toBeGreaterThanOrEqual(s.heroes.at(-1)!.matches);
    expect(s.lastMatchAt!.getTime()).toBeGreaterThanOrEqual(s.firstMatchAt!.getTime());
  });

  it('counts the current streak from the newest match', () => {
    const base = history[0]!;
    const m = (t: number, win: boolean): MatchHistoryEntry => ({
      ...base,
      start_time: t,
      player_team: 0,
      match_result: win ? 0 : 1,
    });
    // Shuffled order on purpose, the newest two are wins.
    const s = summarizeHistory([m(1, false), m(3, true), m(2, false), m(4, true)]);
    expect(s.streak).toEqual({ type: 'win', count: 2 });
    expect(didWin(m(1, true))).toBe(true);
    expect(summarizeHistory([]).streak).toEqual({ type: 'none', count: 0 });
  });
});

describe('misc', () => {
  it('parses Retry-After as seconds or a date', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    const inFuture = new Date(Date.now() + 5000).toUTCString();
    expect(parseRetryAfter(inFuture)).toBeGreaterThan(3000);
  });

  it('exports CSV with escaping', () => {
    expect(toCSV([{ a: 'x,y', b: 1 }])).toBe('a,b\r\n"x,y",1');
  });
});
