import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { BriefSchema } from '../src/contracts/brief.js';
import type { Finding } from '../src/contracts/findings.js';
import type { DecisionRecord } from '../src/contracts/store.js';
import { generateBrief, renderBrief } from '../src/core/brief.js';
import { createMcpServer } from '../src/mcp/server.js';
import { putDecisionRecord, putOutcomeEvent, putRunRecord } from '../src/lib/store.js';
import * as github from '../src/lib/github.js';
import * as httpClient from '../src/lib/http-client.js';

const NOW = new Date('2026-01-02T12:00:00.000Z');

function finding(input: Partial<Finding> & Pick<Finding, 'type' | 'strength' | 'effect' | 'message'>): Finding {
  return {
    id: `finding_${input.type}`,
    source: input.source ?? 'test',
    data: input.data ?? {},
    ...input
  };
}

async function seedDecision(input: {
  decision_id: string;
  run_id?: string;
  created_at?: string;
  verdict: DecisionRecord['verdict'];
  disposition: DecisionRecord['disposition'];
  findings?: Finding[];
  reasons?: string[];
  next_actions?: DecisionRecord['next_actions'];
  run_not_checked?: string[];
  run_summary?: string;
}): Promise<void> {
  const runId = input.run_id ?? `run_${input.decision_id}`;
  const createdAt = input.created_at ?? '2026-01-02T00:00:00.000Z';
  await putDecisionRecord({
    decision_id: input.decision_id,
    run_id: runId,
    created_at: createdAt,
    target: {
      input_repo: 'owner/repo',
      canonical_repo: 'owner/repo',
      issue_number: 123,
      issue_url: 'https://github.com/owner/repo/issues/123'
    },
    verdict: input.verdict,
    disposition: input.disposition,
    findings: input.findings ?? [],
    reasons: input.reasons ?? [],
    signals: [],
    next_actions: input.next_actions ?? []
  });
  await putRunRecord({
    run_id: runId,
    command: 'check',
    generated_at: createdAt,
    summary: input.run_summary ?? 'stored check summary',
    target: { repo: 'owner/repo', issue_number: 123 },
    decision_id: input.decision_id,
    checked: ['linked_work', 'contrib_policy'],
    not_checked: input.run_not_checked ?? ['store brief does not re-query GitHub']
  });
}

async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
  return { code, stdout, stderr };
}

async function callMcpTool(name: string, args: Record<string, unknown>) {
  const server = createMcpServer();
  const client = new Client({ name: 'gitworthy-brief-test', version: '0.1.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    return JSON.parse((result.content as Array<{ type: string; text: string }>)[0].text) as Record<string, unknown>;
  } finally {
    await client.close();
    await server.close();
  }
}

describe('brief generation (GW-020)', () => {
  let storeDir: string;
  let previousStore: string | undefined;

  beforeEach(async () => {
    storeDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-brief-'));
    previousStore = process.env.GITWORTHY_STORE_DIR;
    process.env.GITWORTHY_STORE_DIR = storeDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousStore === undefined) delete process.env.GITWORTHY_STORE_DIR;
    else process.env.GITWORTHY_STORE_DIR = previousStore;
    await rm(storeDir, { recursive: true, force: true }).catch(() => undefined);
  });

  it('renders golden fixtures for ACT, VERIFY, SKIP, claim_first, land_only, crowded, and blocked', async () => {
    const cases: Array<Parameters<typeof seedDecision>[0]> = [
      {
        decision_id: 'decision_act',
        verdict: 'ACT',
        disposition: 'greenfield',
        reasons: ['no blocking evidence found']
      },
      {
        decision_id: 'decision_verify',
        verdict: 'VERIFY',
        disposition: 'review',
        findings: [finding({ type: 'branch_match', strength: 'heuristic', effect: 'verify', message: 'Matching branch name found.' })],
        reasons: ['branch_scan: in_flight']
      },
      {
        decision_id: 'decision_skip',
        verdict: 'SKIP',
        disposition: 'blocked',
        findings: [finding({ type: 'released_fix', strength: 'definitive', effect: 'block', message: 'Published artifact already contains the fix.' })],
        reasons: ['definitive/block: release contains fix']
      },
      {
        decision_id: 'decision_claim',
        verdict: 'VERIFY',
        disposition: 'claim_first',
        findings: [finding({ type: 'claim_required', strength: 'definitive', effect: 'verify', message: 'Claim before opening a PR.' })],
        next_actions: [{ kind: 'coordinate', message: 'Request assignment before work.' }]
      },
      {
        decision_id: 'decision_land',
        verdict: 'SKIP',
        disposition: 'land_only',
        findings: [
          finding({ type: 'linked_pr_open', strength: 'definitive', effect: 'block', message: 'PR #7 explicitly closes the issue.', url: 'https://github.com/owner/repo/pull/7', data: { number: 7 } }),
          finding({ type: 'competing_open_closer', strength: 'corroborated', effect: 'inform', message: 'PR #8 also closes the issue.', url: 'https://github.com/owner/repo/pull/8', data: { number: 8, primary: 7 } })
        ],
        next_actions: [{ kind: 'land', message: 'LAND #7.' }]
      },
      {
        decision_id: 'decision_crowded',
        verdict: 'VERIFY',
        disposition: 'crowded',
        findings: [finding({ type: 'linked_pr_closed', strength: 'definitive', effect: 'verify', message: 'Prior PR was closed unmerged.', data: { prior_attempt: true } })]
      },
      {
        decision_id: 'decision_blocked_policy',
        verdict: 'VERIFY',
        disposition: 'blocked',
        findings: [finding({ type: 'no_pr_path', strength: 'definitive', effect: 'verify', message: 'Repository does not accept pull requests.', url: 'https://github.com/owner/repo/blob/main/CONTRIBUTING.md' })]
      }
    ];

    for (const item of cases) await seedDecision(item);

    const golden = [];
    for (const item of cases) {
      const brief = await generateBrief({ decision_id: item.decision_id }, { now: NOW });
      golden.push({
        id: item.decision_id,
        verdict: brief.verdict,
        disposition: brief.disposition,
        findings: brief.ranked_findings.map((entry) => `${entry.strength}:${entry.type}`),
        policy: brief.contribution_policy.map((entry) => entry.type),
        claims: brief.claim_requirements.map((entry) => entry.type),
        linked: brief.linked_work.map((entry) => entry.type),
        prior: brief.prior_attempts.map((entry) => entry.type),
        stops: brief.stop_conditions
      });
    }

    expect(golden).toMatchInlineSnapshot(`
      [
        {
          "claims": [],
          "disposition": "greenfield",
          "findings": [],
          "id": "decision_act",
          "linked": [],
          "policy": [],
          "prior": [],
          "stops": [],
          "verdict": "ACT",
        },
        {
          "claims": [],
          "disposition": "review",
          "findings": [
            "heuristic:branch_match",
          ],
          "id": "decision_verify",
          "linked": [],
          "policy": [],
          "prior": [],
          "stops": [],
          "verdict": "VERIFY",
        },
        {
          "claims": [],
          "disposition": "blocked",
          "findings": [
            "definitive:released_fix",
          ],
          "id": "decision_skip",
          "linked": [],
          "policy": [],
          "prior": [],
          "stops": [
            "Stop: stored decision contains definitive blocking evidence.",
            "Stop until the blocking repository or release condition changes.",
          ],
          "verdict": "SKIP",
        },
        {
          "claims": [
            "claim_required",
          ],
          "disposition": "claim_first",
          "findings": [
            "definitive:claim_required",
          ],
          "id": "decision_claim",
          "linked": [],
          "policy": [
            "claim_required",
          ],
          "prior": [],
          "stops": [
            "Stop before opening a PR until assignment or claim protocol is satisfied.",
          ],
          "verdict": "VERIFY",
        },
        {
          "claims": [],
          "disposition": "land_only",
          "findings": [
            "definitive:linked_pr_open",
            "corroborated:competing_open_closer",
          ],
          "id": "decision_land",
          "linked": [
            "linked_pr_open",
            "competing_open_closer",
          ],
          "policy": [],
          "prior": [],
          "stops": [
            "Stop: stored decision contains definitive blocking evidence.",
            "Do not open parallel implementation work; inspect or help land the cited PR.",
          ],
          "verdict": "SKIP",
        },
        {
          "claims": [],
          "disposition": "crowded",
          "findings": [
            "definitive:linked_pr_closed",
          ],
          "id": "decision_crowded",
          "linked": [],
          "policy": [],
          "prior": [
            "linked_pr_closed",
          ],
          "stops": [
            "Stop and review linked work, referenced commits, and prior attempts before investing.",
          ],
          "verdict": "VERIFY",
        },
        {
          "claims": [],
          "disposition": "blocked",
          "findings": [
            "definitive:no_pr_path",
          ],
          "id": "decision_blocked_policy",
          "linked": [],
          "policy": [
            "no_pr_path",
          ],
          "prior": [],
          "stops": [
            "Stop until the blocking repository or release condition changes.",
          ],
          "verdict": "VERIFY",
        },
      ]
    `);
  });

  it('is deterministic across repeated generation and validates the brief schema', async () => {
    await seedDecision({
      decision_id: 'decision_deterministic',
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [finding({ type: 'needs_repro', strength: 'heuristic', effect: 'verify', message: 'Needs repro.', data: { path: 'src/repro.ts', symbol: 'reproduceBug' } })]
    });

    const first = await generateBrief({ decision_id: 'decision_deterministic' }, { now: NOW });
    const second = await generateBrief({ decision_id: 'decision_deterministic' }, { now: NOW });

    expect(second).toEqual(first);
    expect(renderBrief(first, 'json')).toBe(renderBrief(second, 'json'));
    expect(BriefSchema.parse(first).named_paths_symbols).toEqual({ paths: ['src/repro.ts'], symbols: ['reproduceBug'] });
  });

  it('warns on stale decisions and fails cleanly for missing records', async () => {
    await seedDecision({
      decision_id: 'decision_stale',
      created_at: '2026-01-01T00:00:00.000Z',
      verdict: 'ACT',
      disposition: 'greenfield'
    });

    const brief = await generateBrief({ decision_id: 'decision_stale' }, { now: NOW });
    expect(brief.staleness_warning).toMatchObject({ stale: true, threshold_hours: 24, age_hours: 36, recommend: 'recheck' });
    expect(brief.next_actions[0]).toMatchObject({ kind: 'recheck' });
    await expect(generateBrief({ decision_id: 'missing' }, { now: NOW })).rejects.toMatchObject({ code: 'store_not_found' });
  });

  it('orders evidence by finding strength and preserves URLs', async () => {
    await seedDecision({
      decision_id: 'decision_urls',
      verdict: 'VERIFY',
      disposition: 'review',
      findings: [
        finding({ type: 'branch_match', strength: 'heuristic', effect: 'verify', message: 'Branch.', url: 'https://example.test/heuristic' }),
        finding({ type: 'linked_pr_open', strength: 'definitive', effect: 'block', message: 'PR.', url: 'https://example.test/definitive' }),
        finding({ type: 'competing_open_closer', strength: 'corroborated', effect: 'inform', message: 'Sibling.', url: 'https://example.test/corroborated' })
      ]
    });
    await putOutcomeEvent({
      event_id: 'outcome_url',
      decision_id: 'decision_urls',
      run_id: 'run_decision_urls',
      target: { repo: 'owner/repo', issue_number: 123 },
      event: 'comment_posted',
      occurred_at: '2026-01-02T01:00:00.000Z',
      source: 'test',
      data: { url: 'https://example.test/outcome' },
      notes: 'commented'
    });

    const brief = await generateBrief({ decision_id: 'decision_urls' }, { now: NOW });
    expect(brief.ranked_findings.map((entry) => entry.type)).toEqual(['linked_pr_open', 'competing_open_closer', 'branch_match']);
    expect(brief.evidence_urls).toEqual([
      'https://github.com/owner/repo/issues/123',
      'https://example.test/definitive',
      'https://example.test/corroborated',
      'https://example.test/heuristic',
      'https://example.test/outcome'
    ]);
  });

  it('does not call GitHub or HTTP clients while generating a brief', async () => {
    await seedDecision({ decision_id: 'decision_no_network', verdict: 'ACT', disposition: 'greenfield' });
    const githubJson = vi.spyOn(github, 'githubJson');
    const fetchRaw = vi.spyOn(github, 'fetchRaw');
    const createHttpClient = vi.spyOn(httpClient, 'createHttpClient');

    await generateBrief({ decision_id: 'decision_no_network' }, { now: NOW });

    expect(githubJson).not.toHaveBeenCalled();
    expect(fetchRaw).not.toHaveBeenCalled();
    expect(createHttpClient).not.toHaveBeenCalled();
  });

  it('includes optional config/profile provenance and omits it with a not_checked note on config errors', async () => {
    await seedDecision({ decision_id: 'decision_config', verdict: 'ACT', disposition: 'greenfield' });
    const configPath = path.join(storeDir, 'config.json');
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, `${JSON.stringify({
      schema_version: '1.0-draft.1',
      profile: { languages: ['typescript'], topics: ['mcp'] },
      manifest: { schema_version: '1.0-draft.1', repos: ['owner/repo'], package_mappings: [{ repo: 'owner/repo', npm_package: 'pkg' }] }
    }, null, 2)}\n`, 'utf8');

    const brief = await generateBrief({ decision_id: 'decision_config', config_path: configPath }, { now: NOW });
    expect(brief.config_provenance?.profile?.value).toEqual({ languages: ['typescript'], topics: ['mcp'] });
    expect(brief.config_provenance?.profile?.provenance?.layer).toBe('user');
    expect(brief.config_provenance?.manifest?.summary).toEqual({ repos: 1, orgs: 0, package_mappings: 1 });

    const badConfigPath = path.join(storeDir, 'bad-config.json');
    await writeFile(badConfigPath, '{"schema_version":"0.0.0"}\n', 'utf8');
    const badConfigBrief = await generateBrief({ decision_id: 'decision_config', config_path: badConfigPath }, { now: NOW });
    expect(badConfigBrief.config_provenance).toBeUndefined();
    expect(badConfigBrief.checks_not_completed.some((item) => item.includes('config/profile provenance not checked'))).toBe(true);
  });

  it('returns matching JSON through CLI and MCP', async () => {
    await seedDecision({
      decision_id: 'decision_parity',
      created_at: '2099-01-01T00:00:00.000Z',
      verdict: 'ACT',
      disposition: 'greenfield',
      run_not_checked: ['future fixture']
    });

    const cli = await run(['brief', 'decision_parity', '--format', 'json']);
    expect(cli.code).toBe(0);
    const cliPayload = JSON.parse(cli.stdout);
    const mcpPayload = await callMcpTool('brief_show', { decision_id: 'decision_parity' });

    expect(cliPayload).toEqual(mcpPayload);
  });
});
