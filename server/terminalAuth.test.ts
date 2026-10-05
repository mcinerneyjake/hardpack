import { describe, it, expect } from 'vitest';
import {
  isAllowedOrigin, isAllowedHost, isValidToken, buildSessionEnv, allowedRootsFor,
  buildDetachedRunArgs, buildAttachArgs, buildReattachCommand, dtachSocket, filterAdoptable, resolveSessionCommand,
  isHostGatewayRejection, withoutHostGateway,
  authorizeUpgrade, authorizeReattach, parseClientFrame, parseTicketParam, parseSessionParam,
  isValidSessionId, rootMountArgs, MAX_INPUT_CHARS, containerizeLoopbackUrl, llmEnvArgs, type CredMount,
} from './terminalAuth.js';

import type { Ticket } from '../shared/constants.js';

// A valid crypto.randomUUID()-shaped session id, used for the detached run label + dtach socket.
const SID = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';

const KANBAN = '/repo/kanban';
const PORTFOLIO = '/repo/portfolio-site';
const PROJECT_ROOTS = { kanban: KANBAN, 'portfolio-site': PORTFOLIO };
const CRED: CredMount = { hostHome: '/host/home', containerHome: '/kanban-home' };

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: 'tkt-0123456789ab', title: 'Do the thing', type: 'feature', priority: 'high',
    status: 'in-progress', order: 1, created: 'x', updated: 'x', body: '',
    project: 'kanban', blockers: [], parent: null, dueDate: null, assignee: null, autonomy: 'hitl', spec: null,
    ...overrides,
  };
}

describe('isAllowedOrigin', () => {
  it('allows localhost dev origins', () => {
    expect(isAllowedOrigin('http://localhost:5173', {})).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3001', {})).toBe(true);
  });

  it('rejects a foreign origin and undefined', () => {
    expect(isAllowedOrigin('https://evil.example', {})).toBe(false);
    expect(isAllowedOrigin('http://evil.example:5173', {})).toBe(false); // right port, wrong host
    expect(isAllowedOrigin('https://localhost:5173', {})).toBe(false);   // right host+port, wrong scheme
    expect(isAllowedOrigin(undefined, {})).toBe(false);
  });

  // tkt-9ee5a1dfa141 — the suite previously asserted `localhost:8080 === false` as "rejects a wrong
  // port", which pinned the bug as intended behavior.
  it('tracks KANBAN_PORT_OFFSET on both the web and API ports', () => {
    const offset = { KANBAN_PORT_OFFSET: '50' };
    expect(isAllowedOrigin('http://localhost:5223', offset)).toBe(true);  // web 5173 + 50
    expect(isAllowedOrigin('http://127.0.0.1:3051', offset)).toBe(true);  // api 3001 + 50
    // …and the unshifted pair is no longer valid for THAT worktree.
    expect(isAllowedOrigin('http://localhost:5173', offset)).toBe(false);
  });

  it('honours an explicit PORT override for the API origin', () => {
    expect(isAllowedOrigin('http://localhost:4000', { PORT: '4000' })).toBe(true);
  });

  // Guards against "just make it port-blind" — another local dev server would then pass the gate.
  it('still rejects an arbitrary loopback port', () => {
    expect(isAllowedOrigin('http://localhost:8080', {})).toBe(false);
    expect(isAllowedOrigin('http://localhost:9999', { KANBAN_PORT_OFFSET: '50' })).toBe(false);
  });
});

describe('isAllowedHost', () => {
  it('allows loopback hosts on any port', () => {
    expect(isAllowedHost('localhost:5173')).toBe(true);
    expect(isAllowedHost('127.0.0.1:3001')).toBe(true);
    expect(isAllowedHost('localhost')).toBe(true);
    expect(isAllowedHost('[::1]:3001')).toBe(true);
    // KANBAN_PORT_OFFSET moves both dev ports; a port-pinned allowlist would reject a real worktree.
    expect(isAllowedHost('localhost:5223')).toBe(true);
    expect(isAllowedHost('127.0.0.1:3051')).toBe(true);
  });

  it('rejects the rebound-DNS host, which is the whole point', () => {
    expect(isAllowedHost('evil.com')).toBe(false);
    expect(isAllowedHost('evil.com:3001')).toBe(false);
    // Rebinding needs a NAME; a name that merely contains "localhost" must not pass.
    expect(isAllowedHost('localhost.evil.com')).toBe(false);
    expect(isAllowedHost('notlocalhost')).toBe(false);
  });

  // The two names `isLoopbackHost` accepts that must not pass as a DIALED name: one is a route to
  // loopback rather than a name for it, the other is a name whose loopback-ness depends on a resolver
  // nobody here controls. Both stay loopback for the URL that predicate containerizes, so this is the
  // gate's own decision and the only place it can be asserted (tkt-fc40f49495c1).
  it('rejects 0.0.0.0 even though isLoopbackHost accepts it for a URL', () => {
    expect(isAllowedHost('0.0.0.0')).toBe(false);
    expect(isAllowedHost('0.0.0.0:3001')).toBe(false);
    expect(containerizeLoopbackUrl('http://0.0.0.0:1234/v1')).toBe('http://host.docker.internal:1234/v1');
  });

  it('rejects *.localhost, which a resolver that ignores RFC 6761 lets an attacker publish', () => {
    expect(isAllowedHost('attacker.localhost')).toBe(false);
    expect(isAllowedHost('attacker.localhost:3001')).toBe(false);
    expect(isAllowedHost('évil.localhost')).toBe(false); // punycoded by URL to xn--vil-9la.localhost
    expect(isAllowedHost('.localhost')).toBe(false);
    // Bare `localhost` is what everything real dials, so the suffix rule must not swallow it.
    expect(isAllowedHost('localhost')).toBe(true);
    expect(containerizeLoopbackUrl('http://lm.localhost:1234/v1')).toBe('http://host.docker.internal:1234/v1');
  });

  it('rejects credential and absent-header tricks', () => {
    // URL parses these to hostname evil.com — the loopback part is userinfo, not the host dialed.
    expect(isAllowedHost('localhost@evil.com')).toBe(false);
    expect(isAllowedHost('127.0.0.1@evil.com')).toBe(false);
    expect(isAllowedHost(undefined)).toBe(false);
    expect(isAllowedHost('')).toBe(false);
  });
});

describe('isValidToken', () => {
  it('accepts an exact match', () => {
    expect(isValidToken('abc', 'abc')).toBe(true);
  });
  it('rejects wrong, empty, or null — and never authorizes on an empty expected', () => {
    expect(isValidToken('nope', 'abc')).toBe(false);
    expect(isValidToken(null, 'abc')).toBe(false);
    expect(isValidToken(undefined, 'abc')).toBe(false);
    expect(isValidToken('', '')).toBe(false); // misconfig must not authorize
    expect(isValidToken('x', '')).toBe(false);
  });
});

describe('buildSessionEnv', () => {
  it('keeps allowlisted keys and forces TERM', () => {
    const env = buildSessionEnv({ PATH: '/usr/bin', HOME: '/home/someuser', TERM: 'dumb' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/someuser');
    expect(env.TERM).toBe('xterm-256color');
  });
  it('drops secret-shaped keys not on the allowlist', () => {
    const env = buildSessionEnv({
      PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-ant', GITHUB_TOKEN: 'ghp_x', AWS_SECRET_ACCESS_KEY: 'z',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect('ANTHROPIC_API_KEY' in env).toBe(false);
    expect('GITHUB_TOKEN' in env).toBe(false);
    expect('AWS_SECRET_ACCESS_KEY' in env).toBe(false);
  });
  it('keeps DOCKER_ daemon-selection vars (not secrets, needed to reach the daemon)', () => {
    const env = buildSessionEnv({ PATH: '/usr/bin', DOCKER_HOST: 'tcp://x', DOCKER_CONTEXT: 'colima' });
    expect(env.DOCKER_HOST).toBe('tcp://x');
    expect(env.DOCKER_CONTEXT).toBe('colima');
  });
});

describe('allowedRootsFor', () => {
  it('shell mode (no ticket) → kanban only', () => {
    expect(allowedRootsFor({ ticket: null, projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN })).toEqual([KANBAN]);
  });
  it('kanban ticket → kanban only', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'kanban' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([KANBAN]);
  });
  it('cross-project ticket → project root first, then kanban', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'portfolio-site' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([PORTFOLIO, KANBAN]);
  });
  it('unmapped project → kanban-only fallback, never the whole disk', () => {
    expect(allowedRootsFor({ ticket: ticket({ project: 'mystery' }), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN }))
      .toEqual([KANBAN]);
  });
});

describe('buildDetachedRunArgs', () => {
  const base = {
    roots: [KANBAN], sessionId: SID, rootLabel: KANBAN, createdAt: 1_700_000_000_000,
    credMount: CRED, image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('mounts each allowed root', () => {
    const joined = buildDetachedRunArgs({ ...base, roots: [PORTFOLIO, KANBAN] }).join(' ');
    expect(joined).toContain(`${PORTFOLIO}:${PORTFOLIO}`);
    expect(joined).toContain(`${KANBAN}:${KANBAN}`);
  });
  it('mounts the persistent HOME + sets HOME, and never passes the token as an -e var', () => {
    const args = buildDetachedRunArgs(base);
    expect(args.join(' ')).toContain(`${CRED.hostHome}:${CRED.containerHome}`);
    expect(args.join(' ')).toContain(`HOME=${CRED.containerHome}`);
    expect(args.some((a: string) => a.includes('CLAUDE_CODE_OAUTH_TOKEN'))).toBe(false);
    expect(args.some((a: string) => a.includes('ANTHROPIC'))).toBe(false);
  });
  it('does not mount any non-allowed host path (roots, HOME, or named node_modules volumes only)', () => {
    const args = buildDetachedRunArgs(base);
    const mounts = args.filter((_: string, i: number) => args[i - 1] === '-v');
    // Pins the loop: with no `-v` args this asserted nothing while reporting that no disallowed host
    // path is mounted — a security boundary vouched for by an empty loop (tkt-9c818426feb3).
    expect(mounts.length).toBeGreaterThan(0);
    for (const mount of mounts) {
      const src = mount.split(':')[0];
      // A host path must be an allowed root or the HOME dir; node_modules sources are named
      // volumes (no host path), so a wrong-platform host node_modules can't leak in.
      const ok = src === KANBAN || src === CRED.hostHome || src.startsWith('kanbanterm-nm-');
      expect(ok).toBe(true);
    }
  });
  it('shadows each root node_modules with a named volume and passes the install dirs', () => {
    const joined = buildDetachedRunArgs({ ...base, roots: [PORTFOLIO, KANBAN] }).join(' ');
    expect(joined).toContain(`:${PORTFOLIO}/node_modules`);
    expect(joined).toContain(`:${KANBAN}/node_modules`);
    expect(joined).toContain(`KANBAN_INSTALL_DIRS=${PORTFOLIO}:${KANBAN}`);
  });
  it('runs DETACHED (-d, no --rm/-it), names + labels the container, and runs claude under dtach', () => {
    const args = buildDetachedRunArgs(base);
    expect(args.slice(0, 2)).toEqual(['run', '-d']);
    expect(args).not.toContain('-it');
    expect(args).not.toContain('--rm'); // must persist independent of the `docker run` client
    expect(args[args.indexOf('--name') + 1]).toBe('kanban-term-1');
    expect(args.join(' ')).toContain(`--label kanban.session=${SID}`); // discoverable after a restart
    expect(args.join(' ')).toContain(`--label kanban.root=${KANBAN}`); // scopes adoption to this checkout
    expect(args.join(' ')).toContain('--label kanban.created=1700000000000'); // reaper age (S3b)
    expect(args[args.indexOf('-w') + 1]).toBe(KANBAN);
    const imgIdx = args.indexOf('kanban-terminal');
    expect(args.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
  });
  it('throws loudly on empty roots rather than mounting nothing', () => {
    expect(() => buildDetachedRunArgs({ ...base, roots: [] })).toThrow(/non-empty/);
  });
});

describe('isHostGatewayRejection', () => {
  // VERBATIM from `docker run --rm --add-host foo:not-an-ip alpine true` on docker 29.6.2 — the shape
  // is what matters: docker renders the value with %q, so it is DOUBLE-QUOTED. The first version of
  // this matcher was written against a hand-guessed unquoted message and could never fire; the tests
  // passed because they asserted the same fabrication. Do not "simplify" these fixtures by hand.
  const REAL_UNRELATED = 'invalid argument "foo:not-an-ip" for "--add-host" flag: invalid IP address in add-host: "not-an-ip"';
  const REAL_REJECTION = 'invalid argument "host.docker.internal:host-gateway" for "--add-host" flag: invalid IP address in add-host: "host-gateway"';

  it('matches docker\'s ACTUAL quoted message for the unsupported magic value', () => {
    expect(isHostGatewayRejection(REAL_REJECTION)).toBe(true);
  });

  it('also matches unquoted / whole-pair spellings, in case another engine words it differently', () => {
    expect(isHostGatewayRejection('docker: invalid IP address in add-host: host-gateway')).toBe(true);
    expect(isHostGatewayRejection('invalid IP address in add-host: "host.docker.internal:host-gateway"')).toBe(true);
    expect(isHostGatewayRejection('INVALID IP ADDRESS IN ADD-HOST:  "HOST-GATEWAY"')).toBe(true);
  });

  // The narrowness IS the feature: a broad match would silently drop the alias on failures that have
  // nothing to do with it, hiding the real cause behind a "successful" degraded start.
  it('does NOT match unrelated failures, including a real non-host-gateway add-host error', () => {
    expect(isHostGatewayRejection(REAL_UNRELATED)).toBe(false);
    expect(isHostGatewayRejection('Unable to find image \'kanban-terminal:latest\' locally')).toBe(false);
    expect(isHostGatewayRejection('docker: Error response from daemon: invalid mount config')).toBe(false);
    expect(isHostGatewayRejection('Cannot connect to the Docker daemon')).toBe(false);
    expect(isHostGatewayRejection('')).toBe(false);
  });

  // The two real fixtures differ only in the value, so this pins that the matcher discriminates on
  // exactly the thing that distinguishes them — not on any incidental shared text.
  it('discriminates between the two real messages, which differ only in the quoted value', () => {
    expect(isHostGatewayRejection(REAL_REJECTION)).toBe(true);
    expect(isHostGatewayRejection(REAL_UNRELATED)).toBe(false);
  });
});

describe('withoutHostGateway', () => {
  it('drops the flag and its value as a pair, leaving everything else in order', () => {
    const args = ['run', '-d', '--add-host', 'host.docker.internal:host-gateway', '-w', '/repo', 'img'];
    expect(withoutHostGateway(args)).toEqual(['run', '-d', '-w', '/repo', 'img']);
  });

  it('is a no-op when the flag is absent (already-stripped retry, or a future caller)', () => {
    const args = ['run', '-d', '-w', '/repo', 'img'];
    expect(withoutHostGateway(args)).toEqual(args);
  });

  it('never strips a DIFFERENT --add-host — it matches the exact value we emit', () => {
    const args = ['run', '--add-host', 'someother.host:1.2.3.4', 'img'];
    expect(withoutHostGateway(args)).toEqual(args);
  });

  it('does not mutate its input', () => {
    const args = ['run', '--add-host', 'host.docker.internal:host-gateway', 'img'];
    withoutHostGateway(args);
    expect(args).toHaveLength(4);
  });

  // Seam: the value crosses buildDetachedRunArgs → withoutHostGateway → docker.run. A unit test on a
  // hand-written argv would still pass if the builder changed how it emits the flag.
  it('strips the alias from a REAL buildDetachedRunArgs output, keeping the rest intact', () => {
    const full = buildDetachedRunArgs({
      roots: [KANBAN], sessionId: SID, rootLabel: KANBAN, createdAt: 1_700_000_000_000,
      credMount: CRED, image: 'kanban-terminal', containerName: 'kanban-term-1',
    });
    expect(full).toContain('--add-host'); // guard: the builder still emits it, so this test can fail

    const stripped = withoutHostGateway(full);
    expect(stripped).not.toContain('--add-host');
    expect(stripped.some((a) => a.includes('host-gateway'))).toBe(false);
    expect(stripped).toHaveLength(full.length - 2);
    // Everything the session actually needs survives.
    expect(stripped.join(' ')).toContain(`${CRED.hostHome}:${CRED.containerHome}`);
    expect(stripped.join(' ')).toContain(`${KANBAN}:${KANBAN}`);
    expect(stripped.slice(-4)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
  });
});

describe('buildAttachArgs / dtachSocket', () => {
  it('execs an interactive dtach attach on the session socket (winch redraw)', () => {
    // env pinned: attach now re-supplies the LLM endpoints, so an ambient process.env would
    // otherwise make this assertion environment-dependent (tkt-c0cf617fdcc4 review).
    expect(buildAttachArgs('kanban-term-1', SID, { LLM_BASE_URL: 'http://x/v1', EMBED_BASE_URL: 'http://x/v1' })).toEqual(
      ['exec', '-it', '-e', 'LLM_BASE_URL', '-e', 'EMBED_BASE_URL',
        'kanban-term-1', 'dtach', '-a', dtachSocket(SID), '-E', '-r', 'winch'],
    );
  });
  it('dtachSocket is a per-session path under /tmp', () => {
    expect(dtachSocket(SID)).toBe(`/tmp/kanban-term-${SID}.dtach`);
  });
});

describe('filterAdoptable', () => {
  const KNOWN = '11111111-2222-4333-8444-555566667777';
  const isKnown = (id: string) => id === KNOWN;
  it('keeps only OUR containers with a valid, not-already-known session id', () => {
    const rows = [
      { name: 'kanban-term-aaa', session: SID },                 // valid + unknown → keep
      { name: 'kanban-term-bbb', session: KNOWN },               // already tracked → drop
      { name: 'other-thing', session: SID },                     // not our name prefix → drop
      { name: 'kanban-term-ccc', session: 'not-a-uuid' },        // invalid id label → drop
    ];
    expect(filterAdoptable(rows, isKnown)).toEqual([{ name: 'kanban-term-aaa', session: SID }]);
  });
  it('empty in → empty out', () => {
    expect(filterAdoptable([], isKnown)).toEqual([]);
  });
});

describe('rootMountArgs', () => {
  it('mounts each root, shadows its node_modules with a volume, and passes the install dirs', () => {
    const joined = rootMountArgs([PORTFOLIO, KANBAN]).join(' ');
    expect(joined).toContain(`${PORTFOLIO}:${PORTFOLIO}`);
    expect(joined).toContain(`:${PORTFOLIO}/node_modules`);
    expect(joined).toContain(`:${KANBAN}/node_modules`);
    expect(joined).toContain(`KANBAN_INSTALL_DIRS=${PORTFOLIO}:${KANBAN}`);
  });
  it('gives paths that differ only by a separator DISTINCT volumes (no lossy collision)', () => {
    const volA = rootMountArgs(['/repo/a/b']).find((a) => a.includes(':/repo/a/b/node_modules'))?.split(':')[0];
    const volB = rootMountArgs(['/repo/a-b']).find((a) => a.includes(':/repo/a-b/node_modules'))?.split(':')[0];
    expect(volA).toBeDefined();
    expect(volB).toBeDefined();
    expect(volA).not.toBe(volB); // a lossy /↔- substitution would have collided these
  });
});

describe('resolveSessionCommand', () => {
  const common = {
    sessionId: SID,
    getTicket: async (id: string) => ticket({ id }),
    projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN, createdAt: 1_700_000_000_000, credMount: CRED,
    image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('no ticket → detached claude under dtach + a matching attach, no prefill (never a raw shell)', async () => {
    const { runArgs, attachArgs, socket, prefill, roots } = await resolveSessionCommand({ ...common, env: {} });
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(runArgs).not.toContain('bash');
    expect(runArgs).not.toContain('--add-dir'); // variadic arg would swallow input; confinement is via mounts
    // Attach re-supplies the LLM env; with an empty host env that's the containerized default.
    expect(attachArgs).toEqual([
      'exec', '-it',
      '-e', 'LLM_BASE_URL', '-e', 'EMBED_BASE_URL',
      'kanban-term-1', 'dtach', '-a', dtachSocket(SID), '-E', '-r', 'winch',
    ]);
    expect(socket).toBe(dtachSocket(SID));
    expect(prefill).toBeUndefined();
    expect(roots).toEqual([KANBAN]); // the transport pre-installs deps for these
  });
  it('rejects a malformed ticket id and never calls getTicket', async () => {
    let called = false;
    await expect(resolveSessionCommand({
      ...common, ticket: 'tkt-BADID',
      getTicket: async (id) => { called = true; return ticket({ id }); },
    })).rejects.toThrow(/Invalid ticket id/);
    expect(called).toBe(false);
  });
  it('propagates an unknown-ticket rejection from getTicket', async () => {
    await expect(resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async () => { throw new Error('Ticket not found: tkt-0123456789ab'); },
    })).rejects.toThrow(/not found/);
  });

  // Integration seam (id → getTicket → seed prefill): the real id + title must survive the
  // lookup into the prefill — no field dropped/mangled at the boundary. The command stays
  // bare claude (the prefill is typed in by the transport, not passed as an arg).
  it('carries the real ticket id and title into the prefill (fidelity invariant)', async () => {
    const { runArgs, prefill } = await resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async (id) => ticket({ id, title: 'Fix the CSV export crash' }),
    });
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(prefill).toContain('tkt-0123456789ab');
    expect(prefill).toContain('Fix the CSV export crash');
  });

  // The prefill is TYPED into the pty, so a title with a CR/LF would auto-submit and ESC could
  // inject a control sequence. A board-controlled title must never carry a control byte through.
  it('strips control chars from the title so the prefill cannot auto-submit or inject', async () => {
    const CR = String.fromCharCode(13), LF = String.fromCharCode(10), ESC = String.fromCharCode(27);
    const title = `evil"${CR}${LF}rm -rf${ESC}[2J then more`;
    const { prefill } = await resolveSessionCommand({
      ...common, ticket: 'tkt-0123456789ab',
      getTicket: async (id) => ticket({ id, title }),
    });
    expect(prefill).toBeDefined();
    // No CR/LF (would submit) or ESC/C0 controls (would inject a sequence) survive into the prefill.
    const controls = [...(prefill ?? '')].filter((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f);
    expect(controls).toEqual([]);
  });
});

// End-to-end seam: the ticket id the widget puts on the WS URL (encodeURIComponent) must
// survive parse → lookup → seed into the spawned command. Drives the REAL chain, stubbing
// only getTicket — so a drop/mangle anywhere from URL to argv fails here (per CLAUDE.md).
describe('ticket-param round trip (widget URL → server parse → seeded command)', () => {
  it('threads the id from the ?ticket= query all the way into the seed', async () => {
    const id = 'tkt-0123456789ab';
    const title = 'Fix the CSV export crash';
    const rawUrl = `/terminal-ws?ticket=${encodeURIComponent(id)}`; // what TerminalWidget builds
    const parsed = parseTicketParam(rawUrl);
    expect(parsed).toBe(id);

    const { runArgs, prefill } = await resolveSessionCommand({
      ticket: parsed, sessionId: SID, getTicket: async (tid) => ticket({ id: tid, title }),
      projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN, createdAt: 1_700_000_000_000, credMount: CRED,
      image: 'kanban-terminal', containerName: 'kanban-term-1',
    });
    // The command stays bare claude-under-dtach; the id + title thread through to the prefill.
    const imgIdx = runArgs.indexOf('kanban-terminal');
    expect(runArgs.slice(imgIdx + 1)).toEqual(['dtach', '-N', dtachSocket(SID), 'claude']);
    expect(prefill).toContain(id);
    expect(prefill).toContain(title);
  });
  it('no ?ticket= → shell/bare session (null, not a crash)', () => {
    expect(parseTicketParam('/terminal-ws')).toBeNull();
    expect(parseTicketParam('')).toBeNull();
  });
});

describe('authorizeUpgrade', () => {
  // env pinned: the suite itself runs in a worktree with KANBAN_PORT_OFFSET set, which would
  // otherwise move the ports out from under these origins.
  const base = {
    path: '/terminal-ws', wsPath: '/terminal-ws', origin: 'http://localhost:5173',
    token: 'secret', expected: 'secret', activeSessions: 0, maxSessions: 2, env: {},
  };
  it('accepts a fully valid upgrade', () => {
    expect(authorizeUpgrade(base)).toEqual({ ok: true });
  });
  it('ignores a non-terminal path (404 so HMR/others pass through)', () => {
    const d = authorizeUpgrade({ ...base, path: '/other' });
    expect(d).toEqual({ ok: false, status: 404, reason: 'not the terminal path' });
  });
  // Seam: KANBAN_PORT_OFFSET → shared/ports.ts → isAllowedOrigin → this decision. A test on the gate
  // alone wouldn't catch authorizeUpgrade dropping env on the way through (tkt-9ee5a1dfa141).
  it('authorizes an offset worktree\'s origin end to end', () => {
    const env = { KANBAN_PORT_OFFSET: '50' };
    expect(authorizeUpgrade({ ...base, origin: 'http://localhost:5223', env })).toEqual({ ok: true });
    expect(authorizeUpgrade({ ...base, origin: 'http://localhost:5173', env }))
      .toMatchObject({ ok: false, status: 403, reason: 'origin not allowed' });
    expect(authorizeUpgrade({ ...base, origin: 'https://evil.example', env }))
      .toMatchObject({ ok: false, status: 403 });
  });

  it('rejects a bad origin (403)', () => {
    expect(authorizeUpgrade({ ...base, origin: 'https://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeUpgrade({ ...base, origin: undefined })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a bad/missing token (403)', () => {
    expect(authorizeUpgrade({ ...base, token: 'wrong' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeUpgrade({ ...base, token: null })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects once the session cap is reached (503)', () => {
    expect(authorizeUpgrade({ ...base, activeSessions: 2 })).toMatchObject({ ok: false, status: 503 });
  });
});

describe('isValidSessionId', () => {
  it('accepts a crypto.randomUUID()-shaped v4 id', () => {
    expect(isValidSessionId('3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c')).toBe(true);
  });
  it('rejects malformed, wrong-version, null, and non-string ids', () => {
    expect(isValidSessionId('not-a-uuid')).toBe(false);
    expect(isValidSessionId('3f8a1c2d-4b5e-1f6a-8b9c-0d1e2f3a4b5c')).toBe(false); // version nibble not 4
    expect(isValidSessionId('3f8a1c2d-4b5e-4f6a-7b9c-0d1e2f3a4b5c')).toBe(false); // variant nibble not 8/9/a/b
    expect(isValidSessionId('tkt-0123456789ab')).toBe(false);
    expect(isValidSessionId(null)).toBe(false);
    expect(isValidSessionId(undefined)).toBe(false);
  });
});

describe('parseSessionParam', () => {
  it('reads the ?session= id the widget puts on the WS URL, null when absent', () => {
    const id = '3f8a1c2d-4b5e-4f6a-8b9c-0d1e2f3a4b5c';
    expect(parseSessionParam(`/terminal-ws?session=${id}`)).toBe(id);
    expect(parseSessionParam(`/terminal-ws?ticket=tkt-0123456789ab&session=${id}`)).toBe(id);
    expect(parseSessionParam('/terminal-ws')).toBeNull();
    expect(parseSessionParam('')).toBeNull();
  });
});

describe('authorizeReattach', () => {
  const base = {
    origin: 'http://localhost:5173', token: 'secret', expected: 'secret',
    lookup: 'found' as const, env: {},
  };
  it('accepts a detached session on a valid origin + token', () => {
    expect(authorizeReattach(base)).toEqual({ ok: true });
  });
  it('accepts an attached-elsewhere lookup (reload race → last-writer-wins takeover)', () => {
    expect(authorizeReattach({ ...base, lookup: 'attached-elsewhere' })).toEqual({ ok: true });
  });
  it('rejects a bad origin (403)', () => {
    expect(authorizeReattach({ ...base, origin: 'https://evil.example' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeReattach({ ...base, origin: undefined })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a bad/missing token (403) — id is not a capability without the token', () => {
    expect(authorizeReattach({ ...base, token: 'wrong' })).toMatchObject({ ok: false, status: 403 });
    expect(authorizeReattach({ ...base, token: null })).toMatchObject({ ok: false, status: 403 });
  });
  it('rejects a not-found lookup (404, defensive — caller routes unknown ids to new sessions)', () => {
    expect(authorizeReattach({ ...base, lookup: 'not-found' })).toMatchObject({ ok: false, status: 404 });
  });
});

describe('parseClientFrame', () => {
  it('parses input and resize frames', () => {
    expect(parseClientFrame('{"t":"i","d":"ls\\n"}')).toEqual({ t: 'i', d: 'ls\n' });
    expect(parseClientFrame('{"t":"r","cols":120,"rows":40}')).toEqual({ t: 'r', cols: 120, rows: 40 });
  });
  it('parses the terminate frame', () => {
    expect(parseClientFrame('{"t":"e"}')).toEqual({ t: 'e' });
  });
  it('drops malformed, mistyped, or unknown frames', () => {
    expect(parseClientFrame('not json')).toBeNull();
    expect(parseClientFrame('null')).toBeNull();
    expect(parseClientFrame('{"t":"i"}')).toBeNull();          // missing d
    expect(parseClientFrame('{"t":"r","cols":"80","rows":24}')).toBeNull(); // cols not a number
    expect(parseClientFrame('{"t":"x"}')).toBeNull();          // unknown type
  });
  it('rejects non-positive / non-integer resize dims (node-pty would throw → server crash)', () => {
    expect(parseClientFrame('{"t":"r","cols":0,"rows":0}')).toBeNull();     // FitAddon on a hidden pane
    expect(parseClientFrame('{"t":"r","cols":-5,"rows":10}')).toBeNull();
    expect(parseClientFrame('{"t":"r","cols":80.5,"rows":24}')).toBeNull(); // non-integer
  });
  it('clamps oversized resize dims to the max', () => {
    expect(parseClientFrame('{"t":"r","cols":99999,"rows":99999}')).toEqual({ t: 'r', cols: 1000, rows: 1000 });
  });
  it('drops an oversized input frame instead of writing it to the pty', () => {
    const atCap = JSON.stringify({ t: 'i', d: 'x'.repeat(MAX_INPUT_CHARS) });
    const overCap = JSON.stringify({ t: 'i', d: 'x'.repeat(MAX_INPUT_CHARS + 1) });
    expect(parseClientFrame(atCap)).toEqual({ t: 'i', d: 'x'.repeat(MAX_INPUT_CHARS) });
    expect(parseClientFrame(overCap)).toBeNull();
  });
});

describe('containerizeLoopbackUrl', () => {
  // Inside a container `localhost` is the container itself — the host's LM Studio is unreachable
  // there, which is why an un-rewritten default silently fails (tkt-c0cf617fdcc4).
  it('rewrites every loopback spelling to the container host alias', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0']) {
      expect(containerizeLoopbackUrl(`http://${host}:1234/v1`)).toBe('http://host.docker.internal:1234/v1');
    }
    expect(containerizeLoopbackUrl('http://[::1]:1234/v1')).toBe('http://host.docker.internal:1234/v1');
  });

  it('preserves port, path and scheme', () => {
    expect(containerizeLoopbackUrl('https://localhost:8443/api/v1')).toBe('https://host.docker.internal:8443/api/v1');
  });

  // A LAN or remote endpoint is already reachable from the container; rewriting it would BREAK it.
  it('leaves a non-loopback host untouched', () => {
    for (const url of ['http://192.168.1.50:1234/v1', 'https://llm.example.com/v1', 'http://ollama:11434/v1']) {
      expect(containerizeLoopbackUrl(url)).toBe(url);
    }
  });

  it('preserves the trailing-slash shape of the input', () => {
    expect(containerizeLoopbackUrl('http://localhost:1234/')).toBe('http://host.docker.internal:1234/');
    expect(containerizeLoopbackUrl('http://localhost:1234')).toBe('http://host.docker.internal:1234');
  });

  it('returns an unparseable value as-is rather than guessing', () => {
    for (const junk of ['', 'not a url', 'localhost:1234']) {
      expect(containerizeLoopbackUrl(junk)).toBe(junk);
    }
  });
});

describe('llmEnvArgs', () => {
  // tkt-281272b5ef77 moved the endpoint VALUES out of argv. The argv now names the variables and
  // docker reads their values from its own environment (supplied by buildSessionEnv), because the
  // host process table is world-readable via `ps aux` and a credential can ride in a URL.
  it('names the endpoints without their values, so no URL reaches the argv', () => {
    const args = llmEnvArgs({ LLM_BASE_URL: 'http://localhost:1234/v1', EMBED_BASE_URL: 'http://localhost:1234/v1' });
    // No LLM_API_KEY: the host set none, and naming a variable with no value BLANKS it on `exec`.
    expect(args).toEqual(['-e', 'LLM_BASE_URL', '-e', 'EMBED_BASE_URL']);
    expect(args.join(' ')).not.toContain('http');
  });

  // The no-.env case is the DEFAULT install, so omitting the endpoint would leave the container
  // falling back to its own localhost — the one address it can never reach. The value now lives in
  // buildSessionEnv, but the guarantee is unchanged.
  it('still reaches the container when unset or empty, never container-localhost', () => {
    expect(llmEnvArgs({})).toContain('LLM_BASE_URL');
    for (const blank of ['', '   ', undefined]) {
      const env = buildSessionEnv({ LLM_BASE_URL: blank });
      expect(env.LLM_BASE_URL).toBe('http://host.docker.internal:1234/v1');
    }
    expect(buildSessionEnv({}).LLM_BASE_URL).not.toContain('localhost:1234');
  });

  it('carries a custom remote endpoint through unchanged', () => {
    const env = buildSessionEnv({ LLM_BASE_URL: 'https://llm.example.com/v1' });
    expect(env.LLM_BASE_URL).toBe('https://llm.example.com/v1');
    // The unset sibling still gets the containerized default, not the remote one.
    expect(env.EMBED_BASE_URL).toBe('http://host.docker.internal:1234/v1');
  });

  // tkt-2c8af65c114e: forward the model ids so the container asks the server for the model it actually
  // has loaded, instead of the agent's code default. Unlike the endpoints, models are NOT rewritten and
  // are omitted entirely when unset (an unset model means host + container share the same code default).
  // They keep `NAME=value` form: a model id is an opaque public string, not a credential.
  it('forwards LLM_MODEL / EMBED_MODEL verbatim when the host sets them', () => {
    const args = llmEnvArgs({
      LLM_BASE_URL: 'http://localhost:1234/v1', EMBED_BASE_URL: 'http://localhost:1234/v1',
      LLM_MODEL: 'openai/gpt-oss-20b', EMBED_MODEL: 'text-embedding-qwen3-embedding-0.6b',
    });
    expect(args).toEqual([
      '-e', 'LLM_BASE_URL', '-e', 'EMBED_BASE_URL',
      '-e', 'LLM_MODEL=openai/gpt-oss-20b',
      '-e', 'EMBED_MODEL=text-embedding-qwen3-embedding-0.6b',
    ]);
  });

  it('emits NO model arg when unset or blank — no invented default (container uses the agent default)', () => {
    expect(llmEnvArgs({}).join(' ')).not.toContain('LLM_MODEL');
    expect(llmEnvArgs({}).join(' ')).not.toContain('EMBED_MODEL');
    for (const blank of ['', '   ']) {
      const args = llmEnvArgs({ LLM_MODEL: blank, EMBED_MODEL: blank }).join(' ');
      expect(args).not.toContain('LLM_MODEL');
      expect(args).not.toContain('EMBED_MODEL');
    }
  });

  it('forwards one model independently of the other (chat set, embed unset)', () => {
    const args = llmEnvArgs({ LLM_MODEL: 'openai/gpt-oss-20b' });
    expect(args).toContain('LLM_MODEL=openai/gpt-oss-20b');
    expect(args.join(' ')).not.toContain('EMBED_MODEL');
  });

  it('is not rewritten like a URL — a model id that looks loopback-ish passes through verbatim', () => {
    // Guards against a future refactor accidentally running a model id through containerizeLoopbackUrl.
    const args = llmEnvArgs({ LLM_MODEL: 'localhost-tuned-model' });
    expect(args).toContain('LLM_MODEL=localhost-tuned-model');
  });
});

// tkt-281272b5ef77. argv is world-readable (`ps aux`, `docker inspect`) and the container holds it for
// its whole lifetime; the docker CLI's own environment is not. These pin the property, not the
// mechanism, so a future refactor that reintroduces `-e NAME=value` fails here.
describe('credentials never reach the docker argv (they still reach the container env)', () => {
  const SECRET = 'sekret';

  it.each([
    ['userinfo', `http://user:${SECRET}@localhost:1234/v1`],
    ['username only', `http://${SECRET}@localhost:1234/v1`],
    ['credential in the query', `http://localhost:1234/v1?api_key=${SECRET}`],
    ['both at once', `http://user:${SECRET}@localhost:1234/v1?token=${SECRET}`],
    ['remote host, not just loopback', `https://llm.example.com/v1?api_key=${SECRET}`],
  ])('keeps a %s out of every argv the session builds', (_name, url) => {
    const env = { LLM_BASE_URL: url, EMBED_BASE_URL: url };
    for (const args of [
      llmEnvArgs(env),
      buildAttachArgs('kanban-term-1', SID, env),
      buildDetachedRunArgs({
        roots: ['/repo'], sessionId: SID, rootLabel: '/repo', createdAt: 0,
        credMount: CRED, image: 'img', containerName: 'kanban-term-1', env,
      }),
    ]) {
      expect(args.join(' '), 'credential leaked into argv').not.toContain(SECRET);
    }
  });

  it('still delivers the credential-bearing URL to the container, via the CLI env', () => {
    // The other half: stripping the argv while dropping the value would "fix" the leak by breaking
    // the endpoint. The whole URL — credential included — must survive out-of-band.
    const url = `http://user:${SECRET}@localhost:1234/v1`;
    expect(buildSessionEnv({ LLM_BASE_URL: url }).LLM_BASE_URL)
      .toBe(`http://user:${SECRET}@host.docker.internal:1234/v1`);
  });

  it('forwards LLM_API_KEY, so a URL-embedded credential is no longer the only path', () => {
    // The severity finding in the audit: the agent reads LLM_API_KEY but nothing ever sent it to the
    // container, so the design funnelled users toward putting the credential in the URL.
    expect(llmEnvArgs({ LLM_API_KEY: 'sk-secret' })).toContain('LLM_API_KEY');
    expect(buildSessionEnv({ LLM_API_KEY: 'sk-secret' }).LLM_API_KEY).toBe('sk-secret');
    expect(llmEnvArgs({ LLM_API_KEY: 'sk-secret' }).join(' ')).not.toContain('sk-secret');
  });

  it('emits NO -e LLM_API_KEY at all when the host has none', () => {
    // Measured against docker 29.6.2, and the reason the flag is derived from the value rather than
    // hardcoded: `run` SKIPS a bare `-e NAME` whose value is absent, but `exec` BLANKS it — the
    // attach path would wipe a key the container was created with. Not symmetric, so not a no-op.
    for (const host of [{}, { LLM_API_KEY: '   ' }]) {
      expect(buildSessionEnv(host).LLM_API_KEY).toBeUndefined();
      expect(llmEnvArgs(host)).not.toContain('LLM_API_KEY');
    }
  });

  // The pairing invariant, and the reason `llmEnvArgs` derives its flags from `llmContainerEnv`
  // rather than from a second hardcoded list: a name in the argv with no value behind it is exactly
  // the silent-drop (on `run`) or blanking (on `exec`) above. Quantified over both argv, so a name
  // added to either half without the other is a red test, not a runtime surprise.
  it.each([
    ['host sets nothing', {}],
    ['host sets endpoints', { LLM_BASE_URL: 'http://127.0.0.9:9999/v1', EMBED_BASE_URL: 'https://e.example.com/v1' }],
    ['host sets a key too', { LLM_API_KEY: 'sk-secret' }],
  ])('every bare `-e NAME` it emits has a value in the CLI env — %s', (_name, env) => {
    const cliEnv = buildSessionEnv(env);
    const args = llmEnvArgs(env);
    const bareNames = args.filter((a, i) => args[i - 1] === '-e' && !a.includes('='));
    expect(bareNames.length).toBeGreaterThan(0); // pins the loop: an empty argv would assert nothing
    for (const name of bareNames) {
      expect(cliEnv[name], `-e ${name} is named in argv but has no value to inherit`).toBeDefined();
    }
  });
});

describe('buildDetachedRunArgs — LLM reachability', () => {
  const base = {
    roots: ['/repo'], sessionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', rootLabel: '/repo',
    createdAt: 0, credMount: { hostHome: '/h', containerHome: '/kanban-home' },
    image: 'img', containerName: 'kanban-term-x',
  };

  it('adds the host-gateway alias so the name resolves on Linux too', () => {
    const args = buildDetachedRunArgs({ ...base, env: {} });
    expect(args).toContain('--add-host');
    expect(args).toContain('host.docker.internal:host-gateway');
  });

  it('injects the host endpoints by NAME, with the rewritten value carried in the CLI env', () => {
    // The rewrite still happens; it moved from the argv to buildSessionEnv (tkt-281272b5ef77), so the
    // reachability guarantee is asserted across both halves rather than in the argv alone.
    const env = { LLM_BASE_URL: 'http://localhost:1234/v1' };
    const args = buildDetachedRunArgs({ ...base, env });
    expect(args).toContain('LLM_BASE_URL');
    expect(args.join(' ')).not.toContain('localhost:1234');
    expect(buildSessionEnv(env).LLM_BASE_URL).toBe('http://host.docker.internal:1234/v1');
  });
});

// Review findings on the first cut of this feature (tkt-c0cf617fdcc4): the loopback set was a list of
// literal spellings, so most of the loopback space fell through and reached the container unrewritten.
describe('containerizeLoopbackUrl — full loopback space', () => {
  it('rewrites all of 127.0.0.0/8, not just 127.0.0.1', () => {
    for (const host of ['127.0.0.2', '127.1.2.3', '127.255.255.254']) {
      expect(containerizeLoopbackUrl(`http://${host}:1234/v1`)).toBe('http://host.docker.internal:1234/v1');
    }
  });

  it('rewrites IPv4-mapped IPv6, in both the dotted and URL-normalized hex forms', () => {
    // URL normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1, so the dotted spelling never reaches the check.
    expect(new URL('http://[::ffff:127.0.0.1]:1234/v1').hostname).toBe('[::ffff:7f00:1]');
    expect(containerizeLoopbackUrl('http://[::ffff:127.0.0.1]:1234/v1')).toBe('http://host.docker.internal:1234/v1');
    expect(containerizeLoopbackUrl('http://[::ffff:7f00:1]:1234/v1')).toBe('http://host.docker.internal:1234/v1');
  });

  it('rewrites the alternate integer/octal/short spellings URL normalizes into 127.0.0.1', () => {
    for (const host of ['127.1', '0177.0.0.1', '2130706433']) {
      expect(containerizeLoopbackUrl(`http://${host}:1234/v1`)).toBe('http://host.docker.internal:1234/v1');
    }
  });

  it('rewrites bracketed ::1 and the RFC 6761 .localhost space', () => {
    expect(containerizeLoopbackUrl('http://[::1]:1234/v1')).toBe('http://host.docker.internal:1234/v1');
    expect(containerizeLoopbackUrl('http://lm.localhost:1234/v1')).toBe('http://host.docker.internal:1234/v1');
  });

  // The inverse error would be worse than the original bug: rewriting a reachable endpoint breaks it.
  it('does not rewrite hosts that merely resemble loopback', () => {
    for (const url of [
      'http://localhost.evil.com:1234/v1',   // localhost as a label, not the host
      'http://notlocalhost:1234/v1',
      'http://128.0.0.1:1234/v1',            // adjacent to 127/8, outside it
      'http://126.255.255.255:1234/v1',
      'http://[::2]:1234/v1',
      'http://[::ffff:8.8.8.8]:1234/v1',     // IPv4-mapped, but not loopback
    ]) {
      expect(containerizeLoopbackUrl(url)).toBe(url);
    }
  });
});

describe('buildAttachArgs — env repair on reattach', () => {
  const NAME = 'kanban-term-abc';
  const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  // A container adopted after an Express restart was created with whatever env existed then, and
  // --add-host can't be changed on exec — but `-e` can, so every attach re-supplies current config.
  it('re-supplies the LLM env, before the container name where docker exec expects options', () => {
    const args = buildAttachArgs(NAME, SID, { LLM_BASE_URL: 'http://localhost:1234/v1' });
    expect(args).toContain('LLM_BASE_URL');
    expect(args.indexOf('-e')).toBeLessThan(args.indexOf(NAME));
  });

  it('still ends with the dtach attach command, unchanged', () => {
    const args = buildAttachArgs(NAME, SID, {});
    expect(args.slice(0, 2)).toEqual(['exec', '-it']);
    expect(args.slice(-7)).toEqual([NAME, 'dtach', '-a', dtachSocket(SID), '-E', '-r', 'winch']);
  });

  // Reattach is the one path with no SessionCommand to read the pair off, so it is also the one that
  // could source argv and env from different host envs. buildReattachCommand exists to remove that
  // choice from the call site (tkt-281272b5ef77).
  it('buildReattachCommand pairs the argv with the env docker will inherit, from ONE host env', () => {
    const host = { LLM_BASE_URL: 'http://127.0.0.5:9999/v1', LLM_API_KEY: 'sk-secret' };
    const { attachArgs, env } = buildReattachCommand(NAME, SID, host);
    let checked = 0;
    for (const [i, a] of attachArgs.entries()) {
      if (attachArgs[i - 1] !== '-e' || a.includes('=')) continue;
      expect(env[a], `-e ${a} is named but has no value to inherit`).toBeDefined();
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
    expect(env.LLM_BASE_URL).toBe('http://host.docker.internal:9999/v1'); // loopback rewritten for the container
    expect(attachArgs.join(' ')).not.toContain('sk-secret');
  });
});

// Round-trip pin for the host→container config path (CLAUDE.md integration-seam rule): host env →
// resolveSessionCommand → docker argv. Unit tests on llmEnvArgs alone stayed green while the real
// chain dropped the value, because resolveSessionCommand never forwarded it (tkt-c0cf617fdcc4 review).
describe('resolveSessionCommand — LLM config round-trip', () => {
  const common = {
    sessionId: SID, getTicket: async () => ticket(), projectRoots: PROJECT_ROOTS, kanbanRoot: KANBAN,
    createdAt: 0, credMount: CRED, image: 'kanban-terminal', containerName: 'kanban-term-1',
  };

  it('carries a custom host endpoint all the way to the container — argv names it, CLI env values it', async () => {
    // The seam now has two halves and BOTH must be asserted: an argv-only check would pass against a
    // build that names the variable and never supplies it, which is exactly the silent-drop failure
    // this round-trip was written for (tkt-c0cf617fdcc4). tkt-281272b5ef77 split the halves.
    const env = { LLM_BASE_URL: 'http://127.0.0.9:9999/v1', EMBED_BASE_URL: 'https://embed.example.com/v1' };
    const command = await resolveSessionCommand({ ...common, ticket: null, env });
    for (const args of [command.runArgs, command.attachArgs]) {
      expect(args).toContain('LLM_BASE_URL');
      expect(args).toContain('EMBED_BASE_URL');
    }
    // command.env, NOT buildSessionEnv(env) recomputed here: calling the value supplier directly
    // would pass against a chain that names the variables in argv and hands the spawn a different
    // env — the two halves sourced separately, which is the seam this pins.
    // 127.0.0.9 is loopback → rewritten; the remote embed endpoint is reachable → untouched.
    expect(command.env.LLM_BASE_URL).toBe('http://host.docker.internal:9999/v1');
    expect(command.env.EMBED_BASE_URL).toBe('https://embed.example.com/v1');
  });

  it('pairs every bare `-e NAME` in BOTH argv with a value on the same command', async () => {
    // The whole-chain form of the pairing invariant: resolveSessionCommand must be the single source
    // of both halves. Sourcing the spawn env from anywhere else (e.g. buildSessionEnv(process.env)
    // recomputed at the call site) drops a custom endpoint silently on `run` and blanks it on `exec`.
    const env = { LLM_BASE_URL: 'http://127.0.0.9:9999/v1', LLM_API_KEY: 'sk-secret' };
    const command = await resolveSessionCommand({ ...common, ticket: null, env });
    let checked = 0;
    for (const args of [command.runArgs, command.attachArgs]) {
      for (const [i, a] of args.entries()) {
        if (args[i - 1] !== '-e' || a.includes('=')) continue;
        expect(command.env[a], `-e ${a} has no value on the command`).toBeDefined();
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0); // a rename that emptied both argv would otherwise pass
    expect(command.env.LLM_API_KEY).toBe('sk-secret');
    expect([...command.runArgs, ...command.attachArgs].join(' ')).not.toContain('sk-secret');
  });

  it('never lets a container-unreachable localhost endpoint reach either argv', async () => {
    for (const env of [{}, { LLM_BASE_URL: 'http://localhost:1234/v1' }, { LLM_BASE_URL: '  ' }]) {
      const { runArgs, attachArgs } = await resolveSessionCommand({ ...common, ticket: null, env });
      expect(runArgs.join(' ')).not.toMatch(/(LLM|EMBED)_BASE_URL=\S*localhost:/);
      expect(attachArgs.join(' ')).not.toMatch(/(LLM|EMBED)_BASE_URL=\S*localhost:/);
    }
  });

  // tkt-2c8af65c114e: the same seam pin for the MODEL half — the whole point of the fix is that the
  // container asks for the loaded model, so prove the ids reach BOTH argv end-to-end (not just llmEnvArgs).
  it('carries LLM_MODEL / EMBED_MODEL into BOTH the run and attach argv when the host sets them', async () => {
    const { runArgs, attachArgs } = await resolveSessionCommand({
      ...common, ticket: null,
      env: { LLM_MODEL: 'openai/gpt-oss-20b', EMBED_MODEL: 'text-embedding-qwen3-embedding-0.6b' },
    });
    for (const args of [runArgs, attachArgs]) {
      expect(args).toContain('LLM_MODEL=openai/gpt-oss-20b');
      expect(args).toContain('EMBED_MODEL=text-embedding-qwen3-embedding-0.6b');
    }
  });

  it('emits no model arg in either argv when the host has none (container keeps the agent default)', async () => {
    const { runArgs, attachArgs } = await resolveSessionCommand({ ...common, ticket: null, env: {} });
    for (const args of [runArgs, attachArgs]) {
      expect(args.join(' ')).not.toContain('LLM_MODEL');
      expect(args.join(' ')).not.toContain('EMBED_MODEL');
    }
  });
});
