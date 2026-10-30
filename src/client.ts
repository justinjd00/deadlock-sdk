import {
  cacheResourceFor,
  MemoryCache,
  resolveTtl,
  type CacheOptions,
  type CacheStore,
} from './core/cache';
import { HttpClient, type HttpClientOptions, type ParseAs, type Query } from './core/http';
import {
  fillPath,
  type ArgsTuple,
  type Language,
  type CallOptions,
  type Operation,
  type PathsFor,
  type ResponseData,
} from './core/typed';
import {
  createSearchIndex,
  type SearchHit,
  type SearchIndex,
  type SearchOptions,
} from './helpers/search';
import { AnalyticsResource } from './resources/analytics';
import { HeroesResource, ItemsResource, RanksResource } from './resources/assets';
import { MatchesResource } from './resources/matches';
import {
  BuildsResource,
  LeaderboardResource,
  PatchesResource,
  SqlResource,
} from './resources/meta';
import { PlayersResource } from './resources/players';
import type { Schemas } from './core/typed';

export interface DeadlockClientOptions extends HttpClientOptions {
  /** Cache settings, or `false` to disable caching. On by default. */
  cache?: CacheOptions | false;
  /** Default language for asset names, e.g. `"german"`. API default is English. */
  language?: Language;
}

/** Credit line for UIs. The Deadlock API asks nothing formal, but credit keeps it alive. */
export const ATTRIBUTION = {
  text: 'Data from the Deadlock API',
  url: 'https://deadlock-api.com',
  html: 'Data from the <a href="https://deadlock-api.com">Deadlock API</a>',
} as const;

type GetPath = PathsFor<'get'>;
type PostPath = PathsFor<'post'>;
type PutPath = PathsFor<'put'>;
type DeletePath = PathsFor<'delete'>;

/** A request option bag with optional raw parsing, for image and protobuf endpoints. */
export type RawOptions = { parseAs?: ParseAs };

/**
 * Typed access to every endpoint of the Deadlock API, generated from its
 * OpenAPI spec. Paths autocomplete, parameters are checked, responses typed.
 */
export interface TypedApi {
  get<P extends GetPath>(
    path: P,
    ...args: ArgsTuple<Operation<P, 'get'>>
  ): Promise<ResponseData<Operation<P, 'get'>>>;
  /** Like `get`, but returns the raw body (for images, protobuf, text). */
  getRaw<P extends GetPath>(
    path: P,
    parseAs: 'text' | 'arrayBuffer',
    ...args: ArgsTuple<Operation<P, 'get'>>
  ): Promise<string | ArrayBuffer>;
  post<P extends PostPath>(
    path: P,
    ...args: ArgsTuple<Operation<P, 'post'>>
  ): Promise<ResponseData<Operation<P, 'post'>>>;
  put<P extends PutPath>(
    path: P,
    ...args: ArgsTuple<Operation<P, 'put'>>
  ): Promise<ResponseData<Operation<P, 'put'>>>;
  delete<P extends DeletePath>(
    path: P,
    ...args: ArgsTuple<Operation<P, 'delete'>>
  ): Promise<ResponseData<Operation<P, 'delete'>>>;
}

interface LooseArgs extends CallOptions {
  path?: Record<string, unknown>;
  query?: Query;
  body?: unknown;
}

export class DeadlockClient {
  readonly http: HttpClient;
  /** Every endpoint, fully typed. Use it for anything the resources below do not cover. */
  readonly api: TypedApi;

  readonly players: PlayersResource;
  readonly matches: MatchesResource;
  readonly heroes: HeroesResource;
  readonly items: ItemsResource;
  readonly ranks: RanksResource;
  readonly leaderboard: LeaderboardResource;
  readonly builds: BuildsResource;
  readonly patches: PatchesResource;
  readonly analytics: AnalyticsResource;
  readonly sql: SqlResource;

  /** Default language for asset requests. */
  readonly language?: Language;

  private readonly cacheOptions: CacheOptions | false;
  private readonly store: CacheStore | undefined;
  private readonly revalidating = new Set<string>();
  private searchIndexPromise?: Promise<SearchIndex<SearchEntity>>;

  constructor(options: DeadlockClientOptions = {}) {
    const { cache, language, ...http } = options;
    this.http = new HttpClient(http);
    this.language = language;
    this.cacheOptions = cache ?? {};
    this.store = cache === false ? undefined : (cache?.store ?? new MemoryCache(cache?.maxEntries));

    const call = async (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      template: string,
      args: LooseArgs = {},
      parseAs?: ParseAs
    ) => {
      const path = fillPath(template, args.path);
      if (method === 'GET') return this.cachedGet(path, args.query, args, parseAs);
      return this.http.request(method, path, {
        query: args.query,
        body: args.body,
        signal: args.signal,
        timeout: args.timeout,
      });
    };
    this.api = {
      get: ((path: string, args?: LooseArgs) => call('GET', path, args)) as TypedApi['get'],
      getRaw: ((path: string, parseAs: ParseAs, args?: LooseArgs) =>
        call('GET', path, args, parseAs)) as TypedApi['getRaw'],
      post: ((path: string, args?: LooseArgs) => call('POST', path, args)) as TypedApi['post'],
      put: ((path: string, args?: LooseArgs) => call('PUT', path, args)) as TypedApi['put'],
      delete: ((path: string, args?: LooseArgs) =>
        call('DELETE', path, args)) as TypedApi['delete'],
    };

    this.players = new PlayersResource(this);
    this.matches = new MatchesResource(this);
    this.heroes = new HeroesResource(this);
    this.items = new ItemsResource(this);
    this.ranks = new RanksResource(this);
    this.leaderboard = new LeaderboardResource(this);
    this.builds = new BuildsResource(this);
    this.patches = new PatchesResource(this);
    this.analytics = new AnalyticsResource(this);
    this.sql = new SqlResource(this);
  }

  /** Drops every cached response and the search index. */
  async clearCache(): Promise<void> {
    this.searchIndexPromise = undefined;
    await this.store?.clear();
  }

  /**
   * @internal Cached GET with optional stale-while-revalidate. The cache key
   * is the full URL, so different filters never collide.
   */
  async cachedGet<T>(
    path: string,
    query: Query | undefined,
    options: CallOptions = {},
    parseAs?: ParseAs
  ): Promise<T> {
    const request = () =>
      this.http.get<T>(path, { query, signal: options.signal, timeout: options.timeout, parseAs });
    const store = this.store;
    // Binary bodies are not cached: they are large and rarely re-read.
    if (!store || this.cacheOptions === false || parseAs === 'arrayBuffer') return request();

    const key = `${parseAs ?? 'json'} ${this.http.buildUrl(path, query)}`;
    const ttl = resolveTtl(this.cacheOptions, cacheResourceFor(path));
    const swr = this.cacheOptions.staleWhileRevalidate ?? 0;
    const load = async () => {
      const value = await request();
      const now = Date.now();
      await store.set(key, { value, storedAt: now, expiresAt: now + ttl });
      return value;
    };

    if (!options.fresh) {
      const entry = await store.get(key);
      const now = Date.now();
      if (entry && now < entry.expiresAt) return entry.value as T;
      if (entry && swr > 0 && now < entry.expiresAt + swr) {
        if (!this.revalidating.has(key)) {
          this.revalidating.add(key);
          void load()
            .catch(() => undefined)
            .finally(() => this.revalidating.delete(key));
        }
        return entry.value as T;
      }
    }
    return load();
  }

  /** @internal Language query for asset endpoints. */
  langQuery(language?: Language): { language?: Language } {
    const lang = language ?? this.language;
    return lang ? { language: lang } : {};
  }

  /**
   * Typo tolerant search over heroes and items, done locally on cached
   * assets. `"hayz"` finds Haze, `"spirit snare"` finds the item.
   */
  async search(
    query: string,
    options: SearchOptions & CallOptions & { in?: Array<'heroes' | 'items'> } = {}
  ): Promise<SearchResult[]> {
    if (!this.searchIndexPromise || options.fresh) {
      const promise = (async () => {
        const [heroes, items] = await Promise.all([
          this.heroes.list({}, options),
          this.items.list({}, options),
        ]);
        return createSearchIndex<SearchEntity>([
          ...heroes.map((h) => ({
            id: String(h.id),
            name: h.name,
            keywords: [h.hero_type ?? '', 'hero'],
            value: { type: 'hero' as const, data: h },
          })),
          ...items
            .filter((i) => i.type === 'upgrade' && (i as { shopable?: boolean }).shopable !== false)
            .map((i) => ({
              id: String(i.id),
              name: i.name ?? i.class_name,
              keywords: ['item'],
              value: { type: 'item' as const, data: i },
            })),
        ]);
      })();
      promise.catch(() => {
        if (this.searchIndexPromise === promise) this.searchIndexPromise = undefined;
      });
      this.searchIndexPromise = promise;
    }
    const index = await this.searchIndexPromise;
    const scopes = new Set(options.in ?? ['heroes', 'items']);
    return index
      .search(query, { ...options, limit: (options.limit ?? 10) * 3 })
      .filter((hit) => scopes.has(hit.value.type === 'hero' ? 'heroes' : 'items'))
      .slice(0, options.limit ?? 10);
  }

  /** API health and version info. */
  info(options: CallOptions = {}) {
    return this.api.get('/v1/info', options);
  }
}

export type SearchEntity =
  { type: 'hero'; data: Schemas['Hero'] } | { type: 'item'; data: Schemas['Item'] };
export type SearchResult = SearchHit<SearchEntity>;

export function createDeadlockClient(options?: DeadlockClientOptions): DeadlockClient {
  return new DeadlockClient(options);
}
