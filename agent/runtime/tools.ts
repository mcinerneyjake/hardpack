import { type Tool } from '@modelcontextprotocol/sdk/types.js';
import { TOOLS, handleToolCall, type ToolResult } from '../../mcp/handlers.js';
import { listProjects } from '../../server/tickets.js';
import { type DocumentIndex } from '../retrieval/retrieval.js';
import { type Provenance } from '../../shared/constants.js';

// Tool layer: a safe whitelist of MCP tools (reused verbatim via handleToolCall) + search_board over the retrieval index, adapted to the OpenAI function-tool shape.

// Read + non-destructive writes only. Deliberately EXCLUDES delete_ticket (destructive, reachable from untrusted intake) and start_ticket (dev-workflow). search_board is agent-only — it needs the embedding index.
export const AGENT_TOOL_NAMES = new Set<string>([
  'list_tickets', 'get_ticket', 'search_board', 'create_ticket', 'update_ticket',
]);

// Create-only mode (the Claude-delegated path, tkt-2492e26a277a): drop update_ticket so a mis-matched
// retrieval can't overwrite an existing ticket's body. A delegated create that duplicates is a
// non-destructive nuisance (delete/merge later); a delegated update that clobbers a rich hand-authored
// body is damage whose undo is only best-effort (ticket-workflow README -> Backup-on-write). The
// interactive/demo path keeps update_ticket for its anti-duplicate story.
export const CREATE_ONLY_TOOL_NAMES = new Set<string>(
  [...AGENT_TOOL_NAMES].filter((n) => n !== 'update_ticket'),
);

// The one tool not in mcp/handlers — semantic search over the board.
const SEARCH_BOARD_TOOL: Tool = {
  name: 'search_board',
  description:
    'Semantic search over existing tickets. ALWAYS call this before proposing a new ticket, to find likely duplicates or a related ticket to update instead of creating one.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language description of the issue to search for' },
      limit: { type: 'number', description: 'Max results to return (default 5)' },
    },
    required: ['query'],
  },
};

// Minimal OpenAI chat-completions function-tool shape (avoids the SDK dep).
export interface ChatTool {
  type: 'function';
  function: { name: string; description: string; parameters: Tool['inputSchema'] };
}

function toChatTool(t: Tool): ChatTool {
  return { type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.inputSchema } };
}

// Human-owned (tkt-fc409e4c7ec9): afk admits unattended work and spec links a spec file, so the
// untrusted-intake agent is never offered either and dispatchTool strips them (the 403 covers afk only).
export const HUMAN_ONLY_FIELDS: ReadonlySet<string> = new Set(['autonomy', 'spec']);

function withoutHumanOnlyFields(t: Tool): Tool {
  const props = t.inputSchema.properties;
  if (!props) return t;
  const kept = Object.fromEntries(Object.entries(props).filter(([k]) => !HUMAN_ONLY_FIELDS.has(k)));
  return { ...t, inputSchema: { ...t.inputSchema, properties: kept } };
}

function buildAgentTools(names: Set<string>): ChatTool[] {
  return [...TOOLS.filter((t) => names.has(t.name)).map(withoutHumanOnlyFields), SEARCH_BOARD_TOOL].map(toChatTool);
}

export function stripHumanOnlyFields(
  args: Record<string, unknown> | undefined,
): { args: Record<string, unknown> | undefined; dropped: string[] } {
  if (!args) return { args, dropped: [] };
  const dropped = Object.keys(args).filter((k) => HUMAN_ONLY_FIELDS.has(k));
  if (dropped.length === 0) return { args, dropped };
  return { args: Object.fromEntries(Object.entries(args).filter(([k]) => !HUMAN_ONLY_FIELDS.has(k))), dropped };
}

// The agent's advertised tools: whitelisted MCP tools + search_board. The create-only variant drops
// update_ticket so the model is never offered it (dispatchTool refuses it too — double-gated).
export const AGENT_TOOLS: ChatTool[] = buildAgentTools(AGENT_TOOL_NAMES);
export const AGENT_TOOLS_CREATE_ONLY: ChatTool[] = buildAgentTools(CREATE_ONLY_TOOL_NAMES);

// Text-only result matching the MCP ToolResult shape.
export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], isError };
}

async function searchBoard(args: Record<string, unknown> | undefined, index: DocumentIndex): Promise<ToolResult> {
  const query = typeof args?.query === 'string' ? args.query : null;
  if (!query) return textResult('Missing required field: query', true);
  const limit = typeof args?.limit === 'number' ? args.limit : 5;
  const results = await index.search(query, limit);
  // Explicit fields, NOT a `...meta` spread — so a future source's meta `score`/`title` key can't overwrite a core field, and generic fields like `source` don't leak in as prompt noise.
  const flat = results.map((r) => ({ id: r.id, title: r.title, status: r.meta?.status, score: r.score }));
  return textResult(JSON.stringify(flat, null, 2));
}

// The two write tools — stamped with run provenance (source: agent + runId) AND project-constrained.
const WRITE_TOOLS = new Set(['create_ticket', 'update_ticket']);

// Projects are DERIVED from tickets, so the human UI mints a new project just by naming one — but the
// untrusted-intake agent must not: it hallucinates project names (tkt-beef54d90c59). Match a proposed
// project to a real one case- and whitespace-insensitively (a weaker local model's "kanban" resolves to
// the board's "Kanban") and canonicalize to the board's exact spelling; a name that matches nothing is
// DROPPED so the write omits it — on create it defaults to unassigned, on update the existing project is
// kept rather than cleared. null (clear) / unset / a non-string all pass through. Pure — no fs, so unit-testable.
export function constrainAgentProject(
  args: Record<string, unknown> | undefined,
  knownProjects: string[],
): { args: Record<string, unknown> | undefined; dropped: string | null } {
  if (!args || typeof args.project !== 'string') return { args, dropped: null };
  const project = args.project;
  const norm = project.trim().toLowerCase();
  const canonical = norm === '' ? undefined : knownProjects.find((p) => p.trim().toLowerCase() === norm);
  if (canonical === undefined) {
    const rest = { ...args };
    delete rest.project;
    return { args: rest, dropped: project };
  }
  return canonical === project ? { args, dropped: null } : { args: { ...args, project: canonical }, dropped: null };
}

// One tool call → one ToolResult. Anything outside the whitelist is refused — double-gating so delete_ticket/start_ticket can never reach the service via the agent. `runId` stamps create/update writes with provenance — the agent-only boundary the human MCP client never crosses.
export async function dispatchTool(
  name: string,
  args: Record<string, unknown> | undefined,
  index: DocumentIndex,
  runId?: string,
  allowedNames: Set<string> = AGENT_TOOL_NAMES,
): Promise<ToolResult> {
  // Two gates. AGENT_TOOL_NAMES is the HARD FLOOR — delete_ticket/start_ticket are never dispatchable
  // no matter what a caller passes, so a mode set can only NARROW within the safe whitelist, never widen
  // it to a destructive tool. allowedNames then applies the per-mode narrowing (create-only drops
  // update_ticket). Keeping the floor here, not just in allowedNames, means a future mode built by
  // analogy can't accidentally re-admit a destructive tool.
  if (!AGENT_TOOL_NAMES.has(name) || !allowedNames.has(name)) {
    return textResult(`Tool not available to the agent: ${name}`, true);
  }
  if (name === 'search_board') return searchBoard(args, index);
  const provenance: Provenance | undefined =
    runId && WRITE_TOOLS.has(name) ? { source: 'agent', runId } : undefined;
  let callArgs = args;
  if (WRITE_TOOLS.has(name)) {
    const { args: stripped, dropped } = stripHumanOnlyFields(args);
    if (dropped.length > 0) console.warn(`[agent] ignored ${dropped.join(', ')} — human-only fields.`);
    callArgs = stripped;
  }
  // Only a string project needs constraining — gate the full-board listProjects() read on that, so a
  // create/update with no project (the common case) doesn't scan every ticket.
  if (WRITE_TOOLS.has(name) && typeof callArgs?.project === 'string') {
    const { args: constrained, dropped } = constrainAgentProject(callArgs, await listProjects());
    // Loud, not silent: a dropped project is a corrected model hallucination the reviewer should see.
    // Path-agnostic wording — on create the ticket is unassigned, on update the existing project is kept.
    if (dropped !== null) console.warn(`[agent] ignored unknown project "${dropped}" — not a project on the board.`);
    callArgs = constrained;
  }
  return handleToolCall(name, callArgs, provenance);
}
