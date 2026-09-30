import { STEPS, isStatusId, type PipelineStep, type StepId, type StatusId, type TicketEvent } from '../../shared/constants.js';

// Display grouping: the three gate checks collapse into one "Gate" node (the timeline still shows them separately). review = the manual "Ready to commit?" gate.
interface DisplayGroup { key: string; label: string; steps: StepId[] }
const DISPLAY: readonly DisplayGroup[] = [
  { key: 'started', label: 'Started', steps: ['started'] },
  { key: 'branch', label: 'Branch', steps: ['branch'] },
  { key: 'gate', label: 'Gate', steps: ['typecheck', 'lint', 'test'] },
  { key: 'review', label: 'Review', steps: ['review'] },
  { key: 'commit', label: 'Commit', steps: ['commit'] },
  { key: 'pr_opened', label: 'PR', steps: ['pr_opened'] },
  { key: 'qa', label: 'QA', steps: ['qa'] },
  { key: 'done', label: 'Done', steps: ['done'] },
];

// Adds 'active' (the node being worked toward, only while in-progress) and 'skipped' (a node before the furthest-reached milestone that never registered — rendered skipped, not pending, to keep the pipeline monotonic).
export type NodeState = 'pending' | 'reached' | 'passed' | 'failed' | 'unattributed' | 'active' | 'skipped'

export interface TrackerNode {
  key: string
  label: string
  state: NodeState
  at: string | null
  // Review-gate interactivity derived here (unit-tested); all false on non-review nodes.
  awaiting: boolean   // Review is the active frontier — pulses, invites a click
  reviewed: boolean   // Review is complete (reached/passed)
  showCheck: boolean  // render the ✓ control at all (awaiting || reviewed)
  clickable: boolean  // ✓ actionable (awaiting && in-progress); a completed review locks
}

export interface TrackerView {
  nodes: TrackerNode[]
  current: string | null // human phase label; only while in-progress
  failed: boolean // a gate failed → the pipeline is stalled there
  started: boolean // past backlog/todo, or any event has arrived
  progress: { done: number; total: number } // completed nodes / total, for a bar
}

const isComplete = (s: NodeState): boolean => s === 'reached' || s === 'passed';

// Milestones the status alone proves complete even without an event: in-progress⇒started; qa⇒started+qa; done⇒all three.
function statusImplied(status: StatusId): StepId[] {
  switch (status) {
    case 'in-progress': return ['started'];
    case 'qa': return ['started', 'qa'];
    case 'done': return ['started', 'qa', 'done'];
    default: return [];
  }
}

// archive_ticket retires abandoned work too, so archived implies only what the status it left did.
// An unknown prior status implies nothing: rendering it Done is the claim this exists to stop (tkt-d17d30a7b3ca).
function archivedFrom(events: readonly TicketEvent[]): StatusId | null {
  const last = events.filter((e) => e.step === 'archived').at(-1);
  const prior = /^from (\S+)$/.exec(last?.detail ?? '')?.[1];
  return prior !== undefined && isStatusId(prior) ? prior : null;
}

function impliedSteps(status: StatusId, events: readonly TicketEvent[]): StepId[] {
  if (status !== 'archived') return statusImplied(status);
  const prior = archivedFrom(events);
  return prior ? statusImplied(prior) : [];
}

function stepLabel(step: StepId): string {
  return STEPS.find((s) => s.id === step)?.label ?? step;
}

export function pipelineView(pipeline: PipelineStep[], status: StatusId, events: readonly TicketEvent[]): TrackerView {
  // Reduced event state, upgraded to complete for status-implied milestones without their own event.
  const stepState = new Map<StepId, PipelineStep['state']>();
  const stepAt = new Map<StepId, string | null>();
  for (const p of pipeline) { stepState.set(p.step, p.state); stepAt.set(p.step, p.at); }
  for (const s of impliedSteps(status, events)) {
    if (!isComplete(stepState.get(s) ?? 'pending')) stepState.set(s, 'reached');
  }

  const failedStep = STEPS.find((s) => stepState.get(s.id) === 'failed');

  const groups = DISPLAY.map((g) => {
    const states = g.steps.map((st) => stepState.get(st) ?? 'pending');
    const groupFailed = states.some((s) => s === 'failed');
    const allComplete = states.every(isComplete);
    // Outcome unknown (a failed chain, or a step that could not start): not a failure, and not never-run.
    const state: NodeState = groupFailed ? 'failed'
      : states.some((s) => s === 'unattributed') ? 'unattributed'
      : allComplete ? (states.some((s) => s === 'passed') ? 'passed' : 'reached')
      : 'pending';
    const at = g.steps.reduce<string | null>((acc, st) => {
      const t = stepAt.get(st) ?? null;
      return t && (!acc || t > acc) ? t : acc;
    }, null);
    const started = g.steps.some((st) => isComplete(stepState.get(st) ?? 'pending'));
    return { key: g.key, label: g.label, state, at, started };
  });

  const failed = failedStep !== undefined;
  const live = status === 'in-progress' && !failed;

  // Frontier = next incomplete group past the furthest complete one, so a stale never-emitted early step doesn't trap the pulse behind it.
  let lastDoneIdx = -1;
  groups.forEach((g, i) => { if (isComplete(g.state)) lastDoneIdx = i; });
  const activeIdx = live && lastDoneIdx + 1 < groups.length ? lastDoneIdx + 1 : -1;

  const nodes: TrackerNode[] = groups.map((g, i) => {
    let state: NodeState = g.state;
    if (g.state === 'unattributed') state = 'unattributed';
    else if (i === activeIdx) state = 'active';
    // A pending node before the furthest-reached one was passed over — show skipped, not pending (monotonic).
    else if (g.state === 'pending' && i < lastDoneIdx) state = 'skipped';
    // awaiting is true ONLY when Review is the active frontier — not merely because the ticket is in-progress; once complete it locks.
    const isReview = g.key === 'review';
    const reviewed = isReview && isComplete(state);
    const awaiting = isReview && state === 'active';
    const clickable = awaiting && status === 'in-progress';
    const showCheck = isReview && (awaiting || reviewed);
    return { key: g.key, label: g.label, state, at: g.at, awaiting, reviewed, showCheck, clickable };
  });

  // Progress = furthest node the green connector reaches (active frontier while in-progress, else last completed) — a position, not a completed-count, so skipped middle nodes sit on the line.
  const reachedIdx = activeIdx >= 0 ? activeIdx : lastDoneIdx;
  const done = reachedIdx + 1;
  // Read after implication, so an archived ticket counts as started exactly when its prior status did.
  const started = [...stepState.values()].some((s) => s !== 'pending');

  return { nodes, current: currentLabel(groups, status, lastDoneIdx, activeIdx, failedStep), failed, started, progress: { done, total: nodes.length } };
}

// Current-phase label. Special case: between branch and a not-started gate, the agent is writing code — the "Implementing…" gap with no event of its own.
function currentLabel(
  groups: { key: string; label: string; state: NodeState; started: boolean }[],
  status: StatusId,
  lastDoneIdx: number,
  activeIdx: number,
  failedStep: { id: StepId } | undefined,
): string | null {
  if (status !== 'in-progress') return null;
  if (failedStep) return `${stepLabel(failedStep.id)} failed`;
  if (activeIdx === -1) return null;
  // in-progress guarantees a status-derived started, so a completed group precedes the frontier — prev is defined.
  const prev = lastDoneIdx >= 0 ? groups[lastDoneIdx] : undefined;
  const active = groups[activeIdx];
  if (active.state === 'unattributed') return `${active.label}: outcome unknown`;
  if (prev?.key === 'branch' && active.key === 'gate' && !active.started) return 'Implementing…';
  return active.label;
}
