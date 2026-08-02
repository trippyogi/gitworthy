import { z } from 'zod';
import { GitworthyError } from '../core/envelope.js';
import { DispositionSchema, VerdictSchema } from './common.js';

/**
 * Shared input contracts for the CLI and MCP boundaries. Both surfaces must reject malformed
 * input with the same stable error codes before any network or filesystem access happens.
 */

/** GitHub owner/login: starts/ends alphanumeric; hyphens allowed in the middle. */
const OWNER_PATTERN = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
/**
 * GitHub repository name: may start with `.` (e.g. org `.github` community-health repos)
 * or alphanumeric/`_`; may contain `.`/`_`/`-`; must not end with `.` or `-`.
 */
const REPO_NAME_PATTERN = '[A-Za-z0-9._](?:[A-Za-z0-9._-]*[A-Za-z0-9])?';
const REPO_PATTERN = new RegExp(`^${OWNER_PATTERN}\\/${REPO_NAME_PATTERN}$`);
const LOGIN_PATTERN = new RegExp(`^${OWNER_PATTERN}$`);
const ISSUE_REF_PATTERN = /^([^\s#]+)#(\d+)$/;

// GitHub caps logins at 39 chars and repo names at 100 chars; capping the combined
// "owner/repo" string rejects a hostile/fuzzed unbounded-length value before it can
// ever be used to build a clone URL or API request path.
export const RepoRefSchema = z.string()
  .trim()
  .min(3, 'repo must not be empty.')
  .max(140, 'repo must be 140 characters or fewer.')
  .regex(REPO_PATTERN, 'Expected owner/repo (e.g. octocat/Hello-World).');

export const OrgOrUserLoginSchema = z.string()
  .trim()
  .min(1, 'org must not be empty.')
  .max(39, 'org/user login must be 39 characters or fewer.')
  .regex(LOGIN_PATTERN, 'Expected an org or user login without a slash (e.g. octocat).');

export const IssueNumberSchema = z.number()
  .int('issue_number must be an integer.')
  .positive('issue_number must be a positive integer.');

/** Coerces a CLI positional string (e.g. "123") into a validated issue number. */
export const IssueNumberStringSchema = z.string()
  .trim()
  .regex(/^\d+$/, 'issue_number must be a positive integer.')
  .transform((value) => Number(value))
  .pipe(IssueNumberSchema);

export const IssueRefStringSchema = z.string()
  .trim()
  .regex(ISSUE_REF_PATTERN, 'Expected issue ref like owner/repo#123.')
  .transform((value) => {
    const match = value.match(ISSUE_REF_PATTERN);
    return { repo: match?.[1] ?? '', issue_number: Number(match?.[2] ?? Number.NaN) };
  })
  .pipe(z.object({ repo: RepoRefSchema, issue_number: IssueNumberSchema }));

export type IssueRef = z.infer<typeof IssueRefStringSchema>;

export const ProbeSchema = z.object({
  file_glob: z.string().optional(),
  contains: z.string().optional()
});

export const SkillProfileSchema = z.union([
  z.string(),
  z.object({
    languages: z.array(z.string()).optional(),
    topics: z.array(z.string()).optional(),
    preferred_ecosystems: z.array(z.string()).optional(),
    avoid: z.array(z.string()).optional(),
    avoid_languages: z.array(z.string()).optional(),
    avoid_topics: z.array(z.string()).optional(),
    avoid_ecosystems: z.array(z.string()).optional()
  }).strict()
]).optional();

const KeywordsSchema = z.array(z.string()).optional();
const LimitSchema = z.number().int().positive();

export const DoctorInputSchema = z.object({
  probe_repo: RepoRefSchema.optional(),
  probe_issue_number: IssueNumberSchema.optional()
});

export const BranchScanInputSchema = z.object({
  repo: RepoRefSchema,
  keywords: z.array(z.string()).min(1, 'keywords must include at least one entry.'),
  issue_number: IssueNumberSchema.optional(),
  max_age_days: LimitSchema.optional(),
  force_refresh: z.boolean().optional()
});

export const IssueVsMainInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema
});

export const ReleaseGapInputSchema = z.object({
  repo: RepoRefSchema,
  npm_package: z.string().min(1, 'npm_package must not be empty.'),
  probe: ProbeSchema.optional(),
  probe_template: z.string().optional(),
  force_refresh: z.boolean().optional()
});

export const DupeClusterInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema,
  max_candidates: LimitSchema.optional()
});

export const RelatedClusterInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema.optional(),
  label: z.string().optional(),
  keywords: KeywordsSchema,
  limit: LimitSchema.optional(),
  min_score: z.number().min(0).max(1).optional()
});

export const LinkedWorkInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema
});

export const ContribPolicyInputSchema = z.object({
  repo: RepoRefSchema,
  force_refresh: z.boolean().optional()
});

export const WorthCheckInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema,
  npm_package: z.string().optional(),
  probe: ProbeSchema.optional(),
  probe_template: z.string().optional(),
  capture: z.boolean().optional(),
  capture_local_private: z.boolean().optional()
});

export const ScanInputSchema = z.object({
  repo: RepoRefSchema,
  label: z.string().optional(),
  keywords: KeywordsSchema,
  since: z.string().optional(),
  limit: LimitSchema.optional(),
  land_hints: z.boolean().optional(),
  skill_profile: SkillProfileSchema,
  manifest_path: z.string().optional()
});

export const OrgScanInputSchema = z.object({
  org: OrgOrUserLoginSchema.optional(),
  label: z.string().optional(),
  keywords: KeywordsSchema,
  since: z.string().optional(),
  limit: LimitSchema.optional(),
  max_repos: LimitSchema.optional(),
  land_hints: z.boolean().optional(),
  skill_profile: SkillProfileSchema,
  manifest_path: z.string().optional()
});

export const HuntInputObjectSchema = z.object({
  repo: RepoRefSchema.optional(),
  org: OrgOrUserLoginSchema.optional(),
  label: z.string().optional(),
  keywords: KeywordsSchema,
  since: z.string().optional(),
  scan_limit: LimitSchema.optional(),
  max_repos: LimitSchema.optional(),
  max_checks: LimitSchema.optional(),
  land_hints: z.boolean().optional(),
  skip_likely_land_only: z.boolean().optional(),
  skip_soft_ask: z.boolean().optional(),
  skip_assigned: z.boolean().optional(),
  skip_ledger_skip: z.boolean().optional(),
  skip_policy_gate: z.boolean().optional(),
  skill_profile: SkillProfileSchema,
  npm_package: z.string().optional(),
  capture: z.boolean().optional(),
  capture_local_private: z.boolean().optional(),
  manifest_path: z.string().optional()
});

/** hunt target resolution happens after config loading so config-only MCP calls can work. */
export const HuntInputSchema = HuntInputObjectSchema;

export const CaptureShowInputSchema = z.object({
  capture_id: z.string().min(1)
});

export const CaptureListInputSchema = z.object({
  limit: LimitSchema.optional()
});

export const CasePromoteInputSchema = z.object({
  capture_id: z.string().min(1),
  verdict: VerdictSchema,
  disposition: DispositionSchema,
  adjudicator_rationale: z.string().min(1),
  evidence_urls: z.array(z.string().url()).min(1),
  out_path: z.string().min(1),
  force: z.boolean().optional()
});

export const ConfigValidateInputSchema = z.object({
  path: z.string().optional(),
  user: z.boolean().optional(),
  repo: z.boolean().optional(),
  manifest_path: z.string().optional()
}).strict();

export const ConfigShowInputSchema = z.object({
  effective: z.boolean().optional(),
  path: z.string().optional(),
  cwd: z.string().optional()
}).strict();

export const ProfileShowInputSchema = z.object({
  path: z.string().optional(),
  cwd: z.string().optional()
}).strict();

export const LedgerLookupInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema
});

export const LedgerRecordInputSchema = z.object({
  repo: RepoRefSchema,
  issue_number: IssueNumberSchema,
  verdict: VerdictSchema.optional(),
  disposition: DispositionSchema.optional(),
  quality_score: z.number().min(0).max(1).optional(),
  notes: z.string().optional(),
  source: z.string().optional()
});

export const LedgerListInputSchema = z.object({
  repo: RepoRefSchema.optional(),
  limit: LimitSchema.optional()
});

function codeForField(field: unknown): string {
  if (field === 'repo') return 'invalid_repo_ref';
  if (field === 'org') return 'invalid_org_ref';
  if (field === 'issue_number') return 'invalid_issue_number';
  return 'invalid_usage';
}

/** Validates MCP/CLI object input against a shared schema, raising a stable-coded GitworthyError instead of a bare ZodError. */
export function parseToolInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path?.[0];
  const label = issue && issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  const message = `${label}${issue?.message ?? 'invalid input'}`;
  throw new GitworthyError({ code: codeForField(field), message, not_checked: [message] });
}

/** Validates a single CLI positional value against a schema, raising a stable-coded GitworthyError. */
export function parseArg<T>(schema: z.ZodType<T>, value: unknown, code: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const message = result.error.issues[0]?.message ?? 'invalid input';
  throw new GitworthyError({ code, message, not_checked: [message] });
}

/** Parses a CLI/MCP issue ref like "owner/repo#123" into { repo, issue_number }. */
export function parseIssueRef(value: string): IssueRef {
  return parseArg(IssueRefStringSchema, value, 'invalid_issue_ref');
}
