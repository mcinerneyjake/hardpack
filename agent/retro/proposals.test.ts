import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_EXCERPT_CHARS, proposalsFileName, renderProposals, retrosDir, writeProposals, type ProposalsInput,
} from './proposals.js';
import { emptyUsage } from '../cost/usage.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const input = (over: Partial<ProposalsInput> = {}): ProposalsInput => ({
  source: '/x/sess.jsonl',
  model: 'm',
  generatedAt: new Date('2026-09-15T00:00:00Z'),
  transcript: { sessionId: 'sess', turns: [{ n: 1, role: 'user', kind: 'text', text: 'hello' }], compactions: 0, malformedLines: 0 },
  result: { chunks: [{ ok: true, firstTurn: 1, lastTurn: 1, lessons: [], dropped: 0 }], lessons: [], dropped: 0, failedChunks: 0 },
  usage: null,
  ...over,
});

describe('retrosDir', () => {
  it('defaults to the gitignored project-root retros/', async () => {
    expect(retrosDir({})).toBe(path.join(repoRoot, 'retros'));
    const ignore = (await fs.readFile(path.join(repoRoot, '.gitignore'), 'utf8')).split('\n');
    expect(ignore).toContain('retros/');
  });

  it('honors RETROS_DIR_OVERRIDE', () => {
    expect(retrosDir({ RETROS_DIR_OVERRIDE: '/elsewhere' })).toBe('/elsewhere');
  });

  it.each(['', '   '])('ignores a blank override (%j) rather than resolving to the cwd', (value) => {
    expect(retrosDir({ RETROS_DIR_OVERRIDE: value })).toBe(path.join(repoRoot, 'retros'));
  });
});

describe('renderProposals', () => {
  it('says so when nothing was proposed, and omits the failed-chunks section when none failed', () => {
    const md = renderProposals(input());
    expect(md).toContain('None proposed.');
    expect(md).not.toContain('## Failed chunks');
    expect(md).toContain('Usage: not recorded');
    expect(md).toContain('Nothing here has been written to memory');
  });

  it('distinguishes unreported tokens from reported ones', () => {
    expect(renderProposals(input({ usage: { ...emptyUsage(), calls: 2, activeMs: 1500 } })))
      .toContain('2 chat call(s), tokens not reported by the runtime, 1.5s active');
    expect(renderProposals(input({ usage: { ...emptyUsage(), calls: 1, reportedCalls: 1, promptTokens: 10, completionTokens: 3 } })))
      .toContain('10 prompt / 3 completion tokens');
  });

  it('caps a long excerpt', () => {
    const text = 'q'.repeat(MAX_EXCERPT_CHARS + 50);
    const md = renderProposals(input({
      transcript: { sessionId: null, turns: [{ n: 1, role: 'assistant', kind: 'text', text }], compactions: 0, malformedLines: 0 },
      result: { chunks: [], lessons: [{ lesson: 'L', why: '', evidence: [1] }], dropped: 0, failedChunks: 0 },
    }));
    expect(md).toContain(`  > ${'q'.repeat(MAX_EXCERPT_CHARS)} …`);
    expect(md).not.toContain('q'.repeat(MAX_EXCERPT_CHARS + 1));
    expect(md).toContain('# Retrospective proposals — sess.jsonl');
  });
});

describe('proposalsFileName', () => {
  it('prefers the session id and falls back to the transcript basename', () => {
    expect(proposalsFileName('abc-123', '/x/y.jsonl')).toBe('abc-123.md');
    expect(proposalsFileName(null, '/x/y.jsonl')).toBe('y.md');
  });

  it('cannot be steered out of the directory by a hostile session id', () => {
    expect(proposalsFileName('../../.claude/memory/MEMORY', '/x/y.jsonl')).toBe('_.._.claude_memory_MEMORY.md');
    expect(proposalsFileName('...', '/x/y.jsonl')).toBe('transcript.md');
  });
});

describe('writeProposals', () => {
  let dir: string;
  beforeEach(async () => {
    await fs.mkdir(path.join(repoRoot, '.tmp-test'), { recursive: true });
    dir = await fs.mkdtemp(path.join(repoRoot, '.tmp-test', 'proposals-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates the directory and writes the file', async () => {
    const out = path.join(dir, 'nested');
    const file = await writeProposals(out, 'a.md', 'body', false);
    expect(file).toBe(path.join(out, 'a.md'));
    expect(await fs.readFile(file, 'utf8')).toBe('body');
  });

  it('refuses a file name that resolves outside the directory', async () => {
    await expect(writeProposals(path.join(dir, 'out'), '../escape.md', 'x', true)).rejects.toThrow('outside');
    await expect(fs.access(path.join(dir, 'escape.md'))).rejects.toThrow();
  });

  it('surfaces a non-EEXIST write error unchanged', async () => {
    await fs.mkdir(path.join(dir, 'a.md'));
    await expect(writeProposals(dir, 'a.md', 'x', true)).rejects.toThrow(/EISDIR/);
  });
});
