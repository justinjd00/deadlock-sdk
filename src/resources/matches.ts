import type { DeadlockClient } from '../client';
import type { CallOptions, Operation, QueryParams, Schemas } from '../core/typed';
import { kda, round } from '../helpers/stats';
import { toAccountId, type PlayerInput } from '../helpers/steamid';
import type { MatchMetadata, MatchPlayer } from './match-types';

type BulkQuery = Omit<
  QueryParams<Operation<'/v1/matches/metadata', 'get'>>,
  'match_ids' | 'format'
>;

/** One row from the bulk metadata endpoint. Shape depends on the `include_*` flags. */
export interface BulkMatch {
  match_id: number;
  /** `"YYYY-MM-DD HH:MM:SS"` in UTC. */
  start_time?: string;
  /** `"Team0"` or `"Team1"`. */
  winning_team?: string;
  duration_s?: number;
  match_mode?: string;
  game_mode?: string;
  average_badge?: number;
  players?: Array<Record<string, unknown> & { account_id: number; hero_id: number; team?: string }>;
  [key: string]: unknown;
}

export interface ScoreboardPlayer {
  accountId: number;
  heroId: number;
  heroName: string;
  team: number;
  won: boolean;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  netWorth: number;
  lastHits: number;
  denies: number;
  level: number;
  /** Final damage dealt to players, from the last stat snapshot. */
  playerDamage?: number;
  /** Item names bought (and still held at the end), in purchase order. */
  finalItems: string[];
  abandoned: boolean;
}

export interface Scoreboard {
  matchId: number;
  startedAt: Date;
  durationS: number;
  winningTeam: number;
  gameMode: number;
  matchMode: number;
  teams: [ScoreboardPlayer[], ScoreboardPlayer[]];
}

export class MatchesResource {
  constructor(private readonly client: DeadlockClient) {}

  /** Full metadata of a finished match. Finished matches never change and are cached for a day. */
  get(matchId: number, options: CallOptions = {}): Promise<MatchMetadata> {
    // The spec types this response as a bare object, see match-types.ts.
    return this.client.api.get('/v1/matches/{match_id}/metadata', {
      ...options,
      path: { match_id: matchId },
    }) as unknown as Promise<MatchMetadata>;
  }

  /**
   * Metadata for many matches in one go. More than 1000 ids are split into
   * several requests. Choose the parts you need with `include_*` flags.
   */
  async getMany(
    matchIds: readonly number[],
    query: BulkQuery = {},
    options: CallOptions = {}
  ): Promise<BulkMatch[]> {
    const ids = [...new Set(matchIds)];
    const batches: BulkMatch[][] = [];
    for (let i = 0; i < ids.length; i += 1000) {
      const match_ids = ids.slice(i, i + 1000);
      batches.push(
        (await this.client.api.get('/v1/matches/metadata', {
          ...options,
          query: { include_info: true, ...query, match_ids, limit: match_ids.length },
        })) as unknown as BulkMatch[]
      );
    }
    return batches.flat();
  }

  /** Matches being played right now (top ranked games), optionally containing given players. */
  active(
    options: CallOptions & { players?: readonly PlayerInput[] } = {}
  ): Promise<Schemas['ActiveMatch'][]> {
    const ids = options.players?.map(toAccountId);
    return this.client.api.get('/v1/matches/active', {
      ...options,
      query:
        ids?.length === 1 ? { account_id: ids[0] } : ids?.length ? { account_ids: ids } : undefined,
    });
  }

  /**
   * A ready-to-render scoreboard: both teams with hero names, KDA, net worth,
   * damage and final item names. Combines match metadata with cached assets.
   */
  async scoreboard(matchId: number, options: CallOptions = {}): Promise<Scoreboard> {
    const [meta, heroes, items] = await Promise.all([
      this.get(matchId, options),
      this.client.heroes.list({ onlyActive: false }, options),
      this.client.items.list({}, options),
    ]);
    const info = meta.match_info;
    const heroNames = new Map(heroes.map((h) => [h.id, h.name]));
    const itemNames = new Map(items.map((i) => [i.id, i.name ?? i.class_name]));
    const upgradeIds = new Set(items.filter((i) => i.type === 'upgrade').map((i) => i.id));

    const toRow = (p: MatchPlayer): ScoreboardPlayer => {
      const last = p.stats?.[p.stats.length - 1];
      return {
        accountId: p.account_id,
        heroId: p.hero_id,
        heroName: heroNames.get(p.hero_id) ?? `Hero ${p.hero_id}`,
        team: p.team,
        won: p.team === info.winning_team,
        kills: p.kills,
        deaths: p.deaths,
        assists: p.assists,
        kda: round(kda(p.kills, p.deaths, p.assists)),
        netWorth: p.net_worth,
        lastHits: p.last_hits,
        denies: p.denies,
        level: p.level,
        playerDamage: typeof last?.player_damage === 'number' ? last.player_damage : undefined,
        finalItems: (p.items ?? [])
          .filter((it) => upgradeIds.has(it.item_id) && !it.sold_time_s)
          .map((it) => itemNames.get(it.item_id) ?? String(it.item_id)),
        abandoned: (p.abandon_match_time_s ?? 0) > 0,
      };
    };

    const rows = info.players.map(toRow).sort((a, b) => b.netWorth - a.netWorth);
    return {
      matchId: info.match_id,
      startedAt: new Date(info.start_time * 1000),
      durationS: info.duration_s,
      winningTeam: info.winning_team,
      gameMode: info.game_mode,
      matchMode: info.match_mode,
      teams: [rows.filter((r) => r.team === 0), rows.filter((r) => r.team === 1)],
    };
  }
}
