import { describe, it, expect } from 'vitest';
import { economicsLines, acceptedCount, isRunOutcome, type RunOutcome, type EconomicsInput } from './economics.js';
import { resolveCostConfig, type CostConfig } from './costConfig.js';
import { emptyUsage, type RunUsage } from './usage.js';
import { type CostLine } from './cost.js';

const localLines = (): CostLine[] => [
  { label: 'marginal energy cost', amount: 0.01, unit: 'USD', kind: 'assumed' },
  { label: 'hardware amortization', amount: 0.04, unit: 'USD', kind: 'assumed' },
  { label: 'marginal energy', amount: 0.02, unit: 'kWh', kind: 'assumed' }, // not USD → ignored
];
const outcome = (created = 0, updated = 0): RunOutcome => ({ created, updated, declined: 0, noProposal: false, errored: false });

function run(over: Partial<EconomicsInput>): CostLine[] {
  return economicsLines({
    usage: emptyUsage(),
    outcome: outcome(),
    localCostLines: localLines(),
    reviewMs: 0,
    cfg: resolveCostConfig({}), // labor 50, manual 5, apiPrices {}
    model: 'local-model',
    ...over,
  });
}
function amt(lines: CostLine[], label: string): number | null {
  const l = lines.find((x) => x.label === label);
  if (!l) throw new Error(`no line: ${label}`);
  return l.amount;
}

describe('acceptedCount', () => {
  it('counts created + updated only', () => {
    expect(acceptedCount({ created: 2, updated: 1, declined: 3, noProposal: false, errored: true })).toBe(3);
  });

  it('does not credit a rejected write as accepted', () => {
    expect(acceptedCount({ created: 0, updated: 0, declined: 0, rejected: 2, noProposal: false, errored: false })).toBe(0);
  });
});

// `rejected` is OPTIONAL because runs.jsonl is append-only and every line written before
// tkt-354d1bdcffa9 lacks the key — requiring it would make the whole existing log unreadable.
describe('isRunOutcome', () => {
  const base = { created: 1, updated: 0, declined: 0, noProposal: false, errored: false };

  it('accepts a pre-existing record with no rejected key', () => {
    expect(isRunOutcome(base)).toBe(true);
  });

  it('accepts a record carrying a numeric rejected', () => {
    expect(isRunOutcome({ ...base, rejected: 3 })).toBe(true);
  });

  it('rejects a present-but-wrong-typed rejected rather than coercing it', () => {
    expect(isRunOutcome({ ...base, rejected: 'lots' })).toBe(false);
    expect(isRunOutcome({ ...base, rejected: null })).toBe(false);
  });

  // A count, not just a number: the sole consumer gates a warning on `> 0`, so a negative or
  // fractional value would suppress it silently instead of failing loudly.
  it('rejects a numeric rejected that is not a whole non-negative count', () => {
    expect(isRunOutcome({ ...base, rejected: -1 })).toBe(false);
    expect(isRunOutcome({ ...base, rejected: 0.5 })).toBe(false);
    expect(isRunOutcome({ ...base, rejected: NaN })).toBe(false);
    expect(isRunOutcome({ ...base, rejected: Infinity })).toBe(false);
  });

  it('still accepts zero', () => {
    expect(isRunOutcome({ ...base, rejected: 0 })).toBe(true);
  });

  it('still rejects a record missing a required field', () => {
    expect(isRunOutcome({ created: 1, updated: 0, declined: 0, noProposal: false })).toBe(false);
  });
});

describe('economicsLines', () => {
  it('reports accepted tickets as a measured count', () => {
    expect(run({ outcome: outcome(2, 1) }).find((l) => l.label === 'accepted tickets'))
      .toMatchObject({ amount: 3, unit: 'count', kind: 'measured' });
  });

  it('sums total run cost from USD local lines + review (ignoring non-USD)', () => {
    expect(amt(run({ reviewMs: 0 }), 'total run cost')).toBeCloseTo(0.05, 9); // 0.01 + 0.04; kWh ignored
  });

  it('adds review time cost = gate-open hours × labor rate', () => {
    expect(amt(run({ reviewMs: 1_800_000 }), 'review time cost')).toBeCloseTo(25, 9);   // 0.5h × $50
    expect(amt(run({ reviewMs: 1_800_000 }), 'total run cost')).toBeCloseTo(25.05, 9);
  });

  it('cost per accepted = total ÷ accepted', () => {
    expect(amt(run({ outcome: outcome(2, 0) }), 'cost per accepted ticket')).toBeCloseTo(0.025, 9); // 0.05/2
  });

  it('cost per accepted is notional with zero accepted', () => {
    expect(amt(run({ outcome: outcome(0, 0) }), 'cost per accepted ticket')).toBeNull();
  });

  it('manual value = minutes/60 × rate when accepted; 0 when nothing accepted', () => {
    expect(amt(run({ outcome: outcome(1, 0) }), 'manual value (avoided)')).toBeCloseTo((5 / 60) * 50, 9);
    expect(amt(run({ outcome: outcome(0, 0) }), 'manual value (avoided)')).toBe(0);
  });

  it('net savings = manual value − total run cost', () => {
    expect(amt(run({ outcome: outcome(1, 0), reviewMs: 0 }), 'net savings')).toBeCloseTo((5 / 60) * 50 - 0.05, 9);
  });

  it('total + derived go notional when a local cost line is notional', () => {
    const lines = run({
      localCostLines: [{ label: 'hardware amortization', amount: null, unit: 'USD', kind: 'assumed' }],
      outcome: outcome(1, 0),
    });
    expect(amt(lines, 'total run cost')).toBeNull();
    expect(amt(lines, 'cost per accepted ticket')).toBeNull();
    expect(amt(lines, 'net savings')).toBeNull();
  });

  it('cloud-equivalent + delta are notional when no price is configured', () => {
    const lines = run({ outcome: outcome(1, 0) });
    expect(lines.find((l) => l.label.startsWith('cloud-equivalent'))?.amount).toBeNull();
    expect(amt(lines, 'local vs cloud (saved)')).toBeNull();
  });

  it('computes cloud-equivalent and the local-vs-cloud delta when priced', () => {
    const cfg: CostConfig = {
      ...resolveCostConfig({}),
      apiPrices: {
        m: {
          inputPerMTok: { value: 3, unit: 'USD/Mtok', source: 't' },
          outputPerMTok: { value: 15, unit: 'USD/Mtok', source: 't' },
        },
      },
    };
    const usage: RunUsage = { ...emptyUsage(), promptTokens: 1_000_000, completionTokens: 1_000_000 };
    const lines = run({ cfg, model: 'm', usage, outcome: outcome(1, 0), reviewMs: 0 });
    expect(lines.find((l) => l.label.startsWith('cloud-equivalent'))?.amount).toBeCloseTo(18, 9); // 1×3 + 1×15
    expect(amt(lines, 'local vs cloud (saved)')).toBeCloseTo(18 - 0.05, 9); // cloud − local
  });

  it('labor-dependent lines are notional when the labor rate is unset', () => {
    const cfg: CostConfig = { ...resolveCostConfig({}), laborRate: { value: null, unit: '$/hour', source: 'unset' } };
    const lines = run({ cfg, outcome: outcome(1, 0) });
    expect(amt(lines, 'review time cost')).toBeNull();
    expect(amt(lines, 'manual value (avoided)')).toBeNull();
    expect(amt(lines, 'total run cost')).toBeNull(); // review notional → total partial
  });
});
