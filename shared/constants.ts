// Single source of truth for domain enums (server validation + React form options) — prevents UI/API drift.

export const BOARD_STATUSES = [
  { id: 'backlog', label: 'Backlog' },
  { id: 'todo', label: 'Todo' },
  { id: 'in-progress', label: 'In Progress' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
] as const;

// All statuses incl. archived (API validation + modal dropdown).
export const STATUSES = [
  ...BOARD_STATUSES,
  { id: 'archived', label: 'Archived' },
] as const;

export const STATUS_IDS = STATUSES.map((s) => s.id);

// Statuses a ticket may be CREATED in: board columns minus qa (a gate you
// transition INTO) and archived (an end-state). Shared so the HTTP service and
// MCP create schema can't diverge.
export const CREATE_STATUS_IDS: readonly StatusId[] = BOARD_STATUSES
  .map((s) => s.id)
  .filter((s) => s !== 'qa');

export const TYPES = ['bug', 'feature', 'task', 'chore'] as const;

export const PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;

// Mirrors ticket-workflow #169. Nothing in hardpack reads it yet: night-run.mjs ignores autonomy.
export const AUTONOMY = ['hitl', 'afk'] as const;

// Provenance authorship: agent = autonomous CLI write; assisted = human-reviewed
// agent draft. Human/MCP/HTTP write leaves source null. Distinct from
// Document.source (a retrieval connector); this names the WRITER.
export const SOURCES = ['agent', 'assisted'] as const;

// Trusted provenance stamp — threaded only through the agent write path, never
// from HTTP bodies or tool args, so authorship can't be spoofed.
export type Provenance = { source: TicketSource; runId: string }

export type StatusId = (typeof STATUSES)[number]['id']
export type TicketType = (typeof TYPES)[number]
export type Priority = (typeof PRIORITIES)[number]
export type TicketSource = (typeof SOURCES)[number]
export type Autonomy = (typeof AUTONOMY)[number]

// Embedded-terminal WS close code (server → client signal), in the WS application range 3000–4999.
// 4500 = the container/session failed to START (docker down, image missing, dtach never ready). The
// WS handshake completes before `docker run` fails, so a bare-close 1005 can't be told from a clean
// session end — this distinct code lets the client KEEP the widget and surface the failure instead of
// silently self-dismissing (tkt-171759eb29f6). A clean end stays a bare close (browser reports 1005).
// Shared so the server emitter and the client classifier can't drift on the number.
export const TERMINAL_STARTUP_FAILURE_CODE = 4500;

// 4501 = a REATTACH failed — the session existed but the server couldn't rejoin it (the adopted
// container isn't ready after the grace window, a transient exec-spawn failure, or the entry was
// disposed mid-reattach). Like 4500 the client keeps the widget and shows an error rather than
// dismissing (the session didn't cleanly end — it became unreachable). Distinct from 4500 for
// diagnosis: 4500 = never started, 4501 = couldn't be rejoined (tkt-42a6d95a92d1).
export const TERMINAL_REATTACH_FAILED_CODE = 4501;

// Type predicates — find() narrows to the literal union without a cast.
export function isStatusId(val: string): val is StatusId {
  return STATUS_IDS.find((s) => s === val) !== undefined;
}
export function isTicketType(val: string): val is TicketType {
  return TYPES.find((t) => t === val) !== undefined;
}
export function isPriority(val: string): val is Priority {
  return PRIORITIES.find((p) => p === val) !== undefined;
}
export function isSource(val: string): val is TicketSource {
  return SOURCES.find((s) => s === val) !== undefined;
}

export type Ticket = {
  id: string
  title: string
  type: TicketType
  priority: Priority
  status: StatusId
  order: number
  created: string
  updated: string
  body: string
  project: string | null
  blockers: string[]
  parent: string | null
  dueDate: string | null
  assignee: string | null
  autonomy: Autonomy
  // Non-null marks a spec ticket; slices are its children.
  spec: string | null
  // Provenance — non-null only for agent-authored tickets. Optional so test
  // literals can omit it; normalize() always emits an explicit value. runId links
  // to the run log for per-ticket usage lookup.
  source?: TicketSource | null
  runId?: string | null
}

// Read-time view model. `completedAt` is derived from the ticket's `done` event and NEVER persisted,
// so it must not sit on `Ticket` — constants.test.ts pins that type structurally identical to the
// package's stored schema, and the guard correctly rejected putting a derived field there
// (tkt-17dbc816e247). Absent means "not recorded" (no telemetry when the ticket was finished); it
// must never fall back to `updated`, which restamps on any edit.
export type BoardTicket = Ticket & { completedAt?: string | null }

// --- Dashboard aggregation -------------------------------------------------
// Shared server/client so they can't drift; counts exclude archived, canonical enum order.

export type StatusCount = { status: StatusId; count: number }
export type PriorityCount = { priority: Priority; count: number }

// --- Workflow-step telemetry ----------------------------------------------
// Ordered milestones a ticket passes through. Shared so emitters + reader can't drift (tkt-512f9b15ddb8).
// Split: started/qa/done/archived are STATUS transitions (updateTicket, archive sweep); the rest are shell commands (PostToolUse hook).

export const STEPS = [
  { id: 'started', label: 'Started' },
  { id: 'branch', label: 'Branch' },
  { id: 'typecheck', label: 'Typecheck' },
  { id: 'lint', label: 'Lint' },
  { id: 'test', label: 'Tests' },
  { id: 'review', label: 'Review' },
  { id: 'commit', label: 'Commit' },
  { id: 'pr_opened', label: 'PR opened' },
  { id: 'qa', label: 'QA' },
  { id: 'done', label: 'Done' },
  { id: 'archived', label: 'Archived' },
] as const;

export const STEP_IDS = STEPS.map((s) => s.id);
export type StepId = (typeof STEPS)[number]['id']

// The stages the server's reduced pipeline carries: `archived` is a logged end state, not a stage.
export const PIPELINE_STEPS = STEPS.filter((s) => s.id !== 'archived');

// reached = status milestone hit (no pass/fail); passed/failed = command milestone, per the hook event;
// unattributed = outcome unknown: a failed command that could not name its link, or a step `gate` could not start.
export const STEP_STATES = ['reached', 'passed', 'failed', 'unattributed'] as const;
export type StepState = (typeof STEP_STATES)[number]

// Status transitions that map to a tracked milestone; others emit nothing.
export const STATUS_STEP: Partial<Record<StatusId, StepId>> = {
  'in-progress': 'started',
  qa: 'qa',
  done: 'done',
  // Its own step, never `done`: archive_ticket retires abandoned work too.
  archived: 'archived',
};

// Which writer appended a row — a label the writer sets, not an attestation.
export const EVENT_SOURCES = ['engine', 'review', 'web', 'hook', 'gate'] as const;
export type EventSourceId = (typeof EVENT_SOURCES)[number]

export type TicketEvent = {
  ticketId: string
  step: StepId
  state: StepState
  at: string
  source?: EventSourceId // absent from a pre-v0.30.0 writer or a value this reader drops as unknown; never a date
  detail?: string
  // Set by the telemetry hook (every row) and `ticket-workflow gate`; presence is not an outcome:
  // `review: reached` is inferred, and a gate `unattributed` row carries it too.
  outcomeFrom?: 'event'
  exitCode?: number
  durationMs?: number
  tests?: TestCounts
}

export type TestCounts = { passed: number; failed: number; skipped: number }

// A reduced pipeline node: latest state per step, or pending if none arrived.
export type PipelineStep = {
  step: StepId
  label: string
  state: StepState | 'pending'
  at: string | null
}

export function isStepId(val: string): val is StepId {
  return STEP_IDS.find((s) => s === val) !== undefined;
}
export function isStepState(val: string): val is StepState {
  return STEP_STATES.find((s) => s === val) !== undefined;
}

// GET /api/tickets/:id/events payload. Shared server/client to prevent drift.
// `skipped` = event lines lost (the pipeline above is missing history). `unrecognized` = lines a
// newer ticket-workflow wrote that this pin can't parse — version skew, not damage. Both required:
// an optional field invites `?? 0`, which reports a damaged log as healthy (tkt-355581f9dab3).
export type TicketEventsResponse = {
  ticketId: string
  pipeline: PipelineStep[]
  events: TicketEvent[]
  skipped: number
  unrecognized: number
}

// Trimmed ticket for the "recently updated" widget — avoids shipping every body.
export type RecentTicket = Pick<Ticket, 'id' | 'title' | 'status' | 'priority' | 'project' | 'updated'>

export type DashboardSummary = {
  project: string | null // null = all projects
  total: number
  byStatus: StatusCount[]
  byPriority: PriorityCount[]
  recentlyUpdated: RecentTicket[]
}

// --- Agent economics (run-log aggregation) ---------------------------------
// GET /api/economics rollup. Shared server/client. Re-declared here (not imported
// from agent/cost) so shared/ stays a dependency-free leaf.

// Canonical economics-line labels in shared/ so a rename is a compile error across
// every consumer, not a silent find() miss.
export const LABEL_TOTAL_RUN_COST = 'total run cost';
export const LABEL_COST_PER_ACCEPTED = 'cost per accepted ticket';
export const LABEL_NET_SAVINGS = 'net savings';
export const LABEL_LOCAL_VS_CLOUD = 'local vs cloud (saved)';

export type EconomicsLineKind = 'measured' | 'assumed' | 'externality'

// One economic figure. amount:null = notional (required input unset), never a silent zero.
export type EconomicsLine = {
  label: string
  amount: number | null
  unit: string
  kind: EconomicsLineKind
  note?: string
}

// One day's rollup for the time-series chart.
export type EconomicsPoint = {
  date: string // YYYY-MM-DD
  runCostUsd: number | null
  totalTokens: number
  acceptedTickets: number
}

export type EconomicsTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  activeMs: number
  created: number
  updated: number
  declined: number
  acceptedTickets: number // created + updated
}

export type EconomicsSummary = {
  range: { from: string | null; to: string | null } // null = unbounded
  runs: number
  totals: EconomicsTotals
  // Cost lines summed across the range, grouped as the per-run RunSummary is.
  measured: EconomicsLine[]
  assumed: EconomicsLine[]
  externalities: EconomicsLine[]
  headline: EconomicsLine[] // cost per accepted ticket · net savings · local vs cloud
  timeSeries: EconomicsPoint[]
  // True if any summed USD line was notional (null) — keeps $ totals honest, not silently under-reported.
  partial: boolean
}

// A single run's economics — the ?runId= deep-link target. A superset of
// EconomicsSummary (runs:1) enriched with the run identity + authored ticket ids
// the detail view links back to.
export type EconomicsRunDetail = EconomicsSummary & {
  runId: string
  model: string
  at: string // ISO timestamp of the run
  ticketIds: { created: string[]; updated: string[] }
}
