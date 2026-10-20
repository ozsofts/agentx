import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChatCircle, FolderOpen, GearSix, PencilSimple, Plus, PushPin } from "@phosphor-icons/react";

export default function ProjectInfo({ project, active, open, onOpen, onClose, onSelect, onCreateSession, onManage, onPin }) {
  const anchor = useRef(null);
  const panel = useRef(null);
  const showTimer = useRef();
  const closeTimer = useRef();
  const restoringFocus = useRef(false);
  const [position, setPosition] = useState(null);
  const clearTimers = useCallback(() => { clearTimeout(showTimer.current); clearTimeout(closeTimer.current); }, []);
  const close = useCallback(() => { clearTimers(); onClose(project.id); }, [clearTimers, onClose, project.id]);
  const show = () => { clearTimers(); onOpen(project.id); };
  const leave = () => {
    clearTimers();
    closeTimer.current = setTimeout(() => { if (!panel.current?.contains(document.activeElement)) close(); }, 180);
  };
  const blur = (event) => {
    if (!anchor.current?.contains(event.relatedTarget) && !panel.current?.contains(event.relatedTarget)) close();
  };
  const place = useCallback(() => {
    const rect = anchor.current?.getBoundingClientRect();
    if (!rect || !panel.current) return;
    const width = Math.min(324, innerWidth - 24);
    const left = Math.max(12, Math.min(rect.right + 8, innerWidth - width - 12));
    const top = Math.max(12, Math.min(rect.top, innerHeight - panel.current.offsetHeight - 12));
    setPosition((current) => current?.top === top && current?.left === left && current?.width === width ? current : { left, top, width });
  }, []);
  useLayoutEffect(() => { if (open) place(); }, [open, place, project.name, project.rootPath]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => { if (!anchor.current?.contains(event.target) && !panel.current?.contains(event.target)) close(); };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      restoringFocus.current = true;
      anchor.current?.querySelector(".project-nav-item")?.focus({ preventScroll: true });
      restoringFocus.current = false;
    };
    const scroll = (event) => { if (event.target instanceof Element && event.target.contains(anchor.current)) close(); };
    const observer = new ResizeObserver(place);
    observer.observe(panel.current);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", scroll, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", scroll, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open, place, close]);
  useEffect(() => clearTimers, [clearTimers]);
  const edit = () => { close(); onManage(project.id); };
  return <>
    <div ref={anchor} className="project-nav-item-wrap"
      onPointerEnter={() => { clearTimers(); showTimer.current = setTimeout(show, 250); }} onPointerLeave={leave}
      onFocusCapture={() => { if (!restoringFocus.current) show(); }} onBlur={blur}>
      <button className={`project-nav-item ${active ? "is-active" : ""}`} onClick={() => { close(); onSelect(project.id); }}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? `project-info-${project.id}` : undefined}
        onKeyDown={(event) => { if (event.key === "ArrowRight") { event.preventDefault(); show(); requestAnimationFrame(() => panel.current?.querySelector("button")?.focus({ preventScroll: true })); } }}>
        <span className={`project-nav-icon ${project.pathExists === false ? "is-missing" : ""}`}><FolderOpen size={16} /></span>
        <span className="task-copy"><span className="task-title">{project.name}</span></span>
      </button>
      <div className="project-nav-actions">
        <button className="project-nav-action" onClick={() => { close(); onCreateSession(project); }} title="新建 Session" aria-label="新建 Session"><Plus size={14} weight="bold" /></button>
        <button className="project-nav-action" onClick={edit} title="编辑当前项目" aria-label="编辑当前项目"><PencilSimple size={14} /></button>
      </div>
    </div>
    {open && createPortal(<section ref={panel} id={`project-info-${project.id}`} role="dialog" aria-label={`${project.name} 项目信息`} className="project-info-popover"
      style={{ ...position, visibility: position ? "visible" : "hidden" }} onPointerEnter={clearTimers} onPointerLeave={leave} onBlur={blur}>
      <header><FolderOpen size={18} /><strong>{project.name}</strong><button className="icon-button" title={project.pinned ? "取消固定项目" : "固定项目"} aria-label={project.pinned ? "取消固定项目" : "固定项目"} aria-pressed={Boolean(project.pinned)} onClick={() => onPin(project.id, { pinned: !project.pinned })}><PushPin size={17} weight={project.pinned ? "fill" : "regular"} /></button></header>
      <div className="project-info-count"><ChatCircle size={17} /><span>{(project.sessions || []).filter((session) => !session.archived).length} 个会话{project.archived ? " · 已归档" : ""}</span></div>
      <div className="project-info-path"><FolderOpen size={17} /><span>{project.rootPath}{project.pathExists === false && <small>目录不可用，请重新关联</small>}</span></div>
      <button className="project-info-edit" onClick={edit}><GearSix size={17} />编辑项目</button>
    </section>, document.body)}
  </>;
}
