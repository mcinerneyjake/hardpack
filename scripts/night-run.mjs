#!/usr/bin/env node
// Unattended overnight PR queue: one headless session per ticket at `--gates auto-pr`
// (tkt-4f8d07e0810d). Each run halts at the merge gate — human in every mode, and since
// tkt-1e6a129c8d7f *enforced* by guard-unattended-merge — leaving a CI-green PR and the ticket in
// `qa`. Nothing merges.
//
// WHY NODE AND NOT BASH: the classification below is the part with real behaviour, and it is what a
// tired human reads at 8am to decide what to merge. In bash it would be untestable.
//
// WHY CLASSIFY BY STATUS TRANSITION: a `claude -p` result envelope reports `is_error: false` /
// `subtype: success` for an opened PR AND for a hard stop on a failed premise. Exit status cannot
// tell them apart, so the ticket's own status is the only honest signal. Measured 2026-09-02.
//
// WHY A TRANSITION AND NOT AN ABSOLUTE READING: a ticket already in `qa` would score as success
// without the run having done anything.

import { spawn, spawnSync } from 'node:child_process';
import {
  readFileSync, writeFileSync, appendFileSync, rmSync, rmdirSync, mkdirSync, accessSync, readdirSync,
  existsSync, symlinkSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

export const USAGE = 'usage: npm run night -- <ticket-id>...';

// The exit status is the only part of this a cron wrapper or an `|| notify-me` ever reads, so a
// stopping verdict must never share a code with a clean night (review, HIGH).
export const EXIT = { ok: 0, preflight: 1, stopped: 2, alarm: 3, usage: 64 };

// Only a clean, expected transition is an OK. Everything else either stops the queue or is reported
// as needing a human — "can't tell" never returns the permissive answer.
export function classify({ before, after, capped = false, committed = false }) {
  const verdict = transitionVerdict({ before, after });
  if (capped) {
    // A cap must never swallow the alarm: night-report's `isAlarm` is the ONLY thing that rescues a
    // `done` ticket from `isOutstanding`, so returning `capped` here is what makes an unattended merge
    // silent in the morning report — the one silence that hook says is worse than a false alarm.
    if (verdict.level === 'alarm') return verdict;
    // A cap that fires after the ticket reached `qa` has nothing left to interrupt, so dropping the
    // rest of the queue costs a night for nothing (tkt-4fc11782b77b). Gating on the uncapped verdict
    // being `ok`, not on `after === 'qa'`, keeps every transition guard in transitionVerdict binding
    // here too. The wording stays a BOARD reading: nothing here observes that a PR was actually opened.
    if (verdict.level === 'ok') {
      return { level: 'capped-after-qa', stop: false, text: 'hit the wall-clock cap after the ticket reached qa; the queue continues' };
    }
    return { level: 'capped', stop: true, text: 'hit the wall-clock cap; left mid-ticket' };
  }
  // THE AUTHORIZING LINE (tkt-c43474b393de). `halt` merges two states a reader would never merge: a
  // session that died mid-edit, and one that finished everything and stopped at the PR-open gate,
  // which is human at `auto-pr` — the second cost the 09-12 queue its remaining two tickets. The
  // only thing that separates them is POSITIVE evidence the work is committed, so this is the sole
  // path to a non-stopping verdict here and `=== true` is deliberate: `parkedWork` returns false for
  // "no commit" AND for "could not determine", and neither may buy a continue.
  //
  // Only on an UNCAPPED run. A cap means the session was cut off rather than ending on its own, so a
  // commit proves the work is safe but not that anything was finished — the reading that makes
  // `capped` above stop is the same one that withholds this carve-out from it.
  if (verdict.level === 'halt' && committed === true) {
    return {
      level: 'parked',
      stop: false,
      // "its work is committed", never "finished the work": committed is the only thing `parkedWork`
      // evidences, and the stronger wording is the claim it explicitly declines to make (review).
      text: 'stopped at the PR-open gate with its work committed and unpushed, so the queue continues',
    };
  }
  return verdict;
}

// Positive evidence that a halted ticket's work survives on disk: a branch naming the ticket whose
// tip THIS RUN wrote and which `origin/main` does not have. It answers "is this parked, or
// abandoned?" — NOT "is the tree clean", which is deliberately not required: in foreign mode the tree
// is the human's own checkout and may be dirty for reasons that have nothing to do with the run, so
// demanding it would deny the carve-out to every case this exists for.
//
// `since` IS LOAD-BEARING, and a name match plus an ahead-count is not enough without it (review,
// medium-high). This repo SQUASH-merges, which rewrites the commit, so a merged-and-undeleted local
// branch stays ahead of origin/main forever — measured, with controls: a branch 1 ahead before the
// merge is still 1 ahead after it. Without a freshness bound, a ticket re-queued after its earlier
// branch merged would park on that dead branch even if tonight's session committed nothing, and the
// report would announce finished work that had already shipped. Foreign repos compound it: nothing
// fetches them, so their `origin/main` is stale too.
//
// EVERY failure returns `committed: false` with a reason. "Could not determine" must never reach
// classify as the permissive answer, so there is no third state to get mishandled downstream: a repo
// with no `origin/main` (two mapped targets have no remote at all) simply never parks.
export function parkedWork({ id, repoRoot, since, git = defaultGit }) {
  if (!repoRoot) return { committed: false, why: 'the ticket names no repo that could be inspected' };
  if (!Number.isFinite(since)) return { committed: false, why: 'the run start time is unknown, so no commit can be tied to this run' };
  // `--format` rather than parsing `git branch`'s output: its leading "* " marker on the current
  // branch would otherwise ride into the ref name and fail every rev-list below.
  const listed = git(repoRoot, ['branch', '--list', '--format=%(refname:short)', `*${id}*`]);
  if (listed.code !== 0) {
    return { committed: false, why: `its branches could not be listed in ${repoRoot} (${listed.out.trim() || `exit ${listed.code}`})` };
  }
  const branches = listed.out.split('\n').map((l) => l.trim()).filter(Boolean);
  if (branches.length === 0) return { committed: false, why: `no branch in ${repoRoot} names this ticket` };
  const stale = [];
  for (const branch of branches) {
    const ahead = git(repoRoot, ['rev-list', '--count', `origin/main..${branch}`]);
    // An unresolvable range (no remote, a different default branch) is undetermined, and the loop
    // must not read it as "this branch is merged" and walk on to report the ticket abandoned.
    if (ahead.code !== 0) {
      return { committed: false, why: `${branch} could not be compared against origin/main (${ahead.out.trim() || `exit ${ahead.code}`})` };
    }
    // `defaultGit` folds stderr into `out`, so any git warning would make Number() NaN. NaN > 0 is
    // false, which fails closed — but it would then be reported as the determined negative "carries
    // no commit", asserting a fact that was never parsed (review, low).
    if (!/^\d+$/.test(ahead.out.trim())) {
      return { committed: false, why: `${branch}'s commit count could not be read (${ahead.out.trim() || 'empty'})` };
    }
    if (Number(ahead.out.trim()) === 0) continue;
    const when = git(repoRoot, ['log', '-1', '--format=%ct', branch]);
    if (!/^\d+$/.test(when.out.trim())) {
      return { committed: false, why: `${branch}'s tip date could not be read (${when.out.trim() || `exit ${when.code}`})` };
    }
    if (Number(when.out.trim()) >= since) return { committed: true, branch, repo: repoRoot };
    stale.push(branch);
  }
  if (stale.length > 0) {
    return { committed: false, why: `${stale.join(', ')} predate${stale.length === 1 ? 's' : ''} this run, so nothing was committed tonight` };
  }
  return { committed: false, why: `${branches.join(', ')} carr${branches.length === 1 ? 'ies' : 'y'} no commit beyond origin/main` };
}

function transitionVerdict({ before, after }) {
  if (!after) {
    return { level: 'note', stop: true, text: `status unreadable after the run (was ${before ?? 'unknown'})` };
  }
  // An unreadable `before` silently collapses this back into the absolute reading the header above
  // says it rejects: with before=null the equality test below is false and a ticket already sitting
  // in `qa` scores a fresh success (review, MEDIUM — measured).
  if (!before) {
    return { level: 'note', stop: true, text: `no status before the run, so no transition can be proven (now ${after})` };
  }
  if (after === before && after !== 'in-progress') {
    return { level: 'note', stop: false, text: `never started (status still ${after})` };
  }
  switch (after) {
    case 'qa':
      return { level: 'ok', stop: false, text: 'PR open, awaiting your merge' };
    case 'done':
      // The guard should have made this impossible. If it happens, something merged unattended and
      // the night must not continue on the assumption that the gate holds.
      return { level: 'alarm', stop: true, text: 'ticket is DONE — the merge gate was crossed; stopping the night' };
    case 'in-progress':
      return { level: 'halt', stop: true, text: 'stopped mid-ticket; needs a human' };
    case 'backlog':
      return { level: 'skip', stop: false, text: 'premise failed; ticket corrected and returned to backlog' };
    default:
      return { level: 'note', stop: true, text: `unexpected status ${after}` };
  }
}

// vitest's summary block in print order: `Test Files`, `Tests`, then `Errors` when an unhandled error
// failed a run whose tests all passed. A zero count is green (the first draft matched /\d+ failed/).
const SUMMARY_LINE = /^\s*(Test Files|Tests|Errors)\s+(?:(\d+)\s+(?:failed|errors?)\b|\d+\s+(?:passed|skipped)\b)/gm;
const COVERAGE_FAILED = /^\s*ERROR: Coverage for\b/m;
const TSC_ERROR = /\berror TS\d+:/;
const ESLINT_ERRORS = /✖ \d+ problems? \((\d+) errors?/;
// The session's own `echo "typecheck=$?"` after a redirected run — the whole line, so an env dump or
// prose cannot pass as one. This is the only verdict a redirected run leaves in the transcript.
const EXIT_LINE = /^\s*(typecheck|lint|test)(?:[_\s]exit)?\s*=\s*(\d+)\s*$/gim;
// Since tkt-ea501e6d1a1d the unattended path may let the pre-commit hook BE the gate, so a failure
// can surface only as husky aborting the commit.
const HOOK_REJECTED = /^\s*husky\s+-\s+pre-commit script failed\b/im;
// The run must BE the segment's command, behind at most a subshell paren, env assignments, `env`,
// `time` or `timeout`: matching it anywhere let `echo "=== npm test ==="` register as a run.
const PREFIX = String.raw`^(?:time\s+|timeout\s+\S+\s+)?(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S)*\s+)*(?:time\s+|timeout\s+\S+\s+)?`;
const TEST_RUN = new RegExp(`${PREFIX}(?:(npm)\\s+(?:run\\s+)?test(?::(?:run|unit|ci))?|(?:npx\\s+)?vitest\\s+run)(?=\\s|$)(.*)$`);
const scriptRun = (name) => new RegExp(`${PREFIX}npm\\s+run\\s+${name}(?=\\s|$)`);
// vitest flags that take the next token as their value, so that token is not a file selection.
const VALUE_FLAGS = /^(?:--reporter|--config|-c|--root|-r|--dir|--project|--outputFile|--pool|--shard|--environment|--retry|--bail|--testTimeout|--hookTimeout|--maxWorkers|--minWorkers|--coverage\.\w+)$/;
const SUBSET_FLAGS = /^(?:-t|--testNamePattern|--changed|--related)(?:=|$)/;

// A heredoc body is data, not commands: a line inside it starting `npx vitest run x` is not a run.
const stripHeredocs = (command) => String(command ?? '').replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '');
const segments = (command) => command.split(/&&|\|\||;|\|(?!\|)|\n/).map((s) => s.trim().replace(/^\(\s*|\s*\)$/g, ''));

const parseEvent = (line) => {
  if (!line.startsWith('{')) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/**
 * `describe` is handed `res.out` — the stdout of `claude -p --output-format stream-json`, one JSON
 * object per line with the session's real output inside string FIELDS, where a newline is the two
 * characters `\n`. Decoding those restores the line starts an anchored pattern needs.
 *
 * Used by `hookRejected` only: husky's marker is printed only when a hook has actually failed, so it
 * is safe to match anywhere. `gateFailed` does NOT decode — see it for why.
 */
export function decodeLog(log) {
  return String(log ?? '').replace(/\\r\\n|\\n|\\r/g, '\n');
}

// Every Bash tool result in transcript order, paired with the command that produced it. Only these
// are the gate speaking: the model's own text, and a ticket body quoting a run into `appendBody`,
// carry the same lines and are not observations.
function* bashResults(log) {
  const uses = new Map();
  for (const line of String(log ?? '').split('\n')) {
    const blocks = parseEvent(line)?.message?.content;
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (block.type === 'tool_use') {
        uses.set(block.id, block);
      } else if (block.type === 'tool_result' && uses.get(block.tool_use_id)?.name === 'Bash') {
        const content = block.content;
        const text = Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('\n') : String(content ?? '');
        yield { command: String(uses.get(block.tool_use_id).input?.command ?? ''), text };
      }
    }
  }
}

// Whether a Bash command's test summaries are the gate's verdict. A selection — a file, a directory,
// `-t`, `--changed`, `npm test <path>` — is a repro or a mutation check, which REQUIRE observing red,
// so it never counts. Mixed selection-and-full, or a selection through an unexpanded `$VAR`, cannot
// be attributed and yields no observation. A `git commit` carrying a summary is the hook running the gate.
export function gateRunKind(command) {
  const cmd = stripHeredocs(command);
  let kind = null;
  for (const segment of segments(cmd)) {
    const m = TEST_RUN.exec(segment);
    if (!m) continue;
    const tokens = m[2].replace(/\d?>>?\s*\S+/g, '').trim().split(/\s+/).filter(Boolean);
    // npm forwards positionals as-is but keeps dash-flags for itself until `--`.
    let vitestFlags = !m[1];
    let here = 'full';
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t === '--') { vitestFlags = true; continue; }
      if (t.includes('$')) { here = 'unknowable'; break; }
      if (!t.startsWith('-')) { here = 'narrow'; break; }
      if (!vitestFlags) continue;
      if (SUBSET_FLAGS.test(t)) { here = 'narrow'; break; }
      if (VALUE_FLAGS.test(t)) i++;
    }
    if (kind !== null && kind !== here) return 'unknowable';
    kind = here;
  }
  return kind ?? (/\bgit\s+commit\b/.test(cmd) ? 'full' : 'none');
}

// One full run's verdict from its summary block; null when no block was printed.
function summaryVerdict(text) {
  let files = false;
  let verdict = null;
  for (const m of text.matchAll(SUMMARY_LINE)) {
    const red = Number(m[2] ?? 0) > 0;
    if (m[1] === 'Test Files') files = red;
    else if (m[1] === 'Tests') { verdict = files || red; files = false; }
    else if (verdict !== null && red) verdict = true;
  }
  return verdict !== null && COVERAGE_FAILED.test(text) ? true : verdict;
}

// The verdict is the LAST observation of each kind, read from Bash tool results: an intermediate red
// is what a red-first repro or mutation check must produce (7 of 9 real logs with one ended `ok`), and
// plain text is not an event, so the suite cannot go green on a shape production never sends.
// Measurements and the adversary list: tkt-54ffcbeccb0c.
export function gateFailed(log) {
  const last = new Map();
  for (const { command, text } of bashResults(log)) {
    const cmd = stripHeredocs(command);
    // A verdict counts only from the command that ran it; an echoed exit status outranks the summary,
    // which cannot see a coverage threshold or a collect error that exited 1 with every test green.
    const exits = new Map();
    for (const m of text.matchAll(EXIT_LINE)) exits.set(m[1].toLowerCase(), Number(m[2]) !== 0);
    const full = gateRunKind(cmd) === 'full';
    const summary = full ? summaryVerdict(text) : null;
    const test = full ? exits.get('test') ?? summary : null;
    if (test !== null) last.set('test', test);

    const links = cmd.split('&&');
    const testLink = links.findIndex((l) => segments(l).some((s) => TEST_RUN.test(s)));
    for (const [kind, tool] of [['typecheck', TSC_ERROR], ['lint', ESLINT_ERRORS]]) {
      const link = links.findIndex((l) => segments(l).some((s) => scriptRun(kind).test(s)));
      if (link < 0) continue;
      const shown = tool.exec(text);
      // A summary printed at all proves every `&&` link before the run exited 0.
      const verdict = exits.get(kind) ?? (shown ? Number(shown[1] ?? 1) > 0 : summary !== null && link < testLink ? false : null);
      if (verdict !== null) last.set(kind, verdict);
    }
  }
  return [...last.values()].some(Boolean);
}

/**
 * The commit was refused by a pre-commit hook. Deliberately NOT folded into `gateFailed`: husky
 * prints this marker for whatever the hook runs, and across this fleet that is not always the gate
 * — `equipment-schedule`'s hook runs only a semicolon guard, `copart-filter`'s adds `vacuous`.
 * Calling those "the quality gate failed, so this is UNDIAGNOSED, not evidence against the branch"
 * tells the 8am reader to discount a real defect, which is worse than saying nothing.
 */
export function hookRejected(log) {
  return HOOK_REJECTED.test(decodeLog(log));
}

/**
 * The last turn ended with backgrounded tasks still running, so the harness killed them: the session
 * stopped waiting on output that never arrived. Returns their summaries in order, or null when
 * nothing was stranded.
 *
 * Position is the whole predicate, and it is weaker than it looks. A kill ANYWHERE also fires on
 * `tkt-0564cfaeca12`, which opened a PR; requiring it after the FINAL `result` envelope still leaves
 * that log, so `describe` gating on a halt is what makes the claim safe, not this function. Measured
 * over all 27 night logs: 6/6 halts, 1/21 non-halts.
 *
 * Two positions are unknowable rather than negative, and both return null. A log with no envelope at
 * all (`tkt-92360b0e2079`, level `capped`) has nothing to compare against. A log whose final line does
 * not parse was cut mid-write — `run()` merges stderr into the same buffer, and a killed child can
 * stop mid-line — so the closing envelope may be missing, which promotes a mid-session strand to the
 * tail: measured to turn a correct null into a false positive (review, MEDIUM).
 */
export function strandedBackgroundTasks(log) {
  const lines = String(log ?? '').split('\n').filter((line) => line !== '');
  if (lines.length === 0 || !parseEvent(lines[lines.length - 1])) return null;

  let sawResult = false;
  let stranded = [];
  for (const line of lines) {
    const event = parseEvent(line);
    if (!event) continue;
    // A fresh envelope closes the segment before it, so earlier strands are no longer the tail.
    if (event.type === 'result') {
      sawResult = true;
      stranded = [];
    } else if (event.type === 'system' && event.subtype === 'task_notification' && event.status === 'stopped') {
      stranded.push(String(event.summary ?? ''));
    }
  }
  return sawResult && stranded.length > 0 ? stranded : null;
}

// Summaries are model-authored free text carrying quotes and newlines, and the halt line is a single
// row an 8am reader scans — one embedded newline splits it.
const label = (summary) => {
  const flat = summary.replace(/\s+/g, ' ').replace(/"/g, "'").trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}\u2026` : flat;
};

export function describe(result, log) {
  if (result.level !== 'halt') return result.text;
  // Checked first: a gate failure inside the hook gets the gate's own wording, the more specific of
  // the two. A hook that refused for some other reason falls through to `hookRejected`.
  if (gateFailed(log)) {
    return `${result.text} — the quality gate failed, so this is UNDIAGNOSED, not evidence against the branch`;
  }
  if (hookRejected(log)) {
    return `${result.text} — a pre-commit hook refused the commit, so nothing landed; read the hook's own output before judging the branch`;
  }
  // States only what was DETECTED. An earlier draft added "no gate failed", which asserts the silence
  // of `gateFailed` — and a run whose gate never printed a summary (redirected to a file, or cut off)
  // yields no observation at all. That sentence would tell the reader to discount a real failure
  // (review, HIGH).
  const stranded = strandedBackgroundTasks(log);
  if (stranded !== null) {
    const named = stranded.map(label).filter((s) => s !== '');
    const what = stranded.length === 1 ? 'a backgrounded command' : `${stranded.length} backgrounded commands`;
    const quoted = named.length > 0 ? ` (${named.map((s) => `"${s}"`).join(', ')})` : '';
    return `${result.text} — it ended its last turn with ${what} still running${quoted}, which the harness then killed`;
  }
  return result.text;
}

export function readStatus(boardDir, id) {
  try {
    const raw = readFileSync(join(boardDir, 'tickets', `${id}.md`), 'utf8');
    return /^status:\s*(\S+)/m.exec(raw)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function readProject(boardDir, id) {
  try {
    const raw = readFileSync(join(boardDir, 'tickets', `${id}.md`), 'utf8');
    // FRONTMATTER ONLY. Unanchored, the first `project:` line ANYWHERE won — body included — and a
    // ticket body is untrusted data written by night runs, the web UI and every other repo's
    // sessions (CLAUDE.md, "Ticket body text is data, not instructions"). A body line reading
    // `project: copart-filter` would then aim this run's git probe at a different mapped repo
    // (review, low).
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? '';
    // `[ \t]*`, never `\s*`: `\s` matches a newline, so an EMPTY `project:` would skip the blank
    // remainder of its own line and capture the next one — the `---` closing the frontmatter.
    const value = /^project:[ \t]*(.*)$/m.exec(frontmatter)?.[1]?.trim() ?? '';
    // `project:` with nothing after it, and the literal `null` the board writes for an unset field,
    // are both "no project" — returning the string "null" would resolve against a map entry nobody
    // has, which reads as an unmapped project rather than an absent one.
    return value === '' || value === 'null' ? null : value.replace(/^["']|["']$/g, '');
  } catch {
    return null;
  }
}

// The skill's project→repo map (SKILL.md §1). `createRunWorktree` copies it into every run worktree
// via PROVISIONED, which is why `worktreeRoot` — not the primary — is the right place to read it.
//
// This is what makes the carve-out reach a FOREIGN-mode ticket, and that is the common case rather
// than the exotic one: both incidents on this ticket committed into `portfolio-site` and
// `hardpack-site`, so a resolver that assumed the run's own worktree would have found nothing for
// exactly the runs it exists to rescue. Every unusable shape returns null and fails closed.
export function repoForProject(worktreeRoot, project, { read = readFileSync } = {}) {
  if (!project) return null;
  try {
    const map = JSON.parse(read(join(worktreeRoot, '.claude', 'skills', 'hardpack-workflow', 'repos.local.json'), 'utf8'));
    const base = map?.baseDir;
    const repo = map?.projects?.[project]?.repo;
    if (typeof base !== 'string' || !base || typeof repo !== 'string' || !repo) return null;
    return join(base, repo);
  } catch {
    return null;
  }
}

export function sentinelPaths(root) {
  return { active: join(root, '.night-run', 'ACTIVE'), stop: join(root, '.night-run', 'STOP') };
}

// `existsSync` swallows every error and returns false, so a file under a directory that has become
// unreadable reads as absent. guard-unattended-merge.mjs documents fixing exactly this for ACTIVE;
// the STOP check reused the rejected call (review, LOW/MEDIUM). Only a genuine ENOENT is "absent".
export function fileHere(path) {
  try {
    accessSync(path);
    return true;
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
}

export const claimPath = (root, pid) => join(sentinelPaths(root).active, String(pid));

// A claim file is named by its pid, exactly: `parseInt` would read `123abc` as 123 and sweep or
// signal a pid nobody claimed.
const parsePid = (raw) => {
  const text = String(raw ?? '').trim();
  const pid = Number.parseInt(text, 10);
  return Number.isInteger(pid) && pid > 0 && String(pid) === text ? pid : null;
};

/**
 * Every claim on the sentinel. ACTIVE is a DIRECTORY of per-run claim files named by pid
 * (tkt-c248cfbc5d8c), so more than one run can hold the gate while each keeps its own owner
 * identity, liveness and takeover. A single-owner FILE there is `legacy` — a runner from before the
 * change — and is read so it is honoured while its owner lives. `unreadable` is anything present
 * that cannot be listed; every caller treats it as held.
 */
export function readClaims(root) {
  const { active } = sentinelPaths(root);
  let entries;
  try {
    entries = readdirSync(active);
  } catch (err) {
    if (err?.code === 'ENOENT') return { kind: 'absent', pids: [], junk: [] };
    if (err?.code === 'ENOTDIR') {
      let legacyPid = null;
      try {
        legacyPid = parsePid(readFileSync(active, 'utf8'));
      } catch { /* present but unreadable: no owner to report */ }
      return { kind: 'legacy', pids: legacyPid === null ? [] : [legacyPid], junk: [], legacyPid };
    }
    return { kind: 'unreadable', pids: [], junk: [] };
  }
  const pids = [];
  const junk = [];
  for (const name of entries) {
    const pid = parsePid(name);
    if (pid === null) junk.push(name);
    else pids.push(pid);
  }
  return { kind: 'dir', pids, junk };
}

export const claimHeld = (root, pid) => readClaims(root).pids.includes(pid);

// EPERM means the pid exists and belongs to somebody else — still alive, so still holding the gate.
export function pidAlive(pid, kill = process.kill.bind(process)) {
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export const defaultCommandOf = (pid) => {
  const res = spawnSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  return res.stdout.trim();
};

/**
 * Is a claim's pid a live NIGHT RUN? `pidAlive` alone answers the wrong question: pids are reused, so
 * a crashed run's number can belong to somebody's editor — and a claim read that way is swept by
 * nobody, keeps the pre-flight's disarmed half skipped every night, and holds STOP unswept forever
 * (review, CONFIRMED). A command `ps` cannot read is "cannot rule out a run" and stays alive.
 */
export function runAlive(pid, { alive = pidAlive, commandOf = defaultCommandOf } = {}) {
  if (!alive(pid)) return false;
  const cmd = commandOf(pid);
  return cmd === null || cmd.includes('night-run.mjs');
}

// Whether any OTHER run still holds the gate. Liveness matters: a dead claim is a leak for the next
// claimer to sweep, not a run to defer to.
export function othersLive(root, { pid = process.pid, alive = runAlive } = {}) {
  return readClaims(root).pids.some((p) => p !== pid && alive(p));
}

// Points this run's claim at its evidence, for `night:status`. The filename stays the identity; the
// content is advisory, and a reader that cannot parse it loses only the pointers.
export function noteClaim(root, info, { pid = process.pid } = {}) {
  try {
    writeFileSync(claimPath(root, pid), `${JSON.stringify({ pid, ...info })}\n`);
  } catch { /* observability only */ }
}

export function readClaimNote(root, pid) {
  try {
    const parsed = JSON.parse(readFileSync(claimPath(root, pid), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * A claim is exclusive to its pid, never to the gate: `wx` makes the create atomic, and a claim whose
 * owner is gone is a leak from a crashed run, swept on the way in — the only thing that stops one
 * crash wedging every later run. A legacy single-owner file is exclusive by design and is honoured
 * while its owner lives. The first draft of the sentinel disarmed and re-armed unconditionally, so a
 * second runner deleted the first one's gate mid-queue and its sessions could merge (review, HIGH);
 * per-pid claims are what let two runs share the gate without either being able to drop the other's.
 */
export function claimSentinel(root, { pid = process.pid, alive = runAlive } = {}) {
  const { active } = sentinelPaths(root);
  mkdirSync(join(root, '.night-run'), { recursive: true });
  const found = readClaims(root);
  const result = { ok: true };
  if (found.kind === 'unreadable') {
    return { ok: false, why: `a sentinel already exists at ${active} and could not be read — remove it by hand if no night run is going` };
  }
  if (found.kind === 'legacy') {
    if (found.legacyPid === null) {
      return { ok: false, why: `a sentinel already exists at ${active} and its owner could not be read — remove it by hand if no night run is going` };
    }
    if (alive(found.legacyPid)) {
      return { ok: false, why: `another night run (pid ${found.legacyPid}) holds the sentinel at ${active} in its single-owner form — wait for it to finish` };
    }
    rmSync(active, { force: true });
    result.tookOver = found.legacyPid;
  }
  const swept = found.kind === 'dir' ? found.pids.filter((p) => p !== pid && !alive(p)) : [];
  for (const p of swept) rmSync(claimPath(root, p), { force: true });
  if (swept.length > 0) result.swept = swept;
  if (found.junk.length > 0) result.junk = found.junk;
  // Two attempts, for two things that are not holders: another run's disarm dropping the emptied
  // directory between the mkdir and the write, and a stale claim under this pid — reused after a
  // crash — which is a leak rather than an owner.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      mkdirSync(active, { recursive: true });
    } catch (err) {
      return { ok: false, why: `could not create the claims directory at ${active} (${err?.code ?? err?.message})` };
    }
    try {
      writeFileSync(claimPath(root, pid), `${pid}\n`, { flag: 'wx' });
      return result;
    } catch (err) {
      if (err?.code === 'EEXIST') rmSync(claimPath(root, pid), { force: true });
      else if (err?.code !== 'ENOENT') return { ok: false, why: `could not claim the sentinel (${err?.code ?? err?.message})` };
    }
  }
  return { ok: false, why: `could not claim the sentinel at ${active} — the claims directory kept changing under the write` };
}

// Writes this run's claim unconditionally. Never touches another run's.
export function arm(root, { pid = process.pid } = {}) {
  mkdirSync(sentinelPaths(root).active, { recursive: true });
  writeFileSync(claimPath(root, pid), `${pid}\n`);
  return claimPath(root, pid);
}

/**
 * Removes only THIS run's claim, so a runner that loses a race — or shares the gate with another live
 * run — can never disarm somebody else's. The directory is dropped once empty and left alone
 * otherwise (ENOTEMPTY is another run's claim). Returns whether a claim of ours was removed.
 */
export function disarm(root, { pid = process.pid } = {}) {
  const { active } = sentinelPaths(root);
  const found = readClaims(root);
  if (found.kind !== 'dir') return false;
  const had = found.pids.includes(pid);
  rmSync(claimPath(root, pid), { force: true });
  try {
    rmdirSync(active);
  } catch { /* another run's claim, or already gone */ }
  return had;
}

export function run(cmd, args, { capMs, graceMs = 10_000, onOutput, input, env, cwd } = {}) {
  return new Promise((resolve) => {
    // Undefined `env` inherits, which every other caller here relies on: a bare `{}` would launch
    // `claude` with no PATH. Undefined `cwd` inherits too.
    const child = spawn(cmd, args, { stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'], env, cwd });
    let out = '';
    let capped = false;
    let killer = null;
    // SIGTERM is a request. A `claude` holding a hung MCP server would otherwise never close, and the
    // night would hang till morning with the sentinel armed (review, MEDIUM).
    const timer = capMs
      ? setTimeout(() => {
          capped = true;
          child.kill('SIGTERM');
          killer = setTimeout(() => child.kill('SIGKILL'), graceMs);
        }, capMs)
      : null;
    const clear = () => { if (timer) clearTimeout(timer); if (killer) clearTimeout(killer); };
    const take = (b) => { out += b.toString(); onOutput?.(b.toString()); };
    child.stdout.on('data', take);
    child.stderr.on('data', take);
    // A spawn that fails never emits 'exit', and with no 'error' listener 'close' is lost too — the
    // harness would hang forever.
    child.on('error', (err) => { clear(); resolve({ code: -1, out: String(err), capped }); });
    child.on('close', (code) => { clear(); resolve({ code, out, capped }); });
    if (input != null) {
      child.stdin.on('error', () => {}); // a guard that blocks may exit before draining fd 0
      child.stdin.end(input);
    }
  });
}

// The payload the disarmed half of the pre-flight drives. It must be the SAME command shape the
// armed half is refused, or the pair stops being a control: with no stdin the launcher never reaches
// its merge branch at all, so an empty read exits 0 whatever the gate would have done to a merge.
export const MERGE_PROBE_PAYLOAD = JSON.stringify({
  tool_name: 'Bash',
  tool_input: { command: 'gh pr merge 999999999' },
});

const HOOK_MARKER = '[guard-unattended-merge] Blocked:';

/**
 * Did the armed probe actually get refused? A bare /BLOCKED/ substring test passes on its own
 * negation — "The command was not BLOCKED, it RAN." contains the word — and `armed.out` is free-form
 * model prose, so nothing constrains it to the one word we asked for. That put a fail-open in the
 * single check the whole design rests on (review, HIGH). The hook's own marker is authored by the
 * guard rather than the model, so it is the strong signal; otherwise the reply must BE the word.
 */
export function guardBlocked(out) {
  const text = (out ?? '').trim();
  if (text.includes(HOOK_MARKER)) return true;
  if (/\bRAN\b/.test(text)) return false; // ambiguous → refuse; aborting the night is the safe way to be wrong
  const last = text.split('\n').filter((l) => l.trim()).at(-1)?.replace(/[*_`.!]/g, '').trim() ?? '';
  return /^BLOCKED$/i.test(last);
}

export const PROBE_CAP_MS = 180_000;

// THE CONTROL THAT GATES THE NIGHT. Both halves are required: "blocks while armed" alone cannot
// distinguish a working guard from one that blocks unconditionally.
export async function preflightGuard(root, { spawnProbe = run, probeCapMs = PROBE_CAP_MS } = {}) {
  // An entry that is not a claim is swept by nobody, so once every run has ended it alone keeps the
  // gate armed for every session on the machine. Refused first, by name, while a human is watching.
  const found = readClaims(root);
  if (found.junk.length > 0) {
    const names = found.junk.map((n) => JSON.stringify(n)).join(', ');
    return { ok: false, why: `${names} in ${sentinelPaths(root).active} is not a claim; nothing sweeps it, so it would keep the gate armed after every run ends — remove it by hand` };
  }
  // `gh pr merge 999999999` is gated by shape yet harmless if the guard is broken — it resolves to no
  // such PR and errors. A probe naming a real PR would merge it on exactly the run where the guard
  // has failed, making the control the incident.
  //
  // This half drives a real `claude` session rather than the hook file directly, because what it has
  // to prove is that the hook is WIRED — running the file by hand proves only that its code is right.
  const armed = await spawnProbe('claude', [
    '-p', '--permission-mode', 'auto',
    'Run exactly this one Bash command and reply with only BLOCKED if a hook refused it, or RAN if it executed: gh pr merge 999999999',
  ], { capMs: probeCapMs });
  // The reply is returned on EVERY path below, not just the refusing one. It is the only record of
  // what a live model actually said, and `guardBlocked`'s reading of it is the single control the
  // unattended design rests on — so a passing gate has to be as auditable as a failing one
  // (tkt-a761e990190d). A capped probe keeps whatever it managed to emit.
  const armedOut = armed.out ?? '';
  // `run` resolves a spawn failure as code -1 with the OS error in `out` — not a model reply at all.
  // Unchecked it is stored as one and reported as "the merge guard did not block", which accuses a
  // guard that was never exercised; `claude` off PATH is the likely cause and reads as a broken gate
  // (review, MEDIUM). The session loop below already reads -1 this way.
  if (armed.code === -1) {
    return { ok: false, why: `the armed guard probe could not be started (${armedOut.trim()})`, armedOut };
  }
  // The sentinel is claimed before this await, so a probe that hangs would park the night with every
  // merge blocked and no ticket run (review, MEDIUM).
  if (armed.capped) {
    return { ok: false, why: 'the armed guard probe timed out, so the gate could not be confirmed', armedOut };
  }
  if (!guardBlocked(armedOut)) {
    return { ok: false, why: 'the merge guard did not block while a run was marked active', armedOut };
  }

  // The disarmed half hands the launcher an ABSENT sentinel path as its override, so it never reads
  // the real gate and this run's claim stays where it is throughout — which is what lets it run beside
  // other live runs (review, CONFIRMED: the first draft disarmed and re-armed around it for nothing).
  const hook = join(root, '.claude', 'hooks', 'guard-bash.mjs');
  const off = await spawnProbe(process.execPath, [hook, join(root, '.night-run', 'NOT-THERE')], {
    input: MERGE_PROBE_PAYLOAD,
    capMs: probeCapMs,
  });
  // The disarmed half's own output is carried too. Its failure message admits it cannot tell "stuck
  // on" from "the launcher failed to load", and `off.out` is the only thing that separates them — a
  // MODULE_NOT_FOUND stack against the guard's own marker. Reporting the ARMED reply on this path
  // shows a clean BLOCKED from the probe that succeeded, pointing the reader at the wrong half
  // (review, MEDIUM).
  const disarmed = { code: off.code, out: off.out ?? '' };
  if (off.capped) {
    return { ok: false, why: 'the disarmed guard probe timed out, so the gate could not be confirmed', armedOut, disarmed };
  }
  // A launcher that cannot load exits 2 as well, so this message names both readings rather than
  // asserting the one it cannot tell apart (review, MEDIUM).
  if (off.code !== 0) {
    return {
      ok: false,
      why: `the merge guard did not permit with no run active (exit ${off.code}) — it is stuck on, or the launcher itself failed to load`,
      armedOut,
      disarmed,
    };
  }
  return { ok: true, armedOut, disarmed };
}

/**
 * The pre-flight's evidence, labelled by WHICH probe spoke. Unlabelled, a disarmed-half failure
 * prints the armed probe's clean `BLOCKED` and reads as though the gate was fine. `(no output)` is
 * written explicitly because a zero-byte record is indistinguishable from a probe that never ran —
 * the exact ambiguity this record exists to remove (review, LOW).
 */
export function renderProbes({ armedOut, disarmed } = {}) {
  const body = (t) => (t?.trim() ? t.trim() : '(no output)');
  let s = `=== armed probe — expected: refused ===\n${body(armedOut)}\n`;
  if (disarmed) {
    s += `\n=== disarmed probe — expected: exit 0 ===\nexit ${disarmed.code}\n${body(disarmed.out)}\n`;
  }
  return s;
}

export function sessionArgs(id) {
  return [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'auto',
    `/hardpack-workflow --gates auto-pr ${id}`,
  ];
}

/**
 * What tells a per-ticket session that the night run it can see is its own (tkt-c4743331eb03).
 *
 * From inside the child, a competing session and its own parent are indistinguishable by anything in
 * the repo: `.night-run/ACTIVE/` holds a claim for a live pid, that pid's argv carries this ticket's id, and
 * `<id>.live.log` — the child's own stdout tee — is growing as it looks. A session that found all
 * three read itself as a competitor and hard-stopped, leaving the ticket `todo` while the queue
 * exited 0. The discriminator cannot be derived from that state, so the runner hands it down.
 *
 * The ticket id, not just a flag: a child working B that stumbles on A's artifacts is looking at a
 * real competitor, and `NIGHT_RUN_TICKET` has to say which.
 */
export function sessionEnv(id, { pid = process.pid, env = process.env, boardDir } = {}) {
  // The session works in a worktree, where `tickets/` does not exist: without the override the board
  // tools would resolve an empty board from cwd and every status would read null (tkt-c248cfbc5d8c).
  return {
    ...env,
    NIGHT_RUN_TICKET: id,
    NIGHT_RUN_PID: String(pid),
    ...(boardDir ? { BOARD_DIR_OVERRIDE: boardDir } : {}),
  };
}

// The live tee is what `night:status` tails to show a run is still moving; the authoritative record
// stays the `<id>.log` written when the session ends. An append that fails must never take the run
// down with it — losing the tail costs visibility, losing the ticket costs the night.
// `exec` is injected — in the options bag, like every other seam here, so a stray positional argument
// cannot land on it and silently blank `capMs` — because the wiring below is otherwise unreachable
// from a test without spawning `claude`: dropping the `env` line left the whole suite green, which is
// how a per-session id goes missing unnoticed.
export const defaultRunSession = (id, { capMs, logDir, exec = run, cwd, boardDir }) => exec('claude', sessionArgs(id), {
  capMs,
  cwd,
  env: sessionEnv(id, { boardDir }),
  onOutput: logDir
    ? (chunk) => { try { appendFileSync(join(logDir, `${id}.live.log`), chunk); } catch { /* observability only */ } }
    : undefined,
});

export const GIT_CAP_MS = 60_000;

// Capped and never interactive: this runs with the claim already held, so a fetch stalled on the
// network or a credential prompt would arm the gate for every session on the machine with nothing
// running and the event loop blocked (review, CONFIRMED).
const defaultGit = (cwd, args) => {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_CAP_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  const failure = res.error ? `${res.error.code ?? res.error.message}` : '';
  return { code: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}${failure}` };
};

export const runWorktreePath = (root, stamp) => join(root, '.claude', 'worktrees', `night-${stamp}`);

// What a session needs that a checkout does not carry — every one gitignored, so none can ride into
// a commit. Copied, never linked: a session editing its copy must not be editing the primary's. The
// skill's repo map is read under CLAUDE_PROJECT_DIR, which is the worktree, and §1 hard-stops
// without it — every session of the first night would have stopped before its ticket (review).
const PROVISIONED = [
  '.env',
  join('.claude', 'settings.local.json'),
  join('.claude', 'skills', 'hardpack-workflow', 'repos.local.json'),
];

/**
 * One worktree per run, so two runs — or a run and an interactive session — never share a working
 * tree (tkt-c248cfbc5d8c). Detached at a freshly fetched origin/main: `main` itself is normally
 * checked out in the primary and cannot be checked out twice. `node_modules` is LINKED to the
 * primary's rather than installed: an install per run costs minutes, and the primary's tree is what
 * a session used before this change anyway.
 */
export function createRunWorktree(root, stamp, { git = defaultGit } = {}) {
  const path = runWorktreePath(root, stamp);
  const fetch = git(root, ['fetch', '-q', 'origin', 'main']);
  if (fetch.code !== 0) {
    return { ok: false, why: `could not fetch origin/main for the run's worktree (${fetch.out.trim() || `exit ${fetch.code}`})` };
  }
  mkdirSync(dirname(path), { recursive: true });
  const add = git(root, ['worktree', 'add', '-q', '--detach', path, 'origin/main']);
  if (add.code !== 0) {
    return { ok: false, why: `could not create the run's worktree at ${path} (${add.out.trim() || `exit ${add.code}`})` };
  }
  const provisioned = [];
  try {
    if (existsSync(join(root, 'node_modules'))) {
      symlinkSync(join(root, 'node_modules'), join(path, 'node_modules'), 'dir');
      provisioned.push(join(path, 'node_modules'));
    }
    for (const rel of PROVISIONED) {
      if (!existsSync(join(root, rel))) continue;
      copyFileSync(join(root, rel), join(path, rel));
      provisioned.push(join(path, rel));
    }
  } catch (err) {
    for (const p of provisioned) {
      try {
        unlinkSync(p);
      } catch { /* best effort; --force below removes the tree */ }
    }
    git(root, ['worktree', 'remove', '--force', path]);
    return { ok: false, why: `could not provision the run's worktree at ${path} (${err?.code ?? err?.message})` };
  }
  return { ok: true, path, provisioned };
}

/**
 * Removes the run's worktree only when it is clean. A dirty one is a halted ticket's uncommitted work
 * and is KEPT, named, for the human. The provisioned files are unlinked first and by hand: the
 * settings copy is untracked and would read as dirt, and the node_modules LINK must never be followed
 * into the primary's directory — pinned by a test against real git rather than trusted.
 */
export function removeRunWorktree(root, { path, provisioned = [] }, { git = defaultGit } = {}) {
  const status = git(path, ['status', '--porcelain']);
  if (status.code !== 0) {
    return { removed: false, why: `its state could not be read (${status.out.trim() || `exit ${status.code}`})` };
  }
  const ours = new Set(provisioned.map((p) => relative(path, p)));
  const dirt = status.out.split('\n').filter((l) => l.trim() !== '' && !ours.has(l.slice(3).trim()));
  if (dirt.length > 0) return { removed: false, why: `it is not clean: ${dirt.join('; ')}` };
  // A session that took EnterWorktree from inside creates a NESTED worktree under this one, and
  // `.claude/worktrees` is gitignored, so its uncommitted work is invisible to the porcelain above and
  // `git worktree remove` would delete it (review, PLAUSIBLE — mechanism measured against real git).
  const list = git(root, ['worktree', 'list', '--porcelain']);
  if (list.code !== 0) {
    return { removed: false, why: `the worktree list could not be read (${list.out.trim() || `exit ${list.code}`})` };
  }
  const nested = list.out.split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length))
    .filter((p) => p !== path && p.startsWith(`${path}/`));
  if (nested.length > 0) return { removed: false, why: `it contains a nested worktree: ${nested.join(', ')}` };
  for (const p of provisioned) {
    try {
      unlinkSync(p);
    } catch { /* already gone */ }
  }
  const res = git(root, ['worktree', 'remove', path]);
  if (res.code !== 0) return { removed: false, why: res.out.trim() || `exit ${res.code}` };
  return { removed: true };
}

// `Number(process.env.CAP_SECONDS ?? 2700) * 1000` yields NaN for a typo, and NaN is falsy — so
// `CAP_SECONDS=abc` silently removed the cap altogether (review, MEDIUM). An unreadable value is a
// usage error, never a default.
export function capMsFrom(raw) {
  if (raw === undefined) return { ok: true, capMs: 2700 * 1000 };
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return { ok: false, why: `CAP_SECONDS must be a positive number of seconds, got ${JSON.stringify(raw)}` };
  }
  return { ok: true, capMs: seconds * 1000 };
}

export async function main(
  argv = process.argv.slice(2),
  // An operator's own override is the board; it must not be clobbered by cwd on its way to the
  // sessions (review). Where neither is right — a bare `npm run night` from an interactive worktree —
  // is tkt-03f3b545fdcf.
  boardDir = process.env.BOARD_DIR_OVERRIDE || process.cwd(),
  {
    spawnProbe = run,
    runSession = defaultRunSession,
    resolveSentinelRoot = primaryRoot,
    env = process.env,
    exec = run,
    writeProbeLog = writeFileSync,
    createWorktree = createRunWorktree,
    removeWorktree = removeRunWorktree,
    alive = runAlive,
  } = {},
) {
  const queue = argv.filter((a) => /^tkt-[0-9a-f]{12}$/.test(a));
  if (queue.length === 0 || queue.length !== argv.length) {
    process.stderr.write(`${USAGE}\n`);
    return EXIT.usage;
  }

  const cap = capMsFrom(env.CAP_SECONDS);
  if (!cap.ok) {
    process.stderr.write(`${cap.why}\n`);
    return EXIT.usage;
  }

  // The runner must write the sentinel where the GUARD reads it. The guard derives that from its own
  // file via `git rev-parse --git-common-dir`; the first draft used process.cwd(), so running from a
  // worktree armed a sentinel nothing read (review, MEDIUM).
  const root = resolveSentinelRoot();
  if (!root) {
    process.stderr.write('could not locate the primary checkout, so the sentinel the guard reads cannot be written\n');
    return EXIT.preflight;
  }

  const claim = claimSentinel(root, { alive });
  if (!claim.ok) {
    process.stderr.write(`pre-flight FAILED: ${claim.why}\nAborting; no tickets were run.\n`);
    return EXIT.preflight;
  }
  if (claim.tookOver) {
    process.stdout.write(`took over a stale single-owner sentinel left by pid ${claim.tookOver}\n`);
  }
  if (claim.swept) {
    process.stdout.write(`swept stale claim(s) left by dead pid(s) ${claim.swept.join(', ')}\n`);
  }

  const { stop } = sentinelPaths(root);
  // Swept on EVERY exit path, signals and crashes included: `night:stop --now` writes STOP and then
  // signals, so a sweep living only in the finally left it behind (tkt-b90152b23e62).
  const sweepStop = () => {
    try {
      rmSync(stop, { force: true });
    } catch (err) {
      process.stdout.write(`WARNING: the STOP file could NOT be removed (${err?.code ?? err?.message}) — the next run will stop immediately until it is deleted by hand\n`);
    }
  };
  let worktree = null;
  let summary = null;
  let saveSummary = () => {};
  // On the signal and crash paths the `claude` child is not killed by this process and may outlive
  // it (night-control.mjs: only a group leader takes it down), so a clean-looking worktree can still
  // be a live session's cwd. Interrupted, it is KEPT and said so (review, CONFIRMED).
  const releaseWorktree = ({ interrupted = false } = {}) => {
    if (!worktree) return;
    const made = worktree;
    worktree = null;
    const res = interrupted
      ? { removed: false, why: 'the run was interrupted, and the session it was driving may still be working in it' }
      : removeWorktree(root, made);
    process.stdout.write(res.removed
      ? `worktree removed: ${made.path}\n`
      : `worktree KEPT at ${made.path} — ${res.why}\n`);
    if (summary) {
      summary.worktree = { path: made.path, removed: res.removed, ...(res.removed ? {} : { why: res.why }) };
      saveSummary();
    }
  };
  // disarm first — it narrows the check-then-write race with `night:stop` — and the rest in a finally,
  // since none of it throws and a disarm that does must not skip it. STOP is swept only by the LAST
  // live runner out: swept by the first, a stop addressed to every run would end one and be lost on
  // the others (tkt-c248cfbc5d8c).
  const cleanup = ({ interrupted = false } = {}) => {
    try {
      disarm(root);
    } finally {
      if (!othersLive(root, { alive })) sweepStop();
      releaseWorktree({ interrupted });
    }
  };
  // SIGHUP is the likeliest overnight death of all — an ssh session dropping — and its default action
  // terminates without running the finally, leaking a sentinel that blocks every later merge
  // (review, MEDIUM/HIGH). Listeners are removed again below: a leak per call trips node's
  // max-listeners warning once anything drives main more than ten times.
  const bySignal = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };
  const handlers = Object.entries(bySignal).map(([signal, code]) => {
    const fn = () => { cleanup({ interrupted: true }); process.exit(code); };
    process.on(signal, fn);
    return [signal, fn];
  });
  const onCrash = (err) => { cleanup({ interrupted: true }); process.stderr.write(`night run crashed: ${err?.stack ?? err}\n`); process.exit(EXIT.stopped); };
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);

  try {
    // The log directory is created BEFORE the pre-flight, not after it. An aborted night is the run
    // whose evidence is worth most — it is the one where something the design depends on did not
    // behave — and a directory made only on the passing path throws that away (tkt-a761e990190d).
    const startedAt = new Date().toISOString();
    const stamp = startedAt.replace(/[:.]/g, '-');
    const logDir = join(root, '.night-run', stamp);
    mkdirSync(logDir, { recursive: true });
    // The link `night:status` attributes a log by. The launcher owns `runner-<stamp>.log` and the
    // runner owns `logDir`, and until this line nothing tied either to the pid in ACTIVE — so status
    // picked a log by mtime and showed a REFUSED launch's "Aborting; no tickets were run" under a
    // healthy run's banner (tkt-166e6cfe2e2c). Written after the claim, so only a pid that really
    // owns the sentinel ever declares itself.
    process.stdout.write(`night-run pid ${process.pid} — logs ${logDir}\n`);

    // Rewritten after EVERY ticket rather than once at the end: the nights worth reading are the ones
    // that died mid-queue, and a summary written only on the way out is exactly the one they never
    // reach. Generated straight from `classify`, never transcribed (tkt-4ea4e17f1419 reads this).
    summary = { startedAt, queue, results: [], exit: null };
    saveSummary = () => {
      try {
        writeFileSync(join(logDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
      } catch (err) {
        process.stdout.write(`    WARNING: summary.json not written (${err?.code ?? err?.message})\n`);
      }
    };

    const pre = await preflightGuard(root, { spawnProbe });
    const probeLog = join(logDir, 'preflight-probes.log');
    const report = renderProbes(pre);
    // Failing to SAVE the evidence must never swallow the abort the evidence is about. Unguarded,
    // this write sits ahead of the message, so an ENOSPC or a swept logDir turned a loud pre-flight
    // abort into an unhandled rejection carrying no verdict — the `finally` below has already
    // deregistered the crash handler by then (review, MEDIUM).
    let saved = probeLog;
    try {
      writeProbeLog(probeLog, report);
    } catch (err) {
      saved = `NOT SAVED (${err?.code ?? err?.message ?? 'write failed'})`;
    }
    if (!pre.ok) {
      // The report is inlined as well as saved: an operator reading `did not block` needs to tell a
      // guard that never fired from a model that simply worded its answer differently, and being
      // sent to a file to find that out is how the difference gets guessed at instead.
      summary.exit = EXIT.preflight;
      saveSummary();
      process.stderr.write(
        `pre-flight FAILED: ${pre.why}\n${report}saved to ${saved}\nAborting; no tickets were run.\n`,
      );
      return EXIT.preflight;
    }
    // A STOP already here was never addressed to this run — another live run's, still in force, or a
    // stop issued while this one was starting — and a night that runs nothing must not be announced
    // as started, so this is read BEFORE the verdict line `night:start` accepts (review). cleanup()
    // sweeps it on the way out once no live run is left to consume it.
    if (fileHere(stop)) {
      const held = othersLive(root, { alive })
        ? 'another live run has not consumed it yet, so it stays'
        : 'no other run is live, so it was meant for this one or left over, and is swept on exit';
      process.stdout.write(`STOP file present before any ticket — a stop is in force (${held}); nothing was run\n`);
      summary.exit = EXIT.stopped;
      saveSummary();
      return EXIT.stopped;
    }
    // Made only once the guard is proven, and BEFORE the verdict line: a worktree that cannot be made
    // must read to `night:start` as the pre-flight failure it is, not as a run that passed and died.
    const made = createWorktree(root, stamp);
    if (!made.ok) {
      summary.exit = EXIT.preflight;
      saveSummary();
      process.stderr.write(`pre-flight FAILED: ${made.why}\nAborting; no tickets were run.\n`);
      return EXIT.preflight;
    }
    worktree = made;
    summary.worktree = { path: made.path, removed: null };
    saveSummary();
    noteClaim(root, { logDir, worktree: made.path });
    process.stdout.write(`pre-flight: merge guard arms and disarms correctly (probes: ${saved})\n`);
    process.stdout.write(`worktree: ${made.path} — every session this run drives works there, detached at origin/main\n`);

    let exit = EXIT.ok;
    let neverStarted = 0;
    for (const id of queue) {
      if (fileHere(stop)) {
        // Between tickets this is a stop addressed to a running queue, and ending is the clean
        // outcome; cleanup() sweeps it on the way out once no live run is left to consume it.
        process.stdout.write('STOP file present — ending the queue cleanly\n');
        break;
      }
      const before = readStatus(boardDir, id);
      // Epoch SECONDS, to compare against git's `%ct`, and taken per ticket rather than per run: a
      // queue runs for hours, so the run's own start would admit a commit made by the previous
      // ticket's session. Captured before the session so a commit it makes can only be newer.
      const sessionStart = Math.floor(Date.now() / 1000);
      process.stdout.write(`\n--- ${id}  (was ${before ?? 'unreadable'})\n`);

      const res = await runSession(id, { capMs: cap.capMs, logDir, exec, cwd: made.path, boardDir });
      writeFileSync(join(logDir, `${id}.log`), res.out);

      // A session that could not be spawned at all would otherwise read as "never started" and march
      // through the whole queue in silence — `claude` off PATH burns every ticket (review, MEDIUM).
      if (res.code === -1) {
        process.stdout.write(`    HALT: the session could not be started (${res.out.slice(0, 200)})\n    queue stops here\n`);
        // Recorded before the break: otherwise the machine-readable summary shows a stopped night
        // with the failing ticket ABSENT, and the reader cannot tell which one it died on.
        summary.results.push({ id, before, after: null, level: 'halt', text: 'the session could not be started', log: join(logDir, `${id}.log`) });
        exit = EXIT.stopped;
        saveSummary();
        break;
      }

      const after = readStatus(boardDir, id);
      // A FAILED GATE IS NOT A PARK (review, medium). CLAUDE.md invites committing as often as the
      // work needs, so a session can commit an early chunk, fail `npm test` later and halt still
      // `in-progress` — with a commit sitting there. Parking that would tell the morning human to
      // push and open a PR on work whose gate is red, and `describe`'s "UNDIAGNOSED" wording never
      // reaches a non-halt level to warn them. So the diagnosis gates the park rather than the
      // other way round.
      const diagnosed = gateFailed(res.out) || hookRejected(res.out);
      // Only asked when it could change the verdict — an uncapped, undiagnosed run left `in-progress`.
      // Every other transition already decides itself, and spawning git against a foreign checkout
      // for a ticket that reached `qa` would be work whose answer nothing reads.
      const parked = after === 'in-progress' && !res.capped && !diagnosed
        ? parkedWork({ id, repoRoot: repoForProject(made.path, readProject(boardDir, id)), since: sessionStart })
        : { committed: false, why: diagnosed ? 'the quality gate failed, so nothing here is finished' : null };
      const verdict = classify({ before, after, capped: res.capped, committed: parked.committed });
      process.stdout.write(`    ${verdict.level.toUpperCase()}: ${describe(verdict, res.out)}\n`);
      // Keyed on the VERDICT, not on the evidence. `parkedWork` can succeed while classify still
      // stops — an unreadable `before` yields `note`/stop — and recording a branch there made the
      // two reports contradict each other, one calling the ticket parked and the other mid-ticket.
      const isParkedVerdict = verdict.level === 'parked';
      if (isParkedVerdict) process.stdout.write(`    parked at ${parked.branch} in ${parked.repo} — unpushed, no PR\n`);
      else if (parked.why) process.stdout.write(`    no committed work found: ${parked.why}\n`);
      summary.results.push({
        id,
        before,
        after,
        level: verdict.level,
        text: verdict.text,
        log: join(logDir, `${id}.log`),
        // Recorded so the morning report can NAME the parked branch without re-deriving it — the
        // run is the only thing that still knows which repo the ticket was worked in.
        ...(isParkedVerdict ? { branch: parked.branch, repo: parked.repo } : {}),
      });
      saveSummary();

      neverStarted = verdict.text.startsWith('never started') ? neverStarted + 1 : 0;
      if (neverStarted >= 2) {
        process.stdout.write('    two tickets in a row never started — something is wrong with the runner, not the board\n    queue stops here\n');
        exit = EXIT.stopped;
        break;
      }
      if (verdict.stop) {
        process.stdout.write('    queue stops here\n');
        exit = verdict.level === 'alarm' ? EXIT.alarm : EXIT.stopped;
        break;
      }
    }
    summary.exit = exit;
    saveSummary();
    process.stdout.write(`\nlogs: ${logDir}\n`);
    return exit;
  } finally {
    // A STOP written while the LAST ticket was in flight is never seen by the loop check, so the
    // sweep in cleanup() is what serves it: the run is over either way (review, MEDIUM).
    cleanup();
    for (const [signal, fn] of handlers) process.off(signal, fn);
    process.off('uncaughtException', onCrash);
    process.off('unhandledRejection', onCrash);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => process.exit(code));
}
