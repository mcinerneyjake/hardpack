// The on-disk shape of a coding-eval run directory, shared by the module that writes it (realDeps)
// and the one that reclaims it (retention). Side-effect free on purpose: retention is reached from
// the test suite and must not pull in realDeps, which spawns `claude` (gateIsolation.test.ts).
//
// These live here rather than as literals on both sides because a rename would otherwise make the
// prune a silent no-op that still reports success — it would look for `<case>/<newname>/repo`, find
// nothing, and print "nothing to prune" while the disk filled (tkt-217f5a6d1d54).

/** `<runDir>/<ticketId>/pristine` — the shared install every control and trial is cloned from. */
export const PRISTINE_TREE = 'pristine';
/** `<runDir>/<ticketId>/<label>/repo` — the checkout a control or session actually works in. */
export const LABEL_TREE = 'repo';
/** `<runDir>/report.json` — written only after the last case is graded, so it marks a finished run. */
export const RUN_REPORT = 'report.json';
/** `<runDir>/results.jsonl` — appended once per graded case. */
export const RUN_RESULTS = 'results.jsonl';
/** `<runDir>/<ticketId>/<label>/session.log` — the metered transcript. */
export const SESSION_LOG = 'session.log';
