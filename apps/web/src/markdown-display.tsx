import { useEffect, useId, useState } from "react";

const BREAK_TAG_PATTERN = /<br\s*\/?>|&lt;br\s*\/?&gt;/gi;

function replaceBreakTagsOutsideInlineCode(line: string): string {
  let output = "";
  let cursor = 0;
  let codeDelimiter = "";

  while (cursor < line.length) {
    if (line[cursor] === "`") {
      let end = cursor + 1;
      while (line[end] === "`") end += 1;
      const delimiter = line.slice(cursor, end);
      output += delimiter;
      if (!codeDelimiter) codeDelimiter = delimiter;
      else if (delimiter.length >= codeDelimiter.length) codeDelimiter = "";
      cursor = end;
      continue;
    }

    if (!codeDelimiter) {
      BREAK_TAG_PATTERN.lastIndex = cursor;
      const match = BREAK_TAG_PATTERN.exec(line);
      if (match?.index === cursor) {
        // Two trailing spaces make this a Markdown hard break without enabling
        // raw HTML rendering for arbitrary model output.
        output += "  \n";
        cursor += match[0].length;
        continue;
      }
    }

    output += line[cursor];
    cursor += 1;
  }

  return output;
}

/**
 * Normalize line-break markup emitted by some CLIs before ReactMarkdown sees it.
 * Fenced and indented code are left byte-for-byte intact so code examples that
 * intentionally contain a <br> tag remain copyable.
 */
export function normalizeAssistantMarkdown(text: string): string {
  const normalized = text.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let fence: { marker: "`" | "~"; length: number } | undefined;

  return lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      const closes = fenceMatch
        && fenceMatch[1]![0] === fence.marker
        && fenceMatch[1]!.length >= fence.length;
      if (closes) fence = undefined;
      return line;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1]![0] as "`" | "~", length: fenceMatch[1]!.length };
      return line;
    }
    if (/^(?: {4}|\t)/.test(line)) return line;
    return replaceBreakTagsOutsideInlineCode(line);
  }).join("\n");
}

function mermaidRenderId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return `mermaid-${safe || "diagram"}`;
}

export function downloadMermaidImage(svgMarkup: string) {
  const source = new Blob([svgMarkup], { type: "image/svg+xml;charset=utf-8" });
  const sourceUrl = URL.createObjectURL(source);
  const image = new Image();
  image.onload = () => {
    const canvas = document.createElement("canvas");
    const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.ceil(image.naturalWidth * scale);
    canvas.height = Math.ceil(image.naturalHeight * scale);
    const context = canvas.getContext("2d");
    if (!context) { URL.revokeObjectURL(sourceUrl); return; }
    context.fillStyle = "#fffdf8";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      URL.revokeObjectURL(sourceUrl);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `mermaid-${new Date().toISOString().slice(0, 10)}.png`;
      link.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  };
  image.onerror = () => {
    const link = document.createElement("a");
    link.href = sourceUrl;
    link.download = `mermaid-${new Date().toISOString().slice(0, 10)}.svg`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(sourceUrl), 1000);
  };
  image.src = sourceUrl;
}

/** Render a Mermaid fence in the browser, keeping source visible while loading or on error. */
export function MermaidDiagram({ chart }: { chart: string }) {
  const reactId = useId();
  const [svg, setSvg] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    setSvg("");
    setError("");
    const renderId = mermaidRenderId(reactId);

    void import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          flowchart: { htmlLabels: false, curve: "basis" }
        });
        return mermaid.render(renderId, chart);
      })
      .then((result) => {
        if (!disposed) setSvg(result.svg);
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        const detail = reason instanceof Error ? reason.message : String(reason || "");
        setError(detail.replace(/\s+/g, " ").trim().slice(0, 240));
      });

    return () => {
      disposed = true;
    };
  }, [chart, reactId]);

  return (
    <figure className="md-mermaid" data-mermaid="true">
      {svg && <div className="md-mermaid-toolbar"><span>Mermaid 图表</span><button type="button" className="md-mermaid-export" onClick={() => downloadMermaidImage(svg)} title="导出为图片">导出图片</button></div>}
      <div className="md-mermaid-canvas">
        {svg ? (
          <div className="md-mermaid-svg" dangerouslySetInnerHTML={{ __html: svg }} />
        ) : (
          <pre className="md-mermaid-source">{chart}</pre>
        )}
      </div>
      {error ? (
        <figcaption className="md-mermaid-error">
          流程图渲染失败，已保留源代码{error ? `：${error}` : "。"}
        </figcaption>
      ) : null}
    </figure>
  );
}
