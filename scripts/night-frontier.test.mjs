// tkt-6ed4a1a0605f — the night run's work selection. One case per dimension of the adversary list:
// autonomy, status, each blocker shape, an unparseable file, the project filter, a named id's three
// refusals, and the dependency fingerprint's five states. Every exclusion is paired with an
// inclusion, because a frontier that is always empty passes every "must not run" case.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoard, frontierOf, refuseNamed, whyNotRunnable, depsFingerprint, DEPS_MARKER } from './night-frontier.mjs';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'night-frontier-'));
  mkdirSync(join(dir, 'tickets'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const ticket = (id, fields = {}) => {
  const f = { status: 'todo', autonomy: 'afk', priority: 'medium', ...fields };
  const lines = Object.entries(f).filter(([, v]) => v !== undefined).map(([k, v]) => (Array.isArray(v)
    ? `${k}:\n${v.map((b) => `  - ${b}`).join('\n')}`
    : `${k}: ${v}`));
  writeFileSync(join(dir, 'tickets', `${id}.md`), `---\nid: ${id}\n${lines.join('\n')}\n---\nbody\n`);
};
const frontier = (o) => {
  const board = readBoard(dir);
  expect(board.ok).toBe(true);
  return frontierOf(board, o);
};

const A = 'tkt-00000000000a';
const B = 'tkt-00000000000b';
const C = 'tkt-00000000000c';
const D = 'tkt-00000000000d';

describe('frontierOf — autonomy is read by the package, and only afk admits', () => {
  it('a todo afk ticket with no blockers is the frontier', () => {
    ticket(A);
    expect(frontier()).toEqual({ queue: [A], excluded: [] });
  });

  it.each([
    ['absent', undefined],
    ['hitl', 'hitl'],
    ['a case variant', 'AFK'],
    ['an empty value', '""'],
  ])('autonomy %s is not afk, and is not even listed as excluded', (_, autonomy) => {
    ticket(A, { autonomy });
    ticket(B);
    expect(frontier()).toEqual({ queue: [B], excluded: [] });
  });
});

describe('frontierOf — status', () => {
  it.each(['backlog', 'in-progress', 'qa'])('an afk ticket in %s is excluded, with why', (status) => {
    ticket(A, { status });
    ticket(B);
    expect(frontier()).toEqual({ queue: [B], excluded: [{ id: A, why: `status is ${status}, not todo` }] });
  });

  it.each(['done', 'archived'])('an afk ticket in %s is finished work: never queued, and not listed as excluded', (status) => {
    ticket(A, { status });
    ticket(B);
    expect(frontier()).toEqual({ queue: [B], excluded: [] });
  });

  // whyNotRunnable still refuses them by name, which is what a NAMED queue reports.
  it('a named done ticket is still refused with its status', () => {
    ticket(A, { status: 'done' });
    expect(refuseNamed(readBoard(dir), [A])).toEqual([{ id: A, why: 'status is done, not todo' }]);
  });
});

describe('frontierOf — blockers resolve by STATUS, and only done closes one', () => {
  it('every blocker done → runnable', () => {
    ticket(B, { status: 'done', autonomy: 'hitl' });
    ticket(C, { status: 'done', autonomy: 'hitl' });
    ticket(A, { blockers: [B, C] });
    expect(frontier().queue).toEqual([A]);
  });

  it.each(['backlog', 'todo', 'in-progress', 'qa', 'archived'])('a blocker in %s excludes, naming it', (status) => {
    ticket(B, { status, autonomy: 'hitl' });
    ticket(A, { blockers: [B] });
    expect(frontier()).toEqual({ queue: [], excluded: [{ id: A, why: `blocked by ${B}(${status})` }] });
  });

  it('a blocker that does not exist excludes as missing — link rot is never a free pass', () => {
    ticket(A, { blockers: [B] });
    expect(frontier().excluded).toEqual([{ id: A, why: `blocked by ${B}(missing)` }]);
  });

  it('a blocker whose file cannot be parsed reads as missing', () => {
    writeFileSync(join(dir, 'tickets', `${B}.md`), '---\nstatus: [unclosed\n---\n');
    ticket(A, { blockers: [B] });
    expect(frontier().excluded).toEqual([{ id: A, why: `blocked by ${B}(missing)` }]);
  });

  it('names every open blocker, not just the first', () => {
    ticket(B, { status: 'done', autonomy: 'hitl' });
    ticket(C, { status: 'qa', autonomy: 'hitl' });
    ticket(A, { blockers: [B, C, D] });
    expect(frontier().excluded[0].why).toBe(`blocked by ${C}(qa), ${D}(missing)`);
  });

  it('a ticket blocking itself is excluded, not a loop', () => {
    ticket(A, { blockers: [A] });
    expect(frontier().excluded).toEqual([{ id: A, why: `blocked by ${A}(todo)` }]);
  });

  // The DAG case: a parent slice still in flight holds back both of its dependents.
  it('dependents of an unmerged slice wait while an independent one runs', () => {
    ticket(A, { status: 'qa' });
    ticket(B, { blockers: [A] });
    ticket(C, { blockers: [A] });
    ticket(D);
    expect(frontier().queue).toEqual([D]);
  });
});

describe('frontierOf — order and the project filter', () => {
  it('orders priority first, then the board order, then id', () => {
    ticket(D, { priority: 'low' });
    ticket(C, { priority: 'urgent', order: 5 });
    ticket(B, { priority: 'urgent', order: 1 });
    ticket(A, { priority: 'high' });
    expect(frontier().queue).toEqual([B, C, A, D]);
  });

  it('breaks a full tie by id, so the order never depends on the directory listing', () => {
    ticket(B);
    ticket(A);
    expect(frontier().queue).toEqual([A, B]);
  });

  it('--project keeps only that project, and leaves other projects out of the excluded list too', () => {
    ticket(A, { project: 'hardpack' });
    ticket(B, { project: 'copart-filter' });
    ticket(C);
    ticket(D, { project: 'hardpack', status: 'qa' });
    expect(frontier({ project: 'hardpack' })).toEqual({ queue: [A], excluded: [{ id: D, why: 'status is qa, not todo' }] });
  });

  it('with no project filter every project is in play, a null project included', () => {
    ticket(A, { project: 'hardpack' });
    ticket(B);
    expect(frontier().queue).toEqual([A, B]);
  });
});

describe('readBoard', () => {
  it('reports an unparseable file by name and keeps the rest', () => {
    ticket(A);
    writeFileSync(join(dir, 'tickets', `${B}.md`), '---\nstatus: nonsense\n---\n');
    const board = readBoard(dir);
    expect(board.unreadable).toEqual([`${B}.md`]);
    expect([...board.tickets.keys()]).toEqual([A]);
  });

  it('ignores files that are not tickets', () => {
    ticket(A);
    writeFileSync(join(dir, 'tickets', 'README.md'), 'not a ticket');
    mkdirSync(join(dir, 'tickets', '.history'));
    const board = readBoard(dir);
    expect(board.unreadable).toEqual([]);
    expect([...board.tickets.keys()]).toEqual([A]);
  });

  it('a board that cannot be listed is a failure, never an empty frontier', () => {
    const res = readBoard(join(dir, 'nope'));
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not be listed \(ENOENT\)/);
  });
});

describe('refuseNamed — a named id must be in the frontier', () => {
  it('passes a frontier ticket', () => {
    ticket(A);
    expect(refuseNamed(readBoard(dir), [A])).toEqual([]);
  });

  it('refuses a hitl one, an absent one and a repeat, each with its reason', () => {
    ticket(A);
    ticket(B, { autonomy: 'hitl' });
    expect(refuseNamed(readBoard(dir), [A, B, C, A])).toEqual([
      { id: B, why: 'autonomy is hitl, not afk' },
      { id: C, why: 'not on the board (or its file is unreadable)' },
      { id: A, why: 'named twice' },
    ]);
  });

  it('reuses the frontier rule, so a blocked one is refused for the same reason', () => {
    ticket(A, { blockers: [B] });
    const board = readBoard(dir);
    expect(refuseNamed(board, [A])).toEqual([{ id: A, why: whyNotRunnable(board.tickets.get(A), board.tickets) }]);
    expect(refuseNamed(board, [A])[0].why).toBe(`blocked by ${B}(missing)`);
  });
});

describe('depsFingerprint — the primary node_modules shared by every parallel slice', () => {
  const marker = () => join(dir, DEPS_MARKER);
  const write = (text) => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true });
    writeFileSync(marker(), text);
  };

  it('an absent install is a readable state, not a failure', () => {
    expect(depsFingerprint(dir)).toEqual({ ok: true, value: 'absent' });
  });

  it('is stable when nothing changed', () => {
    write('{"a":1}');
    expect(depsFingerprint(dir)).toEqual(depsFingerprint(dir));
  });

  it('moves when the lock content changes', () => {
    write('{"a":1}');
    const before = depsFingerprint(dir);
    write('{"a":2}');
    expect(depsFingerprint(dir).value).not.toBe(before.value);
  });

  it('moves when the tree is rebuilt with identical bytes, as `npm ci` does', () => {
    write('{"a":1}');
    const before = depsFingerprint(dir);
    rmSync(join(dir, 'node_modules'), { recursive: true });
    write('{"a":1}');
    expect(depsFingerprint(dir).value).not.toBe(before.value);
  });

  it('moves when an install appears where there was none', () => {
    const before = depsFingerprint(dir);
    write('{}');
    expect(depsFingerprint(dir).value).not.toBe(before.value);
  });

  it('an unreadable marker is a failure, never "absent"', () => {
    mkdirSync(marker(), { recursive: true });
    const res = depsFingerprint(dir);
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/EISDIR/);
  });
});
