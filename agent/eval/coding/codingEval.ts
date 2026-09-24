import { runEval, type EvalReport } from '../harness.js';
import type { CodingCase } from './cases.js';
import { CONTAMINATION_RESIDUAL, type ContaminationHit } from './contamination.js';
import {
  confirmedRegressions, filePasses, gradeCase, hiddenPass, mergeGoldRuns, regressionCandidates, summarizeTrials,
  type CaseGrade, type VitestRun,
} from './grading.js';
import { NETWORK_RESIDUAL, promptHash } from './session.js';

// Every git, npm, vitest and `claude` call sits behind this seam, so the eval's decisions are tested
// with stubs and no subprocess.
export interface CodingDeps {
  // Instrument-wide checks; a throw aborts the whole run.
  checkEnvironment: () => Promise<void>;
  screen: (c: CodingCase) => Promise<ContaminationHit[]>;
  // A fresh one-commit, no-remote fixture at `base`. Throws when it cannot prove that shape.
  prepareFixture: (c: CodingCase, label: string) => Promise<string>;
  // Writes C's version of every hidden test file into `dir`, then runs just those files.
  runHidden: (dir: string, c: CodingCase) => Promise<VitestRun>;
  applyGold: (dir: string, c: CodingCase) => Promise<void>;
  runFullSuite: (dir: string) => Promise<VitestRun>;
  runFiles: (dir: string, files: readonly string[]) => Promise<VitestRun>;
  runSession: (dir: string, c: CodingCase) => Promise<SessionOutcome>;
  // A fresh clone holding the session's files, taken from the fixture or its single linked worktree.
  gradeTree: (dir: string, c: CodingCase, label: string) => Promise<string>;
  // Called after every case, so an aborted run keeps what it already paid for.
  record: (result: CodingResult) => Promise<void>;
  log: (line: string) => void;
}

export interface SessionOutcome {
  exitCode: number;
  costUsd: number | null;
  durationMs: number;
  timedOut: boolean;
  // From the stream-json result line; false and null when there is none.
  isError: boolean;
  turns: number | null;
}

export interface Trial {
  grade: CaseGrade;
  session: SessionOutcome;
}

export type CodingResult =
  | { ticketId: string; status: 'dropped'; reason: string }
  | { ticketId: string; status: 'scored'; trials: Trial[] };

interface Verdict { ok: true; goldHidden: VitestRun; goldFull: VitestRun }
interface Drop { ok: false; reason: string }

export interface CodingEvalOptions {
  trials: number;
}

// A case failing a control is dropped and named: its hidden tests cannot tell solved from unsolved.
async function controlCase(c: CodingCase, deps: CodingDeps): Promise<Verdict | Drop> {
  const hits = await deps.screen(c);
  if (hits.length > 0) {
    const where = [...new Set(hits.map((h) => `${h.needle} in ${h.path}`))].slice(0, 3).join('; ');
    return { ok: false, reason: `contaminated — ${where}` };
  }
  const baseDir = await deps.prepareFixture(c, 'control-base');
  const base = await deps.runHidden(baseDir, c);
  if (hiddenPass(base, c.testFiles)) {
    return { ok: false, reason: 'BASE control failed — the hidden tests already pass before any work, so they cannot detect a solution' };
  }
  const goldDir = await deps.prepareFixture(c, 'control-gold');
  await deps.applyGold(goldDir, c);
  const goldHidden = await deps.runHidden(goldDir, c);
  if (!hiddenPass(goldHidden, c.testFiles)) {
    const red = c.testFiles.filter((f) => !goldHidden.files.get(f) || (goldHidden.files.get(f)?.failed ?? 1) > 0);
    return { ok: false, reason: `GOLD control failed — the merged patch does not pass its own tests here (${red.join(', ') || 'unhandled error'})` };
  }
  const firstGold = await deps.runFullSuite(goldDir);
  const redOnGold = [...firstGold.files].filter(([, o]) => !filePasses(o)).map(([f]) => f);
  // A load-sensitive timeout on the one gold run would otherwise exempt that file from every trial.
  const goldFull = redOnGold.length ? mergeGoldRuns(firstGold, await deps.runFiles(goldDir, redOnGold)) : firstGold;
  return { ok: true, goldHidden, goldFull };
}

export async function runControls(cases: readonly CodingCase[], deps: CodingDeps): Promise<Map<string, Verdict | Drop>> {
  await deps.checkEnvironment();
  const verdicts = new Map<string, Verdict | Drop>();
  for (const c of cases) {
    const v = await controlCase(c, deps);
    verdicts.set(c.ticketId, v);
    deps.log(v.ok ? `  ok ${c.ticketId}` : `! DROPPED ${c.ticketId}: ${v.reason}`);
  }
  if (![...verdicts.values()].some((v) => v.ok)) {
    throw new Error(`coding-eval: all ${cases.length} case(s) failed their controls — there is nothing to score. Read the DROPPED lines above.`);
  }
  return verdicts;
}

// A session that never worked (auth, a rejected flag, a rate limit) is not a model failure: scoring it
// reports a plausible rate over nothing. A session killed at the time cap DID work, and is graded.
export function sessionDidNotRun(s: SessionOutcome): boolean {
  if (s.timedOut) return false;
  if (s.costUsd === null) return s.exitCode !== 0;
  return s.isError && (s.turns ?? 0) <= 1;
}

// Seen on the first real trial (tkt-4251671dcb5a): the session's own valid design failed hidden tests
// asserting the gold PR's exact strings. Until each case is human-screened, F2P undercounts.
export const UNDERSPECIFICATION =
  'Not screened: whether each hidden test is specified by its ticket body. A hidden test that asserts the ' +
  'gold PR\'s exact wording or design fails a different valid solution, so FAIL_TO_PASS is a floor.';

// The harness itself failed (a test slot never freed, a git read of the case commit): never a score.
export class InstrumentFault extends Error {}

async function gradeTrial(c: CodingCase, v: Verdict, work: string, deps: CodingDeps): Promise<CaseGrade> {
  const hidden = await deps.runHidden(work, c);
  const first = await deps.runFullSuite(work);
  const needsSecond = regressionCandidates(c.testFiles, v.goldFull, first).candidates.length > 0
    || (v.goldFull.success && !first.success);
  // A second FULL run, not the candidates alone: a failure caused by interference between files would
  // pass in isolation.
  const second = needsSecond ? await deps.runFullSuite(work) : first;
  const { regressed, envBroken } = confirmedRegressions(c.testFiles, v.goldFull, first, second);
  return gradeCase(hiddenPass(hidden, c.testFiles, v.goldHidden), regressed, envBroken);
}

async function runTrial(c: CodingCase, v: Verdict, deps: CodingDeps, n: number): Promise<Trial> {
  const fixture = await deps.prepareFixture(c, `trial-${n}`);
  const session = await deps.runSession(fixture, c);
  if (sessionDidNotRun(session)) {
    throw new InstrumentFault(`coding-eval: the ${c.ticketId} trial-${n} session exited ${session.exitCode}${session.isError ? ' with an error result' : ' with no result'} — it never ran. Aborting rather than scoring an untouched tree; results so far are recorded.`);
  }
  let grade: CaseGrade;
  try {
    grade = await gradeTrial(c, v, await deps.gradeTree(fixture, c, `trial-${n}`), deps);
  } catch (err) {
    if (err instanceof InstrumentFault) throw err;
    // The session's tree broke grading (a config that will not load): that is its FAIL.
    const msg = err instanceof Error ? err.message.split('\n')[0] : String(err);
    grade = { ...gradeCase(false, [], []), error: msg };
  }
  return { grade, session };
}

function fmtUsd(v: number): string {
  return `$${v.toFixed(2)}`;
}

function summarize(results: CodingResult[]): { metrics: Record<string, number>; lines: string[] } {
  const scored = results.filter((r): r is Extract<CodingResult, { status: 'scored' }> => r.status === 'scored');
  const dropped = results.filter((r): r is Extract<CodingResult, { status: 'dropped' }> => r.status === 'dropped');
  const lines: string[] = [];
  lines.push(`  prompt ${promptHash()} · ${scored.length} scored · ${dropped.length} dropped`);
  for (const r of scored) {
    const marks = r.trials.map((t) => (t.grade.resolved ? 'PASS' : t.grade.error ? 'ERR ' : !t.grade.failToPass ? 'F2P ' : 'P2P ')).join(' ');
    const cost = r.trials.map((t) => (t.session.costUsd === null ? '$?' : fmtUsd(t.session.costUsd))).join(' ');
    const notes = r.trials.flatMap((t) => [...t.grade.regressed, ...(t.grade.error ? [t.grade.error] : [])]);
    lines.push(`  [${marks}] ${r.ticketId}  ${cost}${notes.length ? `  ${[...new Set(notes)].join('; ')}` : ''}`);
  }
  for (const r of dropped) lines.push(`  [DROP] ${r.ticketId}  ${r.reason}`);

  const trials = scored.flatMap((r) => r.trials);
  const unreportedCost = trials.filter((t) => t.session.costUsd === null).length;
  const totalCost = trials.reduce<number>((a, t) => a + (t.session.costUsd ?? 0), 0);
  const wallMs = trials.reduce((a, t) => a + t.session.durationMs, 0);
  lines.push('');
  lines.push(`  sessions: ${trials.length} · cost ${fmtUsd(totalCost)}${unreportedCost ? ` — a FLOOR: ${unreportedCost} session(s) reported no cost` : ''} · wall ${(wallMs / 60000).toFixed(1)} min`);
  lines.push('  Not comparable with the night-run `level`: that is a board-transition reading over different tickets; this is hidden-test completion over a fixed set.');
  lines.push(`  ${CONTAMINATION_RESIDUAL}`);
  lines.push(`  ${UNDERSPECIFICATION}`);
  lines.push(`  ${NETWORK_RESIDUAL}`);
  lines.push('  Owed a run after: a CLAUDE.md or SKILL.md rule change, a model change, or a ticket-workflow pin bump.');

  if (scored.length === 0) {
    lines.push('  NO case survived its controls — no rate is reported.');
    return { metrics: { scored: 0, dropped: dropped.length }, lines };
  }
  const s = summarizeTrials(scored.map((r) => r.trials.map((t) => t.grade.resolved)));
  lines.push(`  pass rate ${(s.passRate * 100).toFixed(1)}% ± ${(s.standardError * 100).toFixed(1)} pts (1 SE, n=${s.cases}, k=${s.trials})`);
  const metrics: Record<string, number> = {
    scored: s.cases,
    dropped: dropped.length,
    trials: s.trials,
    passRate: s.passRate,
    standardError: s.standardError,
    passAtK: s.passAtK,
    costUsdFloor: totalCost,
    unreportedCostSessions: unreportedCost,
    wallMinutes: wallMs / 60000,
  };
  if (s.passHatK !== null) metrics.passHatK = s.passHatK;
  return { metrics, lines };
}

export function evaluateCoding(
  cases: readonly CodingCase[],
  deps: CodingDeps,
  opts: CodingEvalOptions,
): Promise<EvalReport<CodingResult>> {
  if (!Number.isInteger(opts.trials) || opts.trials < 1) {
    throw new Error(`coding-eval: trials must be a positive integer, got ${opts.trials}`);
  }
  let verdicts = new Map<string, Verdict | Drop>();
  return runEval<CodingCase, CodingResult>({
    name: 'coding held-out replay',
    cases: [...cases],
    assertInstruments: async () => {
      verdicts = await runControls(cases, deps);
    },
    scoreCase: async (c) => {
      const v = verdicts.get(c.ticketId);
      // Unreachable through runEval, which asserts first; an unchecked case scored is what this refuses.
      if (!v) throw new Error(`coding-eval: ${c.ticketId} reached scoring with no control verdict`);
      let result: CodingResult;
      if (!v.ok) {
        result = { ticketId: c.ticketId, status: 'dropped', reason: v.reason };
      } else {
        const trials: Trial[] = [];
        for (let n = 1; n <= opts.trials; n++) {
          deps.log(`… ${c.ticketId} trial ${n}/${opts.trials}`);
          try {
            trials.push(await runTrial(c, v, deps, n));
          } catch (err) {
            // Keep the trials this case already paid for; a partial case is recorded, never scored.
            if (trials.length) await deps.record({ ticketId: c.ticketId, status: 'scored', trials });
            throw err;
          }
        }
        result = { ticketId: c.ticketId, status: 'scored', trials };
      }
      await deps.record(result);
      return result;
    },
    summarize,
  });
}
