import { describe, it, expect } from 'vitest';
import {
  isActiveBlocker, isStaleBlocker, computeActiveBlockerCounts, computeStaleBlockerCounts, ticketsBlockedBy,
} from './blockers.js';
import type { Ticket, StatusId } from '../../shared/constants.js';

// Minimal fixture — only id, status, and blockers matter to this module.
const mk = (id: string, status: StatusId, blockers: string[] = []): Ticket => ({
  id, title: id, type: 'task', priority: 'medium', status, order: 0,
  created: '', updated: '', body: '', project: null, blockers,
  parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
});

describe('isActiveBlocker', () => {
  it('treats board-live statuses as active', () => {
    expect(isActiveBlocker('todo')).toBe(true);
    expect(isActiveBlocker('in-progress')).toBe(true);
    expect(isActiveBlocker('backlog')).toBe(true);
  });

  it('treats done and archived as inactive', () => {
    expect(isActiveBlocker('done')).toBe(false);
    expect(isActiveBlocker('archived')).toBe(false);
  });
});

describe('computeActiveBlockerCounts', () => {
  it('counts a live blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'in-progress')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 1 });
  });

  it('excludes a done blocker (the core fix)', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'done')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('excludes an archived blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'archived')];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('excludes a dangling blocker id (target deleted / missing)', () => {
    const tickets = [mk('a', 'todo', ['ghost'])];
    expect(computeActiveBlockerCounts(tickets)).toEqual({});
  });

  it('counts only the active subset of a mixed blocker set', () => {
    const tickets = [
      mk('a', 'todo', ['b', 'c', 'd', 'ghost']),
      mk('b', 'in-progress'), mk('c', 'done'), mk('d', 'todo'),
    ];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 2 });
  });

  it('counts independently across tickets and omits zero-count entries', () => {
    const tickets = [
      mk('a', 'todo', ['x']), mk('b', 'todo', ['y']), mk('c', 'todo', ['z']),
      mk('x', 'todo'), mk('y', 'done'), mk('z', 'todo'),
    ];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 1, c: 1 });
  });
});

// tkt-5753a764e900 — an archived blocker used to vanish, so a ticket waiting on abandoned work read as ready.
describe('isStaleBlocker', () => {
  it('treats only archived as stale', () => {
    expect(isStaleBlocker('archived')).toBe(true);
    expect(isStaleBlocker('done')).toBe(false);
    expect(isStaleBlocker('todo')).toBe(false);
    expect(isStaleBlocker('in-progress')).toBe(false);
    expect(isStaleBlocker('backlog')).toBe(false);
    expect(isStaleBlocker('qa')).toBe(false);
  });

  it('is disjoint from isActiveBlocker across every status', () => {
    const all: StatusId[] = ['backlog', 'todo', 'in-progress', 'qa', 'done', 'archived'];
    for (const s of all) expect(isActiveBlocker(s) && isStaleBlocker(s)).toBe(false);
  });
});

describe('computeStaleBlockerCounts', () => {
  it('counts an archived blocker (the bug: this used to render as nothing)', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'archived')];
    expect(computeStaleBlockerCounts(tickets)).toEqual({ a: 1 });
  });

  it('does NOT count a done blocker — that dependency was genuinely satisfied', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'done')];
    expect(computeStaleBlockerCounts(tickets)).toEqual({});
  });

  it('does not count a live blocker (that is the active count, not a stale edge)', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('b', 'in-progress')];
    expect(computeStaleBlockerCounts(tickets)).toEqual({});
  });

  it('does not count a missing target — deleteTicket scrubs those, so it is a legacy artifact', () => {
    const tickets = [mk('a', 'todo', ['ghost'])];
    expect(computeStaleBlockerCounts(tickets)).toEqual({});
  });

  it('scopes to OPEN holders — a done or archived ticket does not light up', () => {
    const tickets = [
      mk('open', 'todo', ['x']), mk('closed', 'done', ['x']), mk('gone', 'archived', ['x']),
      mk('x', 'archived'),
    ];
    expect(computeStaleBlockerCounts(tickets)).toEqual({ open: 1 });
  });

  it('counts every open status as a holder', () => {
    const tickets = [
      mk('a', 'backlog', ['x']), mk('b', 'todo', ['x']),
      mk('c', 'in-progress', ['x']), mk('d', 'qa', ['x']), mk('x', 'archived'),
    ];
    expect(computeStaleBlockerCounts(tickets)).toEqual({ a: 1, b: 1, c: 1, d: 1 });
  });

  it('reports active and stale independently rather than merging them', () => {
    const tickets = [
      mk('a', 'todo', ['live', 'gone', 'finished']),
      mk('live', 'in-progress'), mk('gone', 'archived'), mk('finished', 'done'),
    ];
    expect(computeActiveBlockerCounts(tickets)).toEqual({ a: 1 });
    expect(computeStaleBlockerCounts(tickets)).toEqual({ a: 1 });
  });

  it('counts multiple archived blockers on one ticket', () => {
    const tickets = [mk('a', 'todo', ['x', 'y']), mk('x', 'archived'), mk('y', 'archived')];
    expect(computeStaleBlockerCounts(tickets)).toEqual({ a: 2 });
  });
});

describe('ticketsBlockedBy', () => {
  it('returns the tickets that list the id as a blocker', () => {
    const tickets = [mk('a', 'todo', ['b']), mk('c', 'todo', ['b']), mk('b', 'todo')];
    expect(ticketsBlockedBy('b', tickets).map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('drops archived dependents but keeps done ones', () => {
    const tickets = [
      mk('a', 'done', ['b']), mk('c', 'archived', ['b']), mk('d', 'todo', ['b']),
    ];
    expect(ticketsBlockedBy('b', tickets).map((t) => t.id)).toEqual(['a', 'd']);
  });

  it('returns empty when nothing is blocked by the id', () => {
    const tickets = [mk('a', 'todo'), mk('b', 'todo', ['a'])];
    expect(ticketsBlockedBy('z', tickets)).toEqual([]);
  });
});
