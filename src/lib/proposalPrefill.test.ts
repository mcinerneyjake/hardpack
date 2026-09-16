import { describe, it, expect } from 'vitest';
import { proposalToPrefill, proposalTargetId, droppedEnumFields, type Prefill } from './proposalPrefill.js';

describe('proposalToPrefill', () => {
  it('keeps valid fields', () => {
    expect(proposalToPrefill({ title: 'PDF bug', type: 'bug', priority: 'high', status: 'todo', body: 'repro' }))
      .toEqual({ title: 'PDF bug', type: 'bug', priority: 'high', status: 'todo', body: 'repro' });
  });

  it('drops fields with invalid enum values', () => {
    expect(proposalToPrefill({ title: 'x', type: 'banana', priority: 'critical', status: 'nope' }))
      .toEqual({ title: 'x' });
  });

  it('filters per-field — keeps valid enums alongside invalid ones', () => {
    expect(proposalToPrefill({ type: 'bug', priority: 'nope', status: 'todo' }))
      .toEqual({ type: 'bug', status: 'todo' });
  });

  it('drops non-string title / body', () => {
    expect(proposalToPrefill({ title: 123, body: { x: 1 } })).toEqual({});
  });

  it('returns {} for empty args', () => {
    expect(proposalToPrefill({})).toEqual({});
  });

  it('carries the content fields dueDate and assignee', () => {
    expect(proposalToPrefill({ title: 'X', dueDate: '2026-07-20', assignee: 'Alice' }))
      .toEqual({ title: 'X', dueDate: '2026-07-20', assignee: 'Alice' });
  });

  it('drops the structural fields project/parent/blockers (set via the modal guarded controls)', () => {
    expect(proposalToPrefill({ title: 'X', project: 'kanban', parent: 'tkt-p', blockers: ['tkt-a'] }))
      .toEqual({ title: 'X' });
  });

  it('keeps explicit null for nullable content fields (assignee/dueDate)', () => {
    expect(proposalToPrefill({ assignee: null, dueDate: null })).toEqual({ assignee: null, dueDate: null });
  });
});

describe('droppedEnumFields', () => {
  it('reports each present-but-invalid enum, in field order', () => {
    expect(droppedEnumFields({ title: 'x', type: 'banana', priority: 'critical', status: 'nope' }))
      .toEqual([
        { field: 'type', value: 'banana' },
        { field: 'priority', value: 'critical' },
        { field: 'status', value: 'nope' },
      ]);
  });

  it('reports per-field — says nothing about a valid enum alongside an invalid one', () => {
    expect(droppedEnumFields({ type: 'bug', priority: 'nope', status: 'todo' }))
      .toEqual([{ field: 'priority', value: 'nope' }]);
  });

  it('reports nothing when every present enum is valid', () => {
    expect(droppedEnumFields({ title: 'x', type: 'bug', priority: 'high', status: 'todo' })).toEqual([]);
  });

  it('reports nothing for empty args — absent was never proposed', () => {
    expect(droppedEnumFields({})).toEqual([]);
  });

  it('treats an explicitly undefined enum as absent, not as dropped', () => {
    expect(droppedEnumFields({ type: undefined, priority: undefined, status: undefined })).toEqual([]);
  });

  it('ignores the non-enum content fields entirely', () => {
    expect(droppedEnumFields({ title: 123, body: { x: 1 }, dueDate: 'nope', assignee: 7 })).toEqual([]);
  });

  it('renders a non-string proposed value in its JSON form', () => {
    expect(droppedEnumFields({ type: 123, priority: null, status: ['todo'] })).toEqual([
      { field: 'type', value: '123' },
      { field: 'priority', value: 'null' },
      { field: 'status', value: '["todo"]' },
    ]);
  });

  // F6: droppedEnumFields is exported with Record<string, unknown>, so a non-JSON value is
  // type-permitted even though the parsed tool call cannot deliver one. It must not throw —
  // a TypeError here surfaces as "the drafting agent hit an error", blaming the model.
  it('names the type instead of throwing on a value JSON cannot render', () => {
    expect(droppedEnumFields({ type: Symbol('x') })).toEqual([{ field: 'type', value: 'symbol' }]);
    expect(droppedEnumFields({ priority: () => 'x' })).toEqual([{ field: 'priority', value: 'function' }]);
    expect(droppedEnumFields({ status: 10n })).toEqual([{ field: 'status', value: 'bigint' }]);
  });

  it('keeps a 60-char value whole and truncates a 61-char one', () => {
    expect(droppedEnumFields({ type: 'a'.repeat(60) })).toEqual([{ field: 'type', value: 'a'.repeat(60) }]);
    expect(droppedEnumFields({ type: 'a'.repeat(61) })).toEqual([{ field: 'type', value: `${'a'.repeat(60)}…` }]);
  });

  // Anti-drift, both directions. Sweeps EVERY Prefill field rather than a hardcoded three: the
  // previous version compared against a literal { type, priority, status }, so a newly validated
  // enum could never appear in it and adding one left this green (tkt-a22ba10cd328, review round 1).
  // The Record type is the other half — Prefill gaining a field fails to compile until it is listed.
  it('reports a dropped enum for exactly the fields that enum-validate a string', () => {
    const PREFILL_FIELDS: Record<keyof Prefill, true> = {
      title: true, type: true, priority: true, status: true, body: true, dueDate: true, assignee: true,
    };
    // A string, so only a FINITE-valued field rejects it. That is what separates an enum field from
    // title/body (any string is valid) and from dueDate/assignee (any string is carried).
    const SENTINEL = '__not_a_valid_enum_value__';

    // Pins the sweep: without it every assertion below sits inside the loop, so an empty collection
    // would pass this test having asserted nothing (caught by scripts/probe/vacuous-ratchet).
    const fields = Object.keys(PREFILL_FIELDS);
    expect(fields).toHaveLength(7);

    for (const field of fields) {
      const enumValidated = !(field in proposalToPrefill({ [field]: SENTINEL }));
      const reported = droppedEnumFields({ [field]: SENTINEL }).some((d) => d.field === field);
      expect(reported, `${field}: enum-validated=${enumValidated} but reported=${reported}`)
        .toBe(enumValidated);
    }
  });
});

describe('proposalTargetId', () => {
  it('returns the id for an update proposal', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: { id: 'tkt-1' } })).toBe('tkt-1');
  });

  it('returns null for a create proposal', () => {
    expect(proposalTargetId({ action: 'create_ticket', args: { title: 'x' } })).toBeNull();
  });

  it('returns null for an update with no id', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: {} })).toBeNull();
  });

  it('returns null for an update with a non-string id', () => {
    expect(proposalTargetId({ action: 'update_ticket', args: { id: 123 } })).toBeNull();
  });
});
