import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getTicket } from '../../server/tickets.js';
import { type RunUsage, isRunUsage } from './usage.js';
import { type RunOutcome, isRunOutcome } from './economics.js';
import { type RunSummary, isRunSummary } from './summary.js';
import { type PostRunCheck, isPostRunCheck } from '../runtime/postRunCheck.js';

// Append-only JSONL run log, one RunRecord per run. Behind a seam so the backend can move to SQLite later (tkt-f93c3c10c26c). Keyed by runId; a ticket's frontmatter carries the runId for the ticket → run → usage lookup.

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// RUNS_DIR_OVERRIDE redirects to a temp dir (tests). Default is project-root `runs/`: this file is at agent/cost/, so TWO levels up — a single `..` would wrongly resolve to agent/runs (reorg regression guard).
export function runsDir(): string {
  return process.env.RUNS_DIR_OVERRIDE ?? path.join(__dirname, '..', '..', 'runs');
}
function runsPath(): string {
  return path.join(runsDir(), 'runs.jsonl');
}

export interface RunRecord {
  runId: string;
  at: string;                       // ISO timestamp
  model: string;
  usage: RunUsage;
  outcome: RunOutcome;
  reviewMs: number;
  cost: RunSummary;
  ticketIds: { created: string[]; updated: string[] };
  // create_ticket calls the per-run cap blocked (tkt-0d76600b9966). Optional only because lines written
  // before it lack the key; appendRun requires it, so every writer records one.
  cappedCreates?: number;
  // tkt-586ed614fde6. Optional for the same reason as cappedCreates.
  postRunCheck?: PostRunCheck;
}
export type NewRunRecord = RunRecord & { cappedCreates: number; postRunCheck: PostRunCheck };

function isCount(v: unknown): boolean {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === 'string');
}
function isTicketIds(v: unknown): v is RunRecord['ticketIds'] {
  return typeof v === 'object' && v !== null
    && 'created' in v && isStringArray(v.created)
    && 'updated' in v && isStringArray(v.updated);
}

// Cast-free validator for a persisted RunRecord line — a truncated/hand-edited line is skipped, not trusted.
export function isRunRecord(v: unknown): v is RunRecord {
  return typeof v === 'object' && v !== null
    && 'runId' in v && typeof v.runId === 'string'
    && 'at' in v && typeof v.at === 'string'
    && 'model' in v && typeof v.model === 'string'
    && 'usage' in v && isRunUsage(v.usage)
    && 'outcome' in v && isRunOutcome(v.outcome)
    && 'reviewMs' in v && typeof v.reviewMs === 'number'
    && 'cost' in v && isRunSummary(v.cost)
    && 'ticketIds' in v && isTicketIds(v.ticketIds)
    && (!('cappedCreates' in v) || isCount(v.cappedCreates))
    && (!('postRunCheck' in v) || isPostRunCheck(v.postRunCheck));
}

// flag 'a' = O_APPEND: concurrent writers stay line-atomic.
export async function appendRun(record: NewRunRecord): Promise<void> {
  await fs.mkdir(runsDir(), { recursive: true });
  await fs.appendFile(runsPath(), `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' });
}

// All records, oldest first. Missing file → [] (not an error); corrupt lines skipped.
export async function readRuns(): Promise<RunRecord[]> {
  let raw: string;
  try {
    raw = await fs.readFile(runsPath(), 'utf8');
  } catch {
    return [];
  }
  const records: RunRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRunRecord(parsed)) records.push(parsed);
    } catch { /* skip a corrupt line */ }
  }
  return records;
}

// The record for a runId, or null. Last write wins (a re-run appending twice resolves to the latest).
export async function readRun(runId: string): Promise<RunRecord | null> {
  const matches = (await readRuns()).filter((r) => r.runId === runId);
  return matches.length > 0 ? matches[matches.length - 1] : null;
}

// The ticket → run → usage join. Null when the ticket has no provenance (human/CLI write) or the run isn't logged.
export async function getRunForTicket(ticketId: string): Promise<RunRecord | null> {
  // Never throws: an unknown/malformed id (getTicket raises 404/400) simply has no run to join → null.
  let ticket;
  try {
    ticket = await getTicket(ticketId);
  } catch {
    return null;
  }
  return ticket.runId ? readRun(ticket.runId) : null;
}
