import type { Schemas } from '../core/typed';

/** Rank names by tier, as of the current season. The client prefers live data from the API. */
export const RANK_NAMES: readonly string[] = [
  'Obscurus',
  'Initiate',
  'Seeker',
  'Acolyte',
  'Sentinel',
  'Mystic',
  'Ritualist',
  'Emissary',
  'Oracle',
  'Phantom',
  'Ascendant',
  'Eternus',
];

export interface DecodedBadge {
  /** The raw badge, e.g. `115`. */
  badge: number;
  /** Tier 0 (Obscurus) to 11 (Eternus). */
  tier: number;
  /** Subrank 1 to 6, `0` for unranked. */
  subrank: number;
  /** Tier name, e.g. `"Eternus"`. */
  name: string;
  /** Human label, e.g. `"Eternus 5"` or `"Obscurus"`. */
  label: string;
  /** Rank icon for this subrank, when rank assets were supplied. */
  image?: string;
  color?: string;
}

/**
 * Decodes a Deadlock badge (`tier * 10 + subrank`). Pass the rank assets from
 * `client.ranks.list()` to get live names and images, otherwise a built-in
 * name table is used.
 */
export function decodeBadge(badge: number, ranks?: readonly Schemas['Rank'][]): DecodedBadge {
  const safe = Math.max(0, Math.trunc(badge));
  const tier = Math.floor(safe / 10);
  const subrank = safe % 10;
  const asset = ranks?.find((r) => r.tier === tier);
  const name = asset?.name ?? RANK_NAMES[tier] ?? `Tier ${tier}`;
  const images = (asset?.images ?? {}) as Record<string, string | null | undefined>;
  const image =
    (subrank > 0
      ? (images[`large_subrank${subrank}_webp`] ?? images[`large_subrank${subrank}`])
      : undefined) ??
    images.large_webp ??
    images.large ??
    undefined;
  return {
    badge: safe,
    tier,
    subrank,
    name,
    label: tier === 0 || subrank === 0 ? name : `${name} ${subrank}`,
    image: image ?? undefined,
    color: asset?.color ?? undefined,
  };
}

/** Inverse of `decodeBadge`. */
export function encodeBadge(tier: number, subrank: number): number {
  return tier * 10 + subrank;
}

/**
 * Parses what people type: `"oracle"`, `"Oracle 3"`, `"eternus6"` or a raw
 * badge like `"81"`. A bare tier name means its first subrank.
 */
export function parseBadge(input: string | number): number {
  if (typeof input === 'number') return Math.trunc(input);
  const raw = input.trim().toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  const m = /^([a-z]+)\s*([1-6])?$/.exec(raw);
  const tier = m ? RANK_NAMES.findIndex((n) => n.toLowerCase() === m[1]) : -1;
  if (!m || tier < 0) {
    throw new RangeError(`Unknown rank "${input}". Use a name like "oracle 3" or a badge number.`);
  }
  return encodeBadge(tier, tier === 0 ? 0 : Number(m[2] ?? 1));
}
