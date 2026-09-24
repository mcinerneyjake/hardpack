import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { asTodo, type CodingCase } from './cases.js';
import { InstrumentFault, type CodingDeps } from './codingEval.js';
import {
  assertContaminationCorpus, distinctiveIdentifiers, screenContamination, type CorpusFile,
} from './contamination.js';
import { parseVitestJson, type VitestRun } from './grading.js';
import {
  assertNoCentralBoard, foreignAncestorClaudeMds, mcpConfig, replayPrompt, rewriteUserSettings, sanitizedEnv,
  sessionArgs, sessionResult, type UserSettings,
} from './session.js';

export interface ExecResult { code: number; out: string; err: string; timedOut: boolean }

// Detached groups do not receive the terminal's SIGINT, so a Ctrl-C on the eval would leave a metered
// session running unwatched. Every live group is killed on the way out.
const liveGroups = new Set<number>();
let exitHooked = false;
function killGroup(pid: number, sig: NodeJS.Signals): void {
  try { process.kill(-pid, sig); } catch { /* already gone */ }
}
function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const reap = (): void => { for (const pid of liveGroups) killGroup(pid, 'SIGKILL'); };
  process.on('exit', reap);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { reap(); process.exit(130); });
  }
}

export function exec(
  cmd: string,
  args: readonly string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; input?: string | Buffer; capMs?: number; logFile?: string },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    // Its own process group, so the cap kills the dev servers and vitest workers a session started too.
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const log = opts.logFile ? createWriteStream(opts.logFile, { flags: 'a' }) : null;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    const pid = child.pid;
    if (pid) { hookExit(); liveGroups.add(pid); }
    const done = (r: Omit<ExecResult, 'timedOut'>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log?.end();
      // Also on a normal exit: a dev server the session backgrounded would hold its port into the next trial.
      if (pid) { killGroup(pid, 'SIGKILL'); liveGroups.delete(pid); }
      resolve({ ...r, timedOut });
    };
    const timer = opts.capMs && pid
      ? setTimeout(() => { timedOut = true; killGroup(pid, 'SIGTERM'); setTimeout(() => killGroup(pid, 'SIGKILL'), 10_000).unref(); }, opts.capMs)
      : undefined;
    child.stdout.on('data', (b: Buffer) => { out.push(b); log?.write(b); });
    child.stderr.on('data', (b: Buffer) => { err.push(b); });
    // Without an 'error' listener a spawn failure loses 'close' too, and the caller hangs.
    child.on('error', (e) => done({ code: -1, out: '', err: e.message }));
    child.on('close', (code) => done({ code: code ?? -1, out: Buffer.concat(out).toString('utf8'), err: Buffer.concat(err).toString('utf8') }));
    child.stdin.on('error', () => { /* a child that exits before reading stdin is reported via close */ });
    child.stdin.end(opts.input ?? '');
  });
}

async function mustExec(cmd: string, args: readonly string[], opts: Parameters<typeof exec>[2]): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`coding-eval: \`${cmd} ${args.join(' ')}\` exited ${r.code} in ${opts.cwd}\n${r.err.slice(-2000)}`);
  }
  return r.out;
}

export interface RealDepsConfig {
  // A checkout of hardpack whose object store holds every case commit.
  repoRoot: string;
  // The board whose .history holds the frozen bodies. Also the central board sessions must not write.
  boardDir: string;
  runDir: string;
  maxBudgetUsd: number;
  sessionCapMs: number;
  // A ticket id the contamination corpus is known to cite: the screen's positive control.
  corpusControlId: string;
  home?: string;
  log: (line: string) => void;
}

function isMissing(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}

// Only a missing directory is empty. Any other error throws: a swallowed EACCES would drop the whole
// memory store from the screen while its control, satisfied by CLAUDE.md, still passed.
async function listFiles(dir: string, keep: (p: string) => boolean): Promise<string[]> {
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true, recursive: true }); } catch (err) {
    if (isMissing(err)) return [];
    throw new Error(`coding-eval: cannot read ${dir} for the contamination screen: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  return entries.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name)).filter(keep);
}

// This eval's own replay sessions write memory under slugs of their fixture paths; screening those would
// exclude a case for having been replayed.
// Claude Code names a project's store after its cwd with every non-alphanumeric turned into `-`.
export function projectSlug(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

// Everything that loads into every session from outside the fixture and could carry the answer,
// including the ancestor CLAUDE.md files a fixture shares with the live checkout.
export async function readContaminationCorpus(home: string, where: { evalRoot: string; liveCheckout: string }): Promise<CorpusFile[]> {
  const claude = path.join(home, '.claude');
  const projects = path.join(claude, 'projects');
  const evalSlug = projectSlug(where.evalRoot);
  // Only the project directory's NAME is matched, never a filename inside a real store.
  const isMemory = (p: string): boolean => {
    const rel = path.relative(projects, p).split(path.sep);
    return rel.includes('memory') && p.endsWith('.md') && !rel[0].startsWith(evalSlug);
  };
  const ancestors: string[] = [];
  for (let d = path.dirname(where.liveCheckout); d !== path.dirname(d); d = path.dirname(d)) ancestors.push(path.join(d, 'CLAUDE.md'));
  const files = [
    ...ancestors,
    path.join(claude, 'CLAUDE.md'),
    ...(await listFiles(projects, isMemory)),
    ...(await listFiles(path.join(claude, 'skills'), (p) => p.endsWith('.md'))),
    ...(await listFiles(path.join(claude, 'commands'), (p) => p.endsWith('.md'))),
    ...(await listFiles(path.join(claude, 'rules'), (p) => p.endsWith('.md'))),
  ];
  const corpus: CorpusFile[] = [];
  for (const f of files) {
    try { corpus.push({ path: f, text: await fs.readFile(f, 'utf8') }); } catch (err) {
      if (!isMissing(err)) throw new Error(`coding-eval: cannot read ${f} for the contamination screen`, { cause: err });
    }
  }
  return corpus;
}


// Keeps only identifiers the base tree does not already contain. A grep that errors keeps the name:
// an unchecked identifier stays in the screen, which can only exclude more.
export async function identifiersNewAt(repoRoot: string, base: string, ids: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const id of ids) {
    const r = await exec('git', ['grep', '-q', '-w', '-F', '-e', id, base], { cwd: repoRoot, env: sanitizedEnv(process.env) });
    if (r.code !== 0) out.push(id);
  }
  return out;
}

export async function screenCase(repoRoot: string, c: Pick<CodingCase, 'ticketId' | 'base' | 'commit'>, corpus: readonly CorpusFile[]) {
  const diff = await mustExec('git', ['diff', c.base, c.commit], { cwd: repoRoot, env: sanitizedEnv(process.env) });
  const identifiers = await identifiersNewAt(repoRoot, c.base, distinctiveIdentifiers(diff));
  return screenContamination({ ticketId: c.ticketId, identifiers }, corpus);
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

export function realDeps(cfg: RealDepsConfig): CodingDeps {
  const home = cfg.home ?? os.homedir();
  const git = (args: string[], cwd = cfg.repoRoot, input?: string | Buffer) => mustExec('git', args, { cwd, input, env: sanitizedEnv(process.env) });
  const pristine = new Map<string, Promise<string>>();
  let corpus: CorpusFile[] | null = null;

  async function frozenBody(c: CodingCase): Promise<string> {
    const file = path.join(cfg.boardDir, 'tickets', '.history', c.ticketId, c.snapshot);
    const text = await fs.readFile(file, 'utf8');
    if (sha256(text) !== c.bodySha256) {
      throw new Error(`coding-eval: frozen body for ${c.ticketId} (${file}) no longer matches the manifest's hash — the task statement changed, so this is not the case that was selected.`);
    }
    return text;
  }

  // One install per case, cloned for every control and trial, so each tree starts identical.
  async function buildPristine(c: CodingCase): Promise<string> {
    const dir = path.join(cfg.runDir, c.ticketId, 'pristine');
    await fs.mkdir(dir, { recursive: true });
    const tar = path.join(cfg.runDir, c.ticketId, 'base.tar');
    await git(['archive', '--format=tar', '-o', tar, c.base]);
    await mustExec('tar', ['-xf', tar, '-C', dir], { cwd: dir });
    await fs.rm(tar);
    const g = (args: string[]) => mustExec('git', args, { cwd: dir, env: sanitizedEnv(process.env) });
    await g(['init', '-q', '-b', 'main']);
    await g(['add', '--all']);
    await g(['-c', 'user.name=coding-eval', '-c', 'user.email=coding-eval@localhost', '-c', 'core.hooksPath=/dev/null',
      'commit', '-q', '--no-verify', '-m', `replay base ${c.base.slice(0, 12)} for ${c.ticketId}`]);
    await mustExec('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env: sanitizedEnv(process.env), capMs: 15 * 60_000 });
    await assertFixtureShape(dir);
    return dir;
  }

  async function prepareFixture(c: CodingCase, label: string): Promise<string> {
    let p = pristine.get(c.ticketId);
    if (!p) { p = buildPristine(c); pristine.set(c.ticketId, p); }
    const src = await p;
    const parent = path.join(cfg.runDir, c.ticketId, label);
    const dir = path.join(parent, 'repo');
    await fs.mkdir(parent, { recursive: true });
    // APFS clone where available: a copy-on-write node_modules costs nothing per trial.
    const cp = await exec('cp', ['-cR', src, dir], { cwd: parent });
    if (cp.code !== 0) await mustExec('cp', ['-R', src, dir], { cwd: parent });
    await assertFixtureShape(dir);
    const board = path.join(parent, 'board');
    await fs.mkdir(path.join(board, 'tickets'), { recursive: true });
    await fs.writeFile(path.join(board, 'tickets', `${c.ticketId}.md`), asTodo(await frozenBody(c)));
    return dir;
  }

  async function assertFixtureShape(dir: string): Promise<void> {
    const count = (await mustExec('git', ['rev-list', '--count', '--all'], { cwd: dir, env: sanitizedEnv(process.env) })).trim();
    const remotes = (await mustExec('git', ['remote'], { cwd: dir, env: sanitizedEnv(process.env) })).trim();
    if (count !== '1') throw new Error(`coding-eval: fixture ${dir} holds ${count} commits, expected exactly 1 — later history could hold the answer`);
    if (remotes !== '') throw new Error(`coding-eval: fixture ${dir} has a remote (${remotes}) — the answer is fetchable`);
  }

  return {
    log: cfg.log,

    async checkEnvironment() {
      const v = await exec('claude', ['--version'], { cwd: cfg.repoRoot });
      if (v.code !== 0) throw new Error(`coding-eval: the claude CLI is not reachable (exit ${v.code}): ${v.err.trim()}`);
      await fs.mkdir(cfg.runDir, { recursive: true });
      // vitest keys results by realpath; a symlinked run dir would miss every file and drop every case.
      if ((await fs.realpath(cfg.runDir)) !== cfg.runDir) {
        throw new Error(`coding-eval: run directory ${cfg.runDir} is not its own realpath — set EVAL_CODING_DIR to a path with no symlink in it.`);
      }
      const inRepo = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: cfg.runDir, env: sanitizedEnv(process.env) });
      if (inRepo.code === 0) {
        throw new Error(`coding-eval: run directory ${cfg.runDir} is inside the git repo ${inRepo.out.trim()} — a replay would see its files and history. Set EVAL_CODING_DIR outside any repo.`);
      }
      const foreign = foreignAncestorClaudeMds(path.join(cfg.runDir, 'x', 'y', 'repo'), cfg.repoRoot, existsSync);
      if (foreign.length > 0) {
        throw new Error(`coding-eval: replays would load ${foreign.join(', ')}, which a real session in ${cfg.repoRoot} never does. Move EVAL_CODING_DIR.`);
      }
      corpus = await readContaminationCorpus(home, { evalRoot: path.dirname(cfg.runDir), liveCheckout: cfg.repoRoot });
      assertContaminationCorpus(corpus, cfg.corpusControlId);
      const settings = await readUserSettings(home);
      assertNoCentralBoard(JSON.stringify(rewriteUserSettings(settings, path.join(cfg.runDir, 'probe-board'), runHookPath(home), [cfg.repoRoot, cfg.boardDir])), cfg.boardDir, 'settings');
      assertNoCentralBoard(mcpConfig(path.join(cfg.runDir, 'probe-board')), cfg.boardDir, 'MCP config');
    },

    async screen(c) {
      if (!corpus) throw new Error('coding-eval: screen called before checkEnvironment read the corpus');
      return screenCase(cfg.repoRoot, c, corpus);
    },

    prepareFixture,

    async applyGold(dir, c) {
      const diff = await git(['diff', '--binary', c.base, c.commit]);
      await mustExec('git', ['apply', '--whitespace=nowarn'], { cwd: dir, input: diff, env: sanitizedEnv(process.env) });
    },

    async runHidden(dir, c) {
      for (const f of c.testFiles) {
        const content = await git(['show', `${c.commit}:${f}`]).catch((err: unknown) => {
          throw new InstrumentFault(`coding-eval: cannot read hidden test ${f} at ${c.commit}`, { cause: err });
        });
        await fs.mkdir(path.dirname(path.join(dir, f)), { recursive: true });
        await fs.writeFile(path.join(dir, f), content);
      }
      return runVitest(dir, c.testFiles);
    },

    runFullSuite: (dir) => runVitest(dir, []),

    async runSession(dir, c) {
      const parent = path.dirname(dir);
      const board = path.join(parent, 'board');
      const settingsPath = path.join(parent, 'settings.json');
      const mcpPath = path.join(parent, 'mcp.json');
      const settings = JSON.stringify(rewriteUserSettings(await readUserSettings(home), board, runHookPath(home), [cfg.repoRoot, cfg.boardDir]), null, 2);
      const mcp = mcpConfig(board);
      assertNoCentralBoard(settings, cfg.boardDir, 'settings');
      assertNoCentralBoard(mcp, cfg.boardDir, 'MCP config');
      await fs.writeFile(settingsPath, settings);
      await fs.writeFile(mcpPath, mcp);
      const started = Date.now();
      const r = await exec('claude', sessionArgs({ settingsPath, mcpConfigPath: mcpPath }, cfg.maxBudgetUsd), {
        cwd: dir,
        input: replayPrompt(c.ticketId),
        env: sanitizedEnv(process.env, { BOARD_DIR_OVERRIDE: board }),
        capMs: cfg.sessionCapMs,
        logFile: path.join(parent, 'session.log'),
      });
      return { exitCode: r.code, durationMs: Date.now() - started, timedOut: r.timedOut, ...sessionResult(r.out) };
    },

    async record(result) {
      await fs.appendFile(path.join(cfg.runDir, 'results.jsonl'), `${JSON.stringify(result)}\n`);
    },

    runFiles: (dir, files) => runVitest(dir, files),

    async gradeTree(dir, c, label) {
      const list = await mustExec('git', ['worktree', 'list', '--porcelain'], { cwd: dir, env: sanitizedEnv(process.env) });
      const root = await fs.realpath(dir);
      // A worktree whose directory is gone (removed, now prunable) holds no work to grade.
      const linked = list.split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9))
        .filter((p) => existsSync(p) && p !== root && p !== dir);
      // Ambiguous work is graded at the root, which then fails unless the root holds it — never guessed.
      if (linked.length > 1) cfg.log(`! ${dir}: ${linked.length} linked worktrees — grading the fixture root`);
      const work = linked.length === 1 ? linked[0] : dir;
      // The session's FILES onto a fresh, fully installed clone: grading in its own tree measured how it
      // provisioned node_modules (a real dir holding only .vite broke packageContract on the smoke run).
      const graded = await prepareFixture(c, `${label}-graded`);
      await mustExec('rsync', ['-a', '--delete', '--exclude', '.git', '--exclude', 'node_modules', '--exclude', '.claude/worktrees',
        `${work}/`, `${graded}/`], { cwd: graded, env: sanitizedEnv(process.env) });
      return graded;
    },
  };

  async function runVitest(dir: string, files: readonly string[]): Promise<VitestRun> {
    const report = path.join(path.dirname(dir), `vitest-${Date.now()}-${Math.random().toString(16).slice(2)}.json`);
    const r = await exec('npx', ['vitest', 'run', '--reporter=json', `--outputFile=${report}`, ...files], {
      cwd: dir, env: sanitizedEnv(process.env), capMs: 20 * 60_000,
    });
    let raw: string;
    try { raw = await fs.readFile(report, 'utf8'); } catch {
      const detail = `vitest wrote no report in ${dir} (exit ${r.code})`;
      // The cap and the machine-wide test slot are this harness's limits, not the session's doing.
      if (r.timedOut || /test-run|slot/i.test(r.err)) throw new InstrumentFault(`coding-eval: ${detail} — the harness, not the tree: ${r.timedOut ? 'hit the time cap' : 'no test slot'}\n${r.err.slice(-2000)}`);
      throw new Error(`coding-eval: ${detail} — the suite did not run, which is not a result\n${r.err.slice(-2000)}`);
    }
    return parseVitestJson(raw, dir);
  }
}

function runHookPath(home: string): string {
  return path.join(home, '.claude', 'tools', 'hooks', 'run-hook.mjs');
}

async function readUserSettings(home: string): Promise<UserSettings> {
  const file = path.join(home, '.claude', 'settings.json');
  const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`coding-eval: ${file} is not a settings object`);
  }
  return { ...parsed };
}
