/** Gap analysis against claiming PRs and optional local draft (GW-042 / C3). */

import type { ContentionClaim, ContentionGap, EquivalenceClass } from '../contracts/contention.js';

export type GapAnalysisInput = {
  issueTitle: string;
  issueBody: string | null | undefined;
  labels: string[];
  claims: ContentionClaim[];
  classes: EquivalenceClass[];
  /** Local draft touched symbols/paths for scope_excess. */
  draft?: { paths: string[]; symbols: string[] };
};

const STATED_ASK_HEADING = /^(#{1,6}\s*)?(proposed fix|expected behavior|expected behaviour|repro(duction)? steps)\b/im;
const RISK_LABEL = /risk-|security|compat|credential|migrat/i;

export function analyzeGaps(input: GapAnalysisInput): ContentionGap[] {
  const gaps: ContentionGap[] = [];
  const body = input.issueBody ?? '';
  const claiming = input.claims.filter((claim) => claim.state === 'open' || claim.merged);

  const anyTests = claiming.some((claim) => claim.touched_paths.some((path) => isTestPath(path)));
  if (claiming.length > 0 && !anyTests) {
    gaps.push({
      kind: 'test_coverage',
      summary: `none of {${claiming.map((claim) => claim.pr).join(', ')}} adds test files`,
      evidence: ['no touched paths matched test file heuristics'],
      prs: claiming.map((claim) => claim.pr),
      symbols: [],
      low_confidence: claiming.every((claim) => claim.touched_paths.length === 0)
    });
  }

  const askClauses = extractAskClauses(body);
  if (askClauses.length > 0 && claiming.length > 0) {
    const covered = askClauses.filter((clause) => claiming.some((claim) => coversClause(claim, clause)));
    const missing = askClauses.filter((clause) => !covered.includes(clause));
    if (missing.length > 0) {
      gaps.push({
        kind: 'stated_ask',
        summary: `stated ask clauses not clearly covered: ${missing.slice(0, 3).join('; ')}`,
        evidence: missing.slice(0, 5),
        prs: claiming.map((claim) => claim.pr),
        symbols: [],
        low_confidence: true
      });
    }
  }

  const riskLabels = input.labels.filter((label) => RISK_LABEL.test(label));
  if (riskLabels.length > 0 && claiming.length > 0) {
    const mentionsRisk = claiming.some((claim) => {
      const blob = `${claim.title}\n${claim.touched_paths.join('\n')}`.toLowerCase();
      return /compat|upgrade|migrat|nondisclos|redact|secret|credential/.test(blob)
        || claim.touched_paths.some((path) => /test/i.test(path));
    });
    if (!mentionsRisk) {
      gaps.push({
        kind: 'adjacent_risk',
        summary: `none of {${claiming.map((claim) => claim.pr).join(', ')}} clearly covers risk labels: ${riskLabels.join(', ')}`,
        evidence: riskLabels.map((label) => `label:${label}`),
        prs: claiming.map((claim) => claim.pr),
        symbols: [],
        low_confidence: true
      });
    }
  }

  if (input.draft) {
    const named = namedSymbolsFromIssue(body);
    const excessSymbols = input.draft.symbols.filter((symbol) => named.length > 0 && !named.includes(symbol));
    const excessPaths = input.draft.paths.filter((path) => {
      const base = path.split('/').pop() ?? path;
      return named.length > 0 && !named.some((symbol) => base.includes(symbol));
    });
    if (excessSymbols.length > 0 || (named.length > 0 && excessPaths.length > 0 && excessSymbols.length === 0)) {
      gaps.push({
        kind: 'scope_excess',
        summary: `draft touches symbols/paths outside the issue's stated ask: ${[...excessSymbols, ...excessPaths].slice(0, 6).join(', ')}`,
        evidence: ['compare draft symbols to identifiers named in Proposed Fix / issue body'],
        prs: [],
        symbols: excessSymbols.slice(0, 20),
        low_confidence: named.length === 0
      });
    }
  }

  if (claiming.length === 0 && askClauses.length > 0) {
    gaps.push({
      kind: 'uncovered_surface',
      summary: 'no claiming PRs; stated ask surface is entirely uncovered',
      evidence: askClauses.slice(0, 5),
      prs: [],
      symbols: [],
      low_confidence: false
    });
  }

  return gaps;
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__|spec)(\/|$)/i.test(path)
    || /\.(test|spec)\.[a-z]+$/i.test(path)
    || /_test\.[a-z]+$/i.test(path);
}

function extractAskClauses(body: string): string[] {
  if (!STATED_ASK_HEADING.test(body)) return [];
  const lines = body.split(/\r?\n/);
  const clauses: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (STATED_ASK_HEADING.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^#{1,6}\s+/.test(line)) break;
    if (!inSection) continue;
    const bullet = /^\s*[-*]\s+(.+)/.exec(line);
    if (bullet?.[1]) clauses.push(bullet[1].trim());
    else if (/^```/.test(line.trim())) clauses.push('fenced proposed fix block');
  }
  return [...new Set(clauses)].slice(0, 12);
}

function coversClause(claim: ContentionClaim, clause: string): boolean {
  const tokens = clause.toLowerCase().match(/[a-z_][a-z0-9_]{2,}/g) ?? [];
  if (tokens.length === 0) return false;
  const hay = `${claim.title} ${claim.touched_paths.join(' ')} ${claim.touched_symbols.join(' ')}`.toLowerCase();
  const hits = tokens.filter((token) => hay.includes(token)).length;
  return hits / tokens.length >= 0.4;
}

function namedSymbolsFromIssue(body: string): string[] {
  const names = new Set<string>();
  for (const match of body.matchAll(/`([A-Za-z_][\w]*)`/g)) names.add(match[1]!);
  for (const match of body.matchAll(/\b_([a-z][\w]*)\b/g)) names.add(`_${match[1]}`);
  return [...names].sort();
}
