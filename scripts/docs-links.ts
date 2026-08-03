/** Fail if markdown links to missing local files (GW-033). */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const roots = ['README.md', 'SECURITY.md', 'SKILL.md', 'ROADMAP.md', 'CONTRIBUTING.md', 'docs', 'eval'];

function walk(entry: string, out: string[]): void {
  const full = path.join(root, entry);
  if (!existsSync(full)) return;
  const st = statSync(full);
  if (st.isDirectory()) {
    for (const name of readdirSync(full)) {
      if (name.startsWith('.')) continue;
      walk(path.join(entry, name), out);
    }
    return;
  }
  if (entry.endsWith('.md')) out.push(entry);
}

const files: string[] = [];
for (const entry of roots) walk(entry, files);

const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
const missing: string[] = [];

for (const file of files) {
  const text = readFileSync(path.join(root, file), 'utf8');
  const dir = path.dirname(file);
  let match: RegExpExecArray | null;
  while ((match = linkRe.exec(text))) {
    const target = match[2].trim();
    if (!target || target.startsWith('http://') || target.startsWith('https://') || target.startsWith('mailto:')) continue;
    if (target.startsWith('#')) continue;
    const bare = target.split('#')[0] ?? '';
    if (!bare) continue;
    const resolved = path.normalize(path.join(root, dir, bare));
    if (!existsSync(resolved)) {
      missing.push(`${file} -> ${target}`);
    }
  }
}

if (missing.length > 0) {
  console.error('Broken local markdown links:');
  for (const item of missing) console.error(`  ${item}`);
  process.exitCode = 1;
} else {
  console.log(`docs link check passed (${files.length} markdown files)`);
}
