# Build economics — what it cost (and saved) to build this with Claude

A reconstruction, from Claude Code session telemetry, of the cost and time to build the **hardpack repo
(app + `agent/` = agentic-rag-demo) + ticket-workflow** with Claude vs. by hand.

`hardpack-savings.json` is a frozen, aggregates-only snapshot (`asOf` in the file). `analyze-hardpack-savings.mjs`
is the script that produced it.

## Headline

**Publicly verifiable** (reproduce with `git` — see below):

| | |
|---|---|
| Merged PRs | **155** (154 hardpack + 1 ticket-workflow) |
| Lines of code | **26,693** |
| Supervised hours (union wall-clock) | **~110** over 29 days |
| Velocity | **~5.3 PRs/day** |

**Self-reported** (from private local session transcripts — *not* independently reproducible):

| | |
|---|---|
| Claude cost (API list price) | **~$2,485** completed-only / ~$2,559 all sessions |
| Tokens / billed responses | 3.2B / 17,628 |

**Estimated savings** — the by-hand counterfactual is anchored on **155 merged PRs × a deliberately-low
2–3 hours each** (git-verifiable unit; adjust to taste):

| | |
|---|---|
| Time saved | **~200–355 hrs (~5–9 weeks)** |
| Value (engineering time avoided @ $100/hr) | **~$29k–$44k** |
| ROI (hand cost ÷ Claude cost) | **~12–19×** |

> The measured side is exact; the by-hand side is an estimate. Lead with the verifiable facts; treat the
> dollar figures as a labelled, conservative, self-measured estimate.

## Four measurement audits (why the naive numbers are wrong)

1. **Dedup by `message.id`.** Claude Code logs each streaming response multiple times (same id, growing
   `output_tokens`; input/cache constant). Counting each log line overcounts billed tokens **~2.4×**. We keep
   one record per `message.id` (the max-output/final one).
2. **Scope by repo.** The `tickets/` and `events/` dirs are a **central board across all projects**. We scope
   to this repo + ticket-workflow and exclude billed responses whose branch resolves to another repo's ticket
   (a ~$162 portfolio-site leak). Unattributed main-branch work (~45% of cost) is kept as in-repo.
3. **Counterfactual = merged PRs, not tickets.** Ticket counts are unreliable here (central board; the
   events-tracking hook was installed partway through, so a milestone-gated ticket count under-counted ~3×).
   Merged PRs are the git-verifiable unit.
4. **Supervision = union wall-clock.** Concurrent sessions are unioned (all top-level timestamps sorted
   together, capped gaps summed), not summed per-session — otherwise overlapping sessions double-count.

## Disclosures (limitations we can't fully resolve)

- **The dollar cost is self-reported** from private local transcripts and is not independently reproducible.
  Only PRs / LOC / supervised-hours / velocity are publicly verifiable.
- **The cost is a floor:** CI code-review API usage runs on GitHub Actions, not in local transcripts, and is
  not counted — so real Claude cost is somewhat higher (and true savings somewhat lower).
- Priced at standard list rates assuming **no >200K 1M-context premium**.
- Tokens are **measured**; the dollar figure is the **assumed** cloud-equivalent (list price).

## Reproduce

Publicly verifiable facts (anyone, any clone):

```sh
git log --oneline | grep -Ec '\(#[0-9]+\)'                 # merged PRs
git ls-files -- '*.ts' '*.tsx' '*.js' '*.jsx' '*.mjs' '*.css' '*.scss' '*.html' \
  | grep -Ev 'node_modules|dist/|\.min\.' | xargs wc -l | tail -1   # LOC
```

Full run (only on the machine whose `~/.claude` holds the sessions):

```sh
node analyze-hardpack-savings.mjs          # DRY RUN — analyses and prints, writes nothing
node analyze-hardpack-savings.mjs --write  # regenerates hardpack-savings.json in place
# env overrides: KANBAN_REPO, TW_REPO, OUT
```

### An unpriced model stops the write

`PRICES` is hand-maintained, and a model missing from it used to cost **$0** — so on 2026-08-16 the
published cumulative cost had *fallen* from $2485.30 to $1670.95 while merged PRs rose 155 → 301, purely
because `claude-opus-5` was absent and 80% of all measured tokens were priced as free. Corrected, the
same data is **$7604.73**, and ROI drops from 36–54x to 7.9–11.9x (`tkt-feb341a5c699`).

Now an unknown model returns `null` rather than 0, the run **exits 2 and refuses to write**, and the
count rides into the snapshot as `measured.unpricedUsage` (always present, `{}` when clean) with the
affected `byModel` row flagged `unpriced: true`. Fix it by adding the rate — verify at
[platform.claude.com pricing](https://platform.claude.com/docs/en/about-claude/pricing) — or pass
`--allow-unpriced` to publish a snapshot that openly declares the gap.

Unpriced responses still count toward tokens, message counts and `supervisedHours`: those are measured
facts, and dropping them would deflate a second figure to cover the first.

**Two limits the numbers carry regardless.** Fast mode on Opus 5 / 4.8 bills at $10/$50, and the
transcripts do not record `speed` — so a fast-mode session is under-priced here. And `PRICES` has no
mechanism keeping it current; this guard makes a *missing* model loud, but a silently *wrong* rate for a
model that is present stays invisible.

The script emits **aggregates only** — no per-ticket titles, no absolute user paths — so the snapshot is safe
to keep in a public repo.

## Files

- `analyze-hardpack-savings.mjs` — the analysis (parses transcripts, dedups, scopes, prices, PR-anchors).
- `hardpack-savings.json` — the frozen aggregates-only snapshot the app + case study read from. Still
  `asOf 2026-07-21` and deliberately not regenerated by the pricing fix above: that run predates the
  missing-model defect (every model in it was priced), so its figures are correct for their date and
  match what portfolio-site publishes. Refreshing it is a content decision that has to move both
  repos together, not a side effect of a bug fix.
