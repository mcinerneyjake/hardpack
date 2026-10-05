import { describe, it, expect } from 'vitest';
import { doneParentsWithChildren, reconcileDoneCollapse } from './collapseDefaults.js';
import type { Ticket, StatusId } from '../../shared/constants.js';

const mk = (id: string, status: StatusId): Ticket => ({
  id, title: id, type: 'task', priority: 'medium', status, order: 0,
  created: '', updated: '', body: '', project: null, blockers: [],
  parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
});

describe('doneParentsWithChildren', () => {
  it('includes a done parent that has children', () => {
    const set = doneParentsWithChildren([mk('p', 'done')], { p: 2 });
    expect([...set]).toEqual(['p']);
  });

  it('excludes a done parent with no children', () => {
    const set = doneParentsWithChildren([mk('p', 'done')], { p: 0 });
    expect([...set]).toEqual([]);
  });

  it('excludes a non-done parent even with children', () => {
    const set = doneParentsWithChildren([mk('p', 'in-progress')], { p: 3 });
    expect([...set]).toEqual([]);
  });
});

describe('reconcileDoneCollapse', () => {
  const state = (collapsed: string[], autoCollapsed: string[]) => ({
    collapsed: new Set(collapsed), autoCollapsed: new Set(autoCollapsed),
  });

  it('auto-collapses a newly-done parent and records it', () => {
    const r = reconcileDoneCollapse(state([], []), new Set(['p']));
    expect(r.changed).toBe(true);
    expect([...r.collapsed]).toEqual(['p']);
    expect([...r.autoCollapsed]).toEqual(['p']);
  });

  it('is idempotent once a done parent is already auto-collapsed', () => {
    const r = reconcileDoneCollapse(state(['p'], ['p']), new Set(['p']));
    expect(r.changed).toBe(false);
    expect([...r.collapsed]).toEqual(['p']);
  });

  it('does not re-collapse a done parent the user has expanded', () => {
    // 'p' is remembered as auto-collapsed but the user removed it from `collapsed`.
    const r = reconcileDoneCollapse(state([], ['p']), new Set(['p']));
    expect(r.changed).toBe(false);
    expect([...r.collapsed]).toEqual([]);
    expect([...r.autoCollapsed]).toEqual(['p']);
  });

  it('reverts the auto-collapse when a parent is no longer done', () => {
    const r = reconcileDoneCollapse(state(['p'], ['p']), new Set());
    expect(r.changed).toBe(true);
    expect([...r.collapsed]).toEqual([]);
    expect([...r.autoCollapsed]).toEqual([]);
  });

  it('forgets an auto id the user already expanded, without touching collapsed', () => {
    const r = reconcileDoneCollapse(state([], ['p']), new Set());
    expect(r.changed).toBe(false);
    expect([...r.autoCollapsed]).toEqual([]);
  });

  it('leaves a manual (non-auto) collapse untouched when nothing is done', () => {
    const r = reconcileDoneCollapse(state(['manual'], []), new Set());
    expect(r.changed).toBe(false);
    expect([...r.collapsed]).toEqual(['manual']);
  });

  it('collapses a new done parent while preserving an unrelated manual collapse', () => {
    const r = reconcileDoneCollapse(state(['manual'], []), new Set(['p']));
    expect(r.changed).toBe(true);
    expect([...r.collapsed].sort()).toEqual(['manual', 'p']);
    expect([...r.autoCollapsed]).toEqual(['p']);
  });
});
