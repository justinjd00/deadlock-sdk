import type { Schemas } from '../core/typed';
import { kda, round, winRate } from './stats';

export type MatchHistoryEntry = Schemas['PlayerMatchHistoryEntry'];

/** `true` when the player's team won. */
export function didWin(entry: Pick<MatchHistoryEntry, 'match_result' | 'player_team'>): boolean {
  return entry.match_result === entry.player_team;
}

export interface HeroSummary {
  heroId: number;
  matches: number;
  wins: number;
  winRate: number;
  kda: number;
  avgNetWorth: number;
}

export interface HistorySummary {
  matches: number;
  wins: number;
  losses: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  avgNetWorth: number;
  avgLastHits: number;
  avgDurationS: number;
  /** Current streak, newest match first. */
  streak: { type: 'win' | 'loss' | 'none'; count: number };
  /** Sum of rank progress from ranked matches in this window. */
  rankedDelta: number;
  /** Most played first. */
  heroes: HeroSummary[];
  firstMatchAt?: Date;
  lastMatchAt?: Date;
}

/** Aggregates a match history (or any slice of it) into the numbers people look at. */
export function summarizeHistory(entries: readonly MatchHistoryEntry[]): HistorySummary {
  const sorted = [...entries].sort((a, b) => b.start_time - a.start_time);
  let wins = 0;
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  let netWorth = 0;
  let lastHits = 0;
  let duration = 0;
  let rankedDelta = 0;
  const heroes = new Map<
    number,
    { m: number; w: number; k: number; d: number; a: number; nw: number }
  >();

  for (const e of sorted) {
    const won = didWin(e);
    if (won) wins++;
    kills += e.player_kills;
    deaths += e.player_deaths;
    assists += e.player_assists;
    netWorth += e.net_worth;
    lastHits += e.last_hits;
    duration += e.match_duration_s;
    rankedDelta += e.ranked_delta ?? 0;
    const h = heroes.get(e.hero_id) ?? { m: 0, w: 0, k: 0, d: 0, a: 0, nw: 0 };
    h.m++;
    if (won) h.w++;
    h.k += e.player_kills;
    h.d += e.player_deaths;
    h.a += e.player_assists;
    h.nw += e.net_worth;
    heroes.set(e.hero_id, h);
  }

  let streak: HistorySummary['streak'] = { type: 'none', count: 0 };
  if (sorted.length) {
    const first = didWin(sorted[0]!);
    let count = 0;
    for (const e of sorted) {
      if (didWin(e) !== first) break;
      count++;
    }
    streak = { type: first ? 'win' : 'loss', count };
  }

  const n = sorted.length;
  return {
    matches: n,
    wins,
    losses: n - wins,
    winRate: round(winRate(wins, n), 4),
    kills,
    deaths,
    assists,
    kda: round(kda(kills, deaths, assists)),
    avgNetWorth: n ? Math.round(netWorth / n) : 0,
    avgLastHits: n ? round(lastHits / n, 1) : 0,
    avgDurationS: n ? Math.round(duration / n) : 0,
    streak,
    rankedDelta,
    heroes: [...heroes.entries()]
      .map(([heroId, h]) => ({
        heroId,
        matches: h.m,
        wins: h.w,
        winRate: round(winRate(h.w, h.m), 4),
        kda: round(kda(h.k, h.d, h.a)),
        avgNetWorth: Math.round(h.nw / h.m),
      }))
      .sort((a, b) => b.matches - a.matches || b.winRate - a.winRate),
    firstMatchAt: n ? new Date(sorted[n - 1]!.start_time * 1000) : undefined,
    lastMatchAt: n ? new Date(sorted[0]!.start_time * 1000) : undefined,
  };
}
