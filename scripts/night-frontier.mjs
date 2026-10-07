// The night run's work selection (tkt-6ed4a1a0605f): the AFK frontier of the ticket DAG, and the
// check that a session sharing the primary's node_modules has not changed it under its siblings.
//
// Parsing goes through the package's own `parseTicketFile`, so `autonomy` is read by `readAutonomy`
// and fails closed exactly as the board tools do — a hand-rolled frontmatter reader here would be a
// second copy of that rule, free to drift from it.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseTicketFile, PRIORITIES } from 'ticket-workflow';

const TICKET_FILE = /^(tkt-[0-9a-z]+)\.md$/;

export function readBoard(boardDir, { parse = parseTicketFile } = {}) {
  let names;
  try {
    names = readdirSync(join(boardDir, 'tickets'));
  } catch (err) {
    return { ok: false, why: `the board at ${boardDir} could not be listed (${err?.code ?? err?.message})` };
  }
  const tickets = new Map();
  const unreadable = [];
  for (const name of names) {
    const m = TICKET_FILE.exec(name);
    if (!m) continue;
    try {
      tickets.set(m[1], parse(m[1], readFileSync(join(boardDir, 'tickets', name), 'utf8'), name));
    } catch {
      unreadable.push(name);
    }
  }
  return { ok: true, tickets, unreadable };
}

// Only `done` closes a blocker. `archived` is not proof the blocking work merged — the slice
// branches from origin/main and needs it there — so an archived blocker excludes, visibly.
export function whyNotRunnable(ticket, tickets) {
  if (ticket.autonomy !== 'afk') return `autonomy is ${ticket.autonomy}, not afk`;
  if (ticket.status !== 'todo') return `status is ${ticket.status}, not todo`;
  const open = ticket.blockers.map((b) => {
    const s = tickets.get(b)?.status;
    if (s === undefined) return `${b}(missing)`;
    return s === 'done' ? null : `${b}(${s})`;
  }).filter((b) => b !== null);
  return open.length > 0 ? `blocked by ${open.join(', ')}` : null;
}

const rank = (t) => PRIORITIES.length - PRIORITIES.indexOf(t.priority);

export function frontierOf(board, { project = null } = {}) {
  const runnable = [];
  const excluded = [];
  for (const t of board.tickets.values()) {
    if (t.autonomy !== 'afk') continue;
    if (project !== null && t.project !== project) continue;
    // Finished work, not an exclusion: listed, it would bury the real ones a little more every night.
    if (t.status === 'done' || t.status === 'archived') continue;
    const why = whyNotRunnable(t, board.tickets);
    if (why === null) runnable.push(t);
    else excluded.push({ id: t.id, why });
  }
  runnable.sort((a, b) => rank(a) - rank(b) || a.order - b.order || a.id.localeCompare(b.id));
  excluded.sort((a, b) => a.id.localeCompare(b.id));
  return { queue: runnable.map((t) => t.id), excluded };
}

export function refuseNamed(board, ids) {
  const seen = new Set();
  const refused = [];
  for (const id of ids) {
    if (seen.has(id)) {
      refused.push({ id, why: 'named twice' });
      continue;
    }
    seen.add(id);
    const t = board.tickets.get(id);
    const why = t ? whyNotRunnable(t, board.tickets) : 'not on the board (or its file is unreadable)';
    if (why !== null) refused.push({ id, why });
  }
  return refused;
}

// npm rewrites node_modules/.package-lock.json on every install, and `npm ci` recreates the whole
// tree — same bytes, new inode — so the inode and mtime ride along with the hash.
export const DEPS_MARKER = join('node_modules', '.package-lock.json');

export function depsFingerprint(root) {
  const file = join(root, DEPS_MARKER);
  try {
    const st = statSync(file);
    const sha = createHash('sha256').update(readFileSync(file)).digest('hex');
    return { ok: true, value: `${st.ino}:${st.mtimeMs}:${sha}` };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, value: 'absent' };
    return { ok: false, why: `${file} could not be read (${err?.code ?? err?.message})` };
  }
}
