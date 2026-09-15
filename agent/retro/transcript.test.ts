import { describe, it, expect } from 'vitest';
import { MAX_TURN_CHARS, parseTranscript } from './transcript.js';

const line = (rec: object): string => JSON.stringify({ sessionId: 's-1', ...rec });
const user = (content: unknown, extra: object = {}): string => line({ type: 'user', message: { role: 'user', content }, ...extra });
const assistant = (content: unknown, extra: object = {}): string => line({ type: 'assistant', message: { role: 'assistant', content }, ...extra });

describe('parseTranscript', () => {
  it('numbers user and assistant turns in order, one per content block', () => {
    const tx = parseTranscript([
      user('fix the flaky test'),
      assistant([
        { type: 'thinking', thinking: 'secret reasoning' },
        { type: 'text', text: 'Looking at it.' },
        { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'npm test' } },
      ]),
      user([{ type: 'tool_result', tool_use_id: 'a', content: '3 failed' }]),
    ].join('\n'));

    expect(tx.sessionId).toBe('s-1');
    expect(tx.turns).toEqual([
      { n: 1, role: 'user', kind: 'text', text: 'fix the flaky test' },
      { n: 2, role: 'assistant', kind: 'text', text: 'Looking at it.' },
      { n: 3, role: 'assistant', kind: 'tool_use', text: 'Bash {"command":"npm test"}' },
      { n: 4, role: 'user', kind: 'tool_result', text: '3 failed' },
    ]);
  });

  it('never carries thinking text into a turn', () => {
    const tx = parseTranscript(assistant([{ type: 'thinking', thinking: 'secret reasoning' }]));
    expect(tx.turns).toEqual([]);
  });

  it('joins array tool_result text blocks and marks errors', () => {
    const tx = parseTranscript(user([{
      type: 'tool_result', is_error: true,
      content: [{ type: 'text', text: 'line one' }, { type: 'image' }, { type: 'text', text: 'line two' }],
    }]));
    expect(tx.turns[0].text).toBe('[error] line one\nline two');
  });

  it('counts compactions and excludes the compaction summary from evidence', () => {
    const tx = parseTranscript([
      user('before'),
      line({ type: 'system', subtype: 'compact_boundary', content: 'Conversation compacted' }),
      user('This session is being continued… the tests all passed.', { isCompactSummary: true }),
      user('after'),
    ].join('\n'));
    expect(tx.compactions).toBe(1);
    expect(tx.turns.map((t) => t.text)).toEqual(['before', 'after']);
  });

  it('skips sidechain, meta, attachment and other system records', () => {
    const tx = parseTranscript([
      user('subagent prompt', { isSidechain: true }),
      user('caveat', { isMeta: true }),
      line({ type: 'attachment', attachment: { x: 1 } }),
      line({ type: 'system', subtype: 'turn_duration' }),
      user('kept'),
    ].join('\n'));
    expect(tx.turns.map((t) => t.text)).toEqual(['kept']);
    expect(tx.compactions).toBe(0);
  });

  it('drops harness plumbing echoed into the user role, but not a user message mentioning it', () => {
    const tx = parseTranscript([
      user('<local-command-stdout></local-command-stdout>'),
      user('<command-name>/clear</command-name>'),
      user('why did <command-name> show up?'),
    ].join('\n'));
    expect(tx.turns.map((t) => t.text)).toEqual(['why did <command-name> show up?']);
  });

  it('keeps a slash command\'s arguments as the user\'s words, and drops an argument-less one', () => {
    const tx = parseTranscript([
      user('<command-message>hardpack-workflow</command-message>\n<command-name>/hardpack-workflow</command-name>\n<command-args>--gates manual — and stop committing to main</command-args>'),
      user('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    ].join('\n'));
    expect(tx.turns.map((t) => t.text)).toEqual(['/hardpack-workflow --gates manual — and stop committing to main']);
  });

  it('counts malformed lines instead of throwing, and ignores blank lines', () => {
    const tx = parseTranscript(['{not json', '', '[1,2]', '"str"', user('ok')].join('\n'));
    expect(tx.malformedLines).toBe(3);
    expect(tx.turns).toHaveLength(1);
  });

  it('skips empty text and records without a usable message', () => {
    const tx = parseTranscript([
      user('   '),
      line({ type: 'user' }),
      line({ type: 'assistant', message: null }),
      assistant([{ type: 'text', text: '' }, { type: 'mystery' }, null]),
    ].join('\n'));
    expect(tx.turns).toEqual([]);
  });

  it('clips an oversized turn and says how much was cut', () => {
    const tx = parseTranscript(user('x'.repeat(MAX_TURN_CHARS + 25)));
    expect(tx.turns[0].text).toBe(`${'x'.repeat(MAX_TURN_CHARS)} …[truncated 25 chars]`);
  });

  it('keeps a turn exactly at the limit whole', () => {
    const tx = parseTranscript(user('y'.repeat(MAX_TURN_CHARS)));
    expect(tx.turns[0].text).toBe('y'.repeat(MAX_TURN_CHARS));
  });

  it('returns an empty result for empty input', () => {
    expect(parseTranscript('')).toEqual({ sessionId: null, turns: [], compactions: 0, malformedLines: 0 });
  });
});
