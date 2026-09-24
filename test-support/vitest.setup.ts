import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { threadId } from 'node:worker_threads';

// Pins the persistent embedding cache to a throwaway dir. tkt-9f09b3a1e95c made that cache
// default-ON (it was opt-in via EMBED_CACHE_PATH), so any suite building an index would
// otherwise resolve defaultCachePath() to the REAL board cache and prune() it down to its own
// stub corpus — silently destroying a developer's warm cache and forcing a full cold re-embed.
//
// Keyed by pid, NOT mkdtemp: vitest evaluates setupFiles once per TEST FILE, so mkdtemp would
// mint a fresh directory for every one of the ~87 suites and leak them all.
//
// Nested under ONE parent, replacing the flat `<tmpdir>/kanban-embed-cache-<pid>` (tkt-d8433087381d,
// which also renamed it off the old product name). The
// pid dir dies with the run only when holdTestRun rewrote TMPDIR, and BOTH its skip branches leave
// os.tmpdir() at the shared root: CI set, and VITEST_WORKER_ID set for a run nested inside another
// vitest worker — the local path, measured at ~2,949 stranded dirs in two hours. A single parent
// caps the top-level cost at one entry however the run was launched.
const root = path.join(os.tmpdir(), 'hardpack-embed-cache');

// threadId is 0 on the main thread and distinct per worker thread. Under a `threads` pool every
// thread shares process.pid AND os.tmpdir() but gets its own process.env, so a pid-only name would
// have each thread claim the SAME directory and register its own exit hook — the first to finish
// deleting the cache its live siblings are still writing to. Forks is vitest's default, so this is
// latent today; it costs one identifier to not depend on that.
const own = threadId === 0 ? String(process.pid) : `${process.pid}-${threadId}`;

// The parent is a fixed, predictable name, and on CI the hold is skipped so it resolves under the
// shared /tmp. If it is squatted — a regular file, or a directory owned by another uid — mkdir
// throws at IMPORT, which is every suite, with an error pointing nowhere near the cause. Falling
// back to a flat sibling keeps the cache PINNED, which is the property that protects the real board
// cache above; only the one-entry tidiness degrades. A fallback that also fails must still throw:
// running on with an unpinned EMBED_CACHE_PATH is the destructive outcome, not a degraded one.
function makeCacheDir(): string {
  try {
    const nested = path.join(root, own);
    fs.mkdirSync(nested, { recursive: true });
    return nested;
  } catch {
    const flat = path.join(os.tmpdir(), `hardpack-embed-cache-${own}`);
    fs.mkdirSync(flat, { recursive: true });
    return flat;
  }
}

const dir = makeCacheDir();
process.env.EMBED_CACHE_PATH = path.join(dir, 'embeddings.json');

// `<pid>` or `<pid>-<threadId>`, and nothing else: a leading zero, a non-numeric name or anything
// else a tool drops here is never a delete candidate.
const PID_DIR = /^[1-9][0-9]*(?:-[0-9]+)?$/;

// ESRCH is the ONLY proof of death: EPERM means alive under another uid, and any other errno means
// the probe itself failed. Both keep the directory — "cannot tell" must never take the delete branch.
function pidDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err instanceof Error && 'code' in err && err.code === 'ESRCH';
  }
}

// A vitest worker is terminated rather than exited, so the hook below never fires for one and the
// parent would accumulate an empty dir per worker per run. Reclaims siblings whose holder is gone.
//
// Residual, accepted rather than covered (tkt-d8433087381d): pid reuse between the probe and the
// rmSync could delete a just-started holder's directory. Microseconds wide, and it needs the shared
// root plus fast reuse; narrowing it properly wants an O_EXCL claim file, which is more machinery
// than an empty cache dir is worth.
function sweepDeadSiblings(): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return; // a root that cannot be read is a root that must not be swept, and not a fatal error
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !PID_DIR.test(entry.name)) continue;
    if (!pidDead(Number(entry.name.replace(/-.*$/, '')))) continue;
    try {
      fs.rmSync(path.join(root, entry.name), { recursive: true, force: true });
    } catch {
      // A concurrent sweeper got there first, or the entry has a foreign owner. Neither is worth
      // failing a test run over.
    }
  }
}

// Both run once per PROCESS, not once per setupFiles evaluation: env is the only state that survives
// a module re-evaluation here, and ~87 exit listeners would trip Node's MaxListeners warning.
// Compared against `dir` rather than merely present, so a spawned child inheriting this var still
// registers its own — its pid, and so its dir, differs.
if (process.env.HARDPACK_EMBED_CACHE_OWNED !== dir) {
  process.env.HARDPACK_EMBED_CACHE_OWNED = dir;
  process.once('exit', () => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // `force` only swallows ENOENT. A read-only, busy or foreign-owned dir would otherwise throw
      // from an exit listener — AFTER a green run — and exit 1, reading as a crashed worker. The
      // next run's sweep reclaims it instead.
    }
  });
  sweepDeadSiblings();
}
