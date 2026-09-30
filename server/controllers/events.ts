import type { Request, Response } from 'express';
import { getTicketEvents, appendEvent, REVIEW_CLEARED } from '../events.js';
import { getTicket } from '../tickets.js';
import type { ReviewRequest } from '../schemas/review.js';
import { ticketId } from '../schemas/params.js';

// Read-only milestone timeline. Never-worked/unknown ticket → all-pending pipeline (200, not 404). Id format validated by the service.
export async function events(req: Request, res: Response): Promise<void> {
  res.json(await getTicketEvents(ticketId(req)));
}

// Toggle the review milestone. { reviewed: false } un-reviews via a cleared marker; anything else confirms.
export async function review(req: Request, res: Response, input: ReviewRequest): Promise<void> {
  const id = ticketId(req);
  // Write endpoint: reject a ghost id (404 via getTicket) so no orphan events/<id>.jsonl is created.
  await getTicket(id);
  const reviewed = input.reviewed !== false;
  await appendEvent({
    ticketId: id,
    step: 'review',
    state: 'reached',
    source: 'web',
    ...(reviewed ? {} : { detail: REVIEW_CLEARED }),
  });
  res.json(await getTicketEvents(id));
}
