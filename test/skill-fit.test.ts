import { describe, expect, it } from 'vitest';
import { parseSkillProfile, resolveSkillProfile, scoreSkillFit } from '../src/core/skill-fit.js';

describe('scoreSkillFit', () => {
  it('starts at 0.5 and stays neutral with no profile terms', () => {
    const result = scoreSkillFit({ profile: {}, issue: { title: 'Fix flaky test', body: 'Some detail.' } });
    expect(result.score).toBe(0.5);
    expect(result.matched).toEqual([]);
    expect(result.avoided).toEqual([]);
    expect(result.reasons.join(' ')).toContain('neutral fit');
  });

  it('adds +0.15 per matched language capped at +0.3', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript', 'go', 'rust'] },
      issue: { title: 'Add typescript and go support', body: null }
    });
    expect(result.matched).toEqual(expect.arrayContaining(['typescript', 'go']));
    expect(result.matched).not.toContain('rust');
    expect(result.score).toBeCloseTo(0.8, 5);
  });

  it('caps the language bonus at +0.3 even with many hits', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript', 'go', 'python', 'ruby'] },
      issue: { title: 'typescript go python ruby all mentioned', body: null }
    });
    expect(result.score).toBeCloseTo(0.8, 5);
  });

  it('matches a language via repo language hint even if absent from issue text', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript'] },
      issue: { title: 'Improve build', body: null },
      repoHints: { language: 'TypeScript' }
    });
    expect(result.matched).toContain('typescript');
    expect(result.score).toBeCloseTo(0.65, 5);
  });

  it('adds +0.1 per matched topic capped at +0.3', () => {
    const result = scoreSkillFit({
      profile: { topics: ['mcp', 'cli', 'agents'] },
      issue: { title: 'Add MCP support to the CLI', body: 'Also relevant to agents.' }
    });
    expect(result.matched).toEqual(expect.arrayContaining(['mcp', 'cli', 'agents']));
    expect(result.score).toBeCloseTo(0.8, 5);
  });

  it('matches topics via repo topics and description', () => {
    const result = scoreSkillFit({
      profile: { topics: ['mcp', 'automation'] },
      issue: { title: 'Improve docs', body: null },
      repoHints: { topics: ['mcp'], description: 'Automation toolkit' }
    });
    expect(result.matched).toEqual(expect.arrayContaining(['mcp', 'automation']));
    expect(result.score).toBeCloseTo(0.7, 5);
  });

  it('subtracts 0.25 per avoid hit', () => {
    const result = scoreSkillFit({
      profile: { avoid: ['swift', 'ios'] },
      issue: { title: 'Fix Swift crash on iOS', body: null }
    });
    expect(result.avoided).toEqual(expect.arrayContaining(['swift', 'ios']));
    expect(result.score).toBeCloseTo(0, 5);
  });

  it('floors the score at 0 when avoid penalties exceed the base score', () => {
    const result = scoreSkillFit({
      profile: { avoid: ['swift', 'ios', 'kotlin'] },
      issue: { title: 'Fix Swift crash on iOS with Kotlin interop', body: null }
    });
    expect(result.score).toBe(0);
  });

  it('clamps the score at 1 when language and topic bonuses combine beyond it', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript', 'go'], topics: ['mcp', 'cli', 'agents'] },
      issue: { title: 'typescript go mcp cli agents', body: null }
    });
    expect(result.score).toBe(1);
  });

  it('combines matches and avoids in the same score', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript'], avoid: ['swift'] },
      issue: { title: 'Port Swift module to TypeScript', body: null }
    });
    expect(result.matched).toContain('typescript');
    expect(result.avoided).toContain('swift');
    expect(result.score).toBeCloseTo(0.4, 5);
  });

  it('uses word boundaries so short language terms do not match substrings', () => {
    const result = scoreSkillFit({
      profile: { languages: ['go'] },
      issue: { title: 'Going over the algorithm again', body: null }
    });
    expect(result.matched).not.toContain('go');
    expect(result.score).toBe(0.5);
  });

  it('matches labels for language and topic and avoid terms', () => {
    const result = scoreSkillFit({
      profile: { languages: ['go'], topics: ['cli'] },
      issue: { title: 'Improve output', body: null, labels: ['go', 'cli'] }
    });
    expect(result.matched).toEqual(expect.arrayContaining(['go', 'cli']));
  });

  it('produces human-readable reasons for matches and avoids', () => {
    const result = scoreSkillFit({
      profile: { languages: ['typescript'], avoid: ['swift'] },
      issue: { title: 'Port Swift module to TypeScript', body: null }
    });
    expect(result.reasons.some((reason) => reason.includes('language') && reason.includes('typescript'))).toBe(true);
    expect(result.reasons.some((reason) => reason.includes('avoid') && reason.includes('swift'))).toBe(true);
  });
});

describe('parseSkillProfile', () => {
  it('returns null for undefined or empty input', () => {
    expect(parseSkillProfile(undefined)).toBeNull();
    expect(parseSkillProfile('')).toBeNull();
    expect(parseSkillProfile('   ')).toBeNull();
  });

  it('parses the compact key=value;key=value form', () => {
    const profile = parseSkillProfile('languages=ts,go;topics=mcp,cli;avoid=swift');
    expect(profile).toEqual({ languages: ['ts', 'go'], topics: ['mcp', 'cli'], avoid: ['swift'] });
  });

  it('trims whitespace around keys and list values', () => {
    const profile = parseSkillProfile(' languages = ts , go ; avoid = swift ');
    expect(profile).toEqual({ languages: ['ts', 'go'], avoid: ['swift'] });
  });

  it('supports singular key aliases', () => {
    const profile = parseSkillProfile('language=rust;topic=cli');
    expect(profile).toEqual({ languages: ['rust'], topics: ['cli'] });
  });

  it('parses a JSON object string', () => {
    const profile = parseSkillProfile(JSON.stringify({ languages: ['typescript'], topics: ['mcp'], avoid: ['swift'] }));
    expect(profile).toEqual({ languages: ['typescript'], topics: ['mcp'], avoid: ['swift'] });
  });

  it('returns null for malformed JSON that starts with a brace', () => {
    expect(parseSkillProfile('{not valid json')).toBeNull();
  });

  it('returns null when no recognized keys are present', () => {
    expect(parseSkillProfile('foo=bar')).toBeNull();
    expect(parseSkillProfile(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('ignores non-string entries in a JSON array field', () => {
    const profile = parseSkillProfile(JSON.stringify({ languages: ['typescript', 42, null] }));
    expect(profile).toEqual({ languages: ['typescript'] });
  });
});

describe('resolveSkillProfile', () => {
  it('returns null for undefined input', () => {
    expect(resolveSkillProfile(undefined)).toBeNull();
  });

  it('parses a raw string input', () => {
    expect(resolveSkillProfile('languages=go')).toEqual({ languages: ['go'] });
  });

  it('passes through an already-parsed profile object', () => {
    const profile = { languages: ['go'] };
    expect(resolveSkillProfile(profile)).toBe(profile);
  });

  it('treats an empty profile object as no profile', () => {
    expect(resolveSkillProfile({})).toBeNull();
  });
});
