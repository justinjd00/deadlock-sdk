/** Win rate in 0..1, `0` when there are no matches. */
export function winRate(wins: number, matches: number): number {
  return matches > 0 ? wins / matches : 0;
}

/** (kills + assists) / deaths, with deaths floored at 1. */
export function kda(kills: number, deaths: number, assists: number): number {
  return (kills + assists) / Math.max(1, deaths);
}

/**
 * Lower bound of the Wilson score interval. Ranks win rates by how sure we
 * can be about them, so a hero with 12 games at 75% does not beat one with
 * 40,000 games at 55%. `z = 1.96` is 95% confidence.
 */
export function wilsonLowerBound(wins: number, matches: number, z = 1.96): number {
  if (matches <= 0) return 0;
  const p = wins / matches;
  const z2 = z * z;
  const denom = 1 + z2 / matches;
  const centre = p + z2 / (2 * matches);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * matches)) / matches);
  return (centre - margin) / denom;
}

/** Rounds to `digits` decimals. */
export function round(value: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

/** Splits `list` into chunks of `size`. */
export function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}
