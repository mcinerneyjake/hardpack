import { describe, it, expect } from 'vitest';
import {
  DISALLOWED_TOOLS, assertNoCentralBoard, denyRulesFor, foreignAncestorClaudeMds, mcpConfig, replayPrompt,
  rewriteUserSettings, sanitizedEnv, sessionArgs, sessionResult, type UserSettings,
} from './session.js';

const CENTRAL = '/home/user/projects/hardpack';
const SCRATCH = '/home/user/projects/.hardpack-eval-coding/run/case/board';
const RUN_HOOK = '/home/user/.claude/tools/hooks/run-hook.mjs';
// A BOARD_DIR_OVERRIDE board apart from the checkout: both must be denied (round-2 review).
const BOARD = '/home/user/boards/central';

const USER: UserSettings = {
  env: { FOO: '1', BOARD_DIR_OVERRIDE: CENTRAL },
  permissions: { allow: ['Bash(ls:*)'] },
  hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `node ${RUN_HOOK} guard-bash closed` }] }],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/home/user/.claude/bin/track-steps-central.sh' }] }],
  },
};

describe('rewriteUserSettings', () => {
  const out = rewriteUserSettings(
    { ...USER, env: { ...USER.env, TICKETS_DIR_OVERRIDE: '/elsewhere/tickets', EVENTS_DIR_OVERRIDE: '/elsewhere/events' } },
    SCRATCH, RUN_HOOK, [CENTRAL, BOARD],
  );
  const text = JSON.stringify(out);

  it('re-points track-steps at the scratch board and leaves no central reference outside the deny rules', () => {
    expect(out.hooks?.PostToolUse[0].hooks?.[0].command).toBe(`BOARD_DIR_OVERRIDE='${SCRATCH}' node '${RUN_HOOK}' track-steps open`);
    expect(() => assertNoCentralBoard(text, CENTRAL, 'settings')).not.toThrow();
  });

  it('strips the overrides that would win over BOARD_DIR_OVERRIDE', () => {
    expect(out.env).toEqual({ FOO: '1', BOARD_DIR_OVERRIDE: SCRATCH });
  });

  it('denies the live checkout AND a separate board to the file tools, keeping existing permissions', () => {
    expect(out.permissions?.allow).toEqual(['Bash(ls:*)']);
    expect(out.permissions?.deny).toEqual(denyRulesFor([CENTRAL, BOARD]));
    expect(out.permissions?.deny).toEqual(expect.arrayContaining([`Read(/${CENTRAL}/**)`, `Read(/${BOARD}/**)`, `Edit(/${BOARD}/**)`]));
    expect(() => assertNoCentralBoard(text, BOARD, 'settings')).not.toThrow();
  });

  it('keeps the guards the session would have loaded', () => {
    expect(out.hooks?.PreToolUse).toEqual(USER.hooks?.PreToolUse);
  });
});

describe('assertNoCentralBoard (the control on the rewrite — proven to go red)', () => {
  it('throws on the unrewritten user settings', () => {
    expect(() => assertNoCentralBoard(JSON.stringify(USER), CENTRAL, 'settings')).toThrow(/central board/);
  });

  it('throws on any surviving mention, whatever field it sits in', () => {
    expect(() => assertNoCentralBoard(JSON.stringify({ x: { y: `${CENTRAL}/tickets` } }), CENTRAL, 'settings')).toThrow();
  });

  it('still throws when a real reference sits beside the exempt deny rules', () => {
    const withLeak = { permissions: { deny: denyRulesFor([CENTRAL]) }, env: { TICKETS_DIR_OVERRIDE: `${CENTRAL}/tickets` } };
    expect(() => assertNoCentralBoard(JSON.stringify(withLeak), CENTRAL, 'settings')).toThrow(/central board/);
  });
});

describe('foreignAncestorClaudeMds', () => {
  const present = new Set(['/w/CLAUDE.md', '/w/projects/hardpack/CLAUDE.md', '/elsewhere/CLAUDE.md']);
  const exists = (p: string): boolean => present.has(p);

  it('allows an ancestor CLAUDE.md a real session in the live checkout also loads', () => {
    expect(foreignAncestorClaudeMds('/w/projects/.eval/run/c/t/repo', '/w/projects/hardpack', exists)).toEqual([]);
  });

  it('flags one the live checkout never loads — including the live checkout\'s own', () => {
    expect(foreignAncestorClaudeMds('/elsewhere/run/repo', '/w/projects/hardpack', exists)).toEqual(['/elsewhere/CLAUDE.md']);
    expect(foreignAncestorClaudeMds('/w/projects/hardpack/sub/repo', '/w/projects/hardpack', exists)).toEqual(['/w/projects/hardpack/CLAUDE.md']);
  });
});

describe('mcpConfig', () => {
  it('runs the fixture\'s own kanban server on the scratch board', () => {
    const cfg: unknown = JSON.parse(mcpConfig(SCRATCH));
    expect(cfg).toEqual({ mcpServers: { kanban: { type: 'stdio', command: 'npx', args: ['tsx', 'mcp/server.ts'], env: { BOARD_DIR_OVERRIDE: SCRATCH } } } });
    expect(() => assertNoCentralBoard(mcpConfig(SCRATCH), CENTRAL, 'MCP config')).not.toThrow();
  });
});

describe('sessionArgs', () => {
  const args = sessionArgs({ settingsPath: '/s.json', mcpConfigPath: '/m.json' }, 25);

  it('excludes user settings and non-eval MCP servers, and disallows the network tools', () => {
    expect(args).toEqual(expect.arrayContaining(['--setting-sources', 'project,local', '--strict-mcp-config']));
    expect(args[args.indexOf('--settings') + 1]).toBe('/s.json');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/m.json');
    expect(args[args.indexOf('--disallowedTools') + 1]).toBe(DISALLOWED_TOOLS.join(','));
    expect(DISALLOWED_TOOLS).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch', 'Bash(gh:*)', 'Bash(git fetch:*)', 'Bash(git clone:*)']));
  });

  it('ends on the variadic flag\'s single value, so no prompt positional can be swallowed', () => {
    expect(args.at(-2)).toBe('--disallowedTools');
  });

  it('requires a positive budget cap', () => {
    expect(args[args.indexOf('--max-budget-usd') + 1]).toBe('25');
    expect(() => sessionArgs({ settingsPath: '/s', mcpConfigPath: '/m' }, 0)).toThrow(/budget cap/);
    expect(() => sessionArgs({ settingsPath: '/s', mcpConfigPath: '/m' }, Number.NaN)).toThrow(/budget cap/);
  });
});

describe('replayPrompt', () => {
  it('names the ticket and the no-remote frame', () => {
    expect(replayPrompt('tkt-0123456789ab')).toMatch(/tkt-0123456789ab[\s\S]*NO remote/);
  });
});

describe('sessionResult', () => {
  it('reads cost, error flag and turns from the last result line', () => {
    const log = ['{"type":"system"}', '{"type":"result","total_cost_usd":4.72,"is_error":false,"num_turns":31}'].join('\n');
    expect(sessionResult(log)).toEqual({ costUsd: 4.72, isError: false, turns: 31 });
  });

  it('reads an error result — the shape an auth failure or a 429 takes', () => {
    expect(sessionResult('{"type":"result","total_cost_usd":0,"is_error":true,"num_turns":1}')).toEqual({ costUsd: 0, isError: true, turns: 1 });
  });

  it('returns a null cost, never 0, when the session reported no result', () => {
    expect(sessionResult('{"type":"system"}\n')).toEqual({ costUsd: null, isError: false, turns: null });
  });
});

describe('sanitizedEnv', () => {
  it('drops board, run-log, night-run and git-context variables and keeps the rest', () => {
    const out = sanitizedEnv({
      PATH: '/bin', HOME: '/h', BOARD_DIR_OVERRIDE: 'x', TICKETS_DIR_OVERRIDE: 'x', RUNS_DIR_OVERRIDE: 'x',
      EMBED_CACHE_PATH: 'x', NIGHT_RUN_PID: '1', GIT_DIR: '/repo/.git', GIT_INDEX_FILE: 'x', GIT_AUTHOR_NAME: 'kept',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: 'x', GIT_CONFIG_GLOBAL: 'x', CLAUDE_CONFIG_DIR: 'x',
    }, { BOARD_DIR_OVERRIDE: SCRATCH });
    expect(out).toEqual({ PATH: '/bin', HOME: '/h', GIT_AUTHOR_NAME: 'kept', BOARD_DIR_OVERRIDE: SCRATCH });
  });
});
