import { describe, it, expect, expectTypeOf } from 'vitest';
import { isStatusId, isTicketType, isPriority } from './constants.js';
import * as local from './constants.js';
import * as pkg from 'ticket-workflow';

describe('isStatusId', () => {
  it('returns true for every valid status id', () => {
    expect(isStatusId('backlog')).toBe(true);
    expect(isStatusId('todo')).toBe(true);
    expect(isStatusId('in-progress')).toBe(true);
    expect(isStatusId('qa')).toBe(true);
    expect(isStatusId('done')).toBe(true);
    expect(isStatusId('archived')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isStatusId('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isStatusId('')).toBe(false);
  });
});

describe('isTicketType', () => {
  it('returns true for every valid ticket type', () => {
    expect(isTicketType('bug')).toBe(true);
    expect(isTicketType('feature')).toBe(true);
    expect(isTicketType('task')).toBe(true);
    expect(isTicketType('chore')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isTicketType('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isTicketType('')).toBe(false);
  });
});

describe('isPriority', () => {
  it('returns true for every valid priority', () => {
    expect(isPriority('low')).toBe(true);
    expect(isPriority('medium')).toBe(true);
    expect(isPriority('high')).toBe(true);
    expect(isPriority('urgent')).toBe(true);
  });

  it('returns false for an invalid string', () => {
    expect(isPriority('invalid')).toBe(false);
  });

  it('returns false for an empty string', () => {
    expect(isPriority('')).toBe(false);
  });
});

// Parity with the ticket-workflow package (tkt-36390042a0bf, tkt-66f0e22efd5e). hardpack keeps a local
// shared/constants.ts for its own imports (frontend, agent), while the service consumes the package;
// the two copies of the domain enums can silently DRIFT, and the board would then disagree with the
// package-backed service on what a valid status/type/step is. This asserts the shared subset is
// identical. Out of scope (correctly): hardpack-only constants (terminal WS codes, economics) and the
// package-only BRANCH_TICKET_ID_RE — parity covers only what BOTH declare.
describe('shared-constant parity with the ticket-workflow package', () => {
  // Each pair references a NAMED export on both sides, so a rename on EITHER side is a COMPILE error
  // (caught by `npm run typecheck`), not merely a runtime miss; the deep-equal then catches a value drift.
  const VALUE_PAIRS: readonly [name: string, localValue: unknown, pkgValue: unknown][] = [
    ['BOARD_STATUSES', local.BOARD_STATUSES, pkg.BOARD_STATUSES],
    ['STATUSES', local.STATUSES, pkg.STATUSES],
    ['STATUS_IDS', local.STATUS_IDS, pkg.STATUS_IDS],
    ['CREATE_STATUS_IDS', local.CREATE_STATUS_IDS, pkg.CREATE_STATUS_IDS],
    ['TYPES', local.TYPES, pkg.TYPES],
    ['PRIORITIES', local.PRIORITIES, pkg.PRIORITIES],
    ['SOURCES', local.SOURCES, pkg.SOURCES],
    ['STEPS', local.STEPS, pkg.STEPS],
    ['STEP_IDS', local.STEP_IDS, pkg.STEP_IDS],
    ['PIPELINE_STEPS', local.PIPELINE_STEPS, pkg.PIPELINE_STEPS],
    ['STEP_STATES', local.STEP_STATES, pkg.STEP_STATES],
    ['STATUS_STEP', local.STATUS_STEP, pkg.STATUS_STEP],
    ['EVENT_SOURCES', local.EVENT_SOURCES, pkg.EVENT_SOURCES],
  ];

  // Probe discipline: a parametrized loop over an empty table passes vacuously — a green check that
  // checked nothing. Guard the table is populated before trusting the per-constant assertions.
  it('has a non-empty parity table', () => {
    expect(VALUE_PAIRS.length).toBeGreaterThan(0);
  });

  it.each(VALUE_PAIRS)('%s is identical between the local copy and the package', (_name, localValue, pkgValue) => {
    expect(localValue).toBeDefined();
    expect(pkgValue).toBeDefined();
    expect(localValue).toEqual(pkgValue);
  });

  // Type parity — a structural drift (a field renamed/added/removed on one side, or an enum member
  // changed) is a COMPILE error under `tsc --noEmit`, before the runtime suite even runs. `npm test`
  // alone won't catch it (vitest runs without --typecheck), but the gate runs typecheck too.
  it('domain types are structurally identical', () => {
    expectTypeOf<local.StatusId>().toEqualTypeOf<pkg.StatusId>();
    expectTypeOf<local.TicketType>().toEqualTypeOf<pkg.TicketType>();
    expectTypeOf<local.Priority>().toEqualTypeOf<pkg.Priority>();
    expectTypeOf<local.TicketSource>().toEqualTypeOf<pkg.TicketSource>();
    expectTypeOf<local.StepId>().toEqualTypeOf<pkg.StepId>();
    expectTypeOf<local.StepState>().toEqualTypeOf<pkg.StepState>();
    expectTypeOf<local.Ticket>().toEqualTypeOf<pkg.Ticket>();
    expectTypeOf<local.Provenance>().toEqualTypeOf<pkg.Provenance>();
    // Every remaining type duplicated on both sides. The response types were absent from this
    // block, which is exactly how v0.10.0's `skipped`/`unrecognized` reached the wire while this
    // copy stayed silent: routes return the PACKAGE's object verbatim (`res.json(await
    // getTicketEvents(...))`, `res.json(await summarizeBoard(...))`), so a field missing here is
    // dropped from the client's view with typecheck green (tkt-355581f9dab3).
    //
    // Listed exhaustively rather than spot-checked: this list is the mechanism, so a type left off
    // it is a silent hole, and the dashboard types sit behind the identical `res.json(pkg object)`
    // shape that just failed for telemetry.
    expectTypeOf<local.EventSourceId>().toEqualTypeOf<pkg.EventSourceId>();
    expectTypeOf<local.TestCounts>().toEqualTypeOf<pkg.TestCounts>();
    expectTypeOf<local.TicketEvent>().toEqualTypeOf<pkg.TicketEvent>();
    expectTypeOf<local.PipelineStep>().toEqualTypeOf<pkg.PipelineStep>();
    expectTypeOf<local.TicketEventsResponse>().toEqualTypeOf<pkg.TicketEventsResponse>();
    expectTypeOf<local.DashboardSummary>().toEqualTypeOf<pkg.DashboardSummary>();
    expectTypeOf<local.RecentTicket>().toEqualTypeOf<pkg.RecentTicket>();
    expectTypeOf<local.StatusCount>().toEqualTypeOf<pkg.StatusCount>();
    expectTypeOf<local.PriorityCount>().toEqualTypeOf<pkg.PriorityCount>();
  });
});
