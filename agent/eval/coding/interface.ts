import { createHash } from 'node:crypto';
import path from 'node:path';

// Frozen body + the entry points hidden tests call that are absent at base (tkt-31b7acb04b13). A screen
// verdict binds to the sha256 of the whole rendered statement, so any change here re-stales it.

export interface ModuleRef {
  specifier: string;
  // Value bindings the test uses; null when they cannot be read (a script run by URL, an opaque import()).
  names: string[] | null;
}

export interface InterfaceItem {
  module: string;
  isNew: boolean;
  names: string[];
}

// Repo-relative content at a revision; null ONLY for a path confirmed absent there. Any other failure throws.
export type ReadAt = (rev: string, file: string) => Promise<string | null>;

export function statementSha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

const IDENT = '[A-Za-z_$][\\w$]*';
const SPEC = String.raw`['"]([^'"]+)['"]`;
const STATIC_IMPORT = new RegExp(String.raw`^[ \t]*import\s+(type\s+)?([^'";]*?)\s*from\s*${SPEC}`, 'gm');
const BARE_IMPORT = new RegExp(String.raw`^[ \t]*import\s*${SPEC}`, 'gm');
const DESTRUCTURED_IMPORT = new RegExp(String.raw`\{([^}]*)\}\s*=\s*await\s+import\(\s*${SPEC}\s*\)`, 'g');
const BOUND_IMPORT = new RegExp(String.raw`(?<![\w$.])(${IDENT})\s*=\s*await\s+import\(\s*${SPEC}\s*\)`, 'g');
const DYNAMIC_IMPORT = new RegExp(String.raw`\bimport\(\s*${SPEC}\s*\)`, 'g');
const URL_REF = new RegExp(String.raw`\bnew URL\(\s*${SPEC}\s*,\s*import\.meta\.url\s*\)`, 'g');
const REGEX_CAN_FOLLOW = '(,=:[!&|?{};+-*%<>~^';

// Linear, so no regex needs a comment alternation to backtrack through (one measured 62 s). Blanks comments
// and template bodies, keeping offsets; string and regex literals stay intact.
export function maskSource(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '/' && next === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      blank(i, end);
      i = end;
    } else if (ch === '/' && next === '*') {
      const close = src.indexOf('*/', i + 2);
      const end = close === -1 ? src.length : close + 2;
      blank(i, end);
      i = end;
    } else if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== ch && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      i = j + 1;
      prev = ch;
    } else if (ch === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = ch;
    } else if (ch === '/' && (prev === '' || REGEX_CAN_FOLLOW.includes(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== '\n') {
        const c = src[j];
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        j++;
      }
      i = j + 1;
      prev = '/';
    } else {
      if (!/\s/.test(ch)) prev = ch;
      i++;
    }
  }
  return out.join('');
}

// Destructuring and import lists alike: `a as b`/`a: b` keep `a`, a default (`a = 1`) is dropped, so is `...rest`.
function listNames(list: string, sep: RegExp): string[] {
  return list.split(',').map((p) => p.trim()).filter((p) => p && !/^type\s/.test(p) && !p.startsWith('...'))
    .map((p) => p.split(sep)[0].split('=')[0].trim()).filter(Boolean);
}

// Every way a test reaches a member of a namespace or bound module: `ns.x`, `ns['x']`, `spyOn(ns, 'x')`, `{ x } = ns`.
function memberUses(masked: string, binding: string): string[] {
  const b = binding.replace(/\$/g, '\\$');
  const uses = new Set<string>();
  const patterns = [
    String.raw`(?<![\w$./\\'"-])${b}\s*\.\s*(${IDENT})`,
    String.raw`(?<![\w$./\\'"-])${b}\s*\[\s*['"](${IDENT})['"]\s*\]`,
    String.raw`\bspyOn\(\s*${b}\s*,\s*['"](${IDENT})['"]`,
  ];
  for (const p of patterns) for (const m of masked.matchAll(new RegExp(p, 'g'))) uses.add(m[1]);
  for (const m of masked.matchAll(new RegExp(String.raw`\{([^}]*)\}\s*=\s*${b}\b(?!\s*[.[(])`, 'g'))) {
    for (const n of listNames(m[1], /\s*:\s*/)) uses.add(n);
  }
  return [...uses];
}

function bindingNames(clause: string, masked: string): string[] {
  const ns = new RegExp(String.raw`\*\s+as\s+(${IDENT})`).exec(clause);
  const names: string[] = ns ? memberUses(masked, ns[1]) : [];
  const braces = /\{([^}]*)\}/.exec(clause);
  const head = (braces ? clause.slice(0, braces.index) : clause).replace(/\*\s+as\s+\S+/, '');
  if (new RegExp(`^\\s*${IDENT}\\s*,?\\s*$`).test(head) && head.trim()) names.push('default');
  if (braces) names.push(...listNames(braces[1], /\s+as\s+/));
  return names;
}

export function parseModuleRefs(source: string): ModuleRef[] {
  const src = maskSource(source);
  const refs: ModuleRef[] = [];
  for (const m of src.matchAll(STATIC_IMPORT)) {
    if (m[1]) continue;
    const names = bindingNames(m[2], src);
    // `import { type A }` resolves nothing at runtime; vitest never loads the module for it.
    if (names.length === 0 && /\{/.test(m[2]) && !/\*\s+as/.test(m[2])) continue;
    refs.push({ specifier: m[3], names });
  }
  for (const m of src.matchAll(BARE_IMPORT)) refs.push({ specifier: m[1], names: [] });
  const typed = new Set<number>();
  const at = (m: RegExpMatchArray): number => (m.index ?? 0) + m[0].lastIndexOf('import(');
  for (const m of src.matchAll(DESTRUCTURED_IMPORT)) {
    refs.push({ specifier: m[2], names: listNames(m[1], /\s*:\s*/) });
    typed.add(at(m));
  }
  for (const m of src.matchAll(BOUND_IMPORT)) {
    refs.push({ specifier: m[2], names: memberUses(src, m[1]) });
    typed.add(at(m));
  }
  for (const m of src.matchAll(DYNAMIC_IMPORT)) if (!typed.has(at(m))) refs.push({ specifier: m[1], names: null });
  for (const m of src.matchAll(URL_REF)) refs.push({ specifier: m[1], names: null });
  return refs.filter((r) => r.specifier.startsWith('./') || r.specifier.startsWith('../'));
}

const FILE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.jsx', '.json']);

// TS source imports its siblings as `.js`; resolution order matches what tsx/vitest would try. A dot that
// is no module extension (`./x.helpers`) is part of the name. Outside the repo resolves to nothing.
export function candidatePaths(fromFile: string, specifier: string): string[] {
  const p = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier));
  if (p === '..' || p.startsWith('../')) return [];
  const ext = path.posix.extname(p);
  const stem = p.slice(0, p.length - ext.length);
  if (ext === '.js') return [`${stem}.ts`, `${stem}.tsx`, p];
  if (ext === '.mjs') return [p, `${stem}.mts`];
  if (ext === '.cjs') return [p, `${stem}.cts`];
  if (FILE_EXT.has(ext)) return [p];
  return [`${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.mjs`, `${p}/index.ts`, `${p}/index.tsx`, `${p}/index.js`, ...(ext ? [p] : [])];
}

// Unrecognized (a re-export, `export *`) reads false and so LISTS the name: over-telling costs a session
// little; hiding a missing name is the defect being fixed.
export function exportsName(source: string, name: string): boolean {
  const src = maskSource(source);
  if (name === 'default' && /^\s*export\s+default\b/m.test(src)) return true;
  const n = name.replace(/\$/g, '\\$');
  const decl = new RegExp(
    String.raw`^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:function\s*\*?\s*|const\s+|let\s+|var\s+|class\s+|enum\s+)${n}\b`, 'm',
  );
  if (decl.test(src)) return true;
  for (const m of src.matchAll(/^\s*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const segs = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/);
      if ((segs[1] ?? segs[0]).trim() === name) return true;
    }
  }
  return false;
}

async function firstPresent(rev: string, candidates: readonly string[], readAt: ReadAt): Promise<{ file: string; source: string } | null> {
  for (const file of candidates) {
    const source = await readAt(rev, file);
    if (source !== null) return { file, source };
  }
  return null;
}

export async function deriveInterface(
  c: { base: string; commit: string; testFiles: readonly string[] },
  readAt: ReadAt,
): Promise<InterfaceItem[]> {
  const byModule = new Map<string, InterfaceItem>();
  for (const testFile of c.testFiles) {
    const source = await readAt(c.commit, testFile);
    if (source === null) throw new Error(`coding-eval: hidden test ${testFile} is absent at ${c.commit} — cannot derive the interface`);
    for (const ref of parseModuleRefs(source)) {
      const candidates = candidatePaths(testFile, ref.specifier);
      if (c.testFiles.some((f) => candidates.includes(f))) continue;
      // Gold passes these tests, so a reference C cannot resolve either (text in a template) is no dependency.
      const atC = await firstPresent(c.commit, candidates, readAt);
      if (atC === null) continue;
      const atBase = await firstPresent(c.base, candidates, readAt);
      const missing = atBase === null ? (ref.names ?? []) : (ref.names ?? []).filter((n) => !exportsName(atBase.source, n));
      if (atBase !== null && missing.length === 0) continue;
      const item = byModule.get(atC.file) ?? { module: atC.file, isNew: atBase === null, names: [] };
      for (const n of missing) if (!item.names.includes(n)) item.names.push(n);
      byModule.set(atC.file, item);
    }
  }
  return [...byModule.values()]
    .map((i) => ({ ...i, names: [...i.names].sort() }))
    .sort((a, b) => a.module.localeCompare(b.module));
}

export function renderInterface(items: readonly InterfaceItem[]): string {
  if (items.length === 0) return '';
  const lines = items.map((i) => {
    const what = i.names.length ? `: ${i.names.map((n) => `\`${n}\``).join(', ')}` : '';
    return `- \`${i.module}\`${i.isNew ? ' (new file)' : ''}${what}`;
  });
  return [
    '## Interface',
    '',
    'This work is graded through the entry points below, none of which a check found at the start. Make sure',
    'each exists at exactly this path, under exactly this export name. What it does is for the ticket above to say.',
    '',
    ...lines,
  ].join('\n');
}

export function taskStatement(frozenBody: string, items: readonly InterfaceItem[]): string {
  const section = renderInterface(items);
  return section ? `${frozenBody.replace(/\s*$/, '')}\n\n${section}\n` : frozenBody;
}
