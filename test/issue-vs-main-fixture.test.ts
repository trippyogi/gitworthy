import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issue_vs_main } from '../src/core/issue-vs-main.js';

let fixtureDir: string;

vi.mock('../src/lib/github.js', () => ({
  githubJson: vi.fn(async () => ({
    number: 49,
    title: 'Add FastAPI Python example',
    body: 'Please add the missing FastAPI example app.',
    state: 'open',
    labels: [],
    comments: 0,
    html_url: 'https://github.com/PostHog/context-mill/issues/49',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    closed_at: null
  }))
}));

vi.mock('../src/lib/git.js', () => ({
  shallowClone: vi.fn(async () => ({ dir: fixtureDir, cleanup: async () => undefined }))
}));

describe('issue_vs_main local fixture tree', () => {
  beforeEach(async () => {
    fixtureDir = await mkdtemp(path.join(tmpdir(), 'gitworthy-issue-fixture-'));
    await mkdir(path.join(fixtureDir, 'example-apps', 'fastapi', 'app'), { recursive: true });
    await mkdir(path.join(fixtureDir, 'example-apps', 'android'), { recursive: true });
    await writeFile(path.join(fixtureDir, 'example-apps', 'fastapi', 'app', 'main.py'), 'from fastapi import FastAPI\napp = FastAPI()\n');
    await writeFile(path.join(fixtureDir, 'example-apps', 'android', 'README.md'), 'Android example\n');
  });

  afterEach(async () => {
    await rm(fixtureDir, { recursive: true, force: true });
  });

  it('surfaces inferred example-apps/fastapi paths and emits shipped', async () => {
    const result = await issue_vs_main({ repo: 'PostHog/context-mill', issue_number: 49 });
    expect(JSON.stringify(result.evidence)).toContain('example-apps/fastapi');
    expect(result.signals).toContain('shipped');
  });
});
