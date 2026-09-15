import fs from 'node:fs/promises';
import { type ChatClient, type PreflightResult } from '../runtime/llm.js';
import { type RunUsage } from '../cost/usage.js';
import { DEFAULT_CHUNK_CHARS, extractLessons } from './extract.js';
import { parseTranscript } from './transcript.js';
import { proposalsFileName, renderProposals, writeProposals } from './proposals.js';

export interface RetroDeps {
  chat: ChatClient;
  model: string;
  preflight: () => Promise<PreflightResult>;
  outDir: string;
  usage?: () => RunUsage;
  chunkChars?: number;
  force?: boolean;
  now?: () => Date;
}

export type RetroOutcome =
  | { ok: true; file: string; lessons: number; dropped: number; failedChunks: number; chunks: number }
  | { ok: false; error: string };

// 2, not 0, for a partial review: a caller reading the exit code must not see "10% reviewed" as success.
export function exitCodeFor(outcome: RetroOutcome): 0 | 1 | 2 {
  if (!outcome.ok) return 1;
  return outcome.failedChunks > 0 ? 2 : 0;
}

export async function runRetro(transcriptPath: string, deps: RetroDeps): Promise<RetroOutcome> {
  const preflight = await deps.preflight();
  if (!preflight.ok) return { ok: false, error: preflight.message };

  let raw: string;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
  } catch (err) {
    return { ok: false, error: `cannot read ${transcriptPath}: ${err instanceof Error ? err.message : String(err)}` };
  }
  const transcript = parseTranscript(raw);
  if (transcript.turns.length === 0) {
    return { ok: false, error: `${transcriptPath} holds no user/assistant turns (${transcript.malformedLines} malformed line(s)) — nothing to review.` };
  }

  const result = await extractLessons(transcript, deps.chat, deps.chunkChars ?? DEFAULT_CHUNK_CHARS);
  // Every chunk failing means nothing was reviewed; writing a file would read as "no lessons".
  if (result.failedChunks === result.chunks.length) {
    const errors = result.chunks.flatMap((c) => (c.ok ? [] : [`turns #${c.firstTurn}–#${c.lastTurn}: ${c.error}`]));
    return { ok: false, error: `every chunk failed, so no proposals were written:\n${errors.join('\n')}` };
  }

  const markdown = renderProposals({
    source: transcriptPath,
    model: deps.model,
    generatedAt: (deps.now ?? (() => new Date()))(),
    transcript,
    result,
    usage: deps.usage ? deps.usage() : null,
  });
  const file = await writeProposals(deps.outDir, proposalsFileName(transcript.sessionId, transcriptPath), markdown, deps.force ?? false);
  return {
    ok: true, file,
    lessons: result.lessons.length, dropped: result.dropped,
    failedChunks: result.failedChunks, chunks: result.chunks.length,
  };
}
