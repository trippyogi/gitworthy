/** Shared issue↔PR linkage helpers (pure, testable). */

export function closesIssue(text: string, issueNumber: number): boolean {
  return new RegExp(
    `(?:fix(?:es)?|close[sd]?|resolve[sd]?)\\s+(?:#|https?:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/issues\\/)${issueNumber}\\b`,
    'i'
  ).test(text);
}

/** True when title/body explicitly references the issue number (including title-only `(#N)`). */
export function mentionsIssue(text: string, issueNumber: number): boolean {
  if (closesIssue(text, issueNumber)) return true;
  if (new RegExp(`(?:^|[\\s(,\\[])(?:#|issues\\/)${issueNumber}\\b`).test(text)) return true;
  // Title conventions: "Fix foo (#123)" or "Fix foo #123"
  return new RegExp(`(?:\\(#${issueNumber}\\)|(?:^|[\\s\\-_/])#${issueNumber}(?:\\)|$|[\\s,.]))`).test(text);
}
