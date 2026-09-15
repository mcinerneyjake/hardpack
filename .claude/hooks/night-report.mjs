// SessionStart: tell the morning session what last night's run left outstanding (tkt-4ea4e17f1419).
//
// WHY A HOOK. CLAUDE.md's session startup offers `todo` tickets, so a night-run PR sitting in `qa` is
// invisible at exactly the moment somebody could merge it. Prose in a governing doc would be the
// honour-system version of this; a hook fires whether or not anyone remembers to look.
//
// LOCAL AND CHEAP ONLY — no network, no `gh`. This runs before the session is usable, so a hung call
// stalls every startup. Resolving each ticket's real PR lives in `npm run night:report`, which a
// human runs once this points at it.
//
// NODE BUILTINS ONLY, AND THAT IS WHY THE FOUR HELPERS BELOW ARE NOT IMPORTED (review, MEDIUM).
// `scripts/night-run.mjs` and `guard-unattended-merge.mjs` own the originals, but BOTH resolve
// `ticket-workflow` out of node_modules — night-run.mjs:20 imports the guard, which imports the
// package. A checkout that has not installed, or is mid dependency-bump (CLAUDE.md requires an
// install *inside* a worktree), would then throw ERR_MODULE_NOT_FOUND at import time: before any
// try/catch, degrading every session start in the repo AND emitting nothing. Sixteen lines of
// duplication is the cheap side of that trade for a startup-critical path. `readsSameRootAs` in the
// test file pins this copy to the original so the two cannot drift silently.
//
// DERIVED, NEVER STORED. The outstanding set is recomputed from each ticket's CURRENT status on every
// start, so a ticket reaching `done` or `archived` drops out on its own — there is no acknowledgement
// file to go stale. A merged PR whose ticket was never set `done` keeps nagging, which is correct:
// the board is lying and the report shows the discrepancy. The one case with no automatic exit is a
// DELETED ticket: `readStatus` then returns null forever, which counts as outstanding by design, so
// clearing it means removing that `.night-run/<stamp>/` directory by hand.
//
// SILENCE IS THE PERMISSIVE ANSWER. Every path that cannot read something emits a line rather than
// returning clean, and an unreadable ticket status counts as outstanding. A hook that prints nothing
// is indistinguishable from a hook that did not run.

import { readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// Mirrors guard-unattended-merge.mjs's primaryRoot: `--git-common-dir` points at the PRIMARY
// checkout's .git from inside any worktree, and the sentinel and `.night-run/` only ever live there.
export function resolveRoot(startDir = HERE) {
  const res = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: startDir,
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  return dirname(res.stdout.trim());
}

// Mirrors guard-unattended-merge.mjs's nightRunActive (tkt-c248cfbc5d8c): ACTIVE is a directory of
// per-run claims, so any entry, an unlistable directory, or the legacy single-owner file is armed and
// only an empty directory or a genuine ENOENT is not. `existsSync` swallows every error and returns
// false, which would read an unreadable sentinel as absent.
function armed(path) {
  let entries;
  try {
    entries = readdirSync(path);
  } catch (err) {
    return err?.code !== 'ENOENT';
  }
  return entries.length > 0;
}

// Mirrors night-run.mjs's readStatus, but resolves the tickets directory itself: CLAUDE.md gives
// TICKETS_DIR_OVERRIDE precedence over BOARD_DIR_OVERRIDE, which the imported form cannot express.
export function statusOf(ticketsDir, id) {
  try {
    return /^status:\s*(\S+)/m.exec(readFileSync(join(ticketsDir, `${id}.md`), 'utf8'))?.[1] ?? null;
  } catch {
    return null;
  }
}

export function ticketsDirFor(boardDir, env = process.env) {
  return env.TICKETS_DIR_OVERRIDE ?? join(boardDir, 'tickets');
}

// Statuses that mean the night left work a human still owes an answer on. `backlog` is absent on
// purpose: `classify` returns it for a premise that failed, which the run already closed out.
const OUTSTANDING = new Set(['qa', 'in-progress']);

/**
 * @param {string|null} status current status from the board, null when it could not be read
 */
export function isOutstanding(status) {
  // A summary named this ticket and its status could not be read — "cannot check" must not resolve
  // to the silent answer, so unknown counts as outstanding.
  return status === null || OUTSTANDING.has(status);
}

// `classify` returns `alarm` only for "ticket is DONE — the merge gate was crossed". That ticket is
// `done`, so isOutstanding drops it; reporting nothing about an unattended merge would be the one
// silence worse than a false alarm.
export function isAlarm(result) {
  return result?.level === 'alarm';
}

// A `parked` ticket let the queue CONTINUE (tkt-c43474b393de), so nothing downstream stopped to make
// it visible. It is still `in-progress` and so still outstanding — what this separates is the
// wording: "stopped mid-ticket" is false of it, and the branch holding the unpushed work is the one
// thing the human needs and cannot get from the board.
export function isParked(result) {
  return result?.level === 'parked';
}

function readSummary(dir) {
  const parsed = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('summary.json is not an object');
  }
  // A missing or renamed `results`/`queue` is the same class of unreadability as bad JSON, and
  // coercing it to [] would equate "cannot read this run" with "this run had no outstanding work"
  // (review, MEDIUM).
  if (!Array.isArray(parsed.results)) throw new Error('summary.json has no results array');
  if (!Array.isArray(parsed.queue)) throw new Error('summary.json has no queue array');
  return parsed;
}

/**
 * Scan every `.night-run/<stamp>/` directory. Every run is read, not just the newest: two runs in one
 * night must not lose the older one.
 *
 * @returns {{runs: Array, missing: string[], corrupt: Array<{stamp: string, why: string}>, error: string|null}}
 */
export function scanRuns(nightDir) {
  const out = { runs: [], missing: [], corrupt: [], error: null };
  let entries;
  try {
    entries = readdirSync(nightDir, { withFileTypes: true });
  } catch (err) {
    // No `.night-run/` at all is the ordinary case on a checkout that has never run one, and must
    // stay silent. Anything else means the directory is THERE and unreadable — report it.
    if (err?.code !== 'ENOENT') out.error = `${err?.code ?? err?.message}`;
    return out;
  }

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    // Only stamp-named directories are runs. `ACTIVE` is the claims directory (tkt-c248cfbc5d8c)
    // and would otherwise be reported at every session start as a crashed run with no summary.
    if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}T/.test(entry.name)) continue;
    const stamp = entry.name;
    try {
      out.runs.push({ stamp, summary: readSummary(join(nightDir, stamp)) });
    } catch (err) {
      if (err?.code === 'ENOENT') out.missing.push(stamp);
      else out.corrupt.push({ stamp, why: `${err?.code ?? err?.message}` });
    }
  }
  return out;
}

/**
 * @param {{root: string|null, boardDir: string, ticketsDir?: string, readStatus?: Function}} opts
 */
export function collect({ root, boardDir, ticketsDir = null, readStatus = statusOf }) {
  if (!root) {
    return {
      rootless: true,
      active: false,
      tickets: [],
      unfinished: [],
      scan: { runs: [], missing: [], corrupt: [], error: null },
    };
  }
  const scan = scanRuns(join(root, '.night-run'));
  const active = armed(join(root, '.night-run', 'ACTIVE'));
  const tickets_ = ticketsDir ?? ticketsDirFor(boardDir);

  // Keyed by id so a ticket queued on two nights reports once, carrying every verdict.
  const byId = new Map();
  const note = (id, verdict) => {
    if (typeof id !== 'string') return;
    const seen = byId.get(id) ?? { id, verdicts: [] };
    if (verdict) seen.verdicts.push(verdict);
    byId.set(id, seen);
  };

  const unfinished = [];
  for (const { stamp, summary } of scan.runs) {
    for (const result of summary.results) {
      note(result?.id, {
        stamp,
        level: result?.level ?? null,
        text: result?.text ?? null,
        branch: result?.branch ?? null,
        repo: result?.repo ?? null,
      });
    }
    // THE QUEUE, NOT JUST THE RESULTS (review, HIGH). night-run.mjs pushes a result only AFTER a
    // session returns, and its signal handlers (`:388`) call cleanup()+process.exit() WITHOUT
    // saveSummary — so a run killed mid-ticket (SIGHUP on a dropped ssh, reboot, sleep) leaves the
    // in-flight ticket named only here, `results` empty and `exit` null. Reading results alone made
    // the hook silent on precisely the case it exists for.
    //
    // Gated on a non-clean exit, though: a run that finished and reported 0 left nothing in flight,
    // and its unprocessed queue entries are ordinary (a STOP consumed between tickets, or a probe
    // queueing an id that does not exist). Ungated this nagged forever about `tkt-000000000000` from
    // this checkout's own probe runs — measured live, not reasoned.
    if (summary.exit !== 0) for (const id of summary.queue) note(id, null);
    // `exit: null` means the run never reached its own end. While the sentinel is armed that is just
    // a run in flight, which the ACTIVE line already covers, so only an unarmed one is a finding.
    if (summary.exit === null && !active) unfinished.push(stamp);
  }

  const tickets = [];
  for (const entry of byId.values()) {
    const status = readStatus(tickets_, entry.id);
    const alarm = entry.verdicts.some(isAlarm);
    if (!isOutstanding(status) && !alarm) continue;
    // The NEWEST verdict decides, never `.some(isParked)` (review, medium — measured). Verdicts
    // accumulate across every run directory forever, so any historical park would have removed the
    // ticket from `halted` permanently: a ticket parked on night 1 and genuinely abandoned on night 2
    // reported only "PARKED", and the "stopped mid-ticket and need a human" line never appeared.
    tickets.push({ ...entry, status, alarm, parked: isParked(entry.verdicts[entry.verdicts.length - 1]) });
  }
  return { rootless: false, active, tickets, unfinished, scan };
}

function list(ids) {
  return ids.join(', ');
}

// Names the branch and repo the run recorded. A parked ticket whose summary carries neither is still
// NAMED rather than dropped: the id with an explicit "branch not recorded" is a finding a human can
// chase, where omitting the line entirely would hide the work this whole carve-out promises to keep
// visible. The newest verdict wins — a ticket parked on two nights has two, and the older branch may
// since have merged.
function describeParked(ticket) {
  const verdict = [...ticket.verdicts].reverse().find((v) => v.branch);
  if (!verdict) return `${ticket.id} (branch not recorded — find it by hand)`;
  return `${ticket.id} on ${verdict.branch}${verdict.repo ? ` in ${verdict.repo}` : ''}`;
}

/**
 * Turn a collection into the lines to inject, most urgent first. Returns [] when there is genuinely
 * nothing outstanding — the only silent path.
 */
export function assess(collected) {
  if (collected.rootless) {
    return ['[night-run] Could not locate the primary checkout, so `.night-run/` was not read — check it by hand.'];
  }
  const lines = [];

  // An alarm ticket is reported as an alarm whatever its current status. Excluding the in-progress
  // ones folded them into the generic halt line and dropped "the merge gate was crossed" — the most
  // urgent sentence this hook can emit (review, HIGH).
  const alarms = collected.tickets.filter((t) => t.alarm);
  // Parked is carved out of `halted` BEFORE it is counted, not reported alongside it: both are
  // `in-progress`, so a ticket landing in each list would be named twice and the "needs a human"
  // count would overstate what is actually stuck.
  const parked = collected.tickets.filter((t) => !t.alarm && t.parked && t.status === 'in-progress');
  const halted = collected.tickets.filter((t) => !t.alarm && !t.parked && t.status === 'in-progress');
  const unknown = collected.tickets.filter((t) => !t.alarm && t.status === null);
  const merges = collected.tickets.filter((t) => !t.alarm && t.status === 'qa');

  if (alarms.length) {
    lines.push(
      `[night-run] ALARM — a night run reported the merge gate was crossed unattended on ${list(alarms.map((t) => t.id))}. ` +
        'Check what merged before doing anything else.',
    );
  }
  if (halted.length) {
    lines.push(
      `[night-run] ${halted.length} night-run ticket(s) stopped mid-ticket and need a human: ${list(halted.map((t) => t.id))}.`,
    );
  }
  if (parked.length) {
    lines.push(
      `[night-run] ${parked.length} night-run ticket(s) finished but are PARKED at the PR-open gate, committed and unpushed: ` +
        `${parked.map(describeParked).join('; ')}. Each needs "Ready to open PR?", then a push and \`gh pr create\`.`,
    );
  }
  if (unknown.length) {
    lines.push(
      // A parked ticket whose board file later became unreadable lands HERE rather than in `parked`,
      // and the branch is the one fact only the run knows — so it is named in both buckets or it is
      // lost exactly when the board can no longer help (review, low).
      `[night-run] ${unknown.length} night-run ticket(s) have no readable status on the board: ` +
        `${unknown.map((t) => (t.parked ? describeParked(t) : t.id)).join(', ')}.`,
    );
  }
  if (merges.length) {
    lines.push(
      `[night-run] ${merges.length} night-run PR(s) are awaiting your merge decision: ${list(merges.map((t) => t.id))}. ` +
        'Run `npm run night:report`, then take Jake through the merge gate for each.',
    );
  }
  if (collected.active) {
    lines.push(
      '[night-run] A night run is ACTIVE (`.night-run/ACTIVE` is armed), so `gh pr merge` AND every ' +
        'backgrounded Bash call (`run_in_background`) are blocked in this checkout — re-run those in ' +
        'the foreground with an explicit timeout. `npm run night:status` says what it is doing.',
    );
  }
  if (collected.unfinished.length) {
    lines.push(
      `[night-run] ${collected.unfinished.length} run(s) recorded no exit code, so the runner died before finishing: ` +
        `${list(collected.unfinished)}. Read their logs under \`.night-run/\` by hand.`,
    );
  }
  if (collected.scan.missing.length) {
    lines.push(
      `[night-run] ${collected.scan.missing.length} run director(ies) have no summary.json — the runner did not finish: ` +
        `${list(collected.scan.missing)}. Read their logs under \`.night-run/\` by hand.`,
    );
  }
  if (collected.scan.corrupt.length) {
    lines.push(
      `[night-run] ${collected.scan.corrupt.length} summary.json file(s) could not be read: ` +
        `${collected.scan.corrupt.map((c) => `${c.stamp} (${c.why})`).join(', ')}. Check them by hand.`,
    );
  }
  if (collected.scan.error) {
    lines.push(`[night-run] Could not read \`.night-run/\` (${collected.scan.error}) — check it by hand.`);
  }
  return lines;
}

export function formatReport(lines) {
  if (!lines.length) return null;
  return {
    systemMessage: lines[0],
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: lines.join(' '),
    },
  };
}

export function report({ root = resolveRoot(), boardDir = null, env = process.env } = {}) {
  // BOARD_DIR_OVERRIDE is how this machine points a session at the central board, matching the
  // convention SKILL.md's stale-in-progress call uses; TICKETS_DIR_OVERRIDE wins over it per
  // CLAUDE.md and is applied in ticketsDirFor. A ticket outside the resolved board reads as an
  // unknown status, which isOutstanding already treats as outstanding rather than as clean.
  const board = boardDir ?? env.BOARD_DIR_OVERRIDE ?? root;
  return assess(collect({ root, boardDir: board, ticketsDir: root ? ticketsDirFor(board, env) : null }));
}

export const THREW = 'the night-run check threw';

export function main(write = (text) => process.stdout.write(text), reportFn = report) {
  try {
    const payload = formatReport(reportFn());
    if (payload) write(`${JSON.stringify(payload)}\n`);
  } catch (err) {
    // The whole point of this hook is that startup is never degraded by it, so a throw becomes a
    // line rather than a non-zero exit.
    write(
      `${JSON.stringify({
        systemMessage: '[night-run] the night-run check failed to run — check `.night-run/` by hand.',
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: `[night-run] ${THREW} (${String(err?.message ?? err).split('\n')[0].slice(0, 200)}) — check \`.night-run/\` by hand.`,
        },
      })}\n`,
    );
  }
  return 0;
}

// `pathToFileURL`, not `file://${argv[1]}`: a path needing percent-encoding never matches its own
// `import.meta.url`, and a suffix test on the filename would also fire when `scripts/night-report.mjs`
// imports this module — printing a hook payload into the report's own stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
