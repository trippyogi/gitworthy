import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitworthyError } from '../src/core/envelope.js';
import { ledger_add, ledger_claim, ledger_list, ledger_update, parseIssueRef } from '../src/core/ledger.js';

describe('ledger', () => {
  let tempDir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'gitworthy-ledger-'));
    ledgerPath = join(tempDir, 'ledger.json');
    process.env.GITWORTHY_LEDGER_PATH = ledgerPath;
  });

  afterEach(async () => {
    delete process.env.GITWORTHY_LEDGER_PATH;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('parses issue refs like the CLI', () => {
    expect(parseIssueRef('owner/repo#123')).toEqual({ repo: 'owner/repo', issue_number: 123 });
    expect(() => parseIssueRef('bad-ref')).toThrow(GitworthyError);
  });

  it('adds and lists records with default url and status', async () => {
    const record = await ledger_add({ repo: 'owner/repo', issue_number: 123, verdict: 'ACT' });
    expect(record).toMatchObject({
      repo: 'owner/repo',
      issue_number: 123,
      url: 'https://github.com/owner/repo/issues/123',
      verdict: 'ACT',
      status: 'candidate'
    });
    expect(record.updated_at).toBeTruthy();

    const listed = await ledger_list({ repo: 'owner/repo', status: 'candidate' });
    expect(listed.records).toHaveLength(1);
    expect(listed.records[0].issue_number).toBe(123);
  });

  it('claims from candidate and blocks active claim conflicts', async () => {
    await ledger_add({ repo: 'owner/repo', issue_number: 1, status: 'candidate' });
    const claimed = await ledger_claim({ repo: 'owner/repo', issue_number: 1, chat_id: 'chat-1' });
    expect(claimed.status).toBe('claimed');
    expect(claimed.chat_id).toBe('chat-1');
    expect(claimed.claimed_at).toBeTruthy();

    await expect(ledger_claim({ repo: 'owner/repo', issue_number: 1 })).rejects.toMatchObject({
      code: 'ledger_claim_conflict'
    });
  });

  it('allows claim after abandoned or done statuses', async () => {
    await ledger_add({ repo: 'owner/repo', issue_number: 2, status: 'abandoned' });
    const fromAbandoned = await ledger_claim({ repo: 'owner/repo', issue_number: 2 });
    expect(fromAbandoned.status).toBe('claimed');

    await ledger_update({ repo: 'owner/repo', issue_number: 2, status: 'done' });
    const fromDone = await ledger_claim({ repo: 'owner/repo', issue_number: 2 });
    expect(fromDone.status).toBe('claimed');
  });

  it('blocks claim when status is reproved, patched, or pr_or_comment', async () => {
    for (const status of ['reproved', 'patched', 'pr_or_comment'] as const) {
      await ledger_add({ repo: 'owner/repo', issue_number: 10, status });
      await expect(ledger_claim({ repo: 'owner/repo', issue_number: 10 })).rejects.toMatchObject({
        code: 'ledger_claim_conflict'
      });
      await ledger_update({ repo: 'owner/repo', issue_number: 10, status: 'abandoned' });
    }
  });

  it('creates a claimed record when claiming a missing issue', async () => {
    const claimed = await ledger_claim({ repo: 'owner/repo', issue_number: 99 });
    expect(claimed.status).toBe('claimed');
    expect(claimed.url).toBe('https://github.com/owner/repo/issues/99');
  });

  it('updates status and notes', async () => {
    await ledger_add({ repo: 'owner/repo', issue_number: 3, status: 'candidate' });
    await ledger_claim({ repo: 'owner/repo', issue_number: 3 });
    const updated = await ledger_update({ repo: 'owner/repo', issue_number: 3, status: 'patched', notes: 'fix landed' });
    expect(updated.status).toBe('patched');
    expect(updated.notes).toBe('fix landed');

    await expect(ledger_update({ repo: 'owner/repo', issue_number: 404, status: 'done' })).rejects.toMatchObject({
      code: 'ledger_not_found'
    });
  });
});
