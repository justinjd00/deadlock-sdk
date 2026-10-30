// npx tsx examples/quickstart.ts [steam id or profile URL]
import { createDeadlockClient } from '../src';

const dl = createDeadlockClient();
const player = process.argv[2] ?? (await dl.leaderboard.get('eu', { limit: 1 }))[0]!.accountIds[0]!;

const me = await dl.players.summary(player);
console.log(`${me.profile?.personaname ?? me.accountId}: ${me.rank?.label ?? 'unranked'}`);
console.log(
  `last ${me.recent.matches}: ${(me.recent.winRate * 100).toFixed(1)}% win rate, KDA ${me.recent.kda}`
);
for (const h of me.topHeroes)
  console.log(`  ${h.name.padEnd(14)} ${h.matches} games, ${(h.winRate * 100).toFixed(0)}%`);

// The meta in high ranks over the last two weeks.
const since = Math.floor(Date.now() / 1000) - 14 * 86400;
const tiers = await dl.heroes.tierList({ min_average_badge: 81, min_unix_timestamp: since });
console.log(
  '\nS tier above Oracle:',
  tiers
    .filter((t) => t.tier === 'S')
    .map((t) => t.name)
    .join(', ')
);

// Anything the resources do not cover is still one typed call away.
const rows = await dl.api.get('/v1/analytics/hero-stats', { query: { min_unix_timestamp: since } });
console.log(
  `${rows.length} hero rows, typed as`,
  Object.keys(rows[0] ?? {})
    .slice(0, 4)
    .join(', '),
  '...'
);
