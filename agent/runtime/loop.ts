import { randomUUID } from 'node:crypto';
import {
  AGENT_TOOLS,
  AGENT_TOOLS_CREATE_ONLY,
  AGENT_TOOL_NAMES,
  CREATE_ONLY_TOOL_NAMES,
  dispatchTool,
  textResult,
} from './tools.js';
import { type ChatClient, type ChatMessage } from './llm.js';
import { type DocumentIndex } from '../retrieval/retrieval.js';
import { type ToolResult } from '../../mcp/handlers.js';
import { type RunOutcome } from '../cost/economics.js';
import { UNTRUSTED_BOUNDARY_RULE, fenceUntrusted } from './untrusted.js';

// Tool-use loop + human-in-the-loop approval gate. Drives a ChatClient through the agent's tools to a final answer. When `approve` is supplied the gate is fail-safe: only read-only tools run freely, everything else (writes + any tool added later) routes through `approve`. Omitting `approve` is an explicit auto-approve opt-out for programmatic callers.

export const SYSTEM_PROMPT = `You are an intake agent for a kanban board. Given a raw report (a bug, a request, or a note), land it on the board correctly:
1. Extract the concrete issue(s) from the input.
2. For each issue, ALWAYS call search_board FIRST to find existing tickets.
3. If a clear, OPEN duplicate or closely related ticket exists, prefer update_ticket over creating a new one. Each search result includes a "status" — IGNORE archived or done tickets as update targets (they are closed); create a new ticket instead, and you may reference the related closed one.
4. Only call create_ticket when nothing OPEN on the board already covers the issue.
When finished, you MUST reply with a 1-3 sentence plain-text summary that names each ticket you created or updated (its id and title), or states that no action was taken and why. Never reply with an empty message.
${UNTRUSTED_BOUNDARY_RULE}`;

// Create-only variant (the Claude-delegated path, tkt-2492e26a277a): update_ticket is not in the
// toolset, so search_board is for REFERENCE only — never to modify an existing ticket. Steers toward a
// new ticket every time, citing any related id in the body instead of updating it.
// Step 1 inverts what this prompt used to say (tkt-dd22f37d1c60) — it is a correction, not a nudge.
export const SYSTEM_PROMPT_CREATE_ONLY = `You are an intake agent for a kanban board. Given a raw report (a bug, a request, or a note), file it as a ticket:
1. Prefer ONE ticket for the whole report. Several symptoms of one problem, or several parts of one piece of work, are ONE ticket — put the extra parts in that ticket's body as detail, do not split them out. A list inside the report is not a reason to split. Only file separate tickets when the issues are genuinely independent: different causes that could be fixed, shipped, or closed on their own.
2. Before filing a ticket, call search_board — but ONLY to find related tickets to REFERENCE (cite the related id in that ticket's body). Search again for each further ticket you file. You cannot modify existing tickets in this mode.
3. Then call create_ticket. Even if a duplicate or closely related ticket already exists, create a new ticket and name the related id in the body rather than trying to update it.
When finished, you MUST reply with a 1-3 sentence plain-text summary that names each ticket you created (its id and title). Never reply with an empty message.
${UNTRUSTED_BOUNDARY_RULE}`;

// Fixed cacheable prompt prefix (system prompt + tool schema), priced separately from the dynamic text. Composed ONCE so the CLI and the in-app intake controller can't drift on the cost basis (both feed it to meterRun). One per mode — the create-only prefix omits update_ticket's schema, so metering tracks the actual tools sent.
export const RUN_PREFIX_TEXT = SYSTEM_PROMPT + JSON.stringify(AGENT_TOOLS);
export const RUN_PREFIX_TEXT_CREATE_ONLY = SYSTEM_PROMPT_CREATE_ONLY + JSON.stringify(AGENT_TOOLS_CREATE_ONLY);

// Read-only tools run without approval; everything else is gated — a tool added later defaults to requiring approval (fail-safe, not fail-open).
const READ_ONLY_TOOLS = new Set(['search_board', 'list_tickets', 'get_ticket']);

// Shown if the model returns an empty final answer — the CLI should never print a blank result.
const EMPTY_SUMMARY_FALLBACK = 'The agent finished but did not return a summary.';

// Runaway guard for the UNATTENDED create-only path (tkt-dd22f37d1c60): bounds tickets created,
// which maxSteps does not. 3, not 1 — suppressing over-decomposition is the prompt's job; this only
// stops the spray. Full mode is excluded: there the human approval gate is the bound, and capping
// ahead of it would silently drop a create the human never got to see.
const DEFAULT_MAX_CREATES = 3;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// Tool-call args arrive as a JSON string; tolerate malformed/empty by passing undefined to the tool (which reports its own error).
function parseArgs(raw: string): Record<string, unknown> | undefined {
  if (!raw.trim()) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

// The loop forwards only a result's text, so this message must be self-describing: tells the model the action was declined and not to retry.
function declined(name: string): ToolResult {
  return {
    content: [{ type: 'text', text: `The human reviewer declined ${name}. Do not retry it; summarize what was and was not done.` }],
  };
}

// Same contract as declined(): the loop forwards only the text, so this must tell the model the cap
// is a hard stop rather than a transient failure — otherwise it retries and burns the step budget.
function creationCapped(max: number): ToolResult {
  return textResult(`Ticket creation limit reached: this run has already created ${max} ticket(s), which is the maximum allowed. Do not call create_ticket again. Summarize the tickets you created and state plainly anything you could not file.`, true);
}

// A human approval gate for a proposed mutating action. Return false to skip it.
export type ApproveFn = (name: string, args: Record<string, unknown> | undefined) => boolean | Promise<boolean>;

// Every dispatched tool result in call order, text before fencing. isError is kept here because the
// chat transcript drops it, and the post-run check must not treat a refusal as a board read.
export interface ToolLogEntry {
  name: string;
  isError: boolean;
  text: string;
  createdId: string | null;
}

export interface IntakeResult {
  final: string;
  messages: ChatMessage[];
  steps: number;
  outcome: RunOutcome;
  // runId (stamped onto every ticket this run authored) + created/updated ids — the link the run log joins on.
  runId: string;
  createdIds: string[];
  updatedIds: string[];
  // create_ticket calls the cap blocked. The ONLY deterministic signal that work was dropped —
  // the outcome cannot carry it (a capped run is not created/declined/errored), and the model's
  // own summary is not trustworthy for this: propose.ts:18 records that exact lesson.
  cappedCreates: number;
  toolLog: ToolLogEntry[];
}

// What a run had already done when it threw. A fault does not un-spend the tokens, and it does not
// un-write the tickets already on disk carrying `runId` in their frontmatter — this is the only route
// either still has to the run log (tkt-3953c78cffe7).
export interface IntakePartial {
  runId: string;
  outcome: RunOutcome;
  createdIds: string[];
  updatedIds: string[];
  steps: number;
  cappedCreates: number;
}

// Carries that partial state to the caller. REJECTS rather than resolving with an errored outcome: a
// caller that ignores it must fail loudly, not report a crashed run as a completed one. `cause` holds
// the original untouched, which is what keeps isRuntimeUnavailable's cause-walk — and so the
// controller's 503 — working through the wrapper.
export class IntakeRunError extends Error {
  readonly partial: IntakePartial;
  constructor(partial: IntakePartial, options: { cause: unknown }) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`Intake run ${partial.runId} failed at step ${partial.steps}: ${detail}`, options);
    this.name = 'IntakeRunError';
    this.partial = partial;
  }
}

export interface IntakeDeps {
  chat: ChatClient;
  index: DocumentIndex;
  maxSteps?: number;
  // Hard cap on tickets CREATED by a create-only run (default DEFAULT_MAX_CREATES). Independent of
  // maxSteps; ignored in full mode. A non-positive or non-integer value falls back to the default.
  maxCreates?: number;
  // Gate for non-read-only tools. Omit to auto-approve (programmatic use); the
  // CLI always supplies a prompting gate.
  approve?: ApproveFn;
  // Propose mode: capture the first create/update and HALT — neither executed nor declined-back, so the model never observes its capture as a rejection (which it would narrate as failure + retry as a duplicate). The callback returns the synthesized summary.
  onCapture?: (name: string, args: Record<string, unknown> | undefined) => string;
  // Inject a fixed runId (tests); otherwise a fresh one is minted per run.
  runId?: string;
  // Create-only mode (tkt-2492e26a277a): drop update_ticket from the toolset + prompt so a delegated
  // create can't misroute into an existing ticket and overwrite its body. Default false (full mode).
  createOnly?: boolean;
}

// create/update are the "accepted" mutations counted toward the outcome — and the only tools a propose-mode capture treats as a proposal.
export function mutationKind(name: string): 'create' | 'update' | null {
  if (name === 'create_ticket') return 'create';
  if (name === 'update_ticket') return 'update';
  return null;
}

// `noProposal` is derived (nothing created/updated/declined/rejected) unless forced — the propose-mode halt captures a proposal without tallying it, so it passes noProposal: false explicitly.
// `rejected` counts in that derivation on purpose: the model DID propose and the service refused it, so reporting noProposal would assert the opposite of what happened (tkt-354d1bdcffa9).
function buildOutcome(
  created: number, updated: number, declined: number, errored: boolean, rejected: number, noProposal?: boolean,
): RunOutcome {
  return { created, updated, declined, errored, rejected, noProposal: noProposal ?? created + updated + declined + rejected === 0 };
}

// Run one tool call, gating non-read-only tools behind the callback. Reports whether it was declined so the loop tallies the outcome. `runId` stamps agent provenance onto create/update writes.
async function runCall(name: string, args: Record<string, unknown> | undefined, deps: IntakeDeps, runId: string, allowedNames: Set<string>): Promise<{ result: ToolResult; declined: boolean }> {
  const needsApproval = !READ_ONLY_TOOLS.has(name);
  if (needsApproval && deps.approve && !(await deps.approve(name, args))) {
    return { result: declined(name), declined: true };
  }
  return { result: await dispatchTool(name, args, deps.index, runId, allowedNames), declined: false };
}

// Pull the persisted ticket id out of a create/update result — the service returns the ticket as JSON.
function ticketIdOf(result: ToolResult): string | null {
  try {
    const parsed: unknown = JSON.parse(result.content.map((c) => c.text).join('\n'));
    if (typeof parsed === 'object' && parsed !== null && 'id' in parsed && typeof parsed.id === 'string') {
      return parsed.id;
    }
  } catch { /* result wasn't JSON (an error message) — no id to capture */ }
  return null;
}

// Run one intake conversation to completion (or until the step budget is spent).
export async function runIntake(input: string, deps: IntakeDeps): Promise<IntakeResult> {
  const createOnly = deps.createOnly ?? false;
  const tools = createOnly ? AGENT_TOOLS_CREATE_ONLY : AGENT_TOOLS;
  const allowedNames = createOnly ? CREATE_ONLY_TOOL_NAMES : AGENT_TOOL_NAMES;
  const messages: ChatMessage[] = [
    { role: 'system', content: createOnly ? SYSTEM_PROMPT_CREATE_ONLY : SYSTEM_PROMPT },
    { role: 'user', content: input },
  ];
  const maxSteps = deps.maxSteps ?? 8;
  // Fail toward the STRICTER value. `?? DEFAULT` alone lets NaN through (it isn't nullish), and
  // `created >= NaN` is false forever — the runaway guard would silently switch itself off, which is
  // the fail-open shape this repo rejects. 0 and negatives fall back too rather than blocking every create.
  const requestedMaxCreates = deps.maxCreates ?? DEFAULT_MAX_CREATES;
  const maxCreates = Number.isInteger(requestedMaxCreates) && requestedMaxCreates > 0
    ? requestedMaxCreates
    : DEFAULT_MAX_CREATES;
  const runId = deps.runId ?? randomUUID();
  const createdIds: string[] = [];
  const updatedIds: string[] = [];
  const toolLog: ToolLogEntry[] = [];
  let created = 0;
  let updated = 0;
  let declinedCount = 0;
  let cappedCreates = 0;
  let rejectedCount = 0;

  // Hoisted so the catch can report which step faulted.
  let step = 0;
  try {
    for (step = 1; step <= maxSteps; step++) {
      const assistant = await deps.chat.complete(messages, tools);
      messages.push(assistant);

      const calls = assistant.tool_calls ?? [];
      if (calls.length === 0) {
        const final = (assistant.content ?? '').trim() || EMPTY_SUMMARY_FALLBACK;
        const outcome = buildOutcome(created, updated, declinedCount, false, rejectedCount);
        return { final, messages, steps: step, outcome, runId, createdIds, updatedIds, cappedCreates, toolLog };
      }

      for (const call of calls) {
        const name = call.function.name;
        const args = parseArgs(call.function.arguments);
        const kind = mutationKind(name);
        // Propose mode: capture the first create/update and halt — don't dispatch, don't feed a decline back. noProposal is false even though nothing is tallied.
        // NOTE: `messages` deliberately ends with the captured tool_call UNANSWERED — a future consumer that replays it would need to backfill a synthetic tool response first (proposeIntake discards messages, so it's moot today).
        if (deps.onCapture && kind) {
          const final = deps.onCapture(name, args);
          const outcome = buildOutcome(created, updated, declinedCount, false, rejectedCount, false);
          return { final, messages, steps: step, outcome, runId, createdIds, updatedIds, cappedCreates, toolLog };
        }
        // Over the create budget: short-circuit BEFORE runCall, so the write never reaches the service.
        // Falls through to the shared tally/push — isError keeps it out of `created`, and it is not a
        // human `declined` either, so the outcome records exactly the tickets that landed.
        const overCap = createOnly && kind === 'create' && created >= maxCreates;
        if (overCap) cappedCreates += 1;
        const { result, declined: wasDeclined } = overCap
          ? { result: creationCapped(maxCreates), declined: false }
          : await runCall(name, args, deps, runId, allowedNames);
        // Accepted ONLY when neither declined nor errored — a failed create/update (missing title → 400 → isError) produced no ticket, so crediting it would make economics.ts claim manual value for work never done.
        const createdId = kind === 'create' && !wasDeclined && !result.isError ? ticketIdOf(result) : null;
        if (kind && wasDeclined) declinedCount += 1;
        else if (kind && !result.isError) {
          if (kind === 'create') { created += 1; if (createdId) createdIds.push(createdId); }
          else { updated += 1; const id = ticketIdOf(result); if (id) updatedIds.push(id); }
        }
        // Refused by the SERVICE — the only case the operator can act on by re-filing the report.
        // Both exclusions are calls that DID reach this branch with isError set (creationCapped and the
        // whitelist refusal are ordinary isError results, not short-circuits) but never reached the
        // service: the run cap is owned by cappedCreates, and a tool absent from `allowedNames` is
        // refused inside dispatchTool. Counting either would advise re-running a report against a limit
        // or a toolset that will refuse it again identically.
        else if (kind && !overCap && allowedNames.has(name)) rejectedCount += 1;
        const text = result.content.map((c) => c.text).join('\n');
        // Only the decline and cap messages stay bare: they are the loop's own instructions. Anything
        // dispatched — board reads, write echoes, refusals — is fenced, including a tool added later.
        const fromDispatch = !overCap && !wasDeclined;
        if (fromDispatch) toolLog.push({ name, isError: result.isError === true, text, createdId });
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: fromDispatch ? fenceUntrusted(text) : text,
        });
      }
    }
  } catch (err) {
    // Preserve the tally across the throw for the same reason the step-budget exit below returns
    // instead of throwing: a bare throw discards it. Here it also strands every ticket the run
    // already wrote — those carry `runId`, so losing it points the economics join at a run that
    // was never logged (tkt-3953c78cffe7).
    throw new IntakeRunError({
      runId,
      outcome: buildOutcome(created, updated, declinedCount, true, rejectedCount),
      createdIds,
      updatedIds,
      steps: step,
      cappedCreates,
    }, { cause: err });
  }

  // Step budget exhausted. Return an errored outcome rather than throwing, so the tally of mutations that DID execute is preserved (a throw would discard it and never set RunOutcome.errored).
  const outcome = buildOutcome(created, updated, declinedCount, true, rejectedCount);
  const final = `The agent did not finish within ${maxSteps} steps; stopping. ` +
    `${created + updated} mutation(s) were applied before the step budget ran out.`;
  return { final, messages, steps: maxSteps, outcome, runId, createdIds, updatedIds, cappedCreates, toolLog };
}
