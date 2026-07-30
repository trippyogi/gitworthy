const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'should', 'would', 'could', 'please', 'issue']);

export function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []).filter((token) => !STOP.has(token)));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = Array.from(a).filter((item) => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function sharedErrorPhrase(a: string, b: string): boolean {
  const quotedPhrases = (text: string) => Array.from(text.matchAll(/"([^"]{8,})"/g)).map((match) => match[1].toLowerCase());
  const lowerA = a.toLowerCase();
  const lowerB = b.toLowerCase();
  if (quotedPhrases(a).some((phrase) => lowerB.includes(phrase))) return true;
  if (quotedPhrases(b).some((phrase) => lowerA.includes(phrase))) return true;
  return lowerA.includes('npx is not available') && lowerB.includes('npx is not available');
}
