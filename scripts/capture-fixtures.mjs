#!/usr/bin/env node
// Captures small, anonymized samples of real API responses into test/fixtures.
// Account ids, Steam names and avatars are replaced, so no real player data
// lands in the repository. Run: node scripts/capture-fixtures.mjs <match_id>
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://api.deadlock-api.com';
const OUT = join(process.cwd(), 'test', 'fixtures');
const matchId = Number(process.argv[2]);
if (!matchId) throw new Error('Usage: node scripts/capture-fixtures.mjs <match_id>');

async function get(path) {
  const res = await fetch(BASE + path, {
    headers: { 'user-agent': 'deadlock-sdk fixture capture' },
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// Stable fake ids: first seen account becomes 1001, the next 1002, ...
const ids = new Map();
const fake = (id) => {
  if (!ids.has(id)) ids.set(id, 1001 + ids.size);
  return ids.get(id);
};
const pick = (obj, keys) =>
  Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

const meta = await get(`/v1/matches/${matchId}/metadata`);
const info = meta.match_info;
const players = info.players.map((p) => ({
  ...p,
  account_id: fake(p.account_id),
  // Keep only the last stat snapshot and the item timeline, that is what the SDK reads.
  stats: p.stats?.slice(-1),
  ...Object.fromEntries(
    [
      'death_details',
      'book_rewards',
      'pings',
      'ability_stats',
      'hero_data',
      'power_up_buffs',
      'player_tracked_stats',
      'hero_xp_rewards',
    ].map((k) => [k, undefined])
  ),
}));
const matchMeta = {
  match_info: {
    ...pick(info, [
      'match_id',
      'start_time',
      'duration_s',
      'match_outcome',
      'winning_team',
      'game_mode',
      'match_mode',
      'average_badge_team0',
      'average_badge_team1',
    ]),
    players,
  },
};

const subject = info.players[0].account_id;
const history = (await get(`/v1/players/${subject}/match-history`)).slice(0, 30).map((m) => ({
  ...m,
  account_id: fake(m.account_id),
}));
const rank = { ...(await get(`/v1/players/${subject}/rank`)), account_id: fake(subject) };

const heroes = (await get('/v1/assets/heroes?only_active=false')).map((h) => ({
  ...pick(h, [
    'id',
    'class_name',
    'name',
    'hero_type',
    'player_selectable',
    'disabled',
    'in_development',
  ]),
  images: pick(h.images ?? {}, ['icon_hero_card']),
}));

const itemsUsed = new Set(info.players.flatMap((p) => (p.items ?? []).map((i) => i.item_id)));
const allItems = await get('/v1/assets/items');
const items = allItems
  .filter((i) => i.type === 'upgrade' && (itemsUsed.has(i.id) || i.item_tier === 1))
  .concat(allItems.filter((i) => i.type === 'ability').slice(0, 3))
  .map((i) =>
    pick(i, [
      'id',
      'class_name',
      'name',
      'type',
      'item_slot_type',
      'item_tier',
      'shopable',
      'cost',
      'hero',
    ])
  );

const ranks = (await get('/v1/assets/ranks')).map((r) => ({
  ...pick(r, ['tier', 'name', 'color']),
  images: pick(r.images ?? {}, ['large', 'large_webp', 'large_subrank1', 'large_subrank5']),
}));

const heroStats = await get('/v1/analytics/hero-stats');
const counters = (await get('/v1/analytics/hero-counter-stats')).filter(
  (r) => r.hero_id === info.players[0].hero_id
);
const synergies = (await get('/v1/analytics/hero-synergy-stats')).filter(
  (r) => r.hero_id1 === info.players[0].hero_id || r.hero_id2 === info.players[0].hero_id
);
const itemStats = (await get('/v1/analytics/item-stats')).filter((r) =>
  items.some((i) => i.id === r.item_id)
);

const leaderboard = await get('/v1/leaderboard/Europe');
const lb = {
  entries: leaderboard.entries.slice(0, 10).map((e, i) => ({
    ...e,
    account_name: `Player ${i + 1}`,
    possible_account_ids: (e.possible_account_ids ?? []).map(fake),
  })),
};

const patches = (await get('/v1/patches')).slice(0, 3);
const active = (await get('/v1/matches/active')).slice(0, 3).map((m) => ({
  ...m,
  players: m.players.map((p) => ({
    ...p,
    account_id: p.account_id ? fake(p.account_id) : p.account_id,
  })),
}));

const steam = [
  {
    account_id: fake(subject),
    personaname: 'Test Player',
    profileurl: 'https://steamcommunity.com/profiles/76561197960266729/',
    avatar: '',
    avatarmedium: '',
    avatarfull: '',
    countrycode: null,
    last_updated: history[0]?.start_time ?? 0,
  },
];

await mkdir(OUT, { recursive: true });
const files = {
  'match-metadata': matchMeta,
  'match-history': history,
  rank,
  heroes,
  items,
  ranks,
  'hero-stats': heroStats,
  'hero-counter-stats': counters,
  'hero-synergy-stats': synergies,
  'item-stats': itemStats,
  leaderboard: lb,
  patches,
  active,
  steam,
};
for (const [name, data] of Object.entries(files)) {
  await writeFile(join(OUT, `${name}.json`), JSON.stringify(data, null, 1) + '\n');
}
console.log(
  `Wrote ${Object.keys(files).length} fixtures, ${ids.size} accounts anonymized, subject is 1001.`
);
