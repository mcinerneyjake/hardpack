process.env.TZ = 'America/New_York';

import { describe, it, expect } from 'vitest';
import { completedToday } from './completedToday.js';
import { defaultFilter, type FilterState } from '../components/FilterPopover.js';
import type { BoardTicket } from '../../shared/constants.js';

const at = (y: number, m: number, d: number, h = 12, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
const iso = (y: number, m: number, d: number, h = 12, min = 0): string => new Date(at(y, m, d, h, min)).toISOString();

const mk = (over: Partial<BoardTicket> = {}): BoardTicket => ({
  id: 'tkt-1', title: 'T', type: 'task', priority: 'medium', status: 'done', order: 0,
  created: '2026-07-01T00:00:00.000Z', updated: '2026-07-02T00:00:00.000Z', body: '',
  project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
  completedAt: iso(2026, 8, 11, 10),
  ...over,
});

const NOW = at(2026, 8, 11, 17);
const f = (over: Partial<FilterState> = {}): FilterState => ({ ...defaultFilter, ...over });

describe('completedToday', () => {
  it('counts a ticket completed earlier today', () => {
    expect(completedToday([mk()], defaultFilter, NOW)).toHaveLength(1);
  });

  it('excludes one completed yesterday', () => {
    expect(completedToday([mk({ completedAt: iso(2026, 8, 10, 10) })], defaultFilter, NOW)).toHaveLength(0);
  });

  it('excludes one with no recorded completion', () => {
    expect(completedToday([mk({ completedAt: null })], defaultFilter, NOW)).toHaveLength(0);
    expect(completedToday([mk({ completedAt: undefined })], defaultFilter, NOW)).toHaveLength(0);
  });

  it('counts archived tickets — Archive all must not zero the day', () => {
    const swept = [mk({ status: 'archived' }), mk({ id: 'tkt-2', status: 'archived' })];
    expect(completedToday(swept, defaultFilter, NOW)).toHaveLength(2);
  });

  it('ignores tickets that are neither done nor archived', () => {
    expect(completedToday([mk({ status: 'in-progress' })], defaultFilter, NOW)).toHaveLength(0);
  });

  it('counts a late-evening completion whose UTC date is tomorrow', () => {
    const late = mk({ completedAt: iso(2026, 8, 11, 23, 30) });
    expect(late.completedAt?.slice(0, 10)).toBe('2026-08-12'); // UTC says tomorrow
    expect(completedToday([late], defaultFilter, at(2026, 8, 11, 23, 45))).toHaveLength(1);
  });

  it('respects the FilterPopover filter', () => {
    const mixed = [mk(), mk({ id: 'tkt-2', project: 'portfolio-site' })];
    expect(completedToday(mixed, f({ project: 'kanban' }), NOW)).toHaveLength(1);
    expect(completedToday(mixed, f({ types: ['bug'] }), NOW)).toHaveLength(0);
  });

  // The chip sets dateFrom/dateTo; counting with them would make the number answer its own question.
  it('ignores the active date range, so selecting another day does not zero the count', () => {
    expect(completedToday([mk()], f({ dateField: 'completedAt', dateFrom: '2026-08-01', dateTo: '2026-08-01' }), NOW))
      .toHaveLength(1);
  });

  it('drops to zero once `now` crosses midnight, without the data changing', () => {
    const t = [mk({ completedAt: iso(2026, 8, 11, 22) })];
    expect(completedToday(t, defaultFilter, at(2026, 8, 11, 23, 59))).toHaveLength(1);
    expect(completedToday(t, defaultFilter, at(2026, 8, 12, 0, 1))).toHaveLength(0);
  });
});
