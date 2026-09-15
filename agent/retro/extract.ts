import { z } from 'zod';
import { type ChatClient } from '../runtime/llm.js';
import { isRuntimeUnavailable } from '../runtime/unavailable.js';
import { type ParsedTranscript, type Turn } from './transcript.js';

export const DEFAULT_CHUNK_CHARS = 24_000;

export const RETRO_SYSTEM_PROMPT = `You review one excerpt of a finished coding-agent session transcript.
Each turn is prefixed [#N role kind]. Extract DURABLE lessons: facts about the codebase, tools or
environment that a future session would otherwise have to re-discover, or corrections the user gave
about how the agent should work. Skip anything that only mattered to this session, and skip general
programming advice.

Every lesson MUST cite the turn numbers that show it. A lesson you cannot tie to a turn is not a lesson.

Reply with ONLY a JSON object, no prose:
{"lessons": [{"lesson": "<one sentence>", "why": "<why it matters>", "evidence": [<turn numbers>]}]}
Reply {"lessons": []} when the excerpt holds nothing durable.`;

const replySchema = z.object({
  lessons: z.array(z.object({
    lesson: z.string().trim().min(1),
    why: z.string().trim().default(''),
    evidence: z.array(z.number().int()),
  })),
});

export interface Lesson {
  lesson: string;
  why: string;
  evidence: number[];
}

export type ChunkResult =
  | { ok: true; firstTurn: number; lastTurn: number; lessons: Lesson[]; dropped: number }
  | { ok: false; firstTurn: number; lastTurn: number; error: string };

export interface ExtractResult {
  chunks: ChunkResult[];
  lessons: Lesson[];
  dropped: number;
  failedChunks: number;
}

export function renderTurn(t: Turn): string {
  return `[#${t.n} ${t.role} ${t.kind}] ${t.text}`;
}

// A turn larger than the budget still gets a chunk of its own rather than being lost.
export function chunkTurns(turns: Turn[], maxChars: number): Turn[][] {
  const chunks: Turn[][] = [];
  let current: Turn[] = [];
  let size = 0;
  for (const t of turns) {
    const len = renderTurn(t).length + 1;
    if (current.length > 0 && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(t);
    size += len;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// Local models routinely drop the final closer(s) of a nested object — measured on qwen: `{"lessons":[…]`.
// Only closers are ever appended, and the result still has to pass the schema and grounding filter.
function parseJsonReply(content: string): unknown {
  const start = content.indexOf('{');
  if (start === -1) throw new Error('no JSON object');
  const end = content.lastIndexOf('}');
  const fromStart = content.slice(start).replace(/\s*(```\s*)?$/, '');
  const candidates = [content.slice(start, end + 1), fromStart, `${fromStart}}`, `${fromStart}]}`];
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch { /* try the next candidate */ }
  }
  throw new Error('unparseable');
}

export type ParsedReply = { ok: true; lessons: Lesson[]; dropped: number } | { ok: false; error: string };

export function parseReply(content: string | null, citable: ReadonlySet<number>): ParsedReply {
  if (content === null || content.trim() === '') return { ok: false, error: 'empty model reply' };
  let json: unknown;
  try {
    json = parseJsonReply(content);
  } catch {
    return { ok: false, error: `model reply is not JSON: ${content.slice(0, 200)}` };
  }
  const parsed = replySchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: `model reply has the wrong shape: ${parsed.error.message.slice(0, 200)}` };

  const lessons: Lesson[] = [];
  let dropped = 0;
  for (const l of parsed.data.lessons) {
    const evidence = [...new Set(l.evidence)].filter((n) => citable.has(n)).sort((a, b) => a - b);
    // The model's citations are claims; only a turn that exists in the excerpt it was shown counts.
    if (evidence.length === 0) {
      dropped++;
      continue;
    }
    lessons.push({ lesson: l.lesson, why: l.why, evidence });
  }
  return { ok: true, lessons, dropped };
}

export async function extractLessons(
  transcript: ParsedTranscript,
  chat: ChatClient,
  chunkChars: number = DEFAULT_CHUNK_CHARS,
): Promise<ExtractResult> {
  const chunks: ChunkResult[] = [];
  const planned = chunkTurns(transcript.turns, chunkChars);
  for (let i = 0; i < planned.length; i++) {
    const turns = planned[i];
    const firstTurn = turns[0].n;
    const lastTurn = turns[turns.length - 1].n;
    let reply: string | null;
    try {
      const msg = await chat.complete([
        { role: 'system', content: RETRO_SYSTEM_PROMPT },
        { role: 'user', content: turns.map(renderTurn).join('\n') },
      ], []);
      reply = msg.content;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Unavailable (incl. one slow chunk's timeout): keep finished chunks, and stop rather than wait
      // out the timeout on every remaining one.
      if (isRuntimeUnavailable(err)) {
        for (const rest of planned.slice(i)) {
          chunks.push({ ok: false, firstTurn: rest[0].n, lastTurn: rest[rest.length - 1].n, error: `not reviewed — runtime unavailable: ${message}` });
        }
        break;
      }
      chunks.push({ ok: false, firstTurn, lastTurn, error: message });
      continue;
    }
    const parsed = parseReply(reply, new Set(turns.map((t) => t.n)));
    chunks.push(parsed.ok
      ? { ok: true, firstTurn, lastTurn, lessons: parsed.lessons, dropped: parsed.dropped }
      : { ok: false, firstTurn, lastTurn, error: parsed.error });
  }
  const okChunks = chunks.flatMap((c) => (c.ok ? [c] : []));
  return {
    chunks,
    lessons: okChunks.flatMap((c) => c.lessons),
    dropped: okChunks.reduce((n, c) => n + c.dropped, 0),
    failedChunks: chunks.length - okChunks.length,
  };
}
