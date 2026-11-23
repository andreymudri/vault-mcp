

/**
 * The ceilings on what a tool returns and on what it accepts, in one place so that each can be
 * read next to the others.
 *
 * Split out of `server/tools.ts`, which re-exports what was public there.
 */

/** How much of a note's body `vault_get_note` returns before cutting it. */
export const MAX_NOTE_CHARS = 20_000;

/**
 * How many characters of a diff a write tool relays.
 *
 * A diff is as long as what was written, and what was written goes into the caller's context a
 * second time: measured on 0.5.0, a 2 MB `insight` came back as an answer of 2,001,083 characters.
 * The cap is on the ANSWER — the note is whole on disk, and the marker says so.
 */
export const MAX_DIFF_CHARS = 20_000;

/**
 * How many notes `vault_list` answers with when the caller names no limit, and the most it takes.
 *
 * It used to answer with every note that matched. On the real vault (709 notes) that was 135,051
 * characters with no filter, and 2.3 MB on a synthetic one of twenty thousand notes — an inventory
 * call that silently costs the caller its whole context window.
 */
export const LIST_DEFAULT_LIMIT = 200;

export const LIST_MAX_LIMIT = 1_000;

/**
 * Ceilings on what a write tool accepts.
 *
 * A megabyte is far past any note a person or an agent writes — the largest in the real vault is
 * 39 KB — and the server otherwise holds whatever it is handed several times over: the argument,
 * the composed note, the diff of the two. An `insight` is one paragraph or a few, and it is also
 * tokenized for the duplicate check, so its ceiling is tighter.
 */
export const MAX_WRITE_CHARS = 1_000_000;

export const MAX_INSIGHT_CHARS = 200_000;

export const MAX_CONTEXT_CHARS = 20_000;
