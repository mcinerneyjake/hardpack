import { describe, it, expect } from 'vitest';
import { setupTempTicketDirs } from '../../test-support/tempTicketDirs.js';
import {
  AGENT_TOOLS,
  AGENT_TOOLS_CREATE_ONLY,
  AGENT_TOOL_NAMES,
  CREATE_ONLY_TOOL_NAMES,
  dispatchTool,
  constrainAgentProject,
} from './tools.js';
import { DocumentIndex, type Embedder, type Document } from '../retrieval/retrieval.js';
import { TOOLS } from '../../mcp/handlers.js';
import { createTicket, getTicket, listTickets } from '../../server/tickets.js';

// Deterministic stub embedder (keyword -> fixed vector), as in retrieval.test.
class StubEmbedder implements Embedder {
  constructor(private readonly map: [string, number[]][]) {}
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map((t) => this.vec(t))); }
  embedQuery(text: string): Promise<number[]> { return Promise.resolve(this.vec(text)); }
  private vec(text: string): number[] {
    const hit = this.map.find(([k]) => text.toLowerCase().includes(k));
    return hit ? hit[1] : [0, 0, 1];
  }
}
// A ticket-sourced Document, as the indexCache bridge would produce it — status
// rides in `meta` and is flattened back to top-level by search_board.
function doc(id: string, title: string): Document {
  return { id, source: 'ticket', title, text: title, meta: { status: 'backlog' } };
}
const embedder = new StubEmbedder([['login', [1, 0, 0]], ['dashboard', [0, 1, 0]]]);

// Validate + narrow a search_board result payload (no casts).
function parseResults(text: string): { id: string; title: string; status: string; score: number }[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('search_board did not return a JSON array');
  return parsed.map((p) => {
    if (typeof p !== 'object' || p === null) throw new Error('result is not an object');
    const id = 'id' in p ? p.id : undefined;
    const title = 'title' in p ? p.title : undefined;
    const status = 'status' in p ? p.status : undefined;
    const score = 'score' in p ? p.score : undefined;
    if (typeof id !== 'string' || typeof title !== 'string' || typeof status !== 'string' || typeof score !== 'number') {
      throw new Error('result missing id/title/status/score');
    }
    return { id, title, status, score };
  });
}

// handleToolCall touches the service (real files) — redirect tickets + telemetry
// I/O to isolated temp dirs. Tests reach files through the service, so no path
// is needed here.
setupTempTicketDirs('agent-tools-test');

describe('AGENT_TOOLS', () => {
  const names = AGENT_TOOLS.map((t) => t.function.name);

  it('advertises exactly the five whitelisted tools', () => {
    expect(AGENT_TOOLS).toHaveLength(5);
    expect(names).toEqual(expect.arrayContaining(
      ['list_tickets', 'get_ticket', 'search_board', 'create_ticket', 'update_ticket'],
    ));
  });

  it('excludes destructive / dev-workflow tools', () => {
    expect(names).not.toContain('delete_ticket');
    expect(names).not.toContain('archive_ticket');
    expect(names).not.toContain('start_ticket');
  });

  it('uses the OpenAI function-tool shape for every tool', () => {
    for (const t of AGENT_TOOLS) {
      expect(t.type).toBe('function');
      expect(typeof t.function.name).toBe('string');
      expect(t.function.parameters).toMatchObject({ type: 'object' });
    }
  });

  it('carries the exact MCP description + inputSchema into parameters (lossless adapter)', () => {
    const mcpCreate = TOOLS.find((t) => t.name === 'create_ticket');
    const create = AGENT_TOOLS.find((t) => t.function.name === 'create_ticket');
    expect(create?.function.description).toBe(mcpCreate?.description);
    expect(create?.function.parameters).toEqual(mcpCreate?.inputSchema);
  });

  it('search_board requires a query', () => {
    const sb = AGENT_TOOLS.find((t) => t.function.name === 'search_board');
    expect(sb?.function.parameters).toMatchObject({ required: ['query'] });
  });
});

describe('AGENT_TOOLS_CREATE_ONLY', () => {
  const names = AGENT_TOOLS_CREATE_ONLY.map((t) => t.function.name);

  it('drops update_ticket but keeps create + reads + search', () => {
    expect(names).not.toContain('update_ticket');
    expect(names).toEqual(expect.arrayContaining(['list_tickets', 'get_ticket', 'search_board', 'create_ticket']));
    expect(names).toHaveLength(4);
  });

  it('still excludes the destructive / dev-workflow tools', () => {
    expect(names).not.toContain('delete_ticket');
    expect(names).not.toContain('archive_ticket');
    expect(names).not.toContain('start_ticket');
  });
});

describe('dispatchTool — search_board', () => {
  it('routes to the index and returns structured, ordered results', async () => {
    const index = await DocumentIndex.build(embedder, [doc('t1', 'Fix login bug'), doc('t2', 'Add dashboard')]);
    const res = await dispatchTool('search_board', { query: 'login screen broken' }, index);
    expect(res.isError).toBeFalsy();
    const results = parseResults(res.content[0].text);
    expect(results[0]).toMatchObject({ id: 't1', title: 'Fix login bug', status: 'backlog' });
    expect(typeof results[0].score).toBe('number');
  });

  it('respects the limit argument', async () => {
    const index = await DocumentIndex.build(embedder, [doc('t1', 'Fix login bug'), doc('t2', 'login again'), doc('t3', 'Add dashboard')]);
    const res = await dispatchTool('search_board', { query: 'login', limit: 1 }, index);
    expect(parseResults(res.content[0].text)).toHaveLength(1);
  });

  it('errors without a query', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('search_board', {}, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('query');
  });
});

describe('dispatchTool — MCP delegation', () => {
  it('delegates list_tickets to handleToolCall', async () => {
    await createTicket({ title: 'Seeded' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('list_tickets', undefined, index);
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain('Seeded');
  });

  it('delegates create_ticket and persists the new ticket', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Made by agent' }, index);
    expect(res.isError).toBeFalsy();
    const list = await dispatchTool('list_tickets', undefined, index);
    expect(list.content[0].text).toContain('Made by agent');
  });

  it('propagates an MCP-layer error (unknown id)', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('get_ticket', { id: 'tkt-doesnotexist' }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not found');
  });
});

// The advertised enums and the predicates that reject a bad value both read shared/constants, so they
// agree by DUPLICATION, not enforcement — and the adapter test above only proves the schema survives
// transport. These drive a bad value through the agent path and assert the refusal is atomic
// (tkt-354d1bdcffa9).
describe('dispatchTool — invalid enum values are refused without writing', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    ['priority', { title: 'x', priority: 'P1' }, 'P1'],
    ['type', { title: 'x', type: 'defect' }, 'defect'],
    ['status', { title: 'x', status: 'qa' }, 'qa'],
  ];

  for (const [field, args, bad] of cases) {
    it(`refuses an invalid ${field}, names the value, and persists no ticket`, async () => {
      const index = await DocumentIndex.build(embedder, []);
      const before = (await listTickets()).length;
      const res = await dispatchTool('create_ticket', args, index);
      expect(res.isError).toBe(true);
      expect(res.content[0].text).toContain(bad);
      expect(await listTickets()).toHaveLength(before);
    });
  }

  // `qa` is a gate you transition INTO, never create in — the asymmetry CREATE_STATUS_ENUM encodes.
  it('accepts on update the status it refuses on create', async () => {
    const created = await createTicket({ title: 'Gate me' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('update_ticket', { id: created.id, status: 'qa' }, index);
    expect(res.isError).toBeFalsy();
    expect((await getTicket(created.id)).status).toBe('qa');
  });
});

describe('dispatchTool — security gate', () => {
  it('blocks delete_ticket and does NOT destroy the ticket', async () => {
    const created = await createTicket({ title: 'Keep me' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('delete_ticket', { id: created.id }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
    // the whitelist must PREVENT the deletion, not merely report it
    expect((await getTicket(created.id)).id).toBe(created.id);
  });

  it('blocks start_ticket', async () => {
    const index = await DocumentIndex.build(embedder, []);
    expect((await dispatchTool('start_ticket', { id: 'x' }, index)).isError).toBe(true);
  });

  // create-only mode (tkt-2492e26a277a): update_ticket must be refused AND the target body untouched —
  // the data-loss regression where a mis-matched retrieval overwrote a rich ticket body.
  it('refuses update_ticket under the create-only tool set and does NOT mutate the body', async () => {
    const created = await createTicket({ title: 'Rich ticket', body: 'ORIGINAL BODY — must survive' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('update_ticket', { id: created.id, body: 'CLOBBERED' }, index, undefined, CREATE_ONLY_TOOL_NAMES);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
    expect((await getTicket(created.id)).body).toBe('ORIGINAL BODY — must survive');
  });

  it('still allows create_ticket under the create-only tool set', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Create-only made this' }, index, undefined, CREATE_ONLY_TOOL_NAMES);
    expect(res.isError).toBeFalsy();
  });

  // The hard floor: a caller can NARROW the tool set but never WIDEN it to a destructive tool — even if
  // allowedNames wrongly includes delete_ticket, AGENT_TOOL_NAMES still refuses it.
  it('refuses delete_ticket even when a caller passes a widened allowedNames set', async () => {
    const created = await createTicket({ title: 'Do not delete' });
    const index = await DocumentIndex.build(embedder, []);
    const widened = new Set([...CREATE_ONLY_TOOL_NAMES, 'delete_ticket']);
    const res = await dispatchTool('delete_ticket', { id: created.id }, index, undefined, widened);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
    expect((await getTicket(created.id)).id).toBe(created.id);
  });

  // tkt-f388cfc8ad4b — archive_ticket is excluded from AGENT_TOOL_NAMES by omission, which is exactly
  // why it was built as a named tool instead of an `archived` value on update_ticket: the agent keeps
  // update_ticket, so widening that enum would have handed untrusted intake the power to hide tickets.
  it('blocks archive_ticket and does NOT archive the ticket', async () => {
    const created = await createTicket({ title: 'Do not archive' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('archive_ticket', { id: created.id }, index);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain('not available');
    expect((await getTicket(created.id)).status).not.toBe('archived');
  });

  it('refuses archive_ticket even when a caller passes a widened allowedNames set', async () => {
    const created = await createTicket({ title: 'Still do not archive' });
    const index = await DocumentIndex.build(embedder, []);
    const widened = new Set([...AGENT_TOOL_NAMES, 'archive_ticket']);
    const res = await dispatchTool('archive_ticket', { id: created.id }, index, undefined, widened);
    expect(res.isError).toBe(true);
    expect((await getTicket(created.id)).status).not.toBe('archived');
  });

  it('blocks an unknown tool', async () => {
    const index = await DocumentIndex.build(embedder, []);
    expect((await dispatchTool('frobnicate', {}, index)).isError).toBe(true);
  });
});

// tkt-beef54d90c59: the agent must not mint new projects — an unknown project name is dropped.
describe('constrainAgentProject', () => {
  const known = ['kanban', 'consulting'];

  it('drops an unknown non-empty project (omits the field)', () => {
    const { args, dropped } = constrainAgentProject({ title: 'X', project: 'Made Up' }, known);
    expect(dropped).toBe('Made Up');
    expect(args).toEqual({ title: 'X' });
    expect(args && 'project' in args).toBe(false);
  });

  it('keeps a known project', () => {
    const { args, dropped } = constrainAgentProject({ title: 'X', project: 'kanban' }, known);
    expect(dropped).toBeNull();
    expect(args).toEqual({ title: 'X', project: 'kanban' });
  });

  it('canonicalizes a case/whitespace variant to the board spelling', () => {
    const { args, dropped } = constrainAgentProject({ title: 'X', project: 'kanban ' }, ['Kanban', 'consulting']);
    expect(dropped).toBeNull();
    expect(args).toEqual({ title: 'X', project: 'Kanban' }); // resolved to the real project
  });

  it('leaves an already-canonical known project as-is', () => {
    const { args, dropped } = constrainAgentProject({ project: 'consulting' }, known);
    expect(dropped).toBeNull();
    expect(args).toEqual({ project: 'consulting' });
  });

  it('leaves an explicit null (clear) untouched', () => {
    const { args, dropped } = constrainAgentProject({ project: null }, known);
    expect(dropped).toBeNull();
    expect(args).toEqual({ project: null });
  });

  it('leaves args without a project key untouched (unset)', () => {
    const { args, dropped } = constrainAgentProject({ title: 'X' }, known);
    expect(dropped).toBeNull();
    expect(args).toEqual({ title: 'X' });
  });

  it('drops a whitespace-only project instead of minting it as a phantom project', () => {
    const { args, dropped } = constrainAgentProject({ project: '   ' }, known);
    expect(dropped).toBe('   ');
    expect(args && 'project' in args).toBe(false);
  });

  it('does not mutate the caller args when dropping', () => {
    const input = { title: 'X', project: 'Ghost' };
    constrainAgentProject(input, known);
    expect(input.project).toBe('Ghost'); // original untouched — a fresh object is returned
  });

  it('handles undefined args', () => {
    expect(constrainAgentProject(undefined, known)).toEqual({ args: undefined, dropped: null });
  });
});

describe('dispatchTool — project constraint (create/update)', () => {
  // Safe id extraction (cast-free) — the create result is the ticket as JSON.
  function idFrom(text: string): string {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') return parsed.id;
    throw new Error('result had no id');
  }

  it('drops an unknown agent-proposed project so the created ticket is unassigned', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Bad project', project: 'Create Modal Enhancements' }, index);
    const ticket = await getTicket(idFrom(res.content[0].text));
    expect(ticket.project).toBeNull();
  });

  it('keeps a project that already exists on the board', async () => {
    await createTicket({ title: 'Seeds the project', project: 'kanban' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Good project', project: 'kanban' }, index);
    const ticket = await getTicket(idFrom(res.content[0].text));
    expect(ticket.project).toBe('kanban');
  });

  it('canonicalizes a case/whitespace variant to the real board project', async () => {
    await createTicket({ title: 'Seeds Marketing', project: 'Marketing' });
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Loose casing', project: 'marketing ' }, index);
    const ticket = await getTicket(idFrom(res.content[0].text));
    expect(ticket.project).toBe('Marketing');
  });

  it('does not clear a valid existing project on update when the proposed one is unknown', async () => {
    const seeded = await createTicket({ title: 'Has a project', project: 'kanban' });
    const index = await DocumentIndex.build(embedder, []);
    await dispatchTool('update_ticket', { id: seeded.id, project: 'Ghosttown', priority: 'high' }, index);
    const after = await getTicket(seeded.id);
    expect(after.project).toBe('kanban'); // unknown project omitted → existing kept
    expect(after.priority).toBe('high');  // the valid field still applied
  });
});

describe('dispatchTool — provenance stamping', () => {
  // Parse the ticket id out of a create/update result (cast-free).
  function idOf(text: string): string {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string' ? parsed.id : '';
  }

  it('stamps source: agent + runId on create when a runId is passed', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'Via dispatch' }, index, 'run-77');
    const ticket = await getTicket(idOf(res.content[0].text));
    expect(ticket.source).toBe('agent');
    expect(ticket.runId).toBe('run-77');
  });

  it('leaves create unstamped when no runId is passed', async () => {
    const index = await DocumentIndex.build(embedder, []);
    const res = await dispatchTool('create_ticket', { title: 'No run' }, index);
    const ticket = await getTicket(idOf(res.content[0].text));
    expect(ticket.source).toBeNull();
    expect(ticket.runId).toBeNull();
  });
});
