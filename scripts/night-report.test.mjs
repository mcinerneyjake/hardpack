import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseArgs, jsonOr, resolveOwner, renderTicket, EXIT, REPORT_USAGE } from './night-report.mjs';

// Fixtures inside the repo, never os.tmpdir(): no suite writes outside the workspace.
const FIXTURES = join(dirname(dirname(fileURLToPath(import.meta.url))), '.tmp-test');

const ID = 'tkt-aaaaaaaaaaaa';
let root;

function sink() {
  const chunks = [];
  return { write: (t) => chunks.push(t), get text() { return chunks.join(''); } };
}

function seedOutstanding(status = 'qa') {
  const dir = join(root, '.night-run', '2026-09-03T01-00-00-000Z');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'summary.json'),
    JSON.stringify({
      startedAt: 'x',
      queue: [ID],
      results: [{ id: ID, before: 'todo', after: 'qa', level: 'ok', text: 'PR open, awaiting your merge' }],
      exit: 0,
    }),
  );
  mkdirSync(join(root, 'tickets'), { recursive: true });
  writeFileSync(join(root, 'tickets', `${ID}.md`), `---\nid: ${ID}\nstatus: ${status}\n---\n\nbody\n`);
}

// A gh double driven by the argv shape, so each test states only the responses it cares about.
function fakeGh(responses) {
  return (args) => {
    if (args[0] === 'repo') return responses.owner ?? { status: 0, stdout: 'someowner\n', stderr: '' };
    if (args[0] === 'search') return responses.search ?? { status: 0, stdout: '[]', stderr: '' };
    if (args[0] === 'pr') return responses.checks ?? { status: 0, stdout: '[]', stderr: '' };
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
}

const PR = {
  number: 83,
  url: 'https://example.invalid/pull/83',
  state: 'merged',
  title: 'Some title',
  repository: { nameWithOwner: 'someowner/other-repo' },
};

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'night-report-cli-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// `env: {}` pins the environment — the last uninjected input, and the one a night run reached
// through to turn `status: qa` into `status: UNREADABLE` (tkt-f55d1ce07347).
const runMain = (argv, responses, env = {}) => {
  const out = sink();
  const err = sink();
  const code = main(argv, { gh: fakeGh(responses ?? {}), resolveRoot: () => root, out, err, env });
  return { code, out: out.text, err: err.text };
};

// Set a real process-level variable for one test, and put it back however the test ends.
function withProcessEnv(vars, fn) {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    const result = fn();
    // An async callback would resolve AFTER the restore below, so the assertion would run with the
    // vars already gone and a later mutation could leak into a sibling test. Refuse, never restore
    // at the wrong time.
    if (typeof result?.then === 'function') {
      throw new TypeError('withProcessEnv needs a synchronous callback');
    }
    return result;
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('night:report', () => {
  it('prints verdict, status, PR identity and every check name with its conclusion', () => {
    seedOutstanding('qa');
    const { code, out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: {
        status: 0,
        stdout: JSON.stringify([
          { name: 'gate', state: 'SUCCESS', bucket: 'pass' },
          { name: 'branch-name', state: 'FAILURE', bucket: 'fail' },
        ]),
        stderr: '',
      },
    });

    expect(code).toBe(EXIT.ok);
    expect(out).toContain(`${ID}  status: qa`);
    expect(out).toContain('verdict (2026-09-03T01-00-00-000Z): ok');
    expect(out).toContain('someowner/other-repo#83 [merged]');
    expect(out).toContain('https://example.invalid/pull/83');
    expect(out).toContain('check gate: SUCCESS');
    expect(out).toContain('check branch-name: FAILURE');
  });

  // The whole reason this uses `gh search prs`: a rolled-up verdict is exactly what a disabled
  // workflow makes wrong, so no line may claim one.
  it('never prints a rolled-up green/red verdict', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 0, stdout: JSON.stringify([{ name: 'gate', state: 'SUCCESS', bucket: 'pass' }]), stderr: '' },
    });

    expect(out).not.toMatch(/\ball checks pass(ed|ing)?\b/i);
    expect(out).not.toMatch(/\bgreen\b/i);
    expect(out).not.toMatch(/\bready to merge\b/i);
  });

  it('calls it out when a PR reports no checks, rather than reading empty as green', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 0, stdout: '[]', stderr: '' },
    });

    expect(out).toContain('no checks reported');
    expect(out).toContain('disabled workflow contributes none');
  });

  it('reports a checks lookup that failed instead of dropping the PR', () => {
    seedOutstanding('qa');
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' },
      checks: { status: 1, stdout: '', stderr: 'no checks reported on the feat/x branch' },
    });

    expect(out).toContain('checks could NOT be listed');
    expect(out).toContain('no checks reported on the feat/x branch');
  });

  it('prints every full-text match, because not all of them are the ticket\'s PR', () => {
    seedOutstanding('qa');
    const other = { ...PR, number: 66, repository: { nameWithOwner: 'someowner/kanban' }, title: 'Mentions it' };
    const { out } = runMain([], {
      search: { status: 0, stdout: JSON.stringify([PR, other]), stderr: '' },
    });

    expect(out).toContain('2 PR(s) mention this id');
    expect(out).toContain('full-text search');
    expect(out).toContain('someowner/other-repo#83');
    expect(out).toContain('someowner/kanban#66');
  });

  it('does not read an empty search as proof that no PR exists', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 0, stdout: '[]', stderr: '' } });

    expect(out).toContain('not proof none exists');
  });

  it('reports a failed search rather than an empty result', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 1, stdout: '', stderr: 'gh: authentication required' } });

    expect(out).toContain('PR search FAILED');
    expect(out).toContain('authentication required');
    expect(out).not.toContain('not proof none exists');
  });

  it('still names the outstanding tickets when the owner cannot be resolved, and exits non-zero', () => {
    seedOutstanding('qa');
    const { code, out, err } = runMain([], { owner: { status: 1, stdout: '', stderr: 'gh: not logged in' } });

    expect(code).toBe(EXIT.unusable);
    expect(err).toContain('could not resolve the GitHub owner');
    expect(out).toContain(ID);
    expect(out).toContain('PR state NOT checked');
  });

  it('says plainly when nothing is outstanding', () => {
    const { code, out } = runMain([]);
    expect(code).toBe(EXIT.ok);
    expect(out).toContain('no night-run tickets are outstanding');
  });

  it('surfaces a run directory with no summary.json', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    const { out } = runMain([]);
    expect(out).toContain('NO summary.json');
    expect(out).toContain('2026-09-03T02-00-00-000Z');
  });

  it('warns that merges are blocked while a run is active', () => {
    mkdirSync(join(root, '.night-run'), { recursive: true });
    writeFileSync(join(root, '.night-run', 'ACTIVE'), '123');
    const { out } = runMain([]);
    expect(out).toContain('ACTIVE');
  });

  it('exits non-zero when the primary checkout cannot be located', () => {
    const out = sink();
    const err = sink();
    const code = main([], { gh: fakeGh({}), resolveRoot: () => null, out, err });
    expect(code).toBe(EXIT.unusable);
    expect(err.text).toContain('could not locate the primary checkout');
  });

  it('never offers to merge', () => {
    seedOutstanding('qa');
    const { out } = runMain([], { search: { status: 0, stdout: JSON.stringify([PR]), stderr: '' } });
    expect(out).toContain('does not merge');
    expect(out).not.toMatch(/gh pr merge --squash/);
  });
});

describe('night:report argument handling', () => {
  it('accepts an explicit owner and skips the lookup', () => {
    expect(resolveOwner(() => { throw new Error('gh must not be called'); }, 'given')).toEqual({ ok: true, owner: 'given' });
  });

  it('rejects an unknown argument and a valueless --owner', () => {
    expect(parseArgs(['--owner'])).toMatchObject({ ok: false });
    expect(parseArgs(['--nope'])).toMatchObject({ ok: false });
    expect(parseArgs(['--owner', 'x'])).toEqual({ ok: true, owner: 'x' });
    expect(parseArgs([])).toEqual({ ok: true, owner: null });
  });

  it('prints the usage on a bad argument', () => {
    const out = sink();
    const err = sink();
    expect(main(['--nope'], { gh: fakeGh({}), resolveRoot: () => root, out, err })).toBe(EXIT.usage);
    expect(err.text).toContain(REPORT_USAGE);
  });

  it('treats a non-array JSON body as a failure, not as an empty result', () => {
    expect(jsonOr({ status: 0, stdout: '{"not":"an array"}', stderr: '' })).toMatchObject({ ok: false });
    expect(jsonOr({ status: 0, stdout: '[]', stderr: '' })).toEqual({ ok: true, value: [] });
    expect(jsonOr({ status: -1, stdout: '', stderr: '' }).why).toContain('gh exited -1');
  });

  it('renders a ticket whose board status could not be read', () => {
    const lines = renderTicket({ id: ID, status: null, verdicts: [] }, { ok: true, matches: [] });
    expect(lines[0]).toContain('UNREADABLE on the board');
  });

  // tkt-c43474b393de. Parked work is UNPUSHED, so the PR search finds nothing and the report would
  // otherwise print "no PR mentions this id" with no hint that a branch is sitting there.
  it('names the branch of a ticket parked at the PR-open gate', () => {
    const verdicts = [{ stamp: 's', level: 'parked', text: 'parked', branch: 'feat/x-thing', repo: '/repos/hardpack-site' }];
    const lines = renderTicket({ id: ID, status: 'in-progress', verdicts }, { ok: true, matches: [] }).join('\n');

    expect(lines).toContain('feat/x-thing');
    expect(lines).toContain('/repos/hardpack-site');
    expect(lines).toContain('no PR');
  });

  // The control: an ordinary verdict carries no branch and must not grow a parked line.
  it('does not claim a parked branch for an ordinary verdict', () => {
    const verdicts = [{ stamp: 's', level: 'halt', text: 'stopped mid-ticket; needs a human' }];
    const lines = renderTicket({ id: ID, status: 'in-progress', verdicts }, { ok: true, matches: [] }).join('\n');

    expect(lines).not.toContain('parked on');
  });

  // Keyed on the LEVEL, not on the branch's presence: a branch recorded beside a STOPPING verdict had
  // this report calling the ticket parked while the SessionStart hook called it mid-ticket — two
  // reports contradicting each other over one ticket (review, low).
  it('does not call a stopping verdict parked merely because a branch was recorded', () => {
    const verdicts = [{ stamp: 's', level: 'note', text: 'no status before the run', branch: 'feat/x', repo: '/r' }];
    const lines = renderTicket({ id: ID, status: 'in-progress', verdicts }, { ok: true, matches: [] }).join('\n');

    expect(lines).not.toContain('parked on');
  });
});

describe('night:report never reports a scan it could not complete as clean', () => {
  it('exits non-zero and refuses the "nothing outstanding" claim when a run dir has no summary', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    const { code, out } = runMain([]);

    expect(code, 'an incomplete scan exited 0, the permissive answer').toBe(EXIT.unusable);
    expect(out).toContain('this is not a clean board');
    expect(out).not.toContain('no night-run tickets are outstanding');
  });

  it('exits non-zero when `.night-run/` itself cannot be read', () => {
    writeFileSync(join(root, '.night-run'), 'not a directory');
    const { code, out } = runMain([]);

    expect(code).toBe(EXIT.unusable);
    expect(out).toContain('could not be read');
    expect(out).not.toContain('no night-run tickets are outstanding');
  });

  it('still exits 0 on a genuinely clean, complete scan', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    writeFileSync(
      join(root, '.night-run', '2026-09-03T02-00-00-000Z', 'summary.json'),
      JSON.stringify({ startedAt: 'x', queue: [], results: [], exit: 0 }),
    );
    const { code, out } = runMain([]);

    expect(code, 'a complete scan with nothing outstanding must stay exit 0').toBe(EXIT.ok);
    expect(out).toContain('no night-run tickets are outstanding');
  });

  it('reports a run that died before recording an exit code', () => {
    mkdirSync(join(root, '.night-run', '2026-09-03T02-00-00-000Z'), { recursive: true });
    writeFileSync(
      join(root, '.night-run', '2026-09-03T02-00-00-000Z', 'summary.json'),
      JSON.stringify({ startedAt: 'x', queue: [], results: [], exit: null }),
    );
    const { code, out } = runMain([]);

    expect(code).toBe(EXIT.unusable);
    expect(out).toContain('no exit code recorded');
  });
});

// Both directions, or the option would be dead code that only looks like isolation: the ambient
// environment must not reach `main`, and the injected one must (tkt-f55d1ce07347).
describe('the board directory comes from the injected env, never the ambient one', () => {
  it('ignores an ambient BOARD_DIR_OVERRIDE — the night-run failure, reproduced', () => {
    seedOutstanding('qa');
    const elsewhere = mkdtempSync(join(FIXTURES, 'night-report-foreign-board-'));
    try {
      const { out } = withProcessEnv({ BOARD_DIR_OVERRIDE: elsewhere }, () =>
        runMain([], { search: { status: 0, stdout: '[]', stderr: '' } }),
      );
      expect(out).toContain(`${ID}  status: qa`);
      expect(out).not.toContain('UNREADABLE');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('ignores an ambient TICKETS_DIR_OVERRIDE, which leaks by the same route', () => {
    seedOutstanding('qa');
    const elsewhere = mkdtempSync(join(FIXTURES, 'night-report-foreign-tickets-'));
    try {
      const { out } = withProcessEnv({ TICKETS_DIR_OVERRIDE: elsewhere }, () =>
        runMain([], { search: { status: 0, stdout: '[]', stderr: '' } }),
      );
      expect(out).toContain(`${ID}  status: qa`);
      expect(out).not.toContain('UNREADABLE');
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // The positive control for both cases above. Without it they would still pass if `env` were
  // ignored outright and the board always resolved to the root — isolation by accident.
  it('DOES read BOARD_DIR_OVERRIDE when it is injected', () => {
    seedOutstanding('qa');
    const elsewhere = mkdtempSync(join(FIXTURES, 'night-report-injected-board-'));
    try {
      const { out } = runMain([], { search: { status: 0, stdout: '[]', stderr: '' } }, {
        BOARD_DIR_OVERRIDE: elsewhere,
      });
      expect(out).toContain(`${ID}  status: UNREADABLE`);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // CLAUDE.md gives TICKETS_DIR_OVERRIDE precedence over BOARD_DIR_OVERRIDE. The third directory is
  // what makes the assertion name which one was read: pointed at the root's own tickets it would
  // read `qa`, which is equally the answer when the env is ignored outright and boardDir falls back
  // to the root — green for the wrong reason, and green under the very leak this ticket fixes.
  it('keeps TICKETS_DIR_OVERRIDE winning over BOARD_DIR_OVERRIDE', () => {
    seedOutstanding('qa');
    const board = mkdtempSync(join(FIXTURES, 'night-report-prec-board-'));
    const tickets = mkdtempSync(join(FIXTURES, 'night-report-prec-tickets-'));
    try {
      writeFileSync(join(tickets, `${ID}.md`), `---\nid: ${ID}\nstatus: in-progress\n---\n\nbody\n`);
      const { out } = runMain([], { search: { status: 0, stdout: '[]', stderr: '' } }, {
        BOARD_DIR_OVERRIDE: board,
        TICKETS_DIR_OVERRIDE: tickets,
      });
      expect(out).toContain(`${ID}  status: in-progress`);
    } finally {
      rmSync(board, { recursive: true, force: true });
      rmSync(tickets, { recursive: true, force: true });
    }
  });
});
