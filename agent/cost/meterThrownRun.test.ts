import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { meterThrownRun } from './meterThrownRun.js';
import { readRun, readRuns, getRunForTicket } from './runLog.js';
import { emptyUsage } from './usage.js';
import { runIntake, IntakeRunError, RUN_PREFIX_TEXT } from '../runtime/loop.js';
import { type ChatClient, type ChatMessage, type ToolCall } from '../runtime/llm.js';
import { DocumentIndex, type Embedder } from '../retrieval/retrieval.js';

// tkt-3953c78cffe7 round-trip. The seam is loop → IntakeRunError → meterThrownRun → runs.jsonl →
// getRunForTicket, and it is the whole defect: every layer worked on its own, but a throw crossing
// them dropped the runId, so a ticket already written pointed at a run nobody had logged. Per-layer
// tests could not see that; only driving the real chain can.

class StubEmbedder implements Embedder {
  embedDocuments(texts: string[]): Promise<number[][]> { return Promise.resolve(texts.map(() => [1, 0, 0])); }
  embedQuery(): Promise<number[]> { return Promise.resolve([1, 0, 0]); }
}
const buildIndex = (): Promise<DocumentIndex> =>
  DocumentIndex.build(new StubEmbedder(), [{ id: 't1', source: 'ticket', title: 'Seed', text: 'Seed' }]);

const assistant = (content: string | null, tool_calls?: ToolCall[]): ChatMessage => ({ role: 'assistant', content, tool_calls });
const toolCall = (id: string, name: string, args: string): ToolCall => ({ id, type: 'function', function: { name, arguments: args } });

// Creates a ticket on turn 1, then dies — the shape a `--yes` CLI run takes when the runtime drops
// mid-run, which is the only way a stamped ticket can outlive its own run record.
class CreatesThenDies implements ChatClient {
  private turn = 0;
  complete(): Promise<ChatMessage> {
    this.turn++;
    if (this.turn === 1) {
      return Promise.resolve(assistant(null, [toolCall('c1', 'create_ticket', '{"title":"Written before the fault"}')]));
    }
    return Promise.reject(new Error('runtime dropped mid-run'));
  }
}

const meterInput = {
  model: 'test-model', usage: emptyUsage(), reviewMs: 0,
  prefixText: RUN_PREFIX_TEXT, dynamicText: 'a report',
};

let runsDir: string;
let ticketsDir: string;
let eventsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-thrown-runs-'));
  ticketsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-thrown-tickets-'));
  eventsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-thrown-events-'));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  process.env.TICKETS_DIR_OVERRIDE = ticketsDir;
  process.env.EVENTS_DIR_OVERRIDE = eventsDir;
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  delete process.env.TICKETS_DIR_OVERRIDE;
  delete process.env.EVENTS_DIR_OVERRIDE;
  await Promise.all([runsDir, ticketsDir, eventsDir].map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('meterThrownRun (round-trip: a throw still reaches the run log)', () => {
  it('a stamped ticket from a run that died resolves back to its run record', async () => {
    let thrown: unknown;
    try {
      await runIntake('a report', { chat: new CreatesThenDies(), index: await buildIndex(), runId: 'run-died' });
    } catch (err) { thrown = err; }
    if (!(thrown instanceof IntakeRunError)) throw new Error(`expected IntakeRunError, got: ${String(thrown)}`);

    expect(await meterThrownRun(thrown, meterInput)).toMatchObject({ runId: 'run-died' });

    // source input == persisted output, across the whole chain.
    const ticketId = thrown.partial.createdIds[0];
    expect(ticketId).toBeTruthy();
    const joined = await getRunForTicket(ticketId);
    expect(joined).not.toBeNull();                       // the 404 "Run not found" this ticket fixes
    expect(joined?.runId).toBe('run-died');
    expect(joined?.outcome).toMatchObject({ created: 1, errored: true });
    expect(joined?.ticketIds.created).toEqual([ticketId]);
  });

  it('writes exactly one record, carrying the model and prefix basis it was given', async () => {
    let thrown: unknown;
    try {
      await runIntake('a report', { chat: new CreatesThenDies(), index: await buildIndex(), runId: 'run-basis' });
    } catch (err) { thrown = err; }
    await meterThrownRun(thrown, meterInput);
    const all = await readRuns();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ runId: 'run-basis', model: 'test-model', reviewMs: 0 });
  });

  it('records a run that died before anything was written, with zero accepted', async () => {
    class DiesImmediately implements ChatClient {
      complete(): Promise<ChatMessage> { return Promise.reject(new Error('down')); }
    }
    let thrown: unknown;
    try {
      await runIntake('x', { chat: new DiesImmediately(), index: await buildIndex(), runId: 'run-nothing' });
    } catch (err) { thrown = err; }
    expect(await meterThrownRun(thrown, meterInput)).toMatchObject({ runId: 'run-nothing' });
    const run = await readRun('run-nothing');
    expect(run?.outcome).toMatchObject({ created: 0, updated: 0, errored: true });
    expect(run?.ticketIds).toEqual({ created: [], updated: [] });
  });

  // Rejection cases — an error raised before the loop minted a runId names no run, so there is
  // nothing to meter. Writing a record anyway would invent a run that never started.
  it('writes nothing and returns null for an error that is not an IntakeRunError', async () => {
    for (const err of [new Error('index build failed'), 'a thrown string', null, undefined]) {
      expect(await meterThrownRun(err, meterInput)).toBeNull();
    }
    expect(await readRuns()).toHaveLength(0);
  });

  // The return value must NOT be read as "persisted": meterRun swallows an appendRun failure, so a
  // boolean here could only ever have been true. It reports the run it metered, and the ids are what
  // the CLI prints so a failed run's written tickets are not re-filed as duplicates.
  it('returns the created ids so a caller can name what landed before the fault', async () => {
    let thrown: unknown;
    try {
      await runIntake('a report', { chat: new CreatesThenDies(), index: await buildIndex(), runId: 'run-ids' });
    } catch (err) { thrown = err; }
    const partial = await meterThrownRun(thrown, meterInput);
    expect(partial?.createdIds).toHaveLength(1);
    expect(partial?.updatedIds).toEqual([]);
    expect(partial?.createdIds[0]).toMatch(/^tkt-/);
  });
});
