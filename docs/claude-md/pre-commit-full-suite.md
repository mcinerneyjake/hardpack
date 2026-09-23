# Record — why the pre-commit hook runs the full suite

> **A record, not instructions.** Written 2026-09-22 for `tkt-a4b482018a8f` (epic
> `tkt-5d922d998de4`). It explains a decision; it does not govern anything. **`CLAUDE.md` is the only
> instruction file; where the two disagree, `CLAUDE.md` wins**, and every measurement below is dated
> external state — re-run it rather than quoting it.

## The decision

`.husky/pre-commit` ends in `npm run typecheck && npm run lint && npm test`, and `npm test` is
`vitest run` — every suite, on every commit. The obvious speed-up, selecting tests from the staged
files (`vitest related <staged>`, or lint-staged driving it), is rejected. It would not be slower by
some margin. It would be **blind to the changes the gate most needs to see**.

## Why selection is blind by construction

`vitest related` walks the **import graph** from each test file. The suite that catches permission
and guard-wiring regressions does not import what it guards. `.claude/settings.audit.test.mjs`
imports only `vitest` and Node builtins, reads `.claude/settings.json` with `readFileSync` and drives
the launcher hooks as child processes. A staged settings file or launcher hook therefore has no edge
to any test, and selection picks none.

It then **passes**. `vitest related` sets `passWithNoTests` to `true` unless you override it
(`node_modules/vitest/dist/chunks/cac.*.js`, `runRelated`: `argv.passWithNoTests ??= true`). So the
commit most likely to weaken a guard is the one a selective gate waves through, green and silent.

## Measured 2026-09-22 (vitest via ticket-workflow v0.28.0, branch off `64aeff5`)

| staged path | `vitest related <path> --run` |
|---|---|
| `.claude/settings.json` | `No test files found, exiting with code 0` |
| `.claude/hooks/guard-bash.mjs` (launcher) | `No test files found, exiting with code 0` |
| `.claude/hooks/guard-ticket.mjs` (launcher) | `No test files found, exiting with code 0` |
| `src/lib/blockers.ts` (positive control) | 1 file, 21 tests |
| `.claude/hooks/guard-unattended-merge.mjs` | 5 files |
| `scripts/probe/adoption-markers.mjs` | 1 file |
| `vitest.config.ts` | 2 files |

The last three rows correct the ticket that commissioned this record. It said `vitest.config.test`
and the probe CLIs have no import edge. In fact each probe suite imports its own module as well as
spawning it, `vitest.config.test` imports `./vitest.config.js`, and the one hook with its own suite
is selected. The blind spot is `.claude/settings.json` and the launcher hooks, plus anything else a
test only reads or spawns. That is narrower than the ticket claimed, but it is exactly the guard
wiring, which is the reason for keeping the full suite.

## What it costs, and where that is paid down

The full gate is minutes, not seconds, and concurrent sessions contend for it. That cost is handled
by the machine-wide run slot (`holdTestRun` in `vitest.config.ts`) and by `CLAUDE.md`'s *Shared test
infrastructure* rule, not by narrowing the gate. In auto modes the skill avoids paying it twice by
asking `scripts/probe/hook-gate.mjs` what the hook already covers (`tkt-ea501e6d1a1d`).

Related: `tkt-48b7083cfa07` (the gate command list drifting between docs, hook and CI, filed against
copart-filter) and `tkt-1d40f809d72a` (session-startup docs).
