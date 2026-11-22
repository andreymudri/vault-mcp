# Security Policy

## Supported versions

Security fixes are released for the latest minor version only.

| Version | Supported |
|---------|-----------|
| 0.6.x   | yes       |
| < 0.6   | no        |

## Reporting a vulnerability

Please report privately, through GitHub's
[private vulnerability reporting](https://github.com/andreymudri/vault-mcp/security/advisories/new)
(the repository's **Security** tab → **Report a vulnerability**). Do not open a public issue for
something exploitable.

Include what you ran, what you expected and what happened; a note that reproduces it is ideal. You
should get a first answer within seven days.

## What this server defends, and against whom

vault-mcp is started by an MCP client on the user's own machine, over stdio, and reads and writes
one directory: the vault. It has no network listener and no authentication of its own — anyone who
can start the process already has the user's file permissions.

The caller is a language model acting on text it did not write. So the adversary this server is
built against is **content**: a clipped web page, a note, a file name or a tool argument that tries
to make the server read or write outside the vault, forge part of its own output, or hang it.

| Threat | Defence |
|---|---|
| A path argument that escapes the vault (`../`, absolute paths) | Every write goes through `guardedPath`: lexical containment, then containment after resolving every symlink on the way. Reads are served from the scanner's index, which only ever holds paths found by walking the vault. |
| A symlink or hard link that points outside the vault | Symlinks are never followed by the scanner and are refused as write targets. A file with more than one hard link is refused on both the read and the write path. Both are reported in the diagnostics instead of being dropped silently. |
| Writing into `.git/`, `.obsidian/`, `node_modules/`, `_templates/` or the archive | Refused by segment, after symlink resolution. |
| Vault content that forges a line of server output (terminal escapes, bidi controls, alternate line terminators) | Search snippets are quoted line by line and escaped; relayed diffs and every path, title and message the server prints are escaped. `vault_get_note` returns the body raw by design — see "Known limitations" in the README. |
| A tool argument or a note built to stall the single-threaded server | Queries, tokens, the suggestion search, frontmatter rendering, diffs, tool inputs and tool outputs are all bounded. Files above `VAULT_MAX_NOTE_BYTES` and binary files are not indexed. |
| Shell injection through a path or a title | git is run with `execFile` and literal pathspecs, never through a shell. Every git invocation is time-bounded and cannot prompt. |
| Two servers writing the same vault | A cross-process lock around every write, a retry on `index.lock`, and a journal of commits that failed. |
| A dependency published by someone else | Runtime dependencies are three, and `npm audit` on them gates CI. Releases are published by a workflow, through OIDC and with npm provenance, from a job that installs no dependency and runs no test: the code of third parties runs in a job with no publishing identity. Actions are pinned by commit, and the one binary the release downloads is pinned and signature-checked. |

## What it does not defend

- **The vault's own git hooks.** `git commit` runs whatever `pre-commit` and `commit-msg` hooks the
  vault's owner installed. They are bounded by a timeout, not sandboxed.
- **Other writers.** Obsidian, a sync client or a `git checkout` can change a file between this
  server reading and writing it. The lock only binds processes that take it.
- **What the model does with what it reads.** A note can contain instructions. The server marks
  quoted note text as such; whether the client's model follows it is outside this process.
- **`VAULT_AUTO_PUSH`.** When it is on, every write is pushed to whatever remote the vault's branch
  tracks. It is off by default because it is the only thing the server does that leaves the machine.
