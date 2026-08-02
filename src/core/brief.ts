import { BriefSchema, BRIEF_RENDERING_VERSION, BRIEF_SCHEMA_VERSION, type Brief, type BriefFormat, type BriefInput } from '../contracts/brief.js';
import type { Finding } from '../contracts/findings.js';
import type { OutcomeEvent } from '../contracts/outcomes.js';
import type { DecisionRecord, RunRecord } from '../contracts/store.js';
import { loadEffectiveConfig } from '../lib/config.js';
import { listOutcomes, showDecision, showRun } from '../lib/store-query.js';
import { GitworthyError } from './envelope.js';

export const BRIEF_STALE_AFTER_HOURS = 24;

const STRENGTH_RANK: Record<Finding['strength'], number> = {
  definitive: 0,
  corroborated: 1,
  heuristic: 2
};

const LINKED_WORK_TYPES = new Set([
  'linked_pr_open',
  'competing_open_closer',
  'linked_pr_mention',
  'title_overlap_pr',
  'close_candidate',
  'assigned'
]);

const CONTRIBUTION_POLICY_TYPES = new Set(['no_pr_path', 'claim_required', 'assigned']);
const PRIOR_ATTEMPT_TYPES = new Set(['linked_pr_closed']);
const PRIOR_OUTCOME_EVENTS = new Set(['closed_unmerged', 'rejected', 'abandoned']);
const LINKED_OUTCOME_EVENTS = new Set(['comment_posted', 'pr_opened', 'merged', 'closed_unmerged']);

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function briefItemFromFinding(finding: Finding): { type: string; message: string; url?: string; data: Record<string, unknown> } {
  return {
    type: finding.type,
    message: finding.message,
    ...(finding.url ? { url: finding.url } : {}),
    data: finding.data
  };
}

function briefItemFromOutcome(outcome: OutcomeEvent): { type: string; message: string; url?: string; data: Record<string, unknown> } {
  const data = asRecord(outcome.data);
  return {
    type: outcome.event,
    message: outcome.notes || `Outcome ${outcome.event} recorded at ${outcome.occurred_at}.`,
    ...(typeof data.url === 'string' ? { url: data.url } : {}),
    data: { event_id: outcome.event_id, occurred_at: outcome.occurred_at, source: outcome.source, ...data }
  };
}

function rankFindings(findings: Finding[]): Finding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort((left, right) => STRENGTH_RANK[left.finding.strength] - STRENGTH_RANK[right.finding.strength] || left.index - right.index)
    .map((item) => item.finding);
}

function collectUrls(value: unknown, output: string[] = []): string[] {
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectUrls(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const child of Object.values(value as Record<string, unknown>)) collectUrls(child, output);
  }
  return output;
}

function collectNamedValues(value: unknown, output: { paths: string[]; symbols: string[] } = { paths: [], symbols: [] }, key = ''): { paths: string[]; symbols: string[] } {
  if (typeof value === 'string') {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('path')
      || lowerKey.includes('file')
      || /(?:^|[./])[\w.-]+\/[\w./-]+$/.test(value)
      || /\.[A-Za-z0-9]{1,8}$/.test(value)
    ) {
      output.paths.push(value);
    }
    if (lowerKey.includes('symbol') || lowerKey.includes('function') || lowerKey.includes('class') || lowerKey.includes('method')) {
      output.symbols.push(value);
    }
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectNamedValues(item, output, key);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) collectNamedValues(child, output, childKey);
  }
  return output;
}

function makeSummary(decision: DecisionRecord, run: RunRecord | null): string {
  const target = `${decision.target.canonical_repo}#${decision.target.issue_number}`;
  const reason = decision.reasons[0] ?? run?.summary;
  return reason
    ? `${decision.verdict}/${decision.disposition} for ${target}: ${reason}`
    : `${decision.verdict}/${decision.disposition} for ${target}.`;
}

function stalenessFor(decision: DecisionRecord, run: RunRecord | null, now: Date): Brief['staleness_warning'] {
  const basis = run?.generated_at ?? decision.created_at;
  const ageMs = Math.max(0, now.getTime() - Date.parse(basis));
  const ageHours = Math.floor(ageMs / 3_600_000);
  const stale = ageHours >= BRIEF_STALE_AFTER_HOURS;
  return {
    stale,
    threshold_hours: BRIEF_STALE_AFTER_HOURS,
    age_hours: ageHours,
    basis,
    ...(stale
      ? {
        warning: `Stored decision is ${ageHours}h old; GitHub state may have changed.`,
        recommend: 'recheck' as const
      }
      : {})
  };
}

function stopConditions(decision: DecisionRecord, stale: boolean): string[] {
  const stops: string[] = [];
  if (decision.verdict === 'SKIP') stops.push('Stop: stored decision contains definitive blocking evidence.');
  if (decision.disposition === 'land_only') stops.push('Do not open parallel implementation work; inspect or help land the cited PR.');
  if (decision.disposition === 'claim_first') stops.push('Stop before opening a PR until assignment or claim protocol is satisfied.');
  if (decision.disposition === 'blocked') stops.push('Stop until the blocking repository or release condition changes.');
  if (decision.disposition === 'crowded') stops.push('Stop and review linked work, referenced commits, and prior attempts before investing.');
  if (stale) stops.push('Recheck before taking public action because the stored decision is stale.');
  return unique(stops);
}

function nextActions(decision: DecisionRecord, stale: boolean): DecisionRecord['next_actions'] {
  const actions = [...decision.next_actions];
  if (stale && !actions.some((action) => action.kind === 'recheck')) {
    actions.unshift({ kind: 'recheck', message: 'Run `gitworthy recheck owner/repo#issue` before claiming or implementing.' });
  }
  return actions;
}

async function configProvenance(decision: DecisionRecord, input: BriefInput, notChecked: string[]): Promise<Brief['config_provenance']> {
  try {
    const effective = await loadEffectiveConfig({
      cwd: input.cwd,
      userPath: input.config_path,
      input: { repo: decision.target.canonical_repo }
    });
    const manifest = effective.values.target_manifest;
    const profile = effective.values.skill_profile;
    if (!manifest && profile === undefined) {
      notChecked.push('config/profile provenance not included: no effective skill profile or target manifest is configured.');
      return undefined;
    }
    return {
      schema_version: effective.schema_version,
      ...(profile !== undefined ? {
        profile: {
          value: profile,
          provenance: effective.provenance.skill_profile
        }
      } : {}),
      ...(manifest ? {
        manifest: {
          path: effective.paths.manifest,
          provenance: effective.provenance.target_manifest ?? effective.provenance.manifest_path,
          summary: {
            repos: manifest.repos?.length ?? 0,
            orgs: manifest.orgs?.length ?? 0,
            package_mappings: manifest.package_mappings?.length ?? 0
          }
        }
      } : {}),
      loaded: effective.loaded
    };
  } catch (error) {
    notChecked.push(`config/profile provenance not checked: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export async function generateBrief(input: BriefInput, options: { now?: Date } = {}): Promise<Brief> {
  const decision = await showDecision(input.decision_id);
  if (!decision) {
    throw new GitworthyError({
      code: 'store_not_found',
      message: `Decision ${input.decision_id} was not found in the local store.`,
      not_checked: [`decision ${input.decision_id}`]
    });
  }

  const run = await showRun(decision.run_id);
  const outcomes = await listOutcomes({
    repo: decision.target.canonical_repo,
    issue_number: decision.target.issue_number
  });
  const rankedFindings = rankFindings(decision.findings);
  const checksNotCompleted = unique([
    ...(run?.not_checked ?? []),
    ...(run ? [] : [`run ${decision.run_id} was not found in the local store`])
  ]);
  const config = await configProvenance(decision, input, checksNotCompleted);
  const named = collectNamedValues(rankedFindings);
  const staleness = stalenessFor(decision, run, options.now ?? new Date());
  const evidenceUrls = unique([
    ...(decision.target.issue_url ? [decision.target.issue_url] : []),
    ...collectUrls(rankedFindings),
    ...collectUrls(outcomes)
  ]);

  return BriefSchema.parse({
    brief_schema_version: BRIEF_SCHEMA_VERSION,
    rendering_version: BRIEF_RENDERING_VERSION,
    command: 'brief',
    target: decision.target,
    verdict: decision.verdict,
    disposition: decision.disposition,
    summary: makeSummary(decision, run),
    source_records: {
      decision_id: decision.decision_id,
      run_id: decision.run_id,
      run_found: Boolean(run),
      outcome_ids: outcomes.map((outcome) => outcome.event_id)
    },
    decision_created_at: decision.created_at,
    ...(run?.generated_at ? { run_generated_at: run.generated_at } : {}),
    ranked_findings: rankedFindings,
    contribution_policy: rankedFindings.filter((finding) => CONTRIBUTION_POLICY_TYPES.has(finding.type)).map(briefItemFromFinding),
    claim_requirements: rankedFindings.filter((finding) => finding.type === 'claim_required' || finding.type === 'assigned').map(briefItemFromFinding),
    linked_work: [
      ...rankedFindings.filter((finding) => LINKED_WORK_TYPES.has(finding.type)).map(briefItemFromFinding),
      ...outcomes.filter((outcome) => LINKED_OUTCOME_EVENTS.has(outcome.event)).map(briefItemFromOutcome)
    ],
    prior_attempts: [
      ...rankedFindings.filter((finding) => PRIOR_ATTEMPT_TYPES.has(finding.type) || finding.data.prior_attempt === true).map(briefItemFromFinding),
      ...outcomes.filter((outcome) => PRIOR_OUTCOME_EVENTS.has(outcome.event)).map(briefItemFromOutcome)
    ],
    named_paths_symbols: { paths: unique(named.paths), symbols: unique(named.symbols) },
    checks_not_completed: checksNotCompleted,
    evidence_urls: evidenceUrls,
    next_actions: nextActions(decision, staleness.stale),
    stop_conditions: stopConditions(decision, staleness.stale),
    staleness_warning: staleness,
    ...(config ? { config_provenance: config } : {})
  });
}

function renderList(items: string[], empty = 'none'): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : `- ${empty}`;
}

function renderItems(items: Array<{ type: string; message: string; url?: string }>, empty = 'none'): string {
  if (items.length === 0) return `- ${empty}`;
  return items.map((item) => `- ${item.type}: ${item.message}${item.url ? ` (${item.url})` : ''}`).join('\n');
}

export function renderBrief(brief: Brief, format: BriefFormat): string {
  if (format === 'json') return `${JSON.stringify(brief, null, 2)}\n`;
  if (format === 'markdown') {
    return [
      `# Gitworthy brief: ${brief.target.canonical_repo}#${brief.target.issue_number}`,
      '',
      `- Verdict: ${brief.verdict}`,
      `- Disposition: ${brief.disposition}`,
      `- Decision: ${brief.source_records.decision_id}`,
      `- Run: ${brief.source_records.run_id}${brief.source_records.run_found ? '' : ' (missing)'}`,
      '',
      `## Summary`,
      '',
      brief.summary,
      '',
      `## Ranked findings`,
      '',
      renderItems(brief.ranked_findings),
      '',
      `## Next actions`,
      '',
      renderList(brief.next_actions.map((action) => `${action.kind}: ${action.message}`)),
      '',
      `## Stop conditions`,
      '',
      renderList(brief.stop_conditions),
      '',
      `## Checks not completed`,
      '',
      renderList(brief.checks_not_completed),
      '',
      `## Evidence URLs`,
      '',
      renderList(brief.evidence_urls),
      '',
      brief.staleness_warning.stale
        ? `> Stale: ${brief.staleness_warning.warning} Recommended action: recheck.`
        : `> Freshness: decision age ${brief.staleness_warning.age_hours}h (stale after ${brief.staleness_warning.threshold_hours}h).`,
      ''
    ].join('\n');
  }
  return [
    `Gitworthy brief for ${brief.target.canonical_repo}#${brief.target.issue_number}`,
    `${brief.verdict}/${brief.disposition}: ${brief.summary}`,
    `Decision: ${brief.source_records.decision_id} | Run: ${brief.source_records.run_id}${brief.source_records.run_found ? '' : ' (missing)'}`,
    '',
    'Ranked findings:',
    renderItems(brief.ranked_findings),
    '',
    'Next actions:',
    renderList(brief.next_actions.map((action) => `${action.kind}: ${action.message}`)),
    '',
    'Stop conditions:',
    renderList(brief.stop_conditions),
    '',
    'Checks not completed:',
    renderList(brief.checks_not_completed),
    '',
    'Evidence URLs:',
    renderList(brief.evidence_urls),
    '',
    brief.staleness_warning.stale
      ? `Stale warning: ${brief.staleness_warning.warning} Recommended action: recheck.`
      : `Freshness: decision age ${brief.staleness_warning.age_hours}h (stale after ${brief.staleness_warning.threshold_hours}h).`,
    ''
  ].join('\n');
}
