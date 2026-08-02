/**
 * Compatibility entry for `pnpm eval` (GW-021).
 * Forwards to the live suite. Prefer `pnpm eval:frozen` / `pnpm eval:live`.
 */

if (!process.argv.includes('--suite') && !process.argv.some((arg) => arg.startsWith('--suite='))) {
  process.argv.push('--suite=live');
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`gitworthy eval compatibility entry (GW-021)

Prefer:
  pnpm eval:frozen   # offline adjudicated corpus (release-blocking)
  pnpm eval:live     # public-state drift (advisory)
  pnpm eval:private  # local captures (gitignored; requires --allow-private)

This command runs the live suite (same as pnpm eval:live).
Legacy --update-fixtures is accepted as an alias for --update-snapshots.
`);
  process.exit(0);
}

console.log('note: `pnpm eval` forwards to the live suite (GW-021). Use `pnpm eval:frozen` for release-blocking offline cases.');

await import('./run-suite.js');
