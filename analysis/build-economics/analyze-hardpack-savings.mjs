#!/usr/bin/env node
// Build economics: how much did building this repo (app + agent/) + ticket-workflow with Claude
// cost and save vs by hand? Reconstructed from Claude Code session telemetry. Emits an
// AGGREGATES-ONLY snapshot (safe to commit to a public repo — no per-ticket titles, no user paths).
//
// Run (on the machine whose ~/.claude holds the transcripts):  node analyze-hardpack-savings.mjs
// Override paths with env: KANBAN_REPO, TW_REPO, OUT.
//
// FOUR MEASUREMENT AUDITS baked in (see README.md):
//   1. Dedup by message.id (max-output record) — streaming logs each response many times (~2.4x overcount).
//   2. Scope to this repo + ticket-workflow — exclude other repos' tickets (the board is central).
//   3. Counterfactual anchored on merged PRs, not ticket counts (tickets are unreliable here).
//   4. Supervision = union wall-clock across concurrent sessions (not per-session sum).
import { readFileSync, readdirSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const KANBAN_REPO = process.env.KANBAN_REPO || resolve(HERE, '..', '..'); // analysis/build-economics/ -> repo root
const TW_REPO = process.env.TW_REPO || resolve(KANBAN_REPO, '..', 'ticket-workflow');
const OUT = process.env.OUT || join(HERE, 'hardpack-savings.json');
const HOME = homedir();
// Claude Code encodes a session's cwd into its project-dir name by replacing / and . with -.
const encodeCwd = p => p.replace(/[/.]/g, '-');
const PROJECT_DIRS = [
  join(HOME, '.claude', 'projects', encodeCwd(KANBAN_REPO)),
  join(HOME, '.claude', 'projects', encodeCwd(KANBAN_REPO) + '-agent'),
];

// Per-1M-token USD list pricing, verified against platform.claude.com/docs/en/about-claude/pricing on
// 2026-08-16. cacheWrite5m = 1.25x input, cacheWrite1h = 2x input, cacheRead = 0.1x input.
// NOTE: assumes standard rates with no >200K "1M-context" premium, and STANDARD SPEED — fast mode on
// Opus 5 / 4.8 is $10/$50, and the transcripts do not record `speed`, so a fast-mode session is
// under-priced here. That direction is conservative for a savings claim; the reverse would not be.
//
// An UNKNOWN model is a hard error, not a $0 row — see unpricedUsage below. `claude-opus-5` was
// missing, so 36,296 messages and 7,797M tokens (80% of all tokens) priced at zero and the published
// cumulative cost FELL from $2485.30 to $1670.95 while merged PRs rose 155 -> 301 (tkt-feb341a5c699).
const PRICES = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 }, 'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 }, 'claude-opus-4-5': { in: 5, out: 25 },
  'claude-opus-4-1': { in: 15, out: 75 }, 'claude-opus-4': { in: 15, out: 75 },
  'claude-fable-5': { in: 10, out: 50 }, 'claude-mythos-5': { in: 10, out: 50 },
  // $2/$10, not $3/$15: the launch introductory rate became the standard price and the scheduled
  // 2026-09-01 increase was cancelled. The old value was in this table and simply wrong.
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 }, 'claude-sonnet-4-5': { in: 3, out: 15 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 }, 'claude-haiku-3-5': { in: 0.8, out: 4 },
};
export const priceKey = model => {
  if (!model) return null;
  let m = model.replace(/\[1m\]$/, '');
  if (PRICES[m]) return m;
  m = m.replace(/-\d{8}$/, '');
  if (PRICES[m]) return m;
  if (m.startsWith('claude-haiku-4-5')) return 'claude-haiku-4-5';
  return null;
};

// `<synthetic>` is Claude Code's marker for a locally-generated message that was never billed — the one
// model string whose true price IS zero. Listed explicitly so it stays distinguishable from a model we
// merely failed to recognise.
const UNBILLED_MODELS = new Set(['<synthetic>']);

/**
 * Cost, or null when the model cannot be priced. NULL, never 0 — a zero is indistinguishable from a
 * genuinely free response and is exactly how this analysis under-reported 80% of its own token spend.
 * Callers must route null into unpricedUsage rather than adding it.
 */
export const costOf = (model, u) => {
  if (UNBILLED_MODELS.has(model)) return 0;
  const k = priceKey(model);
  if (!k) return null;
  const p = PRICES[k];
  return (u.input * p.in + u.output * p.out + u.w5 * p.in * 1.25 + u.w1 * p.in * 2 + u.read * p.in * 0.1) / 1e6;
};

const IDLE_CAP_S = 300;
const PR_HOURS = [2, 3];   // deliberately-low by-hand hours per merged PR (the counterfactual anchor)
const RATE = 100;          // loaded engineer $/hr

// Both spellings of the tracker: the board label was renamed job-networking-tracker → job-tracker on
// 2026-07-22, and this walks the whole session history, so sessions on either side of that rename
// must both be excluded. Dropping the old name would silently re-include everything before the
// rename; omitting the new one silently counted everything after it as in-scope kanban work
// (tkt-6b56ae9defce).
const OUT_OF_SCOPE = new Set(['portfolio-site', 'job-networking-tracker', 'job-tracker']);

// Everything below runs ONLY as `node analyze-hardpack-savings.mjs --write` (tkt-48680743ed36).
//
// It used to be top-level, so merely IMPORTING this module — to check that it still loaded — ran the
// whole analysis and OVERWROTE the tracked snapshot. Observed 2026-08-11: asOf 2026-07-21 → 2026-08-11,
// mergedPRs 155 → 246, loc 26693 → 34414, caught only because `git status` happened to flag the file
// while cutting an unrelated branch.
//
// TWO guards, because they stop different things:
//   isMain   — an import is inert. Not just write-free: the analysis parses every session transcript,
//              so an unguarded import costs seconds and prints a page of output as well.
//   --write  — a direct run without it ANALYSES and PRINTS but writes nothing. hardpack-savings.json is
//              a deliberately frozen, asOf-dated snapshot (tkt-b57fed1622d9, tkt-8ab21d340242) read by
//              src/components/EconomicsBuildSection.tsx and quoted in published portfolio figures, so
//              regenerating it is an explicit act, never a side-effect of running the analysis.
//
// Matches the precedent in scripts/probe/vacuous-ratchet.mjs and scripts/probe/merged-branches.mjs.
// realpath both sides: node realpaths import.meta.url but sets argv[1] via path.resolve, so comparing
// raw paths makes the CLI a silent no-op through a symlink.
const invokedReal = process.argv[1] ? (() => {
  try { return realpathSync(process.argv[1]); } catch { return null; }
})() : null;
export const isMain = invokedReal === realpathSync(fileURLToPath(import.meta.url));

/** The write gate, pure so it is testable without the (transcript-dependent) analysis around it. */
export const shouldWrite = (argv) => argv.includes('--write');

/**
 * Unpriced usage blocks the write (tkt-feb341a5c699). The published figure is a cost FLOOR and a
 * savings claim is computed against it, so a model this table does not know must stop the snapshot
 * rather than quietly shrink the denominator: an unpriced model reads as free work, which inflates ROI.
 *
 * `--allow-unpriced` is the deliberate override, and it is not silent — the count rides into the
 * snapshot either way, so a reader of the JSON can see the hole without re-running anything.
 *
 * Returns a reason string (why the write must stop) or null (proceed). A string, not a boolean, so the
 * caller cannot print a generic message that fails to name which model is missing.
 */
export function unpricedBlocksWrite(unpriced, argv = []) {
  const models = Object.entries(unpriced ?? {});
  if (models.length === 0) return null;
  if (argv.includes('--allow-unpriced')) return null;
  const detail = models
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([m, v]) => `  ${m}: ${v.messages} responses, ${(v.tokens / 1e6).toFixed(0)}M tokens`)
    .join('\n');
  return (
    `REFUSING TO WRITE: ${models.length} model(s) have no entry in PRICES, so their spend is missing ` +
    `from the total:\n${detail}\n` +
    'Priced at zero, an unknown model reads as free work and inflates the savings/ROI figures — the ' +
    'defect this guard exists to stop. Add the rate to PRICES (verify it at ' +
    'platform.claude.com/docs/en/about-claude/pricing), or pass --allow-unpriced to publish a snapshot ' +
    'that openly declares the gap.'
  );
}

/**
 * The gate, and the WIRING of it — separate from main() so a test can reach the write without the
 * transcript-dependent analysis in front of it. Mutating the condition here has to turn a test red;
 * when this lived inline, `if (shouldWrite(argv))` → `if (true)` left the suite green because no test
 * could get past the analysis to the write.
 *
 * A run without --write still PRINTS everything: the analysis stays usable for a look, and only the
 * frozen snapshot is protected.
 */
export function emitSnapshot(argv, outPath, payload) {
  // Checked BEFORE the --write gate so a dry run reports the gap too. A blocked write exits non-zero:
  // the console line alone would scroll past in a pipeline and read as success.
  const blocked = unpricedBlocksWrite(payload?.measured?.unpricedUsage, argv);
  if (blocked) {
    console.error(blocked);
    process.exitCode = 2;
    return false;
  }
  if (!shouldWrite(argv)) {
    console.log('DRY RUN — nothing written. Pass --write to regenerate', outPath, `(this run computed asOf ${payload.asOf})`);
    return false;
  }
  writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
  console.log('Wrote', outPath, '| asOf', payload.asOf);
  return true;
}

export function main(argv = process.argv.slice(2)) {
  function walkJsonl(dir, acc) {
    let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walkJsonl(p, acc);
      else if (e.isFile() && e.name.endsWith('.jsonl')) acc.push(p);
    }
  }
  const files = [];
  for (const d of PROJECT_DIRS) walkJsonl(d, files);
  if (!files.length) {
    console.error('No transcripts found under', PROJECT_DIRS, '\nRun this on the machine whose ~/.claude holds the sessions, or set KANBAN_REPO.');
    process.exit(1);
  }
  const topLevelSet = new Set(files.filter(f => !f.replace(/^.*-(kanban|kanban-agent)\//, '').includes('/')));

  // tickets (central board) — for scope filtering only; titles are NEVER written to the snapshot
  function readFrontmatter(p) {
    const txt = readFileSync(p, 'utf8');
    const m = txt.match(/^---\n([\s\S]*?)\n---/);
    if (!m) return {};
    const fm = {};
    for (const l of m[1].split('\n')) { const mm = l.match(/^(\w+):\s*(.*)$/); if (mm) fm[mm[1]] = mm[2].replace(/^['"]|['"]$/g, ''); }
    return fm;
  }
  const tickets = {};
  const ticketDir = join(KANBAN_REPO, 'tickets');
  if (existsSync(ticketDir)) for (const f of readdirSync(ticketDir)) if (f.endsWith('.md')) { const id = f.replace(/\.md$/, ''); try { tickets[id] = readFrontmatter(join(ticketDir, f)); } catch { /* skip unreadable */ } }
  const branchProject = branch => { const m = branch.match(/tkt-[0-9a-f]{12}/); return m ? (tickets[m[0]]?.project ?? null) : null; };

  // ---- Phase 1: dedup by message.id, keep the max-output (final) record ----
  const records = new Map();
  let rawRecords = 0, anon = 0;
  for (const f of files) {
    const isTop = topLevelSet.has(f);
    let data; try { data = readFileSync(f, 'utf8'); } catch { continue; }
    for (const line of data.split('\n')) {
      if (!line) continue;
      let rec; try { rec = JSON.parse(line); } catch { continue; }
      if (rec.type !== 'assistant' || !rec.message?.usage) continue;
      rawRecords++;
      const um = rec.message.usage;
      const w1 = um.cache_creation?.ephemeral_1h_input_tokens ?? 0;
      const w5 = um.cache_creation?.ephemeral_5m_input_tokens ?? ((um.cache_creation_input_tokens ?? 0) - w1);
      const cur = {
        input: um.input_tokens || 0, output: um.output_tokens || 0, read: um.cache_read_input_tokens || 0,
        w5: Math.max(0, w5), w1: Math.max(0, w1), model: rec.message.model || 'unknown',
        branch: rec.gitBranch || '(none)', isTop, ts: rec.timestamp ? Date.parse(rec.timestamp) : NaN,
      };
      const id = rec.message.id || ('anon-' + (++anon));
      const prev = records.get(id);
      if (!prev) records.set(id, cur);
      else if (cur.output > prev.output) {
        cur.input = Math.max(cur.input, prev.input); cur.read = Math.max(cur.read, prev.read);
        cur.w5 = Math.max(cur.w5, prev.w5); cur.w1 = Math.max(cur.w1, prev.w1);
        records.set(id, cur);
      }
    }
  }

  // ---- Phase 2: aggregate unique billed records (scope-filtered) ----
  const byModel = {};
  const byBranch = {};
  const topTs = [];
  let topLevelMessages = 0, subagentMessages = 0, firstTs = null, lastTs = null;
  const excludedLeak = { cost: 0, count: 0, byProject: {} };
  // Responses whose model has no price. Collected rather than silently zeroed, and reported per model
  // with its token volume so the size of the hole is visible before anyone reads the total.
  const unpriced = {};
  for (const u of records.values()) {
    const rawCost = costOf(u.model, u);
    // Unpriced records still count everywhere EXCEPT cost. Their tokens and timestamps are measured
    // facts; only the rate is unknown, and dropping them outright would quietly deflate
    // supervisedHours and the token total too — a second wrong number chasing the first.
    if (rawCost === null) {
      const un = (unpriced[u.model ?? '(no model field)'] ??= { messages: 0, tokens: 0 });
      un.messages++; un.tokens += u.input + u.output + u.w5 + u.w1 + u.read;
    }
    const cost = rawCost ?? 0;
    const proj = branchProject(u.branch);
    if (proj && OUT_OF_SCOPE.has(proj)) { excludedLeak.cost += cost; excludedLeak.count++; excludedLeak.byProject[proj] = (excludedLeak.byProject[proj] || 0) + cost; continue; }
    const bm = (byModel[u.model] ??= { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0, messages: 0, unpriced: false });
    bm.input += u.input; bm.output += u.output; bm.cacheWrite5m += u.w5; bm.cacheWrite1h += u.w1; bm.cacheRead += u.read; bm.cost += cost; bm.messages++;
    // Marks the row whose `cost` is a floor of 0 rather than a measurement, so byModel cannot be read
    // as "this model was free" without the flag beside it.
    if (rawCost === null) bm.unpriced = true;
    const bb = (byBranch[u.branch] ??= { cost: 0, closed: null });
    bb.cost += cost;
    if (u.isTop) topLevelMessages++; else subagentMessages++;
    if (!Number.isNaN(u.ts)) { if (u.isTop) topTs.push(u.ts); if (firstTs === null || u.ts < firstTs) firstTs = u.ts; if (lastTs === null || u.ts > lastTs) lastTs = u.ts; }
  }
  // union wall-clock supervision (concurrent sessions must not double-count)
  topTs.sort((a, b) => a - b);
  let activeMs = 0;
  for (let i = 1; i < topTs.length; i++) activeMs += Math.min(topTs[i] - topTs[i - 1], IDLE_CAP_S * 1000);
  const activeHours = activeMs / 3.6e6;

  const totals = { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0 };
  for (const b of Object.values(byModel)) { for (const k of Object.keys(totals)) totals[k] += b[k]; }
  totals.allTokens = totals.input + totals.output + totals.cacheWrite5m + totals.cacheWrite1h + totals.cacheRead;

  // completed vs unfinished (closed = ship milestone OR ticket status done/archived); only unfinished cost is stripped
  const eventsDir = join(KANBAN_REPO, 'events');
  const shippedMilestone = new Set();
  if (existsSync(eventsDir)) for (const f of readdirSync(eventsDir)) {
    if (!f.startsWith('tkt-') || !f.endsWith('.jsonl')) continue;
    const id = f.replace(/\.jsonl$/, '');
    try { for (const l of readFileSync(join(eventsDir, f), 'utf8').split('\n')) { if (!l) continue; let r; try { r = JSON.parse(l); } catch { continue; } if ((r.step === 'commit' && r.state === 'passed') || (r.step === 'done' && r.state === 'reached') || r.step === 'pr_opened') { shippedMilestone.add(id); break; } } } catch { /* skip unreadable */ }
  }
  const isClosedBranch = branch => { const m = branch.match(/tkt-[0-9a-f]{12}/); if (!m) return true; const id = m[0]; const st = tickets[id]?.status; return shippedMilestone.has(id) || st === 'done' || st === 'archived'; };
  let unfinished = { cost: 0, count: 0 };
  for (const [branch, b] of Object.entries(byBranch)) if (!isClosedBranch(branch)) { unfinished.cost += b.cost; unfinished.count++; }

  // ---- git: LOC + PR counts (publicly reproducible) ----
  function repoLoc(repo) {
    if (!existsSync(join(repo, '.git'))) return 0;
    try {
      const list = execSync(`git -C '${repo}' ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.cjs' '*.css' '*.scss' '*.html' | grep -Ev 'node_modules|dist/|build/|\\.min\\.' || true`, { encoding: 'utf8', maxBuffer: 1e8 }).split('\n').filter(Boolean);
      let loc = 0; for (const rel of list) { try { loc += readFileSync(join(repo, rel), 'utf8').split('\n').length; } catch { /* skip unreadable */ } }
      return loc;
    } catch { return 0; }
  }
  const prCount = repo => existsSync(join(repo, '.git')) ? (parseInt(execSync(`git -C '${repo}' log --oneline | grep -Ec '\\(#[0-9]+\\)' || true`, { encoding: 'utf8' }).trim()) || 0) : 0;
  const locHardpack = repoLoc(KANBAN_REPO), locTw = repoLoc(TW_REPO), totalLoc = locHardpack + locTw;
  const prHardpack = prCount(KANBAN_REPO), prTw = prCount(TW_REPO), totalPRs = prHardpack + prTw;

  // ---- derived savings (PR-anchored) ----
  const claudeCompleted = totals.cost - unfinished.cost;
  const days = (firstTs && lastTs) ? (lastTs - firstTs) / 8.64e7 : 0;
  const round = n => Math.round(n);
  const savings = {
    anchor: { mergedPRs: totalPRs, hoursPerPr: PR_HOURS, ratePerHour: RATE, note: 'deliberately-low; the by-hand side is an estimate, adjust hours/PR to taste' },
    timeSavedHrs: PR_HOURS.map(h => round(totalPRs * h - activeHours)),
    valueUsdSaved: PR_HOURS.map(h => round(totalPRs * h * RATE - claudeCompleted)),
    roi: PR_HOURS.map(h => +((totalPRs * h * RATE) / claudeCompleted).toFixed(1)),
  };

  const out = {
    asOf: lastTs ? new Date(lastTs).toISOString().slice(0, 10) : null,
    generatedFor: 'hardpack repo (app + agent/agentic-rag-demo) + ticket-workflow',
    headline: {
      publiclyVerifiable: { mergedPRs: totalPRs, loc: totalLoc, supervisedHours: +activeHours.toFixed(1), calendarDays: +days.toFixed(1), prsPerDay: +(totalPRs / (days || 1)).toFixed(1) },
      selfReported: { claudeCostUsd: { completedOnly: +claudeCompleted.toFixed(2), allSessions: +totals.cost.toFixed(2) }, tokens: totals.allTokens, billedResponses: records.size },
      estimatedSavings: savings,
    },
    measured: {
      transcriptFiles: files.length, billedResponses: records.size, topLevelMessages, subagentMessages,
      calendarSpan: { first: firstTs ? new Date(firstTs).toISOString() : null, last: lastTs ? new Date(lastTs).toISOString() : null, days: +days.toFixed(1) },
      supervisedHoursUnion: +activeHours.toFixed(1), idleCapSeconds: IDLE_CAP_S,
      totals, byModel,
      // Always present, `{}` when clean — an absent field reads as "not measured", which is the same
      // ambiguity as pricing an unknown model at zero.
      unpricedUsage: unpriced,
    },
    dedup: { rawAssistantRecords: rawRecords, uniqueBilledResponses: records.size, method: 'one record per message.id (max-output); streaming partials collapsed' },
    scope: { inScope: 'hardpack repo + ticket-workflow (incl. agent/agentic-rag-demo)', excludedProjects: [...OUT_OF_SCOPE], excludedLeak: { cost: +excludedLeak.cost.toFixed(2), responses: excludedLeak.count, byProject: Object.fromEntries(Object.entries(excludedLeak.byProject).map(([k, v]) => [k, +v.toFixed(2)])) }, unattributedNote: '~45% of cost is unattributed main-branch work (planning/board/reviews) — kept as in-repo, not splittable by project' },
    costBasis: { allSessions: +totals.cost.toFixed(2), completedOnly: +claudeCompleted.toFixed(2), unfinished: { cost: +unfinished.cost.toFixed(2), branches: unfinished.count, note: 'branches still open in backlog (no ship milestone and ticket not done/archived)' } },
    counterfactual: { anchor: 'merged PRs (git-verifiable), NOT ticket counts', mergedPRs: totalPRs, prByRepo: { hardpack: prHardpack, ticketWorkflow: prTw }, loc: { total: totalLoc, hardpack: locHardpack, ticketWorkflow: locTw } },
    disclosures: [
      'Dollar cost is SELF-REPORTED from private local session transcripts — not independently reproducible. Only mergedPRs / loc / supervisedHours / velocity are publicly verifiable (git).',
      'Claude cost is a FLOOR: CI code-review API usage runs on GitHub Actions, not in local transcripts, and is not counted.',
      'Priced at standard list rates assuming no >200K 1M-context premium.',
      'Tokens are measured; the dollar figure is the assumed cloud-equivalent (list price). The by-hand side is an estimate anchored on PRs x 2-3h.',
    ],
  };
  emitSnapshot(argv, OUT, out);
  console.log('Verifiable:', totalPRs, 'PRs ·', totalLoc, 'LOC ·', activeHours.toFixed(1), 'supervised hrs ·', out.headline.publiclyVerifiable.prsPerDay, 'PRs/day');
  console.log('Self-reported: $' + claudeCompleted.toFixed(2), 'completed-only / $' + totals.cost.toFixed(2), 'all ·', (totals.allTokens / 1e6).toFixed(0) + 'M tokens ·', records.size, 'responses');
  console.log('Estimated savings (PRs x 2-3h): time', savings.timeSavedHrs.join('-') + 'h · value $' + savings.valueUsdSaved.join('-$') + ' · ROI ' + savings.roi.join('-') + 'x');

}

if (isMain) main();
