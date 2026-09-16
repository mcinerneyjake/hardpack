#!/usr/bin/env node
// Report whether retrospective proposals are being TRIAGED (tkt-caf80d719c0b).
//
// `npm run retro` writes candidate lessons to gitignored `retros/` and deliberately does no triage
// (tkt-4cda7a4ab619). Nothing read that directory, so the proposals were an unread queue that grew
// silently — the failure this probe exists to make visible.
//
// SCOPE, and the limit worth stating out loud: this measures the queue of proposals ALREADY WRITTEN.
// It cannot measure whether retrospectives are being RUN, because that lives in the transcript store
// outside this repo. `--transcripts <dir>` quantifies that second pool on request, and its absence is
// reported as "not measured" rather than as zero. The cadence itself is honor-system prose in
// CLAUDE.md; only the triage queue is instrumented.
//
// A transcript with no proposals file is NOT a finding. The cadence is event-triggered plus a bounded
// batch, so most sessions are never owed a retrospective and this probe cannot tell which were.

import { readFileSync, readdirSync, existsSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXIT = { CLEAN: 0, FINDINGS: 1, CANNOT_SCAN: 2 };

// The dispositions a lesson can receive. Each ROUTES INTO A GATE THAT ALREADY EXISTS; none of them is
// itself a promotion criterion, which is the whole point of the vocabulary (see CLAUDE.md, "Session
// retrospectives"). Adding a verb here without adding the route there makes the probe accept a
// disposition that nothing governs.
export const VERBS = new Set(['memory', 'instruction', 'ticket', 'drop']);

export class ProbeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProbeError';
  }
}

// A fence in a lesson or its why-text would otherwise let sample dispositions count as real ones.
// Evidence excerpts cannot reach this path — renderProposals prefixes every excerpt line with two
// spaces and `> `, so neither a fence nor a `- 1: memory` line inside one is line-initial.
//
// Scanned line by line rather than with one regex, for two reasons a regex got wrong: `~~~` is a
// CommonMark fence too, and an UNTERMINATED fence must swallow the rest of the document. A balanced
// -pairs-only regex left a sample standing in both cases and the file read as fully dispositioned at
// exit 0 — a clean verdict over a file nobody had triaged. Swallowing is the safe direction: it can
// only hide a real disposition section, which over-reports (exit 1), never under-reports.
function stripFences(md) {
  const out = [];
  let open = null;
  for (const line of md.split('\n')) {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (open === null) {
      if (m) { open = m[1][0]; continue; }
      out.push(line);
      continue;
    }
    if (m && m[1][0] === open) open = null;
  }
  return out.join('\n');
}

/**
 * Classify one proposals file. Returns null when the file carries no generated `- Lessons: N` header,
 * which means it is not a proposals file at all — the caller treats that as a PARTIAL SCAN, never as
 * a file with nothing to triage.
 */
export function classifyProposals(raw) {
  const body = stripFences(raw);
  const header = body.match(/^- Lessons: (\d+)\b/m);
  if (!header) return null;
  const lessons = Number(header[1]);

  const heading = body.match(/^## Disposition\s*$/m);
  if (!heading) return { lessons, dispositioned: false, covered: [], unknown: [], outOfRange: [], missing: range(lessons) };

  // Read only to the next section: a later heading's prose must not donate disposition lines.
  const after = body.slice(heading.index + heading[0].length);
  const section = after.split(/^## /m)[0];

  const covered = [];
  const unknown = [];
  const outOfRange = [];
  for (const line of section.split('\n')) {
    const m = line.match(/^-\s*(\d+)\s*:\s*(\S+)/);
    if (!m) continue;
    const n = Number(m[1]);
    // The token is matched WHOLE and case-folded, never stripped of punctuation. Stripping it let
    // `~~memory~~` — a disposition a human had struck out — normalize to `memory` and read as done.
    const verb = m[2].toLowerCase();
    if (!VERBS.has(verb)) { unknown.push({ n, verb: m[2] }); continue; }
    if (n < 1 || n > lessons) { outOfRange.push({ n, verb }); continue; }
    if (!covered.includes(n)) covered.push(n);
  }
  const missing = range(lessons).filter((n) => !covered.includes(n));
  return { lessons, dispositioned: true, covered, unknown, outOfRange, missing };
}

function range(n) {
  return Array.from({ length: n }, (_, i) => i + 1);
}

/**
 * The join key between the two queues. Mirrors `proposalsFileName(null, <transcript path>)` from
 * agent/retro/proposals.ts, which this file cannot import: probes run under bare node and that module
 * is TypeScript. retro-queue.test.mjs pins the sanitizer against it, so a rename or a changed
 * character class there goes red here.
 *
 * KNOWN GAP, and the reason this pool is informational rather than a finding: production names the
 * file from the sessionId parsed OUT of the transcript (`retro.ts` passes `transcript.sessionId`),
 * while this joins on the transcript's FILENAME. They coincide for every Claude Code transcript
 * measured so far, but a copied, renamed or resumed transcript would join wrongly and read as never
 * retrospected. Making the join authoritative means parsing each transcript, which this probe
 * deliberately does not do — tracked separately rather than half-done here.
 */
export function proposalsNameForTranscript(fileName) {
  const base = path.basename(fileName, path.extname(fileName));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return `${safe || 'transcript'}.md`;
}

const CONTROLS = [
  // positive: a complete disposition over two lessons
  {
    doc: '- Lessons: 2 · dropped: 0\n\n## Disposition\n\n- 1: memory — pinned\n- 2: drop — noise\n',
    expect: { lessons: 2, dispositioned: true, missing: [], unknown: 0, oor: 0 },
  },
  // positive: zero lessons needs no disposition and must not sit in the queue forever
  { doc: '- Lessons: 0 · dropped: 3\n', expect: { lessons: 0, dispositioned: false, missing: [], unknown: 0, oor: 0 } },
  // negative: header present, no disposition section — the queue case
  { doc: '- Lessons: 1 · dropped: 0\n', expect: { lessons: 1, dispositioned: false, missing: [1], unknown: 0, oor: 0 } },
  // negative: partial — lesson 2 never dispositioned
  {
    doc: '- Lessons: 2 · dropped: 0\n\n## Disposition\n\n- 1: ticket — filed\n',
    expect: { lessons: 2, dispositioned: true, missing: [2], unknown: 0, oor: 0 },
  },
  // negative: an unknown verb must be reported, never silently ignored as if absent
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n- 1: promote — to memory\n',
    expect: { lessons: 1, dispositioned: true, missing: [1], unknown: 1, oor: 0 },
  },
  // negative: a fenced sample is documentation, not a disposition
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n```\n- 1: memory — sample\n```\n',
    expect: { lessons: 1, dispositioned: true, missing: [1], unknown: 0, oor: 0 },
  },
  // negative: an UNTERMINATED fence must swallow its sample, not leave it standing as a disposition
  {
    doc: '- Lessons: 2 · dropped: 0\n\n## Disposition\n\n```\n- 1: memory — sample\n- 2: drop — sample\n',
    expect: { lessons: 2, dispositioned: true, missing: [1, 2], unknown: 0, oor: 0 },
  },
  // negative: `~~~` is a fence too
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n~~~\n- 1: memory — sample\n~~~\n',
    expect: { lessons: 1, dispositioned: true, missing: [1], unknown: 0, oor: 0 },
  },
  // negative: a struck-out verb is a RETRACTED decision, never a completed one
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n- 1: ~~memory~~ — retracted\n',
    expect: { lessons: 1, dispositioned: true, missing: [1], unknown: 1, oor: 0 },
  },
  // negative: a lesson number the file does not have is reported, not silently absorbed
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n- 1: drop — ok\n- 9: memory — no such lesson\n',
    expect: { lessons: 1, dispositioned: true, missing: [], unknown: 0, oor: 1 },
  },
  // negative: a LATER section's list must not be read as dispositions
  {
    doc: '- Lessons: 2 · dropped: 0\n\n## Disposition\n\n- 1: drop — no\n\n## Notes\n\n- 2: memory — not here\n',
    expect: { lessons: 2, dispositioned: true, missing: [2], unknown: 0, oor: 0 },
  },
  // negative: an excerpt line is indented and quoted, so it can never be a disposition
  {
    doc: '- Lessons: 1 · dropped: 0\n\n## Disposition\n\n  > - 1: memory — quoted from a transcript\n',
    expect: { lessons: 1, dispositioned: true, missing: [1], unknown: 0, oor: 0 },
  },
];

// The loud control: a classifier that is wrong must throw, never emit a plausible queue length.
// `classify` is injectable so the test can watch this throw path itself go red.
export function assertInstruments(classify = classifyProposals) {
  for (const [i, c] of CONTROLS.entries()) {
    const got = classify(c.doc);
    if (got === null) throw new ProbeError(`retro-queue: control ${i} read a proposals file as unparseable — refusing to count.`);
    const actual = {
      lessons: got.lessons, dispositioned: got.dispositioned, missing: got.missing,
      unknown: got.unknown.length, oor: got.outOfRange.length,
    };
    for (const key of ['lessons', 'dispositioned', 'unknown', 'oor']) {
      if (actual[key] !== c.expect[key]) {
        throw new ProbeError(`retro-queue: control ${i} misclassified (${key}: got ${actual[key]}, expected ${c.expect[key]}) — refusing to count.`);
      }
    }
    if (actual.missing.join(',') !== c.expect.missing.join(',')) {
      throw new ProbeError(`retro-queue: control ${i} misclassified (missing: got [${actual.missing}], expected [${c.expect.missing}]) — refusing to count.`);
    }
  }
  // A control that cannot fail proves nothing: confirm the unparseable path is reachable.
  if (classify('no generated header here\n') !== null) {
    throw new ProbeError('retro-queue: a file with no `- Lessons:` header was accepted — refusing to count.');
  }
}

/**
 * Scan the proposals directory. `missingDir` distinguishes "no retrospective has written anything
 * yet" from "we looked somewhere wrong" — the caller resolves the latter before calling, by checking
 * the root exists.
 */
export function scanRetros(dir, now = Date.now()) {
  if (!existsSync(dir)) return { missingDir: true, files: [], unreadable: [] };
  const files = [];
  const unreadable = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name;
    // Dotfiles are never proposals (.DS_Store is the one that would otherwise fire constantly).
    // Anything else that is not `.md` is REPORTED rather than skipped: a proposals file saved as
    // `.MD` or `.md.bak` was invisible to every count, which is the fail-open the unreadable bucket
    // exists to prevent, one layer earlier.
    if (name.startsWith('.')) continue;
    if (entry.isDirectory()) continue;
    if (!name.endsWith('.md')) { unreadable.push(`${name}: not a .md file — skipped, so the counts above may under-report`); continue; }
    const full = path.join(dir, name);
    let raw;
    try {
      raw = readFileSync(full, 'utf8');
    } catch (e) {
      unreadable.push(`${name}: ${e?.message ?? e}`);
      continue;
    }
    const c = classifyProposals(raw);
    if (c === null) { unreadable.push(`${name}: no generated \`- Lessons:\` header — not a proposals file`); continue; }
    let ageDays;
    try {
      ageDays = Math.floor((now - statSync(full).mtimeMs) / 86_400_000);
    } catch (e) {
      unreadable.push(`${name}: cannot stat — ${e?.message ?? e}`);
      continue;
    }
    files.push({ name, ageDays, ...c });
  }
  return { missingDir: false, files, unreadable };
}

export function findings(files) {
  const undispositioned = files.filter((f) => !f.dispositioned && f.missing.length > 0);
  // A file with a bad line is listed under BOTH headings when it also has lessons outstanding.
  // Excluding it from `partial` hid which lessons still needed a decision, so fixing the bad verb
  // told the operator nothing about the two lessons behind it.
  const partial = files.filter((f) => f.dispositioned && f.missing.length > 0);
  const invalid = files.filter((f) => f.unknown.length > 0 || f.outOfRange.length > 0);
  const affected = new Set([...undispositioned, ...partial, ...invalid].map((f) => f.name));
  return { undispositioned, partial, invalid, affected };
}

/** Transcripts with no proposals file. Informational — see the scope note at the top. */
export function scanTranscripts(dir, retroNames) {
  if (!existsSync(dir)) throw new ProbeError(`--transcripts ${dir} does not exist — refusing to report zero un-retrospected transcripts.`);
  const have = new Set(retroNames);
  const without = readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .filter((n) => !have.has(proposalsNameForTranscript(n)));
  return without.sort();
}

export function formatReport({ retros, transcripts, dir }) {
  const out = [];
  if (retros.missingDir) {
    out.push(`No ${dir} directory — nothing to triage.`);
    out.push('This probe does NOT measure whether retrospectives are being run; it only reads proposals already written.');
  } else {
    const f = findings(retros.files);
    const oldest = f.undispositioned.reduce((a, x) => Math.max(a, x.ageDays), -1);
    out.push(`${retros.files.length} proposals file(s) · ${f.undispositioned.length} undispositioned · ${f.partial.length} partial · ${f.invalid.length} with a malformed line`);
    if (oldest >= 0) out.push(`Oldest undispositioned: ${oldest} day(s).`);
    for (const x of f.undispositioned) out.push(`  UNDISPOSITIONED ${x.name} — ${x.lessons} lesson(s), ${x.ageDays}d old`);
    for (const x of f.partial) out.push(`  PARTIAL ${x.name} — no disposition for lesson(s) ${x.missing.join(', ')}`);
    for (const x of f.invalid) {
      if (x.unknown.length) out.push(`  UNKNOWN VERB ${x.name} — ${x.unknown.map((u) => `#${u.n} "${u.verb}"`).join(', ')}`);
      if (x.outOfRange.length) out.push(`  OUT OF RANGE ${x.name} — ${x.outOfRange.map((u) => `#${u.n}`).join(', ')} (file has ${x.lessons} lesson(s))`);
    }
  }
  out.push(transcripts === null
    ? 'Un-retrospected transcripts: not measured (pass --transcripts <dir>).'
    : `Un-retrospected transcripts: ${transcripts.length}. Informational only — most sessions are never owed a retrospective.`);
  if (retros.unreadable.length) {
    out.push('--- UNREADABLE (absent from every count above) ---');
    for (const u of retros.unreadable) out.push(`  ${u}`);
  }
  return out.join('\n');
}

export function runCli(argv, { cwd = process.cwd(), now = Date.now(), env = process.env } = {}) {
  assertInstruments();

  const args = [...argv];
  const takeFlag = (name) => {
    const i = args.indexOf(name);
    if (i === -1) return null;
    const value = args[i + 1];
    if (!value || value.startsWith('-')) throw new ProbeError(`${name} needs a directory argument.`);
    args.splice(i, 2);
    return value;
  };
  const transcriptsDir = takeFlag('--transcripts');
  const explicitDir = takeFlag('--dir') ?? (env.RETROS_DIR_OVERRIDE?.trim() || null);
  // The proposals directory must be IDENTIFIED, never merely resolved. Checking only that the root
  // exists let any existing path through — an empty directory, another project, even a plain file —
  // and the absent `retros/` under it then read as "nothing to triage" at exit 0. That is a clean
  // verdict from a scan that looked in the wrong place, which is the one result this probe refuses.
  // So a root is accepted only when it carries a `package.json`, and a caller who wants an arbitrary
  // directory has to say so explicitly with --dir (or RETROS_DIR_OVERRIDE, which `npm run retro`
  // already honors) rather than having it inferred.
  let dir = explicitDir;
  if (dir === null) {
    const root = args[0] ?? cwd;
    if (!existsSync(root)) throw new ProbeError(`root ${root} does not exist — refusing to report an empty queue.`);
    if (!existsSync(path.join(root, 'package.json'))) {
      throw new ProbeError(`root ${root} has no package.json, so it is not a repo root — refusing to report an empty queue. Pass --dir <path> to scan an arbitrary directory.`);
    }
    dir = path.join(root, 'retros');
  }
  const retros = scanRetros(dir, now);
  const transcripts = transcriptsDir === null ? null : scanTranscripts(transcriptsDir, retros.files.map((f) => f.name));

  const report = formatReport({ retros, transcripts, dir });
  const f = findings(retros.files);
  const bad = f.affected.size;
  // `unreadable` means the scan was PARTIAL, so every count above under-reports. That belongs with the
  // cannot-scan cases, not in the advisory bucket — same split, and same reason, as stale-in-progress.
  const code = retros.unreadable.length ? EXIT.CANNOT_SCAN : (bad === 0 ? EXIT.CLEAN : EXIT.FINDINGS);
  return { code, report };
}

// Compare REAL paths and tolerate a missing argv[1]: a raw `file://` comparison makes the CLI do
// nothing when invoked through a symlink — exit 0 with no output, i.e. an empty-queue reading from a
// probe that never scanned, which is the one result this file refuses.
function isMainModule() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) {
    console.error(`retro-queue: could not resolve own module path (${e?.message ?? e}) — not running as a CLI.`);
    return false;
  }
}

if (isMainModule()) {
  try {
    const { code, report } = runCli(process.argv.slice(2));
    console.log(report);
    process.exitCode = code;
  } catch (e) {
    console.error(`retro-queue: ${e?.message ?? e}`);
    console.error('Treat this as a scan that did not happen, NOT as an empty queue.');
    process.exitCode = EXIT.CANNOT_SCAN;
  }
}
