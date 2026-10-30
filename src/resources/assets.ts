import type { DeadlockClient } from '../client';
import { DeadlockError } from '../core/errors';
import type { CallOptions, Language, Operation, QueryParams, Schemas } from '../core/typed';
import { decodeBadge, type DecodedBadge } from '../helpers/ranks';
import { normalizeText } from '../helpers/search';
import { kda, round, wilsonLowerBound, winRate } from '../helpers/stats';

export type Hero = Schemas['Hero'];
export type Item = Schemas['Item'];
export type UpgradeItem = Schemas['Upgrade'];
export type ItemSlot = Schemas['ItemSlotType'];

type HeroStatsQuery = QueryParams<Operation<'/v1/analytics/hero-stats', 'get'>>;
type CounterQuery = QueryParams<Operation<'/v1/analytics/hero-counter-stats', 'get'>>;
type SynergyQuery = QueryParams<Operation<'/v1/analytics/hero-synergy-stats', 'get'>>;
type ItemStatsQuery = QueryParams<Operation<'/v1/analytics/item-stats', 'get'>>;

export interface AssetOptions extends CallOptions {
  /** Asset language, e.g. `"german"`. Falls back to the client default. */
  language?: Language;
}

export interface HeroStat {
  heroId: number;
  name: string;
  matches: number;
  wins: number;
  winRate: number;
  /** Share of all matches that had this hero, 0..1. */
  pickRate: number;
  kda: number;
  avgNetWorth: number;
  avgPlayerDamage: number;
  /** Win rate lower bound at 95% confidence, used for ranking. */
  confidence: number;
  raw: Schemas['AnalyticsHeroStats'];
}

export type Tier = 'S' | 'A' | 'B' | 'C' | 'D';

export interface TierListEntry extends HeroStat {
  tier: Tier;
  /** 1 is best. */
  position: number;
}

export interface MatchupStat {
  heroId: number;
  name: string;
  matches: number;
  wins: number;
  /** From the perspective of the hero you asked about. */
  winRate: number;
  confidence: number;
}

const sameName = (a: string, b: string) => normalizeText(a) === normalizeText(b);

export class HeroesResource {
  constructor(private readonly client: DeadlockClient) {}

  /** All heroes. Only playable ones by default. */
  list(filter: { onlyActive?: boolean } = {}, options: AssetOptions = {}): Promise<Hero[]> {
    return this.client.api.get('/v1/assets/heroes', {
      ...options,
      query: { ...this.client.langQuery(options.language), only_active: filter.onlyActive ?? true },
    });
  }

  /** A hero by id, name (`"haze"`, `"Lady Geist"`) or class name (`"hero_haze"`). */
  async get(idOrName: number | string, options: AssetOptions = {}): Promise<Hero | undefined> {
    const heroes = await this.list({ onlyActive: false }, options);
    if (typeof idOrName === 'number' || /^\d+$/.test(idOrName)) {
      return heroes.find((h) => h.id === Number(idOrName));
    }
    return heroes.find(
      (h) =>
        sameName(h.name, idOrName) ||
        h.class_name === idOrName ||
        sameName(h.class_name.replace(/^hero_/, ''), idOrName)
    );
  }

  /** Like `get`, but throws `NOT_FOUND` instead of returning `undefined`. */
  async require(idOrName: number | string, options: AssetOptions = {}): Promise<Hero> {
    const hero = await this.get(idOrName, options);
    if (!hero) throw new DeadlockError(`No hero "${idOrName}"`, { code: 'NOT_FOUND', url: '' });
    return hero;
  }

  /**
   * Win rate, pick rate, KDA and more per hero, with names. Filters are the
   * API's own (`min_average_badge`, time range, game mode, ...).
   */
  async stats(query: HeroStatsQuery = {}, options: AssetOptions = {}): Promise<HeroStat[]> {
    const [rows, heroes] = await Promise.all([
      this.client.api.get('/v1/analytics/hero-stats', { ...options, query }),
      this.list({ onlyActive: false }, options),
    ]);
    const names = new Map(heroes.map((h) => [h.id, h.name]));
    // Every match has 12 heroes, so total matches = sum of hero matches / 12.
    const totalMatches = rows.reduce((s, r) => s + r.matches, 0) / 12;
    return rows
      .map((r) => ({
        heroId: r.hero_id,
        name: names.get(r.hero_id) ?? `Hero ${r.hero_id}`,
        matches: r.matches,
        wins: r.wins,
        winRate: round(winRate(r.wins, r.matches), 4),
        pickRate: round(totalMatches ? r.matches / totalMatches : 0, 4),
        kda: round(kda(r.total_kills, r.total_deaths, r.total_assists)),
        avgNetWorth: r.matches ? Math.round(r.total_net_worth / r.matches) : 0,
        avgPlayerDamage: r.matches ? Math.round(r.total_player_damage / r.matches) : 0,
        confidence: round(wilsonLowerBound(r.wins, r.matches), 4),
        raw: r,
      }))
      .sort((a, b) => b.matches - a.matches);
  }

  /**
   * A tier list that respects sample size: heroes are ranked by the lower
   * bound of their win rate confidence interval, then cut into S (top 10%),
   * A (next 20%), B (40%), C (20%) and D (bottom 10%).
   */
  async tierList(
    query: HeroStatsQuery = {},
    options: AssetOptions & { minMatches?: number } = {}
  ): Promise<TierListEntry[]> {
    const stats = (await this.stats(query, options)).filter(
      (s) => s.matches >= (options.minMatches ?? 100)
    );
    const ranked = stats.sort((a, b) => b.confidence - a.confidence || b.winRate - a.winRate);
    const n = ranked.length;
    const cut = (i: number): Tier => {
      const p = (i + 0.5) / n;
      return p <= 0.1 ? 'S' : p <= 0.3 ? 'A' : p <= 0.7 ? 'B' : p <= 0.9 ? 'C' : 'D';
    };
    return ranked.map((s, i) => ({ ...s, tier: cut(i), position: i + 1 }));
  }

  /** Who this hero beats and who beats it, best matchups first. */
  async counters(
    hero: number | string,
    query: CounterQuery = {},
    options: AssetOptions & { minMatches?: number } = {}
  ): Promise<MatchupStat[]> {
    const [target, heroes, rows] = await Promise.all([
      this.require(hero, options),
      this.list({ onlyActive: false }, options),
      this.client.api.get('/v1/analytics/hero-counter-stats', { ...options, query }),
    ]);
    const names = new Map(heroes.map((h) => [h.id, h.name]));
    return rows
      .filter((r) => r.hero_id === target.id && r.matches_played >= (options.minMatches ?? 50))
      .map((r) => ({
        heroId: r.enemy_hero_id,
        name: names.get(r.enemy_hero_id) ?? `Hero ${r.enemy_hero_id}`,
        matches: r.matches_played,
        wins: r.wins,
        winRate: round(winRate(r.wins, r.matches_played), 4),
        confidence: round(wilsonLowerBound(r.wins, r.matches_played), 4),
      }))
      .sort((a, b) => b.confidence - a.confidence);
  }

  /** Best teammates for this hero, by confidence-adjusted win rate together. */
  async synergies(
    hero: number | string,
    query: SynergyQuery = {},
    options: AssetOptions & { minMatches?: number } = {}
  ): Promise<MatchupStat[]> {
    const [target, heroes, rows] = await Promise.all([
      this.require(hero, options),
      this.list({ onlyActive: false }, options),
      this.client.api.get('/v1/analytics/hero-synergy-stats', { ...options, query }),
    ]);
    const names = new Map(heroes.map((h) => [h.id, h.name]));
    return rows
      .filter(
        (r) =>
          (r.hero_id1 === target.id || r.hero_id2 === target.id) &&
          r.matches_played >= (options.minMatches ?? 50)
      )
      .map((r) => {
        const mate = r.hero_id1 === target.id ? r.hero_id2 : r.hero_id1;
        return {
          heroId: mate,
          name: names.get(mate) ?? `Hero ${mate}`,
          matches: r.matches_played,
          wins: r.wins,
          winRate: round(winRate(r.wins, r.matches_played), 4),
          confidence: round(wilsonLowerBound(r.wins, r.matches_played), 4),
        };
      })
      .sort((a, b) => b.confidence - a.confidence);
  }
}

export interface ItemFilter {
  /** `"upgrade"` (shop items, default), `"ability"` or `"weapon"`. `"all"` for everything. */
  type?: Item['type'] | 'all';
  /** Shop column. */
  slot?: ItemSlot;
  /** Shop tier 1 to 4. */
  tier?: number;
  /** Only items you can actually buy. Default `true` for upgrades. */
  shopable?: boolean;
}

export interface ItemStat {
  itemId: number;
  name: string;
  slot?: ItemSlot;
  tier?: number;
  matches: number;
  wins: number;
  winRate: number;
  confidence: number;
  /** Average purchase time in seconds. */
  avgBuyTimeS: number;
  raw: Schemas['ItemStats'];
}

export class ItemsResource {
  constructor(private readonly client: DeadlockClient) {}

  /** All items, filtered locally (one cached request serves every filter). */
  async list(filter: ItemFilter = {}, options: AssetOptions = {}): Promise<Item[]> {
    const all = await this.client.api.get('/v1/assets/items', {
      ...options,
      query: this.client.langQuery(options.language),
    });
    const type = filter.type ?? 'all';
    return all.filter((i) => {
      if (type !== 'all' && i.type !== type) return false;
      if (i.type !== 'upgrade') return filter.slot === undefined && filter.tier === undefined;
      const u = i as UpgradeItem;
      if (filter.slot && u.item_slot_type !== filter.slot) return false;
      if (filter.tier !== undefined && u.item_tier !== filter.tier) return false;
      const shopable = filter.shopable ?? (type === 'upgrade' ? true : undefined);
      if (shopable !== undefined && Boolean(u.shopable) !== shopable) return false;
      return true;
    });
  }

  /** Shop items only: buyable upgrades. */
  shop(
    filter: Omit<ItemFilter, 'type' | 'shopable'> = {},
    options: AssetOptions = {}
  ): Promise<UpgradeItem[]> {
    return this.list({ ...filter, type: 'upgrade', shopable: true }, options) as Promise<
      UpgradeItem[]
    >;
  }

  /** An item by numeric id, class name or display name. */
  async get(idOrName: number | string, options: AssetOptions = {}): Promise<Item | undefined> {
    const all = await this.list({}, options);
    if (typeof idOrName === 'number' || /^\d+$/.test(idOrName))
      return all.find((i) => i.id === Number(idOrName));
    const byClass = all.find((i) => i.class_name === idOrName);
    if (byClass) return byClass;
    const matches = all.filter((i) => i.name && sameName(i.name, idOrName));
    // Prefer the buyable upgrade when abilities share a name.
    return matches.find((i) => i.type === 'upgrade' && (i as UpgradeItem).shopable) ?? matches[0];
  }

  /** Item win rates and buy timings with names, best first. */
  async stats(
    query: ItemStatsQuery = {},
    options: AssetOptions & { minMatches?: number } = {}
  ): Promise<ItemStat[]> {
    const [rows, items] = await Promise.all([
      this.client.api.get('/v1/analytics/item-stats', { ...options, query }),
      this.list({}, options),
    ]);
    const byId = new Map(items.map((i) => [i.id, i]));
    return rows
      .filter((r) => r.matches >= (options.minMatches ?? 100))
      .map((r) => {
        const item = byId.get(r.item_id) as UpgradeItem | undefined;
        return {
          itemId: r.item_id,
          name: item?.name ?? String(r.item_id),
          slot: item?.item_slot_type ?? undefined,
          tier: item?.item_tier ?? undefined,
          matches: r.matches,
          wins: r.wins,
          winRate: round(winRate(r.wins, r.matches), 4),
          confidence: round(wilsonLowerBound(r.wins, r.matches), 4),
          avgBuyTimeS: Math.round(r.avg_buy_time_s),
          raw: r,
        };
      })
      .sort((a, b) => b.confidence - a.confidence);
  }
}

export class RanksResource {
  constructor(private readonly client: DeadlockClient) {}

  /** All rank tiers with names, colors and icons. */
  list(
    _filter: Record<string, never> = {},
    options: AssetOptions = {}
  ): Promise<Schemas['Rank'][]> {
    return this.client.api.get('/v1/assets/ranks', {
      ...options,
      query: this.client.langQuery(options.language),
    });
  }

  /** Decodes a badge like `115` to `"Eternus 5"` with the live icon. */
  async decode(badge: number, options: AssetOptions = {}): Promise<DecodedBadge> {
    return decodeBadge(badge, await this.list({}, options));
  }
}
