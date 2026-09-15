// Reads a Claude Code session transcript (JSONL) into numbered turns a retrospective can cite.

export type TurnKind = 'text' | 'tool_use' | 'tool_result';

export interface Turn {
  n: number;
  role: 'user' | 'assistant';
  kind: TurnKind;
  text: string;
}

export interface ParsedTranscript {
  sessionId: string | null;
  turns: Turn[];
  compactions: number;
  malformedLines: number;
}

export const MAX_TURN_CHARS = 1_500;

// Harness plumbing echoed into the user role; it says nothing about how the session went.
const HARNESS_PREFIXES = ['<local-command-', '<command-name>', '<command-message>', '<system-reminder>'];

// A slash command's arguments are the user's own words (often a correction), wrapped in harness tags.
function slashCommandText(text: string): string {
  const t = text.trimStart();
  if (!t.startsWith('<command-name>') && !t.startsWith('<command-message>')) return text;
  const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1].trim() ?? '';
  if (args === '') return '';
  const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(t)?.[1].trim() ?? '(command)';
  return `${name} ${args}`;
}

function clip(text: string): string {
  const t = text.trim();
  return t.length <= MAX_TURN_CHARS ? t : `${t.slice(0, MAX_TURN_CHARS)} …[truncated ${t.length - MAX_TURN_CHARS} chars]`;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b: unknown) =>
    typeof b === 'object' && b !== null && 'type' in b && b.type === 'text' && 'text' in b && typeof b.text === 'string'
      ? [b.text] : []).join('\n');
}

function blockTurn(block: unknown): { kind: TurnKind; text: string } | null {
  if (typeof block !== 'object' || block === null || !('type' in block)) return null;
  if (block.type === 'text' && 'text' in block && typeof block.text === 'string') {
    return { kind: 'text', text: block.text };
  }
  if (block.type === 'tool_use' && 'name' in block && typeof block.name === 'string') {
    const input = 'input' in block ? JSON.stringify(block.input) : '';
    return { kind: 'tool_use', text: `${block.name} ${input}` };
  }
  if (block.type === 'tool_result') {
    const error = 'is_error' in block && block.is_error === true ? '[error] ' : '';
    return { kind: 'tool_result', text: error + toolResultText('content' in block ? block.content : null) };
  }
  return null;
}

export function parseTranscript(raw: string): ParsedTranscript {
  const turns: Turn[] = [];
  let sessionId: string | null = null;
  let compactions = 0;
  let malformedLines = 0;

  const push = (role: Turn['role'], kind: TurnKind, raw: string): void => {
    const text = role === 'user' && kind === 'text' ? slashCommandText(raw) : raw;
    if (text.trim() === '') return;
    if (role === 'user' && kind === 'text' && HARNESS_PREFIXES.some((p) => text.trimStart().startsWith(p))) return;
    turns.push({ n: turns.length + 1, role, kind, text: clip(text) });
  };

  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (typeof rec !== 'object' || rec === null || Array.isArray(rec)) {
      malformedLines++;
      continue;
    }
    if (sessionId === null && 'sessionId' in rec && typeof rec.sessionId === 'string') sessionId = rec.sessionId;
    if ('type' in rec && rec.type === 'system' && 'subtype' in rec && rec.subtype === 'compact_boundary') {
      compactions++;
      continue;
    }
    // A compaction summary is the session's own retelling, so it is a claim, never evidence.
    if ('isCompactSummary' in rec && rec.isCompactSummary === true) continue;
    if ('isSidechain' in rec && rec.isSidechain === true) continue;
    if ('isMeta' in rec && rec.isMeta === true) continue;
    if (!('type' in rec) || (rec.type !== 'user' && rec.type !== 'assistant')) continue;
    const role = rec.type === 'user' ? 'user' : 'assistant';
    if (!('message' in rec) || typeof rec.message !== 'object' || rec.message === null) continue;
    const content = 'content' in rec.message ? rec.message.content : null;
    if (typeof content === 'string') {
      push(role, 'text', content);
    } else if (Array.isArray(content)) {
      for (const block of content) {
        const t = blockTurn(block);
        if (t) push(role, t.kind, t.text);
      }
    }
  }
  return { sessionId, turns, compactions, malformedLines };
}
