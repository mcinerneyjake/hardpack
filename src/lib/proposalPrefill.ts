import { TYPES, PRIORITIES, STATUSES, type Ticket } from '../../shared/constants.js';

// CONTENT fields only. Excludes STRUCTURAL fields (project/parent/blockers) whose cross-field invariants live only in the modal's guarded controls — raw-carrying them from the agent would bypass the guards (wipe hidden blocker edges, relink to an archived parent, leave cross-project blockers). tkt-727c5cacdfad.
export type Prefill = Partial<Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'dueDate' | 'assignee'>>;

function isType(v: unknown): v is Ticket['type'] {
  return typeof v === 'string' && TYPES.some((t) => t === v);
}
function isPriority(v: unknown): v is Ticket['priority'] {
  return typeof v === 'string' && PRIORITIES.some((p) => p === v);
}
function isStatus(v: unknown): v is Ticket['status'] {
  return typeof v === 'string' && STATUSES.some((s) => s.id === v);
}

export type DroppedEnum = { field: 'type' | 'priority' | 'status'; value: string };

// Keyed by field so each entry is correlated with ITS OWN predicate: `type: isPriority` does not
// compile (the predicate types differ), and a missing key does not either. That is what keeps the
// report and the drop agreeing about what is valid — the shape, not a comment.
const ENUM_VALIDATORS: { [K in DroppedEnum['field']]: (v: unknown) => v is Ticket[K] } = {
  type: isType,
  priority: isPriority,
  status: isStatus,
};

// The order the notice lists them in. Its agreement with ENUM_VALIDATORS, and with what
// proposalToPrefill actually enum-validates, is asserted in proposalPrefill.test.ts — a test that
// sweeps every Prefill field rather than a hardcoded three, so a NEW validated enum reddens it too.
const ENUM_FIELD_ORDER = ['type', 'priority', 'status'] as const;

// Capped because the value is untrusted local-model output of arbitrary length, and it is rendered
// inline in the modal's draft notice (tkt-a22ba10cd328).
const MAX_VALUE_CHARS = 60;

function cap(s: string): string {
  return s.length > MAX_VALUE_CHARS ? `${s.slice(0, MAX_VALUE_CHARS)}…` : s;
}

// Total by construction. Only JSON types can reach this through the parsed tool call, but the
// signature permits more, and JSON.stringify answers undefined for a symbol/function and throws on
// a bigint — which would surface as "the drafting agent hit an error", blaming the model for a
// client-side crash.
function displayValue(v: unknown): string {
  if (typeof v === 'string') return cap(v);
  if (typeof v === 'number' || typeof v === 'boolean' || v === null) return cap(String(v));
  if (typeof v === 'object') return cap(JSON.stringify(v));
  return typeof v;
}

// What proposalToPrefill threw away, so the modal can say a default is a FALLBACK rather than a
// proposal. Reports only present-and-invalid: an absent (or explicitly undefined) field was never
// proposed, so there is nothing to tell the reviewer.
export function droppedEnumFields(args: Record<string, unknown>): DroppedEnum[] {
  const dropped: DroppedEnum[] = [];
  for (const field of ENUM_FIELD_ORDER) {
    const value = args[field];
    if (value !== undefined && !ENUM_VALIDATORS[field](value)) {
      dropped.push({ field, value: displayValue(value) });
    }
  }
  return dropped;
}

// Keep only values of the right type/enum so a bogus model field can't corrupt the form; the service still validates on write.
export function proposalToPrefill(args: Record<string, unknown>): Prefill {
  const out: Prefill = {};
  if (typeof args.title === 'string') out.title = args.title;
  if (typeof args.body === 'string') out.body = args.body;
  if (isType(args.type)) out.type = args.type;
  if (isPriority(args.priority)) out.priority = args.priority;
  if (isStatus(args.status)) out.status = args.status;
  if (typeof args.dueDate === 'string' || args.dueDate === null) out.dueDate = args.dueDate;
  if (typeof args.assignee === 'string' || args.assignee === null) out.assignee = args.assignee;
  return out;
}

export function proposalTargetId(proposal: { action: string; args: Record<string, unknown> }): string | null {
  return proposal.action === 'update_ticket' && typeof proposal.args.id === 'string'
    ? proposal.args.id
    : null;
}
