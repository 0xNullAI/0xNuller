import { useCallback, useEffect, useState } from 'react';
import type { Document } from '../lib/projects';

const STORAGE_PREFIX = 'dg-wiki:content:';

interface ReturnShape {
  content: string;
  isModified: boolean;
  setContent: (next: string) => void;
  reset: () => void;
}

/**
 * Reads the document content, preferring localStorage if the user has
 * edited it. Falls back to the markdown shipped with the build.
 *
 * Storage key is `<projectId>/<docId>` so the same key keeps mapping if the
 * doc is renamed or moved between projects (rare but cheap insurance).
 */
export function usePageContent(projectId: string, doc: Document): ReturnShape {
  const key = `${STORAGE_PREFIX}${projectId}/${doc.id}`;
  const [content, setContentState] = useState(() => {
    if (typeof window === 'undefined') return doc.defaultMd;
    return localStorage.getItem(key) ?? doc.defaultMd;
  });

  // Re-load when the project / doc changes.
  useEffect(() => {
    const stored = localStorage.getItem(key);
    setContentState(stored ?? doc.defaultMd);
  }, [doc.id, doc.defaultMd, key]);

  const setContent = useCallback(
    (next: string) => {
      setContentState(next);
      if (next === doc.defaultMd) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, next);
      }
    },
    [key, doc.defaultMd],
  );

  const reset = useCallback(() => {
    localStorage.removeItem(key);
    setContentState(doc.defaultMd);
  }, [key, doc.defaultMd]);

  return {
    content,
    isModified: content !== doc.defaultMd,
    setContent,
    reset,
  };
}

export function isContentModified(projectId: string, docId: string): boolean {
  if (typeof window === 'undefined') return false;
  return localStorage.getItem(`${STORAGE_PREFIX}${projectId}/${docId}`) !== null;
}
