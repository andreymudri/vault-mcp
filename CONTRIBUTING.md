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

1. Move the entries under `## [Unreleased]` in `CHANGELOG.md` to a new version heading.
2. Set that version in `package.json` and in `server.json` (twice there).
3. Commit, tag `vX.Y.Z`, push the tag.

The `Release` workflow checks that the tag matches `package.json`, runs the lint, the audit, the
suite and the smoke test, publishes to npm with provenance through trusted publishing, and creates
the GitHub Release from the changelog section.
