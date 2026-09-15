import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collect, assess, scanRuns, isOutstanding, formatReport, main, report, resolveRoot, ticketsDirFor }
  from './night-report.mjs';
import { primaryRoot, nightRunActive } from './guard-unattended-merge.mjs';

// Fixtures live INSIDE the repo, not os.tmpdir(): no suite may write outside the workspace, and
// `repoHygiene.test.mjs` greps the whole index for `/Users/<name>` paths. `.tmp-test` is gitignored.
const FIXTURES = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.tmp-test');

let root;

function seedRun(stamp, summary) {
  const dir = join(root, '.night-run', stamp);
  mkdirSync(dir, { recursive: true });
  if (summary !== undefined) {
    writeFileSync(join(dir, 'summary.json'), typeof summary === 'string' ? summary : JSON.stringify(summary));
  }
  return dir;
}

function seedTicket(id, status) {
  mkdirSync(join(root, 'tickets'), { recursive: true });
  writeFileSync(join(root, 'tickets', `${id}.md`), `---\nid: ${id}\nstatus: ${status}\n---\n\nbody\n`);
}

function result(id, level = 'ok', text = 'PR open, awaiting your merge') {
  return { id, before: 'todo', after: 'qa', level, text, log: `${id}.log` };
}

// One summary naming one ticket, so every case below varies exactly one thing off it.
function oneTicketNight(id, { level = 'ok', stamp = '2026-09-03T01-00-00-000Z' } = {}) {
  seedRun(stamp, { startedAt: stamp, queue: [id], results: [result(id, level)], exit: 0 });
}

const ID = 'tkt-aaaaaaaaaaaa';
const ID2 = 'tkt-bbbbbbbbbbbb';

beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'night-report-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = () => assess(collect({ root, boardDir: root }));

describe('night-report hook: what it emits', () => {
  it('emits a merge-decision line when a summarised ticket is still qa', () => {
    oneTicketNight(ID);
    seedTicket(ID, 'qa');

    const lines = run();
    expect(lines.join(' ')).toContain('awaiting your merge decision');
    expect(lines.join(' ')).toContain(ID);
    expect(lines.join(' ')).toContain('npm run night:report');
  });

  it('is silent when every summarised ticket has reached done', () => {
    oneTicketNight(ID);
    seedTicket(ID, 'done');

    expect(run()).toEqual([]);
    expect(formatReport([])).toBeNull();
  });

  // The control for the assertion above, modelled on settings.audit.test.mjs:169. Without it a hook
  // hard-wired to emit nothing — a broken scan, a predicate stuck false — passes the silence test
  // forever. Same fixture, one field flipped: the ONLY difference is the ticket's status.
  it('that same fixture emits as soon as the one ticket is flipped back to qa', () => {
    oneTicketNight(ID);
    seedTicket(ID, 'done');
    expect(run(), 'precondition: the done fixture is silent').toEqual([]);

    seedTicket(ID, 'qa');
    expect(run(), 'the silence test above is vacuous — it passes on any status').not.toEqual([]);
  });

  it('leads with a mid-ticket halt, ahead of the merge decisions', () => {
    seedRun('2026-09-03T01-00-00-000Z', {
      startedAt: 'x',
      queue: [ID, ID2],
      results: [result(ID, 'halt', 'stopped mid-ticket; needs a human'), result(ID2)],
      exit: 3,
    });
    seedTicket(ID, 'in-progress');
    seedTicket(ID2, 'qa');

    const lines = run();
    expect(lines[0]).toContain('stopped mid-ticket');
    expect(lines[0]).toContain(ID);
    expect(lines.join(' ')).toContain('awaiting your merge decision');
    expect(lines.findIndex((l) => l.includes('merge decision'))).toBeGreaterThan(0);
  });

  it('emits when a run is active, even with nothing else outstanding', () => {
    oneTicketNight(ID);
    seedTicket(ID, 'done');
    writeFileSync(join(root, '.night-run', 'ACTIVE'), '12345');

    expect(run().join(' ')).toContain('ACTIVE');
  });

  // tkt-c248cfbc5d8c: ACTIVE is a directory of per-run claims. Any claim is a run, an emptied
  // directory is not, and the single-owner file above still reads as active.
  it('emits for a claims directory holding a claim, and not for an emptied one', () => {
    oneTicketNight(ID);
    seedTicket(ID, 'done');
    const active = join(root, '.night-run', 'ACTIVE');
    mkdirSync(active, { recursive: true });
    expect(run().join(' ')).not.toContain('ACTIVE');
    writeFileSync(join(active, '4242'), '4242\n');
    expect(run().join(' ')).toContain('ACTIVE');
  });

  // Found by the case above: `scanRuns` read every directory under `.night-run/` as a run, so the
  // claims directory was reported at every session start as a crashed run with no summary.
  it('does not read the claims directory as a run that never finished', () => {
    mkdirSync(join(root, '.night-run', 'ACTIVE'), { recursive: true });
    expect(scanRuns(join(root, '.night-run'))).toEqual({ runs: [], missing: [], corrupt: [], error: null });
  });

  // The hook cannot import the guard (node builtins only — see its header), so its predicate is a
  // copy. This pins the copy to the original across every shape the sentinel can take.
  it.each([
    ['absent', () => {}, false],
    ['empty directory', (active) => mkdirSync(active), false],
    ['one claim', (active) => { mkdirSync(active); writeFileSync(join(active, '1'), '1'); }, true],
    ['legacy file', (active) => writeFileSync(active, '12345'), true],
  ])('reads the sentinel exactly as the guard does when it is %s', (_name, make, expected) => {
    mkdirSync(join(root, '.night-run'), { recursive: true });
    const active = join(root, '.night-run', 'ACTIVE');
    make(active);
    expect(nightRunActive(active)).toBe(expected); // the original's answer, pinned
    expect(collect({ root, boardDir: root }).active).toBe(expected);
  });

  it('names a run directory that has no summary.json — the crashed-runner case', () => {
    seedRun('2026-09-03T02-00-00-000Z', undefined);

    const lines = run().join(' ');
    expect(lines).toContain('no summary.json');
    expect(lines).toContain('2026-09-03T02-00-00-000Z');
  });

  it('emits the fallback for a corrupt summary.json rather than staying silent', () => {
    seedRun('2026-09-03T03-00-00-000Z', '{ this is not json');

    const lines = run().join(' ');
    expect(lines).toContain('could not be read');
    expect(lines).toContain('2026-09-03T03-00-00-000Z');
  });

  it('scans every run directory, not just the newest', () => {
    seedRun('2026-09-03T01-00-00-000Z', { startedAt: 'a', queue: [ID], results: [result(ID)], exit: 0 });
    seedRun('2026-09-03T09-00-00-000Z', { startedAt: 'b', queue: [ID2], results: [result(ID2)], exit: 0 });
    seedTicket(ID, 'qa');
    seedTicket(ID2, 'qa');

    const lines = run().join(' ');
    expect(lines, 'the older run was dropped').toContain(ID);
    expect(lines).toContain(ID2);
  });

  it('treats an unreadable board status as outstanding rather than as clean', () => {
    oneTicketNight(ID); // no tickets/ directory seeded at all

    expect(run().join(' ')).toContain('no readable status');
  });

  it('reports an alarm verdict even though the ticket reads done', () => {
    oneTicketNight(ID, { level: 'alarm' });
    seedTicket(ID, 'done');

    expect(run()[0]).toContain('ALARM');
  });

  it('is silent on a checkout that has never run a night', () => {
    expect(run()).toEqual([]);
  });

  it('says so when the primary checkout cannot be located', () => {
    expect(assess(collect({ root: null, boardDir: root }))[0]).toContain('Could not locate the primary checkout');
  });
});

describe('night-report hook: the contract it must honour', () => {
  it('emits the SessionStart payload shape', () => {
    const payload = formatReport(['one', 'two']);
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(payload.hookSpecificOutput.additionalContext).toBe('one two');
    expect(payload.systemMessage).toBe('one');
  });

  it('exits 0 and still emits a line when the scan throws', () => {
    let written = '';
    const code = main(
      (text) => {
        written += text;
      },
      () => {
        throw new Error('boom');
      },
    );

    expect(code, 'a SessionStart hook must never fail the startup it runs in').toBe(0);
    const payload = JSON.parse(written);
    expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(payload.hookSpecificOutput.additionalContext).toContain('boom');
    expect(payload.hookSpecificOutput.additionalContext).toContain('check `.night-run/` by hand');
  });

  it('writes nothing at all when there is nothing outstanding', () => {
    let written = '';
    const code = main(
      (text) => {
        written += text;
      },
      () => [],
    );

    expect(code).toBe(0);
    expect(written).toBe('');
  });

  it('never treats an unparseable ticket status as done', () => {
    expect(isOutstanding(null)).toBe(true);
    expect(isOutstanding('qa')).toBe(true);
    expect(isOutstanding('in-progress')).toBe(true);
    expect(isOutstanding('done')).toBe(false);
    expect(isOutstanding('backlog')).toBe(false);
  });

  it('reports a .night-run/ that exists but cannot be read, and stays silent when it is simply absent', () => {
    expect(scanRuns(join(root, 'nope')).error, 'an absent dir must not raise an alarm').toBeNull();

    const file = join(root, 'not-a-dir');
    writeFileSync(file, 'x');
    expect(scanRuns(file).error, 'an unreadable .night-run/ must be reported').not.toBeNull();
  });
});

// Each of these pins a defect the high-effort review found; every one was measured silent or wrong
// before the fix beside it.
describe('night-report hook: cases the review found silent', () => {
  it('reports a ticket killed mid-flight, named only in the queue', () => {
    // night-run.mjs pushes a result only AFTER a session returns, and its signal handlers exit
    // without saving, so this is exactly what a SIGHUP mid-ticket leaves on disk.
    seedRun('2026-09-03T04-00-00-000Z', { startedAt: 'x', queue: [ID], results: [], exit: null });
    seedTicket(ID, 'in-progress');

    const lines = run();
    expect(lines.join(' '), 'the crashed-mid-ticket case was silent').toContain(ID);
    expect(lines[0]).toContain('stopped mid-ticket');
  });

  it('does not nag about queue entries a cleanly-finished run never processed', () => {
    // Measured on the real board: three probe runs carry queue ["tkt-000000000000"], results [] and
    // exit 0, and an ungated queue read reported that fixture id at every session start.
    seedRun('2026-09-03T04-00-00-000Z', { startedAt: 'x', queue: ['tkt-000000000000'], results: [], exit: 0 });

    expect(run()).toEqual([]);
  });

  it('flags a run that recorded no exit code', () => {
    seedRun('2026-09-03T04-00-00-000Z', { startedAt: 'x', queue: [], results: [], exit: null });

    expect(run().join(' ')).toContain('no exit code');
  });

  it('does not call an in-flight run unfinished while the sentinel is armed', () => {
    seedRun('2026-09-03T04-00-00-000Z', { startedAt: 'x', queue: [], results: [], exit: null });
    writeFileSync(join(root, '.night-run', 'ACTIVE'), '999');

    const lines = run().join(' ');
    expect(lines).toContain('ACTIVE');
    expect(lines, 'a run still in flight is not a dead runner').not.toContain('no exit code');
  });

  it('still leads with ALARM when the alarm ticket now reads in-progress', () => {
    oneTicketNight(ID, { level: 'alarm' });
    seedTicket(ID, 'in-progress');

    const lines = run();
    expect(lines[0], 'the alarm was folded into the generic halt line').toContain('ALARM');
    expect(lines.join(' ')).toContain(ID);
  });

  it('treats a summary with no results/queue array as corrupt, not as an empty night', () => {
    seedRun('2026-09-03T05-00-00-000Z', { startedAt: 'x', exit: 0 });

    expect(run().join(' '), 'a summary missing its arrays read as a clean run').toContain('could not be read');
  });

  it('treats a non-array results field as corrupt', () => {
    seedRun('2026-09-03T05-00-00-000Z', { startedAt: 'x', queue: [], results: {}, exit: 0 });

    expect(run().join(' ')).toContain('could not be read');
  });
});

// tkt-c43474b393de. A `parked` ticket let the queue CONTINUE, so nothing downstream stopped to make
// it visible — this hook is the only thing that does, and the unpushed branch is the one fact a
// human needs that the board does not carry.
describe('night-report hook: tickets parked at the PR-open gate', () => {
  const parkedRun = (id, extra = {}) =>
    seedRun('2026-09-03T01-00-00-000Z', {
      startedAt: 'x',
      queue: [id],
      results: [{
        id,
        before: 'todo',
        after: 'in-progress',
        level: 'parked',
        text: 'finished the work and stopped at the PR-open gate',
        log: `${id}.log`,
        ...extra,
      }],
      exit: 0,
    });

  it('names a parked ticket, its branch and its repo', () => {
    parkedRun(ID, { branch: 'feat/x-thing', repo: '/repos/portfolio-site' });
    seedTicket(ID, 'in-progress');

    const line = run().join(' ');
    expect(line).toContain(ID);
    expect(line).toContain('feat/x-thing');
    expect(line).toContain('/repos/portfolio-site');
    expect(line).toMatch(/PARKED/);
  });

  // The whole promise of the carve-out: continuing the queue must not make the work invisible.
  it('a parked ticket is still OUTSTANDING', () => {
    parkedRun(ID, { branch: 'feat/x', repo: '/r' });
    seedTicket(ID, 'in-progress');

    expect(collect({ root, boardDir: root }).tickets.map((t) => t.id)).toContain(ID);
  });

  // Both are `in-progress`, so without the carve-out in the filter a parked ticket is named twice
  // and the "needs a human" count overstates what is actually stuck.
  it('a parked ticket is not also counted as stopped mid-ticket', () => {
    parkedRun(ID, { branch: 'feat/x', repo: '/r' });
    seedTicket(ID, 'in-progress');

    const halted = run().filter((l) => /stopped mid-ticket/.test(l));
    expect(halted).toEqual([]);
  });

  // The control: an ordinary halt is untouched by any of this and still reads as mid-ticket.
  it('an ordinary halt still reports as stopped mid-ticket', () => {
    oneTicketNight(ID, { level: 'halt' });
    seedTicket(ID, 'in-progress');

    expect(run().join(' ')).toMatch(/stopped mid-ticket/);
  });

  // Dropping the line when the branch is missing would hide exactly the work this exists to keep
  // visible, so the id is named either way and the gap is stated.
  it('a parked ticket with no recorded branch is still named', () => {
    parkedRun(ID);
    seedTicket(ID, 'in-progress');

    const line = run().join(' ');
    expect(line).toContain(ID);
    expect(line).toMatch(/branch not recorded/);
  });

  // THE STALE-PARK HOLE (review, medium — measured). Verdicts accumulate across every run directory
  // forever, so `.some(isParked)` let ANY historical park remove the ticket from `halted`
  // permanently: parked on night 1, genuinely abandoned on night 2, and the "needs a human" line
  // never appeared again.
  it('a park on an earlier night does not suppress a later genuine halt', () => {
    seedRun('2026-09-01T00-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 0,
      results: [{ id: ID, level: 'parked', text: 'p', branch: 'feat/night1', repo: '/r' }],
    });
    seedRun('2026-09-02T00-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 2,
      results: [{ id: ID, level: 'halt', text: 'stopped mid-ticket; needs a human' }],
    });
    seedTicket(ID, 'in-progress');

    const lines = run().join(' ');
    expect(lines).toMatch(/stopped mid-ticket/);
    expect(lines, 'a stale park still claimed the ticket was parked').not.toMatch(/PARKED/);
  });

  // The other direction: a halt on night 1 must not suppress tonight's genuine park either.
  it('a halt on an earlier night does not suppress a later park', () => {
    seedRun('2026-09-01T00-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 2,
      results: [{ id: ID, level: 'halt', text: 'stopped mid-ticket; needs a human' }],
    });
    seedRun('2026-09-02T00-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 0,
      results: [{ id: ID, level: 'parked', text: 'p', branch: 'feat/night2', repo: '/r' }],
    });
    seedTicket(ID, 'in-progress');

    const lines = run().join(' ');
    expect(lines).toMatch(/PARKED/);
    expect(lines).toContain('feat/night2');
    expect(lines).not.toMatch(/stopped mid-ticket/);
  });

  // A parked ticket whose board file later became unreadable lands in the `unknown` bucket, and the
  // branch is the one fact only the run knows — so it must survive there too (review, low).
  it('names the parked branch even when the board status is unreadable', () => {
    parkedRun(ID, { branch: 'feat/x-thing', repo: '/repos/r' });

    const lines = run().join(' ');
    expect(lines).toMatch(/no readable status/);
    expect(lines).toContain('feat/x-thing');
  });

  // A ticket parked twice carries two verdicts, and the older branch may since have merged.
  it('names the newest branch when a ticket was parked on two nights', () => {
    seedRun('2026-09-03T01-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 0,
      results: [{ id: ID, level: 'parked', text: 't', branch: 'feat/old', repo: '/r' }],
    });
    seedRun('2026-09-04T01-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 0,
      results: [{ id: ID, level: 'parked', text: 't', branch: 'feat/new', repo: '/r' }],
    });
    seedTicket(ID, 'in-progress');

    const line = run().join(' ');
    expect(line).toContain('feat/new');
    expect(line).not.toContain('feat/old');
  });

  // An alarm outranks everything: a parked verdict on the same ticket must not hide it.
  it('an alarm on a parked ticket is still reported as an alarm', () => {
    seedRun('2026-09-03T01-00-00-000Z', {
      startedAt: 'x', queue: [ID], exit: 3,
      results: [
        { id: ID, level: 'parked', text: 't', branch: 'feat/x', repo: '/r' },
        { id: ID, level: 'alarm', text: 'ticket is DONE' },
      ],
    });
    seedTicket(ID, 'done');

    expect(run().join(' ')).toMatch(/ALARM/);
  });
});

describe('night-report hook: board resolution', () => {
  it('gives TICKETS_DIR_OVERRIDE precedence over BOARD_DIR_OVERRIDE, as CLAUDE.md requires', () => {
    expect(ticketsDirFor('/board', { TICKETS_DIR_OVERRIDE: '/elsewhere' })).toBe('/elsewhere');
    expect(ticketsDirFor('/board', {})).toBe(join('/board', 'tickets'));
  });

  // report() is the wiring between the env and collect(); without this it was the one exported
  // function with no test, and every other case bypassed it by calling collect directly.
  it('report() reads the board named by BOARD_DIR_OVERRIDE', () => {
    oneTicketNight(ID);
    const board = join(root, 'other-board');
    mkdirSync(join(board, 'tickets'), { recursive: true });
    writeFileSync(join(board, 'tickets', `${ID}.md`), `---\nstatus: qa\n---\n`);

    expect(report({ root, env: { BOARD_DIR_OVERRIDE: board } }).join(' ')).toContain('merge decision');
    expect(report({ root, env: {} }).join(' '), 'the override was ignored').toContain('no readable status');
  });

  // This hook duplicates primaryRoot rather than importing it, to keep node_modules off the startup
  // path. The copy must not drift from the original.
  it('resolves the same primary root as the guard it copies', () => {
    expect(resolveRoot()).toBe(primaryRoot());
  });
});
