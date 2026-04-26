import { useCallback, useEffect, useState } from 'react';
import type { PageMeta } from '../lib/pages';

const STORAGE_PREFIX = 'dg-wiki:content:';

interface ReturnShape {
  content: string;
  isModified: boolean;
  setContent: (next: string) => void;
  reset: () => void;
}

/**
 * Reads the page content, preferring localStorage if the user has edited it.
 * Falls back to the markdown shipped with the build.
 */
export function usePageContent(page: PageMeta): ReturnShape {
  const key = STORAGE_PREFIX + page.id;
  const [content, setContentState] = useState(() => {
    if (typeof window === 'undefined') return page.defaultMd;
    return localStorage.getItem(key) ?? page.defaultMd;
  });

  // When the page changes, re-load its content
  useEffect(() => {
    const stored = localStorage.getItem(key);
    setContentState(stored ?? page.defaultMd);
  }, [page.id, page.defaultMd, key]);

  const setContent = useCallback(
    (next: string) => {
      setContentState(next);
      if (next === page.defaultMd) {
        localStorage.removeItem(key);
      } else {
        localStorage.setItem(key, next);
      }
    },
    [key, page.defaultMd],
  );

  const reset = useCallback(() => {
    localStorage.removeItem(key);
    setContentState(page.defaultMd);
  }, [key, page.defaultMd]);

  return {
    content,
    isModified: content !== page.defaultMd,
    setContent,
    reset,
  };
}
