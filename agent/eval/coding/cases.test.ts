import { describe, it, expect } from 'vitest';
import {
  asTodo, classifyChangedFiles, firstStartedAt, parseCaseManifest, pickFrozenSnapshot, prNumberFromSubject,
  snapshotTime, ticketIdFromBranch, type CodingCase,
} from './cases.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const GOOD: CodingCase = {
  ticketId: 'tkt-0123456789ab',
  pr: 405,
  commit: SHA_A,
  base: SHA_B,
  testFiles: ['server/index.test.ts'],
  bodySha256: 'c'.repeat(64),
  snapshot: '2026-09-16T21-55-49-752Z-e2cc7598.md',
};
const manifest = (cases: unknown[]): string => JSON.stringify({ cases });

describe('classifyChangedFiles', () => {
  it('is eligible only when a commit changes both source and a test', () => {
    expect(classifyChangedFiles(['server/a.ts', 'server/a.test.ts', 'CLAUDE.md'])).toEqual({
      testFiles: ['server/a.test.ts'], sourceFiles: ['server/a.ts'], otherFiles: [], eligible: true,
    });
    expect(classifyChangedFiles(['server/a.test.ts']).eligible).toBe(false);
    expect(classifyChangedFiles(['server/a.ts', 'CLAUDE.md']).eligible).toBe(false);
    expect(classifyChangedFiles([]).eligible).toBe(false);
  });

  it.each([
    ['a dependency change', 'package.json'],
    ['a lockfile change', 'package-lock.json'],
    ['a test-support helper', 'test-support/tempDirs.ts'],
    ['a snapshot', 'server/__snapshots__/a.test.ts.snap'],
    ['a fixture', 'agent/eval/fixtures/corpus.json'],
    ['a markdown fixture', 'agent/eval/fixtures/corpus/tkt-fx.md'],
    ['a mock', 'server/__mocks__/fs.ts'],
    ['a root config', 'vitest.config.ts'],
  ])('is ineligible when C also changes %s — gold and a trial would be different tasks', (_label, extra) => {
    const r = classifyChangedFiles(['server/a.ts', 'server/a.test.ts', extra]);
    expect(r.eligible).toBe(false);
    expect(r.otherFiles).toEqual([extra]);
  });

  it('counts neither root config nor e2e specs', () => {
    expect(classifyChangedFiles(['vitest.config.ts', 'e2e/board.test.ts', 'e2e/x.ts']).eligible).toBe(false);
  });
});

describe('commit and branch parsing', () => {
  it('reads the PR number from a squash subject only at its end', () => {
    expect(prNumberFromSubject('Register a reporter (#405)')).toBe(405);
    expect(prNumberFromSubject('Fix (#12) regression in parser')).toBeNull();
    expect(prNumberFromSubject('Direct commit')).toBeNull();
  });

  it('refuses a branch naming two tickets rather than picking one', () => {
    expect(ticketIdFromBranch('task/tkt-0123456789ab-slug')).toBe('tkt-0123456789ab');
    expect(ticketIdFromBranch('task/tkt-0123456789ab-and-tkt-ba9876543210')).toBeNull();
    expect(ticketIdFromBranch('worktree-something')).toBeNull();
  });
});

describe('firstStartedAt', () => {
  it('returns the FIRST start, skipping other steps and junk lines', () => {
    const log = [
      '{"step":"pr_opened","at":"2026-01-01T00:00:00.000Z"}',
      'not json',
      '{"step":"started","at":"2026-01-02T00:00:00.000Z"}',
      '{"step":"started","at":"2026-01-05T00:00:00.000Z"}',
    ].join('\n');
    expect(firstStartedAt(log)).toBe('2026-01-02T00:00:00.000Z');
  });

  it('returns null with no started event or an unparseable time', () => {
    expect(firstStartedAt('')).toBeNull();
    expect(firstStartedAt('{"step":"started","at":"yesterday"}')).toBeNull();
  });
});

describe('pickFrozenSnapshot', () => {
  const start = '2026-09-16T22:00:00.000Z';
  const before = '2026-09-16T21-55-49-752Z-e2cc7598.md';
  const after1 = '2026-09-16T22-02-37-898Z-59bb56d4.md';
  const after2 = '2026-09-16T22-02-56-316Z-2ed58829.md';

  it('picks the first snapshot AFTER start — it holds the body as it stood at start', () => {
    expect(pickFrozenSnapshot([after2, before, after1], start)).toBe(after1);
  });

  it('never picks a snapshot at or before start, which holds an OLDER body', () => {
    expect(pickFrozenSnapshot([before], start)).toBeNull();
    expect(pickFrozenSnapshot(['2026-09-16T22-00-00-000Z-00000000.md'], start)).toBeNull();
  });

  it('ignores names that are not snapshots', () => {
    expect(snapshotTime('notes.md')).toBeNull();
    expect(pickFrozenSnapshot(['notes.md'], start)).toBeNull();
  });
});

describe('parseCaseManifest (strict — a bad manifest is a broken instrument)', () => {
  it('accepts a well-formed case', () => {
    expect(parseCaseManifest(manifest([GOOD]))).toEqual([GOOD]);
  });

  it.each([
    ['invalid JSON', '{', /not valid JSON/],
    ['no cases array', '{}', /no `cases` array/],
    ['an empty list', manifest([]), /empty/],
    ['a malformed id', manifest([{ ...GOOD, ticketId: 'tkt-abc' }]), /ticketId/],
    ['a short sha', manifest([{ ...GOOD, commit: 'abc123' }]), /commit/],
    ['base equal to commit', manifest([{ ...GOOD, base: SHA_A }]), /base equals commit/],
    ['no test files', manifest([{ ...GOOD, testFiles: [] }]), /testFiles/],
    ['a non-test file listed as hidden', manifest([{ ...GOOD, testFiles: ['server/a.ts'] }]), /testFiles/],
    ['a bad body hash', manifest([{ ...GOOD, bodySha256: 'x' }]), /bodySha256/],
    ['a bad snapshot name', manifest([{ ...GOOD, snapshot: 'body.md' }]), /snapshot/],
    ['a duplicate ticket', manifest([GOOD, { ...GOOD, commit: 'd'.repeat(40) }]), /twice/],
  ])('rejects %s', (_label, raw, re) => {
    expect(() => parseCaseManifest(raw)).toThrow(re);
  });
});

describe('asTodo', () => {
  const snap = '---\ntitle: x\nstatus: in-progress\norder: 1\n---\n\nbody mentions status: in-progress too\n';

  it('resets only the frontmatter status and leaves the body byte-identical', () => {
    expect(asTodo(snap)).toBe('---\ntitle: x\nstatus: todo\norder: 1\n---\n\nbody mentions status: in-progress too\n');
  });

  it('throws on a snapshot with no frontmatter or no status line', () => {
    expect(() => asTodo('just a body')).toThrow(/no frontmatter/);
    expect(() => asTodo('---\ntitle: x\n---\nbody')).toThrow(/no status line/);
  });
});
