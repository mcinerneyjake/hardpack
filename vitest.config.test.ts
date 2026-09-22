import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import picomatch from 'picomatch';
import { describe, it, expect } from 'vitest';
import config from './vitest.config.js';

// Pins the collection excludes and the subprocess worker cap (the .claude/settings.audit.test.mjs
// precedent: audit the config that nothing else would catch drifting). Deleting the worktrees glob
// only shows up as a red gate on a machine that happens to have a worktree — never in CI, which
// clones fresh (tkt-17d81c74b662).
//
// Everything here asserts the PROJECT configs, not the root. Once `projects` is defined the root's
// collection options stop governing collection, so a root-level assertion would keep passing while
// the suites it describes ran under something else entirely (tkt-d5957c036ff8).

type ProjectTest = {
  name?: string;
  include?: string[];
  exclude?: string[];
  testTimeout?: number;
  setupFiles?: string[];
  maxWorkers?: number | string;
  sequence?: { groupOrder?: number };
};

function projectConfigs(): ProjectTest[] {
  const out: ProjectTest[] = [];
  for (const project of config.test?.projects ?? []) {
    if (typeof project !== 'object' || project === null) continue;
    if (!('test' in project)) continue;
    const { test } = project;
    if (typeof test === 'object' && test !== null) out.push(test);
  }
  return out;
}

function projectNamed(name: string): ProjectTest {
  const found = projectConfigs().find((p) => p.name === name);
  if (!found) throw new Error(`no vitest project named "${name}" — the split was renamed or removed`);
  return found;
}

describe('vitest projects', () => {
  it('defines exactly the inproc and subproc projects', () => {
    expect(projectConfigs().map((p) => p.name).sort()).toEqual(['inproc', 'subproc']);
  });
});

describe('vitest collection excludes', () => {
  // Per project: with `projects` defined, the root's exclude no longer governs collection.
  it.each(['inproc', 'subproc'])(
    'project %s excludes worktree checkouts, this checkout’s e2e specs, and node_modules',
    (name) => {
      const exclude = projectNamed(name).exclude ?? [];
      expect(exclude).toContain('.claude/worktrees/**');
      expect(exclude).toContain('e2e/**');
      // `**/` matters: nested `node_modules` and `scripts/.tmp-test` both exist in this repo.
      expect(exclude).toContain('**/node_modules/**');
      expect(exclude).toContain('**/.tmp-test/**');
    },
  );

  // `.claude/worktrees/*` would match the worktree dir but not the suites nested inside it, which is
  // the whole point — so the recursive form is the invariant, not merely "some worktrees pattern".
  it.each(['inproc', 'subproc'])('project %s matches recursively, not just the worktree directory', (name) => {
    const worktreeGlobs = (projectNamed(name).exclude ?? []).filter((p) => p.includes('worktrees'));
    expect(worktreeGlobs).not.toHaveLength(0);
    for (const glob of worktreeGlobs) expect(glob.endsWith('/**')).toBe(true);
  });
});

// Vitest projects do NOT inherit the root's `test` options. Measured on tkt-d5957c036ff8: under a
// projects split the root's setupFiles never ran and a 6.5s test died with "Test timed out in
// 5000ms". Both regressions leave the ROOT config object untouched, so only a per-project
// assertion can see them — which is the whole reason these two blocks are here.
describe('subprocess suites get a realistic timeout', () => {
  it.each(['inproc', 'subproc'])('project %s raises testTimeout well above the 5s default', (name) => {
    expect(projectNamed(name).testTimeout).toBeGreaterThanOrEqual(15_000);
  });
});

describe('every project keeps the embedding-cache pin', () => {
  // Dropping this resolves EMBED_CACHE_PATH to the REAL board cache and prunes it to a stub
  // corpus — destroying a developer's warm cache (test-support/vitest.setup.ts).
  it.each(['inproc', 'subproc'])('project %s loads the setup file', (name) => {
    expect(projectNamed(name).setupFiles).toContain('./test-support/vitest.setup.ts');
  });
});

describe('subprocess worker cap', () => {
  it('constrains the subproc project to a small positive worker count', () => {
    const { maxWorkers } = projectNamed('subproc');
    expect(typeof maxWorkers).toBe('number');
    expect(maxWorkers).toBeGreaterThanOrEqual(1);
    // Above ~4 the cap stops bounding anything on a 14-core machine under four-way concurrency,
    // which is the case it exists for.
    expect(maxWorkers).toBeLessThanOrEqual(4);
  });

  it('leaves the in-process project at full width so solo runs and CI pay no tax', () => {
    const inproc = projectNamed('inproc');
    expect(inproc.maxWorkers).toBeUndefined();
    // `toBeUndefined()` alone is also satisfied by a TYPO — `maxWorker: 3` would cap the project
    // this test calls uncapped, silently and greenly. Reject any near-miss key.
    const nearMiss = Object.keys(inproc).filter((k) => /^max.?work/i.test(k));
    expect(nearMiss, `unexpected worker key on inproc: ${nearMiss.join(', ')}`).toEqual([]);
  });

  // Not cosmetic: vitest throws "Projects ... have different 'maxWorkers' but same
  // 'sequence.groupOrder'" and the whole run collapses to "no tests" (measured).
  it('gives the two projects distinct sequence.groupOrder', () => {
    const orders = projectConfigs().map((p) => p.sequence?.groupOrder);
    // `[].every()` is true and `new Set([]).size === [].length`, so both checks below pass on an
    // empty project list. Pin the count first or this test is green when the split is gone.
    expect(orders).toHaveLength(2);
    expect(orders.every((o) => typeof o === 'number')).toBe(true);
    expect(new Set(orders).size).toBe(orders.length);
  });
});

// Generate, don't transcribe: the hand-written list in vitest.config.ts is re-derived from the
// filesystem here, so a new subprocess suite that nobody added to it reddens the gate instead of
// silently running at full width.
// Match the IMPORT, not call sites. A call-site regex matches prose: it put
// `scripts/preflight-lib.test.mjs` in the list on the strength of a trailing comment reading
// "spawnSync sets status null", though that file imports only pure functions — so rewording a
// comment reddened the gate while changing no behaviour.
//
// A heuristic, not a guarantee: it misses `await import('node:child_process')` and a suite that
// spawns via a helper module. Measured 2026-09-21 — import and call-site detection agree exactly
// across all 121 suites, and test-support/ holds no spawn helper — so the gap is latent, not live.
const SPAWN_IMPORT =
  /(?:from|require\()\s*['"](?:node:)?(?:child_process|execa|tinyexec|cross-spawn|zx)['"]/;

// Mirrors vitest 4's default include, `**/*.{test,spec}.?(c|m)[jt]s?(x)`. The narrower
// `\.test\.(ts|tsx|mjs|js)$` this replaces could not see `.spec.ts` or `.test.mts`, so a spawner
// with either extension was collected into the uncapped project with the gate green.
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// ONE source of truth for what is out of scope: the project's own `exclude` globs, applied with
// the same matcher vitest globs with. A second hand-maintained skip list is what produced the last
// two fail-opens here — a basename prune and a root-anchored glob described different trees, and a
// spawner planted in the gap (`scripts/.tmp-test/`) ran uncapped while this suite stayed green.
// There is nothing to keep in step now, so nothing can drift out of step.
//
// `node_modules` and `.git` are still pruned while walking, for speed only: `node_modules` is in
// EXCLUDE regardless, and `.git` holds no suites. Every other in/out decision belongs to the globs.
const PRUNE_FOR_SPEED = new Set(['node_modules', '.git']);

// ENOENT only, and only for a directory that vanished between readdir and recursion: sibling
// suites create and delete fixture dirs in this tree while this runs, which made this test fail
// roughly 1 run in 3 in the full suite while passing alone. Any other error still throws — a scan
// that could not complete must never be reported as a clean one.
function readDirOrEmpty(dir: string): fs.Dirent[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return [];
    throw err;
  }
}

// Same ENOENT-only rule as readDirOrEmpty, for the other half of the same TOCTOU window: a file
// listed by readdir can be deleted before it is read. '' cannot match SPAWN_IMPORT, which is the
// safe direction only because the vanished file is also gone from the tree vitest collects.
function readFileOrEmpty(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') return '';
    throw err;
  }
}

function walk(
  dir: string,
  repoRoot: string,
  isExcluded: (p: string) => boolean,
  found: string[],
): string[] {
  for (const entry of readDirOrEmpty(dir)) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(repoRoot, full);
    if (entry.isDirectory()) {
      if (PRUNE_FOR_SPEED.has(entry.name)) continue;
      // Prune whole excluded directories rather than walking in and filtering on the way out.
      // Not just speed: `.tmp-test` is created and destroyed by sibling suites WHILE this runs,
      // so descending into it is what produced the ~1-in-3 ENOENT flake. Probing a synthetic
      // child keeps the decision with the globs — the one source of truth — instead of a second
      // hand-written directory list, which is what drifted last time.
      if (isExcluded(path.join(rel, 'probe'))) continue;
      walk(full, repoRoot, isExcluded, found);
    } else if (TEST_FILE.test(entry.name)) {
      found.push(rel);
    }
  }
  return found;
}

describe('the subprocess-suite list is re-derived, not trusted', () => {
  // `new URL(...).pathname` does not decode percent-encoding, so a checkout under a path
  // containing a space would make readdirSync throw ENOENT far from the real cause.
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));

  function derivedSpawners(): string[] {
    // The SAME globs the projects exclude, so the walk and vitest cannot describe different trees.
    // Deliberately `subproc`'s: it carries the shared out-of-scope globs alone, whereas `inproc`'s
    // additionally lists all 19 subprocess suites, which would exclude the very files being sought.
    // `dot: true` is required, not cosmetic: without it `**` refuses to match path segments
    // beginning with a dot, so `**/.tmp-test/**` missed the night-control fixtures, whose paths
    // run through `.claude/worktrees/`. This repo is full of dot-directories.
    const isExcluded = picomatch(projectNamed('subproc').exclude ?? [], { dot: true });
    return walk(repoRoot, repoRoot, isExcluded, [])
      .filter((rel) => !isExcluded(rel))
      .filter((rel) => SPAWN_IMPORT.test(readFileOrEmpty(path.join(repoRoot, rel))))
      .sort();
  }

  it('matches every test file that actually spawns a subprocess', () => {
    const actual = derivedSpawners();
    const declared = [...(projectNamed('subproc').include ?? [])].sort();

    // Both diffs below are satisfied by two EMPTY lists, so the scan must be shown to have found
    // something first — otherwise a walk that silently returned nothing reads as agreement.
    expect(actual.length).toBeGreaterThan(10);
    // Named diffs rather than a bare length check, so a failure says WHICH suite moved.
    expect(actual.filter((f) => !declared.includes(f))).toEqual([]);
    expect(declared.filter((f) => !actual.includes(f))).toEqual([]);
  });

  // The line that AUTHORISES the whole guarantee, and the one nothing pinned before: without
  // SUBPROCESS_SUITES in inproc's exclude, both projects collect all 20 suites, the second copy
  // runs at full width, and the cap buys nothing. Mutation-proven: dropping it takes collection
  // 121 -> 141 while every other assertion here stays green (tkt-d5957c036ff8, review finding 1).
  // Behavioural, not a string comparison: the previous version of this test asserted that each
  // skipped directory name appeared in `exclude`, which was GREEN while the two still described
  // different trees — `.tmp-test` was in both lists, yet a root-anchored glob missed
  // `scripts/.tmp-test` and a spawner there ran uncapped.
  it('excludes every in-tree fixture root at whatever depth it sits', () => {
    const isExcluded = picomatch(projectNamed('subproc').exclude ?? [], { dot: true });

    // Fixed cases, not a scan of whatever fixtures happen to be on disk: that scan is EMPTY on a
    // fresh checkout — which this repo's own vacuous-test ratchet flagged as an unpinned loop —
    // and it varies with which sibling suites have already run.
    const mustExclude = [
      '.tmp-test/x/planted.test.mjs',
      // scripts/probe/hook-gate.test.mjs derives this two dirnames up from itself, so a
      // root-anchored `.tmp-test/**` misses it.
      'scripts/.tmp-test/x/planted.test.mjs',
      // Dot segments BELOW the fixture root: night-control builds fake worktrees in here, and
      // picomatch's `**` skips dot segments unless `dot: true`.
      '.tmp-test/night-control-a1/.claude/worktrees/w/.claude/hooks/guard.test.mjs',
      'agent/node_modules/pkg/thing.test.js',
    ];
    // Negative control: without it, a glob set that excluded EVERYTHING would pass the block above
    // — and the derivation would then find no spawners at all.
    const mustNotExclude = [
      'scripts/probe/stale-in-progress.test.mjs',
      '.claude/settings.audit.test.mjs',
      'server/packageContract.test.ts',
    ];
    expect(mustExclude).toHaveLength(4);
    expect(mustNotExclude).toHaveLength(3);

    for (const p of mustExclude) {
      expect(isExcluded(p), `a suite at "${p}" would be collected uncapped`).toBe(true);
    }
    for (const p of mustNotExclude) {
      expect(isExcluded(p), `"${p}" is a real suite but is being excluded`).toBe(false);
    }
  });

  it('keeps the subprocess suites OUT of the uncapped in-process project', () => {
    const declared = [...(projectNamed('subproc').include ?? [])];
    const excluded = projectNamed('inproc').exclude ?? [];
    expect(declared).not.toHaveLength(0);
    expect(declared.filter((suite) => !excluded.includes(suite))).toEqual([]);
  });
});
