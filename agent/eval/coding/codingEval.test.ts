import { describe, it, expect, vi } from 'vitest';
import type { CodingCase } from './cases.js';
import {
  InstrumentFault, evaluateCoding, sessionDidNotRun, type CodingDeps, type CodingResult, type SessionOutcome,
} from './codingEval.js';
import type { VitestRun } from './grading.js';

const mk = (id: string): CodingCase => ({
  ticketId: id,
  pr: 1,
  commit: 'a'.repeat(40),
  base: 'b'.repeat(40),
  testFiles: ['h.test.ts'],
  bodySha256: 'c'.repeat(64),
  snapshot: '2026-09-16T21-55-49-752Z-e2cc7598.md',
});

const green = { passed: 3, failed: 0, skipped: 0 };
const redFile = { passed: 0, failed: 3, skipped: 0 };
const PASS: VitestRun = { files: new Map([['h.test.ts', green]]), success: true };
const FAIL: VitestRun = { files: new Map([['h.test.ts', redFile]]), success: false };
const GOLD_FULL: VitestRun = { files: new Map([['h.test.ts', green], ['p.test.ts', green]]), success: true };

const session = (o: Partial<SessionOutcome>): SessionOutcome => ({
  exitCode: 0, costUsd: 2, durationMs: 1, timedOut: false, isError: false, turns: 12, ...o,
});

interface Behaviour {
  contaminated?: boolean;
  basePasses?: boolean;
  goldFails?: boolean;
  sessionSolves?: boolean[];
}

// Fixture dirs are labels, so the stub can tell a base, a gold and a trial tree apart.
function stubDeps(behaviours: Record<string, Behaviour>, overrides: Partial<CodingDeps> = {}) {
  const trialCount = new Map<string, number>();
  const gold = new Set<string>();
  const recorded: CodingResult[] = [];
  const deps: CodingDeps = {
    checkEnvironment: vi.fn(() => Promise.resolve()),
    screen: vi.fn((c: CodingCase) => Promise.resolve(behaviours[c.ticketId].contaminated ? [{ needle: c.ticketId, path: 'memory/x.md' }] : [])),
    prepareFixture: vi.fn((c: CodingCase, label: string) => Promise.resolve(`${c.ticketId}/${label}`)),
    applyGold: vi.fn((dir: string) => { gold.add(dir); return Promise.resolve(); }),
    runHidden: vi.fn((dir: string, c: CodingCase) => {
      const b = behaviours[c.ticketId];
      if (dir.endsWith('control-base')) return Promise.resolve(b.basePasses ? PASS : FAIL);
      if (gold.has(dir)) return Promise.resolve(b.goldFails ? FAIL : PASS);
      const n = Number(/trial-(\d+)/.exec(dir)?.[1]);
      return Promise.resolve(b.sessionSolves?.[n - 1] ? PASS : FAIL);
    }),
    runFullSuite: vi.fn(() => Promise.resolve(GOLD_FULL)),
    runFiles: vi.fn(() => Promise.resolve(GOLD_FULL)),
    runSession: vi.fn((dir: string, c: CodingCase) => {
      trialCount.set(c.ticketId, (trialCount.get(c.ticketId) ?? 0) + 1);
      return Promise.resolve(session({ costUsd: 2, durationMs: 60000 }));
    }),
    gradeTree: vi.fn((dir: string) => Promise.resolve(`${dir}-graded`)),
    record: vi.fn((r: CodingResult) => { recorded.push(r); return Promise.resolve(); }),
    log: vi.fn(),
    ...overrides,
  };
  return { deps, trialCount, recorded };
}

function scored(r: CodingResult[]) {
  return r.filter((x) => x.status === 'scored').map((x) => x.ticketId);
}

describe('evaluateCoding — controls run before any session, and a failed control drops loudly', () => {
  it('scores clean cases and drops a contaminated, a base-passing and a gold-failing case', async () => {
    const { deps, trialCount } = stubDeps({
      'tkt-000000000001': { sessionSolves: [true] },
      'tkt-000000000002': { contaminated: true },
      'tkt-000000000003': { basePasses: true },
      'tkt-000000000004': { goldFails: true },
    });
    const report = await evaluateCoding(['1', '2', '3', '4'].map((n) => mk(`tkt-00000000000${n}`)), deps, { trials: 1 });

    expect(scored(report.results)).toEqual(['tkt-000000000001']);
    expect([...trialCount.keys()]).toEqual(['tkt-000000000001']);
    expect(report.metrics.dropped).toBe(3);
    expect(report.metrics.passRate).toBe(1);
    const logged = vi.mocked(deps.log).mock.calls.map((c) => c[0]).join('\n');
    expect(logged).toMatch(/DROPPED tkt-000000000002: contaminated/);
    expect(logged).toMatch(/DROPPED tkt-000000000003: BASE control failed/);
    expect(logged).toMatch(/DROPPED tkt-000000000004: GOLD control failed/);
    expect(report.lines.join('\n')).toMatch(/\[DROP\] tkt-000000000003/);
  });

  it('never scores a case whose base already passes, even if every trial would "solve" it', async () => {
    const { deps } = stubDeps({
      'tkt-000000000001': { sessionSolves: [true] },
      'tkt-000000000003': { basePasses: true, sessionSolves: [true] },
    });
    const report = await evaluateCoding([mk('tkt-000000000001'), mk('tkt-000000000003')], deps, { trials: 1 });
    expect(scored(report.results)).toEqual(['tkt-000000000001']);
    expect(report.metrics.scored).toBe(1);
  });

  it('aborts, spending nothing, when every case fails its controls', async () => {
    const { deps } = stubDeps({ 'tkt-000000000003': { basePasses: true } });
    await expect(evaluateCoding([mk('tkt-000000000003')], deps, { trials: 1 })).rejects.toThrow(/all 1 case\(s\) failed their controls/);
    expect(deps.runSession).not.toHaveBeenCalled();
  });

  it('aborts before any control when the environment check throws', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': {} }, {
      checkEnvironment: () => Promise.reject(new Error('claude CLI unreachable')),
    });
    await expect(evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 })).rejects.toThrow(/unreachable/);
    expect(deps.prepareFixture).not.toHaveBeenCalled();
  });
});

describe('evaluateCoding — a session that never ran is not a model failure', () => {
  it.each([
    ['a non-zero exit with no result line', session({ exitCode: 1, costUsd: null }), true],
    ['an error result after at most one turn (auth, 429)', session({ exitCode: 1, costUsd: 0, isError: true, turns: 1 }), true],
    ['an error result after real work (budget exhausted)', session({ exitCode: 1, costUsd: 20, isError: true, turns: 40 }), false],
    ['a session killed at the time cap', session({ exitCode: -1, costUsd: null, timedOut: true }), false],
    ['a clean exit with no result line', session({ costUsd: null }), false],
    ['a normal run', session({}), false],
  ])('never-ran: %s → %s', (_label, s, expected) => {
    expect(sessionDidNotRun(s)).toBe(expected);
  });

  it('aborts instead of scoring, keeping the cases already recorded', async () => {
    let calls = 0;
    const { deps, recorded } = stubDeps({
      'tkt-000000000001': { sessionSolves: [true] },
      'tkt-000000000002': { sessionSolves: [true] },
    }, {
      runSession: () => Promise.resolve(++calls === 1 ? session({}) : session({ exitCode: 1, costUsd: null })),
    });
    await expect(evaluateCoding([mk('tkt-000000000001'), mk('tkt-000000000002')], deps, { trials: 1 }))
      .rejects.toThrow(/never ran/);
    expect(recorded.map((r) => r.ticketId)).toEqual(['tkt-000000000001']);
  });

  it('records a case\'s finished trials before aborting on a later one', async () => {
    let calls = 0;
    const { deps, recorded } = stubDeps({ 'tkt-000000000001': { sessionSolves: [true, true] } }, {
      runSession: () => Promise.resolve(++calls === 1 ? session({}) : session({ exitCode: 1, costUsd: null })),
    });
    await expect(evaluateCoding([mk('tkt-000000000001')], deps, { trials: 2 })).rejects.toThrow(/never ran/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].status === 'scored' && recorded[0].trials.length).toBe(1);
  });

  it('grades a timed-out session instead of aborting', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [false] } }, {
      runSession: () => Promise.resolve(session({ exitCode: -1, costUsd: null, timedOut: true })),
    });
    expect((await evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 })).metrics.scored).toBe(1);
  });
});

describe('evaluateCoding — trials and grading', () => {
  it('runs k trials each on a fresh fixture and reports pass^k beside pass@k', async () => {
    const { deps, trialCount } = stubDeps({
      'tkt-000000000001': { sessionSolves: [true, true] },
      'tkt-000000000002': { sessionSolves: [true, false] },
    });
    const report = await evaluateCoding([mk('tkt-000000000001'), mk('tkt-000000000002')], deps, { trials: 2 });
    expect(trialCount.get('tkt-000000000001')).toBe(2);
    expect(report.metrics.passAtK).toBe(1);
    expect(report.metrics.passHatK).toBe(0.5);
    expect(report.metrics.passRate).toBe(0.75);
    expect(report.metrics.costUsdFloor).toBe(8);
    const fixtures = vi.mocked(deps.prepareFixture).mock.calls.map((c) => c[1]);
    expect(fixtures.filter((l) => l.startsWith('trial-'))).toEqual(['trial-1', 'trial-2', 'trial-1', 'trial-2']);
  });

  it('grades the fresh tree gradeTree returns, not the session\'s own', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] } });
    await evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 });
    expect(deps.gradeTree).toHaveBeenCalledWith('tkt-000000000001/trial-1', expect.objectContaining({ ticketId: 'tkt-000000000001' }), 'trial-1');
    expect(vi.mocked(deps.runHidden).mock.calls.map((c) => c[0])).toContain('tkt-000000000001/trial-1-graded');
  });

  it('scores a tree that breaks grading as a FAIL with its error, instead of aborting the run', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] }, 'tkt-000000000002': { sessionSolves: [true] } }, {
      runFullSuite: (dir: string) => (dir.startsWith('tkt-000000000001/trial')
        ? Promise.reject(new Error('vitest wrote no report\ndetail'))
        : Promise.resolve(GOLD_FULL)),
    });
    const report = await evaluateCoding([mk('tkt-000000000001'), mk('tkt-000000000002')], deps, { trials: 1 });
    expect(report.metrics.passRate).toBe(0.5);
    expect(report.lines.join('\n')).toMatch(/\[ERR \] tkt-000000000001 .*vitest wrote no report/);
  });

  it('aborts on an instrument fault during grading instead of scoring it as the model\'s FAIL', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] } }, {
      runFullSuite: (dir: string) => (dir.includes('trial')
        ? Promise.reject(new InstrumentFault('no test slot'))
        : Promise.resolve(GOLD_FULL)),
    });
    await expect(evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 })).rejects.toThrow(/no test slot/);
  });

  it('counts a regression only when a second FULL run confirms it', async () => {
    const regressed: VitestRun = { files: new Map([['h.test.ts', green], ['p.test.ts', redFile]]), success: false };
    let fullRuns = 0;
    const flaky = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] } }, {
      runFullSuite: (dir: string) => Promise.resolve(dir.includes('trial') && ++fullRuns === 1 ? regressed : GOLD_FULL),
    });
    expect((await evaluateCoding([mk('tkt-000000000001')], flaky.deps, { trials: 1 })).metrics.passRate).toBe(1);
    expect(fullRuns).toBe(2);

    const real = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] } }, {
      runFullSuite: (dir: string) => Promise.resolve(dir.includes('trial') ? regressed : GOLD_FULL),
    });
    const report = await evaluateCoding([mk('tkt-000000000001')], real.deps, { trials: 1 });
    expect(report.metrics.passRate).toBe(0);
    expect(report.lines.join('\n')).toMatch(/\[P2P \] tkt-000000000001 .*p\.test\.ts/);
  });

  it('reruns gold\'s red files so one load-sensitive timeout does not exempt a file from every trial', async () => {
    const goldFlaky: VitestRun = { files: new Map([['h.test.ts', green], ['p.test.ts', redFile]]), success: false };
    const trialBroke: VitestRun = { files: new Map([['h.test.ts', green], ['p.test.ts', redFile]]), success: false };
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [true] } }, {
      runFullSuite: (dir: string) => Promise.resolve(dir.includes('trial') ? trialBroke : goldFlaky),
      runFiles: vi.fn(() => Promise.resolve({ files: new Map([['p.test.ts', green]]), success: true })),
    });
    const report = await evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 });
    expect(deps.runFiles).toHaveBeenCalledWith('tkt-000000000001/control-gold', ['p.test.ts']);
    expect(report.metrics.passRate).toBe(0);
  });

  it('prints the standard error beside the rate, and reports unreported cost as a floor in lines AND metrics', async () => {
    const { deps } = stubDeps({ 'tkt-000000000001': { sessionSolves: [false] } }, {
      runSession: () => Promise.resolve(session({ costUsd: null, durationMs: 1000 })),
    });
    const report = await evaluateCoding([mk('tkt-000000000001')], deps, { trials: 1 });
    const text = report.lines.join('\n');
    expect(text).toMatch(/pass rate 0\.0% ± 0\.0 pts \(1 SE, n=1, k=1\)/);
    expect(text).toMatch(/a FLOOR: 1 session\(s\) reported no cost/);
    expect(report.metrics.unreportedCostSessions).toBe(1);
    expect(text).toMatch(/Residual, not screened/);
    expect(text).toMatch(/whether each hidden test is specified by its ticket body/);
    expect(text).toMatch(/Not comparable with the night-run `level`/);
  });

  it('rejects a non-positive trial count', () => {
    const { deps } = stubDeps({});
    expect(() => evaluateCoding([mk('tkt-000000000001')], deps, { trials: 0 })).toThrow(/trials/);
  });
});
