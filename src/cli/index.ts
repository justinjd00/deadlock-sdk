import { parseArgs } from 'node:util';
import { ATTRIBUTION, DeadlockClient } from '../client';
import { isDeadlockError } from '../core/errors';
import { didWin } from '../helpers/history';
import { gameModeName, matchModeName } from '../helpers/modes';
import { decodeBadge, parseBadge } from '../helpers/ranks';
import {
  toAccountId,
  toSteamId2,
  toSteamId3,
  toSteamId64,
  steamProfileUrl,
} from '../helpers/steamid';
import { toJSON } from '../helpers/export';
import { wilsonLowerBound } from '../helpers/stats';
import { VERSION } from '../version';
import { FileCache } from './file-cache';

const HELP = `deadlock ${VERSION}, Deadlock stats from the terminal

Usage
  deadlock <command> [args] [options]

Players  (accept account id, SteamID64, [U:1:x], profile URL or a Steam name)
  player <who>          Profile card: rank, recent form, top heroes   --matches 50
  matches <who>         Recent matches                    --limit 15 --ranked --hero haze
  rank <who>            Current rank
  search <name>         Find players by Steam name
  steamid <who>         Convert between all Steam id formats

Matches
  match <id>            Scoreboard with heroes, KDA, net worth and items
  live                  Top matches being played right now

Meta
  tiers                 Tier list (win rate with confidence)   --min-rank oracle --days 14
                        Meta commands cover the last 30 days unless --days is set
  hero <name>           Hero stats, best and worst matchups, best teammates
  items                 Item win rates                         --slot weapon --hero haze
  leaderboard [region]  eu, na, sa, asia, oce                  --hero haze --limit 25
  patches               Latest patch notes
  sql "<query>"         Run SQL on the public dataset (DuckDB syntax)
  sql tables            List tables, "sql schema <table>" for columns

  cache clear           Delete the local cache

Options
  --json            Raw JSON output
  --limit <n>       Max rows
  --no-cache        Skip the local cache for this call
  --api-key <key>   Deadlock API key (or set DEADLOCK_API_KEY)
  -v, --version     Print version
  -h, --help        Show this help

${ATTRIBUTION.text}: ${ATTRIBUTION.url}. Not affiliated with Valve.
`;

const options = {
  json: { type: 'boolean' },
  limit: { type: 'string' },
  'no-cache': { type: 'boolean' },
  'api-key': { type: 'string' },
  matches: { type: 'string' },
  ranked: { type: 'boolean' },
  hero: { type: 'string' },
  slot: { type: 'string' },
  'min-rank': { type: 'string' },
  days: { type: 'string' },
  version: { type: 'boolean', short: 'v' },
  help: { type: 'boolean', short: 'h' },
} as const;

type Flags = ReturnType<typeof parse>['values'];
function parse(argv: string[]) {
  return parseArgs({ args: argv, options, allowPositionals: true, strict: true });
}

class UsageError extends Error {}

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = paint(1);
const dim = paint(2);
const green = paint(32);
const red = paint(31);
const cyan = paint(36);

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;
const plain = (s: string) => s.replace(ANSI, '');
const visible = (s: string) => plain(s).length;

function table(rows: Array<Record<string, unknown>>, limit?: number, maxWidth = 48): void {
  const shown = limit && limit > 0 ? rows.slice(0, limit) : rows;
  if (!shown.length) return void console.log(dim('No results.'));
  const cols = Object.keys(shown[0]!).filter((c) => shown.some((r) => r[c] !== '' && r[c] != null));
  const text = (v: unknown) => {
    const s =
      v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return visible(s) > maxWidth && !/^https?:/.test(s) ? `${s.slice(0, maxWidth - 3)}...` : s;
  };
  const widths = cols.map((c) => Math.max(c.length, ...shown.map((r) => visible(text(r[c])))));
  // Numbers line up on the right, like in any stats table.
  const numeric = cols.map((c) =>
    shown.every((r) => /^[+-]?[\d,.:]+%?$/.test(plain(text(r[c]))) || text(r[c]) === '')
  );
  const pad = (s: string, w: number, right = false) => {
    const fill = ' '.repeat(Math.max(0, w - visible(s)));
    return right ? fill + s : s + fill;
  };
  const line = (cells: string[]) =>
    cells
      .map((s, i) => pad(s, widths[i]!, numeric[i]))
      .join('  ')
      .trimEnd();
  console.log(bold(line(cols)));
  for (const r of shown) console.log(line(cols.map((c) => text(r[c]))));
  if (shown.length < rows.length)
    console.log(dim(`... ${rows.length - shown.length} more, use --limit`));
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const n = (v: number) => v.toLocaleString('en-US');
const k2 = (v: number) => v.toFixed(2);
const mins = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const ago = (unix: number) => {
  const d = Math.max(0, Date.now() / 1000 - unix);
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return `${Math.round(d / 86400)}d ago`;
};

function need(value: string | undefined, what: string): string {
  if (!value) throw new UsageError(`Missing ${what}.`);
  return value;
}

/** Accepts ids and URLs, and falls back to a Steam name search. */
async function resolvePlayer(client: DeadlockClient, input: string): Promise<number> {
  try {
    return toAccountId(input);
  } catch {
    const hits = await client.players.search(input, { limit: 1 });
    const hit = hits[0];
    if (!hit) throw new UsageError(`No player found for "${input}".`);
    console.error(dim(`Using ${hit.personaname} (${hit.account_id}). Pass an id to be exact.`));
    return hit.account_id;
  }
}

const TEAM_NAMES = ['Hidden King', 'Archmother'];

/** Meta commands default to the last 30 days, all-time numbers hide the current balance. */
function timeQuery(flags: Flags) {
  const q: { min_average_badge?: number; min_unix_timestamp?: number } = {};
  if (flags['min-rank']) q.min_average_badge = parseBadge(flags['min-rank']);
  const days = Number(flags.days ?? 30);
  if (!Number.isFinite(days) || days <= 0)
    throw new UsageError('--days must be a positive number.');
  q.min_unix_timestamp = Math.floor(Date.now() / 1000 - days * 86400);
  return q;
}

export async function run(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    console.error((error as Error).message);
    console.error(dim('Run "deadlock --help" for usage.'));
    return 2;
  }
  const { values: flags, positionals } = parsed;
  const [command, arg] = positionals;
  if (flags.version) return (void console.log(VERSION), 0);
  if (flags.help || !command || command === 'help') return (void console.log(HELP), 0);

  const fileCache = new FileCache();
  const client = new DeadlockClient({
    apiKey: flags['api-key'] ?? process.env.DEADLOCK_API_KEY,
    cache: { store: fileCache },
  });
  const call = { fresh: flags['no-cache'] === true };
  const limit = flags.limit ? Number(flags.limit) : undefined;
  const out = (data: unknown, render: () => void) =>
    flags.json ? console.log(toJSON(data)) : render();

  try {
    switch (command) {
      case 'player': {
        const id = await resolvePlayer(client, need(arg, 'player'));
        const s = await client.players.summary(id, {
          ...call,
          matches: flags.matches ? Number(flags.matches) : 50,
        });
        out(s, () => {
          const r = s.recent;
          console.log(
            `${bold(s.profile?.personaname ?? String(s.accountId))}  ${dim(`${s.accountId} · ${s.steamId64}`)}`
          );
          console.log(`Rank      ${s.rank ? cyan(s.rank.label) : dim('unranked or private')}`);
          console.log(
            `Last ${r.matches}   ${r.wins}W ${r.losses}L  ${bold(pct(r.winRate))}  KDA ${k2(r.kda)}  ` +
              `streak ${r.streak.type === 'win' ? green(`${r.streak.count}W`) : r.streak.type === 'loss' ? red(`${r.streak.count}L`) : '-'}`
          );
          if (r.rankedDelta)
            console.log(
              `Ranked    ${r.rankedDelta > 0 ? green(`+${r.rankedDelta}`) : red(String(r.rankedDelta))} rank points`
            );
          console.log(`\n${bold('Top heroes')}`);
          table(
            s.topHeroes.map((h) => ({
              hero: h.name,
              matches: n(h.matches),
              winrate: pct(h.winRate),
              kda: k2(h.kda),
              'avg souls': n(h.avgNetWorth),
            }))
          );
        });
        break;
      }
      case 'matches': {
        const id = await resolvePlayer(client, need(arg, 'player'));
        const hero = flags.hero ? await client.heroes.require(flags.hero) : undefined;
        const [history, heroes] = await Promise.all([
          client.players.matchHistory(id, {
            ...call,
            limit: limit ?? 15,
            matchModes: flags.ranked ? [4] : undefined,
            heroId: hero?.id,
          }),
          client.heroes.list({ onlyActive: false }),
        ]);
        const names = new Map(heroes.map((h) => [h.id, h.name]));
        out(history, () =>
          table(
            history.map((m) => ({
              when: ago(m.start_time),
              match: m.match_id,
              hero: names.get(m.hero_id) ?? m.hero_id,
              result: didWin(m) ? green('WIN') : red('LOSS'),
              kda: `${m.player_kills}/${m.player_deaths}/${m.player_assists}`,
              souls: n(m.net_worth),
              length: mins(m.match_duration_s),
              mode: matchModeName(m.match_mode),
              rank: m.ranked_delta
                ? m.ranked_delta > 0
                  ? green(`+${m.ranked_delta}`)
                  : red(String(m.ranked_delta))
                : '',
            }))
          )
        );
        break;
      }
      case 'rank': {
        const id = await resolvePlayer(client, need(arg, 'player'));
        const r = await client.players.rank(id, call);
        out(r, () =>
          console.log(
            r.badge > 0 ? `${cyan(r.label)}  ${dim(`badge ${r.badge}`)}` : dim('No ranked data.')
          )
        );
        break;
      }
      case 'search': {
        const name = positionals.slice(1).join(' ');
        const hits = await client.players.search(need(name, 'name'), {
          ...call,
          limit: limit ?? 10,
        });
        out(hits, () =>
          table(
            hits.map((p) => ({
              name: p.personaname,
              id: p.account_id,
              'matches 30d': p.matches_played_last_30d ?? '',
              'team avg rank': p.last_team_avg_badge
                ? decodeBadge(p.last_team_avg_badge).label
                : '',
            }))
          )
        );
        break;
      }
      case 'steamid': {
        const id = toAccountId(need(arg, 'Steam id'));
        const ids = {
          accountId: id,
          steamId64: toSteamId64(id),
          steamId3: toSteamId3(id),
          steamId2: toSteamId2(id),
          profile: steamProfileUrl(id),
        };
        out(ids, () =>
          table(
            Object.entries(ids).map(([format, value]) => ({ format, value })),
            undefined,
            80
          )
        );
        break;
      }
      case 'match': {
        const s = await client.matches.scoreboard(Number(need(arg, 'match id')), call);
        out(s, () => {
          console.log(
            `${bold(`Match ${s.matchId}`)}  ${dim(`${s.startedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC · ${mins(s.durationS)} · ${gameModeName(s.gameMode)} ${matchModeName(s.matchMode)}`)}`
          );
          for (const [i, team] of s.teams.entries()) {
            const won = s.winningTeam === i;
            console.log(`\n${bold(TEAM_NAMES[i]!)}  ${won ? green('WIN') : red('LOSS')}`);
            table(
              team.map((p) => ({
                hero: p.heroName,
                k: p.kills,
                d: p.deaths,
                a: p.assists,
                souls: n(p.netWorth),
                dmg: p.playerDamage !== undefined ? n(p.playerDamage) : '',
                items: p.finalItems.slice(-4).join(', '),
                player: p.accountId,
              }))
            );
          }
        });
        break;
      }
      case 'live': {
        const [active, heroes] = await Promise.all([
          client.matches.active(call),
          client.heroes.list({ onlyActive: false }),
        ]);
        const names = new Map(heroes.map((h) => [h.id, h.name]));
        out(active, () =>
          table(
            active.map((m) => ({
              match: m.match_id ?? '',
              time: m.duration_s != null ? mins(m.duration_s) : '',
              mode: m.match_mode_parsed ?? '',
              region: m.region_mode_parsed ?? '',
              watching: m.spectators ?? '',
              heroes: m.players.map((p) => names.get(p.hero_id ?? -1) ?? '?').join(', '),
            })),
            limit ?? 15
          )
        );
        break;
      }
      case 'tiers': {
        const tiers = await client.heroes.tierList(timeQuery(flags), { ...call, minMatches: 200 });
        out(tiers, () =>
          table(
            tiers.map((t) => ({
              tier: bold(t.tier),
              hero: t.name,
              winrate: pct(t.winRate),
              'pick rate': pct(t.pickRate),
              matches: n(t.matches),
              kda: k2(t.kda),
            })),
            limit
          )
        );
        break;
      }
      case 'hero': {
        const hero = await client.heroes.require(need(positionals.slice(1).join(' '), 'hero name'));
        const q = timeQuery(flags);
        const [stats, counters, mates] = await Promise.all([
          client.heroes.stats(q, call),
          client.heroes.counters(hero.id, q, call),
          client.heroes.synergies(hero.id, q, call),
        ]);
        const me = stats.find((s) => s.heroId === hero.id);
        out(
          { hero: { id: hero.id, name: hero.name }, stats: me, counters, synergies: mates },
          () => {
            console.log(`${bold(hero.name)}  ${dim(hero.hero_type ?? '')}`);
            if (me)
              console.log(
                `Win rate ${bold(pct(me.winRate))}  pick rate ${pct(me.pickRate)}  KDA ${k2(me.kda)}  ${dim(`${n(me.matches)} matches`)}`
              );
            console.log(`\n${bold('Strong against')}`);
            table(
              counters.slice(0, 5).map((c) => ({
                hero: c.name,
                winrate: green(pct(c.winRate)),
                matches: n(c.matches),
              }))
            );
            console.log(`\n${bold('Weak against')}`);
            // Worst matchups by confidence too, so a 3 game sample does not top the list.
            const weak = [...counters].sort(
              (a, b) =>
                wilsonLowerBound(b.matches - b.wins, b.matches) -
                wilsonLowerBound(a.matches - a.wins, a.matches)
            );
            table(
              weak
                .slice(0, 5)
                .map((c) => ({ hero: c.name, winrate: red(pct(c.winRate)), matches: n(c.matches) }))
            );
            console.log(`\n${bold('Best teammates')}`);
            table(
              mates
                .slice(0, 5)
                .map((c) => ({ hero: c.name, winrate: pct(c.winRate), matches: n(c.matches) }))
            );
          }
        );
        break;
      }
      case 'items': {
        const hero = flags.hero ? await client.heroes.require(flags.hero) : undefined;
        const stats = await client.items.stats(
          { ...timeQuery(flags), hero_id: hero?.id },
          { ...call, minMatches: 500 }
        );
        const rows = flags.slot ? stats.filter((s) => s.slot === flags.slot) : stats;
        out(rows, () =>
          table(
            rows.map((s) => ({
              item: s.name,
              slot: s.slot ?? '',
              tier: s.tier ?? '',
              winrate: pct(s.winRate),
              matches: n(s.matches),
              'avg buy': mins(s.avgBuyTimeS),
            })),
            limit ?? 25
          )
        );
        break;
      }
      case 'leaderboard': {
        const rows = await client.leaderboard.get(arg ?? 'Europe', {
          ...call,
          hero: flags.hero,
          limit: limit ?? 25,
        });
        out(rows, () =>
          table(rows.map((r) => ({ '#': r.rank, name: r.name, heroes: r.topHeroes.join(', ') })))
        );
        break;
      }
      case 'patches': {
        const patches = await client.patches.list(call);
        out(patches, () =>
          table(
            patches.map((p) => ({
              date: p.publishedAt.toISOString().slice(0, 10),
              title: p.title,
              url: p.url,
            })),
            limit ?? 10
          )
        );
        break;
      }
      case 'sql': {
        if (arg === 'tables' && positionals.length === 2) {
          const tables = await client.sql.tables(call);
          out(tables, () => tables.forEach((t) => console.log(t)));
          break;
        }
        if (arg === 'schema' && positionals.length === 3) {
          const cols = await client.sql.schema(positionals[2]!, call);
          out(cols, () =>
            table(
              cols.map((c) => ({ column: c.name, type: c.type })),
              limit,
              60
            )
          );
          break;
        }
        const rows = await client.sql.query(
          need(positionals.slice(1).join(' '), 'SQL query'),
          call
        );
        out(rows, () => table(rows as Array<Record<string, unknown>>, limit ?? 50));
        break;
      }
      case 'cache': {
        if (arg !== 'clear') throw new UsageError('Usage: deadlock cache clear');
        await fileCache.clear();
        console.log(`Cleared ${fileCache.dir}`);
        break;
      }
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error instanceof RangeError) {
      console.error(error.message);
      console.error(dim('Run "deadlock --help" for usage.'));
      return 2;
    }
    if (isDeadlockError(error)) {
      if (error.code === 'INVALID_INPUT') {
        console.error(error.message);
        return 2;
      }
      console.error(
        `Error (${error.code}${error.status ? ` ${error.status}` : ''}): ${error.message}`
      );
      return 1;
    }
    throw error;
  }
}
