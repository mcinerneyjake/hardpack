import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Git exports an ABSOLUTE GIT_DIR in a worktree and it is inherited by `npm test`, so a temp-repo
// command would silently drive the REAL repository and grade the wrong branch (tkt-cf1e0c0b3dda).
const GIT_CONTEXT_VARS = ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_PREFIX'];
function hermeticEnv() {
  const env = { ...process.env };
  for (const key of GIT_CONTEXT_VARS) delete env[key];
  return env;
}

/**
 * Every wired PreToolUse hook file that lives in this repo, resolved to a real path.
 * A wired-but-ABSENT file is asserted, never filtered out: the hook then does not run at all, which
 * is the silent no-guard this whole design exists to prevent — quietly dropping it from the list
 * would let every assertion below pass while the guard is missing.
 */
function wiredLocalHooks() {
  const matchers = settings.hooks?.PreToolUse ?? [];
  const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
  const rels = commands
    .map((c) => /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w.-]+\.mjs)/.exec(c)?.[1])
    .filter(Boolean);
  for (const rel of rels) {
    expect(existsSync(join(REPO_ROOT, rel)), `${rel} is wired in settings.json but missing on disk`).toBe(true);
  }
  return rels.map((rel) => join(REPO_ROOT, rel));
}

// Audits the checked-in permission allowlist (.claude/settings.json). This reads rule
// STRINGS, so safety is layered: git rules are broad but guard-bash-backed (asserted below);
// non-git rules are pinned to a reviewed set; delete_ticket + dangerous tokens are rejected.

const settings = JSON.parse(readFileSync(new URL('./settings.json', import.meta.url), 'utf8'));
const allow = settings.permissions?.allow ?? [];

// MCP tools safe to auto-approve: reads + non-destructive writes. create_ticket stays here but is
// blocked at runtime by guard-ticket (authoring is delegated to the local agent, tkt-2492e26a277a) —
// parallel to the broad git rules being guard-bash-backed. The allowlist entry avoids a re-prompt if
// that policy is ever relaxed; the hook (asserted below) is the real gate.
const REQUIRED_MCP = [
  'mcp__kanban__list_tickets',
  'mcp__kanban__get_ticket',
  'mcp__kanban__start_ticket',
  'mcp__kanban__create_ticket',
  'mcp__kanban__update_ticket',
  'mcp__kanban__record_review',
];

// The complete reviewed set of non-git Bash rules (git rules are exempt, hook-backed).
const EXPECTED_NONGIT_BASH = new Set([
  'Bash(gh pr create *)',
  'Bash(gh pr view *)',
  'Bash(gh pr checks *)',
  'Bash(gh pr merge *)',
  'Bash(npm run typecheck)',
  'Bash(npm run lint)',
  'Bash(npm test)',
  'Bash(npm run test:coverage)',
  'Bash(npm run build)',
  'Bash(npm run agent -- --yes *)', // the delegated create path (tkt-2492e26a277a) — --yes = metered, non-interactive
  'Bash(npx vitest run *)',
]);

// Explicit dangerous tokens that must never appear verbatim in any rule.
const FORBIDDEN = ['rm -r', 'sudo', '--force', '-f ', 'git reset --hard', 'chmod', 'mkfs', 'dd if=', 'curl', 'wget', ':(){', '> /dev/'];

describe('.claude/settings.json permission allowlist', () => {
  it('is a well-formed list of non-empty string rules', () => {
    expect(Array.isArray(allow)).toBe(true);
    expect(allow.length).toBeGreaterThan(0);
    for (const rule of allow) {
      expect(typeof rule).toBe('string');
      expect(rule.trim().length).toBeGreaterThan(0);
    }
  });

  it('covers the expected non-destructive MCP tools', () => {
    for (const tool of REQUIRED_MCP) expect(allow).toContain(tool);
  });

  it('keeps the destructive delete_ticket tool gated (absent from the allowlist)', () => {
    expect(allow.some((rule) => rule.includes('delete_ticket'))).toBe(false);
  });

  it('pins every non-git Bash rule to the reviewed specific set (no wildcarded subcommands)', () => {
    for (const rule of allow) {
      if (!rule.startsWith('Bash(')) continue; // MCP tool rules
      if (rule.startsWith('Bash(git ')) continue; // git breadth is guard-bash-backed
      expect(
        EXPECTED_NONGIT_BASH.has(rule),
        `unexpected non-git Bash rule "${rule}" — if intended, add it to EXPECTED_NONGIT_BASH (a deliberate re-review)`,
      ).toBe(true);
    }
  });

  it('contains no explicit dangerous token in any rule', () => {
    for (const rule of allow) {
      for (const bad of FORBIDDEN) {
        expect(
          rule.toLowerCase().includes(bad.toLowerCase()),
          `allow rule "${rule}" contains forbidden token "${bad}"`,
        ).toBe(false);
      }
    }
  });

  // The broad git rules are only safe because guard-bash blocks the dangerous shapes at runtime — a hard invariant.
  it('keeps the guard-bash PreToolUse hook wired (backstop for the git allowlist)', () => {
    const matchers = settings.hooks?.PreToolUse ?? [];
    const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.some((c) => c.includes('guard-bash'))).toBe(true);
  });

  // create_ticket is allowlisted but must be blocked at runtime by guard-ticket (authoring is
  // delegated to the local agent) — the allow entry is only safe because this hook is wired.
  it('keeps the guard-ticket PreToolUse hook wired (backstop for the create_ticket allow entry)', () => {
    const matchers = settings.hooks?.PreToolUse ?? [];
    const createGuards = matchers.filter((m) => (m.matcher ?? '').includes('create_ticket'));
    const commands = createGuards.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.some((c) => c.includes('guard-ticket'))).toBe(true);
  });

  // Wiring says a guard-shaped path is configured; it cannot say the file behind it still guards. A
  // vendored copy truncated to a no-op keeps the substring and passes the two assertions above — the
  // same fail-open shape one level up. These two close it (tkt-6e4c55c81208).

  // The local hooks must stay LAUNCHERS delegating to the pinned package, never re-vendored copies:
  // the copy this replaced drifted and left every repo outside hardpack failing OPEN for ~24h in
  // 2026-07.
  //
  // The check is on SUBSTANCE, not length. Length alone was the original proxy (a re-vendored
  // guard-bash is 333 lines), but a launcher legitimately carries consumer POLICY — guard-ticket's now
  // sets TICKET_WORKFLOW_CREATE_REASON, which is deliberately verbose because it is the text a blocked
  // session reads (tkt-0361525dbf9f). That pushed it to 37 of a 40-line cap, i.e. one paragraph from a
  // false failure. Raising a threshold to fit your own change is exactly how a guard gets hollowed out,
  // so the cap is raised AND paired with what actually distinguishes the two: a launcher delegates and
  // decides nothing, while a vendored guard carries its own rule table.
  const VENDORED_LOGIC = [
    [/^\s*const\s+RULES\b/m, 'defines a RULES table'],
    [/^\s*(export\s+)?function\s+decide\b/m, 'defines its own decide()'],
    [/\bnew RegExp\(|=\s*\/[^/\n]+\/[gimsuy]*\s*[;,)]/m, 'defines a matcher regex'],
  ];

  it('wires only launchers that delegate to the pinned package, not vendored copies', () => {
    const local = wiredLocalHooks();
    expect(local.length).toBeGreaterThan(0); // else every assertion below is vacuous
    for (const file of local) {
      const src = readFileSync(file, 'utf8');
      expect(src, `${file} does not import the package hook`).toContain('ticket-workflow/hooks/');
      // Generous, because policy text is legitimate here; the substance checks below are the real gate.
      expect(src.split('\n').length, `${file} is too long to be a launcher`).toBeLessThan(80);
      for (const [pattern, what] of VENDORED_LOGIC) {
        expect(pattern.test(src), `${file} ${what} — that is a vendored guard, not a launcher`).toBe(false);
      }
    }
  });

  // The control for the assertion above: the patterns must actually FIRE on a real vendored guard. Three
  // regexes that match nothing would pass every launcher forever — a guard that cannot fail.
  it('those vendored-logic patterns detect the real guard they exist to reject', () => {
    const packaged = join(dirname(createRequire(import.meta.url).resolve('ticket-workflow')), '..', 'hooks', 'guard-bash.mjs');
    const src = readFileSync(packaged, 'utf8');
    const fired = VENDORED_LOGIC.filter(([pattern]) => pattern.test(src)).map(([, what]) => what);
    expect(fired, 'no pattern matched the packaged guard-bash — the checks above are vacuous').not.toEqual([]);
  });

  // Verify the EFFECT, not the wiring: drive the actually-wired file and watch it block. The package
  // ships no tests, so with the duplicated local suites gone this is hardpack's only executable proof
  // that the PINNED hook build still guards — the hook analogue of server/packageContract.test.ts.
  it('blocks a commit on main through the wired launcher, and allows one on a branch', () => {
    const repo = mkdtempSync(join(tmpdir(), 'audit-guard-'));
    try {
      const git = (...args) => execFileSync('git', args, { cwd: repo, env: hermeticEnv(), encoding: 'utf8' });
      git('init', '-q', '-b', 'main', '.');
      // The remote is load-bearing: as of ticket-workflow v0.12.0 the protected-branch rules only
      // apply to repos that have one, because "land it on a branch and open a PR" is meaningless
      // with nowhere to push (tkt-f32915b3e858). Without this the fixture is exempt and this test
      // passes while asserting nothing.
      git('remote', 'add', 'origin', 'https://example.invalid/r.git');
      git('config', 'user.email', 't@t');
      git('config', 'user.name', 't');
      writeFileSync(join(repo, 'a.txt'), 'x');
      git('add', 'a.txt');
      git('commit', '-qm', 'init');

      const hook = wiredLocalHooks().find((f) => f.includes('guard-bash'));
      expect(hook, 'no guard-bash launcher is wired').toBeTruthy();
      const fire = (env = {}) =>
        spawnSync('node', [hook], {
          input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git commit -m x' } }),
          cwd: repo,
          env: { ...hermeticEnv(), ...env },
          encoding: 'utf8',
        });

      const onMain = fire();
      expect(onMain.status, `expected a block on main, got ${onMain.status}: ${onMain.stderr}`).toBe(2);

      // The on-branch half removes the alternative explanation — a guard that blocks everything would
      // pass the assertion above while guarding nothing in particular.
      git('switch', '-qc', 'feat/tkt-abcdef123456-x');
      expect(fire().status, 'the same command must be allowed on a feature branch').toBe(0);

      // The highest-consequence rule in the guard: an unresolvable branch must BLOCK, because every
      // way of breaking `git rev-parse` would otherwise be a commit-to-main bypass (tkt-fbc74a3252fe).
      // Run on the feature branch, where the case above proves the command is otherwise allowed.
      const blinded = fire({ GIT_CEILING_DIRECTORIES: repo, GIT_CONFIG_PARAMETERS: "'garbage'" });
      expect(blinded.status, `an unresolvable branch must fail CLOSED, got ${blinded.status}`).toBe(2);

      // A payload the guard cannot PARSE is the other way it can be blinded, and since
      // ticket-workflow v0.25.0 it fails closed on every command rather than only commit/push
      // (tkt-9782083b72c2). Before that the catch exited 0, so an unreadable payload waved through
      // `git commit` on main. Nothing else in this repo pins it: a revert to fail-open upstream
      // would restore that bypass with the whole suite green.
      const unparseable = spawnSync('node', [hook], {
        input: 'not json',
        cwd: repo,
        env: hermeticEnv(),
        encoding: 'utf8',
      });
      expect(unparseable.status, `an unreadable payload must fail CLOSED, got ${unparseable.status}`).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // The hardpack-workflow skill's foreign-repo mode (tkt-9a3afc5b9f4f) rests on ONE claim: a command
  // carrying `cd <target>` is judged against the TARGET's branch, so never-commit-to-main still
  // applies to the repo actually being written. That is a claim about code in this repo, so it
  // belongs in a test rather than in SKILL.md prose (CLAUDE.md -> Writing these documents).
  // Both directions are asserted: blocking-on-cd alone is equally consistent with a guard that
  // blocks any cd, which would make foreign mode unusable rather than safe.
  it('judges a cd-carrying command against the target repo, in both directions', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'audit-guard-cd-'));
    try {
      const make = (name, branch) => {
        const dir = join(tmp, name);
        const git = (...args) => execFileSync('git', args, { cwd: dir, env: hermeticEnv(), encoding: 'utf8' });
        execFileSync('git', ['init', '-q', '-b', 'main', dir], { env: hermeticEnv() });
        git('remote', 'add', 'origin', 'https://example.invalid/r.git'); // protected-branch rules need one
        git('config', 'user.email', 't@t');
        git('config', 'user.name', 't');
        writeFileSync(join(dir, 'a.txt'), 'x');
        git('add', 'a.txt');
        git('commit', '-qm', 'init');
        if (branch) git('switch', '-qc', branch);
        return dir;
      };
      const onBranch = make('sess', 'feat/tkt-abcdef123456-x');
      const onMain = make('targ', null);
      const spaced = make('has space', null); // `make` joins, so the space lands in the path

      const hook = wiredLocalHooks().find((f) => f.includes('guard-bash'));
      expect(hook, 'no guard-bash launcher is wired').toBeTruthy();
      // `cwd` goes in the PAYLOAD as well as on the process: guard-bash reads `payload?.cwd ??
      // process.cwd()`, and the runtime always sends the field, so a payload-less fixture would
      // exercise a fallback production never takes.
      const run = (cwd, command) =>
        spawnSync('node', [hook], {
          input: JSON.stringify({ cwd, tool_name: 'Bash', tool_input: { command } }),
          cwd,
          env: hermeticEnv(),
          encoding: 'utf8',
        });
      const fire = (cwd, command) => run(cwd, command).status;

      // Session is on a feature branch, so the session's own branch would ALLOW. Only reading the
      // cd target's branch produces a block — this is the assertion foreign mode's safety rests on.
      expect(fire(onBranch, 'git commit -m x'), 'plain commit on a feature branch must be allowed').toBe(0);
      const blocked = run(onBranch, `cd ${onMain} && git commit -m x`);
      expect(blocked.status, 'a cd into a repo on main must be blocked, judged by the TARGET branch').toBe(2);
      // Exit 2 has four sources here, two of them "cannot determine" — so the status alone would stay
      // green if branch resolution broke and the target-branch judgement stopped happening.
      expect(blocked.stderr, `blocked for the wrong reason: ${blocked.stderr}`).toMatch(/commits to main/i);

      // The reverse: session on main, cd into a feature branch. A guard that merely blocked any cd,
      // or that read only the session, would fail here — and foreign mode would be dead in practice.
      expect(fire(onMain, 'git commit -m x'), 'plain commit on main must be blocked').toBe(2);
      expect(
        fire(onMain, `cd ${onBranch} && git commit -m x`),
        'a cd into a repo on a feature branch must be allowed even when the session sits on main',
      ).toBe(0);

      // KNOWN FAIL-OPEN, pinned deliberately. `resolveDir` returns null for a target it cannot
      // parse, and the guard falls back to the SESSION's branch — in foreign mode the permissive
      // answer. Only the UNQUOTED split still falls through at the pinned build; v0.23.0 (#76-#78)
      // dequoted the parser and latched an unnameable `cd` closed, so the quoted and variable
      // spellings now block and are pinned as such below. This is why SKILL.md §1 still refuses such
      // a target and §2a still mandates a literal path; if upstream fixes this one too, it goes red
      // and that instruction can be relaxed. Deleting the instruction while this still passes would
      // reopen a real hole (tkt-9a3afc5b9f4f, code review finding 1).
      expect(
        fire(onBranch, `cd ${spaced} && git commit -m x`),
        'if this now BLOCKS, guard-bash parses spaced targets — relax SKILL.md §1/§2a to match',
      ).toBe(0);

      // The spellings v0.23.0 DID fix, pinned so a regression is visible. Asserting only the row
      // above reported "unchanged" for dimensions this suite never varied, while the guarantee moved
      // underneath it — quoted and variable are separate dimensions of the same fail-open, not
      // restatements of it (tkt-20abb1a93afe, review finding 2).
      for (const target of [`"${spaced}"`, `'${spaced}'`]) {
        expect(
          fire(onBranch, `cd ${target} && git commit -m x`),
          `a quoted cd target on main must be judged, not fall back to the session: ${target}`,
        ).toBe(2);
      }
      expect(
        fire(onBranch, 'cd $TARGET && git commit -m x'),
        'an unresolvable variable cd target must fail CLOSED, not judge the session',
      ).toBe(2);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // guard-ticket needs its own behavioural case: the shape test above is satisfied by a path in a
  // COMMENT, so a launcher hollowed out to `process.exit(0)` would leave create_ticket unguarded —
  // defeating the metered-intake gate — with every other assertion here still green.
  it('blocks create_ticket through the wired launcher, and allows an unrelated tool', () => {
    const hook = wiredLocalHooks().find((f) => f.includes('guard-ticket'));
    expect(hook, 'no guard-ticket launcher is wired').toBeTruthy();
    const fire = (tool_name) =>
      spawnSync('node', [hook], {
        input: JSON.stringify({ tool_name, tool_input: { title: 'x' } }),
        env: hermeticEnv(),
        encoding: 'utf8',
      });

    const blockedCall = fire('mcp__kanban__create_ticket');
    expect(blockedCall.status, `expected a block, got ${blockedCall.status}: ${blockedCall.stderr}`).toBe(2);
    // Removes the "blocks everything, including on a failed import" explanation.
    expect(fire('mcp__kanban__get_ticket').status, 'an unrelated tool must be allowed').toBe(0);
  });

  // CLAUDE.md ("What guards `gh` is not nothing") asserts that the pinned package's own guard never
  // inspects `gh`, and derives a real conclusion from it (on the main thread with no night run
  // active, nothing enforces the merge gate). It was a hand-run grep, so it went stale the moment
  // upstream chose to add one. Generated, not transcribed (tkt-4de2f4a839b7, tkt-6916ee90b044).
  it('pins CLAUDE.md\'s claim that guard-bash does not inspect `gh`', () => {
    const packaged = join(dirname(createRequire(import.meta.url).resolve('ticket-workflow')), '..', 'hooks', 'guard-bash.mjs');
    const src = readFileSync(packaged, 'utf8');
    const GH_TOKEN = /\bgh\b/g;
    // The control first: a bare /\bgh\b/ silently fails to match inside "through"/"right", so a typo'd
    // pattern would report a clean zero forever. Prove it fires on the shape being ruled out.
    expect('gh pr merge 40 --squash'.match(GH_TOKEN), 'the detector cannot see a gh command').toHaveLength(1);
    expect('a through-and-through rightful thought'.match(GH_TOKEN), 'the detector matches inside words').toBeNull();

    expect(
      src.match(GH_TOKEN),
      'the pinned guard-bash now references `gh` — CLAUDE.md says it never does, and concludes from ' +
        'that nothing enforces the merge gate on the main thread with no night run active. ' +
        'Re-measure, then fix both the claim and the conclusion it feeds.',
    ).toBeNull();
  });

  // `gh pr merge` lands a commit on main SERVER-SIDE with no `git push`, so guard-bash's pushesMain
  // rule is never consulted and the merge sails past it — watched on the previously pinned build:
  // exit 0 (tkt-e508ad42a68a). v0.16.0's guard-subagent-gates closes the half that has no human at the
  // keyboard. Asserted here because it is the pin that decides whether the file exists at all.
  //
  // Scope, stated so this is not read as more than it is: this drives the hook out of the PINNED
  // PACKAGE, not out of `.claude/settings.json`. guard-subagent-gates is wired at USER scope
  // (machine-local, unversioned), so nothing in this repo can assert it is armed — only that the build
  // hardpack pins still refuses. Hence no wiredLocalHooks() lookup.
  it('refuses a subagent `gh pr merge` through the pinned build, and allows the main thread', () => {
    const hook = join(dirname(createRequire(import.meta.url).resolve('ticket-workflow')), '..', 'hooks', 'guard-subagent-gates.mjs');
    expect(existsSync(hook), `the pinned build ships no guard-subagent-gates (${hook})`).toBe(true);
    const fire = (command, extra) =>
      spawnSync('node', [hook], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, ...extra }),
        env: hermeticEnv(),
        encoding: 'utf8',
      });

    const sub = { agent_id: 'agent_audit', agent_type: 'code-reviewer' };
    const merge = fire('gh pr merge 40 --squash --delete-branch', sub);
    expect(merge.status, `expected a block, got ${merge.status}: ${merge.stderr}`).toBe(2);

    // Two controls, because there are two ways this could block for the wrong reason. Without the
    // first it could be a block-all-`gh` guard; without the second, a guard that blocks the command
    // rather than the CALLER — which would wedge this repo's own merge gate.
    expect(fire('gh pr view 40 --json state', sub).status, 'a gh READ must stay allowed').toBe(0);
    expect(fire('gh pr merge 40 --squash', {}).status, 'the main thread must stay allowed').toBe(0);
  });

});

// A `deny` rule outranks every `allow`, including one a future edit adds. FORBIDDEN above rejects a
// rule SPELLING and says nothing about what a session may run, so these three need this list too
// (tkt-a9b55cabbc92).
//
// SCOPE, because this block is easy to over-read: it denies three shell binaries under the single
// spelling `Bash(<binary> …)`. It does NOT deny the capability — `/usr/bin/curl …`, `sh -c "curl …"`
// and `xargs curl` all miss it, and `npx playwright`, `npx vitest` and any inline `node -e` reach the
// network without touching it at all. Narrowing the local `Bash(node *)` wildcard is what covers
// inline code. Neither measure subsumes the other and neither is a boundary.
const REQUIRED_DENY = ['Bash(curl *)', 'Bash(wget *)', 'Bash(nc *)'];
const deny = settings.permissions?.deny ?? [];

// `Bash(curl …)` → `curl`. This one spelling is all a rule string makes checkable.
const deniedBinaries = REQUIRED_DENY.map((r) => /^Bash\(([\w-]+)/.exec(r)?.[1]).filter(Boolean);
const contradicts = (rules) => rules.filter((r) => deniedBinaries.some((b) => r.startsWith(`Bash(${b} `)));

describe('.claude/settings.json permission denylist', () => {
  it('is a well-formed list of non-empty string rules', () => {
    expect(Array.isArray(deny)).toBe(true);
    for (const rule of deny) {
      expect(typeof rule, `${JSON.stringify(rule)} is not a string`).toBe('string');
      expect(rule.trim(), 'blank rule').not.toBe('');
    }
  });

  // `?? []` makes an ABSENT key and an empty array fail identically — deleting the block must not
  // read as satisfying it.
  it('carries every shape in REQUIRED_DENY, so none is re-grantable by a later allow', () => {
    expect(deny, 'do not remove an egress shape without retaking tkt-a9b55cabbc92').toEqual(
      expect.arrayContaining(REQUIRED_DENY),
    );
  });

  // The control: proves the matcher above fires on a short list, so its green means the entries are
  // really present rather than that arrayContaining never discriminates.
  it('the requirement discriminates — a list missing one shape does not satisfy it', () => {
    expect(REQUIRED_DENY.length).toBeGreaterThan(0);
    expect(() =>
      expect(REQUIRED_DENY.slice(1)).toEqual(expect.arrayContaining(REQUIRED_DENY)),
    ).toThrow();
  });

  // deny wins at runtime, so this catches unreadable config rather than a live hole. It matches ONE
  // spelling: `Bash(/usr/bin/curl *)` and `Bash(xargs curl *)` pass it and are not thereby safe.
  it('grants no allow rule spelled Bash(<denied binary> …)', () => {
    expect(deniedBinaries.length, 'deny rules stopped parsing as Bash(<binary> …)').toBe(REQUIRED_DENY.length);
    expect(contradicts(allow)).toEqual([]);
  });
});

// The BROADEST permissions actually in effect were the ones nothing checked (tkt-fa2bd5a7a455).
// `.claude/settings.local.json` granted `Bash(node *)` and `Bash(npm install *)` — blanket arbitrary
// execution — and it is gitignored GLOBALLY via ~/.config/git/ignore, so the audit above and CI are
// both blind to it. Two facts make that matter: `guard-bash` contains zero references to npm or node
// (measured), so those rules have no runtime backstop at all; and `.husky/pre-commit` runs `npm test`,
// so a test here gates every local commit.
//
// tkt-a9b55cabbc92 narrowed both. The chain that decided it: a ticket body reaches the session as
// unmarked context (tkt-0e885b80e794), is authored by the local intake model from arbitrary report
// text, and `node -e "fetch(…)"` under a blanket rule reaches the network with no prompt and no hook.
// Path-scoped rules keep that gate on inline code while leaving reviewed repo scripts unprompted.
//
// This can never be a CI gate — the file is legitimately absent there. What it must not do is pass
// VACUOUSLY in that case, so the mode is asserted explicitly rather than skipped.
describe('.claude/settings.local.json (machine-local, audited only where it exists)', () => {
  const localPath = new URL('./settings.local.json', import.meta.url);
  const present = existsSync(localPath);
  const localAllow = present
    ? (JSON.parse(readFileSync(localPath, 'utf8')).permissions?.allow ?? [])
    : null;

  // A wildcard that ends the rule is the dangerous shape: `Bash(npm run *)` admits any script. One
  // inside the quoted body of a MESSAGE flag (`Bash(git commit -m ' *)`) is prose, not a subcommand.
  // The flag list is the whole guard: exempting any quote let `Bash(node -e ' *)` — the rule Claude
  // Code writes for `node -e 'code'` — evade REVIEWED_LOCAL_WILDCARDS entirely (tkt-a9b55cabbc92).
  const isOpenEnded = (rule) =>
    /\*\s*\)$/.test(rule) && !/(?:^|\s)--?(?:m|body|title|message)\s+'[^']*\*/.test(rule);

  // Reviewed and deliberate. Each is Jake's own local choice; the point of the list is that a NEW one
  // has to be added here consciously rather than arriving unnoticed.
  const REVIEWED_LOCAL_WILDCARDS = new Set([
    'Bash(git push *)', 'Bash(git add *)', 'Bash(git switch *)', 'Bash(git pull *)', // git: guard-bash-backed
    'Bash(gh pr *)', 'Bash(npx playwright *)', 'Bash(npx vitest *)', 'Bash(npm test *)',
    'Bash(npm run *)', // NO runtime backstop — see the header
    // Path-scoped replacements for `Bash(node *)` / `Bash(npm install *)`, which were REMOVED from
    // this set rather than merely dropped from the file — re-adding either must come back through
    // here (tkt-a9b55cabbc92). What they buy is that inline `node -e` now prompts. They are a PREFIX
    // match, so `node scripts/probe/../../x.js` still runs: this narrows accidents, not an attacker
    // who already controls the command string. `Bash(node_modules/.bin/tsx *)` was tried here and
    // rejected — `tsx -e` is blanket arbitrary execution, measured.
    'Bash(node scripts/probe/*)', 'Bash(node "$CLAUDE_PROJECT_DIR/scripts/probe/*)',
  ]);

  it('records whether it evaluated anything, so an absent file is not a silent pass', () => {
    // The three-outcome discipline in its smallest form: this is 'audited' or 'absent', never an
    // unexamined green. In CI it is 'absent' and the assertions below have nothing to check — which is
    // a fact about the environment, and is stated rather than hidden.
    expect(present ? 'audited' : 'absent').toMatch(/^(audited|absent)$/);
    if (!present) expect(localAllow).toBeNull();
  });

  it.runIf(present)('grants no open-ended wildcard that has not been reviewed here', () => {
    const unreviewed = localAllow.filter((r) => isOpenEnded(r) && !REVIEWED_LOCAL_WILDCARDS.has(r));
    expect(unreviewed, 'add it to REVIEWED_LOCAL_WILDCARDS deliberately, or narrow the rule').toEqual([]);
  });

  // The array the header above says nothing was checking. deny still wins at runtime; this surfaces
  // the contradiction where CI cannot see it.
  it.runIf(present)('grants no local allow rule spelled Bash(<denied binary> …)', () => {
    expect(contradicts(localAllow)).toEqual([]);
  });

  it.runIf(present)('rejects the same dangerous tokens as the checked-in file', () => {
    // The local file is not a lower standard — it is just invisible to CI.
    for (const rule of localAllow) {
      for (const token of FORBIDDEN) {
        expect(rule.includes(token), `${rule} contains "${token}"`).toBe(false);
      }
    }
  });

  // The control. A detector that matched nothing would pass every local file forever, which is the
  // vacuous shape this whole block exists to avoid — so prove it fires and prove it discriminates.
  it('detects open-ended wildcards, and does not fire on a quoted message body', () => {
    for (const rule of ['Bash(npm run *)', 'Bash(node *)', 'Bash(gh pr *)', 'Bash(npx playwright *)']) {
      expect(isOpenEnded(rule), rule).toBe(true);
    }
    for (const rule of ["Bash(git commit -m ' *)", 'Bash(npm test)', 'Bash(npm run lint)', 'mcp__kanban__get_ticket']) {
      expect(isOpenEnded(rule), rule).toBe(false);
    }
  });
});

describe('.claude/settings.json permission allowlist — hook backstops', () => {
  // Guards are per-repo (duplicates decide identically); WRITERS are per-machine — a second track-steps
  // double-writes every milestone (1,889 rows, 2026-07-17..08-13; tkt-af4669ce9a0d).
  // Detects OVER-wiring only: the surviving writer is machine-local, so its removal is silent here.
  it('wires NO PostToolUse track-steps hook (the writer belongs at user scope, exactly once)', () => {
    const matchers = settings.hooks?.PostToolUse ?? [];
    const commands = matchers.flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    expect(commands.filter((c) => c.includes('track-steps'))).toEqual([]);
  });
});

// SessionStart runs before the session is usable, so this hook's failure mode is degrading EVERY
// startup in the repo (tkt-4ea4e17f1419). Its logic is covered in .claude/hooks/night-report.test.mjs;
// what only this file can assert is that the wired path exists and that running it is actually safe.
describe('.claude/settings.json SessionStart night-report hook', () => {
  const sessionStartCommands = () =>
    (settings.hooks?.SessionStart ?? []).flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));

  it('wires night-report, and the file it names is on disk', () => {
    const commands = sessionStartCommands();
    expect(commands.some((c) => c.includes('night-report'))).toBe(true);
    for (const rel of commands.map((c) => /\$CLAUDE_PROJECT_DIR\/(\.claude\/hooks\/[\w.-]+\.mjs)/.exec(c)?.[1]).filter(Boolean)) {
      expect(existsSync(join(REPO_ROOT, rel)), `${rel} is wired in settings.json but missing on disk`).toBe(true);
    }
  });

  // A hook with no timeout can hang the startup it runs in, which is the documented rollback trigger.
  it('bounds every SessionStart hook with a timeout', () => {
    const entries = (settings.hooks?.SessionStart ?? []).flatMap((m) => m.hooks ?? []);
    expect(entries.length).toBeGreaterThan(0); // else the assertion below is vacuous
    for (const h of entries) expect(typeof h.timeout, `${h.command} has no timeout`).toBe('number');
  });

  // Verify the EFFECT, not the wiring: drive the actually-wired file and watch it exit 0 with a
  // well-formed payload. Unit tests inject their own root, so this is the only check that the real
  // file's imports resolve and that it does not throw against the real checkout.
  it('runs clean against the real checkout, emitting nothing or a valid SessionStart payload', () => {
    const hook = join(REPO_ROOT, '.claude', 'hooks', 'night-report.mjs');
    const res = spawnSync(process.execPath, [hook], { encoding: 'utf8', env: hermeticEnv(), timeout: 20_000 });

    expect(res.status, `hook exited ${res.status}: ${res.stderr}`).toBe(0);
    if (res.stdout.trim()) {
      const payload = JSON.parse(res.stdout);
      expect(payload.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(typeof payload.hookSpecificOutput.additionalContext).toBe('string');
      // Without this the check is VACUOUS: main() returns 0 unconditionally and its catch-all emits
      // exactly the two fields asserted above, so a hook that throws on every startup would pass
      // (review, MEDIUM). This is the one string only the failure path can produce.
      expect(
        payload.hookSpecificOutput.additionalContext,
        'the hook threw on the real checkout and reported it as a normal payload',
      ).not.toContain('the night-run check threw');
    }
  });
});

// The machine-wide runtime at ~/.claude/tools carries its OWN ticket-workflow pin, invisible to every
// repo's audit — so it skews silently. Found 2026-08-18 at v0.16.0 against repos on v0.18.0+: the
// NUL-byte write guard was live only for hardpack-rooted sessions, while every other repo drove the
// central board through a server without it (tkt-876ab4261e69).
//
// That install is where the USER-SCOPE guards actually resolve from: ~/.claude/settings.json wires
// each one as `run-hook.mjs <name> <closed|open>`, which imports `ticket-workflow/hooks/<name>.mjs`
// from this prefix. So its version is not a detail of one repo — it is the version of guard-bash on
// the machine.
//
// Like the settings.local.json block above, this can never be a CI gate: ~/.claude/tools is
// legitimately absent there. Every read below therefore happens INSIDE a test, never in this describe
// body — an unguarded JSON.parse out here fails the whole FILE with a SyntaxError naming no path,
// taking every settings.json and guard-bash assertion with it, and .husky/pre-commit runs `npm test`,
// so that would block every local commit while pointing at nothing.
describe('~/.claude/tools ticket-workflow pin (machine-local runtime, audited only where it exists)', () => {
  const TOOLS_DIR = join(homedir(), '.claude', 'tools');
  const toolsPkg = join(TOOLS_DIR, 'package.json');
  const toolsInstalledPkg = join(TOOLS_DIR, 'node_modules', 'ticket-workflow', 'package.json');
  const userSettings = join(homedir(), '.claude', 'settings.json');

  // Presence keys on EITHER file. The thing that guards the machine is the node_modules tree, and
  // run-hook.mjs resolves into it by walking up — it needs no package.json at the prefix. Keying on
  // the pin file alone reports a live, LOADING, stale install as "absent" and skips every assertion
  // below, which is precisely the skew this block exists to catch.
  const present = existsSync(toolsPkg) || existsSync(toolsInstalledPkg);

  const VERSION = /^v\d+\.\d+\.\d+(?:-[\w.]+)?$/; // prerelease pins are legitimate, e.g. v0.20.0-rc.1

  // Returns null rather than a fallback: a spec this cannot read must never compare EQUAL to another
  // one it also cannot read.
  const parsePin = (spec) => /#(v\d+\.\d+\.\d+(?:-[\w.]+)?)$/.exec(spec ?? '')?.[1] ?? null;

  const readJson = (p) => {
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch (err) {
      // Fail THIS assertion with the path, rather than throwing out of the file.
      return expect.fail(`${p} is not readable JSON: ${err.message}`);
    }
  };

  const pinnedTag = (pkgPath) => {
    const pkg = readJson(pkgPath);
    return parsePin({ ...pkg.dependencies, ...pkg.devDependencies }['ticket-workflow']);
  };

  const repoTag = () => pinnedTag(join(REPO_ROOT, 'package.json'));

  // "absent" must cost something locally, or finding a missing runtime reads as a normal green.
  it('treats a missing machine-wide runtime as a failure anywhere but CI', () => {
    if (present) return;
    expect(process.env.CI, `${TOOLS_DIR} is missing and this is not CI — the user-scope guards are not installed`).toBeTruthy();
  });

  // Guards the comparisons below against their own vacuous mode: two unreadable specs both parse to
  // null, and null === null would pass forever with nothing pinned at all.
  it('reads this repo\'s own pin, so the comparison has a real reference value', () => {
    expect(repoTag(), 'could not parse a ticket-workflow git tag from this repo\'s package.json').toMatch(VERSION);
  });

  it.runIf(present)('pins the same tag this repo does', () => {
    expect(existsSync(toolsPkg), `${TOOLS_DIR} has an install but no package.json to pin it`).toBe(true);
    const tag = pinnedTag(toolsPkg);
    expect(tag, `${toolsPkg} has no readable ticket-workflow git-tag pin`).toMatch(VERSION);
    expect(tag, 'bump ~/.claude/tools in the same pass as this repo (memory project_user_scope_tools_install)').toBe(repoTag());
  });

  // The tag is what was REQUESTED; this is what is actually loaded. npm can satisfy a bumped git tag
  // from a cached sha and leave the old build in place (reference_npm_git_pin_cached_resolution), so a
  // tag-only assertion would pass on exactly the install this ticket was filed about.
  it.runIf(present)('has that tag INSTALLED, not merely requested', () => {
    expect(existsSync(toolsInstalledPkg), `no ticket-workflow installed under ${TOOLS_DIR}`).toBe(true);
    expect(`v${readJson(toolsInstalledPkg).version}`, 'npm resolved the pin from cache — reinstall and re-verify the installed version').toBe(repoTag());
  });

  // Same requested-vs-loaded hazard, applied to the install THIS repo's guard-bash launcher and
  // packageContract.test.ts resolve from. repoTag() is only what was requested; nothing else asserts
  // what is actually on disk here.
  it('has this repo\'s own pin INSTALLED too', () => {
    const installed = join(REPO_ROOT, 'node_modules', 'ticket-workflow', 'package.json');
    expect(existsSync(installed), 'this repo has no ticket-workflow installed').toBe(true);
    expect(`v${readJson(installed).version}`, 'run npm install — the installed build is not the pinned tag').toBe(repoTag());
  });

  // Derived from the wiring, not retyped: a guard added at user scope tomorrow must not be silently
  // unaudited by a test whose name promises "every hook the dispatcher resolves".
  const dispatchedHooks = () => {
    const s = readJson(userSettings);
    const commands = Object.values(s.hooks ?? {})
      .flat()
      .flatMap((m) => (m.hooks ?? []).map((h) => h.command ?? ''));
    return [...new Set(commands.map((c) => /run-hook\.mjs\s+([\w-]+)\s+(?:closed|open)/.exec(c)?.[1]).filter(Boolean))];
  };

  // existsSync is NOT the resolution run-hook.mjs performs: it imports the bare specifier
  // `ticket-workflow/hooks/<name>.mjs`, and the package declares an explicit per-hook `exports` map.
  // A hook dropped from `exports` while the file still sits on disk throws ERR_PACKAGE_PATH_NOT_EXPORTED
  // at runtime. What that costs differs per hook and the difference is worth knowing when this goes
  // red: four are wired `closed`, but only guard-bash and guard-subagent-gates match Bash, so only
  // those two block a Bash call — including the npm install that would fix it. guard-ticket gates an
  // MCP tool and guard-review-target is a UserPromptExpansion hook, so those two fail closed on their
  // own trigger only; warn-stale-worktree is `open` and merely records nothing.
  it.runIf(present)('exports every hook the user-scope dispatcher imports', () => {
    const hooks = dispatchedHooks();
    expect(hooks.length, `parsed no run-hook.mjs wiring out of ${userSettings} — the matcher has gone stale`).toBeGreaterThan(0);
    const resolveFrom = createRequire(join(TOOLS_DIR, 'hooks', 'run-hook.mjs'));
    const unresolvable = hooks.filter((h) => {
      try {
        resolveFrom.resolve(`ticket-workflow/hooks/${h}.mjs`);
        return false;
      } catch {
        return true;
      }
    });
    expect(unresolvable, 'run-hook.mjs imports these by bare specifier and cannot load them').toEqual([]);
  });

  // The control, bound to the REAL parser via fixture files — a hand-copied regex here would pass
  // every mutation to pinnedTag, which is the shape that let v0.16.0 sit against v0.18.0 unnoticed.
  it('extracts a pin from a real package.json, tells two versions apart, and refuses to guess', () => {
    const dir = mkdtempSync(join(tmpdir(), 'audit-pin-'));
    try {
      const fixture = (name, spec) => {
        const p = join(dir, name);
        writeFileSync(p, JSON.stringify(spec === null ? { dependencies: {} } : { dependencies: { 'ticket-workflow': spec } }));
        return p;
      };
      expect(pinnedTag(fixture('a.json', 'github:mcinerneyjake/ticket-workflow#v0.19.0'))).toBe('v0.19.0');
      expect(pinnedTag(fixture('b.json', 'github:mcinerneyjake/ticket-workflow#v0.16.0')))
        .not.toBe(pinnedTag(fixture('c.json', 'github:mcinerneyjake/ticket-workflow#v0.19.0')));
      for (const spec of ['', '^1.2.3', 'github:mcinerneyjake/ticket-workflow', 'github:mcinerneyjake/ticket-workflow#main', null]) {
        expect(pinnedTag(fixture('d.json', spec)), `${spec} is not a version pin and must not parse as one`).toBeNull();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
