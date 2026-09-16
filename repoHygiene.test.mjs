import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// tkt-e18d0c20d6b6. Adapted from ticket-workflow's src/repoHygiene.test.ts, which paid for the
// design. hardpack is PUBLIC and now carries a gitignored `repos.local.json` full of absolute paths
// and private project names, one directory away from tracked files — so "no local identifiers here"
// stopped being safe as convention and needed a gate.
//
// The check that motivated this test was itself wrong: a hand-run `git grep -l` for the account name
// in ONE capitalization returned zero over the index and was reported clean, while the lowercase
// spelling sat in server/terminal.test.ts. A negative control that sweeps one spelling of the thing
// you are hunting licenses exactly the wrong conclusion — the shape that hid a real account in
// ticket-workflow too. The regex below never had that flaw; the human grep did.
//
// PLACEHOLDER-AWARE, not shape-blind: fixtures legitimately need home paths to exercise path
// parsing, so banning the shape outright is what forces a stale exclusion list to exist. What is
// banned is a home path naming a REAL account. Prefer rewriting an offending example over adding to
// PLACEHOLDERS — a growing exclusion list is how the predecessor check rotted into always-fires.

const PLACEHOLDERS = new Set([
  'someuser', 'user', 'youruser', 'me', 'x', 'o', 'test', 'example',
  // CI runners: a workflow, or a pasted CI log in a doc, legitimately carries these.
  'runner', 'ubuntu',
]);

// `/Users/<owner>` and `/home/<owner>` need NO trailing slash — `HOME=/Users/user` at end of line is
// exactly the leak a slash-requiring pattern misses.
//
// The PREFIX is matched in both natural cases (`/Users/`, `/users/`, `/home/`, `/Home/`) because
// macOS is case-insensitive, so `/users/<account>/…` is a working path that shells and tools really
// emit — a review staged that spelling and the suite passed green. A blanket `i` flag is still
// wrong: it would also match the all-caps `HOME` that appears in ordinary prose ("mount/HOME/git"),
// which is a false positive this file already tripped over once.
//
// DECLARED LIMITS, so they are not mistaken for coverage: an all-caps `/USERS/` or `/HOME/` prefix
// is not matched (not a real path spelling, and matching it reintroduces the prose collision), and
// the classifier is LINE-scoped, so a path wrapped across two lines in a long markdown doc clears it.
const ABS_HOME = /(?:\/[Uu]sers\/|\/[Hh]ome\/)([A-Za-z_][A-Za-z0-9._-]*)/g;
// The tilde form DOES require a trailing slash, deliberately: bare `~word` is ordinary prose
// ("~two hours", "~40 lines"). So `cd ~user` with no path after it is a known blind spot — named
// here and pinned by a test below rather than left implied. Note `~/.claude/` never matches: the
// owner class must start at [A-Za-z_], and `/` follows the tilde immediately.
const TILDE_HOME = /~([A-Za-z_][A-Za-z0-9._-]*)\//g;

// Scoped to LINES, not to this whole file: a whole-file exclusion would make a genuine leak
// anywhere in this file unscannable, which is the mistake this design removed.
const FIXTURE = 'HYGIENE_FIXTURE';

const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];

function git(args, cwd) {
  const env = { ...process.env };
  // An inherited git context overrides cwd, so this would silently scan a DIFFERENT repository and
  // report it clean — and no file-count floor catches that, since any repo clears one.
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  try {
    return { ok: true, out: execFileSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 }) };
  } catch (err) {
    if (err && typeof err === 'object' && 'status' in err && err.status === 1) return { ok: false, out: '' };
    throw err;
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));

function repoRoot() {
  const root = git(['rev-parse', '--show-toplevel'], here).out.trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  // Identity check, not a smoke test: it is what makes "clean" mean clean HERE.
  expect(pkg.name, 'resolved a different repository than hardpack').toBe('hardpack');
  return root;
}

export function leakedOwners(line) {
  const owners = [...line.matchAll(ABS_HOME), ...line.matchAll(TILDE_HOME)].map((m) => m[1]);
  return owners.filter((o) => !PLACEHOLDERS.has(o.toLowerCase()));
}

describe('public repo carries no local identifiers', () => {
  it('has no home-directory path naming a real account, anywhere in the index', () => {
    const root = repoRoot();

    // Scans the INDEX, not the working tree: a leak could be staged and then cleaned in the worktree,
    // passing the gate while the leaked blob commits.
    const candidates = git(['grep', '--cached', '-I', '-n', '-i', '-E', '(/Users/|/home/|~)[A-Za-z_]', '--', '.'], root);

    // Non-vacuity. A negative claim resolved from an empty scan is a clean report that inspected
    // nothing — and this check FAILED that way once: swapping the candidate pattern for a string
    // that matches nothing left all tests green, because neither guard below covers the pattern
    // ITSELF. `tracked.length` only counts files, and the textFiles grep below uses a different
    // pattern; both pass while this exact grep matches nothing.
    //
    // This is the load-bearing one: the control fixtures further down this file are tracked and do
    // carry home-path spellings, so a non-matching candidate grep is proof the instrument is broken,
    // never proof the repo is clean.
    expect(candidates.ok, 'the candidate pattern matched NOTHING — the instrument is broken, not the repo clean (this file\'s own fixtures must match)').toBe(true);

    const tracked = git(['ls-files'], root).out.split('\n').filter(Boolean);
    expect(tracked.length).toBeGreaterThan(50);
    // No second needle here, deliberately (tkt-4620536e2d34): any literal is in the index BECAUSE it
    // is written here, so it can only be vacuously green — which is why the old `kanban` one could
    // never red. The witnesses that can: the `candidates.ok` assert above, where the REAL pattern
    // must match this file's fixtures, and the tracked-vs-textFiles pair below.

    // `-I` above skips binary files, and ONE stray NUL byte is enough to classify a text file as
    // binary — so a leak in a NUL-poisoned markdown file would be silently skipped and reported
    // clean. This repo has already paid for that exact shape (`tkt-0fc9ba1b86c2`, the nul-bytes
    // probe). Today zero tracked files classify as binary, so pin it: a new one fails here and a
    // human decides, rather than quietly shrinking the scan.
    const textFiles = git(['grep', '--cached', '-I', '-l', '-e', '', '--', '.'], root).out.split('\n').filter(Boolean);
    const skippedAsBinary = tracked.filter((f) => !textFiles.includes(f));
    expect(skippedAsBinary, 'tracked files classify as BINARY and are skipped by the -I scan above — a stray NUL byte hides a leak this way').toEqual([]);

    const leaks = [];
    for (const line of candidates.out.split('\n').filter(Boolean)) {
      if (line.includes(FIXTURE)) continue;
      const [file, , ...rest] = line.split(':');
      for (const owner of leakedOwners(rest.join(':'))) leaks.push(`${file}: ${owner}`);
    }

    expect(leaks, 'a home path names a real account — use a placeholder').toEqual([]);
  });

  // The gitignored companion is the whole reason this gate exists. If the ignore rule ever stops
  // matching, this fails before the leak reaches a public commit.
  // ALLOWLIST, not a suffix denylist. The first cut asserted "no tracked file ends in .local.json"
  // while .gitignore ignored the same suffix — two layers narrowed identically, so both missed
  // `repos.local.json.bak`, `.jsonc`, `.yaml` and a plain `local.json` TOGETHER. A denylist guarded
  // by the denylist it mirrors is not a second layer. Anything new here must be added deliberately.
  const ALLOWED_SKILL_FILES = [
    '.claude/skills/hardpack-workflow/SKILL.md',
    '.claude/skills/hardpack-workflow/repos.example.json',
  ];

  it('tracks exactly the intended skill files, and no machine-local config', () => {
    const root = repoRoot();
    const tracked = git(['ls-files', '--', '.claude/skills'], root).out.split('\n').filter(Boolean);
    expect(
      [...tracked].sort(),
      'unexpected tracked file under .claude/skills — if it is machine-local the .gitignore rule is not matching; if it is intended, add it to ALLOWED_SKILL_FILES',
    ).toEqual([...ALLOWED_SKILL_FILES].sort());
  });

  // Controls: the matcher must fire on the real thing and stay silent on placeholders, or the clean
  // verdict above means nothing.
  it('flags a real account name, in either case, with or without a trailing slash', () => {
    expect(leakedOwners('/Users/realaccount/board/')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('HOME=/Users/realaccount')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/home/realaccount')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/_realaccount/x')).toEqual(['_realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('cd ~realaccount/repo')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    // The exact miss that motivated this file: a lowercase account, caught with no `i` flag.
    expect(leakedOwners('/Users/realaccount/x')).toEqual(['realaccount']); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/Realaccount/x')).toEqual(['Realaccount']); // HYGIENE_FIXTURE
  });

  it('permits placeholders, CI runner paths, ~/ and ordinary prose', () => {
    expect(leakedOwners('cd ~someuser/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/Users/x/repos/some-repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('/home/runner/work/repo/repo')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('see ~/.claude/settings.json')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('it took ~two hours and ~40 lines')).toEqual([]); // HYGIENE_FIXTURE
    expect(leakedOwners('no home path here at all')).toEqual([]);
    // Prose with an uppercase path segment must not read as a home dir — the `i`-flag regression.
    expect(leakedOwners('Shared mount/HOME/git middle of the argv')).toEqual([]); // HYGIENE_FIXTURE
  });

  // The documented blind spot, pinned so it cannot be mistaken for coverage later.
  it('does NOT catch a bare tilde account with no path after it (known limit)', () => {
    expect(leakedOwners('cd ~realaccount')).toEqual([]); // HYGIENE_FIXTURE
  });
});
