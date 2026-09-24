import { describe, it, expect } from 'vitest';
import {
  assertContaminationCorpus, assertCorpusReadable, distinctiveIdentifiers, screenContamination,
} from './contamination.js';

const DIFF = [
  'diff --git a/server/lib/slots.ts b/server/lib/slots.ts',
  '--- a/server/lib/slots.ts',
  '+++ b/server/lib/slots.ts',
  '+export function releaseSlotWithToken(token: string) {',
  '+const x = 1;',
  '-export function movedHelperName() {}',
  '+export function movedHelperName() {}',
  'diff --git a/server/lib/slots.test.ts b/server/lib/slots.test.ts',
  '+const onlyInTheTestFile = 1;',
].join('\n');

describe('distinctiveIdentifiers', () => {
  it('keeps new long declared names from source files only', () => {
    expect(distinctiveIdentifiers(DIFF)).toEqual(['releaseSlotWithToken']);
  });

  it('drops a name the diff also removes — a move, which the base already carries', () => {
    expect(distinctiveIdentifiers(DIFF)).not.toContain('movedHelperName');
  });

  it('drops short names that would match everywhere', () => {
    expect(distinctiveIdentifiers(DIFF)).not.toContain('x');
  });

  it('drops single words, which match prose, and keeps camel and snake compounds', () => {
    const diff = [
      'diff --git a/a/b.ts b/a/b.ts',
      '+const provenance = 1;',
      '+class Comparison {}',
      '+const PROVISIONED = 1;',
      '+const BOARD_GOLDEN_SET = [];',
      '+function exitCodeForRun() {}',
    ].join('\n');
    expect(distinctiveIdentifiers(diff)).toEqual(['BOARD_GOLDEN_SET', 'exitCodeForRun']);
  });
});

describe('screenContamination', () => {
  const corpus = [
    { path: 'memory/a.md', text: 'see tkt-0123456789ab for the fix' },
    { path: 'memory/b.md', text: 'call releaseSlotWithToken( before exit' },
    { path: 'memory/c.md', text: 'tkt-0123456789abc is a different, longer token' },
  ];

  it('hits on the ticket id and on a distinctive identifier', () => {
    expect(screenContamination({ ticketId: 'tkt-0123456789ab', identifiers: ['releaseSlotWithToken'] }, corpus)).toEqual([
      { needle: 'tkt-0123456789ab', path: 'memory/a.md' },
      { needle: 'releaseSlotWithToken', path: 'memory/b.md' },
    ]);
  });

  it('does not hit on a longer token that merely contains the needle', () => {
    expect(screenContamination({ ticketId: 'tkt-0123456789ab', identifiers: [] }, [corpus[2]])).toEqual([]);
  });

  it('is clean when nothing matches', () => {
    expect(screenContamination({ ticketId: 'tkt-ffffffffffff', identifiers: [] }, corpus)).toEqual([]);
  });
});

describe('assertContaminationCorpus (one control per source)', () => {
  it('throws when CLAUDE.md passes the id control but no memory file was read', () => {
    expect(() => assertContaminationCorpus([{ path: '/h/.claude/CLAUDE.md', text: 'tkt-0123456789ab' }], 'tkt-0123456789ab'))
      .toThrow(/NO memory file/);
  });

  it('passes with both sources present', () => {
    expect(() => assertContaminationCorpus([
      { path: '/h/.claude/CLAUDE.md', text: 'tkt-0123456789ab' },
      { path: '/h/.claude/projects/p/memory/a.md', text: 'x' },
    ], 'tkt-0123456789ab')).not.toThrow();
  });
});

describe('assertCorpusReadable (the screen must be able to say "could not check")', () => {
  it('throws on an empty corpus', () => {
    expect(() => assertCorpusReadable([], 'tkt-0123456789ab')).toThrow(/EMPTY/);
  });

  it('throws when the known-present id is not found', () => {
    expect(() => assertCorpusReadable([{ path: 'm', text: 'nothing' }], 'tkt-0123456789ab')).toThrow(/POSITIVE control/);
  });

  it('passes when the known-present id is found', () => {
    expect(() => assertCorpusReadable([{ path: 'm', text: 'tkt-0123456789ab' }], 'tkt-0123456789ab')).not.toThrow();
  });
});
