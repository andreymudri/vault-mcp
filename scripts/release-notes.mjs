#!/usr/bin/env node
/**
 * Prints the CHANGELOG section of one version: `node scripts/release-notes.mjs v0.6.0`.
 *
 * The release workflow hands the output to `gh release create`, so the notes of a GitHub Release
 * are the changelog entry and never a second, hand-written summary that drifts from it. A version
 * with no entry is an error with a message, not an empty release: the changelog is written before
 * the tag is pushed, and a missing section means that step was skipped.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const version = (process.argv[2] ?? '').replace(/^v/, '');
if (version === '') {
  process.stderr.write('usage: release-notes.mjs <version>\n');
  process.exit(2);
}

const changelog = readFileSync(fileURLToPath(new URL('../CHANGELOG.md', import.meta.url)), 'utf8');
const lines = changelog.split(/\r?\n/);
const isHeading = (line) => /^## \[/.test(line);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  process.stderr.write(`release-notes: CHANGELOG.md has no section for ${version}\n`);
  process.exit(1);
}

const rest = lines.slice(start + 1);
const end = rest.findIndex((line) => isHeading(line) || /^\[[^\]]+\]: /.test(line));
const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
if (body === '') {
  process.stderr.write(`release-notes: the CHANGELOG.md section for ${version} is empty\n`);
  process.exit(1);
}
process.stdout.write(`${body}\n`);
