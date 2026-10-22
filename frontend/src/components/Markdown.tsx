import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = (children as React.ReactElement<{ children?: string; className?: string }>)?.props;
  const lang = /language-(\w+)/.exec(code?.className ?? "")?.[1];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(String(code?.children ?? "").replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* Zwischenablage nicht verfügbar */ }
  };
  return (
    <div className="codeblock">
      <div className="codeblock-bar">
        <span className="mono tag">{lang ?? "text"}</span>
        <button type="button" className="ghost small" onClick={copy}>{copied ? "Kopiert" : "Kopieren"}</button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: CodeBlock,
          a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer nofollow">{children}</a>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
