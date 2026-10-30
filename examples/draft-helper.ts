// Suggests a pick against a known enemy lineup, from real matchup data.
// npx tsx examples/draft-helper.ts haze "lady geist" abrams
import { createDeadlockClient, wilsonLowerBound } from '../src';

const dl = createDeadlockClient();
const enemies = await Promise.all(process.argv.slice(2).map((name) => dl.heroes.require(name)));
if (!enemies.length) throw new Error('Pass enemy hero names, e.g. haze "lady geist" abrams');

const since = {
  min_unix_timestamp: Math.floor(Date.now() / 1000) - 30 * 86400,
  min_average_badge: 71,
};
const heroes = await dl.heroes.list();
const enemyIds = new Set(enemies.map((e) => e.id));

// For every candidate, sum wins and games against each enemy, then rank by confidence.
const scored = await Promise.all(
  heroes
    .filter((h) => !enemyIds.has(h.id))
    .map(async (hero) => {
      const matchups = await dl.heroes.counters(hero.id, since, { minMatches: 200 });
      const vs = matchups.filter((m) => enemyIds.has(m.heroId));
      const wins = vs.reduce((n, m) => n + m.wins, 0);
      const games = vs.reduce((n, m) => n + m.matches, 0);
      return {
        hero: hero.name,
        games,
        winRate: games ? wins / games : 0,
        score: wilsonLowerBound(wins, games),
      };
    })
);

console.log(`Best picks into ${enemies.map((e) => e.name).join(', ')} (Emissary+, last 30 days):`);
for (const s of scored.sort((a, b) => b.score - a.score).slice(0, 5)) {
  console.log(
    `  ${s.hero.padEnd(14)} ${(s.winRate * 100).toFixed(1)}%  over ${s.games.toLocaleString()} games`
  );
}
