// tkt-4f8d07e0810d — one case per dimension of the adversary list on the ticket, plus one per
// finding from the high-effort review that swept the dimensions the first draft missed.
//
// The guarantee under test: an unattended queue never continues past a state that needs a human, and
// never leaves the sentinel behind. Every stopping case is paired with a continuing control, because
// a runner that stops on everything is as useless as one that stops on nothing.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync, openSync, closeSync,
  chmodSync, lstatSync,
} from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classify, gateFailed, hookRejected, decodeLog, strandedBackgroundTasks,
  describe as describeResult, readStatus, guardBlocked,
  arm, disarm, claimSentinel, readClaims, claimHeld, claimPath, othersLive, noteClaim, readClaimNote,
  pidAlive, runAlive, fileHere, sentinelPaths,
  preflightGuard, main, run, sessionArgs, sessionEnv, defaultRunSession, capMsFrom, USAGE, EXIT,
  MERGE_PROBE_PAYLOAD, renderProbes, createRunWorktree, removeRunWorktree, runWorktreePath,
  parkedWork, repoForProject, readProject,
} from './night-run.mjs';
import { nightRunActive } from '../.claude/hooks/guard-unattended-merge.mjs';

let board;
beforeEach(() => {
  board = mkdtempSync(join(tmpdir(), 'night-run-'));
  mkdirSync(join(board, 'tickets'), { recursive: true });
});
afterEach(() => rmSync(board, { recursive: true, force: true }));

const seed = (id, status) =>
  writeFileSync(join(board, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\nbody\n`);

const A = 'tkt-00000000000a';
const B = 'tkt-00000000000b';
const C = 'tkt-00000000000c';

// A pre-flight that passes: BLOCKED while armed, then exit 0 while disarmed.
const passingProbe = () => {
  let call = 0;
  return () => Promise.resolve(call++ === 0
    ? { code: 0, out: 'BLOCKED', capped: false }
    : { code: 0, out: '', capped: false });
};

// Records which tickets were actually driven, and applies each one's outcome to the board so the
// classifier reads a real transition rather than a stubbed verdict.
const sessionStub = (outcomes = {}) => {
  const fn = (id) => {
    fn.calls.push(id);
    const o = outcomes[id] ?? { status: 'qa' };
    if (o.status) seed(id, o.status);
    if (o.thenStop) writeFileSync(sentinelPaths(board).stop, '');
    return Promise.resolve({ code: o.code ?? 0, out: o.log ?? '', capped: o.capped ?? false });
  };
  fn.calls = [];
  return fn;
};

// The run's worktree needs a git repository with an `origin`, which a temp board is not; the real
// thing is exercised against real git in its own describe below. The stub still makes a directory,
// so the `cwd` handed to each session is a path that exists.
const fakeWorktree = (root, stamp) => {
  const path = join(root, 'wt', stamp);
  mkdirSync(path, { recursive: true });
  return { ok: true, path, provisioned: [] };
};

// main() resolves the sentinel root through the guard; tests point it at the temp board.
const opts = (extra = {}) => ({
  resolveSentinelRoot: () => board,
  env: {},
  createWorktree: fakeWorktree,
  removeWorktree: () => ({ removed: true }),
  ...extra,
});

const captureStdout = async (fn) => {
  const orig = process.stdout.write.bind(process.stdout);
  let buf = '';
  process.stdout.write = (chunk) => { buf += chunk; return true; };
  try { await fn(); } finally { process.stdout.write = orig; }
  return buf;
};

const latestSummary = () => {
  const dir = join(board, '.night-run');
  const stampDir = readdirSync(dir).filter((n) => /^\d{4}-/.test(n)).sort().at(-1);
  return JSON.parse(readFileSync(join(dir, stampDir, 'summary.json'), 'utf8'));
};

// tkt-c0dfe86b6856 — a named budget, because a bare 5s literal made this a contention detector: the
// child must spawn, import night-run.mjs and clear its pre-flight before it can park, and a starved
// child misses that deadline while behaving correctly. Widening costs nothing on the passing path —
// the poll returns the moment the marker lands — and weakens no control, since a child that never
// parks still fails, only later. Same trade as the testTimeout comment in vitest.config.ts.
// Both bounds are enforced, not merely documented. Below the floor the window is back to what
// contention trips; above the ceiling vitest's own testTimeout pre-empts the wait, so it dies as an
// unreadable "Test timed out" before it can report which family the failure was — the ceiling test
// below pins that against the real config rather than a transcribed number.
const PARK_BUDGET_FLOOR_MS = 5_000;
const PARK_BUDGET_CEILING_MS = 15_000;
const parkBudgetFrom = (raw) => {
  if (raw === undefined || raw === '') return 12_000;
  const n = Number(raw);
  // Throws rather than defaulting: `Number(raw) || 12_000` would swallow a typo and silently restore
  // a window nobody chose — the same false negative, reintroduced through the escape hatch. The
  // range is part of that: a sub-millisecond value is "positive" yet drains every child instantly,
  // and an over-large one is accepted here only to fail later as a timeout.
  if (!Number.isFinite(n) || n <= PARK_BUDGET_FLOOR_MS || n > PARK_BUDGET_CEILING_MS) {
    throw new Error(
      `NIGHT_RUN_TEST_PARK_MS must be a number of ms in (${PARK_BUDGET_FLOOR_MS}, ${PARK_BUDGET_CEILING_MS}], got ${JSON.stringify(raw)}. `
      + 'Below the floor, machine contention trips it; above the ceiling, the suite testTimeout pre-empts '
      + 'the wait before it can report why it failed. Raising the ceiling means raising testTimeout too.',
    );
  }
  return n;
};
const PARK_BUDGET_MS = parkBudgetFrom(process.env.NIGHT_RUN_TEST_PARK_MS);

// Polls rather than sleeping a fixed interval: the child has to spawn, import and clear its
// pre-flight before it arms, and a fixed wait would be either flaky or slow.
const waitFor = async (pred, timeoutMs = PARK_BUDGET_MS) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};

// Reports WHICH family a red is, which is the whole reason this is not a bare boolean: a runner that
// never parks and a machine too busy to let it park are otherwise indistinguishable — both just run
// out the clock. An exited child can never write the marker, so that verdict is definitive and ends
// the wait immediately rather than spending the budget to reach the same answer.
const waitForPark = async (pred, child, budgetMs = PARK_BUDGET_MS) => {
  const started = Date.now();
  let closed = false;
  child.once('close', () => { closed = true; });
  // exitCode/signalCode cover a child that died before this listener was attached; 'close' never
  // re-fires for it.
  const gone = () => closed || child.exitCode !== null || child.signalCode !== null;
  for (;;) {
    const elapsedMs = Date.now() - started;
    // Tested before the exit check, so a child that parks and then exits still counts as parked.
    if (pred()) return { parked: true, reason: 'parked', elapsedMs };
    if (gone()) return { parked: false, reason: 'the child exited without ever writing its parked marker', elapsedMs };
    if (elapsedMs >= budgetMs) {
      return { parked: false, reason: `no parked marker within ${budgetMs}ms and the child is still alive — a hang, or a machine too contended to let it park`, elapsedMs };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
};

// One driver template for every subprocess case — they exist because the handlers under test end
// with process.exit. runSession arrives as source so each case can say how the session dies.
const here = dirname(fileURLToPath(import.meta.url));
const driverFor = (name, runSessionSrc) => {
  const driver = join(board, name);
  writeFileSync(driver, `
    import { main } from ${JSON.stringify(join(here, 'night-run.mjs'))};
    import { writeFileSync } from 'node:fs';
    let c = 0;
    const spawnProbe = () => Promise.resolve(c++ === 0 ? { code: 0, out: 'BLOCKED' } : { code: 0, out: '' });
    const runSession = ${runSessionSrc};
    main([${JSON.stringify(A)}], ${JSON.stringify(board)}, {
      spawnProbe, runSession, env: {}, resolveSentinelRoot: () => ${JSON.stringify(board)},
      createWorktree: (root) => ({ ok: true, path: root + '/wt', provisioned: [] }),
      removeWorktree: () => { writeFileSync(${JSON.stringify(join(board, 'worktree-removed'))}, ''); return { removed: true }; },
    });
  `);
  return driver;
};

// Spawns a runner and resolves once its session is parked mid-ticket. "Parked" is a marker the
// session writes itself, never the sentinel: arming precedes the loop's STOP check, so a STOP
// written on "armed" is consumed on the normal path and the signal lands on a finished run.
// The hold timer is load-bearing: a bare pending promise holds nothing on the loop, and the child drains.
// It tracks the park budget rather than sitting at its own 5s: a child that parks late under
// contention would otherwise drain while the caller is still asserting against it, trading one flake
// for another. Every caller SIGKILLs in a finally, so a longer hold costs no wall clock.
const spawnParked = async (name, { stdout = 'ignore', prelude = '', hold = `setTimeout(() => {}, ${PARK_BUDGET_MS});` } = {}) => {
  const parked = join(board, 'parked');
  const driver = driverFor(name, `() => new Promise(() => {
    ${prelude}
    writeFileSync(${JSON.stringify(parked)}, '');
    ${hold}
  })`);
  seed(A, 'todo');
  const child = spawn(process.execPath, [driver], { stdio: ['ignore', stdout, 'ignore'] });
  const exited = new Promise((resolve) => child.on('close', resolve));
  const { parked: isParked, reason, elapsedMs } = await waitForPark(() => existsSync(parked), child);
  if (!isParked) {
    child.kill('SIGKILL');
    await exited;
  }
  // control: genuinely mid-ticket. The message names the family, so a red here is readable without
  // re-running on a quiet machine.
  expect(isParked, `${reason} (after ${elapsedMs}ms)`).toBe(true);
  return { ...sentinelPaths(board), child, exited };
};

// tkt-c0dfe86b6856 — tests of the harness itself. The park window decides whether a red here means
// "the runner is broken" or "the machine was busy", and a window that cannot tell those apart makes
// every red in this file unreadable.
describe('the park window — whether a red in this file can be believed', () => {
  it('detects a park that lands inside the budget', async () => {
    let parked = false;
    const t = setTimeout(() => { parked = true; }, 120);
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const r = await waitForPark(() => parked, child, 4000);
      expect(r.parked).toBe(true);
    } finally { clearTimeout(t); child.kill('SIGKILL'); }
  });

  // The discrimination the ticket asks for: an exited child will NEVER write the marker, so this is
  // a definitive negative and must not be spent waiting out the budget. Without the early exit the
  // two families are indistinguishable — both just run out the clock.
  it('calls an exited child a definitive never-parks, without burning the budget', async () => {
    const budgetMs = 10_000;
    const child = spawn(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'ignore' });
    const r = await waitForPark(() => false, child, budgetMs);
    expect(r.parked).toBe(false);
    expect(r.reason).toMatch(/exited/i);
    // Derived from the budget, never a bare literal: a hardcoded wall-clock threshold here would be
    // the very shape this ticket removes, in the suite whose config records 26-32 contention
    // timeouts at four-way parallelism.
    expect(r.elapsedMs).toBeLessThan(budgetMs / 2);
  });

  // The load-bearing line in the poll: `pred()` is tested BEFORE the exit check, so a child that
  // parks and then dies is still parked. Inverting those two lines passed 274/274 before this case
  // existed — a green mutation, so the guarantee was carried by a comment and nothing else. The
  // crash.mjs consumer is exactly this shape: it writes the marker, then throws 150ms later.
  it('counts a child that parks and then exits as parked, not as a never-parks', async () => {
    const marker = join(board, 'park-then-exit');
    const child = spawn(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, ''); process.exit(0);`],
      { stdio: 'ignore' },
    );
    await new Promise((r) => child.once('close', r)); // the child is definitively gone...
    expect(existsSync(marker)).toBe(true); // control: ...and it really did park before dying
    const r = await waitForPark(() => existsSync(marker), child, 1000);
    expect(r.parked).toBe(true);
  });

  it('reports a live child that never parked as a hang-or-contention red, naming the budget', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      const r = await waitForPark(() => false, child, 200);
      expect(r.parked).toBe(false);
      expect(r.reason).toMatch(/200ms/);
      expect(r.reason).toMatch(/still alive/i);
    } finally { child.kill('SIGKILL'); }
  });

  // Named for the EFFECTIVE budget, not the default: with the env var set this is a statement about
  // the override, so the message has to name it or a mistyped export points the operator at a
  // constant they never touched. The default is covered on its own below.
  it('runs on an effective budget clear of the window contention trips', () => {
    const override = process.env.NIGHT_RUN_TEST_PARK_MS ?? 'unset';
    expect(PARK_BUDGET_MS, `effective park budget (NIGHT_RUN_TEST_PARK_MS=${override})`)
      .toBeGreaterThan(PARK_BUDGET_FLOOR_MS);
  });

  // The ceiling is the bound easily lost, and `<` does not express it: a budget 1ms under the
  // timeout is legal by that test and still cannot print anything, because vitest pre-empts the wait
  // before the assertion runs — the unreadable "Test timed out" this ticket set out to remove. So
  // the whole LEGAL RANGE, not just today's value, must clear the timeout with room to spare, read
  // off the config rather than transcribed so raising one without the other cannot pass.
  it('keeps the whole legal budget range inside the suite timeout, with room to report', async () => {
    const { default: vitestConfig } = await import('../vitest.config.js');
    const subproc = vitestConfig.test.projects.find((p) => p.test.name === 'subproc');
    expect(subproc.test.testTimeout).toBeGreaterThan(0); // control: the timeout is actually set here
    expect(PARK_BUDGET_CEILING_MS * 1.25).toBeLessThanOrEqual(subproc.test.testTimeout);
    expect(PARK_BUDGET_MS).toBeLessThanOrEqual(PARK_BUDGET_CEILING_MS);
  });

  // A `Number(raw) || DEFAULT` override would swallow a typo and silently restore a short window —
  // the same false negative this ticket removes, reintroduced through the escape hatch. The range
  // matters as much as the type: `0.5` is a positive number of ms that drains every child instantly,
  // and an over-large value is accepted only to die later as a timeout.
  it('refuses a malformed or out-of-range budget override rather than silently falling back', () => {
    expect(parkBudgetFrom(undefined)).toBeGreaterThan(PARK_BUDGET_FLOOR_MS);
    expect(parkBudgetFrom(undefined)).toBeLessThanOrEqual(PARK_BUDGET_CEILING_MS);
    expect(parkBudgetFrom('14000')).toBe(14000);
    expect(() => parkBudgetFrom('nonsense')).toThrow(/NIGHT_RUN_TEST_PARK_MS/);
    expect(() => parkBudgetFrom('0')).toThrow(/NIGHT_RUN_TEST_PARK_MS/);
    expect(() => parkBudgetFrom('-1')).toThrow(/NIGHT_RUN_TEST_PARK_MS/);
    expect(() => parkBudgetFrom('0.5')).toThrow(/NIGHT_RUN_TEST_PARK_MS/); // drains every child
    expect(() => parkBudgetFrom('45000')).toThrow(/testTimeout/); // silently un-reportable
  });
});

describe('classify — dimension 1: the status transition', () => {
  it('todo → qa is the intended outcome and continues', () => {
    const r = classify({ before: 'todo', after: 'qa' });
    expect(r.level).toBe('ok');
    expect(r.stop).toBe(false);
  });

  // The row missing from the first draft of the design, and the one that matters most: under this
  // design a done ticket means the merge gate was crossed unattended.
  it('→ done is an ALARM and stops the night', () => {
    const r = classify({ before: 'todo', after: 'done' });
    expect(r.level).toBe('alarm');
    expect(r.stop).toBe(true);
    expect(r.text).toMatch(/merge gate was crossed/i);
  });

  it('→ in-progress stops the queue', () => {
    expect(classify({ before: 'todo', after: 'in-progress' }).stop).toBe(true);
  });

  // The control for "stops the queue": a failed premise is a normal outcome and must NOT stop it.
  it('→ backlog continues, because a failed premise is routine', () => {
    const r = classify({ before: 'todo', after: 'backlog' });
    expect(r.level).toBe('skip');
    expect(r.stop).toBe(false);
  });

  it('an unchanged status reads as never started, not as success', () => {
    const r = classify({ before: 'todo', after: 'todo' });
    expect(r.level).not.toBe('ok');
    expect(r.stop).toBe(false);
  });

  it('an unreadable status stops rather than assuming success', () => {
    const r = classify({ before: 'todo', after: null });
    expect(r.level).toBe('note');
    expect(r.stop).toBe(true);
  });

  // A ticket already in qa would score as success on an absolute reading, without the run having
  // done anything — which is why the classifier takes a transition.
  it('qa → qa is NOT reported as a fresh success', () => {
    expect(classify({ before: 'qa', after: 'qa' }).level).not.toBe('ok');
  });

  // With before=null the equality test above is false, so the transition check collapsed back into
  // the absolute reading and a ticket already in qa scored a fresh success (review, MEDIUM).
  it('an unreadable BEFORE cannot prove a transition, so qa is not a success', () => {
    const r = classify({ before: null, after: 'qa' });
    expect(r.level).not.toBe('ok');
    expect(r.stop).toBe(true);
  });
});

describe('classify — dimension 2: how the run exited', () => {
  // The defect: a cap firing while the session wrote its handoff dropped the six tickets still
  // queued behind it, even though the PR was open and the ticket had reached `qa`
  // (tkt-4fc11782b77b, measured on tkt-92360b0e2079).
  it('a cap after the ticket reached qa does not stop the queue', () => {
    const r = classify({ before: 'todo', after: 'qa', capped: true });
    expect(r.stop).toBe(false);
    expect(r.level).toBe('capped-after-qa');
  });

  // Kept from the test this replaced: continuing the queue must not promote the run to a success,
  // because the cap still truncated whatever the session was doing after the PR.
  it('a capped run is never reported as a fresh success', () => {
    expect(classify({ before: 'todo', after: 'qa', capped: true }).level).not.toBe('ok');
  });

  // The controls, one per dimension the carve-out above must NOT widen into. A cap landing before
  // `qa` really is mid-ticket, and a `qa` whose transition cannot be PROVEN must not buy a continue
  // merely because the status happens to read `qa`.
  it.each([
    ['mid-ticket', { before: 'todo', after: 'in-progress' }],
    ['having moved nothing', { before: 'todo', after: 'todo' }],
    ['on a ticket already in qa, so no transition is proven', { before: 'qa', after: 'qa' }],
    ['on a qa with an unreadable before', { before: null, after: 'qa' }],
    ['with an unreadable after', { before: 'todo', after: null }],
    ['on a ticket that reached done', { before: 'todo', after: 'done' }],
  ])('a cap %s stops the queue', (_what, statuses) => {
    const r = classify({ ...statuses, capped: true });
    expect(r.stop).toBe(true);
    expect(r.level).not.toBe('capped-after-qa');
  });

  // The row above passes on `stop` alone even when the cap SWALLOWS the alarm, which is exactly how
  // the defect hid: `isAlarm` is the only thing that rescues a done ticket from `isOutstanding`, so
  // a capped level here erases an unattended merge from the morning report entirely.
  it('a cap does not swallow the alarm when the merge gate was crossed', () => {
    expect(classify({ before: 'todo', after: 'done', capped: true }).level).toBe('alarm');
  });

  // The carve-out's OTHER side: these continue, and nothing recorded that until now. An orphan
  // resumed from `in-progress` that reaches qa is as complete as a fresh todo → qa.
  it('a cap after an in-progress orphan reached qa also continues', () => {
    const r = classify({ before: 'in-progress', after: 'qa', capped: true });
    expect(r.stop).toBe(false);
    expect(r.level).toBe('capped-after-qa');
  });
});

// tkt-c43474b393de. `halt` merged "died mid-edit" with "finished, awaiting one human command", and
// the second stopped the 09-12 queue before its remaining two tickets. The guarantee here: the queue
// continues past an `in-progress` ticket ONLY on positive evidence its work is committed.
describe('classify — dimension 3: evidence the halted work is safe', () => {
  it('a halt with committed work parks instead of stopping the queue', () => {
    const r = classify({ before: 'todo', after: 'in-progress', committed: true });
    expect(r.level).toBe('parked');
    expect(r.stop).toBe(false);
    expect(r.text).toMatch(/unpushed/);
  });

  // The control that gives the row above its meaning, and the state the default must hold: absent
  // evidence, an in-progress ticket is the abandoned case and still stops.
  it.each([
    ['evidence is absent', { committed: false }],
    ['the argument is omitted entirely', {}],
  ])('a halt stops when %s', (_what, evidence) => {
    const r = classify({ before: 'todo', after: 'in-progress', ...evidence });
    expect(r.level).toBe('halt');
    expect(r.stop).toBe(true);
  });

  // `parkedWork` reports "could not determine" as `committed: false`, so there is no third value to
  // mishandle — but a non-boolean reaching here must not be coerced into a continue by a truthy
  // test. This is the fail-closed direction the whole carve-out rests on.
  it.each([
    ['a reason string', 'no branch names this ticket'],
    ['a truthy object', {}],
    ['null', null],
    ['undefined', undefined],
  ])('a halt stops when the evidence is %s rather than true', (_what, committed) => {
    const r = classify({ before: 'todo', after: 'in-progress', committed });
    expect(r.stop).toBe(true);
    expect(r.level).not.toBe('parked');
  });

  // One control per dimension the carve-out must NOT widen into. A cap means the session was cut off
  // rather than ending on its own, so a commit proves the work is safe but not that it is finished;
  // and every non-halt transition already decides itself.
  it.each([
    ['a capped run', { before: 'todo', after: 'in-progress', capped: true }],
    ['a ticket that reached done', { before: 'todo', after: 'done' }],
    ['an unreadable after', { before: 'todo', after: null }],
    ['an unreadable before', { before: null, after: 'in-progress' }],
    ['a ticket that never moved', { before: 'todo', after: 'todo' }],
    ['an unexpected status', { before: 'todo', after: 'sideways' }],
  ])('committed work does not park %s', (_what, statuses) => {
    expect(classify({ ...statuses, committed: true }).level).not.toBe('parked');
  });

  // The two that must keep their own verdict rather than merely "not park": an alarm is the most
  // urgent line the morning report can carry, and a qa is a real success.
  it('committed work never swallows the alarm', () => {
    expect(classify({ before: 'todo', after: 'done', committed: true }).level).toBe('alarm');
  });

  it('committed work does not demote a ticket that actually reached qa', () => {
    const r = classify({ before: 'todo', after: 'qa', committed: true });
    expect(r.level).toBe('ok');
    expect(r.stop).toBe(false);
  });

  // A capped halt keeps the cap's own wording: reporting it as `halt` would lose the reason the
  // session stopped, which is what `describe` hangs the gate/hook diagnosis off.
  it('a capped halt is still reported as capped, not parked', () => {
    const r = classify({ before: 'todo', after: 'in-progress', capped: true, committed: true });
    expect(r.level).toBe('capped');
    expect(r.stop).toBe(true);
  });
});

describe('parkedWork — what counts as evidence the work survives', () => {
  // `code`/`out` mirrors defaultGit's shape. Each call is recorded so a test can assert WHICH git
  // question was asked, not merely what came back.
  const gitStub = (replies) => {
    const fn = (cwd, args) => {
      fn.calls.push({ cwd, args });
      const reply = replies.shift();
      return reply ?? { code: 1, out: 'unexpected extra git call' };
    };
    fn.calls = [];
    return fn;
  };

  // Epoch seconds. FRESH is a tip committed at/after the session started; STALE is a tip from a
  // previous night, which is what the squash-merge case leaves behind.
  const NOW = 1_700_000_000;
  const FRESH = `${NOW + 30}\n`;
  const STALE = `${NOW - 86_400}\n`;

  it('a branch naming the ticket with a commit beyond origin/main is committed work', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-thing\n` }, { code: 0, out: '3\n' }, { code: 0, out: FRESH }]);
    const r = parkedWork({ id: A, repoRoot: '/repos/portfolio-site', since: NOW, git });
    expect(r.committed).toBe(true);
    expect(r.branch).toBe(`feat/${A}-thing`);
    expect(r.repo).toBe('/repos/portfolio-site');
  });

  // The foreign-mode row, and the reason the resolver exists at all: BOTH incidents on this ticket
  // committed into another repo, so the question must be asked there and not in the run's worktree.
  it('asks git in the repo it was given, not in the process cwd', () => {
    const git = gitStub([{ code: 0, out: `task/${A}-x\n` }, { code: 0, out: '1\n' }, { code: 0, out: FRESH }]);
    parkedWork({ id: A, repoRoot: '/repos/hardpack-site', since: NOW, git });
    expect(git.calls.every((c) => c.cwd === '/repos/hardpack-site')).toBe(true);
    expect(git.calls[0].args).toContain('--format=%(refname:short)');
    expect(git.calls[1].args).toContain(`origin/main..task/${A}-x`);
  });

  // THE SQUASH-MERGE HOLE (review, medium-high — measured in a throwaway repo: a branch 1 ahead
  // before a squash merge is still 1 ahead after it). Without the freshness bound, a ticket
  // re-queued after its earlier branch merged parks on that dead branch even though tonight's
  // session committed nothing, and the report announces work that already shipped.
  it('a branch whose tip predates this run is NOT committed work, however far ahead it is', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-merged\n` }, { code: 0, out: '9\n' }, { code: 0, out: STALE }]);
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git });
    expect(r.committed).toBe(false);
    expect(r.why).toMatch(/predates? this run/);
  });

  it('prefers a freshly committed branch over a stale one that is also ahead', () => {
    const git = gitStub([
      { code: 0, out: `feat/${A}-old\nfeat/${A}-tonight\n` },
      { code: 0, out: '4\n' }, { code: 0, out: STALE },
      { code: 0, out: '1\n' }, { code: 0, out: FRESH },
    ]);
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git });
    expect(r.committed).toBe(true);
    expect(r.branch).toBe(`feat/${A}-tonight`);
  });

  // A tip exactly at the session start is this run's: the boundary must not exclude it.
  it('accepts a tip committed at the very moment the session started', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-x\n` }, { code: 0, out: '1\n' }, { code: 0, out: `${NOW}\n` }]);
    expect(parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git }).committed).toBe(true);
  });

  it('an unknown run start is NOT committed work', () => {
    const git = gitStub([]);
    expect(parkedWork({ id: A, repoRoot: '/repos/x', since: undefined, git }).committed).toBe(false);
    expect(git.calls, 'it asked git anyway').toEqual([]);
  });

  it('an unreadable tip date is NOT committed work', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-x\n` }, { code: 0, out: '1\n' }, { code: 128, out: 'bad object' }]);
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git });
    expect(r.committed).toBe(false);
    expect(r.why).toMatch(/tip date/);
  });

  // The abandoned case this whole distinction exists to keep stopping: tkt-6233ae50f62a, killed
  // mid-`npm test` with nothing committed.
  it('no branch naming the ticket is NOT committed work', () => {
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git: gitStub([{ code: 0, out: '\n' }]) });
    expect(r.committed).toBe(false);
    expect(r.why).toMatch(/no branch/);
  });

  // A rebased/ff-merged branch really is level with origin/main and leaves nothing unpushed.
  it('a branch carrying no commit beyond origin/main is NOT committed work', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-old\n` }, { code: 0, out: '0\n' }]);
    expect(parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git }).committed).toBe(false);
  });

  it('finds the live branch when a merged one is listed first', () => {
    const git = gitStub([
      { code: 0, out: `feat/${A}-old\nfeat/${A}-new\n` },
      { code: 0, out: '0\n' },
      { code: 0, out: '2\n' },
      { code: 0, out: FRESH },
    ]);
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git });
    expect(r.committed).toBe(true);
    expect(r.branch).toBe(`feat/${A}-new`);
  });

  // "Can't check" must never return the permissive answer. A repo with no `origin/main` — two mapped
  // targets have no remote at all — lands here, and must not walk on and report the ticket abandoned
  // on the strength of a range git refused to resolve.
  it.each([
    ['the repo is unresolvable', { repoRoot: null, replies: [] }],
    ['the branch list fails', { repoRoot: '/repos/x', replies: [{ code: 128, out: 'not a git repository' }] }],
    ['origin/main cannot be resolved', {
      repoRoot: '/repos/x',
      replies: [{ code: 0, out: `feat/${A}-y\n` }, { code: 128, out: "unknown revision 'origin/main'" }],
    }],
  ])('undetermined is NOT committed work: %s', (_what, { repoRoot, replies }) => {
    const r = parkedWork({ id: A, repoRoot, since: NOW, git: gitStub(replies) });
    expect(r.committed).toBe(false);
    expect(r.why).toBeTruthy();
  });

  // `defaultGit` folds stderr into `out`, so a git warning makes the count unparseable. It must fail
  // closed AND say so: reporting the determined negative "carries no commit beyond origin/main"
  // asserts a fact never parsed, and that sentence is what tells a human their work is gone
  // (review, low).
  it('an unreadable commit count is NOT committed work, and does not claim the branch is empty', () => {
    const git = gitStub([{ code: 0, out: `feat/${A}-y\n` }, { code: 0, out: 'warning: gc\n7\n' }]);
    const r = parkedWork({ id: A, repoRoot: '/repos/x', since: NOW, git });
    expect(r.committed).toBe(false);
    expect(r.why).toMatch(/could not be read/);
    expect(r.why).not.toMatch(/no commit beyond/);
  });
});

describe('repoForProject — resolving a ticket to the repo its work is in', () => {
  const mapFile = (value) => () => (typeof value === 'string' ? value : JSON.stringify(value));

  it('joins baseDir with the project row', () => {
    const read = mapFile({ baseDir: '/base', projects: { 'portfolio-site': { repo: 'projects/portfolio-site' } } });
    expect(repoForProject('/wt', 'portfolio-site', { read })).toBe('/base/projects/portfolio-site');
  });

  // Every unusable shape fails closed, so a half-set-up machine can never resolve `undefined/undefined`
  // and hand it to git — the same list SKILL.md §1 hard-stops on.
  it.each([
    ['no project given', null, { baseDir: '/base', projects: { x: { repo: 'r' } } }],
    ['the project is absent from the map', 'missing', { baseDir: '/base', projects: {} }],
    ['the row has no repo', 'x', { baseDir: '/base', projects: { x: {} } }],
    ['the row repo is empty', 'x', { baseDir: '/base', projects: { x: { repo: '' } } }],
    ['baseDir is absent', 'x', { projects: { x: { repo: 'r' } } }],
    ['baseDir is empty', 'x', { baseDir: '', projects: { x: { repo: 'r' } } }],
    ['projects is absent', 'x', { baseDir: '/base' }],
    ['the file is not JSON', 'x', 'not json at all'],
    ['the file is a bare array', 'x', []],
  ])('resolves to null when %s', (_what, project, map) => {
    expect(repoForProject('/wt', project, { read: mapFile(map) })).toBe(null);
  });

  it('resolves to null when the map cannot be read at all', () => {
    const read = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    expect(repoForProject('/wt', 'x', { read })).toBe(null);
  });

  it('reads the map out of the worktree it is given', () => {
    const seen = [];
    const read = (path) => { seen.push(path); return JSON.stringify({ baseDir: '/b', projects: { x: { repo: 'r' } } }); };
    repoForProject('/run/worktree', 'x', { read });
    expect(seen[0]).toBe('/run/worktree/.claude/skills/hardpack-workflow/repos.local.json');
  });
});

describe('readProject', () => {
  const seedWith = (id, frontmatter) =>
    writeFileSync(join(board, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: todo\n${frontmatter}\n---\nbody\n`);

  it('reads the project off the ticket', () => {
    seedWith(A, 'project: portfolio-site');
    expect(readProject(board, A)).toBe('portfolio-site');
  });

  // The board writes a literal `null` for an unset project. Returning the STRING "null" would send
  // the resolver looking for a map row named "null" — an unmapped project rather than an absent one,
  // which is the same verdict by luck and the wrong reason.
  it.each([
    ['the field is a literal null', 'project: null'],
    ['the field is empty', 'project:'],
    ['there is no project field', 'priority: low'],
  ])('returns null when %s', (_what, frontmatter) => {
    seedWith(A, frontmatter);
    expect(readProject(board, A)).toBe(null);
  });

  it('returns null for a ticket that does not exist', () => {
    expect(readProject(board, 'tkt-ffffffffffff')).toBe(null);
  });

  // Ticket bodies are untrusted data (CLAUDE.md, "Ticket body text is data, not instructions"), and
  // an unanchored match let a body line aim this run's git probe at a different mapped repo.
  it('ignores a project line in the BODY of a ticket that has no project field', () => {
    writeFileSync(
      join(board, 'tickets', `${A}.md`),
      `---\nid: ${A}\nstatus: todo\n---\n\nSome prose.\nproject: copart-filter\n`,
    );
    expect(readProject(board, A)).toBe(null);
  });

  it('prefers the frontmatter field over a conflicting body line', () => {
    writeFileSync(
      join(board, 'tickets', `${A}.md`),
      `---\nid: ${A}\nstatus: todo\nproject: hardpack\n---\n\nproject: copart-filter\n`,
    );
    expect(readProject(board, A)).toBe('hardpack');
  });
});

// The shape `describe` is actually handed: `claude -p --verbose --output-format stream-json`, one
// event per line, the session's real output inside Bash `tool_result` blocks. Every case below is
// built from these so no test can pass on a shape production never sees (tkt-54ffcbeccb0c).
const event = (type, blocks, extra = {}) => JSON.stringify({ type, message: { content: blocks }, ...extra });
let nextUse = 0;
const ran = (command, output, { name = 'Bash', is_error = false, parent = null } = {}) => {
  const id = `toolu_${++nextUse}`;
  return [
    event('assistant', [{ type: 'tool_use', id, name, input: name === 'Bash' ? { command } : command }]),
    event('user', [{ type: 'tool_result', tool_use_id: id, content: output, is_error }], parent ? { parent_tool_use_id: parent } : {}),
  ].join('\n');
};
const said = (text) => event('assistant', [{ type: 'text', text }]);
const transcript = (...lines) => lines.join('\n');
const RED_FULL = ' Test Files  1 failed | 74 passed (75)\n      Tests  3 failed | 2009 passed (2012)\n   Duration  40.1s';
const GREEN_FULL = ' Test Files  75 passed (75)\n      Tests  2012 passed (2012)\n   Duration  38.7s';
const RED_ONE = ' Test Files  1 failed (1)\n      Tests  1 failed | 93 skipped (94)';
const GREEN_ONE = ' Test Files  1 passed (1)\n      Tests  1 passed | 93 skipped (94)';
const NARROW = 'npx vitest run src/lib/detail.test.ts -t "trimmed value" 2>&1';

describe('gateFailed — dimension 7: which occurrence is the gate verdict (tkt-54ffcbeccb0c)', () => {
  it('a halt with a failing gate is reported as UNDIAGNOSED, not a broken branch', () => {
    const r = classify({ before: 'todo', after: 'in-progress' });
    expect(describeResult(r, ran('npm test 2>&1 | tail -5', RED_FULL))).toMatch(/undiagnosed/i);
  });

  // The control. Without it the wording would be unconditional and carry no information.
  it('a halt with no gate failure is not called undiagnosed', () => {
    const r = classify({ before: 'todo', after: 'in-progress' });
    expect(describeResult(r, ran('npm test 2>&1 | tail -5', GREEN_FULL))).not.toMatch(/undiagnosed/i);
  });

  // Dimension 1 — encoding. The regression this ticket exists for: the raw detector never fired on
  // a stream-json log (0/27 real logs), and the old unit cases fed plain text, which production
  // never sends. Plain text is not an observation now, so the suite cannot go green on that shape.
  it('reads the summary out of a stream-json Bash result', () => {
    expect(gateFailed(ran('npm test', RED_FULL))).toBe(true);
  });
  it('plain text — the shape the old tests fed — is not an observation', () => {
    expect(gateFailed('Tests  2 failed | 10 passed')).toBe(false);
    expect(gateFailed('typecheck failed')).toBe(false);
  });
  it('a log cut mid-write still reads the events before the cut', () => {
    expect(gateFailed(transcript(ran('npm test', RED_FULL), '{"type":"resu'))).toBe(true);
  });

  // Dimension 2 — source. Only a Bash result is the gate speaking; the model quoting a summary in
  // its own text or in ticket paperwork is not. Measured: `tkt-7cab2f9cc082` (ended ok) carries
  // `Tests 1 failed` in an assistant block; a text decode would have fired on it.
  it('the same line in the model own text is not an observation', () => {
    expect(gateFailed(said('Tests  3 failed | 2009 passed (2012)'))).toBe(false);
  });
  it('the same line quoted into a non-Bash tool input is not an observation', () => {
    const paperwork = ran({ id: A, appendBody: 'Tests  2 failed | 10 passed\nmutation observed red' }, 'ok', { name: 'mcp__kanban__update_ticket' });
    expect(gateFailed(paperwork)).toBe(false);
  });

  // Dimension 3 — position. A red-first repro and the mutation check both REQUIRE observing red, so
  // the last observation is the verdict, never any occurrence. 7 of the 9 real logs with a red
  // summary anywhere ended `ok`; all 9 end green under this rule.
  it('red then green is green', () => {
    expect(gateFailed(transcript(ran('npm test', RED_FULL), ran('npm test', GREEN_FULL)))).toBe(false);
  });
  it('green then red is red', () => {
    expect(gateFailed(transcript(ran('npm test', GREEN_FULL), ran('npm test', RED_FULL)))).toBe(true);
  });

  // Dimension 4 — breadth. A selection is not the gate. This is what keeps a mutation check that
  // happened to be the final run from labelling a healthy branch UNDIAGNOSED (`tkt-ab211de0101c`).
  it.each([
    ['a file path', 'npx vitest run src/lib/detail.test.ts 2>&1'],
    ['a -t name filter', NARROW],
    ['a directory', 'npx vitest run hooks/ 2>&1'],
    ['npm test -- <path>', 'npm test -- scripts/night-run.test.mjs'],
  ])('a final narrow red after a full green is not the verdict — %s', (_name, selection) => {
    expect(gateFailed(transcript(ran('npm test', GREEN_FULL), ran(selection, RED_ONE)))).toBe(false);
  });
  it('a final full red after a narrow green is the verdict', () => {
    expect(gateFailed(transcript(ran(NARROW, GREEN_ONE), ran('npm test 2>&1', RED_FULL)))).toBe(true);
  });
  it('only narrow runs, last one red, is no verdict at all', () => {
    expect(gateFailed(transcript(ran(NARROW, GREEN_ONE), ran(NARROW, RED_ONE)))).toBe(false);
  });
  it.each([
    ['flags only after --', 'npm test -- --no-file-parallelism'],
    ['a reporter flag', 'npx vitest run --reporter=basic 2>&1'],
    ['an env prefix and a cd', 'cd /x/y && SKIP_DB_TESTS=1 npm test 2>&1 | tail -20'],
    ['the run script', 'npm run test 2>&1'],
    ['bare vitest', 'npx vitest run 2>&1'],
  ])('a full run is still full with — %s', (_name, command) => {
    expect(gateFailed(ran(command, RED_FULL))).toBe(true);
  });

  // Dimension 5 — kinds are independent: a green test run does not clear a red typecheck. The verdict
  // line is the session's own `echo "typecheck=$?"`, the convention in 14 of 27 real logs; tsc is
  // silent on success and the run is routinely redirected to a file, so nothing else is observable.
  it('tests green last but typecheck red last is a failed gate', () => {
    const red = ran('npm run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"', 'typecheck=1');
    expect(gateFailed(transcript(red, ran('npm test', GREEN_FULL)))).toBe(true);
    // Its inverse: the named line is also last-of-kind, so a later green typecheck clears it.
    expect(gateFailed(transcript(red, ran('npm run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"', 'typecheck=0')))).toBe(false);
    // The tools' own visible output is a verdict too; lint is its own kind.
    expect(gateFailed(ran('npm run lint 2>&1 | tail -3', '✖ 2 problems (2 errors, 0 warnings)'))).toBe(true);
    expect(gateFailed(ran('npm run lint 2>&1 | tail -3', '✖ 2 problems (0 errors, 2 warnings)'))).toBe(false);
    expect(gateFailed(ran('npm run typecheck 2>&1 | tail -3', 'src/a.ts(3,1): error TS2322: x is not y'))).toBe(true);
    expect(gateFailed(transcript(ran('npm run lint; echo "lint=$?"', 'lint=0'), red))).toBe(true);
  });
  // (review) A chained gate proves its earlier links: the summary printing at all means every `&&`
  // before the run exited 0, which is the only green a silent tsc ever leaves.
  it('a green chained gate clears an earlier red typecheck echo; a `;` chain proves nothing', () => {
    const red = ran('npm run typecheck > /tmp/tc.log 2>&1; echo "typecheck=$?"', 'typecheck=1');
    expect(gateFailed(transcript(red, ran('npm run typecheck && npm run lint && npm test 2>&1 | tail -5', GREEN_FULL)))).toBe(false);
    expect(gateFailed(transcript(red, ran('npm run typecheck; npm run lint; npm test 2>&1 | tail -5', GREEN_FULL)))).toBe(true);
    // A red summary proves the earlier links just as well.
    expect(gateFailed(transcript(red, ran('npm run typecheck && npm test 2>&1 | tail -5', GREEN_FULL), ran('npm test', GREEN_FULL)))).toBe(false);
  });
  // (review) The named lines are attributed exactly like the summary: only from a command that ran
  // that script. A cat of an old log, a per-file eslint, or PR prose is not the gate.
  it.each([
    ['a cat of an old gate log', 'cat /tmp/old-gate.log', 'typecheck=1'],
    ['a per-file eslint', 'npx eslint src/foo.ts; echo "lint=$?"', 'lint=1'],
    ['PR comment prose', 'gh pr view 12 --comments', 'Lint failed on CI last night, please rerun'],
    ['an env dump', 'env | sort', 'TEST=1\nTEST_EXIT=1 FOO=2'],
    ['a console line inside a run', 'npm test 2>&1 | tail -3', 'test failed to connect, retrying'],
  ])('a verdict-looking line outside its command is not an observation — %s', (_name, command, output) => {
    expect(gateFailed(transcript(ran('npm run typecheck; echo "typecheck=$?"', 'typecheck=0'), ran('npm run lint; echo "lint=$?"', 'lint=0'), ran(command, output)))).toBe(false);
  });
  // The same echo after a redirected `npm test` is the only verdict that run leaves in the transcript
  // (`TEST_EXIT=$?` and `TYPECHECK=$?` are both real spellings). After a selection it is the
  // selection's exit status, so breadth applies to it exactly as to the summary line.
  it('an echoed exit status stands in for a redirected run, and is breadth-checked', () => {
    expect(gateFailed(ran('npm test > /tmp/t.log 2>&1; echo "TEST_EXIT=$?"', 'TEST_EXIT=1'))).toBe(true);
    expect(gateFailed(ran('npm test > /tmp/t.log 2>&1; echo "test exit=$?"', 'test exit=0'))).toBe(false);
    expect(gateFailed(ran(`${NARROW} > /tmp/t.log; echo "TEST_EXIT=$?"`, 'TEST_EXIT=1'))).toBe(false);
    expect(gateFailed(ran('npm run typecheck >/dev/null 2>&1; echo "TYPECHECK=$?"', 'TYPECHECK=2'))).toBe(true);
  });

  // Dimension 6 — a zero count is green. Measured against the first draft, which matched /\d+ failed/.
  it('Tests 0 failed is not a failure', () => {
    expect(gateFailed(ran('npm test', 'Tests  0 failed | 12 passed (12)'))).toBe(false);
  });

  // Dimension 7 — absent.
  it.each([
    ['empty', ''],
    ['null', null],
    ['undefined', undefined],
    ['events but no Bash result', transcript(said('starting'), JSON.stringify({ type: 'result', subtype: 'success' }))],
    ['a Bash result with no summary', ran('npm test > /tmp/t.log 2>&1; echo done', 'done')],
  ])('makes no claim for %s', (_name, input) => {
    expect(gateFailed(input)).toBe(false);
  });

  // Dimension 8 — the exit flag is not the signal. Every red run in the corpus was piped through
  // `tail`, so `is_error` is false on all of them (0/27 carry a red summary with is_error true).
  it('a red summary fires with is_error false; a green one does not fire with is_error true', () => {
    expect(gateFailed(ran('npm test 2>&1 | tail -5', RED_FULL, { is_error: false }))).toBe(true);
    expect(gateFailed(ran('npm test', GREEN_FULL, { is_error: true }))).toBe(false);
  });

  // Dimension 9 — attribution. A summary counts only from the command that produced it.
  it('a summary shown by a non-test command is not an observation', () => {
    expect(gateFailed(ran('cat /tmp/test.log', RED_FULL))).toBe(false);
  });
  it('a hook-run gate inside git commit is a full observation', () => {
    const commit = ran('git commit -m "x"', `${RED_FULL}\nhusky - pre-commit script failed (code 1)`);
    expect(gateFailed(commit)).toBe(true);
    expect(gateFailed(transcript(ran('npm test', RED_FULL), ran('git commit -m "x"', `${GREEN_FULL}\n[main abc123] x`)))).toBe(false);
  });
  it('a command mixing a narrow and a full run cannot attribute its summaries, so it is not an observation', () => {
    expect(gateFailed(ran(`${NARROW}; npm test 2>&1`, `${GREEN_ONE}\n${RED_FULL}`))).toBe(false);
  });
  it('a selection through an unexpanded variable is unknowable, not full', () => {
    expect(gateFailed(ran('npx vitest run $SEL --coverage.enabled=false 2>&1', RED_ONE))).toBe(false);
  });

  // Dimension 10 — a review subagent running the gate is the gate running.
  it('a result inside a subagent counts like any other', () => {
    expect(gateFailed(transcript(ran('npm test', GREEN_FULL), ran('npx vitest run 2>&1', RED_FULL, { parent: 'toolu_parent' })))).toBe(true);
  });

  // A pre-commit hook refusing the commit is NOT by itself a gate failure — see hookRejected.
  it('the husky marker alone is not a gate failure', () => {
    expect(gateFailed(ran('git commit -m "x"', 'husky - pre-commit script failed (code 1)'))).toBe(false);
  });

  // Dimension 11 — the review's sweep of what the summary line alone cannot see. Each output shape
  // was verified against vitest in this repo by the reviewer: a collect/import error prints
  // `Test Files 1 failed` over a green `Tests` line; an unhandled error prints `Errors 1 error`;
  // a coverage threshold prints `ERROR: Coverage for …`. All three exit 1.
  it.each([
    ['a collect failure', ' Test Files  1 failed | 74 passed (75)\n      Tests  2009 passed (2009)'],
    ['an unhandled error', ' Test Files  75 passed (75)\n      Tests  2011 passed (2011)\n     Errors  1 error'],
    ['a coverage threshold', `${GREEN_FULL}\nERROR: Coverage for lines (80%) does not meet global threshold (90%)`],
  ])('a run that exited 1 with every test green is red — %s', (_name, output) => {
    expect(gateFailed(ran('npm test 2>&1 | tail -8', output))).toBe(true);
  });
  it('an echoed exit status outranks the summary in the same result, whichever is printed first', () => {
    expect(gateFailed(ran('npm test > /tmp/t.log 2>&1; echo "test=$?"; tail -5 /tmp/t.log', `test=1\n${GREEN_FULL}`))).toBe(true);
    expect(gateFailed(ran('npm test > /tmp/t.log 2>&1; echo "test=$?"; tail -5 /tmp/t.log', `test=0\n${RED_FULL}`))).toBe(false);
  });
  it('npm forwards a positional without `--`, so it is a selection; its own flags are not', () => {
    expect(gateFailed(transcript(ran('npm test', GREEN_FULL), ran('npm test scripts/night-run.test.mjs', RED_ONE)))).toBe(false);
    expect(gateFailed(ran('npm test --silent', RED_FULL))).toBe(true);
  });
  it.each([
    ['time', 'time npm test 2>&1 | tail -5'],
    ['timeout with a unit', 'timeout 10m npm test'],
    ['a quoted env value', 'FOO="a b" npm test'],
    ['a subshell', '(cd x && npm test)'],
    ['env', 'env CI=1 npm test'],
    ['a space-separated flag value', 'npx vitest run --reporter basic'],
    ['a config flag', 'npx vitest run --config vitest.ci.config.ts'],
  ])('a full run stays full behind — %s', (_name, command) => {
    expect(gateFailed(ran(command, RED_FULL))).toBe(true);
  });
  it.each([
    ['--changed', 'npx vitest run --changed'],
    ['npm test -- --related', 'npm test -- --related src/a.ts'],
  ])('a subset flag is a selection — %s', (_name, command) => {
    expect(gateFailed(transcript(ran('npm test', GREEN_FULL), ran(command, RED_ONE)))).toBe(false);
  });
  it('a script that is not the unit gate is not the `test` kind', () => {
    expect(gateFailed(ran('npm run test:e2e; echo "test=$?"', 'test=1'))).toBe(false);
  });
  it('a heredoc body is data: a run command inside it does not classify the writing command', () => {
    const write = `cat > "$T/fix.mjs" <<'SCR'\nnpx vitest run hooks/\nSCR\nnpm test 2>&1`;
    expect(gateFailed(ran(write, RED_FULL))).toBe(true);
    const commit = `git commit -m "$(cat <<'EOF'\nFix x\n\nnpx vitest run scripts/x.test.mjs stays red\nEOF\n)"`;
    expect(gateFailed(ran(commit, `${RED_FULL}\nhusky - pre-commit script failed (code 1)`))).toBe(true);
  });
});

describe('decodeLog — the log shape describe() is actually handed', () => {
  // The regression this exists for: every matcher is line-anchored, and stream-json carries the
  // session's output inside JSON strings, so before this no anchored pattern could ever fire.
  it('restores line starts from JSON-escaped newlines', () => {
    expect(decodeLog(String.raw`a\nTests  1 failed`)).toBe('a\nTests  1 failed');
    expect(decodeLog(String.raw`a\r\nb`)).toBe('a\nb');
  });

  it('leaves already-decoded text and empty input alone', () => {
    expect(decodeLog('a\nb')).toBe('a\nb');
    expect(decodeLog(null)).toBe('');
    expect(decodeLog(undefined)).toBe('');
  });
});

describe('hookRejected — a hook refusing the commit is not the same claim as a failed gate', () => {
  it.each([
    ['husky - pre-commit script failed (code 1)', true],
    ['  husky - pre-commit script failed (code 2)', true],
    [JSON.stringify({ content: 'x\nhusky - pre-commit script failed (code 1)\n' }), true],
    // A DIFFERENT hook is not the commit gate and must not borrow its wording.
    ['husky - pre-push script failed (code 1)', false],
    // The model describing the mechanism is not the mechanism firing.
    ['if the gate fails you will see husky - pre-commit script failed', false],
    ['', false],
  ])('hookRejected(%s) === %s', (log, want) => {
    expect(hookRejected(log)).toBe(want);
  });

  const halt = () => classify({ before: 'todo', after: 'in-progress' });

  // equipment-schedule's pre-commit runs only a semicolon guard, so "the quality gate failed, so
  // this is UNDIAGNOSED, not evidence against the branch" would tell the reader to discount a real
  // defect. It gets its own wording instead.
  it('a non-gate hook failure is not called a gate failure', () => {
    const text = describeResult(halt(), 'husky - pre-commit script failed (code 1)');
    expect(text).toMatch(/pre-commit hook refused the commit/);
    expect(text).not.toMatch(/undiagnosed/i);
  });

  it('a gate failure inside the hook keeps the gate wording, which is the accurate one', () => {
    const log = ran('git commit -m "x"', 'Tests  14 failed | 3 passed (17)\nhusky - pre-commit script failed (code 1)');
    expect(describeResult(halt(), log)).toMatch(/undiagnosed/i);
  });

  it('neither wording is attached to a halt with no failure evidence at all', () => {
    const text = describeResult(halt(), 'stopped at a hard stop');
    expect(text).not.toMatch(/undiagnosed/i);
    expect(text).not.toMatch(/refused the commit/);
  });

  // The wording rides on a halt; a successful run must never pick it up.
  it('says nothing extra on a non-halt verdict', () => {
    const ok = classify({ before: 'todo', after: 'qa' });
    expect(describeResult(ok, 'husky - pre-commit script failed (code 1)')).toBe(ok.text);
  });
});

describe('strandedBackgroundTasks — dimension 8: the halt left waiting on a background task', () => {
  const RESULT = JSON.stringify({ type: 'result', subtype: 'success', num_turns: 40 });
  const stopped = (summary) =>
    JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'stopped', summary });
  const completed = (summary) =>
    JSON.stringify({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed', summary });
  const log = (...lines) => lines.join('\n');
  const halt = () => classify({ before: 'todo', after: 'in-progress' });

  it('names the tasks the session was left waiting on, in the transcript own wording', () => {
    expect(strandedBackgroundTasks(log(RESULT, stopped('Re-run full gate after review fixes'))))
      .toEqual(['Re-run full gate after review fixes']);
  });

  // THE discriminating dimension. `tkt-0564cfaeca12` ended `ok` with three killed tasks, two of them
  // before its final envelope: a session that kills a task and then keeps working has not stranded.
  it('a task stopped BEFORE the final result envelope is not stranded', () => {
    expect(strandedBackgroundTasks(log(stopped('an abandoned watch'), RESULT))).toBeNull();
  });

  // A log is not one session per file: `tkt-6fc47c796754` holds 9 result envelopes, `tkt-cd9743d95ac2`
  // 5. Keying on the FIRST would call every later segment stranded.
  it('keys on the last result envelope, not the first', () => {
    expect(strandedBackgroundTasks(log(RESULT, stopped('between segments'), RESULT))).toBeNull();
    expect(strandedBackgroundTasks(log(RESULT, RESULT, stopped('after the last')))).toEqual(['after the last']);
  });

  // `tkt-92360b0e2079` (level `capped`) carries zero result envelopes. With no envelope there is no
  // position to compare against, so "after it" is unanswerable — and a detector that cannot place the
  // event must not claim a mechanism.
  it('makes no claim when the log has no result envelope at all', () => {
    expect(strandedBackgroundTasks(log(stopped('nowhere to anchor')))).toBeNull();
  });

  // The inversion this guard exists for (review, MEDIUM). `run()` merges stderr into the same buffer
  // and a killed child stops mid-line, so the closing envelope can be lost — and the two logs below
  // are INDISTINGUISHABLE from one where the strand really was the tail. Guessing turns a correct
  // null into a false diagnosis, so an unparseable final line is unknowable, not negative.
  it.each([
    ['a truncated final envelope', '{"type":"resu'],
    ['stderr interleaved into the final line', `warn: mcp${RESULT}`],
  ])('makes no claim when the tail is unreadable — %s', (_name, tail) => {
    expect(strandedBackgroundTasks(log(RESULT, stopped('mid-session watcher'), tail))).toBeNull();
    // The control: the same log with an intact tail is also null, so the guard is not what decides it.
    expect(strandedBackgroundTasks(log(RESULT, stopped('mid-session watcher'), RESULT))).toBeNull();
  });

  // Unparseable lines only defeat the tail. In the middle they are skipped, as a live capture requires.
  it('skips unparseable lines that are not the tail', () => {
    expect(strandedBackgroundTasks(log(RESULT, 'not json at all', stopped('still found'))))
      .toEqual(['still found']);
  });

  it('a task that COMPLETED after the last envelope is not stranded', () => {
    expect(strandedBackgroundTasks(log(RESULT, completed('Background command finished')))).toBeNull();
  });

  it.each([
    ['no notification at all', log(RESULT, JSON.stringify({ type: 'assistant' }))],
    ['empty log', ''],
    ['null log', null],
    ['undefined log', undefined],
  ])('makes no claim for %s', (_name, input) => {
    expect(strandedBackgroundTasks(input)).toBeNull();
  });

  it('reports a stranded task carrying no summary', () => {
    const line = JSON.stringify({ type: 'system', subtype: 'task_notification', status: 'stopped' });
    expect(strandedBackgroundTasks(log(RESULT, line))).toEqual(['']);
  });

  // Three of the six real halts strand MORE than one task; `tkt-5d7682011a3b` strands three. Reporting
  // only the last would hide the majority case.
  it('reports every task stranded after the final envelope, not just the last', () => {
    const out = strandedBackgroundTasks(log(RESULT, stopped('Run typecheck, lint, test'), stopped('Check gate progress'), stopped('Wait for gate to finish')));
    expect(out).toEqual(['Run typecheck, lint, test', 'Check gate progress', 'Wait for gate to finish']);
  });

  it('a halt left waiting on a background task says so, and quotes it', () => {
    const text = describeResult(halt(), log(RESULT, stopped('Run the five-command quality gate')));
    expect(text).toMatch(/a backgrounded command still running/);
    expect(text).toContain('Run the five-command quality gate');
  });

  it('counts them when more than one was stranded', () => {
    const text = describeResult(halt(), log(RESULT, stopped('first watch'), stopped('second watch')));
    expect(text).toMatch(/2 backgrounded commands still running/);
    expect(text).toContain('"first watch", "second watch"');
  });

  // The halt line is one row an 8am reader scans, and summaries are model-authored free text — real
  // ones in the fleet already carry double quotes.
  it('flattens a summary that would split or confuse the row', () => {
    const text = describeResult(halt(), log(RESULT, stopped('Background command "x"\nsecond line')));
    expect(text).not.toMatch(/\n/);
    expect(text).toContain(`Background command 'x' second line`);
  });

  it('caps a summary long enough to bury the line', () => {
    const text = describeResult(halt(), log(RESULT, stopped('y'.repeat(200))));
    expect(text).toContain(`${'y'.repeat(59)}…`);
    expect(text).not.toContain('y'.repeat(61));
  });

  // The authorizing line. `tkt-0564cfaeca12` carries this exact signal after its last envelope and
  // opened a PR — describing it as a halt mechanism would be a false diagnosis at 8am.
  it('says nothing extra on a non-halt verdict carrying the same signal', () => {
    const ok = classify({ before: 'todo', after: 'qa' });
    expect(describeResult(ok, log(RESULT, stopped('Wait for PR checks to settle')))).toBe(ok.text);
  });

  it('yields to the gate wording, which names a more specific cause', () => {
    const text = describeResult(halt(), log(ran('npm run typecheck', 'src/a.ts(3,1): error TS2322: x'), RESULT, stopped('a watch')));
    expect(text).toMatch(/undiagnosed/i);
    expect(text).not.toMatch(/backgrounded command/);
  });

  // Asserting an undetected negative is the shape this clause must never take: `gateFailed` is inert
  // on stream-json (0/27), and `tkt-ab211de0101c` is a real halt whose decoded log carries
  // `Tests 1 failed` (review, HIGH). Claiming "no gate failed" there would discount a real defect.
  it('claims only what it detected, never that no gate failed', () => {
    const text = describeResult(halt(), log(RESULT, stopped('a watch')));
    expect(text).not.toMatch(/no gate failed/i);
    expect(text).not.toMatch(/not evidence against the branch/i);
  });

  // The control: without it the clause could be unconditional and carry no information.
  it('is not attached to a halt with no stranded task', () => {
    expect(describeResult(halt(), log(RESULT, completed('all done')))).not.toMatch(/backgrounded command/);
  });
});

describe('guardBlocked — the armed half of the control', () => {
  it('accepts the reply we asked for', () => {
    expect(guardBlocked('BLOCKED')).toBe(true);
  });

  it('accepts the hook own marker, which the model cannot author', () => {
    expect(guardBlocked('[guard-unattended-merge] Blocked: tried to merge a pull request')).toBe(true);
  });

  // The fail-open that sat in the single check the whole design rests on: a bare /BLOCKED/ substring
  // test passes on its own negation (review, HIGH — measured).
  it('REJECTS a sentence that merely contains the word, including its own negation', () => {
    expect(guardBlocked('The command was not BLOCKED — it RAN.')).toBe(false);
  });

  it('rejects a plain RAN', () => {
    expect(guardBlocked('RAN')).toBe(false);
  });

  it('rejects silence', () => {
    expect(guardBlocked('')).toBe(false);
  });
});

describe('capMsFrom — dimension 2, and the cap that removed itself', () => {
  it('defaults when unset', () => {
    expect(capMsFrom(undefined)).toEqual({ ok: true, capMs: 2700 * 1000 });
  });

  it('accepts a positive number of seconds', () => {
    expect(capMsFrom('60')).toEqual({ ok: true, capMs: 60_000 });
  });

  // `Number('abc') * 1000` is NaN, which is falsy, so the first draft silently ran with no cap at
  // all (review, MEDIUM).
  it.each(['abc', '0', '-5', ''])('rejects %s rather than silently disabling the cap', (raw) => {
    expect(capMsFrom(raw).ok).toBe(false);
  });
});

describe('readStatus — dimension 1, reading the board', () => {
  it('reads a real status', () => {
    seed('tkt-000000000001', 'qa');
    expect(readStatus(board, 'tkt-000000000001')).toBe('qa');
  });

  it('returns null for a missing ticket rather than throwing', () => {
    expect(readStatus(board, 'tkt-00000000dead')).toBeNull();
  });
});

describe('fileHere — the STOP check that must not fail open', () => {
  it('reports a present file', () => {
    const p = join(board, 'here');
    writeFileSync(p, '');
    expect(fileHere(p)).toBe(true);
  });

  it('reports a genuinely absent file', () => {
    expect(fileHere(join(board, 'nope'))).toBe(false);
  });

  // guard-unattended-merge.mjs documents rejecting existsSync for exactly this: only ENOENT may
  // permit, so anything else — an unreadable parent, EACCES — must read as present.
  it('treats a non-ENOENT error as present rather than absent', () => {
    const file = join(board, 'a-file');
    writeFileSync(file, '');
    // Descending THROUGH a regular file yields ENOTDIR, not ENOENT — the shape existsSync would
    // swallow into a false "absent".
    expect(fileHere(join(file, 'through'))).toBe(true);
  });
});

describe('sentinel lifecycle and ownership — dimension 3, and two actors', () => {
  const active = () => sentinelPaths(board).active;

  it('arm creates this run’s claim and disarm removes it, dropping the emptied directory', () => {
    arm(board);
    expect(claimHeld(board, process.pid)).toBe(true);
    expect(nightRunActive(active())).toBe(true);
    disarm(board);
    expect(existsSync(active())).toBe(false);
    expect(nightRunActive(active())).toBe(false);
  });

  it('disarm on an already-absent sentinel does not throw', () => {
    expect(() => disarm(board)).not.toThrow();
  });

  it('a fresh claim writes this process as an owner, under a file named by its pid', () => {
    expect(claimSentinel(board)).toEqual({ ok: true });
    expect(claimHeld(board, process.pid)).toBe(true);
    expect(readFileSync(claimPath(board, process.pid), 'utf8').trim()).toBe(String(process.pid));
  });

  // Two actors, both live: the case the single-owner sentinel refused, and the whole point of the
  // claims directory (tkt-c248cfbc5d8c). Neither can drop the other's claim, and the guard — the
  // real predicate, imported — reads armed until the LAST claim is gone.
  it('two live runners hold the sentinel at once, and each disarms only its own claim', () => {
    expect(claimSentinel(board, { pid: 4242, alive: () => true }).ok).toBe(true);
    expect(claimSentinel(board, { pid: 99, alive: () => true }).ok).toBe(true);
    expect([...readClaims(board).pids].sort()).toEqual([4242, 99].sort());
    expect(nightRunActive(active())).toBe(true);
    expect(disarm(board, { pid: 4242 })).toBe(true);
    expect(claimHeld(board, 99)).toBe(true);
    expect(nightRunActive(active())).toBe(true); // still armed for the other run
    expect(disarm(board, { pid: 99 })).toBe(true);
    expect(nightRunActive(active())).toBe(false);
  });

  // The takeover, per claim: an owner that is gone left a leak, not a run, and it is swept on the
  // way in while a live neighbour is left alone. Without this, one crash wedges every later run.
  it('sweeps a claim whose owner is gone and leaves a live one alone', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    claimSentinel(board, { pid: 5555, alive: () => true });
    const res = claimSentinel(board, { pid: 99, alive: (p) => p !== 4242 });
    expect(res).toEqual({ ok: true, swept: [4242] });
    expect([...readClaims(board).pids].sort()).toEqual([5555, 99].sort());
  });

  // The runner from before the claims directory writes a single-owner FILE. It is exclusive by
  // design, so it is honoured while alive and taken over into the directory form once dead.
  it('honours a live single-owner sentinel from an older runner', () => {
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(active(), '4242\n');
    const res = claimSentinel(board, { pid: 99, alive: () => true });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/single-owner form/);
    expect(readClaims(board)).toMatchObject({ kind: 'legacy', legacyPid: 4242 }); // untouched
  });

  it('takes over a dead single-owner sentinel into the claims directory', () => {
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(active(), '4242\n');
    const res = claimSentinel(board, { pid: 99, alive: () => false });
    expect(res).toEqual({ ok: true, tookOver: 4242 });
    expect(readClaims(board)).toMatchObject({ kind: 'dir', pids: [99] });
  });

  it('refuses when a sentinel exists but its owner cannot be read', () => {
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(active(), 'not-a-pid\n');
    const res = claimSentinel(board, { pid: 99, alive: () => false });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not be read/i);
  });

  // Unreadable is "cannot rule out a run": the claim refuses, and the guard stays armed.
  it('refuses when the claims directory cannot be listed, and the guard reads it as armed', () => {
    mkdirSync(active(), { recursive: true });
    chmodSync(active(), 0o000);
    try {
      const res = claimSentinel(board, { pid: 99, alive: () => false });
      expect(res.ok).toBe(false);
      expect(res.why).toMatch(/could not be read/i);
      expect(nightRunActive(active())).toBe(true);
    } finally {
      chmodSync(active(), 0o755);
    }
  });

  // An entry that is not a pid cannot be swept and is not an owner: the claim proceeds and names it,
  // and it keeps the guard armed after every real claim is gone — loud, never silently permissive.
  it('names a non-pid entry, leaves it in place, and it keeps the gate armed', () => {
    mkdirSync(active(), { recursive: true });
    writeFileSync(join(active(), '.DS_Store'), '');
    const res = claimSentinel(board, { pid: 99, alive: () => true });
    expect(res).toEqual({ ok: true, junk: ['.DS_Store'] });
    disarm(board, { pid: 99 });
    expect(existsSync(join(active(), '.DS_Store'))).toBe(true);
    expect(nightRunActive(active())).toBe(true);
  });

  // A pid reused after a crash finds its own number already claimed. That is a leak, not a holder.
  it('replaces a stale claim left under this process’s own pid', () => {
    mkdirSync(active(), { recursive: true });
    writeFileSync(claimPath(board, 99), '{"pid":99,"logDir":"/old"}\n');
    expect(claimSentinel(board, { pid: 99, alive: () => true })).toEqual({ ok: true });
    expect(readFileSync(claimPath(board, 99), 'utf8').trim()).toBe('99');
  });

  it('disarm refuses to remove a claim this process does not own', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    expect(disarm(board, { pid: 99 })).toBe(false);
    expect(claimHeld(board, 4242)).toBe(true);
  });

  it('a claim note is advisory: read back when written, empty for a bare pid, never the identity', () => {
    claimSentinel(board, { pid: 99, alive: () => true });
    expect(readClaimNote(board, 99)).toEqual({});
    noteClaim(board, { logDir: '/runs/x' }, { pid: 99 });
    expect(readClaimNote(board, 99)).toEqual({ pid: 99, logDir: '/runs/x' });
    expect(claimHeld(board, 99)).toBe(true);
  });

  it('othersLive counts only claims that are not this pid and whose owner is alive', () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    claimSentinel(board, { pid: 99, alive: () => true });
    expect(othersLive(board, { pid: 99, alive: () => true })).toBe(true);
    expect(othersLive(board, { pid: 99, alive: (p) => p === 99 })).toBe(false);
    expect(othersLive(board, { pid: 4242, alive: () => true })).toBe(true);
  });

  it('pidAlive says yes for this process and no for a pid that cannot exist', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 30, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; })).toBe(false);
  });

  // The review's confirmed finding: a live pid is not a live RUN. Pids are reused, so a crashed
  // run's claim under somebody's editor would be swept by nobody, skip the disarmed probe every
  // night, and hold STOP unswept forever. Each claim decision defaults to this predicate.
  describe('runAlive — a claim’s pid must be a live night run, not merely a live pid', () => {
    const night = () => 'node scripts/night-run.mjs tkt-00000000000a';
    it('dead → not a run, whatever ps would say', () => {
      expect(runAlive(1, { alive: () => false, commandOf: night })).toBe(false);
    });
    it('alive and running night-run.mjs → a run', () => {
      expect(runAlive(1, { alive: () => true, commandOf: night })).toBe(true);
    });
    it('alive but somebody else’s process — a reused pid — → not a run', () => {
      expect(runAlive(1, { alive: () => true, commandOf: () => '/Applications/SomeEditor -w' })).toBe(false);
    });
    it('alive with a command ps cannot read → a run, since one cannot be ruled out', () => {
      expect(runAlive(1, { alive: () => true, commandOf: () => null })).toBe(true);
    });
    it('is what the claim sweeps by: a reused pid is swept, a night run is not', () => {
      claimSentinel(board, { pid: 4242, alive: () => true });
      claimSentinel(board, { pid: 5555, alive: () => true });
      const commandOf = (p) => (p === 4242 ? '/Applications/SomeEditor -w' : night());
      const res = claimSentinel(board, { pid: 99, alive: (p) => runAlive(p, { alive: () => true, commandOf }) });
      expect(res).toEqual({ ok: true, swept: [4242] });
    });
  });

  // The third case of this dimension, and the only one that cannot be driven in-process: the handler
  // ends with process.exit. A run killed mid-ticket must still clear the sentinel (a leaked one blocks
  // every later merge) AND the STOP that `night:stop --now` wrote just before signalling (a leftover
  // one silences the next night, tkt-b90152b23e62). SIGHUP is the likeliest overnight death — an ssh
  // session dropping — and each signal is its own registration, so each is sent.
  it.each(['SIGINT', 'SIGTERM', 'SIGHUP'])('clears the sentinel and a STOP when the run is killed with %s mid-ticket', async (signal) => {
    const { active, stop, child, exited } = await spawnParked('driver.mjs');
    try {
      expect(existsSync(active)).toBe(true); // control: armed
      writeFileSync(stop, ''); // what night:stop does first...
      child.kill(signal); // ...and then, with --now, this
      await exited;
      expect(existsSync(active)).toBe(false);
      expect(existsSync(stop)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  // The runner kills nothing on its own signal, so the `claude` child may outlive it with the
  // worktree as its cwd; a clean-looking tree is not a free one here (review, CONFIRMED). KEPT, and
  // said so — the summary carries the reason.
  it('KEEPS the worktree when the run is killed mid-ticket, rather than deleting a live session’s cwd', async () => {
    const outPath = join(board, 'runner.out');
    const fd = openSync(outPath, 'a');
    const { child, exited } = await spawnParked('keep.mjs', { stdout: fd });
    closeSync(fd);
    try {
      child.kill('SIGTERM');
      await exited;
      expect(existsSync(join(board, 'worktree-removed'))).toBe(false);
      expect(readFileSync(outPath, 'utf8')).toMatch(/worktree KEPT at .* — the run was interrupted/);
      expect(latestSummary().worktree).toMatchObject({ removed: false, why: expect.stringMatching(/interrupted/) });
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });

  // The unremovable case on the signal path: a directory defeats a non-recursive rmSync. It must be
  // LOUD, and stdout goes to a file because a pipe can lose a write made just before process.exit.
  it('says so loudly when the STOP a signal should sweep cannot be removed', async () => {
    const outPath = join(board, 'runner.out');
    const fd = openSync(outPath, 'a');
    const { active, stop, child, exited } = await spawnParked('loud.mjs', { stdout: fd });
    closeSync(fd);
    try {
      mkdirSync(stop);
      child.kill('SIGTERM');
      await exited;
      expect(readFileSync(outPath, 'utf8')).toMatch(/STOP file could NOT be removed/);
      expect(existsSync(stop)).toBe(true);
      expect(existsSync(active)).toBe(false); // the sentinel still clears
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('a crash mid-run — the other half of dimension 3', () => {
  // An uncaught throw in a stream handler is the other way an overnight run dies without reaching the
  // finally; it leaks the same sentinel (review, MEDIUM/HIGH), and the crash handler is the same
  // cleanup, so it must sweep STOP too. Asserts the exit code, so a crash cannot report a clean night.
  it('clears the sentinel and a STOP, and exits non-zero, when something throws uncaught', async () => {
    const { active, stop, child, exited } = await spawnParked('crash.mjs', {
      prelude: `writeFileSync(${JSON.stringify(sentinelPaths(board).stop)}, '');`,
      hold: "setTimeout(() => { throw new Error('boom'); }, 150);",
    });
    try {
      const code = await exited;
      expect(code).not.toBe(0);
      expect(existsSync(active)).toBe(false);
      expect(existsSync(stop)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await exited;
    }
  });
});

describe('run — dimension 2, exercised directly rather than stubbed', () => {
  it('resolves with code -1 when the binary does not exist, instead of hanging', async () => {
    const res = await run('definitely-not-a-real-binary-xyz', []);
    expect(res.code).toBe(-1);
  });

  // The cap is a request until it escalates: a child that ignores SIGTERM would otherwise keep the
  // night parked until morning with the sentinel armed (review, MEDIUM).
  it('caps a child that ignores SIGTERM, by escalating to SIGKILL', async () => {
    const res = await run(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], {
      capMs: 150,
      graceMs: 150,
    });
    expect(res.capped).toBe(true);
  });

  it('does not mark a fast, clean child as capped', async () => {
    const res = await run(process.execPath, ['-e', 'process.exit(0)'], { capMs: 5000 });
    expect(res.capped).toBe(false);
    expect(res.code).toBe(0);
  });

  // tkt-c4743331eb03 — the helper's return value proves nothing on its own; what the deadlock needed
  // was for the CHILD to see it. Spawned for real rather than stubbed, because the drop would be in
  // the wiring between the two.
  it('hands an env through to the spawned child', async () => {
    const res = await run(process.execPath, ['-e', 'process.stdout.write(process.env.NIGHT_RUN_TICKET ?? "UNSET")'], {
      env: sessionEnv(A),
    });
    expect(res.out).toBe(A);
  });

  // The control on the case above: passing no env must still leave the child a usable environment.
  // A `spawn` handed a bare `{}` would launch `claude` with no PATH — a fix that trades a deadlock
  // for a night that cannot start at all.
  it('leaves the inherited environment alone when given no env', async () => {
    const res = await run(process.execPath, ['-e', 'process.stdout.write(process.env.PATH ? "HAS_PATH" : "NO_PATH")']);
    expect(res.out).toBe('HAS_PATH');
  });
});

describe('preflightGuard — dimension 4', () => {
  const armedProbe = () => Promise.resolve({ code: 0, out: 'BLOCKED', capped: false });
  const hookOk = () => Promise.resolve({ code: 0, out: '', capped: false });

  it('passes when the guard blocks while armed and permits while disarmed', async () => {
    arm(board);
    let call = 0;
    const spawnProbe = () => (call++ === 0 ? armedProbe() : hookOk());
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(true);
    expect(existsSync(sentinelPaths(board).active)).toBe(true); // re-armed for the night
  });

  it('aborts when the guard does NOT block while armed', async () => {
    arm(board);
    const spawnProbe = () => Promise.resolve({ code: 0, out: 'RAN', capped: false });
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/did not block/i);
  });

  // Without this half, a guard that blocks unconditionally would pass the pre-flight and prove
  // nothing about whether it discriminates.
  it('aborts when the guard is stuck on — blocking with no run active', async () => {
    arm(board);
    let call = 0;
    const spawnProbe = () => (call++ === 0 ? armedProbe() : Promise.resolve({ code: 2, out: '', capped: false }));
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/stuck on, or the launcher itself failed to load/i);
  });

  // The disarmed half hands the launcher an ABSENT sentinel path, so it never reads the real gate:
  // both halves run beside another live run, and neither run's claim moves (review, CONFIRMED —
  // the first draft disarmed and re-armed around the probe for nothing, then skipped it for nothing).
  it('probes both halves beside another live run, and moves nobody’s claim', async () => {
    claimSentinel(board, { pid: 4242, alive: () => true });
    arm(board, { pid: 99 });
    const seen = [];
    let call = 0;
    const spawnProbe = (cmd, args) => { seen.push(args); return call++ === 0 ? armedProbe() : hookOk(); };
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(true);
    expect(res.disarmed).toEqual({ code: 0, out: '' });
    expect(seen[1].at(-1)).toMatch(/NOT-THERE$/); // the probe's sentinel is the absent path, not ours
    expect([...readClaims(board).pids].sort()).toEqual([4242, 99].sort());
  });

  // An entry that is not a claim is swept by nobody, so once every run ends it alone keeps the gate
  // armed for every session on the machine. Refused first, by name, before a live model is spent.
  it('refuses, naming the entry, when the claims directory holds something that is not a claim', async () => {
    mkdirSync(sentinelPaths(board).active, { recursive: true });
    writeFileSync(join(sentinelPaths(board).active, '.DS_Store'), '');
    arm(board, { pid: 99 });
    const calls = [];
    const spawnProbe = () => { calls.push(1); return armedProbe(); };
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/"\.DS_Store" .* is not a claim/);
    expect(calls).toEqual([]);
  });

  // The sentinel is claimed before the probes run, so a hung probe parks the night with every merge
  // blocked and no ticket run (review, MEDIUM).
  it.each([0, 1])('aborts when probe %i times out rather than hanging the night', async (which) => {
    arm(board);
    let call = 0;
    const spawnProbe = () => {
      const capped = call++ === which;
      return Promise.resolve({ code: 0, out: capped ? '' : 'BLOCKED', capped });
    };
    const res = await preflightGuard(board, { spawnProbe });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/timed out/i);
  });

  it('passes a timeout to both probes, so neither can hang unbounded', async () => {
    arm(board);
    const seen = [];
    let call = 0;
    const spawnProbe = (cmd, args, o) => { seen.push(o); return call++ === 0 ? armedProbe() : hookOk(); };
    await preflightGuard(board, { spawnProbe });
    expect(seen.every((o) => typeof o?.capMs === 'number' && o.capMs > 0)).toBe(true);
  });

  // The disarmed half must drive the SAME command shape the armed half is refused. With no stdin the
  // launcher never reaches its merge branch, so it exits 0 whatever the gate would do to a merge —
  // measured 2026-09-03, and the reason the payload is passed explicitly rather than left empty.
  it('drives the disarmed probe with a merge-shaped payload on stdin', async () => {
    arm(board);
    const seen = [];
    let call = 0;
    const spawnProbe = (cmd, args, o) => {
      seen.push({ cmd, args, opts: o });
      return call++ === 0 ? armedProbe() : hookOk();
    };
    await preflightGuard(board, { spawnProbe });
    expect(seen[1].opts?.input).toBe(MERGE_PROBE_PAYLOAD);
    expect(JSON.parse(seen[1].opts.input).tool_input.command).toMatch(/^gh pr merge /);
  });
});

describe('sessionArgs — what each ticket is actually driven with', () => {
  // The literal spellings CLAUDE.md pins: auto-pr is the level the queue is authorized for, and
  // anything looser would cross the merge gate the whole design rests on.
  it('runs the skill at --gates auto-pr for the named ticket', () => {
    expect(sessionArgs(A).at(-1)).toBe(`/hardpack-workflow --gates auto-pr ${A}`);
  });
});

// tkt-c4743331eb03 — a sub-session that finds `.night-run/ACTIVE`, resolves the pid, and sees this
// ticket's id in its argv reads its own PARENT as a competing session and hard-stops. Nothing in the
// repo distinguishes the two: the sentinel, the argv and the growing live log look identical from
// inside the child. The discriminator has to be handed down by the runner, which is what this is.
describe('sessionEnv — how a night child knows the runner it found is its own', () => {
  it('names the ticket this session was spawned for', () => {
    expect(sessionEnv(A).NIGHT_RUN_TICKET).toBe(A);
  });

  it('names the runner pid, so the ACTIVE sentinel can be matched against it', () => {
    expect(sessionEnv(A).NIGHT_RUN_PID).toBe(String(process.pid));
  });

  // The dimension that decides whether this is a self-check or a blanket excuse. A night child
  // working B that stumbles on A's artifacts is looking at a REAL competitor, and the variable has
  // to distinguish that case rather than reading "a night run is active" as "it is me".
  it('names only its OWN ticket, so a sibling ticket still reads as a competitor', () => {
    expect(sessionEnv(B).NIGHT_RUN_TICKET).toBe(B);
    expect(sessionEnv(B).NIGHT_RUN_TICKET).not.toBe(A);
  });

  it('carries the inherited environment through, rather than replacing it', () => {
    expect(sessionEnv(A, { env: { PATH: '/usr/bin', HOME: '/home/x' } })).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/x',
    });
  });

  // An explicit pid is what lets the test above assert a value rather than re-deriving it, and what
  // lets a caller identify the runner when it is not this process.
  it('takes an explicit pid over the current process', () => {
    expect(sessionEnv(A, { pid: 4242 }).NIGHT_RUN_PID).toBe('4242');
  });

  // The helper and the passthrough were both green with the runner wiring them to nothing: the
  // `env` line could be deleted outright and all 92 tests still passed. This is the case that fails.
  it('is what the runner actually drives each per-ticket session with', async () => {
    let seen;
    const exec = (_cmd, _args, opts) => { seen = opts; return Promise.resolve({ code: 0, out: '', capped: false }); };
    await defaultRunSession(A, { capMs: 1000, exec, cwd: '/wt/night-x', boardDir: '/board' });
    expect(seen.env.NIGHT_RUN_TICKET).toBe(A);
    expect(seen.env.NIGHT_RUN_PID).toBe(String(process.pid));
    expect(seen.cwd).toBe('/wt/night-x');
    expect(seen.env.BOARD_DIR_OVERRIDE).toBe('/board');
  });

  // The session works in a worktree, where `tickets/` does not exist; without this the board tools
  // resolve an empty board from cwd and every status reads null (tkt-c248cfbc5d8c).
  it('points the board tools at the board when told where it is, and adds nothing otherwise', () => {
    expect(sessionEnv(A, { env: {}, boardDir: '/board' }).BOARD_DIR_OVERRIDE).toBe('/board');
    expect('BOARD_DIR_OVERRIDE' in sessionEnv(A, { env: {} })).toBe(false);
  });

  // Driven through `main` with NO runSession override, so the DEFAULT binding is under test: the case
  // above stays green if `main` stops reaching defaultRunSession at all, and then no session gets an id.
  it('reaches each queued ticket through main default session runner', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const seen = [];
    const exec = (_cmd, _args, o) => {
      seen.push(o.env.NIGHT_RUN_TICKET);
      return Promise.resolve({ code: 0, out: '', capped: false });
    };
    await main([A, B], board, opts({ spawnProbe: passingProbe(), exec }));
    expect(seen).toEqual([A, B]);
  });
});

describe('main — dimensions 5 and 6: the queue and the STOP file', () => {
  it('an empty queue is a usage error, never a silent success', async () => {
    expect(await main([], board, opts())).toBe(EXIT.usage);
  });

  it('a malformed ticket id is a usage error rather than being skipped in silence', async () => {
    expect(await main(['tkt-nope'], board, opts())).toBe(EXIT.usage);
  });

  it('an unreadable CAP_SECONDS is a usage error, not a run with no cap', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const code = await main([A], board, opts({ env: { CAP_SECONDS: 'abc' }, runSession }));
    expect(code).toBe(EXIT.usage);
    expect(runSession.calls).toEqual([]);
  });

  // The runner must write the sentinel where the GUARD reads it; if that root cannot be resolved it
  // must not fall back to somewhere the guard never looks (review, MEDIUM).
  it('aborts when the primary checkout cannot be located', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const code = await main([A], board, opts({ resolveSentinelRoot: () => null, runSession }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
  });

  it('a failing pre-flight aborts before any ticket runs, and clears the sentinel', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const spawnProbe = () => Promise.resolve({ code: 0, out: 'RAN', capped: false });
    const code = await main([A], board, opts({ spawnProbe, runSession }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
    expect(readStatus(board, A)).toBe('todo'); // untouched
  });

  // Dimension 6, "many": the control for every stopping case below.
  it('runs every ticket in the queue when each one opens a PR, and exits 0', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub();
    expect(await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A, B]);
  });

  // The verdict was honest on stdout while the EXIT STATUS said success, so `npm run night ||
  // notify-me` never fired on the one outcome it exists for (review, HIGH).
  it('exits with the ALARM code when a ticket reaches done', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: 'done' } });
    const code = await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.alarm);
    expect(runSession.calls).toEqual([A]);
  });

  it('exits with the stopped code when a ticket halts mid-ticket', async () => {
    seed(A, 'todo');
    const runSession = sessionStub({ [A]: { status: 'in-progress' } });
    expect(await main([A], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.stopped);
  });

  it('exits with the stopped code when a cap lands mid-ticket', async () => {
    seed(A, 'todo');
    const runSession = sessionStub({ [A]: { status: 'in-progress', capped: true } });
    expect(await main([A], board, opts({ spawnProbe: passingProbe(), runSession }))).toBe(EXIT.stopped);
  });

  // The regression, end to end: the cap fired after PR-open and every ticket behind it was dropped
  // and relaunched by hand (tkt-92360b0e2079, 2026-09-08). B must still be driven.
  it('runs the rest of the queue when a cap lands after the ticket reached qa', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: 'qa', capped: true }, [B]: { status: 'qa' } });
    const code = await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A, B]);
  });

  // `claude` off PATH resolves {code:-1} per ticket, which read as "never started" and marched
  // through the whole queue in silence, then exited 0 (review, MEDIUM).
  it('stops the queue when a session cannot be started at all', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: null, code: -1, log: 'ENOENT claude' } });
    const code = await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.stopped);
    expect(runSession.calls).toEqual([A]);
  });

  it('stops after two tickets in a row never start, rather than burning the queue', async () => {
    for (const id of [A, B, C]) seed(id, 'todo');
    const runSession = sessionStub({ [A]: { status: null }, [B]: { status: null }, [C]: { status: null } });
    const code = await main([A, B, C], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(code).toBe(EXIT.stopped);
    expect(runSession.calls).toEqual([A, B]);
  });

  // A STOP found before ANY ticket was never addressed to this run, and a night that ran nothing is
  // not a clean night (tkt-c248cfbc5d8c) — under concurrency this is another live run's stop still
  // in force, so `night:start` must read it as a non-start rather than exit 0.
  it('a STOP file present up front runs nothing, prints no verdict line, and exits stopped', async () => {
    seed(A, 'todo');
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(sentinelPaths(board).stop, '');
    const runSession = sessionStub();
    let code;
    const out = await captureStdout(async () => { code = await main([A], board, opts({ spawnProbe: passingProbe(), runSession })); });
    expect(code).toBe(EXIT.stopped);
    expect(runSession.calls).toEqual([]);
    expect(out).toMatch(/STOP file present before any ticket — a stop is in force \(no other run is live/);
    expect(out).not.toMatch(/^pre-flight: /m); // `night:start` must not read this as a started night
    expect(existsSync(sentinelPaths(board).stop)).toBe(false); // swept: nobody else was live
    expect(latestSummary().exit).toBe(EXIT.stopped);
  });

  it('a STOP file present up front names the live run that has not consumed it, and leaves it', async () => {
    seed(A, 'todo');
    mkdirSync(sentinelPaths(board).active, { recursive: true });
    writeFileSync(claimPath(board, 424242), '424242\n');
    writeFileSync(sentinelPaths(board).stop, '');
    const out = await captureStdout(() => main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub(), alive: (p) => p === process.pid || p === 424242 })));
    expect(out).toMatch(/another live run has not consumed it yet/);
    expect(existsSync(sentinelPaths(board).stop)).toBe(true);
  });

  // Dimension 5's third case: the STOP file appears while a ticket is running. It must not kill the
  // ticket in flight — A completes — and must stop the queue before B.
  it('a STOP file appearing mid-queue lets the running ticket finish and stops before the next', async () => {
    seed(A, 'todo');
    seed(B, 'todo');
    const runSession = sessionStub({ [A]: { status: 'qa', thenStop: true } });
    await main([A, B], board, opts({ spawnProbe: passingProbe(), runSession }));
    expect(runSession.calls).toEqual([A]);
    expect(readStatus(board, A)).toBe('qa'); // finished, not killed
  });

  it('clears the sentinel on a normal exit', async () => {
    seed(A, 'todo');
    await main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub() }));
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
  });

  // Another run, live by the injected liveness — the same seam night-control uses, since a pid the
  // test does not own is not something it can keep alive.
  const OTHER = 424242;
  const withOther = () => (p) => p === process.pid || p === OTHER;

  // The single-owner sentinel refused here. Now the run starts alongside, and the other run's claim
  // is exactly where it was when this one leaves (tkt-c248cfbc5d8c).
  it('starts alongside another live runner and leaves its claim in place', async () => {
    seed(A, 'todo');
    mkdirSync(sentinelPaths(board).active, { recursive: true });
    writeFileSync(claimPath(board, OTHER), `${OTHER}\n`);
    const runSession = sessionStub();
    const code = await main([A], board, opts({ spawnProbe: passingProbe(), runSession, alive: withOther() }));
    expect(code).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A]);
    expect(readClaims(board).pids).toEqual([OTHER]);
  });

  // The review's confirmed finding, driven through main's DEFAULT liveness with a real process: the
  // claim's pid is alive — a node child parked on a timer — but it is not a night run, so it is
  // swept and it holds neither the gate nor the STOP. Injecting `alive` would leave the default
  // unpinned, which is how the hole passed nine green tests.
  it('sweeps a claim whose pid was reused by a live process that is not a night run, by default', async () => {
    seed(A, 'todo');
    const stranger = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
    try {
      await waitFor(() => pidAlive(stranger.pid));
      mkdirSync(sentinelPaths(board).active, { recursive: true });
      writeFileSync(claimPath(board, stranger.pid), `${stranger.pid}\n`);
      const runSession = sessionStub({ [A]: { status: 'qa', thenStop: true } });
      const out = await captureStdout(() => main([A], board, opts({ spawnProbe: passingProbe(), runSession })));
      expect(out).toMatch(new RegExp(`swept stale claim\\(s\\) left by dead pid\\(s\\) ${stranger.pid}`));
      expect(out).toMatch(/arms and disarms correctly/); // both halves probed: no live RUN beside us
      expect(existsSync(sentinelPaths(board).stop)).toBe(false); // and STOP was not held for it
    } finally {
      stranger.kill('SIGKILL');
    }
  });

  // The control for the case above: the same claim, dead, is swept on the way in.
  it('sweeps another runner’s claim when that runner is gone', async () => {
    seed(A, 'todo');
    mkdirSync(sentinelPaths(board).active, { recursive: true });
    writeFileSync(claimPath(board, OTHER), `${OTHER}\n`);
    const out = await captureStdout(() => main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub(), alive: (p) => p === process.pid })));
    expect(out).toMatch(new RegExp(`swept stale claim\\(s\\) left by dead pid\\(s\\) ${OTHER}`));
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
  });

  it('refuses to start while an older single-owner runner holds the sentinel', async () => {
    seed(A, 'todo');
    mkdirSync(join(board, '.night-run'), { recursive: true });
    writeFileSync(sentinelPaths(board).active, `${OTHER}\n`);
    const runSession = sessionStub();
    const code = await main([A], board, opts({ spawnProbe: passingProbe(), runSession, alive: withOther() }));
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
    expect(readFileSync(sentinelPaths(board).active, 'utf8').trim()).toBe(String(OTHER));
  });

  // STOP is one file read by every run. Swept by the first run out, a stop meant for both would end
  // one and be lost on the other: the last LIVE runner out is the one that sweeps it.
  it('leaves a STOP in place for a run that is still live, and sweeps it as the last one out', async () => {
    seed(A, 'todo');
    mkdirSync(sentinelPaths(board).active, { recursive: true });
    writeFileSync(claimPath(board, OTHER), `${OTHER}\n`);
    const runSession = sessionStub({ [A]: { status: 'qa', thenStop: true } });
    await main([A], board, opts({ spawnProbe: passingProbe(), runSession, alive: withOther() }));
    expect(existsSync(sentinelPaths(board).stop)).toBe(true); // the other run has not seen it yet
    rmSync(claimPath(board, OTHER)); // ...and now that run is gone
    seed(B, 'todo');
    await main([B], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub() }));
    expect(existsSync(sentinelPaths(board).stop)).toBe(false);
  });

  it('hands every session the run’s worktree as cwd and the board as the override', async () => {
    seed(A, 'todo');
    const seen = [];
    const runSession = (id, o) => { seen.push(o); seed(id, 'qa'); return Promise.resolve({ code: 0, out: '', capped: false }); };
    let made;
    const createWorktree = (root, stamp) => { made = fakeWorktree(root, stamp); return made; };
    await main([A], board, opts({ spawnProbe: passingProbe(), runSession, createWorktree }));
    expect(seen[0].cwd).toBe(made.path);
    expect(seen[0].boardDir).toBe(board);
  });

  // Before the verdict line, so `night:start` reads it as the pre-flight failure it is rather than a
  // run that passed and then died.
  it('a worktree that cannot be made is a pre-flight failure, before any ticket and before the verdict line', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    let code;
    const out = await captureStdout(async () => {
      code = await main([A], board, opts({ spawnProbe: passingProbe(), runSession, createWorktree: () => ({ ok: false, why: 'no origin' }) }));
    });
    expect(code).toBe(EXIT.preflight);
    expect(runSession.calls).toEqual([]);
    expect(out).not.toMatch(/^pre-flight: /m);
    expect(existsSync(sentinelPaths(board).active)).toBe(false);
    expect(latestSummary().exit).toBe(EXIT.preflight);
  });

  it('records the worktree in summary.json, and KEEPS one that is not clean by name', async () => {
    seed(A, 'todo');
    const kept = { removed: false, why: 'it is not clean: ?? scratch.txt' };
    const out = await captureStdout(() => main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub(), removeWorktree: () => kept })));
    expect(out).toMatch(/worktree KEPT at .* — it is not clean: \?\? scratch\.txt/);
    expect(latestSummary().worktree).toMatchObject({ removed: false, why: kept.why });
    expect(typeof latestSummary().worktree.path).toBe('string');
  });

  it('records a removed worktree as removed', async () => {
    seed(A, 'todo');
    const out = await captureStdout(() => main([A], board, opts({ spawnProbe: passingProbe(), runSession: sessionStub() })));
    expect(out).toMatch(/worktree removed: /);
    expect(latestSummary().worktree).toMatchObject({ removed: true });
  });

  it('exports a usage string that names the npm entrypoint', () => {
    expect(USAGE).toContain('npm run night');
  });
});

// tkt-c248cfbc5d8c — the isolation itself, against real git rather than a stub. Fixtures live INSIDE
// the repo (`.tmp-test`, gitignored): no suite may write outside the workspace.
describe('the run’s worktree — one per run, against real git', () => {
  const FIXTURES = join(here, '..', '.tmp-test');
  let base;
  let primary;
  let origin;
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const seedRepo = (dir) => {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 'T');
  };

  beforeEach(() => {
    mkdirSync(FIXTURES, { recursive: true });
    base = mkdtempSync(join(FIXTURES, 'night-wt-'));
    primary = join(base, 'primary');
    origin = join(base, 'origin.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
    seedRepo(primary);
    // `.claude/worktrees` ignored as in the real repo: that is what blinds the porcelain to a nested one.
    writeFileSync(join(primary, '.gitignore'), 'node_modules\n.env\nrepos.local.json\n.claude/worktrees\n');
    mkdirSync(join(primary, '.claude', 'skills', 'hardpack-workflow'), { recursive: true });
    writeFileSync(join(primary, '.claude', 'keep'), '');
    writeFileSync(join(primary, '.claude', 'skills', 'hardpack-workflow', 'SKILL.md'), '# skill\n');
    git(primary, 'add', '.gitignore', '.claude/keep', '.claude/skills/hardpack-workflow/SKILL.md');
    git(primary, 'commit', '-qm', 'init');
    git(primary, 'remote', 'add', 'origin', origin);
    git(primary, 'push', '-q', 'origin', 'main');
    mkdirSync(join(primary, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(primary, 'node_modules', 'pkg', 'index.js'), 'ok');
    writeFileSync(join(primary, '.env'), 'X=1\n');
    writeFileSync(join(primary, '.claude', 'settings.local.json'), '{}');
    writeFileSync(join(primary, '.claude', 'skills', 'hardpack-workflow', 'repos.local.json'), '{"baseDir":"/x"}');
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  // The repo map is the one every session reads first: SKILL.md §1 resolves it under
  // CLAUDE_PROJECT_DIR — the worktree — and hard-stops without it (review, CONFIRMED: the first
  // draft left it out, and every session of the first night would have stopped before its ticket).
  it('creates it detached at origin/main, links node_modules, and copies the gitignored config in — the skill’s repo map included', () => {
    const made = createRunWorktree(primary, 'stamp');
    expect(made.ok).toBe(true);
    expect(made.path).toBe(runWorktreePath(primary, 'stamp'));
    expect(git(made.path, 'rev-parse', 'HEAD').trim()).toBe(git(primary, 'rev-parse', 'origin/main').trim());
    expect(git(made.path, 'rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('HEAD'); // detached
    expect(lstatSync(join(made.path, 'node_modules')).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(made.path, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('ok');
    expect(readFileSync(join(made.path, '.env'), 'utf8')).toBe('X=1\n');
    expect(existsSync(join(made.path, '.claude', 'settings.local.json'))).toBe(true);
    expect(readFileSync(join(made.path, '.claude', 'skills', 'hardpack-workflow', 'repos.local.json'), 'utf8')).toBe('{"baseDir":"/x"}');
  });

  // `.claude/worktrees` is gitignored, so a session that took EnterWorktree from inside leaves work
  // the porcelain cannot see; `git worktree remove` would delete it (review, PLAUSIBLE — measured).
  it('keeps a worktree that holds a nested worktree, whose uncommitted work the porcelain cannot see', () => {
    const made = createRunWorktree(primary, 'stamp');
    const inner = join(made.path, '.claude', 'worktrees', 'inner');
    git(made.path, 'worktree', 'add', '-q', '--detach', inner, 'HEAD');
    writeFileSync(join(inner, 'half-done.txt'), 'uncommitted');
    // The control: porcelain is blind to it. (Not asserted empty — the copied settings file is
    // untracked and shows here on CI, where no global ignore hides it; it is filtered as ours.)
    expect(git(made.path, 'status', '--porcelain')).not.toMatch(/worktrees|half-done/);
    const res = removeRunWorktree(primary, made);
    expect(res.removed).toBe(false);
    expect(res.why).toMatch(/nested worktree/);
    expect(existsSync(join(inner, 'half-done.txt'))).toBe(true);
  });

  // The fetch is real: a commit that reached origin after the primary last looked is where the
  // worktree starts, so a night's PRs are cut from what origin has now.
  it('fetches first, so the worktree starts from origin’s tip and not the primary’s stale view', () => {
    const other = join(base, 'other');
    execFileSync('git', ['clone', '-q', origin, other]);
    git(other, 'config', 'user.email', 't@example.com');
    git(other, 'config', 'user.name', 'T');
    writeFileSync(join(other, 'later.txt'), 'x');
    git(other, 'add', 'later.txt');
    git(other, 'commit', '-qm', 'later');
    git(other, 'push', '-q', 'origin', 'main');
    const stale = git(primary, 'rev-parse', 'origin/main').trim();
    const made = createRunWorktree(primary, 'stamp');
    expect(made.ok).toBe(true);
    const head = git(made.path, 'rev-parse', 'HEAD').trim();
    expect(head).toBe(git(other, 'rev-parse', 'HEAD').trim());
    expect(head).not.toBe(stale);
  });

  // The removal must not follow the link: the primary's node_modules is the whole machine's install,
  // and the settings copy is untracked, so it must read as ours rather than as dirt.
  it('removes a clean worktree and never follows the node_modules link into the primary', () => {
    const made = createRunWorktree(primary, 'stamp');
    expect(removeRunWorktree(primary, made)).toEqual({ removed: true });
    expect(existsSync(made.path)).toBe(false);
    expect(readFileSync(join(primary, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe('ok');
    expect(git(primary, 'worktree', 'list')).not.toContain('night-stamp');
  });

  it('keeps a worktree that is not clean, names why, and leaves its provisioned files for the human', () => {
    const made = createRunWorktree(primary, 'stamp');
    writeFileSync(join(made.path, 'scratch.txt'), 'a halted ticket left this');
    const res = removeRunWorktree(primary, made);
    expect(res.removed).toBe(false);
    expect(res.why).toMatch(/not clean/);
    expect(res.why).toMatch(/scratch\.txt/);
    expect(existsSync(made.path)).toBe(true);
    expect(existsSync(join(made.path, '.env'))).toBe(true);
  });

  it('refuses, leaving nothing behind, when origin/main cannot be fetched', () => {
    git(primary, 'remote', 'remove', 'origin');
    const res = createRunWorktree(primary, 'stamp');
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/fetch/);
    expect(existsSync(runWorktreePath(primary, 'stamp'))).toBe(false);
  });
});

// tkt-a761e990190d — the probes' output is the only evidence of what a live model and the real hook
// actually did, and `guardBlocked`'s reading of it gates the whole night. It used to be discarded on
// the passing path and absent from every failing path's message, so neither a green night nor an
// aborted one could say what was replied. One case per RETURN PATH, because a suite that samples two
// of four cannot report the absence of evidence on the other two (review, LOW/MEDIUM).
describe('the pre-flight records what each probe actually said', () => {
  const BLOCKED = () => ({ code: 0, out: 'BLOCKED', capped: false });
  const hookOk = () => ({ code: 0, out: '', capped: false });
  const seq = (...rs) => { let i = 0; return () => Promise.resolve(rs[Math.min(i++, rs.length - 1)]); };

  const probeLogs = () => {
    const dir = join(board, '.night-run');
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .map((d) => join(dir, d, 'preflight-probes.log'))
      .filter((f) => existsSync(f));
  };

  const captureStderr = async (fn) => {
    const orig = process.stderr.write.bind(process.stderr);
    let buf = '';
    process.stderr.write = (chunk) => { buf += chunk; return true; };
    try { await fn(); } finally { process.stderr.write = orig; }
    return buf;
  };

  // --- renderProbes: the labelling itself.
  it('labels each probe, and writes an explicit marker rather than nothing', () => {
    const out = renderProbes({ armedOut: '', disarmed: { code: 2, out: '' } });
    expect(out).toMatch(/armed probe/);
    expect(out).toMatch(/disarmed probe/);
    expect(out).toMatch(/exit 2/);
    expect(out.match(/\(no output\)/g)).toHaveLength(2); // never a silent empty section
  });

  it('omits the disarmed section entirely when that half never ran', () => {
    expect(renderProbes({ armedOut: 'BLOCKED' })).not.toMatch(/disarmed probe/);
  });

  // --- preflightGuard: all four return paths carry evidence.
  it('return path 1 — passing: carries both probes', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq(BLOCKED(), hookOk()) });
    expect(res.ok).toBe(true);
    expect(res.armedOut).toBe('BLOCKED');
    expect(res.disarmed).toEqual({ code: 0, out: '' });
  });

  // The ticket's own worked example: prose CONTAINING the word is refused by the tightened matcher,
  // and the refusal must carry the words that caused it.
  it('return path 2 — refused: carries the reply that failed the matcher', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq({ code: 0, out: 'The command was BLOCKED.', capped: false }) });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/did not block/i);
    expect(res.armedOut).toBe('The command was BLOCKED.');
  });

  it('return path 3 — disarmed half timed out: carries the DISARMED probe, not just the armed one', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq(BLOCKED(), { code: null, out: 'hung', capped: true }) });
    expect(res.ok).toBe(false);
    expect(res.disarmed).toEqual({ code: null, out: 'hung' });
  });

  // Finding 1: on this path the ARMED reply is a clean BLOCKED from the half that worked, so
  // reporting only it points the reader at the wrong probe. `off.out` is what separates "stuck on"
  // from "the launcher failed to load" — the two readings the message itself admits it cannot tell.
  it('return path 4 — guard stuck on / launcher broken: carries the output that separates the two', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq(BLOCKED(), { code: 2, out: 'ERR_MODULE_NOT_FOUND', capped: false }) });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/stuck on, or the launcher/);
    expect(res.disarmed).toEqual({ code: 2, out: 'ERR_MODULE_NOT_FOUND' });
  });

  it('an armed probe that timed out still carries whatever it emitted', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq({ code: null, out: 'half a rep', capped: true }) });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/timed out/);
    expect(res.armedOut).toBe('half a rep');
  });

  // Finding 2: `run` resolves a spawn failure as code -1 with the OS error in `out`. Read as a model
  // reply it fails guardBlocked and the night reports a broken GUARD — accusing something that was
  // never exercised. `claude` off PATH is the likely cause.
  it('a probe that could not be spawned is named as such, not blamed on the guard', async () => {
    arm(board);
    const res = await preflightGuard(board, { spawnProbe: seq({ code: -1, out: 'Error: spawn claude ENOENT', capped: false }) });
    expect(res.ok).toBe(false);
    expect(res.why).toMatch(/could not be started/);
    expect(res.why).toMatch(/ENOENT/);
    expect(res.why).not.toMatch(/did not block/);
  });

  // --- main: the artifact and the message.
  it('saves the report on a PASSING pre-flight, where nothing previously kept it', async () => {
    seed(A, 'todo');
    const code = await main([A], board, opts({ spawnProbe: seq(BLOCKED(), hookOk()), runSession: sessionStub() }));
    expect(code).toBe(EXIT.ok);
    expect(probeLogs()).toHaveLength(1);
    expect(readFileSync(probeLogs()[0], 'utf8')).toMatch(/armed probe[\s\S]*BLOCKED/);
  });

  it('inlines the report in the abort message, and keeps it on disk', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const spawnProbe = seq({ code: 0, out: 'I ran it and it RAN.', capped: false });
    let code;
    const err = await captureStderr(async () => { code = await main([A], board, opts({ spawnProbe, runSession })); });
    expect(code).toBe(EXIT.preflight);
    expect(err).toContain('I ran it and it RAN.');
    expect(runSession.calls).toEqual([]);
    expect(readFileSync(probeLogs()[0], 'utf8')).toContain('I ran it and it RAN.');
  });

  it('shows the DISARMED probe in the abort message when that is the half that failed', async () => {
    seed(A, 'todo');
    const spawnProbe = seq(BLOCKED(), { code: 2, out: 'ERR_MODULE_NOT_FOUND', capped: false });
    let code;
    const err = await captureStderr(async () => { code = await main([A], board, opts({ spawnProbe, runSession: sessionStub() })); });
    expect(code).toBe(EXIT.preflight);
    expect(err).toMatch(/disarmed probe/);
    expect(err).toContain('ERR_MODULE_NOT_FOUND');
  });

  // Finding 3: the save sits ahead of the abort message, so an unguarded throw here would replace a
  // loud verdict with an unhandled rejection — the finally has already dropped the crash handler.
  it('a failed save never swallows the abort it is evidence for', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const writeProbeLog = () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); };
    let code;
    const err = await captureStderr(async () => {
      code = await main([A], board, opts({ spawnProbe: seq({ code: 0, out: 'RAN', capped: false }), runSession, writeProbeLog }));
    });
    expect(code).toBe(EXIT.preflight);
    expect(err).toMatch(/pre-flight FAILED/);
    expect(err).toMatch(/NOT SAVED \(ENOSPC\)/);
    expect(existsSync(sentinelPaths(board).active)).toBe(false); // still cleaned up
  });

  it('a failed save does not abort a night whose gate is fine', async () => {
    seed(A, 'todo');
    const runSession = sessionStub();
    const writeProbeLog = () => { throw new Error('nope'); };
    const code = await main([A], board, opts({ spawnProbe: seq(BLOCKED(), hookOk()), runSession, writeProbeLog }));
    expect(code).toBe(EXIT.ok);
    expect(runSession.calls).toEqual([A]);
  });
});
