// Pinned to a UTC-behind zone: CI runners are UTC, where a local-vs-UTC date bug is INVISIBLE because
// the two agree. Set before importing anything that touches Date.
process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { matchesFilter, filterTickets } from './filterTickets.js';
import { defaultFilter, type FilterState } from '../components/FilterPopover.js';
import type { Ticket } from '../../shared/constants.js';

const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1', title: 'Title', type: 'feature', priority: 'medium', status: 'backlog', order: 0,
  created: '2026-07-01T00:00:00.000Z', updated: '2026-07-10T00:00:00.000Z', body: 'Body',
  project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
  ...over,
});

const f = (over: Partial<FilterState> = {}): FilterState => ({ ...defaultFilter, ...over });

describe('matchesFilter', () => {
  it('passes everything under the default (empty) filter', () => {
    expect(matchesFilter(mk(), defaultFilter, '')).toBe(true);
  });

  it('filters by type (multi-select is OR)', () => {
    expect(matchesFilter(mk({ type: 'bug' }), f({ types: ['bug'] }), '')).toBe(true);
    expect(matchesFilter(mk({ type: 'feature' }), f({ types: ['bug'] }), '')).toBe(false);
    expect(matchesFilter(mk({ type: 'chore' }), f({ types: ['bug', 'chore'] }), '')).toBe(true);
  });

  it('filters by priority', () => {
    expect(matchesFilter(mk({ priority: 'high' }), f({ priority: 'high' }), '')).toBe(true);
    expect(matchesFilter(mk({ priority: 'low' }), f({ priority: 'high' }), '')).toBe(false);
  });

  it('filters by project (a null project never matches a set project filter)', () => {
    expect(matchesFilter(mk({ project: 'kanban' }), f({ project: 'kanban' }), '')).toBe(true);
    expect(matchesFilter(mk({ project: 'other' }), f({ project: 'kanban' }), '')).toBe(false);
    expect(matchesFilter(mk({ project: null }), f({ project: 'kanban' }), '')).toBe(false);
  });

  it('filters by assignee (null assignee excluded when a filter is set)', () => {
    expect(matchesFilter(mk({ assignee: 'jake' }), f({ assignee: 'jake' }), '')).toBe(true);
    expect(matchesFilter(mk({ assignee: null }), f({ assignee: 'jake' }), '')).toBe(false);
  });

  it('filters by a created-date range, inclusive on both bounds', () => {
    const t = mk({ created: '2026-07-05T12:00:00.000Z' });
    expect(matchesFilter(t, f({ dateFrom: '2026-07-05', dateTo: '2026-07-05' }), '')).toBe(true); // boundary
    expect(matchesFilter(t, f({ dateFrom: '2026-07-01', dateTo: '2026-07-10' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateFrom: '2026-07-06' }), '')).toBe(false);
    expect(matchesFilter(t, f({ dateTo: '2026-07-04' }), '')).toBe(false);
  });

  it('honors dateField (updated vs created)', () => {
    const t = mk({ created: '2026-07-01T00:00:00.000Z', updated: '2026-07-20T00:00:00.000Z' });
    expect(matchesFilter(t, f({ dateField: 'updated', dateFrom: '2026-07-15' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateField: 'created', dateFrom: '2026-07-15' }), '')).toBe(false);
  });

  it('searches title and body, case-insensitively', () => {
    expect(matchesFilter(mk({ title: 'Fix the WIDGET' }), defaultFilter, 'widget')).toBe(true);
    expect(matchesFilter(mk({ title: 'x', body: 'a Gadget here' }), defaultFilter, 'gadget')).toBe(true);
    expect(matchesFilter(mk({ title: 'x', body: 'y' }), defaultFilter, 'zzz')).toBe(false);
  });

  it('ANDs across fields — every active clause must pass', () => {
    const t = mk({ type: 'bug', priority: 'high', project: 'kanban' });
    expect(matchesFilter(t, f({ types: ['bug'], priority: 'high', project: 'kanban' }), '')).toBe(true);
    expect(matchesFilter(t, f({ types: ['bug'], priority: 'low' }), '')).toBe(false);
  });
});

describe('filterTickets', () => {
  it('returns only matching tickets and preserves order', () => {
    const tickets = [mk({ id: 'a', type: 'bug' }), mk({ id: 'b', type: 'feature' }), mk({ id: 'c', type: 'bug' })];
    expect(filterTickets(tickets, f({ types: ['bug'] }), '').map((t) => t.id)).toEqual(['a', 'c']);
  });

  it('returns all tickets under the default filter', () => {
    const tickets = [mk({ id: 'a' }), mk({ id: 'b' })];
    expect(filterTickets(tickets, defaultFilter, '')).toHaveLength(2);
  });
});

// tkt-17dbc816e247 — `completedAt` is absent on tickets completed before telemetry existed
// (73 done + 212 archived on the live board), so the date branch must never assume a value.
describe('completedAt date filtering', () => {
  it('does not throw when the ticket has no completedAt', () => {
    expect(() =>
      matchesFilter(mk(), f({ dateField: 'completedAt', dateFrom: '2026-08-11' }), '')
    ).not.toThrow();
  });

  it('excludes a ticket with no completedAt from a completed-date range', () => {
    expect(matchesFilter(mk(), f({ dateField: 'completedAt', dateFrom: '2026-08-11' }), '')).toBe(false);
  });
});

// tkt-cb6ee8e7fdd0 — created/updated compared UTC dates against local date inputs, so 186 of 887 real
// `created` stamps (21%) matched the wrong day.
describe('created/updated use the local calendar day', () => {
  // Without this the whole block degrades to comparing UTC against UTC and passes while the bug is live.
  it('control: the runner is in a UTC-behind zone, so local and UTC dates can differ', () => {
    expect(new Date('2026-08-12T03:30:00.000Z').getHours()).not.toBe(3);
  });

  it('matches a late-evening creation under its LOCAL day, not the next UTC one', () => {
    // 23:30 EDT on Aug 11 is 03:30Z on Aug 12 — a naive slice(0,10) yields '2026-08-12'.
    const t = mk({ created: '2026-08-12T03:30:00.000Z' });
    expect(t.created.slice(0, 10)).toBe('2026-08-12'); // the old behavior, for contrast
    expect(matchesFilter(t, f({ dateFrom: '2026-08-11', dateTo: '2026-08-11' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateFrom: '2026-08-12', dateTo: '2026-08-12' }), '')).toBe(false);
  });

  it('applies the same rule to updated', () => {
    const t = mk({ updated: '2026-08-12T03:30:00.000Z' });
    expect(matchesFilter(t, f({ dateField: 'updated', dateFrom: '2026-08-11', dateTo: '2026-08-11' }), ''))
      .toBe(true);
  });

  // NOT a repro — a regression guard. It passes before AND after the fix, and that is the point: 72 of
  // the 887 live tickets are bulk-seeded with `created` at exactly T00:00:00.000Z, a nominal calendar
  // DATE rather than an instant. Converting those to local time would move all 72 back a day.
  it('leaves a date-only stamp (exact UTC midnight) on its stated day', () => {
    const t = mk({ created: '2026-07-31T00:00:00.000Z' });
    expect(matchesFilter(t, f({ dateFrom: '2026-07-31', dateTo: '2026-07-31' }), '')).toBe(true);
    expect(matchesFilter(t, f({ dateFrom: '2026-07-30', dateTo: '2026-07-30' }), '')).toBe(false);
  });

  it('treats a stamp one millisecond past midnight as a real instant', () => {
    const t = mk({ created: '2026-07-31T00:00:00.001Z' });
    expect(matchesFilter(t, f({ dateFrom: '2026-07-30', dateTo: '2026-07-30' }), '')).toBe(true);
  });

  // Frontmatter is hand-editable, so an unparseable date must drop out of the range rather than take
  // the board render down with it.
  it('excludes an unparseable stamp instead of throwing', () => {
    const t = mk({ created: 'not-a-date' });
    expect(() => matchesFilter(t, f({ dateFrom: '2026-07-30' }), '')).not.toThrow();
    expect(matchesFilter(t, f({ dateFrom: '2026-07-30' }), '')).toBe(false);
  });
});
