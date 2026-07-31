import { githubJson, fetchRaw, GithubIssue } from '../lib/github.js';
import { DEFAULT_MAX_TREE_FILES, listCloneFiles, listTreeFiles, localCheckoutMatchesRepo, readClonedFilesBatch, readTreeFilesBatch, shallowClone, type ClonedFile } from '../lib/git.js';
import { loadCanonicalRepo } from '../lib/repo.js';
import { assessRepro, looksLikeBug } from './candidate-quality.js';
import { createEnvelope, Envelope, GitworthyError } from './envelope.js';
import { distinctiveTerms, isGenericTerm } from './terms.js';

const INTENT_LIMIT = "directory or string existence does not prove the issue's intent is satisfied; read both before making any public claim.";
const FUZZY_SKIP = 'issue_vs_main tree/grep skipped: no concrete path terms (src/…, extensions/…, or ≥2 path-like tokens); assessed repro signals only.';
/** Budgets bound how much of a hostile tree we ever grep in one scan. */
const MAX_GREP_FILES = 2000;
const MAX_GREP_TOTAL_BYTES = 20_000_000;
const CONTENTS_PATH_CAP = 20;
type Input = { repo: string; issue_number: number };

function explicitPathTerms(issue: GithubIssue): string[] {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  return Array.from(text.matchAll(/[\w.-]+\/[\w./-]+/g)).map((match) => match[0]);
}

function pathLiteralTokens(issue: GithubIssue): Set<string> {
  return new Set(explicitPathTerms(issue).flatMap((term) => term.toLowerCase().split(/[^a-z0-9_-]+/)).filter(Boolean));
}

function contentTerms(issue: GithubIssue): string[] {
  const literalTokens = pathLiteralTokens(issue);
  const text = `${issue.title}\n${issue.body ?? ''}`;
  return distinctiveTerms(text, 20).filter((term) => !literalTokens.has(term));
}

function pathTerms(issue: GithubIssue): string[] {
  const explicit = explicitPathTerms(issue);
  return [...explicit, ...inferredExampleTerms(issue)];
}

function inferredExampleTerms(issue: GithubIssue): string[] {
  const titleWords = distinctiveTerms(issue.title, 10);
  return issue.title.toLowerCase().includes('example') ? titleWords.filter((word) => !isGenericTerm(word) && word !== 'python').map((word) => `example-apps/${word}`) : [];
}

function terms(issue: GithubIssue): string[] {
  return Array.from(new Set([...explicitPathTerms(issue), ...contentTerms(issue)]));
}

/** True when the issue names concrete code paths worth cloning/walking. */
export function hasConcretePathTerms(issue: Pick<GithubIssue, 'title' | 'body'>): boolean {
  const text = `${issue.title}\n${issue.body ?? ''}`;
  if (/\b(?:src|extensions?|packages?|lib|apps?|server|client|plugins?|internal|crates?)\/[\w./-]+/i.test(text)) return true;
  const paths = explicitPathTerms(issue as GithubIssue).filter((item) => !/^https?:\/\//i.test(item) && item.includes('/'));
  if (paths.some((item) => item.split('/').filter(Boolean).length >= 2)) return true;
  if (paths.length >= 2) return true;
  return false;
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

function pathMatchesIntent(filePath: string, intentPath: string): boolean {
  const normalizedFile = normalizePath(filePath).toLowerCase();
  const normalizedIntent = normalizePath(intentPath).toLowerCase();
  return normalizedFile === normalizedIntent || normalizedFile.startsWith(`${normalizedIntent}/`);
}

function issueMetaEvidence(issue: GithubIssue, repro: ReturnType<typeof assessRepro>, bugMissingRepro: boolean) {
  return {
    issue: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => label.name),
    comments: issue.comments,
    url: issue.html_url,
    repro,
    needs_repro: bugMissingRepro
  };
}

function sanitizeRepoPath(term: string): string | null {
  if (!term || /^https?:\/\//i.test(term)) return null;
  const normalized = normalizePath(term).replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return null;
  return normalized;
}

type ScanBundle = {
  treeMatches: string[];
  grepMatches: Array<Record<string, unknown>>;
  shippedSignal: boolean;
  mode: 'full' | 'local_checkout' | 'contents_fallback';
  cloneCached: boolean | null;
  fileListCached: boolean | null;
  checked: string[];
  notCheckedExtra: string[];
};

function scoreTreeAndGrep(input: {
  files: ClonedFile[];
  candidates: string[];
  grepCandidates: string[];
  exactPathTerms: string[];
  inferredIntentTerms: string[];
  contentsByPath: Map<string, string | null | undefined>;
}): { treeMatches: string[]; grepMatches: Array<Record<string, unknown>>; shippedSignal: boolean } {
  const allTreeMatches = input.files
    .map((file) => file.path)
    .filter((relative) => input.candidates.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
  const treeMatches = allTreeMatches
    .sort((left, right) =>
      Number(input.exactPathTerms.some((term) => right.toLowerCase().includes(term.toLowerCase())))
      - Number(input.exactPathTerms.some((term) => left.toLowerCase().includes(term.toLowerCase())))
    )
    .slice(0, 50);
  const grepMatches = [] as Array<Record<string, unknown>>;
  const grepFileSlice = input.files.slice(0, MAX_GREP_FILES);
  for (const file of grepFileSlice) {
    const text = input.contentsByPath.get(file.path);
    if (text == null) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const term = input.grepCandidates.find((candidate) => lines[index].toLowerCase().includes(candidate.toLowerCase()));
      if (term) grepMatches.push({ path: file.path, line: index + 1, term, sample: lines[index].slice(0, 200) });
      if (grepMatches.length >= 10) break;
    }
    if (grepMatches.length >= 10) break;
  }
  const pathIntentMatched = input.exactPathTerms.length > 0
    && treeMatches.some((relative) => input.exactPathTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
  const inferredIntentMatched = input.inferredIntentTerms.length > 0
    && treeMatches.some((relative) => input.inferredIntentTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
  const contentIntentMatched = grepMatches.some((match) => {
    const matchPath = match.path;
    return typeof matchPath === 'string' && input.exactPathTerms.some((term) => pathMatchesIntent(matchPath, term));
  });
  return {
    treeMatches,
    grepMatches,
    shippedSignal: inferredIntentMatched || (pathIntentMatched && contentIntentMatched)
  };
}

async function scanPooledClone(input: {
  repo: string;
  candidates: string[];
  grepCandidates: string[];
  exactPathTerms: string[];
  inferredIntentTerms: string[];
}): Promise<ScanBundle> {
  const clone = await shallowClone(input.repo);
  try {
    const listed = await listCloneFiles(input.repo);
    const contentsByPath = await readClonedFilesBatch(
      input.repo,
      listed.files.slice(0, MAX_GREP_FILES).map((file) => file.path),
      { maxTotalBytes: MAX_GREP_TOTAL_BYTES }
    );
    const scored = scoreTreeAndGrep({
      files: listed.files,
      candidates: input.candidates,
      grepCandidates: input.grepCandidates,
      exactPathTerms: input.exactPathTerms,
      inferredIntentTerms: input.inferredIntentTerms,
      contentsByPath
    });
    const notCheckedExtra: string[] = [];
    if (listed.truncated) {
      notCheckedExtra.push(
        `git tree listing was soft-capped at ${DEFAULT_MAX_TREE_FILES} files; matching paths beyond the cap may be missing.`
      );
    }
    return {
      ...scored,
      mode: 'full',
      cloneCached: clone.cached,
      fileListCached: listed.cached,
      checked: [
        clone.cached ? `reused pooled bare clone of ${input.repo}` : `bare cloned ${input.repo}`,
        listed.cached ? `reused cached tree listing for ${input.repo}` : `listed git tree for ${input.repo}`,
        'searched candidate terms in tree and file contents'
      ],
      notCheckedExtra
    };
  } finally {
    await clone.cleanup();
  }
}

async function scanLocalCheckout(input: {
  repo: string;
  candidates: string[];
  grepCandidates: string[];
  exactPathTerms: string[];
  inferredIntentTerms: string[];
}): Promise<ScanBundle | null> {
  const local = process.env.GITWORTHY_LOCAL_REPO?.trim();
  if (!local) return null;
  try {
    if (!(await localCheckoutMatchesRepo(local, input.repo))) return null;
    const listed = await listTreeFiles(local);
    const slice = listed.files.slice(0, MAX_GREP_FILES);
    const contentsByPath = await readTreeFilesBatch(local, slice, { maxTotalBytes: MAX_GREP_TOTAL_BYTES });
    // Ensure missing paths stay absent rather than undefined for scoreTreeAndGrep
    for (const file of slice) {
      if (!contentsByPath.has(file.path)) contentsByPath.set(file.path, null);
    }
    const scored = scoreTreeAndGrep({
      files: listed.files,
      candidates: input.candidates,
      grepCandidates: input.grepCandidates,
      exactPathTerms: input.exactPathTerms,
      inferredIntentTerms: input.inferredIntentTerms,
      contentsByPath
    });
    const notCheckedExtra: string[] = [
      `used local checkout at ${local} via GITWORTHY_LOCAL_REPO; remote clone was unavailable.`,
      'local checkout HEAD may differ from the remote default branch; treat shipped signals as VERIFY evidence only.'
    ];
    if (listed.truncated) {
      notCheckedExtra.push(
        `git tree listing was soft-capped at ${DEFAULT_MAX_TREE_FILES} files; matching paths beyond the cap may be missing.`
      );
    }
    return {
      ...scored,
      mode: 'local_checkout',
      cloneCached: null,
      fileListCached: false,
      checked: [
        `verified local checkout origin matches ${input.repo}`,
        `listed local checkout tree for ${input.repo} at ${local}`,
        'searched candidate terms in tree and file contents'
      ],
      notCheckedExtra
    };
  } catch {
    return null;
  }
}

async function scanContentsFallback(input: {
  repo: string;
  grepCandidates: string[];
  exactPathTerms: string[];
  inferredIntentTerms: string[];
  cloneError: unknown;
}): Promise<ScanBundle> {
  const resolved = await loadCanonicalRepo(input.repo);
  const branch = resolved.default_branch;
  const treeMatches: string[] = [];
  const grepMatches: Array<Record<string, unknown>> = [];
  const probed: string[] = [];

  for (const rawTerm of [...input.exactPathTerms, ...input.inferredIntentTerms].slice(0, CONTENTS_PATH_CAP)) {
    const term = sanitizeRepoPath(rawTerm);
    if (!term || probed.includes(term)) continue;
    probed.push(term);
    let text: string | null = null;
    try {
      text = await fetchRaw(input.repo, branch, term);
    } catch {
      // Non-404 raw failures (rate limit, auth, 5xx) must not abort the whole fallback.
      text = null;
    }
    if (text != null) {
      treeMatches.push(term);
      const lines = text.split('\n');
      for (let index = 0; index < lines.length && grepMatches.length < 10; index += 1) {
        const hit = input.grepCandidates.find((candidate) => lines[index].toLowerCase().includes(candidate.toLowerCase()));
        if (hit) grepMatches.push({ path: term, line: index + 1, term: hit, sample: lines[index].slice(0, 200) });
      }
      continue;
    }
    try {
      const entries = await githubJson<unknown>(`/repos/${input.repo}/contents/${encodeURI(term)}?ref=${encodeURIComponent(branch)}`);
      if (Array.isArray(entries) && entries.length > 0) {
        treeMatches.push(term);
        for (const entry of entries.slice(0, 20)) {
          if (entry && typeof entry === 'object' && 'path' in entry && typeof (entry as { path: unknown }).path === 'string') {
            const child = (entry as { path: string }).path;
            if (!treeMatches.includes(child)) treeMatches.push(child);
          }
        }
      } else if (entryLooksLikeFile(entries)) {
        treeMatches.push(term);
      }
    } catch {
      // path absent or inaccessible — continue probing other terms
    }
  }

  const pathIntentMatched = input.exactPathTerms.length > 0
    && treeMatches.some((relative) => input.exactPathTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
  const inferredIntentMatched = input.inferredIntentTerms.length > 0
    && treeMatches.some((relative) => input.inferredIntentTerms.some((term) => relative.toLowerCase().includes(term.toLowerCase())));
  const contentIntentMatched = grepMatches.some((match) => {
    const matchPath = match.path;
    return typeof matchPath === 'string' && input.exactPathTerms.some((term) => pathMatchesIntent(matchPath, term));
  });

  const cloneMessage = input.cloneError instanceof GitworthyError
    ? input.cloneError.message
    : input.cloneError instanceof Error
      ? input.cloneError.message
      : 'git clone failed';

  return {
    treeMatches: treeMatches.slice(0, 50),
    grepMatches,
    shippedSignal: inferredIntentMatched || (pathIntentMatched && contentIntentMatched),
    mode: 'contents_fallback',
    cloneCached: null,
    fileListCached: null,
    checked: [
      `clone unavailable (${cloneMessage}); probed ${probed.length} path term${probed.length === 1 ? '' : 's'} via GitHub contents/raw on ${branch}`
    ],
    notCheckedExtra: [
      'full repository tree was not cloned; contents/raw fallback only probes named path terms and cannot prove absence.',
      INTENT_LIMIT
    ]
  };
}

function entryLooksLikeFile(entries: unknown): boolean {
  return Boolean(
    entries
    && typeof entries === 'object'
    && !Array.isArray(entries)
    && 'type' in entries
    && (entries as { type: unknown }).type === 'file'
  );
}

function envelopeFromScan(input: {
  issue: GithubIssue;
  repro: ReturnType<typeof assessRepro>;
  bugMissingRepro: boolean;
  needsReproSignals: Array<'needs_repro'>;
  scan: ScanBundle;
  repo: string;
  issueNumber: number;
}): Envelope {
  const signals = [
    ...(input.scan.shippedSignal ? ['shipped' as const] : []),
    ...input.needsReproSignals
  ];
  const verdict_summary = input.scan.shippedSignal
    ? 'ask appears shipped on main, verify intent.'
    : input.scan.treeMatches.length > 0 || input.scan.grepMatches.length > 0
      ? 'partial overlap found.'
      : input.bugMissingRepro
        ? 'bug-shaped issue lacks reproduction steps; verify before investing.'
        : input.scan.mode === 'contents_fallback'
          ? 'clone unavailable; contents fallback found no named-path evidence on default branch.'
          : 'no evidence on main.';
  return createEnvelope({
    verdict_summary,
    evidence: [
      issueMetaEvidence(input.issue, input.repro, input.bugMissingRepro),
      { tree_matches: input.scan.treeMatches },
      { grep_matches: input.scan.grepMatches },
      {
        kind: 'issue_vs_main_perf',
        mode: input.scan.mode,
        clone_cached: input.scan.cloneCached,
        file_list_cached: input.scan.fileListCached
      }
    ],
    signals,
    checked: [
      `fetched issue ${input.repo}#${input.issueNumber}`,
      ...input.scan.checked,
      'assessed reproduction-step signals in the issue body'
    ],
    not_checked: [INTENT_LIMIT, ...input.scan.notCheckedExtra.filter((item) => item !== INTENT_LIMIT)],
    cached: false
  });
}

export async function issue_vs_main(input: Input): Promise<Envelope> {
  const issue = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
  const repro = assessRepro(issue.body);
  const bugMissingRepro = looksLikeBug({ title: issue.title, body: issue.body, labels: issue.labels.map((label) => label.name) }) && repro === 'missing';
  const needsReproSignals = bugMissingRepro ? ['needs_repro' as const] : [];
  const inferredIntentTerms = inferredExampleTerms(issue);
  const concrete = hasConcretePathTerms(issue) || inferredIntentTerms.length > 0;

  if (!concrete) {
    return createEnvelope({
      verdict_summary: bugMissingRepro
        ? 'bug-shaped issue lacks reproduction steps; verify before investing.'
        : 'no concrete path terms; skipped main tree/grep.',
      evidence: [
        issueMetaEvidence(issue, repro, bugMissingRepro),
        { tree_matches: [] },
        { grep_matches: [] },
        { kind: 'issue_vs_main_perf', mode: 'repro_only', clone_cached: null, file_list_cached: null }
      ],
      signals: needsReproSignals,
      checked: [`fetched issue ${input.repo}#${input.issue_number}`, 'assessed reproduction-step signals in the issue body', 'skipped tree/grep (no concrete path terms)'],
      not_checked: [INTENT_LIMIT, FUZZY_SKIP],
      cached: false
    });
  }

  const candidates = terms(issue);
  const grepCandidates = contentTerms(issue);
  const exactPathTerms = pathTerms(issue);
  const scanInput = {
    repo: input.repo,
    candidates,
    grepCandidates,
    exactPathTerms,
    inferredIntentTerms
  };

  let scan: ScanBundle;
  try {
    scan = await scanPooledClone(scanInput);
  } catch (cloneError) {
    const local = await scanLocalCheckout(scanInput);
    scan = local ?? await scanContentsFallback({
      repo: input.repo,
      grepCandidates,
      exactPathTerms,
      inferredIntentTerms,
      cloneError
    });
  }

  return envelopeFromScan({
    issue,
    repro,
    bugMissingRepro,
    needsReproSignals,
    scan,
    repo: input.repo,
    issueNumber: input.issue_number
  });
}
