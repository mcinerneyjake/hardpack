import { describe, it, expect } from 'vitest';
import { cappedCreatesWarning, describeThrownRun } from './runReport.js';
import { type IntakePartial } from './loop.js';

function outcome(): IntakePartial['outcome'] {
  return { created: 0, updated: 0, declined: 0, noProposal: false, errored: true, rejected: 0 };
}

function partial(over: Partial<IntakePartial> = {}): IntakePartial {
  return {
    runId: 'run-1',
    outcome: outcome(),
    createdIds: [],
    updatedIds: [],
    steps: 3,
    cappedCreates: 0,
    ...over,
  };
}

describe('cappedCreatesWarning', () => {
  it('names the blocked count', () => {
    expect(cappedCreatesWarning(2)).toContain('2 further create_ticket call(s) were blocked');
  });

  it('is silent when nothing was blocked', () => {
    expect(cappedCreatesWarning(0)).toBeNull();
  });

  // `<= 0` alone lets NaN through — it compares false — rendering "! NaN further …" at the operator.
  // Number.isInteger also catches the `undefined` a persisted RunRecord's optional field can supply.
  it('is silent on a count that is not a whole positive number', () => {
    const bad: number[] = [NaN, 1.5, -1];
    for (const n of bad) expect(cappedCreatesWarning(n)).toBeNull();
  });
});

describe('describeThrownRun', () => {
  it('names the ids a run wrote before it failed', () => {
    const lines = describeThrownRun(partial({ createdIds: ['tkt-a'], updatedIds: [] }));
    expect(lines.join('\n')).toContain('created ["tkt-a"]');
    expect(lines.join('\n')).toContain('run-1');
  });

  it('reports the capped-create count on the throw path, not only on the success path', () => {
    const lines = describeThrownRun(partial({ createdIds: ['tkt-a'], cappedCreates: 2 }));
    expect(lines.join('\n')).toContain('2 further create_ticket call(s) were blocked');
  });

  // `created` increments on any non-error create, but createdIds only gets a push when ticketIdOf
  // finds a JSON `id`. Tickets landing with no id captured must NOT read as "nothing landed" — that
  // is what makes the operator re-file and duplicate them.
  it('reports writes whose ids were never captured', () => {
    const lines = describeThrownRun(partial({
      createdIds: [], updatedIds: [], outcome: { ...outcome(), created: 3 },
    }));
    expect(lines.join('\n')).toContain('3 created');
    expect(lines.join('\n')).toContain('no ids were captured');
  });

  it('says nothing when a run neither wrote nor was capped', () => {
    expect(describeThrownRun(partial())).toEqual([]);
  });

  it('says nothing when the error named no run', () => {
    expect(describeThrownRun(null)).toEqual([]);
  });
});
