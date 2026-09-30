import { useEffect, useState, useCallback, useMemo, useRef, lazy, Suspense } from 'react';
import { api } from './api.js';
import type { UnreadableTicketFile } from 'ticket-workflow';
import Board from './components/Board.jsx';
import Dashboard from './components/Dashboard.jsx';
import EconomicsDashboard from './components/EconomicsDashboard.jsx';
import EconomicsRunDetail from './components/EconomicsRunDetail.jsx';
import Sidebar, { type View } from './components/Sidebar.jsx';
import ArchiveLane from './components/ArchiveLane.jsx';
import TicketModal from './components/TicketModal.jsx';
import FilterPopover, { type FilterState } from './components/FilterPopover.jsx';
import { completedToday } from './lib/completedToday.js';
import { todayLocal, msUntilNextLocalMidnight } from './lib/completedDate.js';
import DashboardConfigPopover from './components/DashboardConfigPopover.jsx';
import { type TerminalSession } from './components/TerminalWidget.jsx';
// Lazy + DEV-gated so the xterm payload lands in its own chunk (loaded only in dev), never the prod main bundle.
const TerminalWidget = lazy(() => import('./components/TerminalWidget.jsx'));
import ErrorBanner from './components/ui/ErrorBanner.jsx';
import { encode, decode } from './lib/filterParams.js';
import { type Prefill } from './lib/proposalPrefill.js';
import { computeChildCounts } from './lib/childCounts.js';
import { computeActiveBlockerCounts, computeStaleBlockerCounts } from './lib/blockers.js';
import { filterTickets } from './lib/filterTickets.js';
import { resolveTicket } from './lib/resolveTicket.js';
import { nextStreamHealth, type StreamHealth } from './lib/streamHealth.js';
import { useTheme } from './useTheme.js';
import { useDashboardConfig } from './useDashboardConfig.js';
import type { Ticket, BoardTicket } from '../shared/constants.js';

// The embedded terminal must survive a Vite full reload so it can REATTACH (tkt-dd308ec91efc):
// React state resets on reload, so persist "a terminal is open (for which ticket)" in
// sessionStorage and restore it, re-mounting the widget — which then rejoins its running session
// via its own stored session id. Dev-only (the widget itself is DEV-gated). Defensive read.
const TERMINAL_OPEN_KEY = 'terminal:open';
function isTerminalSession(v: unknown): v is TerminalSession {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  if (!('ticket' in v)) return true; // {} = shell session
  return typeof v.ticket === 'string';
}
function loadTerminalSession(): TerminalSession | null {
  if (!import.meta.env.DEV) return null;
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(TERMINAL_OPEN_KEY) ?? 'null');
    return isTerminalSession(parsed) ? parsed : null;
  } catch { return null; }
}

export default function App() {
  const { theme, toggle } = useTheme();
  const [tickets, setTickets] = useState<BoardTicket[]>([]);
  // One board-wide clock, re-issued at local midnight. A per-component mountedAt would freeze, and a
  // board left open overnight would keep calling yesterday's work "Today" (tkt-17dbc816e247).
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState<UnreadableTicketFile[]>([]);
  const [eventsSkipped, setEventsSkipped] = useState(0);
  const [eventsUnreadable, setEventsUnreadable] = useState(0);
  const [streamHealth, setStreamHealth] = useState<StreamHealth>('live');
  const [editing, setEditing] = useState<BoardTicket | 'new' | null>(null);
  const [prefill, setPrefill] = useState<Prefill | null>(null);
  // Non-null → Save routes through intake-apply (provenance + metering), not the human route.
  const [draftRunId, setDraftRunId] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterState>(() => decode(new URLSearchParams(location.search)));
  const [showArchive, setShowArchive] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  // Ephemeral peek from the ticket editor — no URL coupling; reload won't reopen it.
  const [runId, setRunId] = useState<string | null>(null);
  const [view, setView] = useState<View>('board');
  // Dev-only embedded terminal (tkt-be809dd2b7fb). null = closed; {} = shell; {ticket} = seeded.
  // Restored from sessionStorage so a reload re-mounts the widget and reattaches (tkt-dd308ec91efc).
  const [terminalSession, setTerminalSession] = useState<TerminalSession | null>(loadTerminalSession);
  const dash = useDashboardConfig();
  // Bumped on every ticket reload so the dashboard re-fetches its aggregates.
  const [refreshKey, setRefreshKey] = useState(0);

  // Persist the open-terminal state so a reload restores it (see loadTerminalSession).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    try {
      if (terminalSession) sessionStorage.setItem(TERMINAL_OPEN_KEY, JSON.stringify(terminalSession));
      else sessionStorage.removeItem(TERMINAL_OPEN_KEY);
    } catch { /* storage unavailable → reload just won't reattach */ }
  }, [terminalSession]);

  useEffect(() => {
    const params = encode(filter);
    const search = params.toString();
    history.replaceState(null, '', search ? `?${search}` : location.pathname);
  }, [filter]);

  useEffect(() => {
    const t = setTimeout(() => setSearchTerm(searchInput.trim()), 200);
    return () => clearTimeout(t);
  }, [searchInput]);

  const load = useCallback(() => {
    api.list()
      .then((board) => {
        setTickets(board.tickets);
        setUnreadable(board.unreadable);
        setEventsSkipped(board.eventsSkipped);
        setEventsUnreadable(board.eventsUnreadable);
        setRefreshKey((k) => k + 1);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  // Mute refresh-driven reloads briefly after a local write so the chokidar echo can't clobber optimistic drag state; external changes land outside the window.
  const muteRefreshUntil = useRef(0);
  const markLocalWrite = useCallback(() => { muteRefreshUntil.current = Date.now() + 500; }, []);

  const projects = useMemo(
    () => [...new Set(tickets.map((t) => t.project).filter((p): p is string => Boolean(p)))].sort(),
    [tickets],
  );

  const assignees = useMemo(
    () => [...new Set(tickets.map((t) => t.assignee).filter((a): a is string => Boolean(a)))].sort(),
    [tickets],
  );

  // Re-arms on each fire, so the board rolls over every midnight it stays open. A timer that fires
  // late (laptop asleep) still fires, which is the behaviour we want.
  useEffect(() => {
    const id = setTimeout(() => setNow(Date.now()), msUntilNextLocalMidnight(now));
    return () => clearTimeout(id);
  }, [now]);

  const archivedTickets = useMemo(() => tickets.filter((t) => t.status === 'archived'), [tickets]);

  const filteredTickets = useMemo(
    () => filterTickets(tickets.filter((t) => t.status !== 'archived'), filter, searchTerm),
    [tickets, filter, searchTerm],
  );

  const todaysCompletions = useMemo(() => completedToday(tickets, filter, now), [tickets, filter, now]);

  const handleShowToday = useCallback(() => {
    const today = todayLocal(now);
    setFilter((f) => ({ ...f, dateField: 'completedAt', dateFrom: today, dateTo: today }));
    // Expand the archive when today's work has been swept there, so the chip's number never exceeds
    // what is actually on screen.
    if (todaysCompletions.some((t) => t.status === 'archived')) setShowArchive(true);
  }, [now, todaysCompletions]);

  // Archived tickets obey the same FilterPopover filters so the Archive lane narrows with the board
  // (tkt-d7919e9f1e9b) — one predicate via filterTickets, so board + archive can't drift. The board
  // SEARCH box stays board-only (empty searchTerm here); only the FilterPopover `filter` narrows the
  // archive. Skipped while the lane is collapsed — its cards/empty-state aren't rendered then.
  const filteredArchivedTickets = useMemo(
    () => (showArchive ? filterTickets(archivedTickets, filter, '') : []),
    [showArchive, archivedTickets, filter],
  );

  // parent id → sub-ticket count, from all tickets not filtered (see computeChildCounts).
  const childCounts = useMemo(() => computeChildCounts(tickets), [tickets]);

  // ticket id → active blocker count; from all tickets so hidden-column blockers still count (see computeActiveBlockerCounts).
  const activeBlockerCounts = useMemo(() => computeActiveBlockerCounts(tickets), [tickets]);

  const staleBlockerCounts = useMemo(() => computeStaleBlockerCounts(tickets), [tickets]);

  // Lets stable callbacks read current tickets without a dep; synced in an effect, not during render.
  const ticketsRef = useRef(tickets);
  useEffect(() => { ticketsRef.current = tickets; }, [tickets]);

  useEffect(() => {
    load();
  }, [load]);

  // Live board sync: server broadcasts a bare `refresh` over SSE on any ticket-file change.
  useEffect(() => {
    const es = new EventSource('/api/stream');
    // Skip the echo of our own write (see markLocalWrite).
    const onRefresh = () => { if (Date.now() >= muteRefreshUntil.current) load(); };
    // Only refetch on a genuine RE-connect (mount load covers first connect); EventSource doesn't replay missed events.
    let connectedOnce = false;
    // readyState is sampled HERE, not inside the updater: React may run an updater during a later
    // render pass, by which time cleanup's es.close() has forced readyState to CLOSED — reading it
    // there turns a transient blip into a permanent "dead" verdict (tkt-ea0d1ed1d5d2).
    const onOpen = () => {
      const readyState = es.readyState;
      setStreamHealth((h) => nextStreamHealth(h, 'open', readyState));
      if (!connectedOnce) { connectedOnce = true; return; }
      load();
    };
    // Both verdicts belong to nextStreamHealth: `error` alone is a transient blip the browser is
    // already retrying, and only a CLOSED readyState is permanent.
    const onError = () => {
      const readyState = es.readyState;
      setStreamHealth((h) => nextStreamHealth(h, 'error', readyState));
    };
    es.addEventListener('refresh', onRefresh);
    es.addEventListener('open', onOpen);
    es.addEventListener('error', onError);
    return () => {
      es.removeEventListener('refresh', onRefresh);
      es.removeEventListener('open', onOpen);
      es.removeEventListener('error', onError);
      es.close();
    };
  }, [load]);

  // Always (re)sets prefill so a normal open doesn't inherit a stale one.
  const openTicket = useCallback((target: Ticket | 'new', initial: Prefill | null = null, initialRunId: string | null = null) => {
    setPrefill(initial);
    setDraftRunId(initialRunId);
    setEditing(target);
  }, []);

  const closeTicket = useCallback(() => {
    setEditing(null);
    setPrefill(null);
    setDraftRunId(null);
  }, []);

  // Nav between views closes any open modal (scoped to the view it opened from).
  const handleViewChange = useCallback((next: View) => {
    setView(next);
    // Sidebar sits above the backdrop, so a nav must dismiss open overlays itself.
    closeTicket();
    setRunId(null);
  }, [closeTicket]);

  // Stacks over the ticket editor (a peek); closing returns to it with edits intact.
  const openRun = useCallback((rid: string) => {
    setRunId(rid);
  }, []);

  // Ids from the dashboard/run lists may not be in the current list — fall back to a fetch (see resolveTicket).
  const openTicketById = useCallback((id: string) => {
    resolveTicket(id, ticketsRef.current, api.get)
      .then(openTicket)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [openTicket]);

  const handleSave = useCallback(async (data: Partial<Ticket>, applyRunId?: string) => {
    const target = editing !== 'new' ? editing : null;
    try {
      if (applyRunId) {
        // Agent draft: apply via provenance/metering endpoint (🤖 Assisted badge + run link).
        await api.intake.apply({
          action: target ? 'update_ticket' : 'create_ticket',
          runId: applyRunId,
          args: target ? { ...data, id: target.id } : data,
        });
      } else if (target) await api.update(target.id, data);
      else await api.create(data);
      closeTicket();
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [editing, load, closeTicket]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await api.remove(id);
      closeTicket();
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [load, closeTicket]);

  const handleReparent = useCallback(async (id: string, newParentId: string) => {
    if (id === newParentId) return;
    // Guard cycles: reject if newParentId is a descendant of id.
    const current = ticketsRef.current;
    const descendants = new Set<string>();
    const queue = [id];
    while (queue.length) {
      const cur = queue.shift();
      if (cur === undefined) break;
      for (const t of current) {
        if (t.parent === cur && !descendants.has(t.id)) {
          descendants.add(t.id);
          queue.push(t.id);
        }
      }
    }
    if (descendants.has(newParentId)) return;
    const originalParent = current.find((t) => t.id === id)?.parent ?? null;
    markLocalWrite();
    setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: newParentId } : t)));
    try {
      await api.update(id, { parent: newParentId });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setTickets((prev) => prev.map((t) => (t.id === id ? { ...t, parent: originalParent } : t)));
    }
  }, [markLocalWrite]);

  const handleArchiveAll = useCallback(async () => {
    const doneTickets = ticketsRef.current.filter((t) => t.status === 'done');
    try {
      await Promise.all(doneTickets.map((t) => api.update(t.id, { status: 'archived' })));
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); load(); }
  }, [load]);

  // Optimistic move: patch local state first, persist, reload on failure.
  const handleMove = useCallback(async (id: string, status: Ticket['status'], order: number) => {
    markLocalWrite();
    setTickets((prev) =>
      prev.map((t) => (t.id === id ? { ...t, status, order } : t)));
    try {
      await api.update(id, { status, order });
      // A move into done mints the `done` event that completedAt is derived from (archived mints its own step). The
      // optimistic patch above has no completedAt and markLocalWrite() mutes the SSE echo, so
      // without an explicit reload the pill and the "N today" chip would not appear until some
      // unrelated write (tkt-17dbc816e247).
      if (status === 'done' || status === 'archived') load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      load();
    }
  }, [load, markLocalWrite]);

  return (
    <div className="layout">
      <Sidebar
        view={view}
        onViewChange={handleViewChange}
        theme={theme}
        onToggleTheme={toggle}
      />

      <div className="app">
        <header className="topbar">
          <h1>Hardpack</h1>
          <div className="topbar-actions">
            {view === 'board' ? (
              <>
                <input
                  className="search-input"
                  type="search"
                  placeholder="Search tickets…"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                />
                <FilterPopover filter={filter} projects={projects} assignees={assignees} onChange={setFilter} onQuickToday={handleShowToday} />
              </>
            ) : view === 'dashboard' ? (
              <DashboardConfigPopover projects={projects} dash={dash} />
            ) : null}
            <button className="btn primary" onClick={() => openTicket('new')}>
              + New ticket
            </button>
          </div>
        </header>

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        {/* Not dismissible: the board below is missing these tickets until the files are
            fixed, and a warning you can wave away is the silence this replaced. */}
        {unreadable.length > 0 && (
          <div className="error persistent" role="alert">
            {unreadable.length} ticket file(s) could not be read and are missing from this board:{' '}
            {unreadable.map((u) => u.file).join(', ')} — fix the frontmatter (an unquoted title
            containing a colon is the usual cause).
          </div>
        )}

        {/* Same rule as above, on the telemetry side: a completion date that is simply absent looks
            exactly like a ticket that was never completed (tkt-3d6039df4076). Two counts, because a
            log that could not be OPENED yields no lines — so a line count alone reports the total
            loss as a healthy board. */}
        {(eventsSkipped > 0 || eventsUnreadable > 0) && (
          <div className="error persistent" role="alert">
            {eventsUnreadable > 0 && <>{eventsUnreadable} telemetry log(s) could not be read at all. </>}
            {eventsSkipped > 0 && <>{eventsSkipped} telemetry line(s) could not be parsed. </>}
            A completion date may therefore be missing, or out of date, on tickets that do have one.
            Check events/ for a truncated line or a permissions problem.
          </div>
        )}

        {/* Third of the same kind, on the live-update side: a stream that has stopped for good looks
            exactly like a board where nothing is happening, and it was previously a console warning
            nobody sees (tkt-ea0d1ed1d5d2). Cleared only by an observed reconnect. */}
        {streamHealth === 'dead' && (
          <div className="error persistent" role="alert">
            Live updates are off — the connection to the server closed and will not reopen on its own.
            Everything below is a snapshot from the last successful load and may already be out of
            date. Reload the page to reconnect.
          </div>
        )}

        {view === 'board' ? (
          <>
            <Board tickets={filteredTickets} now={now} todayCount={todaysCompletions.length} onShowToday={handleShowToday} allTickets={tickets} sort={filter.sort} childCounts={childCounts} activeBlockerCounts={activeBlockerCounts} staleBlockerCounts={staleBlockerCounts} onMove={handleMove} onReparent={handleReparent} onOpen={openTicket} onArchiveAll={handleArchiveAll} />
            <ArchiveLane tickets={filteredArchivedTickets} now={now} totalCount={archivedTickets.length} activeBlockerCounts={activeBlockerCounts} show={showArchive} onToggle={() => setShowArchive((v) => !v)} onOpen={openTicket} />
          </>
        ) : view === 'economics' ? (
          <EconomicsDashboard refreshKey={refreshKey} />
        ) : (
          <Dashboard
            project={dash.project}
            visible={dash.visible}
            autoRefresh={dash.autoRefresh}
            refreshKey={refreshKey}
            onOpen={openTicketById}
          />
        )}

        {editing && (
          <TicketModal
            key={editing === 'new' ? 'new' : editing.id}
            ticket={editing === 'new' ? null : editing}
            initial={prefill ?? undefined}
            initialRunId={draftRunId ?? undefined}
            allTickets={tickets}
            projects={projects}
            assignees={assignees}
            onSave={handleSave}
            onDelete={handleDelete}
            onOpen={openTicket}
            onOpenRun={openRun}
            onClose={closeTicket}
            // Close the editor first so the seeded terminal isn't hidden behind the modal.
            onRunInTerminal={(id) => { closeTicket(); setTerminalSession({ ticket: id }); }}
          />
        )}

        {/* Single-run economics peek, stacked over the ticket editor. */}
        {runId && (
          <EconomicsRunDetail
            runId={runId}
            onClose={() => setRunId(null)}
            // Close this peek as the ticket opens so the two don't stack.
            onOpen={(id) => { setRunId(null); openTicketById(id); }}
          />
        )}
      </div>

      {/* Dev-only embedded terminal — mounted at .layout so it survives view changes; DEV-gated
          so a production build never ships a launcher pointing at a non-existent endpoint. */}
      {import.meta.env.DEV && terminalSession === null && (
        <button className="terminal-fab" onClick={() => setTerminalSession({})} title="Open terminal">
          ⌨ Terminal
        </button>
      )}
      {import.meta.env.DEV && terminalSession && (
        <Suspense fallback={null}>
          <TerminalWidget
            key={terminalSession.ticket ?? 'shell'}
            session={terminalSession}
            theme={theme}
            onClose={() => setTerminalSession(null)}
            // {} is the shell session, so the key flips ticket→'shell' and the widget remounts —
            // really disposing the ticket-confined container rather than renaming it.
            onStartShell={() => setTerminalSession({})}
          />
        </Suspense>
      )}
    </div>
  );
}
