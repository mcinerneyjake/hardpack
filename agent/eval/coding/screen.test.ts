import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { parseCaseManifest, type CodingCase } from './cases.js';
import { applyScreen, parseScreen } from './screen.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHA = 'c'.repeat(64);
const ST = 'e'.repeat(64);
const STMTS: ReadonlyMap<string, string> = new Map(['1', '2', '3', '4'].map((n) => [`tkt-00000000000${n}`, ST]));

const entry = (o: Record<string, unknown> = {}) => ({ bodySha256: SHA, commit: 'a'.repeat(40), testFiles: ['h.test.ts'], statementSha256: ST, verdict: 'partly', scorable: true, note: 'helper name only', ...o });
const raw = (cases: unknown) => JSON.stringify({ cases });

const mk = (id: string, o: Partial<CodingCase> = {}): CodingCase => ({
  ticketId: id, pr: 1, commit: 'a'.repeat(40), base: 'b'.repeat(40), testFiles: ['h.test.ts'], bodySha256: SHA,
  snapshot: '2026-09-16T21-55-49-752Z-e2cc7598.md', ...o,
});

describe('parseScreen', () => {
  it('parses every verdict shape it allows', () => {
    const s = parseScreen(raw({
      'tkt-000000000001': entry({ verdict: 'yes', scorable: true }),
      'tkt-000000000002': entry({ verdict: 'partly', scorable: false }),
      'tkt-000000000003': entry({ verdict: 'no', scorable: false }),
    }));
    expect(s.size).toBe(3);
    expect(s.get('tkt-000000000003')).toEqual(entry({ verdict: 'no', scorable: false }));
  });

  it('accepts an empty screen, which applyScreen then treats as nothing scorable', () => {
    expect(parseScreen(raw({})).size).toBe(0);
  });

  it.each([
    ['invalid JSON', '{', /not valid JSON/],
    ['no cases', '{}', /no `cases` object/],
    ['cases as an array', raw([entry()]), /no `cases` object/],
    ['a malformed id', raw({ 'tkt-XYZ': entry() }), /well-formed tkt- id/],
    ['a non-object entry', raw({ 'tkt-000000000001': 'no' }), /not an object/],
    ['a short sha', raw({ 'tkt-000000000001': entry({ bodySha256: 'abc' }) }), /sha256/],
    ['a short commit', raw({ 'tkt-000000000001': entry({ commit: 'abc' }) }), /commit is not a full sha/],
    ['empty testFiles', raw({ 'tkt-000000000001': entry({ testFiles: [] }) }), /testFiles/],
    ['an unknown verdict', raw({ 'tkt-000000000001': entry({ verdict: 'maybe' }) }), /yes, partly or no/],
    ['a string scorable', raw({ 'tkt-000000000001': entry({ scorable: 'false' }) }), /boolean/],
    ['a "no" marked scorable', raw({ 'tkt-000000000001': entry({ verdict: 'no', scorable: true }) }), /cannot be scorable/],
    ['a "yes" marked unscorable', raw({ 'tkt-000000000001': entry({ verdict: 'yes', scorable: false }) }), /must be scorable/],
    ['a missing statementSha256', raw({ 'tkt-000000000001': entry({ statementSha256: undefined }) }), /statementSha256/],
    ['a short statementSha256', raw({ 'tkt-000000000001': entry({ statementSha256: 'abc' }) }), /statementSha256/],
    ['a blank note', raw({ 'tkt-000000000001': entry({ note: '  ' }) }), /note/],
  ])('rejects %s', (_label, input, err) => {
    expect(() => parseScreen(input)).toThrow(err);
  });

  it('rejects a duplicated id, which JSON.parse would otherwise resolve to the last copy', () => {
    const no = JSON.stringify(entry({ verdict: 'no', scorable: false }));
    const yes = JSON.stringify(entry({ verdict: 'yes', scorable: true }));
    expect(() => parseScreen(`{"cases":{"tkt-000000000001":${no},"tkt-000000000001":${yes}}}`)).toThrow(/lists tkt-000000000001 twice/);
  });

  it('does not mistake an id quoted inside a note for a duplicate key', () => {
    const s = parseScreen(raw({ 'tkt-000000000001': entry({ note: '"tkt-000000000001": appears in prose' }) }));
    expect(s.size).toBe(1);
  });
});

describe('applyScreen — fails closed', () => {
  const screen = parseScreen(raw({
    'tkt-000000000001': entry(),
    'tkt-000000000002': entry({ verdict: 'no', scorable: false }),
    'tkt-000000000003': entry(),
  }));

  it('keeps only cases screened scorable against the same body', () => {
    const { scorable, screenedOut } = applyScreen(
      [mk('tkt-000000000001'), mk('tkt-000000000002'), mk('tkt-000000000003', { bodySha256: 'd'.repeat(64) }), mk('tkt-000000000004')],
      screen,
      STMTS,
    );
    expect(scorable.map((c) => c.ticketId)).toEqual(['tkt-000000000001']);
    expect(screenedOut).toEqual([
      { ticketId: 'tkt-000000000002', reason: 'underspecified (no)' },
      { ticketId: 'tkt-000000000003', reason: expect.stringMatching(/stale screen/) },
      { ticketId: 'tkt-000000000004', reason: expect.stringMatching(/unscreened/) },
    ]);
  });

  it.each([
    ['a different commit', { commit: 'e'.repeat(40) }],
    ['an added hidden test file', { testFiles: ['h.test.ts', 'k.test.ts'] }],
    ['a renamed hidden test file', { testFiles: ['k.test.ts'] }],
  ])('treats %s as a stale screen', (_label, o) => {
    const { scorable, screenedOut } = applyScreen([mk('tkt-000000000001', o)], screen, STMTS);
    expect(scorable).toEqual([]);
    expect(screenedOut[0].reason).toMatch(/stale screen/);
  });

  it.each([
    ['a statement that changed since it was judged', new Map([['tkt-000000000001', 'f'.repeat(64)]]), /^stale screen — judged a different task statement/],
    ['no statement built for the case', new Map<string, string>(), /^no task statement could be built/],
  ])('screens out %s, even for a "yes"', (_label, statements, reason) => {
    const s = parseScreen(raw({ 'tkt-000000000001': entry({ verdict: 'yes', scorable: true }) }));
    const { scorable, screenedOut } = applyScreen([mk('tkt-000000000001')], s, statements);
    expect(scorable).toEqual([]);
    expect(screenedOut[0].reason).toMatch(reason);
  });

  it('ignores testFiles order', () => {
    const s = parseScreen(raw({ 'tkt-000000000001': entry({ testFiles: ['b.test.ts', 'a.test.ts'] }) }));
    expect(applyScreen([mk('tkt-000000000001', { testFiles: ['a.test.ts', 'b.test.ts'] })], s, STMTS).scorable).toHaveLength(1);
  });
});

describe('the committed screen covers the committed manifest', () => {
  const cases = parseCaseManifest(fs.readFileSync(path.join(here, 'cases.json'), 'utf8'));
  const screen = parseScreen(fs.readFileSync(path.join(here, 'screen.json'), 'utf8'));

  // Statement hashes need the gitignored board snapshots, so CI checks the rest of the binding only.
  it('binds a verdict to every case\'s current body, commit and hidden tests', () => {
    const asJudged = new Map([...screen].map(([id, e]) => [id, e.statementSha256]));
    const { screenedOut } = applyScreen(cases, screen, asJudged);
    expect(screenedOut.filter((r) => !r.reason.startsWith('underspecified'))).toEqual([]);
  });

  it('holds no verdict for a ticket the manifest no longer lists, which a re-select would silently revive', () => {
    const ids = new Set(cases.map((c) => c.ticketId));
    expect([...screen.keys()].filter((id) => !ids.has(id))).toEqual([]);
  });
});
