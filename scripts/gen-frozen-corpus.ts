/**
 * Emit GW-024 frozen eval corpus (offline provider replay packs).
 * Run: pnpm exec tsx scripts/gen-frozen-corpus.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve('eval/frozen');
const REPO = 'acme/widgets';
const CANONICAL = 'acme/widgets';

type HttpEx = Record<string, unknown>;
type GitProbe = Record<string, unknown>;

class Fx {
  seq = 0;
  http: HttpEx[] = [];
  git: GitProbe[] = [];

  private next() {
    return this.seq++;
  }

  gh(url: string, body: unknown, status = 200) {
    this.http.push({
      sequence: this.next(),
      provider: 'github',
      match: { method: 'GET', canonical_url: url, request_body_digest_sha256: null },
      response: { status, headers: { 'content-type': 'application/json' }, body_encoding: 'json', body }
    });
  }

  /** Unified-diff body for the same pulls/{n} URL linked_work already fetched as JSON. */
  ghDiff(url: string, text: string) {
    this.http.push({
      sequence: this.next(),
      provider: 'github',
      match: { method: 'GET', canonical_url: url, request_body_digest_sha256: null },
      response: {
        status: 200,
        headers: { 'content-type': 'application/vnd.github.diff' },
        body_encoding: 'text',
        body: text
      }
    });
  }

  ghRateLimit(url: string) {
    this.http.push({
      sequence: this.next(),
      provider: 'github',
      match: { method: 'GET', canonical_url: url, request_body_digest_sha256: null },
      response: {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '4102444800'
        },
        body_encoding: 'json',
        body: { message: 'API rate limit exceeded' }
      }
    });
  }

  raw404(repo: string, branch: string, file: string) {
    this.http.push({
      sequence: this.next(),
      provider: 'github',
      match: {
        method: 'GET',
        canonical_url: `https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
        request_body_digest_sha256: null
      },
      response: { status: 404, headers: {}, body_encoding: 'omitted' }
    });
  }

  rawText(repo: string, branch: string, file: string, text: string) {
    this.http.push({
      sequence: this.next(),
      provider: 'github',
      match: {
        method: 'GET',
        canonical_url: `https://raw.githubusercontent.com/${repo}/${branch}/${file}`,
        request_body_digest_sha256: null
      },
      response: {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body_encoding: 'text',
        body: text
      }
    });
  }

  npm(url: string, body: unknown) {
    this.http.push({
      sequence: this.next(),
      provider: 'npm',
      match: { method: 'GET', canonical_url: url, request_body_digest_sha256: null },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body_encoding: 'json', body }
    });
  }

  npmTarball(url: string, content: string) {
    this.http.push({
      sequence: this.next(),
      provider: 'npm',
      match: { method: 'GET', canonical_url: url, request_body_digest_sha256: null },
      response: {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
        body_encoding: 'base64',
        body: Buffer.from(content).toString('base64')
      }
    });
  }

  lsRemote(repo: string, heads: Array<{ name: string; sha: string }>) {
    this.git.push({
      sequence: this.git.length,
      kind: 'ls_remote_heads',
      match: { repo },
      response: { heads }
    });
  }

  clone(repo: string, files: Array<{ path: string; content: string }>) {
    this.git.push({
      sequence: this.git.length,
      kind: 'shallow_clone',
      match: { repo },
      response: { files }
    });
  }

  pack(caseId: string) {
    return {
      schema_version: '1.0-draft.1',
      fixture_version: 1,
      case_id: caseId,
      attributed_from: { notes: 'GW-024 synthetic offline promotion pack' },
      http_exchanges: this.http,
      git_probes: this.git
    };
  }
}

function searchUrl(q: string, perPage = 20) {
  return `https://api.github.com/search/issues?per_page=${perPage}&q=${encodeURIComponent(q)}`;
}

function npmMetaUrl(packageName: string) {
  return `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}`;
}

function issue(partial: Record<string, unknown> & { number: number; title: string; state: string }) {
  return {
    body: partial.title,
    labels: [],
    comments: 0,
    html_url: `https://github.com/${REPO}/issues/${partial.number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: partial.state === 'closed' ? '2026-01-03T00:00:00Z' : null,
    assignees: [],
    ...partial
  };
}

function pull(partial: Record<string, unknown> & { number: number; title: string; state: string }) {
  return {
    body: partial.body ?? '',
    draft: false,
    merged: partial.state === 'closed' && partial.merged_at !== null,
    html_url: `https://github.com/${REPO}/pull/${partial.number}`,
    user: { login: 'human-dev' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: partial.state === 'closed' ? '2026-01-03T00:00:00Z' : null,
    merged_at: null,
    ...partial
  };
}

function prSearchItem(p: ReturnType<typeof pull>, repo = CANONICAL) {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    html_url: `https://github.com/${repo}/pull/${p.number}`,
    repository_url: `https://api.github.com/repos/${repo}`,
    pull_request: { url: `https://api.github.com/repos/${repo}/pulls/${p.number}` }
  };
}

function repoMeta(fullName: string) {
  return { full_name: fullName, default_branch: 'main', html_url: `https://github.com/${fullName}` };
}

function contrib404s(fx: Fx, repo: string) {
  for (const file of [
    'CONTRIBUTING.md', '.github/CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md',
    'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md'
  ]) {
    fx.raw404(repo, 'main', file);
  }
}

/** Standard linked_work tail: comments, PR search, optional title overlap, org network search. */
function linkedTail(
  fx: Fx,
  inputRepo: string,
  homeRepo: string,
  issueNumber: number,
  searchItems: unknown[],
  extraPulls: Array<ReturnType<typeof pull>> = [],
  titleOverlap?: { terms: string; items?: unknown[]; pulls?: Array<ReturnType<typeof pull>> }
) {
  fx.gh(`https://api.github.com/repos/${homeRepo}/issues/${issueNumber}/comments?per_page=100`, []);
  fx.gh(searchUrl(`repo:${CANONICAL} is:pr ${issueNumber}`), { total_count: searchItems.length, incomplete_results: false, items: searchItems });
  for (const pr of extraPulls) {
    fx.gh(`https://api.github.com/repos/${inputRepo}/pulls/${pr.number}`, pr);
  }
  if (titleOverlap) {
    const items = titleOverlap.items ?? [];
    fx.gh(searchUrl(`repo:${CANONICAL} is:pr is:open ${titleOverlap.terms}`), {
      total_count: items.length,
      incomplete_results: false,
      items
    });
    for (const pr of titleOverlap.pulls ?? []) {
      fx.gh(`https://api.github.com/repos/${inputRepo}/pulls/${pr.number}`, pr);
    }
  }
  fx.gh(searchUrl(`is:pr ("Fixes #${issueNumber}" OR "Closes #${issueNumber}" OR "Resolves #${issueNumber}" OR "#${issueNumber}") org:acme`), {
    total_count: 0, incomplete_results: false, items: []
  });
  fx.gh(searchUrl(`is:pr ("Fixes #${issueNumber}" OR "Closes #${issueNumber}" OR "Resolves #${issueNumber}" OR "#${issueNumber}") user:acme`), {
    total_count: 0, incomplete_results: false, items: []
  });
}

function linkedBase(fx: Fx, inputRepo: string, issueNumber: number, issueBody: unknown, timeline: unknown[]) {
  fx.gh(`https://api.github.com/repos/${inputRepo}`, repoMeta(CANONICAL));
  fx.gh(`https://api.github.com/repos/${inputRepo}/issues/${issueNumber}`, issueBody);
  fx.gh(`https://api.github.com/repos/${inputRepo}/issues/${issueNumber}/timeline?per_page=100&page=1`, timeline);
}

function titleTermsFromIssue(title: string) {
  const terms = title.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  return terms.slice(0, 3).join(' ');
}

function linkedNoHuman(fx: Fx, inputRepo: string, issueNumber: number, issueBody: ReturnType<typeof issue>) {
  linkedBase(fx, inputRepo, issueNumber, issueBody, []);
  linkedTail(fx, inputRepo, inputRepo, issueNumber, [], [], {
    terms: titleTermsFromIssue(issueBody.title),
    items: [],
    pulls: []
  });
}

function dupePack(fx: Fx, repo: string, target: ReturnType<typeof issue>, searchItems: unknown[], listed: unknown[], searchTerms: string) {
  fx.gh(`https://api.github.com/repos/${repo}/issues/${target.number}`, target);
  fx.gh(`https://api.github.com/repos/${repo}`, repoMeta(CANONICAL));
  fx.gh(searchUrl(`repo:${CANONICAL} is:issue ${searchTerms}`, 50), { total_count: searchItems.length, incomplete_results: false, items: searchItems });
  fx.gh(`https://api.github.com/repos/${repo}/issues?page=1&per_page=50&state=all`, listed);
}

function caseJson(input: Record<string, unknown>) {
  return {
    schema_version: '1.0-draft.1',
    case_version: 1,
    suite: 'frozen',
    classification: 'frozen',
    provenance: { notes: 'GW-024 promotion' },
    time_sensitive: false,
    ...input
  };
}

function makeTarball(filePath: string, content: string): Buffer {
  const name = `package/${filePath}`;
  const data = Buffer.from(content, 'utf8');
  const header = Buffer.alloc(512, 0);
  header.write(name.slice(0, 99), 0, 100, 'utf8');
  header.write('0000644', 100, 7);
  header.write('0000000', 108, 7);
  header.write('0000000', 116, 7);
  header.write(data.length.toString(8).padStart(11, '0'), 124, 11);
  header.write(Math.ceil((512 + data.length) / 512).toString(8).padStart(6, '0'), 136, 6);
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += header[i] ?? 0;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512, 0);
  const end = Buffer.alloc(1024, 0);
  return Buffer.concat([header, data, pad, end]);
}

const tarballWithProbe = gzipSync(makeTarball('dist/add.js', 'exports.shell = true; // shell: true'));

type CaseDef = { meta: Record<string, unknown>; pack: Record<string, unknown> };

const cases: CaseDef[] = [];

// --- linked_work: open closing PR ---
{
  const fx = new Fx();
  const n = 100;
  const pr = pull({ number: 101, title: `Fix widget timeout (#${n})`, body: `Fixes #${n}`, state: 'open' });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'widget timeout on refresh', state: 'open' }), [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: 101, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/101` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/101`, pr);
  linkedTail(fx, REPO, REPO, n, [prSearchItem(pr)], []);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-open-closer',
      name: 'Open PR explicitly closes issue (linked_work)',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'land_only',
        failure_mode: 'open_closing_pr_linked_work',
        adjudicator_rationale: 'Timeline cross-reference with Fixes #N must emit linked_pr_open for human VERIFY; worth_check treats explicit closers as hard SKIP.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`, `https://github.com/${REPO}/pull/101`],
        required_signals: ['linked_pr_open'], forbidden_signals: [],
        required_findings: ['101'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-open-closer.provider.json'
    }),
    pack: fx.pack('frozen-linked-open-closer')
  });
}

// --- linked_work: closed unmerged prior attempt ---
{
  const fx = new Fx();
  const n = 102;
  const pr = pull({ number: 103, title: `Attempt fix #${n}`, body: `Fixes #${n}`, state: 'closed', merged_at: null });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'intermittent socket hang', state: 'open' }), [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: 103, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/103` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/103`, pr);
  linkedTail(fx, REPO, REPO, n, [prSearchItem(pr)], []);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-closed-unmerged',
      name: 'Closed unmerged linked PR is prior attempt',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'closed_unmerged_prior_attempt',
        adjudicator_rationale: 'Closed unmerged PRs must surface linked_pr_closed density without forcing SKIP.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_closed'], forbidden_signals: ['linked_pr_open'],
        required_findings: ['prior_attempt'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-closed-unmerged.provider.json'
    }),
    pack: fx.pack('frozen-linked-closed-unmerged')
  });
}

// --- linked_work: title overlap only ---
{
  const fx = new Fx();
  const n = 104;
  const target = issue({ number: n, title: 'cryptic oauth callback mismatch', body: 'OAuth callback mismatch when using custom domains.', state: 'open' });
  const pr = pull({ number: 105, title: 'oauth callback mismatch draft', body: 'Related work', state: 'open' });
  linkedBase(fx, REPO, n, target, []);
  linkedTail(fx, REPO, REPO, n, [], [], {
    terms: 'cryptic oauth callback',
    items: [prSearchItem(pr)],
    pulls: [pr]
  });
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-title-overlap-only',
      name: 'Title-overlap PR is VERIFY-grade not hard closer',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'title_overlap_pr_verify_grade',
        adjudicator_rationale: 'Title-overlap linkage may emit linked_pr_open but must not be treated as definitive closer (source title_overlap).',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_open'],
        required_findings: ['title_overlap'], forbidden_findings: ['closes_issue']
      },
      provider_fixtures: '../fixtures/frozen-linked-title-overlap-only.provider.json'
    }),
    pack: fx.pack('frozen-linked-title-overlap-only')
  });
}

// --- linked_work: draft without close ignored ---
{
  const fx = new Fx();
  const n = 106;
  const pr = pull({ number: 107, title: 'WIP mega refactor', body: 'Touches everything', state: 'open', draft: true });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'slow dashboard render', state: 'open' }), [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: 107, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/107` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/107`, pr);
  linkedTail(fx, REPO, REPO, n, [], []);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-draft-ignored',
      name: 'Draft PR without close ignored for verdict signals',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'draft_pr_without_close_ignored',
        adjudicator_rationale: 'Draft PRs without explicit closing language must not emit linked_pr_open.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        forbidden_signals: ['linked_pr_open'],
        required_findings: ['draft_without_close'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-draft-ignored.provider.json'
    }),
    pack: fx.pack('frozen-linked-draft-ignored')
  });
}

// --- linked_work: automation author ignored ---
{
  const fx = new Fx();
  const n = 108;
  const pr = pull({ number: 109, title: `Fixes #${n}`, body: `Fixes #${n}`, state: 'open', user: { login: 'dependabot[bot]' } });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'dependency bump side effect', state: 'open' }), [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: 109, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/109` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/109`, pr);
  linkedTail(fx, REPO, REPO, n, [], [], {
    terms: titleTermsFromIssue('dependency bump side effect'),
    items: [],
    pulls: []
  });
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-automation-ignored',
      name: 'Automation-authored linked PR ignored',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'automation_author_ignored',
        adjudicator_rationale: 'Dependabot and other automation authors must not block via linked_pr_open.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        forbidden_signals: ['linked_pr_open'],
        required_findings: ['automation_author'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-automation-ignored.provider.json'
    }),
    pack: fx.pack('frozen-linked-automation-ignored')
  });
}

// --- linked_work: empty timeline ---
{
  const fx = new Fx();
  const n = 110;
  const body = issue({ number: n, title: 'silent failure uploading csv', state: 'open' });
  linkedNoHuman(fx, REPO, n, body);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-empty-timeline',
      name: 'Empty timeline notes missing cross-references',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'missing_timeline_cross_references',
        adjudicator_rationale: 'Empty timeline should note cross-reference gaps without inventing linked PRs.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        forbidden_signals: ['linked_pr_open', 'linked_pr_closed'],
        required_findings: ['timeline events observed: none'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-empty-timeline.provider.json'
    }),
    pack: fx.pack('frozen-linked-empty-timeline')
  });
}

// --- linked_work: assigned maintainer ---
{
  const fx = new Fx();
  const n = 111;
  linkedBase(fx, REPO, n, issue({
    number: n, title: 'race in widget scheduler', state: 'open',
    assignees: [{ login: 'maintainer-alice' }]
  }), [{
    event: 'assigned', created_at: '2026-01-02T00:00:00Z', assignee: { login: 'maintainer-alice' }, actor: { login: 'lead-bob' }
  }]);
  linkedTail(fx, REPO, REPO, n, [], [], {
    terms: titleTermsFromIssue('race in widget scheduler'),
    items: [],
    pulls: []
  });
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-assigned',
      name: 'Assigned maintainer emits assigned signal',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'claim_first',
        failure_mode: 'assigned_maintainer_signal',
        adjudicator_rationale: 'Current assignees must emit assigned for worth_check VERIFY/claim_first.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['assigned'], forbidden_signals: ['linked_pr_open'],
        required_findings: ['maintainer-alice'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-assigned.provider.json'
    }),
    pack: fx.pack('frozen-linked-assigned')
  });
}

// --- linked_work: competing open closers ---
{
  const fx = new Fx();
  const n = 112;
  const pr1 = pull({ number: 113, title: `Fixes #${n} primary`, body: `Fixes #${n}`, state: 'open' });
  const pr2 = pull({ number: 114, title: `Also fixes #${n}`, body: `Closes #${n}`, state: 'open' });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'duplicate handler registration', state: 'open' }), [
    { event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z', source: { type: 'issue', issue: { number: 113, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/113` } } } },
    { event: 'cross-referenced', created_at: '2026-01-03T00:00:00Z', source: { type: 'issue', issue: { number: 114, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/114` } } } }
  ]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/113`, pr1);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/114`, pr2);
  linkedTail(fx, REPO, REPO, n, [prSearchItem(pr1), prSearchItem(pr2)], []);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-competing-closers',
      name: 'Competing open closers density evidence',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'land_only',
        failure_mode: 'competing_open_closers_density',
        adjudicator_rationale: 'Multiple open explicit closers must remain visible as linked_pr_open density; worth_check picks a land-pick primary.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_open'],
        required_findings: ['113', '114'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-competing-closers.provider.json'
    }),
    pack: fx.pack('frozen-linked-competing-closers')
  });
}

// --- linked_work: merged PR verify path ---
{
  const fx = new Fx();
  const n = 115;
  const pr = pull({ number: 116, title: `Fixes #${n}`, body: `Fixes #${n}`, state: 'closed', merged_at: '2026-01-04T00:00:00Z', merged: true });
  linkedBase(fx, REPO, n, issue({ number: n, title: 'toast notification stuck open', state: 'open' }), [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: 116, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/116` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/116`, pr);
  linkedTail(fx, REPO, REPO, n, [prSearchItem(pr)], []);
  cases.push({
    meta: caseJson({
      id: 'frozen-linked-merged-verify',
      name: 'Merged linked PR while issue open (VERIFY close candidate)',
      function: 'linked_work',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'linked_pr_merged_verify_path',
        adjudicator_rationale: 'Merged linked PR with open issue emits linked_pr_merged for CLOSE_CANDIDATE review.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_merged'], forbidden_signals: ['linked_pr_open'],
        required_findings: ['116'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-linked-merged-verify.provider.json'
    }),
    pack: fx.pack('frozen-linked-merged-verify')
  });
}

// --- contrib_policy: claim_required ---
{
  const fx = new Fx();
  const repo = 'acme/policy';
  fx.gh(`https://api.github.com/repos/${repo}`, repoMeta(repo));
  fx.rawText(repo, 'main', 'CONTRIBUTING.md', '# Contributing\n\nPlease comment before opening a pull request if you want to work on an issue.\n\nYou must request assignment from a maintainer before starting.');
  for (const file of ['.github/CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md']) {
    fx.raw404(repo, 'main', file);
  }
  cases.push({
    meta: caseJson({
      id: 'frozen-contrib-claim-required',
      name: 'Contribution policy claim_required extraction',
      function: 'contrib_policy',
      input: { repo },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'claim_first',
        failure_mode: 'contrib_policy_claim_required',
        adjudicator_rationale: 'CONTRIBUTING.md claim language must emit claim_required signal.',
        evidence_urls: [`https://github.com/${repo}/blob/main/CONTRIBUTING.md`],
        required_signals: ['claim_required'], forbidden_signals: ['no_pr_path'],
        required_findings: ['claim_required'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-contrib-claim-required.provider.json'
    }),
    pack: fx.pack('frozen-contrib-claim-required')
  });
}

// --- contrib_policy: evidence_requirements ---
{
  const fx = new Fx();
  const repo = 'acme/policy';
  fx.gh(`https://api.github.com/repos/${repo}`, repoMeta(repo));
  fx.rawText(repo, 'main', 'CONTRIBUTING.md', '# Contributing\n\nAll changes require tests and proof in the pull request description.');
  for (const file of ['.github/CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md']) {
    fx.raw404(repo, 'main', file);
  }
  cases.push({
    meta: caseJson({
      id: 'frozen-contrib-evidence-requirements',
      name: 'Contribution policy evidence_requirements field',
      function: 'contrib_policy',
      input: { repo },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'contrib_policy_evidence_requirements',
        adjudicator_rationale: 'Evidence/tests language is extracted as evidence_requirements category (inform-only, no dedicated signal).',
        evidence_urls: [`https://github.com/${repo}/blob/main/CONTRIBUTING.md`],
        required_signals: [], forbidden_signals: ['claim_required'],
        required_findings: ['evidence_requirements'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-contrib-evidence-requirements.provider.json'
    }),
    pack: fx.pack('frozen-contrib-evidence-requirements')
  });
}

// --- contrib_policy: no_pr_path ---
{
  const fx = new Fx();
  const repo = 'acme/mirror-only';
  fx.gh(`https://api.github.com/repos/${repo}`, repoMeta(repo));
  fx.rawText(repo, 'main', 'CONTRIBUTING.md', '# Mirror repository\n\nThis is a mirror repo. Pull requests are not accepted here.');
  for (const file of ['.github/CONTRIBUTING.md', 'AGENTS.md', 'AI_POLICY.md', 'CODE_OF_CONDUCT.md', '.github/PULL_REQUEST_TEMPLATE.md', 'SECURITY.md']) {
    fx.raw404(repo, 'main', file);
  }
  cases.push({
    meta: caseJson({
      id: 'frozen-contrib-no-pr-path',
      name: 'Contribution policy no_pr_path signal',
      function: 'contrib_policy',
      input: { repo },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'blocked',
        failure_mode: 'contrib_policy_no_pr_path',
        adjudicator_rationale: 'Mirror/no-PR policy must emit no_pr_path for blocked disposition in worth_check.',
        evidence_urls: [`https://github.com/${repo}/blob/main/CONTRIBUTING.md`],
        required_signals: ['no_pr_path'], forbidden_signals: ['claim_required'],
        required_findings: ['no_pr_path'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-contrib-no-pr-path.provider.json'
    }),
    pack: fx.pack('frozen-contrib-no-pr-path')
  });
}

// --- branch_scan: in_flight ---
{
  const fx = new Fx();
  const repo = 'acme/branches';
  fx.lsRemote(repo, [
    { name: 'main', sha: 'aaa111' },
    { name: 'fix-200-widget-cache', sha: 'bbb222' },
    { name: 'chore/deps', sha: 'ccc333' }
  ]);
  fx.gh(`https://api.github.com/repos/${repo}/commits/bbb222`, {
    commit: { author: { date: new Date().toISOString() }, message: 'fix widget cache' },
    html_url: `https://github.com/${repo}/commit/bbb222`
  });
  cases.push({
    meta: caseJson({
      id: 'frozen-branch-in-flight',
      name: 'Branch scan in_flight issue-number match',
      function: 'branch_scan',
      input: { repo, keywords: ['widget', 'cache'], issue_number: 200 },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'branch_scan_in_flight_match',
        adjudicator_rationale: 'Issue-number branch hits must emit in_flight even when tip metadata is sparse.',
        evidence_urls: [`https://github.com/${repo}/tree/fix-200-widget-cache`],
        required_signals: ['in_flight'],
        required_findings: ['fix-200-widget-cache'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-branch-in-flight.provider.json'
    }),
    pack: fx.pack('frozen-branch-in-flight')
  });
}

// --- branch_scan: no match ---
{
  const fx = new Fx();
  const repo = 'acme/branches';
  fx.lsRemote(repo, [{ name: 'main', sha: 'aaa111' }, { name: 'release/1.0', sha: 'ddd444' }]);
  cases.push({
    meta: caseJson({
      id: 'frozen-branch-no-match',
      name: 'Branch scan finds no matching remote heads',
      function: 'branch_scan',
      input: { repo, keywords: ['quantum', 'flux'], issue_number: 201 },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'branch_scan_no_match',
        adjudicator_rationale: 'Unrelated branch names must not emit in_flight.',
        evidence_urls: [`https://github.com/${repo}`],
        forbidden_signals: ['in_flight'], required_signals: [],
        required_findings: [], forbidden_findings: ['fix-201']
      },
      provider_fixtures: '../fixtures/frozen-branch-no-match.provider.json'
    }),
    pack: fx.pack('frozen-branch-no-match')
  });
}

// --- issue_vs_main: shipped ---
{
  const fx = new Fx();
  const repo = 'acme/shipped';
  const n = 49;
  fx.gh(`https://api.github.com/repos/${repo}/issues/${n}`, issue({
    number: n,
    title: 'Add example-apps/fastapi demo',
    body: 'Please add example-apps/fastapi with a runnable demo.',
    state: 'open'
  }));
  fx.clone(repo, [
    { path: 'example-apps/fastapi/app.py', content: 'print("example-apps/fastapi demo")\n' },
    { path: 'README.md', content: '# shipped repo\n' }
  ]);
  cases.push({
    meta: caseJson({
      id: 'frozen-issue-shipped',
      name: 'Issue vs main shipped path overlap',
      function: 'issue_vs_main',
      input: { repo, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'issue_vs_main_shipped_overlap',
        adjudicator_rationale: 'Concrete path overlap on main emits shipped heuristic for human verification.',
        evidence_urls: [`https://github.com/${repo}/issues/${n}`],
        required_signals: ['shipped'],
        required_findings: ['example-apps/fastapi'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-issue-shipped.provider.json'
    }),
    pack: fx.pack('frozen-issue-shipped')
  });
}

// --- issue_vs_main: partial overlap ---
{
  const fx = new Fx();
  const repo = 'acme/partial';
  const n = 24;
  fx.gh(`https://api.github.com/repos/${repo}/issues/${n}`, issue({
    number: n,
    title: 'Improve src/widgets/handler.ts logging',
    body: 'Add structured logging to src/widgets/handler.ts for timeout cases.',
    state: 'open'
  }));
  fx.clone(repo, [
    { path: 'src/widgets/handler.ts', content: 'export function handle() { return "ok"; }\n' },
    { path: 'src/other/unrelated.ts', content: 'export const x = 1;\n' }
  ]);
  cases.push({
    meta: caseJson({
      id: 'frozen-issue-partial-overlap',
      name: 'Issue vs main partial overlap without shipped signal',
      function: 'issue_vs_main',
      input: { repo, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'issue_vs_main_partial_overlap',
        adjudicator_rationale: 'Path overlap without content intent match stays VERIFY (partial overlap summary, no shipped signal).',
        evidence_urls: [`https://github.com/${repo}/issues/${n}`],
        forbidden_signals: ['shipped'],
        required_findings: ['partial overlap'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-issue-partial-overlap.provider.json'
    }),
    pack: fx.pack('frozen-issue-partial-overlap')
  });
}

// --- release_gap: released_fix ---
{
  const fx = new Fx();
  const repo = 'acme/npm-gap';
  const pkg = '@acme/widgets-cli';
  const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/-/widgets-cli-2.0.0.tgz`;
  fx.npm(npmMetaUrl(pkg), {
    name: pkg,
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { version: '2.0.0', dist: { tarball: tarballUrl } } },
    time: { '2.0.0': '2026-01-01T00:00:00Z' }
  });
  fx.npmTarball(tarballUrl, tarballWithProbe);
  fx.clone(repo, [{ path: 'package.json', content: '{"name":"@acme/widgets-cli","version":"2.0.0"}\n' }]);
  cases.push({
    meta: caseJson({
      id: 'frozen-release-released-fix',
      name: 'Release gap released_fix with matched probe',
      function: 'release_gap',
      input: {
        repo,
        npm_package: pkg,
        probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' }
      },
      ground_truth: {
        verdict: 'SKIP', disposition: 'blocked',
        failure_mode: 'release_gap_released_fix_probe',
        adjudicator_rationale: 'Version equality plus content probe match in npm tarball emits definitive released_fix.',
        evidence_urls: [`https://www.npmjs.com/package/${pkg}/v/2.0.0`],
        required_signals: ['released_fix'],
        required_findings: ['shell: true'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-release-released-fix.provider.json'
    }),
    pack: fx.pack('frozen-release-released-fix')
  });
}

// --- release_gap: version only ---
{
  const fx = new Fx();
  const repo = 'acme/npm-gap';
  const pkg = '@acme/widgets-lib';
  const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/-/widgets-lib-1.0.0.tgz`;
  fx.npm(npmMetaUrl(pkg), {
    name: pkg,
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { version: '1.0.0', dist: { tarball: tarballUrl } } },
    time: { '1.0.0': '2026-01-01T00:00:00Z' }
  });
  fx.npmTarball(tarballUrl, gzipSync(makeTarball('dist/add.js', 'exports.ok = true;\n')));
  fx.clone(repo, [{ path: 'package.json', content: '{"name":"@acme/widgets-lib","version":"1.0.0"}\n' }]);
  cases.push({
    meta: caseJson({
      id: 'frozen-release-version-only',
      name: 'Release gap version equality without probe match',
      function: 'release_gap',
      input: {
        repo,
        npm_package: pkg,
        probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' }
      },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'release_gap_version_only_no_probe',
        adjudicator_rationale: 'Equal versions without issue-specific probe match must not emit released_fix.',
        evidence_urls: [`https://www.npmjs.com/package/${pkg}/v/1.0.0`],
        forbidden_signals: ['released_fix'],
        required_findings: ['1.0.0'], forbidden_findings: ['released_fix']
      },
      provider_fixtures: '../fixtures/frozen-release-version-only.provider.json'
    }),
    pack: fx.pack('frozen-release-version-only')
  });
}

// --- dupe: medium lexical ---
{
  const fx = new Fx();
  const target = issue({ number: 50, title: 'widget spinner flickers on safari', body: 'Safari spinner flickers during widget refresh cycles.', state: 'open' });
  const candidate = issue({ number: 51, title: 'widget spinner flickers chrome too', body: 'Chrome also shows spinner flicker on widget refresh.', state: 'open' });
  dupePack(fx, REPO, target, [target, candidate], [target, candidate], 'widget spinner flickers safari');
  cases.push({
    meta: caseJson({
      id: 'frozen-dupe-medium-lexical',
      name: 'Medium lexical duplicate without blocking signal',
      function: 'dupe_cluster',
      input: { repo: REPO, issue_number: 50 },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'crowded',
        failure_mode: 'medium_lexical_dupe_without_blocking',
        adjudicator_rationale: 'Lexical scores above evidence threshold must surface candidates without emitting duplicate signal below blocking threshold.',
        evidence_urls: [`https://github.com/${REPO}/issues/50`, `https://github.com/${REPO}/issues/51`],
        forbidden_signals: ['duplicate'],
        required_findings: ['51'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-dupe-medium-lexical.provider.json'
    }),
    pack: fx.pack('frozen-dupe-medium-lexical')
  });
}

// --- rename canonicalization ---
{
  const fx = new Fx();
  const alias = 'acme/old-widgets';
  const n = 120;
  linkedBase(fx, alias, n, issue({ number: n, title: 'rename canonical path check', state: 'open' }), []);
  linkedTail(fx, alias, CANONICAL, n, [], [], {
    terms: titleTermsFromIssue('rename canonical path check'),
    items: [],
    pulls: []
  });
  cases.push({
    meta: caseJson({
      id: 'frozen-repo-rename-canonical',
      name: 'Renamed repo resolves canonical full_name',
      function: 'linked_work',
      input: { repo: alias, issue_number: n },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'renamed_repo_canonicalization',
        adjudicator_rationale: 'Alias repo input must resolve to canonical acme/widgets for search/linkage keys.',
        evidence_urls: [`https://github.com/${CANONICAL}/issues/${n}`],
        required_findings: ['acme/widgets'], forbidden_signals: ['linked_pr_open'],
        required_signals: [], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-repo-rename-canonical.provider.json'
    }),
    pack: fx.pack('frozen-repo-rename-canonical')
  });
}

function worthPhase2Extras(fx: Fx, target: ReturnType<typeof issue>, searchTerms: string, opts: { clone?: boolean; branch?: boolean } = {}) {
  const issueUrl = `https://api.github.com/repos/${REPO}/issues/${target.number}`;
  fx.gh(issueUrl, target);
  fx.gh(issueUrl, target);
  if (opts.clone !== false) {
    fx.clone(REPO, [{ path: 'README.md', content: '# widgets\n' }]);
  }
  if (opts.branch !== false) {
    fx.lsRemote(REPO, [{ name: 'main', sha: 'aaa111' }]);
  }
  fx.gh(searchUrl(`repo:${CANONICAL} is:issue ${searchTerms}`, 50), { total_count: 1, incomplete_results: false, items: [target] });
  fx.gh(`https://api.github.com/repos/${REPO}/issues?page=1&per_page=50&state=all`, [target]);
}

function worthPackOpenCloser(caseId: string, issueNumber: number) {
  const fx = new Fx();
  const pr = pull({ number: issueNumber + 1, title: `Fixes #${issueNumber}`, body: `Fixes #${issueNumber}`, state: 'open' });
  const target = issue({ number: issueNumber, title: 'worth check open closer short circuit', state: 'open' });
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${issueNumber}`, target);
  linkedBase(fx, REPO, issueNumber, target, [{
    event: 'cross-referenced', created_at: '2026-01-02T00:00:00Z',
    source: { type: 'issue', issue: { number: issueNumber + 1, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/${issueNumber + 1}` } } }
  }]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/${issueNumber + 1}`, pr);
  linkedTail(fx, REPO, REPO, issueNumber, [prSearchItem(pr)], []);
  contrib404s(fx, REPO);
  return fx.pack(caseId);
}

// --- worth_check: SKIP open closer ---
{
  const n = 300;
  cases.push({
    meta: caseJson({
      id: 'frozen-worth-skip-open-closer',
      name: 'worth_check SKIP on definitive open closer (short-circuit)',
      function: 'worth_check',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'SKIP', disposition: 'land_only',
        failure_mode: 'worth_check_skip_open_closer',
        adjudicator_rationale: 'Explicit open closing PR must short-circuit expensive checks and hard SKIP.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_open'],
        required_findings: ['short_circuited'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-worth-skip-open-closer.provider.json'
    }),
    pack: worthPackOpenCloser('frozen-worth-skip-open-closer', n)
  });
}

function worthGreenfieldPack(caseId: string, issueNumber: number) {
  const fx = new Fx();
  const target = issue({ number: issueNumber, title: 'consider adding holographic widget mode', body: 'It would be nice to support holographic widget rendering.', state: 'open' });
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${issueNumber}`, target);
  linkedNoHuman(fx, REPO, issueNumber, target);
  contrib404s(fx, REPO);
  worthPhase2Extras(fx, target, 'consider adding holographic', { clone: false });
  return fx.pack(caseId);
}

// --- worth_check: ACT greenfield ---
{
  const n = 301;
  cases.push({
    meta: caseJson({
      id: 'frozen-worth-act-greenfield',
      name: 'worth_check ACT on greenfield (no blockers)',
      function: 'worth_check',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'ACT', disposition: 'greenfield',
        failure_mode: 'worth_check_act_greenfield',
        adjudicator_rationale: 'With no blocking or VERIFY-grade signals across sub-checks, policy returns ACT/greenfield (honest mechanism test).',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        forbidden_signals: ['linked_pr_open', 'duplicate', 'in_flight', 'released_fix', 'assigned'],
        required_findings: [], forbidden_findings: ['SKIP']
      },
      provider_fixtures: '../fixtures/frozen-worth-act-greenfield.provider.json'
    }),
    pack: worthGreenfieldPack('frozen-worth-act-greenfield', n)
  });
}

function worthAssignedPack(caseId: string, issueNumber: number) {
  const fx = new Fx();
  const target = issue({
    number: issueNumber, title: 'assigned worth verify path', state: 'open',
    assignees: [{ login: 'maintainer-alice' }]
  });
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${issueNumber}`, target);
  linkedBase(fx, REPO, issueNumber, target, [{
    event: 'assigned', created_at: '2026-01-02T00:00:00Z', assignee: { login: 'maintainer-alice' }, actor: { login: 'lead' }
  }]);
  linkedTail(fx, REPO, issueNumber, [], []);
  fx.gh(`https://api.github.com/repos/${REPO}`, repoMeta(CANONICAL));
  contrib404s(fx, REPO);
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${issueNumber}`, target);
  fx.clone(REPO, [{ path: 'README.md', content: '# widgets\n' }]);
  fx.lsRemote(REPO, [{ name: 'main', sha: 'aaa111' }]);
  dupePack(fx, REPO, target, [target], [target], 'assigned worth verify');
  return fx.pack(caseId);
}

// --- worth_check: VERIFY assigned ---
{
  const n = 302;
  cases.push({
    meta: caseJson({
      id: 'frozen-worth-verify-assigned',
      name: 'worth_check VERIFY when issue assigned',
      function: 'worth_check',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'claim_first',
        failure_mode: 'worth_check_verify_assigned',
        adjudicator_rationale: 'Assigned maintainer must cap worth_check at VERIFY/claim_first even without linked PRs.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['assigned'], forbidden_signals: ['linked_pr_open'],
        required_findings: ['maintainer-alice'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-worth-verify-assigned.provider.json'
    }),
    pack: worthAssignedPack('frozen-worth-verify-assigned', n)
  });
}

// --- worth_check: rate limit VERIFY ---
{
  const fx = new Fx();
  const n = 303;
  const target = issue({ number: n, title: 'rate limit verify path', state: 'open' });
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${n}`, target);
  fx.gh(`https://api.github.com/repos/${REPO}`, repoMeta(CANONICAL));
  fx.ghRateLimit(`https://api.github.com/repos/${REPO}/issues/${n}/timeline?per_page=100&page=1`);
  contrib404s(fx, REPO);
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${n}`, target);
  fx.clone(REPO, [{ path: 'README.md', content: '# widgets\n' }]);
  fx.lsRemote(REPO, [{ name: 'main', sha: 'aaa111' }]);
  dupePack(fx, REPO, target, [target], [target], 'rate limit verify');
  cases.push({
    meta: caseJson({
      id: 'frozen-worth-rate-limit-verify',
      name: 'worth_check VERIFY when linked_work hits rate limit',
      function: 'worth_check',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY', disposition: 'review',
        failure_mode: 'auth_rate_limit_verify_path',
        adjudicator_rationale: 'Provider rate-limit failures must cap at VERIFY, never false hard SKIP.',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        forbidden_signals: ['linked_pr_open'],
        required_findings: ['rate limit'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-worth-rate-limit-verify.provider.json'
    }),
    pack: fx.pack('frozen-worth-rate-limit-verify')
  });
}

// --- worth_check: SKIP released_fix ---
{
  const fx = new Fx();
  const n = 304;
  const repo = 'acme/npm-gap';
  const pkg = '@acme/widgets-cli';
  const tarballUrl = `https://registry.npmjs.org/${encodeURIComponent(pkg)}/-/widgets-cli-2.0.0.tgz`;
  const target = issue({ number: n, title: 'cli shell escape bug', body: 'Fix shell: true in add.js', state: 'open' });
  fx.gh(`https://api.github.com/repos/${repo}/issues/${n}`, target);
  linkedBase(fx, repo, n, target, []);
  linkedTail(fx, repo, n, [], []);
  fx.gh(`https://api.github.com/repos/${repo}`, repoMeta(repo));
  contrib404s(fx, repo);
  fx.gh(`https://api.github.com/repos/${repo}/issues/${n}`, target);
  fx.npm(npmMetaUrl(pkg), {
    name: pkg,
    'dist-tags': { latest: '2.0.0' },
    versions: { '2.0.0': { version: '2.0.0', dist: { tarball: tarballUrl } } },
    time: { '2.0.0': '2026-01-01T00:00:00Z' }
  });
  fx.npmTarball(tarballUrl, tarballWithProbe);
  fx.clone(repo, [{ path: 'package.json', content: '{"name":"@acme/widgets-cli","version":"2.0.0"}\n' }]);
  fx.lsRemote(repo, [{ name: 'main', sha: 'aaa111' }]);
  dupePack(fx, repo, target, [target], [target], 'cli shell escape');
  cases.push({
    meta: caseJson({
      id: 'frozen-worth-skip-released-fix',
      name: 'worth_check SKIP on released_fix probe match',
      function: 'worth_check',
      input: {
        repo,
        issue_number: n,
        npm_package: pkg,
        probe: { file_glob: 'dist/**/add.js', contains: 'shell: true' }
      },
      ground_truth: {
        verdict: 'SKIP', disposition: 'blocked',
        failure_mode: 'worth_check_skip_released_fix',
        adjudicator_rationale: 'Matched release_gap released_fix is a definitive hard SKIP path.',
        evidence_urls: [`https://github.com/${repo}/issues/${n}`],
        required_signals: ['released_fix'], forbidden_signals: ['linked_pr_open'],
        required_findings: ['released_fix'], forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-worth-skip-released-fix.provider.json'
    }),
    pack: fx.pack('frozen-worth-skip-released-fix')
  });
}

// --- contention: superseded overlapping claims (Hermes #76793 narrative, synthetic acme) ---
{
  const fx = new Fx();
  const n = 76793;
  const target = issue({
    number: n,
    title: 'match app id',
    body: '## Proposed Fix\n\n```ts\n_app_id\n```\nOnly `_app_id`.\n',
    state: 'open',
    labels: [{ name: 'sweeper:risk-compatibility' }]
  });
  const prOpen = pull({
    number: 100,
    title: 'fix app id',
    body: `Fixes #${n}`,
    state: 'open',
    user: { login: 'dev-a' }
  });
  const prClosed = pull({
    number: 102,
    title: 'broader fix',
    body: `Fixes #${n}`,
    state: 'closed',
    merged: false,
    merged_at: null,
    user: { login: 'dev-b' }
  });
  const diffOpen = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,1 +1,3 @@ export function matchAppId(input: string) {',
    ' export function matchAppId(input: string) {',
    '+export function _app_id(value: string) {',
    '+  return value;',
    '+}',
    ''
  ].join('\n');
  const diffClosed = [
    'diff --git a/src/auth.ts b/src/auth.ts',
    '--- a/src/auth.ts',
    '+++ b/src/auth.ts',
    '@@ -1,1 +1,5 @@ export function matchAppId(input: string) {',
    ' export function matchAppId(input: string) {',
    '+export function _app_id(value: string) { return value; }',
    '+export function _client_id(value: string) { return value; }',
    ''
  ].join('\n');

  // contention() fetches the issue before calling linked_work
  fx.gh(`https://api.github.com/repos/${REPO}/issues/${n}`, target);
  linkedBase(fx, REPO, n, target, [
    {
      event: 'cross-referenced',
      created_at: '2026-01-02T00:00:00Z',
      source: { type: 'issue', issue: { number: 100, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/100` } } }
    },
    {
      event: 'cross-referenced',
      created_at: '2026-01-02T01:00:00Z',
      source: { type: 'issue', issue: { number: 102, pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/102` } } }
    }
  ]);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/100`, prOpen);
  fx.gh(`https://api.github.com/repos/${REPO}/pulls/102`, prClosed);
  linkedTail(fx, REPO, REPO, n, [prSearchItem(prOpen), prSearchItem(prClosed)]);
  // Same pulls/{n} URLs as JSON above; replay queue serves JSON then unified diff.
  fx.ghDiff(`https://api.github.com/repos/${REPO}/pulls/100`, diffOpen);
  fx.ghDiff(`https://api.github.com/repos/${REPO}/pulls/102`, diffClosed);
  fx.lsRemote(REPO, [
    { name: 'main', sha: 'aaa111' },
    { name: 'fix-76793-app-id', sha: 'abc222' }
  ]);

  cases.push({
    meta: caseJson({
      id: 'frozen-contention-superseded-overlap',
      name: 'Contention superseded when closed PR overlaps open claim',
      function: 'contention',
      input: { repo: REPO, issue_number: n },
      ground_truth: {
        verdict: 'VERIFY',
        disposition: 'land_only',
        failure_mode: 'contention_superseded_overlapping_claims',
        adjudicator_rationale:
          'Synthetic pack of the Hermes #76793 race narrative: open closer #100 and closed unmerged #102 share auth/_app_id paths; contention must report superseded with claim_branches density and provenance footer. Mechanism-only (no worth_check verdict).',
        evidence_urls: [`https://github.com/${REPO}/issues/${n}`],
        required_signals: ['linked_pr_open'],
        forbidden_signals: ['linked_pr_merged'],
        required_findings: ['superseded', '100', '102', 'fix-76793', 'Contention analysis'],
        forbidden_findings: []
      },
      provider_fixtures: '../fixtures/frozen-contention-superseded-overlap.provider.json'
    }),
    pack: fx.pack('frozen-contention-superseded-overlap')
  });
}

await mkdir(path.join(ROOT, 'cases'), { recursive: true });
await mkdir(path.join(ROOT, 'fixtures'), { recursive: true });

const existing = new Set(['frozen-smoke-dupe', 'frozen-dupe-ignores-pr-row', 'frozen-dupe-no-candidates', 'frozen-dupe-closed-title-gate']);

for (const item of cases) {
  const id = String(item.meta.id);
  if (existing.has(id)) continue;
  await writeFile(path.join(ROOT, 'cases', `${id}.json`), `${JSON.stringify(item.meta, null, 2)}\n`);
  await writeFile(path.join(ROOT, 'fixtures', `${id}.provider.json`), `${JSON.stringify(item.pack, null, 2)}\n`);
  console.log('wrote', id);
}

console.log(`generated ${cases.length} case definitions (${cases.length + existing.size} total with existing)`);
