import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, msUntilNextSundayEvening, stopArchiveScheduler, scheduleWeeklyArchive } from './index.js';
import { terminalRouter } from './routes/terminal.js';
import { terminalToken } from './terminalToken.js';
import * as tickets from './tickets.js';
import { closeAllStreamClients } from './stream.js';
import { resetIndexCache } from '../agent/retrieval/indexCache.js';
import { resolveEmbedConfig } from '../agent/retrieval/models.js';
import { appendRun, readRun, readRuns, type NewRunRecord } from '../agent/cost/runLog.js';
import { emptyUsage } from '../agent/cost/usage.js';
import * as econ from '../agent/cost/economicsSummary.js';
import { setupTempTicketDirs } from '../test-support/tempTicketDirs.js';
import { isTicketEventsResponse } from '../src/lib/terminalRelay.js';

const dirs = setupTempTicketDirs('kanban-index-test');

// ONE listening server for this whole file, rather than supertest's default of a fresh app.listen(0)
// PER REQUEST — ~100 of them here (tkt-8167cd23c651). That churn is the leading explanation for a
// long-standing flake: under heavy full-suite concurrency a request to /api/tickets intermittently came
// back 404, and once **401** — a status this codebase cannot emit anywhere (grepped; the app mounts no
// auth middleware and constructs no 401), which is the fingerprint of a request answered by something
// that is not this app. Reusing one bound port removes the per-request socket/fd churn entirely.
const server = app.listen(0);
afterAll(() => new Promise<void>((resolve, reject) => {
  server.close((err) => (err ? reject(err) : resolve()));
}));

async function seedTicket(id: string, title = 'Test ticket', body = '') {
  const content = [
    '---',
    `title: '${title}'`,
    "type: task",
    "priority: medium",
    "status: backlog",
    "order: 1",
    "created: '2026-01-01T00:00:00.000Z'",
    "updated: '2026-01-01T00:00:00.000Z'",
    '---',
    '',
    body,
  ].join('\n');
  await fs.writeFile(path.join(dirs.tickets, `${id}.md`), content, 'utf8');
}

describe('GET /api/tickets', () => {
  it('returns an empty board when no tickets exist', async () => {
    const res = await request(server).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tickets: [], unreadable: [], eventsSkipped: 0, eventsUnreadable: 0 });
  });

  // `res.json` accepts anything, so the compiler cannot see this envelope's shape: when
  // withCompletedAtAll started returning an object, nothing but a request-level assertion could
  // catch `tickets` becoming one level deeper (tkt-3d6039df4076).
  describe('eventsSkipped', () => {
    const seedDone = async (id: string, lines: string[]) => {
      await fs.writeFile(path.join(dirs.tickets, `${id}.md`), [
        '---', "title: 'Done one'", 'type: task', 'priority: medium', 'status: done', 'order: 1',
        "created: '2026-01-01T00:00:00.000Z'", "updated: '2026-01-01T00:00:00.000Z'", '---', '',
      ].join('\n'), 'utf8');
      await fs.writeFile(path.join(dirs.events, `${id}.jsonl`), lines.join('\n') + '\n', 'utf8');
    };

    it('reports lines lost from the logs the completion join read', async () => {
      await seedDone('tkt-damaged01', [
        'not json',
        JSON.stringify({ ticketId: 'tkt-damaged01', step: 'done', state: 'reached', at: '2026-07-01T00:00:00.000Z' }),
      ]);
      const res = await request(server).get('/api/tickets');
      expect(res.status).toBe(200);
      expect(res.body.eventsSkipped).toBe(1);
      expect(Array.isArray(res.body.tickets)).toBe(true); // not nested one level deeper
      expect(res.body.tickets[0].completedAt).toBe('2026-07-01T00:00:00.000Z');
    });

    it('reports 0 on a clean board', async () => {
      await seedDone('tkt-clean0001', [
        JSON.stringify({ ticketId: 'tkt-clean0001', step: 'done', state: 'reached', at: '2026-07-01T00:00:00.000Z' }),
      ]);
      const res = await request(server).get('/api/tickets');
      expect(res.body.eventsSkipped).toBe(0);
    });
  });

  it('returns all tickets', async () => {
    await seedTicket('abc123456789', 'First');
    await seedTicket('def123456789', 'Second');
    const res = await request(server).get('/api/tickets');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(2);
    expect(res.body.unreadable).toEqual([]);
  });

  // tkt-6cd916608a2f — a corrupt file is skipped so the board survives, but the client
  // must be told: a short array is otherwise indistinguishable from the whole board.
  describe('unreadable ticket files', () => {
    // The real trigger: a hand-edited unquoted title whose colon makes YAML read
    // "Fix the seam" as a nested mapping key.
    const UNQUOTED_COLON = '---\ntitle: Fix the seam: stale tabs\ntype: task\n---\n';

    it('serves the readable tickets and names the unreadable file', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
      await seedTicket('abc123456789', 'Good');
      await fs.writeFile(path.join(dirs.tickets, 'tkt-colon.md'), UNQUOTED_COLON, 'utf8');

      const res = await request(server).get('/api/tickets');

      expect(res.status).toBe(200); // one bad file must not 500 the board (tkt-cd9d5026c34f)
      expect(res.body.tickets.map((t: { id: string }) => t.id)).toEqual(['abc123456789']);
      expect(res.body.unreadable).toEqual([{ file: 'tkt-colon.md', reason: expect.any(String) }]);
      warn.mockRestore();
    });

    it('still reports the unreadable file on the search path', async () => {
      // Search must not re-read the board — a second read would drop the report.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
      await seedTicket('abc123456789', 'Findable');
      await fs.writeFile(path.join(dirs.tickets, 'tkt-colon.md'), UNQUOTED_COLON, 'utf8');

      const res = await request(server).get('/api/tickets?q=findable');

      expect(res.body.tickets.map((t: { id: string }) => t.id)).toEqual(['abc123456789']);
      expect(res.body.unreadable).toHaveLength(1);
      warn.mockRestore();
    });

    it('narrows the tickets by q while leaving unreadable board-wide', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => { /* silence */ });
      await seedTicket('abc123456789', 'Findable');
      await fs.writeFile(path.join(dirs.tickets, 'tkt-colon.md'), UNQUOTED_COLON, 'utf8');

      const res = await request(server).get('/api/tickets?q=nomatch');

      expect(res.body.tickets).toEqual([]);
      expect(res.body.unreadable).toHaveLength(1); // a filter must never hide it
      warn.mockRestore();
    });
  });
});

describe('GET /api/dashboard', () => {
  async function seedWithProject(id: string, project: string) {
    const content = [
      '---', `title: '${id}'`, 'type: task', 'priority: medium', 'status: todo',
      'order: 1', `project: ${project}`,
      "created: '2026-01-01T00:00:00.000Z'", "updated: '2026-01-01T00:00:00.000Z'", '---', '',
    ].join('\n');
    await fs.writeFile(path.join(dirs.tickets, `${id}.md`), content, 'utf8');
  }

  it('returns an all-zero summary for an empty board', async () => {
    const res = await request(server).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.project).toBeNull();
    expect(Array.isArray(res.body.byStatus)).toBe(true);
  });

  it('aggregates all tickets when no project is given', async () => {
    await seedTicket('abc123456789', 'First');
    await seedTicket('def123456789', 'Second');
    const res = await request(server).get('/api/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
  });

  it('scopes the summary to ?project=', async () => {
    await seedWithProject('aaaaaaaaaaaa', 'kanban');
    await seedWithProject('bbbbbbbbbbbb', 'other');
    const res = await request(server).get('/api/dashboard?project=kanban');
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.project).toBe('kanban');
  });
});

describe('GET /api/tickets/:id', () => {
  it('returns the ticket when it exists', async () => {
    await seedTicket('abc123456789', 'My ticket');
    const res = await request(server).get('/api/tickets/abc123456789');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc123456789', title: 'My ticket' });
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(server).get('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id (path traversal)', async () => {
    const res = await request(server).get('/api/tickets/..%2F..%2Fetc%2Fpasswd');
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tickets', () => {
  it('creates a ticket and returns 201 with the new ticket', async () => {
    const res = await request(server)
      .post('/api/tickets')
      .send({ title: 'New ticket', type: 'task', priority: 'medium', status: 'backlog' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'New ticket', type: 'task' });
    expect(typeof res.body.id).toBe('string');
  });

  it('returns 400 when title is missing', async () => {
    const res = await request(server).post('/api/tickets').send({ type: 'task' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('Title') });
  });

  it('returns 400 when title is an empty string', async () => {
    const res = await request(server).post('/api/tickets').send({ title: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 400 (not 500) when title is a non-string', async () => {
    const res = await request(server).post('/api/tickets').send({ title: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('title') });
  });

  it('returns 400 when project is a non-string', async () => {
    const res = await request(server).post('/api/tickets').send({ title: 'A', project: { nested: true } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('project') });
  });

  it('returns 400 when blockers is not an array of strings', async () => {
    const res = await request(server).post('/api/tickets').send({ title: 'A', blockers: 'tkt-x' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('blockers') });
  });

  it('returns 400 when creating with a non-creatable status (qa)', async () => {
    const res = await request(server).post('/api/tickets').send({ title: 'A', status: 'qa' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('status') });
  });

  it('returns 400 when creating with status archived', async () => {
    const res = await request(server).post('/api/tickets').send({ title: 'A', status: 'archived' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/tickets/:id', () => {
  it('updates an existing ticket and returns the updated body', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ title: 'Updated' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'abc123456789', title: 'Updated' });
  });

  it('returns 400 when order is not a number', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ order: 'five' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('order') });
  });

  // tkt-81b4d35e95e5 — appendBody appends non-destructively over the raw-HTTP seam
  it('appends via appendBody without overwriting the existing body', async () => {
    await seedTicket('abc123456789', 'Original', 'Seed body');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ appendBody: 'Appended' });
    expect(res.status).toBe(200);
    expect(res.body.body).toBe('Seed body\n\nAppended');
  });

  it('returns 400 when body and appendBody are sent together', async () => {
    await seedTicket('abc123456789', 'Original', 'Seed body');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ body: 'Replace', appendBody: 'Add' });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not both') });
  });

  it('returns 400 (not 500) when title is a non-string', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ title: 42 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('title') });
  });

  it('returns 400 when parent is a non-string (and does not persist it)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ parent: 99 });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('parent') });
  });

  it('returns 400 when assignee is a nested object (data-loss guard)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ assignee: { name: 'x' } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('assignee') });
  });

  it('accepts a fractional order (drag-drop midpoint)', async () => {
    await seedTicket('abc123456789', 'Original');
    const res = await request(server)
      .patch('/api/tickets/abc123456789')
      .send({ order: 1.5 });
    expect(res.status).toBe(200);
    expect(res.body.order).toBe(1.5);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(server)
      .patch('/api/tickets/zzzzzzzzzzzz')
      .send({ title: 'Ghost' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id', async () => {
    const res = await request(server)
      .patch('/api/tickets/..%2Fbad')
      .send({ title: 'x' });
    expect(res.status).toBe(400);
  });
});

describe('DELETE /api/tickets/:id', () => {
  it('deletes an existing ticket and returns 204', async () => {
    await seedTicket('abc123456789', 'To delete');
    const res = await request(server).delete('/api/tickets/abc123456789');
    expect(res.status).toBe(204);
    const check = await request(server).get('/api/tickets/abc123456789');
    expect(check.status).toBe(404);
  });

  it('returns 404 for an unknown id', async () => {
    const res = await request(server).delete('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns 400 for an invalid id', async () => {
    const res = await request(server).delete('/api/tickets/..%2Fbad');
    expect(res.status).toBe(400);
  });
});

describe('wrap error handler', () => {
  it('does not leak stack traces in the error response body', async () => {
    const res = await request(server).get('/api/tickets/zzzzzzzzzzzz');
    expect(res.status).toBe(404);
    expect(res.body).not.toHaveProperty('stack');
    expect(Object.keys(res.body)).toEqual(['error']);
  });
});

// Fixed non-DST week — a DST-transition week blew past the ± bounds.
const FIXED_WEEK = new Date('2026-06-15T12:00:00'); // Monday

// day: 0=Sun, 1=Mon, ... 6=Sat
function at(day: number, hour: number): Date {
  const d = new Date(FIXED_WEEK);
  const diff = (day - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + diff);
  d.setHours(hour, 0, 0, 0);
  return d;
}

describe('msUntilNextSundayEvening', () => {
  it('Sunday before 6 PM — fires the same evening, not next week', () => {
    const now = at(0, 15); // Sunday 3 PM
    const ms = msUntilNextSundayEvening(now);
    // Should be ~3 hours, not ~7 days
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThan(4 * 60 * 60 * 1000); // < 4 hours
  });

  it('Sunday at exactly 6 PM — schedules next Sunday (already past)', () => {
    const now = at(0, 18); // Sunday 6 PM sharp
    const ms = msUntilNextSundayEvening(now);
    // target === now → 0ms; the || 7 branch schedules next Sunday
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000); // > 6 days
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000); // ≤ 7 days
  });

  it('Sunday after 6 PM — schedules next Sunday', () => {
    const now = at(0, 20); // Sunday 8 PM
    const ms = msUntilNextSundayEvening(now);
    expect(ms).toBeGreaterThan(6 * 24 * 60 * 60 * 1000);
    expect(ms).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
  });

  it('Monday — schedules 6 days out', () => {
    const now = at(1, 12); // Monday noon
    const ms = msUntilNextSundayEvening(now);
    const sixDaysMs = 6 * 24 * 60 * 60 * 1000;
    expect(ms).toBeGreaterThan(sixDaysMs - 60_000);
    expect(ms).toBeLessThan(sixDaysMs + 6 * 60 * 60 * 1000 + 60_000);
  });

  it('Saturday — schedules 1 day out', () => {
    const now = at(6, 12); // Saturday noon
    const ms = msUntilNextSundayEvening(now);
    const oneDayMs = 24 * 60 * 60 * 1000;
    expect(ms).toBeGreaterThan(oneDayMs - 60_000);
    expect(ms).toBeLessThan(oneDayMs + 6 * 60 * 60 * 1000 + 60_000);
  });

  it('always returns a positive delay', () => {
    for (let day = 0; day < 7; day++) {
      for (const hour of [0, 6, 12, 17, 18, 23]) {
        expect(msUntilNextSundayEvening(at(day, hour))).toBeGreaterThan(0);
      }
    }
  });
});

describe('stopArchiveScheduler', () => {
  it('is exported and callable with no timer running without throwing', () => {
    expect(() => stopArchiveScheduler()).not.toThrow();
  });

  it('is idempotent — calling twice does not throw', () => {
    expect(() => { stopArchiveScheduler(); stopArchiveScheduler(); }).not.toThrow();
  });

  it('calls clearTimeout exactly once when a timer is running, then becomes a no-op', () => {
    vi.useFakeTimers();
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();       // populates archiveTimer
      stopArchiveScheduler();        // should call clearTimeout and null the ref
      expect(clearSpy).toHaveBeenCalledOnce();
      stopArchiveScheduler();        // no-op: archiveTimer is now null
      expect(clearSpy).toHaveBeenCalledOnce(); // still exactly once
    } finally {
      clearSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('GET /api/tickets?q= (search)', () => {
  it('returns only matching tickets when q is set', async () => {
    await seedTicket('abc333333333', 'Fix login bug');
    await seedTicket('abc444444444', 'Add dashboard');
    const res = await request(server).get('/api/tickets?q=login');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].title).toBe('Fix login bug');
  });

  it('search is case-insensitive', async () => {
    await seedTicket('abc555555555', 'Fix Login Bug');
    const res = await request(server).get('/api/tickets?q=LOGIN');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
  });

  it('matches tickets by body content', async () => {
    await seedTicket('abc666666666', 'Unrelated title', 'The password reset flow is broken');
    await seedTicket('abc777777777', 'Another ticket', 'Nothing relevant');
    const res = await request(server).get('/api/tickets?q=password');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(1);
    expect(res.body.tickets[0].id).toBe('abc666666666');
  });

  it('returns an empty tickets array when nothing matches', async () => {
    await seedTicket('abc888888888', 'Some ticket');
    const res = await request(server).get('/api/tickets?q=xyzzy-no-match');
    expect(res.status).toBe(200);
    expect(res.body.tickets).toHaveLength(0);
  });
});

describe('GET /api/projects', () => {
  it('returns an empty array when no tickets have a project', async () => {
    await seedTicket('proj11111111', 'No project');
    const res = await request(server).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns unique project names sorted ascending', async () => {
    const raw = (id: string, project: string) =>
      fs.writeFile(
        path.join(dirs.tickets, `${id}.md`),
        [
          '---', `title: '${id}'`, 'type: task', 'priority: medium',
          'status: backlog', 'order: 1', `project: '${project}'`,
          "created: '2026-01-01T00:00:00.000Z'",
          "updated: '2026-01-01T00:00:00.000Z'", '---', '',
        ].join('\n'),
        'utf8',
      );
    await raw('projaaaaaaaa', 'zebra');
    await raw('projbbbbbbbb', 'alpha');
    await raw('projcccccccc', 'zebra');
    const res = await request(server).get('/api/projects');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['alpha', 'zebra']);
  });
});

describe('POST /api/archive', () => {
  it('returns { archived: 0 } on an empty board', async () => {
    const res = await request(server).post('/api/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 0 });
  });

  it('archives stale done tickets and returns the count', async () => {
    // A done ticket updated >3 days ago is stale; a fresh one is not.
    const write = (id: string, updated: string) =>
      fs.writeFile(
        path.join(dirs.tickets, `${id}.md`),
        [
          '---', `title: '${id}'`, 'type: task', 'priority: medium',
          'status: done', 'order: 1', `updated: '${updated}'`,
          "created: '2026-01-01T00:00:00.000Z'", '---', '',
        ].join('\n'),
        'utf8',
      );
    await write('arcstale1111', '2026-01-01T00:00:00.000Z');
    await write('arcfresh1111', new Date().toISOString());
    const res = await request(server).post('/api/archive');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ archived: 1 });

    const stale = await request(server).get('/api/tickets/arcstale1111');
    expect(stale.body.status).toBe('archived');
    const fresh = await request(server).get('/api/tickets/arcfresh1111');
    expect(fresh.body.status).toBe('done');
  });
});

describe('wrap error funnel — 500 branch', () => {
  it('maps an unexpected (non-HttpError) throw to 500 with only { error }', async () => {
    const spy = vi.spyOn(tickets, 'listProjects').mockRejectedValueOnce(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(server).get('/api/projects');
      expect(res.status).toBe(500);
      expect(Object.keys(res.body)).toEqual(['error']);
      expect(res.body).not.toHaveProperty('stack');
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.error).not.toContain('boom');
      expect(errSpy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

describe('scheduleWeeklyArchive — timer callback fires', () => {
  it('runs the archive sweep when the timer fires, then reschedules', async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(tickets, 'archiveStaleTickets').mockResolvedValue(0);
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();          // arms the first timer
      expect(sweep).not.toHaveBeenCalled();
      // advance past the max delay (≤7 days) to fire the callback
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(sweep).toHaveBeenCalled();
      stopArchiveScheduler();
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      sweep.mockRestore();
      clearSpy.mockRestore();
      stopArchiveScheduler();
      vi.useRealTimers();
    }
  });

  it('keeps the scheduler alive when a sweep rejects (error is swallowed)', async () => {
    vi.useFakeTimers();
    const sweep = vi.spyOn(tickets, 'archiveStaleTickets').mockRejectedValue(new Error('disk gone'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    try {
      scheduleWeeklyArchive();
      await vi.advanceTimersByTimeAsync(8 * 24 * 60 * 60 * 1000);
      expect(sweep).toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled();   // failure logged, not thrown
      stopArchiveScheduler();
      expect(clearSpy).toHaveBeenCalled(); // still rescheduled despite the error
    } finally {
      sweep.mockRestore();
      errSpy.mockRestore();
      clearSpy.mockRestore();
      stopArchiveScheduler();
      vi.useRealTimers();
    }
  });
});

// A REAL unreachable runtime, not a plain Error whose message merely mentions the code: undici rejects
// with a TypeError whose `cause` carries `code` (verified against node's fetch). The old fixtures used a
// bare `new Error('connect ECONNREFUSED')`, which is indistinguishable from an in-agent bug — which is
// why they passed while the controller was answering 503 for everything (tkt-a449b3ae0339).
function connectionRefused(): TypeError {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1234'), { code: 'ECONNREFUSED' }) });
}

// --- intake search route (embedder stubbed via global fetch) ---

function isEmbedReq(v: unknown): v is { input: string[] } {
  return typeof v === 'object' && v !== null && 'input' in v
    && Array.isArray(v.input) && v.input.every((s) => typeof s === 'string');
}

// RuntimeEmbedder verifies EMBED_MODEL against GET /v1/models before embedding, because the runtime
// answers 200 for an id it does not serve and silently substitutes another (tkt-01b784eb0030). A stub
// runtime that is meant to be UP must therefore serve the configured model, or the preflight — correctly —
// refuses to embed. Returns null for any other URL so each stub keeps its own chat/embeddings handling.
function modelsReply(url: string): Response | null {
  if (!url.endsWith('/models')) return null;
  const body = JSON.stringify({ data: [{ id: resolveEmbedConfig().model }] });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('POST /api/intake/search', () => {
  // "login" inputs align with a "login" query — deterministic, no real model.
  function stubEmbeddings(): void {
    vi.stubGlobal('fetch', vi.fn((url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const models = modelsReply(String(url));
      if (models) return Promise.resolve(models);
      const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
      const input = isEmbedReq(parsed) ? parsed.input : [];
      const data = input.map((s, i) => ({ index: i, embedding: [s.toLowerCase().includes('login') ? 1 : 0, 1] }));
      return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }

  beforeEach(() => { resetIndexCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('400 when query is missing', async () => {
    const res = await request(server).post('/api/intake/search').send({});
    expect(res.status).toBe(400);
  });

  it('returns results ranked by semantic similarity, with status', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    await seedTicket('tkt-bbb', 'Add dashboard charts');
    stubEmbeddings();
    const res = await request(server).post('/api/intake/search').send({ query: 'the login screen is broken' });
    expect(res.status).toBe(200);
    expect(res.body.results[0].id).toBe('tkt-aaa');
    expect(res.body.results[0].status).toBe('backlog');
  });

  it('503 when the embeddings runtime is unreachable', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(connectionRefused())));
    const res = await request(server).post('/api/intake/search').send({ query: 'x' });
    expect(res.status).toBe(503);
  });

  it('400 when the query is only whitespace', async () => {
    const res = await request(server).post('/api/intake/search').send({ query: '   ' });
    expect(res.status).toBe(400);
  });

  // Round-trip for the embed preflight's classification (tkt-01b784eb0030). The value crosses four
  // modules — retrieval.ts throws, unavailable.ts classifies, intake.ts maps to a status, asyncWrap
  // decides what is logged and what reaches the wire — and no per-layer test sees the whole path.
  // unavailable.ts's rule is that only positive evidence of a down runtime may answer "is the model
  // running?"; everything else must land on 500, where the operator-actionable text gets logged.
  describe('embed model preflight → HTTP status', () => {
    // Serves a model list that does NOT contain the configured model.
    function stubModelsServing(ids: string[], embedStatus = 200): void {
      vi.stubGlobal('fetch', vi.fn((url: string | URL | Request): Promise<Response> => {
        const u = String(url);
        if (u.endsWith('/models')) {
          return Promise.resolve(new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0] }] }), { status: embedStatus, headers: { 'content-type': 'application/json' } }));
      }));
    }

    it('500, not 503, when EMBED_MODEL is not served — and the fix reaches the log, not the wire', async () => {
      await seedTicket('tkt-aaa', 'Fix login bug');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ });
      stubModelsServing(['some-other-model']);
      const res = await request(server).post('/api/intake/search').send({ query: 'login' });
      expect(res.status).toBe(500);                       // a config fault, never "is the model running?"
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.error).not.toContain('EMBED_MODEL'); // no internals on the wire
      const logged = errSpy.mock.calls.flat().map((c) => String(c)).join(' ');
      expect(logged).toContain('Set EMBED_MODEL to one of these'); // but it IS actionable somewhere
      errSpy.mockRestore();
    });

    it('503 when the model list answers with a gateway status', async () => {
      await seedTicket('tkt-aaa', 'Fix login bug');
      vi.stubGlobal('fetch', vi.fn((url: string | URL | Request): Promise<Response> => {
        if (String(url).endsWith('/models')) return Promise.resolve(new Response('upstream gone', { status: 502 }));
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }));
      const res = await request(server).post('/api/intake/search').send({ query: 'login' });
      expect(res.status).toBe(503);
    });

    it('500 when the model list 404s — a base-URL fault must not read as a down runtime', async () => {
      await seedTicket('tkt-aaa', 'Fix login bug');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ });
      vi.stubGlobal('fetch', vi.fn((url: string | URL | Request): Promise<Response> => {
        if (String(url).endsWith('/models')) return Promise.resolve(new Response('not found', { status: 404 }));
        return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }));
      const res = await request(server).post('/api/intake/search').send({ query: 'login' });
      expect(res.status).toBe(500);
      expect(errSpy).toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('a transient list failure does not wedge the process — the next call re-probes', async () => {
      await seedTicket('tkt-aaa', 'Fix login bug');
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ });
      vi.stubGlobal('fetch', vi.fn(() => Promise.reject(connectionRefused())));
      expect((await request(server).post('/api/intake/search').send({ query: 'login' })).status).toBe(503);
      errSpy.mockRestore();
      stubEmbeddings(); // runtime comes back; the SAME shared embedder must recover
      const res = await request(server).post('/api/intake/search').send({ query: 'the login screen is broken' });
      expect(res.status).toBe(200);
    });
  });

  it('respects the limit parameter', async () => {
    await seedTicket('tkt-aaa', 'Fix login bug');
    await seedTicket('tkt-bbb', 'Another login issue');
    await seedTicket('tkt-ccc', 'Add dashboard charts');
    stubEmbeddings();
    const res = await request(server).post('/api/intake/search').send({ query: 'login', limit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(1);
  });

  it('returns an empty list for an empty board without calling the runtime', async () => {
    const res = await request(server).post('/api/intake/search').send({ query: 'anything' });
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });

  /**
   * The schema is the ONLY validation this endpoint has, and `k` reaches
   * `retrieval.search` → `.slice(0, Math.max(0, k))` unexamined. So `0` and negatives clamp to an
   * empty slice — the caller is told "no matches" about a board that matched — a fraction slices to
   * its floor, and a huge `k` returns the whole board. Out-of-range now falls back to the
   * documented default of 5, the same way a non-number already did (tkt-8585f0de3ef6 finding K).
   */
  describe('limit bounds', () => {
    const seedSix = async () => {
      for (const n of [1, 2, 3, 4, 5, 6]) await seedTicket(`tkt-lim${n}0000000`, `login issue ${n}`);
      stubEmbeddings();
    };
    const search = (limit: unknown) => request(server).post('/api/intake/search').send({ query: 'login', limit });

    it.each([
      ['zero', 0],
      ['negative', -1],
      ['a fraction', 1.5],
      ['above the bound', 10_000],
    ])('falls back to the default of 5 for %s', async (_label, limit) => {
      await seedSix();
      const res = await search(limit);
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(5);
    });

    // The control. Without it every case above would also pass a schema that ignored `limit`
    // entirely and always used 5 — the bound must reject out-of-range values, not all of them.
    it('and still honours an in-range limit', async () => {
      await seedSix();
      const res = await search(2);
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(2);
    });

    // Both ends of the range are INSIDE it. 50 is the case worth having: it is above the fallback
    // of 5, so an off-by-one that excluded it would return 5 results and look like a pass.
    it.each([[1, 1], [50, 6]])('accepts the boundary limit %i', async (limit, expected) => {
      await seedSix();
      const res = await search(limit);
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(expected);
    });

    // The documented `.catch` behaviour the bound rides on top of: a non-number is still a
    // fallback, never a 400 (server/schemas/intake.ts:6-7).
    it('and a non-number is still the documented silent fallback, not a 400', async () => {
      await seedSix();
      const res = await search('lots');
      expect(res.status).toBe(200);
      expect(res.body.results).toHaveLength(5);
    });
  });
});

describe('POST /api/intake/propose', () => {
  let runsDir: string | null = null;
  beforeAll(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-propose-runs-'));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
  });
  afterAll(async () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    if (runsDir) { await fs.rm(runsDir, { recursive: true, force: true }); runsDir = null; }
  });

  function stubProposeFlow(turns: { content: string | null; tool_calls?: unknown[] }[]): void {
    let chatTurn = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const models = modelsReply(url);
      if (models) return Promise.resolve(models);
      if (url.includes('/embeddings')) {
        const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const inputs = isEmbedReq(parsed) ? parsed.input : [];
        const data = inputs.map((_str, i) => ({ index: i, embedding: [1, 0, 0] }));
        return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      const message = turns[chatTurn] ?? { content: '(end)' };
      chatTurn++;
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }

  beforeEach(() => { resetIndexCache(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('400 when report is missing', async () => {
    const res = await request(server).post('/api/intake/propose').send({});
    expect(res.status).toBe(400);
  });

  it('returns a captured proposal without writing it', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }] },
      { content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"New bug"}' } }] },
      { content: 'Proposed creating a ticket.' },
    ]);
    const res = await request(server).post('/api/intake/propose').send({ report: 'a new bug to add' });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toMatchObject({ action: 'create_ticket', args: { title: 'New bug' } });
    expect((await tickets.listTickets()).some((t) => t.title === 'New bug')).toBe(false);
  });

  // tkt-098da79e168d: every propose spends tokens → must reach the run log even if never applied.
  it('meters a run at propose time (captured proposal → noProposal:false, 0 accepted)', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Metered draft"}' } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(server).post('/api/intake/propose').send({ report: 'a bug to add' });
    expect(res.status).toBe(200);
    const run = await readRun(res.body.runId);
    expect(run).not.toBeNull();
    expect(run?.usage.totalTokens).toBeGreaterThan(0); // the spend is recorded
    expect(run?.outcome).toMatchObject({ created: 0, updated: 0, noProposal: false }); // proposed, not yet applied
    expect(run?.ticketIds).toEqual({ created: [], updated: [] });
    expect(run?.cappedCreates).toBe(0);
  });

  // tkt-9f09b3a1e95c round-trip (indexCache → controller → meterRun → runLog): the run record
  // counted CHAT calls only, so a draft whose embed burst dominated wall-clock logged ~32s of a
  // ~111s run. Both kinds must survive persist → read-back, or the economics under-report ~3.5×.
  it('records BOTH chat and embed calls in the run trace (not chat only)', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }] },
      { content: 'Nothing to do.' },
    ]);
    const res = await request(server).post('/api/intake/propose').send({ report: 'a report' });
    expect(res.status).toBe(200);

    const run = await readRun(res.body.runId);
    const trace = run?.usage.callTrace ?? [];
    expect(trace.some((c) => c.kind === 'chat')).toBe(true);
    // The embed entry must be the agent's search_board QUERY embed, carrying its text. A bare
    // `some(kind === 'embed')` would also pass on an unrelated document embed, so this pins the
    // per-run marginal cost the controller is supposed to attribute.
    const embeds = trace.filter((c) => c.kind === 'embed');
    expect(embeds).toHaveLength(1);
    expect(embeds[0].inputChars).toBeGreaterThan(0);
    // The trace must reconcile with the scalar totals it is a breakdown of.
    expect(trace).toHaveLength(run?.usage.calls ?? -1);
    expect(trace.reduce((sum, c) => sum + c.ms, 0)).toBe(run?.usage.activeMs);
  });

  // The index build is SHARED (getTicketIndex coalesces concurrent callers), so it must never be
  // billed to a run — otherwise two simultaneous drafts each record the whole burst.
  it('does not charge a run for the shared index build', async () => {
    await seedTicket('tkt-bbb', 'A ticket whose text nothing has embedded yet');
    resetIndexCache(); // force a real document-embedding build inside this request
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"anything"}' } }] },
      { content: 'Done.' },
    ]);
    const res = await request(server).post('/api/intake/propose').send({ report: 'a report' });
    expect(res.status).toBe(200);

    const run = await readRun(res.body.runId);
    // Exactly the one query embed — not the build's document batches.
    expect((run?.usage.callTrace ?? []).filter((c) => c.kind === 'embed')).toHaveLength(1);
  });

  it('meters a no-proposal run (agent only searched → noProposal:true)', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    stubProposeFlow([
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }] },
      { content: 'Nothing relevant; no action taken.' },
    ]);
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.proposal).toBeNull();
    const run = await readRun(res.body.runId);
    expect(run?.outcome.noProposal).toBe(true);
    expect(run?.usage.totalTokens).toBeGreaterThan(0);
  });

  it('503 when the runtime is unreachable', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(connectionRefused())));
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(503);
  });

  it('400 when the report is only whitespace', async () => {
    const res = await request(server).post('/api/intake/propose').send({ report: '   ' });
    expect(res.status).toBe(400);
  });

  // Chat-only failures, with the embedder up. These two are the whole point of tkt-a449b3ae0339: the
  // status now depends on whether the failure is EVIDENCE about reachability, not on where it happened.
  const chatFails = (rejection: unknown) => {
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const models = modelsReply(url);
      if (models) return Promise.resolve(models);
      if (url.includes('/embeddings')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(rejection); // /chat/completions fails
    }));
  };

  it('503 when the chat endpoint is genuinely unreachable even though the embedder is up', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    chatFails(connectionRefused());
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(503);
  });

  // This case ASSERTED 503 before the fix, and that assertion was the defect: an opaque error carries no
  // evidence the runtime is down, so answering 503 told the user to enter the ticket manually and lost
  // the fault. It is now a 500 whose detail goes to the server log and never onto the wire.
  it('500, not 503, when the chat call fails opaquely — and the detail stays server-side', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ });
    chatFails(new Error('tool loop blew up: cannot read properties of undefined'));
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('tool loop'); // no internals on the wire
    expect(errSpy).toHaveBeenCalled();                 // but it IS reported somewhere
    errSpy.mockRestore();
  });

  // tkt-3953c78cffe7: the controller's own comment says a propose that is never applied must still
  // reach the run log — but meterIntakeRun sat AFTER the loop, so a throw skipped it and the spend
  // reached nothing at all. The two status tests above are the controls: they pin that the fault
  // still propagates with the same classification, so this cannot be satisfied by swallowing it.
  it('meters a run whose loop throws part way through, and still reports the fault', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => { /* silence */ });
    let chatTurn = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const models = modelsReply(url);
      if (models) return Promise.resolve(models);
      if (url.includes('/embeddings')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      chatTurn++;
      // Turn 1 spends tokens on a real search_board call; turn 2 dies opaquely (a 500, not a 503 —
      // an opaque fault carries no evidence the runtime is down).
      if (chatTurn === 1) {
        const message = { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_board', arguments: '{"query":"login"}' } }] };
        return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.reject(new Error('the loop blew up mid-run'));
    }));

    const before = (await readRuns()).length;
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(500);                       // the fault still surfaces
    expect(res.body.error).toBe('Internal server error');

    const after = await readRuns();
    expect(after).toHaveLength(before + 1);             // ...and the spend was NOT lost with it
    const run = after[after.length - 1];
    expect(run.outcome.errored).toBe(true);
    expect(run.usage.totalTokens).toBeGreaterThan(0);
    expect(run.ticketIds).toEqual({ created: [], updated: [] });
    errSpy.mockRestore();
  });

  it('503 when the runtime answers with a gateway status', async () => {
    await seedTicket('tkt-aaa', 'Existing login bug');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const models = modelsReply(url);
      if (models) return Promise.resolve(models);
      if (url.includes('/embeddings')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ index: 0, embedding: [1, 0, 0] }] }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      return Promise.resolve(new Response('upstream gone', { status: 502 }));
    }));
    const res = await request(server).post('/api/intake/propose').send({ report: 'x' });
    expect(res.status).toBe(503);
  });
});

describe('POST /api/intake/apply', () => {
  let runsDir: string | null = null;
  beforeAll(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-apply-runs-'));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
  });
  afterAll(async () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    if (runsDir) { await fs.rm(runsDir, { recursive: true, force: true }); runsDir = null; }
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  function stubProposeFlow(turns: { content: string | null; tool_calls?: unknown[] }[]): void {
    let turn = 0;
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      const models = modelsReply(url);
      if (models) return Promise.resolve(models);
      if (url.includes('/embeddings')) {
        const parsed: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
        const inputs = isEmbedReq(parsed) ? parsed.input : [];
        return Promise.resolve(new Response(JSON.stringify({ data: inputs.map((_s, i) => ({ index: i, embedding: [1, 0, 0] })) }), { status: 200, headers: { 'content-type': 'application/json' } }));
      }
      const message = turns[turn] ?? { content: '(end)' };
      turn++;
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 15, completion_tokens: 5, total_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    }));
  }
  async function proposeRunId(report: string, turns: { content: string | null; tool_calls?: unknown[] }[]): Promise<string> {
    stubProposeFlow(turns);
    const res = await request(server).post('/api/intake/propose').send({ report });
    expect(res.status).toBe(200);
    vi.unstubAllGlobals(); // apply never calls the model
    return res.body.runId;
  }

  // B + A (create): a proposed→applied create stamps source:'assisted' + runId and records economics.
  it('create: stamps assisted + runId and records the run', async () => {
    const runId = await proposeRunId('a metered bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Metered bug"}' } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(server).post('/api/intake/apply')
      .send({ action: 'create_ticket', runId, args: { title: 'Metered bug' } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: 'assisted', runId, title: 'Metered bug' });
    const run = await readRun(runId);
    expect(run?.ticketIds.created).toContain(res.body.id);
    expect(run?.outcome.created).toBe(1);
    expect(run?.usage.totalTokens).toBeGreaterThan(0);
  });

  // tkt-098da79e168d seam invariant: two append-only records share one runId; rollup dedupes last-wins → counted once.
  it('propose→apply meters one run in the rollup despite two log records (seam)', async () => {
    const runId = await proposeRunId('a seam bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Seam"}' } }] },
      { content: 'Proposed.' },
    ]);
    const applyRes = await request(server).post('/api/intake/apply')
      .send({ action: 'create_ticket', runId, args: { title: 'Seam' } });
    expect(applyRes.status).toBe(201);

    const dupes = (await readRuns()).filter((r) => r.runId === runId);
    expect(dupes).toHaveLength(2); // propose record + apply record, same runId
    const [first, second] = dupes;
    expect(first?.usage.totalTokens).toBe(second?.usage.totalTokens); // apply reuses the captured usage
    expect(second?.usage.totalTokens).toBeGreaterThan(0);

    const s = econ.summarizeEconomics(dupes);
    expect(s.runs).toBe(1); // counted once, not twice
    expect(s.totals.totalTokens).toBe(second?.usage.totalTokens); // tokens not doubled
    expect(s.totals.acceptedTickets).toBe(1); // the apply record's outcome wins
    // readRun (the ?runId detail view) agrees — last-wins keeps the enriched apply record.
    expect((await readRun(runId))?.ticketIds.created).toContain(applyRes.body.id);
  });

  it('an abandoned propose is metered with its spend and 0 accepted', async () => {
    const runId = await proposeRunId('an abandoned draft', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Abandoned"}' } }] },
      { content: 'Proposed.' },
    ]);
    // No apply — the user closed the modal.
    const solo = (await readRuns()).filter((r) => r.runId === runId);
    expect(solo).toHaveLength(1);
    const s = econ.summarizeEconomics(solo);
    expect(s.totals.totalTokens).toBeGreaterThan(0); // spend recorded
    expect(s.totals.acceptedTickets).toBe(0); // but nothing accepted
  });

  // Seam fidelity: drive the full content field set through propose→apply; every field lands == input.
  it('create: every proposed content field survives the apply boundary (fidelity)', async () => {
    const args = {
      title: 'Full fidelity', body: 'repro steps here', type: 'bug',
      priority: 'high', status: 'todo', assignee: 'Alice', dueDate: '2026-07-20',
    };
    const runId = await proposeRunId('a fully specified bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: JSON.stringify(args) } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(server).post('/api/intake/apply').send({ action: 'create_ticket', runId, args });
    expect(res.status).toBe(201);
    // source-input == persisted-output across every field the agent proposed.
    expect(res.body).toMatchObject({ ...args, source: 'assisted', runId });
  });

  // Idempotency: a replayed apply with the same runId returns the same ticket — no duplicate, no double-meter.
  it('is idempotent on runId — a replay returns the same ticket, no duplicate', async () => {
    const runId = await proposeRunId('idempotent bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Idem"}' } }] },
      { content: 'Proposed.' },
    ]);
    const first = await request(server).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Idem' } });
    const second = await request(server).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Idem' } });
    expect(first.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect((await tickets.listTickets()).filter((t) => t.title === 'Idem')).toHaveLength(1);
  });

  // Replay after the applied ticket was deleted: a benign retry acknowledges (200), not 404.
  it('replay after the ticket was deleted → 200 ack, not 404', async () => {
    const runId = await proposeRunId('deletable bug', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'create_ticket', arguments: '{"title":"Deletable"}' } }] },
      { content: 'Proposed.' },
    ]);
    const first = await request(server).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Deletable' } });
    expect(first.status).toBe(201);
    await request(server).delete(`/api/tickets/${first.body.id}`).expect(204);
    const replay = await request(server).post('/api/intake/apply').send({ action: 'create_ticket', runId, args: { title: 'Deletable' } });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ id: first.body.id, deleted: true });
  });

  // B (update): an assisted update threads the runId but leaves authorship (source) unchanged.
  it('update: threads the runId but does not reassign authorship', async () => {
    await seedTicket('tkt-upd12345678', 'Original'); // human-seeded → source null
    const runId = await proposeRunId('update the login ticket', [
      { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'update_ticket', arguments: '{"id":"tkt-upd12345678","title":"Updated"}' } }] },
      { content: 'Proposed.' },
    ]);
    const res = await request(server).post('/api/intake/apply')
      .send({ action: 'update_ticket', runId, args: { id: 'tkt-upd12345678', title: 'Updated' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: 'tkt-upd12345678', title: 'Updated', runId });
    expect(res.body.source).toBeNull();
    expect(await readRun(runId)).not.toBeNull();
  });

  it('update with a missing id → 400 (not a silent create)', async () => {
    const res = await request(server).post('/api/intake/apply')
      .send({ action: 'update_ticket', runId: 'run-x', args: { title: 'No id' } });
    expect(res.status).toBe(400);
  });

  // An apply whose runId has no captured usage falls back to a plain human write — no provenance, no run.
  it('applies with an unknown runId — plain write (no provenance, no run)', async () => {
    const res = await request(server).post('/api/intake/apply')
      .send({ action: 'create_ticket', runId: 'run-orphan', args: { title: 'Orphan' } });
    expect(res.status).toBe(201);
    expect(res.body.source).toBeNull();
    expect(res.body.runId).toBeNull();
    expect(await readRun('run-orphan')).toBeNull();
  });

  /**
   * `args` was an open record, so anything the client sent was carried to the service and silently
   * dropped there. The set is now closed to the keys the apply path actually reads: `id` (read by
   * apply itself, for the update target) plus the fields `extractTicketFields` extracts. Value
   * TYPES are deliberately still the service's job — a second copy of those rules here would be the
   * hand-kept field list this slice exists to avoid (tkt-f9a2fc5604cd).
   */
  describe('args key set', () => {
    it.each(['order', 'source', 'created', 'id ', '__proto__'])(
      'rejects the unknown key %j with a 400, before the ticket service runs',
      async (key) => {
        const before = (await tickets.listTickets()).length;
        const res = await request(server).post('/api/intake/apply')
          .send({ action: 'create_ticket', runId: 'run-strict', args: { title: 'Strict', [key]: 'x' } });
        expect(res.status).toBe(400);
        // The write not landing is the point; a 400 that still created the ticket passes the line above.
        expect((await tickets.listTickets()).length).toBe(before);
      },
    );

    /**
     * The control: every key the apply path reads must still be accepted, or the tightening has
     * broken the endpoint rather than bounded it. `appendBody` is update-only and `id` is read by
     * apply itself. Neither is simply ignored on create: `id` is dropped silently, and `appendBody`
     * is TYPE-checked and then dropped, so a non-string 400s a metered create (tkt-5171e5aa3379).
     * Both still belong in the key set — that defect is in the controller, not here. Two calls
     * because the service rejects `body` and `appendBody` TOGETHER (replace vs append) — sending
     * both in one request would 400 for a reason that has nothing to do with the key set.
     */
    it('accepts every key the apply path reads', async () => {
      await seedTicket('tkt-strictkey01', 'Original');
      const common = {
        id: 'tkt-strictkey01', title: 'All fields', type: 'bug', priority: 'high',
        status: 'todo', project: 'kanban', parent: null, dueDate: '2026-07-20',
        assignee: 'Alice', blockers: [],
      };
      const appended = await request(server).post('/api/intake/apply')
        .send({ action: 'update_ticket', runId: 'run-strict-ok', args: { ...common, appendBody: 'more' } });
      expect(appended.status).toBe(200);
      expect(appended.body).toMatchObject({ id: 'tkt-strictkey01', title: 'All fields', type: 'bug' });

      const replaced = await request(server).post('/api/intake/apply')
        .send({ action: 'update_ticket', runId: 'run-strict-ok-2', args: { ...common, body: 'replaced' } });
      expect(replaced.status).toBe(200);
      expect(replaced.body.body).toContain('replaced');
    });

    // Type validation stays where it was — the schema must not have absorbed it and started
    // reporting a different error for a known key with the wrong type.
    it('and leaves value-type validation to the service', async () => {
      const res = await request(server).post('/api/intake/apply')
        .send({ action: 'create_ticket', runId: 'run-strict-type', args: { title: 42 } });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('title must be a string');
    });
  });
});

describe('GET /api/intake/health', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('reports available:true when the chat runtime responds', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } }))));
    const res = await request(server).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  it('reports available:false when the runtime is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('connect ECONNREFUSED'))));
    const res = await request(server).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  it('reports available:false (still 200, never 503) when the runtime errors', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))));
    const res = await request(server).get('/api/intake/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});

describe('GET /api/tickets/:id/events', () => {
  it('returns an all-pending pipeline and no events for a never-worked ticket', async () => {
    await seedTicket('tkt-fresh');
    const res = await request(server).get('/api/tickets/tkt-fresh/events');
    expect(res.status).toBe(200);
    expect(res.body.ticketId).toBe('tkt-fresh');
    expect(res.body.events).toEqual([]);
    expect(res.body.pipeline.every((p: { state: string }) => p.state === 'pending')).toBe(true);
  });

  it('reflects a status transition emitted via the PATCH route', async () => {
    await seedTicket('tkt-work', 'Work', '');
    const patch = await request(server).patch('/api/tickets/tkt-work').send({ status: 'in-progress' });
    expect(patch.status).toBe(200);
    const res = await request(server).get('/api/tickets/tkt-work/events');
    expect(res.status).toBe(200);
    expect(res.body.events).toHaveLength(1);
    const started = res.body.pipeline.find((p: { step: string }) => p.step === 'started');
    expect(started.state).toBe('reached');
  });

  it('rejects an id that fails the path-traversal guard with 400', async () => {
    const res = await request(server).get('/api/tickets/bad.id/events');
    expect(res.status).toBe(400);
  });

  // Round-trip across the seam (tkt-355581f9dab3): a corrupt line seeded on disk must reach the
  // HTTP body as a count and survive the client's runtime guard. Per-layer tests all passed while
  // these fields were being dropped — the package returned them and hardpack's type never declared them.
  //
  // Each case pairs a positive check with a DISCRIMINATING one. `isTicketEventsResponse(res.body)`
  // alone is inert: the body already carries both counts, so it passes against the old loose guard
  // too. Stripping a count from the real body is what fails if the guard is ever re-loosened.
  describe('lost-line counts survive service → HTTP → client guard', () => {
    const seedEvents = (id: string, lines: string[]) =>
      fs.writeFile(path.join(dirs.events, `${id}.jsonl`), `${lines.join('\n')}\n`, 'utf8');

    const good = (id: string, step: string) =>
      JSON.stringify({ ticketId: id, step, state: 'passed', at: '2026-07-01T00:00:00.000Z' });

    it('reports lost lines as skipped, and the client guard accepts the payload', async () => {
      await seedTicket('tkt-damaged');
      await seedEvents('tkt-damaged', ['not json at all', good('tkt-damaged', 'lint'), '{"torn']);
      const res = await request(server).get('/api/tickets/tkt-damaged/events');
      expect(res.status).toBe(200);
      expect(res.body.skipped).toBe(2);
      expect(res.body.unrecognized).toBe(0);
      expect(isTicketEventsResponse(res.body)).toBe(true);
      // Discriminating: a real body minus a count must be REJECTED. Without this, the guard could
      // be re-loosened to three fields and every assertion here would stay green.
      expect(isTicketEventsResponse({ ...res.body, skipped: undefined })).toBe(false);
      expect(isTicketEventsResponse({ ...res.body, unrecognized: undefined })).toBe(false);
    });

    // The half that would have shipped as a false positive: a newer machine-wide hook writing a
    // step id this pin doesn't know is skew, not loss.
    it('reports a newer writer as unrecognized, NOT as lost history', async () => {
      await seedTicket('tkt-skewed');
      await seedEvents('tkt-skewed', [
        good('tkt-skewed', 'lint'),
        JSON.stringify({ ticketId: 'tkt-skewed', step: 'deploy', state: 'passed', at: '2026-07-01T00:00:00.000Z' }),
      ]);
      const res = await request(server).get('/api/tickets/tkt-skewed/events');
      expect(res.body.unrecognized).toBe(1);
      expect(res.body.skipped).toBe(0);
      expect(isTicketEventsResponse(res.body)).toBe(true);
    });

    // The control: without it, a body hard-coding zeros would satisfy both cases above.
    it('reports 0/0 for a clean log, and the fields are present rather than absent', async () => {
      await seedTicket('tkt-healthy');
      await seedEvents('tkt-healthy', [good('tkt-healthy', 'lint'), good('tkt-healthy', 'commit')]);
      const res = await request(server).get('/api/tickets/tkt-healthy/events');
      expect(res.body.skipped).toBe(0);
      expect(res.body.unrecognized).toBe(0);
      expect(Object.keys(res.body)).toContain('skipped');
      expect(Object.keys(res.body)).toContain('unrecognized');
      expect(res.body.events).toHaveLength(2);
    });
  });
});

describe('POST /api/tickets/:id/review', () => {
  const reviewState = (body: { pipeline: { step: string; state: string }[] }) =>
    body.pipeline.find((p) => p.step === 'review')?.state;

  it('marks review reached and returns the updated pipeline', async () => {
    await seedTicket('tkt-rev');
    const res = await request(server).post('/api/tickets/tkt-rev/review').send({ reviewed: true });
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('reached');
  });

  it('un-reviews with { reviewed: false }, reverting review to pending', async () => {
    await seedTicket('tkt-rev');
    await request(server).post('/api/tickets/tkt-rev/review').send({ reviewed: true });
    const res = await request(server).post('/api/tickets/tkt-rev/review').send({ reviewed: false });
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('pending');
    // both actions are retained in the append-only log
    expect(res.body.events.filter((e: { step: string }) => e.step === 'review')).toHaveLength(2);
  });

  it('defaults to reviewed when no body is sent', async () => {
    await seedTicket('tkt-rev');
    const res = await request(server).post('/api/tickets/tkt-rev/review');
    expect(res.status).toBe(200);
    expect(reviewState(res.body)).toBe('reached');
  });

  it('rejects an invalid id with 400', async () => {
    const res = await request(server).post('/api/tickets/bad.id/review').send({ reviewed: true });
    expect(res.status).toBe(400);
  });

  it('rejects a well-formed id for a nonexistent ticket with 404 and writes no event file', async () => {
    const res = await request(server).post('/api/tickets/tkt-ghost99999999/review').send({ reviewed: true });
    expect(res.status).toBe(404);
    // the orphan events/<id>.jsonl must never have been created
    const files = await fs.readdir(dirs.events);
    expect(files.some((f) => f.includes('tkt-ghost99999999'))).toBe(false);
  });
});

describe('malformed JSON body', () => {
  it('returns a 400 { error } on the JSON contract, not the default HTML error page', async () => {
    const res = await request(server)
      .post('/api/tickets')
      .set('Content-Type', 'application/json')
      .send('{ "title": '); // truncated → express.json throws a SyntaxError
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toHaveProperty('error');
  });
});

// The edge contract for a path no router matched, and the banner Express sends by default.
// Both are app-wide: they hold for every request that reaches the stack, not per route (tkt-f9a2fc5604cd).
describe('Express edge: unmatched paths and the x-powered-by banner', () => {
  // Express's built-in finalhandler answers an unmatched path with an HTML page, so every client
  // that parses { error } gets a parse failure instead of the message. The three cases are
  // deliberately different shapes: under a mounted router, under the /api prefix, and outside it.
  it.each([
    ['get', '/api/intake/not-a-real-endpoint'],
    ['get', '/api/this-route-does-not-exist'],
    ['get', '/not-even-under-api'],
  ] as const)('%s %s → 404 on the JSON { error } contract', async (method, route) => {
    const res = await request(server)[method](route);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  // A wrong METHOD on a real path is the same miss — the router declines it and it falls through.
  it('a real path with no handler for the method → the same JSON 404', async () => {
    const res = await request(server).post('/api/dashboard');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  // The status assertions are the control: "header absent" would also pass against a request that
  // never reached the app, so each case pins the response it is reading the headers off.
  it('no response carries x-powered-by — on a match, a miss, or an error', async () => {
    const ok = await request(server).get('/api/tickets');
    expect(ok.status).toBe(200);
    expect(ok.headers['x-powered-by']).toBeUndefined();

    const miss = await request(server).get('/api/this-route-does-not-exist');
    expect(miss.status).toBe(404);
    expect(miss.headers['x-powered-by']).toBeUndefined();

    const bad = await request(server).post('/api/tickets').set('Content-Type', 'application/json').send('{ "title": ');
    expect(bad.status).toBe(400);
    expect(bad.headers['x-powered-by']).toBeUndefined();
  });

  // The 404 must not shadow a route that matched and then threw. NOTE it does NOT pin the
  // 404-vs-errorHandler ordering, though it reads like it should: wrap() catches the rejection and
  // calls sendError itself, never next(err), so this stays green with errorHandler deleted
  // (measured). The next(err) path — and thus the ordering — is pinned by 'malformed JSON body'.
  it('and it does not swallow an error raised by a matched route', async () => {
    const spy = vi.spyOn(tickets, 'listProjects').mockRejectedValueOnce(new Error('boom'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await request(server).get('/api/projects');
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ error: 'Internal server error' });
    } finally {
      spy.mockRestore();
      consoleSpy.mockRestore();
    }
  });
});

describe('GET /api/economics', () => {
  let runsDir: string;
  beforeAll(async () => {
    runsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-index-test-runs-'));
    process.env.RUNS_DIR_OVERRIDE = runsDir;
  });
  afterAll(async () => {
    delete process.env.RUNS_DIR_OVERRIDE;
    await fs.rm(runsDir, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await fs.rm(path.join(runsDir, 'runs.jsonl'), { force: true });
  });

  const rec = (runId: string, at: string): NewRunRecord => ({
    runId, at, model: 'test', usage: emptyUsage(),
    outcome: { created: 1, updated: 0, declined: 0, noProposal: false, errored: false },
    reviewMs: 0,
    cost: {
      measured: [], externalities: [], headline: [{ label: 'cost per accepted ticket', amount: 0.02, unit: 'USD', kind: 'assumed' }],
      assumed: [{ label: 'total run cost', amount: 0.02, unit: 'USD', kind: 'assumed' }],
    },
    ticketIds: { created: ['tkt-x'], updated: [] },
    cappedCreates: 0,
  });

  it('returns an aggregate summary over the run log', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(server).get('/api/economics');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(2);
    expect(res.body.totals.acceptedTickets).toBe(2);
    expect(res.body.timeSeries).toHaveLength(2);
  });

  it('returns zeros for an empty run log', async () => {
    const res = await request(server).get('/api/economics');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(0);
  });

  it('filters by ?from/?to (bare dates → inclusive day bounds)', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-05T10:00:00.000Z'));
    const res = await request(server).get('/api/economics?from=2026-07-04&to=2026-07-06');
    expect(res.body.runs).toBe(1);
  });

  it('returns a single run for ?runId=', async () => {
    await appendRun(rec('run-1', '2026-07-01T10:00:00.000Z'));
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(server).get('/api/economics?runId=run-2');
    expect(res.status).toBe(200);
    expect(res.body.runs).toBe(1);
  });

  it('enriches the single-run payload with identity + authored ticket ids', async () => {
    await appendRun(rec('run-2', '2026-07-02T10:00:00.000Z'));
    const res = await request(server).get('/api/economics?runId=run-2');
    expect(res.status).toBe(200);
    // The aggregate rollup drops these; the detail payload carries them.
    expect(res.body.runId).toBe('run-2');
    expect(res.body.model).toBe('test');
    expect(res.body.at).toBe('2026-07-02T10:00:00.000Z');
    expect(res.body.ticketIds).toEqual({ created: ['tkt-x'], updated: [] });
  });

  it('404s for an unknown runId', async () => {
    const res = await request(server).get('/api/economics?runId=nope');
    expect(res.status).toBe(404);
  });

  it('maps a non-HttpError from the service to 500 (wrap)', async () => {
    const spy = vi.spyOn(econ, 'summarizeEconomicsFromLog').mockRejectedValueOnce(new Error('boom'));
    const res = await request(server).get('/api/economics');
    expect(res.status).toBe(500);
    spy.mockRestore();
  });
});

// The router is mounted on the real app only when KANBAN_TERMINAL=1 (read at import time), so these
// mount it directly — the route's own gate is what's under test, not app.ts's env switch.
describe('GET /api/terminal/token (host gate, tkt-b6eb52013662)', () => {
  const terminalApp = express().use('/api', terminalRouter);

  it('serves the token to a loopback Host', async () => {
    const res = await request(terminalApp).get('/api/terminal/token').set('Host', '127.0.0.1:3001');
    expect(res.status).toBe(200);
    expect(res.body.token).toEqual(expect.any(String));
    expect(res.body.token.length).toBeGreaterThan(0);
  });

  it('still serves it under a shifted KANBAN_PORT_OFFSET port', async () => {
    const res = await request(terminalApp).get('/api/terminal/token').set('Host', 'localhost:5223');
    expect(res.status).toBe(200);
  });

  it('rejects a rebound foreign Host without leaking the token', async () => {
    const res = await request(terminalApp).get('/api/terminal/token').set('Host', 'evil.com');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden host' });
    expect(JSON.stringify(res.body)).not.toContain(terminalToken());
  });

  it('rejects a foreign Host that merely embeds a loopback name', async () => {
    const res = await request(terminalApp).get('/api/terminal/token').set('Host', 'localhost.evil.com');
    expect(res.status).toBe(403);
  });
});

// A DNS-rebound page is SAME-ORIGIN to the browser: the loopback bind is irrelevant (the browser is
// on loopback) and no origin check is ever consulted. The Host header is the one thing that still
// carries the name the browser dialled. The terminal token route has checked it since
// tkt-b6eb52013662; nothing else did, so a rebound page had full read/write over the board and could
// burn metered local-LLM runs through /api/intake (tkt-fc40f49495c1).
//
// SCOPE, so nobody reads more into it: `hostGuard` is Express middleware, and the terminal WebSocket
// is handled on `server.on('upgrade')` — it never enters this stack. That path is guarded instead by
// `authorizeUpgrade`, which checks Origin; browsers always send it on an upgrade, and a rebound page
// sends its own.
describe('the Host gate covers every Express route (not the WS upgrade, which Origin guards)', () => {
  const FORGED = 'evil.com';
  const send = (method: 'get' | 'post', route: string) =>
    method === 'get' ? request(server).get(route) : request(server).post(route);

  // One route per router mounted in app.ts — a guard wired after a router protects every route
  // except the ones already handled, and nothing about the passing cases would show it.
  const ROUTES = [
    ['get', '/api/tickets'],
    ['post', '/api/tickets'],
    ['get', '/api/tickets/tkt-aaaaaaaaaaaa/events'],
    ['get', '/api/dashboard'],
    ['post', '/api/archive'],
    ['post', '/api/intake/search'],
    ['get', '/api/economics'],
    ['get', '/api/stream'],
  ] as const;

  it.each(ROUTES)('refuses %s %s from a rebound Host', async (method, route) => {
    const res = await send(method, route).set('Host', FORGED);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden host' });
  });

  /**
   * The list above cannot tell a real route from a typo: the guard is app-wide and first, so a
   * rebound `GET /api/this-does-not-exist` 403s exactly the same way, and a route later renamed
   * would leave every case green while claiming per-router coverage. So each one is dialed again
   * from an allowed Host and must be *matched* — any status but 404.
   *
   * `/api/stream` is excluded here and covered below instead: it is SSE, so a GET that succeeds
   * never ends and would hang this file rather than fail it.
   */
  it.each(ROUTES.filter(([, route]) => route !== '/api/stream'))(
    'and %s %s is a route that actually exists',
    async (method, route) => {
      const res = await send(method, route).set('Host', '127.0.0.1:3001');
      expect(res.status).not.toBe(404);
      expect(res.status).not.toBe(403);
    },
  );

  it('and the existence check can tell a real route from an invented one', async () => {
    const res = await request(server).get('/api/this-route-does-not-exist').set('Host', '127.0.0.1:3001');
    expect(res.status).toBe(404);
  });

  // The 404 catch-all is wired after every router but the Host gate is wired FIRST, so a rebound
  // page must still be refused rather than told the path does not exist. A 404 here would leak
  // which paths are real to an origin the gate exists to turn away (tkt-f9a2fc5604cd).
  it('and a rebound Host on an unmatched path is still 403, not the new 404', async () => {
    const res = await request(server).get('/api/this-route-does-not-exist').set('Host', FORGED);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden host' });
  });

  it('and /api/stream is a real SSE route, which is why it is checked apart', async () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const abort = new AbortController();
    try {
      // fetch resolves on headers, so this never waits for a stream that by design does not end.
      const res = await fetch(`http://127.0.0.1:${port}/api/stream`, { signal: abort.signal });
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
    } finally {
      abort.abort();
      closeAllStreamClients(); // an open SSE response would keep server.close() waiting in afterAll
    }
  });

  // The status is not the point — the write not landing is. A refusal that still mutated the board
  // would satisfy every assertion above.
  it('and the refused write leaves the board untouched', async () => {
    await seedTicket('tkt-hostgate01', 'Present before the attempt');
    const before = (await request(server).get('/api/tickets')).body.tickets.length;
    const res = await request(server)
      .post('/api/tickets')
      .set('Host', FORGED)
      .send({ title: 'Filed by a rebound page', type: 'task', priority: 'medium' });
    expect(res.status).toBe(403);
    expect((await request(server).get('/api/tickets')).body.tickets.length).toBe(before);
  });

  // An EMPTY Host, which is a different code path from an absent one: this fails on `new URL('http://')`
  // throwing, while a genuinely absent header (HTTP/1.0) takes the `host === undefined` branch —
  // unreachable through supertest, and covered directly in terminalAuth.test.ts.
  it('refuses a request whose Host is empty, rather than assuming the best', async () => {
    const res = await request(server).get('/api/tickets').set('Host', '');
    expect(res.status).toBe(403);
  });

  /**
   * The name a rebinding attack actually gets to choose. `*.localhost` is loopback only where the
   * resolver honours RFC 6761; where it does not, the attacker publishes it, serves the page, and
   * rebinds. `isLoopbackHost` accepts it — correctly, for a URL it containerizes — so this asserts
   * the gate's own narrower rule, at the HTTP level where it matters.
   */
  it('refuses attacker.localhost, which isLoopbackHost alone would allow', async () => {
    const res = await request(server).get('/api/tickets').set('Host', 'attacker.localhost');
    expect(res.status).toBe(403);
  });

  /**
   * `0.0.0.0` reaches loopback services in browsers that never applied the 2024 fix, and it is not a
   * name anyone's DNS has to resolve — so it is a way in that rebinding does not even need. No real
   * caller dials it: the UI dials `localhost`, the proxy dials `localhost`, curl dials whatever the
   * user typed. `isLoopbackHost` treats it as loopback for `containerizeLoopbackUrl`, where it is the
   * right answer for a URL; as a *dialled name* it is not.
   */
  it('refuses 0.0.0.0, which is a route to loopback rather than a name for it', async () => {
    const res = await request(server).get('/api/tickets').set('Host', '0.0.0.0:3001');
    expect(res.status).toBe(403);
  });

  // The control. Without it a guard that refused everything would pass every case above — and the
  // shifted port matters because KANBAN_PORT_OFFSET moves both dev ports in a worktree.
  it.each(['127.0.0.1:3001', 'localhost:5173', 'localhost', '[::1]:3001', 'localhost:5223', '127.0.0.1:3051'])(
    'and still answers the real page on Host %s',
    async (host) => {
      const res = await request(server).get('/api/tickets').set('Host', host);
      expect(res.status).toBe(200);
    },
  );

  /**
   * Ordering, asserted through its effect: the guard is wired before `express.json`, so an
   * oversized body from a rebound Host is refused rather than buffered and parsed. The control
   * below sends the same body from a real Host and requires the 413 — without it this passes for
   * any body size at all, including one the parser never objected to.
   */
  describe('and refuses before the body is parsed', () => {
    const oversized = { title: 'x'.repeat(300_000), type: 'task', priority: 'medium' };

    it('403s the oversized body rather than 413ing it', async () => {
      const res = await request(server).post('/api/tickets').set('Host', FORGED).send(oversized);
      expect(res.status).toBe(403);
    });

    it('and that body really is one the parser would have rejected', async () => {
      const res = await request(server).post('/api/tickets').send(oversized);
      expect(res.status).toBe(413);
    });
  });
});

// The harness itself, asserted (tkt-8167cd23c651). Two different things are checked, because either
// alone is weak: the runtime invariant that one bound port serves every request, and a source check
// that no call site has drifted back to passing the app itself — which silently reintroduces the
// per-request ephemeral server this file exists to avoid. Nothing at runtime can observe that drift,
// since handing supertest the app works perfectly well; it just brings the flake back.
describe('test harness: one server per file', () => {
  // Deliberately does NOT assert the port is unchanged across requests: with a bound server supertest
  // never rebinds, so that comparison cannot fail — it passes even when written against itself
  // (checked by mutation). What IS load-bearing is that this one server stays listening and serves
  // every request; closing it turns this red.
  it('keeps one bound server listening and serving for the whole file', async () => {
    const address = server.address();
    expect(typeof address === 'object' && address !== null ? address.port : null).toBeGreaterThan(0);
    expect(server.listening).toBe(true);
    expect((await request(server).get('/api/tickets')).status).toBe(200);
    expect((await request(server).get('/api/tickets')).status).toBe(200);
  });

  it('has no per-request-server call sites left, and the detector is not vacuous', async () => {
    const source = await fs.readFile(new URL(import.meta.url), 'utf8');
    // Assembled rather than written literally: a literal would match THIS file and make the assertion
    // below impossible to satisfy — the detector would be finding itself.
    const perRequestServer = new RegExp('request' + '\\(app\\)', 'g');
    expect(source.match(perRequestServer)).toBeNull();
    expect(source).toContain('request(server)');
    // Positive control: the pattern must actually fire on the shape it looks for, or a rename would
    // leave it matching nothing anywhere and passing for the wrong reason.
    expect(['await ', 'request', '(app)', '.get("/x")'].join('').match(perRequestServer)).toHaveLength(1);
  });
});
