import { describe, it, expect } from 'vitest';
import { pipelineView } from './pipelineView.js';
import { PIPELINE_STEPS, type PipelineStep, type TicketEvent } from '../../shared/constants.js';

// Build a full canonical pipeline, overriding the given steps' states.
function build(states: Partial<Record<PipelineStep['step'], PipelineStep['state']>>): PipelineStep[] {
  return PIPELINE_STEPS.map((s) => ({
    step: s.id,
    label: s.label,
    state: states[s.id] ?? 'pending',
    at: states[s.id] ? '2026-07-01T00:00:00.000Z' : null,
  }));
}

// Display nodes are keyed by group, not raw step: typecheck/lint/test → 'gate'.
const stateOf = (v: ReturnType<typeof pipelineView>, key: string) =>
  v.nodes.find((n) => n.key === key)?.state;
const TOTAL = 8; // started, branch, gate, review, commit, pr_opened, qa, done

describe('pipelineView — grouping, status derivation, review gate', () => {
  it('collapses the gate checks and orders Review right after Gate', () => {
    const v = pipelineView(build({}), 'backlog', []);
    expect(v.nodes.map((n) => n.key)).toEqual(['started', 'branch', 'gate', 'review', 'commit', 'pr_opened', 'qa', 'done']);
    expect(v.progress.total).toBe(TOTAL);
  });

  it('treats a backlog ticket with no events as not started', () => {
    const v = pipelineView(build({}), 'backlog', []);
    expect(v.started).toBe(false);
    expect(v.current).toBeNull();
    expect(v.progress.done).toBe(0);
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('fills the Started node from status alone, even with no `started` event (#2)', () => {
    const v = pipelineView(build({}), 'in-progress', []); // no events at all
    expect(stateOf(v, 'started')).toBe('reached'); // status proves it started → green
    expect(v.current).toBe('Branch'); // next milestone
  });

  it('derives the "Implementing…" gap once branch is done and the gate has not started', () => {
    const v = pipelineView(build({ branch: 'passed' }), 'in-progress', []);
    expect(v.current).toBe('Implementing…');
    expect(stateOf(v, 'gate')).toBe('active');
    expect(v.progress.done).toBe(3); // reach = the active Gate frontier (started, branch, gate)
  });

  it('labels the phase "Gate" once any gate check has landed (partial gate)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed' }), 'in-progress', []);
    expect(v.current).toBe('Gate'); // gate started but not complete
    expect(stateOf(v, 'gate')).toBe('active');
    expect(v.progress.done).toBe(3); // reach = the active Gate frontier
  });

  it('awaits Review once the whole gate passes (the manual gate before commit)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed', lint: 'passed', test: 'passed' }), 'in-progress', []);
    expect(stateOf(v, 'gate')).toBe('passed');
    expect(stateOf(v, 'review')).toBe('active'); // frontier is Review, awaiting confirmation
    expect(v.current).toBe('Review');
    expect(v.progress.done).toBe(4); // reach = the active Review frontier
  });

  it('advances to Commit once review is confirmed', () => {
    const v = pipelineView(
      build({ branch: 'passed', typecheck: 'passed', lint: 'passed', test: 'passed', review: 'reached' }),
      'in-progress',
      [],
    );
    expect(stateOf(v, 'review')).toBe('reached');
    expect(stateOf(v, 'commit')).toBe('active');
    expect(v.current).toBe('Commit');
    expect(v.progress.done).toBe(5); // reach = the active Commit frontier
  });

  it('marks pending nodes before the furthest milestone as skipped (monotonic pipeline)', () => {
    // Gate + Review never registered, but Commit did (e.g. a docs-only ticket:
    // branch + commit, gate skipped, review never clicked).
    const v = pipelineView(build({ branch: 'passed', commit: 'passed' }), 'in-progress', []);
    expect(stateOf(v, 'gate')).toBe('skipped');
    expect(stateOf(v, 'review')).toBe('skipped');
    expect(stateOf(v, 'commit')).toBe('passed');
    expect(stateOf(v, 'pr_opened')).toBe('active'); // frontier is past commit
    // nodes AFTER the frontier stay pending, not skipped
    expect(stateOf(v, 'qa')).toBe('pending');
    expect(stateOf(v, 'done')).toBe('pending');
    // progress = furthest reach (the active PR frontier), running THROUGH the
    // skipped gate/review on the green line: started…pr = 6 of 8
    expect(v.progress.done).toBe(6);
  });

  it('stalls the Gate node and names the failing check when one fails', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed', lint: 'failed' }), 'in-progress', []);
    expect(v.failed).toBe(true);
    expect(stateOf(v, 'gate')).toBe('failed');
    expect(v.current).toBe('Lint failed'); // the specific sub-check, not just "Gate"
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  // Unattributed = outcome unknown (a failed chain, or a step that could not start): never
  // never-run, never skipped, and never an accusation of failure.
  it('shows an unattributed gate chain as outcome unknown, not as failed or never-run', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'unattributed', lint: 'unattributed', test: 'unattributed' }), 'in-progress', []);
    expect(v.failed).toBe(false);
    expect(stateOf(v, 'gate')).toBe('unattributed');
    expect(v.current).toBe('Gate: outcome unknown');
  });

  it('keeps an unattributed gate visible, never skipped, while later milestones move the frontier on', () => {
    const v = pipelineView(
      build({ branch: 'passed', typecheck: 'unattributed', lint: 'unattributed', test: 'passed', review: 'reached', commit: 'passed' }),
      'in-progress',
      [],
    );
    expect(stateOf(v, 'gate')).toBe('unattributed');
    expect(v.failed).toBe(false);
    expect(stateOf(v, 'pr_opened')).toBe('active');
    expect(v.current).toBe('PR');
  });

  it('does not flag a qa ticket as failed over a lingering unattributed step', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'unattributed', lint: 'passed', test: 'passed', commit: 'passed' }), 'qa', []);
    expect(v.failed).toBe(false);
    expect(stateOf(v, 'gate')).toBe('unattributed');
  });

  it('names the failed step over an unattributed one when both are present', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed', lint: 'failed', test: 'unattributed' }), 'in-progress', []);
    expect(stateOf(v, 'gate')).toBe('failed');
    expect(v.current).toBe('Lint failed');
  });

  it('shows a fully completed pipeline with no active node when done', () => {
    const all: Partial<Record<PipelineStep['step'], PipelineStep['state']>> = {};
    for (const s of PIPELINE_STEPS) all[s.id] = s.id === 'review' ? 'reached' : 'passed';
    const v = pipelineView(build(all), 'done', []);
    expect(v.current).toBeNull();
    expect(v.progress).toEqual({ done: TOTAL, total: TOTAL });
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });

  it('marks no active node or current label outside in-progress (qa)', () => {
    const v = pipelineView(build({ branch: 'passed' }), 'qa', []);
    expect(v.started).toBe(true);
    expect(stateOf(v, 'qa')).toBe('reached'); // status-derived
    expect(v.current).toBeNull();
    expect(v.nodes.some((n) => n.state === 'active')).toBe(false);
  });
});

describe('pipelineView — review-gate interactivity flags', () => {
  const review = (v: ReturnType<typeof pipelineView>) => {
    const n = v.nodes.find((x) => x.key === 'review');
    if (!n) throw new Error('no review node');
    return n;
  };
  const gatePassed = { branch: 'passed', typecheck: 'passed', lint: 'passed', test: 'passed' } as const;

  it('all flags false while Gate is still running (Review not yet the frontier)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed' }), 'in-progress', []);
    expect(review(v)).toMatchObject({
      state: 'pending', awaiting: false, reviewed: false, showCheck: false, clickable: false,
    });
  });

  it('awaiting + clickable + showCheck when Review is the frontier (gate passed, in-progress)', () => {
    const v = pipelineView(build(gatePassed), 'in-progress', []);
    expect(review(v)).toMatchObject({
      state: 'active', awaiting: true, reviewed: false, showCheck: true, clickable: true,
    });
  });

  it('locks once reviewed: reviewed + showCheck, but NOT awaiting and NOT clickable', () => {
    const v = pipelineView(build({ ...gatePassed, review: 'reached' }), 'in-progress', []);
    expect(review(v)).toMatchObject({
      state: 'reached', awaiting: false, reviewed: true, showCheck: true, clickable: false,
    });
  });

  it('a skipped Review shows no ✓ control and is not clickable', () => {
    const v = pipelineView(build({ branch: 'passed', commit: 'passed' }), 'in-progress', []);
    expect(review(v)).toMatchObject({
      state: 'skipped', awaiting: false, reviewed: false, showCheck: false, clickable: false,
    });
  });

  it('never clickable outside in-progress, even when reviewed (qa/done)', () => {
    const all: Partial<Record<PipelineStep['step'], PipelineStep['state']>> = {};
    for (const s of PIPELINE_STEPS) all[s.id] = s.id === 'review' ? 'reached' : 'passed';
    for (const status of ['qa', 'done'] as const) {
      const n = review(pipelineView(build(all), status, []));
      expect(n.reviewed).toBe(true);   // it WAS reviewed
      expect(n.clickable).toBe(false); // but not in-progress → not actionable
      expect(n.awaiting).toBe(false);
    }
  });

  it('leaves non-review nodes non-interactive (e.g. the active Gate frontier)', () => {
    const v = pipelineView(build({ branch: 'passed', typecheck: 'passed' }), 'in-progress', []);
    const gate = v.nodes.find((n) => n.key === 'gate');
    expect(gate?.state).toBe('active');
    expect(gate).toMatchObject({ awaiting: false, reviewed: false, showCheck: false, clickable: false });
  });
});

describe('pipelineView — archived reads the prior status off the archived event (tkt-d17d30a7b3ca)', () => {
  const archivedEvent = (detail?: string): TicketEvent => ({
    ticketId: 'tkt-000000000000', step: 'archived', state: 'reached', at: '2026-09-01T00:00:00.000Z',
    ...(detail === undefined ? {} : { detail }),
  });
  const reachedKeys = (v: ReturnType<typeof pipelineView>) =>
    v.nodes.filter((n) => n.state === 'reached' || n.state === 'passed').map((n) => n.key);

  it.each(['from todo', 'from backlog'])('does not render abandoned work archived %s as Done', (detail) => {
    const v = pipelineView(build({}), 'archived', [archivedEvent(detail)]);
    expect(reachedKeys(v)).toEqual([]);
    expect(v.started).toBe(false);
  });

  it('counts finished work archived from done as started, so the tracker renders it', () => {
    expect(pipelineView(build({}), 'archived', [archivedEvent('from done')]).started).toBe(true);
  });

  it('keeps an event-recorded milestone on abandoned work, implying nothing beyond it', () => {
    const v = pipelineView(build({ started: 'reached', branch: 'passed' }), 'archived', [archivedEvent('from todo')]);
    expect(reachedKeys(v)).toEqual(['started', 'branch']);
  });

  it.each([
    ['from done', ['started', 'qa', 'done']],
    ['from qa', ['started', 'qa']],
    ['from in-progress', ['started']],
  ])('implies the milestones of the prior status (%s)', (detail, keys) => {
    const v = pipelineView(build({}), 'archived', [archivedEvent(detail)]);
    expect(reachedKeys(v)).toEqual(keys);
  });

  it.each([
    ['no archived event', []],
    ['an archived event with no detail', [archivedEvent()]],
    ['a malformed detail', [archivedEvent('from nowhere')]],
    ['a detail naming archived itself', [archivedEvent('from archived')]],
    ['a detail with trailing text', [archivedEvent('from done, maybe')]],
  ])('implies nothing when the prior status is unknown: %s', (_label, events) => {
    const v = pipelineView(build({}), 'archived', events);
    expect(reachedKeys(v)).toEqual([]);
  });

  it('lets the last archived event in the log decide when a ticket was archived twice', () => {
    const v = pipelineView(build({}), 'archived', [archivedEvent('from done'), archivedEvent('from todo')]);
    expect(reachedKeys(v)).toEqual([]);
  });

  it('ignores an archived event once the ticket is no longer archived', () => {
    const v = pipelineView(build({}), 'todo', [archivedEvent('from done')]);
    expect(reachedKeys(v)).toEqual([]);
  });
});
