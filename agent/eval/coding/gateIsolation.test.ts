import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

// eval:coding spends cloud money per session, so nothing the gate runs may reach it: not an npm
// script the gate calls, not the pre-commit hook, not a CI workflow, and not a test importing the
// modules that spawn `claude` (tkt-7beeca1d62ab).

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = /eval:coding|eval\/coding\/cli/;
const SPAWNING_IMPORT = /from\s+['"][^'"]*(?:coding\/|\.\/)(?:realDeps|cli)(?:\.js)?['"]/;
const SKIP_DIRS = new Set(['node_modules', '.git', 'worktrees', '.tmp-test', 'coverage', 'dist']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), out);
    } else if (/\.test\.(?:ts|tsx|mjs|js)$/.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

function scripts(): Record<string, string> {
  const pkg: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (typeof pkg !== 'object' || pkg === null || !('scripts' in pkg) || typeof pkg.scripts !== 'object' || pkg.scripts === null) {
    throw new Error('package.json has no scripts object');
  }
  return Object.fromEntries(Object.entries(pkg.scripts).map(([k, v]) => [k, String(v)]));
}

describe('eval:coding is unreachable from the gate', () => {
  it('positive control: the entry pattern finds the eval:coding script itself', () => {
    expect(scripts()['eval:coding']).toMatch(ENTRY);
  });

  it('no other npm script invokes it', () => {
    const callers = Object.entries(scripts()).filter(([k, v]) => k !== 'eval:coding' && ENTRY.test(v)).map(([k]) => k);
    expect(callers).toEqual([]);
  });

  it('neither the pre-commit hook nor any CI workflow invokes it', () => {
    const files = [
      ...fs.readdirSync(path.join(ROOT, '.husky')).map((f) => path.join(ROOT, '.husky', f)),
      ...fs.readdirSync(path.join(ROOT, '.github', 'workflows')).map((f) => path.join(ROOT, '.github', 'workflows', f)),
    ].filter((f) => fs.statSync(f).isFile());
    expect(files.length).toBeGreaterThan(1);
    expect(files.filter((f) => ENTRY.test(fs.readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('no test file imports the modules that spawn claude', () => {
    // Split so this file's own source does not match the scan below.
    expect(SPAWNING_IMPORT.test("import { realDeps } from './" + "realDeps.js';")).toBe(true);
    expect(SPAWNING_IMPORT.test("import x from '../agent/eval/coding/" + "cli';")).toBe(true);
    const tests = walk(ROOT);
    // The walk must see this very file, or an empty result would pass for the wrong reason.
    expect(tests).toContain(fileURLToPath(import.meta.url));
    const importers = tests.filter((f) => SPAWNING_IMPORT.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    expect(importers).toEqual([]);
  });
});
