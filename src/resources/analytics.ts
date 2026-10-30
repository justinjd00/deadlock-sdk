import type { DeadlockClient } from '../client';
import type {
  ArgsTuple,
  CallOptions,
  Operation,
  PathsFor,
  QueryParams,
  ResponseData,
} from '../core/typed';

type AnalyticsPath = Extract<PathsFor<'get'>, `/v1/analytics/${string}`>;

/** Analytics endpoints without path parameters, by their short name. */
export type AnalyticsName = AnalyticsPath extends `/v1/analytics/${infer N}`
  ? N extends `${string}{${string}` // skip templated paths
    ? never
    : N
  : never;

type PathOf<N extends AnalyticsName> = `/v1/analytics/${N}` & AnalyticsPath;

/**
 * All 20+ analytics endpoints with full typing, by short name:
 *
 * ```ts
 * await dl.analytics.get('hero-stats', { query: { min_average_badge: 100 } });
 * await dl.analytics.get('item-permutation-stats', { query: { hero_id: 7, comb_size: 2 } });
 * ```
 *
 * For hero names, win rates and tier lists use `dl.heroes.stats()` and friends.
 */
export class AnalyticsResource {
  constructor(private readonly client: DeadlockClient) {}

  get<N extends AnalyticsName>(
    name: N,
    ...args: ArgsTuple<Operation<PathOf<N>, 'get'>>
  ): Promise<ResponseData<Operation<PathOf<N>, 'get'>>> {
    const get = this.client.api.get as (path: string, ...rest: unknown[]) => Promise<unknown>;
    return get(`/v1/analytics/${name}`, ...args) as Promise<
      ResponseData<Operation<PathOf<N>, 'get'>>
    >;
  }

  /** Build-level stats for one hero. */
  heroBuildStats(
    heroId: number,
    query: QueryParams<Operation<'/v1/analytics/hero-build-stats/{hero_id}', 'get'>> = {},
    options: CallOptions = {}
  ) {
    return this.client.api.get('/v1/analytics/hero-build-stats/{hero_id}', {
      ...options,
      path: { hero_id: heroId },
      query,
    });
  }
}
