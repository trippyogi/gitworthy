/** Swarm-risk prediction for zero-claim (or lightly claimed) issues (GW-042 / C4). */

import type { ContentionPosture, SwarmRisk } from '../contracts/contention.js';

const PROPOSED_FIX = /^(#{1,6}\s*)?(proposed fix|suggested fix|patch)\b/im;

export type SwarmRiskInput = {
  issueBody: string | null | undefined;
  labels: string[];
  issueCreatedAt: string;
  claimCount: number;
  /** Repo median hours to first PR on labeled issues when known; optional. */
  medianHoursToFirstPr?: number;
};

export function assessSwarmRisk(input: SwarmRiskInput): {
  swarm_risk: SwarmRisk;
  posture: ContentionPosture;
  reasons: string[];
} {
  const reasons: string[] = [];
  const body = input.issueBody ?? '';
  const hasProposedFix = hasFencedProposedFix(body);
  if (hasProposedFix) reasons.push('issue contains a fenced code block under a Proposed Fix / patch heading');

  const helpWanted = input.labels.some((label) => /^(good first issue|help wanted)$/i.test(label));
  const ageHours = Math.max(0, (Date.now() - Date.parse(input.issueCreatedAt)) / 3_600_000);
  if (helpWanted && ageHours < 24) reasons.push('help-wanted / good-first-issue label younger than 24h');

  let swarm_risk: SwarmRisk = 'low';
  if (hasProposedFix || (helpWanted && ageHours < 24)) swarm_risk = 'high';
  else if (helpWanted || ageHours < 72) {
    swarm_risk = 'medium';
    if (!hasProposedFix) reasons.push(helpWanted ? 'help-wanted label present' : 'issue younger than 72h');
  }

  if (typeof input.medianHoursToFirstPr === 'number' && Number.isFinite(input.medianHoursToFirstPr)) {
    if (ageHours > input.medianHoursToFirstPr * 2 && input.claimCount === 0) {
      reasons.push('issue age exceeds 2× repo median time-to-first-PR with zero claims');
      if (swarm_risk === 'high') swarm_risk = 'medium';
    }
  }

  let posture: ContentionPosture = 'race';
  if (input.claimCount > 0 && swarm_risk !== 'low') posture = 'differentiate';
  else if (swarm_risk === 'high' && hasProposedFix && input.claimCount === 0) posture = 'race';
  else if (swarm_risk === 'low' && ageHours > 24 * 14) posture = 'defer';
  else if (swarm_risk === 'medium' && hasProposedFix) posture = 'differentiate';

  if (reasons.length === 0) reasons.push('no elevated swarm signals');
  return { swarm_risk, posture, reasons };
}

function hasFencedProposedFix(body: string): boolean {
  if (!PROPOSED_FIX.test(body)) return false;
  // Require a fenced block somewhere after a matching heading line.
  const lines = body.split(/\r?\n/);
  let afterHeading = false;
  for (const line of lines) {
    if (PROPOSED_FIX.test(line)) afterHeading = true;
    if (afterHeading && /^```/.test(line.trim())) return true;
  }
  return false;
}
