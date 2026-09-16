import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appendRun, readRun, readRuns, getRunForTicket, isRunRecord, runsDir as defaultRunsDir, type RunRecord, type NewRunRecord } from './runLog.js';
import { emptyUsage } from './usage.js';
import { createTicket } from '../../server/tickets.js';

let runsDir: string;
let ticketsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-test-'));
  ticketsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'runlog-tickets-test-'));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
  process.env.TICKETS_DIR_OVERRIDE = ticketsDir;
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  delete process.env.TICKETS_DIR_OVERRIDE;
  await fs.rm(runsDir, { recursive: true, force: true });
  await fs.rm(ticketsDir, { recursive: true, force: true });
});

function mkRecord(runId: string, over: Partial<RunRecord> = {}): NewRunRecord {
  return {
    runId,
    at: '2026-07-03T00:00:00.000Z',
    model: 'test-model',
    usage: emptyUsage(),
    outcome: { created: 1, updated: 0, declined: 0, noProposal: false, errored: false },
    reviewMs: 0,
    cost: { measured: [], assumed: [], externalities: [], headline: [] },
    ticketIds: { created: [], updated: [] },
    cappedCreates: 0,
    ...over,
  };
}

describe('appendRun / readRun / readRuns', () => {
  it('appends a record and reads it back by runId (survives a "restart")', async () => {
    await appendRun(mkRecord('run-1', { model: 'qwen', reviewMs: 42 }));
    // A fresh read == a new process reading the persisted log.
    const got = await readRun('run-1');
    expect(got?.model).toBe('qwen');
    expect(got?.reviewMs).toBe(42);
  });

  it('readRuns returns every record, oldest first', async () => {
    await appendRun(mkRecord('run-1'));
    await appendRun(mkRecord('run-2'));
    expect((await readRuns()).map((r) => r.runId)).toEqual(['run-1', 'run-2']);
  });

  it('readRun returns null for an unknown runId', async () => {
    await appendRun(mkRecord('run-1'));
    expect(await readRun('nope')).toBeNull();
  });

  it('returns [] / null when the log file does not exist', async () => {
    expect(await readRuns()).toEqual([]);
    expect(await readRun('anything')).toBeNull();
  });

  it('skips a corrupt line without failing the read', async () => {
    await appendRun(mkRecord('run-1'));
    await fs.appendFile(path.join(runsDir, 'runs.jsonl'), 'not json {{{\n');
    await appendRun(mkRecord('run-2'));
    expect((await readRuns()).map((r) => r.runId)).toEqual(['run-1', 'run-2']);
  });

  it('resolves a duplicate runId to the last-written record', async () => {
    await appendRun(mkRecord('run-1', { reviewMs: 1 }));
    await appendRun(mkRecord('run-1', { reviewMs: 2 }));
    expect((await readRun('run-1'))?.reviewMs).toBe(2);
  });
});

describe('getRunForTicket (ticket → run join)', () => {
  it('resolves an agent-stamped ticket to its run record', async () => {
    const ticket = await createTicket({ title: 'Agent made this' }, { source: 'agent', runId: 'run-9' });
    await appendRun(mkRecord('run-9', { model: 'joined' }));
    const run = await getRunForTicket(ticket.id);
    expect(run?.runId).toBe('run-9');
    expect(run?.model).toBe('joined');
  });

  it('returns null for a ticket with no provenance (human/CLI write)', async () => {
    const ticket = await createTicket({ title: 'Human made this' });
    expect(await getRunForTicket(ticket.id)).toBeNull();
  });

  it('returns null (does not throw) for an unknown or malformed ticket id', async () => {
    expect(await getRunForTicket('tkt-doesnotexist')).toBeNull();
    expect(await getRunForTicket('../bad id')).toBeNull(); // getTicket would throw 400
  });
});

describe('runsDir (default location)', () => {
  it('defaults to the project-root runs/ dir, not nested under agent/', () => {
    const saved = process.env.RUNS_DIR_OVERRIDE;
    delete process.env.RUNS_DIR_OVERRIDE;
    try {
      const dir = defaultRunsDir();
      expect(dir.endsWith(`${path.sep}runs`)).toBe(true);
      // Regression guard: the reorg moved this file to agent/cost/, so a single
      // `..` would wrongly resolve to <root>/agent/runs.
      expect(dir.includes(`${path.sep}agent${path.sep}`)).toBe(false);
    } finally {
      if (saved !== undefined) process.env.RUNS_DIR_OVERRIDE = saved;
    }
  });
});

describe('isRunRecord', () => {
  it('accepts a well-formed record', () => {
    expect(isRunRecord(mkRecord('run-1'))).toBe(true);
  });

  it('rejects a record missing a top-level field', () => {
    const withoutModel: Record<string, unknown> = { ...mkRecord('run-1') };
    delete withoutModel.model;
    expect(isRunRecord(withoutModel)).toBe(false);
  });

  it('rejects a record with malformed nested usage/cost', () => {
    expect(isRunRecord({ ...mkRecord('run-1'), usage: { promptTokens: 'nope' } })).toBe(false);
    expect(isRunRecord({ ...mkRecord('run-1'), cost: { measured: [{ label: 'x' }] } })).toBe(false);
  });
});
