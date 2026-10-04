import type { Note } from '../types.js';

/**
 * In-memory graph of wiki-links between notes.
 *
 * `build` clears any previous state before repopulating, so a full rebuild after a scanner
 * refresh is the normal operation — the graph is cheap enough that incremental update isn't
 * worth the complexity.
 */
export class LinkGraph {
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly incoming = new Map<string, Set<string>>();

  /**
   * Populates `outgoing` and `incoming` from `note.links`. `note.brokenLinks` is deliberately
   * ignored: a link that resolved to nothing cannot contribute an edge.
   */
  build(notes: Note[]): void {
    this.outgoing.clear();
    this.incoming.clear();
    for (const note of notes) {
      for (const target of note.links) {
        addEdge(this.outgoing, note.path, target);
        addEdge(this.incoming, target, note.path);
      }
    }
  }

  /** Vault-relative paths of notes that link to `path`. */
  backlinks(path: string): string[] {
    return [...(this.incoming.get(path) ?? [])];
  }

  /** Vault-relative paths `path` links out to. */
  outLinks(path: string): string[] {
    return [...(this.outgoing.get(path) ?? [])];
  }

  /**
   * Every directed edge as `[source, target]`, one per pair (the Sets already deduplicate a note
   * that links the same target twice), sorted by source and then target in code-unit order.
   *
   * Sorted so two builds over the same notes answer the same list whatever order the scanner
   * handed them in: `vault_graph` returns this to a client that diffs and draws it.
   */
  edges(): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const [source, targets] of this.outgoing) {
      for (const target of targets) out.push([source, target]);
    }
    return out.sort((a, b) => compare(a[0], b[0]) || compare(a[1], b[1]));
  }

  /** Union of `outLinks(path)` and `backlinks(path)`, deduplicated, excluding `path` itself. */
  neighbors(path: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const candidate of [...this.outLinks(path), ...this.backlinks(path)]) {
      if (candidate === path || seen.has(candidate)) continue;
      seen.add(candidate);
      out.push(candidate);
    }
    return out;
  }
}

function addEdge(map: Map<string, Set<string>>, from: string, to: string): void {
  const bucket = map.get(from);
  if (bucket === undefined) map.set(from, new Set([to]));
  else bucket.add(to);
}

/** Code-unit order, the same on every platform and locale (`localeCompare` is neither). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
