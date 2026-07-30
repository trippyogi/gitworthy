import { describe, expect, it } from 'vitest';
import { listProbeTemplates, resolveProbeTemplate } from '../src/core/probe-templates.js';

describe('resolveProbeTemplate', () => {
  it('resolves changelog to a CHANGELOG glob with no contains', () => {
    expect(resolveProbeTemplate('changelog')).toEqual({ file_glob: '**/CHANGELOG*' });
  });

  it('resolves readme to a README glob with no contains', () => {
    expect(resolveProbeTemplate('readme')).toEqual({ file_glob: '**/README*' });
  });

  it('resolves package-exports to package.json with an exports contains clause', () => {
    expect(resolveProbeTemplate('package-exports')).toEqual({ file_glob: '**/package.json', contains: '"exports"' });
  });

  it('resolves dist-index to a dist/index glob', () => {
    expect(resolveProbeTemplate('dist-index')).toEqual({ file_glob: '**/dist/index.*' });
  });

  it('resolves src-index to a src/index glob', () => {
    expect(resolveProbeTemplate('src-index')).toEqual({ file_glob: '**/src/index.*' });
  });

  it('returns null for unknown template ids', () => {
    expect(resolveProbeTemplate('not-a-template')).toBeNull();
  });
});

describe('listProbeTemplates', () => {
  it('lists all templates with ids, globs, and descriptions', () => {
    const templates = listProbeTemplates();
    expect(templates).toHaveLength(5);
    expect(templates.map((template) => template.id).sort()).toEqual(
      ['changelog', 'dist-index', 'package-exports', 'readme', 'src-index'].sort()
    );
    for (const template of templates) {
      expect(typeof template.file_glob).toBe('string');
      expect(typeof template.description).toBe('string');
      expect(template.description.length).toBeGreaterThan(0);
    }
    const packageExports = templates.find((template) => template.id === 'package-exports');
    expect(packageExports).toMatchObject({ file_glob: '**/package.json', contains: '"exports"' });
  });
});
