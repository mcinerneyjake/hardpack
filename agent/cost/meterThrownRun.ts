import { IntakeRunError, type IntakePartial } from '../runtime/loop.js';
import { meterRun } from './meterRun.js';
import { type RunUsage } from './usage.js';
import { notChecked } from '../runtime/postRunCheck.js';

export interface ThrownRunInput {
  model: string;
  usage: RunUsage;
  reviewMs: number;
  // Cacheable prefix + per-run variable input, same basis meterRun uses for a completed run.
  prefixText: string;
  dynamicText: string;
}

// Meter a run that threw. Both entry points (the CLI and the intake controller) metered only AFTER the
// loop returned, so a mid-run fault skipped metering entirely: the spend reached no run log, and any
// ticket the run had already written sat on disk stamped with a runId that `?runId=` then 404'd on
// (tkt-3953c78cffe7). The runId and the partial tallies ride out on IntakeRunError; this turns them
// into the record.
//
// Returns the partial it metered, or null when the error named no run — one raised before the loop
// minted a runId (a failed index build, say) has nothing to meter, and that is not a failure. It
// deliberately does NOT report whether the record reached disk: meterRun is total, swallowing an
// appendRun failure with a console.warn, so no boolean here could mean "persisted" without lying.
// Callers get the ids instead, which is the thing they actually have a use for.
//
// TOTAL by construction: it runs inside a catch block, so throwing here would replace the fault the
// caller is about to rethrow with a metering error, losing the real one. meterRun does not throw
// today; this backstop is why a future change to it cannot silently swallow the caller's fault.
export async function meterThrownRun(err: unknown, input: ThrownRunInput): Promise<IntakePartial | null> {
  if (!(err instanceof IntakeRunError)) return null;
  try {
    await meterRun({
      runId: err.partial.runId,
      outcome: err.partial.outcome,
      ticketIds: { created: err.partial.createdIds, updated: err.partial.updatedIds },
      cappedCreates: err.partial.cappedCreates,
      postRunCheck: notChecked('the run threw before returning its transcript'),
      model: input.model,
      usage: input.usage,
      reviewMs: input.reviewMs,
      prefixText: input.prefixText,
      dynamicText: input.dynamicText,
    });
  } catch (meterErr) {
    console.warn(`[runlog] failed to meter the failed run ${err.partial.runId}: ${meterErr instanceof Error ? meterErr.message : String(meterErr)}`);
  }
  return err.partial;
}
