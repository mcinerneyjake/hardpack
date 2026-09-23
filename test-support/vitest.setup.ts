import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Pins the persistent embedding cache to a throwaway dir. tkt-9f09b3a1e95c made that cache
// default-ON (it was opt-in via EMBED_CACHE_PATH), so any suite building an index would
// otherwise resolve defaultCachePath() to the REAL board cache and prune() it down to its own
// stub corpus — silently destroying a developer's warm cache and forcing a full cold re-embed.
//
// Keyed by pid, NOT mkdtemp: vitest evaluates setupFiles once per TEST FILE, so mkdtemp would
// mint a fresh directory for every one of the ~87 suites and leak them all (nothing here can
// register a cleanup hook that outlives the file). It lands in holdTestRun's per-run TMPDIR and dies
// with the run (tkt-f93e25bdfbcd); in CI, where no hold is taken, one dir per worker per run leaks.
const dir = path.join(os.tmpdir(), `kanban-embed-cache-${process.pid}`);
fs.mkdirSync(dir, { recursive: true });
process.env.EMBED_CACHE_PATH = path.join(dir, 'embeddings.json');
