import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('legacy contract fixture', () => {
  it('documents the pre-1.0 envelope and MCP tool surface', () => {
    const fixture = JSON.parse(readFileSync(new URL('./contracts/fixtures/legacy-0.3-contract.json', import.meta.url), 'utf8')) as {
      envelope: { checked: unknown; not_checked: unknown; signals: string[] };
      mcp: { tools: string[] };
    };
    expect(fixture.envelope.checked).toBeTruthy();
    expect(fixture.envelope.not_checked).toBeTruthy();
    expect(fixture.envelope.signals).toContain('linked_pr_open');
    expect(fixture.mcp.tools).toEqual(expect.arrayContaining(['worth_check', 'hunt', 'doctor', 'ledger_list']));
  });
});
