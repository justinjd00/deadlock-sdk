import type { DeadlockClient } from '../client';
import { DeadlockError, isDeadlockError } from '../core/errors';
import type { CallOptions, Operation, QueryParams, Schemas } from '../core/typed';
import { summarizeHistory, type HistorySummary, type MatchHistoryEntry } from '../helpers/history';
import { decodeBadge, type DecodedBadge } from '../helpers/ranks';
import { chunk } from '../helpers/stats';
import { toAccountId, toSteamId64, type PlayerInput } from '../helpers/steamid';

type HeroStatsQuery = Omit<QueryParams<Operation<'/v1/players/hero-stats', 'get'>>, 'account_ids'>;
type EnemyQuery = QueryParams<Operation<'/v1/players/{account_id}/enemy-stats', 'get'>>;
type MateQuery = QueryParams<Operation<'/v1/players/{account_id}/mate-stats', 'get'>>;

export interface PlayerRank extends DecodedBadge {
  accountId: number;
  /** Raw API response. */
  raw: Schemas['RankResponse'];
}

export interface MatchHistoryOptions extends CallOptions {
  /** Newest N matches only. */
  limit?: number;
  /** Only matches that started at or after this time. */
  since?: Date | number;
  /** Restrict to these match modes, e.g. `[4]` for ranked. */
  matchModes?: number[];
  /** Restrict to one hero. */
  heroId?: number;
  /**
   * Ask the API to refetch from Steam. Strictly rate limited (1 per hour per
   * IP), only use it when the stored history is clearly outdated.
   */
  forceRefetch?: boolean;
}

export interface PlayerSummary {
  accountId: number;
  steamId64: string;
  profile?: Schemas['SteamProfile'];
  /** `undefined` when the player has no ranked data or it is private. */
  rank?: PlayerRank;
  /** Aggregates over the most recent matches. */
  recent: HistorySummary;
  /** Most played heroes in the window, with names. */
  topHeroes: Array<HistorySummary['heroes'][number] & { name: string }>;
}

const BATCH = 1000;

export class PlayersResource {
  constructor(private readonly client: DeadlockClient) {}

  /** Converts any Steam id format or profile URL to the account id the API uses. */
  resolve(input: PlayerInput): number {
    return toAccountId(input);
  }

  /** Current rank, decoded to tier, subrank, name and icon. */
  async rank(player: PlayerInput, options: CallOptions = {}): Promise<PlayerRank> {
    const accountId = toAccountId(player);
    const [raw, ranks] = await Promise.all([
      this.client.api.get('/v1/players/{account_id}/rank', {
        ...options,
        path: { account_id: accountId },
      }),
      this.client.ranks.list({}, options).catch(() => undefined),
    ]);
    return { ...decodeBadge(raw.badge ?? 0, ranks), accountId, raw };
  }

  /** Ranks for many players at once. Batches of 1000 are split for you. */
  async ranks(
    players: readonly PlayerInput[],
    options: CallOptions = {}
  ): Promise<Array<Schemas['AccountRank'] & DecodedBadge>> {
    const ids = unique(players.map(toAccountId));
    const [batches, ranks] = await Promise.all([
      Promise.all(
        chunk(ids, BATCH).map((account_ids) =>
          this.client.api.get('/v1/players/rank', { ...options, query: { account_ids } })
        )
      ),
      this.client.ranks.list({}, options).catch(() => undefined),
    ]);
    return batches.flat().map((r) => ({ ...r, ...decodeBadge(r.badge ?? 0, ranks) }));
  }

  /** Match history, newest first, with optional local filters. */
  async matchHistory(
    player: PlayerInput,
    options: MatchHistoryOptions = {}
  ): Promise<MatchHistoryEntry[]> {
    const accountId = toAccountId(player);
    const all = await this.client.api.get('/v1/players/{account_id}/match-history', {
      ...options,
      path: { account_id: accountId },
      query: options.forceRefetch ? { force_refetch: true } : undefined,
    });
    const since = toUnixSeconds(options.since);
    const filtered = all
      .filter((m) => since === undefined || m.start_time >= since)
      .filter((m) => !options.matchModes || options.matchModes.includes(m.match_mode))
      .filter((m) => options.heroId === undefined || m.hero_id === options.heroId)
      .sort((a, b) => b.start_time - a.start_time);
    return options.limit !== undefined ? filtered.slice(0, options.limit) : filtered;
  }

  /**
   * Everything a profile card needs in one call: Steam profile, rank, recent
   * form (win rate, KDA, streak) and most played heroes with names.
   * Requests run in parallel, missing parts (private rank, no profile) are skipped.
   */
  async summary(
    player: PlayerInput,
    options: CallOptions & { matches?: number } = {}
  ): Promise<PlayerSummary> {
    const accountId = toAccountId(player);
    const optional = <T>(p: Promise<T>) =>
      p.catch((e: unknown) => {
        if (isDeadlockError(e) && ['FORBIDDEN', 'NOT_FOUND', 'BAD_REQUEST'].includes(e.code))
          return undefined;
        throw e;
      });
    const [history, rank, profiles, heroes] = await Promise.all([
      this.matchHistory(accountId, { ...options, limit: options.matches ?? 50 }),
      optional(this.rank(accountId, options)),
      optional(this.profiles([accountId], options)),
      this.client.heroes.list({ onlyActive: false }, options).catch(() => []),
    ]);
    const recent = summarizeHistory(history);
    const names = new Map(heroes.map((h) => [h.id, h.name]));
    return {
      accountId,
      steamId64: toSteamId64(accountId),
      profile: profiles?.[0],
      rank: rank && rank.badge > 0 ? rank : undefined,
      recent,
      topHeroes: recent.heroes
        .slice(0, 5)
        .map((h) => ({ ...h, name: names.get(h.heroId) ?? `Hero ${h.heroId}` })),
    };
  }

  /** Per-hero stats for one or more players. */
  async heroStats(
    players: PlayerInput | readonly PlayerInput[],
    query: HeroStatsQuery = {},
    options: CallOptions = {}
  ) {
    const ids = unique((Array.isArray(players) ? players : [players]).map(toAccountId));
    const batches = await Promise.all(
      chunk(ids, BATCH).map((account_ids) =>
        this.client.api.get('/v1/players/hero-stats', {
          ...options,
          query: { ...query, account_ids } as never,
        })
      )
    );
    return batches.flat();
  }

  /** Steam profiles (name, avatar, matches last 30 days) in batches. */
  async profiles(
    players: readonly PlayerInput[],
    options: CallOptions & { refresh?: boolean } = {}
  ) {
    const ids = unique(players.map(toAccountId));
    const batches = await Promise.all(
      chunk(ids, BATCH).map((account_ids) =>
        this.client.api.get('/v1/players/steam', {
          ...options,
          query: { account_ids, refresh: options.refresh },
        })
      )
    );
    return batches.flat();
  }

  /** Finds players by Steam name. Ranked by activity by default. */
  search(name: string, options: CallOptions & { limit?: number } = {}) {
    if (!name.trim()) {
      return Promise.reject(
        new DeadlockError('Search query must not be empty', { code: 'INVALID_INPUT', url: '' })
      );
    }
    return this.client.api.get('/v1/players/steam-search', {
      ...options,
      query: { search_query: name.trim(), limit: options.limit },
    });
  }

  /** How the player does against each opponent they met. */
  enemyStats(player: PlayerInput, query: Omit<EnemyQuery, never> = {}, options: CallOptions = {}) {
    return this.client.api.get('/v1/players/{account_id}/enemy-stats', {
      ...options,
      path: { account_id: toAccountId(player) },
      query,
    });
  }

  /** How the player does with each teammate. */
  mateStats(player: PlayerInput, query: Omit<MateQuery, never> = {}, options: CallOptions = {}) {
    return this.client.api.get('/v1/players/{account_id}/mate-stats', {
      ...options,
      path: { account_id: toAccountId(player) },
      query,
    });
  }

  /** Rank badge as an image (PNG by default), e.g. for overlays. */
  rankImage(
    player: PlayerInput,
    options: CallOptions & { format?: 'png' | 'webp' } = {}
  ): Promise<ArrayBuffer> {
    return this.client.api.getRaw('/v1/players/{account_id}/rank/image', 'arrayBuffer', {
      ...options,
      path: { account_id: toAccountId(player) },
      query: options.format ? ({ format: options.format } as never) : undefined,
    }) as Promise<ArrayBuffer>;
  }
}

function unique(ids: number[]): number[] {
  return [...new Set(ids)];
}

/** Dates and epoch milliseconds become Unix seconds, small numbers are taken as seconds already. */
export function toUnixSeconds(value: Date | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
}
