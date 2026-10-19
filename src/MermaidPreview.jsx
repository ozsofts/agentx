import { useEffect, useState } from "react";

let sequence = 0;
let renderer;
export default function MermaidPreview({ source }) {
  const [result, setResult] = useState({});
  useEffect(() => {
    let cancelled = false;
    setResult({});
    (async () => {
      try {
        if (source.length > 50_000) throw new Error("图表内容过长，请减少到 50,000 字符以内。");
        renderer ||= import("mermaid").then(({ default: mermaid }) => {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral", suppressErrorRendering: true, maxTextSize: 50_000, maxEdges: 500 });
          return mermaid;
        });
        const mermaid = await renderer;
        const { svg } = await mermaid.render(`preview-mermaid-${++sequence}`, source);
        if (!cancelled) setResult({ image: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
      } catch (error) {
        if (!cancelled) setResult({ error: error.message });
      }
    })();
    return () => { cancelled = true; };
  }, [source]);
  if (result.error) return <div className="preview-error" role="alert"><strong>Mermaid 图表无法渲染</strong><p>请切换到源码，检查图表语法。</p><details><summary>错误详情</summary><pre>{result.error}</pre></details></div>;
  if (!result.image) return <div className="preview-placeholder" role="status">正在绘制图表…</div>;
  return <img className="mermaid-image" src={result.image} alt="Mermaid 图表" />;
}
