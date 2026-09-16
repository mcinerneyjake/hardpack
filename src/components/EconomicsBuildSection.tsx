import snapshot from '../../analysis/build-economics/hardpack-savings.json';
import { StatTile } from './EconomicsParts.js';
import { fmtInt } from '../lib/econFormat.js';

// "What did it cost to BUILD this app with Claude" — distinct from the run economics above (which meters
// the local intake agent per run). Static, aggregates-only snapshot committed at analysis/build-economics/
// (dedup + repo-scope + PR-anchor + union-supervision audited). Tokens/PRs/LOC are MEASURED (no `*`); the
// dollar cost and the by-hand savings are ASSUMED/estimated (a note → the `*` marker, matching the page).
const S = snapshot;
const usd = (n: number): string => `$${fmtInt(n)}`;
const v = S.headline.publiclyVerifiable;
const sr = S.headline.selfReported;
const est = S.headline.estimatedSavings;

export function EconomicsBuildSection() {
  return (
    <section className="econ-build">
      <h3 className="econ-group-title">Build economics — this app, made with Claude</h3>
      <p className="econ-caveat">
        What it cost to <em>build</em> this app with Claude — distinct from the run economics above, which
        meters the local intake agent. Reconstructed from Claude Code session telemetry, committed at{' '}
        <code>analysis/build-economics/</code>. As of {S.asOf}. Tokens, PRs, and LOC are measured; the dollar
        cost is the assumed cloud-equivalent at list price (self-reported, and a floor — CI usage excluded).
      </p>

      <div className="econ-tiles">
        <StatTile label="merged PRs" value={fmtInt(v.mergedPRs)} />
        <StatTile label="lines of code" value={fmtInt(v.loc)} />
        <StatTile label="supervised hours" value={`~${Math.round(v.supervisedHours)}`} />
        <StatTile label="tokens" value={`${(sr.tokens / 1e9).toFixed(1)}B`} />
        <StatTile label="billed responses" value={fmtInt(sr.billedResponses)} />
        <StatTile
          label="Claude cost"
          value={usd(sr.claudeCostUsd.completedOnly)}
          note="assumed cloud-equivalent · list price · self-reported floor (CI usage excluded)"
        />
      </div>

      <h4 className="econ-build-subtitle">Estimated vs. building by hand</h4>
      <div className="econ-tiles">
        <StatTile
          label="time saved"
          value={`${est.timeSavedHrs[0]}–${est.timeSavedHrs[1]} hrs`}
          note={`estimate · ${est.anchor.mergedPRs} PRs × ${est.anchor.hoursPerPr[0]}–${est.anchor.hoursPerPr[1]}h by hand`}
        />
        <StatTile
          label="engineering time avoided"
          value={`$${Math.round(est.valueUsdSaved[0] / 1000)}k–$${Math.round(est.valueUsdSaved[1] / 1000)}k`}
          note={`estimate · at $${est.anchor.ratePerHour}/hr`}
        />
        <StatTile
          label="return on spend"
          value={`${Math.round(est.roi[0])}–${Math.round(est.roi[1])}×`}
          note="estimate · hand cost ÷ Claude cost"
        />
      </div>
      <p className="econ-caveat">
        The by-hand side is an estimate anchored on merged PRs (git-verifiable), not ticket counts.{' '}
        {S.scope.unattributedNote}. Cross-project work excluded ({usd(S.scope.excludedLeak.cost)} leak).
      </p>
    </section>
  );
}
