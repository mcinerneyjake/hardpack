import { describe, it, expect } from 'vitest';
import { buildTicketForm, blockersForProject, isHiddenBlockerEdge, resolveProposalPlan, createFromUpdatePrefill } from './intakeApply.js';
import { changedFormFields } from './ticketDiff.js';
import type { Ticket } from '../../shared/constants.js';

function ticket(over: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt-1', title: 'Login broken', type: 'bug', priority: 'medium', status: 'backlog',
    order: 1, created: '', updated: '', body: 'old body', project: null, blockers: [],
    parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null, ...over,
  };
}

describe('buildTicketForm', () => {
  it('builds the baseline from the ticket only (no prefill overlay)', () => {
    const t = ticket();
    const baseline = buildTicketForm(t, [t]);
    expect(baseline.title).toBe('Login broken');
    expect(baseline.body).toBe('old body');
    expect(baseline.status).toBe('backlog');
  });

  it('overlays the prefill on the form; untouched fields fall back to the ticket', () => {
    const t = ticket();
    const form = buildTicketForm(t, [t], { body: 'new repro', priority: 'high' });
    expect(form.body).toBe('new repro');
    expect(form.priority).toBe('high');
    expect(form.title).toBe('Login broken');
  });

  // tkt-727c5cacdfad (Bug H): the prefill carries every editable field, not just title/type/priority/status/body.
  it('overlays the content prefill fields (assignee/dueDate) onto the form', () => {
    const t = ticket();
    const form = buildTicketForm(t, [t], { assignee: 'Alice', dueDate: '2026-07-20' });
    expect(form.assignee).toBe('Alice');
    expect(form.dueDate).toBe('2026-07-20');
  });

  // tkt-727c5cacdfad: structural fields (project/blockers/parent) aren't carried in the prefill — buildTicketForm keeps the guarded ticket-derived values.
  it('keeps ticket-derived project/blockers/parent regardless of the prefill', () => {
    const t = ticket({ blockers: ['tkt-x'], parent: null, project: 'kanban' });
    const form = buildTicketForm(t, [t], { assignee: 'Alice' });
    expect(form.blockers).toEqual(['tkt-x']);
    expect(form.parent).toBeNull();
    expect(form.project).toBe('kanban');
  });

  // tkt-128ee05af9ba: form (with prefill) vs baseline (without) must diff to the proposed change, not {}.
  it('makes an agent-proposed change a real diff vs the prefill-free baseline', () => {
    const t = ticket();
    const patch = changedFormFields(buildTicketForm(t, [t], { body: 'new repro' }), buildTicketForm(t, [t]));
    expect(patch.body).toBe('new repro');
  });

  it('produces an empty patch for an unchanged submit (no prefill)', () => {
    const t = ticket();
    expect(changedFormFields(buildTicketForm(t, [t]), buildTicketForm(t, [t]))).toEqual({});
  });

  it('overlays the prefill on defaults for a create (no ticket)', () => {
    const form = buildTicketForm(null, [], { title: 'New bug', type: 'bug' });
    expect(form.title).toBe('New bug');
    expect(form.type).toBe('bug');
    expect(form.status).toBe('backlog');
    expect(form.body).toBe('');
  });

  it('keeps the full blocker set (archived/dangling included) — the modal filters those for display', () => {
    const t = ticket({ blockers: ['tkt-active', 'tkt-archived', 'tkt-missing'] });
    expect(buildTicketForm(t, []).blockers).toEqual(['tkt-active', 'tkt-archived', 'tkt-missing']);
  });

  // tkt-c8b4b6aa948d: buildTicketForm keeps the archived id in the baseline, so removing the visible active blocker leaves the archived edge in the diff.
  it('preserves an archived blocker edge when the user removes an active one', () => {
    const active = ticket({ id: 'tkt-active', status: 'todo' });
    const archived = ticket({ id: 'tkt-archived', status: 'archived' });
    const t = ticket({ blockers: ['tkt-active', 'tkt-archived'] });
    const baseline = buildTicketForm(t, [active, archived]);
    // simulate removeBlocker('tkt-active') — removes only the clicked (visible) chip
    const form = { ...baseline, blockers: baseline.blockers.filter((b) => b !== 'tkt-active') };
    expect(changedFormFields(form, baseline).blockers).toEqual(['tkt-archived']);
  });

  it('seeds an active parent but drops an archived one', () => {
    const child = ticket({ parent: 'tkt-parent' });
    expect(buildTicketForm(child, [ticket({ id: 'tkt-parent', status: 'todo' })]).parent).toBe('tkt-parent');
    expect(buildTicketForm(child, [ticket({ id: 'tkt-parent', status: 'archived' })]).parent).toBeNull();
  });
});

describe('blockersForProject', () => {
  it('keeps every blocker when the project is cleared to None', () => {
    expect(blockersForProject(['a', 'b'], [], null)).toEqual(['a', 'b']);
  });

  it('drops a visible active cross-project blocker but keeps a same-project one', () => {
    const p1 = ticket({ id: 'a', status: 'todo', project: 'P1' });
    const p2 = ticket({ id: 'b', status: 'todo', project: 'P2' });
    expect(blockersForProject(['a', 'b'], [p1, p2], 'P1')).toEqual(['a']);
  });

  // The project-change trigger for tkt-c8b4b6aa948d: hidden edges must survive it.
  it('preserves hidden archived/dangling blockers across a project change', () => {
    const archived = ticket({ id: 'arch', status: 'archived', project: 'P2' });
    expect(blockersForProject(['arch', 'gone'], [archived], 'P1')).toEqual(['arch', 'gone']);
  });
});

describe('isHiddenBlockerEdge', () => {
  it('is true for an archived target or a dangling id, false for an active one', () => {
    const active = ticket({ id: 'a', status: 'todo' });
    const archived = ticket({ id: 'b', status: 'archived' });
    expect(isHiddenBlockerEdge('a', [active, archived])).toBe(false);
    expect(isHiddenBlockerEdge('b', [active, archived])).toBe(true);
    expect(isHiddenBlockerEdge('gone', [active, archived])).toBe(true);
  });
});

describe('resolveProposalPlan', () => {
  it('routes a create proposal to create mode', () => {
    expect(resolveProposalPlan({ action: 'create_ticket', args: { title: 'New' } }, []).mode).toBe('create');
  });

  it('routes an update proposal for a loaded ticket to update mode', () => {
    const t = ticket({ id: 'tkt-real' });
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: 'tkt-real', body: 'x' } }, [t]);
    expect(plan.mode).toBe('update');
    if (plan.mode === 'update') expect(plan.target.id).toBe('tkt-real');
  });

  // tkt-1dfa61b8830e: an unloaded update target resolves to not-found (carrying the id), not a duplicate-drafting create.
  it('routes an update proposal for an unloaded ticket to not-found', () => {
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: 'tkt-ghost', body: 'x' } }, []);
    expect(plan.mode).toBe('not-found');
    if (plan.mode === 'not-found') expect(plan.targetId).toBe('tkt-ghost');
  });

  // Review finding C: a missing/non-string update id is also not-found (targetId null) — routing on the action, not the id.
  it('routes an update proposal with a missing id to not-found (null targetId)', () => {
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { body: 'x' } }, []);
    expect(plan.mode).toBe('not-found');
    if (plan.mode === 'not-found') expect(plan.targetId).toBeNull();
  });

  // Review finding A: a blank id collapses to null so the caller's notice renders, not a falsy-'' silent no-op.
  it('collapses a blank update id to not-found with a null targetId', () => {
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: '' } }, []);
    expect(plan.mode).toBe('not-found');
    if (plan.mode === 'not-found') expect(plan.targetId).toBeNull();
  });

  // tkt-727c5cacdfad (Bug G): a create-bound prefill drops a non-create status; an update target keeps the full status.
  it('clamps a non-create status out of a create-bound prefill', () => {
    const plan = resolveProposalPlan({ action: 'create_ticket', args: { title: 'X', status: 'qa' } }, []);
    expect(plan.mode).toBe('create');
    expect(plan.prefill.status).toBeUndefined();
  });

  it('keeps a create-valid status in a create-bound prefill', () => {
    expect(resolveProposalPlan({ action: 'create_ticket', args: { status: 'todo' } }, []).prefill.status).toBe('todo');
  });

  it('keeps a non-create status for an update target (update accepts every status)', () => {
    const t = ticket({ id: 'tkt-u' });
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: 'tkt-u', status: 'qa' } }, [t]);
    expect(plan.mode).toBe('update');
    expect(plan.prefill.status).toBe('qa');
  });
});

// tkt-e346dd06e8bb: "Draft new ticket" reuses an UPDATE-mode prefill for a CREATE. The proposed
// status is a transition for the existing target, so drafting a NEW ticket must drop it entirely —
// not just clamp qa/archived — or a create-valid transition (done/in-progress) births a ticket
// already past the pipeline.
describe('createFromUpdatePrefill', () => {
  it('drops a create-valid transition status (done) so the new ticket takes the create default', () => {
    expect(createFromUpdatePrefill({ title: 'X', status: 'done' }).status).toBeUndefined();
  });

  it('drops an in-progress transition status too', () => {
    expect(createFromUpdatePrefill({ status: 'in-progress' }).status).toBeUndefined();
  });

  it('also drops a create-unsafe status (subsumes the qa/archived clamp)', () => {
    expect(createFromUpdatePrefill({ status: 'qa' }).status).toBeUndefined();
  });

  it('leaves the other content fields untouched while dropping status', () => {
    expect(createFromUpdatePrefill({ title: 'X', body: 'b', priority: 'high', status: 'done' }))
      .toEqual({ title: 'X', body: 'b', priority: 'high' });
  });

  it('returns a status-less prefill unchanged', () => {
    const prefill = { title: 'X', body: 'b' };
    expect(createFromUpdatePrefill(prefill)).toEqual(prefill);
  });
});
