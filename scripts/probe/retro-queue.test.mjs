import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  ProbeError,
  VERBS,
  classifyProposals,
  proposalsNameForTranscript,
  assertInstruments,
  scanRetros,
  scanTranscripts,
  findings,
  formatReport,
  runCli,
} from './retro-queue.mjs';
import { proposalsFileName } from '../../agent/retro/proposals.js';

// tkt-caf80d719c0b. What this pins is the EXIT-CODE CONTRACT and the seam to agent/retro. The failure
// that matters is not a wrong count — it is the probe reporting an empty queue from a scan that never
// happened, or from a directory nobody wrote to. Every cannot-scan path below must exit 2, never 0.

// Fixtures inside the repo, never os.tmpdir(): no suite writes outside the workspace.
const FIXTURES = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.tmp-test');
const CLI = fileURLToPath(new URL('./retro-queue.mjs', import.meta.url));

let root;
beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'retro-queue-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const proposals = (lessons, extra = '') => `# Retrospective proposals — s1\n\n- Lessons: ${lessons} · dropped for citing no turn in their excerpt: 0\n\n## Lessons\n${extra}`;

/** The probe accepts a root only when it is affirmatively identifiable as a repo root. */
function repoRootFixture() {
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
  mkdirSync(join(root, 'retros'), { recursive: true });
  return root;
}

function retros(files) {
  repoRootFixture();
  const dir = join(root, 'retros');
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

// `err.status` is null when the spawn itself failed; -1 keeps that distinguishable from a real 0.
// process.execPath, not PATH's `node`: on this machine node is x86_64 under Rosetta, so the two can
// genuinely differ (merged-branches.test.mjs uses the same).
function run(args) {
  try {
    return { status: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('classifyProposals', () => {
  it('returns null for a file carrying no generated header', () => {
    expect(classifyProposals('# Notes\n\nnothing generated here\n')).toBeNull();
  });

  it('reads a file with no disposition section as fully outstanding', () => {
    const c = classifyProposals(proposals(3));
    expect(c).toMatchObject({ lessons: 3, dispositioned: false, missing: [1, 2, 3] });
  });

  it('reads a complete disposition', () => {
    const c = classifyProposals(`${proposals(2)}\n## Disposition\n\n- 1: memory — kept\n- 2: drop — noise\n`);
    expect(c).toMatchObject({ lessons: 2, dispositioned: true, covered: [1, 2], missing: [], unknown: [] });
  });

  it('reports the lessons a partial disposition leaves out', () => {
    const c = classifyProposals(`${proposals(3)}\n## Disposition\n\n- 1: ticket — filed\n- 3: drop — no\n`);
    expect(c.missing).toEqual([2]);
  });

  it('reports an unknown verb instead of silently ignoring the line', () => {
    const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n- 1: promote — to memory\n`);
    expect(c.unknown).toEqual([{ n: 1, verb: 'promote' }]);
    expect(c.missing).toEqual([1]);
  });

  it('does not count a fenced sample disposition', () => {
    const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n\`\`\`\n- 1: memory — sample\n\`\`\`\n`);
    expect(c.missing).toEqual([1]);
  });

  // The three below are the fail-opens the high-effort review found: each made a file with ZERO real
  // dispositions read as fully triaged at exit 0.
  it('does not count a sample left standing by an UNTERMINATED fence', () => {
    const c = classifyProposals(`${proposals(2)}\n## Disposition\n\n\`\`\`\n- 1: memory — sample\n- 2: drop — sample\n`);
    expect(c.missing).toEqual([1, 2]);
  });

  it('strips tilde fences as well as backtick fences', () => {
    const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n~~~\n- 1: memory — sample\n~~~\n`);
    expect(c.missing).toEqual([1]);
  });

  it('treats a struck-out verb as retracted, not as a completed disposition', () => {
    const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n- 1: ~~memory~~ — retracted\n`);
    expect(c.missing).toEqual([1]);
    expect(c.unknown).toEqual([{ n: 1, verb: '~~memory~~' }]);
  });

  it('reports a lesson number the file does not have', () => {
    const c = classifyProposals(`${proposals(2)}\n## Disposition\n\n- 1: drop — x\n- 2: drop — y\n- 9: memory — nope\n`);
    expect(c.missing).toEqual([]);
    expect(c.outOfRange).toEqual([{ n: 9, verb: 'memory' }]);
  });

  it('still lists the outstanding lessons when a line is malformed', () => {
    const c = classifyProposals(`${proposals(3)}\n## Disposition\n\n- 1: bogus — x\n`);
    expect(findings([{ ...c, name: 'p.md' }]).partial).toHaveLength(1);
  });

  it('does not read a later section list as dispositions', () => {
    const c = classifyProposals(`${proposals(2)}\n## Disposition\n\n- 1: drop — no\n\n## Notes\n\n- 2: memory — not here\n`);
    expect(c.missing).toEqual([2]);
  });

  it('does not read a quoted transcript excerpt as a disposition', () => {
    const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n  > - 1: memory — quoted\n`);
    expect(c.missing).toEqual([1]);
  });

  it('treats a zero-lesson file as needing nothing', () => {
    const c = classifyProposals(proposals(0));
    expect(c.missing).toEqual([]);
    expect(findings([{ ...c, name: 'z.md' }]).undispositioned).toEqual([]);
  });
});

describe('the built-in control', () => {
  it('passes against the real classifier', () => {
    expect(() => assertInstruments()).not.toThrow();
  });

  // A control that cannot fail proves nothing: watch the throw path itself go red.
  it('throws when the classifier misclassifies', () => {
    const wrong = () => ({ lessons: 99, dispositioned: true, covered: [], unknown: [], outOfRange: [], missing: [] });
    expect(() => assertInstruments(wrong)).toThrow(ProbeError);
  });

  it('throws when an unparseable file would be accepted', () => {
    const real = classifyProposals;
    const tooPermissive = (doc) => real(doc) ?? { lessons: 0, dispositioned: true, covered: [], unknown: [], outOfRange: [], missing: [] };
    expect(() => assertInstruments(tooPermissive)).toThrow(/no .* header was accepted/);
  });
});

describe('the seam to agent/retro/proposals.ts', () => {
  // The probe cannot import that module (it runs under bare node; the module is TypeScript), so the
  // join key is mirrored by hand. A rename there that drifted from here would make every transcript
  // read as never retrospected — silently, and in the reassuring direction.
  it.each([
    'a1b2c3d4-0000-4000-8000-000000000000.jsonl',
    'plain.jsonl',
    'has spaces and %.jsonl',
    '...dots.jsonl',
    'ünïcode.jsonl',
  ])('agrees with proposalsFileName for %s', (name) => {
    expect(proposalsNameForTranscript(name)).toBe(proposalsFileName(null, name));
  });

  // What the cases above pin is the SANITIZER, via the sessionId === null branch. Production takes
  // the other branch (retro.ts passes transcript.sessionId), so pin the live case explicitly: the
  // two agree exactly when the parsed sessionId equals the filename stem, and diverge when it does
  // not. Asserting the divergence keeps the probe's KNOWN GAP comment honest rather than aspirational.
  it('agrees when the parsed sessionId matches the filename stem', () => {
    expect(proposalsNameForTranscript('sess-1.jsonl')).toBe(proposalsFileName('sess-1', 'sess-1.jsonl'));
  });

  it('diverges when the transcript was renamed away from its sessionId', () => {
    expect(proposalsNameForTranscript('copied.jsonl')).not.toBe(proposalsFileName('sess-1', 'copied.jsonl'));
  });
});

describe('scanRetros', () => {
  it('flags a missing directory rather than reporting an empty queue', () => {
    expect(scanRetros(join(root, 'retros')).missingDir).toBe(true);
  });

  it('lists a file with no generated header as unreadable, not as nothing to triage', () => {
    const dir = retros({ 'junk.md': '# not a proposals file\n' });
    const s = scanRetros(dir);
    expect(s.files).toEqual([]);
    expect(s.unreadable).toHaveLength(1);
  });

  it('reports age in days', () => {
    const dir = retros({ 's1.md': proposals(1) });
    const old = new Date('2026-09-01T00:00:00Z');
    utimesSync(join(dir, 's1.md'), old, old);
    const s = scanRetros(dir, Date.parse('2026-09-16T00:00:00Z'));
    expect(s.files[0].ageDays).toBe(15);
  });
});

describe('scanTranscripts', () => {
  it('lists transcripts with no proposals file', () => {
    mkdirSync(join(root, 'tx'), { recursive: true });
    writeFileSync(join(root, 'tx', 's1.jsonl'), '');
    writeFileSync(join(root, 'tx', 's2.jsonl'), '');
    expect(scanTranscripts(join(root, 'tx'), ['s1.md'])).toEqual(['s2.jsonl']);
  });

  it('refuses to report zero when the directory does not exist', () => {
    expect(() => scanTranscripts(join(root, 'nope'), [])).toThrow(ProbeError);
  });
});

describe('the CLI exit-code contract', () => {
  it('exits 0 with an empty, fully dispositioned queue', () => {
    retros({ 's1.md': `${proposals(1)}\n## Disposition\n\n- 1: drop — noise\n` });
    const r = run([root]);
    expect(r.status).toBe(EXIT.CLEAN);
  });

  it('exits 1 on an undispositioned proposal', () => {
    retros({ 's1.md': proposals(2) });
    const r = run([root]);
    expect(r.status).toBe(EXIT.FINDINGS);
    expect(r.out).toContain('UNDISPOSITIONED s1.md');
  });

  it('exits 1 on a partial disposition, naming the lesson left out', () => {
    retros({ 's1.md': `${proposals(2)}\n## Disposition\n\n- 1: memory — kept\n` });
    const r = run([root]);
    expect(r.status).toBe(EXIT.FINDINGS);
    expect(r.out).toContain('PARTIAL s1.md');
  });

  it('exits 1 on an unknown verb', () => {
    retros({ 's1.md': `${proposals(1)}\n## Disposition\n\n- 1: escalate — somewhere\n` });
    const r = run([root]);
    expect(r.status).toBe(EXIT.FINDINGS);
    expect(r.out).toContain('UNKNOWN VERB s1.md');
  });

  // The fail-closed direction: a partial scan must not be downgraded to an advisory 1, because every
  // count it printed under-reports.
  it('exits 2 when a file in the directory cannot be parsed', () => {
    retros({ 's1.md': proposals(1), 'junk.md': '# nope\n' });
    const r = run([root]);
    expect(r.status).toBe(EXIT.CANNOT_SCAN);
    expect(r.out).toContain('UNREADABLE');
  });

  it('exits 2 when the root does not exist, rather than reading as an empty queue', () => {
    const r = run([join(root, 'absent')]);
    expect(r.status).toBe(EXIT.CANNOT_SCAN);
    expect(r.out).toContain('refusing to report an empty queue');
  });

  // The wrong-root fail-open: an EXISTING but wrong path used to pass the guard, find no retros/,
  // and report "nothing to triage" at exit 0 — a clean verdict from a scan that looked elsewhere.
  it('exits 2 for an existing directory that is not a repo root', () => {
    const r = run([root]);
    expect(r.status).toBe(EXIT.CANNOT_SCAN);
    expect(r.out).toContain('not a repo root');
  });

  it('exits 2 when the root is a plain file', () => {
    writeFileSync(join(root, 'afile'), 'x');
    expect(run([join(root, 'afile')]).status).toBe(EXIT.CANNOT_SCAN);
  });

  it('scans an arbitrary directory when --dir names one explicitly', () => {
    const dir = join(root, 'elsewhere');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 's1.md'), proposals(1));
    const r = run(['--dir', dir]);
    expect(r.status).toBe(EXIT.FINDINGS);
    expect(r.out).toContain('UNDISPOSITIONED s1.md');
  });

  it('reports a non-.md entry rather than skipping it into invisibility', () => {
    repoRootFixture();
    writeFileSync(join(root, 'retros', 'stray.MD'), proposals(1));
    const r = run([root]);
    expect(r.status).toBe(EXIT.CANNOT_SCAN);
    expect(r.out).toContain('stray.MD');
  });

  it('ignores dotfiles such as .DS_Store', () => {
    repoRootFixture();
    writeFileSync(join(root, 'retros', '.DS_Store'), 'junk');
    expect(run([root]).status).toBe(EXIT.CLEAN);
  });

  it('exits 0 for an absent retros dir, and says it does not measure whether retros are run', () => {
    writeFileSync(join(root, 'package.json'), '{"name":"fixture"}');
    const r = run([root]);
    expect(r.status).toBe(EXIT.CLEAN);
    expect(r.out).toContain('nothing to triage');
    expect(r.out).toMatch(/does NOT measure whether retrospectives are being run/);
  });

  it('reports un-retrospected transcripts as not measured when the flag is absent', () => {
    retros({ 's1.md': `${proposals(1)}\n## Disposition\n\n- 1: drop — x\n` });
    expect(run([root]).out).toContain('not measured');
  });

  it('counts un-retrospected transcripts when the flag is given', () => {
    retros({ 's1.md': `${proposals(1)}\n## Disposition\n\n- 1: drop — x\n` });
    mkdirSync(join(root, 'tx'), { recursive: true });
    writeFileSync(join(root, 'tx', 's1.jsonl'), '');
    writeFileSync(join(root, 'tx', 's9.jsonl'), '');
    const r = run([root, '--transcripts', join(root, 'tx')]);
    expect(r.status).toBe(EXIT.CLEAN);
    expect(r.out).toContain('Un-retrospected transcripts: 1');
  });

  it('exits 2 when --transcripts points nowhere', () => {
    retros({ 's1.md': `${proposals(1)}\n## Disposition\n\n- 1: drop — x\n` });
    const r = run([root, '--transcripts', join(root, 'absent')]);
    expect(r.status).toBe(EXIT.CANNOT_SCAN);
  });

  it('exits 2 when --transcripts is given no argument', () => {
    expect(run([root, '--transcripts']).status).toBe(EXIT.CANNOT_SCAN);
  });
});

describe('the disposition vocabulary', () => {
  // Each verb names a route into a gate that already exists. A verb added here without a route in
  // CLAUDE.md would let the probe bless a disposition nothing governs.
  it('is exactly the four routes CLAUDE.md defines', () => {
    expect([...VERBS].sort()).toEqual(['drop', 'instruction', 'memory', 'ticket']);
  });

  it('accepts every verb', () => {
    for (const v of VERBS) {
      const c = classifyProposals(`${proposals(1)}\n## Disposition\n\n- 1: ${v} — because\n`);
      expect(c.missing, v).toEqual([]);
      expect(c.unknown, v).toEqual([]);
    }
  });
});

describe('formatReport', () => {
  it('states both facts for an absent directory', () => {
    const out = formatReport({ retros: { missingDir: true, files: [], unreadable: [] }, transcripts: null, dir: '/x/retros' });
    expect(out).toContain('nothing to triage');
    expect(out).toContain('not measured');
  });
});

describe('runCli in-process', () => {
  it('returns the report and code without spawning', () => {
    retros({ 's1.md': proposals(1) });
    const { code, report } = runCli([root]);
    expect(code).toBe(EXIT.FINDINGS);
    expect(report).toContain('1 undispositioned');
  });
});
