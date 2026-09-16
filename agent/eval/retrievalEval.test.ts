import { describe, it, expect } from 'vitest';
import { DocumentIndex, type Embedder, type Document } from '../retrieval/retrieval.js';
import { evaluateRetrieval, assertRetrievalInstruments } from './retrievalEval.js';
import { POSITIVE_CONTROL, NEGATIVE_CONTROL, type GoldenPair, type GoldenSet } from './golden.js';

// Deterministic embedder: each document is a one-hot basis vector by build order, so cosine is 1 for
// the matching query and 0 otherwise — recall is exactly controllable without a runtime. A query maps
// to a target doc index, or 'uniform' (equal weight on all docs) to model a no-answer query whose best
// cosine is 1/sqrt(dim) — deliberately weak, for the negative control.
class ControlledEmbedder implements Embedder {
  constructor(private readonly dim: number, private readonly queryTargets: Map<string, number | 'uniform'>) {}
  private oneHot(i: number): number[] {
    return Array.from({ length: this.dim }, (_, j) => (j === i ? 1 : 0));
  }
  embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.resolve(texts.map((_, i) => this.oneHot(i)));
  }
  embedQuery(text: string): Promise<number[]> {
    const t = this.queryTargets.get(text);
    if (t === 'uniform') return Promise.resolve(Array.from({ length: this.dim }, () => 1));
    if (typeof t === 'number') return Promise.resolve(this.oneHot(t));
    return Promise.resolve(Array.from({ length: this.dim }, () => 0.01)); // unknown query — weak, no strong match
  }
}

function doc(id: string, i: number): Document {
  return { id, source: 'ticket', title: `title ${i}`, text: `body text for ${id} number ${i}` };
}

// A 6-doc board whose 4th entry is the real positive-control ticket, so the imported control constants
// resolve against it. Extra queryTargets override the control routing per test.
const CONTROL_ID = POSITIVE_CONTROL.expectedId;
const IDS = ['tkt-a', 'tkt-b', 'tkt-c', CONTROL_ID, 'tkt-e', 'tkt-f'];
const CONTROL_IDX = IDS.indexOf(CONTROL_ID);

function buildIndex(extraTargets: [string, number | 'uniform'][] = []): Promise<DocumentIndex> {
  const targets = new Map<string, number | 'uniform'>([
    [POSITIVE_CONTROL.query, CONTROL_IDX],       // positive control lands on its ticket → top-1
    [NEGATIVE_CONTROL.query, 'uniform'],         // negative control is weak everywhere
    ...extraTargets,
  ]);
  const embedder = new ControlledEmbedder(IDS.length, targets);
  return DocumentIndex.build(embedder, IDS.map((id, i) => doc(id, i)));
}

// The stub corpus is built around the real control constants (CONTROL_ID above), so these are the
// controls that belong to it.
const CONTROLS = { positive: POSITIVE_CONTROL, negative: NEGATIVE_CONTROL };
function goldenSet(pairs: GoldenPair[]): GoldenSet {
  return { name: 'stub', pairs, ...CONTROLS };
}

describe('assertRetrievalInstruments (loud gate — proven to go red)', () => {
  it('passes when the corpus is non-empty and both controls hold', async () => {
    await expect(assertRetrievalInstruments(await buildIndex(), [], CONTROLS)).resolves.toBeUndefined();
  });

  it('throws LOUD on an empty index rather than reporting recall over nothing', async () => {
    const empty = await DocumentIndex.build(new ControlledEmbedder(1, new Map()), []);
    await expect(assertRetrievalInstruments(empty, [], CONTROLS)).rejects.toThrow(/EMPTY/);
  });

  it('throws when the POSITIVE control does not rank top-1 (embedder miswired)', async () => {
    // Route the positive-control query to the WRONG doc → rank !== 1.
    const idx = await buildIndex([[POSITIVE_CONTROL.query, 0]]);
    await expect(assertRetrievalInstruments(idx, [], CONTROLS)).rejects.toThrow(/POSITIVE control failed/);
  });

  it('throws when the NEGATIVE control scores a confident hit (index asserts a non-existent answer)', async () => {
    // Route the no-answer query to a real doc → cosine 1.0 ≥ threshold.
    const idx = await buildIndex([[NEGATIVE_CONTROL.query, 0]]);
    await expect(assertRetrievalInstruments(idx, [], CONTROLS)).rejects.toThrow(/NEGATIVE control failed/);
  });

  it('throws when a golden anchor is ABSENT from the corpus (deleted ticket, not a retrieval miss)', async () => {
    // tkt-2597a4525562 is one of the three anchors actually deleted from the board (tkt-0a076c4d3084).
    const idx = await buildIndex();
    await expect(assertRetrievalInstruments(idx, [{ query: 'q', expectedId: 'tkt-2597a4525562' }], CONTROLS))
      .rejects.toThrow(/ABSENT from the corpus/);
  });

  // Two absent ids, one of them duplicated across pairs: the count must be 2, not 3. Without the Set
  // the dedup is invisible — the mutation that drops it leaves every other assertion green.
  it('names every absent anchor once, deduping ids repeated across pairs', async () => {
    const pairs: GoldenPair[] = [
      { query: 'present', expectedId: 'tkt-a' },
      { query: 'gone one', expectedId: 'tkt-6394577fd6af' },
      { query: 'gone one again', expectedId: 'tkt-6394577fd6af' },
      { query: 'gone two', expectedId: 'tkt-98c0ccfb2e90' },
    ];
    const idx = await buildIndex();
    await expect(assertRetrievalInstruments(idx, pairs, CONTROLS))
      .rejects.toThrow(/2 golden anchor\(s\) ABSENT.*tkt-6394577fd6af, tkt-98c0ccfb2e90/);
  });

  it('throws when the POSITIVE CONTROL ticket itself was deleted, naming it as absent', async () => {
    // Without this the deleted control reaches the rank check and reports "the embedder is broken" —
    // the misdiagnosis this gate exists to remove.
    const ids = ['tkt-a', 'tkt-b'];
    const idx = await DocumentIndex.build(
      new ControlledEmbedder(ids.length, new Map()),
      ids.map((id, i) => doc(id, i)),
    );
    await expect(assertRetrievalInstruments(idx, [], CONTROLS))
      .rejects.toThrow(new RegExp(`ABSENT from the corpus — ${POSITIVE_CONTROL.expectedId}`));
  });

  // Pins the ORDER: the anchor check must precede every embedding call, so a deleted anchor reports
  // itself instead of surfacing as an embedder timeout when the runtime is also down.
  it('reports the absent anchor without issuing any embedding query', async () => {
    class ExplodingEmbedder implements Embedder {
      embedDocuments(texts: string[]): Promise<number[][]> {
        return Promise.resolve(texts.map(() => [1]));
      }
      embedQuery(): Promise<number[]> {
        return Promise.reject(new Error('embedQuery must not be called before the anchor check'));
      }
    }
    const ids = ['tkt-a', POSITIVE_CONTROL.expectedId];
    const idx = await DocumentIndex.build(new ExplodingEmbedder(), ids.map((id, i) => doc(id, i)));
    await expect(assertRetrievalInstruments(idx, [{ query: 'q', expectedId: 'tkt-gone000000' }], CONTROLS))
      .rejects.toThrow(/ABSENT from the corpus/);
  });

  it('passes when every anchor is present, so the gate is not merely always-throwing', async () => {
    const idx = await buildIndex();
    await expect(assertRetrievalInstruments(idx, [{ query: 'q', expectedId: 'tkt-a' }], CONTROLS))
      .resolves.toBeUndefined();
  });
});

describe('evaluateRetrieval', () => {
  it('computes recall/MRR over a golden set and passes the instrument gate', async () => {
    const pairs: GoldenPair[] = [
      { query: 'find a', expectedId: 'tkt-a' },
      { query: 'find c', expectedId: 'tkt-c' },
    ];
    const idx = await buildIndex([['find a', 0], ['find c', 2]]);
    const report = await evaluateRetrieval(idx, goldenSet(pairs));
    expect(report.metrics).toMatchObject({ recallAt1: 1, recallAt5: 1, mrr: 1 });
    expect(report.results.map((r) => r.rank)).toEqual([1, 1]);
  });

  it('scores a genuine miss as recall 0 rather than hiding it', async () => {
    // The query confidently retrieves the WRONG doc (tkt-e), so the expected tkt-a is not top-1.
    const pairs: GoldenPair[] = [{ query: 'points elsewhere', expectedId: 'tkt-a' }];
    const idx = await buildIndex([['points elsewhere', 4]]);
    const report = await evaluateRetrieval(idx, goldenSet(pairs));
    expect(report.results[0].rank).not.toBe(1);
    expect(report.metrics.recallAt1).toBe(0);
  });

  it('aborts the whole eval (no metrics) when a golden anchor was deleted from the board', async () => {
    // The failure this gate exists for: without it the deleted pair scores as a miss and the run
    // reports a plausible recall number capped by the board rather than by retrieval.
    const idx = await buildIndex([['find a', 0]]);
    const pairs: GoldenPair[] = [
      { query: 'find a', expectedId: 'tkt-a' },
      { query: 'anchor was deleted', expectedId: 'tkt-2597a4525562' },
    ];
    await expect(evaluateRetrieval(idx, goldenSet(pairs))).rejects.toThrow(/ABSENT from the corpus/);
  });

  it('aborts the whole eval (no metrics) when the instrument gate throws', async () => {
    const empty = await DocumentIndex.build(new ControlledEmbedder(1, new Map()), []);
    await expect(evaluateRetrieval(empty, goldenSet([{ query: 'x', expectedId: 'tkt-a' }]))).rejects.toThrow(/EMPTY/);
  });
});
