import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// The suites that drive real subprocesses (git commits through the guard hooks, the probe CLIs,
// the terminal setup scripts). They are split into their own project so they can run at a
// constrained worker width: at full width, four concurrent `npm test` runs from separate
// worktrees oversubscribe 14 cores badly enough that they fail as *timeouts* while passing in
// isolation — a false negative about guard behaviour, measured 2026-09-21 on tkt-d5957c036ff8
// (uncapped: 0 timeouts solo, 4 at two-way, 26-32 at four-way; every failing file was in this
// list and none outside it).
//
// Transcribed lists rot, so vitest.config.test.ts REGENERATES this set — by the `child_process`
// (or execa/tinyexec/cross-spawn/zx) IMPORT, not by call sites, which matched prose and put a
// file here on the strength of a comment — and fails if the two disagree. A new subprocess suite
// must be added here or the gate goes red. That file also pins the exclude below, without which
// both projects collect these suites and the uncapped one runs them a second time at full width.
const SUBPROCESS_SUITES = [
  '.claude/hooks/guard-unattended-merge.test.mjs',
  '.claude/settings.audit.test.mjs',
  'agent/eval/fixtureCorpus.test.ts',
  'analysis/build-economics/analyze-hardpack-savings.test.mjs',
  'repoHygiene.test.mjs',
  'scripts/night-run.test.mjs',
  'scripts/probe/adoption-markers.test.mjs',
  'scripts/probe/clean-room.test.mjs',
  'scripts/probe/hook-gate.test.mjs',
  'scripts/probe/merged-branches.test.mjs',
  'scripts/probe/nul-bytes.test.mjs',
  'scripts/probe/repo-stats.test.mjs',
  'scripts/probe/retro-queue.test.mjs',
  'scripts/probe/stale-in-progress.test.mjs',
  'scripts/probe/vacuous-ratchet.test.mjs',
  'scripts/review-preconditions.test.mjs',
  'scripts/terminal-setup-cred.test.mjs',
  'scripts/terminal-setup-github.test.mjs',
  'server/packageContract.test.ts',
];

// Measured, four concurrent runs on 14 cores (tkt-d5957c036ff8): uncapped 26-32 timeouts, 4 at
// cap 3, 8 at cap 2 — tightening further serializes this phase for longer and widens the window
// rather than narrowing it. Two-way is fully green at 3. Not a free win: a distinct groupOrder
// stops the two projects overlapping, so a solo run pays ~8s (36.4s -> 44.6s).
//
// Clamped, not absolute: an uncapped project gets `availableParallelism() - 1`, which is 1 on CI's
// 2-vCPU `ubuntu-latest`. A bare 3 would therefore be a *floor* there, tripling subprocess pressure
// on the weakest host this runs on — the opposite of the intent.
const SUBPROCESS_MAX_WORKERS = Math.max(1, Math.min(3, availableParallelism() - 1));

// `.claude/worktrees/**` holds full checkouts (CLAUDE.md tells concurrent sessions to make one),
// so without it vitest collects every suite twice AND tries to run the worktree's Playwright
// specs — reddening the husky gate from the main checkout whenever a worktree merely exists
// (tkt-17d81c74b662). The bare `e2e/**` only covers this checkout's own.
// `.tmp-test` is this repo's in-tree fixture root (gitignored). Without excluding it vitest
// COLLECTS fixture files named `*.test.ts` that other suites write mid-run — measured: a spawner
// planted there ran in the uncapped project while the audit stayed green.
//
// `**/` on the last two is load-bearing, not decoration. There are TWO `.tmp-test` directories:
// the repo root's, and `scripts/.tmp-test`, which `scripts/probe/hook-gate.test.mjs` derives two
// `dirname`s up from its own location. A root-anchored `.tmp-test/**` misses the nested one, and
// a planted spawner there was collected into the uncapped project with the gate green. Nested
// `node_modules` has the same shape. `e2e` and `.claude/worktrees` stay root-anchored on purpose —
// those exist only at the root, and the walk matches them by relative path, not basename.
const EXCLUDE = ['e2e/**', '**/node_modules/**', '.claude/worktrees/**', '**/.tmp-test/**'];

// Vitest projects do NOT inherit the root's `test` options — measured on tkt-d5957c036ff8: under
// a projects split the root's setupFiles never ran (`setup 0ms`) and a 6.5s test died with
// "Test timed out in 5000ms", i.e. the 20s timeout silently reverted to vitest's default. Both
// regressions are invisible to a test that reads the ROOT config object, which still holds the
// right values. So every project restates these, and vitest.config.test.ts asserts per project.
const SHARED = {
  environment: 'node' as const,
  // Vitest's 5s default is not a budget for real subprocesses: the guard-bash end-to-end case
  // measured 5232ms purely from added load elsewhere in the run, so it failed as a *timeout*
  // while passing in isolation. 20s still catches a genuine hang (tkt-0993b12650a1).
  testTimeout: 20_000,
  // Pins EMBED_CACHE_PATH away from the real board cache — see the file's comment.
  setupFiles: ['./test-support/vitest.setup.ts'],
  exclude: EXCLUDE,
};

export default defineConfig({
  test: {
    ...SHARED,
    projects: [
      {
        test: {
          ...SHARED,
          name: 'inproc',
          exclude: [...EXCLUDE, ...SUBPROCESS_SUITES],
          // Distinct groupOrder is REQUIRED, not cosmetic: vitest throws
          // "have different 'maxWorkers' but same 'sequence.groupOrder'" when two projects
          // differ in maxWorkers at the same order (measured, tkt-d5957c036ff8).
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          ...SHARED,
          name: 'subproc',
          include: SUBPROCESS_SUITES,
          maxWorkers: SUBPROCESS_MAX_WORKERS,
          sequence: { groupOrder: 1 },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      // Scope coverage to the testable logic layers (per CLAUDE.md's testing
      // table). React components and transport entrypoints carry no
      // unit-testable logic; the agent module is still under phased
      // construction and not yet in the testing table (its own tests run, but
      // it is excluded from the gate for now). So the threshold reflects real,
      // asserted behaviour — not UI glue or in-flight code.
      // server/tickets.ts, server/events.ts, server/validation.ts and
      // mcp/handlers.ts are excluded: they are thin re-export shims over the
      // ticket-workflow package (tkt-66f0e22efd5e), which covers that logic in
      // its own CI gate. As shims they declare no functions, so the perFile
      // thresholds below would fail them for having nothing to cover. Upstream's
      // gate runs against upstream SOURCE, never the pinned tag, so
      // server/packageContract.test.ts asserts the pinned build through the shim
      // (tkt-6aa717c1c9ec).
      include: [
        'server/index.ts',
        'server/stream.ts',
        'server/completion.ts',
        'server/ticketWatcher.ts',
        'server/lib/**/*.ts',
        'server/middleware/**/*.ts',
        'server/schemas/**/*.ts',
        'shared/constants.ts',
        'src/lib/**/*.ts',
      ],
      reporter: ['text', 'html'],
      // Enterprise-floor gate: catches a regression in coverage discipline
      // without pinning the suite to its current high-water mark (~97%/94%).
      // A floor, not a target — see CLAUDE.md testing guidance.
      thresholds: {
        // perFile so an untested new function can't hide behind the aggregate
        // (~97%) average — each included layer must independently clear the floor.
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
