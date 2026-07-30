import { githubJson, GithubIssue } from '../lib/github.js';
import { createEnvelope, Envelope } from './envelope.js';
import { jaccard, sharedErrorPhrase, tokens } from './text-sim.js';

const RELATED_LIMIT = 'lexical similarity only (token overlap + shared error phrases); no embeddings are used, so semantically related issues phrased with different vocabulary will be missed. Clustering uses at most one page of open issues (100) before applying limit, so siblings outside that window are not considered.';
const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const DEFAULT_MIN_SCORE = 0.35;
const MEMBER_DISPLAY_CAP = 15;
const TEXT_SLICE = 600;

type Input = {
  repo: string;
  issue_number?: number;
  label?: string;
  keywords?: string[];
  limit?: number;
  min_score?: number;
};

type ClusterMember = { number: number; title: string; url: string; state: string };

type RelatedClusterEvidence = {
  kind: 'related_cluster';
  id: number;
  size: number;
  score: number;
  members: ClusterMember[];
};

type SeedClusterEvidence = {
  kind: 'seed_cluster';
  issue_number: number;
  cluster_id: number;
  related: ClusterMember[];
};

function matchesKeywords(issue: GithubIssue, keywords: string[] | undefined): boolean {
  if (!keywords || keywords.length === 0) return true;
  const haystack = `${issue.title}\n${issue.body ?? ''}`.toLowerCase();
  return keywords.some((keyword) => haystack.includes(keyword.toLowerCase()));
}

function matchesLabel(issue: GithubIssue, label: string | undefined): boolean {
  if (!label) return true;
  return issue.labels.some((item) => item.name.toLowerCase() === label.toLowerCase());
}

function toMember(issue: GithubIssue): ClusterMember {
  return { number: issue.number, title: issue.title, url: issue.html_url, state: issue.state };
}

class UnionFind {
  private readonly parent: number[];

  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }

  find(index: number): number {
    while (this.parent[index] !== index) {
      this.parent[index] = this.parent[this.parent[index]];
      index = this.parent[index];
    }
    return index;
  }

  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

type Component = { nodes: GithubIssue[]; score: number };

function buildComponents(nodes: GithubIssue[], minScore: number): Component[] {
  const texts = nodes.map((issue) => `${issue.title} ${issue.body ?? ''}`.slice(0, TEXT_SLICE));
  const tokenSets = texts.map((text) => tokens(text));
  const unionFind = new UnionFind(nodes.length);
  const edges: Array<{ a: number; b: number; score: number }> = [];
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const jaccardScore = jaccard(tokenSets[i], tokenSets[j]);
      const phraseMatch = sharedErrorPhrase(texts[i], texts[j]);
      if (jaccardScore >= minScore || phraseMatch) {
        const score = Math.max(jaccardScore, phraseMatch ? 0.5 : 0);
        edges.push({ a: i, b: j, score });
        unionFind.union(i, j);
      }
    }
  }
  const rootScore = new Map<number, number>();
  for (const edge of edges) {
    const root = unionFind.find(edge.a);
    rootScore.set(root, Math.max(rootScore.get(root) ?? 0, edge.score));
  }
  const byRoot = new Map<number, GithubIssue[]>();
  for (let i = 0; i < nodes.length; i += 1) {
    const root = unionFind.find(i);
    const group = byRoot.get(root);
    if (group) group.push(nodes[i]);
    else byRoot.set(root, [nodes[i]]);
  }
  return Array.from(byRoot.entries()).map(([root, groupNodes]) => ({
    nodes: groupNodes,
    score: Number((rootScore.get(root) ?? 0).toFixed(3))
  }));
}

export async function related_cluster(input: Input): Promise<Envelope> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const minScore = input.min_score ?? DEFAULT_MIN_SCORE;
  const query = new URLSearchParams({ state: 'open', per_page: '100' });
  if (input.label) query.set('labels', input.label);
  const listed = await githubJson<GithubIssue[]>(`/repos/${input.repo}/issues?${query.toString()}`);
  const candidates = listed
    .filter((issue) => !('pull_request' in issue))
    .filter((issue) => matchesLabel(issue, input.label))
    .filter((issue) => matchesKeywords(issue, input.keywords))
    .slice(0, limit);

  const byNumber = new Map<number, GithubIssue>();
  for (const issue of candidates) byNumber.set(issue.number, issue);

  const checked: string[] = [
    `fetched open issues for ${input.repo}`,
    'excluded pull requests',
    input.label ? `filtered by label: ${input.label}` : 'no label filter requested',
    input.keywords?.length ? `filtered titles and bodies by keywords: ${input.keywords.join(', ')}` : 'no keyword filter requested',
    `considered up to ${limit} open candidate issue(s)`
  ];
  const not_checked: string[] = [RELATED_LIMIT];

  let seed: GithubIssue | undefined;
  if (input.issue_number !== undefined) {
    try {
      seed = await githubJson<GithubIssue>(`/repos/${input.repo}/issues/${input.issue_number}`);
      if (!byNumber.has(seed.number)) byNumber.set(seed.number, seed);
      checked.push(`fetched seed issue ${input.repo}#${input.issue_number} (included even if closed)`);
    } catch {
      not_checked.push(`seed issue ${input.repo}#${input.issue_number} was not checked because the fetch failed.`);
    }
  }

  const nodes = Array.from(byNumber.values());
  const components = buildComponents(nodes, minScore)
    .sort((a, b) => b.nodes.length - a.nodes.length || b.score - a.score)
    .map((component, index) => ({ ...component, id: index + 1 }));

  checked.push('tokenized title+body and built edges by Jaccard token overlap and shared error phrases', 'grouped issues into connected components (clusters)');

  const clusterEvidence: RelatedClusterEvidence[] = components
    .filter((component) => component.nodes.length >= 2)
    .map((component) => ({
      kind: 'related_cluster',
      id: component.id,
      size: component.nodes.length,
      score: component.score,
      members: [...component.nodes]
        .sort((a, b) => a.number - b.number)
        .slice(0, MEMBER_DISPLAY_CAP)
        .map(toMember)
    }));

  const evidence: Array<RelatedClusterEvidence | SeedClusterEvidence> = [...clusterEvidence];

  if (seed) {
    const seedComponent = components.find((component) => component.nodes.some((issue) => issue.number === seed!.number));
    const related = seedComponent
      ? [...seedComponent.nodes]
        .filter((issue) => issue.number !== seed!.number)
        .sort((a, b) => a.number - b.number)
        .slice(0, MEMBER_DISPLAY_CAP)
        .map(toMember)
      : [];
    evidence.push({
      kind: 'seed_cluster',
      issue_number: seed.number,
      cluster_id: seedComponent?.id ?? 0,
      related
    });
    checked.push(related.length > 0
      ? `found ${related.length} issue(s) related to seed ${input.repo}#${seed.number}`
      : `seed ${input.repo}#${seed.number} has no related issues above min_score ${minScore}`);
  }

  return createEnvelope({
    verdict_summary: `found ${clusterEvidence.length} related cluster${clusterEvidence.length === 1 ? '' : 's'} among ${nodes.length} issue${nodes.length === 1 ? '' : 's'}.`,
    evidence,
    signals: [],
    checked,
    not_checked,
    cached: false
  });
}
