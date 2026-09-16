import * as readline from 'node:readline/promises';
import { RuntimeEmbedder } from './retrieval/retrieval.js';
import { buildCliIndex } from './retrieval/indexCache.js';
import { RuntimeChatClient, resolveLlmConfig } from './runtime/llm.js';
import { runIntake, RUN_PREFIX_TEXT, RUN_PREFIX_TEXT_CREATE_ONLY, type IntakeResult } from './runtime/loop.js';
import { getTicket } from '../server/tickets.js';
import { askApproval } from './runtime/approval.js';
import { mergeUsage } from './cost/usage.js';
import { renderSummary } from './cost/summary.js';
import { meterRun } from './cost/meterRun.js';
import { meterThrownRun } from './cost/meterThrownRun.js';

// CLI entry for the local agentic-intake agent, with a stdin approval gate on every mutating action. Requires running embedding + chat models (e.g. LM Studio).
//   npm run agent -- "the dashboard crashes when I export to CSV"
//   npm run agent -- --yes "…"   auto-approve every write (non-interactive; for
//                                driving a metered run from a Claude Code session)
//   npm run agent -- --create-only "…"   drop update_ticket — always create a NEW
//                                ticket (the Claude-delegated path; a mis-matched
//                                retrieval can't overwrite an existing body)

try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

async function main(): Promise<void> {
  // LEADING flags only, so a `-y` inside the report text isn't mistaken for the option.
  const argv = process.argv.slice(2);
  let autoApprove = false;
  let createOnly = false;
  while (argv.length > 0 && (argv[0] === '--yes' || argv[0] === '-y' || argv[0] === '--create-only')) {
    if (argv[0] === '--create-only') createOnly = true;
    else autoApprove = true;
    argv.shift();
  }
  const input = argv.join(' ').trim();
  if (!input) {
    console.error('Usage: npm run agent -- [--yes] [--create-only] "<report>"');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let reviewMs = 0; // measured HITL gate-open time, fed to the run summary
  // --yes auto-approves so a create/update happens INSIDE the metered run — the run→ticket linkage the run log needs.
  const interactiveApprove = async (name: string, args: Record<string, unknown> | undefined): Promise<boolean> => {
    console.log(`\n⚠  The agent wants to ${name}:`);
    console.log(JSON.stringify(args ?? {}, null, 2));
    // For an update, show the ticket's CURRENT state so the reviewer isn't blind.
    if (name === 'update_ticket' && args && typeof args.id === 'string') {
      try {
        const current = await getTicket(args.id);
        console.log(`Current: "${current.title}" — ${current.status}/${current.priority}`);
        // Body replacement is destructive and its undo is only best-effort (ticket-workflow README -> Backup-on-write); show the current body so the reviewer isn't approving a blind overwrite.
        if (typeof args.body === 'string' && args.body !== current.body) {
          console.log('Current body (will be REPLACED by the proposed `body` above):');
          console.log(current.body || '(empty)');
        }
      } catch {
        console.log('(could not load the current ticket state)');
      }
    }
    // Fail-safe: a closed stdin (EOF / non-interactive) declines rather than crashing.
    const start = Date.now();
    const ok = await askApproval(() => rl.question('Approve? [y/N] '));
    reviewMs += Date.now() - start;
    return ok;
  };
  const approve = autoApprove ? () => true : interactiveApprove;

  const embedder = RuntimeEmbedder.fromEnv();
  const chat = RuntimeChatClient.fromEnv();
  const model = resolveLlmConfig().model;

  // Before the embedding pass, not after: indexing takes ~30s, and dying on the first chat call
  // afterwards spends all of it to report a fault that was knowable up front (tkt-b97efe93a6a3).
  const preflight = await chat.preflight();
  if (!preflight.ok) {
    rl.close();
    console.error(preflight.message);
    process.exit(1);
  }

  try {
    console.log('Building the board index…');
    const index = await buildCliIndex(embedder);
    console.log(`Indexed ${index.size} tickets. Running intake${autoApprove ? ' (auto-approve)' : ''}${createOnly ? ' (create-only)' : ''}…`);
    const prefixText = createOnly ? RUN_PREFIX_TEXT_CREATE_ONLY : RUN_PREFIX_TEXT;
    let result: IntakeResult;
    try {
      result = await runIntake(input, { chat, index, approve, createOnly });
    } catch (err) {
      // --yes auto-approves, so writes land INSIDE the loop: a throw part way through leaves those
      // tickets on disk stamped with this run's id. Metering here is what keeps their economics link
      // resolvable instead of 404 "Run not found" (tkt-3953c78cffe7). Rethrown — main()'s handler
      // still reports the fault and exits non-zero.
      const partial = await meterThrownRun(err, {
        model, usage: mergeUsage(chat.getUsage(), embedder.getUsage()), reviewMs, prefixText,
        dynamicText: input,
      });
      // Name what landed BEFORE rethrowing. main()'s handler prints the fault only, and the
      // Claude-delegated create-only flow is required to report the ids back — without this the
      // caller sees a bare failure, re-files the same report, and duplicates the ticket that landed.
      if (partial && (partial.createdIds.length > 0 || partial.updatedIds.length > 0)) {
        console.error(`\n! the run wrote to the board before it failed — created ${JSON.stringify(partial.createdIds)}, updated ${JSON.stringify(partial.updatedIds)} (runId ${partial.runId})`);
      }
      throw err;
    }
    console.log(`\n--- Result (${result.steps} steps) ---\n${result.final}`);
    // Deterministic, not read off the model's summary — a weak local model narrates the tickets it
    // made and omits the ones it was blocked from making (tkt-dd22f37d1c60).
    if (result.cappedCreates > 0) {
      console.warn(`\n! ${result.cappedCreates} further create_ticket call(s) were blocked by the per-run limit. The report covered too much — re-file the remainder as separate single-issue runs.`);
    }
    // Same reason as the cap warning above: a refused write leaves the model free to report success,
    // and the metered run is over by the time anyone reads the log (tkt-354d1bdcffa9).
    if ((result.outcome.rejected ?? 0) > 0) {
      console.warn(`\n! ${result.outcome.rejected} write(s) were refused by the service and no ticket was created for them. Re-run the report, or check the run log for the rejection text.`);
    }

    // Per-run cost & economics via the shared meterRun (usage from both runtime clients). Best-effort — the tickets are already written, so a run-log failure won't fail the run.
    const usage = mergeUsage(chat.getUsage(), embedder.getUsage());
    const summary = await meterRun({
      runId: result.runId,
      model,
      usage,
      outcome: result.outcome,
      reviewMs,
      ticketIds: { created: result.createdIds, updated: result.updatedIds },
      prefixText,
      dynamicText: input,
    });
    console.log(`\n${renderSummary(summary)}`);
  } finally {
    rl.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\nAgent failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
