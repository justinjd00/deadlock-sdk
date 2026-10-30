import type { DeadlockClient } from '../client';
import { DeadlockError } from '../core/errors';
import type { CallOptions, Operation, QueryParams, Schemas } from '../core/typed';
import { normalizeRegion, type LeaderboardRegion } from '../helpers/modes';
import { normalizeText } from '../helpers/search';
import { toAccountId, type PlayerInput } from '../helpers/steamid';

export interface LeaderboardRow {
  rank: number;
  name: string;
  /** Leaderboards are keyed by name, so more than one account can match. */
  accountIds: number[];
  topHeroIds: number[];
  topHeroes: string[];
  raw: Schemas['LeaderboardEntry'];
}

export class LeaderboardResource {
  constructor(private readonly client: DeadlockClient) {}

  /**
   * Leaderboard for a region (`"eu"`, `"na"`, `"Europe"`, ...), optionally per
   * hero, with hero names resolved.
   */
  async get(
    region: LeaderboardRegion | string,
    options: CallOptions & { hero?: number | string; leaderboardId?: number; limit?: number } = {}
  ): Promise<LeaderboardRow[]> {
    const r = normalizeRegion(region) as LeaderboardRegion;
    const query =
      options.leaderboardId !== undefined ? { leaderboard_id: options.leaderboardId } : undefined;
    const [board, heroes] = await Promise.all([
      options.hero === undefined
        ? this.client.api.get('/v1/leaderboard/{region}', {
            ...options,
            path: { region: r },
            query,
          })
        : this.client.heroes.require(options.hero, options).then((h) =>
            this.client.api.get('/v1/leaderboard/{region}/{hero_id}', {
              ...options,
              path: { region: r, hero_id: h.id },
              query,
            })
          ),
      this.client.heroes.list({ onlyActive: false }, options),
    ]);
    const names = new Map(heroes.map((h) => [h.id, h.name]));
    const rows = board.entries.map((e) => ({
      rank: e.rank ?? 0,
      name: e.account_name ?? '',
      accountIds: e.possible_account_ids ?? [],
      topHeroIds: e.top_hero_ids ?? [],
      topHeroes: (e.top_hero_ids ?? []).map((id) => names.get(id) ?? `Hero ${id}`),
      raw: e,
    }));
    return options.limit !== undefined ? rows.slice(0, options.limit) : rows;
  }

  /** Finds a player on a leaderboard by name or account id. */
  async find(
    player: string | number,
    region: LeaderboardRegion | string,
    options: CallOptions & { hero?: number | string } = {}
  ): Promise<LeaderboardRow | undefined> {
    const rows = await this.get(region, options);
    const asId =
      typeof player === 'number' ? player : /^\d+$/.test(player) ? Number(player) : undefined;
    return rows.find(
      (row) =>
        (asId !== undefined && row.accountIds.includes(asId)) ||
        (typeof player === 'string' && normalizeText(row.name) === normalizeText(player))
    );
  }
}

type BuildSearchQuery = QueryParams<Operation<'/v1/builds', 'get'>>;

export class BuildsResource {
  constructor(private readonly client: DeadlockClient) {}

  /** Searches community builds. Sorting, hero, tag, language and text filters are supported. */
  search(query: BuildSearchQuery = {}, options: CallOptions = {}): Promise<Schemas['Build'][]> {
    return this.client.api.get('/v1/builds', { ...options, query });
  }

  /** Most favorited current builds for a hero. */
  async forHero(
    hero: number | string,
    options: CallOptions & { limit?: number; sortBy?: BuildSearchQuery['sort_by'] } = {}
  ): Promise<Schemas['Build'][]> {
    const h = await this.client.heroes.require(hero, options);
    return this.search(
      {
        hero_id: h.id,
        only_latest: true,
        sort_by: options.sortBy ?? 'weekly_favorites',
        limit: options.limit ?? 10,
      },
      options
    );
  }

  /** All builds published by a player. */
  byAuthor(player: PlayerInput, options: CallOptions = {}) {
    return this.client.api.get('/v1/builds/by-author/{account_id}', {
      ...options,
      path: { account_id: toAccountId(player) },
    });
  }

  /** One build, live from the game. */
  get(heroId: number, buildId: number, options: CallOptions = {}) {
    return this.client.api.get('/v1/builds/{hero_id}/{build_id}', {
      ...options,
      path: { hero_id: heroId, build_id: buildId },
    });
  }
}

export interface PatchNote {
  title: string;
  url: string;
  publishedAt: Date;
  /** HTML body of the patch notes. */
  html: string;
  raw: Schemas['Patch'];
}

export class PatchesResource {
  constructor(private readonly client: DeadlockClient) {}

  /** Patch notes, newest first. */
  async list(options: CallOptions = {}): Promise<PatchNote[]> {
    const patches = await this.client.api.get('/v1/patches', options);
    return patches
      .map((p) => ({
        title: p.title,
        url: p.link,
        publishedAt: new Date(p.pub_date),
        html: p.content_encoded ?? '',
        raw: p,
      }))
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
  }

  /** The newest patch. */
  async latest(options: CallOptions = {}): Promise<PatchNote | undefined> {
    return (await this.list(options))[0];
  }
}

export interface SqlColumn {
  name: string;
  type: string;
  comment?: string;
}

export class SqlResource {
  constructor(private readonly client: DeadlockClient) {}

  /**
   * Runs a read-only SQL query (DuckDB syntax) on the public dataset and
   * returns the rows. Great for analyses the REST endpoints do not cover.
   *
   * ```ts
   * await dl.sql.query<{ hero_id: number; n: number }>(
   *   'SELECT hero_id, count(*) AS n FROM match_player GROUP BY 1 ORDER BY n DESC LIMIT 5'
   * );
   * ```
   *
   * Analytical queries can take a while, so the timeout defaults to 120s.
   */
  async query<Row = Record<string, unknown>>(
    sql: string,
    options: CallOptions = {}
  ): Promise<Row[]> {
    if (!sql.trim())
      throw new DeadlockError('SQL query must not be empty', { code: 'INVALID_INPUT', url: '' });
    const text = (await this.client.api.getRaw('/v1/sql', 'text', {
      timeout: 120_000,
      ...options,
      query: { query: sql, format: 'json' } as never,
    })) as string;
    try {
      const parsed = JSON.parse(text) as unknown;
      return (Array.isArray(parsed) ? parsed : [parsed]) as Row[];
    } catch (cause) {
      throw new DeadlockError('SQL endpoint did not return JSON', {
        code: 'INVALID_RESPONSE',
        url: '/v1/sql',
        body: text.slice(0, 500),
        cause,
      });
    }
  }

  /** Available tables. */
  tables(options: CallOptions = {}) {
    return this.client.api.get('/v1/sql/tables', options);
  }

  /** Columns of a table. The spec types this as a map, the API returns a list. */
  async schema(table: string, options: CallOptions = {}): Promise<SqlColumn[]> {
    const raw = (await this.client.api.get('/v1/sql/tables/{table}/schema', {
      ...options,
      path: { table },
    })) as unknown;
    if (Array.isArray(raw)) return raw as SqlColumn[];
    return Object.entries(raw as Record<string, string>).map(([name, type]) => ({ name, type }));
  }
}
