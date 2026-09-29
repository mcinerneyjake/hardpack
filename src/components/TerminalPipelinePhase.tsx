import { useState } from 'react';
import { useTicketEvents } from '../useTicketEvents.js';
import { pipelineView } from '../lib/pipelineView.js';
import { isTicketEventsResponse, statusFromPipeline } from '../lib/terminalRelay.js';

// Current pipeline phase beside the ticket id in the terminal header (tkt-87d1f5e5b5ee).
//
// Deliberately in the HEADER, not a node strip above the terminal body: the header's height is set by
// its title and buttons, so this can appear and disappear freely. Anything mounted between the header
// and .tw-body-wrap shrinks the terminal after xterm has already fit and reported its rows to the pty,
// which Ink renders as its input and status lines stacked on top of each other.
//
// Split out of TerminalWidget because session.ticket is optional — calling useTicketEvents there would
// be a conditional hook.

export default function TerminalPipelinePhase({ ticketId, minimized, onStartShell }: {
  ticketId: string;
  minimized: boolean;
  onStartShell: () => void;
}) {
  // Latched, not derived: `live` is an input to the hook that produces the data proving doneness, so it
  // can't be read off that data in the same render. Set during render (React's adjust-state-while-
  // rendering escape hatch), not in an effect — an effect here would cascade an extra render pass.
  const [reachedDone, setReachedDone] = useState(false);
  const { data } = useTicketEvents(ticketId, !minimized && !reachedDone);

  const valid = isTicketEventsResponse(data) ? data : null;
  const status = valid ? statusFromPipeline(valid.pipeline) : 'todo';
  if (status === 'done' && !reachedDone) setReachedDone(true);

  // A dropped poll keeps the last good phase (the hook retains data on error); a malformed or
  // never-worked one renders nothing. Either way the terminal stream is untouched.
  if (!valid) return null;
  const view = pipelineView(valid.pipeline, status);
  if (!view.started) return null;

  // view.current carries the live phase label ("<Step> failed", "<Group>: outcome unknown"), but only while in-progress.
  const label = status === 'done' ? 'Done' : status === 'qa' ? 'QA' : view.current;
  if (!label) return null;

  const tone = view.failed ? 'failed' : status === 'done' ? 'done' : 'active';

  // Done turns the chip into the way out. Offered, never taken automatically: the agent inside this
  // very session is what marks the ticket done, so acting on it unprompted would cut off its own
  // closing output. Switching to a shell session changes App's mount key, so the ticket-confined
  // container is really torn down — the confinement is frozen at spawn and can't be relabelled away.
  if (status === 'done') {
    return (
      <button
        type="button"
        className="tw-phase is-done tw-phase--action"
        onClick={onStartShell}
        title="Ticket complete — end this session and open a plain shell"
      >
        <span aria-hidden="true">✓</span> {label} · start fresh
      </button>
    );
  }

  return <span className={`tw-phase is-${tone}`} title={`Pipeline: ${label}`}>{label}</span>;
}
