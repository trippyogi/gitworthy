import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { readCache, writeCache } from '../lib/cache.js';
import { downloadAndExtractTarball, npmMetadata, readPackageJsonFromClone } from '../lib/registry.js';
import { shallowClone } from '../lib/git.js';
import { createEnvelope, Envelope } from './envelope.js';
import { resolveProbeTemplate } from './probe-templates.js';

const TTL = 60 * 60 * 1000;

type Input = { repo: string; npm_package: string; probe?: { file_glob?: string; contains?: string }; probe_template?: string; force_refresh?: boolean };
type ProbeResult = { probe: { file_glob?: string; contains?: string }; matches: Array<Record<string, unknown>>; matched: boolean };

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  }));
  return nested.flat();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Match paths against simple globs with a double-star slash prefix plus optional star wildcards. */
export function globMatch(relative: string, pattern: string): boolean {
  const normalizedRelative = relative.replace(/\\/g, '/');
  const normalizedPattern = pattern.replace(/\\/g, '/');

  function matchPath(pathValue: string, pathPattern: string): boolean {
    if (!pathPattern.includes('*')) {
      return pathValue === pathPattern || pathValue.endsWith(`/${pathPattern}`) || pathValue.endsWith(pathPattern);
    }
    const regex = new RegExp(`(?:^|/)${pathPattern.split('*').map(escapeRegex).join('[^/]*')}$`);
    return regex.test(pathValue);
  }

  if (normalizedPattern.includes('**/')) {
    const idx = normalizedPattern.indexOf('**/');
    const prefix = normalizedPattern.slice(0, idx);
    const suffix = normalizedPattern.slice(idx + 3);
    return normalizedRelative.startsWith(prefix) && matchPath(normalizedRelative, suffix);
  }
  return matchPath(normalizedRelative, normalizedPattern.replace(/^\*\//, ''));
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
  const checked = [`fetched npm metadata for ${input.npm_package}`, `read package.json from ${input.repo}`];

  let effectiveProbe = input.probe;
  if (input.probe_template) {
    const resolved = resolveProbeTemplate(input.probe_template);
    if (resolved) {
      const merged = {
        file_glob: input.probe?.file_glob ?? resolved.file_glob,
        contains: input.probe?.contains ?? resolved.contains
      };
      const usedTemplateField =
        (Boolean(resolved.file_glob) && !input.probe?.file_glob) ||
        (Boolean(resolved.contains) && input.probe?.contains === undefined);
      effectiveProbe = (merged.file_glob || merged.contains) ? merged : undefined;
      if (usedTemplateField) {
        checked.push(`resolved probe_template "${input.probe_template}" to file_glob ${merged.file_glob ?? '(none)'}${merged.contains ? ` (contains: ${merged.contains})` : ''}`);
      }
    } else {
      not_checked.push(`probe_template "${input.probe_template}" is not a known template id; no probe was applied.`);
    }
  }

  try {
    const mainPackage = await readPackageJsonFromClone(clone.dir);
    evidence.push({ repo: input.repo, ref: 'main package.json', version: mainPackage.version, url: `https://github.com/${input.repo}/blob/main/package.json` });
    const latestMeta = metadata.versions[latest];
    evidence.push({ package: input.npm_package, version: latest, published_at: metadata.time[latest], url: `https://www.npmjs.com/package/${input.npm_package}/v/${latest}` });
    let probe: ProbeResult | undefined;
    const contentProbe = Boolean(effectiveProbe?.contains);
    const probeRequested = Boolean(effectiveProbe?.contains || effectiveProbe?.file_glob);
    if (probeRequested && latestMeta?.dist?.tarball) {
      const tarball = await downloadAndExtractTarball(latestMeta.dist.tarball);
      try {
        const root = path.join(tarball.dir, 'package');
        const files = await walk(root);
        const matches = [] as Array<Record<string, unknown>>;
        for (const file of files) {
          const relative = path.relative(root, file).replace(/\\/g, '/');
          if (effectiveProbe?.file_glob && !globMatch(relative, effectiveProbe.file_glob)) continue;
          if (contentProbe) {
            const text = await readFile(file, 'utf8').catch(() => '');
            if (text.includes(effectiveProbe!.contains!)) matches.push({ path: relative, context: contextLines(text, effectiveProbe!.contains!) });
          } else {
            matches.push({ path: relative });
          }
        }
        probe = { probe: effectiveProbe!, matches, matched: matches.length > 0 };
        evidence.push(probe);
        if (!probe.matched) {
          evidence.push({ note: contentProbe
            ? 'probe ran; no issue-specific match found in the published artifact'
            : 'probe ran; no files matched the probe file_glob in the published artifact' });
        }
      } finally {
        await tarball.cleanup();
      }
    } else if (probeRequested) {
      not_checked.push('Issue-specific artifact contents were not checked because the npm tarball was unavailable.');
    } else {
      not_checked.push('Issue-specific artifact contents were not checked because no probe was provided.');
    }
    const latestPublished = metadata.time[latest] ? `, published ${metadata.time[latest].slice(0, 10)}` : '';
    const probeMatched = probe?.matched === true;
    // Existence-only probes (file_glob without contains) are evidence, not enough for released_fix.
    const releasedFix = mainPackage.version === latest && contentProbe && probeMatched;
    const verdict_summary = mainPackage.version === latest ? `main and npm are equal at ${latest}${latestPublished}.` : `main package version ${mainPackage.version ?? 'unknown'} differs from npm latest ${latest}${latestPublished}.`;
    const envelope = createEnvelope({ verdict_summary, evidence, signals: releasedFix ? ['released_fix'] : [], checked, not_checked, cached: false, fetched_at });
    await writeCache('release_gap', input, envelope, fetched_at);
    return envelope;
  } finally {
    await clone.cleanup();
  }
}
