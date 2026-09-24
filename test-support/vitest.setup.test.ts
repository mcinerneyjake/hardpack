import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

// tkt-d8433087381d. The setup file's directory only dies with the run when `holdTestRun` rewrote
// TMPDIR; both `skipReason` branches (CI set, or VITEST_WORKER_ID set for a run nested inside a
// vitest worker) leave os.tmpdir() at the SHARED root, where nothing sweeps it. Measured: ~2,949
// top-level dirs in two hours from the eval-coding harness, which runs the suite per repo copy.
//
// Driven out-of-process because the assertion is about what the module does to os.tmpdir() at
// IMPORT time, and about an exit hook — neither is observable from inside the importing process.
// TMPDIR is set per child to an in-tree fixture root, so the suite never writes to the real
// tmpdir it is testing the handling of.

const SETUP = fileURLToPath(new URL('./vitest.setup.ts', import.meta.url));
const FIXTURE_ROOT = fileURLToPath(new URL('../.tmp-test/vitest-setup', import.meta.url));

// `created` is reported from INSIDE the child: the exit hook removes the directory, so whether it
// was created is only observable before this process exits.
const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
await import(${JSON.stringify(SETUP)});
const cachePath = process.env.EMBED_CACHE_PATH;
console.log(JSON.stringify({
  cachePath,
  pid: process.pid,
  created: fs.existsSync(path.dirname(cachePath)),
}));
`;

const CACHE_ROOT = 'hardpack-embed-cache';

function runSetupIn(tmpdir: string): { cachePath: string; pid: number; created: boolean } {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], {
    // A scrubbed TMPDIR is the whole point: inheriting the parent's would test the wrong directory.
    env: { ...process.env, TMPDIR: tmpdir },
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`setup child exited ${result.status}: ${result.stderr}`);
  }
  const line = result.stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line);
}

describe('test-support/vitest.setup.ts', () => {
  let tmpdir: string;

  beforeEach(() => {
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    tmpdir = fs.mkdtempSync(path.join(FIXTURE_ROOT, 'run-'));
  });

  afterEach(() => {
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  // Removing only the per-test `run-*` dir would leave FIXTURE_ROOT behind every run — the same
  // one-entry-per-run shape this ticket is about, one directory over.
  afterAll(() => {
    fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('pins EMBED_CACHE_PATH to a file inside the tmpdir', () => {
    const { cachePath, created } = runSetupIn(tmpdir);

    expect(cachePath.startsWith(tmpdir)).toBe(true);
    expect(path.basename(cachePath)).toBe('embeddings.json');
    expect(created).toBe(true);
  });

  // The cache root is a fixed, predictable name, and under a skipped hold it resolves in the SHARED
  // tmpdir. A squatted name must not break every suite — but it must not silently leave the cache
  // unpinned either, because an unpinned EMBED_CACHE_PATH resolves to the real board cache and gets
  // pruned to a stub corpus. Degrade tidiness, never the safety property.
  it('falls back to a flat sibling when the cache root is squatted by a file', () => {
    fs.writeFileSync(path.join(tmpdir, CACHE_ROOT), '');

    const { cachePath, created } = runSetupIn(tmpdir);

    expect(created).toBe(true);
    expect(cachePath.startsWith(tmpdir)).toBe(true);
    expect(path.basename(path.dirname(cachePath)).startsWith(`${CACHE_ROOT}-`)).toBe(true);
  });

  // The soak criterion, as a test: `ls $TMPDIR | wc -l` unchanged across the reproducing path.
  //
  // It asserts INSIDE the cache root as well as at the top level, and that is the whole point of the
  // case. A top-level-only assertion is vacuous the moment the nesting lands — it reads
  // `[CACHE_ROOT]` by construction whatever happens underneath, so it stays green with the
  // exit hook and the sweep both removed, and the leak this ticket exists for simply moves one level
  // down. Verified: with both disabled, top level held while the root grew one entry per run.
  it('does not grow the tmpdir across runs, at the top level or inside the cache root', () => {
    const first = runSetupIn(tmpdir);
    const topAfterFirst = fs.readdirSync(tmpdir);
    const insideAfterFirst = fs.readdirSync(path.join(tmpdir, CACHE_ROOT));

    const second = runSetupIn(tmpdir);
    const topAfterSecond = fs.readdirSync(tmpdir);
    const insideAfterSecond = fs.readdirSync(path.join(tmpdir, CACHE_ROOT));

    // Distinct pids, or the two runs could collide on one name and pass for the wrong reason.
    expect(second.pid).not.toBe(first.pid);
    expect(topAfterSecond).toEqual(topAfterFirst);
    expect(topAfterSecond).toEqual([CACHE_ROOT]);
    expect(insideAfterSecond).toEqual(insideAfterFirst);
    expect(insideAfterSecond).toEqual([]);
  });

  it('removes its cache directory when the process exits', () => {
    const { cachePath } = runSetupIn(tmpdir);

    expect(fs.existsSync(path.dirname(cachePath))).toBe(false);
  });

  // A vitest worker is terminated rather than exited, so the hook above does not fire for it and
  // the parent would otherwise accumulate one empty dir per worker per run. One case per dimension
  // of the adversary list on tkt-d8433087381d; the sweep DELETES, so the keep cases are the point.
  describe('dead-pid sweep', () => {
    let root: string;

    beforeEach(() => {
      root = path.join(tmpdir, CACHE_ROOT);
      fs.mkdirSync(root, { recursive: true });
    });

    function seedDir(name: string): void {
      fs.mkdirSync(path.join(root, name), { recursive: true });
    }

    // 999999 is a legal pid on Linux (pid_max defaults to 4194304), so the sentinel is safe because
    // a short-lived runner never allocates that far, NOT because it is out of range. It is above
    // macOS's 99999 ceiling, but the gate runs on ubuntu-latest.
    it('removes a directory whose pid is dead', () => {
      seedDir('999999');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, '999999'))).toBe(false);
    });

    // The dimension the sweep's own comment calls load-bearing, and the ONLY case that pins the
    // ESRCH discrimination: pid 1 is init/launchd, owned by root, so process.kill(1, 0) throws
    // EPERM for a non-root caller — alive, but unsignalable. Without this case, replacing that
    // catch body with `return true` (any errno means dead) survives every other test here.
    it('keeps a directory whose pid is alive under another uid (EPERM, not ESRCH)', () => {
      seedDir('1');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, '1'))).toBe(true);
    });

    it('removes a thread-suffixed directory whose pid is dead', () => {
      seedDir('999999-3');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, '999999-3'))).toBe(false);
    });

    it('keeps a thread-suffixed directory whose pid is alive', () => {
      seedDir(`${process.pid}-7`);

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, `${process.pid}-7`))).toBe(true);
    });

    it('keeps a directory whose pid is alive', () => {
      // This test process is alive for the whole child run, so its pid is a live holder.
      seedDir(String(process.pid));

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, String(process.pid)))).toBe(true);
    });

    it('keeps an entry whose name is not a pid', () => {
      seedDir('not-a-pid');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, 'not-a-pid'))).toBe(true);
    });

    it('keeps a leading-zero name, which is not a canonical pid', () => {
      seedDir('0123');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, '0123'))).toBe(true);
    });

    it('keeps a regular file named like a dead pid', () => {
      fs.writeFileSync(path.join(root, '999998'), '');

      runSetupIn(tmpdir);

      expect(fs.existsSync(path.join(root, '999998'))).toBe(true);
    });
  });
});
