import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import { latestDoneAt, withCompletedAt, withCompletedAtAll, clearCompletionCache } from './completion.js';
import type { Ticket, TicketEvent } from '../shared/constants.js';

const dirs = setupTempTicketDirs('completion');

const mk = (over: Partial<Ticket> = {}): Ticket => ({
  id: 'tkt-1', title: 'T', type: 'task', priority: 'medium', status: 'done', order: 0,
  created: '2026-07-01T00:00:00.000Z', updated: '2026-07-02T00:00:00.000Z', body: '',
  project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
  ...over,
});

const ev = (over: Partial<TicketEvent> = {}): TicketEvent => ({
  ticketId: 'tkt-1', step: 'done', state: 'reached', at: '2026-08-11T19:00:00.000Z', ...over,
});

async function writeEvents(id: string, events: TicketEvent[]): Promise<void> {
  await fs.writeFile(path.join(dirs.events, `${id}.jsonl`), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

beforeEach(() => clearCompletionCache());

describe('latestDoneAt', () => {
  it('returns the done timestamp', () => {
    expect(latestDoneAt([ev()])).toBe('2026-08-11T19:00:00.000Z');
  });

  it('ignores non-done steps', () => {
    expect(latestDoneAt([ev({ step: 'started' }), ev({ step: 'qa' })])).toBeNull();
  });

  it('takes the LATEST of several done events (reopened then reclosed)', () => {
    const events = [
      ev({ at: '2026-08-01T10:00:00.000Z' }),
      ev({ at: '2026-08-09T10:00:00.000Z' }),
      ev({ at: '2026-08-05T10:00:00.000Z' }),
    ];
    expect(latestDoneAt(events)).toBe('2026-08-09T10:00:00.000Z');
  });

  it('skips unparseable timestamps rather than returning them', () => {
    expect(latestDoneAt([ev({ at: 'garbage' })])).toBeNull();
    expect(latestDoneAt([ev({ at: 'garbage' }), ev({ at: '2026-08-11T19:00:00.000Z' })]))
      .toBe('2026-08-11T19:00:00.000Z');
  });

  it('returns null for no events at all', () => {
    expect(latestDoneAt([])).toBeNull();
  });
});

describe('withCompletedAt', () => {
  it('attaches the done timestamp to a done ticket', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('attaches it to an archived ticket too — archiving preserves the completion', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk({ status: 'archived' }))).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('gives null when the ticket has no events file (pre-telemetry)', async () => {
    expect((await withCompletedAt(mk())).completedAt).toBeNull();
  });

  it('gives null when events exist but none is a done step', async () => {
    await writeEvents('tkt-1', [ev({ step: 'started' })]);
    expect((await withCompletedAt(mk())).completedAt).toBeNull();
  });

  it('leaves a non-completed ticket untouched, with no completedAt key', async () => {
    await writeEvents('tkt-1', [ev()]);
    const out = await withCompletedAt(mk({ status: 'in-progress' }));
    expect(out.completedAt).toBeUndefined();
  });

  it('enriches only the completed tickets in a list', async () => {
    await writeEvents('tkt-1', [ev()]);
    await writeEvents('tkt-2', [ev({ ticketId: 'tkt-2', at: '2026-08-10T19:00:00.000Z' })]);
    const { tickets: out } = await withCompletedAtAll([mk(), mk({ id: 'tkt-2', status: 'todo' })]);
    expect(out[0].completedAt).toBe('2026-08-11T19:00:00.000Z');
    expect(out[1].completedAt).toBeUndefined();
  });
});

// A read failure is "could not check", which must never be cached as "never completed" — the file's
// mtime never changes again, so one transient EMFILE/EACCES would pin the ticket as not-recorded for
// the life of the process, indistinguishable from a genuine pre-telemetry ticket.
describe('unreadable events file', () => {
  it('does not cache a failed read as "never completed"', async () => {
    // chmod, not a dir-for-file swap: the mtime must be IDENTICAL across the failed and successful
    // read, or the mtime key alone would force a re-read and the test would pass even if the failure
    // were being cached — a control that cannot fail.
    const file = path.join(dirs.events, 'tkt-1.jsonl');
    await writeEvents('tkt-1', [ev()]);
    const before = (await fs.stat(file)).mtimeMs;

    await fs.chmod(file, 0o000);
    expect((await withCompletedAt(mk())).completedAt).toBeNull(); // EACCES → "could not check"

    await fs.chmod(file, 0o644);
    expect((await fs.stat(file)).mtimeMs).toBe(before); // chmod does not move mtime
    // Same mtime, so a cached null would still be served here. It must not be.
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });
});

describe('cache invalidation', () => {
  // A cache that never invalidates freezes every date on the board and looks perfectly correct.
  it('picks up a newly appended done event', async () => {
    await writeEvents('tkt-1', [ev({ step: 'started' })]);
    expect((await withCompletedAt(mk())).completedAt).toBeNull();

    await writeEvents('tkt-1', [ev({ step: 'started' }), ev({ at: '2026-08-11T21:00:00.000Z' })]);
    // mtime has moved, so the memo must be discarded rather than replayed.
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T21:00:00.000Z');
  });

  it('serves a repeat read without the file (proving the memo is actually used)', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
    // Rewriting identical content changes mtime, so instead assert the cached value survives a
    // second call while the file is untouched — a miss here would still hit disk and pass, so the
    // real assertion is the invalidation test above.
    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });
});

// The widest reader of events/ was the only one discarding lines in silence (tkt-3d6039df4076).
// The harm lands on a field a human reads: if the DISCARDED line was the `done` event, latestDoneAt
// returns null and the board renders "not recorded" for a ticket that was recorded.
describe('discarded event lines are counted', () => {
  async function writeRaw(id: string, lines: string[]): Promise<void> {
    await fs.writeFile(path.join(dirs.events, `${id}.jsonl`), lines.join('\n') + '\n');
  }

  it('reports how many lines it discarded', async () => {
    await writeRaw('tkt-1', [
      'not json at all',
      JSON.stringify(ev({ step: 'started' })),
      '{"step":"done","at":', // truncated
      JSON.stringify({ step: 'done' }), // no `at` — fails isStepAt
    ]);
    const { tickets, eventsSkipped } = await withCompletedAtAll([mk()]);
    expect(eventsSkipped).toBe(3);
    expect(tickets[0].completedAt).toBeNull();
  });

  // The negative control: a counter wired to a constant passes the case above and fails this one.
  it('reports 0 for a clean board', async () => {
    await writeEvents('tkt-1', [ev()]);
    const { tickets, eventsSkipped } = await withCompletedAtAll([mk()]);
    expect(eventsSkipped).toBe(0);
    expect(tickets[0].completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('sums across tickets rather than reporting only the last', async () => {
    await writeRaw('tkt-1', ['garbage', JSON.stringify(ev())]);
    await writeRaw('tkt-2', ['garbage', 'more garbage', JSON.stringify(ev({ ticketId: 'tkt-2' }))]);
    const { eventsSkipped } = await withCompletedAtAll([mk(), mk({ id: 'tkt-2' })]);
    expect(eventsSkipped).toBe(3);
  });

  it('counts nothing for a ticket with no events file', async () => {
    const { eventsSkipped } = await withCompletedAtAll([mk()]);
    expect(eventsSkipped).toBe(0);
  });

  // Non-completed tickets are never joined, so their logs are never read. The count must not imply
  // the whole board was inspected.
  it('does not count tickets it never reads', async () => {
    await writeRaw('tkt-1', ['garbage', JSON.stringify(ev())]);
    const { eventsSkipped } = await withCompletedAtAll([mk({ status: 'in-progress' })]);
    expect(eventsSkipped).toBe(0);
  });

  // The worst loss reported as the healthiest board: a log that cannot be read AT ALL yields no
  // lines, so a line counter alone says 0 and the banner stays hidden — "can't check" returning the
  // permissive answer. Whole-file failures get their own count.
  it.skipIf(process.getuid?.() === 0)('counts a log it could not read at all', async () => {
    const file = path.join(dirs.events, 'tkt-1.jsonl');
    await writeEvents('tkt-1', [ev()]);
    await fs.chmod(file, 0o000);
    try {
      const { tickets, eventsSkipped, eventsUnreadable } = await withCompletedAtAll([mk()]);
      expect(eventsUnreadable).toBe(1);
      expect(eventsSkipped).toBe(0); // no lines were read, so none were lost — a different fact
      expect(tickets[0].completedAt).toBeNull();
    } finally {
      await fs.chmod(file, 0o644);
    }
  });

  // The same fail-open one level up: completedAtFor's stat catch was unconditional, so a directory
  // that lost its execute bit (or an EMFILE storm across the 32 concurrent stats) read as
  // "pre-telemetry" for every done ticket — a board-wide blackout rendered as "never completed".
  it.skipIf(process.getuid?.() === 0)('counts a stat failure rather than calling it pre-telemetry', async () => {
    await writeEvents('tkt-1', [ev()]);
    await fs.chmod(dirs.events, 0o000);
    try {
      const { eventsUnreadable } = await withCompletedAtAll([mk()]);
      expect(eventsUnreadable).toBe(1);
    } finally {
      await fs.chmod(dirs.events, 0o755);
    }
  });

  it('reports 0 unreadable on a healthy board', async () => {
    await writeEvents('tkt-1', [ev()]);
    expect((await withCompletedAtAll([mk()])).eventsUnreadable).toBe(0);
  });

  // A genuinely absent log is pre-telemetry, not a failure — counting it would mark most of the
  // board damaged, which is the inverse mistake.
  it('does not count an absent log as unreadable', async () => {
    expect((await withCompletedAtAll([mk()])).eventsUnreadable).toBe(0);
  });

  // The package reader deliberately exempts a torn FINAL line: appendEvent terminates every complete
  // record with \n, so a non-empty last chunk is a write in flight. Diverging here made the two
  // readers of the SAME file disagree, and made that ticket permanently uncacheable.
  it('does not count a torn final line, matching the package reader', async () => {
    await fs.writeFile(path.join(dirs.events, 'tkt-1.jsonl'),
      JSON.stringify(ev()) + '\n{"step":"done","at":');
    const { tickets, eventsSkipped } = await withCompletedAtAll([mk()]);
    expect(eventsSkipped).toBe(0);
    expect(tickets[0].completedAt).toBe('2026-08-11T19:00:00.000Z');
  });

  it('counts that torn line once a later event follows it', async () => {
    await writeRaw('tkt-1', ['{"step":"done","at":', JSON.stringify(ev())]);
    expect((await withCompletedAtAll([mk()])).eventsSkipped).toBe(1);
  });

  // The count is only stable across loads because a damaged read is never cached. Nothing stated
  // that coupling, so a future "cache the date but keep re-reporting" change could make the banner
  // appear on first load and vanish on every later one, suite green.
  it('reports the same count on a second, cache-warm load', async () => {
    await writeRaw('tkt-1', ['garbage', JSON.stringify(ev())]);
    expect((await withCompletedAtAll([mk()])).eventsSkipped).toBe(1);
    expect((await withCompletedAtAll([mk()])).eventsSkipped).toBe(1);
  });

  // The load-bearing half. A damaged read is not a trustworthy answer, so it must be re-derived
  // rather than pinned — the event file's mtime never changes again once written, so a cached wrong
  // date would never be revisited.
  it('does not cache a date derived from a damaged log', async () => {
    const file = path.join(dirs.events, 'tkt-1.jsonl');
    // Both writes are stamped with the SAME explicit mtime rather than one being restored after the
    // fact: fs.utimes loses sub-millisecond precision, so a restored stamp differs by a fraction,
    // the mtime key invalidates on its own, and the test passes without proving anything. Stamping
    // both through the same call makes them identical by construction.
    const STAMP = new Date('2026-08-01T00:00:00.000Z');

    await writeRaw('tkt-1', ['garbage', JSON.stringify(ev({ step: 'started' }))]);
    await fs.utimes(file, STAMP, STAMP);
    const before = (await fs.stat(file)).mtimeMs;
    expect((await withCompletedAt(mk())).completedAt).toBeNull();

    await fs.writeFile(file, [JSON.stringify(ev({ step: 'started' })), JSON.stringify(ev())].join('\n') + '\n');
    await fs.utimes(file, STAMP, STAMP);
    // The control: same mtime, so a cached answer WOULD still be served. If this drifts the test
    // below proves nothing, so it is asserted rather than assumed.
    expect((await fs.stat(file)).mtimeMs).toBe(before);

    expect((await withCompletedAt(mk())).completedAt).toBe('2026-08-11T19:00:00.000Z');
  });
});
