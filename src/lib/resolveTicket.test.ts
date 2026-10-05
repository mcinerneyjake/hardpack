import { describe, it, expect, vi } from 'vitest';
import { resolveTicket } from './resolveTicket.js';
import type { Ticket } from '../../shared/constants.js';

const mk = (id: string): Ticket => ({
  id, title: id, type: 'task', priority: 'medium', status: 'todo', order: 0,
  created: '', updated: '', body: '', project: null, blockers: [],
  parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
});

describe('resolveTicket', () => {
  it('returns the local ticket without calling the fetcher when present', async () => {
    const local = mk('a');
    const fetcher = vi.fn();
    const result = await resolveTicket('a', [local, mk('b')], fetcher);
    expect(result).toBe(local);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('falls back to the fetcher when the id is absent from the list', async () => {
    const fetched = mk('z');
    const fetcher = vi.fn().mockResolvedValue(fetched);
    const result = await resolveTicket('z', [mk('a')], fetcher);
    expect(fetcher).toHaveBeenCalledWith('z');
    expect(result).toBe(fetched);
  });

  it('fetches when the list is empty', async () => {
    const fetched = mk('z');
    const fetcher = vi.fn().mockResolvedValue(fetched);
    expect(await resolveTicket('z', [], fetcher)).toBe(fetched);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('propagates a fetcher rejection (e.g. 404 for a deleted ticket)', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Ticket not found'));
    await expect(resolveTicket('gone', [], fetcher)).rejects.toThrow('Ticket not found');
  });
});
