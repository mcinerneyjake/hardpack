import { z } from 'zod';
import type { TicketFields } from '../validation.js';

// Request payloads for the intake endpoints. NOT validated by the service/agent
// layer, so the schema IS their validation. z.infer single-sources type + validator.

// POST /api/intake/search. query required; an invalid limit falls back to 5 (.catch(5)) rather
// than rejecting — this endpoint never 400s on limit, and a refactor must keep that.
// The bound sits INSIDE the .catch, so out-of-range widens what falls back rather than starting to
// reject: `k` otherwise reaches `.slice(0, Math.max(0, k))` unexamined, and 0 or a negative reports
// "no matches" about a board that matched (tkt-8585f0de3ef6 finding K).
export const intakeSearchSchema = z.object({
  query: z.string({ error: 'query is required' }).trim().min(1, 'query is required'),
  limit: z.number().int().min(1).max(50).catch(5),
});
export type IntakeSearchRequest = z.infer<typeof intakeSearchSchema>

// POST /api/intake/propose — run the intake agent in PROPOSE mode.
export const intakeProposeSchema = z.object({
  report: z.string({ error: 'report is required' }).trim().min(1, 'report is required'),
});
export type IntakeProposeRequest = z.infer<typeof intakeProposeSchema>

// Keyed by `keyof TicketFields` so a field added upstream fails typecheck here rather than being
// silently rejected at runtime — a hand-written key list would just drift (tkt-f9a2fc5604cd).
// Values stay unknown: extractTicketFields owns type validation, and restating it here is the
// second hand-kept field list this slice exists to avoid.
// `.optional()`: under zod 4 a bare z.unknown() is a REQUIRED key, so omitting it 400s every apply.
const anyValue = z.unknown().optional();
const ticketFieldArgs: Record<keyof TicketFields, z.ZodType> = {
  title: anyValue,
  type: anyValue,
  priority: anyValue,
  status: anyValue,
  body: anyValue,
  appendBody: anyValue,
  project: anyValue,
  parent: anyValue,
  dueDate: anyValue,
  assignee: anyValue,
  blockers: anyValue,
  autonomy: anyValue,
  spec: anyValue,
};

// POST /api/intake/apply. args = the user's final form fields (validated by the
// ticket service); runId links to the drafting propose call for metering.
export const intakeApplySchema = z.object({
  action: z.enum(['create_ticket', 'update_ticket']),
  runId: z.string().trim().min(1, 'runId is required'),
  // strict: an unknown key is refused rather than carried to the service and dropped there.
  // `id` is read by apply() itself (the update target), not by extractTicketFields.
  args: z.strictObject({ ...ticketFieldArgs, id: anyValue }),
});
export type IntakeApplyRequest = z.infer<typeof intakeApplySchema>
