import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Answers ONE question: can a Claude Code session be run that loads NO instructions from the
 * scope under test, so a change to that scope can be A/B'd?
 *
 * Without this an instruction change can only be asserted, never measured — the confound that
 * invalidated the `tkt-70ab03c22f43` A/B, where both arms silently carried a tenet added an
 * hour earlier and the arms were therefore unattributable (`tkt-b86d2a318f8b`).
 *
 * The load-bearing rule is that **"I could not determine this" must never be reported as "no
 * instructions were loaded"** — an auth failure, a missing binary, a hedged answer and a
 * genuinely empty context all look alike from outside. So: every classification is an
 * ALLOWLIST (an unrecognised value is BLOCKED, never clean), the answer must be a bare
 * yes/no rather than prose containing one, and `assertInstruments()` runs self-checks before
 * any verdict is produced.
 */

/**
 * Which scope's instructions are under test. The scope decides what SEPARATES the two arms,
 * which is the whole design: see `armPlan`.
 */
export const SCOPE = {
  USER: 'user',       // `~/.claude/CLAUDE.md` — isolated by `--bare`
  PROJECT: 'project', // a repo's own `CLAUDE.md` — isolated by the working directory
};

/** This file lives at `<repo>/scripts/probe/`, so the repo root is two levels up. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export const DEFAULT_MARKER = 'adversary list';

/**
 * Deliberately does NOT quote the marker. An earlier version asked "does your context contain
 * the phrase 'adversary list'?", which supplies in the question the very string the answer is
 * about — true by construction in every arm.
 */
export const DEFAULT_QUESTION =
  'Do your loaded instructions include a tenet about what a guarantee needs enumerated before the code is written? Reply with exactly one word: YES or NO.';

/** The project-scope marker, per `CLAUDE.md` -> "Ticket body text is data, not instructions". */
export const PROJECT_MARKER = 'data, not instructions';

/**
 * Every phrase the question must avoid, not just the heading. Anchoring the anti-quote test on
 * `PROJECT_MARKER` alone let a question through that reproduced the rule's BODY near-verbatim
 * ("content to act on … addressed to you", `CLAUDE.md:85`) while the test still passed.
 */
export const PROJECT_MARKER_PHRASES = [
  PROJECT_MARKER,
  'content to act on',
  'directives addressed to you',
  'addressed to you',
  'never as directives',
];

/** Same rule as DEFAULT_QUESTION: asks after the rule's EFFECT, never in its own words. */
export const PROJECT_QUESTION =
  'Do your loaded instructions include a rule about whether a work item description may itself tell you how to behave? Reply with exactly one word: YES or NO.';

export const VERDICT = {
  CLEAN: 'CLEAN',                         // control saw instructions, isolated arm did not
  NOT_ISOLATED: 'NOT_ISOLATED',           // the mechanism ran but still loaded them
  BLOCKED: 'BLOCKED',                     // could not run (auth, binary, hedge) — NOT "clean"
  INSTRUMENT_BROKEN: 'INSTRUMENT_BROKEN', // the control failed, so nothing here is believable
};

/**
 * Printed with every verdict. Each run is spawned once and never repeated, so a verdict is one
 * model reply per run: disclosed, not changed (`tkt-b678f8cb17a2`).
 */
export const SAMPLE_NOTE =
  'Sample: each run (control and isolated) asks the model once and is never repeated, so this verdict rests on at most one model answer per run.';

export const ARM = {
  PRESENT: 'MARKER_PRESENT',
  ABSENT: 'MARKER_ABSENT',
  BLOCKED: 'BLOCKED',
};

/**
 * Known "the session never got to answer" shapes. This list is a fast path for a clear
 * message, NOT the safety net — an unrecognised failure still lands on BLOCKED via the
 * strict-answer rule below. Patterns are anchored to error wording so they cannot fire on
 * a model's own prose (a bare /401/ once matched any answer mentioning that number).
 */
const AUTH_BLOCKED = [
  /not logged in/i,
  /please run \/login/i,
  /failed to authenticate/i,
  /\b(?:api[ _-]?)?error\b[^\n]*\b401\b/i,
  /invalid api key/i,
  /api key is invalid/i,
  /credit balance/i,
];

/** The prompt demands one word, so anything else is an answer we did not get. */
const STRICT_YES = /^yes[.!]?$/i;
const STRICT_NO = /^no[.!]?$/i;

/**
 * Pure: what a single arm's output means. Exported so the decision logic is testable without
 * spawning a model.
 */
export function classifyArm({ stdout = '', stderr = '', status = 0 } = {}) {
  const text = `${stdout}\n${stderr}`;
  if (AUTH_BLOCKED.some((re) => re.test(text))) return ARM.BLOCKED;
  if (status !== 0) return ARM.BLOCKED;
  const trimmed = stdout.trim();
  if (STRICT_YES.test(trimmed)) return ARM.PRESENT;
  if (STRICT_NO.test(trimmed)) return ARM.ABSENT;
  // Prose, a hedge, an unrecognised error, or silence. Undetermined — never "absent".
  return ARM.BLOCKED;
}

/** Allowlist: an unrecognised scope gets no default question, rather than the wrong one. */
export function questionFor(scope) {
  assertScope(scope);
  return scope === SCOPE.USER ? DEFAULT_QUESTION : PROJECT_QUESTION;
}

function unknownScopeMessage(scope) {
  return `clean-room: unrecognised scope ${JSON.stringify(scope)} — expected one of ${Object.values(SCOPE).join(', ')}`;
}

/**
 * The single scope allowlist every other entry point defers to. Membership is tested against the
 * VALUES, never by indexing an object: a key lookup answers for `toString` and `__proto__` too,
 * which is how an unrecognised scope reached a verdict carrying a function as its reason.
 */
export function assertScope(scope) {
  if (!Object.values(SCOPE).includes(scope)) throw new Error(unknownScopeMessage(scope));
}

/**
 * Pure: the cwd and flags each arm gets, for the scope under test. This is what authorizes
 * running a session with the REPOSITORY as its working directory, so it opens with `assertScope`
 * — the allowlist — rather than falling through: an unvalidated scope reaching here would get a
 * pair of arms and produce a confident verdict about nothing.
 *
 * The neutral directory is not removed by project scope, it MOVES: it always sits on the arm
 * that must not see the scope under test. Under `user` that is both arms; under `project` it is
 * the isolated arm alone, which is what lets the control load the repo's file. That the neutral
 * directory is actually neutral is NOT free — see `assertNeutralDir`, which is the guard, not
 * this comment.
 *
 * Project scope applies `--bare` to NEITHER arm, so the arms differ in one FLAG dimension only
 * and user scope loads identically in both. The cwd swap itself is broad by construction: it
 * moves every cwd-derived input at once — the repo's `CLAUDE.md`, every `CLAUDE.md` ABOVE it,
 * project settings, hooks, skills, MCP servers and per-project memory. So a `project` CLEAN
 * attributes the rule to the working directory, never to the repo's own file alone; the reason
 * text says so, and the caller must identify which of those carries it before running an A/B.
 */
export function armPlan({ scope, projectDir, neutralDir } = {}) {
  assertScope(scope);
  if (scope === SCOPE.USER) {
    return {
      control: { cwd: neutralDir, bare: false },
      cleanroom: { cwd: neutralDir, bare: true },
    };
  }
  return {
    control: { cwd: projectDir, bare: false },
    cleanroom: { cwd: neutralDir, bare: false },
  };
}

/**
 * Reason text per verdict per scope. The VERDICT itself never depends on the scope — only the
 * wording does — so a project-scope result cannot silently claim something about user scope.
 */
const REASONS = {
  [VERDICT.CLEAN]: {
    [SCOPE.USER]:
      'Control saw the marker; the isolated arm did not. The isolated arm loads no user-scope instructions. NOTE: --bare also strips MCP servers, skills, hooks and project settings, so an A/B built on it differs in more than the instruction under test — hold those constant in both arms.',
    [SCOPE.PROJECT]:
      'Control saw the marker with the repository as its working directory; the isolated arm, run from a neutral directory, did not. The rule is attributable to the WORKING DIRECTORY — the project CLAUDE.md, any CLAUDE.md above it, project settings, hooks, skills and MCP servers, and per-project memory — and NOT to the project CLAUDE.md alone. Identify which of those carries it before editing anything for an A/B. User-scope instructions loaded in BOTH arms and are therefore held constant.',
  },
  [VERDICT.NOT_ISOLATED]: {
    [SCOPE.USER]:
      'The mechanism ran but user-scope instructions were still loaded, so it cannot serve as a control arm.',
    [SCOPE.PROJECT]:
      'The isolated arm found the marker from a neutral directory, so the working directory is not what supplies it — it is already in user scope, or the model inferred it. Not attributable to the project file.',
  },
};

/** Safe because `decide` has already run the scope through `assertScope`. */
function reasonFor(verdict, scope) {
  return REASONS[verdict][scope];
}

/**
 * Pure: combine the two arms into a verdict.
 *
 * Every branch is an explicit allowlist. CLEAN is returned ONLY for the single input pair that
 * earns it; there is no fall-through, so an unrecognised or missing arm value cannot become the
 * permissive answer.
 */
export function decide({ control, cleanroom, scope = SCOPE.USER } = {}) {
  // Before any branch: an unrecognised scope must not reach the reason lookup. `REASONS[v][scope]`
  // is a key lookup, so `toString` and `__proto__` would answer with an inherited member and a
  // CLEAN verdict would carry a function as its reason.
  assertScope(scope);
  // Checked first and unconditionally: if a normal session cannot find a marker known to be in
  // the instructions under test, the probe cannot detect instructions at all, and every "absent"
  // it reports afterwards is unfalsifiable.
  if (control !== ARM.PRESENT) {
    return {
      verdict: VERDICT.INSTRUMENT_BROKEN,
      reason: control === ARM.BLOCKED
        ? 'The control arm could not run, so the probe was never shown to detect instructions at all.'
        : 'The control arm did NOT find the marker in a normal session. Either the question is wrong or discovery is broken; a clean-room result would be unfalsifiable.',
    };
  }
  if (cleanroom === ARM.ABSENT) {
    return { verdict: VERDICT.CLEAN, reason: reasonFor(VERDICT.CLEAN, scope) };
  }
  if (cleanroom === ARM.PRESENT) {
    return { verdict: VERDICT.NOT_ISOLATED, reason: reasonFor(VERDICT.NOT_ISOLATED, scope) };
  }
  return {
    verdict: VERDICT.BLOCKED,
    reason: `The isolation mechanism did not produce a usable answer (${cleanroom ?? 'no result'}) — typically auth. This is NOT evidence of an empty context; it is the absence of evidence.`,
  };
}

/** Exit status is what a caller or CI reads, so it is derived by a testable function. */
export function exitCodeFor(verdict) {
  return verdict === VERDICT.CLEAN ? 0 : 1;
}

/**
 * Self-checks, run before any verdict is produced. Throws rather than returning a result,
 * because a probe whose own logic has inverted is worse than no probe (`repo-stats.mjs`
 * precedent).
 */
export function assertInstruments() {
  const neutral = '/neutral';
  const repo = '/repo';
  const planned = (scope) => armPlan({ scope, projectDir: repo, neutralDir: neutral });
  const threw = (fn) => { try { fn(); return false; } catch { return true; } };

  const cases = [
    ['a bare NO is absent', classifyArm({ stdout: 'NO' }), ARM.ABSENT],
    ['a bare YES is present', classifyArm({ stdout: 'YES' }), ARM.PRESENT],
    ['prose containing "no" is undetermined', classifyArm({ stdout: 'Error: no credentials configured.' }), ARM.BLOCKED],
    ['an auth failure is undetermined', classifyArm({ stdout: 'Not logged in · Please run /login' }), ARM.BLOCKED],
    ['an auth failure on stderr beats a clean stdout answer', classifyArm({ stdout: 'NO', stderr: 'Not logged in' }), ARM.BLOCKED],
    ['an unknown arm value is not clean', decide({ control: ARM.PRESENT, cleanroom: 'SOMETHING_NEW' }).verdict, VERDICT.BLOCKED],
    ['a missing arm value is not clean', decide({ control: ARM.PRESENT }).verdict, VERDICT.BLOCKED],
    ['a broken control is not clean', decide({ control: ARM.BLOCKED, cleanroom: ARM.ABSENT }).verdict, VERDICT.INSTRUMENT_BROKEN],
    ['the earned pair is clean', decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT }).verdict, VERDICT.CLEAN],
    // The arm layout is as load-bearing as the classification: a project control arm that did not
    // reach the repo, or an isolated arm that did, measures nothing while still reporting.
    ['user scope keeps both arms neutral', planned(SCOPE.USER).control.cwd === neutral && planned(SCOPE.USER).cleanroom.cwd === neutral, true],
    ['user scope isolates with --bare', planned(SCOPE.USER).cleanroom.bare, true],
    ['project scope points the control at the repo', planned(SCOPE.PROJECT).control.cwd, repo],
    ['project scope keeps the isolated arm neutral', planned(SCOPE.PROJECT).cleanroom.cwd, neutral],
    ['project scope uses --bare in neither arm', planned(SCOPE.PROJECT).control.bare || planned(SCOPE.PROJECT).cleanroom.bare, false],
    ['an unrecognised scope gets no arms', threw(() => planned('everything')), true],
    ['an unrecognised scope gets no question', threw(() => questionFor('everything')), true],
    // A prototype key is the shape that reached a verdict carrying a function as its reason.
    ['a prototype key is not a scope', threw(() => decide({ control: ARM.PRESENT, cleanroom: ARM.ABSENT, scope: 'toString' })), true],
    ['every reason is a string', Object.values(REASONS).every((byScope) => Object.values(byScope).every((r) => typeof r === 'string')), true],
  ];
  const failed = cases.filter(([, actual, expected]) => actual !== expected);
  if (failed.length > 0) {
    throw new Error(
      `clean-room probe self-check FAILED — refusing to report a verdict:\n${
        failed.map(([name, actual, expected]) => `  - ${name}: got ${actual}, expected ${expected}`).join('\n')}`,
    );
  }
}

function runClaude({ args, cwd, timeoutMs, spawn }) {
  const r = spawn('claude', args, { cwd, timeout: timeoutMs, encoding: 'utf8' });
  // Keep whatever was captured before the failure; the error is appended, never substituted,
  // so a message on stderr can still be classified.
  if (r.error) {
    return {
      stdout: r.stdout ?? '',
      stderr: `${r.stderr ?? ''}\n${r.error.message}`,
      status: typeof r.status === 'number' ? r.status : 1,
    };
  }
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: typeof r.status === 'number' ? r.status : 1 };
}

/**
 * Refuse a project run we cannot point at a real directory. spawnSync would fail closed anyway
 * (ENOENT -> BLOCKED -> INSTRUMENT_BROKEN), but the verdict would blame the question rather
 * than the path, which is a true report of the wrong mistake.
 */
export function assertProjectDir(projectDir) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) {
    throw new Error(`clean-room: project scope needs a directory, got ${JSON.stringify(projectDir)}`);
  }
  let stat;
  try {
    stat = statSync(projectDir);
  } catch {
    throw new Error(`clean-room: project directory does not exist: ${projectDir}`);
  }
  // Kept distinct from the branch above: collapsing them reports "does not exist" about a path
  // that plainly does, which is the true-report-of-the-wrong-mistake this function exists to stop.
  if (!stat.isDirectory()) throw new Error(`clean-room: project path is not a directory: ${projectDir}`);
}

/**
 * `mkdtemp` honours TMPDIR, so the "neutral" directory is only neutral if no `CLAUDE.md` sits
 * above it. This is the guard behind `armPlan`'s claim, and it fails in the direction that
 * matters most: with TMPDIR inside a repo, the USER-scope control arm would load that repo's
 * CLAUDE.md while the `--bare` arm would not — a FALSE CLEAN, credited to user scope for a rule
 * that lives in a project file.
 *
 * It walks for `CLAUDE.md` only. Refusing on `.claude/` as well would reject any TMPDIR under a
 * home directory, and the probe would be unavailable rather than wrong — the failure direction
 * this repo treats as its own defect.
 */
export function assertNeutralDir(neutralDir) {
  let dir = realpathSync(neutralDir);
  for (;;) {
    if (existsSync(join(dir, 'CLAUDE.md'))) {
      throw new Error(
        `clean-room: the neutral directory is not neutral — ${join(dir, 'CLAUDE.md')} sits at or above ${neutralDir}, so the control arm would load it. Point TMPDIR outside any project.`,
      );
    }
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
}

export function probe({
  question,
  scope = SCOPE.USER,
  projectDir = REPO_ROOT,
  model = 'claude-haiku-4-5-20251001',
  timeoutMs = 180_000,
  spawn = spawnSync,
} = {}) {
  assertInstruments();
  // All three throw BEFORE anything is spawned or created, so an unusable configuration costs no
  // model call and can never reach a verdict. `assertScope` is called directly rather than left to
  // `questionFor`, which an explicit `question` skips via `??` — the ordering a passed-in question
  // would otherwise slip past.
  assertScope(scope);
  const resolved = question ?? questionFor(scope);
  if (scope === SCOPE.PROJECT) assertProjectDir(projectDir);

  const neutralDir = mkdtempSync(join(tmpdir(), 'cleanroom-work-'));
  try {
    assertNeutralDir(neutralDir);
    const plan = armPlan({ scope, projectDir, neutralDir });
    const base = ['-p', resolved, '--model', model];
    const runArm = ({ cwd, bare }) =>
      classifyArm(runClaude({ args: bare ? ['--bare', ...base] : base, cwd, timeoutMs, spawn }));
    const control = runArm(plan.control);
    const cleanroom = runArm(plan.cleanroom);
    return {
      scope, question: resolved, arms: { control, cleanroom }, sample: SAMPLE_NOTE, ...decide({ control, cleanroom, scope }),
    };
  } finally {
    rmSync(neutralDir, { recursive: true, force: true });
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/**
 * A flag present with no value is an error, never a silent fall back to the default. A following
 * token that is itself a flag counts as missing: `--question --scope project` otherwise runs both
 * arms on the literal question "--scope", which is the one malformed invocation that still spends
 * two real model calls before failing.
 */
function flagValue(name) {
  const i = process.argv.indexOf(name);
  if (i === -1) return undefined;
  const value = process.argv[i + 1];
  if (!value || value.startsWith('--')) {
    console.error(`${name} requires a value.`);
    process.exit(1);
  }
  return value;
}

if (isMain()) {
  const question = flagValue('--question');
  const scope = flagValue('--scope') ?? SCOPE.USER;
  const projectDirFlag = flagValue('--project-dir');
  const projectDir = projectDirFlag ?? REPO_ROOT;
  if (!Object.values(SCOPE).includes(scope)) {
    console.error(unknownScopeMessage(scope));
    process.exit(1);
  }
  // Accepting and ignoring it would hand back a user-scope CLEAN at exit 0 to someone who
  // believes they measured that repo — the same failure this file exists to prevent, one level up.
  if (projectDirFlag !== undefined && scope !== SCOPE.PROJECT) {
    console.error('--project-dir only applies to --scope project; it would be ignored here.');
    process.exit(1);
  }
  const result = probe({ question, scope, projectDir });
  console.log(`scope:     ${result.scope}${scope === SCOPE.PROJECT ? ` (${projectDir})` : ''}`);
  console.log(`question:  ${result.question}`);
  console.log(`control:   ${result.arms.control}`);
  console.log(`cleanroom: ${result.arms.cleanroom}`);
  console.log(`\n${result.verdict} — ${result.reason}`);
  console.log(result.sample);
  if (result.verdict !== VERDICT.CLEAN) {
    console.log('\nDo NOT run an A/B on instruction changes until this reports CLEAN;');
    console.log('both arms would carry the same instructions and be unattributable.');
  }
  process.exit(exitCodeFor(result.verdict));
}
