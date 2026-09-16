import { listBoard, type BoardListing } from '../../../server/tickets.js';
import { type Ticket } from '../../../shared/constants.js';
import { type Document } from '../retrieval.js';
import { type Connector } from './connector.js';

// The hardpack board as a connector. Ticket-specific knowledge lives here and nowhere else: title+body is the embeddable text, `status` rides through in `meta`, `updated` feeds the index cache's change signature.
export class TicketConnector implements Connector<Ticket> {
  readonly source = 'ticket';

  pull(): Promise<Ticket[]> {
    return listBoard().then((b) => b.tickets);
  }

  // The board read WITH its completeness report. `pull()` satisfies the source-agnostic Connector
  // contract and therefore returns records only — which makes a partial read indistinguishable from a
  // smaller board. Harmless for search; fatal for anything that DELETES derived state, so the one
  // caller that prunes reads this instead (tkt-da0b8b6bc21e).
  pullBoard(): Promise<BoardListing> {
    return listBoard();
  }

  toDocument(t: Ticket): Document {
    return {
      id: t.id,
      source: this.source,
      title: t.title,
      text: `${t.title}\n\n${t.body}`.trim(),
      updated: t.updated,
      meta: { status: t.status },
    };
  }
}
