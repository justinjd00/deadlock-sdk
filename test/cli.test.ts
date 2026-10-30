import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from '../src/cli';
import { VERSION } from '../src';
import { MATCH_ID, SUBJECT, fakeApi } from './helpers';

let dir: string;
let stdout: string[];
let stderr: string[];
let fetch: ReturnType<typeof fakeApi>;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'deadlock-cli-'));
  vi.stubEnv('XDG_CACHE_HOME', join(dir, 'cache'));
  vi.stubEnv('NO_COLOR', '1');
});

afterAll(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stdout = [];
  stderr = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void stdout.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void stderr.push(a.join(' ')));
  fetch = fakeApi();
  vi.stubGlobal('fetch', fetch);
});

const out = () => stdout.join('\n');

describe('cli', () => {
  it('prints version and help', async () => {
    expect(await run(['--version'])).toBe(0);
    expect(stdout[0]).toBe(VERSION);
    expect(await run([])).toBe(0);
    expect(out()).toContain('Deadlock stats from the terminal');
    expect(out()).toContain('deadlock-api.com');
  });

  it('rejects unknown commands, flags and bad input with exit code 2', async () => {
    expect(await run(['nope'])).toBe(2);
    expect(await run(['tiers', '--bogus'])).toBe(2);
    expect(await run(['tiers', '--min-rank', 'diamond'])).toBe(2);
    expect(await run(['tiers', '--days', '-1'])).toBe(2);
    expect(await run(['match'])).toBe(2);
    expect(await run(['steamid', 'not-an-id'])).toBe(2);
    expect(await run(['leaderboard', 'mars'])).toBe(2);
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('mars'), expect.anything());
  });

  it('shows a player card', async () => {
    expect(await run(['player', String(SUBJECT)])).toBe(0);
    expect(out()).toContain('Test Player');
    expect(out()).toMatch(/Rank\s+[A-Z][a-z]+ \d/);
    expect(out()).toMatch(/\d+W \d+L/);
    expect(out()).toContain('Top heroes');
  });

  it('falls back to a name search for players', async () => {
    expect(await run(['rank', 'Test Player'])).toBe(0);
    expect(stderr.join('\n')).toContain(`Using Test Player (${SUBJECT})`);
  });

  it('lists matches as a table and as JSON', async () => {
    expect(await run(['matches', String(SUBJECT), '--limit', '3'])).toBe(0);
    expect(stdout[0]).toMatch(/^when\s+match\s+hero\s+result\s+kda/);
    expect(stdout).toHaveLength(4);
    expect(out()).toMatch(/WIN|LOSS/);
    stdout.length = 0;
    expect(await run(['matches', String(SUBJECT), '--limit', '2', '--json'])).toBe(0);
    expect(JSON.parse(out())).toHaveLength(2);
  });

  it('prints a scoreboard with both teams', async () => {
    expect(await run(['match', String(MATCH_ID)])).toBe(0);
    expect(out()).toContain(`Match ${MATCH_ID}`);
    expect(out()).toContain('Hidden King');
    expect(out()).toContain('Archmother');
    expect(out().match(/\bWIN\b/g)).toHaveLength(1);
  });

  it('prints the tier list for the last 30 days by default', async () => {
    expect(await run(['tiers', '--limit', '5'])).toBe(0);
    expect(stdout[0]).toMatch(/^tier\s+hero\s+winrate/);
    expect(stdout[1]).toMatch(/^S\s/);
    const url = new URL(
      String(fetch.mock.calls.find(([u]) => String(u).includes('hero-stats'))![0])
    );
    const since = Number(url.searchParams.get('min_unix_timestamp'));
    expect(Date.now() / 1000 - since).toBeCloseTo(30 * 86400, -2);
  });

  it('passes rank filters as badges', async () => {
    expect(await run(['tiers', '--min-rank', 'oracle 3', '--days', '7'])).toBe(0);
    const url = String(fetch.mock.calls.find(([u]) => String(u).includes('hero-stats'))![0]);
    expect(url).toContain('min_average_badge=83');
  });

  it('shows hero matchups', async () => {
    expect(await run(['hero', '1'])).toBe(0);
    for (const s of ['Strong against', 'Weak against', 'Best teammates'])
      expect(out()).toContain(s);
  });

  it('covers items, leaderboard, live, patches, steamid and sql', async () => {
    for (const argv of [
      ['items', '--limit', '3'],
      ['leaderboard', 'eu', '--limit', '3'],
      ['live', '--limit', '2'],
      ['patches', '--limit', '1'],
      ['search', 'test'],
      ['steamid', '[U:1:22202]'],
      ['sql', 'SELECT 1'],
      ['sql', 'tables'],
    ]) {
      stdout.length = 0;
      expect(await run(argv), argv.join(' ')).toBe(0);
      expect(stdout.length, argv.join(' ')).toBeGreaterThan(0);
    }
    expect(out()).toContain('match_player');
  });

  it('prints full profile URLs', async () => {
    expect(await run(['steamid', '22202'])).toBe(0);
    expect(out()).toContain('https://steamcommunity.com/profiles/76561197960287930');
    expect(out()).toContain('STEAM_1:0:11101');
  });

  it('reports API errors with exit code 1', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"down"}', { status: 500 }))
    );
    expect(await run(['patches', '--no-cache'])).toBe(1);
    expect(stderr.join('\n')).toMatch(/Error \(HTTP_ERROR 500\)/);
  });

  it('clears the cache', async () => {
    expect(await run(['cache', 'clear'])).toBe(0);
    expect(out()).toContain(join(dir, 'cache', 'deadlock-sdk'));
  });
});
