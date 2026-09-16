import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { createTicket, updateTicket, getTicket, deleteTicket, archiveStaleTickets, summarize, HttpError } from './tickets.js';
import { BOARD_STATUSES, PRIORITIES, type Ticket } from '../shared/constants.js';
import { sweep, testBlocks, screenBlock, assertInstruments, controlFailures, CONTROLS, HITS } from '../scripts/probe/vacuous-tests.mjs';
import { readEvents } from './events.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';

// Contract tests for the PINNED ticket-workflow build, driven through hardpack's shim.
//
// Not a copy of the package's unit suite (tkt-6aa717c1c9ec deleted those). That suite runs
// upstream, against upstream SOURCE at upstream HEAD — never against the tag package.json pins,
// and the published tarball ships no tests. So without this file a dep bump to a build that
// regressed any behaviour below would land with typecheck/lint/coverage fully green.
//
// Scope is deliberately narrow: only behaviours that (a) hardpack relies on and (b) no surviving
// hardpack test asserts. server/index.test.ts MOCKS archiveStaleTickets, so its real staleness
// rule is otherwise unasserted here.

const dirs = setupTempTicketDirs('pkg-contract');

const STALE = "'2026-01-01T00:00:00.000Z'";

async function writeRaw(id: string, fields: Record<string, string>) {
  const all = {
    title: 'T',
    type: 'task',
    priority: 'medium',
    status: 'backlog',
    order: '1',
    created: STALE,
    updated: STALE,
    ...fields,
  };
  const body = ['---', ...Object.entries(all).map(([k, v]) => `${k}: ${v}`), '---', ''].join('\n');
  await fs.writeFile(path.join(dirs.tickets, `${id}.md`), body, 'utf8');
}

describe('pinned ticket-workflow build: parent-cycle guard', () => {
  it('rejects a ticket as its own parent', async () => {
    const t = await createTicket({ title: 'A' });
    await expect(updateTicket(t.id, { parent: t.id })).rejects.toBeInstanceOf(HttpError);
  });

  it('rejects a descendant as the parent, and does not persist the cycle', async () => {
    const parent = await createTicket({ title: 'P' });
    const child = await createTicket({ title: 'C' });
    await updateTicket(child.id, { parent: parent.id });
    await expect(updateTicket(parent.id, { parent: child.id })).rejects.toBeInstanceOf(HttpError);
    expect((await getTicket(parent.id)).parent).toBeNull();
  });
});

describe('pinned ticket-workflow build: referential cleanup on delete', () => {
  it('prunes the deleted id from other tickets blockers and parent', async () => {
    const target = await createTicket({ title: 'Target' });
    const blocked = await createTicket({ title: 'Blocked' });
    const child = await createTicket({ title: 'Child' });
    await updateTicket(blocked.id, { blockers: [target.id] });
    await updateTicket(child.id, { parent: target.id });

    await deleteTicket(target.id);

    expect((await getTicket(blocked.id)).blockers).toEqual([]);
    expect((await getTicket(child.id)).parent).toBeNull();
  });
});

describe('pinned ticket-workflow build: archiveStaleTickets staleness rule', () => {
  it('archives a done ticket older than the staleness window', async () => {
    await writeRaw('tkt-stale0000', { status: 'done' });
    expect(await archiveStaleTickets()).toBe(1);
    expect((await getTicket('tkt-stale0000')).status).toBe('archived');
  });

  it('leaves a freshly-updated done ticket alone', async () => {
    await writeRaw('tkt-fresh0000', { status: 'done', updated: `'${new Date().toISOString()}'` });
    expect(await archiveStaleTickets()).toBe(0);
    expect((await getTicket('tkt-fresh0000')).status).toBe('done');
  });

  it('never archives a stale ticket that is not done', async () => {
    await writeRaw('tkt-open00000', { status: 'in-progress' });
    expect(await archiveStaleTickets()).toBe(0);
    expect((await getTicket('tkt-open00000')).status).toBe('in-progress');
  });
});

describe('pinned ticket-workflow build: id confinement', () => {
  it('rejects a traversal id rather than reading outside the board', async () => {
    await expect(getTicket('../../etc/passwd')).rejects.toBeInstanceOf(HttpError);
  });
});

// Error-message redaction (package v0.25.0, upstream #86; tkt-9782083b72c2). server/middleware/
// asyncWrap.ts returns an HttpError's message VERBATIM to HTTP clients, on the stated grounds that
// "HttpError messages are authored + safe". Until v0.25.0 this particular message interpolated the
// raw YAML error, which carries the absolute file path — so that assumption was false for this path
// and the board's own file layout reached any client that could GET a corrupt ticket. A bump that
// restored the interpolation would re-open it with the whole gate green, which is what this file is
// for. Asserted as an ABSENCE of the leak, not as an exact string, so upstream stays free to reword.
describe('pinned ticket-workflow build: unparseable frontmatter does not leak the path', () => {
  it('rejects with an HttpError that names the ticket but not its filesystem path', async () => {
    await fs.writeFile(path.join(dirs.tickets, 'tkt-leaky01.md'), '---\n: : not valid: yaml\n---\n', 'utf8');
    await expect(getTicket('tkt-leaky01')).rejects.toBeInstanceOf(HttpError);
    const err = await getTicket('tkt-leaky01').catch((e: unknown) => e);
    const message = err instanceof HttpError ? err.message : String(err);
    // Positive control: the message must still identify WHICH ticket, or redaction has gone too far
    // and the error is useless to the client it is returned to.
    expect(message).toContain('tkt-leaky01');
    expect(message, `leaks the board path: ${message}`).not.toContain(dirs.tickets);
    expect(message, `leaks a YAML parser detail: ${message}`).not.toMatch(/line \d+, column \d+/);
  });
});

describe('pinned ticket-workflow build: appendBody is non-destructive', () => {
  it('appends to the existing body instead of replacing it', async () => {
    const t = await createTicket({ title: 'A', body: 'first' });
    await updateTicket(t.id, { appendBody: 'second' });
    const after = await getTicket(t.id);
    expect(after.body).toContain('first');
    expect(after.body).toContain('second');
  });
});

// Backup-on-write (tkt-18d53c0c7cd8, package v0.3.0). CLAUDE.md tells every session a clobbered body
// IS recoverable and that appendBody is the rule; nothing asserted that against the pin, so a bump
// that reordered snapshotHistory after the write — or dropped it — would leave the doc making a
// PERMISSIVE claim with the gate fully green (tkt-74a35da0ef1e).
describe('pinned ticket-workflow build: backup-on-write snapshots the prior body', () => {
  const historyDir = (id: string) => path.join(dirs.tickets, '.history', id);

  async function snapshots(id: string): Promise<string[]> {
    const dir = historyDir(id);
    if (!existsSync(dir)) return [];
    const names = await fs.readdir(dir);
    return Promise.all(names.map((n) => fs.readFile(path.join(dir, n), 'utf8')));
  }

  it('writes the PRIOR full file — frontmatter and body — before a body-changing update', async () => {
    const t = await createTicket({ title: 'Snapshot me', body: 'original' });
    await updateTicket(t.id, { body: 'clobbered' });
    const snaps = await snapshots(t.id);
    expect(snaps).toHaveLength(1);
    expect(snaps.join('')).toContain('original');
    // The whole point is recoverability, so the snapshot must not be body-only.
    expect(snaps.join('')).toContain('Snapshot me');
    expect(await getTicket(t.id).then((x) => x.body)).toBe('clobbered');
  });

  it('snapshots an appendBody too, not only a full-body clobber', async () => {
    const t = await createTicket({ title: 'B', body: 'first' });
    await updateTicket(t.id, { appendBody: 'second' });
    expect((await snapshots(t.id)).join('')).toContain('first');
  });

  it('snapshots nothing on a structured-only update', async () => {
    const t = await createTicket({ title: 'C', body: 'keep' });
    await updateTicket(t.id, { priority: 'high' });
    expect(await snapshots(t.id)).toEqual([]);
  });
});

// readEvents' fail-closed rule (tkt-fc7c6846903d, package v0.9.0) and its lost-line counts
// (tkt-355581f9dab3, v0.10.0). hardpack imported both by bumping the pin and asserts neither:
// server/index.test.ts drives the HTTP route, so a regression that restored `catch { return []; }`
// would render an all-pending pipeline for a damaged log with the whole gate green — the fail-open
// shape this repo rejects, arriving through a dependency rather than a diff.
describe('pinned ticket-workflow build: unreadable event logs fail closed', () => {
  const seed = (id: string, lines: string[]) =>
    fs.writeFile(path.join(dirs.events, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  const good = (id: string, step: string) =>
    JSON.stringify({ ticketId: id, step, state: 'passed', at: '2026-07-01T00:00:00.000Z' });

  it('returns [] for a genuinely absent log — only ENOENT may read as "no events"', async () => {
    expect(await readEvents('tkt-noevents01')).toEqual({ events: [], skipped: 0, unrecognized: 0 });
  });

  // skipIf, not an early return: root bypasses the mode bits, and a test that reports PASSED where
  // it never ran is the same fail-open it is here to detect.
  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'throws rather than returning [] when the log exists but cannot be read',
    async () => {
      await seed('tkt-noperm01', [good('tkt-noperm01', 'lint')]);
      const file = path.join(dirs.events, 'tkt-noperm01.jsonl');
      await fs.chmod(file, 0o000);
      try {
        const err: unknown = await readEvents('tkt-noperm01').catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HttpError);
        if (!(err instanceof HttpError)) throw new Error('expected HttpError');
        expect(err.status).toBe(500);
        // The absolute events dir must not ride along: asyncWrap sends HttpError messages verbatim.
        expect(err.message).not.toContain(dirs.events);
      } finally {
        await fs.chmod(file, 0o644);
      }
    },
  );

  it('counts lost lines, and keeps unknown vocabulary out of that count', async () => {
    await seed('tkt-counts001', [
      'not json at all',
      good('tkt-counts001', 'lint'),
      JSON.stringify({ ticketId: 'tkt-counts001', step: 'deploy', state: 'passed', at: 'x' }),
    ]);
    const { events, skipped, unrecognized } = await readEvents('tkt-counts001');
    expect(events.map((e) => e.step)).toEqual(['lint']);
    expect(skipped).toBe(1);
    expect(unrecognized).toBe(1);
  });

  // The one rule that SUPPRESSES a count, so a regression here is silently permissive.
  it('does not count a torn final line, but does once a later event follows it', async () => {
    await fs.writeFile(path.join(dirs.events, 'tkt-torn00001.jsonl'),
      `${good('tkt-torn00001', 'lint')}\n{"ticketId":"tkt-torn00001","step":"co`, 'utf8');
    expect((await readEvents('tkt-torn00001')).skipped).toBe(0);

    await seed('tkt-torn00002', [
      good('tkt-torn00002', 'lint'),
      '{"ticketId":"tkt-torn00002","step":"co',
      good('tkt-torn00002', 'commit'),
    ]);
    expect((await readEvents('tkt-torn00002')).skipped).toBe(1);
  });
});

// ci.yml's gate runs `npx ticket-workflow audit .` (tkt-9342280b2536, v0.15.0). No other hardpack
// test touches the pinned CLI, so a bump to a build that dropped or renamed the subcommand would
// pass every local gate and only fail in CI.
describe('pinned ticket-workflow build: CLI ships the audit and vacuous subcommands', () => {
  // Walked upward, not cwd-resolved: a worktree has no node_modules of its own (imports resolve to
  // the primary checkout), and the cwd-anchored spelling failed there as 'undefinedundefined' —
  // the swallowed spawn error, not a CLI regression (tkt-7bac51ae3cc6).
  const findBin = (): string => {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (;;) {
      const candidate = path.join(dir, 'node_modules', '.bin', 'ticket-workflow');
      if (existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) throw new Error('ticket-workflow bin not found in any enclosing node_modules');
      dir = parent;
    }
  };

  it('usage names audit and vacuous', () => {
    const r = spawnSync(findBin(), [], { encoding: 'utf8' });
    expect(r.error, 'the CLI failed to spawn at all').toBeUndefined();
    expect(`${r.stdout}${r.stderr}`).toMatch(/\baudit\b/);
    // scripts/probe/vacuous-*.mjs are shims over this build (tkt-05b1630bb53a), and other repos'
    // adoption runs `ticket-workflow vacuous --check` — a bump that dropped it passes every local gate.
    expect(`${r.stdout}${r.stderr}`).toMatch(/\bvacuous\b/);
  });
});

// tkt-05b1630bb53a. The vacuous engine's own suite runs at upstream HEAD, never at this pin, and
// the ratchet only catches counts RISING — a bump to a build whose screen quietly weakened reports
// 0/0 identically. So detection quality and control discipline get pinned here, through the shim
// every documented sweep command imports (a runtime typo in its export list would fail these
// static imports at load; the .d.mts covers only tsc).
describe('pinned ticket-workflow build: vacuous probe through the shim', () => {
  it('finds a known-vacuous test and leaves a sound one alone', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'shim-sweep-'));
    try {
      await fs.mkdir(path.join(dir, 'src'), { recursive: true });
      await fs.writeFile(path.join(dir, 'src', 'bad.test.ts'), "it('asserts nothing', () => { const x = compute(); use(x); });\n");
      await fs.writeFile(path.join(dir, 'src', 'good.test.ts'), "it('adds', () => { expect(add(1, 2)).toBe(3); });\n");
      const result = sweep(dir);
      expect(result.files).toBe(2);
      expect(result.candidates).toEqual([
        { file: path.join('src', 'bad.test.ts'), line: 1, title: 'asserts nothing', hits: [HITS.NO_ASSERTION] },
      ]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('screens a parsed block directly', () => {
    const blocks = testBlocks("it('nothing', () => { use(x); });");
    expect(blocks).toHaveLength(1);
    expect(screenBlock(blocks[0])).toContain(HITS.NO_ASSERTION);
  });

  // controlFailures() over EMPTY control arrays returns [] (verified) — so a build that shipped
  // without controls would pass assertInstruments and sweep uncontrolled. Non-empty is the guard.
  it('ships controls in every category, all passing', () => {
    for (const category of ['positive', 'negative', 'oneBlock', 'zeroBlock'] as const) {
      expect(CONTROLS[category].length, category).toBeGreaterThan(0);
    }
    expect(controlFailures()).toEqual([]);
  });

  it('assertInstruments throws rather than letting a broken screen sweep', () => {
    const saved = [...CONTROLS.positive];
    CONTROLS.positive.push(['impossible', "it('n', () => { expect(real()).toBe(1); });", HITS.LITERAL]);
    try {
      expect(() => assertInstruments()).toThrow(/control/);
    } finally {
      CONTROLS.positive.length = 0;
      CONTROLS.positive.push(...saved);
    }
    expect(controlFailures()).toEqual([]);
  });
});

// tkt-8e57620f90b7. The guard lives entirely upstream (hardpack's validation/tickets modules are
// re-export shims), so nothing else here would notice a bump to a build that dropped it — and the
// failure mode is silent: the write succeeds, `unreadable` stays empty, and only a count is wrong.
// Both real occurrences on this board arrived through appendBody.
describe('pinned ticket-workflow build: raw NUL bytes are refused', () => {
  const NUL = '\0'; // spelled as an escape — a raw byte here would be invisible in this source

  it('rejects a NUL arriving through appendBody, and leaves no binary file behind', async () => {
    const t = await createTicket({ title: 'A', body: 'original' });
    await expect(updateTicket(t.id, { appendBody: `as \`${NUL}\` escape` })).rejects.toBeInstanceOf(HttpError);
    const raw = await fs.readFile(path.join(dirs.tickets, `${t.id}.md`));
    expect(raw.includes(0)).toBe(false);
  });

  it('rejects a NUL in a body replace on create', async () => {
    await expect(createTicket({ title: 'A', body: `x${NUL}y` })).rejects.toBeInstanceOf(HttpError);
  });

  // Negative control: the escape is what the prose actually means, and must still round-trip.
  it('accepts the two-character \\0 escape', async () => {
    const t = await createTicket({ title: 'A', body: 'header is `SQLite format 3\\0`' });
    expect((await getTicket(t.id)).body).toContain('\\0');
  });
});

// tkt-ad0806bc834f. A bump inverting the linked-worktree allow would wedge every armed ticket session
// with this gate green. Asserts THIS repo's install; settings.audit.test.mjs binds the wired
// ~/.claude/tools one to it. Spawned, not imported, because the module calls process.exit.
describe('pinned ticket-workflow build: guard-worktree verdicts', () => {
  const guard = createRequire(import.meta.url).resolve('ticket-workflow/hooks/guard-worktree.mjs');
  // Inside the repo, never os.tmpdir(); realpath because the guard realpaths the paths it judges.
  const fixtures = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), '.tmp-test');
  const SESSION = 'pkg-contract-session';
  let root = '';
  let primary = '';
  let linked = '';
  let stateDir = '';

  // A pre-commit hook exports GIT_DIR/GIT_INDEX_FILE, which would retarget every fixture git call
  // at the repo being committed rather than the fixture.
  const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const git = (args: string[], cwd: string) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, env: cleanEnv(), stdio: 'pipe' });

  const hook = (payload: Record<string, unknown>) =>
    spawnSync(process.execPath, [guard], {
      input: JSON.stringify({ session_id: SESSION, ...payload }),
      env: { ...cleanEnv(), WORKTREE_GUARD_STATE_DIR: stateDir },
      encoding: 'utf8',
    });
  const edit = (file: string, cwd: string) =>
    hook({ tool_name: 'Edit', cwd, tool_input: { file_path: file, old_string: 'a', new_string: 'b' } });

  beforeAll(() => {
    mkdirSync(fixtures, { recursive: true });
    root = realpathSync(mkdtempSync(path.join(fixtures, 'guard-worktree-')));
    primary = path.join(root, 'primary');
    linked = path.join(root, 'linked');
    stateDir = path.join(root, 'state');
    mkdirSync(primary, { recursive: true });
    git(['init', '-q'], primary);
    writeFileSync(path.join(primary, 'file.txt'), 'x\n');
    git(['add', 'file.txt'], primary);
    git(['commit', '-q', '-m', 'init'], primary);
    git(['worktree', 'add', '-q', '--detach', linked], primary);

    const armed = hook({ tool_name: 'mcp__kanban__start_ticket', cwd: primary, tool_input: { id: 'tkt-000000000000' } });
    expect(armed.status, armed.stderr).toBe(0);
    expect(existsSync(path.join(stateDir, SESSION)), 'start_ticket wrote no marker').toBe(true);
  });

  afterAll(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it('blocks an armed Edit into the primary checkout', () => {
    const r = edit(path.join(primary, 'file.txt'), primary);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/PRIMARY checkout/);
  });

  it('allows an armed Edit into a linked worktree', () => {
    const r = edit(path.join(linked, 'file.txt'), linked);
    expect(r.status, r.stderr).toBe(0);
  });

  it('blocks an armed git stash pop, even from a linked worktree', () => {
    const r = hook({ tool_name: 'Bash', cwd: linked, tool_input: { command: 'git stash pop' } });
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toMatch(/refs\/stash/);
  });

  // CLAUDE.md's post-merge steps are only runnable by an armed session while these stay allowed.
  it.each([
    ['git fetch origin main', 'primary'],
    ['git push origin --delete task/x', 'primary'],
    ['git switch -c task/x --no-track origin/main', 'linked'],
  ])('allows an armed `%s` in the %s checkout', (command, where) => {
    const cwd = where === 'primary' ? primary : linked;
    const r = hook({ tool_name: 'Bash', cwd, tool_input: { command } });
    expect(r.status, r.stderr).toBe(0);
  });

  it.each(['git pull --ff-only', 'git switch main'])('blocks an armed `%s` in the primary', (command) => {
    const r = hook({ tool_name: 'Bash', cwd: primary, tool_input: { command } });
    expect(r.status, r.stderr).toBe(2);
  });

  // Negative control: without it every block above could be an unconditional refusal.
  it('allows the same primary Edit for a session that never started a ticket', () => {
    const r = hook({ session_id: 'pkg-contract-unarmed', tool_name: 'Edit', cwd: primary, tool_input: { file_path: path.join(primary, 'file.txt') } });
    expect(r.status, r.stderr).toBe(0);
  });
});

// tkt-e69819938f33. The v0.24.0 bump rewrote summarize() from per-bucket filter passes to a single
// Map tally, so its correctness now rests on the OUTPUT being enum-driven — BOARD_STATUSES and
// PRIORITIES mapped with `?? 0` — rather than on which buckets the tally happened to observe.
// Nothing else in hardpack asserts that: server/index.test.ts only checks Array.isArray(byStatus).
// A build that returned observed buckets only would drop the zero rows, and Dashboard.tsx maps
// byPriority unfiltered and derives priorityMax from it, so the bars would silently rescale with
// typecheck, lint and the full suite green.
describe('pinned ticket-workflow build: summarize() output is enum-driven', () => {
  // Rows are compared against the constants themselves, never a transcribed count — a canonical
  // status added upstream must fail here rather than quietly widen the expected shape.
  const mk = (over: Partial<Ticket>): Ticket => ({
    id: 'tkt-000000000000',
    title: 'T',
    type: 'task',
    priority: 'medium',
    status: 'todo',
    order: 0,
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z',
    body: '',
    project: null,
    blockers: [],
    parent: null,
    dueDate: null,
    assignee: null,
    ...over,
  });

  it('emits a zero row for every canonical status and priority on an empty board', () => {
    const s = summarize([]);
    expect(s.byStatus).toEqual(BOARD_STATUSES.map((b) => ({ status: b.id, count: 0 })));
    expect(s.byPriority).toEqual(PRIORITIES.map((p) => ({ priority: p, count: 0 })));
    expect(s.total).toBe(0);
  });

  it('keeps the zero rows, in enum order, when only some buckets are populated', () => {
    const s = summarize([
      mk({ id: 'tkt-00000000000a', status: 'todo', priority: 'high' }),
      mk({ id: 'tkt-00000000000b', status: 'todo', priority: 'high' }),
      mk({ id: 'tkt-00000000000c', status: 'done', priority: 'low' }),
    ]);
    expect(s.byStatus).toEqual(
      BOARD_STATUSES.map((b) => ({ status: b.id, count: b.id === 'todo' ? 2 : b.id === 'done' ? 1 : 0 })),
    );
    expect(s.byPriority).toEqual(
      PRIORITIES.map((p) => ({ priority: p, count: p === 'high' ? 2 : p === 'low' ? 1 : 0 })),
    );
    expect(s.total).toBe(3);
  });

  it('excludes archived from every count', () => {
    const s = summarize([
      mk({ id: 'tkt-00000000000d', status: 'todo' }),
      mk({ id: 'tkt-00000000000e', status: 'archived' }),
    ]);
    expect(s.total).toBe(1);
    expect(s.byStatus.find((r) => r.status === 'todo')?.count).toBe(1);
    expect(s.byStatus.map((r) => r.status)).not.toContain('archived');
  });

  it('returns recentlyUpdated newest-first, capped at 8', () => {
    const twelve = Array.from({ length: 12 }, (_, i) =>
      mk({ id: `tkt-0000000001${String(i).padStart(2, '0')}`, updated: `2026-02-${String(i + 1).padStart(2, '0')}T00:00:00.000Z` }),
    );
    const s = summarize(twelve);
    expect(s.recentlyUpdated).toHaveLength(8);
    const stamps = s.recentlyUpdated.map((r) => r.updated);
    expect(stamps).toEqual([...stamps].sort().reverse());
    expect(stamps[0]).toBe('2026-02-12T00:00:00.000Z');
  });
});
