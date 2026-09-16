import { type RunUsage } from './usage.js';
import { type CostConfig, isSet } from './costConfig.js';
import { type CostLine, ApiPriceCostModel } from './cost.js';
import {
  LABEL_TOTAL_RUN_COST, LABEL_COST_PER_ACCEPTED, LABEL_NET_SAVINGS, LABEL_LOCAL_VS_CLOUD,
} from '../../shared/constants.js';

// Per-run cost + outcome → unit economics (cost/accepted, net savings, local-vs-cloud). Every derived line stays notional until all its inputs are available.

export interface RunOutcome {
  created: number;
  updated: number;
  declined: number;
  noProposal: boolean;
  errored: boolean;
  // Writes the SERVICE refused (invalid enum, missing title, unknown id). Optional because runs.jsonl
  // is append-only and every line written before tkt-354d1bdcffa9 lacks the key. Distinct from
  // `declined` (a human said no) and from IntakeResult.cappedCreates (blocked before reaching the
  // service) — collapsing any pair of those loses why the ticket never landed.
  rejected?: number;
}

// Accepted = created OR updated (declined / no-proposal / error are not accepted).
export function acceptedCount(o: RunOutcome): number {
  return o.created + o.updated;
}

// Cast-free validator for a persisted RunOutcome (run log reads).
export function isRunOutcome(v: unknown): v is RunOutcome {
  return typeof v === 'object' && v !== null
    && 'created' in v && typeof v.created === 'number'
    && 'updated' in v && typeof v.updated === 'number'
    && 'declined' in v && typeof v.declined === 'number'
    && 'noProposal' in v && typeof v.noProposal === 'boolean'
    && 'errored' in v && typeof v.errored === 'boolean'
    // Absent is valid (pre-tkt-354d1bdcffa9 lines); anything present must be a real count. A count is
    // the only thing this can be, and the one consumer (agent/index.ts) gates a warning on `> 0` — so
    // a hand-edited -1 or 0.5 would silently suppress that warning rather than fail loudly.
    && (!('rejected' in v)
      || (typeof v.rejected === 'number' && Number.isInteger(v.rejected) && v.rejected >= 0));
}

export interface EconomicsInput {
  usage: RunUsage;
  outcome: RunOutcome;
  /** Actual local $ lines (energy + hardware) — the cloud-equivalent is NOT included. */
  localCostLines: CostLine[];
  /** Measured HITL approval-gate-open time, ms. */
  reviewMs: number;
  cfg: CostConfig;
  model: string;
}

const MS_PER_HOUR = 3_600_000;

// Sum the USD lines; flag if any were notional so derived totals stay honest.
function sumUsd(lines: CostLine[]): { total: number; partial: boolean } {
  let total = 0;
  let partial = false;
  for (const l of lines) {
    if (l.unit !== 'USD') continue;
    if (l.amount === null) partial = true;
    else total += l.amount;
  }
  return { total, partial };
}

const usd = (label: string, amount: number | null, note?: string): CostLine =>
  ({ label, amount, unit: 'USD', kind: 'assumed', note });

export function economicsLines(input: EconomicsInput): CostLine[] {
  const { usage, outcome, localCostLines, reviewMs, cfg, model } = input;
  const accepted = acceptedCount(outcome);
  const labor = cfg.laborRate;
  const lines: CostLine[] = [];

  lines.push({ label: 'accepted tickets', amount: accepted, unit: 'count', kind: 'measured' });

  let reviewUsd: number | null = null;
  if (isSet(labor)) {
    reviewUsd = (reviewMs / MS_PER_HOUR) * labor.value;
    lines.push(usd('review time cost', reviewUsd, `${Math.round(reviewMs / 1000)}s x ${labor.value}/hr`));
  } else {
    lines.push(usd('review time cost', null, 'notional - set labor rate'));
  }

  const local = sumUsd(localCostLines);
  const totalPartial = local.partial || reviewUsd === null;
  const totalUsd = local.total + (reviewUsd ?? 0);
  lines.push(usd(LABEL_TOTAL_RUN_COST, totalPartial ? null : totalUsd,
    totalPartial ? 'notional - some cost inputs unset' : undefined));

  // Cost per ACCEPTED ticket (not per run).
  if (totalPartial) lines.push(usd(LABEL_COST_PER_ACCEPTED, null, 'notional - total cost incomplete'));
  else if (accepted === 0) lines.push(usd(LABEL_COST_PER_ACCEPTED, null, 'notional - no accepted tickets'));
  else lines.push(usd(LABEL_COST_PER_ACCEPTED, totalUsd / accepted));

  // Manual value is per REPORT: realized once when anything is accepted, NOT multiplied by ticket count.
  const manualMin = cfg.manualMinutesPerReport;
  let valueUsd: number | null = null;
  if (isSet(manualMin) && isSet(labor)) {
    valueUsd = accepted > 0 ? (manualMin.value / 60) * labor.value : 0;
    lines.push(usd('manual value (avoided)', valueUsd,
      accepted > 0 ? `${manualMin.value}min x ${labor.value}/hr` : 'no accepted ticket - nothing avoided'));
  } else {
    lines.push(usd('manual value (avoided)', null, 'notional - set manual minutes + labor rate'));
  }

  if (valueUsd !== null && !totalPartial) lines.push(usd(LABEL_NET_SAVINGS, valueUsd - totalUsd));
  else lines.push(usd(LABEL_NET_SAVINGS, null, 'notional - value or cost incomplete'));

  // Cloud-equivalent (activates the dormant price-table seam) + local-vs-cloud delta.
  const cloud = new ApiPriceCostModel(cfg.apiPrices, model).lines(usage)[0];
  lines.push(cloud);
  if (cloud.amount !== null && !totalPartial) {
    lines.push(usd(LABEL_LOCAL_VS_CLOUD, cloud.amount - totalUsd, 'cloud - local'));
  } else {
    lines.push(usd(LABEL_LOCAL_VS_CLOUD, null, 'notional - cloud or local incomplete'));
  }

  return lines;
}
