import { getTicket, HttpError } from '../../server/tickets.js';
import { type Ticket } from '../../shared/constants.js';
import type { ToolLogEntry } from './loop.js';

// Deterministic post-run check over the tickets an intake run CREATED (tkt-586ed614fde6). It narrows
// the human re-read in CLAUDE.md's ticket-creation step 3; it does not replace it. Coverage of the
// report's substance was measured and rejected — see the ticket for the numbers.

export const POST_RUN_VERDICTS = ['pass', 'drift', 'nothing-created', 'not-checked'] as const;
export type PostRunVerdict = typeof POST_RUN_VERDICTS[number];

export interface CreatedTicketCheck {
  id: string;
  // null = the re-read failed for a reason other than 404, so existence is unknown.
  found: boolean | null;
  unsourcedIds: string[];
}

export interface PostRunCheck {
  verdict: PostRunVerdict;
  tickets: CreatedTicketCheck[];
  reason?: string;
}

// Any case and any length: the service's id validator accepts both, the board holds legacy
// non-hex ids, and a case-insensitive filesystem resolves an upper-cased one to the real file.
const TICKET_ID = /(?<![a-z0-9])tkt-[a-z0-9]+(?![a-z0-9])/gi;

// Tools whose results can legitimately put an id in front of the model. create_ticket is excluded on
// purpose: its echo repeats the body under test, so counting it would source every id it contains.
const SOURCE_TOOLS = new Set(['search_board', 'list_tickets', 'get_ticket']);

export function ticketIdsIn(text: string): string[] {
  return [...new Set((text.match(TICKET_ID) ?? []).map((id) => id.toLowerCase()))];
}

export function notChecked(reason: string): PostRunCheck {
  return { verdict: 'not-checked', tickets: [], reason };
}

// Only reads that returned data, and only those that came back BEFORE this ticket's create: a refusal
// quotes the id it refused, and a later read of the new ticket echoes the body under test.
function sourcedIds(report: string, toolLog: ToolLogEntry[], createdIds: string[], id: string): Set<string> {
  const sourced = new Set([...ticketIdsIn(report), ...createdIds.map((c) => c.toLowerCase())]);
  const createdAt = toolLog.findIndex((e) => e.createdId === id);
  for (const entry of toolLog.slice(0, Math.max(createdAt, 0))) {
    if (entry.isError || !SOURCE_TOOLS.has(entry.name)) continue;
    for (const cited of ticketIdsIn(entry.text)) sourced.add(cited);
  }
  return sourced;
}

async function reread(id: string, read: (id: string) => Promise<Ticket>): Promise<Ticket | false | null> {
  try {
    return await read(id);
  } catch (err) {
    return err instanceof HttpError && err.status === 404 ? false : null;
  }
}

export async function checkCreatedTickets(
  report: string,
  toolLog: ToolLogEntry[],
  createdIds: string[],
  read: (id: string) => Promise<Ticket> = getTicket,
): Promise<PostRunCheck> {
  if (createdIds.length === 0) return { verdict: 'nothing-created', tickets: [] };
  const tickets: CreatedTicketCheck[] = [];
  for (const id of createdIds) {
    const ticket = await reread(id, read);
    if (!ticket) {
      tickets.push({ id, found: ticket === false ? false : null, unsourcedIds: [] });
      continue;
    }
    const sourced = sourcedIds(report, toolLog, createdIds, id);
    const cited = ticketIdsIn(`${ticket.title}\n${ticket.body}`);
    tickets.push({ id, found: true, unsourcedIds: cited.filter((c) => c !== id.toLowerCase() && !sourced.has(c)) });
  }
  const drift = tickets.some((t) => t.found === false || t.unsourcedIds.length > 0);
  // Drift outranks unknown: a confirmed defect is worth reporting even when another re-read failed.
  const verdict: PostRunVerdict = drift ? 'drift' : tickets.some((t) => t.found === null) ? 'not-checked' : 'pass';
  return { verdict, tickets };
}

function isCreatedTicketCheck(v: unknown): v is CreatedTicketCheck {
  return typeof v === 'object' && v !== null
    && 'id' in v && typeof v.id === 'string'
    && 'found' in v && (v.found === null || typeof v.found === 'boolean')
    && 'unsourcedIds' in v && Array.isArray(v.unsourcedIds) && v.unsourcedIds.every((s) => typeof s === 'string');
}

function isVerdict(v: unknown): v is PostRunVerdict {
  return POST_RUN_VERDICTS.some((verdict) => verdict === v);
}

export function isPostRunCheck(v: unknown): v is PostRunCheck {
  return typeof v === 'object' && v !== null
    && 'verdict' in v && isVerdict(v.verdict)
    && 'tickets' in v && Array.isArray(v.tickets) && v.tickets.every(isCreatedTicketCheck)
    && (!('reason' in v) || typeof v.reason === 'string');
}

// One line per ticket that failed, for the CLI. Empty for pass / nothing-created.
export function describeCheck(check: PostRunCheck): string[] {
  if (check.verdict === 'not-checked' && check.tickets.length === 0) {
    return [`post-run check did not run: ${check.reason ?? 'no reason recorded'}`];
  }
  const lines: string[] = [];
  for (const t of check.tickets) {
    if (t.found === false) lines.push(`${t.id} was reported created but does not re-read (404)`);
    else if (t.found === null) lines.push(`${t.id} could not be re-read, so it was not checked`);
    else if (t.unsourcedIds.length > 0) {
      lines.push(`${t.id} cites ${t.unsourcedIds.join(', ')}, which appear in neither the report nor any board read this run made`);
    }
  }
  return lines;
}
