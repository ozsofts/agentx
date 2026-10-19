import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { ArrowsClockwise, ArrowsOutSimple, ArrowsInSimple, CaretLeft, CaretRight, Code, Columns, Eye, FileText, FolderOpen, GitDiff, Globe, Minus, Plus, ShieldCheck, WarningCircle, X } from "@phosphor-icons/react";
import MermaidPreview from "./MermaidPreview.jsx";
import usePanelResize from "./usePanelResize.js";
import BrowserPreview from "./BrowserPreview.jsx";
import { websiteUrl } from "../electron/browser-url.mjs";

// three.js is only needed when a GLB is actually opened.
const GlbPreview = lazy(() => import("./GlbPreview.jsx"));

function ImagePreview({ document, revision }) {
  const [zoom, setZoom] = useState(null);
  const [width, setWidth] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [document.url, revision]);
  return <div className="image-preview">
    <div className="image-controls">
      <button className={!zoom ? "is-active" : ""} onClick={() => setZoom(null)}>适应</button>
      <button onClick={() => setZoom(100)}>原尺寸</button>
      <button aria-label="缩小图片" onClick={() => setZoom((value) => Math.max(10, (value || 100) - 25))}><Minus size={14} /></button>
      <span>{zoom ? `${zoom}%` : "自动"}</span>
      <button aria-label="放大图片" onClick={() => setZoom((value) => Math.min(400, (value || 100) + 25))}><Plus size={14} /></button>
    </div>
    <div className="image-canvas">{failed ? <div className="preview-error" role="alert">无法解码此图片，请检查文件格式是否正确。</div> : <img src={document.url.startsWith("blob:") ? document.url : `${document.url}?v=${revision}`} alt={document.name} onLoad={(event) => setWidth(event.currentTarget.naturalWidth)} onError={() => setFailed(true)} style={{ maxWidth: zoom ? "none" : "100%", width: zoom && width ? width * zoom / 100 : undefined }} />}</div>
  </div>;
}

export default function WorkPanel({ open, visible = true, cwd, sessionId, stateCache, onClose, request, renderDiff, MarkdownContent, changeCount = 0 }) {
  const saved = stateCache?.get(sessionId);
  const [tabs, setTabs] = useState(() => saved?.tabs || []);
  const [active, setActive] = useState(() => saved?.active || null);
  const [expanded, setExpanded] = useState(false);
  const [operationMenu, setOperationMenu] = useState(false);
  const [webForm, setWebForm] = useState(false);
  const [webAddress, setWebAddress] = useState("");
  const [notice, setNotice] = useState("");
  const [tabScroll, setTabScroll] = useState({ overflow: false, left: false, right: false });
  const tabsRef = useRef(tabs);
  const generation = useRef(0);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const resize = usePanelResize(panelRef);
  const tabListRef = useRef(null);
  const operationRef = useRef(null);
  tabsRef.current = tabs;
  useEffect(() => { stateCache?.set(sessionId, { tabs, active }); }, [stateCache, sessionId, tabs, active]);
  useEffect(() => {
    if (!open) return;
    const list = tabListRef.current;
    const tab = list?.querySelector('[aria-selected="true"]')?.closest('.work-tab');
    if (tab && list) {
      const left = tab.offsetLeft - list.offsetLeft;
      if (left < list.scrollLeft) list.scrollLeft = left;
      else if (left + tab.offsetWidth > list.scrollLeft + list.clientWidth) list.scrollLeft = left + tab.offsetWidth - list.clientWidth;
    }
  }, [active, open]);
  useEffect(() => {
    if (!operationMenu) return;
    const dismiss = (event) => { if (event.key === "Escape" || (event.type === "pointerdown" && !operationRef.current?.contains(event.target))) setOperationMenu(false); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", dismiss); };
  }, [operationMenu]);
  useEffect(() => {
    const list = tabListRef.current;
    if (!open || !list) return;
    const update = () => {
      const remaining = list.scrollWidth - list.clientWidth - list.scrollLeft;
      const next = { overflow: list.scrollWidth > list.clientWidth + 1, left: list.scrollLeft > 1, right: remaining > 1 };
      setTabScroll((current) => current.overflow === next.overflow && current.left === next.left && current.right === next.right ? current : next);
    };
    const observer = new ResizeObserver(update);
    observer.observe(list);
    for (const tab of list.children) observer.observe(tab);
    list.addEventListener("scroll", update, { passive: true });
    update();
    return () => { observer.disconnect(); list.removeEventListener("scroll", update); };
  }, [open, tabs.length]);

  function scrollTabs(direction) {
    const list = tabListRef.current;
    list?.scrollBy({ left: direction * Math.max(120, list.clientWidth * 0.7), behavior: "smooth" });
  }
  useEffect(() => {
    generation.current += 1;
    for (const tab of tabsRef.current) if (!tab.local && !tab.kind) loadFile(tab.path, false);
    return () => {
      generation.current += 1;
      for (const tab of tabsRef.current) {
        if (!tab.local && !tab.kind) window.piDesktop?.preview({ type: "close", path: tab.path }).catch(() => {});
      }
    };
  }, [cwd]);

  async function loadFile(path, select = true, base) {
    const epoch = generation.current;
    if (!window.piDesktop?.preview) { setNotice("浏览器演示模式请使用“打开文件”；项目内文件和自动刷新需要桌面版。"); return; }
    if (select) setNotice("");
    try {
      const document = await window.piDesktop.preview({ type: "read", path, base });
      if (epoch !== generation.current) return;
      setTabs((current) => {
        const previous = current.find((tab) => tab.path === document.path);
        const next = { ...previous, path: document.path, document, error: null, revision: (previous?.revision || 0) + 1, mode: previous?.mode || "preview" };
        return previous ? current.map((tab) => tab.path === document.path ? next : tab) : [...current, next];
      });
      if (select) setActive(document.path);
    } catch (error) {
      if (epoch !== generation.current) return;
      const message = error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      if (select) setNotice(message);
      setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, error: message } : tab));
    }
  }
  function openDiff() {
    setTabs((current) => current.some((tab) => tab.kind === "diff") ? current : [...current, { path: "diff", kind: "diff", document: { name: "变更" } }]);
    setActive("diff"); setWebForm(false); setOperationMenu(false);
  }
  function openWeb(value) {
    try {
      const url = websiteUrl(value);
      const existing = tabsRef.current.find((tab) => tab.kind === "web" && (tab.browser?.url || tab.url) === url);
      if (existing) setActive(existing.path);
      else {
        if (tabsRef.current.length >= 24) { setNotice("最多同时打开 24 个标签。"); return; }
        const tab = { path: `web:${crypto.randomUUID()}`, kind: "web", url, document: { name: new URL(url).host } };
        setTabs((current) => [...current, tab]); setActive(tab.path);
      }
      setWebForm(false); setOperationMenu(false); setWebAddress(""); setNotice("");
    } catch { setNotice("请输入有效的 HTTP 或 HTTPS 网页地址。"); }
  }
  function browserUpdate(path, browser) {
    setTabs((current) => current.map((tab) => tab.path === path ? { ...tab, browser, document: { ...tab.document, name: browser.title || tab.document.name } } : tab));
  }
  useEffect(() => window.piDesktop?.onBrowserChange((event) => {
    const tab = tabsRef.current.find((item) => `${sessionId}:${item.path}` === (event.id || event.openerId));
    if (!tab) return;
    if (event.type === "open") openWeb(event.url);
    else browserUpdate(tab.path, event);
  }), [sessionId]);
  useEffect(() => {
    if (request?.url) openWeb(request.url);
    else if (request?.path) loadFile(request.path);
    else if (request) openDiff();
  }, [request]);
  useEffect(() => window.piDesktop?.onPreviewChange(({ path }) => {
    if (tabsRef.current.some((tab) => tab.path === path)) loadFile(path, false);
  }), [cwd]);

  async function chooseFiles() {
    setOperationMenu(false); setWebForm(false);
    if (!window.piDesktop?.preview) { inputRef.current?.click(); return; }
    try { for (const path of await window.piDesktop.preview({ type: "choose" })) await loadFile(path); }
    catch (error) { setNotice(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "")); }
  }
  async function authorizeFolder() {
    setOperationMenu(false);
    if (!window.piDesktop?.preview) { setNotice("浏览器演示模式不支持授权项目外文件夹。"); return; }
    try {
      const result = await window.piDesktop.preview({ type: "authorize-folder", defaultPath: cwd });
      if (!result) return;
      for (const path of result.opened) await loadFile(path);
      if (!result.opened.length) setNotice(`已授权文件夹：${result.granted}`);
    } catch (error) {
      setNotice(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""));
    }
  }
  async function revokeBase(base) {
    await window.piDesktop?.preview({ type: "revoke", base }).catch(() => {});
    setTabs((current) => current.filter((tab) => tab.document.base !== base));
    setActive(null);
  }
  async function importLocal(event) {
    const files = [...event.target.files];
    for (const file of files) {
      if (tabsRef.current.length >= 24) { setNotice("最多同时预览 24 个文件。"); break; }
      const ext = file.name.split(".").at(-1).toLowerCase();
      const kind = /^(png|jpe?g|gif|webp|avif|bmp)$/.test(ext) ? "image" : ext === "glb" ? "model" : ({ svg: "svg", md: "markdown", markdown: "markdown", html: "html", htm: "html", mmd: "mermaid", mermaid: "mermaid" })[ext] || "text";
      if (file.size > (kind === "image" ? 20 : kind === "model" ? 150 : 2) * 1024 * 1024) { setNotice(`${file.name} 文件过大，无法预览。`); continue; }
      const document = { path: file.name, name: file.name, kind, url: URL.createObjectURL(file), content: kind === "image" ? null : await file.text(), autoRefresh: false };
      const tab = { path: document.path, document, mode: "preview", revision: Date.now(), local: true };
      setTabs((current) => { const old = current.find((item) => item.path === tab.path); if (old?.local) URL.revokeObjectURL(old.document.url); return [...current.filter((item) => item.path !== tab.path), tab]; });
      setActive(tab.path);
    }
    event.target.value = "";
  }
  function closeTab(path) {
    const tab = tabsRef.current.find((item) => item.path === path);
    if (tab?.local) URL.revokeObjectURL(tab.document.url);
    else if (tab?.kind === "web") window.piDesktop?.browser({ type: "close", id: `${sessionId}:${path}` }).catch(() => {});
    else if (!tab?.kind) window.piDesktop?.preview({ type: "close", path }).catch(() => {});
    const remaining = tabsRef.current.filter((item) => item.path !== path);
    setTabs(remaining);
    if (!remaining.length) setWebForm(false);
    if (active === path) setActive(remaining[Math.max(0, tabsRef.current.indexOf(tab) - 1)]?.path || null);
  }
  const hasActive = tabs.some((tab) => tab.path === active);
  const webEntry = () => { setWebForm(true); setOperationMenu(false); setNotice(""); };
  const operations = <><button onClick={openDiff}><GitDiff size={19} /><span>查看变更<small>{changeCount ? `${changeCount} 个文件有变更` : "暂无变更"}</small></span></button><button aria-label="打开预览文件" onClick={chooseFiles}><FolderOpen size={19} /><span>打开文件<small>图片、文档、代码或三维模型</small></span></button><button onClick={webEntry}><Globe size={19} /><span>打开网页<small>输入网址，在这里浏览</small></span></button></>;
  return <aside ref={panelRef} className={`review-panel work-panel${expanded ? " is-expanded" : ""}${resize.dragging ? " is-resizing" : ""}${resize.bounds.overlay ? " is-overlay" : ""}`} style={{ width: resize.width, flexBasis: resize.width, minWidth: resize.bounds.min }} hidden={!open} aria-label="工作面板">
    <div className="work-panel-resizer" role="separator" tabIndex={open ? 0 : -1} aria-label="调整工作面板宽度" aria-orientation="vertical" aria-valuemin={resize.bounds.min} aria-valuemax={Math.round(resize.bounds.max)} aria-valuenow={Math.round(resize.width)} title="拖动调整宽度，双击恢复默认；方向键微调" {...resize.handleProps} />
    <input ref={inputRef} type="file" multiple hidden onChange={importLocal} accept=".png,.jpg,.jpeg,.gif,.webp,.avif,.bmp,.svg,.md,.markdown,.html,.htm,.mmd,.mermaid,.glb,.txt,.json,.css,.js,.ts,.jsx,.tsx,.py,.yml,.yaml" />
    <div className="work-panel-tabbar">
    <div ref={tabListRef} className="work-tabs" role="tablist" aria-label="工作面板标签">
      {tabs.map((tab, index) => <div key={tab.path} className={`work-tab ${active === tab.path ? "is-active" : ""}`}><button id={`work-tab-${index}`} role="tab" aria-selected={active === tab.path} aria-controls={`work-file-${index}`} title={tab.kind === "web" ? tab.browser?.url || tab.url : tab.path} onClick={() => { setActive(tab.path); setWebForm(false); }}>{tab.kind === "diff" ? <GitDiff size={15} /> : tab.kind === "web" ? <Globe size={15} /> : <FileText size={14} />}<span>{tab.document.name}</span></button><button aria-label={`关闭 ${tab.document.name}`} title="关闭标签" onClick={() => closeTab(tab.path)}><X size={12} /></button></div>)}
    </div>
    <div className="work-panel-actions">
      {tabScroll.overflow && <><button className="icon-button" title="向左滚动标签" aria-label="向左滚动标签" disabled={!tabScroll.left} onClick={() => scrollTabs(-1)}><CaretLeft size={14} /></button><button className="icon-button" title="向右滚动标签" aria-label="向右滚动标签" disabled={!tabScroll.right} onClick={() => scrollTabs(1)}><CaretRight size={14} /></button></>}
      <div className="work-operation-anchor" ref={operationRef}><button className="icon-button" title="添加内容" aria-label="添加面板内容" aria-expanded={operationMenu} onClick={() => setOperationMenu((value) => !value)}><Plus size={17} /></button>{operationMenu && <div className="work-operation-menu">{operations}<button aria-label="授权项目外文件夹并打开文件" onClick={authorizeFolder}><ShieldCheck size={18} /><span>授权项目外文件夹</span></button></div>}</div>
      <button className="icon-button" title={expanded ? "恢复分栏" : "展开工作面板"} aria-label={expanded ? "恢复分栏" : "展开工作面板"} onClick={() => setExpanded((value) => !value)}>{expanded ? <ArrowsInSimple size={16} /> : <ArrowsOutSimple size={16} />}</button><button className="icon-button panel-toggle is-active" title="收起工作面板" aria-label="关闭工作面板" aria-expanded={true} onClick={() => { setExpanded(false); setOperationMenu(false); onClose(); }}><Columns size={17} /></button>
    </div>
    </div>
    {notice && <div className="preview-notice" role="alert"><WarningCircle size={15} /><span>{notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setNotice("")}><X size={13} /></button></div>}
    {(webForm || !hasActive) && <div className="work-panel-empty">{webForm ? <form className="web-address-form" onSubmit={(event) => { event.preventDefault(); openWeb(webAddress); }}><Globe size={28} /><h2>打开网页</h2><label htmlFor={`web-address-${sessionId}`}>网页地址</label><input id={`web-address-${sessionId}`} autoFocus placeholder="https://example.com" value={webAddress} onChange={(event) => setWebAddress(event.target.value)} /><div><button type="button" onClick={() => setWebForm(false)}>返回</button><button className="button-primary" type="submit" disabled={!webAddress.trim()}>打开</button></div></form> : <div className="work-empty-actions"><p>在这里查看与当前会话相关的内容</p>{operations}</div>}</div>}
    {tabs.map((tab, index) => <div className="work-tab-content" role="tabpanel" id={`work-file-${index}`} aria-labelledby={`work-tab-${index}`} hidden={webForm || active !== tab.path} key={tab.path}>
      {tab.kind === "diff" ? renderDiff((path) => loadFile(path)) : tab.kind === "web" ? active === tab.path && !webForm && <BrowserPreview id={`${sessionId}:${tab.path}`} url={tab.url} state={tab.browser} visible={open && visible} onUpdate={(state) => browserUpdate(tab.path, state)} /> : <>
      <div className="preview-toolbar">
        <div className="preview-modes">{["preview", "source"].filter((mode) => mode !== "source" || tab.document.content !== null).map((mode) => <button className={tab.mode === mode ? "is-active" : ""} key={mode} onClick={() => setTabs((current) => current.map((item) => item.path === tab.path ? { ...item, mode } : item))}>{mode === "preview" ? <Eye size={14} /> : <Code size={14} />}{mode === "preview" ? "预览" : "源码"}</button>)}</div>
        <span className="preview-update-status">{tab.local ? "本地快照" : tab.document.autoRefresh ? "自动刷新" : "手动刷新"}</span>
        <button className="icon-button" disabled={tab.local} title="刷新文件" aria-label={`刷新 ${tab.document.name}`} onClick={() => loadFile(tab.path, false)}><ArrowsClockwise size={15} /></button>
      </div>
      <div className="preview-path" title={tab.path}>{tab.path}</div>
      {tab.document.external && <div className="preview-notice is-grant"><ShieldCheck size={14} /><span>项目外文件 · 已授权读取 <code>{tab.document.base}</code></span><button className="grant-revoke" onClick={() => revokeBase(tab.document.base)}>撤销授权</button></div>}
      {tab.error ? <div className="preview-error" role="alert"><strong>文件暂时无法读取</strong><p>{tab.error}</p><button onClick={() => loadFile(tab.path, false)}>重新加载</button></div>
        : tab.mode === "source" || tab.document.kind === "text" ? <pre className="preview-source">{tab.document.content}</pre>
        : tab.document.kind === "image" || tab.document.kind === "svg" ? <ImagePreview document={tab.document} revision={tab.revision} />
        : tab.document.kind === "model" ? <Suspense fallback={<div className="preview-placeholder">正在准备三维预览…</div>}><GlbPreview document={tab.document} revision={tab.revision} /></Suspense>
        : tab.document.kind === "markdown" ? <div className="document-preview"><MarkdownContent resourceUrl={`${tab.document.url}?v=${tab.revision}`} onOpenFile={(path) => loadFile(path, true, tab.document.base)}>{tab.document.content}</MarkdownContent></div>
        : tab.document.kind === "mermaid" ? <div className="document-preview"><MermaidPreview source={tab.document.content} /></div>
        : tab.document.kind === "html" ? <><div className="html-preview-note">静态 HTML · 脚本已禁用{tab.local ? " · 相对资源需在桌面项目中预览" : ""}</div><iframe className="html-preview" key={`${tab.path}-${tab.revision}`} title={`预览 ${tab.document.name}`} sandbox="" referrerPolicy="no-referrer" {...(tab.local ? { srcDoc: `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">${tab.document.content}` } : { src: `${tab.document.url}?v=${tab.revision}` })} /></> : null}
    </>}
    </div>)}
  </aside>;
}
