#!/usr/bin/env node
// Detached launcher and observer for the audited night runner (tkt-999d1adc3aa4). `night-run.mjs`
// keeps sole ownership of the sentinel and the queue; this file only starts one, watches it, and
// asks it to stop. Every primitive below is imported, never reimplemented.
//
// WHY DETACHED: `npm run night` dies with the Claude session that launched it. The queue is supposed
// to outlive the session, so the child gets its own process group and its stdio goes to a file.
//
// `cwd: root` IS LOAD-BEARING, and diverges from plain `npm run night` on purpose. The runner's
// `boardDir` defaults to `process.cwd()` and `readStatus` reads `<cwd>/tickets/<id>.md`
// (night-run.mjs:82-89, :333). `tickets/` is gitignored, so it does not exist in a worktree — a run
// launched from one reads EVERY status as null and classifies every ticket as "status unreadable".
// Launching from `primaryRoot()` fixes that here. `npm run night` stays bitten by it: that is
// tkt-03f3b545fdcf, not something this file quietly half-fixes.
//
// CONFINEMENT: `start` only ever launches inside NIGHT_RUN_BOUNDARY, and an unset boundary REFUSES
// rather than defaulting — an unbounded launcher spawning a detached process at whatever
// `primaryRoot()` returns is what this check exists to prevent. `status` and `stop` are deliberately
// NOT bounded; see boundedRoot. The boundary is configured machine-locally because this repo is
// public and the workspace path is not ours to publish.
//
// HARNESS-TIMEOUT TRAP: the Bash tool defaults to a 120s timeout and the pre-flight deadline below is
// 420s, so a default-length `night:start` gets killed by the harness. That is harmless — this process
// is only an observer and the detached runner is in its own session, still going — but it reads as a
// failure. Call with `timeout: 540000`, or pass `--no-wait`.

import { spawn, spawnSync } from 'node:child_process';
import { openSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, realpathSync, rmSync, rmdirSync } from 'node:fs';
import { join, dirname, resolve, sep, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EXIT, PROBE_CAP_MS, GIT_CAP_MS, sentinelPaths, claimPath, readClaims, claimHeld, readClaimNote, pidAlive,
  defaultCommandOf, fileHere, readStatus,
} from './night-run.mjs';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'night-run.mjs');

export const CONTROL_USAGE =
  'usage: npm run night:start -- <ticket-id>... [--no-wait] [--wait-seconds N]\n' +
  '       npm run night:start -- --frontier [--project <name>] [--no-wait] [--wait-seconds N]\n' +
  '       npm run night:status\n' +
  '       npm run night:stop [--now]';

// A run that has not claimed the sentinel within this window has almost always lost it to another
// run. Answering that in five seconds is the whole point of splitting the wait in two.
export const CLAIM_WAIT_MS = 5_000;
// Derived, never transcribed: preflightGuard runs two probes back to back, each capped at
// PROBE_CAP_MS, then the run's worktree is fetched and made under GIT_CAP_MS, plus a margin for
// process start-up.
export const DEFAULT_WAIT_MS = PROBE_CAP_MS * 2 + GIT_CAP_MS + 60_000;
const POLL_MS = 250;

// The runner writes exactly one of these to stdout before it touches a ticket.
const PREFLIGHT_OK = /^pre-flight: /m;
const PREFLIGHT_FAILED = /^pre-flight FAILED/m;

/**
 * THE LINE THAT DECIDES A NIGHT STARTED. Kept as its own function because everything downstream —
 * the exit status, whether the operator is told merges are gated — hangs off it, and "no marker yet"
 * must never collapse into "ok". A null here means undecided, which the caller treats as failure.
 */
export function readVerdict(text) {
  if (PREFLIGHT_FAILED.test(text ?? '')) return 'failed';
  if (PREFLIGHT_OK.test(text ?? '')) return 'ok';
  return null;
}

// Symlinks are resolved before comparing: `resolve` normalises `..` and trailing separators but
// follows nothing, so a contained path reached through a symlinked prefix would be refused and a
// symlink pointing OUT of the boundary would pass. A path that does not exist yet keeps its
// lexical form — there is nothing to follow.
const realOrLexical = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Is `root` inside `boundary`? The separator in the prefix test is load-bearing: a bare
 * `startsWith` accepts a SIBLING whose name merely begins with the boundary's, so `<boundary>-other`
 * would pass as contained. Equality is allowed — the boundary itself is in bounds.
 */
export function withinBoundary(root, boundary) {
  if (!boundary) {
    return { ok: false, why: 'NIGHT_RUN_BOUNDARY is not set, so the workspace this may run in cannot be confirmed — refusing. Set it to the directory the runner is allowed under.' };
  }
  // A relative boundary silently binds to the launcher's cwd, so the SAME value would mean different
  // directories depending on where it was invoked from. That is not a boundary.
  if (!isAbsolute(boundary)) {
    return { ok: false, why: `NIGHT_RUN_BOUNDARY must be an absolute path, got ${JSON.stringify(boundary)}` };
  }
  const b = realOrLexical(boundary);
  const r = realOrLexical(root);
  // `b + sep` would be `//` when the boundary is the filesystem root, which nothing starts with.
  const prefix = b.endsWith(sep) ? b : b + sep;
  if (r !== b && !r.startsWith(prefix)) {
    return { ok: false, why: `refusing: the resolved root ${r} is outside NIGHT_RUN_BOUNDARY (${b})` };
  }
  return { ok: true };
}

/**
 * Only `start` is bounded. Narrowing this to cover `status` and `stop` as well looked more
 * conservative and was the opposite: with no boundary configured — the normal state inside a
 * worktree, which carries no `.env` — it removed the operator's only way to inspect or END a run
 * whose sentinel is already blocking every merge, leaving "delete the file by hand" as the recovery
 * path. Refusing to LAUNCH unbounded is safe; refusing to STOP is a denial of service on the
 * recovery path (review, MEDIUM). Neither verb can wander: both act only on the resolved root of
 * this repo.
 */
function boundedRoot({ resolveRoot, boundary, err }, { bounded = true } = {}) {
  const root = resolveRoot();
  if (!root) {
    err.write('could not locate the primary checkout, so the sentinel the guard reads cannot be found\n');
    return null;
  }
  if (!bounded) return root;
  const check = withinBoundary(root, boundary);
  if (!check.ok) {
    err.write(`${check.why}\n`);
    return null;
  }
  return root;
}

export function parseArgs(argv) {
  const [verb, ...rest] = argv;
  const ids = [];
  let wait = true;
  let waitMs = DEFAULT_WAIT_MS;
  let hard = false;
  let frontier = false;
  let project = null;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--no-wait') { wait = false; continue; }
    if (a === '--frontier') { frontier = true; continue; }
    if (a === '--project') {
      project = rest[i + 1] ?? '';
      i += 1;
      if (!project || project.startsWith('--')) return { ok: false, why: '--project needs a project name' };
      continue;
    }
    if (a === '--now') { hard = true; continue; }
    if (a === '--wait-seconds') {
      const raw = rest[i + 1];
      i += 1;
      const seconds = Number(raw);
      if (!Number.isFinite(seconds) || seconds <= 0) {
        return { ok: false, why: `--wait-seconds must be a positive number of seconds, got ${JSON.stringify(raw)}` };
      }
      waitMs = seconds * 1000;
      continue;
    }
    if (a.startsWith('--')) return { ok: false, why: `unknown flag ${a}` };
    ids.push(a);
  }
  if (project !== null && !frontier) return { ok: false, why: '--project narrows --frontier, and means nothing without it' };
  if (frontier && ids.length > 0) return { ok: false, why: '--frontier selects its own queue, so ticket ids cannot be named with it' };
  return { ok: true, verb, ids, wait, waitMs, hard, frontier, project };
}

// The runner is a process-group leader when this launcher started it (`detached: true`), which is
// what makes signalling the whole group possible — see stopRun.
const defaultPgidOf = (pid) => {
  const res = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' });
  if (res.status !== 0 || !res.stdout?.trim()) return null;
  const pgid = Number.parseInt(res.stdout.trim(), 10);
  return Number.isInteger(pgid) && pgid > 0 ? pgid : null;
};

/**
 * Who holds the sentinel, and are they really night runs? One verdict PER CLAIM, since more than one
 * run may hold the gate (tkt-c248cfbc5d8c). `pidAlive` alone answers the wrong question: pids are
 * reused, so a dead runner's number can belong to somebody's editor and read as a healthy night.
 * Every "cannot tell" branch gets its own kind rather than folding into `live` — a status that
 * cannot confirm a night run must not report one. (The same hole inside `claimSentinel` is
 * tkt-bbb2735702ba; this file does not touch it.)
 */
export function claimStates(root, { alive = pidAlive, commandOf = defaultCommandOf } = {}) {
  const found = readClaims(root);
  const judge = (pid) => {
    if (!alive(pid)) return { kind: 'dead', pid };
    const cmd = commandOf(pid);
    if (cmd === null) return { kind: 'unknown-command', pid };
    if (!cmd.includes('night-run.mjs')) return { kind: 'foreign', pid, cmd };
    // Ids are read from whole ARGUMENTS after the runner path, never scraped from the command string:
    // a checkout under `.claude/worktrees/tkt-<id>-slug` puts a ticket id in the path itself, and a
    // free `matchAll` reports it as queued work that was never queued (measured on this ticket).
    const argv = cmd.split(/\s+/);
    const at = argv.findIndex((t) => t.includes('night-run.mjs'));
    const queue = at === -1 ? [] : argv.slice(at + 1).filter((t) => /^tkt-[0-9a-f]{12}$/.test(t));
    // Only the two pointers are taken off the note. It is free-form JSON any session can write, and
    // spread whole it could overwrite the verdict — a `kind: 'dead'` there would have `--now` sweep a
    // live run's claim (review, CONFIRMED).
    const note = readClaimNote(root, pid);
    const pointers = Object.fromEntries(['logDir', 'worktree'].filter((k) => typeof note[k] === 'string').map((k) => [k, note[k]]));
    return { kind: 'live', pid, cmd, queue, ...pointers };
  };
  if (found.kind === 'absent' || found.kind === 'unreadable') return { kind: found.kind, claims: [], junk: [] };
  if (found.kind === 'legacy') {
    return { kind: 'legacy', claims: [found.legacyPid === null ? { kind: 'unreadable' } : judge(found.legacyPid)], junk: [] };
  }
  const claims = found.pids.map(judge);
  return { kind: claims.length === 0 && found.junk.length === 0 ? 'empty' : 'dir', claims, junk: found.junk };
}

const liveOf = (state) => state.claims.filter((c) => c.kind === 'live');

const describeStale = (state) => (state.kind === 'unreadable'
  ? 'unreadable'
  : [
    ...state.claims.map((c) => `${c.kind}${c.pid ? ` pid ${c.pid}` : ''}`),
    ...state.junk.map((j) => `junk ${JSON.stringify(j)}`),
  ].join(', '));

const realSleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function pollUntil(check, { deadlineMs, sleep, now }) {
  const end = now() + deadlineMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (now() >= end) return null;
    await sleep(POLL_MS);
  }
}

const readIfThere = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
};

const tail = (text, n) => {
  const lines = (text ?? '').split('\n').filter((l) => l !== '');
  return lines.length > n ? lines.slice(-n) : lines;
};

// null means the directory could not be READ — kept distinct from an empty list, so a status line
// never reports absence it did not measure.
const sortedMatching = (dir, pred) => {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const scored = entries.filter(pred).map((name) => {
    try {
      return { name, at: statSync(join(dir, name)).mtimeMs };
    } catch {
      return null;
    }
  }).filter(Boolean);
  scored.sort((a, b) => b.at - a.at);
  return scored;
};

const isRunnerLog = (n) => /^runner-.*\.log$/.test(n);

/**
 * The runner's self-declaration, written by night-run.mjs once it holds the sentinel.
 *
 * Two separate reasons for the shape. The distinct literal, rather than a bare `/pid (\d+)/`:
 * a refused launch names the OWNER's pid in prose (`another night run (pid N) already holds the
 * sentinel`), so a bare match attributes, with total confidence, the one log that certainly is not
 * the owner's — the defect itself (tkt-166e6cfe2e2c). The line ANCHOR: `status` prints tails
 * prefixed `  | `, so a re-logged status output carries a verbatim declaration belonging to another
 * run. `readVerdict` guards the same mid-line quoting hazard.
 */
const declarationOf = (text) => {
  // LAST match, not the first: `openLog` opens the runner log in append mode, so one file can carry
  // two runs' output (a repeated ISO stamp — an NTP step back is enough). First-match-wins would let
  // a dead run's declaration hide the current owner's, further down the same file.
  const m = [...(text ?? '').matchAll(/^night-run pid (\d+) — logs (.+)$/gm)].at(-1);
  return m ? { pid: Number.parseInt(m[1], 10), logDir: m[2].trim() } : null;
};

// Newest-first, so the ordinary case — the owner's log IS the newest — stops at the first read.
const ownerLogFrom = (dir, logs, pid) => {
  for (const { name } of logs) {
    const text = readIfThere(join(dir, name));
    const decl = declarationOf(text);
    if (decl && decl.pid === pid) return { name, text, logDir: decl.logDir };
  }
  return null;
};

const since = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
};

async function start(args, deps) {
  const { out, err, spawnFn, openLog, now, sleep, alive, commandOf } = deps;

  const bad = args.ids.filter((id) => !/^tkt-[0-9a-f]{12}$/.test(id));
  if ((!args.frontier && args.ids.length === 0) || bad.length > 0) {
    // Caught here rather than in the child: a detached runner's usage error lands in a log nobody is
    // watching, so a typo would read as a night that quietly ran nothing.
    err.write(`${bad.length ? `not a ticket id: ${bad.join(', ')}\n` : 'no ticket ids given\n'}${CONTROL_USAGE}\n`);
    return EXIT.usage;
  }

  const root = boundedRoot(deps);
  if (!root) return EXIT.preflight;

  const dir = join(root, '.night-run');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const logPath = join(dir, `runner-${stamp}.log`);
  const fd = openLog(logPath);

  let exited = null;
  let spawnError = null;
  const runnerArgs = args.frontier ? ['--frontier', ...(args.project ? ['--project', args.project] : [])] : args.ids;
  const queue = args.frontier ? `the AFK frontier${args.project ? ` of ${args.project}` : ''}` : args.ids.join(' ');
  const child = spawnFn(process.execPath, [RUNNER, ...runnerArgs], {
    cwd: root,
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  // A spawn that fails never emits 'exit', and with no 'error' listener the poll below would run to
  // its full deadline before reporting a child that never existed.
  child.on('error', (e) => { spawnError = e; });
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  child.unref();

  const pid = child.pid;
  out.write(`runner pid ${pid ?? '(none)'} — log ${logPath}\n`);

  const claimed = await pollUntil(
    () => (spawnError ? 'error' : exited ? 'exited' : claimHeld(root, pid) ? 'claimed' : null),
    { deadlineMs: CLAIM_WAIT_MS, sleep, now },
  );
  if (claimed === 'error') {
    err.write(`the runner could not be started (${String(spawnError)})\n`);
    return EXIT.stopped;
  }
  // Selection runs before the claim (tkt-6ed4a1a0605f), so an exit there carries the runner's own
  // verdict: 0 is an empty frontier, which is a quiet night, and a refused queue keeps its pre-flight
  // code rather than reading as a crash.
  if (claimed === 'exited' && (exited.code === EXIT.ok || exited.code === EXIT.preflight)) {
    (exited.code === EXIT.ok ? out : err).write(`the runner exited before claiming the sentinel (code ${exited.code}); nothing was run\n${readIfThere(logPath)}`);
    return exited.code;
  }
  if (claimed === 'exited' || claimed === null) {
    // The runner's own log carries the reason a claim was refused — a live single-owner sentinel from
    // an older runner is the one case left, now that live claims coexist.
    const why = claimed === 'exited'
      ? `the runner exited immediately (code ${exited.code}, signal ${exited.signal ?? 'none'})`
      : `the runner did not claim the sentinel within ${CLAIM_WAIT_MS / 1000}s`;
    err.write(`${why}\n${readIfThere(logPath)}`);
    return EXIT.stopped;
  }

  if (!args.wait) {
    out.write(`sentinel claimed by pid ${pid}; queue: ${queue}\npre-flight NOT waited for (--no-wait) — check with: npm run night:status\n`);
    return EXIT.ok;
  }

  // `exited` is tested FIRST. Reading the verdict first meant a runner that printed its pre-flight
  // line and then stopped resolved to 'ok', and a stopped runner was announced as a started night —
  // reachable in one poll interval whenever a leftover STOP file makes the runner pass pre-flight,
  // break out of the queue and disarm (review, CRITICAL; reproduced, exit 0 with the sentinel gone).
  const verdict = await pollUntil(
    () => (exited ? 'exited' : readVerdict(readIfThere(logPath))),
    { deadlineMs: args.waitMs, sleep, now },
  );

  // A passing pre-flight is necessary but NOT sufficient: the success line claims merges are gated
  // right now, so the sentinel must still be held by this child at the moment we say so.
  if (verdict === 'ok') {
    if (!exited && claimHeld(root, pid)) {
      out.write(
        `pre-flight confirmed — the merge guard blocks while armed and permits while disarmed.\n` +
        `night run started: pid ${pid}\n` +
        `queue: ${queue}\n` +
        `log: ${logPath}\n` +
        `\`gh pr merge\` is now BLOCKED in ${root} until every night run ends (npm run night:stop).\n`,
      );
      return EXIT.ok;
    }
    const holders = readClaims(root).pids;
    err.write(
      `the runner passed its pre-flight and then STOPPED — NO night is running and merges are NOT gated.\n` +
      `${holders.length === 0 ? 'No claim on the sentinel remains.' : `The sentinel is now held by pid ${holders.join(', ')}, not by this runner.`}\n` +
      `A leftover STOP file is the usual cause; check the log and start again.\nlog: ${logPath}\n${tail(readIfThere(logPath), 20).join('\n')}\n`,
    );
    return EXIT.preflight;
  }

  // Everything below is a non-start. The child is deliberately left alone on the deadline path: slow
  // is not broken, and killing a runner that is merely still probing would destroy the evidence.
  const log = readIfThere(logPath);
  if (verdict === 'failed' || verdict === 'exited') {
    const state = claimStates(root, { alive, commandOf });
    const live = liveOf(state);
    // The log is re-read because `exited` short-circuits the poll: the runner may have printed a
    // verdict in the same interval it died, and "exited having passed" reads very differently from
    // "exited saying nothing".
    const late = readVerdict(log);
    const headline = verdict === 'failed' || late === 'failed'
      ? 'pre-flight FAILED'
      : `the runner exited ${late === 'ok' ? 'just after passing its pre-flight' : 'before reporting a pre-flight verdict'} (code ${exited?.code}, signal ${exited?.signal ?? 'none'})`;
    // Never point `--now` at a CONFIRMED live run: that would SIGTERM somebody else's healthy night
    // to tidy up after ours (review, LOW). A live run wins over any stale claim beside it, because
    // `--now` would reach both.
    const advice = live.length > 0
      ? `the sentinel is held by live night run(s) pid ${live.map((c) => c.pid).join(', ')} — leave them alone; they are not yours.\n`
      : state.kind === 'absent' || state.kind === 'empty'
        ? ''
        : `sentinel still present (${describeStale(state)}); clear it with: npm run night:stop -- --now\n`;
    err.write(`${headline} — no night was started.\n${log}${advice}`);
    return EXIT.preflight;
  }
  err.write(
    `pre-flight NOT confirmed after ${Math.round(args.waitMs / 1000)}s — the runner (pid ${pid}) is still going and has NOT been killed.\n` +
    `Do not assume a night is running: watch it with \`npm run night:status\`, or end it with \`npm run night:stop\`.\n` +
    `log: ${logPath}\n${tail(log, 20).join('\n')}\n`,
  );
  return EXIT.preflight;
}

function status(deps) {
  const { out, alive, commandOf, now } = deps;
  const root = boundedRoot(deps, { bounded: false });
  if (!root) return EXIT.preflight;

  const { active, stop } = sentinelPaths(root);
  const dir = join(root, '.night-run');
  const state = claimStates(root, { alive, commandOf });
  const live = liveOf(state);
  const lines = [`root: ${root}`];

  if (state.kind === 'absent' || state.kind === 'empty') {
    const form = state.kind === 'empty' ? ' (the claims directory is present but empty)' : '';
    lines.push(`sentinel: NOT armed${form} — no night run is active, and \`gh pr merge\` is not gated here.`);
  } else {
    let armedAt;
    try { armedAt = statSync(active).mtimeMs; } catch { armedAt = null; }
    const elapsed = armedAt === null ? 'unknown' : since(now() - armedAt);
    // The directory's mtime moves with every claim, so this is claim churn rather than arming time.
    lines.push(`sentinel: ARMED (${active}), claims last changed ${elapsed} ago — \`gh pr merge\` is BLOCKED in this checkout.`);
    if (state.kind === 'unreadable') {
      lines.push('owner: the sentinel exists but could not be read — remove it by hand if no night run is going.');
    }
    if (state.kind === 'legacy') {
      lines.push('form: a single-owner file from a runner that predates per-run claims; a new run waits for it.');
    }
    // `--now` reaches EVERY claim, so a stale one beside a live run is not cleared with it.
    const clearing = live.length > 0
      ? 'It is swept by the next run to start; `npm run night:stop -- --now` would also STOP the live run(s) above.'
      : 'Clear it with `npm run night:stop -- --now`.';
    for (const c of state.claims) {
      switch (c.kind) {
        case 'live':
          lines.push(`owner: pid ${c.pid}, alive, running night-run.mjs`);
          lines.push(`queue: ${c.queue.length ? c.queue.join(' ') : '(none named on its command line)'}`);
          if (c.worktree) lines.push(`worktree: ${c.worktree}`);
          break;
        case 'foreign':
          lines.push(`owner: pid ${c.pid} is alive but is NOT a night run — stale, reused pid. Command: ${c.cmd}`);
          lines.push(`The gate is held by a claim nobody owns, and \`--now\` refuses an unconfirmed pid; remove ${state.kind === 'legacy' ? active : claimPath(root, c.pid)} by hand.`);
          break;
        case 'unknown-command':
          lines.push(`owner: pid ${c.pid} is alive but its command could not be read, so it cannot be confirmed as a night run.`);
          break;
        case 'dead':
          lines.push(`owner: pid ${c.pid} is GONE — a crashed run left its claim behind. ${clearing}`);
          break;
        default:
          lines.push('owner: the sentinel exists but its pid could not be parsed — remove it by hand if no night run is going.');
      }
    }
    for (const j of state.junk) {
      lines.push(`claim ${JSON.stringify(j)}: not a pid — it keeps the gate armed; remove ${join(active, j)} by hand.`);
    }
  }

  lines.push(`STOP: ${fileHere(stop) ? `present (${stop}) — every queue ends after its ticket in flight` : 'absent'}`);

  // Attribution keys off the OWNER PID, which `dead`, `foreign` and `unknown-command` carry just as
  // `live` does — a crashed run's own log is exactly what an operator wants named, and reaching for
  // the newest instead reproduces this ticket's defect in those states (review, MEDIUM). Only
  // `absent` and `unreadable` have no pid at all. `in flight:` stays gated on `live` separately:
  // the log outlives the run that wrote it (review, LOW).
  const logs = sortedMatching(dir, isRunnerLog);
  if (logs === null) {
    lines.push(`runner log: UNKNOWN — ${dir} could not be read, so no log can be attributed. This is not a report that none exists.`);
  } else {
    // One attribution PER CLAIM (tkt-c248cfbc5d8c), each keyed off that claim's pid.
    const withPid = state.claims.filter((c) => c.pid !== undefined);
    if (withPid.length === 0) {
      const log = logs[0];
      lines.push(log
        ? `runner log: ${log.name} (newest — the sentinel names no pid to attribute it to)`
        : 'runner log: none in .night-run/');
      if (log) lines.push(...tail(readIfThere(join(dir, log.name)), 12).map((l) => `  | ${l}`));
    }
    for (const c of withPid) {
      const owned = ownerLogFrom(dir, logs, c.pid);
      if (!owned) {
        // "Cannot tell" does not fall back to the newest. That fallback is what printed a refused
        // launch's `Aborting; no tickets were run` under a healthy run (tkt-166e6cfe2e2c). The newest
        // is named but NOT shown, and deliberately not called somebody else's: a runner declares
        // itself only after claiming and making its log dir, so a status inside that window — or
        // against a run started before this line existed — is disowning the live run's own log.
        lines.push(`runner log: NOT identified — no runner-*.log in ${dir} declares pid ${c.pid}${logs[0] ? `; the newest (${logs[0].name}) is not shown, since nothing ties it to this pid` : ', and none is present'}.`);
      } else {
        lines.push(`runner log: ${owned.name} (pid ${c.pid})`);
        lines.push(...tail(owned.text, 12).map((l) => `  | ${l}`));
      }
      // The run directory comes from the claim's own note or the owner's OWN declaration, never from an
      // independent newest-of pick. The runner prints `--- <id>` as it picks each ticket up, so that
      // names the ticket in flight before its live tee exists.
      const runDir = c.logDir ?? owned?.logDir ?? null;
      const declared = owned ? [...owned.text.matchAll(/^--- (tkt-[0-9a-f]{12})/gm)].at(-1)?.[1] ?? null : null;
      if (c.kind === 'live' && runDir) lines.push(...inFlightLines(root, runDir, { declared }));
    }
  }

  out.write(`${lines.join('\n')}\n`);
  return EXIT.ok;
}

// The ticket in flight is the one whose live tee has no finished `<id>.log` beside it yet, or failing
// that the one the runner log last declared with `--- <id>` — a session that has not written a byte
// yet has a tee-less tick.
function inFlightLines(root, logDir, { declared = null } = {}) {
  const lines = [`run dir: ${logDir}`];
  let names = [];
  let readable = true;
  try {
    names = readdirSync(logDir);
  } catch {
    readable = false;
  }
  const finished = new Set(names.filter((n) => /^tkt-[0-9a-f]{12}\.log$/.test(n)).map((n) => n.slice(0, 16)));
  const fromTees = names
    .filter((n) => /^tkt-[0-9a-f]{12}\.live\.log$/.test(n))
    .map((n) => n.slice(0, 16))
    .filter((id) => !finished.has(id))
    .at(-1) ?? null;
  const inFlight = fromTees ?? (declared && !finished.has(declared) ? declared : null);
  if (!inFlight) {
    return [...lines, readable
      ? 'in flight: none — between tickets, or still in pre-flight'
      : 'in flight: unknown — the run directory could not be read'];
  }
  const board = readStatus(root, inFlight);
  lines.push(`in flight: ${inFlight} (board status now ${board ?? 'unreadable'})`);
  const tee = readIfThere(join(logDir, `${inFlight}.live.log`));
  lines.push(tee ? `live tail (${inFlight}.live.log):` : `live tail: none yet for ${inFlight}`);
  lines.push(...tail(tee, 12).map((l) => `  | ${l}`));
  return lines;
}

function stopRun(args, deps) {
  const { out, alive, commandOf, kill, pgidOf } = deps;
  const root = boundedRoot(deps, { bounded: false });
  if (!root) return EXIT.preflight;
  const { active, stop } = sentinelPaths(root);
  const state = claimStates(root, { alive, commandOf });
  const live = liveOf(state);

  // Writing STOP with nothing LIVE leaves a LANDMINE: the next run breaks out of its queue before any
  // ticket, having run nothing, and reports a clean night. The old order wrote the file and then
  // announced there was nothing to stop (review, MEDIUM); a dead claim would consume it just as
  // little as no claim.
  if (live.length === 0) {
    out.write(state.kind === 'absent' || state.kind === 'empty'
      ? `No night run is active (no claim at ${active}), so there is nothing to stop and no STOP file was written.\n`
      : `No LIVE night run holds the sentinel (${describeStale(state)}), so no STOP file was written.\n`);
    return args.hard && state.kind !== 'absent' && state.kind !== 'empty' ? clearStale(state, deps, root) : EXIT.ok;
  }

  mkdirSync(join(root, '.night-run'), { recursive: true });
  writeFileSync(stop, `${new Date().toISOString()}\n`);
  const runs = live.length === 1 ? 'the queue ends' : `all ${live.length} queues end`;
  out.write(`wrote ${stop} — ${runs} cleanly after the ticket in flight (live run${live.length === 1 ? '' : 's'}: pid ${live.map((c) => c.pid).join(', ')}).\n`);

  if (!args.hard) return EXIT.ok;
  // --now signals EVERY live owner: STOP is one file read by every run, so the hard form is too.
  for (const c of live) {
    // THE PROCESS GROUP, not the pid. The runner's signal handler disarms the sentinel and exits,
    // but never touches the `claude` session it spawned — that child is not detached, so it is
    // merely orphaned and keeps running. Signalling the pid alone therefore REMOVED the merge gate
    // and left a live `--gates auto-pr` session free to merge: the exact thing the sentinel exists
    // to prevent (review, HIGH). The runner leads its own group because the launcher spawns it
    // detached; a runner started another way may not, and then the child genuinely can survive.
    const pgid = pgidOf(c.pid);
    if (pgid === c.pid) {
      kill(-c.pid, 'SIGTERM');
      out.write(`sent SIGTERM to process group ${c.pid} — the runner and the session it is driving both stop, and it disarms its claim on the way out.\n`);
      continue;
    }
    kill(c.pid, 'SIGTERM');
    out.write(
      `sent SIGTERM to pid ${c.pid} only — it is not a process-group leader (pgid ${pgid ?? 'unreadable'}), so a session it spawned may SURVIVE this signal and is no longer merge-gated once the sentinel clears. Check for a stray \`claude\` process.\n`,
    );
  }
  return clearStale(state, deps, root);
}

// The stale claims beside (or instead of) the live ones. A pid that cannot be CONFIRMED as a night
// run is never signalled: pids are reused, and SIGTERM to the wrong one kills a stranger's process to
// tidy up our own file. A claim whose owner is confirmed DEAD is the leak the next claimer would
// sweep; sweeping it here is that takeover on demand. A claim that cannot be read is not confirmed
// anything and is left for a hand, as `claimSentinel` leaves it (review, CONFIRMED).
function clearStale(state, { out, err }, root) {
  const { active } = sentinelPaths(root);
  let code = EXIT.ok;
  for (const c of state.claims) {
    if (c.kind === 'live') continue;
    if (c.kind === 'dead') {
      const target = state.kind === 'legacy' ? active : claimPath(root, c.pid);
      try {
        rmSync(target, { force: true });
        out.write(`swept the claim left by dead pid ${c.pid} (${target}).\n`);
      } catch (e) {
        out.write(`could not remove the claim left by dead pid ${c.pid} at ${target} (${e?.code ?? e?.message}) — remove it by hand.\n`);
      }
      continue;
    }
    if (c.kind === 'unreadable') {
      out.write(`the sentinel at ${active} holds no parseable pid, so nothing can be confirmed about it — remove it by hand if no night run is going.\n`);
      continue;
    }
    err.write(`refusing to signal pid ${c.pid}: it could not be confirmed as a night run (${c.kind}). Kill it by hand if you are sure.\n`);
    code = EXIT.stopped;
  }
  for (const j of state.junk) {
    out.write(`claim ${JSON.stringify(j)} is not a pid and was left alone — remove ${join(active, j)} by hand.\n`);
  }
  if (state.kind === 'unreadable') out.write(`the sentinel at ${active} could not be read — remove it by hand if no night run is going.\n`);
  try {
    rmdirSync(active);
  } catch { /* still holds a claim, or was a file */ }
  return code;
}

export async function main(argv = process.argv.slice(2), {
  resolveRoot = primaryRoot,
  // Injectable so the confinement default below is itself testable: a test supplies `env: {}` and
  // omits `boundary`, which exercises this expression instead of bypassing it (tkt-f77eab475f15).
  env = process.env,
  boundary = env.NIGHT_RUN_BOUNDARY,
  spawnFn = spawn,
  openLog = (p) => openSync(p, 'a'),
  now = Date.now,
  sleep = realSleep,
  alive = pidAlive,
  commandOf = defaultCommandOf,
  pgidOf = defaultPgidOf,
  kill = process.kill.bind(process),
  out = process.stdout,
  err = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (!args.ok) {
    err.write(`${args.why}\n${CONTROL_USAGE}\n`);
    return EXIT.usage;
  }
  const deps = { resolveRoot, boundary, spawnFn, openLog, now, sleep, alive, commandOf, pgidOf, kill, out, err };
  switch (args.verb) {
    case 'start': return start(args, deps);
    case 'status': return status(deps);
    case 'stop': return stopRun(args, deps);
    default:
      err.write(`${args.verb ? `unknown verb ${args.verb}` : 'no verb given'}\n${CONTROL_USAGE}\n`);
      return EXIT.usage;
  }
}

// `file://${argv[1]}` is not a URL: a path needing percent-encoding (a space, a `#`) never matches
// its own `import.meta.url`, so the CLI would do nothing and exit 0 — a silent success in the one
// file whose contract is never to report one (review, LOW).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => process.exit(code));
}
