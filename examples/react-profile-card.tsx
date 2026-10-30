// A profile card with live rank, recent form and top heroes.
import { DeadlockProvider, usePlayerSummary } from '@justinjd00/deadlock-sdk/react';

export function ProfileCard({ player }: { player: string }) {
  const { data, error, loading, refetch } = usePlayerSummary(player, { matches: 30 });
  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return null;
  const { profile, rank, recent, topHeroes } = data;

  return (
    <article>
      <header>
        {profile?.avatarmedium && <img src={profile.avatarmedium} alt="" width={48} height={48} />}
        <h2>{profile?.personaname ?? data.accountId}</h2>
        {rank?.image && <img src={rank.image} alt={rank.label} width={40} height={40} />}
        <span>{rank?.label ?? 'Unranked'}</span>
      </header>
      <p>
        {recent.wins}W {recent.losses}L · {(recent.winRate * 100).toFixed(1)}% · KDA {recent.kda}
        {recent.streak.count > 1 && ` · ${recent.streak.count} ${recent.streak.type} streak`}
      </p>
      <ul>
        {topHeroes.map((h) => (
          <li key={h.heroId}>
            {h.name}: {h.matches} games, {(h.winRate * 100).toFixed(0)}%
          </li>
        ))}
      </ul>
      <button onClick={refetch}>Refresh</button>
    </article>
  );
}

export function App() {
  return (
    <DeadlockProvider>
      <ProfileCard player="https://steamcommunity.com/profiles/76561197960287930" />
    </DeadlockProvider>
  );
}
