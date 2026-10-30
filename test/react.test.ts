// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DeadlockProvider,
  useActiveMatches,
  useDeadlockClient,
  useHeroes,
  useLeaderboard,
  usePlayerSearch,
  usePlayerSummary,
  useScoreboard,
  useTierList,
} from '../src/react';
import { MATCH_ID, SUBJECT, testClient } from './helpers';

function setup() {
  const { client, fetch } = testClient();
  const wrapper = ({ children }: { children?: ReactNode }) =>
    createElement(DeadlockProvider, { client }, children);
  return { client, fetch, wrapper };
}

afterEach(() => vi.useRealTimers());

describe('react hooks', () => {
  it('provides the client via context', () => {
    const { client, wrapper } = setup();
    const { result } = renderHook(() => useDeadlockClient(), { wrapper });
    expect(result.current).toBe(client);
  });

  it('loads a player summary and refetches bypassing the cache', async () => {
    const { fetch, wrapper } = setup();
    const { result } = renderHook(() => usePlayerSummary(SUBJECT), { wrapper });
    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data?.accountId).toBe(SUBJECT);
    const before = fetch.mock.calls.length;
    act(() => result.current.refetch());
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  });

  it('stays idle without input', async () => {
    const { fetch, wrapper } = setup();
    const { result } = renderHook(() => usePlayerSummary(undefined), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('exposes errors', async () => {
    const { wrapper } = setup();
    const { result } = renderHook(() => useLeaderboard('mars'), { wrapper });
    await waitFor(() => expect(result.current.error).toBeDefined());
    expect(result.current.error?.message).toContain('Unknown region');
  });

  it('loads heroes, tier list and scoreboard', async () => {
    const { wrapper } = setup();
    const heroes = renderHook(() => useHeroes(), { wrapper });
    const tiers = renderHook(() => useTierList({}, { minMatches: 1 }), { wrapper });
    const board = renderHook(() => useScoreboard(MATCH_ID), { wrapper });
    await waitFor(() => expect(heroes.result.current.data?.length).toBeGreaterThan(0));
    await waitFor(() => expect(tiers.result.current.data?.[0]?.tier).toBe('S'));
    await waitFor(() => expect(board.result.current.data?.matchId).toBe(MATCH_ID));
  });

  it('refreshes live matches on an interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetch, wrapper } = setup();
    const { result } = renderHook(() => useActiveMatches({ refetchInterval: 1000 }), { wrapper });
    await waitFor(() => expect(result.current.data?.length).toBeGreaterThan(0));
    const before = fetch.mock.calls.length;
    await act(() => vi.advanceTimersByTimeAsync(1100));
    await waitFor(() => expect(fetch.mock.calls.length).toBeGreaterThan(before));
  });

  it('debounces player search', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { fetch, wrapper } = setup();
    const { result, rerender } = renderHook(({ q }) => usePlayerSearch(q, { debounceMs: 200 }), {
      wrapper,
      initialProps: { q: 't' },
    });
    rerender({ q: 'te' });
    rerender({ q: 'tes' });
    await act(() => vi.advanceTimersByTimeAsync(250));
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(fetch.mock.calls.filter(([u]) => String(u).includes('steam-search'))).toHaveLength(1);
  });
});
