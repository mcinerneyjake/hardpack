import fs from 'node:fs/promises';
import path from 'node:path';
import { RuntimeEmbedder } from './retrieval/retrieval.js';
import { buildCliIndex } from './retrieval/indexCache.js';
import { RuntimeChatClient, resolveLlmConfig } from './runtime/llm.js';
import { runIntake, SYSTEM_PROMPT } from './runtime/loop.js';
import { AGENT_TOOLS } from './runtime/tools.js';
import { mergeUsage, subtractUsage } from './cost/usage.js';
import { resolveCostConfig } from './cost/costConfig.js';
import { buildSummary } from './cost/summary.js';
import { appendRun } from './cost/runLog.js';
import { ReplayRecorder } from './replay/replayRecorder.js';
import { isTrace } from './replay/replayTrace.js';

// Records ONE real agent run into a replay-viewer trace JSON by wrapping chat/index/approve with the ReplayRecorder — no changes to the loop. Requires running embedding + chat models.
//   npm run agent:record -- --out traces/create.json "the export button 500s"
//   npm run agent:record -- --decline --out traces/decline.json "<vague note>"
// --decline declines at the gate (records a declined approval, writes nothing).

const USAGE = 'Usage: npm run agent:record -- --out <path> [--decline] "<report>"';

try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let decline = false;
  let out = '';
  // Leading flags only, so a `--`-lookalike inside the report isn't consumed.
  while (argv.length > 0) {
    const first = argv[0];
    if (first === '--decline') { decline = true; argv.shift(); }
    else if (first === '--out') {
      argv.shift();
      const value = argv.shift();
      // A missing --out value must error, not swallow the next flag as a filename (e.g. "--decline").
      if (value === undefined || value.startsWith('--')) { console.error(USAGE); process.exit(1); }
      out = value;
    } else break;
  }
  const input = argv.join(' ').trim();
  if (!input || !out) { console.error(USAGE); process.exit(1); }

  const recorder = new ReplayRecorder();
  const embedder = RuntimeEmbedder.fromEnv();
  const chat = RuntimeChatClient.fromEnv();
  const model = resolveLlmConfig().model;

  console.log('Building the board index…');
  const index = await buildCliIndex(embedder);
  // Snapshot AFTER the index build so the one-time full-board embed isn't charged to this run — trace totals then reflect marginal cost (chat + per-query embeds).
  const embedBaseline = embedder.getUsage();
  recorder.instrument(index);
  console.log(`Indexed ${index.size} tickets. Recording intake (${decline ? 'decline' : 'auto-approve'})…`);

  const result = await runIntake(input, {
    chat: recorder.chat(chat),
    index,
    approve: recorder.approve(() => !decline),
  });

  const usage = mergeUsage(chat.getUsage(), subtractUsage(embedder.getUsage(), embedBaseline));
  const at = new Date().toISOString();

  // Persist the run log so a stamped ticket's provenance badge resolves to a real run, not a dead "?runId=" link. Best-effort — writes already landed, so a log failure must not fail the recording.
  const summary = buildSummary({
    usage,
    outcome: result.outcome,
    reviewMs: 0, // non-interactive gate — no human review pause to meter
    cfg: resolveCostConfig(),
    model,
    prefixText: SYSTEM_PROMPT + JSON.stringify(AGENT_TOOLS),
    dynamicText: input,
  });
  try {
    await appendRun({
      runId: result.runId, at, model, usage,
      outcome: result.outcome, reviewMs: 0, cost: summary,
      ticketIds: { created: result.createdIds, updated: result.updatedIds },
      cappedCreates: result.cappedCreates,
    });
  } catch (err) {
    console.warn(`[runlog] failed to persist run ${result.runId}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const trace = recorder.build({
    input, runId: result.runId, model, at,
    final: result.final, createdIds: result.createdIds, updatedIds: result.updatedIds,
    outcome: result.outcome, usage,
  });

  // Fail loudly if the recorded trace doesn't satisfy the schema the viewer reads.
  if (!isTrace(trace)) {
    console.error('Recorded trace failed isTrace() validation — not written.');
    process.exit(1);
  }

  const outPath = path.resolve(out);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  console.log(`\n--- Result (${result.steps} steps) ---\n${result.final}`);
  console.log(`\nWrote ${trace.steps.length} trace steps → ${out}`);
  console.log(`runId ${result.runId} · outcome ${JSON.stringify(trace.meta.outcome)} · created ${JSON.stringify(result.createdIds)} · updated ${JSON.stringify(result.updatedIds)}`);
}

main().catch((err: unknown) => {
  console.error(`\nRecord failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
