import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setupTempTicketDirs } from '../../test-support/tempTicketDirs.js';
import { checkCreatedTickets, describeCheck, isPostRunCheck, notChecked, ticketIdsIn } from './postRunCheck.js';
import { runIntake, type ToolLogEntry } from './loop.js';
import { type ChatClient, type ChatMessage, type ToolCall } from './llm.js';
import { DocumentIndex, type Embedder } from '../retrieval/retrieval.js';
import { createTicket, HttpError } from '../../server/tickets.js';
import { meterRun } from '../cost/meterRun.js';
import { readRun } from '../cost/runLog.js';
import { emptyUsage } from '../cost/usage.js';

class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}

class ScriptedChat implements ChatClient {
  private calls = 0;
  constructor(private readonly turns: ChatMessage[]) {}
  complete(): Promise<ChatMessage> {
    const turn = this.turns[this.calls] ?? { role: 'assistant', content: 'done' };
    this.calls++;
    return Promise.resolve(turn);
  }
}

const assistant = (content: string | null, tool_calls?: ToolCall[]): ChatMessage => ({ role: 'assistant', content, tool_calls });
const toolCall = (id: string, name: string, args: unknown): ToolCall =>
  ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const logged = (name: string, text: string, over: Partial<ToolLogEntry> = {}): ToolLogEntry =>
  ({ name, isError: false, text, createdId: null, ...over });

const UNSOURCED = 'tkt-bbbbbbbbbbbb';
const FROM_REPORT = 'tkt-cccccccccccc';

setupTempTicketDirs('post-run-check-test');

let runsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-run-check-runs-'));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true });
});

describe('checkCreatedTickets — round trip (runIntake → check → meterRun → runs.jsonl)', () => {
  it('records drift naming the one id no source supplied, and passes the ids that were sourced', async () => {
    const related = await createTicket({ title: 'Existing export bug' });
    const index = await DocumentIndex.build(new StubEmbedder(), [
      { id: related.id, source: 'ticket', title: related.title, text: related.title },
    ]);
    const report = `CSV export crashes; see ${FROM_REPORT}`;
    const chat = new ScriptedChat([
      assistant(null, [toolCall('s1', 'search_board', { query: 'export' })]),
      assistant(null, [toolCall('c1', 'create_ticket', {
        title: 'CSV export crashes',
        body: `Related: ${related.id}, ${FROM_REPORT}, ${UNSOURCED}`,
      })]),
      assistant('Created it.'),
    ]);
    const result = await runIntake(report, { chat, index, createOnly: true, runId: 'run-round-trip' });
    expect(result.createdIds).toHaveLength(1);

    const postRunCheck = await checkCreatedTickets(report, result.toolLog, result.createdIds);
    await meterRun({
      runId: result.runId, model: 'test', usage: emptyUsage(), outcome: result.outcome, reviewMs: 0,
      ticketIds: { created: result.createdIds, updated: result.updatedIds },
      cappedCreates: result.cappedCreates, postRunCheck, prefixText: 'p', dynamicText: report,
    });

    const run = await readRun('run-round-trip');
    expect(run?.postRunCheck).toEqual({
      verdict: 'drift',
      tickets: [{ id: result.createdIds[0], found: true, unsourcedIds: [UNSOURCED] }],
    });
  });
});

// Review findings on the first cut — each drives the real loop, since the fix lives in what it records.
describe('checkCreatedTickets — ids a run could only have invented', () => {
  const run = async (report: string, turns: ChatMessage[]) => {
    const index = await DocumentIndex.build(new StubEmbedder(), [{ id: 'tkt-000000000001', source: 'ticket', title: 't', text: 't' }]);
    const result = await runIntake(report, { chat: new ScriptedChat(turns), index, createOnly: true });
    return checkCreatedTickets(report, result.toolLog, result.createdIds);
  };

  it('does not source an id from a get_ticket that failed (404) on it', async () => {
    const check = await run('a report', [
      assistant(null, [toolCall('g1', 'get_ticket', { id: UNSOURCED })]),
      assistant(null, [toolCall('c1', 'create_ticket', { title: 'x', body: `Related: ${UNSOURCED}` })]),
      assistant('done'),
    ]);
    expect(check.verdict).toBe('drift');
    expect(check.tickets[0].unsourcedIds).toEqual([UNSOURCED]);
  });

  it('does not source an id from reading the created ticket back after the create', async () => {
    const turns: ChatMessage[] = [
      assistant(null, [toolCall('c1', 'create_ticket', { title: 'x', body: `Related: ${UNSOURCED}` })]),
      assistant(null, [toolCall('l1', 'list_tickets', {})]),
      assistant('done'),
    ];
    const check = await run('a report', turns);
    expect(check.verdict).toBe('drift');
    expect(check.tickets[0].unsourcedIds).toEqual([UNSOURCED]);
  });

  it('flags an unsourced id however it is cased', async () => {
    const check = await run('a report', [
      assistant(null, [toolCall('c1', 'create_ticket', { title: 'x', body: 'Related: TKT-BBBBBBBBBBBB' })]),
      assistant('done'),
    ]);
    expect(check.verdict).toBe('drift');
  });
});

describe('checkCreatedTickets', () => {
  it('does not treat the create_ticket echo as a source for the ids it repeats', async () => {
    const created = await createTicket({ title: 'x', body: `See ${UNSOURCED}` });
    const log = [logged('create_ticket', JSON.stringify(created), { createdId: created.id })];
    const check = await checkCreatedTickets('a report', log, [created.id]);
    expect(check).toEqual({ verdict: 'drift', tickets: [{ id: created.id, found: true, unsourcedIds: [UNSOURCED] }] });
  });

  it('sources ids from every read-only tool result before the create, and from no other tool', async () => {
    const created = await createTicket({ title: `About ${UNSOURCED}`, body: `and ${FROM_REPORT} and tkt-dddddddddddd and tkt-ffffffffffff` });
    const log = [
      logged('get_ticket', JSON.stringify({ id: UNSOURCED })),
      logged('search_board', JSON.stringify([{ id: FROM_REPORT }])),
      logged('update_ticket', 'tkt-dddddddddddd'),
      logged('create_ticket', JSON.stringify(created), { createdId: created.id }),
      logged('list_tickets', 'tkt-ffffffffffff'),
    ];
    const check = await checkCreatedTickets('report', log, [created.id]);
    expect(check.tickets[0].unsourcedIds).toEqual(['tkt-dddddddddddd', 'tkt-ffffffffffff']);
  });

  it('sources nothing from the log when the ticket has no create entry in it', async () => {
    const created = await createTicket({ title: 'x', body: UNSOURCED });
    const check = await checkCreatedTickets('report', [logged('get_ticket', UNSOURCED)], [created.id]);
    expect(check.tickets[0].unsourcedIds).toEqual([UNSOURCED]);
  });

  it('passes when every cited id is sourced, including a sibling ticket the same run created', async () => {
    const first = await createTicket({ title: 'first' });
    const second = await createTicket({ title: 'second', body: `Split from ${first.id}; reported as ${FROM_REPORT}` });
    const check = await checkCreatedTickets(`bug ${FROM_REPORT}`, [], [first.id, second.id]);
    expect(check).toEqual({
      verdict: 'pass',
      tickets: [
        { id: first.id, found: true, unsourcedIds: [] },
        { id: second.id, found: true, unsourcedIds: [] },
      ],
    });
  });

  it('records nothing-created when the run created nothing', async () => {
    expect(await checkCreatedTickets('r', [], [])).toEqual({ verdict: 'nothing-created', tickets: [] });
  });

  it('records drift for a created id that no longer re-reads (404)', async () => {
    const check = await checkCreatedTickets('r', [], ['tkt-eeeeeeeeeeee']);
    expect(check).toEqual({ verdict: 'drift', tickets: [{ id: 'tkt-eeeeeeeeeeee', found: false, unsourcedIds: [] }] });
  });

  it('records not-checked, never pass, when a re-read fails for any reason other than 404', async () => {
    for (const err of [new HttpError(500, 'boom'), new Error('EACCES')]) {
      const check = await checkCreatedTickets('r', [], ['tkt-eeeeeeeeeeee'], () => Promise.reject(err));
      expect(check).toEqual({ verdict: 'not-checked', tickets: [{ id: 'tkt-eeeeeeeeeeee', found: null, unsourcedIds: [] }] });
    }
  });

  it('reports drift over not-checked when one ticket drifted and another could not be read', async () => {
    const drifted = await createTicket({ title: 'x', body: UNSOURCED });
    const read = async (id: string) => {
      if (id === drifted.id) return drifted;
      throw new Error('unreadable');
    };
    const check = await checkCreatedTickets('r', [], ['tkt-eeeeeeeeeeee', drifted.id], read);
    expect(check.verdict).toBe('drift');
  });
});

describe('ticketIdsIn', () => {
  it('finds each id once in any case or length, and stops at a word boundary', () => {
    expect(ticketIdsIn(`${UNSOURCED} TKT-BBBBBBBBBBBB tkt-mqqh0pl6yz feat/tkt-586ed614fde6-post-run xtkt-aaaa`))
      .toEqual([UNSOURCED, 'tkt-mqqh0pl6yz', 'tkt-586ed614fde6']);
  });
});

describe('isPostRunCheck / describeCheck', () => {
  it('round-trips every verdict the check can produce', () => {
    for (const v of [
      { verdict: 'pass', tickets: [] },
      { verdict: 'nothing-created', tickets: [] },
      notChecked('why'),
      { verdict: 'drift', tickets: [{ id: 'tkt-x', found: false, unsourcedIds: [] }] },
    ]) expect(isPostRunCheck(JSON.parse(JSON.stringify(v)))).toBe(true);
  });

  it('names each failing ticket, and says so when the check did not run', () => {
    const lines = describeCheck({
      verdict: 'drift',
      tickets: [
        { id: 'tkt-1', found: true, unsourcedIds: [] },
        { id: 'tkt-2', found: true, unsourcedIds: [UNSOURCED] },
        { id: 'tkt-3', found: false, unsourcedIds: [] },
        { id: 'tkt-4', found: null, unsourcedIds: [] },
      ],
    });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(UNSOURCED);
    expect(describeCheck(notChecked('the run threw'))).toEqual(['post-run check did not run: the run threw']);
    expect(describeCheck({ verdict: 'pass', tickets: [] })).toEqual([]);
  });
});
