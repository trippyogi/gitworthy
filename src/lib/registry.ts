import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extract } from 'tar';
import { GitworthyError } from '../core/envelope.js';

export type NpmMetadata = {
  name: string;
  'dist-tags': { latest: string };
  versions: Record<string, { version: string; dist: { tarball: string } }>;
  time: Record<string, string>;
};

export async function npmMetadata(packageName: string): Promise<NpmMetadata> {
  const url = `https://registry.npmjs.org/${encodeURIComponent(packageName).replace('%40', '@')}`;
  const response = await fetch(url, { headers: { 'user-agent': 'gitworthy' } });
  if (!response.ok) {
    throw new GitworthyError({ code: 'npm_metadata_error', message: `npm metadata request failed with status ${response.status}.`, status: response.status, not_checked: [`npm metadata was not checked for ${packageName}.`] });
  }
  return response.json() as Promise<NpmMetadata>;
}

export async function downloadAndExtractTarball(tarballUrl: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const response = await fetch(tarballUrl, { headers: { 'user-agent': 'gitworthy' } });
  if (!response.ok || !response.body) {
    throw new GitworthyError({ code: 'npm_tarball_error', message: `npm tarball request failed with status ${response.status}.`, status: response.status, not_checked: [`npm tarball was not checked at ${tarballUrl}.`] });
  }
  const dir = await mkdtemp(path.join(tmpdir(), 'gitworthy-npm-'));
  const buffer = Buffer.from(await response.arrayBuffer());
  const tarPath = path.join(dir, 'package.tgz');
  await import('node:fs/promises').then((fs) => fs.writeFile(tarPath, buffer));
  await extract({ file: tarPath, cwd: dir });
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function readPackageJsonFromClone(dir: string): Promise<{ version?: string; name?: string }> {
  return JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')) as { version?: string; name?: string };
}
