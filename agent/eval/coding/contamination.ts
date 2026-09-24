// Memory and user-scope instructions load into every session and cannot be isolated today (the
// clean-room.mjs blocker), so a case they already describe is excluded instead.

export const CONTAMINATION_RESIDUAL =
  'Residual, not screened: a lesson from a replayed ticket paraphrased into memory or a user-scope ' +
  'instruction WITHOUT its ticket id or any distinctive identifier from its diff. The screen matches ' +
  'strings, so a paraphrase passes it and the case may measure recall rather than completion.';

// Short or generic names would match everywhere and screen out every case.
const MIN_IDENTIFIER_LENGTH = 10;
// Single words match prose: 9 of the top 25 identifier hits measured on this repo were English words.
const COMPOUND = /[a-z0-9][A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/;

const DECLARATION =
  /\b(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g;

// Compound names DECLARED on added, not removed, source lines. Callers must still drop any the base
// already carries: memory citing a pre-existing name says nothing about this case's answer.
export function distinctiveIdentifiers(goldDiff: string): string[] {
  const added = new Set<string>();
  const removed = new Set<string>();
  let inTestFile = false;
  for (const line of goldDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inTestFile = /\.test\.[a-z]+$/.test(line.trim());
      continue;
    }
    if (inTestFile || line.startsWith('+++') || line.startsWith('---')) continue;
    const target = line.startsWith('+') ? added : line.startsWith('-') ? removed : null;
    if (!target) continue;
    for (const m of line.slice(1).matchAll(DECLARATION)) target.add(m[1]);
  }
  return [...added].filter((n) => n.length >= MIN_IDENTIFIER_LENGTH && COMPOUND.test(n) && !removed.has(n)).sort();
}

export interface CorpusFile {
  path: string;
  text: string;
}

export interface ContaminationHit {
  needle: string;
  path: string;
}

export function screenContamination(
  needles: { ticketId: string; identifiers: readonly string[] },
  corpus: readonly CorpusFile[],
): ContaminationHit[] {
  const hits: ContaminationHit[] = [];
  for (const needle of [needles.ticketId, ...needles.identifiers]) {
    const re = new RegExp(`(?<![A-Za-z0-9_$])${needle.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`);
    for (const f of corpus) {
      if (re.test(f.text)) hits.push({ needle, path: f.path });
    }
  }
  return hits;
}

// Two controls, one per source: CLAUDE.md cites the known id, and the memory store must contribute.
export function assertContaminationCorpus(corpus: readonly CorpusFile[], knownPresentId: string): void {
  assertCorpusReadable(corpus, knownPresentId);
  if (!corpus.some((f) => /[/\\]memory[/\\]/.test(f.path))) {
    throw new Error('coding-eval: the contamination corpus holds NO memory file — the memory store was not read, so the screen would pass cases memory describes.');
  }
}

// A screen that read nothing would pass every case — the permissive answer to "could not check".
export function assertCorpusReadable(corpus: readonly CorpusFile[], knownPresentId: string): void {
  if (corpus.length === 0) {
    throw new Error('coding-eval: the contamination corpus is EMPTY — no memory or user-scope instruction file was read, so the screen would pass every case.');
  }
  const control = screenContamination({ ticketId: knownPresentId, identifiers: [] }, corpus);
  if (control.length === 0) {
    throw new Error(`coding-eval: contamination POSITIVE control failed — ${knownPresentId}, which the corpus is known to cite, was not found. The screen is not reading what it should.`);
  }
}
