# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) — with the usual caveat that before 1.0 a
minor version may break compatibility, and says so under **Changed**.

## [Unreleased]

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

[Unreleased]: https://github.com/andreymudri/vault-mcp/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/andreymudri/vault-mcp/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/andreymudri/vault-mcp/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/andreymudri/vault-mcp/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/andreymudri/vault-mcp/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/andreymudri/vault-mcp/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/andreymudri/vault-mcp/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/andreymudri/vault-mcp/releases/tag/v0.1.0
