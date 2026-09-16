import { appendRun, type RunRecord } from './runLog.js';
import { buildSummary, type RunSummary } from './summary.js';
import { resolveCostConfig } from './costConfig.js';
import { type RunUsage } from './usage.js';
import { type RunOutcome } from './economics.js';
import { type PostRunCheck } from '../runtime/postRunCheck.js';

export interface MeterRunInput {
  runId: string;
  model: string;
  usage: RunUsage;
  outcome: RunOutcome;
  reviewMs: number;
  ticketIds: RunRecord['ticketIds'];
  cappedCreates: number;
  postRunCheck: PostRunCheck;
  // Cacheable prefix (system prompt + tool schema), priced separately from the dynamic tail (RUN_PREFIX_TEXT).
  prefixText: string;
  // Per-run variable input (the CLI's raw prompt, or the intake report).
  dynamicText: string;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The SINGLE metering path shared by the CLI and the in-app intake controller, so their economics share one cost basis + record shape.
// Fully best-effort — the real work is already done, so this must NOT throw: a cost-build failure returns an empty summary; a persist failure still returns the built summary.
export async function meterRun(input: MeterRunInput): Promise<RunSummary> {
  let cost: RunSummary;
  try {
    cost = buildSummary({
      usage: input.usage,
      outcome: input.outcome,
      reviewMs: input.reviewMs,
      cfg: resolveCostConfig(),
      model: input.model,
      prefixText: input.prefixText,
      dynamicText: input.dynamicText,
    });
  } catch (err) {
    console.warn(`[cost] failed to summarize run ${input.runId}: ${errMsg(err)}`);
    return { measured: [], assumed: [], externalities: [], headline: [] };
  }
  try {
    await appendRun({
      runId: input.runId,
      at: new Date().toISOString(),
      model: input.model,
      usage: input.usage,
      outcome: input.outcome,
      reviewMs: input.reviewMs,
      cost,
      ticketIds: input.ticketIds,
      cappedCreates: input.cappedCreates,
      postRunCheck: input.postRunCheck,
    });
  } catch (err) {
    console.warn(`[runlog] failed to persist run ${input.runId}: ${errMsg(err)}`);
  }
  return cost;
}
