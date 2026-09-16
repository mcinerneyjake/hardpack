import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldWrite, isMain, emitSnapshot, costOf, priceKey, unpricedBlocksWrite, topLevelFiles } from './analyze-hardpack-savings.mjs';

const MODULE = fileURLToPath(new URL('./analyze-hardpack-savings.mjs', import.meta.url));

// tkt-48680743ed36. The whole module was top-level, so merely IMPORTING it ran the full analysis and
// OVERWROTE the tracked snapshot — observed 2026-08-11 changing asOf, mergedPRs (155→246) and loc,
// caught only because `git status` happened to flag the file. The snapshot is a deliberately frozen,
// asOf-dated source for src/components/EconomicsBuildSection.tsx and published figures.
describe('analyze-hardpack-savings is inert unless run deliberately', () => {
  // KANBAN_REPO drives the transcript search path, so pointing it at an empty dir makes the analysis
  // find nothing and exit 1 — on ANY machine, with or without real ~/.claude sessions. That is what
  // lets the direct-run control below be deterministic here and in CI alike, without needing the
  // multi-second real analysis.
  const run = (args, extraEnv = {}) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'econ-guard-'));
    const out = path.join(dir, 'snapshot.json');
    try {
      const r = spawnSync(process.execPath, args, {
        encoding: 'utf8',
        env: { ...process.env, OUT: out, KANBAN_REPO: path.join(dir, 'no-such-repo') },
        ...extraEnv,
      });
      return { ...r, wroteFile: existsSync(out) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('an IMPORT writes nothing and runs nothing — the incident', () => {
    const r = run(['-e', `import(${JSON.stringify(MODULE)})`]);
    expect(r.wroteFile).toBe(false);
    expect(r.status).toBe(0);
    // Silent, not merely write-free: the analysis parses every transcript, so an unguarded import
    // also cost seconds and a page of output. Reaching the analysis at all would print this.
    expect(r.stderr).not.toContain('No transcripts found');
  });

  it('a DIRECT run does reach the analysis — the control that isMain is not simply always false', () => {
    // Without this, a guard that never lets main() run would pass the test above identically.
    const r = run([MODULE, '--write']);
    expect(r.stderr).toContain('No transcripts found');
    expect(r.status).toBe(1);
  });

  // KNOWN GAP, stated rather than papered over: nothing here asserts that main() still CALLS
  // emitSnapshot. Deleting that call leaves this suite green, because reaching it needs the real
  // multi-second transcript analysis, which does not exist in CI. Asserting the source text instead
  // would be a substring match on code — the weak form this repo already calls out.
  //
  // The residual is acceptable because it is LOUD, unlike the bug being fixed: a main() that stopped
  // writing prints neither "Wrote" nor "DRY RUN", so `--write` producing nothing is immediately
  // visible. The defect this ticket exists for was silent — an import that overwrote a tracked file
  // with nobody looking.
  it('exports isMain as false when imported', () => {
    expect(isMain).toBe(false); // vitest imports this file; the module is not argv[1]
  });

  describe('the --write gate', () => {
    it('requires the flag, and is not satisfied by a lookalike', () => {
      expect(shouldWrite(['--write'])).toBe(true);
      expect(shouldWrite(['--foo', '--write'])).toBe(true);
      for (const argv of [[], ['--dry-run'], ['-w'], ['--write-snapshot'], ['write']]) {
        expect(shouldWrite(argv), JSON.stringify(argv)).toBe(false);
      }
    });

    it('is WIRED to the write, not merely consulted', () => {
      // Testing shouldWrite alone was not enough: mutating the call site to `if (true)` left the
      // suite green, because no test could reach the write past the transcript analysis. This drives
      // the write path directly, so the wiring itself is what goes red.
      const dir = mkdtempSync(path.join(tmpdir(), 'econ-emit-'));
      const file = path.join(dir, 'snapshot.json');
      const payload = { asOf: '2026-01-01' };
      try {
        expect(emitSnapshot([], file, payload)).toBe(false);
        expect(existsSync(file)).toBe(false);

        expect(emitSnapshot(['--write'], file, payload)).toBe(true);
        expect(existsSync(file)).toBe(true);
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(payload);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// tkt-feb341a5c699. `PRICES` had no `claude-opus-5`, so costOf returned 0 for it and 36,296 responses
// — 80% of every token measured — were published as free. The cumulative cost FELL, $2485.30 (07-21)
// to $1670.95 (08-16), while merged PRs rose 155 -> 301, and ROI inflated 12.5-18.7x to 36-54x.
// An unknown model must be loud; a zero is indistinguishable from a genuinely free response.
describe('an unpriceable model is reported, never priced at zero', () => {
  const usage = { input: 1e6, output: 1e6, w5: 0, w1: 0, read: 0 };

  it('returns NULL, not 0, for a model with no price', () => {
    // The distinction is the whole fix: `0` is a number the totals happily absorb.
    expect(costOf('claude-opus-9-future', usage)).toBeNull();
    expect(costOf('', usage)).toBeNull();
    expect(costOf(undefined, usage)).toBeNull();
  });

  it('prices the model that was missing, at the published rate', () => {
    // $5/MTok in + $25/MTok out on 1M each. Hand-computed from the rate card, not from the code.
    expect(costOf('claude-opus-5', usage)).toBeCloseTo(30, 6);
    expect(costOf('claude-opus-5[1m]', usage)).toBeCloseTo(30, 6);
  });

  it('keeps sonnet-5 at its actual $2/$10, which the table had wrong as $3/$15', () => {
    expect(costOf('claude-sonnet-5', usage)).toBeCloseTo(12, 6);
    expect(costOf('claude-sonnet-4-6', usage)).toBeCloseTo(18, 6); // the $3/$15 tier, unchanged
  });

  it('still prices a dated model id, and still zeroes only the genuinely unbilled one', () => {
    expect(priceKey('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    // `<synthetic>` is Claude Code's marker for a locally-generated, never-billed message — the one
    // string whose true cost IS zero. It must not land in the unpriced bucket and block the write.
    expect(costOf('<synthetic>', usage)).toBe(0);
  });

  it('applies the cache multipliers the rate card specifies', () => {
    // 1.25x / 2x / 0.1x of the $5 input rate, on 1M tokens each = 6.25 + 10 + 0.5.
    expect(costOf('claude-opus-5', { input: 0, output: 0, w5: 1e6, w1: 1e6, read: 1e6 })).toBeCloseTo(16.75, 6);
  });

  describe('the write gate', () => {
    const gap = { 'claude-opus-5': { messages: 36296, tokens: 7_797_000_000 } };

    it('blocks the write and names the model and its volume', () => {
      const reason = unpricedBlocksWrite(gap, []);
      // Asserting the specific content, not merely that something was returned: a generic "blocked"
      // leaves the reader with no way to know WHICH model to add.
      expect(reason).toContain('claude-opus-5');
      expect(reason).toContain('36296 responses');
      expect(reason).toContain('7797M tokens');
    });

    it('permits a clean run — the control that it does not block unconditionally', () => {
      expect(unpricedBlocksWrite({}, [])).toBeNull();
      expect(unpricedBlocksWrite(undefined, [])).toBeNull();
    });

    it('is overridable only by the documented flag', () => {
      expect(unpricedBlocksWrite(gap, ['--allow-unpriced'])).toBeNull();
      for (const argv of [['--allow'], ['--allowunpriced'], ['allow-unpriced']]) {
        expect(unpricedBlocksWrite(gap, argv), JSON.stringify(argv)).not.toBeNull();
      }
    });

    it('is WIRED to emitSnapshot, and refuses even with --write', () => {
      // The lesson from the --write gate above: testing the predicate alone left the call site
      // mutable to `if (false)` with the suite green. This drives the real write path.
      const dir = mkdtempSync(path.join(tmpdir(), 'econ-unpriced-'));
      const file = path.join(dir, 'snapshot.json');
      const before = process.exitCode;
      try {
        const blocked = { asOf: '2026-01-01', measured: { unpricedUsage: gap } };
        expect(emitSnapshot(['--write'], file, blocked)).toBe(false);
        expect(existsSync(file), 'a snapshot with unpriced spend must not reach disk').toBe(false);
        expect(process.exitCode, 'a console warning alone scrolls past in a pipeline').toBe(2);

        // The control: same payload, empty gap, and the write goes through — so the refusal above is
        // attributable to the unpriced models and not to the extra `measured` key.
        process.exitCode = before;
        const clean = { asOf: '2026-01-01', measured: { unpricedUsage: {} } };
        expect(emitSnapshot(['--write'], file, clean)).toBe(true);
        expect(existsSync(file)).toBe(true);
      } finally {
        process.exitCode = before;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});

// tkt-cc42ea05eb4b: the match was keyed to the `-kanban` slug, so the move to projects/hardpack
// classified every session as a subagent and published 0.0 supervised hours.
describe('topLevelFiles classifies by the walked directory, not its name', () => {
  const projects = path.join(path.sep, 'home', '.claude', 'projects');
  const main = path.join(projects, '-Users-x-projects-hardpack');
  const agent = `${main}-agent`;

  it('counts a session directly in a hardpack project dir as top-level', () => {
    const f = path.join(main, 'aaaa.jsonl');
    expect(topLevelFiles([f], [main, agent]).has(f)).toBe(true);
  });

  it('counts a session in the -agent dir as top-level', () => {
    const f = path.join(agent, 'bbbb.jsonl');
    expect(topLevelFiles([f], [main, agent]).has(f)).toBe(true);
  });

  it('does not count a subagent transcript nested under a session', () => {
    const f = path.join(main, 'aaaa', 'subagents', 'agent-1.jsonl');
    expect(topLevelFiles([f], [main, agent]).has(f)).toBe(false);
  });

  it('does not count a sibling dir that merely shares the slug prefix', () => {
    const f = path.join(`${main}--claude-worktrees-tkt-x`, 'cccc.jsonl');
    expect(topLevelFiles([f], [main, agent]).has(f)).toBe(false);
  });

  it('works for any directory name, so the next rename cannot zero it', () => {
    const other = path.join(projects, '-Users-x-projects-anything-else');
    const top = path.join(other, 'dddd.jsonl');
    const nested = path.join(other, 'dddd', 'subagents', 'e.jsonl');
    expect([...topLevelFiles([top, nested], [other])]).toEqual([top]);
  });

  it('returns an empty set for no files', () => {
    expect(topLevelFiles([], [main]).size).toBe(0);
  });
});
