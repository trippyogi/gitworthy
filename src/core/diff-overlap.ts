/** Diff-level claim comparison heuristics (GW-041 / C2). VERIFY-capped; no tree-sitter. */

import type { ContentionClaim, EquivalenceClass } from '../contracts/contention.js';

const SAME_CHANGE_SYMBOL_OVERLAP = 0.5;
const SAME_CHANGE_PATH_OVERLAP = 0.5;

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const item of a) if (b.has(item)) inter += 1;
  return inter / new Set([...a, ...b]).size;
}

export function classifyPair(
  left: ContentionClaim,
  right: ContentionClaim
): { relation: 'same_change' | 'overlapping' | 'distinct'; shared_paths: string[]; shared_symbols: string[]; low_confidence: boolean } {
  const leftPaths = new Set(left.touched_paths);
  const rightPaths = new Set(right.touched_paths);
  const leftSymbols = new Set(left.touched_symbols);
  const rightSymbols = new Set(right.touched_symbols);
  const shared_paths = [...leftPaths].filter((path) => rightPaths.has(path)).sort();
  const shared_symbols = [...leftSymbols].filter((symbol) => rightSymbols.has(symbol)).sort();
  const pathScore = jaccard(leftPaths, rightPaths);
  const symbolScore = jaccard(leftSymbols, rightSymbols);
  const low_confidence = left.touched_paths.length === 0 || right.touched_paths.length === 0
    || left.diff_stat?.truncated === true
    || right.diff_stat?.truncated === true;

  if (shared_paths.length === 0 && shared_symbols.length === 0) {
    return { relation: 'distinct', shared_paths, shared_symbols, low_confidence };
  }

  const leftSubset = shared_paths.length === leftPaths.size && leftPaths.size > 0 && leftPaths.size < rightPaths.size;
  const rightSubset = shared_paths.length === rightPaths.size && rightPaths.size > 0 && rightPaths.size < leftPaths.size;
  if (
    (symbolScore >= SAME_CHANGE_SYMBOL_OVERLAP && pathScore >= SAME_CHANGE_PATH_OVERLAP)
    || (shared_symbols.length > 0 && pathScore >= 0.8)
  ) {
    return { relation: 'same_change', shared_paths, shared_symbols, low_confidence };
  }
  if (leftSubset || rightSubset || pathScore >= 0.25 || symbolScore >= 0.25) {
    return { relation: 'overlapping', shared_paths, shared_symbols, low_confidence };
  }
  return { relation: 'distinct', shared_paths, shared_symbols, low_confidence };
}

export function buildEquivalenceClasses(claims: ContentionClaim[]): EquivalenceClass[] {
  const openOrRecent = claims.filter((claim) => claim.state === 'open' || claim.merged || claim.state === 'closed');
  if (openOrRecent.length === 0) return [];

  const parent = new Map<number, number>();
  const find = (n: number): number => {
    const p = parent.get(n) ?? n;
    if (p !== n) {
      const root = find(p);
      parent.set(n, root);
      return root;
    }
    return n;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const claim of openOrRecent) parent.set(claim.pr, claim.pr);

  const pairNotes = new Map<string, ReturnType<typeof classifyPair>>();
  for (let i = 0; i < openOrRecent.length; i += 1) {
    for (let j = i + 1; j < openOrRecent.length; j += 1) {
      const left = openOrRecent[i]!;
      const right = openOrRecent[j]!;
      const result = classifyPair(left, right);
      pairNotes.set(`${left.pr}:${right.pr}`, result);
      if (result.relation === 'same_change' || result.relation === 'overlapping') {
        union(left.pr, right.pr);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (const claim of openOrRecent) {
    const root = find(claim.pr);
    const list = groups.get(root) ?? [];
    list.push(claim.pr);
    groups.set(root, list);
  }

  const byPr = new Map(openOrRecent.map((claim) => [claim.pr, claim]));
  const classes: EquivalenceClass[] = [];
  let index = 1;
  for (const prs of groups.values()) {
    const members = prs.map((pr) => byPr.get(pr)!).filter(Boolean);
    const shared_paths = intersectAll(members.map((member) => member.touched_paths));
    const shared_symbols = intersectAll(members.map((member) => member.touched_symbols));
    let relation: EquivalenceClass['relation'] = 'distinct';
    let low_confidence = members.some((member) => member.diff_stat?.truncated === true || member.touched_paths.length === 0);
    if (members.length >= 2) {
      relation = 'overlapping';
      for (let i = 0; i < members.length; i += 1) {
        for (let j = i + 1; j < members.length; j += 1) {
          const note = pairNotes.get(`${members[i]!.pr}:${members[j]!.pr}`)
            ?? pairNotes.get(`${members[j]!.pr}:${members[i]!.pr}`);
          if (note?.relation === 'same_change') relation = 'same_change';
          if (note?.low_confidence) low_confidence = true;
        }
      }
    }
    const representative = pickRepresentative(members);
    classes.push({
      id: `eq-${index}`,
      relation,
      prs: members.map((member) => member.pr).sort((a, b) => a - b),
      representative,
      shared_paths,
      shared_symbols,
      low_confidence,
      note: members.length === 1 ? 'single claim' : undefined
    });
    index += 1;
  }
  return classes.sort((a, b) => a.representative - b.representative);
}

function intersectAll(lists: string[][]): string[] {
  if (lists.length === 0) return [];
  let set = new Set(lists[0]);
  for (const list of lists.slice(1)) {
    const next = new Set(list);
    set = new Set([...set].filter((item) => next.has(item)));
  }
  return [...set].sort();
}

/** Smallest diff that still touches the union of shared paths when available. */
function pickRepresentative(members: ContentionClaim[]): number {
  const scored = members.map((member) => {
    const adds = member.diff_stat?.additions ?? Number.POSITIVE_INFINITY;
    const dels = member.diff_stat?.deletions ?? 0;
    const files = member.diff_stat?.changed_files ?? member.touched_paths.length;
    return { pr: member.pr, size: adds + dels + files * 10 };
  });
  scored.sort((a, b) => a.size - b.size || a.pr - b.pr);
  return scored[0]!.pr;
}

export function claimsSuperseded(claims: ContentionClaim[], classes: EquivalenceClass[]): boolean {
  const open = new Set(claims.filter((claim) => claim.state === 'open' && !claim.merged).map((claim) => claim.pr));
  const closed = new Set(claims.filter((claim) => claim.state === 'closed' && !claim.merged).map((claim) => claim.pr));
  if (open.size === 0 || closed.size === 0) return false;
  for (const eq of classes) {
    if (eq.relation === 'distinct') continue;
    const hasOpen = eq.prs.some((pr) => open.has(pr));
    const hasClosed = eq.prs.some((pr) => closed.has(pr));
    if (hasOpen && hasClosed) return true;
  }
  return false;
}
