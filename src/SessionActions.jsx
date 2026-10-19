import { useEffect, useRef, useState } from "react";
import { Archive, DotsThree, DownloadSimple, FileText, Info, PencilSimple, UploadSimple, WarningCircle, X } from "@phosphor-icons/react";
import Modal from "./Modal.jsx";

const failureText = (failure) => (failure.message || "会话操作失败").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");

export default function SessionActions({ transport, sessionId, session, project, projects, running, onRename, onImported, onArchive, demo }) {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [source, setSource] = useState(null);
  const [projectId, setProjectId] = useState("");
  const [info, setInfo] = useState(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const token = useRef(null);
  const persisted = Boolean(session?.sessionFile && !session.archived);
  const blocked = running || busy || demo;
  const closeDialog = () => {
    if (busy) return;
    if (token.current) transport?.sessionCommand({ type: "cancel-import", token: token.current }).catch(() => {});
    token.current = null;
    setDialog(null); setError(""); trigger.current?.focus();
  };

  useEffect(() => {
    const outside = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, []);
  useEffect(() => {
    setOpen(false); setDialog(null); setNotice(""); setError("");
    if (token.current) transport?.sessionCommand({ type: "cancel-import", token: token.current }).catch(() => {});
    token.current = null;
  }, [sessionId, transport]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  }, [open]);

  const act = async (action) => {
    setOpen(false); setError(""); setNotice("");
    if (action === "rename") { onRename(); return; }
    setDialog(action);
    if (action === "info") {
      setInfo(null); setBusy(true);
      try { setInfo(await transport.sessionCommand({ type: "info", sessionId })); }
      catch (failure) { setError(failureText(failure)); }
      finally { setBusy(false); }
    }
    if (action === "import") {
      setSource(null); setProjectId(project?.id || "");
    }
  };
  const chooseImport = async () => {
    setBusy(true); setError("");
    try {
      const result = await transport.sessionCommand({ type: "choose-import" });
      if (result) { token.current = result.token; setSource(result); }
    } catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  const transfer = async (format) => {
    setBusy(true); setError("");
    try {
      const result = await transport.sessionCommand(dialog === "import"
        ? { type: "import", token: source.token, projectId }
        : { type: "export", format, projectId: project.id, sessionId });
      if (!result) return;
      if (dialog === "import") { token.current = null; onImported(result); }
      else setNotice(`已导出到 ${result.filePath}`);
      setDialog(null);
    } catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  const archive = async () => {
    setBusy(true); setError("");
    try { await onArchive(); setDialog(null); }
    catch (failure) { setError(failureText(failure)); }
    finally { setBusy(false); }
  };
  const menuKey = (event) => {
    if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    if (event.key === "Tab") setOpen(false);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...root.current.querySelectorAll('[role="menuitem"]:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  const targetProject = projects.find((item) => item.id === projectId);
  return <div className="session-actions" ref={root}>
    <button ref={trigger} className="icon-button" title="会话操作" aria-label="会话操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}><DotsThree size={20} weight="bold" /></button>
    {open && <div className="session-menu" role="menu" aria-label="会话操作" onKeyDown={menuKey}>
      <div className="session-menu-heading">{session?.title || "新会话"}</div>
      <button role="menuitem" disabled={blocked || !persisted} onClick={() => act("rename")}><PencilSimple />重命名会话</button>
      <button role="menuitem" disabled={blocked || !persisted} onClick={() => act("export")}><DownloadSimple />导出会话…</button>
      <button role="menuitem" disabled={blocked || !project} onClick={() => act("import")}><UploadSimple />导入会话…</button>
      <button role="menuitem" disabled={busy || demo || !project} onClick={() => act("info")}><Info />会话信息</button>
      <div className="session-menu-separator" />
      <button role="menuitem" disabled={blocked || !persisted} onClick={() => act("archive")}><Archive />归档会话</button>
      {(running || !persisted || demo) && <p className="session-menu-hint">{demo ? "演示模式 · 本地会话操作需使用 Desktop" : running ? "任务运行中，部分操作暂不可用" : "发送第一条消息后保存会话"}</p>}
    </div>}
    {notice && <div className="session-notice" role="status"><span>{notice}</span><button className="icon-button" title="关闭提示" onClick={() => setNotice("")}><X size={14} /></button></div>}
    {dialog && <Modal onClose={closeDialog}>
      <section className="small-dialog session-operation-dialog" role="dialog" aria-modal="true" aria-labelledby="session-action-title">
        <header className="small-dialog-header"><div><FileText size={20} /><div><h2 id="session-action-title">{{ import: "导入会话", export: "导出会话", info: "会话信息", archive: "归档会话" }[dialog]}</h2><p>{project?.name || "当前项目"}</p></div></div><button className="icon-button" title="关闭" disabled={busy} onClick={closeDialog}><X size={18} /></button></header>
        <div className="small-dialog-form">
          {dialog === "import" && <>
            <label className="field-control"><span>导入到项目</span><select value={projectId} disabled={busy || running} onChange={(event) => setProjectId(event.target.value)}>{projects.filter((item) => !item.removed && !item.archived && item.pathExists !== false).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
            <p className="session-detail-path">{targetProject?.rootPath}</p>
            <button className="button-quiet session-file-picker" disabled={busy || running} onClick={chooseImport}><UploadSimple size={16} />{source ? "重新选择 JSONL" : "选择 JSONL 会话文件"}</button>
            {source && <div className="session-import-summary"><strong>{source.fileName}</strong><span>{source.title} · {source.messageCount} 条消息</span><span>原项目目录：{source.sourceCwd}</span></div>}
            <p className="session-explanation">确认后创建独立会话并打开，保留当前会话及原文件。</p>
          </>}
          {dialog === "export" && <><p className="session-explanation">HTML 方便阅读；JSONL 保留工具调用、推理记录和会话历史，可再次导入。</p><div className="session-export-options"><button disabled={busy || running} className="button-quiet" onClick={() => transfer("html")}><FileText size={18} /><span>HTML 阅读副本</span></button><button disabled={busy || running} className="button-quiet" onClick={() => transfer("jsonl")}><DownloadSimple size={18} /><span>JSONL 完整备份</span></button></div></>}
          {dialog === "info" && (info ? <dl className="session-info-list">{[
            ["名称", session?.title || "未保存的新会话"], ["项目", project?.name], ["项目目录", info.cwd], ["Session ID", info.sessionId], ["记录文件", persisted ? info.sessionFile : "尚未保存，发送第一条消息后创建"], ["当前模型", info.model ? `${info.model.provider} / ${info.model.name || info.model.id}` : "未选择"], ["权限模式", { ask: "执行前询问", full: "完全访问", "read-only": "只读" }[info.permissionMode]], ["消息数", info.stats?.totalMessages],
          ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ?? "—"}</dd></div>)}</dl> : <p className="session-explanation">{busy ? "正在读取…" : "无法读取会话信息"}</p>)}
          {dialog === "archive" && <p className="session-explanation">归档“{session?.title || "当前会话"}”后，将从侧栏隐藏并打开新的空会话。JSONL 记录会保留，可在当前项目的信息页面中恢复。</p>}
          {running && dialog !== "info" && <p className="settings-error">任务正在运行，请先等待完成。</p>}
          {error && <div className="settings-error" role="alert"><WarningCircle size={15} />{error}</div>}
          <div className="small-dialog-actions"><button className="button-quiet" disabled={busy} onClick={closeDialog}>{dialog === "info" ? "关闭" : "取消"}</button>{dialog === "import" && <button className="button-primary" disabled={busy || running || !source || !targetProject} onClick={() => transfer()}>{busy ? "导入中…" : "确认导入并打开"}</button>}{dialog === "archive" && <button className="button-primary" disabled={busy || running} onClick={archive}>{busy ? "归档中…" : "确认归档"}</button>}</div>
        </div>
      </section>
    </Modal>}
  </div>;
}
