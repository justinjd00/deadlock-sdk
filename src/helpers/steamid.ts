import { DeadlockError } from '../core/errors';

/** Offset between a 32-bit account id and a SteamID64 for individual accounts. */
export const STEAM_ID64_BASE = 76561197960265728n;
const MAX_ACCOUNT_ID = 0xffffffff;

/**
 * Anything that identifies a Steam account: account id (SteamID3 number,
 * what the Deadlock API uses), SteamID64, `[U:1:123]`, `STEAM_0:1:61`, or a
 * steamcommunity.com/profiles/... URL.
 */
export type PlayerInput = number | bigint | string;

/** Converts any supported Steam identifier to the 32-bit account id. */
export function toAccountId(input: PlayerInput): number {
  if (typeof input === 'bigint') return fromBig(input, String(input));
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || input < 0) throw invalid(String(input));
    if (input <= MAX_ACCOUNT_ID) return input;
    // SteamID64 as a JS number loses precision above 2^53, but real ones fit.
    return fromBig(BigInt(input), String(input));
  }

  const raw = input.trim();
  if (!raw) throw invalid(input);

  // [U:1:123] or U:1:123 (SteamID3)
  const id3 = /^\[?U:1:(\d+)\]?$/i.exec(raw);
  if (id3) return checkRange(Number(id3[1]), raw);

  // STEAM_X:Y:Z (SteamID2), account id = Z * 2 + Y
  const id2 = /^STEAM_[0-5]:([01]):(\d+)$/i.exec(raw);
  if (id2) return checkRange(Number(id2[2]) * 2 + Number(id2[1]), raw);

  // steamcommunity.com/profiles/7656...
  const profile = /steamcommunity\.com\/profiles\/(\d{17})/i.exec(raw);
  if (profile) return fromBig(BigInt(profile[1]!), raw);

  if (/steamcommunity\.com\/id\//i.test(raw)) {
    throw new DeadlockError(
      `"${raw}" is a custom (vanity) Steam URL. It cannot be converted offline. ` +
        'Use players.search(name) or the Steam Web API ResolveVanityURL to get the id.',
      { code: 'INVALID_INPUT', url: '' }
    );
  }

  if (/^\d+$/.test(raw)) {
    const big = BigInt(raw);
    return big <= BigInt(MAX_ACCOUNT_ID) ? Number(big) : fromBig(big, raw);
  }

  throw invalid(raw);
}

/** SteamID64 as a string (it does not fit a JS number safely in all cases). */
export function toSteamId64(input: PlayerInput): string {
  return (BigInt(toAccountId(input)) + STEAM_ID64_BASE).toString();
}

/** `[U:1:123]` notation. */
export function toSteamId3(input: PlayerInput): string {
  return `[U:1:${toAccountId(input)}]`;
}

/** Legacy `STEAM_1:Y:Z` notation. */
export function toSteamId2(input: PlayerInput): string {
  const id = toAccountId(input);
  return `STEAM_1:${id % 2}:${Math.floor(id / 2)}`;
}

/** Steam community profile URL for an account. */
export function steamProfileUrl(input: PlayerInput): string {
  return `https://steamcommunity.com/profiles/${toSteamId64(input)}`;
}

/** `true` when the input can be converted to an account id. */
export function isPlayerInput(input: unknown): input is PlayerInput {
  if (typeof input !== 'number' && typeof input !== 'string' && typeof input !== 'bigint')
    return false;
  try {
    toAccountId(input);
    return true;
  } catch {
    return false;
  }
}

function fromBig(value: bigint, raw: string): number {
  if (value <= BigInt(MAX_ACCOUNT_ID)) return Number(value);
  const id = value - STEAM_ID64_BASE;
  if (id < 0n || id > BigInt(MAX_ACCOUNT_ID)) throw invalid(raw);
  return Number(id);
}

function checkRange(id: number, raw: string): number {
  if (!Number.isSafeInteger(id) || id < 0 || id > MAX_ACCOUNT_ID) throw invalid(raw);
  return id;
}

function invalid(raw: string): DeadlockError {
  return new DeadlockError(
    `"${raw}" is not a Steam account id, SteamID64, SteamID3 or profile URL.`,
    {
      code: 'INVALID_INPUT',
      url: '',
    }
  );
}
