export interface CacheEntry<T = unknown> {
  value: T;
  /** Epoch ms when the value was stored. */
  storedAt: number;
  /** Epoch ms after which the value is stale. */
  expiresAt: number;
}

/**
 * Anything that can hold cache entries. Methods may be sync or async, so
 * Redis, IndexedDB, localStorage or files plug in without adapters.
 */
export interface CacheStore {
  get(key: string): CacheEntry | undefined | Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): void | Promise<void>;
  delete(key: string): void | Promise<void>;
  clear(): void | Promise<void>;
}

/** In-memory LRU store. The default. */
export class MemoryCache implements CacheStore {
  private readonly map = new Map<string, CacheEntry>();

  constructor(private readonly maxEntries = 300) {}

  get(key: string): CacheEntry | undefined {
    const entry = this.map.get(key);
    if (entry) {
      this.map.delete(key);
      this.map.set(key, entry);
    }
    return entry;
  }

  set(key: string, entry: CacheEntry): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** Groups of endpoints that change at different speeds. */
export type CacheResource =
  | 'assets'
  | 'analytics'
  | 'players'
  | 'matches'
  | 'live'
  | 'leaderboard'
  | 'builds'
  | 'patches'
  | 'other';

/**
 * Defaults follow the API's own `Cache-Control` headers: game assets change
 * with patches, finished matches never change, live data moves constantly.
 */
export const DEFAULT_TTL: Readonly<Record<CacheResource, number>> = {
  assets: 60 * 60_000,
  analytics: 30 * 60_000,
  players: 2 * 60_000,
  matches: 24 * 60 * 60_000,
  live: 20_000,
  leaderboard: 10 * 60_000,
  builds: 15 * 60_000,
  patches: 60 * 60_000,
  other: 5 * 60_000,
};

/** Maps an API path to its cache group. */
export function cacheResourceFor(path: string): CacheResource {
  if (path.startsWith('/v1/assets')) return 'assets';
  if (path.startsWith('/v1/analytics')) return 'analytics';
  if (path.startsWith('/v1/matches/active') || path.includes('/live')) return 'live';
  if (path.startsWith('/v1/matches')) return 'matches';
  if (path.startsWith('/v1/players')) return 'players';
  if (path.startsWith('/v1/leaderboard')) return 'leaderboard';
  if (path.startsWith('/v1/builds')) return 'builds';
  if (/^\/v\d\/patches/.test(path)) return 'patches';
  return 'other';
}

export interface CacheOptions {
  /** Custom store. Defaults to an in-memory LRU. */
  store?: CacheStore;
  /** Max entries for the default in-memory store. */
  maxEntries?: number;
  /** One TTL for everything, or per resource group. In ms. */
  ttl?: number | Partial<Record<CacheResource, number>>;
  /** Serve expired entries for this long while refreshing in the background. In ms, default 0. */
  staleWhileRevalidate?: number;
}

export function resolveTtl(options: CacheOptions | undefined, resource: CacheResource): number {
  const ttl = options?.ttl;
  if (typeof ttl === 'number') return ttl;
  return ttl?.[resource] ?? DEFAULT_TTL[resource];
}
