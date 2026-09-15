#!/usr/bin/env node
// `npm run night:report` — the detail behind the SessionStart block from `.claude/hooks/night-report.mjs`
// (tkt-4ea4e17f1419). The hook is local-only and cheap; this is what a human runs once it points here.
//
// IT REPORTS, IT NEVER MERGES, and it must not offer to. The merge is CLAUDE.md §4: read the
// comments, ask "Ready to merge?", then plain `gh pr merge --squash --delete-branch`.
//
// `gh search prs`, NOT `gh pr list`. A ticket whose code lives upstream is worked in foreign mode and
// its PR lands in `ticket-workflow`; a `gh pr list` run from hardpack returned a confident false "no PR
// exists" on the first live run (project_night_run_queue.md).
//
// EVERY MATCH IS PRINTED, because that search is FULL TEXT and routinely returns more than one PR:
// measured on tkt-e69819938f33, which matches three merged PRs across two repos — its own
// (ticket-workflow#83) plus two that merely mention the id in their bodies. Picking one would be the
// same confident wrong answer as the `gh pr list` false negative above, so the human picks.
//
// CHECK NAMES WITH THEIR CONCLUSIONS, NEVER A ROLLED-UP GREEN/RED. A disabled workflow contributes no
// check at all, so an empty or exit-0 result does not mean everything ran — `code-review` is
// `disabled_manually` in this repo (CLAUDE.md, tkt-16b6e37a1cbb).

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { collect, ticketsDirFor } from '../.claude/hooks/night-report.mjs';
import { primaryRoot } from '../.claude/hooks/guard-unattended-merge.mjs';

export const REPORT_USAGE = 'usage: npm run night:report [-- --owner <github-owner>]';

export const EXIT = { ok: 0, unusable: 1, usage: 64 };

function ghRunner(args) {
  const res = spawnSync('gh', args, { encoding: 'utf8' });
  return {
    status: res.error ? -1 : res.status,
    stdout: res.stdout ?? '',
    stderr: res.error ? String(res.error.message) : (res.stderr ?? ''),
  };
}

// Reads the EFFECT (parseable JSON), not the exit status: `gh pr checks` exits non-zero when a check
// is merely pending, and exit 0 with an empty array is a real state that must not read as "green".
export function jsonOr(result) {
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed)) return { ok: true, value: parsed };
  } catch {
    /* falls through to the failure shape below */
  }
  const why = (result.stderr || result.stdout || '').trim().split('\n')[0] || `gh exited ${result.status}`;
  return { ok: false, why };
}

export function resolveOwner(gh, explicit = null) {
  if (explicit) return { ok: true, owner: explicit };
  const res = gh(['repo', 'view', '--json', 'owner', '-q', '.owner.login']);
  const owner = (res.stdout ?? '').trim();
  if (res.status !== 0 || !owner) {
    return { ok: false, why: ((res.stderr ?? '') || 'gh could not name the repository owner').trim().split('\n')[0] };
  }
  return { ok: true, owner };
}

export function searchPrs(gh, id, owner) {
  return jsonOr(gh(['search', 'prs', id, '--owner', owner, '--json', 'number,url,state,repository,title']));
}

export function checksFor(gh, repo, number) {
  return jsonOr(gh(['pr', 'checks', String(number), '--repo', repo, '--json', 'name,state,bucket']));
}

export function parseArgs(argv) {
  let owner = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--owner') {
      owner = argv[i + 1] ?? null;
      if (!owner) return { ok: false, why: '--owner needs a value' };
      i += 1;
      continue;
    }
    return { ok: false, why: `unknown argument ${JSON.stringify(argv[i])}` };
  }
  return { ok: true, owner };
}

export function renderTicket(ticket, prs) {
  const lines = [`${ticket.id}  status: ${ticket.status ?? 'UNREADABLE on the board'}`];
  for (const v of ticket.verdicts) {
    lines.push(`  verdict (${v.stamp}): ${v.level ?? 'unknown'} — ${v.text ?? 'no text recorded'}`);
    // A parked ticket's work is committed and UNPUSHED, so the PR search below finds nothing for it
    // and would otherwise print "no PR mentions this id" with no hint that a branch is sitting there
    // (tkt-c43474b393de). Keyed on the LEVEL, not on `v.branch` alone: a branch recorded beside a
    // stopping verdict would have this report calling the ticket parked while the SessionStart hook
    // called the same ticket mid-ticket (review, low).
    if (v.level === 'parked' && v.branch) {
      lines.push(`    parked on ${v.branch}${v.repo ? ` in ${v.repo}` : ''} — unpushed, so no PR exists yet`);
    }
  }
  if (!prs.ok) {
    lines.push(`  PR search FAILED: ${prs.why} — no PR state was determined for this ticket.`);
    return lines;
  }
  if (!prs.matches.length) {
    lines.push('  no PR mentions this id. That is a search result, not proof none exists — check by hand.');
    return lines;
  }
  lines.push(`  ${prs.matches.length} PR(s) mention this id (full-text search — not all of them are its PR):`);
  for (const pr of prs.matches) {
    lines.push(`  - ${pr.repo}#${pr.number} [${pr.state}] ${pr.title}`);
    lines.push(`    ${pr.url}`);
    if (!pr.checks.ok) {
      lines.push(`    checks could NOT be listed: ${pr.checks.why}`);
    } else if (!pr.checks.value.length) {
      lines.push('    no checks reported — a disabled workflow contributes none, so this is not "green".');
    } else {
      for (const c of pr.checks.value) lines.push(`    check ${c.name}: ${c.state}`);
    }
  }
  return lines;
}

// `env` is injected because `night-run.mjs` exports BOARD_DIR_OVERRIDE into every night session, so
// reading process.env here aimed the suite's fixture lookup at the real board (tkt-f55d1ce07347).
// The hook this delegates to already took it as `report({ env })`; this caller skipped it.
export function main(
  argv = process.argv.slice(2),
  {
    gh = ghRunner,
    resolveRoot = primaryRoot,
    out = process.stdout,
    err = process.stderr,
    env = process.env,
  } = {},
) {
  const args = parseArgs(argv);
  if (!args.ok) {
    err.write(`${args.why}\n${REPORT_USAGE}\n`);
    return EXIT.usage;
  }

  const root = resolveRoot();
  if (!root) {
    err.write('could not locate the primary checkout, so `.night-run/` could not be read\n');
    return EXIT.unusable;
  }
  const boardDir = env.BOARD_DIR_OVERRIDE ?? root;
  // Resolved here rather than by collect()'s default, which reads process.env and would leak
  // TICKETS_DIR_OVERRIDE past the seam above; ticketsDirFor encodes its documented precedence.
  const collected = collect({ root, boardDir, ticketsDir: ticketsDirFor(boardDir, env) });

  for (const stamp of collected.scan.missing) {
    out.write(`run ${stamp}: NO summary.json — the runner did not finish. Read its log by hand.\n`);
  }
  for (const { stamp, why } of collected.scan.corrupt) {
    out.write(`run ${stamp}: summary.json unreadable (${why}).\n`);
  }
  for (const stamp of collected.unfinished) {
    out.write(`run ${stamp}: no exit code recorded — the runner died before finishing.\n`);
  }
  if (collected.scan.error) out.write(`\`.night-run/\` could not be read (${collected.scan.error}).\n`);
  if (collected.active) {
    out.write('a night run is ACTIVE — `gh pr merge` is blocked in this checkout until it disarms.\n');
  }

  // A scan that could not read everything has NOT established that nothing is outstanding, so it may
  // neither print that sentence nor exit 0 — "a stopping verdict must never share a code with a clean
  // night" (night-run.mjs:25, review MEDIUM).
  const partial =
    Boolean(collected.scan.error) ||
    collected.scan.missing.length > 0 ||
    collected.scan.corrupt.length > 0 ||
    collected.unfinished.length > 0;

  if (!collected.tickets.length) {
    out.write(
      partial
        ? 'no outstanding tickets were DERIVED, but the scan above was incomplete — this is not a clean board.\n'
        : 'no night-run tickets are outstanding.\n',
    );
    return partial ? EXIT.unusable : EXIT.ok;
  }

  const owner = resolveOwner(gh, args.owner);
  if (!owner.ok) {
    // Naming the tickets without their PR state beats printing nothing: "could not check" must still
    // hand the human the list it did derive locally.
    err.write(`could not resolve the GitHub owner (${owner.why}); pass --owner <name>\n`);
    for (const t of collected.tickets) {
      out.write(`${t.id}  status: ${t.status ?? 'UNREADABLE'} — PR state NOT checked\n`);
    }
    return EXIT.unusable;
  }

  for (const ticket of collected.tickets) {
    const found = searchPrs(gh, ticket.id, owner.owner);
    const prs = found.ok
      ? {
          ok: true,
          matches: found.value.map((pr) => {
            const repo = pr.repository?.nameWithOwner ?? '(unknown repo)';
            return {
              repo,
              number: pr.number,
              state: pr.state,
              title: pr.title,
              url: pr.url,
              checks: checksFor(gh, repo, pr.number),
            };
          }),
        }
      : found;
    out.write(`${renderTicket(ticket, prs).join('\n')}\n\n`);
  }

  out.write('This report does not merge. The merge gate is CLAUDE.md §4 and stays human.\n');
  return partial ? EXIT.unusable : EXIT.ok;
}

// `process.exitCode`, never `process.exit()`: this report writes many lines, and process.exit does
// not flush a pending async pipe write, so `npm run night:report | less` loses the tail (review, LOW).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main();
}
