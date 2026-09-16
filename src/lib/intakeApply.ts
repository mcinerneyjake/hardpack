import { proposalToPrefill, proposalTargetId, droppedEnumFields, type Prefill, type DroppedEnum } from './proposalPrefill.js';
import type { TicketFormFields } from './ticketDiff.js';
import { CREATE_STATUS_IDS, type Ticket } from '../../shared/constants.js';

// Declared structurally (not imported) so this board module keeps no build-time dep on agent/ (server/agentBoundary.test.ts forbids it).
export interface CapturedProposal {
  action: string;
  args: Record<string, unknown>;
}

// droppedEnums intersects the union rather than repeating on each arm, so it is mandatory on every
// mode and a new construction site fails to compile until it carries the report (tkt-a22ba10cd328).
export type IntakePlan = (
  | { mode: 'create'; prefill: Prefill }
  | { mode: 'update'; target: Ticket; prefill: Prefill }
  | { mode: 'not-found'; targetId: string | null; prefill: Prefill }
) & { droppedEnums: DroppedEnum[] };

// Drop a status the CREATE path rejects (only qa among board statuses; archived can't be a create status) so createTicket defaults it instead of 400ing (tkt-727c5cacdfad). Update keeps the full status.
function createSafePrefill(prefill: Prefill): Prefill {
  if (prefill.status === undefined || CREATE_STATUS_IDS.includes(prefill.status)) return prefill;
  const clamped: Prefill = { ...prefill };
  delete clamped.status;
  return clamped;
}

// "Draft new ticket" reuses an UPDATE proposal's prefill to CREATE a fresh ticket. The proposed
// status is a transition for the *existing* target (e.g. done/in-progress), not a birth status —
// drop it so the new ticket takes the create default instead of being born past the pipeline
// (tkt-e346dd06e8bb). Dropping status entirely also subsumes createSafePrefill's qa/archived clamp.
export function createFromUpdatePrefill(prefill: Prefill): Prefill {
  if (prefill.status === undefined) return prefill;
  const next: Prefill = { ...prefill };
  delete next.status;
  return next;
}

// Routed on the ACTION: an update_ticket proposal MUST resolve to a loaded ticket; a missing/blank/unloaded id is 'not-found', never a create (which would draft a DUPLICATE — tkt-1dfa61b8830e). A create-bound prefill is status-clamped (createSafePrefill) so the draft can't 400.
export function resolveProposalPlan(proposal: CapturedProposal, allTickets: Ticket[]): IntakePlan {
  const prefill = proposalToPrefill(proposal.args);
  const droppedEnums = droppedEnumFields(proposal.args);
  if (proposal.action !== 'update_ticket') return { mode: 'create', prefill: createSafePrefill(prefill), droppedEnums };
  const targetId = proposalTargetId(proposal) || null; // '' (blank id) collapses to null
  const target = targetId !== null ? allTickets.find((t) => t.id === targetId) : undefined;
  if (target) return { mode: 'update', target, prefill, droppedEnums };
  return { mode: 'not-found', targetId, prefill: createSafePrefill(prefill), droppedEnums };
}

// Parent to seed the form with, but only if it's still an active (non-archived) ticket.
function activeParentId(ticket: Ticket | null, allTickets: Ticket[]): string | null {
  const id = ticket?.parent ?? null;
  if (!id) return null;
  const parent = allTickets.find((t) => t.id === id);
  return parent && parent.status !== 'archived' ? id : null;
}

// prefill overlays the agent's CONTENT fields; structural fields (project/blockers/parent) stay ticket-derived so their guards can't be bypassed. Pass prefill for the editable form; OMIT it for the save baseline — folding it in makes form == baseline, so changedFormFields returns {} and an agent edit is silently dropped (tkt-128ee05af9ba).
export function buildTicketForm(ticket: Ticket | null, allTickets: Ticket[], prefill?: Prefill): TicketFormFields {
  return {
    title: prefill?.title ?? ticket?.title ?? '',
    type: prefill?.type ?? ticket?.type ?? 'task',
    priority: prefill?.priority ?? ticket?.priority ?? 'medium',
    status: prefill?.status ?? ticket?.status ?? 'backlog',
    body: prefill?.body ?? ticket?.body ?? '',
    // Explicit-undefined check so a proposed null clears the field; project/blockers/parent stay ticket-derived (guards can't be bypassed — tkt-c8b4b6aa948d).
    dueDate: prefill?.dueDate !== undefined ? prefill.dueDate : (ticket?.dueDate ?? null),
    assignee: prefill?.assignee !== undefined ? prefill.assignee : (ticket?.assignee ?? null),
    project: ticket?.project ?? null,
    blockers: ticket?.blockers ?? [],
    parent: activeParentId(ticket, allTickets),
  };
}

// A blocker edge is "hidden" when its target is archived or dangling (deleted). Never shown as a chip, so every rewrite of the blocker set must PRESERVE it or it silently deletes data (tkt-c8b4b6aa948d). ONE predicate, shared by the chip filter and blockersForProject, so they can't drift.
export function isHiddenBlockerEdge(id: string, allTickets: Ticket[]): boolean {
  const blocker = allTickets.find((t) => t.id === id);
  return blocker === undefined || blocker.status === 'archived';
}

// On reassign to project: drop VISIBLE active blockers from other projects, but KEEP hidden edges (isHiddenBlockerEdge) — filtering them would silently delete an edge the user never saw.
export function blockersForProject(blockers: string[], allTickets: Ticket[], project: string | null): string[] {
  if (project === null) return blockers;
  return blockers.filter((id) => {
    if (isHiddenBlockerEdge(id, allTickets)) return true;              // hidden — always keep
    return allTickets.find((t) => t.id === id)?.project === project;   // visible active — same-project only
  });
}
