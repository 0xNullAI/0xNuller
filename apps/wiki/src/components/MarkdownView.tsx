import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface Props {
  content: string;
}

export function MarkdownView({ content }: Props) {
  return (
    <article className="markdown-body reveal">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, ...rest }) => (
            <a href={href} target={href?.startsWith('http') ? '_blank' : undefined} rel="noreferrer" {...rest} />
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
