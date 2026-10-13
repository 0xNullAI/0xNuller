import { lazy, memo, Suspense } from 'react';

// The markdown renderer is fetched on first use, so the first paint of the chat does not wait
// for it; until it arrives the text shows as plain text with its line breaks kept.
const MarkdownRenderer = lazy(() => import('./MarkdownRenderer.js'));

export const MarkdownText = memo(function MarkdownText({ content }: { content: string }) {
  return (
    <Suspense fallback={<span className="whitespace-pre-wrap">{content}</span>}>
      <MarkdownRenderer content={content} />
    </Suspense>
  );
});
