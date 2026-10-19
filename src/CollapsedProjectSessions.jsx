import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, CircleNotch, FileText, FolderOpen, Plus } from "@phosphor-icons/react";

export default function CollapsedProjectSessions({ project, active, activeTaskId, runningSessions, open, onOpen, onClose, onSessionSelect, onCreateSession }) {
  const trigger = useRef(null);
  const panel = useRef(null);
  const closeTimer = useRef(null);
  const restoreFocus = useRef(false);
  const panelId = useId();
  const [position, setPosition] = useState(null);
  const sessions = (project.sessions || []).filter((session) => !session.archived);
  const cancelClose = useCallback(() => clearTimeout(closeTimer.current), []);
  const close = useCallback(() => { cancelClose(); onClose(project.id); }, [cancelClose, onClose, project.id]);
  const place = useCallback(() => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const left = rect.right + 8;
    const width = Math.min(324, window.innerWidth - left - 12);
    const maxHeight = Math.min(440, window.innerHeight - 24);
    const height = Math.min(panel.current?.offsetHeight || maxHeight, maxHeight);
    setPosition({ left, top: Math.max(12, Math.min(rect.top, window.innerHeight - height - 12)), width, maxHeight });
  }, []);
  const show = () => { cancelClose(); place(); onOpen(project.id); };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      if (!panel.current?.contains(document.activeElement)) close();
    }, 180);
  };
  const leaveFocus = (event) => {
    if (trigger.current?.contains(event.relatedTarget) || panel.current?.contains(event.relatedTarget)) return;
    close();
  };
  const focusSession = () => requestAnimationFrame(() => (panel.current?.querySelector(".project-session-item") || panel.current?.querySelector("button"))?.focus());

  useLayoutEffect(() => { if (open) place(); }, [open, place, sessions.length]);
  useEffect(() => {
    if (!open) { cancelClose(); return; }
    const outside = (event) => {
      if (!trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) close();
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      restoreFocus.current = true;
      trigger.current?.focus();
      restoreFocus.current = false;
    };
    const scroll = (event) => { if (!panel.current?.contains(event.target)) close(); };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
      cancelClose();
    };
  }, [open, close, cancelClose]);
  useEffect(() => cancelClose, [cancelClose]);

  return <>
    <button
      ref={trigger}
      className={`project-nav-item ${active ? "is-active" : ""}`}
      aria-label={`${project.name} 的会话`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? panelId : undefined}
      title={open ? undefined : project.name}
      onPointerEnter={show}
      onPointerLeave={scheduleClose}
      onFocus={() => { if (!restoreFocus.current) show(); }}
      onBlur={leaveFocus}
      onClick={() => { show(); focusSession(); }}
      onKeyDown={(event) => {
        if (event.key === "ArrowRight" || event.key === "ArrowDown") { event.preventDefault(); show(); focusSession(); }
      }}
    >
      <span className={`project-nav-icon ${project.pathExists === false ? "is-missing" : ""}`}><FolderOpen size={16} /></span>
    </button>
    {open && position && createPortal(
      <section
        ref={panel}
        id={panelId}
        className="project-session-popover"
        role="dialog"
        aria-label={`${project.name} 的会话`}
        style={position}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onBlur={leaveFocus}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const items = [...panel.current.querySelectorAll(".project-session-item")];
          if (!items.length) return;
          event.preventDefault();
          const index = items.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
          items[next].focus();
        }}
      >
        <header className="project-session-popover-header">
          <div className="project-session-popover-heading">
            <strong title={project.name}>{project.name}</strong>
            <span>{sessions.length} 个 Session{project.archived ? " · 已归档" : ""}</span>
          </div>
          <button className="icon-button" title="新建 Session" aria-label="在此项目新建 Session" disabled={project.archived || project.pathExists === false} onClick={() => { close(); onCreateSession(project); }}><Plus size={17} /></button>
        </header>
        <nav className="project-session-popover-list" aria-label="选择会话">
          {sessions.map((session) => <button
            key={session.sessionId}
            data-session-id={session.sessionId}
            className={`project-session-item ${activeTaskId === session.sessionId ? "is-active" : ""}`}
            aria-current={activeTaskId === session.sessionId ? "page" : undefined}
            title={session.title || "未命名会话"}
            onClick={() => { close(); onSessionSelect(project, session); }}
          >
            {runningSessions[session.sessionId] ? <CircleNotch size={14} className="spin session-running-icon" aria-label="正在处理" /> : <FileText size={14} />}
            <span>{session.title || "未命名会话"}</span>
            {runningSessions[session.sessionId] && <small className="session-running-label">进行中</small>}
            {activeTaskId === session.sessionId && <Check size={14} className="project-session-current" aria-label="当前会话" />}
          </button>)}
          {!sessions.length && <p className="project-session-popover-empty">暂无会话，点击右上角 + 开始新会话。</p>}
        </nav>
      </section>, document.body,
    )}
  </>;
}
