#!/usr/bin/env node
// Baseline metrics for the workflow rewrite (tkt-4caa375dc3b7; definitions on that ticket).
//   node scripts/probe/baseline-metrics.mjs [boardRoot] [--transcripts <dir>]... [--json <snapshot name>]   (writes baselines/<name>.json)   exit 0 measured · 2 could not measure

import { readFileSync, readdirSync, existsSync, statSync, realpathSync, writeFileSync, renameSync, mkdirSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTicket } from './stale-in-progress.mjs';

export const EXIT = { MEASURED: 0, CANNOT_MEASURE: 2 };

export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeError';
  }
}

const isStartTicket = (name) => /^mcp__[^_].*__start_ticket$/.test(name);
const isTicketWrite = (c) => /^mcp__[^_].*__update_ticket$/.test(c.name) && typeof c.input?.id === 'string' && (c.input.status !== undefined || c.input.appendBody !== undefined);
const isCodeReview = (c) => c.name === 'Skill' && /^code-review\b/.test(c.input?.skill ?? '');
const isLaunchNotice = (text) => /^\s*Skill "code-review" launched\b/.test(text);
const textOf = (content) =>
  typeof content === 'string' ? content : Array.isArray(content) ? content.map((x) => (x?.type === 'text' ? x.text : '')).join('\n') : '';
const emptySegment = () => ({ humanTurns: 0, gateAnswers: 0, reviews: [] });
const fill = (review, text) => {
  const { findings } = countFindings(text);
  if (findings !== null) Object.assign(review, { findings, parsed: true });
};

/**
 * Attribute round-trips and reviews to the ticket whose start_ticket last SUCCEEDED. Rows before the
 * first start go to that ticket; a transcript that starts none goes to the one ticket it writes, if
 * exactly one, else `unattributed`.
 */
export function parseTranscript(rows) {
  const segments = new Map();
  const pending = emptySegment();
  let current = null;
  const askIds = new Set();
  const startIds = new Map();
  const reviewById = new Map();
  const written = new Set();
  const seg = () => {
    if (current === null) return pending;
    if (!segments.has(current)) segments.set(current, emptySegment());
    return segments.get(current);
  };
  const attributePending = (id) => {
    current = id;
    const s = seg();
    s.humanTurns += pending.humanTurns;
    s.gateAnswers += pending.gateAnswers;
    s.reviews.push(...pending.reviews);
  };

  for (const o of rows) {
    if (!o || o.isSidechain) continue;
    const content = o.message?.content;
    if (o.type === 'assistant' && Array.isArray(content)) {
      for (const c of content) {
        if (c?.type !== 'tool_use') continue;
        if (isStartTicket(c.name) && typeof c.input?.id === 'string') startIds.set(c.id, c.input.id);
        else if (isTicketWrite(c)) written.add(c.input.id);
        else if (c.name === 'AskUserQuestion') askIds.add(c.id);
        else if (isCodeReview(c)) {
          const review = { findings: null, parsed: false };
          reviewById.set(c.id, review);
          seg().reviews.push(review);
        }
      }
      continue;
    }
    if (o.type !== 'user') continue;
    if (o.origin?.kind === 'human' && !o.isMeta) {
      seg().humanTurns++;
      if (/<command-name>\/code-review\b/.test(textOf(content))) seg().reviews.push({ findings: null, parsed: false });
      continue;
    }
    if (o.origin?.kind === 'task-notification' && typeof content === 'string') {
      const id = content.match(/<tool-use-id>(.*?)<\/tool-use-id>/)?.[1];
      const review = id && reviewById.get(id);
      const result = content.split('<result>')[1];
      if (review && !review.parsed && result !== undefined) fill(review, result);
      continue;
    }
    if (Array.isArray(content)) {
      for (const x of content) {
        if (x?.type !== 'tool_result') continue;
        if (askIds.has(x.tool_use_id) && !x.is_error) seg().gateAnswers++;
        // v0.29.0+ refuses an in-progress ticket; a refused start must not move attribution.
        if (startIds.has(x.tool_use_id) && !x.is_error) {
          const id = startIds.get(x.tool_use_id);
          if (current === null) attributePending(id);
          else current = id;
        }
        const review = reviewById.get(x.tool_use_id);
        const text = typeof x.content === 'string' ? x.content : textOf(x.content);
        if (review && !review.parsed && !isLaunchNotice(text)) fill(review, text);
      }
    }
  }
  if (current === null && written.size === 1) attributePending([...written][0]);
  const unattributed = current === null ? pending : emptySegment();
  return { segments, unattributed };
}

const FINDINGS_HEADING = /^(?:(#{1,4})\s*(?:\d+[.)]\s*)?findings\b.*|\*\*findings\b[^*\n]*\*\*.*)$/im;
const HEADING_END = /^#{1,4}\s/;
const LABEL_END = /^\*\*[^*\n]+:?\*\*:?\s*$/;
const STRONG_ITEM = /^(?:#{2,5}\s*\[?(\d+)[\].):]|\*\*\[?(\d+)[\].):]|\|\s*(\d+)\s*\|)/;
const PLAIN_ITEM = /^(\d+)[.)]\s/;
const BULLET = /^[-*]\s+\S/;
const FIELD_BULLET = /^[-*]\s+\*\*[A-Za-z][\w ()/-]{0,30}:\*\*/;
const FILE_LINE_ITEM = /^(?:\*\*)?`[^`\s]+:\d+/;
const NO_FINDINGS = /\b(?:no|zero|0)\s+(?:significant\s+|correctness\s+|new\s+|surviving\s+)?findings\b|\bnothing (?:found|survived)\b|\bempty findings list\b|^\(none\)/im;
const LEAD_ZERO = /\bfound (?:no (?:real |correctness )?(?:bugs|issues|defects|problems)|nothing wrong)\b|\bno (?:real )?bugs found\b/i;
const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
// Bare `is N …` and `N claims` matched clean reviews ("is one comment line", "3 claims check out").
const LEAD_COUNT = /(?:\bfound\s+|\bthere (?:is|are)\s+|(?:^|[.:]\s+))(one|two|three|four|five|six|seven|eight|nine|\d+)\b[^.\n]{0,40}?\b(?:issues?|problems?|bugs?|findings?|gaps?|(?:wrong|false|incorrect|inaccurate) claims?)\b/i;

function leadCount(text) {
  const lead = text
    .replace(/^\s*\[harness:[^\]]*\]\s*/, '')
    .replace(/^\s*Skill "code-review" completed[^\n]*\n+\s*Result:\s*/, '')
    .replace(/^[^\n]*\b(?:effort|level you typed)\b[^\n]*\n+/i, '')
    .slice(0, 400);
  const count = lead.match(LEAD_COUNT);
  if (count) return NUMBER_WORDS[count[1].toLowerCase()] ?? Number(count[1]);
  return LEAD_ZERO.test(lead) || NO_FINDINGS.test(lead) ? 0 : null;
}

// ReportFindings' shape printed as a fenced array. The LAST non-empty one wins: a review may quote a
// `[]` or a config array before its findings, and `every()` is vacuously true on an empty array.
function jsonFindings(text) {
  let count = null;
  let sawEmpty = false;
  for (const m of text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
    let arr;
    try { arr = JSON.parse(m[1]); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    if (arr.length === 0) { sawEmpty = true; continue; }
    if (arr.every((f) => f && typeof f === 'object' && 'summary' in f && ('file' in f || 'failure_scenario' in f))) count = arr.length;
  }
  return { count, sawEmpty };
}

function sectionCount(text) {
  const heading = text.match(FINDINGS_HEADING);
  if (!heading) return undefined;
  // A bold sub-label (`**Failure scenario:**`) ends a section only when the section itself opened as one.
  const ends = (line) => (HEADING_END.test(line) || (!heading[1] && LABEL_END.test(line))) && !STRONG_ITEM.test(line);
  const section = [];
  for (const line of text.slice(heading.index + heading[0].length).split('\n')) {
    if (ends(line)) break;
    section.push(line);
  }
  const distinct = (re) => new Set(section.map((l) => l.match(re)).filter(Boolean).map((m) => m.slice(1).find(Boolean))).size;
  const count = (keep) => section.filter(keep).length;
  const n = distinct(STRONG_ITEM) || distinct(PLAIN_ITEM)
    || count((l) => BULLET.test(l) && !FIELD_BULLET.test(l)) || count((l) => FILE_LINE_ITEM.test(l));
  if (n > 0) return n;
  return NO_FINDINGS.test(section.join('\n')) ? 0 : null;
}

/** `findings: null` means UNPARSED — never zero. */
export function countFindings(text) {
  const json = jsonFindings(text);
  if (json.count !== null) return { findings: json.count };
  const fromSection = sectionCount(text);
  const n = fromSection === undefined ? leadCount(text) : fromSection;
  return { findings: n === null && json.sawEmpty ? 0 : n };
}

export function readTranscript(file) {
  const rows = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    try { rows.push(JSON.parse(line)); } catch { /* a torn final line from a live session */ }
  }
  return rows;
}

export const SYNTHETIC_DIR = /-private-|eval-coding/;
export const NIGHT_DIR = /claude-worktrees-night-/;

export function defaultTranscriptDirs(home = os.homedir()) {
  const root = path.join(home, '.claude', 'projects');
  if (!existsSync(root)) throw new ProbeError(`no transcript store at ${root} — pass --transcripts <dir>.`);
  const all = readdirSync(root).map((d) => path.join(root, d)).filter((d) => statSync(d).isDirectory());
  return { dirs: all.filter((d) => !SYNTHETIC_DIR.test(path.basename(d))), skipped: all.filter((d) => SYNTHETIC_DIR.test(path.basename(d))).length };
}

export function scanTranscripts(dirs) {
  const perTicket = new Map();
  const unattributed = { transcripts: 0, humanTurns: 0, reviews: 0 };
  let files = 0;
  let first = null;
  let last = null;
  for (const dir of dirs) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new ProbeError(`transcript dir ${dir} is not a directory.`);
    const night = NIGHT_DIR.test(path.basename(dir));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl'))) {
      files++;
      const rows = readTranscript(path.join(dir, f));
      for (const r of rows) {
        if (typeof r?.timestamp !== 'string') continue;
        if (first === null || r.timestamp < first) first = r.timestamp;
        if (last === null || r.timestamp > last) last = r.timestamp;
      }
      const { segments, unattributed: u } = parseTranscript(rows);
      if (u.humanTurns || u.reviews.length) {
        unattributed.transcripts++;
        unattributed.humanTurns += u.humanTurns;
        unattributed.reviews += u.reviews.length;
      }
      for (const [id, s] of segments) {
        const t = perTicket.get(id) ?? { ...emptySegment(), interactive: false, transcripts: [] };
        t.humanTurns += s.humanTurns;
        t.gateAnswers += s.gateAnswers;
        t.reviews.push(...s.reviews);
        t.interactive ||= !night;
        t.transcripts.push(path.join(path.basename(dir), f));
        perTicket.set(id, t);
      }
    }
  }
  return { perTicket, unattributed, files, window: { first, last } };
}

export const OPEN_BACKLOG = new Set(['backlog', 'todo']);

// Body hits on CLAUDE.md/ticket-workflow were ~half product tickets (measured 2026-10-01), so bodies
// match only files that exist solely to run the workflow. Titles drop `session`/`hooks`/bare `memory`,
// which named hardpack's terminal and React code.
export const TITLE_TERMS = [
  /CLAUDE\.md/i, /SKILL\.md/i, /\bskills?\b/i, /\bguard[-\w]*/i, /\b(?:PreToolUse|PostToolUse|SessionStart|git|Claude Code)\s+hooks?\b/i,
  /\bhusky\b/i, /pre-commit/i, /night[- ]run/i, /\bprobe\b/i, /\bworktrees?\b/i, /ticket-workflow/i, /\bpin bump\b/i,
  /code[- ]review/i, /review gate/i, /MEMORY\.md|\bmemory (?:index|store|file|director)|auto-?memory|assistant memory/i,
  /test[- ]slots?/i, /\bvitest\b/i, /\bCI\b/, /\bworkflow\b/i, /\bruleset\b/i, /\bMCP\b/, /track-steps/i, /milestones?/i,
  /settings(?:\.local)?\.json/i, /allowlist/i, /\bretro/i, /clean-room/i, /mutation/i, /red-first/i, /Remote Control/i,
  /\bcompaction\b/i, /\bgate\b/i, /e2e\.yml/i,
];
export const BODY_TERMS = [
  /\bguard-(?:bash|worktree|ticket|subagent-gates|unattended-merge|review-target|board-writes)\b/, /\.husky\//,
  /night-run\.mjs/, /track-steps/, /settings(?:\.local)?\.json/, /skillContract\.test/,
];

// parseTicket keeps a YAML block scalar's indicator (`>-`) as the value; the text is on the next lines.
export function titleOf(raw, parsed) {
  if (!/^[>|][-+]?$/.test(parsed.title ?? '')) return parsed.title ?? '';
  const lines = raw.split('\n');
  const i = lines.findIndex((l) => /^title:\s*[>|]/.test(l));
  const out = [];
  for (const l of lines.slice(i + 1)) {
    if (!/^\s+\S/.test(l)) break;
    out.push(l.trim());
  }
  return out.join(' ');
}

export function classifyInfra({ title = '', body = '' }) {
  for (const re of TITLE_TERMS) {
    const m = title.match(re);
    if (m) return { infra: true, where: 'title', term: m[0] };
  }
  for (const re of BODY_TERMS) {
    const m = body.match(re);
    if (m) return { infra: true, where: 'body', term: m[0] };
  }
  return { infra: false, where: null, term: null };
}

export function scanBoard(root) {
  const dir = path.join(root, 'tickets');
  if (!existsSync(dir)) throw new ProbeError(`no tickets/ under ${root} — refusing to report an empty board.`);
  const tickets = new Map();
  const unreadable = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const raw = readFileSync(path.join(dir, f), 'utf8');
    const t = parseTicket(raw);
    if (!t || typeof t.status !== 'string') { unreadable.push(f); continue; }
    tickets.set(path.basename(f, '.md'), { ...t, title: titleOf(raw, t) });
  }
  if (tickets.size === 0) throw new ProbeError(`tickets/ under ${root} holds no readable tickets.`);
  return { tickets, unreadable };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function workStats(worked) {
  const interactive = worked.filter(([, t]) => t.interactive);
  const roundTrips = interactive.map(([, t]) => t.humanTurns + t.gateAnswers);
  const reviews = worked.flatMap(([, t]) => t.reviews);
  const parsed = reviews.filter((r) => r.findings !== null);
  const fullyParsed = worked.filter(([, t]) => t.reviews.length && t.reviews.every((r) => r.findings !== null));
  const findingsPerTicket = fullyParsed.map(([, t]) => t.reviews.reduce((a, r) => a + r.findings, 0));
  return {
    roundTrips: { n: roundTrips.length, mean: mean(roundTrips), median: median(roundTrips), zero: roundTrips.filter((x) => x === 0).length },
    night: worked.length - interactive.length,
    reviews: { n: reviews.length, parsed: parsed.length, meanFindings: mean(parsed.map((r) => r.findings)) },
    findingsPerTicket: { n: findingsPerTicket.length, mean: mean(findingsPerTicket), median: median(findingsPerTicket) },
  };
}

// Only ids on the board count, so a fixture or eval id cannot leak into a real number. snapshot() shares
// this so its per-ticket rows always recompute the metrics stored beside them.
const onBoard = (perTicket, tickets) => [...perTicket].filter(([id]) => tickets.has(id));

export function measure({ perTicket, tickets, project = 'hardpack' }) {
  const worked = onBoard(perTicket, tickets);
  const open = [...tickets].filter(([, t]) => t.project === project && OPEN_BACKLOG.has(t.status));
  const classified = open.map(([id, t]) => ({ id, title: t.title ?? '', ...classifyInfra(t) }));
  const infra = classified.filter((c) => c.infra);
  return {
    all: workStats(worked),
    project: workStats(worked.filter(([id]) => tickets.get(id).project === project)),
    projectName: project,
    backlog: { n: open.length, infra: infra.length, titleOnly: infra.filter((c) => c.where === 'title').length, classified },
    unmatchedIds: perTicket.size - worked.length,
  };
}

const human = (text) => ({ type: 'user', origin: { kind: 'human' }, message: { content: text } });
const toolUse = (id, name, input) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id, content, extra = {}) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] } });
const notify = (id, body) => ({ type: 'user', origin: { kind: 'task-notification' }, message: { content: `<tool-use-id>${id}</tool-use-id>\n<result>${body}</result>` } });
const started = (id, ticket, extra) => [toolUse(id, 'mcp__kanban__start_ticket', { id: ticket }), result(id, '{}', extra)];

export const CONTROL_TRANSCRIPT = [
  human('<command-name>/hardpack-workflow</command-name>'),
  { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
  { type: 'user', isMeta: true, origin: { kind: 'human' }, message: { content: 'skill body' } },
  ...started('s1', 'tkt-aaaaaaaaaaaa'),
  toolUse('q1', 'AskUserQuestion', {}),
  result('q1', 'answered'),
  toolUse('q2', 'AskUserQuestion', {}),
  result('q2', 'not available', { is_error: true }),
  toolUse('r1', 'Skill', { skill: 'code-review' }),
  result('r1', 'Skill "code-review" launched (forked execution, running in the background).'),
  notify('r1', '## Findings\n\n**1. guard fails open**\n\n**Failure scenario:**\n1. run it\n2. see it\n\n**2. typo**\n\n## Scope\n'),
  notify('r1', '## Findings\n\n**1.** a later re-notification must not replace the first\n**2.** x\n**3.** y\n'),
  { type: 'user', isSidechain: true, origin: { kind: 'human' }, message: { content: 'sidechain' } },
  ...started('s0', 'tkt-cccccccccccc', { is_error: true }),
  human('fix it'),
  ...started('s2', 'tkt-bbbbbbbbbbbb'),
  toolUse('r2', 'Skill', { skill: 'code-review' }),
  result('r2', 'Skill "code-review" completed.\n\nResult: I read three files. Nothing to report in that form.'),
  toolUse('r3', 'Skill', { skill: 'code-review' }),
  result('r3', 'Skill "code-review" completed.\n\nResult: ## Findings\n\nNo significant findings.'),
  toolUse('r4', 'Skill', { skill: 'code-review' }),
  result('r4', 'Skill "code-review" completed.\n\nResult: I found no bugs. 3 claims in the comment check out.'),
];

export const CONTROL_EXPECT = {
  'tkt-aaaaaaaaaaaa': { humanTurns: 2, gateAnswers: 1, findings: [2] },
  'tkt-bbbbbbbbbbbb': { humanTurns: 0, gateAnswers: 0, findings: [null, 0, 0] },
};

export const CONTROL_RESUMED = [human('/pr'), toolUse('u1', 'mcp__kanban__update_ticket', { id: 'tkt-dddddddddddd', status: 'qa' }), human('merge')];

export const CONTROL_TICKETS = [
  { t: { title: 'Extend guard-subagent-gates to block Edit', body: '' }, infra: true },
  { t: { title: 'Comments — discussion thread on tickets', body: 'Follow-up from the code review of tkt-x.' }, infra: false },
  { t: { title: 'pidAlive treats non-ESRCH errors as dead', body: 'In scripts/night-run.mjs the check…' }, infra: true },
  { t: { title: 'Add "Rejected" status for tickets', body: 'Per CLAUDE.md, ship it in ticket-workflow first.' }, infra: false },
  { t: { title: 'Hardening embedded-terminal session container', body: '' }, infra: false },
  { t: { title: 'useTicket hooks rerender loop', body: '' }, infra: false },
];

export const CONTROL_FOLDED_TITLE = {
  raw: '---\ntitle: >-\n  Tag SSE refresh events\n  with a source id\nstatus: backlog\n---\nbody\n',
  want: 'Tag SSE refresh events with a source id',
};

export function assertControl({ parse = parseTranscript, classify = classifyInfra } = {}) {
  const got = parse(CONTROL_TRANSCRIPT).segments;
  for (const [id, want] of Object.entries(CONTROL_EXPECT)) {
    const s = got.get(id);
    const findings = s?.reviews.map((r) => r.findings);
    if (!s || s.humanTurns !== want.humanTurns || s.gateAnswers !== want.gateAnswers || JSON.stringify(findings) !== JSON.stringify(want.findings)) {
      throw new ProbeError(`control failed for ${id}: want ${JSON.stringify(want)}, got ${JSON.stringify(s && { humanTurns: s.humanTurns, gateAnswers: s.gateAnswers, findings })}`);
    }
  }
  if (got.size !== Object.keys(CONTROL_EXPECT).length) throw new ProbeError(`control failed: ${got.size} tickets attributed, want ${Object.keys(CONTROL_EXPECT).length}`);
  const resumed = parse(CONTROL_RESUMED).segments.get('tkt-dddddddddddd');
  if (resumed?.humanTurns !== 2) throw new ProbeError('control failed: a no-start session writing one ticket was not attributed to it');
  for (const { t, infra } of CONTROL_TICKETS) {
    if (classify(t).infra !== infra) throw new ProbeError(`control failed: "${t.title}" classified infra=${!infra}, want ${infra}`);
  }
  const { raw, want } = CONTROL_FOLDED_TITLE;
  const title = titleOf(raw, parseTicket(raw));
  if (title !== want) throw new ProbeError(`control failed: folded title read as "${title}", want "${want}"`);
}

const fmt = (x) => (x === null ? 'n/a' : Number.isInteger(x) ? String(x) : x.toFixed(2));
const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : 'n/a');

function statLines(s, scope) {
  return [
    `  round-trips per interactive ticket:  mean ${fmt(s.roundTrips.mean)} · median ${fmt(s.roundTrips.median)} · n=${s.roundTrips.n} (${s.roundTrips.zero} with zero) · ${s.night} night-run tickets excluded`,
    `  findings per review:                 mean ${fmt(s.reviews.meanFindings)} · n=${s.reviews.parsed} parsed of ${s.reviews.n} (parse rate ${pct(s.reviews.parsed, s.reviews.n)})`,
    `  findings per ticket:                 mean ${fmt(s.findingsPerTicket.mean)} · median ${fmt(s.findingsPerTicket.median)} · n=${s.findingsPerTicket.n} tickets whose every review parsed`,
  ].map((l) => l.replace(/^ {2}/, `  [${scope}] `));
}

export function formatReport(m, { files, window, dirs, skipped, unreadable, unattributed }) {
  const lines = [
    'control: PASS (fixture transcripts and tickets reproduce their known counts)',
    `transcripts: ${files} files in ${dirs} dirs (${skipped} synthetic dirs skipped) · window ${window.first ?? 'n/a'} → ${window.last ?? 'n/a'}`,
    '',
    'all projects on the board:',
    ...statLines(m.all, 'all'),
    `${m.projectName} only:`,
    ...statLines(m.project, m.projectName),
    '',
    `infra share of ${m.projectName} backlog+todo:  ${pct(m.backlog.infra, m.backlog.n)} (${m.backlog.infra}/${m.backlog.n}) · title-only lower bound ${pct(m.backlog.titleOnly, m.backlog.n)}`,
    '',
    `unattributed: ${unattributed.transcripts} transcripts (${unattributed.humanTurns} human turns, ${unattributed.reviews} reviews) started no ticket and wrote to zero or several`,
  ];
  if (m.unmatchedIds) lines.push(`excluded: ${m.unmatchedIds} worked ids not on this board`);
  if (unreadable.length) lines.push(`WARNING: ${unreadable.length} unreadable ticket files skipped — the backlog count under-reports.`);
  lines.push('', 'classification (audit these):');
  for (const c of m.backlog.classified) lines.push(`  ${c.infra ? 'INFRA' : 'other'}  ${c.id}  ${c.infra ? `[${c.where}: ${c.term}]` : '            '}  ${c.title}`);
  return lines.join('\n');
}

const PROBE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASELINES_DIR = path.resolve(PROBE_DIR, '..', '..', 'baselines');

// An inherited GIT_DIR/GIT_WORK_TREE (inside a git hook) would make git judge some other repo.
export function runGit(args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env });
  return r.error || r.status === null ? { status: null, out: '' } : { status: r.status, out: r.stdout.trim() };
}

function probeVersion(git) {
  const head = git(['rev-parse', 'HEAD'], PROBE_DIR);
  const dirty = git(['status', '--porcelain', '--', '.'], PROBE_DIR);
  return { commit: head.status === 0 ? head.out : null, dirty: dirty.status === 0 ? dirty.out !== '' : null };
}

// The transcript store rolls (~30 days), so this per-ticket evidence is the only re-auditable copy of a run (tkt-65a9fa9ebd09).
export function snapshot(m, context, perTicket, tickets, { now = new Date(), git = runGit } = {}) {
  const worked = onBoard(perTicket, tickets)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, t]) => ({
      id,
      project: tickets.get(id).project ?? null,
      interactive: t.interactive,
      humanTurns: t.humanTurns,
      gateAnswers: t.gateAnswers,
      reviewFindings: t.reviews.map((r) => r.findings),
      transcripts: t.transcripts ?? [],
    }));
  return { control: 'PASS', generatedAt: now.toISOString(), probe: probeVersion(git), ...context, metrics: m, perTicket: worked };
}

const SNAPSHOT_NAME = /^[A-Za-z0-9][\w.-]*$/;

// Private projects' ticket ids in a public repo: a bare name can only land in baselines/, and only
// while the repo's own .gitignore (global excludes off) ignores it there. "Could not ask git" refuses.
export function snapshotTarget(name, { dir = BASELINES_DIR, git = runGit } = {}) {
  if (!SNAPSHOT_NAME.test(name)) throw new ProbeError(`--json takes a bare snapshot name, not a path: "${name}".`);
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.json`);
  const tmp = path.join(dir, `.${name}.json.${process.pid}.tmp`);
  for (const p of [file, tmp]) {
    const r = git(['-c', 'core.excludesFile=/dev/null', 'check-ignore', '-q', '--', path.basename(p)], dir);
    if (r.status !== 0) throw new ProbeError(`${p} is not ignored by the repo .gitignore (check-ignore exit ${r.status}) — refusing to write private ticket ids.`);
  }
  return { file, tmp };
}

// Temp + rename so a failed run never truncates the previous snapshot; 'wx' never follows a planted temp.
export function writeAtomic({ file, tmp }, text, rename = renameSync) {
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, `${text}\n`);
    closeSync(fd);
    rename(tmp, file);
  } catch (e) {
    try { closeSync(fd); } catch { /* already closed */ }
    unlinkSync(tmp);
    throw e;
  }
}

function parseArgs(argv) {
  const transcriptDirs = [];
  const positional = [];
  let jsonName = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--transcripts' || a === '--json') {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new ProbeError(a === '--json' ? '--json needs a snapshot name.' : '--transcripts needs a directory argument.');
      if (a === '--transcripts') transcriptDirs.push(value);
      else if (jsonName !== null) throw new ProbeError('--json given more than once.');
      else jsonName = value;
    } else if (a.startsWith('-')) throw new ProbeError(`unknown flag ${a}.`);
    else positional.push(a);
  }
  return { transcriptDirs, positional, jsonName };
}

export function runCli(argv, { cwd = process.cwd(), env = process.env, home = os.homedir(), control = assertControl, baselinesDir = BASELINES_DIR, git = runGit } = {}) {
  const { transcriptDirs, positional, jsonName } = parseArgs(argv);
  const target = jsonName === null ? null : snapshotTarget(jsonName, { dir: baselinesDir, git });

  control();

  const root = positional[0] ?? (env.BOARD_DIR_OVERRIDE?.trim() || cwd);
  const { tickets, unreadable } = scanBoard(root);
  const source = transcriptDirs.length ? { dirs: transcriptDirs, skipped: 0 } : defaultTranscriptDirs(home);
  const scan = scanTranscripts(source.dirs);
  if (scan.files === 0) throw new ProbeError('no transcripts found — refusing to report zero round-trips.');
  const m = measure({ perTicket: scan.perTicket, tickets });
  if (m.all.roundTrips.n === 0) throw new ProbeError('no interactive transcript worked a ticket on this board — refusing to report zero round-trips.');
  if (m.backlog.n === 0) throw new ProbeError('no hardpack backlog+todo tickets — refusing to report a 0% infra share.');

  const context = { files: scan.files, window: scan.window, dirs: source.dirs.length, skipped: source.skipped, unreadable, unattributed: scan.unattributed };
  const report = formatReport(m, context);
  if (target === null) return { code: EXIT.MEASURED, report, metrics: m };
  const snap = snapshot(m, { ...context, transcriptDirs: source.dirs }, scan.perTicket, tickets, { git });
  writeAtomic(target, JSON.stringify(snap, null, 2));
  return { code: EXIT.MEASURED, report: `${report}\n\nsnapshot: ${snap.perTicket.length} tickets written to ${target.file}`, metrics: m };
}

function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  try {
    const { code, report } = runCli(process.argv.slice(2));
    console.log(report);
    process.exitCode = code;
  } catch (e) {
    console.error(`baseline-metrics: ${e?.message ?? e}`);
    console.error('Treat this as a measurement that did not happen, NOT as zero.');
    process.exitCode = EXIT.CANNOT_MEASURE;
  }
}
