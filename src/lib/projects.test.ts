import { describe, it, expect } from 'vitest';
import { findProject, findDocument, githubEditUrl, pageKey, PROJECTS, REPO_BASE } from './projects';

describe('PROJECTS data', () => {
  it('contains the four expected projects', () => {
    const ids = PROJECTS.map((p) => p.id);
    expect(ids).toEqual(['kit', 'agent', 'chat', 'mcp']);
  });

  it('every project has at least one document', () => {
    for (const p of PROJECTS) {
      expect(p.documents.length).toBeGreaterThan(0);
    }
  });

  it('every document has non-empty defaultMd', () => {
    for (const p of PROJECTS) {
      for (const d of p.documents) {
        expect(d.defaultMd.length).toBeGreaterThan(0);
        expect(d.sourcePath).toMatch(/^src\/content\/.+\.md$/);
      }
    }
  });

  it('document audience is either user or developer', () => {
    for (const p of PROJECTS) {
      for (const d of p.documents) {
        expect(['user', 'developer']).toContain(d.audience);
      }
    }
  });
});

describe('findProject', () => {
  it('returns the matching project', () => {
    expect(findProject('kit').id).toBe('kit');
    expect(findProject('mcp').id).toBe('mcp');
  });

  it('falls back to DG-Agent for unknown ids', () => {
    expect(findProject('does-not-exist').id).toBe('agent');
    expect(findProject(null).id).toBe('agent');
  });
});

describe('findDocument', () => {
  const project = findProject('agent');

  it('returns the matching document', () => {
    const manual = findDocument(project, 'manual');
    expect(manual.id).toBe('manual');
  });

  it('falls back to the first document when id is unknown', () => {
    const fallback = findDocument(project, 'totally-bogus');
    expect(fallback.id).toBe(project.documents[0]!.id);
  });

  it('falls back when id is null', () => {
    const fallback = findDocument(project, null);
    expect(fallback).toBeTruthy();
  });
});

describe('githubEditUrl', () => {
  it('builds a URL pointing at main on the correct file', () => {
    const project = findProject('kit');
    const doc = project.documents[0]!;
    const url = githubEditUrl(doc);
    expect(url).toMatch(/^https:\/\/github\.com\/0xNullAI\/DG-Wiki\/edit\/main\//);
    expect(url).toContain(doc.sourcePath);
  });
});

describe('pageKey', () => {
  it('joins project + doc with a slash', () => {
    expect(pageKey('agent', 'manual')).toBe('agent/manual');
  });
});

describe('REPO_BASE', () => {
  it('points at the DG-Wiki repo', () => {
    expect(REPO_BASE).toBe('https://github.com/0xNullAI/DG-Wiki');
  });
});
