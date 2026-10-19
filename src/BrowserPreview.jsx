import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, ArrowsClockwise, CaretLeft, CaretRight, X } from "@phosphor-icons/react";
import { websiteUrl } from "../electron/browser-url.mjs";

export default function BrowserPreview({ id, url, state, visible, onUpdate }) {
  const surface = useRef(null);
  const [address, setAddress] = useState(state?.url || url);
  const [error, setError] = useState("");
  const [demoUrl, setDemoUrl] = useState(url);
  const updateRef = useRef(onUpdate);
  updateRef.current = onUpdate;
  useEffect(() => { setAddress(state?.url || url); }, [state?.url, url]);
  const desktop = Boolean(window.piDesktop?.browser);
  async function command(type, extra = {}) {
    try {
      setError("");
      const result = await window.piDesktop.browser({ type, id, ...extra });
      if (result) updateRef.current(result);
    } catch (failure) { setError(failure.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
  }
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    let ready = false;
    let frame;
    let previous = "";
    const sync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!ready || cancelled) return;
        const element = surface.current;
        const blocked = !visible || !element?.getClientRects().length || element.closest("[hidden]") || element.querySelector(".preview-error") || document.querySelector(".modal-backdrop, .work-operation-menu, .project-session-popover, .work-panel.is-resizing");
        const rect = element?.getBoundingClientRect();
        const operation = blocked ? { type: "hide", id } : { type: "bounds", id, bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
        const signature = JSON.stringify(operation);
        if (signature === previous) return;
        previous = signature;
        window.piDesktop.browser(operation).catch(() => {});
      });
    };
    window.piDesktop.browser({ type: "open", id, url }).then((result) => {
      if (cancelled) { window.piDesktop.browser({ type: "hide", id }).catch(() => {}); return; }
      if (result) updateRef.current(result);
      ready = true;
      sync();
    }).catch((failure) => { if (!cancelled) setError(failure.message); });
    const resize = new ResizeObserver(sync);
    resize.observe(surface.current);
    const mutations = new MutationObserver(sync);
    mutations.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden", "inert", "class", "style"] });
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
      window.piDesktop.browser({ type: "hide", id }).catch(() => {});
    };
  }, [id, desktop, visible]);

  async function navigate(event) {
    event.preventDefault();
    try {
      const target = websiteUrl(address);
      setError(""); setAddress(target);
      if (desktop) await command("navigate", { url: target });
      else { setDemoUrl(target); updateRef.current({ url: target, title: new URL(target).host }); }
    } catch { setError("请输入有效的 HTTP 或 HTTPS 网页地址。"); }
  }
  function external() {
    if (desktop) command("external", { url: state?.url || demoUrl });
    else window.open(demoUrl, "_blank", "noopener,noreferrer");
  }
  return <div className="browser-preview" data-browser-id={id}>
    <form className="browser-toolbar" onSubmit={navigate}>
      <button type="button" className="icon-button" title="后退" aria-label="网页后退" disabled={!state?.canBack} onClick={() => command("back")}><CaretLeft size={16} /></button>
      <button type="button" className="icon-button" title="前进" aria-label="网页前进" disabled={!state?.canForward} onClick={() => command("forward")}><CaretRight size={16} /></button>
      <button type="button" className="icon-button" title={state?.loading ? "停止加载" : "刷新网页"} aria-label="刷新网页" onClick={() => desktop ? command(state?.loading ? "stop" : "reload") : setDemoUrl(`${demoUrl}`)}>{state?.loading ? <X size={15} /> : <ArrowsClockwise size={15} />}</button>
      <input aria-label="网页地址" value={address} onChange={(event) => setAddress(event.target.value)} spellCheck={false} />
      <button type="button" className="icon-button" title="在系统浏览器中打开" aria-label="在系统浏览器中打开" onClick={external}><ArrowSquareOut size={16} /></button>
    </form>
    {!desktop && <div className="html-preview-note">浏览器演示：部分网站限制内嵌显示，桌面版使用独立浏览区域。</div>}
    <div ref={surface} className="browser-surface">
      {error || state?.error ? <div className="preview-error" role="alert"><strong>无法打开网页</strong><p>{error || state.error}</p><button onClick={() => command("reload")}>重试</button> <button onClick={external}>在系统浏览器中打开</button></div>
        : !desktop ? <iframe title={`网页 ${demoUrl}`} src={demoUrl} sandbox="allow-scripts allow-forms allow-same-origin" referrerPolicy="no-referrer" />
        : state?.loading ? <div className="preview-placeholder">正在加载网页…</div> : null}
    </div>
  </div>;
}
