import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LABEL_TREE, PRISTINE_TREE, RUN_REPORT, RUN_RESULTS, SESSION_LOG } from './layout.js';
import { STALE_AFTER_MS, pruneRuns, selectPrunable } from './retention.js';

const STAMPS = [
  '2026-09-24T17-44-37-294Z',
  '2026-09-24T17-49-13-716Z',
  '2026-09-24T18-27-00-718Z',
  '2026-09-24T18-48-19-852Z',
];

describe('selectPrunable — only a stamp this harness minted is ever a candidate', () => {
  it('drops every run older than the newest `keep`', () => {
    expect(selectPrunable(STAMPS, { keep: 1 })).toEqual([STAMPS[2], STAMPS[1], STAMPS[0]]);
    expect(selectPrunable(STAMPS, { keep: 2 })).toEqual([STAMPS[1], STAMPS[0]]);
  });

  it('returns nothing when the board holds `keep` runs or fewer', () => {
    expect(selectPrunable([], { keep: 1 })).toEqual([]);
    expect(selectPrunable(STAMPS.slice(0, 1), { keep: 2 })).toEqual([]);
    expect(selectPrunable(STAMPS.slice(0, 2), { keep: 2 })).toEqual([]);
  });

  // The measured contents of the live eval root: a hand-made regrade dir and three loose logs sit
  // beside the run stamps, and none of them is harness output.
  it('never names a non-stamp entry, however directory-shaped', () => {
    const others = ['regrade-1790276437445', 'smoke-1.log', 'controls-all.log', 'node_modules', '.DS_Store'];
    expect(selectPrunable([...STAMPS, ...others], { keep: 1 })).toEqual([STAMPS[2], STAMPS[1], STAMPS[0]]);
  });

  it('rejects near-misses rather than treating them as old runs', () => {
    const nearMisses = [
      '2026-09-24',                    // date only
      '2026-09-24T18-48-19-852Z-old',  // stamp plus a suffix
      '2026-09-24T18-48-19-852',       // no trailing Z
      '2026-09-24t18-48-19-852z',      // lowercase
      '2026-09-24T18:48:19.852Z',      // raw ISO, before the cli substitutes separators
      '2026-09-24T18-48-19Z',          // no millis
      '2026-09-24T18-48-19-8521Z',     // four-digit millis
      '2026-9-24T18-48-19-852Z',       // unpadded month
    ];
    expect(selectPrunable(nearMisses, { keep: 1 })).toEqual([]);
  });

  // The in-flight run is protected by name, not by being newest: a clock skew or a hand-passed
  // stamp must not make the directory currently being written a delete candidate.
  it('protects the named run even when it is not among the newest `keep`', () => {
    expect(selectPrunable(STAMPS, { keep: 1, protect: STAMPS[0] })).toEqual([STAMPS[2], STAMPS[1]]);
  });

  it('does not grant an extra survivor slot when the protected run is already the newest', () => {
    expect(selectPrunable(STAMPS, { keep: 1, protect: STAMPS[3] })).toEqual([STAMPS[2], STAMPS[1], STAMPS[0]]);
  });

  it('does not throw when the protected stamp is absent from the names', () => {
    expect(selectPrunable(STAMPS.slice(0, 2), { keep: 1, protect: STAMPS[3] })).toEqual([STAMPS[0]]);
  });

  // A protect that silently matches nothing is the fail-open shape: the in-flight run would become
  // a candidate and nothing would say so.
  it.each(['not-a-stamp', '', '2026-09-24', `${STAMPS[0]}/../${STAMPS[1]}`])(
    'refuses protect=%s rather than protecting nothing', (protect) => {
      expect(() => selectPrunable(STAMPS, { keep: 1, protect })).toThrow(/protect/);
    });

  // "Could not read the argument" must not resolve to the permissive answer, which here is deleting.
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses keep=%s rather than defaulting', (keep) => {
    expect(() => selectPrunable(STAMPS, { keep })).toThrow(/keep/);
  });
});

describe('pruneRuns', () => {
  let root = '';

  const LABELS = ['control-base', 'control-gold', 'trial-1'];
  /** One `pristine` tree plus one `repo` tree per label — 4 derived trees per case. */
  const TREES_PER_CASE = 1 + LABELS.length;

  // Mirrors the measured on-disk layout of a real run (tkt-217f5a6d1d54), through the same constants
  // realDeps writes it with, so the fixture cannot drift from the code under test. The derived trees
  // are `<case>/pristine` and `<case>/<label>/repo`; the session's records sit *beside* the repo,
  // inside the same label dir, which is why a whole-label delete loses them.
  async function seedRun(stamp: string, cases: string[], opts: { finished?: boolean } = {}): Promise<void> {
    for (const c of cases) {
      await fs.mkdir(path.join(root, stamp, c, PRISTINE_TREE, 'node_modules'), { recursive: true });
      await fs.writeFile(path.join(root, stamp, c, PRISTINE_TREE, 'node_modules', 'big.bin'), 'x');
      for (const label of LABELS) {
        const dir = path.join(root, stamp, c, label);
        await fs.mkdir(path.join(dir, LABEL_TREE, 'node_modules'), { recursive: true });
        await fs.writeFile(path.join(dir, LABEL_TREE, 'node_modules', 'big.bin'), 'x');
        await fs.mkdir(path.join(dir, 'board', 'tickets'), { recursive: true });
        await fs.writeFile(path.join(dir, 'board', 'tickets', `${c}.md`), '# frozen body');
        await fs.writeFile(path.join(dir, SESSION_LOG), 'metered transcript');
        await fs.writeFile(path.join(dir, 'settings.json'), '{}');
        await fs.writeFile(path.join(dir, 'mcp.json'), '{}');
      }
    }
    await fs.mkdir(path.join(root, stamp), { recursive: true });
    await fs.writeFile(path.join(root, stamp, RUN_RESULTS), '{"case":1}\n');
    // Written by cli.ts only after the last case is graded, so it is what marks a run finished.
    if (opts.finished !== false) await fs.writeFile(path.join(root, stamp, RUN_REPORT), '{"ok":true}');
  }

  const exists = async (p: string): Promise<boolean> => fs.access(p).then(() => true, () => false);

  beforeEach(async () => {
    // realpath: on macOS os.tmpdir() is itself a symlink, and the root guard rejects a non-realpath.
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hardpack-eval-retention-')));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('removes the derived trees of an old run', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa', 'tkt-bbbbbbbbbbbb']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);

    const result = await pruneRuns(root, { keep: 1 });

    expect(result.pruned).toEqual([STAMPS[0]]);
    expect(result.trees).toBe(2 * TREES_PER_CASE);
    expect(await exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE))).toBe(false);
    expect(await exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', 'trial-1', LABEL_TREE))).toBe(false);
  });

  // The whole safety argument for keep:1. session.log is a metered Claude Code transcript and
  // results.jsonl keeps only a grade summary, so losing it cannot be undone without re-spending.
  it('keeps every record a pruned run holds, not just the top-level report', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);

    await pruneRuns(root, { keep: 1 });

    const label = path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', 'trial-1');
    expect(await exists(path.join(root, STAMPS[0], RUN_REPORT))).toBe(true);
    expect(await exists(path.join(root, STAMPS[0], RUN_RESULTS))).toBe(true);
    expect(await exists(path.join(label, SESSION_LOG))).toBe(true);
    expect(await exists(path.join(label, 'settings.json'))).toBe(true);
    expect(await exists(path.join(label, 'mcp.json'))).toBe(true);
    expect(await exists(path.join(label, 'board', 'tickets', 'tkt-aaaaaaaaaaaa.md'))).toBe(true);
  });

  it('leaves the newest run entirely alone', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);

    await pruneRuns(root, { keep: 1 });

    expect(await exists(path.join(root, STAMPS[1], 'tkt-cccccccccccc', PRISTINE_TREE))).toBe(true);
    expect(await exists(path.join(root, STAMPS[1], 'tkt-cccccccccccc', 'trial-1', LABEL_TREE))).toBe(true);
  });

  // Both non-stamp dirs are seeded with a report.json and a real tree, so they are prunable in every
  // respect *except* their name. `2026-09-24` is the load-bearing one: `regrade-…` sorts ABOVE every
  // stamp, so with the RUN_STAMP filter removed it would take the single `keep` slot and survive on
  // recency — leaving the assertion green and the control worthless. A name that sorts below the
  // stamps becomes a candidate instead, so deleting the filter reddens this.
  it('leaves a non-stamp directory and a loose file untouched', async () => {
    await seedRun(STAMPS[1], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[2], ['tkt-cccccccccccc']);
    const nonStamps = ['regrade-1790276437445', '2026-09-24'];
    for (const name of nonStamps) {
      await fs.mkdir(path.join(root, name, 'tkt-dddddddddddd', PRISTINE_TREE), { recursive: true });
      await fs.writeFile(path.join(root, name, RUN_REPORT), '{"ok":true}');
    }
    await fs.writeFile(path.join(root, 'smoke-1.log'), 'log');

    await pruneRuns(root, { keep: 1 });

    for (const name of nonStamps) {
      expect(await exists(path.join(root, name, 'tkt-dddddddddddd', PRISTINE_TREE))).toBe(true);
    }
    expect(await exists(path.join(root, 'smoke-1.log'))).toBe(true);
  });

  // A stamp-named *file* must not abort the prune: readdir on it raises ENOTDIR, not ENOENT, and an
  // unhandled throw here would take down the whole metered run before a single session.
  it('ignores a stamp-named regular file instead of failing on it', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[2], ['tkt-cccccccccccc']);
    await fs.writeFile(path.join(root, STAMPS[1]), 'a redirected log, not a run');

    const result = await pruneRuns(root, { keep: 1 });

    expect(result.pruned).toEqual([STAMPS[0]]);
    expect(await exists(path.join(root, STAMPS[1]))).toBe(true);
  });

  // The link is named `pristine` deliberately: that is the one name the prune deletes outright, so
  // a stat-following isDirectory() would unlink it and this assertion would redden. Named anything
  // else the test proves nothing, because `<link>/repo` resolves to nothing either way.
  it('does not treat a symlink as a derived tree, even under the name it deletes', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);
    const outside = path.join(root, 'outside');
    await fs.mkdir(path.join(outside, 'precious'), { recursive: true });
    const decoy = path.join(root, STAMPS[0], 'tkt-eeeeeeeeeeee', PRISTINE_TREE);
    await fs.mkdir(path.dirname(decoy), { recursive: true });
    await fs.symlink(outside, decoy);

    await pruneRuns(root, { keep: 1 });

    expect(await exists(path.join(outside, 'precious'))).toBe(true);
    expect(await fs.lstat(decoy).then((s) => s.isSymbolicLink(), () => false)).toBe(true);
  });

  // A relocated tree: `fs.rm` on a symlink unlinks it without descending, so a stat-based check
  // here would orphan the real tree, reclaim ~0 bytes, and still report a tree removed — an
  // under-reclaim announced as success to the one person who ran --prune because the disk was full.
  it('leaves a symlinked repo alone rather than unlinking it and counting it reclaimed', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);
    const relocated = path.join(root, 'relocated-tree');
    await fs.mkdir(path.join(relocated, 'node_modules'), { recursive: true });
    const label = path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', LABELS[0]);
    await fs.rm(path.join(label, LABEL_TREE), { recursive: true, force: true });
    await fs.symlink(relocated, path.join(label, LABEL_TREE));

    const result = await pruneRuns(root, { keep: 1 });

    expect(await fs.lstat(path.join(label, LABEL_TREE)).then((s) => s.isSymbolicLink(), () => false)).toBe(true);
    expect(await exists(path.join(relocated, 'node_modules'))).toBe(true);
    // pristine + the two labels whose repo is a real directory — never the symlinked one.
    expect(result.trees).toBe(TREES_PER_CASE - 1);
  });

  it('is idempotent — a second prune reports no run pruned', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-cccccccccccc']);

    expect((await pruneRuns(root, { keep: 1 })).pruned).toEqual([STAMPS[0]]);
    expect(await pruneRuns(root, { keep: 1 })).toEqual({ pruned: [], skipped: [], trees: 0 });
  });

  // Was previously asserted with only two stamps, where the protected run was already the sole
  // survivor by recency — so the flag could be deleted outright and the test stayed green.
  it('protects a named run that would otherwise be pruned', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await seedRun(STAMPS[1], ['tkt-bbbbbbbbbbbb']);
    await seedRun(STAMPS[2], ['tkt-cccccccccccc']);

    const result = await pruneRuns(root, { keep: 1, protect: STAMPS[0] });

    expect(result.pruned).toEqual([STAMPS[1]]);
    expect(await exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE))).toBe(true);
    expect(await exists(path.join(root, STAMPS[1], 'tkt-bbbbbbbbbbbb', PRISTINE_TREE))).toBe(false);
  });

  // The liveness rule. A run without report.json is indistinguishable from outside from one that is
  // mid-`npm ci` or mid-vitest, and those phases write nothing retention can see for up to 20 min
  // apiece — so an unfinished run is held until it is old enough to call abandoned.
  describe('an unfinished run', () => {
    beforeEach(async () => {
      await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa'], { finished: false });
      await seedRun(STAMPS[1], ['tkt-cccccccccccc']);
    });

    const survives = async (): Promise<boolean> => exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE));

    it('is skipped while it is recent, however quiet', async () => {
      const result = await pruneRuns(root, { keep: 1 });
      expect(result.skipped).toEqual([STAMPS[0]]);
      expect(result.pruned).toEqual([]);
      expect(await survives()).toBe(true);
    });

    it('is still skipped after a gap longer than a vitest cap', async () => {
      const result = await pruneRuns(root, { keep: 1, now: Date.now() + 45 * 60_000 });
      expect(result.skipped).toEqual([STAMPS[0]]);
      expect(await survives()).toBe(true);
    });

    it('is reclaimed once it has been quiet long enough to call abandoned', async () => {
      const result = await pruneRuns(root, { keep: 1, now: Date.now() + STALE_AFTER_MS + 1_000 });
      expect(result.pruned).toEqual([STAMPS[0]]);
      expect(await survives()).toBe(false);
    });

    it('is reclaimed immediately once it has a report.json, whatever its mtimes say', async () => {
      await fs.writeFile(path.join(root, STAMPS[0], RUN_REPORT), '{"ok":true}');
      expect((await pruneRuns(root, { keep: 1 })).pruned).toEqual([STAMPS[0]]);
      expect(await survives()).toBe(false);
    });

    const caseDirOf = (): string => path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa');

    /**
     * Ages every path `newestActivityMs` samples except the ones named, so a single source of
     * liveness is isolated. It ENUMERATES the tree rather than listing LABELS: `pristine` is a
     * directory under the case dir too, and leaving it fresh silently kept four of these tests
     * green no matter which bump was deleted.
     */
    async function ageAllExcept(keepFresh: readonly string[]): Promise<void> {
      const old = new Date(Date.now() - 10 * STALE_AFTER_MS);
      const runDir = path.join(root, STAMPS[0]);
      const sampled = [runDir, path.join(runDir, RUN_RESULTS)];
      for (const c of await fs.readdir(runDir, { withFileTypes: true })) {
        if (!c.isDirectory()) continue;
        const caseDir = path.join(runDir, c.name);
        sampled.push(caseDir);
        for (const l of await fs.readdir(caseDir, { withFileTypes: true })) {
          if (!l.isDirectory()) continue;
          sampled.push(path.join(caseDir, l.name), path.join(caseDir, l.name, SESSION_LOG));
        }
      }
      for (const p of sampled) {
        if (!keepFresh.includes(p) && await exists(p)) await fs.utimes(p, old, old);
      }
    }

    it('reads a label directory as a sign of life, which is all the grading phase touches', async () => {
      // `runVitest` writes its JSON report into the label dir, so that mtime is the grading heartbeat.
      await ageAllExcept([path.join(caseDirOf(), LABELS[0])]);
      const now = Date.now() + STALE_AFTER_MS / 2;
      expect((await pruneRuns(root, { keep: 1, now })).skipped).toEqual([STAMPS[0]]);
    });

    // The session phase writes nothing but session.log, and a deep write does NOT bump an ancestor
    // directory's mtime — so this is the only signal keeping a 45-minute metered session alive.
    it('reads session.log alone as a sign of life, which is all the metered session touches', async () => {
      await ageAllExcept([path.join(caseDirOf(), LABELS[0], SESSION_LOG)]);
      const now = Date.now() + STALE_AFTER_MS / 2;
      expect((await pruneRuns(root, { keep: 1, now })).skipped).toEqual([STAMPS[0]]);
    });

    it('reads the run directory alone as a sign of life', async () => {
      await ageAllExcept([path.join(root, STAMPS[0])]);
      const now = Date.now() + STALE_AFTER_MS / 2;
      expect((await pruneRuns(root, { keep: 1, now })).skipped).toEqual([STAMPS[0]]);
    });

    it('reads results.jsonl alone as a sign of life, which is all a scored case writes', async () => {
      await ageAllExcept([path.join(root, STAMPS[0], RUN_RESULTS)]);
      const now = Date.now() + STALE_AFTER_MS / 2;
      expect((await pruneRuns(root, { keep: 1, now })).skipped).toEqual([STAMPS[0]]);
    });

    it('reads a case directory alone as a sign of life, which is all a new case creates', async () => {
      await ageAllExcept([caseDirOf()]);
      const now = Date.now() + STALE_AFTER_MS / 2;
      expect((await pruneRuns(root, { keep: 1, now })).skipped).toEqual([STAMPS[0]]);
    });
  });

  it('treats a missing eval root as nothing to do, not an error', async () => {
    await expect(pruneRuns(path.join(root, 'never-created'), { keep: 1 })).resolves
      .toEqual({ pruned: [], skipped: [], trees: 0 });
  });

  it('returns empty on an eval root holding no runs', async () => {
    await expect(pruneRuns(root, { keep: 1 })).resolves.toEqual({ pruned: [], skipped: [], trees: 0 });
  });

  it('refuses a bad keep before reading the directory', async () => {
    await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
    await expect(pruneRuns(root, { keep: 0 })).rejects.toThrow(/keep/);
    expect(await exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE))).toBe(true);
  });

  // Observable ordering: a missing root returns empty rather than throwing, so this can only pass
  // if `keep` is checked before the directory is read.
  it('refuses a bad keep before touching the filesystem at all', async () => {
    await expect(pruneRuns(path.join(root, 'never-created'), { keep: 0 })).rejects.toThrow(/keep/);
  });

  // checkEnvironment lives in realDeps and runs after the first delete, so the destructive code has
  // to validate its own root: a stale or mistyped EVAL_CODING_DIR must not be pruned first and
  // complained about second.
  describe('refuses an eval root it cannot vouch for, before deleting anything', () => {
    const survives = async (): Promise<boolean> => exists(path.join(root, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE));

    beforeEach(async () => {
      await seedRun(STAMPS[0], ['tkt-aaaaaaaaaaaa']);
      await seedRun(STAMPS[1], ['tkt-cccccccccccc']);
    });

    it('refuses a relative root, which would resolve against the cwd', async () => {
      await expect(pruneRuns(path.relative(process.cwd(), root), { keep: 1 })).rejects.toThrow(/relative/);
      expect(await survives()).toBe(true);
    });

    // Canonicalized, not refused: a symlinked eval root is a legitimate thing to prune, and the
    // prune must happen at its real location.
    it('resolves a symlinked root and prunes the real directory', async () => {
      const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
      await fs.symlink(root, link);
      try {
        await expect(pruneRuns(link, { keep: 1 })).resolves.toMatchObject({ pruned: [STAMPS[0]] });
        expect(await survives()).toBe(false);
      } finally {
        await fs.unlink(link);
      }
    });

    // The bug that killed the compare-spellings version: `path.resolve` collapses `..` LEXICALLY
    // before realpath runs, so `<symlink>/..` named the symlink's parent and deleted trees there
    // while the operator meant the link's true parent. Resolving first is what fixes it.
    it('follows `..` through a symlink to the real parent, not the lexical one', async () => {
      const real = path.join(root, 'real-parent');
      const decoyParent = path.join(root, 'lexical-parent');
      await fs.mkdir(path.join(real, 'evals'), { recursive: true });
      await fs.mkdir(decoyParent, { recursive: true });
      await fs.symlink(path.join(real, 'evals'), path.join(decoyParent, 'current'));
      // Concatenated, not path.join'd: join would collapse `current/..` here in the test and the
      // `..` would never reach the code under test at all.
      const viaLink = `${decoyParent}${path.sep}current${path.sep}..`;
      await fs.mkdir(path.join(decoyParent, STAMPS[0], 'tkt-dddddddddddd', PRISTINE_TREE), { recursive: true });
      await fs.writeFile(path.join(decoyParent, STAMPS[0], RUN_REPORT), '{"ok":true}');
      await fs.mkdir(path.join(decoyParent, STAMPS[1]), { recursive: true });

      await pruneRuns(viaLink, { keep: 1 });

      // Nothing under the lexical parent may be touched — it is not where the path really points.
      expect(await exists(path.join(decoyParent, STAMPS[0], 'tkt-dddddddddddd', PRISTINE_TREE))).toBe(true);
    });

    // Narrowing a check must not deny service: realpath strips these, so comparing it against the
    // raw argument rejected spellings that are perfectly legitimate.
    it.each([`${path.sep}`, `${path.sep}.`])('accepts a root spelled with a trailing "%s"', async (suffix) => {
      await expect(pruneRuns(root + suffix, { keep: 1 })).resolves.toMatchObject({ pruned: [STAMPS[0]] });
    });

    it('refuses a root inside a git repo, where a replay would see the repo itself', async () => {
      await fs.mkdir(path.join(root, '.git'), { recursive: true });
      await expect(pruneRuns(root, { keep: 1 })).rejects.toThrow(/git repo/);
      expect(await survives()).toBe(true);
    });

    // The walk-up is the case that matters: the default eval root is a *sibling* of the repo, so a
    // check on the root alone would never see it. Every other test here would pass without the loop.
    it('refuses a root whose ancestor is a git repo', async () => {
      const nested = path.join(root, 'nested-eval-root');
      await fs.mkdir(path.join(nested, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE), { recursive: true });
      await fs.mkdir(path.join(nested, STAMPS[1]), { recursive: true });
      await fs.writeFile(path.join(root, '.git'), 'gitdir: /elsewhere');

      await expect(pruneRuns(nested, { keep: 1 })).rejects.toThrow(/git repo/);
      expect(await exists(path.join(nested, STAMPS[0], 'tkt-aaaaaaaaaaaa', PRISTINE_TREE))).toBe(true);
    });
  });
});
