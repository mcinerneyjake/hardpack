// A held-out coding case: a squash commit C on main whose ticket is replayed at C^ and graded by C's
// own test files (tkt-7beeca1d62ab; design in tkt-6515fd388307 → "Decision — 2026-09-22").

export interface CodingCase {
  ticketId: string;
  pr: number;
  commit: string;
  base: string;
  testFiles: string[];
  // Pins the frozen task statement: a .history snapshot that changes under us is a different task.
  bodySha256: string;
  snapshot: string;
}

const TICKET_ID = /^tkt-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const TEST_FILE = /\.test\.(?:ts|tsx|mjs|js)$/;
const SOURCE_FILE = /\.(?:ts|tsx|mjs|js)$/;

export function isTestFile(p: string): boolean {
  return TEST_FILE.test(p);
}

// Only code a hidden test can exercise. Config at the root and e2e specs are neither graded behaviour
// nor something vitest's unit projects collect.
export function isSourceFile(p: string): boolean {
  return SOURCE_FILE.test(p) && !isTestFile(p) && !p.startsWith('e2e/') && p.includes('/');
}

export interface ChangedFiles {
  testFiles: string[];
  sourceFiles: string[];
  otherFiles: string[];
  eligible: boolean;
}

// Test-side files the hidden tests depend on: a session cannot be expected to invent them at the path
// and name C chose, so a case whose gold needs one is unsolvable rather than hard.
const TEST_SUPPORT = /(?:^|\/)(?:test-support|__snapshots__|__mocks__|fixtures)\//;

// Eligible = C changes source AND tests, and nothing else but docs. A lockfile, config, snapshot or
// fixture change would make gold (whole diff) and a trial (source by the session) different tasks.
export function classifyChangedFiles(paths: readonly string[]): ChangedFiles {
  const testFiles = paths.filter(isTestFile).filter((p) => !p.startsWith('e2e/')).sort();
  const sourceFiles = paths.filter((p) => isSourceFile(p) && !TEST_SUPPORT.test(p)).sort();
  // A .md under a test-support path is a fixture (the corpus tickets are .md), never a doc.
  const otherFiles = paths.filter((p) => !testFiles.includes(p) && !sourceFiles.includes(p) && (!p.endsWith('.md') || TEST_SUPPORT.test(p))).sort();
  return {
    testFiles, sourceFiles, otherFiles,
    eligible: testFiles.length > 0 && sourceFiles.length > 0 && otherFiles.length === 0,
  };
}

// Squash subjects end "(#405)"; nothing else in the subject identifies the PR.
export function prNumberFromSubject(subject: string): number | null {
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

export function ticketIdFromBranch(branch: string): string | null {
  const ids = branch.match(/tkt-[0-9a-f]{12}/g) ?? [];
  // Two ids in one branch name is ambiguous; refusing it beats guessing which ticket the PR was for.
  return ids.length === 1 ? ids[0] : null;
}

// The FIRST start: a restarted ticket's later start is mid-work, with the answer partly on the branch.
export function firstStartedAt(eventsJsonl: string): string | null {
  for (const line of eventsJsonl.split('\n')) {
    if (!line.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    if (
      typeof ev === 'object' && ev !== null
      && 'step' in ev && ev.step === 'started'
      && 'at' in ev && typeof ev.at === 'string'
      && !Number.isNaN(Date.parse(ev.at))
    ) return ev.at;
  }
  return null;
}

// `2026-09-16T21-55-49-752Z-e2cc7598.md` → epoch ms. The writer replaced `:` and `.` with `-`.
export function snapshotTime(name: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-[0-9a-f]{8}\.md$/.exec(name);
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(t) ? null : t;
}

// snapshotHistory saves the PRIOR file before each body write, so the first snapshot after `started`
// is the body at start. None → nothing proves the live copy is that body; ineligible.
export function pickFrozenSnapshot(names: readonly string[], startedAt: string): string | null {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return null;
  let best: { name: string; t: number } | null = null;
  for (const name of names) {
    const t = snapshotTime(name);
    if (t === null || t <= start) continue;
    if (!best || t < best.t) best = { name, t };
  }
  return best ? best.name : null;
}

function fail(i: number, msg: string): never {
  throw new Error(`coding-eval: case manifest entry ${i}: ${msg}`);
}

// Strict: a malformed manifest is a broken instrument, never a shorter case list.
export function parseCaseManifest(raw: string): CodingCase[] {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (err) {
    throw new Error(`coding-eval: case manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof data !== 'object' || data === null || !('cases' in data) || !Array.isArray(data.cases)) {
    throw new Error('coding-eval: case manifest has no `cases` array');
  }
  const cases: CodingCase[] = data.cases.map((c: unknown, i: number): CodingCase => {
    if (typeof c !== 'object' || c === null) fail(i, 'not an object');
    const get = (k: string): unknown => (k in c ? Reflect.get(c, k) : undefined);
    const ticketId = get('ticketId');
    const pr = get('pr');
    const commit = get('commit');
    const base = get('base');
    const testFiles = get('testFiles');
    const bodySha256 = get('bodySha256');
    const snapshot = get('snapshot');
    if (typeof ticketId !== 'string' || !TICKET_ID.test(ticketId)) fail(i, 'ticketId is not a well-formed tkt- id');
    if (typeof pr !== 'number' || !Number.isInteger(pr) || pr <= 0) fail(i, 'pr is not a positive integer');
    if (typeof commit !== 'string' || !SHA.test(commit)) fail(i, 'commit is not a full sha');
    if (typeof base !== 'string' || !SHA.test(base)) fail(i, 'base is not a full sha');
    if (commit === base) fail(i, 'base equals commit');
    if (!Array.isArray(testFiles) || testFiles.length === 0 || !testFiles.every((f) => typeof f === 'string' && isTestFile(f))) {
      fail(i, 'testFiles must be a non-empty list of *.test.* paths');
    }
    if (typeof bodySha256 !== 'string' || !SHA256.test(bodySha256)) fail(i, 'bodySha256 is not a sha256 hex digest');
    if (typeof snapshot !== 'string' || snapshotTime(snapshot) === null) fail(i, 'snapshot is not a .history snapshot name');
    return { ticketId, pr, commit, base, testFiles: testFiles.map(String), bodySha256, snapshot };
  });
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.ticketId)) throw new Error(`coding-eval: case manifest lists ${c.ticketId} twice`);
    seen.add(c.ticketId);
  }
  if (cases.length === 0) throw new Error('coding-eval: case manifest is empty — refusing to report a rate over nothing');
  return cases;
}

// The snapshot is the frozen body verbatim except its status: it was captured after start_ticket
// had already moved it, and start_ticket refuses an in-progress ticket.
export function asTodo(snapshot: string): string {
  const end = snapshot.indexOf('\n---', 4);
  if (!snapshot.startsWith('---\n') || end === -1) throw new Error('coding-eval: frozen snapshot has no frontmatter');
  const front = snapshot.slice(0, end);
  if (!/^status: .*$/m.test(front)) throw new Error('coding-eval: frozen snapshot frontmatter has no status line');
  return front.replace(/^status: .*$/m, 'status: todo') + snapshot.slice(end);
}
