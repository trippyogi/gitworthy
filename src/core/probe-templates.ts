export type ProbeTemplateId = 'changelog' | 'readme' | 'package-exports' | 'dist-index' | 'src-index';

export type ProbeTemplate = { file_glob: string; contains?: string };
type ProbeTemplateDefinition = ProbeTemplate & { id: ProbeTemplateId; description: string };

const TEMPLATES: Record<ProbeTemplateId, ProbeTemplateDefinition> = {
  changelog: {
    id: 'changelog',
    file_glob: '**/CHANGELOG*',
    description: 'Matches any CHANGELOG file to check whether a fix was mentioned in release notes.'
  },
  readme: {
    id: 'readme',
    file_glob: '**/README*',
    description: 'Matches any README file for documentation-level confirmation of a feature or fix.'
  },
  'package-exports': {
    id: 'package-exports',
    file_glob: '**/package.json',
    contains: '"exports"',
    description: 'Checks package.json for an "exports" field, useful for confirming a new entry point shipped.'
  },
  'dist-index': {
    id: 'dist-index',
    file_glob: '**/dist/index.*',
    description: 'Matches the built dist/index entry file to inspect compiled output.'
  },
  'src-index': {
    id: 'src-index',
    file_glob: '**/src/index.*',
    description: 'Matches the src/index entry file to inspect source output.'
  }
};

export function resolveProbeTemplate(id: string): ProbeTemplate | null {
  const template = TEMPLATES[id as ProbeTemplateId];
  if (!template) return null;
  return { file_glob: template.file_glob, ...(template.contains ? { contains: template.contains } : {}) };
}

export function listProbeTemplates(): Array<{ id: ProbeTemplateId; file_glob: string; contains?: string; description: string }> {
  return Object.values(TEMPLATES).map(({ id, file_glob, contains, description }) => ({
    id,
    file_glob,
    ...(contains ? { contains } : {}),
    description
  }));
}
