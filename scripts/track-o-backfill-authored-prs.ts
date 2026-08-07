/**
 * Track O Phase 2: thin CLI wrapper around runTrackOBackfill.
 *
 * Prefer: gitworthy outcome backfill [--author=@me] [--write]
 *
 * Legacy:
 *   pnpm exec tsx scripts/track-o-backfill-authored-prs.ts [--author=@me]
 *   pnpm exec tsx scripts/track-o-backfill-authored-prs.ts [--author=@me] --write
 */
import { runTrackOBackfill } from '../src/lib/track-o-backfill.js';

function argValue(name: string): string | undefined {
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith('-')) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  await runTrackOBackfill({
    author: argValue('--author'),
    write: process.argv.includes('--write')
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
