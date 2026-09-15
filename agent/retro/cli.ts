import { RuntimeChatClient, resolveLlmConfig } from '../runtime/llm.js';
import { ProposalsExistError, retrosDir } from './proposals.js';
import { exitCodeFor, runRetro } from './retro.js';

// Offline session retrospective (tkt-4cda7a4ab619). Writes candidate lessons to retros/, never to memory.
//   npm run retro -- ~/.claude/projects/<project>/<session>.jsonl
//   npm run retro -- --force <transcript.jsonl>   replace an existing proposals file
// Exit: 0 every chunk reviewed · 2 file written but some chunks NOT reviewed · 1 nothing written.

try { process.loadEnvFile('.env'); } catch { /* no .env — use process env + defaults */ }

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const paths = argv.filter((a) => a !== '--force');
  if (paths.length !== 1 || paths[0].startsWith('-')) {
    console.error('Usage: npm run retro -- [--force] <transcript.jsonl>');
    return 1;
  }

  const chat = RuntimeChatClient.fromEnv();
  const outcome = await runRetro(paths[0], {
    chat,
    model: resolveLlmConfig().model,
    preflight: () => chat.preflight(),
    usage: () => chat.getUsage(),
    outDir: retrosDir(),
    force,
  });
  if (!outcome.ok) {
    console.error(outcome.error);
  } else {
    console.log(`Wrote ${outcome.file}`);
    console.log(`${outcome.lessons} lesson(s) proposed · ${outcome.dropped} dropped (no valid citation) · ${outcome.failedChunks}/${outcome.chunks} chunk(s) failed`);
    if (outcome.failedChunks > 0) console.warn('! Some chunks were NOT reviewed — the file lists which turns.');
  }
  return exitCodeFor(outcome);
}

main().then((code) => { process.exitCode = code; }).catch((err: unknown) => {
  console.error(err instanceof ProposalsExistError ? err.message : `Retro failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
