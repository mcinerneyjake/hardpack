// Fallback ticket-mutation CLI for when the kanban MCP server is unavailable (tkt-cccfc5a30f9c).
// MCP servers load at session start and are not hot-reloaded, so a disconnect strands `update_ticket`
// for the whole session — this is the sanctioned escape hatch, not a second everyday path.
//
// Deliberately NOT here: `create` (authoring is delegated to the metered local agent — see CLAUDE.md
// "Ticket creation flow") and `delete` (destructive; stays a prompted MCP call). Reads are already
// covered by the package's own viewer: `npx ticket-workflow show <id>`.
import { readFileSync } from 'node:fs';
import { getTicket, updateTicket } from '../server/tickets';
// AUTONOMY from the package, beside its predicate, so the error lists exactly what isAutonomy accepts.
import { AUTONOMY, isAutonomy, isSpecRef, SPEC_REF_HINT, type TicketPatch } from 'ticket-workflow';
import { isStatusId, isTicketType, isPriority, STATUS_IDS, TYPES, PRIORITIES } from '../shared/constants';

const SETTABLE_FIELDS = [
  'status', 'type', 'priority', 'project', 'assignee', 'dueDate', 'parent', 'autonomy', 'spec',
] as const;
type SettableField = (typeof SETTABLE_FIELDS)[number];

const USAGE = `Usage:
  npm run ticket -- set <id> <field> <value>    ${SETTABLE_FIELDS.join(' | ')}
  npm run ticket -- append <id> <file|->        append markdown to the body (never overwrites)

Pass the literal "null" to clear project/assignee/dueDate/parent/spec.
Read a ticket with the package viewer: npx ticket-workflow show <id>`;

class UsageError extends Error {}

function isSettableField(val: string): val is SettableField {
  return SETTABLE_FIELDS.find((f) => f === val) !== undefined;
}

function patchFor(field: SettableField, value: string): TicketPatch {
  if (field === 'status') {
    if (!isStatusId(value)) throw new UsageError(`invalid status "${value}" — expected one of: ${STATUS_IDS.join(', ')}`);
    return { status: value };
  }
  if (field === 'type') {
    if (!isTicketType(value)) throw new UsageError(`invalid type "${value}" — expected one of: ${TYPES.join(', ')}`);
    return { type: value };
  }
  if (field === 'priority') {
    if (!isPriority(value)) throw new UsageError(`invalid priority "${value}" — expected one of: ${PRIORITIES.join(', ')}`);
    return { priority: value };
  }
  if (field === 'autonomy') {
    if (!isAutonomy(value)) throw new UsageError(`invalid autonomy "${value}" — expected one of: ${AUTONOMY.join(', ')}`);
    return { autonomy: value };
  }
  if (field === 'spec') {
    if (value === 'null') return { spec: null };
    if (!isSpecRef(value)) throw new UsageError(`invalid spec "${value}" — ${SPEC_REF_HINT}`);
    return { spec: value };
  }
  // Passed through unchecked here (the service still validates dueDate); "null" is the only way argv can express empty.
  return { [field]: value === 'null' ? null : value };
}

async function cmdSet(id: string, field: string, value: string): Promise<string> {
  if (!isSettableField(field)) throw new UsageError(`unknown field "${field}"\n\n${USAGE}`);
  const t = await updateTicket(id, patchFor(field, value));
  return `${t.id}  ${field} -> ${t[field] ?? 'null'}`; // read back, so the line proves what persisted
}

async function cmdAppend(id: string, source: string, stdin: string): Promise<string> {
  const text = (source === '-' ? stdin : readFileSync(source, 'utf8')).trim();
  if (!text) throw new UsageError('nothing to append — the input was empty');
  const before = await getTicket(id);
  // appendBody, not a read-modify-write on `body`: the service concatenates server-side, so a stale
  // read can't drop a concurrent edit — and its per-id lock is in-process, so this CLI races an MCP session.
  const t = await updateTicket(id, { appendBody: text });
  return `${t.id}  appended ${text.length} chars (body ${before.body.length} -> ${t.body.length})`;
}

export async function runTicketCli(argv: string[], stdin = ''): Promise<string> {
  const [cmd, id, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h') return USAGE;
  if (!id) throw new UsageError(`missing ticket id\n\n${USAGE}`);

  if (cmd === 'set') {
    const [field, ...valueParts] = rest;
    const value = valueParts.join(' ');
    if (!field || !value) throw new UsageError(`\`set\` needs a field and a value\n\n${USAGE}`);
    return cmdSet(id, field, value);
  }
  if (cmd === 'append') {
    const [source] = rest;
    if (!source) throw new UsageError(`\`append\` needs a file path (or - for stdin)\n\n${USAGE}`);
    return cmdAppend(id, source, stdin);
  }
  throw new UsageError(`unknown command "${cmd}"\n\n${USAGE}`);
}

function isMain(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.endsWith('scripts/ticket.ts');
}

if (isMain()) {
  const stdin = process.argv.includes('-') && !process.stdin.isTTY ? readFileSync(0, 'utf8') : '';
  try {
    console.log(await runTicketCli(process.argv.slice(2), stdin));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
