# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual caveat that before 1.0 a
minor version may break compatibility, and says so under **Changed**.

## [Unreleased]

## [0.6.0] - 2026-11-22

The audit release: every finding of the 2026-11-22 review, measured before it was changed.
`docs/followups.md` (items 20 to 31) keeps the measurement, the fix and the test for each.

### Added

- **A write lock between processes.** An MCP stdio server is started per client, so two sessions are
  two processes; the in-memory queue only ever serialised one of them. Every write now takes a lock
  file derived from the vault (inside `.git/` when there is one) around read-modify-write-commit. A
  writer that cannot get it within `VAULT_LOCK_TIMEOUT_MS` (30 s) is refused with `lock.timeout`;
  a lock left by a dead process, or held past two minutes, is taken over.
- **Recovery of a commit that failed.** `git add` and `git commit` wait out another git's
  `index.lock` for about three seconds; what still fails is recorded in a journal inside `.git/`
  and made by the next write, under its original message.
- **`vault_status`**, the eleventh tool: server version, notes and chunks indexed, repository,
  branch or detached HEAD, commits not pushed, commits pending recovery, who holds the lock,
  read-only or not. Also as structured content.
- **`limit` and `offset` on `vault_list`.**
- **`.vault-mcp.json`** at the vault root names the folders (`index`, `raw`, `wiki`, `projects`,
  `daily`, `archive`, `templates`) and the section headings the server looks up and writes. Tool
  descriptions and error messages then name the folders the vault has.
- **Operations.** JSON-line logs on stderr (`VAULT_LOG_LEVEL`) and through the MCP `logging`
  capability, with the vault path redacted; `VAULT_READ_ONLY` and `VAULT_DISABLED_TOOLS`;
  `VAULT_MAX_NOTE_BYTES`, `VAULT_LOCK_TIMEOUT_MS`, `VAULT_SCAN_TTL_MS`; a start-up report of every
  setting the server could not honour (`config.invalid`); SIGTERM and SIGINT let a write in flight
  finish, release the lock and exit 0.
- **Protocol.** Every tool has a title and annotations (`readOnlyHint`, `destructiveHint`,
  `idempotentHint`, `openWorldHint`). Every refusal carries its code as
  `structuredContent.error.code`.
- **Translated warnings.** Commit, push, move and link-rewrite warnings and the `Reason:` line of
  `vault_learn` follow `VAULT_LANG`; they used to stay in Portuguese.
- `scripts/bench.mjs`, `npm run lint` (Biome) and `npm run coverage` (with a floor).

### Changed

- **Node 22 or later** (was 20). Node 20 is past its end of life.
- **Parameter names are in English**: `title`, `context`, `domain`, `project`,
  `confirm_new_domain` on `vault_learn` and `vault_move`, and `type` on `vault_search`,
  `vault_list` and `vault_graph`. The previous names (`titulo`, `contexto`, `dominio`, `projeto`,
  `confirm_novo_dominio`, `tipo`) are still accepted and renamed on the way in; passing both
  spellings of one argument is refused.
- **An argument a tool does not declare is refused**, by name. It used to be dropped, so a mistyped
  filter answered with the whole vault.
- **`vault_learn` only appends inside the domain the learning was filed under.** A shared tag used
  to be enough, which filed a learning about one project into a note about another. The look-alike
  in the other domain is named in the reason.
- **Search results change.** A section with a heading and no body no longer becomes a chunk — on
  the vault this was built for, 36% of all chunks were empty template sections and they took 23% of
  the result slots. Ties are broken by line number, not by the chunk id as a string.
- **Answers and inputs are bounded.** `vault_list` answers 200 notes by default (1,000 at most); a
  diff relayed by a write tool stops at 20,000 characters; `content` is limited to 1,000,000
  characters, `insight` to 200,000 and `context` to 20,000.
- **The scanner refuses what is not a note.** A file above 5 MB or with a NUL byte is not indexed,
  and it, like a skipped symlink, is reported in the diagnostics.
- **A scan of a large vault is reused** for ten times what it cost, two seconds at most; a vault
  that scans in under 20 ms is never affected, and the server's own writes are seen at once.
- **Memory.** Posting lists are typed arrays. With twenty thousand synthetic notes the live heap
  went from 492 MB to 186 MB and the cold start from 4.2 s to 3.2 s.
- A vault that is not a git repository answers one sentence about it instead of git's stderr on
  every write. `VAULT_AUTO_PUSH` also accepts `true`, `yes` and `on`, and a value it does not
  recognise is reported at start-up.
- `zod` 4 and `@modelcontextprotocol/sdk` 1.32.

### Fixed

- Two servers on one vault lost updates: of 8 processes editing different parts of one note, 6 or
  7 edits survived, and every caller was told it had succeeded.
- A commit that failed left the note on disk and uncommitted for good — with `VAULT_AUTO_PUSH` it
  never left the machine.
- A wiki-link typed in NFC did not resolve to a file whose name is stored in NFD.
- A title long enough to exceed the file-name limit failed with a raw `ENAMETOOLONG`; it is now
  refused up front with `path.nameTooLong`.

### Security

- `npm audit` on the runtime dependencies went from 14 advisories (1 critical, 7 high) to none.
- CI runs with read-only permissions and actions pinned by commit, and gates on the audit, the lint
  and a coverage floor. Releases are published from a tag by a workflow, with npm provenance.
- `SECURITY.md` states the threat model and how to report a vulnerability.

## [0.5.0] - 2026-10-05

### Added

- `vault_learn` accepts `preview: true` and computes the note, the domain MOC, the knowledge index
  and the daily-note changes without writing, committing or pushing. The structured result carries
  each file's before/after text and diff, a revision hash and the preview time.
- `preview_time` and `expected_revision` make the approved write refuse with `preview_stale` when
  the plan changed since the preview.
- `force_new` creates a linked sibling note even when the topic already exists.

## [0.4.0] - 2026-10-04

### Added

- `vault_graph`: the wiki-link graph of the vault as nodes and edges, also as structured content
  under an output schema.

## [0.3.0] - 2026-08-28

### Added

- `tags` and `status` filters in `vault_search`.
- `offset` in `vault_get_note`, for a note that does not fit in one answer.
- What the scanner could not index is reported in `vault_search` and `vault_list`.

### Fixed

- Every git invocation is time-bounded and unable to prompt, not only the push.

## [0.2.1] - 2026-08-27

### Fixed

- `VAULT_LANG` now translates the body of the answers and the errors raised by the write layer, not
  only the refusals of bad input. Twenty-one places that still answered in Portuguese were closed.
- Six cross-platform defects, one of them a test that failed outside CI.

## [0.2.0] - 2026-08-27

### Added

- `VAULT_LANG` (`en` by default, or `pt`): the language of tool descriptions and server messages.
  What is written INTO the vault — commit subjects, section names — follows the vault.
- `server.json`, the MCP Registry entry.

## [0.1.1] - 2026-08-27

### Added

- `vault_move` and `vault_delete`. A move rewrites every wiki-link so that an edge that resolved
  before resolves to the same note after, and migrates the MOC entry; a delete is refused when the
  note has no committed version to restore.
- Published to npm as `@andreymudri/vault-mcp`.
- CI on Windows and macOS, a smoke test of the built server and a compatibility job.

### Fixed

- `vault_edit_note` matches a passage regardless of CRLF or LF, and writes the new text with the
  line ending the note already uses.
- Link rewriting keeps the form the author wrote (slug, root path or relative path) and updates an
  alias that repeated the old name.
- A summary cut to fit is marked with an ellipsis; the "no notes yet" placeholder of an empty MOC
  section is removed when the first entry goes in.

## [0.1.0] - 2026-08-26

### Added

- First release: seven tools (`vault_search`, `vault_get_note`, `vault_list`, `vault_backlinks`,
  `vault_write_note`, `vault_edit_note`, `vault_learn`) over an Obsidian vault, on stdio.
- Lexical BM25 retrieval over heading-delimited chunks, plus one hop of wiki-link expansion.
- `vault_learn` decides between appending to the note that covers the subject and creating one, and
  propagates to the domain MOC, the knowledge index and the daily note in a single commit.
- Optional push after each commit with `VAULT_AUTO_PUSH`.

[Unreleased]: https://github.com/andreymudri/vault-mcp/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/andreymudri/vault-mcp/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/andreymudri/vault-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/andreymudri/vault-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/andreymudri/vault-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/andreymudri/vault-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/andreymudri/vault-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/andreymudri/vault-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/andreymudri/vault-mcp/releases/tag/v0.1.0
