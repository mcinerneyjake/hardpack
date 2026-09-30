import type { StatusId } from '../../shared/constants.js';
import { useTicketEvents } from '../useTicketEvents.js';
import { pipelineView } from '../lib/pipelineView.js';

export default function CardProgress({ ticketId, status }: { ticketId: string; status: StatusId }) {
  const { data } = useTicketEvents(ticketId, true);
  if (!data) return null;

  const view = pipelineView(data.pipeline, status, data.events);
  if (!view.started) return null;

  const pct = Math.round((view.progress.done / view.progress.total) * 100);

  return (
    <div className={`card-progress${view.failed ? ' is-failed' : ''}`} title={view.current ?? 'In progress'}>
      <div className="card-progress-track">
        <div className="card-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      {view.current && <span className="card-progress-label">{view.current}</span>}
    </div>
  );
}
