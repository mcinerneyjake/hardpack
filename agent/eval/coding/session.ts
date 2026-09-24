import { createHash } from 'node:crypto';
import path from 'node:path';

// Every ancestor CLAUDE.md loads into a session. A fixture may load only those a real session in the
// live checkout also loads; any other is an instruction input the real pipeline never sees.
export function foreignAncestorClaudeMds(fixtureDir: string, liveCheckout: string, exists: (p: string) => boolean): string[] {
  const liveAncestors = new Set<string>();
  for (let d = path.dirname(liveCheckout); ; d = path.dirname(d)) {
    liveAncestors.add(path.join(d, 'CLAUDE.md'));
    if (d === path.dirname(d)) break;
  }
  const foreign: string[] = [];
  for (let d = path.dirname(fixtureDir); ; d = path.dirname(d)) {
    const f = path.join(d, 'CLAUDE.md');
    if (exists(f) && !liveAncestors.has(f)) foreign.push(f);
    if (d === path.dirname(d)) break;
  }
  return foreign;
}

// Part of the measured configuration: changing it changes what a score means, so its hash is printed
// in every report. Not the /hardpack-workflow skill — a no-remote fixture cannot reach its PR gates,
// so a skill run would measure where it halts rather than whether the ticket's work got done.
export function replayPrompt(ticketId: string): string {
  return [
    `Work ticket ${ticketId} from the kanban board, following this repository's CLAUDE.md.`,
    'This checkout is a local replay with NO remote: there is no push, no PR and no merge.',
    'Take the ticket through implementation, tests and the quality gate, commit it on a branch, and stop there.',
    'Nobody is available to answer questions; where CLAUDE.md asks the human, proceed as if approved.',
  ].join(' ');
}

export function promptHash(): string {
  return createHash('sha256').update(replayPrompt('tkt-000000000000')).digest('hex').slice(0, 12);
}

// Routes to the merged answer: the public repo holds every merged PR.
export const DISALLOWED_TOOLS = [
  'WebFetch',
  'WebSearch',
  'Bash(gh:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(git fetch:*)',
  'Bash(git clone:*)',
  'Bash(git remote:*)',
  'Bash(git pull:*)',
] as const;

export const NETWORK_RESIDUAL =
  'Residual, not blocked: the live checkout is denied to the Read/Edit tools but not to a Bash `cat` or ' +
  '`git -C` of it, and any network route other than the disallowed commands (a Node or Python HTTP ' +
  'call) can still reach the merged PR.';

export interface SessionPaths {
  settingsPath: string;
  mcpConfigPath: string;
}

// The prompt goes on stdin: --disallowedTools is variadic and would swallow a positional prompt.
export function sessionArgs(paths: SessionPaths, maxBudgetUsd: number): string[] {
  if (!(maxBudgetUsd > 0) || !Number.isFinite(maxBudgetUsd)) {
    throw new Error(`coding-eval: a per-session budget cap is required, got ${maxBudgetUsd}`);
  }
  return [
    '-p', '--verbose', '--output-format', 'stream-json', '--permission-mode', 'auto',
    '--setting-sources', 'project,local',
    '--settings', paths.settingsPath,
    '--strict-mcp-config', '--mcp-config', paths.mcpConfigPath,
    '--max-budget-usd', String(maxBudgetUsd),
    '--disallowedTools', DISALLOWED_TOOLS.join(','),
  ];
}

// The fixture's own server, as of C^, on the scratch board. `--strict-mcp-config` drops the user-scope
// entry, whose own env pins BOARD_DIR_OVERRIDE to the central board and would win over ours.
export function mcpConfig(scratchBoard: string): string {
  return JSON.stringify({
    mcpServers: {
      kanban: { type: 'stdio', command: 'npx', args: ['tsx', 'mcp/server.ts'], env: { BOARD_DIR_OVERRIDE: scratchBoard } },
    },
  }, null, 2);
}

interface HookEntry { type?: string; command?: string; [k: string]: unknown }
interface HookGroup { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown }
interface Permissions { deny?: string[]; [k: string]: unknown }
export interface UserSettings {
  env?: Record<string, string>;
  hooks?: Record<string, HookGroup[]>;
  permissions?: Permissions;
  [k: string]: unknown;
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// `//` marks an absolute path in a permission rule.
export function denyRulesFor(dirs: readonly string[]): string[] {
  return [...new Set(dirs)].flatMap((dir) => ['Read', 'Edit', 'Write', 'Grep', 'Glob'].map((tool) => `${tool}(/${dir}/**)`));
}

// The user settings with every track-steps hook re-pointed at the scratch board (the wired script
// hardcodes the central one) and the live checkout and board denied. Loaded instead of user settings.
export function rewriteUserSettings(settings: UserSettings, scratchBoard: string, runHookPath: string, denied: readonly string[]): UserSettings {
  const trackSteps = `BOARD_DIR_OVERRIDE=${shellQuote(scratchBoard)} node ${shellQuote(runHookPath)} track-steps open`;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    hooks[event] = groups.map((g) => ({
      ...g,
      hooks: (g.hooks ?? []).map((h) => (typeof h.command === 'string' && /track-steps/.test(h.command) ? { ...h, command: trackSteps } : h)),
    }));
  }
  // TICKETS_/EVENTS_DIR_OVERRIDE win over BOARD_DIR_OVERRIDE, so any of them left set could redirect it.
  const env = Object.fromEntries(Object.entries(settings.env ?? {}).filter(([k]) => !BOARD_ENV.test(k)));
  const permissions = { ...(settings.permissions ?? {}), deny: [...(settings.permissions?.deny ?? []), ...denyRulesFor(denied)] };
  return { ...settings, env: { ...env, BOARD_DIR_OVERRIDE: scratchBoard }, hooks, permissions };
}

const BOARD_ENV = /^(?:BOARD|TICKETS|EVENTS|RUNS)_DIR_OVERRIDE$/;

// The control on the rewrite, over the serialized text so an unknown field is covered too. The deny
// rules are the one place the central path belongs, so they are removed before the scan.
export function assertNoCentralBoard(serialized: string, centralBoard: string, label: string): void {
  const denies = new Set(denyRulesFor([centralBoard]).map((r) => JSON.stringify(r)));
  let text = serialized;
  for (const d of denies) text = text.split(d).join('""');
  const found = [centralBoard, 'track-steps-central'].filter((n) => text.includes(n));
  if (found.length > 0) {
    throw new Error(`coding-eval: the session ${label} still references ${found.join(' and ')} — a replay would write to the central board. Refusing to run.`);
  }
}

export interface SessionResult {
  // Claude Code's API-equivalent figure, notional on a subscription. Null = no result line, never $0.
  costUsd: number | null;
  isError: boolean;
  turns: number | null;
}

export function sessionResult(streamJson: string): SessionResult {
  for (const line of streamJson.split('\n').reverse()) {
    if (!line.includes('"type":"result"')) continue;
    try {
      const ev: unknown = JSON.parse(line);
      if (typeof ev !== 'object' || ev === null || !('type' in ev) || ev.type !== 'result') continue;
      return {
        costUsd: 'total_cost_usd' in ev && typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        isError: 'is_error' in ev && ev.is_error === true,
        turns: 'num_turns' in ev && typeof ev.num_turns === 'number' ? ev.num_turns : null,
      };
    } catch { /* keep scanning */ }
  }
  return { costUsd: null, isError: false, turns: null };
}

// The fixture must not inherit this process's board, run log, night-run identity or git context: a
// leaked override (or a hook-exported GIT_DIR) points a replayed suite or session at real state.
const LEAKY_ENV = /^(?:(?:BOARD|TICKETS|EVENTS|RUNS)_DIR_OVERRIDE|EMBED_CACHE_PATH|CLAUDE_CONFIG_DIR|NIGHT_RUN_.*|GIT_(?:DIR|INDEX_FILE|WORK_TREE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|PREFIX|CONFIG.*))$/;

export function sanitizedEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (LEAKY_ENV.test(k)) continue;
    out[k] = v;
  }
  return { ...out, ...extra };
}
