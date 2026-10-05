import { describe, it, expect } from 'vitest';
import { computeChildCounts } from './childCounts.js';
import type { Ticket, StatusId } from '../../shared/constants.js';

// Minimal ticket fixture — only the fields computeChildCounts reads matter.
const mk = (id: string, status: StatusId, parent: string | null = null): Ticket => ({
  id, title: id, type: 'task', priority: 'medium', status, order: 0,
  created: '', updated: '', body: '', project: null, blockers: [],
  parent, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
});

describe('computeChildCounts', () => {
  it('counts open children of an open parent', () => {
    const tickets = [mk('p', 'todo'), mk('c1', 'todo', 'p'), mk('c2', 'in-progress', 'p')];
    expect(computeChildCounts(tickets)).toEqual({ p: 2 });
  });

  it('drops a done child from an open parent count', () => {
    const tickets = [mk('p', 'in-progress'), mk('c1', 'todo', 'p'), mk('c2', 'done', 'p')];
    expect(computeChildCounts(tickets)).toEqual({ p: 1 });
  });

  it('restores the full original count once the parent is done', () => {
    const tickets = [mk('p', 'done'), mk('c1', 'done', 'p'), mk('c2', 'done', 'p'), mk('c3', 'todo', 'p')];
    expect(computeChildCounts(tickets)).toEqual({ p: 3 });
  });

  it('omits a parent whose only child is done while it is still open', () => {
    const tickets = [mk('p', 'todo'), mk('c1', 'done', 'p')];
    expect(computeChildCounts(tickets)).toEqual({});
  });

  it('ignores tickets without a parent', () => {
    const tickets = [mk('a', 'todo'), mk('b', 'done')];
    expect(computeChildCounts(tickets)).toEqual({});
  });

  it('treats a child of an unknown parent id as belonging to an open parent', () => {
    // No ticket "ghost" exists, so its status is unknown → open-parent rule applies.
    const tickets = [mk('c1', 'todo', 'ghost'), mk('c2', 'done', 'ghost')];
    expect(computeChildCounts(tickets)).toEqual({ ghost: 1 });
  });

  it('counts independently across multiple parents', () => {
    const tickets = [
      mk('p1', 'todo'), mk('a', 'todo', 'p1'), mk('b', 'done', 'p1'),
      mk('p2', 'done'), mk('c', 'done', 'p2'),
    ];
    expect(computeChildCounts(tickets)).toEqual({ p1: 1, p2: 1 });
  });
});
