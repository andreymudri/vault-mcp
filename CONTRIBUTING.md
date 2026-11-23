# Contributing

## Setup

Node 26 for development (the suite relies on the runtime's own type stripping); the published
package runs on Node 22 and later.

```bash
npm ci
npm test            # typecheck over src/ and test/, then the suite
npm run lint        # Biome, warnings are errors
npm run coverage    # the suite again, with the coverage floor
npm run build       # compiles src/ to dist/
npm run smoke       # starts the built server and asks it for its tools
node scripts/bench.mjs 5000   # synthetic vault: cold start, warm search, memory
```

`dist/` is what a registered server actually runs. After changing `src/`, build and restart the
client session.

## How changes are made here

- **Test first.** A change of behaviour comes with a test that was seen failing for the right
  reason. Where the defect is a gap in coverage rather than a wrong answer, the test is checked by
  mutation: undo the fix, watch it fail.
- **Measure before deciding.** Decisions in this codebase carry the number that justified them, in
  the comment next to the code. `docs/followups.md` is the record of each defect, its measurement,
  its fix and the test that pins it.
- **Two processes are the normal case.** An MCP stdio server is started per client. A change to the
  write path needs a test in `test/cross-process.test.ts`, which starts real processes.
- **Every string the server says goes through the catalog.** `src/i18n/messages.ts` holds both
  languages and the types force them to have the same keys. Errors raised deep in the write layer
  carry a code and are translated at the tool boundary. What the server WRITES into the vault
  (commit subjects, section names) is the vault's language and is not translated.
- **Bounded by default.** A new input, output or loop over vault content states its ceiling.

## Conventions

- TypeScript strict, ESM, imports with the `.js` suffix. `erasableSyntaxOnly` is on: no enums, no
  constructor parameter properties.
- Code comments in English. Commit messages in Portuguese, conventional-commits style
  (`feat(scope): …`, `fix(scope): …`).
- No new runtime dependency without a very good reason: there are three.

## Releasing

A release is a commit on `main` that changes the version. Nobody runs a command after that.

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` to a new version heading.
2. Set that version in `package.json`, in `package-lock.json` (twice) and in `server.json` (twice).
   `node scripts/release-check.mjs` says whether they agree, and the suite runs it too.
3. Open a PR, and merge it.

On every push to `main` the `Release` workflow asks whether the version in `package.json` has a
tag. When it does not, it runs the lint, the audit, the suite and the smoke test on that commit,
packs it, and then, in a separate job that installs nothing and holds the only publishing identity:

- publishes the tarball to npm through trusted publishing (OIDC, no token), with provenance;
- creates the tag `vX.Y.Z` on the verified commit and the GitHub Release, from the changelog section;
- publishes `server.json` to the MCP Registry.

Every step checks whether it was already done, so a release that stopped halfway is finished with
**Re-run failed jobs** on the same run. Running the workflow by hand from the Actions tab does the
same, from `main` only, and only while `main` is still at the commit that went to npm: a version
already on npm is accepted only if it is byte for byte the tarball of this run, because the tag is
about to be put on this commit.

It publishes under the `latest` dist-tag, so a prerelease version (`1.0.0-rc.1`) is refused by the
check rather than published.

Two things it depends on that live outside the repository:

- The package's **trusted publisher** on npm, registered once by the package owner:
  `npm trust github @andreymudri/vault-mcp --file release.yml --repo andreymudri/vault-mcp --allow-publish`.
  It names this workflow file, so renaming `release.yml` breaks publishing until it is registered
  again, and npm drops a registration that publishes nothing within two days.
- The pinned `MCP_PUBLISHER_VERSION` in the workflow, which Dependabot does not track. Raise it by
  hand when the registry asks for a newer client.
