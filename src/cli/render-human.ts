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

/** Render primary command results for humans. Falls back to one-line summary for unknown shapes. */
export function renderHuman(output: unknown, options: { verbose?: boolean } = {}): string {
  const result = asRecord(output) as HumanResult;
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

  const next = nextActionLines(result);
  if (next.length > 0) lines.push(...bulletSection('Next', next));

  const evidence = findingLines(result);
  if (evidence.length > 0) lines.push(...bulletSection('Evidence', evidence));

  if (Array.isArray(result.checked) && result.checked.length > 0) {
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
