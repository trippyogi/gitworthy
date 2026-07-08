const GENERIC_TERMS = new Set([
  'about', 'above', 'after', 'again', 'against', 'also', 'appear', 'appears', 'before', 'being', 'below', 'between', 'break', 'could', 'does', 'done', 'during', 'example', 'feature', 'fix', 'from', 'have', 'into', 'keep', 'local', 'make', 'more', 'need', 'needs', 'please', 'running', 'should', 'state', 'support', 'task', 'tasks', 'that', 'this', 'through', 'when', 'where', 'with', 'would', 'add', 'added', 'adding', 'issue', 'using'
]);

export function isGenericTerm(term: string): boolean {
  return GENERIC_TERMS.has(term.toLowerCase());
}

export function normalizeTerm(term: string): string {
  const lower = term.toLowerCase();
  if (lower.length > 4 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 4 && lower.endsWith('es')) return lower.slice(0, -2);
  if (lower.length > 4 && lower.endsWith('s')) return lower.slice(0, -1);
  return lower;
}

export function distinctiveTerms(text: string, limit = 20): string[] {
  const raw = text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? [];
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const word of raw) {
    const normalized = normalizeTerm(word);
    if (isGenericTerm(word) || isGenericTerm(normalized) || seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= limit) break;
  }
  return terms;
}
