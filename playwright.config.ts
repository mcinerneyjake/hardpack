import { defineConfig, devices } from 'playwright/test';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { holdTestRun } from 'ticket-workflow/test-run';
import { webBaseUrl } from './shared/ports.js';

// Workers and --ui/watch loader processes re-evaluate this file and inherit env; holdTestRun skips
// only vitest's workers, so a descendant of the holder must not claim a second slot (tkt-7bb0ed6b14e3).
const holder = process.env.HARDPACK_E2E_SLOT_HOLDER;
if (holder === undefined || holder === String(process.pid)) {
  await holdTestRun({ repo: 'hardpack-e2e' });
  process.env.HARDPACK_E2E_SLOT_HOLDER = String(process.pid);
}

// The specs create and delete tickets through the UI. Point the dev server at
// throwaway temp dirs so a run never mutates the real tickets/ or events/ dirs
// (by-title cleanup used to leak strays into the real board if the runner died).
// The dirs must exist before webServer starts (its env references them below),
// so they're made here at config load; globalTeardown removes them after the run
// via the paths stashed on process.env.
const e2eTicketsDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-tickets-'));
const e2eEventsDir = mkdtempSync(path.join(os.tmpdir(), 'kanban-e2e-events-'));
process.env.E2E_TMP_TICKETS_DIR = e2eTicketsDir;
process.env.E2E_TMP_EVENTS_DIR = e2eEventsDir;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  globalTeardown: './e2e/globalTeardown.ts',
  use: { baseURL: webBaseUrl(), trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run dev',
    url: webBaseUrl(),
    // Never attach to a manually-started dev server — it would be serving the
    // real board, defeating the temp-dir isolation below.
    reuseExistingServer: false,
    timeout: 15_000,
    env: {
      ...process.env,
      // Point the drafting model at a dead port so the intake health check reports
      // "down" — the create modal then falls to the manual form deterministically,
      // independent of whether a local LLM (LM Studio etc.) happens to be running.
      // (This is the CI reality too: no model available.)
      LLM_BASE_URL: 'http://127.0.0.1:9',
      EMBED_BASE_URL: 'http://127.0.0.1:9',
      TICKETS_DIR_OVERRIDE: e2eTicketsDir,
      EVENTS_DIR_OVERRIDE: e2eEventsDir,
    },
  },
});
