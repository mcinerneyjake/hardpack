import type { CodingCase } from './cases.js';

// Human underspecification verdicts (tkt-91ec1112633c). Kept apart from cases.json because `--select`
// regenerates that file wholesale and would drop any mark written into it.

export type ScreenVerdict = 'yes' | 'partly' | 'no';

export interface ScreenEntry {
  // A verdict judges one body against one set of hidden tests; if any of the three moves, it is stale.
  bodySha256: string;
  commit: string;
  testFiles: string[];
  // sha256 of the exact text `--statement` printed and the human judged; bodySha256 alone misses the interface.
  statementSha256: string;
  verdict: ScreenVerdict;
  // Could a solution faithful to that statement pass every hidden file? Only this decides whether a case is scored.
  scorable: boolean;
  note: string;
}

export type Screen = ReadonlyMap<string, ScreenEntry>;

export interface ScreenedOut {
  ticketId: string;
  reason: string;
}

const TICKET_ID = /^tkt-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const VERDICTS: readonly string[] = ['yes', 'partly', 'no'];

function isVerdict(v: unknown): v is ScreenVerdict {
  return typeof v === 'string' && VERDICTS.includes(v);
}

function fail(id: string, msg: string): never {
  throw new Error(`coding-eval: screen entry ${id}: ${msg}`);
}

// JSON.parse keeps the LAST duplicate key silently, so a re-screen appended below a "no" would win.
function assertNoDuplicateIds(raw: string): void {
  const seen = new Set<string>();
  for (const m of raw.matchAll(/"(tkt-[0-9a-f]{12})"\s*:/g)) {
    if (seen.has(m[1])) throw new Error(`coding-eval: screen lists ${m[1]} twice`);
    seen.add(m[1]);
  }
}

// Strict, like the case manifest: a malformed screen is a broken instrument, never a permissive one.
export function parseScreen(raw: string): Screen {
  let data: unknown;
  try { data = JSON.parse(raw); } catch (err) {
    throw new Error(`coding-eval: screen is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (typeof data !== 'object' || data === null || !('cases' in data)
    || typeof data.cases !== 'object' || data.cases === null || Array.isArray(data.cases)) {
    throw new Error('coding-eval: screen has no `cases` object');
  }
  assertNoDuplicateIds(raw);
  const screen = new Map<string, ScreenEntry>();
  for (const [id, e] of Object.entries(data.cases)) {
    if (!TICKET_ID.test(id)) fail(id, 'key is not a well-formed tkt- id');
    if (typeof e !== 'object' || e === null) fail(id, 'not an object');
    const get = (k: string): unknown => (k in e ? Reflect.get(e, k) : undefined);
    const bodySha256 = get('bodySha256');
    const commit = get('commit');
    const testFiles = get('testFiles');
    const statementSha256 = get('statementSha256');
    const verdict = get('verdict');
    const scorable = get('scorable');
    const note = get('note');
    if (typeof bodySha256 !== 'string' || !SHA256.test(bodySha256)) fail(id, 'bodySha256 is not a sha256 hex digest');
    if (typeof commit !== 'string' || !SHA.test(commit)) fail(id, 'commit is not a full sha');
    if (!Array.isArray(testFiles) || testFiles.length === 0 || !testFiles.every((f) => typeof f === 'string')) {
      fail(id, 'testFiles must be a non-empty list of paths');
    }
    if (typeof statementSha256 !== 'string' || !SHA256.test(statementSha256)) fail(id, 'statementSha256 is not a sha256 hex digest');
    if (!isVerdict(verdict)) fail(id, 'verdict must be yes, partly or no');
    if (typeof scorable !== 'boolean') fail(id, 'scorable must be a boolean');
    if (verdict === 'no' && scorable) fail(id, 'a "no" verdict cannot be scorable');
    if (verdict === 'yes' && !scorable) fail(id, 'a "yes" verdict must be scorable');
    if (typeof note !== 'string' || !note.trim()) fail(id, 'note must say what a faithful solution could not predict');
    screen.set(id, { bodySha256, commit, testFiles: testFiles.map(String), statementSha256, verdict, scorable, note });
  }
  return screen;
}

function sameTests(a: readonly string[], b: readonly string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((f, i) => f === y[i]);
}

// Fail closed: a case nobody screened, or screened against a different statement or tests, is not scored.
// `statements` maps id → sha256 of the statement the session will be given; a case absent from it is out.
export function applyScreen(
  cases: readonly CodingCase[],
  screen: Screen,
  statements: ReadonlyMap<string, string>,
): { scorable: CodingCase[]; screenedOut: ScreenedOut[] } {
  const scorable: CodingCase[] = [];
  const screenedOut: ScreenedOut[] = [];
  for (const c of cases) {
    const e = screen.get(c.ticketId);
    if (!e) screenedOut.push({ ticketId: c.ticketId, reason: 'unscreened — no verdict in screen.json' });
    else if (e.bodySha256 !== c.bodySha256 || e.commit !== c.commit || !sameTests(e.testFiles, c.testFiles)) {
      screenedOut.push({ ticketId: c.ticketId, reason: 'stale screen — judged a different body, commit or hidden test set' });
    } else if (!e.scorable) screenedOut.push({ ticketId: c.ticketId, reason: `underspecified (${e.verdict})` });
    else if (!statements.has(c.ticketId)) {
      screenedOut.push({ ticketId: c.ticketId, reason: 'no task statement could be built for this case' });
    } else if (statements.get(c.ticketId) !== e.statementSha256) {
      screenedOut.push({ ticketId: c.ticketId, reason: 'stale screen — judged a different task statement than the one a session is now given' });
    } else scorable.push(c);
  }
  return { scorable, screenedOut };
}
