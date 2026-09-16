import { describe, it, expect } from 'vitest';
import { setupTempTicketDirs } from '../../test-support/tempTicketDirs.js';
import { proposeIntake } from '../../agent/runtime/propose.js';
import { DocumentIndex, type Embedder, type Document } from '../../agent/retrieval/retrieval.js';
import type { ChatMessage, ChatClient } from '../../agent/runtime/llm.js';
import type { ChatTool } from '../../agent/runtime/tools.js';
import { createTicket, updateTicket, getTicket } from '../../server/tickets.js';
import { changedFormFields } from './ticketDiff.js';
import { resolveProposalPlan, buildTicketForm } from './intakeApply.js';

// END-TO-END round-trip test for the in-app intake seam (propose→apply), driving the
// real chain headlessly with a scripted chat fake. See CLAUDE.md → Testing → "Integration seams".

class ScriptedChat implements ChatClient {
  private i = 0;
  constructor(private readonly replies: ChatMessage[]) {}
  complete(_messages: ChatMessage[], _tools: ChatTool[]): Promise<ChatMessage> {
    const reply = this.replies[Math.min(this.i, this.replies.length - 1)];
    this.i += 1;
    return Promise.resolve(reply);
  }
}

// Never queried here (the model goes straight to a mutation), so a constant vector suffices.
class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(_text: string): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}

function doc(id: string, title: string): Document {
  return { id, source: 'ticket', title, text: title, meta: { status: 'backlog' } };
}

function toolCallReply(name: string, args: Record<string, unknown>): ChatMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [{ id: 'call-1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}

const finalReply: ChatMessage = { role: 'assistant', content: 'Done.' };

async function newIndex(): Promise<DocumentIndex> {
  return DocumentIndex.build(new StubEmbedder(), [doc('seed', 'seed')]);
}

describe('intake propose→apply round-trip', () => {
  setupTempTicketDirs('intake-round-trip');

  it('round-trips a create proposal into a persisted ticket (fidelity)', async () => {
    const args = { title: 'Export button 500s', body: 'Clicking export returns a 500', type: 'bug', priority: 'high' };
    const chat = new ScriptedChat([toolCallReply('create_ticket', args), finalReply]);
    const { proposal } = await proposeIntake('the export button 500s', { chat, index: await newIndex() });
    expect(proposal).not.toBeNull();
    if (!proposal) return;

    const plan = resolveProposalPlan(proposal, []);
    expect(plan.mode).toBe('create');

    // The create form submits the whole form (defaults + prefill).
    const created = await createTicket({ status: 'backlog', ...plan.prefill });
    const persisted = await getTicket(created.id);
    expect(persisted.title).toBe(args.title);
    expect(persisted.body).toBe(args.body);
    expect(persisted.type).toBe('bug');
    expect(persisted.priority).toBe('high');
  });

  it('round-trips an update proposal through the modal form builders and persists the change', async () => {
    const existing = await createTicket({ title: 'Login is broken', body: 'old body', type: 'bug', priority: 'medium', status: 'backlog' });
    const chat = new ScriptedChat([toolCallReply('update_ticket', { id: existing.id, body: 'Repro: click login then 500' }), finalReply]);
    const { proposal } = await proposeIntake('login 500', { chat, index: await newIndex() });
    if (!proposal) throw new Error('expected a proposal');

    const plan = resolveProposalPlan(proposal, [existing]); // the real modal routing decision
    expect(plan.mode).toBe('update');
    if (plan.mode !== 'update') return;
    expect(plan.target.id).toBe(existing.id);

    // form overlays the prefill, baseline does NOT (Bug D, tkt-128ee05af9ba) — else the diff is {} and body never persists.
    const patch = changedFormFields(
      buildTicketForm(plan.target, [existing], plan.prefill),
      buildTicketForm(plan.target, [existing]),
    );
    expect(patch.body).toBe('Repro: click login then 500');
    await updateTicket(plan.target.id, patch);
    expect((await getTicket(plan.target.id)).body).toBe('Repro: click login then 500');
  });

  // tkt-1dfa61b8830e (Bug E, FIXED): an unloaded update id resolves to 'not-found', not 'create' (would draft a duplicate).
  it('an update proposal with an unknown id resolves to not-found, not create', () => {
    const plan = resolveProposalPlan({ action: 'update_ticket', args: { id: 'tkt-ghost-9999', body: 'x' } }, []);
    expect(plan.mode).toBe('not-found');
  });

  // tkt-727c5cacdfad (Bug G, FIXED): a create-bound prefill clamps a non-create status so createTicket accepts it.
  it('G: a create proposal with status qa yields a prefill createTicket accepts', async () => {
    const plan = resolveProposalPlan({ action: 'create_ticket', args: { title: 'X', status: 'qa' } }, []);
    await expect(createTicket({ status: 'backlog', ...plan.prefill })).resolves.toBeTruthy();
  });

  // tkt-727c5cacdfad (Bug H, FIXED): proposalToPrefill carries assignee/dueDate/etc into the persisted ticket.
  it('H: an agent-proposed assignee survives into the persisted ticket', async () => {
    const plan = resolveProposalPlan({ action: 'create_ticket', args: { title: 'Bug for Alice', assignee: 'Alice', dueDate: '2026-07-20' } }, []);
    const created = await createTicket({ status: 'backlog', ...plan.prefill });
    const persisted = await getTicket(created.id);
    expect(persisted.assignee).toBe('Alice');
  });

  // tkt-a22ba10cd328: an invalid enum is dropped silently, so the form's default is
  // indistinguishable from a value the agent never proposed. The drop must survive the seam as a
  // REPORT while the dropped value itself stays out of the form (the behaviour is unchanged).
  it('an invalid proposed enum is reported as dropped while the form keeps the default', async () => {
    const args = { title: 'Export 500s', type: 'banana', priority: 'critical', status: 'todo' };
    const chat = new ScriptedChat([toolCallReply('create_ticket', args), finalReply]);
    const { proposal } = await proposeIntake('export 500s', { chat, index: await newIndex() });
    if (!proposal) throw new Error('expected a proposal');

    const plan = resolveProposalPlan(proposal, []);
    expect(plan.droppedEnums).toEqual([
      { field: 'type', value: 'banana' },
      { field: 'priority', value: 'critical' },
    ]);

    // The valid enum still lands, and the two invalid ones fall back to buildTicketForm's defaults.
    const form = buildTicketForm(null, [], plan.prefill);
    expect(form.status).toBe('todo');
    expect(form.type).toBe('task');
    expect(form.priority).toBe('medium');

    // Fidelity: what persists is the default, not the proposed string — this is a legibility fix.
    const created = await createTicket({ ...form });
    const persisted = await getTicket(created.id);
    expect(persisted.type).toBe('task');
    expect(persisted.priority).toBe('medium');
  });

  // A+B (tkt-67de93c44726 / tkt-7aa8c73735a9): the intake-apply write path stamps source:'assisted' + runId.
  it('A/B: an assisted write stamps source:assisted + runId', async () => {
    const t = await createTicket({ title: 'Drafted' }, { source: 'assisted', runId: 'run-ab' });
    expect(t.source).toBe('assisted');
    expect(t.runId).toBe('run-ab');
  });
});
