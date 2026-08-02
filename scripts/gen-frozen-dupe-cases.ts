/**
 * Emit additional GW-024 frozen dupe_cluster cases (offline packs).
 * Run: pnpm exec tsx scripts/gen-frozen-dupe-cases.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

type Issue = {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: unknown[];
  comments: number;
  html_url: string;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  pull_request?: { url: string };
};

function issue(partial: Partial<Issue> & Pick<Issue, 'number' | 'title' | 'state'>): Issue {
  return {
    body: partial.body ?? partial.title,
    labels: [],
    comments: 0,
    html_url: `https://github.com/acme/widgets/issues/${partial.number}`,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    closed_at: partial.state === 'closed' ? '2026-01-03T00:00:00Z' : null,
    ...partial
  };
}

function pack(caseId: string, target: Issue, searchItems: Issue[], listed: Issue[], searchUrl: string) {
  return {
    schema_version: '1.0-draft.1',
    fixture_version: 1,
    case_id: caseId,
    attributed_from: { notes: 'GW-024 synthetic offline promotion pack' },
    http_exchanges: [
      {
        sequence: 0,
        provider: 'github',
        match: { method: 'GET', canonical_url: `https://api.github.com/repos/acme/widgets/issues/${target.number}`, request_body_digest_sha256: null },
        response: { status: 200, headers: { 'content-type': 'application/json' }, body_encoding: 'json', body: target }
      },
      {
        sequence: 1,
        provider: 'github',
        match: { method: 'GET', canonical_url: 'https://api.github.com/repos/acme/widgets', request_body_digest_sha256: null },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body_encoding: 'json',
          body: { full_name: 'acme/widgets', default_branch: 'main', html_url: 'https://github.com/acme/widgets' }
        }
      },
      {
        sequence: 2,
        provider: 'github',
        match: { method: 'GET', canonical_url: searchUrl, request_body_digest_sha256: null },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          body_encoding: 'json',
          body: { total_count: searchItems.length, incomplete_results: false, items: searchItems }
        }
      },
      {
        sequence: 3,
        provider: 'github',
        match: {
          method: 'GET',
          canonical_url: 'https://api.github.com/repos/acme/widgets/issues?page=1&per_page=50&state=all',
          request_body_digest_sha256: null
        },
        response: { status: 200, headers: { 'content-type': 'application/json' }, body_encoding: 'json', body: listed }
      }
    ],
    git_probes: []
  };
}

function caseFile(input: {
  id: string;
  name: string;
  issue: number;
  failure_mode: string;
  rationale: string;
  required_signals?: string[];
  forbidden_signals?: string[];
  required_findings?: string[];
  verdict: 'ACT' | 'VERIFY' | 'SKIP';
  disposition: 'greenfield' | 'crowded' | 'review' | 'blocked' | 'land_only' | 'claim_first';
}) {
  return {
    schema_version: '1.0-draft.1',
    case_version: 1,
    id: input.id,
    suite: 'frozen',
    name: input.name,
    function: 'dupe_cluster',
    input: { repo: 'acme/widgets', issue_number: input.issue },
    classification: 'frozen',
    ground_truth: {
      verdict: input.verdict,
      disposition: input.disposition,
      failure_mode: input.failure_mode,
      adjudicator_rationale: input.rationale,
      evidence_urls: [`https://github.com/acme/widgets/issues/${input.issue}`],
      required_findings: input.required_findings ?? [],
      forbidden_findings: [],
      required_signals: input.required_signals ?? [],
      forbidden_signals: input.forbidden_signals ?? ['duplicate']
    },
    provider_fixtures: `../fixtures/${input.id}.provider.json`,
    provenance: { notes: 'GW-024 promotion' },
    time_sensitive: false
  };
}

const root = path.resolve('eval/frozen');

const cases = [
  {
    meta: caseFile({
      id: 'frozen-dupe-ignores-pr-row',
      name: 'PR list row must not count as duplicate issue',
      issue: 1659,
      failure_mode: 'pr_row_not_duplicate_issue',
      rationale: 'Case study 2: issues API rows that are PRs must be filtered from lexical duplicate clusters.',
      forbidden_signals: ['duplicate'],
      verdict: 'ACT',
      disposition: 'greenfield'
    }),
    pack: pack(
      'frozen-dupe-ignores-pr-row',
      issue({
        number: 1659,
        title: 'preserve classified agent turn failures',
        body: 'Preserve classified agent turn failures instead of collapsing them.',
        state: 'open'
      }),
      [
        issue({
          number: 1675,
          title: 'preserve classified agent turn failures',
          body: 'Implementation PR reusing the issue title.',
          state: 'open',
          pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/1675' }
        })
      ],
      [
        issue({
          number: 1659,
          title: 'preserve classified agent turn failures',
          body: 'Preserve classified agent turn failures instead of collapsing them.',
          state: 'open'
        }),
        issue({
          number: 1675,
          title: 'preserve classified agent turn failures',
          body: 'Implementation PR reusing the issue title.',
          state: 'open',
          pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/1675' }
        })
      ],
      'https://api.github.com/search/issues?per_page=50&q=repo%3Aacme%2Fwidgets+is%3Aissue+preserve+classified+agent+turn+failures'
    )
  },
  {
    meta: caseFile({
      id: 'frozen-dupe-no-candidates',
      name: 'Greenfield issue with no lexical duplicates',
      issue: 42,
      failure_mode: 'greenfield_no_lexical_duplicate',
      rationale: 'Genuinely unique title/body should emit no duplicate signal.',
      forbidden_signals: ['duplicate'],
      verdict: 'ACT',
      disposition: 'greenfield'
    }),
    pack: pack(
      'frozen-dupe-no-candidates',
      issue({ number: 42, title: 'unique zebra widget flume', body: 'Utterly unique zebra widget flume request.', state: 'open' }),
      [issue({ number: 42, title: 'unique zebra widget flume', body: 'Utterly unique zebra widget flume request.', state: 'open' })],
      [
        issue({ number: 42, title: 'unique zebra widget flume', body: 'Utterly unique zebra widget flume request.', state: 'open' }),
        issue({ number: 7, title: 'docs typo in readme', body: 'Fix spelling.', state: 'open' })
      ],
      'https://api.github.com/search/issues?per_page=50&q=repo%3Aacme%2Fwidgets+is%3Aissue+unique+zebra+widget+flume'
    )
  },
  {
    meta: caseFile({
      id: 'frozen-dupe-closed-title-gate',
      name: 'Closed issue needs title gate for duplicate evidence',
      issue: 10,
      failure_mode: 'closed_duplicate_requires_title_gate',
      rationale: 'Closed issues with weak title overlap must not enter the duplicate evidence set.',
      forbidden_signals: ['duplicate'],
      verdict: 'ACT',
      disposition: 'greenfield'
    }),
    pack: pack(
      'frozen-dupe-closed-title-gate',
      issue({
        number: 10,
        title: 'timeout retry backoff storm',
        body: 'Users hit timeout retry backoff storm when the gateway flaps.',
        state: 'open'
      }),
      [
        issue({
          number: 11,
          title: 'totally different title about caching',
          body: 'Users hit timeout retry backoff storm when the gateway flaps.',
          state: 'closed'
        })
      ],
      [
        issue({
          number: 10,
          title: 'timeout retry backoff storm',
          body: 'Users hit timeout retry backoff storm when the gateway flaps.',
          state: 'open'
        }),
        issue({
          number: 11,
          title: 'totally different title about caching',
          body: 'Users hit timeout retry backoff storm when the gateway flaps.',
          state: 'closed'
        })
      ],
      'https://api.github.com/search/issues?per_page=50&q=repo%3Aacme%2Fwidgets+is%3Aissue+timeout+retry+backoff+storm'
    )
  }
];

await mkdir(path.join(root, 'cases'), { recursive: true });
await mkdir(path.join(root, 'fixtures'), { recursive: true });
for (const item of cases) {
  await writeFile(path.join(root, 'cases', `${item.meta.id}.json`), `${JSON.stringify(item.meta, null, 2)}\n`);
  await writeFile(path.join(root, 'fixtures', `${item.meta.id}.provider.json`), `${JSON.stringify(item.pack, null, 2)}\n`);
  console.log('wrote', item.meta.id);
}
