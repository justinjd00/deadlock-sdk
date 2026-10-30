# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-31

First release.

### Added

- `DeadlockClient` with typed access to every endpoint of the Deadlock API (`dl.api.get/post/put/delete`), generated from its OpenAPI spec. Paths autocomplete, path and query parameters are checked, responses are inferred.
- Resources: `players` (summary, rank, batched ranks, match history with filters, hero stats, enemy and mate stats, search, profiles), `matches` (metadata, bulk metadata in chunks of 1000, live matches, ready to render scoreboards), `heroes` (lookup by name, stats, confidence ranked tier list, counters, synergies), `items` (shop filters, lookup, item stats), `ranks`, `leaderboard`, `builds`, `patches`, `analytics` (all analytics endpoints by short name) and `sql`.
- Steam id helpers for account ids, SteamID64, SteamID3, SteamID2 and profile URLs, accepted by every method.
- Rank helpers: `decodeBadge`, `encodeBadge` and `parseBadge` (`"oracle 3"` to `83`).
- Stats helpers: `summarizeHistory` (win rate, KDA, streak, ranked progress, per hero), `wilsonLowerBound`, `winRate`, `kda`.
- HTTP layer with retries, `Retry-After`, proactive throttling on `RateLimit-*` headers, no retries for 504 query timeouts, timeouts, `AbortSignal`, request de-duplication and typed `DeadlockError` codes.
- Per resource cache TTLs, stale-while-revalidate and pluggable stores.
- React hooks in `@justinjd00/deadlock-sdk/react`.
- `deadlock` CLI: player, matches, rank, search, steamid, match, live, tiers, hero, items, leaderboard, patches, sql and a disk cache.
- Weekly contract tests against the live API plus a schema drift check.

[1.0.0]: https://github.com/justinjd00/deadlock-sdk/releases/tag/v1.0.0
