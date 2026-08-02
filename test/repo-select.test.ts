import { describe, expect, it } from 'vitest';
import { resolvePackageForRepo, selectRepos } from '../src/core/repo-select.js';

describe('selectRepos', () => {
  it('excludes archived/forked repos and prefers skill+activity over stars alone', () => {
    const { selected, meta } = selectRepos({
      maxRepos: 2,
      skill_profile: { languages: ['typescript'], topics: ['cli'] },
      repos: [
        { full_name: 'acme/starry', stargazers_count: 9000, language: 'Go', pushed_at: '2026-06-01T00:00:00Z' },
        { full_name: 'acme/fit', stargazers_count: 12, language: 'TypeScript', topics: ['cli'], pushed_at: '2026-07-01T00:00:00Z' },
        { full_name: 'acme/old', stargazers_count: 5, language: 'TypeScript', pushed_at: '2020-01-01T00:00:00Z' },
        { full_name: 'acme/archived', archived: true, stargazers_count: 100, pushed_at: '2026-07-01T00:00:00Z' },
        { full_name: 'acme/fork', fork: true, stargazers_count: 100, pushed_at: '2026-07-01T00:00:00Z' }
      ]
    });
    expect(selected.map((repo) => repo.full_name)).toEqual(['acme/fit', 'acme/starry']);
    expect(meta.rows.find((row) => row.repo === 'acme/archived')?.action).toBe('excluded');
    expect(meta.rows.find((row) => row.repo === 'acme/old')?.action).toBe('excluded');
  });

  it('honors include/exclude and package mappings', () => {
    const { selected, meta } = selectRepos({
      maxRepos: 5,
      org: 'acme',
      manifest: {
        schema_version: '1.0-draft.1',
        include: { repos: ['acme/kept'] },
        exclude: { repos: ['acme/blocked'] },
        package_mappings: [{ repo: 'acme/kept', npm_package: '@acme/kept' }]
      },
      repos: [
        { full_name: 'acme/kept', stargazers_count: 1, pushed_at: '2026-07-01T00:00:00Z' },
        { full_name: 'acme/blocked', stargazers_count: 99, pushed_at: '2026-07-01T00:00:00Z' },
        { full_name: 'acme/other', stargazers_count: 50, pushed_at: '2026-07-01T00:00:00Z' }
      ]
    });
    expect(selected.map((repo) => repo.full_name)).toEqual(['acme/kept']);
    expect(meta.package_mappings).toEqual([{ repo: 'acme/kept', npm_package: '@acme/kept' }]);
  });
});

describe('resolvePackageForRepo', () => {
  it('disables ambiguous global npm packages on multi-target manifests', () => {
    const result = resolvePackageForRepo('acme/a', {
      schema_version: '1.0-draft.1',
      repos: ['acme/a', 'acme/b']
    }, 'left-pad');
    expect(result.npm_package).toBeUndefined();
    expect(result.ambiguous).toBe(true);
    expect(result.warning).toMatch(/ambiguous global npm_package/);
  });
});
