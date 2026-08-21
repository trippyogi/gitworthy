/** Multi-line human CLI renderers (GW-030). */

type Write = (text: string) => void;

type HumanResult = {
  command?: string;
  verdict?: string;
  disposition?: string;
  verdict_summary?: string;
  summary?: string;
  next_actions?: Array<{ kind?: string; message?: string }>;
  findings?: Array<{ type?: string; strength?: string; message?: string; url?: string; effect?: string }>;
  evidence?: Array<Record<string, unknown>>;
  checked?: string[];
  not_checked?: string[];
  metrics?: Record<string, unknown>;
  signals?: string[];
  capabilities?: Array<{ id?: string; status?: string; summary?: string; remediation?: string }>;
  items?: Array<Record<string, unknown>>;
  capacity?: { used?: Record<string, number>; limits?: Record<string, number>; confidence?: string };
};

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function findingLines(result: HumanResult): string[] {
  const fromFindings = (result.findings ?? [])
    .filter((item) => typeof item.message === 'string')
    .map((item) => {
      const strength = typeof item.strength === 'string' ? item.strength : 'heuristic';
      const type = typeof item.type === 'string' ? item.type : 'finding';
      const url = typeof item.url === 'string' ? ` · ${item.url}` : '';
      return `  ${strength} · ${type}: ${item.message}${url}`;
    });
  if (fromFindings.length > 0) return fromFindings.slice(0, 5);

  const evidenceFindings = (result.evidence ?? [])
    .filter((item) => item.kind === 'finding' || typeof item.type === 'string')
    .map((item) => {
      const strength = typeof item.strength === 'string' ? item.strength : 'heuristic';
      const type = typeof item.type === 'string' ? item.type : 'evidence';
      const message = typeof item.message === 'string' ? item.message : JSON.stringify(item).slice(0, 120);
      const url = typeof item.url === 'string' ? ` · ${item.url}` : '';
      return `  ${strength} · ${type}: ${message}${url}`;
    });
  return evidenceFindings.slice(0, 5);
}

function nextActionLines(result: HumanResult): string[] {
  const actions = result.next_actions ?? [];
  if (actions.length > 0) {
    return actions
      .map((item) => (typeof item.message === 'string' ? item.message : undefined))
      .filter((item): item is string => Boolean(item))
      .slice(0, 4)
      .map((line) => `  ${line}`);
  }
  // Doctor uses verdicts for exit codes; capability remediations are the action surface.
  if (result.command === 'doctor' || (result.capabilities && result.capabilities.length > 0)) {
    return [];
  }
  if (result.verdict === 'SKIP' && result.disposition === 'land_only') {
    return ['  Review or help land the cited open PR. Do not open a parallel implementation.'];
  }
  if (result.verdict === 'ACT') {
    return ['  Completed mandatory checks found no reason to stop; still re-check before a public action.'];
  }
  if (result.verdict === 'VERIFY') {
    return ['  Perform the named human verification steps before investing.'];
  }
  return [];
}

function bulletSection(title: string, lines: string[], empty = '  none'): string[] {
  return [title, ...(lines.length > 0 ? lines : [empty]), ''];
}

function metricsLines(metrics: Record<string, unknown> | undefined, verbose: boolean): string[] {
  if (!verbose || !metrics) return [];
  const parts: string[] = [];
  if (typeof metrics.duration_ms === 'number') parts.push(`duration=${Math.round(metrics.duration_ms)}ms`);
  if (typeof metrics.github_requests === 'number') parts.push(`github_requests=${metrics.github_requests}`);
  if (typeof metrics.cache_hits === 'number') parts.push(`cache_hits=${metrics.cache_hits}`);
  if (typeof metrics.github_retries === 'number' && metrics.github_retries > 0) parts.push(`retries=${metrics.github_retries}`);
  if (typeof metrics.git_commands === 'number' && metrics.git_commands > 0) parts.push(`git=${metrics.git_commands}`);
  if (metrics.budget_exhausted === true) parts.push('budget_exhausted');
  if (parts.length === 0) return [];
  return ['Counters', `  ${parts.join(' · ')}`, ''];
}

function portfolioLines(result: HumanResult): string[] | undefined {
  if (result.command !== 'portfolio' && result.command !== 'pr_scan') return undefined;
  const items = Array.isArray(result.items)
    ? result.items
    : Array.isArray((result as { opportunities?: Array<Record<string, unknown>> }).opportunities)
      ? (result as { opportunities: Array<Record<string, unknown>> }).opportunities
      : [];
  const lines = [
    result.command === 'portfolio' ? 'portfolio' : 'pr_scan',
    typeof result.verdict_summary === 'string' ? result.verdict_summary : (typeof result.summary === 'string' ? result.summary : ''),
    '',
    'Opportunities'
  ];
  if (items.length === 0) lines.push('  none');
  for (const item of items.slice(0, 12)) {
    const target = asRecord(item.target);
    const label = target.kind === 'pull_request'
      ? `${String(target.repo ?? '')}#pr${String(target.pr_number ?? '')}`
      : `${String(target.repo ?? '')}#${String(target.issue_number ?? '')}`;
    const mode = typeof item.primary_mode === 'string' ? item.primary_mode : typeof item.hint_mode === 'string' ? item.hint_mode : '?';
    const dispatch = typeof item.dispatch_state === 'string' ? item.dispatch_state : 'n/a';
    const score = typeof item.score === 'number' ? item.score.toFixed(2) : '?';
    const verdict = typeof item.verdict === 'string' ? ` verdict=${item.verdict}` : '';
    lines.push(`  ${mode} · ${dispatch} · ${score} · ${label}${verdict}`);
  }
  lines.push('');
  if (result.capacity) {
    const used = Object.entries(result.capacity.used ?? {}).map(([mode, count]) => `${mode}=${count}`).join(', ') || 'none';
    const limits = Object.entries(result.capacity.limits ?? {}).map(([mode, count]) => `${mode}=${count}`).join(', ') || 'none';
    lines.push('Capacity', `  used ${used}`, `  limits ${limits}`, `  confidence ${result.capacity.confidence ?? 'unknown'}`, '');
  }
  if (Array.isArray(result.not_checked) && result.not_checked.length > 0) {
    lines.push(...bulletSection('Not checked', result.not_checked.slice(0, 8).map((item) => `  ${item}`)));
  }
  return lines;
}

/** Render primary command results for humans. Falls back to one-line summary for unknown shapes. */
export function renderHuman(output: unknown, options: { verbose?: boolean } = {}): string {
  const result = asRecord(output) as HumanResult;
  const portfolio = portfolioLines(result);
  if (portfolio) {
    while (portfolio.length > 0 && portfolio[portfolio.length - 1] === '') portfolio.pop();
    return `${portfolio.join('\n')}\n`;
  }
  const verdict = typeof result.verdict === 'string' ? result.verdict : undefined;
  const disposition = typeof result.disposition === 'string' ? result.disposition : undefined;
  const summary = typeof result.verdict_summary === 'string'
    ? result.verdict_summary
    : typeof result.summary === 'string'
      ? result.summary
      : undefined;

  if (!summary && !verdict) {
    return `${JSON.stringify(output)}\n`;
  }

  const headline = [verdict, disposition].filter(Boolean).join(' · ') || (typeof result.command === 'string' ? result.command : 'result');
  const lines: string[] = [
    headline,
    summary ?? '',
    ''
  ];

  const capabilities = (result.capabilities ?? [])
    .filter((item) => typeof item.id === 'string' && typeof item.status === 'string')
    .map((item) => {
      const summary = typeof item.summary === 'string' ? item.summary : '';
      const remediation = typeof item.remediation === 'string' && item.status !== 'pass'
        ? ` → ${item.remediation}`
        : '';
      return `  ${item.status} · ${item.id}: ${summary}${remediation}`;
    });
  if (capabilities.length > 0) {
    lines.push(...bulletSection('Capabilities', capabilities));
    const remediations = (result.capabilities ?? [])
      .filter((item) => item.status && item.status !== 'pass' && item.status !== 'skipped' && typeof item.remediation === 'string')
      .map((item) => `  ${item.id}: ${item.remediation}`);
    if (remediations.length > 0) lines.push(...bulletSection('Remediation', remediations));
  }

  const next = nextActionLines(result);
  if (next.length > 0) lines.push(...bulletSection('Next', next));

  const evidence = findingLines(result);
  if (evidence.length > 0) lines.push(...bulletSection('Evidence', evidence));

  if (capabilities.length === 0 && Array.isArray(result.checked) && result.checked.length > 0) {
    lines.push(...bulletSection('Checked', result.checked.slice(0, 12).map((item) => `  ${item}`)));
  }
  if (Array.isArray(result.not_checked) && result.not_checked.length > 0) {
    lines.push(...bulletSection('Not checked', result.not_checked.slice(0, 12).map((item) => `  ${item}`)));
  }

  lines.push(...metricsLines(result.metrics, options.verbose === true));

  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

export function progress(write: Write, quiet: boolean, message: string): void {
  if (quiet) return;
  write(`${message}\n`);
}
