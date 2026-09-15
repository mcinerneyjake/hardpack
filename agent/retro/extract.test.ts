import { describe, it, expect } from 'vitest';
import { chunkTurns, extractLessons, parseReply, renderTurn, RETRO_SYSTEM_PROMPT } from './extract.js';
import { type ChatClient, type ChatMessage } from '../runtime/llm.js';
import { RuntimeUnavailableError } from '../runtime/unavailable.js';
import { type ParsedTranscript, type Turn } from './transcript.js';

const turn = (n: number, text = `turn ${n}`): Turn => ({ n, role: 'user', kind: 'text', text });
const tx = (turns: Turn[]): ParsedTranscript => ({ sessionId: 's', turns, compactions: 0, malformedLines: 0 });

class ScriptedChat implements ChatClient {
  public requests: ChatMessage[][] = [];
  constructor(private readonly replies: (string | Error)[]) {}
  complete(messages: ChatMessage[]): Promise<ChatMessage> {
    this.requests.push(messages);
    const r = this.replies[this.requests.length - 1] ?? '{"lessons": []}';
    return r instanceof Error ? Promise.reject(r) : Promise.resolve({ role: 'assistant', content: r });
  }
}

describe('chunkTurns', () => {
  it('packs turns under the budget and starts a new chunk when the next would overflow', () => {
    const turns = [turn(1), turn(2), turn(3)];
    const one = renderTurn(turns[0]).length + 1;
    expect(chunkTurns(turns, one * 2).map((c) => c.map((t) => t.n))).toEqual([[1, 2], [3]]);
  });

  it('gives a turn larger than the budget a chunk of its own rather than losing it', () => {
    const chunks = chunkTurns([turn(1), turn(2, 'z'.repeat(500)), turn(3)], 50);
    expect(chunks.map((c) => c.map((t) => t.n))).toEqual([[1], [2], [3]]);
  });

  it('returns no chunks for no turns', () => {
    expect(chunkTurns([], 100)).toEqual([]);
  });
});

describe('parseReply', () => {
  const citable = new Set([4, 5, 6]);

  it('keeps a lesson citing turns in the excerpt, deduped and sorted', () => {
    const r = parseReply('{"lessons":[{"lesson":"L","why":"W","evidence":[6,4,6]}]}', citable);
    expect(r).toEqual({ ok: true, lessons: [{ lesson: 'L', why: 'W', evidence: [4, 6] }], dropped: 0 });
  });

  it('drops a lesson whose citations are all outside the excerpt', () => {
    const r = parseReply('{"lessons":[{"lesson":"L","why":"W","evidence":[1,99]}]}', citable);
    expect(r).toEqual({ ok: true, lessons: [], dropped: 1 });
  });

  it('drops a lesson with no citations', () => {
    const r = parseReply('{"lessons":[{"lesson":"L","why":"W","evidence":[]}]}', citable);
    expect(r).toEqual({ ok: true, lessons: [], dropped: 1 });
  });

  it('keeps only the valid citations of a partly valid lesson', () => {
    const r = parseReply('{"lessons":[{"lesson":"L","why":"","evidence":[99,5]}]}', citable);
    expect(r.ok && r.lessons[0].evidence).toEqual([5]);
  });

  it('reads JSON wrapped in a code fence or prose', () => {
    const r = parseReply('Here you go:\n```json\n{"lessons":[{"lesson":"L","evidence":[4]}]}\n```', citable);
    expect(r).toEqual({ ok: true, lessons: [{ lesson: 'L', why: '', evidence: [4] }], dropped: 0 });
  });

  it.each([
    ['the outer brace (measured on a local model)', '{"lessons":[{"lesson":"L","why":"W","evidence":[4]}]'],
    ['the outer brace inside a code fence', '```json\n{"lessons":[{"lesson":"L","why":"W","evidence":[4]}]\n```'],
    ['both closers', '{"lessons":[{"lesson":"L","why":"W","evidence":[4]}'],
  ])('recovers a reply missing %s', (_name, reply) => {
    expect(parseReply(reply, citable)).toEqual({ ok: true, lessons: [{ lesson: 'L', why: 'W', evidence: [4] }], dropped: 0 });
  });

  it('does not recover a reply cut off mid-value', () => {
    expect(parseReply('{"lessons":[{"lesson":"L","why":"W","evid', citable).ok).toBe(false);
  });

  it('treats an explicit empty list as a successful parse with zero lessons', () => {
    expect(parseReply('{"lessons": []}', citable)).toEqual({ ok: true, lessons: [], dropped: 0 });
  });

  it.each([
    ['null', null],
    ['blank', '  '],
    ['prose with no JSON', 'I found nothing worth keeping.'],
    ['missing lessons key', '{"items": []}'],
    ['non-integer evidence', '{"lessons":[{"lesson":"L","evidence":["4"]}]}'],
    ['empty lesson text', '{"lessons":[{"lesson":"  ","evidence":[4]}]}'],
  ])('fails closed on %s — never reads it as zero lessons', (_name, reply) => {
    expect(parseReply(reply, citable).ok).toBe(false);
  });
});

describe('extractLessons', () => {
  it('sends each chunk with the retro prompt and only that chunk\'s turns', async () => {
    const chat = new ScriptedChat(['{"lessons":[]}', '{"lessons":[]}']);
    const t1 = turn(1, 'a'.repeat(30));
    const t2 = turn(2, 'b'.repeat(30));
    await extractLessons(tx([t1, t2]), chat, renderTurn(t1).length + 1);
    expect(chat.requests).toHaveLength(2);
    expect(chat.requests[0][0]).toEqual({ role: 'system', content: RETRO_SYSTEM_PROMPT });
    expect(chat.requests[1][1].content).toBe(renderTurn(t2));
  });

  it('only accepts citations from the chunk the model was shown', async () => {
    const t1 = turn(1, 'a'.repeat(30));
    const t2 = turn(2, 'b'.repeat(30));
    const chat = new ScriptedChat([
      '{"lessons":[{"lesson":"cites a later chunk","evidence":[2]}]}',
      '{"lessons":[{"lesson":"cites itself","evidence":[2]}]}',
    ]);
    const r = await extractLessons(tx([t1, t2]), chat, renderTurn(t1).length + 1);
    expect(r.lessons.map((l) => l.lesson)).toEqual(['cites itself']);
    expect(r.dropped).toBe(1);
  });

  it('records a bad reply or a non-runtime error as a failed chunk and keeps going', async () => {
    const t1 = turn(1, 'a'.repeat(30));
    const chat = new ScriptedChat([
      'not json',
      new Error('Chat response was truncated'),
      '{"lessons":[{"lesson":"L","evidence":[3]}]}',
    ]);
    const r = await extractLessons(tx([t1, turn(2, 'b'.repeat(30)), turn(3, 'c'.repeat(30))]), chat, renderTurn(t1).length + 1);
    expect(r.failedChunks).toBe(2);
    expect(r.chunks.map((c) => c.ok)).toEqual([false, false, true]);
    expect(r.chunks[1]).toMatchObject({ ok: false, firstTurn: 2, lastTurn: 2, error: 'Chat response was truncated' });
    expect(r.lessons).toHaveLength(1);
  });

  it('keeps finished chunks when the runtime becomes unavailable, and marks the rest not reviewed without calling it again', async () => {
    const t1 = turn(1, 'a'.repeat(30));
    const chat = new ScriptedChat([
      '{"lessons":[{"lesson":"kept","evidence":[1]}]}',
      new RuntimeUnavailableError('timed out'),
      '{"lessons":[{"lesson":"never asked","evidence":[3]}]}',
    ]);
    const r = await extractLessons(tx([t1, turn(2, 'b'.repeat(30)), turn(3, 'c'.repeat(30))]), chat, renderTurn(t1).length + 1);
    expect(chat.requests).toHaveLength(2);
    expect(r.lessons.map((l) => l.lesson)).toEqual(['kept']);
    expect(r.failedChunks).toBe(2);
    expect(r.chunks[2]).toMatchObject({ ok: false, firstTurn: 3, lastTurn: 3, error: 'not reviewed — runtime unavailable: timed out' });
  });
});
