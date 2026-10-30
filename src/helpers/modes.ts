import { DeadlockError } from '../core/errors';

/** Numeric game modes used in match history and metadata. */
export const GAME_MODES = {
  0: 'Invalid',
  1: 'Normal',
  2: '1v1 Test',
  3: 'Sandbox',
  4: 'Street Brawl',
} as const satisfies Record<number, string>;

/** Numeric match modes used in match history and metadata. */
export const MATCH_MODES = {
  0: 'Invalid',
  1: 'Unranked',
  2: 'Private Lobby',
  3: 'Co-op Bot',
  4: 'Ranked',
  5: 'Server Test',
  6: 'Tutorial',
  7: 'Hero Labs',
  8: 'New Player Placement',
} as const satisfies Record<number, string>;

/** Regions accepted by the leaderboard endpoints. */
export const LEADERBOARD_REGIONS = ['Europe', 'Asia', 'NAmerica', 'SAmerica', 'Oceania'] as const;
export type LeaderboardRegion = (typeof LEADERBOARD_REGIONS)[number];

export function gameModeName(mode: number | null | undefined): string {
  return (GAME_MODES as Record<number, string>)[mode ?? 0] ?? `Mode ${mode}`;
}

export function matchModeName(mode: number | null | undefined): string {
  return (MATCH_MODES as Record<number, string>)[mode ?? 0] ?? `Mode ${mode}`;
}

const REGION_ALIASES: Record<string, LeaderboardRegion> = {
  eu: 'Europe',
  europe: 'Europe',
  asia: 'Asia',
  sea: 'Asia',
  na: 'NAmerica',
  nam: 'NAmerica',
  namerica: 'NAmerica',
  'north america': 'NAmerica',
  sa: 'SAmerica',
  sam: 'SAmerica',
  samerica: 'SAmerica',
  'south america': 'SAmerica',
  oce: 'Oceania',
  oceania: 'Oceania',
};

/** Accepts `"eu"`, `"na"`, `"North America"`, ... and returns the API's region name. */
export function normalizeRegion(region: string): LeaderboardRegion {
  const hit = REGION_ALIASES[region.trim().toLowerCase().replace(/[_-]+/g, ' ')];
  if (hit) return hit;
  const exact = LEADERBOARD_REGIONS.find((r) => r.toLowerCase() === region.trim().toLowerCase());
  if (exact) return exact;
  throw new DeadlockError(`Unknown region "${region}". Use one of: eu, na, sa, asia, oce.`, {
    code: 'INVALID_INPUT',
    url: '',
  });
}
