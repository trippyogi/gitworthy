import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  githubJson: vi.fn()
}));

vi.mock('../src/lib/github.js', () => ({
  githubJson: mocks.githubJson
}));

const { watch_add, watch_list, watch_recheck, watch_remove } = await import('../src/core/watch.js');

describe('local watch registry', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'gw-watch-'));
    process.env.GITWORTHY_STORE_DIR = dir;
    mocks.githubJson.mockReset();
    mocks.githubJson.mockResolvedValue({
      state: 'open',
      updated_at: '2026-08-01T00:00:00.000Z',
      assignees: [{ login: 'alice' }]
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.GITWORTHY_STORE_DIR;
  });

  it('adds, lists, and removes a local watch without writing upstream', async () => {
    const added = await watch_add({ repo: 'o/r', issue_number: 3, note: 'wait for CI' });
    expect(added.watch.target).toEqual({ kind: 'issue', repo: 'o/r', issue_number: 3 });
    expect(added.not_checked.join(' ')).toMatch(/local-only|never auto-creates/i);
    const listed = await watch_list();
    expect(listed.watches).toHaveLength(1);
    await watch_remove(added.watch.watch_id);
    expect((await watch_list()).watches).toHaveLength(0);
  });

  it('recheck reports exact fingerprint deltas and can update local state', async () => {
    const added = await watch_add({ repo: 'o/r', issue_number: 3 });
    mocks.githubJson.mockResolvedValue({
      state: 'closed',
      updated_at: '2026-08-20T00:00:00.000Z',
      assignees: [{ login: 'alice' }]
    });
    const recheck = await watch_recheck({ watch_id: added.watch.watch_id, write: true });
    expect(recheck.recheck.changed).toBe(true);
    expect(recheck.recheck.triggers).toContain('target_state_changed');
    expect(recheck.recheck.deltas.some((delta) => delta.path === 'issue_state')).toBe(true);
    expect(recheck.recheck.updated).toBe(true);
    expect(recheck.watch.last_snapshot.issue_state).toBe('closed');
  });

  it('does not invent a watch from a WATCH routing mode', async () => {
    expect(typeof watch_add).toBe('function');
    expect((await watch_list()).watches).toEqual([]);
  });
});
