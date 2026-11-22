#!/usr/bin/env node
/**
 * Decides whether the version in `package.json` may be published, and prints it:
 * `node scripts/release-check.mjs [--root <dir>]`.
 *
 * The release is automatic — a version merged into `main` with no tag yet is published to npm,
 * tagged, released on GitHub and published to the MCP Registry — and none of that can be taken
 * back: a version number spent on npm is spent. So everything that has to agree before the first
 * of those steps is checked here, where a disagreement costs a red job instead of a version.
 *
 * It prints the version on stdout and nothing else, or every problem on stderr and exits 1. Every
 * problem, not the first: the fix is one commit either way, and a check that reports them one
 * run at a time turns it into several.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.indexOf('--root');
const root = rootFlag === -1 ? fileURLToPath(new URL('..', import.meta.url)) : (process.argv[rootFlag + 1] ?? '');
const read = (name) => readFileSync(join(root, name), 'utf8');
const json = (name) => JSON.parse(read(name));

const pkg = json('package.json');
const lock = json('package-lock.json');
const server = json('server.json');
const changelog = read('CHANGELOG.md');

const version = String(pkg.version ?? '');
const problems = [];
const same = (what, actual, expected) => {
  if (actual !== expected) problems.push(`${what} is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
};

// Plain x.y.z. The tag is `v` plus this. A prerelease is refused HERE rather than accepted and
// left to fail later: the workflow publishes under the `latest` dist-tag, npm will not take a
// prerelease without a `--tag`, and a version that passes this check, is verified and packed, and
// only then stops at npm does so again on every push.
if (/^\d+\.\d+\.\d+-[0-9A-Za-z.-]+$/.test(version)) {
  problems.push(`package.json: version ${JSON.stringify(version)} is a prerelease, which this pipeline does not publish`);
} else if (!/^\d+\.\d+\.\d+$/.test(version)) {
  problems.push(`package.json: version ${JSON.stringify(version)} is not a semantic version`);
}

// The lockfile carries the version twice, and `npm ci` in CI installs from it.
same('package-lock.json: version', lock.version, version);
same('package-lock.json: packages[""].version', lock.packages?.['']?.version, version);

// `server.json` is what the MCP Registry publishes. It names the server's own version and the
// version of the npm package a client is told to install; both are this one.
same('server.json: version', server.version, version);
same('server.json: packages[0].version', server.packages?.[0]?.version, version);
same('server.json: packages[0].identifier', server.packages?.[0]?.identifier, pkg.name);

// The registry proves ownership of a name by reading `mcpName` from INSIDE the npm tarball. If the
// two differ, npm publishes and the registry then refuses — with the version already spent.
same('server.json: name (must equal the mcpName in package.json)', server.name, pkg.mcpName);

// The notes of the GitHub Release are this section. No section means the changelog step was
// skipped, and an empty one means it was started and not finished.
const lines = changelog.split(/\r?\n/);
const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
if (start === -1) {
  problems.push(`CHANGELOG.md has no section for ${version}`);
} else {
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^## \[/.test(line) || /^\[[^\]]+\]: /.test(line));
  if ((end === -1 ? rest : rest.slice(0, end)).join('\n').trim() === '') {
    problems.push(`CHANGELOG.md: the section for ${version} is empty`);
  }
}

// npm's trusted publishing compares the package's `repository.url` with the repository whose
// workflow is publishing, and refuses a mismatch at publish time. Checked here when the workflow
// says which repository it is running in.
const publishing = process.env.GITHUB_REPOSITORY;
if (publishing !== undefined && publishing !== '') {
  const url = String(pkg.repository?.url ?? pkg.repository ?? '');
  const declared = /github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1];
  if (declared !== publishing) {
    problems.push(`package.json: repository is ${JSON.stringify(url)}, but this is being published from ${publishing}`);
  }
}

if (problems.length > 0) {
  process.stderr.write(`release-check: ${version} cannot be released\n${problems.map((p) => `  - ${p}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`${version}\n`);
