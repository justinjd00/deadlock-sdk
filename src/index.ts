export { DeadlockClient, createDeadlockClient, ATTRIBUTION } from './client';
export type { DeadlockClientOptions, SearchEntity, SearchResult, TypedApi } from './client';

export type { PlayerRank, PlayerSummary, MatchHistoryOptions } from './resources/players';
export type { BulkMatch, Scoreboard, ScoreboardPlayer } from './resources/matches';
export type {
  AssetOptions,
  Hero,
  HeroStat,
  Item,
  ItemFilter,
  ItemSlot,
  ItemStat,
  MatchupStat,
  Tier,
  TierListEntry,
  UpgradeItem,
} from './resources/assets';
export type { LeaderboardRow, PatchNote, SqlColumn } from './resources/meta';
export type { AnalyticsName } from './resources/analytics';
export type * from './resources/match-types';

export type { components, paths, Schemas, CallOptions, Language } from './core/typed';

export { DeadlockError, isDeadlockError } from './core/errors';
export type { DeadlockErrorCode } from './core/errors';
export { HttpClient, DEFAULT_BASE_URL, DEFAULT_USER_AGENT, parseRetryAfter } from './core/http';
export type {
  FetchLike,
  Hooks,
  HttpClientOptions,
  RateLimitState,
  RequestEvent,
  ResponseEvent,
  RetryEvent,
  RetryOptions,
  ThrottleEvent,
} from './core/http';
export { MemoryCache, DEFAULT_TTL, cacheResourceFor } from './core/cache';
export type { CacheEntry, CacheOptions, CacheResource, CacheStore } from './core/cache';

export {
  toAccountId,
  toSteamId64,
  toSteamId3,
  toSteamId2,
  steamProfileUrl,
  isPlayerInput,
  STEAM_ID64_BASE,
} from './helpers/steamid';
export type { PlayerInput } from './helpers/steamid';
export { decodeBadge, encodeBadge, parseBadge, RANK_NAMES } from './helpers/ranks';
export type { DecodedBadge } from './helpers/ranks';
export { didWin, summarizeHistory } from './helpers/history';
export type { HeroSummary, HistorySummary, MatchHistoryEntry } from './helpers/history';
export { kda, winRate, wilsonLowerBound, round, chunk } from './helpers/stats';
export {
  GAME_MODES,
  MATCH_MODES,
  LEADERBOARD_REGIONS,
  gameModeName,
  matchModeName,
  normalizeRegion,
} from './helpers/modes';
export type { LeaderboardRegion } from './helpers/modes';
export { createSearchIndex, editDistance, normalizeText, tokenize } from './helpers/search';
export type { SearchDocument, SearchHit, SearchIndex, SearchOptions } from './helpers/search';
export { toCSV, toJSON } from './helpers/export';
export type { CsvColumn, CsvOptions } from './helpers/export';

export { VERSION } from './version';
