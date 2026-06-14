// Markdown.tsx — tiny, dependency-free renderer for the grounded answer prose.
// We control the model's output (short plain-language answers) and render only a
// safe subset: paragraphs, bullet lists, **bold**, *italic*, and [text](https) links.
// No raw HTML / dangerouslySetInnerHTML — everything is React elements, so model
// text can never inject markup.
import React from "react";

const SAFE_LINK = /^https?:\/\//i;

/** Parse inline **bold**, *italic*, and [text](url) into React nodes. */
function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Match the three inline forms; everything else is plain text.
  const re = /(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) {
      nodes.push(<strong key={`${keyPrefix}-b${i}`}>{m[2]}</strong>);
    } else if (m[3]) {
      nodes.push(<em key={`${keyPrefix}-i${i}`}>{m[4]}</em>);
    } else if (m[5]) {
      const url = m[7].trim();
      nodes.push(
        SAFE_LINK.test(url) ? (
          <a key={`${keyPrefix}-a${i}`} href={url} target="_blank" rel="noopener noreferrer">
            {m[6]}
          </a>
        ) : (
          m[6]
        ),
      );
    }
    last = re.lastIndex;
    i++;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: React.ReactNode[] = [];
  let para: string[] = [];
  let list: string[] = [];
  let key = 0;

  const flushPara = () => {
    if (para.length) {
      blocks.push(<p key={`p${key++}`}>{renderInline(para.join(" "), `p${key}`)}</p>);
      para = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      blocks.push(
        <ul key={`u${key++}`} className="answer-list">
          {list.map((item, idx) => (
            <li key={idx}>{renderInline(item, `u${key}-${idx}`)}</li>
          ))}
        </ul>,
      );
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();

  return <div className="answer-body">{blocks}</div>;
}
