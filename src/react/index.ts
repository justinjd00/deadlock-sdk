import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { DeadlockClient, type DeadlockClientOptions } from '../client';
import type { CallOptions, Operation, QueryParams, Schemas } from '../core/typed';
import type { MatchHistoryEntry } from '../helpers/history';
import type { PlayerInput } from '../helpers/steamid';
import type { Hero, HeroStat, TierListEntry } from '../resources/assets';
import type { Scoreboard } from '../resources/matches';
import type { LeaderboardRow } from '../resources/meta';
import type { MatchHistoryOptions, PlayerRank, PlayerSummary } from '../resources/players';

const ClientContext = createContext<DeadlockClient | null>(null);
let sharedClient: DeadlockClient | undefined;

export interface DeadlockProviderProps {
  /** Use an existing client, or let the provider create one from `options`. */
  client?: DeadlockClient;
  options?: DeadlockClientOptions;
  children?: ReactNode;
}

/** Shares one client (one cache, one rate limit tracker) across the tree. */
export function DeadlockProvider({ client, options, children }: DeadlockProviderProps) {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const value = useMemo(() => client ?? new DeadlockClient(options), [client]);
  return createElement(ClientContext.Provider, { value }, children);
}

/** The client from the nearest provider, or a shared default client. */
export function useDeadlockClient(): DeadlockClient {
  const fromContext = useContext(ClientContext);
  if (fromContext) return fromContext;
  sharedClient ??= new DeadlockClient();
  return sharedClient;
}

export interface QueryState<T> {
  data: T | undefined;
  error: Error | undefined;
  loading: boolean;
  /** Fetch again, bypassing the cache. */
  refetch: () => void;
}

export interface QueryOptions {
  /** `false` holds off fetching, e.g. until an input is valid. */
  enabled?: boolean;
  /** Re-fetch every N ms (live data). */
  refetchInterval?: number;
}

/**
 * Generic data hook. `key` decides when to re-run, pass every input the
 * fetcher uses. Responses for outdated keys are dropped and in-flight
 * requests are aborted on unmount.
 */
export function useDeadlockQuery<T>(
  key: unknown,
  fetcher: (client: DeadlockClient, options: CallOptions) => Promise<T>,
  options: QueryOptions = {}
): QueryState<T> {
  const client = useDeadlockClient();
  const enabled = options.enabled !== false;
  const keyString = JSON.stringify(key);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const [state, setState] = useState<{ data?: T; error?: Error; loading: boolean }>({
    loading: enabled,
  });
  const [tick, setTick] = useState(0);
  const freshRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setState((s) => ({ ...s, loading: false }));
      return;
    }
    const controller = new AbortController();
    const fresh = freshRef.current;
    freshRef.current = false;
    setState((s) => ({ ...s, loading: true, error: undefined }));
    fetcherRef
      .current(client, { signal: controller.signal, fresh })
      .then((data) => {
        if (!controller.signal.aborted) setState({ data, loading: false });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setState((s) => ({
            ...s,
            loading: false,
            error: error instanceof Error ? error : new Error(String(error)),
          }));
        }
      });
    return () => controller.abort();
  }, [client, keyString, enabled, tick]);

  useEffect(() => {
    if (!enabled || !options.refetchInterval) return;
    const id = setInterval(() => {
      freshRef.current = true;
      setTick((t) => t + 1);
    }, options.refetchInterval);
    return () => clearInterval(id);
  }, [enabled, options.refetchInterval]);

  const refetch = useCallback(() => {
    freshRef.current = true;
    setTick((t) => t + 1);
  }, []);

  return { data: state.data, error: state.error, loading: state.loading, refetch };
}

const valid = (player: PlayerInput | undefined | null): player is PlayerInput =>
  player !== undefined && player !== null && player !== '';

/** Profile, rank, recent form and top heroes in one hook. */
export function usePlayerSummary(
  player: PlayerInput | undefined,
  options: QueryOptions & { matches?: number } = {}
) {
  return useDeadlockQuery<PlayerSummary>(
    ['summary', String(player), options.matches],
    (c, o) => c.players.summary(player!, { ...o, matches: options.matches }),
    { ...options, enabled: valid(player) && options.enabled !== false }
  );
}

export function usePlayerRank(player: PlayerInput | undefined, options: QueryOptions = {}) {
  return useDeadlockQuery<PlayerRank>(
    ['rank', String(player)],
    (c, o) => c.players.rank(player!, o),
    {
      ...options,
      enabled: valid(player) && options.enabled !== false,
    }
  );
}

export function useMatchHistory(
  player: PlayerInput | undefined,
  filter: Omit<MatchHistoryOptions, keyof CallOptions> = {},
  options: QueryOptions = {}
) {
  return useDeadlockQuery<MatchHistoryEntry[]>(
    ['history', String(player), filter],
    (c, o) => c.players.matchHistory(player!, { ...o, ...filter }),
    { ...options, enabled: valid(player) && options.enabled !== false }
  );
}

export function useScoreboard(matchId: number | undefined, options: QueryOptions = {}) {
  return useDeadlockQuery<Scoreboard>(
    ['scoreboard', matchId],
    (c, o) => c.matches.scoreboard(matchId!, o),
    {
      ...options,
      enabled: matchId !== undefined && options.enabled !== false,
    }
  );
}

/** Live top matches, refreshed every 30s by default. */
export function useActiveMatches(options: QueryOptions & { players?: PlayerInput[] } = {}) {
  return useDeadlockQuery<Schemas['ActiveMatch'][]>(
    ['active', options.players?.map(String)],
    (c, o) => c.matches.active({ ...o, players: options.players }),
    { refetchInterval: 30_000, ...options }
  );
}

export function useHeroes(options: QueryOptions & { onlyActive?: boolean } = {}) {
  return useDeadlockQuery<Hero[]>(
    ['heroes', options.onlyActive],
    (c, o) => c.heroes.list({ onlyActive: options.onlyActive }, o),
    options
  );
}

type HeroStatsQuery = QueryParams<Operation<'/v1/analytics/hero-stats', 'get'>>;

export function useHeroStats(query: HeroStatsQuery = {}, options: QueryOptions = {}) {
  return useDeadlockQuery<HeroStat[]>(
    ['hero-stats', query],
    (c, o) => c.heroes.stats(query, o),
    options
  );
}

export function useTierList(
  query: HeroStatsQuery = {},
  options: QueryOptions & { minMatches?: number } = {}
) {
  return useDeadlockQuery<TierListEntry[]>(
    ['tiers', query, options.minMatches],
    (c, o) => c.heroes.tierList(query, { ...o, minMatches: options.minMatches }),
    options
  );
}

export function useLeaderboard(
  region: string,
  options: QueryOptions & { hero?: number | string; limit?: number } = {}
) {
  return useDeadlockQuery<LeaderboardRow[]>(
    ['leaderboard', region, options.hero, options.limit],
    (c, o) => c.leaderboard.get(region, { ...o, hero: options.hero, limit: options.limit }),
    options
  );
}

/** Debounced Steam name search, for player pickers. */
export function usePlayerSearch(
  name: string,
  options: QueryOptions & { debounceMs?: number; limit?: number } = {}
) {
  const [debounced, setDebounced] = useState(name);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(name), options.debounceMs ?? 250);
    return () => clearTimeout(id);
  }, [name, options.debounceMs]);
  return useDeadlockQuery<Schemas['SteamProfile'][]>(
    ['player-search', debounced, options.limit],
    (c, o) => c.players.search(debounced, { ...o, limit: options.limit }),
    { ...options, enabled: debounced.trim().length >= 2 && options.enabled !== false }
  );
}
