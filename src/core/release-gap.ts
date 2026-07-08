import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCache, writeCache } from '../lib/cache.js';
import { downloadAndExtractTarball, npmMetadata, readPackageJsonFromClone } from '../lib/registry.js';
import { shallowClone } from '../lib/git.js';
import { createEnvelope, Envelope } from './envelope.js';

const TTL = 60 * 60 * 1000;

type Input = { repo: string; npm_package: string; probe?: { file_glob?: string; contains?: string }; force_refresh?: boolean };

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }));
  return nested.flat();
}

function globMatch(relative: string, pattern: string): boolean {
  if (pattern.includes('**/')) {
    const [prefix, suffix] = pattern.split('**/');
    return relative.startsWith(prefix) && relative.endsWith(suffix);
  }
  return relative === pattern || relative.endsWith(pattern.replace(/^\*\//, ''));
}

function contextLines(text: string, needle: string): string[] {
  const lines = text.split('\n');
  const index = lines.findIndex((line) => line.includes(needle));
  if (index < 0) return [];
  return lines.slice(Math.max(0, index - 3), Math.min(lines.length, index + 4));
}

export async function release_gap(input: Input): Promise<Envelope> {
  const cached = await readCache<Envelope>('release_gap', input, TTL, input.force_refresh);
  if (cached.hit) return { ...cached.value, cached: true, fetched_at: cached.fetched_at };
  const fetched_at = new Date().toISOString();
  const metadata = await npmMetadata(input.npm_package);
  const latest = metadata['dist-tags'].latest;
  const clone = await shallowClone(input.repo);
  const evidence: Array<Record<string, unknown>> = [];
  const not_checked = ['npm registry comparison only covers npm packages in v0.1.'];
  try {
    const mainPackage = await readPackageJsonFromClone(clone.dir);
    evidence.push({ repo: input.repo, ref: 'main package.json', version: mainPackage.version, url: `https://github.com/${input.repo}/blob/main/package.json` });
    const latestMeta = metadata.versions[latest];
    evidence.push({ package: input.npm_package, version: latest, published_at: metadata.time[latest], url: `https://www.npmjs.com/package/${input.npm_package}/v/${latest}` });
    if (input.probe?.contains && latestMeta?.dist?.tarball) {
      const tarball = await downloadAndExtractTarball(latestMeta.dist.tarball);
      try {
        const root = path.join(tarball.dir, 'package');
        const files = await walk(root);
        const matches = [] as Array<Record<string, unknown>>;
        for (const file of files) {
          const relative = path.relative(root, file);
          if (input.probe.file_glob && !globMatch(relative, input.probe.file_glob)) continue;
          const text = await readFile(file, 'utf8').catch(() => '');
          if (text.includes(input.probe.contains)) matches.push({ path: relative, context: contextLines(text, input.probe.contains) });
        }
        evidence.push({ probe: input.probe, matches });
      } finally {
        await tarball.cleanup();
      }
    } else {
      not_checked.push('tarball probe was not checked because no probe was provided.');
    }
    const latestPublished = metadata.time[latest] ? `, published ${metadata.time[latest].slice(0, 10)}` : '';
    const verdict_summary = mainPackage.version === latest ? `main and npm are equal at ${latest}${latestPublished}.` : `main package version ${mainPackage.version ?? 'unknown'} differs from npm latest ${latest}${latestPublished}.`;
    const envelope = createEnvelope({ verdict_summary, evidence, checked: [`fetched npm metadata for ${input.npm_package}`, `read package.json from ${input.repo}`], not_checked, cached: false, fetched_at });
    await writeCache('release_gap', input, envelope, fetched_at);
    return envelope;
  } finally {
    await clone.cleanup();
  }
}
