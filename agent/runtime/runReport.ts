import { type IntakePartial } from './loop.js';

// Operator-facing lines about what a run did to the board, rendered away from the CLI so both the
// success path and the throw path read from one source (tkt-f2161edc8185). Callers add their own
// leading blank line and choose the stream.

// Deterministic, not read off the model's summary — a weak local model narrates the tickets it made
// and omits the ones it was blocked from making (tkt-dd22f37d1c60).
export function cappedCreatesWarning(cappedCreates: number): string | null {
  // Not `<= 0` alone: NaN and undefined both compare false against it and would render "! NaN further
  // …" into an operator-facing warning. RunRecord.cappedCreates is optional, so a caller rendering
  // this from a persisted run is one `??`-less read away (runIntake's maxCreates rejects the same shape).
  if (!Number.isInteger(cappedCreates) || cappedCreates <= 0) return null;
  return `! ${cappedCreates} further create_ticket call(s) were blocked by the per-run limit. The report covered too much — re-file the remainder as separate single-issue runs.`;
}

// A refusal is the one outcome with nothing on the board to find: no id, no cap, no ticket. `rejected`
// is optional, and NaN compares false against `<= 0` — hence Number.isInteger (tkt-354d1bdcffa9).
export function rejectedWritesWarning(rejected: number | undefined): string | null {
  if (!Number.isInteger(rejected) || (rejected ?? 0) <= 0) return null;
  return `! ${rejected} write(s) were refused by the service and no ticket was created for them. Re-run the report, or check the run log for the rejection text.`;
}

// --yes auto-approves, so writes land INSIDE the loop: a throw part way through leaves tickets on
// disk stamped with this run's id. main()'s handler prints the fault only, and the Claude-delegated
// create-only flow is required to report the ids back — without this the caller sees a bare failure,
// re-files the same report, and duplicates the ticket that landed.
export function describeThrownRun(partial: IntakePartial | null): string[] {
  if (!partial) return [];
  const lines: string[] = [];
  if (partial.createdIds.length > 0 || partial.updatedIds.length > 0) {
    lines.push(`! the run wrote to the board before it failed — created ${JSON.stringify(partial.createdIds)}, updated ${JSON.stringify(partial.updatedIds)} (runId ${partial.runId})`);
  } else if (partial.outcome.created > 0 || partial.outcome.updated > 0) {
    // Writes landed whose ids were never captured: `created` increments on any non-error create, but
    // createdIds only gets a push when ticketIdOf finds a JSON `id`. Reporting the
    // ids alone would read as "nothing landed" and the operator re-files, duplicating what is already
    // on the board — the exact outcome this line exists to prevent (tkt-f2161edc8185).
    lines.push(`! the run wrote to the board before it failed — ${partial.outcome.created} created, ${partial.outcome.updated} updated, but no ids were captured (runId ${partial.runId}). Check the board before re-filing.`);
  }
  // Independent of the lines above: the cap blocks calls that never reached the service, so a capped
  // run is under-reported by the ids either way (tkt-f2161edc8185).
  const capped = cappedCreatesWarning(partial.cappedCreates);
  if (capped) lines.push(capped);
  // Also independent: a run whose every write was refused has no ids and no cap, so without this the
  // other two lines stay silent and the refusals are never re-filed (tkt-fde6b41809d6).
  const rejected = rejectedWritesWarning(partial.outcome.rejected);
  if (rejected) lines.push(rejected);
  return lines;
}
