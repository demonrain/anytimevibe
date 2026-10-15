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

  return lines.map((line, index) => {
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
    // A hard line break inside a GFM table row starts a new row. AGY uses
    // <br> for multi-line cells, so keep that content on the same row.
    const nextLine = lines[index + 1] || "";
    const tableRow = /^\s*\|/.test(line) && (/\|\s*$/.test(line) || /^\s*\|?\s*:?-{3,}/.test(nextLine));
    return tableRow
      ? line.replace(BREAK_TAG_PATTERN, " · ")
      : replaceBreakTagsOutsideInlineCode(line);
  }).join("\n");
}

/** Make common AGY Mermaid decorations valid without changing node labels. */
export function normalizeMermaidChart(chart: string): string {
  let subgraphId = 0;
  return chart.replace(/^(\s*)subgraph\s+(.+?)\s*$/gim, (full, indent: string, rawTitle: string) => {
    const title = rawTitle.trim();
    // Existing IDs and explicit [title] declarations are already valid.
    if (/^[A-Za-z_][A-Za-z0-9_-]*(?:\s*\[.*\])?$/.test(title)) return full;
    const safeTitle = title.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    subgraphId += 1;
    return `${indent}subgraph agy_subgraph_${subgraphId}["${safeTitle}"]`;
  }).replace(/^\s*-{3,}\s*$/gm, "");
}

function mermaidRenderId(id: string): string {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, "");
  return `mermaid-${safe || "diagram"}`;
}

function sanitizeMermaidSvgText(svgMarkup: string): string {
  return svgMarkup
    .replace(/<image\b[^>]*\/>/gi, "")
    .replace(/<image\b[^>]*>[\s\S]*?<\/image\s*>/gi, "")
    .replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/@import\s+(?:url\([^)]*\)|[^;]+);?/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]+\1\s*\)/gi, "none")
    .replace(/\s(?:href|xlink:href)=(['"])(?!#)[^'"\s]*\1/gi, "");
}

function setMermaidSvgDimensions(svg: SVGElement) {
  const viewBox = svg.getAttribute("viewBox")?.trim().split(/[ ,]+/).map(Number);
  if (viewBox?.length === 4 && viewBox.every(Number.isFinite)) {
    if (!svg.getAttribute("width") && viewBox[2]! > 0) svg.setAttribute("width", `${Math.ceil(viewBox[2]!)}px`);
    if (!svg.getAttribute("height") && viewBox[3]! > 0) svg.setAttribute("height", `${Math.ceil(viewBox[3]!)}px`);
  }
}

/** Remove SVG resources that would taint a canvas and make its dimensions explicit. */
export function sanitizeMermaidSvg(svgMarkup: string): string {
  if (typeof DOMParser !== "undefined" && typeof XMLSerializer !== "undefined") {
    const document = new DOMParser().parseFromString(svgMarkup, "image/svg+xml");
    const svg = document.documentElement;
    if (svg?.localName === "svg") {
      document.querySelectorAll("image, foreignObject").forEach((node) => node.remove());
      document.querySelectorAll("*").forEach((element) => {
        for (const attribute of Array.from(element.attributes)) {
          if ((attribute.localName === "href" || attribute.name === "href" || attribute.name === "xlink:href") && !attribute.value.trim().startsWith("#")) {
            element.removeAttribute(attribute.name);
          }
          if (attribute.name === "style") element.setAttribute("style", sanitizeMermaidSvgText(attribute.value));
        }
      });
      document.querySelectorAll("style").forEach((style) => {
        style.textContent = sanitizeMermaidSvgText(style.textContent || "");
      });
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      setMermaidSvgDimensions(svg as unknown as SVGElement);
      return new XMLSerializer().serializeToString(svg);
    }
  }

  let svg = sanitizeMermaidSvgText(svgMarkup);

  const viewBox = /\bviewBox=(['"])([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)[ ,]+([-+\d.eE]+)\1/i.exec(svg);
  const width = viewBox ? Math.ceil(Number(viewBox[4])) : 0;
  const height = viewBox ? Math.ceil(Number(viewBox[5])) : 0;
  if (!/\sxmlns=(['"])http:\/\/www\.w3\.org\/2000\/svg\1/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (width > 0 && !/\swidth=(['"])[^'"]+\1/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, `<svg width="${width}px"`);
  }
  if (height > 0 && !/\sheight=(['"])[^'"]+\1/i.test(svg)) {
    svg = svg.replace(/<svg\b/i, `<svg height="${height}px"`);
  }
  return svg;
}

function saveMermaidSvg(svg: string, date: string) {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `mermaid-${date}.svg`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadMermaidImage(svgMarkup: string) {
  const svg = sanitizeMermaidSvg(svgMarkup);
  const source = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const sourceUrl = URL.createObjectURL(source);
  const image = new Image();
  const date = new Date().toISOString().slice(0, 10);
  image.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      const scale = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      canvas.width = Math.ceil(image.naturalWidth * scale);
      canvas.height = Math.ceil(image.naturalHeight * scale);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas is unavailable");
      context.fillStyle = "#fffdf8";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(sourceUrl);
        if (!blob) {
          saveMermaidSvg(svg, date);
          return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `mermaid-${date}.png`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, "image/png");
    } catch {
      URL.revokeObjectURL(sourceUrl);
      saveMermaidSvg(svg, date);
    }
  };
  image.onerror = () => {
    URL.revokeObjectURL(sourceUrl);
    saveMermaidSvg(svg, date);
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
          themeVariables: {
            background: "transparent",
            primaryColor: "#fffdf8",
            primaryBorderColor: "#89958b",
            lineColor: "#68766d",
            clusterBkg: "#f5f7f3",
            clusterBorder: "#cbd4cc",
            tertiaryColor: "transparent"
          },
          flowchart: { htmlLabels: false, curve: "basis" }
        });
        return mermaid.render(renderId, normalizeMermaidChart(chart));
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
      {svg && <div className="md-mermaid-toolbar"><span>Mermaid 图表</span><button type="button" className="md-mermaid-export" onClick={() => downloadMermaidImage(svg)} title="导出 PNG 图片">导出 PNG</button></div>}
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
