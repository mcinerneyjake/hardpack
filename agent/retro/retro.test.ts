import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, runRetro, type RetroDeps } from './retro.js';
import { type ChatClient, type ChatMessage } from '../runtime/llm.js';
import { emptyUsage } from '../cost/usage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

class ScriptedChat implements ChatClient {
  public requests: ChatMessage[][] = [];
  constructor(private readonly replies: string[]) {}
  complete(messages: ChatMessage[]): Promise<ChatMessage> {
    this.requests.push(messages);
    return Promise.resolve({ role: 'assistant', content: this.replies[this.requests.length - 1] ?? '{"lessons":[]}' });
  }
}

const rec = (o: object): string => JSON.stringify({ sessionId: 'sess-42', ...o });
const TRANSCRIPT = [
  rec({ type: 'user', message: { role: 'user', content: 'run the gate' } }),
  rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'npm test | tail' } }] } }),
  rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'Tests 3 failed\nexit 0' }] } }),
  rec({ type: 'system', subtype: 'compact_boundary' }),
  rec({ type: 'user', isCompactSummary: true, message: { role: 'user', content: 'Summary: all tests passed.' } }),
  rec({ type: 'user', message: { role: 'user', content: 'In zsh use $pipestatus, not PIPESTATUS.' } }),
].join('\n');

let root: string;
let transcriptPath: string;
let outDir: string;

beforeEach(async () => {
  await fs.mkdir(path.join(repoRoot, '.tmp-test'), { recursive: true });
  root = await fs.mkdtemp(path.join(repoRoot, '.tmp-test', 'retro-'));
  transcriptPath = path.join(root, 'sess-42.jsonl');
  outDir = path.join(root, 'retros');
  await fs.writeFile(transcriptPath, TRANSCRIPT);
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const deps = (chat: ChatClient, over: Partial<RetroDeps> = {}): RetroDeps => ({
  chat,
  model: 'local-test-model',
  preflight: () => Promise.resolve({ ok: true }),
  outDir,
  now: () => new Date('2026-09-15T12:00:00Z'),
  usage: emptyUsage,
  ...over,
});

describe('exitCodeFor', () => {
  const ok = { ok: true, file: 'f', lessons: 0, dropped: 0, chunks: 10 } as const;
  it('is 0 only when every chunk was reviewed, 2 when any was not, 1 when nothing was written', () => {
    expect(exitCodeFor({ ...ok, failedChunks: 0 })).toBe(0);
    expect(exitCodeFor({ ...ok, failedChunks: 1 })).toBe(2);
    expect(exitCodeFor({ ...ok, failedChunks: 9 })).toBe(2);
    expect(exitCodeFor({ ok: false, error: 'x' })).toBe(1);
  });
});

describe('runRetro — transcript to proposals file', () => {
  it('round-trips transcript text into the proposals file verbatim, as model-independent evidence', async () => {
    const chat = new ScriptedChat([JSON.stringify({ lessons: [
      { lesson: 'A pipe hides the exit status of the command before it.', why: 'The gate read as green while tests failed.', evidence: [2, 3, 4] },
      { lesson: 'Invented lesson', why: '', evidence: [40] },
    ] })]);

    const outcome = await runRetro(transcriptPath, deps(chat));

    expect(outcome).toMatchObject({ ok: true, lessons: 1, dropped: 1, failedChunks: 0, chunks: 1 });
    // What the model was shown excludes the compaction summary.
    const sent = chat.requests[0][1].content ?? '';
    expect(sent).not.toContain('Summary: all tests passed.');
    expect(sent).toContain('[#4 user text] In zsh use $pipestatus, not PIPESTATUS.');

    const files = await fs.readdir(outDir);
    expect(files).toEqual(['sess-42.md']);
    const md = await fs.readFile(path.join(outDir, 'sess-42.md'), 'utf8');
    expect(md).toContain('### 1. A pipe hides the exit status of the command before it.');
    expect(md).toContain('- **#2 assistant tool_use**\n  > Bash {"command":"npm test | tail"}');
    expect(md).toContain('- **#3 user tool_result**\n  > Tests 3 failed\n  > exit 0');
    expect(md).toContain('  > In zsh use $pipestatus, not PIPESTATUS.');
    expect(md).toContain('compactions: 1');
    expect(md).toContain('dropped for citing no turn in their excerpt: 1');
    expect(md).not.toContain('Invented lesson');
    expect(md).not.toContain('Summary: all tests passed.');
  });

  it('writes nothing and never reads the transcript when the preflight fails', async () => {
    const chat = new ScriptedChat([]);
    const outcome = await runRetro(path.join(root, 'does-not-exist.jsonl'), deps(chat, {
      preflight: () => Promise.resolve({ ok: false, message: 'runtime is not reachable' }),
    }));
    expect(outcome).toEqual({ ok: false, error: 'runtime is not reachable' });
    expect(chat.requests).toHaveLength(0);
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it('fails when every chunk fails, writing no file that would read as "no lessons"', async () => {
    const chat = new ScriptedChat(['sorry, I cannot help with that']);
    const outcome = await runRetro(transcriptPath, deps(chat));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('every chunk failed');
    await expect(fs.access(outDir)).rejects.toThrow();
  });

  it('writes a file naming the failed chunks when only some fail', async () => {
    const chat = new ScriptedChat(['not json', '{"lessons":[]}']);
    const outcome = await runRetro(transcriptPath, deps(chat, { chunkChars: 60 }));
    expect(outcome).toMatchObject({ ok: true, failedChunks: 1 });
    const md = await fs.readFile(path.join(outDir, 'sess-42.md'), 'utf8');
    expect(md).toContain('## Failed chunks');
    expect(md).toContain('Lessons from these turns are MISSING, not absent.');
  });

  it('fails on a transcript with no usable turns', async () => {
    await fs.writeFile(transcriptPath, `${rec({ type: 'attachment' })}\n{broken`);
    const outcome = await runRetro(transcriptPath, deps(new ScriptedChat([])));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('1 malformed line');
  });

  it('fails on an unreadable transcript path', async () => {
    const outcome = await runRetro(path.join(root, 'missing.jsonl'), deps(new ScriptedChat([])));
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.error).toContain('cannot read');
  });

  it('refuses to overwrite an existing proposals file unless forced', async () => {
    await fs.mkdir(outDir, { recursive: true });
    await fs.writeFile(path.join(outDir, 'sess-42.md'), 'human edits');

    await expect(runRetro(transcriptPath, deps(new ScriptedChat([])))).rejects.toThrow('--force');
    expect(await fs.readFile(path.join(outDir, 'sess-42.md'), 'utf8')).toBe('human edits');

    const forced = await runRetro(transcriptPath, deps(new ScriptedChat([]), { force: true }));
    expect(forced.ok).toBe(true);
    expect(await fs.readFile(path.join(outDir, 'sess-42.md'), 'utf8')).toContain('# Retrospective proposals — sess-42');
  });
});
