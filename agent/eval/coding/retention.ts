import fs from 'node:fs/promises';
import path from 'node:path';
import { LABEL_TREE, PRISTINE_TREE, RUN_REPORT, RUN_RESULTS, SESSION_LOG } from './layout.js';

export const DEFAULT_KEEP_RUNS = 1;

// A run that has a report.json is finished by construction — cli.ts writes it only after the last
// case is graded — so its presence is *proof* a run is done rather than an inference from mtimes.
// A run without one may be in flight or may have crashed, and the two are indistinguishable from
// outside, so it is held until it has been quiet this long. The window is hours, not minutes,
// because a live run is legitimately silent for a whole `npm ci` (15 min cap) plus up to four
// vitest runs (20 min cap each) without touching anything retention can see (tkt-217f5a6d1d54).
export const STALE_AFTER_MS = 6 * 60 * 60_000;

// Exactly the form cli.ts mints: `new Date().toISOString().replace(/[:.]/g, '-')`. Anything else in
// the eval root was put there by hand, and this prune deletes only what the harness itself created.
const RUN_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export interface PruneOptions {
  keep: number;
  /** The run being written now. Survives whether or not it is among the newest `keep`. */
  protect?: string;
  /** Injected by tests; defaults to the wall clock. */
  now?: number;
  staleAfterMs?: number;
}

export interface PruneResult {
  /** Run stamps this call took at least one tree from. */
  pruned: string[];
  /** Run stamps held back: unfinished, and not yet quiet long enough to call them abandoned. */
  skipped: string[];
  /** Derived trees actually removed — `pristine` and `<label>/repo` are counted one apiece. */
  trees: number;
}

function assertKeep(keep: number): void {
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`coding-eval: keep must be a positive integer, got ${keep} — refusing to prune rather than guess.`);
  }
}

// Duplicated from realDeps.ts rather than imported: that module spawns `claude`, and this one is
// reached from the test suite.
function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

async function readdirOrEmpty(dir: string): Promise<{ name: string; dir: boolean }[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((e) => ({
      // lstat-based, so a symlink answers false and is never followed into a tree we were not given.
      name: e.name, dir: e.isDirectory(),
    }));
  } catch (err) {
    // ENOENT only: a run dir removed under us is a race worth tolerating. ENOTDIR is deliberately
    // NOT swallowed — every caller has already filtered to directories, so it could only mean one
    // of those filters is gone, and swallowing it would make removing one of them invisible.
    if (isMissing(err)) return [];
    throw err;
  }
}

/** lstat-based, unlike `exists`: a symlinked `repo` must not be unlinked and counted as reclaimed. */
async function isRealDir(p: string): Promise<boolean> {
  try {
    return (await fs.lstat(p)).isDirectory();
  } catch (err) {
    if (isMissing(err)) return false;
    throw err;
  }
}

// checkEnvironment() validates the run dir, but it lives in realDeps and runs after the first
// delete — and never at all on the --prune path. So the destructive code carries its own guard
// rather than trusting a caller's ordering (tkt-217f5a6d1d54).
//
// It CANONICALIZES rather than validates. Comparing spellings was tried and produced three bugs:
// `path.resolve` collapses `..` lexically *before* realpath sees it, so `<symlink>/..` named one
// directory and deleted another; and on a case-insensitive volume realpath case-folds, so a
// hand-typed EVAL_CODING_DIR was refused as a symlink. Resolving to the true location has neither
// failure mode, and a symlinked eval root is a legitimate thing to prune — at its real location.
async function assertNotInRepo(dir: string, named: string): Promise<void> {
  for (let cur = dir; ; cur = path.dirname(cur)) {
    if (await exists(path.join(cur, '.git'))) {
      throw new Error(`coding-eval: refusing to prune ${named} — it resolves inside the git repo at ${cur}, where a replay would see the repo's own files.`);
    }
    if (path.dirname(cur) === cur) return;
  }
}

export function selectPrunable(names: readonly string[], opts: PruneOptions): string[] {
  assertKeep(opts.keep);
  // Every field is fixed-width and zero-padded, so lexicographic order is chronological order.
  const stamps = names.filter((n) => RUN_STAMP.test(n)).sort().reverse();
  const survivors = new Set(stamps.slice(0, opts.keep));
  if (opts.protect !== undefined) {
    if (!RUN_STAMP.test(opts.protect)) {
      throw new Error(`coding-eval: protect must be a run stamp, got ${opts.protect} — a drifted format would silently protect nothing.`);
    }
    survivors.add(opts.protect);
  }
  return stamps.filter((n) => !survivors.has(n));
}

/**
 * Newest sign of life anywhere retention can cheaply see: the run dir, its records, and every case
 * and label dir under it. The label dirs matter most — `runVitest` writes its JSON report there, so
 * they move throughout the controls and grading phases, which write no transcript and no results.
 */
async function newestActivityMs(runDir: string): Promise<number> {
  let newest = 0;
  const bump = async (p: string): Promise<void> => {
    try {
      newest = Math.max(newest, (await fs.stat(p)).mtimeMs);
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
  };
  await bump(runDir);
  await bump(path.join(runDir, RUN_RESULTS));
  for (const c of await readdirOrEmpty(runDir)) {
    if (!c.dir) continue;
    const caseDir = path.join(runDir, c.name);
    await bump(caseDir);
    for (const label of await readdirOrEmpty(caseDir)) {
      if (!label.dir) continue;
      await bump(path.join(caseDir, label.name));
      await bump(path.join(caseDir, label.name, SESSION_LOG));
    }
  }
  return newest;
}

/** A run is safe to reclaim once it is provably finished, or has been abandoned long enough. */
async function isFinished(runDir: string, now: number, staleAfterMs: number): Promise<boolean> {
  if (await exists(path.join(runDir, RUN_REPORT))) return true;
  return now - (await newestActivityMs(runDir)) >= staleAfterMs;
}

export async function pruneRuns(evalRoot: string, opts: PruneOptions): Promise<PruneResult> {
  assertKeep(opts.keep);
  if (!path.isAbsolute(evalRoot)) {
    throw new Error(`coding-eval: refusing to prune a relative eval root (${evalRoot}) — it would resolve against the cwd, which differs between the primary and a worktree.`);
  }
  // Resolve to the true location and operate there, so `<symlink>/..` and a case-variant spelling
  // both name what the shell names rather than a lexically-collapsed sibling.
  let root: string;
  let entries;
  try {
    root = await fs.realpath(evalRoot);
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if (isMissing(err)) return { pruned: [], skipped: [], trees: 0 };
    throw err;
  }

  // Directories only: a stamp-named regular file is not a run.
  const candidates = selectPrunable(entries.filter((e) => e.isDirectory()).map((e) => e.name), opts);
  const result: PruneResult = { pruned: [], skipped: [], trees: 0 };
  if (candidates.length === 0) return result;

  // Only once something is actually going to be deleted, so a missing or odd root is still a no-op.
  await assertNotInRepo(root, evalRoot);

  const now = opts.now ?? Date.now();
  const staleAfterMs = opts.staleAfterMs ?? STALE_AFTER_MS;
  for (const stamp of candidates) {
    const runDir = path.join(root, stamp);
    if (!(await isFinished(runDir, now, staleAfterMs))) {
      result.skipped.push(stamp);
      continue;
    }
    let removed = 0;
    for (const caseEntry of await readdirOrEmpty(runDir)) {
      if (!caseEntry.dir) continue;
      const caseDir = path.join(runDir, caseEntry.name);
      for (const child of await readdirOrEmpty(caseDir)) {
        if (!child.dir) continue;
        // `pristine` is a bare tree; every other directory is a label holding its records beside a
        // `repo` checkout, and only that checkout goes.
        const target = child.name === PRISTINE_TREE
          ? path.join(caseDir, child.name)
          : path.join(caseDir, child.name, LABEL_TREE);
        if (child.name !== PRISTINE_TREE && !(await isRealDir(target))) continue;
        await fs.rm(target, { recursive: true, force: true });
        removed++;
      }
    }
    if (removed > 0) {
      result.pruned.push(stamp);
      result.trees += removed;
    }
  }
  return result;
}
