import { useState, useEffect } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { api } from '../api.js';
import { STATUSES, BOARD_STATUSES, TYPES, PRIORITIES, type Ticket, type BoardTicket, type StatusId } from '../../shared/constants.js';
import { useRelatedTickets } from '../useRelatedTickets.js';
import { relatedStripState } from '../lib/relatedStripState.js';
import PipelineTracker from './PipelineTracker.js';
import ProvenanceNote from './ProvenanceNote.js';
import { ticketProvenance } from '../lib/provenance.js';
import { type Prefill, type DroppedEnum } from '../lib/proposalPrefill.js';
import { resolveProposalPlan, buildTicketForm, blockersForProject, isHiddenBlockerEdge, createFromUpdatePrefill } from '../lib/intakeApply.js';
import { ticketsBlockedBy } from '../lib/blockers.js';
import { changedFormFields } from '../lib/ticketDiff.js';
import { daysSince, formatAge } from '../lib/ticketAge.js';
import { formatIso } from '../lib/formatDate.js';
import { formatCalendarDate } from '../lib/completedDate.js';
import Spinner from './ui/Spinner.js';
import Modal from './ui/Modal.jsx';
import { draftFailureOf, type DraftFailure } from '../lib/draftFailure.js';

// Ticket bodies are written by night runs, the intake agent and sessions in other repos, and
// `marked` passes raw HTML straight through — so a body arrives here carrying whatever tags its
// author chose, which hands an otherwise egress-free agent an exfiltration channel.
// e2e/previewEgress.spec.ts drives every entry below; its CSP-stripped arm is what holds this
// list honest, since with the CSP up a leak here is invisible.
//
// `style` is the one to keep: the ELEMENT is in DOMPurify's default allowlist and its `@import`
// and `@font-face src:url()` reach the network even with the `style` ATTRIBUTE forbidden — and an
// unscoped <style> also lets a body restyle the whole app. `object`/`embed`/`iframe`/`ping`/
// `formaction` are NOT in DOMPurify 3.4.14's defaults and are inert today; they are kept only as
// belt against a future default widening. Deliberately absent: `href`, since a link does not fetch
// until clicked, and `input`, whose only egress shape (`type=image`) is already disarmed by
// dropping `src` — banning it would strip GFM task-list checkboxes (tkt-5037f1a9fb57).
const PREVIEW_SANITIZE = {
  FORBID_TAGS: ['img', 'video', 'audio', 'source', 'track', 'image', 'use', 'feimage', 'style', 'object', 'embed', 'iframe'],
  FORBID_ATTR: ['src', 'srcset', 'poster', 'style', 'background', 'xlink:href', 'formaction', 'ping', 'data'],
};

type FormState = Pick<Ticket, 'title' | 'type' | 'priority' | 'status' | 'body' | 'project' | 'blockers' | 'parent' | 'dueDate' | 'assignee'>

type Props = {
  ticket: BoardTicket | null
  allTickets: Ticket[]
  projects: string[]
  assignees: string[]
  onSave: (data: Partial<FormState>, runId?: string) => void | Promise<void>
  onDelete: (id: string) => void
  onOpen: (ticket: Ticket, initial?: Prefill, runId?: string) => void
  onOpenRun: (runId: string) => void
  onClose: () => void
  // Dev-only: open the embedded terminal seeded with this ticket (see App / TerminalWidget).
  onRunInTerminal?: (ticketId: string) => void
  initial?: Prefill
  // Non-null → Save applies through the intake-apply endpoint (update-suggestion reopen path).
  initialRunId?: string
}

const BOARD_STATUS_SET = new Set<StatusId>(BOARD_STATUSES.map((s) => s.id));

function getDescendantIds(id: string, all: Ticket[]): Set<string> {
  const ids = new Set<string>();
  const queue = [id];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === undefined) break;
    for (const t of all) {
      if (t.parent === cur && !ids.has(t.id)) {
        ids.add(t.id);
        queue.push(t.id);
      }
    }
  }
  return ids;
}

export default function TicketModal({ ticket, initial, initialRunId, allTickets, projects, assignees, onSave, onDelete, onOpen, onOpenRun, onClose, onRunInTerminal }: Props) {
  // Save PATCHes only fields changed vs baseline (open-time state, WITHOUT the prefill) so an unchanged field can't clobber a concurrent external edit; baselining WITH the prefill made agent edits diff to {} and vanish (tkt-128ee05af9ba). Both captured once — never re-baselined.
  const [form, setForm] = useState<FormState>(() => buildTicketForm(ticket, allTickets, initial));
  const [baseline] = useState<FormState>(() => buildTicketForm(ticket, allTickets));
  const [preview, setPreview] = useState(false);
  // Lazy init, not a bare Date.now(): reading the clock during render violates react-hooks/purity.
  const [mountedAt] = useState(() => Date.now());
  // Create mode only: live dedup as the title is typed.
  const related = useRelatedTickets(form.title, ticket === null);
  const relatedState = relatedStripState(related.matches.length > 0, related.loading, related.error);

  // Create mode: probe the model on open; fall back to the manual form when it's down.
  const [note, setNote] = useState('');
  const [draftPhase, setDraftPhase] = useState<'idle' | 'loading' | DraftFailure>('idle');
  const [drafted, setDrafted] = useState(false);
  const [noProposal, setNoProposal] = useState(false);
  const [updateSuggestion, setUpdateSuggestion] = useState<{ ticket: Ticket; prefill: Prefill; runId: string } | null>(null);
  // Agent targeted a ticket not on the board — hold id (may be null) + prefill to surface it (never silently duplicate).
  const [updateNotFound, setUpdateNotFound] = useState<{ targetId: string | null; prefill: Prefill; runId: string } | null>(null);
  // Enum values the agent proposed that aren't valid. Survives setDrafted(true), which unmounts the
  // draft panel — the form is where the resulting default is actually on screen (tkt-a22ba10cd328).
  const [droppedEnums, setDroppedEnums] = useState<DroppedEnum[]>([]);
  // Carried into Save so the draft applies through the provenance/metering endpoint.
  const [draftRunId, setDraftRunId] = useState<string | null>(initialRunId ?? null);
  const [saving, setSaving] = useState(false); // in-flight Save guard — blocks a double-submit
  const [modelStatus, setModelStatus] = useState<'checking' | 'up' | 'down'>(ticket === null ? 'checking' : 'up');

  useEffect(() => {
    if (ticket !== null) return;
    let alive = true;
    api.intake.health()
      .then((h) => { if (alive) setModelStatus(h.available ? 'up' : 'down'); })
      .catch(() => { if (alive) setModelStatus('down'); });
    return () => { alive = false; };
  }, [ticket]);

  const draft = async () => {
    if (!note.trim()) return;
    setDraftPhase('loading');
    setNoProposal(false);
    setUpdateSuggestion(null);
    setUpdateNotFound(null);
    setDraftRunId(null);
    setDroppedEnums([]);
    try {
      const result = await api.intake.propose(note.trim());
      const proposal = result.proposal;
      if (!proposal) { setNoProposal(true); setDraftPhase('idle'); return; }
      const plan = resolveProposalPlan(proposal, allTickets);
      setDroppedEnums(plan.droppedEnums);
      if (plan.mode === 'update') {
        setUpdateSuggestion({ ticket: plan.target, prefill: plan.prefill, runId: result.runId });
      } else if (plan.mode === 'not-found') {
        // Surface it; do NOT silently draft a duplicate (tkt-1dfa61b8830e).
        setUpdateNotFound({ targetId: plan.targetId, prefill: plan.prefill, runId: result.runId });
      } else {
        setForm((f) => ({ ...f, ...plan.prefill }));
        setDrafted(true);
        setDraftRunId(result.runId);
      }
      setDraftPhase('idle');
    } catch (err) {
      // The real message stays server-side (it can carry internals); the UI only needs to know whether
      // this was the model being unreachable or something else going wrong (tkt-a449b3ae0339).
      setDraftPhase(draftFailureOf(err));
    }
  };

  // Bypass a suggested match (update / not-found) and draft the agent's proposal as a NEW ticket.
  // createFromUpdatePrefill drops the update-transition status so the new ticket isn't born past the pipeline (tkt-e346dd06e8bb).
  const draftAsNew = (prefill: Prefill, runId: string) => {
    setForm((f) => ({ ...f, ...createFromUpdatePrefill(prefill) }));
    setUpdateSuggestion(null);
    setUpdateNotFound(null);
    setDrafted(true);
    setDraftRunId(runId);
  };

  const set = (k: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const setProject = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const project = e.target.value || null;
    setForm((f) => ({
      ...f,
      project,
      // Clear selections not in the chosen project; blockers preserve hidden archived/dangling edges (see blockersForProject).
      blockers: blockersForProject(f.blockers, allTickets, project),
      parent: project === null
        ? f.parent
        : (allTickets.find((t) => t.id === f.parent)?.project === project ? f.parent : null),
    }));
  };

  const setParent = (e: React.ChangeEvent<HTMLSelectElement>) =>
    setForm((f) => ({ ...f, parent: e.target.value || null }));

  const addBlocker = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    if (!id || form.blockers.includes(id)) return;
    setForm((f) => ({ ...f, blockers: [...f.blockers, id] }));
    e.target.value = '';
  };

  const removeBlocker = (id: string) =>
    setForm((f) => ({ ...f, blockers: f.blockers.filter((b) => b !== id) }));

  // descendantIds = full subtree, excluded from parent options to prevent cycles.
  const children = ticket ? allTickets.filter((t) => t.parent === ticket.id) : [];
  const descendantIds = ticket ? getDescendantIds(ticket.id, allTickets) : new Set<string>();
  // Non-null only for an agent-authored existing ticket — gates the provenance note.
  const provenance = ticket ? ticketProvenance(ticket) : null;
  const sameProject = (t: Ticket) => form.project === null || t.project === form.project;
  const parentOptions = allTickets.filter(
    (t) =>
      t.id !== ticket?.id &&
      !descendantIds.has(t.id) &&
      BOARD_STATUS_SET.has(t.status) &&
      sameProject(t) &&
      // Always include the current parent so it's visible and clearable, even if done.
      (t.status !== 'done' || t.id === form.parent),
  );

  const availableBlockers = allTickets.filter(
    (t) => t.id !== ticket?.id && !form.blockers.includes(t.id) && t.status !== 'done' && BOARD_STATUS_SET.has(t.status) && sameProject(t),
  );
  // Show only ACTIVE blockers as chips; archived/dangling ids stay in form.blockers (hidden, preserved on save) so an edit can't drop them (tkt-c8b4b6aa948d). Same isHiddenBlockerEdge rule as blockersForProject.
  const blockerTickets = form.blockers
    .filter((id) => !isHiddenBlockerEdge(id, allTickets))
    .map((id) => allTickets.find((t) => t.id === id))
    .filter((t): t is Ticket => t !== undefined);
  // Reverse edge (what this blocks): derived, read-only, only for a saved ticket.
  const blockedTickets = ticket ? ticketsBlockedBy(ticket.id, allTickets) : [];

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || saving) return; // guard re-entry — a double-submit would write twice
    setSaving(true);
    try {
      // Existing: PATCH only what changed vs baseline; new: send the whole form.
      await onSave(ticket ? changedFormFields(form, baseline) : form, draftRunId ?? undefined);
    } finally {
      setSaving(false); // no-op if onSave closed the modal (success); re-enables on a handled error
    }
  };

  // Rendered on both faces of the create flow, with the tail clause differing because the FACTS
  // differ: on the panel (update / not-found) no form is on screen and the prefill has not been
  // applied yet, so claiming one "is showing the default" there is simply false. The drop itself is
  // past tense in both, which also keeps the notice true after the user fixes the field by hand
  // (tkt-a22ba10cd328, review round 1 — F2/F7).
  const one = droppedEnums.length === 1;
  const droppedEnumNotice = (where: 'panel' | 'form') => droppedEnums.length === 0 ? null : (
    <div className="draft-notice draft-notice--dropped">
      <span>
        The agent proposed {one ? 'a value' : 'values'} that {one ? "isn't" : "aren't"} valid, so{' '}
        {one ? 'it was' : 'they were'} dropped:{' '}
        {droppedEnums.map((d, i) => (
          <span key={d.field}>
            {i > 0 ? ', ' : null}<strong>{d.field}</strong> = <code>{d.value}</code>
          </span>
        ))}
        .{' '}
        {where === 'form'
          ? `Nothing was lost — ${one ? 'that field' : 'those fields'} fell back to the default, so set ${one ? 'it' : 'them'} yourself if the default is wrong.`
          : `Nothing was lost — ${one ? 'that field' : 'those fields'} will use the default unless you set ${one ? 'it' : 'them'}.`}
      </span>
    </div>
  );

  // Create flow's three faces: probing, draft-from-note, editable form.
  const showChecking = ticket === null && modelStatus === 'checking' && !drafted;
  const showDraftPanel = ticket === null && modelStatus === 'up' && !drafted;
  const showForm = ticket !== null || modelStatus === 'down' || drafted;

  return (
    <Modal
      onClose={onClose}
      className={showForm ? undefined : 'modal--draft'}
      label={ticket ? 'Edit ticket' : 'New ticket'}
      // After in-modal navigation this modal was REMOUNTED, so the trigger it captured is a link that
      // died with the previous instance. The card for the ticket actually on screen is both reachable and
      // the better destination — it is where the user just was (tkt-75ac08441da5). Queried at close time,
      // since the board re-renders while the modal is open.
      restoreFocusTo={() => (ticket ? document.querySelector<HTMLElement>(`[data-ticket-id="${ticket.id}"]`) : null)}
    >
      <form onSubmit={submit}>
          {showChecking && (
            <div className="draft-checking">
              <Spinner />
              <span>Checking for the drafting model…</span>
              <button type="button" className="link" onClick={onClose}>Cancel</button>
            </div>
          )}

          {showDraftPanel && (
            <section className="draft-panel">
              <div className="draft-head">✨ Draft from a note</div>
              <textarea
                className="draft-input"
                placeholder="Describe it here — the agent drafts a ticket for this board…"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                autoFocus
              />
              {(draftPhase === 'model-down' || draftPhase === 'fault') && (
                <p className="draft-error">
                  {draftPhase === 'model-down'
                    ? "Couldn't draft a ticket — is the model running?"
                    : "Couldn't draft a ticket — the drafting agent hit an error. The details are in the server log."}{' '}
                  <button type="button" className="link" onClick={() => setModelStatus('down')}>Enter manually</button>
                </p>
              )}
              {noProposal && (
                <div className="draft-notice">
                  <span>
                    The agent didn't suggest a ticket — add more detail and try again, or{' '}
                    <button type="button" className="link" onClick={() => setModelStatus('down')}>enter manually</button>.
                  </span>
                </div>
              )}
              {updateSuggestion && (
                <div className="draft-notice">
                  <span>Looks like this updates an existing ticket: <strong>“{updateSuggestion.ticket.title}”</strong>.</span>
                  <button
                    type="button"
                    className="link"
                    onClick={() => onOpen(updateSuggestion.ticket, updateSuggestion.prefill, updateSuggestion.runId)}
                  >
                    Open &amp; apply →
                  </button>
                  <button
                    type="button"
                    className="link"
                    onClick={() => draftAsNew(updateSuggestion.prefill, updateSuggestion.runId)}
                  >
                    Draft new ticket →
                  </button>
                </div>
              )}
              {updateNotFound && (
                <div className="draft-notice">
                  <span>
                    The agent tried to update a ticket that isn't on your board
                    {updateNotFound.targetId ? <> (<code>{updateNotFound.targetId}</code>)</> : null} — it may have been
                    deleted, or the id was wrong. Refine the note, or{' '}
                    <button
                      type="button"
                      className="link"
                      onClick={() => draftAsNew(updateNotFound.prefill, updateNotFound.runId)}
                    >
                      draft it as a new ticket →
                    </button>
                  </span>
                </div>
              )}
              {droppedEnumNotice('panel')}
              <div className="draft-actions">
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => void draft()}
                  disabled={draftPhase === 'loading' || note.trim() === ''}
                >
                  {draftPhase === 'loading' ? <span>Drafting…</span> : 'Draft ticket'}
                </button>
                <button type="button" className="btn" onClick={onClose}>Cancel</button>
              </div>
            </section>
          )}

          {showForm && (
          <>
          <input
            className="title-input"
            placeholder="Ticket title"
            value={form.title}
            onChange={set('title')}
            autoFocus
          />

          {/* Live tracker — existing ticket only; renders null for un-started. */}
          {ticket && <PipelineTracker ticketId={ticket.id} status={ticket.status} />}

          {/* Provenance: agent-authored tickets link to their run's economics. */}
          {provenance && <ProvenanceNote source={provenance.source} runId={provenance.runId} onOpenRun={onOpenRun} />}

          {/* Read-only, existing-ticket-only: the server owns both stamps. */}
          {ticket && (() => {
            const age = daysSince(ticket.updated, mountedAt);
            return (
              <div className="ticket-dates">
                <span title={ticket.created}>🕐 Created {formatCalendarDate(ticket.created)}</span>
                {age !== null && (
                  <span title={ticket.updated}>
                    · updated {age === 0 ? 'today' : `${formatAge(age)} ago`}
                  </span>
                )}
                {ticket.completedAt && (
                  <span title={ticket.completedAt}>
                    · ✅ completed {formatIso(ticket.completedAt, (d) => d.toLocaleDateString())}
                  </span>
                )}
              </div>
            );
          })()}

          {/* Dedup: semantic matches as you type; click one to edit instead of duplicating. */}
          {relatedState !== 'hidden' && (
            <div className="subtasks-section">
              {relatedState === 'list' ? (
                <>
                  <div className="subtasks-head">
                    <span>Related tickets</span>
                    {related.loading && <Spinner />}
                  </div>
                  <div className="subtask-list">
                    {related.matches.map((m) => {
                      const full = allTickets.find((t) => t.id === m.id);
                      return full ? (
                        <button key={m.id} type="button" className="subtask-item" onClick={() => onOpen(full)}>
                          <span className={`subtask-dot prio-${full.priority}`} />
                          <span className="subtask-title">{m.title}</span>
                          <span className="subtask-status">{Math.round(m.score * 100)}%{m.status ? ` · ${m.status}` : ''}</span>
                        </button>
                      ) : null;
                    })}
                  </div>
                </>
              ) : relatedState === 'searching' ? (
                <div className="subtasks-head">
                  <Spinner />
                  <span>Searching related tickets…</span>
                </div>
              ) : (
                <div className="subtasks-head">
                  <span>Couldn't search related tickets — is the model running?</span>
                </div>
              )}
            </div>
          )}

          {droppedEnumNotice('form')}

          <div className="row">
            <label>
              Type
              <select value={form.type} onChange={set('type')}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>
              Priority
              <select value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={form.status} onChange={set('status')}>
                {(ticket?.status === 'archived' ? STATUSES : BOARD_STATUSES).map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="row">
            <label className="solo">
              Project
              <select value={form.project ?? ''} onChange={setProject}>
                <option value="">None</option>
                {projects.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
            <label className="solo">
              Parent ticket
              <select value={form.parent ?? ''} onChange={setParent}>
                <option value="">None</option>
                {parentOptions.map((t) => (
                  <option key={t.id} value={t.id}>{t.title}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="row">
            <label className="solo">
              Due date
              <input
                type="date"
                value={form.dueDate ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, dueDate: e.target.value || null }))}
              />
            </label>
            <label className="solo">
              Assignee
              <input
                type="text"
                list="assignee-suggestions"
                placeholder="Unassigned"
                value={form.assignee ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, assignee: e.target.value.trim() || null }))}
              />
              <datalist id="assignee-suggestions">
                {assignees.map((a) => <option key={a} value={a} />)}
              </datalist>
            </label>
          </div>

          {ticket && children.length > 0 && (
            <div className="subtasks-section">
              <div className="subtasks-head">
                <span>Sub-tickets</span>
                <span className="subtasks-count">{children.length}</span>
              </div>
              <div className="subtask-list">
                {children.map((child) => (
                  <button
                    key={child.id}
                    type="button"
                    className="subtask-item"
                    onClick={() => onOpen(child)}
                  >
                    <span className={`subtask-dot prio-${child.priority}`} />
                    <span className="subtask-title">{child.title}</span>
                    <span className="subtask-status">{child.status}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="blockers-section">
            <div className="blockers-head">
              <span>Blockers</span>
              {availableBlockers.length > 0 && (
                <select className="blocker-add-select" onChange={addBlocker} defaultValue="">
                  <option value="" disabled>+ Add blocker</option>
                  {availableBlockers.map((t) => (
                    <option key={t.id} value={t.id}>{t.title}</option>
                  ))}
                </select>
              )}
            </div>
            {blockerTickets.length > 0 ? (
              <div className="blocker-tags">
                {blockerTickets.map((t) => (
                  <span key={t.id} className="blocker-tag">
                    {t.title}
                    <button type="button" className="blocker-remove" onClick={() => removeBlocker(t.id)}>×</button>
                  </span>
                ))}
              </div>
            ) : (
              <span className="blockers-empty">None</span>
            )}
          </div>

          {blockedTickets.length > 0 && (
            <div className="blockers-section">
              <div className="blockers-head">
                <span>Blocks</span>
              </div>
              <div className="blocker-tags">
                {blockedTickets.map((t) => (
                  <span key={t.id} className={`blocker-tag${t.status === 'done' ? ' done' : ''}`}>
                    {t.title}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="body-head">
            <span>Description</span>
            <button
              type="button"
              className="link"
              onClick={() => setPreview((p) => !p)}
            >
              {preview ? 'Edit' : 'Preview'}
            </button>
          </div>

          {preview ? (
            <div
              className="md-preview"
              dangerouslySetInnerHTML={{
                __html: DOMPurify.sanitize(
                  String(marked.parse(form.body || '_No description_')),
                  PREVIEW_SANITIZE,
                ),
              }}
            />
          ) : (
            <textarea
              className="body-input"
              rows={10}
              value={form.body}
              onChange={set('body')}
              placeholder="Markdown supported…"
            />
          )}

          <div className="modal-actions">
            {ticket && (
              <button
                type="button"
                className="btn danger"
                onClick={() => onDelete(ticket.id)}
              >
                Delete
              </button>
            )}
            {import.meta.env.DEV && ticket && onRunInTerminal && (
              <button
                type="button"
                className="btn"
                onClick={() => onRunInTerminal(ticket.id)}
                title="Open a confined Claude Code session seeded with this ticket"
              >
                ▶ Run in terminal
              </button>
            )}
            <div className="spacer" />
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={saving || !form.title.trim()}>
              {saving ? 'Saving…' : ticket ? 'Save' : 'Create'}
            </button>
          </div>
          </>
          )}
        </form>
    </Modal>
  );
}
