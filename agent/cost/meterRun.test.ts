import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { meterRun, type MeterRunInput } from './meterRun.js';
// Namespace imports so appendRun / buildSummary can be stubbed to throw (live ESM binding
// — meterRun reads the same module objects vitest spies on), exercising the best-effort
// swallow on both the persist and the cost-assembly paths.
import * as runLog from './runLog.js';
import * as summary from './summary.js';
import { emptyUsage, UsageMeter } from './usage.js';

let runsDir: string;
beforeEach(async () => {
  runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meter-run-test-'));
  process.env.RUNS_DIR_OVERRIDE = runsDir;
});
afterEach(async () => {
  delete process.env.RUNS_DIR_OVERRIDE;
  vi.restoreAllMocks();
  await fs.rm(runsDir, { recursive: true, force: true });
});

function input(over: Partial<MeterRunInput> = {}): MeterRunInput {
  return {
    runId: 'run-meter',
    model: 'test-model',
    usage: { ...emptyUsage(), promptTokens: 10, completionTokens: 5, totalTokens: 15, activeMs: 100 },
    outcome: { created: 1, updated: 0, declined: 0, noProposal: false, errored: false },
    reviewMs: 250,
    ticketIds: { created: ['tkt-1'], updated: [] },
    prefixText: 'system prompt + tools',
    dynamicText: 'the run input',
    ...over,
  };
}

// tkt-1e98c78e8c01 — the seam round-trip. A per-call trace is only useful if it survives the
// whole path (meter → summary → JSONL → read back); the fidelity invariant is that the trace's
// per-call ms still reconciles to the aggregate activeMs on the far side.
describe('per-call trace round-trip (meter → persist → read back)', () => {
  it('preserves every call and reconciles the trace to activeMs after a read back', async () => {
    const meter = new UsageMeter();
    meter.record({ kind: 'embed', startedAt: 1_000, elapsedMs: 65_000, inputChars: 1_267_300 });
    meter.record({ kind: 'chat', startedAt: 66_000, elapsedMs: 14_975, inputChars: 3_700, tokens: { prompt: 924, completion: 57, total: 981 } });
    meter.record({ kind: 'chat', startedAt: 81_000, elapsedMs: 700, inputChars: 4_100, tokens: { prompt: 1_010, completion: 41, total: 1_051 } });
    const usage = meter.get();

    await meterRun(input({ runId: 'run-trace', usage }));
    const run = await runLog.readRun('run-trace');
    if (!run) throw new Error('run was not persisted');

    // Source input == persisted output across the full path — no call silently dropped.
    const trace = run.usage.callTrace;
    if (!trace) throw new Error('callTrace did not survive the round-trip');
    expect(trace).toEqual(usage.callTrace);
    expect(trace).toHaveLength(3);
    expect(trace.map((c) => c.kind)).toEqual(['embed', 'chat', 'chat']);

    // The fidelity invariant, asserted on the far side of the boundary.
    expect(trace.reduce((n, c) => n + c.ms, 0)).toBe(run.usage.activeMs);
    expect(trace).toHaveLength(run.usage.calls);
  });

  // tkt-354d1bdcffa9 — the same seam for the refused-write count. A rejection is only observable if
  // it survives meter → JSONL → read back; the whole point of the field is the far side.
  it('preserves a refused-write count and its noProposal:false across the round-trip', async () => {
    const outcome = { created: 0, updated: 0, declined: 0, rejected: 2, noProposal: false, errored: false };
    await meterRun(input({ runId: 'run-rejected', outcome }));
    const run = await runLog.readRun('run-rejected');
    if (!run) throw new Error('run was not persisted');
    // Source input == persisted output — the field is not dropped or defaulted in transit.
    expect(run.outcome).toEqual(outcome);
    // The distinction the ticket exists for, asserted where a dashboard would read it.
    expect(run.outcome.rejected).toBe(2);
    expect(run.outcome.noProposal).toBe(false);
  });

  // A run genuinely proposing nothing must stay distinguishable from one whose writes were refused.
  it('reads back a no-proposal run as noProposal:true with no rejections', async () => {
    const outcome = { created: 0, updated: 0, declined: 0, rejected: 0, noProposal: true, errored: false };
    await meterRun(input({ runId: 'run-quiet', outcome }));
    const run = await runLog.readRun('run-quiet');
    expect(run?.outcome.rejected).toBe(0);
    expect(run?.outcome.noProposal).toBe(true);
  });

  // The 128 dev runs already on disk predate this field; they must stay readable.
  it('still reads back a pre-trace record, leaving its trace undefined (not [])', async () => {
    const legacy = { ...emptyUsage(), activeMs: 128_000, calls: 12 };
    delete legacy.callTrace;
    await meterRun(input({ runId: 'run-legacy', usage: legacy }));
    const run = await runLog.readRun('run-legacy');
    expect(run).not.toBeNull();
    expect(run?.usage.activeMs).toBe(128_000);
    expect(run?.usage.callTrace).toBeUndefined();
  });

  it('rejects a persisted record whose callTrace is malformed (not trusted on read)', async () => {
    const bad = { ...emptyUsage(), callTrace: [{ kind: 'chat', ms: 'soon' }] };
    expect(runLog.isRunRecord({
      runId: 'r', at: 'now', model: 'm', usage: bad,
      outcome: { created: 0, updated: 0, declined: 0, noProposal: true, errored: false },
      reviewMs: 0, cost: { measured: [], assumed: [], externalities: [], headline: [] },
      ticketIds: { created: [], updated: [] },
    })).toBe(false);
  });
});

describe('meterRun', () => {
  it('builds the cost summary, persists the run, and returns the summary', async () => {
    const summary = await meterRun(input());
    // Returned summary is the four cost-line groups.
    expect(summary).toMatchObject({ measured: expect.any(Array), assumed: expect.any(Array), externalities: expect.any(Array), headline: expect.any(Array) });

    const run = await runLog.readRun('run-meter');
    expect(run).not.toBeNull();
    expect(run).toMatchObject({
      runId: 'run-meter',
      model: 'test-model',
      outcome: { created: 1, noProposal: false },
      ticketIds: { created: ['tkt-1'], updated: [] },
    });
    expect(run?.usage.totalTokens).toBe(15);
    expect(run?.reviewMs).toBe(250);
    // The persisted cost equals the returned summary (one build, no drift).
    expect(run?.cost).toEqual(summary);
  });

  it('swallows an appendRun failure (best-effort) and still returns the REAL summary', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(runLog, 'appendRun').mockRejectedValueOnce(new Error('disk full'));

    // Must not throw despite the persist failure, and the built cost is still returned
    // (so the CLI renders the real summary even when the write drops).
    const result = await meterRun(input({ runId: 'run-fail' }));
    expect(result.assumed.length).toBeGreaterThan(0); // the real, non-empty summary
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-fail'));
    expect(await runLog.readRun('run-fail')).toBeNull(); // nothing persisted
  });

  // A cost-build throw must NOT escape either (a controller apply() already wrote the
  // ticket; metering must never 500 the request). Returns an empty summary instead.
  it('swallows a buildSummary failure and returns an empty summary without persisting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(summary, 'buildSummary').mockImplementationOnce(() => { throw new Error('bad cost config'); });
    const append = vi.spyOn(runLog, 'appendRun');

    const result = await meterRun(input({ runId: 'run-nocost' }));
    expect(result).toEqual({ measured: [], assumed: [], externalities: [], headline: [] });
    expect(append).not.toHaveBeenCalled(); // no record when the cost couldn't be built
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('run-nocost'));
  });
});
