import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatReport } from '../harness.js';
import {
  classifyChangedFiles, firstStartedAt, parseCaseManifest, pickFrozenSnapshot, prNumberFromSubject,
  ticketIdFromBranch, type CodingCase,
} from './cases.js';
import { belowMinimumN, evaluateCoding, hashStatements, MIN_SCORED_CASES, runControls } from './codingEval.js';
import { assertContaminationCorpus } from './contamination.js';
import { exec, readContaminationCorpus, readTaskStatement, realDeps, screenCase, sha256 } from './realDeps.js';
import { RUN_REPORT } from './layout.js';
import { DEFAULT_KEEP_RUNS, pruneRuns, type PruneResult } from './retention.js';
import { applyScreen, parseScreen } from './screen.js';

// Cloud-metered: every session is a Claude Code run billed per token. Never wired into `npm test`
// or CI — gateIsolation.test.ts holds that.
//
//   npm run eval:coding -- --select 20        build agent/eval/coding/cases.json from merged PRs
//   npm run eval:coding -- --controls-only    run every pre-session check, spend nothing
//   npm run eval:coding -- --statement <id>   print the exact task statement a session sees, for screening
//   npm run eval:coding -- --prune [--keep n] drop old runs' fixture trees, keep their reports
//   npm run eval:coding -- [--trials k] [--budget usd] [--cases id,id] [--keep n] [--allow-small-n]

export const MANIFEST_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'cases.json');
export const SCREEN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'screen.json');

// Cited in ~/.claude/CLAUDE.md, so a corpus read that cannot find it read nothing useful.
const CORPUS_CONTROL_ID = 'tkt-c8ac95e41f6f';
function evalRootFor(repoRoot: string): string {
  return process.env.EVAL_CODING_DIR ?? path.join(path.dirname(repoRoot), '.hardpack-eval-coding');
}
const DEFAULT_BUDGET_USD = 20;
const SESSION_CAP_MS = 45 * 60_000;

interface Args {
  select: number | null;
  controlsOnly: boolean;
  trials: number;
  budget: number;
  only: string[] | null;
  statement: string | null;
  allowSmallN: boolean;
  prune: boolean;
  keep: number;
}

function parseArgs(argv: string[]): Args {
  const a: Args = {
    select: null, controlsOnly: false, trials: 1, budget: DEFAULT_BUDGET_USD, only: null, statement: null, allowSmallN: false,
    prune: false, keep: DEFAULT_KEEP_RUNS,
  };
  const num = (flag: string, v: string | undefined): number => {
    const n = Number(v);
    if (v === undefined || !Number.isFinite(n) || n <= 0) throw new Error(`${flag} needs a positive number, got ${v ?? 'nothing'}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i];
    if (f === '--select') a.select = num(f, argv[++i]);
    else if (f === '--controls-only') a.controlsOnly = true;
    else if (f === '--trials') a.trials = num(f, argv[++i]);
    else if (f === '--budget') a.budget = num(f, argv[++i]);
    else if (f === '--cases') a.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (f === '--statement') a.statement = argv[++i] ?? '';
    else if (f === '--allow-small-n') a.allowSmallN = true;
    else if (f === '--prune') a.prune = true;
    else if (f === '--keep') a.keep = num(f, argv[++i]);
    else throw new Error(`unknown argument: ${f}`);
  }
  if (a.select !== null && (a.controlsOnly || a.only || a.prune)) throw new Error('--select builds the manifest; it takes no other mode');
  if (a.prune && (a.controlsOnly || a.only)) throw new Error('--prune reclaims disk; it takes no other mode');
  if (a.statement !== null && (a.select !== null || a.prune || a.controlsOnly || a.only)) {
    throw new Error('--statement prints one case\'s task statement; it takes no other mode');
  }
  return a;
}

async function primaryCheckout(cwd: string): Promise<string> {
  const r = await exec('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd });
  if (r.code !== 0) throw new Error('coding-eval: not inside a git checkout');
  return path.dirname(r.out.trim());
}

async function readOrNull(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

// Deterministic spread across time: ordered by a hash of the id rather than recency, so the set is
// not all from the month the rules were heaviest.
async function selectCases(repoRoot: string, boardDir: string, want: number): Promise<void> {
  const g = async (args: string[]): Promise<string> => {
    const r = await exec('git', args, { cwd: repoRoot });
    if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.err}`);
    return r.out;
  };
  await g(['fetch', '-q', 'origin', 'main']);
  // The whole history, not a window: a ticket's earlier PR outside the window would go uncounted.
  const log = await g(['log', 'origin/main', '--first-parent', '--format=%H%x09%P%x09%s']);
  const corpus = await readContaminationCorpus(os.homedir(), { evalRoot: evalRootFor(repoRoot), liveCheckout: repoRoot });
  assertContaminationCorpus(corpus, CORPUS_CONTROL_ID);
  const skipped = new Map<string, number>();
  const skip = (why: string): void => { skipped.set(why, (skipped.get(why) ?? 0) + 1); };
  const picked: CodingCase[] = [];

  // Every PR's ticket first: a ticket landed over several PRs has part of its answer in a later PR's
  // base while its frozen body describes the whole, so it is excluded outright.
  const commits = log.trim().split('\n').map((line) => {
    const [commit, parents, subject] = line.split('\t');
    return { commit, parents: parents.split(' '), pr: prNumberFromSubject(subject) };
  });
  const ticketOf = new Map<number, string | null>();
  const prsPerTicket = new Map<string, number>();
  for (const c of commits) {
    if (c.pr === null) continue;
    const view = await exec('gh', ['pr', 'view', String(c.pr), '--json', 'headRefName', '-q', '.headRefName'], { cwd: repoRoot });
    // An unreadable PR would silently under-count its ticket's PRs, so it stops the selection.
    if (view.code !== 0) throw new Error(`coding-eval: gh could not read PR #${c.pr} (${view.err.trim()}) — refusing to select with an incomplete PR→ticket map.`);
    const id = ticketIdFromBranch(view.out.trim());
    ticketOf.set(c.pr, id);
    if (id) prsPerTicket.set(id, (prsPerTicket.get(id) ?? 0) + 1);
  }

  for (const { commit, parents: parentList, pr } of commits) {
    if (parentList.length !== 1) { skip('merge commit'); continue; }
    const base = parentList[0];
    if (pr === null) { skip('no PR number in subject'); continue; }
    const ticketId = ticketOf.get(pr) ?? null;
    if (!ticketId) { skip('PR branch names no single ticket, or gh could not read it'); continue; }
    if ((prsPerTicket.get(ticketId) ?? 0) > 1) { skip('ticket landed over more than one PR'); continue; }
    const files = classifyChangedFiles((await g(['diff', '--name-only', base, commit])).trim().split('\n').filter(Boolean));
    if (!files.eligible) { skip('not source+tests(+docs) only'); continue; }
    const events = await readOrNull(path.join(boardDir, 'events', `${ticketId}.jsonl`));
    const startedAt = events ? firstStartedAt(events) : null;
    if (!startedAt) { skip('no started event'); continue; }
    let names: string[] = [];
    try { names = await fs.readdir(path.join(boardDir, 'tickets', '.history', ticketId)); } catch { /* none */ }
    const snapshot = pickFrozenSnapshot(names, startedAt);
    if (!snapshot) { skip('no .history snapshot after start'); continue; }
    const hits = await screenCase(repoRoot, { ticketId, base, commit }, corpus);
    if (hits.length > 0) { skip('contaminated'); continue; }
    const body = await fs.readFile(path.join(boardDir, 'tickets', '.history', ticketId, snapshot), 'utf8');
    picked.push({ ticketId, pr, commit, base, testFiles: files.testFiles, bodySha256: sha256(body), snapshot });
  }

  const chosen = picked
    .sort((x, y) => sha256(x.ticketId).localeCompare(sha256(y.ticketId)))
    .slice(0, want);
  const manifest = {
    $comment: 'Generated by `npm run eval:coding -- --select N` (tkt-7beeca1d62ab). Do not hand-edit: bodySha256 pins each frozen task statement.',
    selectedAt: new Date().toISOString(),
    eligible: picked.length,
    cases: chosen,
  };
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  process.stdout.write(`Scanned ${log.trim().split('\n').length} commits; ${picked.length} eligible; wrote ${chosen.length} to ${MANIFEST_PATH}\n`);
  for (const [why, n] of [...skipped].sort((a, b) => b[1] - a[1])) process.stdout.write(`  skipped ${n}: ${why}\n`);
  if (chosen.length < want) process.stdout.write(`! only ${chosen.length} of the ${want} requested were eligible\n`);
}

function reportPrune(result: PruneResult, keep: number): void {
  if (result.pruned.length === 0 && result.skipped.length > 0) {
    // Never "nothing to prune" here: someone running --prune because the disk is full would read
    // that headline and conclude retention had nothing left to give back.
    process.stdout.write(`Retention: reclaimed nothing — ${result.skipped.length} run(s) are unfinished and still recent.\n`);
  } else if (result.pruned.length === 0) {
    process.stdout.write(`Retention: nothing to prune (keeping ${keep} run(s)).\n`);
  } else {
    process.stdout.write(
      `Retention: removed ${result.trees} fixture tree(s) from ${result.pruned.length} run(s), keeping the newest ${keep}. Reports, transcripts and settings kept.\n`,
    );
    for (const stamp of result.pruned) process.stdout.write(`  pruned ${stamp}\n`);
  }
  for (const stamp of result.skipped) process.stdout.write(`  skipped ${stamp} — no report.json and still recent\n`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const repoRoot = await primaryCheckout(process.cwd());
  const boardDir = process.env.BOARD_DIR_OVERRIDE ?? repoRoot;

  if (args.select !== null) {
    await selectCases(repoRoot, boardDir, args.select);
    return;
  }

  if (args.prune) {
    reportPrune(await pruneRuns(evalRootFor(repoRoot), { keep: args.keep }), args.keep);
    return;
  }

  let cases = parseCaseManifest(await fs.readFile(MANIFEST_PATH, 'utf8'));
  if (args.statement !== null) {
    const c = cases.find((x) => x.ticketId === args.statement);
    if (!c) throw new Error(`--statement names ${args.statement || 'nothing'}, which is not in the manifest`);
    const text = await readTaskStatement(repoRoot, boardDir, c);
    process.stdout.write(text);
    process.stderr.write(`statementSha256: ${sha256(text)}\n`);
    return;
  }
  const humanScreen = parseScreen(await fs.readFile(SCREEN_PATH, 'utf8'));
  if (args.only) {
    const unknown = args.only.filter((id) => !cases.some((c) => c.ticketId === id));
    if (unknown.length) throw new Error(`--cases names ids not in the manifest: ${unknown.join(', ')}`);
    cases = cases.filter((c) => args.only?.includes(c.ticketId));
  }
  // Only for cases a verdict could score: one unbuildable unscorable case must not abort the run.
  const statements = new Map<string, string>();
  for (const c of cases.filter((x) => humanScreen.get(x.ticketId)?.scorable)) {
    try {
      statements.set(c.ticketId, await readTaskStatement(repoRoot, boardDir, c));
    } catch (err) {
      process.stdout.write(`! ${c.ticketId}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }
  // Before any fixture, control or prune: a screened-out case is never touched in any mode.
  const { scorable, screenedOut } = applyScreen(cases, humanScreen, hashStatements(statements));
  for (const r of screenedOut) process.stdout.write(`  [SKIP] ${r.ticketId}  ${r.reason}\n`);
  if (scorable.length === 0) throw new Error(`all ${cases.length} case(s) are screened out — nothing to control or score.`);
  // scored ≤ scorable, so below the floor no rate can come back: the spend would buy marks alone.
  if (!args.controlsOnly && scorable.length < MIN_SCORED_CASES && !args.allowSmallN) {
    throw new Error(`${belowMinimumN(scorable.length)} Refusing to spend on a run that cannot report one; pass --allow-small-n for per-case marks.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const evalRoot = evalRootFor(repoRoot);
  const runDir = path.join(evalRoot, stamp);
  const deps = realDeps({
    repoRoot, boardDir, runDir,
    maxBudgetUsd: args.budget,
    sessionCapMs: SESSION_CAP_MS,
    corpusControlId: CORPUS_CONTROL_ID,
    statements,
    log: (l) => process.stdout.write(`${l}\n`),
  });
  process.stdout.write(`Run directory: ${runDir}\n`);

  if (args.controlsOnly) {
    const verdicts = await runControls(scorable, deps);
    const ok = [...verdicts.values()].filter((v) => v.ok).length;
    process.stdout.write(`\n${ok}/${scorable.length} scorable case(s) pass their controls. No session was run.\n`);
    return;
  }

  // After the --controls-only return, so a run documented as spending nothing also destroys nothing,
  // and still before the first metered session. `protect` keeps this run's own dir out of the sweep.
  reportPrune(await pruneRuns(evalRoot, { keep: args.keep, protect: stamp }), args.keep);

  if (scorable.length < MIN_SCORED_CASES) process.stdout.write(`! ${belowMinimumN(scorable.length)}\n`);
  const sessions = scorable.length * args.trials;
  process.stdout.write(`Up to ${sessions} session(s) at a $${args.budget} cap each — spend bounded by $${(sessions * args.budget).toFixed(0)}.\n`);
  const report = await evaluateCoding(cases, deps, { trials: args.trials, humanScreen, statements });
  process.stdout.write(`${formatReport(report)}\n`);
  await fs.writeFile(path.join(runDir, RUN_REPORT), `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(`\ncoding eval failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
