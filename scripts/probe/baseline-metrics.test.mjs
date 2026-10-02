import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  ProbeError,
  countFindings,
  parseTranscript,
  scanTranscripts,
  classifyInfra,
  titleOf,
  measure,
  assertControl,
  runCli,
  SYNTHETIC_DIR,
  NIGHT_DIR,
} from './baseline-metrics.mjs';
import { parseTicket } from './stale-in-progress.mjs';

// tkt-4caa375dc3b7. These numbers become the baseline the workflow rewrite is judged against, so the
// contract is: each definition counts what the ticket says, and every can't-measure path exits 2.

const FIXTURES = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), '.tmp-test');
const CLI = fileURLToPath(new URL('./baseline-metrics.mjs', import.meta.url));

let root;
beforeEach(() => {
  mkdirSync(FIXTURES, { recursive: true });
  root = mkdtempSync(join(FIXTURES, 'baseline-metrics-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const human = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const start = (id, ticket, extra) => [toolUse(id, 'mcp__kanban__start_ticket', { id: ticket }), result(id, '{}', extra)];
const write = (id, ticket, input = { status: 'qa' }) => toolUse(id, 'mcp__kanban__update_ticket', { id: ticket, ...input });
const segs = (rows) => parseTranscript(rows.flat()).segments;
const A = 'tkt-aaaaaaaaaaaa';
const B = 'tkt-bbbbbbbbbbbb';

function board(tickets) {
  mkdirSync(join(root, 'tickets'), { recursive: true });
  for (const [id, fm] of Object.entries(tickets)) {
    const lines = Object.entries(fm).filter(([k]) => k !== 'body').map(([k, v]) => `${k}: ${v}`);
    writeFileSync(join(root, 'tickets', `${id}.md`), `---\n${lines.join('\n')}\n---\n${fm.body ?? ''}\n`);
  }
}

function transcripts(files, dirName = 'transcripts') {
  const dir = join(root, dirName);
  mkdirSync(dir, { recursive: true });
  for (const [name, rows] of Object.entries(files)) writeFileSync(join(dir, name), rows.flat().map((r) => JSON.stringify(r)).join('\n'));
  return dir;
}

function run(args) {
  try {
    return { status: 0, out: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8' }) };
  } catch (err) {
    return { status: err.status ?? -1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

describe('countFindings', () => {
  it('counts a fenced ReportFindings-shaped array first', () => {
    const json = JSON.stringify([{ file: 'a', summary: 'x' }, { file: 'b', summary: 'y' }]);
    expect(countFindings(`## Findings\n\n**1.** z\n\n\`\`\`json\n${json}\n\`\`\``).findings).toBe(2);
  });

  it('does not let a quoted empty array or a quoted data array beat the real findings', () => {
    expect(countFindings('## Findings\n```json\n[]\n```\n**1.** a\n**2.** b\n**3.** c\n').findings).toBe(3);
    expect(countFindings('Config:\n```json\n[{"file":"a.ts"}]\n```\n## Findings\n**1.** a\n**2.** b\n**3.** c\n').findings).toBe(3);
  });

  it('reads a lone empty ReportFindings array as zero', () => {
    expect(countFindings('Nothing to flag.\n```json\n[]\n```').findings).toBe(0);
  });

  it('counts bold-numbered findings and ignores a finding\'s plain repro steps and sub-labels', () => {
    expect(countFindings('## Findings\n\n**1. a**\n\n**Failure scenario:**\n1. step\n2. step\n3. step\n\n**2. b**\n\n**3. c**\n').findings).toBe(3);
  });

  it('counts numbered heading findings without ending the section on them', () => {
    expect(countFindings('## Findings\n\n### 1. a\ntext\n### 2. b\n## Scope\n### 3. not a finding\n').findings).toBe(2);
  });

  it('ends a bold-label section at the next bold label', () => {
    expect(countFindings('**Findings:**\n\n1. **a** x\n2. **b** y\n\n**What I checked:**\n3. no\n').findings).toBe(2);
  });

  it('counts column-0 bullets, not nested ones and not per-finding field bullets', () => {
    expect(countFindings('## Findings\n\n- a\n  - detail\n- b\n- c\n').findings).toBe(3);
    expect(countFindings('## Findings\n\n- **File:** a.ts:1\n- **Failure:** boom\n- **Fix:** do\n').findings).toBeNull();
  });

  it('counts one paragraph per finding opening with file:line', () => {
    expect(countFindings('## Findings (2)\n\n`a.ts:1` — medium. x\n\n**`b.ts:9` — low.** y\n').findings).toBe(2);
  });

  it('dedupes a number restated within the section', () => {
    expect(countFindings('## Findings\n\n**1.** a\n**2.** b\n**1.** a again\n').findings).toBe(2);
  });

  it('reads an explicit zero inside the section as 0', () => {
    expect(countFindings('## Findings\n\nNo significant findings.\n').findings).toBe(0);
  });

  it('leaves an uncountable Findings section UNPARSED even when other prose says no findings', () => {
    expect(countFindings('## Findings\n\nSee the table above.\n\n## Notes\n\nno new findings beyond those').findings).toBeNull();
  });

  it('reads a lead verdict of zero', () => {
    expect(countFindings('Skill "code-review" completed (forked execution).\n\nResult: I found no bugs in this diff.').findings).toBe(0);
    expect(countFindings('No bugs found in this diff.').findings).toBe(0);
  });

  it('does not read incidental numbers in a clean verdict as findings', () => {
    expect(countFindings('The only change is one comment line, and I found no issues with it.').findings).toBe(0);
    expect(countFindings('I found no bugs. 3 claims in the new comment all check out.').findings).toBe(0);
    expect(countFindings('No bugs found. The diff is 2 files and neither has problems.').findings).toBe(0);
  });

  it('lets a lead count win over a qualified zero', () => {
    expect(countFindings('I found no correctness bugs in this diff. One test-coverage gap is worth fixing.').findings).toBe(1);
    expect(countFindings('I found nothing wrong in the diff itself. There is one low-severity gap next to it.').findings).toBe(1);
    expect(countFindings('I found two real problems in the staged diff.').findings).toBe(2);
    expect(countFindings('I found one wrong claim in the new comment.').findings).toBe(1);
  });

  it('skips the effort-level preamble before reading the lead', () => {
    expect(countFindings('No effort level was given, so I reused **high**.\nI found one issue: x.').findings).toBe(1);
  });

  it('returns UNPARSED, never 0, for prose it cannot count', () => {
    expect(countFindings('All eight finders are running; I will wait.').findings).toBeNull();
    expect(countFindings('').findings).toBeNull();
  });
});

describe('parseTranscript', () => {
  it('attributes the opening invocation to the first ticket started', () => {
    expect(segs([human('/hardpack-workflow'), start('s', A)]).get(A).humanTurns).toBe(1);
  });

  it('switches attribution at each successful start_ticket', () => {
    const s = segs([start('s1', A), human('a'), start('s2', B), human('b'), human('c')]);
    expect([s.get(A).humanTurns, s.get(B).humanTurns]).toEqual([1, 2]);
  });

  it('does not move attribution on a refused start_ticket', () => {
    const s = segs([human('work on A'), start('s1', A), start('s2', B, { is_error: true }), human('keep going')]);
    expect(s.get(A).humanTurns).toBe(2);
    expect(s.has(B)).toBe(false);
  });

  it('credits a no-start session to the single ticket it writes', () => {
    expect(segs([human('/pr'), write('u', A), human('merge')]).get(A).humanTurns).toBe(2);
  });

  it('leaves a no-start session writing several tickets unattributed, and reports it', () => {
    const { segments, unattributed } = parseTranscript([human('groom'), write('u1', A), write('u2', B, { appendBody: 'x' })]);
    expect(segments.size).toBe(0);
    expect(unattributed.humanTurns).toBe(1);
  });

  it('does not count a field-only write (priority) as working a ticket', () => {
    const { segments, unattributed } = parseTranscript([human('x'), write('u', A, { priority: 'low' })]);
    expect(segments.size).toBe(0);
    expect(unattributed.humanTurns).toBe(1);
  });

  it('counts answered gates and skips errored ones', () => {
    const s = segs([start('s', A), toolUse('q1', 'AskUserQuestion', {}), result('q1', 'yes'), toolUse('q2', 'AskUserQuestion', {}), result('q2', 'unavailable', { is_error: true })]);
    expect(s.get(A).gateAnswers).toBe(1);
  });

  it('ignores sidechain, meta and non-human user rows', () => {
    const s = segs([
      start('s', A),
      { type: 'user', isSidechain: true, origin: { kind: 'human' }, message: { content: 'x' } },
      { type: 'user', isMeta: true, origin: { kind: 'human' }, message: { content: 'x' } },
      { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
      { type: 'user', origin: { kind: 'task-notification' }, message: { content: 'done' } },
    ]);
    expect(s.get(A).humanTurns).toBe(0);
  });

  const notify = (body) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<tool-use-id>r</tool-use-id>\n<result>${body}</result>` } });

  it('reads a forked review from its task-notification, not its launch notice, and only once', () => {
    const s = segs([
      start('s', A),
      toolUse('r', 'Skill', { skill: 'code-review' }),
      result('r', 'Skill "code-review" launched (forked execution, running in the background).'),
      notify('## Findings\n\n**1.** a\n**2.** b\n'),
      notify('## Findings\n\n**1.** a\n'),
    ]);
    expect(s.get(A).reviews.map((r) => r.findings)).toEqual([2]);
  });

  it('lets a later notification fill a review whose earlier carrier was unparseable', () => {
    const s = segs([start('s', A), toolUse('r', 'Skill', { skill: 'code-review' }), result('r', 'Started; results to follow.'), notify('I found one issue: x.')]);
    expect(s.get(A).reviews.map((r) => r.findings)).toEqual([1]);
  });

  it('parses a completed inline review that mentions something running in the background', () => {
    const s = segs([start('s', A), toolUse('r', 'Skill', { skill: 'code-review' }), result('r', 'Skill "code-review" completed.\n\nResult: I found one issue: the dev server running in the background leaks.')]);
    expect(s.get(A).reviews.map((r) => r.findings)).toEqual([1]);
  });

  it('records a review that never reported as UNPARSED', () => {
    const s = segs([start('s', A), toolUse('r', 'Skill', { skill: 'code-review' }), result('r', 'Skill "code-review" launched (forked execution, running in the background).')]);
    expect(s.get(A).reviews.map((r) => r.findings)).toEqual([null]);
  });

  it('counts a human-typed /code-review as an unparsed review', () => {
    expect(segs([start('s', A), human('<command-name>/code-review</command-name>')]).get(A).reviews.map((r) => r.findings)).toEqual([null]);
  });
});

describe('scanTranscripts', () => {
  it('marks a ticket worked only in a night-run dir as non-interactive, and merges across transcripts', () => {
    const night = transcripts({ 'n.jsonl': [start('s', A)] }, '-x-hardpack--claude-worktrees-night-2026');
    const day = transcripts({ 'd1.jsonl': [human('go'), start('s', B)], 'd2.jsonl': [start('s', B), human('more')] });
    const { perTicket } = scanTranscripts([night, day]);
    expect(perTicket.get(A).interactive).toBe(false);
    expect(perTicket.get(B)).toMatchObject({ interactive: true, humanTurns: 2 });
  });

  it('skips a torn final line rather than failing the file', () => {
    const dir = transcripts({ 't.jsonl': [start('s', A), human('x')] });
    writeFileSync(join(dir, 'torn.jsonl'), `${JSON.stringify(human('y'))}\n{"type":"us`);
    expect(scanTranscripts([dir]).perTicket.get(A).humanTurns).toBe(1);
  });
});

describe('classifyInfra', () => {
  it('matches a workflow term in the title and names it', () => {
    expect(classifyInfra({ title: 'Extend guard-subagent-gates to block Edit', body: '' })).toMatchObject({ infra: true, where: 'title' });
  });

  it('matches a workflow-only file in the body', () => {
    expect(classifyInfra({ title: 'pidAlive misreads EPERM', body: 'scripts/night-run.mjs line 40' })).toEqual({ infra: true, where: 'body', term: 'night-run.mjs' });
  });

  it('does not let incidental body mentions classify a product ticket', () => {
    expect(classifyInfra({ title: 'Add "Rejected" status', body: 'Per CLAUDE.md, land it in ticket-workflow; code review follow-up.' }).infra).toBe(false);
  });

  it('does not read hardpack\'s terminal sessions or React hooks as workflow', () => {
    expect(classifyInfra({ title: 'Terminal session drops on reconnect', body: '' }).infra).toBe(false);
    expect(classifyInfra({ title: 'useTicket hooks rerender loop', body: '' }).infra).toBe(false);
    expect(classifyInfra({ title: 'Durability strategy for assistant memory store', body: '' }).infra).toBe(true);
  });

  it('matches CI case-sensitively, so ordinary words containing it do not', () => {
    expect(classifyInfra({ title: 'Circular import in decimal parsing', body: '' }).infra).toBe(false);
    expect(classifyInfra({ title: 'Cache npm in the CI job', body: '' }).infra).toBe(true);
  });
});

describe('titleOf', () => {
  it('unfolds a YAML block-scalar title', () => {
    const raw = '---\ntitle: >-\n  Two\n  lines\nstatus: todo\n---\n';
    expect(titleOf(raw, parseTicket(raw))).toBe('Two lines');
  });

  it('passes a plain title through', () => {
    const raw = "---\ntitle: 'Plain'\nstatus: todo\n---\n";
    expect(titleOf(raw, parseTicket(raw))).toBe('Plain');
  });
});

describe('measure', () => {
  const tickets = new Map([
    [A, { project: 'hardpack', status: 'done', title: 'a' }],
    [B, { project: 'copart-filter', status: 'done', title: 'b' }],
    ['tkt-cccccccccccc', { project: 'hardpack', status: 'backlog', title: 'Fix the night-run probe' }],
    ['tkt-dddddddddddd', { project: 'hardpack', status: 'todo', title: 'Comments on tickets' }],
    ['tkt-eeeeeeeeeeee', { project: 'hardpack', status: 'in-progress', title: 'A guard hook' }],
    ['tkt-ffffffffffff', { project: 'job-tracker', status: 'backlog', title: 'CLAUDE.md cap' }],
  ]);
  const work = (humanTurns, extra = {}) => ({ humanTurns, gateAnswers: 0, reviews: [], interactive: true, ...extra });

  it('excludes worked ids that are not on the board', () => {
    const m = measure({ perTicket: new Map([[A, work(4)], ['tkt-999999999999', work(50)]]), tickets });
    expect(m.all.roundTrips).toMatchObject({ n: 1, mean: 4 });
    expect(m.unmatchedIds).toBe(1);
  });

  it('keeps night-run tickets out of the round-trip mean and counts them separately', () => {
    const m = measure({ perTicket: new Map([[A, work(6)], ['tkt-cccccccccccc', work(0, { interactive: false })]]), tickets });
    expect(m.all.roundTrips).toMatchObject({ n: 1, mean: 6 });
    expect(m.all.night).toBe(1);
  });

  it('reports all projects and the hardpack-only slice separately', () => {
    const m = measure({ perTicket: new Map([[A, work(2)], [B, work(8)]]), tickets });
    expect([m.all.roundTrips.mean, m.project.roundTrips.mean]).toEqual([5, 2]);
  });

  it('takes the infra share over hardpack backlog+todo only', () => {
    const m = measure({ perTicket: new Map(), tickets });
    expect([m.backlog.infra, m.backlog.n]).toEqual([1, 2]);
  });

  it('keeps unparsed reviews out of the mean and their tickets out of findings per ticket', () => {
    const m = measure({ perTicket: new Map([[A, work(0, { reviews: [{ findings: 4 }, { findings: null }] })]]), tickets });
    expect(m.all.reviews).toMatchObject({ n: 2, parsed: 1, meanFindings: 4 });
    expect(m.all.findingsPerTicket.n).toBe(0);
  });
});

describe('assertControl', () => {
  it('passes on the shipped definitions', () => {
    expect(() => assertControl()).not.toThrow();
  });

  it('fails when the transcript parser miscounts', () => {
    const broken = (rows) => {
      const r = parseTranscript(rows);
      const a = r.segments.get(A);
      if (a) a.humanTurns++;
      return r;
    };
    expect(() => assertControl({ parse: broken })).toThrow(ProbeError);
  });

  it('fails when the classifier calls everything infra', () => {
    expect(() => assertControl({ classify: () => ({ infra: true }) })).toThrow(/classified infra/);
  });
});

describe('runCli', () => {
  const healthy = () => {
    board({
      [A]: { title: 'Work', status: 'done', project: 'hardpack' },
      [B]: { title: 'Fix the guard hook', status: 'backlog', project: 'hardpack' },
      'tkt-cccccccccccc': { title: 'Comments', status: 'todo', project: 'hardpack' },
    });
    return transcripts({ 's.jsonl': [human('go'), start('s', A), toolUse('q', 'AskUserQuestion', {}), result('q', 'yes')] });
  };

  it('measures a healthy fixture and labels each metric with its scope and n', () => {
    const dir = healthy();
    const { code, report } = runCli([root, '--transcripts', dir]);
    expect(code).toBe(EXIT.MEASURED);
    expect(report).toContain('[all] round-trips per interactive ticket:  mean 2 · median 2 · n=1');
    expect(report).toContain('[hardpack] round-trips per interactive ticket:  mean 2');
    expect(report).toContain('infra share of hardpack backlog+todo:  50.0% (1/2)');
    expect(report).toContain('unattributed: 0 transcripts');
  });

  it('runs the control before measuring, so a broken instrument prints no numbers', () => {
    const dir = healthy();
    const control = () => { throw new ProbeError('control failed: injected'); };
    expect(() => runCli([root, '--transcripts', dir], { control })).toThrow(/control failed/);
  });

  it.each([
    ['a board with no tickets/', () => transcripts({ 's.jsonl': [start('s', A)] }), /no tickets\//],
    ['an empty transcript dir', () => { board({ [A]: { title: 'x', status: 'backlog', project: 'hardpack' } }); return transcripts({}); }, /no transcripts found/],
    ['transcripts that work no board ticket', () => { board({ [A]: { title: 'x', status: 'backlog', project: 'hardpack' } }); return transcripts({ 's.jsonl': [start('s', B)] }); }, /no interactive transcript/],
    ['only night-run transcripts', () => { board({ [A]: { title: 'x', status: 'backlog', project: 'hardpack' } }); return transcripts({ 's.jsonl': [start('s', A)] }, 'p-claude-worktrees-night-1'); }, /no interactive transcript/],
    ['no hardpack backlog', () => { board({ [A]: { title: 'x', status: 'done', project: 'hardpack' } }); return transcripts({ 's.jsonl': [start('s', A)] }); }, /0% infra share/],
  ])('refuses to report from %s', (_, setup, message) => {
    const dir = setup();
    expect(() => runCli([root, '--transcripts', dir])).toThrow(message);
  });

  it('refuses a missing transcript dir and malformed flags', () => {
    healthy();
    expect(() => runCli([root, '--transcripts', join(root, 'nope')])).toThrow(/not a directory/);
    expect(() => runCli([root, '--transcripts'])).toThrow(/needs a directory/);
    expect(() => runCli([root, '--bogus'])).toThrow(/unknown flag/);
  });

  it('falls back to BOARD_DIR_OVERRIDE when no root is given', () => {
    const dir = healthy();
    expect(runCli(['--transcripts', dir], { cwd: join(root, 'transcripts'), env: { BOARD_DIR_OVERRIDE: root } }).code).toBe(EXIT.MEASURED);
  });

  it('classifies synthetic and night-run transcript dirs by name', () => {
    expect(SYNTHETIC_DIR.test('-private-var-folders-x-cleanroom-work-ab')).toBe(true);
    expect(SYNTHETIC_DIR.test('-Users-x-projects--hardpack-eval-coding-2026')).toBe(true);
    expect(SYNTHETIC_DIR.test('-Users-x-projects-hardpack')).toBe(false);
    expect(NIGHT_DIR.test('-Users-x-projects-hardpack--claude-worktrees-night-2026-09-09T03-49-13-817Z')).toBe(true);
    expect(NIGHT_DIR.test('-Users-x-projects-hardpack--claude-worktrees-tkt-4caa375dc3b7')).toBe(false);
  });
});

describe('CLI exit codes', () => {
  it('exits 0 with a report on a healthy fixture', () => {
    board({ [A]: { title: 'Work', status: 'backlog', project: 'hardpack' } });
    const r = run([root, '--transcripts', transcripts({ 's.jsonl': [start('s', A)] })]);
    expect(r.status).toBe(EXIT.MEASURED);
    expect(r.out).toContain('control: PASS');
  });

  it('exits 2, not 0, when it cannot measure', () => {
    const r = run([root, '--transcripts', transcripts({})]);
    expect(r.status).toBe(EXIT.CANNOT_MEASURE);
    expect(r.out).toContain('NOT as zero');
  });
});
