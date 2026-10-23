import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "./Icon";

function CodeBlock({ children }: { children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = (children as React.ReactElement<{ children?: string; className?: string }>)?.props;
  const lang = /language-(\w+)/.exec(code?.className ?? "")?.[1];
  const text = String(code?.children ?? "").replace(/\n$/, "");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* Zwischenablage nicht verfügbar */ }
  };
  return (
    <div className="codeb">
      <div className="hd">
        <Icon name="file" size={12} />{lang ?? "text"}
        <span className="row" style={{ marginLeft: "auto" }}>
          <button type="button" className="btn btn-s btn-g codeb-copy" onClick={copy}><Icon name="copy" size={12} />{copied ? "Kopiert" : "Kopieren"}</button>
        </span>
      </div>
      <div className="pre numbered">
        {text.split("\n").map((line, i) => <div className="cl" key={i}><span className="ln">{i + 1}</span>{line || " "}</div>)}
      </div>
    </div>
  );
}

export function Markdown({ text, caret = false }: { text: string; caret?: boolean }) {
  return (
    <div className={`md${caret ? " caret" : ""}`}>
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
