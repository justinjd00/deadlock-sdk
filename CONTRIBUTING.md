# Contributing

Thanks for helping out. Bug reports, API drift reports and pull requests are all welcome.

## Setup

Requires Node.js 22 or newer for development (the published package runs on Node 20+).

```bash
git clone https://github.com/justinjd00/deadlock-sdk.git
cd deadlock-sdk
npm install
```

## Scripts

| Command                 | What it does                                               |
| ----------------------- | ---------------------------------------------------------- |
| `npm run build`         | Builds ESM, CJS, type declarations and the CLI             |
| `npm test`              | Offline unit and type tests (Vitest)                       |
| `npm run test:contract` | Runs the SDK against the live Deadlock API                 |
| `npm run generate`      | Rebuilds `src/generated` from the live OpenAPI spec        |
| `npm run check:schema`  | Fails if `src/generated` no longer matches the live spec   |
| `npm run typecheck`     | `tsc --noEmit`, includes the `@ts-expect-error` type tests |
| `npm run lint`          | ESLint                                                     |
| `npm run format`        | Prettier                                                   |
| `npm run check:package` | publint and are-the-types-wrong on the packed tarball      |

Before opening a PR, run `npm run build && npm run typecheck && npm run lint && npm test`.

## Guidelines

- Keep the core free of runtime dependencies.
- Anything React goes to `src/react`, so the core stays tree-shakeable and browser friendly.
- Never edit `src/generated` by hand. Run `npm run generate` and commit the diff.
- The match metadata response is untyped in the spec, its types live in `src/resources/match-types.ts`. Keep new fields optional.
- Every bug fix gets a test. Fixtures in `test/fixtures` are trimmed, anonymized real responses. Regenerate them with `node scripts/capture-fixtures.mjs <match_id>`. Never commit real account ids or Steam names.
- Be gentle with the API: it is free and community run. Tests must not hit it, only `test:contract` does.
- Comment the why, not the what.

## When the API changes

The weekly `API contract` workflow opens an issue labeled `api-drift` when the live API or its spec no longer matches. To investigate locally:

```bash
npm run check:schema   # do the generated types still match the spec?
npm run generate       # if not, regenerate and review the diff
npm run test:contract  # does the SDK still behave against the live API?
```

## Releasing

1. Bump `version` in `package.json` and `VERSION` in `src/version.ts` (a test keeps them in sync).
2. Add a `## [x.y.z] - YYYY-MM-DD` section to `CHANGELOG.md`.
3. Merge to `main`, then tag: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`.

The `Release` workflow verifies the tag against `package.json`, then creates the GitHub release from the changelog and publishes to npm and GitHub Packages in separate jobs. npm uses [trusted publishing](https://docs.npmjs.com/trusted-publishers) once `justinjd00/deadlock-sdk` with workflow `release.yml` is registered as trusted publisher on npmjs.com. An `NPM_TOKEN` secret works as a fallback. If the npm job fails, fix the setup and re-run only that job.

## Commit messages

Conventional commits, e.g. `feat: add lane matchup stats`, `fix: handle private match history`, `docs: ...`.

## Reporting issues

Include the package version, Node.js or browser version, a minimal code sample and the `code` of the `DeadlockError` if one was thrown.
