// Compile time checks for the typed API. `npm run typecheck` fails if any of
// the @ts-expect-error lines stop being errors, so this guards the types.
import { describe, expect, expectTypeOf, it } from 'vitest';
import { DeadlockClient, type Schemas } from '../src';

const dl = new DeadlockClient({ fetch: async () => new Response('[]'), cache: false });

async function typed() {
  const rank = await dl.api.get('/v1/players/{account_id}/rank', { path: { account_id: 1 } });
  expectTypeOf(rank).toEqualTypeOf<Schemas['RankResponse']>();

  const heroes = await dl.api.get('/v1/assets/heroes', {
    query: { only_active: true, language: 'german' },
  });
  expectTypeOf(heroes).toEqualTypeOf<Schemas['Hero'][]>();

  // Operations without required input take no arguments.
  await dl.api.get('/v1/info');

  // @ts-expect-error unknown path
  await dl.api.get('/v1/does-not-exist');
  // @ts-expect-error path params are required
  await dl.api.get('/v1/players/{account_id}/rank');
  // @ts-expect-error wrong path param type
  await dl.api.get('/v1/players/{account_id}/rank', { path: { account_id: 'x' } });
  // @ts-expect-error unknown query param
  await dl.api.get('/v1/assets/heroes', { query: { nope: 1 } });
  // @ts-expect-error language is a closed set
  await dl.api.get('/v1/assets/heroes', { query: { language: 'klingon' } });

  const summary = await dl.players.summary(1);
  expectTypeOf(summary.recent.winRate).toBeNumber();
  // @ts-expect-error players are ids or strings
  await dl.players.summary({ id: 1 });

  const tiers = await dl.heroes.tierList();
  expectTypeOf(tiers[0]!.tier).toEqualTypeOf<'S' | 'A' | 'B' | 'C' | 'D'>();

  // @ts-expect-error analytics names come from the spec
  await dl.analytics.get('not-an-endpoint');
}

describe('types', () => {
  it('compiles', () => {
    expect(typeof typed).toBe('function');
  });
});
