import { type ChatTool } from './tools.js';
import { UsageMeter, type RunUsage, type CallTokens } from '../cost/usage.js';
import { RuntimeUnavailableError, UNAVAILABLE_STATUS } from './unavailable.js';

// Gateway-class statuses: the request never reached a working model.

// Chat client for the agent loop — OpenAI-compatible /v1/chat/completions via fetch, no SDK. The provider seam (local vs cloud) is config-driven; a cloud driver would be a separate ChatClient (tkt-29788d084c21).

const DEFAULT_BASE_URL = 'http://localhost:1234/v1';
// Local models can be slow to first token; give them generous headroom.
const CHAT_TIMEOUT_MS = 120_000;
// A liveness probe should fail fast — far shorter than a generation request.
const PING_TIMEOUT_MS = 5_000;

export interface LlmConfig {
  baseUrl: string;
  model: string;
  /** Optional bearer key — required by cloud endpoints, unused by local ones. */
  apiKey: string | null;
  /** Sampling temperature. Defaults to 0: intake is a CLASSIFICATION task, so determinism beats
   *  variety — the same report should land on the same type/priority/project every run. */
  temperature: number;
  /** Nucleus sampling. null ⇒ omit from the request (let the runtime default stand). */
  topP: number | null;
  /** RNG seed for reproducibility, when the runtime honors it. null ⇒ omit. */
  seed: number | null;
  /** Reasoning-effort hint (gpt-oss et al). An ACCURACY dial, not a latency one — high is ~6× slower.
   *  null ⇒ omit. */
  reasoningEffort: string | null;
}

// Parse a finite float from env; null on absent/blank/NaN so a bad value omits the param rather than
// sending garbage. Callers apply their own default (temperature) or omit (top_p).
function floatFromEnv(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function intFromEnv(raw: string | undefined): number | null {
  const n = floatFromEnv(raw);
  return n !== null && Number.isInteger(n) ? n : null;
}

export function resolveLlmConfig(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const baseUrl = (env.LLM_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = env.LLM_MODEL ?? 'qwen/qwen3.5-9b';
  const apiKey = env.LLM_API_KEY ?? null;
  return {
    baseUrl,
    model,
    apiKey,
    temperature: floatFromEnv(env.LLM_TEMPERATURE) ?? 0,
    topP: floatFromEnv(env.LLM_TOP_P),
    seed: intFromEnv(env.LLM_SEED),
    reasoningEffort: env.LLM_REASONING_EFFORT?.trim() || null,
  };
}

// --- message + tool-call shapes (OpenAI chat-completions) -------------------

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ChatClient {
  complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage>;
}

/** Preflight verdict. `ok: false` carries an operator-facing message naming the fix. */
export type PreflightResult = { ok: true } | { ok: false; message: string };

// The runtime reports an unloaded/evicting model as a 4xx whose body says so. Matched on the body
// text because it is not a distinct status code, and translated into the command that fixes it —
// the raw upstream JSON (`{"error":"Model has not started loading/has been unloaded."}`) tells the
// operator nothing actionable (tkt-b97efe93a6a3).
function looksUnloaded(body: string): boolean {
  return /has not started loading|has been unloaded|model.{0,20}not loaded/i.test(body);
}

// --- response validation (type predicates, no casts) ------------------------

function isToolCall(v: unknown): v is ToolCall {
  if (typeof v !== 'object' || v === null) return false;
  if (!('id' in v) || typeof v.id !== 'string') return false;
  if ('type' in v && v.type !== 'function') return false;
  if (!('function' in v) || typeof v.function !== 'object' || v.function === null) return false;
  const fn = v.function;
  return 'name' in fn && typeof fn.name === 'string'
    && 'arguments' in fn && typeof fn.arguments === 'string';
}

interface AssistantMessage { content: string | null; tool_calls?: ToolCall[] }
function isAssistantMessage(v: unknown): v is AssistantMessage {
  if (typeof v !== 'object' || v === null) return false;
  const content = 'content' in v ? v.content : null;
  if (content !== null && typeof content !== 'string') return false;
  if ('tool_calls' in v && v.tool_calls !== undefined) {
    if (!Array.isArray(v.tool_calls) || !v.tool_calls.every(isToolCall)) return false;
  }
  return true;
}

interface ChatCompletion { choices: { message: AssistantMessage }[] }
function isChatCompletion(v: unknown): v is ChatCompletion {
  if (typeof v !== 'object' || v === null) return false;
  if (!('choices' in v) || !Array.isArray(v.choices) || v.choices.length === 0) return false;
  const first: unknown = v.choices[0];
  if (typeof first !== 'object' || first === null || !('message' in first)) return false;
  return isAssistantMessage(first.message);
}

// `finish_reason: "length"` means the runtime hit its token cap and TRUNCATED — content/tool_calls are
// incomplete. The loop reads a truncated turn (no tool_calls) as "the model is done" and returns the
// partial text as the run's final answer (tkt-dcf9ceff7174), so this must be caught and surfaced as an
// error, never treated as terminal. Any other reason (stop / tool_calls / absent) is a usable turn.
function truncatedByLength(v: unknown): boolean {
  if (typeof v !== 'object' || v === null || !('choices' in v) || !Array.isArray(v.choices)) return false;
  const first: unknown = v.choices[0];
  return typeof first === 'object' && first !== null
    && 'finish_reason' in first && first.finish_reason === 'length';
}

// Token usage is optional + best-effort: read only when well-formed, so a runtime that omits/malforms it never breaks the response.
function chatUsageOf(v: unknown): CallTokens | undefined {
  if (typeof v !== 'object' || v === null || !('usage' in v)) return undefined;
  const u = v.usage;
  if (typeof u !== 'object' || u === null) return undefined;
  if (!('prompt_tokens' in u) || typeof u.prompt_tokens !== 'number') return undefined;
  if (!('completion_tokens' in u) || typeof u.completion_tokens !== 'number') return undefined;
  if (!('total_tokens' in u) || typeof u.total_tokens !== 'number') return undefined;
  // Optional cached-prompt-token hit count (newer llama.cpp / vLLM); omitted by older runtimes.
  let cached: number | undefined;
  if ('prompt_tokens_details' in u) {
    const d = u.prompt_tokens_details;
    if (typeof d === 'object' && d !== null && 'cached_tokens' in d && typeof d.cached_tokens === 'number') {
      cached = d.cached_tokens;
    }
  }
  return { prompt: u.prompt_tokens, completion: u.completion_tokens, total: u.total_tokens, cached };
}

// Size of the request as sent — tool-call args and results ride in the messages, so they count.
function messageChars(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + (m.content?.length ?? 0)
    + (m.tool_calls?.reduce((t, c) => t + c.function.name.length + c.function.arguments.length, 0) ?? 0), 0);
}

export class RuntimeChatClient implements ChatClient {
  private readonly meter = new UsageMeter();

  // `now` is injectable so call durations are deterministic under test.
  constructor(
    private readonly cfg: LlmConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeChatClient {
    return new RuntimeChatClient(resolveLlmConfig(env));
  }

  // Accumulated usage over this client's lifetime (one client per run). Tokens are "available" only if reportedCalls > 0.
  getUsage(): RunUsage {
    return this.meter.get();
  }

  async complete(messages: ChatMessage[], tools: ChatTool[]): Promise<ChatMessage> {
    const start = this.now();
    const res = await this.fetchCompletion(messages, tools);
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 500);
      // Runtime up, model absent — still "the runtime cannot serve this", and the message names the fix.
      if (looksUnloaded(body)) throw new RuntimeUnavailableError(this.unloadedMessage());
      // A gateway-class status is the runtime (or a proxy in front of it) declining to serve — the
      // other direction of the same misreport (tkt-a449b3ae0339). 4xx and a bare 500 stay faults, so
      // their body reaches the server log instead of being answered with "is the model running?".
      if (UNAVAILABLE_STATUS.has(res.status)) {
        throw new RuntimeUnavailableError(`Chat request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
      }
      throw new Error(`Chat request failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`);
    }
    const json: unknown = await res.json();
    if (!isChatCompletion(json)) throw new Error('Unexpected /chat/completions response shape');
    // Meter first: the model ran and burned tokens even if the reply was truncated — recording it
    // before the truncation throw keeps compute attribution honest (tkt-1e98c78e8c01).
    this.meter.record({
      kind: 'chat',
      startedAt: start,
      elapsedMs: this.now() - start,
      inputChars: messageChars(messages),
      tokens: chatUsageOf(json),
    });
    // Before the truncation check: if the wrong model answered, "raise your token limit" is the wrong fix.
    this.assertServedModel(json);
    if (truncatedByLength(json)) {
      throw new Error('Chat response was truncated (finish_reason: "length") — the model hit its token limit and the reply is incomplete. Refusing to treat a truncated response as a final answer; raise the token limit or shorten the input.');
    }
    const msg = json.choices[0].message;
    return { role: 'assistant', content: msg.content, tool_calls: msg.tool_calls };
  }

  // Preflight lists downloaded ids; only the reply says which model RAN — an unserved id comes back 200
  // naming a different one (measured, tkt-fdb39a679982). Absent, blank, or differing only in case and
  // padding is no evidence of substitution, and a false positive here denies service on every agent path.
  // A tag/quantization suffix is NOT normalized away: that names a different build, which is exactly
  // the provenance difference this exists to catch.
  private assertServedModel(json: unknown): void {
    if (typeof json !== 'object' || json === null || !('model' in json)) return;
    const served = json.model;
    if (typeof served !== 'string') return;
    const norm = served.trim().toLowerCase();
    if (norm === '' || norm === this.cfg.model.trim().toLowerCase()) return;
    throw new Error(
      `Chat ran on "${served}" but "${this.cfg.model}" was requested (${this.cfg.baseUrl}). `
      + 'The runtime substituted a different model, so this reply is not attributable to the requested '
      + 'model — refusing it. Set LLM_MODEL to a model the runtime serves.',
    );
  }

  // Bearer auth is required by cloud endpoints and unused by local ones; one place decides.
  private authHeaders(base: Record<string, string> = {}): Record<string, string> {
    return this.cfg.apiKey ? { ...base, authorization: `Bearer ${this.cfg.apiKey}` } : base;
  }

  // Liveness probe — a cheap GET to /models. Returns false on any failure (down, timeout, non-200) so callers branch without a try/catch.
  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, {
        headers: this.authHeaders(), signal: AbortSignal.timeout(PING_TIMEOUT_MS),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  // Model ids the runtime advertises; null when it can't be reached or answers badly.
  private async listModelIds(): Promise<string[] | null> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/models`, { headers: this.authHeaders(), signal: AbortSignal.timeout(PING_TIMEOUT_MS) });
      if (!res.ok) return null;
      const json: unknown = await res.json();
      if (typeof json !== 'object' || json === null || !('data' in json) || !Array.isArray(json.data)) return null;
      return json.data.flatMap((m: unknown) =>
        typeof m === 'object' && m !== null && 'id' in m && typeof m.id === 'string' ? [m.id] : []);
    } catch {
      return null;
    }
  }

  private unloadedMessage(): string {
    return `The model "${this.cfg.model}" is not loaded at ${this.cfg.baseUrl}.\n`
      + `Load it and re-run:  lms load ${this.cfg.model}\n`
      + '(The chat and embedding models evict each other in one LM Studio instance — tkt-5da0ac7b4956.)';
  }

  // Fail fast BEFORE the run's embedding pass, so a bad model id doesn't surface 30s of indexing later.
  //
  // Deliberately does NOT claim the model is *resident*: verified against LM Studio 2026-07-27, GET
  // /models lists every DOWNLOADED model — an unloaded one is still listed — so residency is not
  // observable over the OpenAI-compatible surface. A presence check would be a preflight that can
  // never fail, which is worse than none. What it does catch is a typo'd/absent LLM_MODEL. Eviction
  // is handled where it actually shows up: the 4xx translation in complete(). Loading is left to the
  // runtime's JIT (LM Studio loads on first call), which is why this reports rather than loads.
  async preflight(): Promise<PreflightResult> {
    const ids = await this.listModelIds();
    if (ids === null) {
      return { ok: false, message: `The local LLM runtime at ${this.cfg.baseUrl} is not reachable.\nStart it and re-run (LM Studio: \`lms server start\`), or point LLM_BASE_URL elsewhere.` };
    }
    if (!ids.includes(this.cfg.model)) {
      const known = ids.length ? ids.map((i) => `  - ${i}`).join('\n') : '  (none)';
      return { ok: false, message: `LLM_MODEL "${this.cfg.model}" is not available at ${this.cfg.baseUrl}.\nModels the runtime reports:\n${known}\nFix LLM_MODEL in .env, or download the model.` };
    }
    return { ok: true };
  }

  private async fetchCompletion(messages: ChatMessage[], tools: ChatTool[]): Promise<Response> {
    const headers = this.authHeaders({ 'content-type': 'application/json' });
    const body = JSON.stringify({
      model: this.cfg.model,
      messages,
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
      // Sampling params. temperature is always sent (default 0 for deterministic classification); the
      // rest are omitted when unset (JSON.stringify drops undefined) so the runtime's own default stands.
      temperature: this.cfg.temperature,
      top_p: this.cfg.topP ?? undefined,
      seed: this.cfg.seed ?? undefined,
      reasoning_effort: this.cfg.reasoningEffort ?? undefined,
    });
    try {
      return await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new RuntimeUnavailableError(`Chat request timed out after ${CHAT_TIMEOUT_MS}ms — is the runtime at ${this.cfg.baseUrl} up?`, { cause: err });
      }
      throw err;
    }
  }
}
