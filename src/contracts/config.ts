import { z } from 'zod';
import { SCHEMA_VERSION } from './common.js';
import { OrgOrUserLoginSchema, RepoRefSchema } from './inputs.js';

export const CONFIG_SCHEMA_VERSION = SCHEMA_VERSION;

const NonEmptyStringSchema = z.string().trim().min(1).max(200);
const StringListSchema = z.array(NonEmptyStringSchema).max(50);
const PositiveLimitSchema = z.number().int().positive();

export const SkillProfileV1Schema = z.object({
  languages: StringListSchema.optional(),
  topics: StringListSchema.optional(),
  preferred_ecosystems: StringListSchema.optional(),
  avoid: StringListSchema.optional(),
  avoid_languages: StringListSchema.optional(),
  avoid_topics: StringListSchema.optional(),
  avoid_ecosystems: StringListSchema.optional()
}).strict();

export const ConfigDefaultsSchema = z.object({
  label: NonEmptyStringSchema.optional(),
  keywords: StringListSchema.optional(),
  since: NonEmptyStringSchema.optional(),
  limit: PositiveLimitSchema.max(100).optional(),
  scan_limit: PositiveLimitSchema.max(100).optional(),
  max_repos: PositiveLimitSchema.max(20).optional(),
  max_checks: PositiveLimitSchema.max(5).optional(),
  land_hints: z.boolean().optional(),
  skip_likely_land_only: z.boolean().optional(),
  skip_soft_ask: z.boolean().optional(),
  skip_assigned: z.boolean().optional(),
  skip_ledger_skip: z.boolean().optional(),
  skip_policy_gate: z.boolean().optional(),
  npm_package: NonEmptyStringSchema.optional(),
  manifest_path: NonEmptyStringSchema.optional()
}).strict();

const TargetFilterSchema = z.object({
  labels: StringListSchema.optional(),
  keywords: StringListSchema.optional(),
  repos: z.array(RepoRefSchema).max(100).optional(),
  orgs: z.array(OrgOrUserLoginSchema).max(100).optional()
}).strict();

export const TargetOverrideSchema = ConfigDefaultsSchema.extend({
  repo: RepoRefSchema.optional(),
  org: OrgOrUserLoginSchema.optional(),
  skill_profile: SkillProfileV1Schema.optional()
}).strict().refine((value) => Boolean(value.repo) !== Boolean(value.org), {
  message: 'target override requires exactly one of repo or org.',
  path: ['repo']
});

export const TargetRepoEntrySchema = z.union([
  RepoRefSchema,
  z.object({
    repo: RepoRefSchema,
    npm_package: NonEmptyStringSchema.optional(),
    label: NonEmptyStringSchema.optional(),
    keywords: StringListSchema.optional(),
    since: NonEmptyStringSchema.optional(),
    limit: PositiveLimitSchema.max(100).optional(),
    land_hints: z.boolean().optional(),
    skill_profile: SkillProfileV1Schema.optional()
  }).strict()
]);

export const TargetOrgEntrySchema = z.union([
  OrgOrUserLoginSchema,
  z.object({
    org: OrgOrUserLoginSchema,
    label: NonEmptyStringSchema.optional(),
    keywords: StringListSchema.optional(),
    since: NonEmptyStringSchema.optional(),
    limit: PositiveLimitSchema.max(100).optional(),
    max_repos: PositiveLimitSchema.max(20).optional(),
    land_hints: z.boolean().optional(),
    skill_profile: SkillProfileV1Schema.optional()
  }).strict()
]);

export const PackageMappingSchema = z.object({
  repo: RepoRefSchema,
  npm_package: NonEmptyStringSchema
}).strict();

export const TargetManifestSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  repos: z.array(TargetRepoEntrySchema).max(100).optional(),
  orgs: z.array(TargetOrgEntrySchema).max(100).optional(),
  include: TargetFilterSchema.optional(),
  exclude: TargetFilterSchema.optional(),
  package_mappings: z.array(PackageMappingSchema).max(100).optional(),
  target_overrides: z.array(TargetOverrideSchema).max(100).optional()
}).strict().superRefine((manifest, ctx) => {
  const seen = new Map<string, string>();
  manifest.package_mappings?.forEach((item, index) => {
    const existing = seen.get(item.repo);
    if (existing && existing !== item.npm_package) {
      ctx.addIssue({ code: 'custom', path: ['package_mappings', index, 'npm_package'], message: `ambiguous npm package mapping for ${item.repo}: ${existing} vs ${item.npm_package}` });
    } else seen.set(item.repo, item.npm_package);
  });
  manifest.repos?.forEach((item, index) => {
    if (typeof item === 'string' || !item.npm_package) return;
    const existing = seen.get(item.repo);
    if (existing && existing !== item.npm_package) {
      ctx.addIssue({ code: 'custom', path: ['repos', index, 'npm_package'], message: `ambiguous npm package mapping for ${item.repo}: ${existing} vs ${item.npm_package}` });
    } else seen.set(item.repo, item.npm_package);
  });
});

export const ConfigFileSchema = z.object({
  schema_version: z.literal(CONFIG_SCHEMA_VERSION),
  defaults: ConfigDefaultsSchema.optional(),
  profile: SkillProfileV1Schema.optional(),
  manifest: TargetManifestSchema.optional(),
  manifest_path: NonEmptyStringSchema.optional()
}).strict();

export type SkillProfileV1 = z.infer<typeof SkillProfileV1Schema>;
export type ConfigDefaults = z.infer<typeof ConfigDefaultsSchema>;
export type ConfigFile = z.infer<typeof ConfigFileSchema>;
export type TargetManifest = z.infer<typeof TargetManifestSchema>;
export type TargetRepoEntry = z.infer<typeof TargetRepoEntrySchema>;
export type TargetOrgEntry = z.infer<typeof TargetOrgEntrySchema>;
