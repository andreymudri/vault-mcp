---
name: phase-gate
description: Run the adversarial review gate on a branch, worktree, or diff range before declaring a phase done. Four parallel review lenses, an independent refutation round over every finding AND every claimed fix, mutation proof that each fix is load-bearing, bounded commands, and a machine-readable gate-result.json. Triggers - phase gate, review gate, "is this ready to merge", before integrating a worktree branch, before cutting a release.
---

# Phase gate

A gate that rubber-stamps is worse than no gate: it converts "unreviewed" into "approved" at no
cost. Everything below exists to make PASS expensive.

## Inputs

| Input | Meaning | If missing |
|---|---|---|
| `TARGET` | branch, worktree path, or diff range (`v0.1.1..HEAD`) | ask; never guess |
| `SPEC` | what this phase was supposed to do | ask; a gate with no spec can only check for bugs, not for *done* |
| `BUDGET` | severity budget, e.g. `high=0, medium<=3` | default `high=0`; state the default you used |

Record all three verbatim in the gate record. A gate whose scope is reconstructed afterwards is a
gate that can be argued with.

## Non-negotiables

These are not style preferences. Each one is here because skipping it has already produced a
wrong PASS.

1. **An agent's summary is not evidence.** Read the full diff yourself before any verdict. A
   subagent reporting "fixed, tests pass" is a claim, not a result.
2. **Never declare PASS from a self-report.** PASS requires: you read the diff, the suite ran
   green under an explicit timeout, and every finding has a refutation verdict.
3. **A test that never failed proves nothing.** See mutation proof (step 4).
4. **On any doubt about a destructive suggestion, don't suggest it.** Verify the target is what
   you think it is first — see resource guards (step 5).
5. **Never print a secret.** Not to debug, not to verify. Verify by length or truncated hash.
   Never invoke a credential helper with `get`. If one is exposed: stop, say so, tell the user to
   rotate it now.

## 0. Preflight

Run the `env-preflight` skill if it has not run this session. The gate runs commands; knowing in
advance that sudo hangs, that `/tmp` is near a quota, or that CI does not cover Windows changes
what the lenses can conclude.

## 1. Read the diff yourself

```bash
timeout 60 git diff --stat <TARGET>
timeout 120 git diff <TARGET>
```

Build a file-by-file table: *file | what changed | how it is verified (test name or command)*.
Any row whose third column is empty is itself a finding — untested change, severity at least
medium.

Do this **before** dispatching. The lenses are a second opinion on your reading, not a substitute
for it.

## 2. Dispatch four lenses, in parallel

One message, four `Agent` calls, so they actually run concurrently. Give each the diff range, the
spec, and its lens *only* — a reviewer told to look at everything looks at nothing.

Every lens returns findings as `{severity, file, line, claim, reproduction, suggested_fix}`.
**A finding with no `reproduction` is not a finding**; send it back or drop it.

- **(a) Correctness & edge cases.** Boundaries, empty and single-element inputs, error paths,
  concurrency, ordering assumptions, integer/precision. Does the change do what `SPEC` says, and
  does it still do what the code did before?
- **(b) Security & data destruction.** Absolute paths; writes that can escape the repo or vault
  root; anchors derived from attacker-controlled input; shell interpolation; `rm`/truncate/force
  paths; symlink following; anything that can lose user data. Ask of every write: *what is the
  worst path this can resolve to, and who controls it?*
- **(c) Cross-platform.** CRLF assumptions, `split('\n')` on content that may carry `\r`, path
  separators, POSIX-only calls (`mkfifo`, mode bits, process groups, negative-pid kills),
  filenames illegal on NTFS (`*`, `?`, `:`, newline), symlinks in tests, and whether CI actually
  covers the platforms being claimed.
- **(d) Test quality & coverage.** Are the new tests load-bearing? Do they cover the default
  branch, the timeout branch, and the cleanup/teardown lifecycle? Is any assertion coupled to a
  toolchain internal or to a language/locale default rather than to behavior? Is there a test that
  would pass with the implementation deleted?

## 3. Refutation round

For **every finding** and **every claimed fix**, spawn an independent agent whose only job is to
**disprove** it, working from the code rather than from the claim. It must reproduce from scratch.

- Verdict `CONFIRMED` requires the refuter reproducing the problem itself.
- Verdict `REFUTED` kills the finding; record it with the reason.
- A **fix** claimed without reproducible evidence that the original problem is gone is rejected
  and sent back — "tests pass" is not that evidence unless a test covers the specific problem.
- Prompt the refuter to default to `REFUTED` under uncertainty. The asymmetry is deliberate: a
  false finding costs a fix round, a false PASS ships.

Watch for **false equivalence** — an agent claiming two code paths are the same when only their
happy paths match. Make it name the inputs where they diverge, or reject the claim.

## 4. Fix, then prove the fix is load-bearing

For each confirmed finding: write the failing test **first**, watch it fail for the right reason
(assertion, not import error), then fix.

Then the mutation proof, which is the step that makes the test mean something:

```bash
git stash push -- <file-with-the-fix>     # or revert just the fix hunk
timeout 300 <test command for that test>  # MUST go red
git stash pop
timeout 300 <test command for that test>  # MUST go green
```

If reverting the fix leaves the suite **green**, the test does not exercise the fix. Reject it and
write a real one. Record `mutation_proof: {reverted: <sha|hunk>, went_red: true|false}`.

## 5. Resource guards

- **Every** build/test command gets an explicit `timeout`. An unbounded run behind an infinite
  loop saturates the machine and the gate never returns.
- Set a hard wall-clock cap for the whole gate; on exceeding it, stop and record `TIMEOUT`, never
  a partial PASS.
- Report timings from real command output. Never estimate.
- Clean up in a `trap`, so an interrupt does not leak worktrees:

```bash
cleanup() { git worktree prune; rm -rf "$SCRATCH"; }
trap cleanup EXIT INT TERM
```

- Before PASS, verify no orphans: `git worktree list` and a process scan.
  **Match the executable, never the whole argument string** — `\bnode\b` against full args flags
  chromium via `--render-node-override`, because `-` is a word boundary.
  **A long-lived node process is usually not garbage.** MCP servers are long-lived by design and
  live as long as the session; killing one tears out the tools of the session running the gate.
  Classify as live on any doubt, and re-read the full command line before proposing any kill.

## 6. Gate record

Write `gate-result.json` **outside the working tree** (session scratchpad). It describes this run,
not the repository, and left in the tree it becomes an untracked file someone commits.

```json
{
  "target": "v0.1.1..HEAD", "spec": "...", "budget": {"high": 0, "medium": 3},
  "verdict": "PASS | FAIL | TIMEOUT",
  "diff_read_by_orchestrator": true,
  "suite": {"command": "timeout 300 npm test", "passed": 1187, "failed": 0, "wall_clock_s": 8.7},
  "findings": [{
    "id": "F1", "lens": "security", "severity": "high",
    "file": "src/write/writer.ts", "line": 541,
    "claim": "...", "reproduction": "...",
    "refutation": {"verdict": "CONFIRMED", "by": "independent agent", "evidence": "..."},
    "fix": {"commit": "abc1234", "test": "test/x.test.ts:12"},
    "mutation_proof": {"reverted": "abc1234", "went_red": true}
  }],
  "orphans": {"worktrees": [], "processes": []},
  "unverified": ["anything you could not check, and why"]
}
```

`unverified` is mandatory and must not be empty when something was skipped. A gate that hides its
blind spots is the failure mode this whole file exists to prevent.

## 7. Verdict

**PASS** only when: zero findings above budget survive refutation; every fix has a mutation proof
that went red; the suite ran green under an explicit timeout; you personally read the diff; and no
orphans remain.

Otherwise **FAIL**, with the exact next action. Say plainly what was not checked — the gate's
value is that its PASS is believable, and that only holds if its FAIL is honest.
