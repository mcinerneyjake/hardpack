import path from 'node:path';

export interface FileOutcome {
  passed: number;
  failed: number;
  skipped: number;
}

// Per-file assertion counts of one vitest run, keyed by repo-relative path.
export type FileResults = Map<string, FileOutcome>;

export interface VitestRun {
  files: FileResults;
  // vitest's top-level verdict: false on unhandled errors even when every file reads "passed".
  success: boolean;
}

// Counts, not vitest's per-file `status`: that reads "passed" for an all-skipped file and for a run
// with unhandled errors (JsonReporter: `failed` only when a test or the file itself failed).
export function parseVitestJson(raw: string, root: string): VitestRun {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (err) {
    throw new Error(`coding-eval: vitest JSON report is unparseable: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof data !== 'object' || data === null || !('testResults' in data) || !Array.isArray(data.testResults)) {
    throw new Error('coding-eval: vitest JSON report has no testResults array');
  }
  const files: FileResults = new Map();
  for (const r of data.testResults) {
    if (typeof r !== 'object' || r === null) continue;
    const name: unknown = 'name' in r ? r.name : undefined;
    const status: unknown = 'status' in r ? r.status : undefined;
    const assertions: unknown = 'assertionResults' in r ? r.assertionResults : undefined;
    if (typeof name !== 'string') continue;
    const o: FileOutcome = { passed: 0, failed: status === 'failed' ? 1 : 0, skipped: 0 };
    if (Array.isArray(assertions)) {
      o.failed = 0;
      for (const a of assertions) {
        const s: unknown = typeof a === 'object' && a !== null && 'status' in a ? a.status : undefined;
        if (s === 'passed') o.passed++;
        else if (s === 'failed') o.failed++;
        else o.skipped++;
      }
      // A file-level failure (a throw at import) carries no failed assertion; keep it red.
      if (status === 'failed' && o.failed === 0) o.failed = 1;
    }
    files.set(path.relative(root, name).split(path.sep).join('/'), o);
  }
  const success = 'success' in data && data.success === true;
  return { files, success };
}

export function filePasses(o: FileOutcome | undefined): boolean {
  return o !== undefined && o.failed === 0 && o.passed > 0;
}

// FAIL_TO_PASS: every hidden file reported, green, and passing at least as many assertions as it did
// on the gold tree — so skipping the hidden tests cannot score.
export function hiddenPass(run: VitestRun, files: readonly string[], gold?: VitestRun): boolean {
  if (files.length === 0 || !run.success) return false;
  return files.every((f) => {
    const o = run.files.get(f);
    if (!filePasses(o)) return false;
    const g = gold?.files.get(f);
    return g === undefined || (o?.passed ?? 0) >= g.passed;
  });
}

export interface CaseGrade {
  failToPass: boolean;
  passToPass: boolean;
  // Green on the gold tree, red or missing on the session's tree, and red again on a rerun.
  regressed: string[];
  // Red on the gold tree: environment, not the session, so excluded from PASS_TO_PASS.
  envBroken: string[];
  resolved: boolean;
  error?: string;
}

// Green on gold, and on the session tree either red, missing, or passing FEWER assertions — so skipping
// or deleting the one existing test a change broke is still a regression.
export function regressionCandidates(hiddenFiles: readonly string[], goldFull: VitestRun, sessionFull: VitestRun): { candidates: string[]; envBroken: string[] } {
  const hidden = new Set(hiddenFiles);
  const candidates: string[] = [];
  const envBroken: string[] = [];
  for (const [file, o] of goldFull.files) {
    if (hidden.has(file)) continue;
    if (!filePasses(o)) { envBroken.push(file); continue; }
    const s = sessionFull.files.get(file);
    if (!filePasses(s) || (s?.passed ?? 0) < o.passed) candidates.push(file);
  }
  return { candidates: candidates.sort(), envBroken: envBroken.sort() };
}

// A regression counts only when BOTH full runs show it: one sample under machine load is not evidence.
export function confirmedRegressions(hiddenFiles: readonly string[], goldFull: VitestRun, first: VitestRun, second: VitestRun): { regressed: string[]; envBroken: string[] } {
  const a = regressionCandidates(hiddenFiles, goldFull, first);
  const b = new Set(regressionCandidates(hiddenFiles, goldFull, second).candidates);
  const regressed = a.candidates.filter((f) => b.has(f));
  // An unhandled error is `success: false` that NO red file explains (a red hidden file makes success
  // false too — seen on the first real trial); only meaningful when gold ran clean.
  const unexplained = (r: VitestRun): boolean => !r.success && [...r.files.values()].every(filePasses);
  if (goldFull.success && unexplained(first) && unexplained(second)) regressed.push('<unhandled error in the full suite>');
  return { regressed, envBroken: a.envBroken };
}

// Gold's red files are rerun once; only those red twice are environment, the rest re-enter PASS_TO_PASS.
export function mergeGoldRuns(first: VitestRun, rerun: VitestRun): VitestRun {
  const files = new Map(first.files);
  for (const [f, o] of rerun.files) if (!filePasses(files.get(f)) && filePasses(o)) files.set(f, o);
  return { files, success: first.success };
}

export function gradeCase(failToPass: boolean, regressed: readonly string[], envBroken: readonly string[]): CaseGrade {
  const passToPass = regressed.length === 0;
  return { failToPass, passToPass, regressed: [...regressed], envBroken: [...envBroken], resolved: failToPass && passToPass };
}

export interface RateSummary {
  cases: number;
  trials: number;
  passRate: number;
  // Binomial standard error over cases, from the per-case mean. Stated beside the rate, always.
  standardError: number;
  // P(at least one of k trials resolves), per case, averaged. Equal to passRate when k = 1.
  passAtK: number;
  // P(all k trials resolve). The reliability number; k = 1 cannot produce it, so it is null there.
  passHatK: number | null;
}

export function summarizeTrials(perCase: readonly (readonly boolean[])[]): RateSummary {
  const ks = new Set(perCase.map((t) => t.length));
  if (perCase.length === 0) throw new Error('coding-eval: no scored cases — refusing to report a rate over nothing');
  if (ks.size !== 1 || ks.has(0)) {
    throw new Error(`coding-eval: every case must have the same non-zero trial count, got ${[...ks].join(', ')}`);
  }
  const k = perCase[0].length;
  const n = perCase.length;
  const means = perCase.map((t) => t.filter(Boolean).length / k);
  const passRate = means.reduce((a, b) => a + b, 0) / n;
  const standardError = Math.sqrt((passRate * (1 - passRate)) / n);
  const passAtK = perCase.filter((t) => t.some(Boolean)).length / n;
  const passHatK = k >= 2 ? perCase.filter((t) => t.every(Boolean)).length / n : null;
  return { cases: n, trials: k, passRate, standardError, passAtK, passHatK };
}
