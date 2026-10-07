import { describe, it, expect } from 'vitest';
import {
  candidatePaths, deriveInterface, maskSource, exportsName, parseModuleRefs, renderInterface, taskStatement,
  type ReadAt,
} from './interface.js';

const BASE = 'b'.repeat(40);
const C = 'c'.repeat(40);

function tree(base: Record<string, string>, atC: Record<string, string>): ReadAt {
  return (rev, file) => {
    const t = rev === BASE ? base : rev === C ? { ...base, ...atC } : null;
    if (!t) return Promise.reject(new Error(`unknown rev ${rev}`));
    return Promise.resolve(file in t ? t[file] : null);
  };
}

const derive = (testFiles: string[], base: Record<string, string>, atC: Record<string, string>) =>
  deriveInterface({ base: BASE, commit: C, testFiles }, tree(base, atC));

describe('maskSource', () => {
  it('blanks comments and template bodies, keeps strings and regex literals, and preserves every offset', () => {
    const src = "a(); // it's\n/* b */ const s = '//x/*y'; const r = /'/; const t = `import x`;";
    const out = maskSource(src);
    expect(out).toHaveLength(src.length);
    expect(out).toBe(`a();${' '.repeat(" // it's".length)}\n${' '.repeat('/* b */'.length)} const s = '//x/*y'; const r = /'/; const t = \`        \`;`);
  });

  it('runs in linear time on the input a comment-alternation regex hung on', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `  see http://x/${i} // and //more`);
    const src = ['const s = `', 'import the following:', ...lines, "it's", '`;', "import { a } from './m.js';"].join('\n');
    const t0 = performance.now();
    expect(parseModuleRefs(src)).toEqual([{ specifier: './m.js', names: ['a'] }]);
    expect(performance.now() - t0).toBeLessThan(500);
  });
});

describe('parseModuleRefs', () => {
  it('reads value names from single- and multi-line braces, defaults and aliases', () => {
    const refs = parseModuleRefs([
      "import { a, b as c } from './x.js';",
      'import {',
      '  d,',
      '  type T,',
      "} from './y.mjs';",
      "import def, { e } from '../z.js';",
    ].join('\n'));
    expect(refs).toEqual([
      { specifier: './x.js', names: ['a', 'b'] },
      { specifier: './y.mjs', names: ['d'] },
      { specifier: '../z.js', names: ['default', 'e'] },
    ]);
  });

  it('reads through comments in braces, including one holding a quote', () => {
    expect(parseModuleRefs([
      'import {',
      '  a, // it\'s the first',
      '  /* b2, */ b,',
      "} from './x.js';",
    ].join('\n'))).toEqual([{ specifier: './x.js', names: ['a', 'b'] }]);
  });

  it('reads the members a namespace or a bound dynamic import is used for, never its own specifier', () => {
    expect(parseModuleRefs([
      "import * as tickets from './tickets.js';",
      'tickets.listTickets(); tickets.listTickets(); other.tickets.x();',
      "const m = await import('./lazy.js');",
      'm.run();',
      "const { a, b: renamed } = await import('./dest.js');",
    ].join('\n'))).toEqual([
      { specifier: './tickets.js', names: ['listTickets'] },
      { specifier: './dest.js', names: ['a', 'b'] },
      { specifier: './lazy.js', names: ['run'] },
    ]);
  });

  it('reads spyOn, bracket access, destructuring from a namespace, and an import() assigned later', () => {
    expect(parseModuleRefs([
      "import * as mod from './m.js';",
      "vi.spyOn(mod, 'newFn'); mod['other']; const { third, fourth: f = 2 } = mod;",
      'let lazy;',
      "beforeAll(async () => { lazy = await import('./lazy.js'); });",
      'lazy.go();',
      "const { a = 1, ...rest } = await import('./dest.js');",
    ].join('\n'))).toEqual([
      { specifier: './m.js', names: ['other', 'newFn', 'third', 'fourth'] },
      { specifier: './dest.js', names: ['a'] },
      { specifier: './lazy.js', names: ['go'] },
    ]);
  });

  it('ignores an import inside a block comment or a template, and braces holding only types and a comment', () => {
    expect(parseModuleRefs([
      '/*',
      "import { old } from './old.js';",
      '*/',
      "const t = `\nimport { q } from './q.js';\n`;",
      "import { /* only types */ type T } from './types.js';",
      '// m.removed() was here',
    ].join('\n'))).toEqual([]);
  });

  it('ignores bare packages, `import type`, and braces holding only types', () => {
    expect(parseModuleRefs([
      "import { describe } from 'vitest';",
      "import fs from 'node:fs';",
      "import type { Ticket } from '../shared/constants.js';",
      "import { type IntakePartial } from './loop.js';",
    ].join('\n'))).toEqual([]);
  });

  it('reads a namespace import, a side-effect import, a literal dynamic import and a script run by URL', () => {
    expect(parseModuleRefs([
      "import * as econ from './econ.js';",
      "import './setup.js';",
      "load(await import('./lazy.js'));",
      "const CLI = fileURLToPath(new URL('./probe.mjs', import.meta.url));",
      'const skipped = await import(name);',
    ].join('\n'))).toEqual([
      { specifier: './econ.js', names: [] },
      { specifier: './setup.js', names: [] },
      { specifier: './lazy.js', names: null },
      { specifier: './probe.mjs', names: null },
    ]);
  });
});

describe('candidatePaths', () => {
  it.each([
    ['agent/x.test.ts', './a.js', ['agent/a.ts', 'agent/a.tsx', 'agent/a.js']],
    ['scripts/p/x.test.mjs', './a.mjs', ['scripts/p/a.mjs', 'scripts/p/a.mts']],
    ['agent/x/a.test.ts', './fixtures.helpers', ['agent/x/fixtures.helpers.ts', 'agent/x/fixtures.helpers.tsx', 'agent/x/fixtures.helpers.js', 'agent/x/fixtures.helpers.mjs', 'agent/x/fixtures.helpers/index.ts', 'agent/x/fixtures.helpers/index.tsx', 'agent/x/fixtures.helpers/index.js', 'agent/x/fixtures.helpers']],
    ['root.test.ts', '../outside.js', []],
    ['src/lib/x.test.ts', '../api', ['src/api.ts', 'src/api.tsx', 'src/api.js', 'src/api.mjs', 'src/api/index.ts', 'src/api/index.tsx', 'src/api/index.js']],
  ])('%s importing %s', (from, spec, expected) => {
    expect(candidatePaths(from, spec)).toEqual(expected);
  });
});

describe('exportsName', () => {
  it.each([
    ['export function f() {}', 'f'],
    ['export async function f() {}', 'f'],
    ['export const f = 1;', 'f'],
    ['export class F {}', 'F'],
    ['export abstract class F {}', 'F'],
    ['export enum F {}', 'F'],
    ["const g = '**/*.ts';\nexport function f() {}\n/* x */", 'f'],
    ['export function *gen() {}', 'gen'],
    ['export function* gen() {}', 'gen'],
    ['export {\n  a, // keep\n  f,\n};', 'f'],
    ['const x = 1;\nexport { x as default };', 'default'],
    ['const g = 1;\nexport { g as f };', 'f'],
    ['export { f, h };', 'f'],
    ['export default function () {}', 'default'],
  ])('finds %j → %s', (src, name) => {
    expect(exportsName(src, name)).toBe(true);
  });

  it.each([
    ['export function fx() {}', 'f'],
    ['function f() {}', 'f'],
    ['export { f as g };', 'f'],
    ['export interface F {}', 'F'],
    ["export * from './other.js';", 'f'],
    ['// export function f() {}', 'f'],
    ['/*\nexport function f() {}\n*/', 'f'],
    ['// use this as default fallback\nexport const y = 1;', 'default'],
  ])('does not credit %j with %s, so the name stays listed', (src, name) => {
    expect(exportsName(src, name)).toBe(false);
  });
});

describe('deriveInterface', () => {
  it('lists a module new at C with every value name the hidden test imports, at the path C used', async () => {
    const items = await derive(['agent/u.test.ts'], {}, {
      'agent/u.test.ts': "import { isDown, DownError } from './unavailable.js';",
      'agent/unavailable.ts': 'export class DownError {}\nexport function isDown() {}',
    });
    expect(items).toEqual([{ module: 'agent/unavailable.ts', isNew: true, names: ['DownError', 'isDown'] }]);
  });

  it('lists only the exports an existing module lacks at base', async () => {
    const items = await derive(['src/api.test.ts'], { 'src/api.ts': 'export function api() {}' }, {
      'src/api.test.ts': "import { api, ApiError } from './api.js';",
    });
    expect(items).toEqual([{ module: 'src/api.ts', isNew: false, names: ['ApiError'] }]);
  });

  it('omits a module whose every imported name exists at base, and a namespace import of an existing one', async () => {
    const items = await derive(['server/i.test.ts'], { 'server/index.ts': 'export const app = 1;', 'server/tickets.ts': '' }, {
      'server/i.test.ts': "import { app } from './index.js';\nimport * as tickets from './tickets.js';",
    });
    expect(items).toEqual([]);
  });

  it('resolves an extensionless specifier to index.ts, and a new script referenced by URL with no names', async () => {
    const items = await derive(['scripts/probe/n.test.mjs'], {}, {
      'scripts/probe/n.test.mjs': "import { scan } from './lib';\nconst CLI = new URL('./nul-bytes.mjs', import.meta.url);",
      'scripts/probe/lib/index.ts': 'export function scan() {}',
      'scripts/probe/nul-bytes.mjs': '',
    });
    expect(items).toEqual([
      { module: 'scripts/probe/lib/index.ts', isNew: true, names: ['scan'] },
      { module: 'scripts/probe/nul-bytes.mjs', isNew: true, names: [] },
    ]);
  });

  it('skips a reference C cannot resolve either, rather than inventing a file gold never had', async () => {
    const items = await derive(['a/x.test.ts'], {}, {
      'a/x.test.ts': "const src = `\nimport { q } from './fixture.js';\n`;",
    });
    expect(items).toEqual([]);
  });

  it('merges names across hidden files, skips a reference to another hidden file, and sorts', async () => {
    const items = await derive(['a/x.test.ts', 'a/y.test.ts'], { 'a/m.ts': '' }, {
      'a/x.test.ts': "import { zeta, alpha } from './m.js';\nimport { helper } from './y.test.js';",
      'a/y.test.ts': "import { alpha, mid } from './m.js';",
    });
    expect(items).toEqual([{ module: 'a/m.ts', isNew: false, names: ['alpha', 'mid', 'zeta'] }]);
  });

  it('throws, never derives an empty interface, when a hidden test is absent at C or a read fails', async () => {
    await expect(derive(['a/gone.test.ts'], {}, {})).rejects.toThrow(/absent at/);
    const failing: ReadAt = (rev) => (rev === C ? Promise.resolve("import { a } from './m.js';") : Promise.reject(new Error('git died')));
    await expect(deriveInterface({ base: BASE, commit: C, testFiles: ['a/x.test.ts'] }, failing)).rejects.toThrow(/git died/);
  });
});

describe('the rendered statement', () => {
  it('renders exactly this text', () => {
    expect(taskStatement('---\nid: x\n---\nBody.\n\n', [
      { module: 'a/m.ts', isNew: false, names: ['f'] },
      { module: 'a/n.mjs', isNew: true, names: [] },
    ])).toBe([
      '---', 'id: x', '---', 'Body.', '',
      '## Interface',
      '',
      'This work is graded through the entry points below, none of which a check found at the start. Make sure',
      'each exists at exactly this path, under exactly this export name. What it does is for the ticket above to say.',
      '',
      '- `a/m.ts`: `f`',
      '- `a/n.mjs` (new file)',
      '',
    ].join('\n'));
  });

  it('leaves the body untouched when nothing is missing', () => {
    expect(renderInterface([])).toBe('');
    expect(taskStatement('Body.\n', [])).toBe('Body.\n');
  });
});
