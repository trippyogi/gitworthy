const AUTOMATION_LOGINS = new Set([
  'dependabot',
  'dependabot[bot]',
  'renovate',
  'renovate[bot]',
  'github-actions',
  'github-actions[bot]',
  'greenkeeper',
  'greenkeeper[bot]',
  'imgbot',
  'imgbot[bot]',
  'snyk-bot',
  'snyk[bot]',
  'codecov',
  'codecov[bot]',
  'copilot',
  'copilot[bot]',
  'vercel',
  'vercel[bot]',
  'netlify',
  'netlify[bot]',
  'changeset-bot',
  'changeset-bot[bot]',
  'release-please',
  'release-please[bot]',
  'semantic-release-bot',
  'github-advanced-security',
  'github-advanced-security[bot]'
]);

/** True when a GitHub login is an automation / bot account that should not block contributions. */
export function isAutomationAuthor(login: string | null | undefined): boolean {
  if (!login) return false;
  const lower = login.toLowerCase();
  if (AUTOMATION_LOGINS.has(lower)) return true;
  if (lower.endsWith('[bot]')) return true;
  if (lower.endsWith('-bot')) return true;
  if (lower.includes('dependabot') || lower.includes('renovate')) return true;
  return false;
}
