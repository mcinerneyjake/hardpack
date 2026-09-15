import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type RunUsage } from '../cost/usage.js';
import { type ExtractResult } from './extract.js';
import { type ParsedTranscript, type Turn } from './transcript.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const MAX_EXCERPT_CHARS = 600;

// Default is project-root `retros/` (gitignored): proposals quote private transcripts and this repo is public.
export function retrosDir(env: NodeJS.ProcessEnv = process.env): string {
  // A blank override must not resolve to the cwd, which is the repo root and not gitignored.
  return env.RETROS_DIR_OVERRIDE?.trim() || path.join(__dirname, '..', '..', 'retros');
}

export interface ProposalsInput {
  source: string;
  model: string;
  generatedAt: Date;
  transcript: ParsedTranscript;
  result: ExtractResult;
  usage: RunUsage | null;
}

function quote(text: string): string {
  const t = text.length <= MAX_EXCERPT_CHARS ? text : `${text.slice(0, MAX_EXCERPT_CHARS)} …`;
  return t.split('\n').map((l) => `  > ${l}`).join('\n');
}

function usageLine(usage: RunUsage | null): string {
  if (usage === null) return 'not recorded';
  const tokens = usage.reportedCalls > 0
    ? `${usage.promptTokens} prompt / ${usage.completionTokens} completion tokens`
    : 'tokens not reported by the runtime';
  return `${usage.calls} chat call(s), ${tokens}, ${(usage.activeMs / 1000).toFixed(1)}s active`;
}

export function renderProposals(input: ProposalsInput): string {
  const { transcript: tx, result } = input;
  const byN = new Map<number, Turn>(tx.turns.map((t) => [t.n, t]));
  const okChunks = result.chunks.length - result.failedChunks;
  const lines = [
    `# Retrospective proposals — ${tx.sessionId ?? path.basename(input.source)}`,
    '',
    `- Source: \`${input.source}\``,
    `- Generated: ${input.generatedAt.toISOString()} · model \`${input.model}\``,
    `- Turns: ${tx.turns.length} · compactions: ${tx.compactions} (summary text never used as evidence) · malformed lines: ${tx.malformedLines}`,
    `- Chunks: ${okChunks}/${result.chunks.length} parsed · failed: ${result.failedChunks}`,
    `- Lessons: ${result.lessons.length} · dropped for citing no turn in their excerpt: ${result.dropped}`,
    `- Usage: ${usageLine(input.usage)}`,
    '',
    '> Candidates only. Nothing here has been written to memory. A human decides what, if anything, is kept.',
    '',
  ];
  if (result.failedChunks > 0) {
    lines.push('## Failed chunks', '', 'Lessons from these turns are MISSING, not absent.', '');
    for (const c of result.chunks) {
      if (!c.ok) lines.push(`- turns #${c.firstTurn}–#${c.lastTurn}: ${c.error}`);
    }
    lines.push('');
  }
  lines.push('## Lessons', '');
  if (result.lessons.length === 0) lines.push('None proposed.', '');
  result.lessons.forEach((l, i) => {
    lines.push(`### ${i + 1}. ${l.lesson}`, '');
    if (l.why) lines.push(l.why, '');
    lines.push('Evidence (quoted from the transcript):', '');
    for (const n of l.evidence) {
      const t = byN.get(n);
      if (t) lines.push(`- **#${t.n} ${t.role} ${t.kind}**`, quote(t.text));
    }
    lines.push('');
  });
  return lines.join('\n');
}

export function proposalsFileName(sessionId: string | null, source: string): string {
  const base = sessionId ?? path.basename(source, path.extname(source));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  return `${safe || 'transcript'}.md`;
}

export class ProposalsExistError extends Error {
  constructor(readonly file: string) {
    super(`${file} already exists — re-run with --force to replace it.`);
    this.name = 'ProposalsExistError';
  }
}

export async function writeProposals(dir: string, fileName: string, markdown: string, force: boolean): Promise<string> {
  const root = path.resolve(dir);
  const file = path.resolve(root, fileName);
  if (path.dirname(file) !== root) throw new Error(`refusing to write ${file}: outside ${root}`);
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.writeFile(file, markdown, { flag: force ? 'w' : 'wx' });
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EEXIST') throw new ProposalsExistError(file);
    throw err;
  }
  return file;
}
