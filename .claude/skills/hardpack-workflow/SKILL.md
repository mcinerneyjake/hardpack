---
name: hardpack-workflow
description: Run the kanban ticket cycle for one project — audit the board, pick the highest-value ticket, validate its premise, implement, review, commit, PR, and mark done. Use only when explicitly invoked.
argument-hint: "<project> [<ticket-id>|--ticket <id>] [--gates manual|auto-commit|auto-pr] [--continuous]"
disable-model-invocation: true
---

# Kanban ticket cycle

You drive the cycle. You do **not** carry the workflow spec — each repo's own `CLAUDE.md` does, and
you read it at runtime (step 2). If you find yourself reciting testing tables, commit-message
formats or seam rules from memory, stop and go read the repo's file instead. Two sources of truth
drift, and a stale skill *instructs*.

What is yours: argument parsing, repo resolution, board audit, ticket selection, premise validation,
gate levels, hard stops, and the loop.

## 0. Parse `$ARGUMENTS`

- A token matching `tkt-[0-9a-f]{12}` → the **named ticket**, wherever in the line it appears.
  `--ticket <id>` is the canonical spelling; a bare id is accepted too, because an id cannot collide
  with a project name. See **A named ticket** below for what naming one does and does not skip.
- First bare token that is *not* a ticket id → **project**. Flags may appear in any order.
- `--gates manual|auto-commit|auto-pr` → omitted means **ask** (see below), not a silent default; an
  unanswered menu resolves to `manual`.
- `--continuous` → default **off**.
- Unknown flag → stop and say so. Never guess.
- **A leftover bare token — neither a ticket id nor the project — is not a flag, so the rule above
  does not catch it.** Stop on it anyway. This is the gap that produced `tkt-ec08d8af98f3`: the
  invocation `kanban --gates manual tkt-…` parsed as a project and a level, and the id fell through
  in silence, which is indistinguishable from never having been typed.
- Two ticket ids, or a `--ticket` whose next token is not a well-formed id → stop. Never pick one of
  two, and never treat the malformed token as the project.
- **A token that begins `tkt-` but does not match the full shape** — wrong length, non-hex,
  uppercase — → stop and say it is not a well-formed ticket id. Without this it falls through to the
  project rule below, and `--ticket tkt-abc` silently becomes *the project* `tkt-abc`, which then
  fails in §1 as "no repo mapping" — a true sentence about the wrong mistake.

### A named ticket

Naming a ticket skips **§4's ranking, and nothing else.** What naming one buys is skipping the
*choice*; it is never a claim that the ticket is still true, so **§5's premise validation runs
unchanged.** A ticket a human named is exactly as likely to be stale as one this skill ranked — more
so, if it was named from memory.

- **If §5's premise check fails on a named ticket: report and stop.** Record the correction as §5
  says, then stop — in every mode, `--continuous` included. Do **not** fall through to the
  next-priority ticket. The user asked for *that* ticket, and quietly substituting another is work
  nobody requested. This is the one premise failure that is a hard stop (§14); the ranked case
  deliberately is not, because there no particular ticket was asked for.
- **Blocked, `done`, `qa`, or already `in-progress` → warn and confirm** with `AskUserQuestion`,
  naming which one it is. For a blocker, resolve the blocker ids' *statuses* per §4 and name the ones
  still open. Never silently proceed — the state may be news to the user — and never silently
  refuse: naming a ticket is an override, and a `done` ticket with follow-up work or an
  `in-progress` one this session is resuming are both legitimate reasons to be here.
- **A night run holding this ticket may be your own parent — check before you believe otherwise, and
  check BOTH variables.** Nothing in the repo tells the two apart: `.night-run/ACTIVE/` holds one
  claim file per live runner, named by its pid, that pid's argv carries this ticket's id, and
  `.night-run/<run>/<id>.live.log` grows while you watch it. All three are equally true of a
  competing session and of the runner that spawned you. The runner passes `NIGHT_RUN_TICKET` and
  `NIGHT_RUN_PID` down to each per-ticket session; read them by shelling out, since neither is
  visible to you except through a command. **Resolve the primary checkout first**: a night session
  works in a worktree of its own (`tkt-c248cfbc5d8c`), where `.night-run/` does not exist, so a
  relative read there answers `NONE` about a run that is very much going.

  ```bash
  primary="$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")"
  printf '%s|%s|%s\n' "${NIGHT_RUN_TICKET:-UNSET}" "${NIGHT_RUN_PID:-UNSET}" "$(ls "$primary/.night-run/ACTIVE" 2>/dev/null || echo NONE)"
  ```

  The third field lists the claim files, one pid per line; `NONE` means no claims directory at all,
  and an empty field means an emptied one — no run either way.

  **You are the night run's own child only when `NIGHT_RUN_TICKET` names this ticket AND
  `NIGHT_RUN_PID` is one of the claim files listed.** Then that pid is your parent and that log is
  your own stdout: say so and get on with the work — do not stop, and do not ask the user to kill
  it. More than one claim is normal: night runs are concurrent, each in its own worktree, and the
  other claims are other runs, not competitors for this ticket.

  **Anything else is a competing session and stops you**, including the two near-misses that look
  like a match. A **different** id is a different ticket's session. And a **pid mismatch on a matching
  id** is the orphan case: a runner killed by a dropped ssh disarms and exits without taking its
  `claude` down (`night-control.mjs`), so an orphan keeps its dead parent's id and pid while a fresh
  runner re-queues the same ticket — id-matching alone would tell two live sessions to edit one ticket
  in one working tree, which is what the one-worktree rule exists to prevent. Unset means no night run
  spawned you.

  **The variables identify a session *tree*, not a direct child** — every descendant inherits them, so
  a session you started by hand from inside a night session's terminal reads them too, and a set
  variable is not proof of parentage. It is evidence, weighed with the pid; treat a mismatch as a
  competitor and stop.

  Measured 2026-09-04 (`tkt-c4743331eb03`): a session that read all three artifacts as a competitor
  hard-stopped on `tkt-508b1bd3a693`, left it `todo`, and the queue reported `never started` while
  exiting 0. That a `claude -p` child can read the variables at all was measured the same day, with a
  negative control returning `UNSET`.
- **Not on the board → stop.** Resolve it with **`get_ticket <id>`**, not by looking for it in §3's
  `list_tickets({ project })`: that call is project-filtered, capped at 100, and excludes `archived`
  by default, so "absent from that list" conflates *does not exist*, *belongs to another project*,
  *archived*, and *past the cap* — four states, one of which the line below depends on telling apart.
  `get_ticket` distinguishes them; say which one it was.
- **A named ticket resolves its own project — do not ask for one.** `get_ticket` returns the
  ticket's `project`, which is authoritative, so `/hardpack-workflow tkt-…` with no project is a
  complete invocation and must not trigger the project menu below. A user who knows the id rarely
  knows the exact project string, and that is the most natural way to use this argument. If a
  project was *also* given and the two disagree, stop and print both — never silently prefer one.
- **`--continuous`:** the named ticket runs **first**, then §16 returns to §4 and the loop ranks
  normally from there. A named ticket is consumed once; it does not pin the loop to itself.

**When these run.** §0 only *records* the id — every check above needs the board. Run them after
§3's audit and before §5, and do not reach §6's `start_ticket` or cut a branch until they have all
passed. Naming a ticket removes the ranking, never the checks that stand between a typo and somebody
else's ticket.

No project given: call `list_tickets` per project, show open counts, and `AskUserQuestion`. The
`project` field is free-form `string | null` — derive the live set from the board, never a hardcoded
list.

**No `--gates` given: ask, with the same tool.** A level decides how many human approvals the rest of
the run skips, so choosing it silently is the one default that should not be invisible. One option
per level, `manual` first and labelled `(Recommended)`, each naming what the level crosses on your
behalf:

- `manual` (Recommended) — every gate asks. Nothing is crossed on your behalf.
- `auto-commit` — you run the review and commit without asking; PR-open and merge still ask.
- `auto-pr` — you run the review, commit and open the PR without asking; merge still asks.

**An unaskable or unanswered menu resolves to `manual`** — never to an auto level, and never to a
level inferred from the request's tone or from what was chosen last time. This is the fail-safe
direction: "I could not ask" must not return the permissive answer, exactly as elsewhere in this
repo's guards. A run that could not put the question is a run with no authorization to cross
anything, which is what `manual` means.

An explicit `--gates` flag is an answer already given: skip the menu, do not re-ask, and do not treat
the flag as a suggestion to confirm. Ask the project and the gate level in one `AskUserQuestion` call
when both are missing — it takes several questions, and two round-trips to start one ticket is
friction the menu does not need to cost.

`kanban`'s `skillContract.test.mjs` binds that list to the §11–13 table and fails that repo's suite
when the two drift. Read the checks there rather than a summary here — enumerating them in prose is
the transcription this repo's own rules forbid, and the first cut of this paragraph was already
missing two of them. As with the gate table, it asserts the *list*, never that a run asks.

State the resolved settings in one line before doing anything:
`project=X gates=Y continuous=Z ticket=<id|ranked>`. Say `ticket=ranked` when none was named, so
"nobody named one" and "one was named and silently dropped" can never render identically.
Reprint it with `mode=native|foreign` appended once §1 has resolved the repos — it cannot be known
before then, since it needs the `git rev-parse` and the repo map.

## 1. Resolve the repos — native or foreign mode

Two repos matter, and they are not always the same one:

- the **session repo** — `git rev-parse --show-toplevel`. This is where the auto-injected `CLAUDE.md`,
  the `settings.json` allowlist and the project-scoped hooks came from, whatever you do later.
- the **target repo** — where this project's code lives, resolved from the project→repo map below.

Equal → **native mode**. Different → **foreign mode**: you drive the target repo from this session,
via §2a's command form. Announce which one, and in foreign mode name both paths.

**The project→repo map lives at `$CLAUDE_PROJECT_DIR/.claude/skills/hardpack-workflow/repos.local.json`.**
Read it and resolve the target as `<baseDir>/<projects[project].repo>`. That file is **gitignored on
purpose**: it carries an absolute home path and private project names, and this repo is public. Keep
absolute paths out of `SKILL.md` — `repoHygiene.test.mjs` scans the git index and fails the suite if a
home path naming a real account lands here. (It does **not** check project names; that part is
convention.)

**Treat the map as unusable — stop, and name the file — in any of these cases**, not just the first
two. A half-set-up machine and a set-up one must never render identically:

- the file is missing, or is not valid JSON;
- `baseDir` is absent or empty;
- `projects` is absent, or has no entries;
- the requested project is present but its `repo` is absent or empty.

Resolving `undefined/undefined` and continuing is the failure this list exists to prevent — a valid
JSON file with the wrong shape (`{}`, or `repos.example.json` copied with only `$comment` edited) is
neither missing nor unparseable, so the first two conditions alone would let it through. Seed a real
one from `repos.example.json` in the same directory.

**Three stops survive foreign mode. None is softened by it:**

- **The resolved target path does not exist.** Print it and stop — a stale row must not send anyone,
  or any `cd`, somewhere that isn't there. Confirm with a real check, not by assuming the map is current.
- **The project is absent from the map.** Say you have no repo mapping and stop. Do not guess a path
  from the project's name.
- **The resolved target path is not a plain absolute path.** If it contains whitespace, `$`, `*`, a
  quote or a leading `~`, stop and say why. This one is not fastidiousness — see the fail-open below.

**Why foreign mode is safe, and the two places it is not.** `guard-bash` parses a `cd` (and a
`git -C`) out of the command and judges **the target repo's** branch, so the protected-branch rules
apply to the repo actually being written. It follows the `cd` in both directions: a `cd` into a repo
on `main` is blocked even when the session sits on a feature branch, and a `cd` into a feature branch
is allowed even when the session sits on `main`. Asserted against the pinned build in kanban's
`.claude/settings.audit.test.mjs` ("judges a cd-carrying command against the target repo, in both
directions") — do not take it from this file's word.

Two limits on that, both measured, both failing in the **permissive** direction:

1. **A target path the guard cannot parse silently reverts to judging the *session*.** `resolveDir`
   returns null for a `cd` target this parser cannot name — and the fallback is the session's branch,
   which in foreign mode is a feature branch, i.e. *allowed*. **Which spellings still fall through
   moved at `ticket-workflow` v0.23.0, so measure rather than trusting a list.** Drive the spellings
   through the installed hook with the session on a feature branch and every target on `main`,
   keeping two controls: a plain `cd <path>` must block, and a bare `git commit` must pass. Measured
   that way at v0.23.0 (2026-08-31, `tkt-20abb1a93afe`), `cd "/a/my repo"`, `cd '/a/my repo'` and
   `cd $TARGET` now **block** — #76–#78 dequoted the parser and latched an unnameable `cd` closed —
   while an **unquoted** `cd /a/my repo` and `pushd <path>` still **pass**. Those two remaining
   fail-opens are why the third stop above and §2a's literal-path rule both stand; the `pushd` one is
   upstream's explicit design, since `cdTarget` matches only `cd`. Relax a rule only for a spelling
   you have just watched block, never for the group.
2. **The commit rule is remote-gated; the push rule is not.** `ruleFor` returns null for `commit`
   when the repo has no remote, so in a target with no `origin` a commit on `main` is **allowed** —
   deliberate upstream behaviour ("land it on a branch and open a PR" being meaningless with nowhere
   to push), and identical natively. Two mapped targets have no remote today. Do not tell a reader
   working one of those that a guard is holding: check `git remote` and say which rules are live.

**What foreign mode carries, and what it drops.** The old hard stop named three things that load from
the session's directory — `CLAUDE.md`, `settings.json`, and the guard hooks. They do not all fare the
same, so do not let the guard result above stand in for the other two:

| loads from the session, not the target | status in foreign mode |
|---|---|
| **guard hooks** | **Carried** — but not because the target's copy runs. The guards are wired in `~/.claude/settings.json`, so they fire whatever the cwd, and `guard-bash` judges the `cd` target. The target's own `.claude/hooks/*` do **not** run, and they are not all launchers of the pinned package: two mapped targets vendor a standalone 333-line guard with no `ticket-workflow` reference at all. Those are older and stricter-by-accident (they hardcode `main` instead of consulting `origin/HEAD`), so the session's newer guard covers what they would have — verify that still holds before relying on it for a target you have not checked. |
| **`CLAUDE.md`** | **Your job, per §2.** Nothing loads the target's automatically. |
| **`settings.json` permission allowlist** | **Dropped, and in the permissive direction.** |
| **pipeline telemetry** | **Carried, and credited to the target** — from `ticket-workflow` v0.20.0, subject to the machine's own pin (§2a). Residual: a target whose branch names no `tkt-…` id drops the milestone silently. |

The allowlist row is the one with no mitigation, so state it rather than discovering it: commands you
run against the target are permitted by **this session's** allowlist, and the board repo's is among
the broadest on the machine. A target that deliberately allows less does not get to enforce that here.
The guards still bound what a permitted command may *do* — this widens what runs without a prompt, it
does not unblock a commit to `main`. If a target's restrictions are the point of the ticket, work it
from a session rooted there instead.

## 2. Read the repo's own rules

Read the **target** repo's `CLAUDE.md` and follow it for every mechanic: branch naming, commit format,
testing requirements, seam rules, PR body, merge steps. `~/.claude/CLAUDE.md` carries the status
protocol and the engineering tenets and applies everywhere.

> **Foreign mode inverts the usual precedence, and nothing on screen will tell you.** The `CLAUDE.md`
> auto-injected into this session is the **session** repo's, and it does **not** govern the target's
> ticket. It arrives first, it is never announced as scoped, and it reads exactly like the rules for
> the work in front of you — so the failure is silent by construction. In foreign mode the target's
> `CLAUDE.md` is the one you must go and read, and where the two disagree the **target wins** on every
> mechanic. Say out loud which file you are following before the first edit.

**Rank the target's rules by what its own `CLAUDE.md` actually defines** — do not treat "has a
`CLAUDE.md`" as "defines a workflow":

1. **It defines the mechanic** → follow it, exactly.
2. **It deliberately defines a *different* one** → follow that, and do not restore the missing step.
   A repo whose `CLAUDE.md` says commits land locally on `main` with no push, no PR and no CI means
   it; inventing a PR gate there is not caution, it is disobeying the file you were sent to read.
3. **It is silent on the mechanic** → fall back to `~/.claude/CLAUDE.md` plus the derived gate in
   §9, and **say which mechanic you are improvising**. Silence is common: several targets define
   testing and comment rules but no branch or commit convention at all.
4. **There is no `CLAUDE.md`** → say so out loud, then as (3). Never silently assume kanban's rules
   apply elsewhere; kanban's are the heaviest on this machine and the least likely to fit.

Whichever rung applies, name it. "I am on rung 3 for commit format" is checkable; "following the
repo's rules" is not.

## 2a. Foreign-mode command form — `cd`, never `-C` or `--prefix`

Skip this section in native mode. In foreign mode, **every** command that acts on the target repo is:

```bash
cd <target> && <the literal command from §6/§9/§11–13>
```

**Not `git -C <target> …`, and not `npm --prefix <target> …`, for any milestone-bearing command**
(`git switch -c`, `npm run typecheck`, `npm run lint`, `npm test`, `git commit`, `gh pr create`).
Both are safe — `guard-bash` follows `-C` as it follows `cd` — but the `track-steps` matcher is
**positional**: it reads `t[0]`/`t[1]`/`t[2]`, so `git -C … commit` puts `-C` where `commit` must be
and matches **nothing**. Measured, with controls:

| command | milestone recorded |
|---|---|
| `git commit -m x` | `commit` |
| `cd <target> && git commit -m x` | `commit` |
| `git -C <target> commit -m x` | **none** |
| `npm run typecheck` | `typecheck` |
| `npm --prefix <target> run typecheck` | **none** |
| `cd <target> && npm run typecheck` | `typecheck` |

The compound form works because the matcher splits on `&&` first and matches each segment. So `cd`
is not a style preference — it is the only spelling of a foreign command that the pipeline can see.

`--prefix` stays correct in the one place it already appears (**Never**, filing a follow-up ticket):
that command is deliberately *not* milestone-bearing, and it must run the agent from the board repo
rather than the target.

**Two things that are not commands, and route differently.** The board tools (`list_tickets`,
`start_ticket`, `update_ticket`, `record_review`) reach the board through the MCP server — a **separate
process** whose cwd and environment were fixed when the session started. No shell `cd` can move it, so
these are correct in both modes and take no prefix. (Which root it resolved is a per-machine detail;
what matters here is that a command's cwd is not an input to it.) **`EnterWorktree`/`ExitWorktree` are the
opposite: they act on the *session's* repo**, so in foreign mode they would branch this repo rather
than the target. Do not use them in foreign mode — if the target needs a worktree, that is a reason to
work it from a session rooted there.

> **Attribution is correct from `ticket-workflow` v0.20.0 — but the *machine's* pin decides, not this
> repo's.** `track-steps` resolves the directory per milestone, so a foreign-mode `cd <target> && npm
> test` is credited to the target's branch ticket and **not** to the session's. Before v0.20.0 it read
> the session's branch only: a session on a `tkt-…` branch silently appended `test`/`commit`/`review`
> rows to **that** ticket's log — a real ticket showing a pipeline it never ran, the same class as the
> 1,889 duplicate rows in `tkt-af4669ce9a0d` (`tkt-2734584f8715`, `tkt-8ada0242e94e`).
>
> **The writer loads from the machine-local `~/.claude/tools` install, which carries its own pin**, so
> this repo's `package.json` does not answer the question and neither does the tag. Ask the machine
> for the *installed* version — a bare `npm install` after a pin bump can keep the old sha:
>
> ```bash
> node -p "require(require('os').homedir()+'/.claude/tools/node_modules/ticket-workflow/package.json').version"
> ```
>
> **Below v0.20.0 the old precaution still applies:** check the session's own branch before entering
> foreign mode, and if it carries a `tkt-…` id, switch the session repo to `main` first or say why. At
> or above it, that step is unnecessary. Two residuals at every version: a target branch naming no
> ticket drops the milestone silently, and a `cd` that is *data* rather than a move (`VAR=$( cd /x … )`,
> a heredoc body line) is credited to that directory's ticket (`tkt-218e8700a9c1`).

## 3. Audit the board

`list_tickets({ project, limit: 100 })`. Print the status one-liner (`3 backlog · 2 todo · 1 in-progress`).

**Read `unreadable` before trusting any count.** A non-empty array means ticket files failed to parse
and are absent from `total` too — the board is bigger than every number in the envelope. Report it;
in `--continuous` it is a hard stop.

**Read `unassigned` too** (ticket-workflow ≥ 0.8.0). It lists open tickets with no `project`, which
are missing from the `list_tickets({ project })` call above — so they can never be selected as work,
by this skill or any session. Both fields mean the same thing: *the board is bigger than your filtered
view shows*. Report the ids; assigning a project is a one-call `update_ticket` fix. Not a hard stop —
some are deliberately cross-repo, so read the ticket before "fixing" one.

If the field is absent, the repo is on an older ticket-workflow; say so rather than reading its
absence as zero.

Flag, without acting yet: past-due tickets, and `in-progress` tickets nobody is on (the status
protocol calls these a lie the next session has to untangle).

## 4. Select the ticket

**Skip this section when §0 named a ticket *and that ticket has not been run yet*** — skipping the
ranking is the whole of what naming one buys. Both halves matter: under `--continuous` §16 returns
here every iteration, and a skip conditioned on the *parse* alone would skip ranking forever and
arrive at §5 with nothing selected. A named ticket is consumed by its first run; every iteration
after it ranks normally. Go straight to §5, which runs for a named ticket exactly as it does for a
ranked one, and read §0's **A named ticket** for the blocked / `done` / `in-progress` cases this
section's rules would otherwise decide silently.

Rank, in order:

1. Past-due `dueDate`.
2. Priority: `urgent > high > medium > low`.
3. `in-progress` orphans before fresh `todo` — finish what's started.
4. Prefer a child over its epic.

**Blockers: resolve each blocker id's *status*; exclude only if one is still open.** Never treat the
presence of a `blockers` array as blocking — most blocker targets on this board are already `done`,
and presence-based exclusion wrongly drops tickets that are ready.

Announce the pick **and the runner-up**, one line each with the reason. A choice nobody can check is
a choice nobody can correct. In `manual` mode with a close call, confirm via `AskUserQuestion`; in
`--continuous`, pick and proceed.

## 5. Validate the premise — before any edit

Re-derive the ticket's **factual** claims against the current code. Agent-authored tickets inherit
their reporter's wrong premise verbatim, and a plan is stale on arrival.

If a claim is false: `update_ticket({ appendBody })` with the correction, put the ticket in
**`backlog`**, say plainly that it was filed on a wrong premise, and **return to step 4** — unless
this is the ticket named in §0, which stops instead (see the exception below). Do not quietly repair
the ticket and implement it anyway.

**`backlog`, never `todo`.** `todo` means "ready to pick up", and a ticket whose premise just failed
is the opposite of ready — leaving it there hands the next session a booby-trapped queue, and this
loop would pick it straight back up. Validation normally runs *before* `start_ticket`, so a rejected
ticket usually needs no status change at all; say so rather than issuing a no-op write. If a premise
only collapses after the ticket is already `in-progress`, move it back to `backlog` explicitly —
never leave it `in-progress`, which the status protocol calls a lie the next session has to untangle.

**For a ranked pick this is not a hard stop, in any mode** (the named-ticket exception below is the
one case that is). A wrong premise is a finding about the *ticket*, not about
the repo or the session — nothing is broken, nothing is half-applied, and the working tree is
untouched because validation runs before the first edit. So in `--continuous`: record the correction,
**abandon that ticket**, and take the next-priority one. Do not implement a re-scoped version of a
ticket whose premise just failed; the corrected body is the input to a *later* pick, once a human has
read it.

**Exception — when the ticket *being validated* is the one named in §0.** Everything above describes
a *ranked* pick, where abandoning one ticket and taking the next is right precisely because no
particular ticket was asked for. For the named ticket, append the correction the same way and then
**stop and report**: do not return to step 4, and do not implement a re-scoped version of it. That
one *is* on §14's list. The asymmetry is the point — "pick something useful" survives a stale
ticket, "work on this one" does not.

Read the condition as scoped to *this* ticket, not to the invocation. Under `--continuous` the run
was still started with a named ticket long after that ticket is done, and a premise failure on some
*later ranked* pick is an ordinary abandon-and-continue — not a hard stop.

Partial failure counts as failure. A ticket whose claims are half true is still mis-scoped, and
salvaging "the true half" mid-loop is the quiet narrowing step 5 exists to prevent — record which
half survived, say so in the correction, and move on.

**Bound the skid: three consecutive premise failures ends the loop.** One is a stale ticket; three in
a row means the board's tickets are systematically out of date with the code, and grinding through
the backlog rewriting bodies is not the work that was asked for. Report the three and stop. Reset the
counter on any ticket that validates.

## 6. Start and branch

`start_ticket <id>` — it sets `in-progress` **and** returns the body in one call. Not `update_ticket`.

Then cut the branch from a fresh `main` per the repo's convention (typically
`<prefix>/<id>-<slug>`, `bug→fix · feature→feat · task→task · chore→chore`).

**Inside a worktree, `main` is normally checked out in the primary and `git switch main` is refused
as already checked out.** Branch from the remote instead: `git fetch origin main`, then
`git switch -c <prefix>/<id>-<slug> --no-track origin/main` (without `--no-track` the new branch
would track `origin/main` itself). Every night-run session is in a worktree
(`tkt-c248cfbc5d8c`), and so is any session that took `EnterWorktree`; the `git switch -c` spelling
below is unchanged, so the milestone still records.

**Use the literal command spellings** `git switch -c`, `npm run typecheck`, `npm run lint`,
`npm test`, `gh pr create` — the `track-steps` hook keys pipeline milestones off those exact strings
and off the `tkt-[0-9a-f]{12}` in the branch name. A paraphrase records nothing, silently. In foreign
mode these keep their exact spelling and gain a `cd <target> &&` prefix — see §2a.

## 7. `## Done when`

For feature and bug tickets, `update_ticket({ appendBody })` a short list of observable, checkable
outcomes **before writing code**. It fixes the exit condition while changing it is still free.

Always `appendBody`, never `body` — `body` replaces, `tickets/` is gitignored, and a clobbered body
is unrecoverable.

## 8. Implement and test

Follow the repo's testing rules from step 2. Evaluate **each touched file independently**, not the
ticket as a whole. State which rule you are following and which file it came from.

Before fixing a bug, grep the tests and read the test *name* — a green test may be pinning the very
defect you were asked to fix.

## 9. Quality gate — derived, not assumed

Read the **target** repo's `package.json` scripts and run whichever of `typecheck`, `lint`, `test`
exist — in foreign mode, the target's, not the session's, and via §2a's `cd` form.
**Name the ones that do not exist** rather than reporting a clean three-command gate — `ticket-workflow`
has no `lint`, and a gate that silently shrinks is a gate that lies.

Read each command's exit status directly. Never read it through a pipe (in zsh that is
`$pipestatus[1]`, 1-indexed — `$PIPESTATUS` is empty). A missing script is reported, never counted
as a pass.

**The gate is not only the npm scripts.** Where the target's `CLAUDE.md` defines checks that bind its
tests to *this* diff — kanban names a **mutation check** and a **red-first repro** rule — those are
part of this step, and they run **before** the commit gate in every mode, including the auto ones that
cross it unattended. Take the procedure, its scope and the marker it wants recorded from that file
(step 2), never from here: a second copy of a procedure is the drift this skill exists to avoid, and
a stale one *instructs*. Where the repo offers an escape hatch, take it explicitly and say why,
rather than bending an acceptance criterion to fit.

An auto mode that crosses the commit gate without a check the repo defines is a **silent downgrade**
of that mode, not a faster one — the same hole as crossing it with no review. If one cannot be run,
name it and stop (§14); a check you could not run is never reported as one that passed.

### In an `auto-*` mode, the hook may be the gate — but only where it demonstrably is

Otherwise the night run pays for the whole gate twice, once here and once inside the commit's
`pre-commit` hook: ~3 minutes per ticket of extra wall clock, spent inside the window halts happen in
(`tkt-ea501e6d1a1d`). Ask the probe rather than the repo's reputation. Run it **from the session's own
checkout, before §2a's `cd`** — that spelling is what the `Bash(node scripts/probe/*)` permission rule
prefix-matches, and an absolute path or a `cd …&&` prefix matches no rule and prompts, which in an
unattended run is a probe that never runs:

    node scripts/probe/hook-gate.mjs <the tree the commit will happen in>

**Point it at the working tree the commit will happen in — `git rev-parse --show-toplevel` from where
you are about to commit — not at the path §1 resolved from `repos.local.json`.** In a worktree those
are different directories and the difference silently removes the gate: husky's generated `.husky/_`
is self-ignored (`.husky/_/.gitignore` is `*`), so it is never checked out into a worktree, and
`git hook run pre-commit` there answers *"cannot find a hook named pre-commit"* — measured 2026-09-08.
Probing the primary checkout would report the gate as covered while the commit runs no hook at all.
The probe pointed at the worktree gets this right on its own; the mistake is only ever in which path
it is handed.

It names the gate scripts the target defines, which of them the **effective** `pre-commit` hook
actually runs, and what is left over. Run what it leaves; skip what it covers. Three rules on reading
it, each of which fails toward running more:

- **Anything but an exit-0 report means run the full gate.** Exit 3 is *undetermined*, never "covers
  nothing", and conflating them is the only reading that loses a gate.
- **Coverage is positive evidence about one repo, never a fleet-wide fact.** Measured 2026-09-08, four
  of the nine projects are fully covered; `equipment-schedule`'s hook runs an unrelated script and four
  repos have no `pre-commit` hook at all. Re-probe per ticket — the answer is a repo's current config,
  and `HUSKY=0`, a non-executable hook, or a missing `.husky/pre-commit` each silently make it none.
- **The mutation check and the red-first repro do not move.** They are narrow, targeted runs, they are
  not what the hook repeats, and they still belong here — before the commit, in every mode.

Then **verify the commit by effect, not by its exit status**: `git rev-parse HEAD` must have moved. A
gate that fails inside the hook aborts the commit and prints husky's
`pre-commit script failed (code N)` rather than any wording of yours, so a commit you did not confirm
is a gate result you do not have.

**Say in the summary which commands the hook ran for you.** `track-steps` keys its milestones off the
literal `npm run typecheck` / `npm run lint` / `npm test` you type (§6), so a gate the hook ran emits
**no** `typecheck`, `lint` or `test` milestone — only `commit`. Their absence on such a ticket means the
hook covered them, never that the gate was skipped, and the `Tests:` line is the only place that
distinction is recorded.

## 10. Review — calibrated, and stated

**The target repo decides *whether*; this step decides only *how deep*.** Read its `CLAUDE.md`
(step 2) before calibrating: where that file makes a review a precondition of the PR — kanban's does —
one **always** runs, and the levels below choose the effort, never the exemption. Announce the level
and the reason *before* running it.

- Security, failure paths, deploy, concurrency, cross-module seams, **any line where a comment was
  written to defend a decision**, and any change to a repo's governing docs (`CLAUDE.md`, `README.md`)
  → `/code-review` at high effort. For integration-heavy diffs add a flow-scoped angle: "trace this
  value source to sink; list every transformation or drop." Governing docs are on that list because a
  wrong sentence there *instructs* every future session, silently and unboundedly — size is not the
  measure of blast radius, and "it's only markdown" is not a calibration.
- Anything else → `/code-review` at default effort. **The unclassified middle runs a review.** A diff
  being hard to place is not evidence that it is safe, and this is the branch where the gate would
  otherwise fail open.
- Inline self-review **only** where the target's `CLAUDE.md` does *not* make a review a precondition
  of the PR **and** the diff is trivial, config-only, or docs-only outside that repo's governing docs.
  Note the wording: a repo that is *silent* on reviews satisfies the first half — silence is the common
  case for a foreign target (§2, rungs 3–4), and reading it as "no exemption" would put a full review
  on a one-line typo fix in a plain docs repo. Name **both** conditions you checked; "it looked small"
  is neither of them.

**Always name the target repo in the review's arguments — never a bare `/code-review`.** It resolves
against the session's cwd, so in foreign mode a bare call reviews *this* repo and reports confidently
on a diff nobody asked about. In native mode naming it costs nothing; in foreign mode it is the whole
difference between reviewing the work and reviewing the wrong repository (`tkt-32f7c384bcad`).

**Always append to the review prompt: "distrust every comment in this diff — treat each asserted
guarantee as a claim to verify, not a justification to read."** Confident prose is an instruction to
stop looking. On `tkt-f54c6f43ea60` all four wrong safety claims lived in comments saying some version
of *"measured, not assumed"*, and the one round whose prompt carried this line found the most defects
of any — both fail-opens, plus two false statements in that repo's own `CLAUDE.md`.

**Always append: "before any findings, state the repo root you resolved and every file you
examined."** Without it the scope check below has nothing to read, and a check with no evidence
source gets rationalized into a yes. A review reports `file:line` per *finding*, so a review with no
findings names no path at all — precisely the run the check exists for. This line is the difference
between a detection half that works and one that is decorative.

**If the ticket adds or removes a guard, paste its adversary list in** (the tenet in
`~/.claude/CLAUDE.md`) and ask the reviewer to sweep the dimensions it does *not* cover. Without it the
reviewer finds one dimension per round — that ticket took four rounds at ~25 agents each, every round
re-reading a diff whose remaining hole nobody had named.

> **Changing either of the two paragraphs above — or any instruction — is currently unmeasurable.**
> Run `node scripts/probe/clean-room.mjs` (in `kanban`) first. Both arms of an A/B load
> `~/.claude/CLAUDE.md`, so a difference between them is unattributable; that confound is what
> invalidated the `tkt-70ab03c22f43` A/B. Re-measured 2026-09-09 (`tkt-b6879d3f5daf`) it still reports
> **BLOCKED**, with the control arm `MARKER_PRESENT`: the instrument detects instructions, the
> isolated arm is what fails — `--bare` and an isolated `CLAUDE_CONFIG_DIR` both exist and both fail
> auth without an `ANTHROPIC_API_KEY`. Run it rather than trusting that date.
>
> Until it reports `CLEAN` this cuts **both** ways. **Do not delete an instruction on the strength of
> an A/B** (`tkt-b86d2a318f8b`) — and do not add one described as measured: a diff adding a tenet
> lands `unmeasured` and records its **Claim** and **Falsifier**, per kanban's `CLAUDE.md`
> (*"Adding an instruction"* — the phrase its contract test matches, so this reference survives a
> reworded heading). Neither direction blocks the change; both forbid the claim.

### Before `record_review` — confirm the review reviewed *this*

| check | when it cannot be confirmed |
|---|---|
| **finders ran** | did not run |
| **scope** | did not run |

**That second column is the whole table's content.** A check you could not confirm is a review that
did not run — never a review that came back clean. Run both, say which you ran, and only then
`record_review({ id })`.

**finders ran.** Check `agents_error`; `verified: 0` *and* `refuted: 0` means no verification
happened, whatever the prose says.

**scope — compare paths, never counts (`tkt-32f7c384bcad`).** Take the repo root and the file list
the review was told to state, and check two things: the root is the **target** repo, and the files
overlap what this ticket actually changed. Your ground truth is **both** of these, in the target
(§2a's `cd` form):

```bash
git diff --name-only main...HEAD   # work already committed on this branch
git status --porcelain             # uncommitted, including untracked `??` files
```

Neither alone is ground truth, and each fails in the direction that stops a *correct* review:
porcelain is empty at the second review of a branch the workflow explicitly lets you commit to more
than once, and `git diff` omits the untracked files a new-file ticket adds.

**Do not reason from the finding count, and do not expect an empty report from a misdirected run.**
The tempting version of this check — "a review pointed at the wrong repo meets a clean tree and says
so" — does not hold. The harness falls back to a branch-vs-`main` range, and a checkout accumulates
squash-merged branches that nothing in the cycle can clear (`git branch --list`; see the
`gh pr merge --delete-branch` note in kanban's `CLAUDE.md`), so a misdirected review readily returns
a **full, confident, plausible** report about a ticket that merged weeks ago. Zero findings is a
legitimate result and proves nothing in either direction. What separates the two cases is *whose
files were read*.

Naming the target repo (above) is the *prevention* half, and it is honor-system prose: nothing stops
a bare call. This is the *detection* half, which is why the two are not redundant — and the appended
"state every file you examined" line above is what makes it performable at all.

**A scope check that fails, or that you cannot perform, is a §14 hard stop.** Re-run the review with
the target repo named; never carry an unconfirmed review across the commit gate. This is the one
fail-open in the cycle that is silent by construction — it yields a confident, well-formatted report
about a repository nobody asked about.

## 11–13. The gates

| level | review | commit | PR open | merge |
|---|---|---|---|---|
| `manual` (default) | ask | ask | ask | ask |
| `auto-commit` | run | cross | ask | ask |
| `auto-pr` | run | cross | cross | **ask — always** |

**The review column has no skip value at any level, and that is the point of it.** `ask` means ask
*when* to spend the tokens — "not now" defers the commit, it never cancels the review. `run` means the
level has pre-authorized you to run it yourself (§10), which is the only thing an auto mode lifts.
There is no value that crosses `commit` without a review having run, so no reading of this table
reaches an open PR with none.

**That is a claim about this table, not a guarantee about a run.** Nothing enforces it at execution
time: `guard-bash` does not inspect `gh`, and kanban's `skillContract.test.mjs` — which fails that
repo's gate if a column here is dropped, reordered or given a skipping value — asserts the table's
*shape* only, and in foreign mode never runs at all. The obligation is yours; the table only removes
the excuse.

**Review resolves before the commit, which is what the column order records — do not "fix" it back.**
The reasoning is in kanban's `CLAUDE.md` ("The review gate's ordering is deliberate"); read it there
rather than trusting a summary here.

**Merge is human in every mode.** There is no flag that changes this.

At PR-open, `update_ticket({ status: 'qa' })` — the single point a ticket enters `qa`. The merge does
not end the ticket: §15 owns everything after it, `ExitWorktree` and `status: 'done'` included.

**Surface the target's `mergeWarning` at the merge gate rather than burying it.** Per-project
warnings live in `repos.local.json` (§1) — a project may carry one because merging deploys to
production, or because its required checks do not actually run. Print it verbatim before asking, and
say plainly when a project has none, so "no warning" is never confused with "not checked".

**In foreign mode, add one line to the merge gate: which repo is about to be merged, by path.** The
approval a human gives at this gate is the last one, and from a session rooted somewhere else the
question "ready to merge?" does not on its own say *what*. The `gh` commands take §2a's `cd` form
like every other — `gh` resolves the repo from the cwd, so a bare `gh pr merge` here targets the
session's repository.

## 14. Hard stops — `auto` suppresses routine stops, never all stops

Stop, report, and wait on any of:

- A quality-gate failure not fixed in one pass.
- **A check the target repo defines that you could not run** (§9). Name it. Not-run is never reported
  as passed, and under `--continuous` this ends the loop like any other hard stop.
- **In `auto-pr`: a repo where no enabled workflow runs on a pull request.** `gh workflow list --all`
  names which are enabled — but enabled is not the same as *contributing a check*, so read each
  candidate's `on:` block too. A workflow triggered only `on: push` (a deploy job), one that is
  `paths:`-filtered away from this diff, or a GitHub-managed entry like `Dependabot Updates` all list
  as `active` and still leave `gh pr checks` empty. Absence of failing checks is not green — where
  nothing runs, empty reads identically to clean. Never read it as a pass.
  **Required-ness is deliberately not the condition.** `gh api repos/{owner}/{repo}/rulesets` answers
  403 on this account's **private** repos, which have no GitHub Pro (*"Upgrade to GitHub Pro or make
  this repository public"*); public `mcinerneyjake/kanban` does answer, which is why `CLAUDE.md` can
  use that endpoint for *this* repo and this rule cannot use it generally. A stop conditioned on
  required-ness therefore cannot be verified in most repos `auto-pr` actually runs in: it either denies
  service permanently there or gets guessed at. Both readings of the older wording were defensible,
  which is why three night runs on the same two repos split — one opened PRs, two stranded committed,
  gated, reviewed work unpushed (`tkt-c60f592675cf`). Required-ness is in any case a **merge** concern,
  and merge is human at every level (§11–13); PR-open is not the merge.
- A red check, or a `/code-review` finding you rate significant.
- **A review whose scope you could not confirm** (§10) — an empty finding list from a review
  that never saw your diff reads exactly like a clean one.
- A `guard-bash` block. Fix the environment; never route around the guard.
- A merge conflict, or a non-empty `unreadable`.
- The local LLM being down when a follow-up ticket needs filing.
- **A failed premise on a ticket named in §0** (§5). Naming one is a request for that ticket, so
  there is nothing to fall through to.

In `--continuous`, a hard stop **ends the loop**. It never skips to the next ticket.

**A *ranked* pick's failed premise validation is deliberately NOT on that list** — see step 5. It
fires before any edit, so there is nothing to leave half-done: the ticket is corrected, abandoned,
and the loop moves to the next-priority one. Three consecutive failures *is* a hard stop, because
that stops being a stale ticket and starts being a stale board.

## 15. Close the ticket — wrap-up check, then the handoff

The merge is not the close. After the merge lands, in this order: `ExitWorktree` if the ticket ran in
one (native mode only — see §2a), `update_ticket({ status: 'done' })`, then the three subsections below.
None is optional, and none is a courtesy — a ticket that merges without them leaves work that only this
session knew about. The table's two columns are the two that a run *owes an answer for*; the audit
between them is an input to the first, which is why it is not a third column.

| ticket type | wrap-up check | handoff |
|---|---|---|
| `bug` | ask | print |
| `feature` | ask | print |
| `task` | ask | print |
| `chore` | ask | print |

**Every row is identical, and that is the content of the table.** There is no ticket type that closes
without being asked — not a chore, not a docs-only change. Docs tickets are if anything the likeliest
to owe wrap-up, since they are the ones that make a neighboring claim stale.

**Nothing checks this table.** `kanban`'s `skillContract.test.mjs` used to derive its rows from
`TYPES` in `shared/constants.ts`; that binding was dropped in `tkt-5a4ff25d4e74` because a drift here
is read by a human at the wrap-up prompt rather than acting silently — see that repo's
`docs/skillContract-dropped-assertions.md` for the reasoning and the restore path. The consequence to
know: **a ticket type added to `TYPES` will not redden any suite for missing a row here.** Add the row
in the same diff.

### The in-progress audit

Before the wrap-up check, run the board's stale-`in-progress` probe. This close is the right moment
for it — §15 already re-reads the board to rank the next ticket — and it is nearly free:

```bash
node "$CLAUDE_PROJECT_DIR/scripts/probe/stale-in-progress.mjs" "${BOARD_DIR_OVERRIDE:-$CLAUDE_PROJECT_DIR}"
```

It reads the board only — each `in-progress` ticket's `blockers` (resolving every blocker's *status*,
never the array's presence) and the ticket's own prose. It never reads git. That is the point: the
audit this replaces measured branches, commits and pipeline logs, which is the right instrument for a
code ticket and the wrong one for a ticket whose deliverable is a human picking dropdown values, an
offline PC, or an account somebody else has to open. It read "no branch" as "no work", and was wrong
on `tkt-639be86eb24d` twice — once flagged and retracted the same day, then repeated verbatim eight
days later (`tkt-3d25ae0626c6`). Do not re-derive this audit by hand; run the probe.

Not milestone-bearing, so it takes no `cd` (§2a), and it is correct in both modes because
`$CLAUDE_PROJECT_DIR` is the board repo rather than the target. The explicit argument keeps the
answer independent of the cwd — but it must defer to `BOARD_DIR_OVERRIDE`, which is how this machine
points a session at the board in the first place. Hardcoding `$CLAUDE_PROJECT_DIR` there would
override it and exit 2 in any checkout whose own `tickets/` is absent (it is gitignored).

**It is advisory. No exit code blocks this ticket's close, in any mode.** The three mean different
things, and only one of them is about tickets. (Written as prose, not a table. The mechanical reason
is gone — `parseCloseTable` collected every `|` line in §15, so a second table here merged silently
into the close table above (`tkt-dd85591df5ee`), and that parser was dropped in `tkt-5a4ff25d4e74`.
Prose stays the right form regardless: three exit codes reading three different ways is a list, and
a table beside the close table invites reading them as one.)

- **`0`** — every `in-progress` ticket is accounted for. Nothing to do.
- **`1`** — findings: unaccounted tickets, or blocker link-rot. Read the tails and offer them to the
  wrap-up check. **Not** a §14 hard stop — an unrelated epic sitting unaccounted must not gate the
  ticket in hand.
- **`2`** — the scan did not complete: no `tickets/`, an empty scan, an unreadable file, or a crash.
  Say "the audit did not run" out loud, and close the ticket anyway.

Exit `2` is the one to read carefully, because it is the fail-closed direction: the probe refuses to
report a clean board it could not verify. **"I could not check" is never "the board is clean."** An
unreadable ticket file lands here rather than in `1` on purpose — the scan was *partial*, so every
count it printed under-reports, and folding that into the advisory code would make one permanently
corrupt file a constant no-signal alarm.

**Surface the body tails; do not summarize them into a verdict.** For anything it cannot account for
the probe prints that ticket's own words instead of a judgement, because its phrase list is
incomplete by construction and a human reading the actual prose is the check on the instrument. Read
the `ok` rows with the same suspicion: each names the line that excused it (`DECLARED L36: "…"`), and
a phrase matching *someone else's* blockage, or a heading whose own section later says it is
satisfied, is exactly how a real orphan gets silenced — measured on this board, and the reason the
prose phrase `blocked on` was removed rather than narrowed. Paste
those tails, name the ids, and let the human decide. A ticket flagged here may be legitimately
`in-progress` for a reason nobody wrote in a form a regex can see — which is exactly how the two
false flags happened. **Never change another ticket's status off this output**; that, too, has been
done and had to be undone.

What the output feeds, both immediately below: an id you and the human agree is genuinely orphaned is
a **board follow-up** in the wrap-up check, and §4 ranks `in-progress` orphans above fresh `todo`, so
the audit also informs the handoff's ranked id.

### The wrap-up check

One `AskUserQuestion`, multi-select, over this **fixed** list. Fixed is the point: asked freehand the
question narrows to whatever the run happens to still remember, which after a long ticket is the
recent half. Offer every item every time, even where you believe none applies — and say which ones you
already believe apply, so the human is correcting a draft rather than auditing from scratch.

- **Docs the diff falsified** — a claim in the target repo's `CLAUDE.md` or `README.md` that this
  ticket just made stale. Governing-doc edits are never trivial (kanban's `CLAUDE.md`, "Writing these
  documents"), so a stale one here misinforms every later session.
- **Board follow-ups** — a §10 review finding you chose not to fix (each becomes a ticket through the
  metered local agent, **one issue per run** — see **Never**), a ticket this one supersedes or
  unblocks, a parent to update, or a stale premise §5 found sitting in another ticket's body.
- **Durable facts for memory** — something this ticket established that the repo does not record and
  the next session would have to re-derive.
- **Nothing — close it out.** A real option, and it must be **chosen**.

**Exactly four options, because `AskUserQuestion` renders 2–4.** The two board-writing categories are
deliberately folded into one rather than listed separately: a five-item list cannot be rendered, so it
would be silently trimmed to four at runtime — and *which* item got dropped would vary by run, which is
the narrowing this fixed list exists to prevent. Splitting the check across two questions was the other
option and is worse: two questions make "nothing needed" answerable twice, in ways that can disagree.

**"Nothing" is exclusive, and resolves toward more work, not less.** Multi-select permits
`["Board follow-ups", "Nothing"]`. Treat that as the follow-up items alone and ignore the "Nothing" —
never the reverse. An answer that contradicts itself must not be read as authorization to skip.

**An unaskable or unanswered wrap-up check does not resolve to "nothing needed".** Print that the check
did not run, name the three follow-up items above, and say plainly that the close is unverified. This
is the same fail-safe direction as §0's unanswered gate menu, and the same rule as everywhere else in
this repo: "I could not check" must never return the permissive answer.

**That is a claim about this file, not about a run.** Nothing observes whether the check happened —
the test asserts the table above, and in foreign mode kanban's suite never runs at all. The table
removes the excuse; it does not enforce the step.

### The handoff

Print a paste-ready block that returns to the **board repo** — the home base, since the skill is
project-scoped there and the board tools are reachable from it in either mode:

```bash
cd <board-repo-path> && claude
```

then, in that session:

```
/hardpack-workflow <project> --gates manual <next ticket id>
```

**Substitute every placeholder before printing. A printed placeholder is a defect, not a template.**
`<board-repo-path>` is `$CLAUDE_PROJECT_DIR` **resolved at runtime** — print the resolved path, never
the variable, because the block is pasted into a *new* terminal where it is unset, so a literal
`cd "$CLAUDE_PROJECT_DIR"` succeeds and lands in `$HOME`: a handoff that fails silently in the wrong
directory. `<project>` is this run's project name — §0 reads the first bare token that is not a
ticket id *as* the project, and a literal `<project>` is not one, so
a literal `<project>` resolves against a project that is not on the board rather than falling through
to §0's menu. Equally, never write the resolved path into *this* file, which is public
(`repoHygiene.test.mjs` fails kanban's suite on one). Two lines, not one: whether an initial prompt can
carry a slash command is not something this file has measured, so do not print a one-liner that
assumes it.

**`<next ticket id>` is the ticket the next session should pick up, ranked at close time.** Re-read
the board — `list_tickets({ project, limit: 100 })` — and run §4's ranking over what comes back. Do
**not** reuse the ranking from the start of this run, or the runner-up §4 announced: the board moved
while the ticket was open, not least because the wrap-up check immediately above routinely files
follow-ups into it. A remembered ranking is stale by construction. Exclude what §4 already
excludes, plus what cannot be worked at all: a ticket whose `blockers` name an id that is still open
— resolve each blocker's *status* per §4, never the array's presence — and anything `done` or in
`qa`. **Do not exclude an `in-progress` orphan.** §4 ranks those *above* fresh `todo` ("finish
what's started") and §3 flags them for exactly this, so dropping them would make the handoff
systematically recommend a ticket §4 ranks lower — with nothing on screen saying so. §0 treats a
named `in-progress` ticket as a legitimate resume, not a refusal; it costs the next session one
confirmation tap, which is the right price for handing back work somebody left open. Carrying the id
is the whole point: without it the next session re-derives a ranking this one already has in hand,
which is the friction `tkt-71229c9290b8` was filed against.

**No candidate → omit the token entirely.** Print the invocation with the project and the level only,
and say in prose that the board has nothing ready. Never print `<next ticket id>` itself, and never
substitute a stand-in like `none` or `TBD`. Both stop the next session dead before it reaches the
board: the project is already substituted and sits first, so a stand-in lands as a *second* bare
token, which §0 stops on by name — and a stand-in beginning `tkt-` trips §0's malformed-id stop
instead. Loud, in other words, not silent; the reason to omit the token is that a stop the next
session must read and clear is exactly the friction this handoff exists to remove. (Do not reason
from the `<project>` paragraph above: its "first bare token" premise does not hold in this
position.)

**Do not add a second worked example for that case.** `skillContract.test.mjs` permits exactly one
line-initial slash command in this subsection — **any** name, not just this skill's, since
`invocationsIn` matches `^/<name>`. So a stray `/clear` example reddens the contract as surely as a
second `/hardpack-workflow` block would, and fencing exempts neither: `fenceMask` governs heading
detection only. Prose is the only form the no-candidate case can take here.

**Say that the id is a recommendation, not a decision.** Under the block, print one line naming the
ticket and its title and stating that the next session still owes it §5 premise validation. Without
it the id reads as a choice already made — and the stakes are higher here than for a ranked pick,
because §5 *stops* on a named ticket whose premise fails instead of moving to the next one. A handoff
that hides that turns one stale ticket into a dead-ended session.

**The handoff always says `--gates manual`, whatever level this run used.** A gate level authorizes
*one* run to cross gates on the human's behalf; echoing `auto-pr` into the next session re-grants that
authorization to a run nobody approved. `manual` crosses nothing, so pre-filling it costs no
authorization — which is also why pre-filling it is not the invisible default §0's menu exists to
prevent. The ticket id is the opposite case and carries no such hazard: naming a ticket skips §4's
ranking and nothing else (§0), so it pre-fills a *choice*, never an authorization.

**It prints at every close, `--continuous` included — that is why the table's column is per ticket
type and not per mode.** In a loop it is not an instruction to stop; it is the resume point, correct
at the moment it is printed, for a loop that can end at the very next hard stop or compaction. Say
which it is: *"resuming here if the loop ends"* under `--continuous`, *"next session"* otherwise. The
id it carries is then the ticket the loop is about to take, ranked off the same board state. It is
still a **separate read** from §16's, which re-reads the board and returns to §4 on its own, so the
two can diverge if the board moves between them — and §0 consumes a named ticket on its first run
only, so the loop never actually consumes the printed id. Print it as the resume point it is, not as
a promise about what §16 will pick. The `--gates manual` it carries is not a contradiction of a
loop still running at `auto-pr` — the level is this session's, and a new session re-earns its own.

## 16. Loop or stop

§15 runs in full for the ticket just closed — **both** steps, in **both** modes — before this section
decides anything. Then: `--continuous` re-reads the board (it may have changed) and returns to step 4;
otherwise recommend `/clear` after the handoff, the ticket being the session's unit of work (session
lifecycle, `~/.claude/CLAUDE.md`; `tkt-c8ac95e41f6f`). The only thing `--continuous` changes here is
whether a `/clear` is recommended next.

**Checkpoint every ticket.** Print `project=X gates=Y done=N in-flight=<id>` after each cycle.
**A compaction mid-loop ends the loop** — what survives it is a summary, not evidence. Finish or
checkpoint the in-flight ticket (a `## Checkpoint` block per the session-lifecycle rule in
`~/.claude/CLAUDE.md`), print the checkpoint line above, and recommend a fresh session. Finding yourself
working the board without these instructions in context IS the compacted case: stop the loop the
same way rather than continuing freehand.

## Never

- **Call `create_ticket`.** It is hook-blocked at both scopes. File follow-ups through the metered
  local agent, **one issue per run** — a multi-issue report sprays into thin tickets:
  ```
  npm --prefix "$CLAUDE_PROJECT_DIR" run agent -- --yes --create-only "<one issue>"
  ```
  (`--prefix` sets the child's cwd, so this works whatever the cwd is; `$CLAUDE_PROJECT_DIR` is this
  repo, which is where the agent lives.) Then `get_ticket` the result and
  fix any mis-classification via `update_ticket`. If the local runtime is down, stop and hand the
  finding over — never hand-author the ticket.
- **Merge without explicit approval**, in any mode.
- **`git add -A` / `.`, `commit -a`, force-push, `branch -D`, `reset --hard`, `clean -f`** — all
  blocked by `guard-bash`, all avoidable by staging explicit paths.
