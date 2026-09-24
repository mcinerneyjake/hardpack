import { describe, it, expect } from 'vitest';
import {
  confirmedRegressions, filePasses, gradeCase, hiddenPass, mergeGoldRuns, parseVitestJson, regressionCandidates,
  summarizeTrials, type FileOutcome, type VitestRun,
} from './grading.js';

const ok = (passed = 3): FileOutcome => ({ passed, failed: 0, skipped: 0 });
const red: FileOutcome = { passed: 1, failed: 1, skipped: 0 };
const run = (entries: [string, FileOutcome][], success = true): VitestRun => ({ files: new Map(entries), success });

describe('parseVitestJson', () => {
  const report = (testResults: unknown[], success = true): string => JSON.stringify({ success, testResults });

  it('counts assertions per file, keyed by repo-relative path', () => {
    const r = parseVitestJson(report([
      { name: '/fx/a.test.ts', status: 'passed', assertionResults: [{ status: 'passed' }, { status: 'skipped' }] },
      { name: '/fx/b.test.ts', status: 'failed', assertionResults: [{ status: 'failed' }] },
    ]), '/fx');
    expect(r.files.get('a.test.ts')).toEqual({ passed: 1, failed: 0, skipped: 1 });
    expect(r.files.get('b.test.ts')).toEqual({ passed: 0, failed: 1, skipped: 0 });
    expect(r.success).toBe(true);
  });

  it('keeps a file-level failure red even with no failed assertion (an import-time throw)', () => {
    const r = parseVitestJson(report([{ name: '/fx/a.test.ts', status: 'failed', assertionResults: [] }]), '/fx');
    expect(filePasses(r.files.get('a.test.ts'))).toBe(false);
  });

  it('reads a missing top-level success as false', () => {
    expect(parseVitestJson(JSON.stringify({ testResults: [] }), '/fx').success).toBe(false);
  });

  it('throws on a report it cannot read rather than returning no results', () => {
    expect(() => parseVitestJson('nope', '/fx')).toThrow(/unparseable/);
    expect(() => parseVitestJson('{}', '/fx')).toThrow(/testResults/);
  });
});

describe('filePasses', () => {
  it('fails an all-skipped file, which vitest itself reports as "passed"', () => {
    expect(filePasses({ passed: 0, failed: 0, skipped: 4 })).toBe(false);
    expect(filePasses(undefined)).toBe(false);
    expect(filePasses(ok())).toBe(true);
  });
});

describe('hiddenPass', () => {
  it('fails a hidden file that was never reported — a vanished test must not score', () => {
    expect(hiddenPass(run([['a.test.ts', ok()]]), ['a.test.ts', 'b.test.ts'])).toBe(false);
  });

  it('fails an empty file list and a run with unhandled errors', () => {
    expect(hiddenPass(run([]), [])).toBe(false);
    expect(hiddenPass(run([['a.test.ts', ok()]], false), ['a.test.ts'])).toBe(false);
  });

  it('fails when fewer assertions pass than on gold — skipping part of the hidden tests cannot score', () => {
    const gold = run([['a.test.ts', ok(5)]]);
    expect(hiddenPass(run([['a.test.ts', { passed: 2, failed: 0, skipped: 3 }]]), ['a.test.ts'], gold)).toBe(false);
    expect(hiddenPass(run([['a.test.ts', ok(5)]]), ['a.test.ts'], gold)).toBe(true);
  });
});

describe('regressionCandidates + gradeCase', () => {
  const gold = run([['h.test.ts', ok()], ['p.test.ts', ok()], ['env.test.ts', red]], false);

  it('names files green on gold and not green on the session tree, and excludes env-broken ones', () => {
    expect(regressionCandidates(['h.test.ts'], gold, run([['p.test.ts', red], ['env.test.ts', red]]))).toEqual({
      candidates: ['p.test.ts'], envBroken: ['env.test.ts'],
    });
    expect(regressionCandidates(['h.test.ts'], gold, run([]))).toEqual({ candidates: ['p.test.ts'], envBroken: ['env.test.ts'] });
    expect(regressionCandidates(['h.test.ts'], gold, run([['p.test.ts', ok()]])).candidates).toEqual([]);
  });

  it('treats an existing file passing FEWER assertions than on gold as a candidate — skip/delete cannot hide a break', () => {
    const g = run([['p.test.ts', ok(5)]]);
    expect(regressionCandidates([], g, run([['p.test.ts', { passed: 4, failed: 0, skipped: 1 }]])).candidates).toEqual(['p.test.ts']);
    expect(regressionCandidates([], g, run([['p.test.ts', ok(6)]])).candidates).toEqual([]);
  });

  it('confirms a regression only when both full runs show it', () => {
    const g = run([['p.test.ts', ok()]]);
    const broke = run([['p.test.ts', red]], false);
    expect(confirmedRegressions([], g, broke, run([['p.test.ts', ok()]])).regressed).toEqual([]);
    expect(confirmedRegressions([], g, broke, broke).regressed).toEqual(['p.test.ts']);
  });

  it('counts an unhandled error in both runs against a clean gold, and never against a dirty one', () => {
    const g = run([['p.test.ts', ok()]]);
    const unhandled = run([['p.test.ts', ok()]], false);
    expect(confirmedRegressions([], g, unhandled, unhandled).regressed).toEqual(['<unhandled error in the full suite>']);
    expect(confirmedRegressions([], run([['p.test.ts', ok()]], false), unhandled, unhandled).regressed).toEqual([]);
  });

  it('does not read success:false caused by a red HIDDEN file as an unhandled P2P error', () => {
    const g = run([['h.test.ts', ok()], ['p.test.ts', ok()]]);
    const hiddenRed = run([['h.test.ts', red], ['p.test.ts', ok()]], false);
    expect(confirmedRegressions(['h.test.ts'], g, hiddenRed, hiddenRed).regressed).toEqual([]);
  });

  it('mergeGoldRuns re-admits a gold file only when its rerun passes', () => {
    const first = run([['a.test.ts', red], ['b.test.ts', red]], false);
    const merged = mergeGoldRuns(first, run([['a.test.ts', ok()], ['b.test.ts', red]]));
    expect(filePasses(merged.files.get('a.test.ts'))).toBe(true);
    expect(filePasses(merged.files.get('b.test.ts'))).toBe(false);
  });

  it('resolves only when FAIL_TO_PASS holds and nothing regressed', () => {
    expect(gradeCase(true, [], ['env.test.ts']).resolved).toBe(true);
    expect(gradeCase(false, [], []).resolved).toBe(false);
    const g = gradeCase(true, ['p.test.ts'], []);
    expect(g.passToPass).toBe(false);
    expect(g.resolved).toBe(false);
  });
});

describe('summarizeTrials', () => {
  it('reports the rate with its standard error, and pass@k = rate at k=1 with no pass^k', () => {
    const s = summarizeTrials([[true], [true], [false], [true]]);
    expect(s.passRate).toBe(0.75);
    expect(s.standardError).toBeCloseTo(Math.sqrt(0.75 * 0.25 / 4));
    expect(s.passAtK).toBe(0.75);
    expect(s.passHatK).toBeNull();
  });

  it('separates pass@k from pass^k when k >= 2', () => {
    const s = summarizeTrials([[true, false], [true, true], [false, false]]);
    expect(s.passAtK).toBeCloseTo(2 / 3);
    expect(s.passHatK).toBeCloseTo(1 / 3);
    expect(s.passRate).toBeCloseTo(0.5);
  });

  it('refuses no cases and mismatched trial counts', () => {
    expect(() => summarizeTrials([])).toThrow(/no scored cases/);
    expect(() => summarizeTrials([[true], [true, false]])).toThrow(/same non-zero trial count/);
  });
});
