import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  classifyArm, decide, assertInstruments, exitCodeFor, armPlan, questionFor, assertProjectDir,
  assertScope, assertNeutralDir, probe,
  ARM, VERDICT, SCOPE, DEFAULT_QUESTION, DEFAULT_MARKER, PROJECT_QUESTION, PROJECT_MARKER_PHRASES,
} from './clean-room.mjs';

// tkt-b86d2a318f8b — this probe exists so that "I could not determine this" is never reported
// as "no instructions were loaded". Everything below pins that one property, because it is the
// only failure that matters and the one a green suite would otherwise hide.

const HERE = dirname(fileURLToPath(import.meta.url));

describe('classifyArm', () => {
  it.each([['YES'], ['yes'], ['Yes.'], ['YES\n']])('reads %s as the marker being present', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.PRESENT);
  });

  it.each([['NO'], ['no'], ['No.'], ['NO\n']])('reads %s as the marker being absent', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.ABSENT);
  });

  // Every AUTH_BLOCKED pattern gets its own case. The previous suite pinned one of seven:
  // the rest were already caught by the strict-answer fallthrough, so deleting them left it green.
  // These strings each carry a bare answer in stdout, so ONLY the auth scan can classify them.
  it.each([
    ['Not logged in · Please run /login'],
    ['Please run /login to continue'],
    ['Failed to authenticate.'],
    ['API Error: 401 unauthorized'],
    ['Invalid API key provided'],
    ['API key is invalid.'],
    ['Your credit balance is too low'],
  ])('treats %s on stderr as BLOCKED even when stdout carries a clean NO', (stderr) => {
    expect(classifyArm({ stdout: 'NO', stderr, status: 0 })).toBe(ARM.BLOCKED);
  });

  // The bare /401/ this replaced matched the digit sequence anywhere, including a real answer.
  it('does not treat a model answer mentioning 401 as an auth failure', () => {
    expect(classifyArm({ stdout: 'NO', stderr: 'note: 401 tickets were scanned' })).toBe(ARM.ABSENT);
  });

  // THE class of bug the strict match exists for: prose that merely contains "no".
  it.each([
    ['Error: no credentials configured for this workspace.'],
    ['API Error: 429 rate_limit_error. No response available.'],
    ["I can't see my loaded instructions, so no."],
    ['Yes and no, it depends'],
    [''],
    ['   '],
  ])('treats %s as BLOCKED rather than guessing absent', (stdout) => {
    expect(classifyArm({ stdout })).toBe(ARM.BLOCKED);
  });

  it('treats a non-zero exit as BLOCKED even when the output looks like an answer', () => {
    expect(classifyArm({ stdout: 'NO', status: 1 })).toBe(ARM.BLOCKED);
  });

  it('treats a spawn failure as BLOCKED', () => {
    expect(classifyArm({ stdout: '', stderr: 'spawnSync claude ENOENT', status: 1 })).toBe(ARM.BLOCKED);
  });

  it('defaults to BLOCKED when called with nothing at all', () => {
    expect(classifyArm()).toBe(ARM.BLOCKED);
  });
});

describe('decide', () => {
  it('reports CLEAN only for the one pair that earns it', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT }).verdict).toBe(VERDICT.CLEAN);
  });

  it('reports BLOCKED, not CLEAN, when the isolated arm could not run', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.BLOCKED }).verdict).toBe(VERDICT.BLOCKED);
  });

  it('reports NOT_ISOLATED when the isolated arm still loaded instructions', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.PRESENT }).verdict).toBe(VERDICT.NOT_ISOLATED);
  });

  it.each([[ARM.ABSENT], [ARM.BLOCKED]])('reports INSTRUMENT_BROKEN when the control is %s', (control) => {
    expect(decide({ control, cleanroom: ARM.ABSENT }).verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  // decide() previously used CLEAN as its fall-through, so an unrecognised or missing arm value
  // — a future classifyArm outcome, a partially-built object — became the permissive answer.
  it.each([
    ['an unknown future outcome', 'TIMEOUT'],
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a lowercase near-miss', 'marker_absent'],
  ])('reports BLOCKED, not CLEAN, for %s as the isolated arm', (_label, cleanroom) => {
    expect(decide({ control: ARM.PRESENT, cleanroom }).verdict).toBe(VERDICT.BLOCKED);
  });

  it('reports INSTRUMENT_BROKEN when called with no arms at all', () => {
    expect(decide().verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });

  // The exhaustive guarantee: CLEAN is reachable from exactly one input pair.
  it('returns CLEAN for exactly one combination across every arm value', () => {
    const values = [...Object.values(ARM), 'TIMEOUT', undefined, null, ''];
    const clean = [];
    for (const control of values) {
      for (const cleanroom of values) {
        if (decide({ control, cleanroom }).verdict === VERDICT.CLEAN) clean.push([control, cleanroom]);
      }
    }
    expect(clean).toEqual([[ARM.PRESENT, ARM.ABSENT]]);
  });
});

describe('exitCodeFor', () => {
  // This is the line that authorizes an A/B to proceed, and it was previously unpinned:
  // mutating it to a bare exit(0) left the whole suite green.
  it('exits 0 only for CLEAN', () => {
    expect(exitCodeFor(VERDICT.CLEAN)).toBe(0);
  });

  it.each([[VERDICT.BLOCKED], [VERDICT.NOT_ISOLATED], [VERDICT.INSTRUMENT_BROKEN], ['anything else'], [undefined]])(
    'exits non-zero for %s',
    (verdict) => {
      expect(exitCodeFor(verdict)).not.toBe(0);
    },
  );
});

describe('assertInstruments', () => {
  it('passes on the real module', () => {
    expect(() => assertInstruments()).not.toThrow();
  });
});

describe('CLI entrypoint', () => {
  // The main-module guard was `file://${process.argv[1]}`, which fails to match whenever the
  // path needs URL-escaping — so the CLI silently did nothing and exited 0, the fail-open
  // reading, from a probe that never ran an arm. A space is the cheapest reproduction.
  it('still runs from a path containing a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clean room probe-'));
    try {
      const copy = join(dir, 'cr.mjs');
      copyFileSync(join(HERE, 'clean-room.mjs'), copy);
      let stdout = '';
      let status = 0;
      try {
        // --question with no value exits 1 before spawning any session, so this exercises the
        // entrypoint without burning a model call.
        stdout = execFileSync(process.execPath, [copy, '--question'], { encoding: 'utf8', stdio: 'pipe' });
      } catch (e) {
        status = e.status;
        stdout = `${e.stdout ?? ''}${e.stderr ?? ''}`;
      }
      expect(status).toBe(1);            // it ran — a silent no-op would have exited 0
      expect(stdout).toContain('--question requires a value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// tkt-2a7055ddd5ea — the arm LAYOUT is as load-bearing as the answer classification. A control
// arm that never reached the repo, or an isolated arm that did, still produces a confident
// verdict; nothing downstream can tell. Everything below pins which directory each arm gets.

const NEUTRAL = '/neutral-tmp';
const REPO = '/some/repo';
const plan = (scope) => armPlan({ scope, projectDir: REPO, neutralDir: NEUTRAL });

describe('armPlan — user scope', () => {
  it('keeps BOTH arms in the neutral directory', () => {
    expect(plan(SCOPE.USER).control.cwd).toBe(NEUTRAL);
    expect(plan(SCOPE.USER).cleanroom.cwd).toBe(NEUTRAL);
  });

  // The directory leak this file was built to prevent: a project CLAUDE.md answering for the
  // control arm, so the control passes for the wrong reason.
  it('never lets the repository reach either arm', () => {
    const p = plan(SCOPE.USER);
    expect([p.control.cwd, p.cleanroom.cwd]).not.toContain(REPO);
  });

  it('isolates with --bare on the clean-room arm only', () => {
    expect(plan(SCOPE.USER).cleanroom.bare).toBe(true);
    expect(plan(SCOPE.USER).control.bare).toBe(false);
  });
});

describe('armPlan — project scope', () => {
  it('points the control arm at the repository', () => {
    expect(plan(SCOPE.PROJECT).control.cwd).toBe(REPO);
  });

  // "Do not simply point both arms at the repo" — if the isolated arm sees the project file too,
  // both arms answer YES and the rule is unattributable.
  it('keeps the isolated arm in the neutral directory', () => {
    expect(plan(SCOPE.PROJECT).cleanroom.cwd).toBe(NEUTRAL);
    expect(plan(SCOPE.PROJECT).cleanroom.cwd).not.toBe(REPO);
  });

  // --bare would strip user scope from one side only, so the arms would differ in TWO dimensions
  // and a CLEAN could not be attributed to the project file.
  it('uses --bare in neither arm, holding user scope constant', () => {
    expect(plan(SCOPE.PROJECT).control.bare).toBe(false);
    expect(plan(SCOPE.PROJECT).cleanroom.bare).toBe(false);
  });

  // Scoped deliberately: this pins the PLAN, whose only fields are cwd and bare. It is NOT
  // evidence that the two sessions differ in one respect — the cwd swap moves every cwd-derived
  // input at once (ancestor CLAUDE.md files, project settings, hooks, skills, MCP, memory), which
  // is why the CLEAN reason attributes to the working directory rather than the repo's own file.
  it('differs from the control in exactly one PLAN field — the cwd', () => {
    const { control, cleanroom } = plan(SCOPE.PROJECT);
    expect(Object.keys(control).sort()).toEqual(['bare', 'cwd']);
    const differing = Object.keys(control).filter((k) => control[k] !== cleanroom[k]);
    expect(differing).toEqual(['cwd']);
  });
});

describe('armPlan — the scope allowlist', () => {
  // The line that authorizes running a session with the repository as its cwd. A fall-through
  // here hands an unvalidated scope a pair of arms and reports a verdict about nothing.
  it.each([
    ['an unknown scope', 'repo'],
    ['a case near-miss', 'Project'],
    ['undefined', undefined],
    ['null', null],
    ['an empty string', ''],
    ['a number', 0],
  ])('throws rather than planning arms for %s', (_label, scope) => {
    expect(() => armPlan({ scope, projectDir: REPO, neutralDir: NEUTRAL })).toThrow(/unrecognised scope/);
  });

  it('throws when called with nothing at all', () => {
    expect(() => armPlan()).toThrow(/unrecognised scope/);
  });

  // The neutral directory must survive every valid scope — it moves between arms, it is never
  // dropped. A scope that used the repo for both arms would satisfy every other test here.
  it('gives every valid scope an arm in the neutral directory', () => {
    const scopes = Object.values(SCOPE);
    expect(scopes).toEqual([SCOPE.USER, SCOPE.PROJECT]);
    for (const scope of scopes) {
      const p = plan(scope);
      expect([p.control.cwd, p.cleanroom.cwd]).toContain(NEUTRAL);
    }
  });
});

describe('questionFor', () => {
  it('returns the user-scope question for user scope', () => {
    expect(questionFor(SCOPE.USER)).toBe(DEFAULT_QUESTION);
  });

  it('returns the project-scope question for project scope', () => {
    expect(questionFor(SCOPE.PROJECT)).toBe(PROJECT_QUESTION);
  });

  it.each([['unknown', 'repo'], ['undefined', undefined], ['empty', '']])(
    'throws rather than defaulting for %s scope',
    (_label, scope) => {
      expect(() => questionFor(scope)).toThrow(/unrecognised scope/);
    },
  );

  // Quoting the marker supplies the answer in the question: true by construction in every arm.
  it('does not quote the user-scope marker', () => {
    expect(DEFAULT_QUESTION.toLowerCase()).not.toContain(DEFAULT_MARKER.toLowerCase());
  });

  // The heading phrase alone was not enough: the first version of this question reproduced the
  // rule's BODY near-verbatim and this test still passed, because it checked only the heading.
  it('quotes no phrase from the project rule, heading or body', () => {
    expect(PROJECT_MARKER_PHRASES.length).toBeGreaterThanOrEqual(5);
    for (const phrase of PROJECT_MARKER_PHRASES) {
      expect(PROJECT_QUESTION.toLowerCase()).not.toContain(phrase.toLowerCase());
    }
  });

  it.each([[DEFAULT_QUESTION], [PROJECT_QUESTION]])('demands one bare word', (question) => {
    expect(question).toMatch(/exactly one word: YES or NO\.$/);
  });
});

describe('decide — scope changes the wording, never the verdict', () => {
  const ARM_VALUES = [...Object.values(ARM), 'TIMEOUT', undefined, null, ''];

  it('returns the same verdict for every valid scope across every arm pair', () => {
    expect(ARM_VALUES).toHaveLength(7);
    for (const control of ARM_VALUES) {
      for (const cleanroom of ARM_VALUES) {
        const user = decide({ control, cleanroom, scope: SCOPE.USER }).verdict;
        const project = decide({ control, cleanroom, scope: SCOPE.PROJECT }).verdict;
        expect(project).toBe(user);
      }
    }
  });

  // REASONS[verdict][scope] is a key lookup, so a prototype key answered with an inherited member
  // and `?? fallback` never fired: CLEAN came back carrying `Object.prototype.toString` as its
  // reason. Any other unknown scope silently emitted the USER reason, asserting --bare isolation
  // for a run that used no --bare.
  it.each([
    ['a prototype method', 'toString'],
    ['the prototype itself', '__proto__'],
    ['constructor', 'constructor'],
    ['an unknown scope', 'repo'],
    ['a case near-miss', 'Project'],
    ['null', null],
  ])('refuses %s as a scope rather than reasoning about it', (_label, scope) => {
    expect(() => decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT, scope })).toThrow(/unrecognised scope/);
  });

  it('never returns a non-string reason', () => {
    for (const scope of [SCOPE.USER, SCOPE.PROJECT]) {
      for (const control of ARM_VALUES) {
        for (const cleanroom of ARM_VALUES) {
          expect(typeof decide({ control, cleanroom, scope }).reason).toBe('string');
        }
      }
    }
  });

  it('defaults to user scope when none is given, preserving the existing reason', () => {
    expect(decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT }).reason).toBe(
      decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT, scope: SCOPE.USER }).reason,
    );
  });

  // A project verdict that recites the user-scope reason claims --bare isolation that never ran.
  it('does not describe a project-scope CLEAN as a user-scope isolation', () => {
    const { reason } = decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT, scope: SCOPE.PROJECT });
    expect(reason).toMatch(/project CLAUDE\.md/);
    expect(reason).not.toMatch(/--bare/);
    expect(reason).not.toMatch(/loads no user-scope instructions/);
  });

  // The cwd swap moves far more than the repo's own file — `level-up/CLAUDE.md` sits on the
  // upward chain from this repo (measured). A CLEAN that credits the project file alone sends the
  // next A/B to edit a file that may not carry the rule, which is the confound this probe exists
  // to prevent, reintroduced one level up.
  it('attributes a project-scope CLEAN to the working directory, not the project file alone', () => {
    const { reason } = decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT, scope: SCOPE.PROJECT });
    expect(reason).toMatch(/WORKING DIRECTORY/);
    expect(reason).toMatch(/any CLAUDE\.md above it/);
    expect(reason).toMatch(/NOT to the project CLAUDE\.md alone/);
  });

  it('reports a project NOT_ISOLATED as unattributable to the project file', () => {
    const { reason } = decide({ control: ARM.PRESENT, cleanroom: ARM.PRESENT, scope: SCOPE.PROJECT });
    expect(reason).toMatch(/[Nn]ot attributable/);
  });

  // The two-sided guarantee: a rule that was never added must still break the instrument, in
  // EVERY scope. Without this the probe would produce a verdict for every input it is given.
  it.each([[SCOPE.USER], [SCOPE.PROJECT]])('still reports INSTRUMENT_BROKEN in %s scope for a rule nobody added', (scope) => {
    expect(decide({ control: ARM.ABSENT, cleanroom: ARM.ABSENT, scope }).verdict).toBe(VERDICT.INSTRUMENT_BROKEN);
  });
});

describe('assertProjectDir', () => {
  it('accepts a real directory', () => {
    expect(() => assertProjectDir(HERE)).not.toThrow();
  });

  it('rejects a path that does not exist', () => {
    expect(() => assertProjectDir(join(HERE, 'no-such-directory-here'))).toThrow(/does not exist/);
  });

  // Distinct from the missing-path message on purpose: "does not exist" about a path that plainly
  // does is a true report of the wrong mistake, which is what this function exists to prevent.
  it('rejects a file with "not a directory", not "does not exist"', () => {
    expect(() => assertProjectDir(join(HERE, 'clean-room.mjs'))).toThrow(/is not a directory/);
    expect(() => assertProjectDir(join(HERE, 'clean-room.mjs'))).not.toThrow(/does not exist/);
  });

  it.each([['undefined', undefined], ['null', null], ['an empty string', ''], ['a number', 7]])(
    'rejects %s rather than spawning against it',
    (_label, dir) => {
      expect(() => assertProjectDir(dir)).toThrow(/needs a directory/);
    },
  );
});

describe('assertScope', () => {
  it.each([[SCOPE.USER], [SCOPE.PROJECT]])('accepts %s', (scope) => {
    expect(() => assertScope(scope)).not.toThrow();
  });

  // Membership is tested against the VALUES; a key lookup would answer for these.
  it.each([['toString'], ['__proto__'], ['constructor'], ['hasOwnProperty'], ['repo'], [undefined], [null], ['']])(
    'refuses %s',
    (scope) => {
      expect(() => assertScope(scope)).toThrow(/unrecognised scope/);
    },
  );
});

describe('assertNeutralDir', () => {
  // The guard behind armPlan's neutrality claim. mkdtemp honours TMPDIR, so with TMPDIR inside a
  // repo the USER-scope control arm loads that repo's CLAUDE.md while the --bare arm does not:
  // a false CLEAN credited to user scope for a rule that lives in a project file.
  it('accepts the real temp directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanroom-neutral-ok-'));
    try {
      expect(() => assertNeutralDir(dir)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a directory with a CLAUDE.md directly above it', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanroom-fakerepo-'));
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# pretend project\n');
      const nested = join(root, 'tmp');
      mkdirSync(nested);
      expect(() => assertNeutralDir(nested)).toThrow(/not neutral/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a directory that IS a project root', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanroom-fakerepo-'));
    try {
      writeFileSync(join(root, 'CLAUDE.md'), '# pretend project\n');
      expect(() => assertNeutralDir(root)).toThrow(/not neutral/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // Refusing on `.claude/` too would reject any TMPDIR under a home directory and make the probe
  // unavailable rather than wrong — the failure direction this repo counts as its own defect.
  it('does not refuse on a .claude directory alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'cleanroom-dotclaude-'));
    try {
      mkdirSync(join(root, '.claude'));
      const nested = join(root, 'tmp');
      mkdirSync(nested);
      expect(() => assertNeutralDir(nested)).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('probe — refuses before spawning', () => {
  // These must throw during validation. If any reached runClaude it would spawn a real session,
  // so a hang or a model call here IS the failure.
  it('refuses a project run whose directory does not exist', () => {
    expect(() => probe({ scope: SCOPE.PROJECT, projectDir: join(HERE, 'nope') })).toThrow(/does not exist/);
  });

  it('refuses an unrecognised scope', () => {
    expect(() => probe({ scope: 'repo' })).toThrow(/unrecognised scope/);
  });

  // An explicit question skips questionFor via `??`, so the scope check has to be its own call.
  // Without it this shape reached mkdtemp before armPlan objected.
  it('refuses an unrecognised scope even when a question is supplied', () => {
    expect(() => probe({ scope: 'repo', question: 'anything at all' })).toThrow(/unrecognised scope/);
  });
});

describe('CLI flags', () => {
  const runCli = (args) => {
    try {
      return { status: 0, out: execFileSync(process.execPath, [join(HERE, 'clean-room.mjs'), ...args], { encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { status: e.status, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  };

  // Each of these must exit before any session is spawned — the model call is the expensive
  // half, and a bad flag is exactly when it must not happen.
  it('rejects an unrecognised --scope with a non-zero exit', () => {
    const { status, out } = runCli(['--scope', 'repo']);
    expect(status).toBe(1);
    expect(out).toContain('unrecognised scope');
  });

  it.each([['--scope'], ['--project-dir'], ['--question']])('rejects %s with no value', (flag) => {
    const { status, out } = runCli([flag]);
    expect(status).toBe(1);
    expect(out).toContain(`${flag} requires a value`);
  });

  // The only bad-flag shape that used to spend two real model calls: `--question` swallowed
  // `--scope` as its value, then indexOf found `--scope` at that same position and read `project`
  // as ITS value, so both arms ran on the literal question "--scope".
  it.each([
    [['--question', '--scope', 'project']],
    [['--scope', '--question', 'x']],
    [['--project-dir', '--scope', 'project']],
  ])('rejects %s rather than running on a flag as a value', (args) => {
    const { status, out } = runCli(args);
    expect(status).toBe(1);
    expect(out).toContain('requires a value');
  });

  // Accepted-and-ignored would hand back a user-scope CLEAN at exit 0 to someone who believes
  // they measured that repo.
  it('rejects --project-dir when the scope is not project', () => {
    const { status, out } = runCli(['--project-dir', HERE]);
    expect(status).toBe(1);
    expect(out).toContain('only applies to --scope project');
  });

  it('accepts --project-dir together with --scope project', () => {
    // Reaches validation and would spawn, so pair it with a bad scope value that fails first —
    // proving the flag COMBINATION is accepted without spending a model call.
    const { status, out } = runCli(['--project-dir', HERE, '--scope', 'nope']);
    expect(status).toBe(1);
    expect(out).toContain('unrecognised scope');
    expect(out).not.toContain('only applies to --scope project');
  });
});
