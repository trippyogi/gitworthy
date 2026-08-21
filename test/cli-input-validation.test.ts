import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli/index.js';
import { ErrorResultSchema, IssueRefStringSchema, RepoRefSchema } from '../src/contracts/index.js';

// All of these paths are invalid input, so none should ever reach a GitHub/git network call;
// there are deliberately no lib/git or lib/github mocks in this file.
async function run(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '';
  let stderr = '';
  const code = await runCli(argv, (text) => { stdout += text; }, (text) => { stderr += text; });
  return { code, stdout, stderr };
}

describe('CLI input validation', () => {
  it('rejects an unknown flag before any command runs', async () => {
    const { code, stdout } = await run(['scan', 'o/r', '--bogus-flag', '--json']);
    expect(code).toBe(2);
    const payload = JSON.parse(stdout);
    const parsed = ErrorResultSchema.parse(payload);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.category).toBe('input');
    expect(parsed.error.code).toBe('invalid_usage');
  });

  it('rejects a malformed repo before check runs', async () => {
    const { code, stdout } = await run(['check', 'not-a-repo#1', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_issue_ref');
    expect(parsed.error.category).toBe('input');
  });

  it('rejects a malformed repo for scan', async () => {
    const { code, stdout } = await run(['scan', 'not_a_valid_repo!!', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_repo_ref');
  });

  it('rejects a non-numeric issue number for issue', async () => {
    const { code, stdout } = await run(['issue', 'o/r', 'not-a-number', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_issue_number');
  });

  it('rejects a zero or negative issue number', async () => {
    const { code, stdout } = await run(['issue', 'o/r', '0', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_issue_number');
  });

  it('reports missing required positionals with a stable invalid_usage code', async () => {
    const { code, stdout } = await run(['policy', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
    expect(parsed.error.message).toContain('policy requires owner/repo.');
  });

  it('rejects hunt when neither repo nor org is provided', async () => {
    const { code, stdout } = await run(['hunt', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.category).toBe('input');
  });

  it('rejects portfolio --org combined with an owner/repo value', async () => {
    const { code, stdout } = await run(['portfolio', 'owner/repo', '--org', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
    expect(parsed.error.message).toContain('--org expects an org or user login');
  });

  it('rejects prs without a repo', async () => {
    const { code, stdout } = await run(['prs', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
  });

  it('rejects hunt --org combined with an owner/repo value', async () => {
    const { code, stdout } = await run(['hunt', 'owner/repo', '--org', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
    expect(parsed.error.message).toContain('--org expects an org or user login');
  });

  it('accepts capture flags in strict parsing but still rejects malformed check refs before network', async () => {
    const { code, stdout } = await run(['check', 'not-a-repo#1', '--capture', '--capture-local-private', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_issue_ref');
  });

  it('validates case promote required adjudication flags before store access', async () => {
    const { code, stdout } = await run(['case', 'promote', 'capture_missing', '--verdict', 'ACT', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
    expect(parsed.error.message).toContain('--disposition');
  });

  it('validates capture subcommands before store access', async () => {
    const { code, stdout } = await run(['capture', 'show', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_usage');
    expect(parsed.error.message).toContain('capture show requires a capture_id');
  });

  it('rejects an org login that fails the shared login format', async () => {
    const { code, stdout } = await run(['org', 'in_valid_org', '--json']);
    expect(code).toBe(2);
    const parsed = ErrorResultSchema.parse(JSON.parse(stdout));
    expect(parsed.error.code).toBe('invalid_org_ref');
  });

  it('prints a plain-text error message (not JSON) when --json is not passed', async () => {
    const { code, stderr, stdout } = await run(['policy']);
    expect(code).toBe(2);
    expect(stdout).toBe('');
    expect(stderr).toContain('policy requires owner/repo.');
  });

  it('still prints package version for --version, -V, and version despite strict parsing', async () => {
    for (const argv of [['--version'], ['-V'], ['version']]) {
      const { code, stdout } = await run(argv);
      expect(code).toBe(0);
      expect(stdout.trim().length).toBeGreaterThan(0);
    }
  });

  it('accepts GitHub repos whose names begin with a period (e.g. .github)', () => {
    expect(RepoRefSchema.parse('octocat/.github')).toBe('octocat/.github');
    expect(RepoRefSchema.parse('myorg/.github-private')).toBe('myorg/.github-private');
    expect(IssueRefStringSchema.parse('octocat/.github#12')).toEqual({
      repo: 'octocat/.github',
      issue_number: 12
    });
  });

  it('refuses mcp --http on a public bind without GITWORTHY_MCP_TOKEN', async () => {
    const previous = process.env.GITWORTHY_MCP_TOKEN;
    delete process.env.GITWORTHY_MCP_TOKEN;
    try {
      const { code, stdout, stderr } = await run(['mcp', '--http', '--host', '0.0.0.0', '--port', '8799', '--json']);
      expect(code).toBe(2);
      const payload = stdout.trim() ? JSON.parse(stdout) : null;
      if (payload) {
        const parsed = ErrorResultSchema.parse(payload);
        expect(parsed.error.message).toMatch(/GITWORTHY_MCP_TOKEN/);
      } else {
        expect(stderr).toMatch(/GITWORTHY_MCP_TOKEN/);
      }
    } finally {
      if (previous === undefined) delete process.env.GITWORTHY_MCP_TOKEN;
      else process.env.GITWORTHY_MCP_TOKEN = previous;
    }
  });
});
