import fs from 'node:fs/promises';
import { releaseTestRun } from 'ticket-workflow/test-run';

// Removes the throwaway tickets/events temp dirs created in playwright.config.ts
// (paths stashed on process.env at config load, which runs in this same main
// process). Without this, every `playwright test` run leaks two dirs under
// os.tmpdir() until the OS tmp reaper eventually clears them.
export default async function globalTeardown(): Promise<void> {
  for (const dir of [process.env.E2E_TMP_TICKETS_DIR, process.env.E2E_TMP_EVENTS_DIR]) {
    if (dir) await fs.rm(dir, { recursive: true, force: true });
  }
  await releaseTestRun();
}
