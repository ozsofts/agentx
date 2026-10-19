import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ArrowCounterClockwise,
  ArrowUp,
  ArrowDown,
  CaretDown,
  CaretRight,
  Check,
  CheckCircle,
  Circle,
  CircleNotch,
  Code,
  Columns,
  Copy,
  Cpu,
  FileCode,
  FileText,
  FolderOpen,
  GearSix,
  GitBranch,
  GitDiff,
  ListChecks,
  MagnifyingGlass,
  Paperclip,
  Package,
  PencilSimple,
  Plus,
  PuzzlePiece,
  ArrowsClockwise,
  ShieldCheck,
  SidebarSimple,
  Stop,
  TerminalWindow,
  Trash,
  UploadSimple,
  WarningCircle,
  Wrench,
  X,
} from "@phosphor-icons/react";
import { createTransport } from "./transport.js";
import { markdownFilePath } from "./markdown-file-path.js";
import WorkPanel from "./WorkPanel.jsx";
import SessionActions from "./SessionActions.jsx";
import MermaidPreview from "./MermaidPreview.jsx";
import useThreadScroll from "./useThreadScroll.js";
import Modal from "./Modal.jsx";
import CollapsedProjectSessions from "./CollapsedProjectSessions.jsx";
import QueuedInputs from "./QueuedInputs.jsx";

const desktopMode = Boolean(window.piDesktop);

const initialTasks = [
  { id: "pi-shell", title: "构建 Agentx 桌面端工作区", repo: "agentx", branch: "main", time: "刚刚", status: "done" },
  { id: "rpc-events", title: "统一 RPC 事件协议", repo: "pi-gateway", branch: "feat/events", time: "18 分钟", status: "idle" },
  { id: "permission", title: "设计命令权限策略", repo: "pi-desktop", branch: "feat/permissions", time: "昨天", status: "idle" },
  { id: "sessions", title: "恢复持久化会话", repo: "pi-runtime", branch: "main", time: "昨天", status: "idle" },
];

const starterSessions = {
  "pi-shell": [
    { id: "u1", role: "user", text: "构建 Agentx 本地桌面客户端，先把核心工作区搭起来。" },
    {
      id: "a1",
      role: "assistant",
      text: "我会先梳理现有目录，再把桌面端壳层、任务会话和 Agent Transport 分开。这样 UI 不需要知道底层来自 SDK、RPC 还是远程服务。",
      activities: [
        { id: "t1", status: "done", title: "检查了工作区结构", meta: "12 个文件" },
        { id: "t2", status: "done", title: "读取 Pi RPC 事件模型", meta: "JSONL" },
        { id: "t3", status: "done", title: "定义 Agent Transport", meta: "9 个事件" },
      ],
    },
    {
      id: "a2",
      role: "assistant",
      text: "初始版本已经形成完整闭环。Agent Host 会负责把 Pi 原始事件转换成稳定的页面协议。\n\n| 能力 | 状态 |\n| --- | --- |\n| 选择项目与恢复会话 | 已完成 |\n| 实时工具状态与命令审批 | 已完成 |\n| 文件变更审查 | 已完成 |\n\n```ts\ninterface AgentTransport {\n  subscribe(listener: EventListener): Unsubscribe;\n}\n```",
      changes: { files: 6, additions: 248, deletions: 42 },
    },
  ],
  "rpc-events": [
    { id: "u2", role: "user", text: "把 Pi SDK 和 RPC 的事件整理成页面能长期依赖的协议。" },
    { id: "a3", role: "assistant", text: "事件层会统一 session、run、message、tool 和 approval 五类标识，并为断线恢复保留 sequence。", activities: [{ id: "t4", status: "done", title: "整理事件映射", meta: "18 类事件" }] },
  ],
  permission: [
    { id: "u3", role: "user", text: "命令权限要支持只读、执行前询问和完全访问。" },
    { id: "a4", role: "assistant", text: "权限判断会放在工具真正执行之前。页面确认只负责收集用户决策，Agent Host 才是执行门。" },
  ],
  sessions: [
    { id: "u4", role: "user", text: "应用重启后继续显示原来的会话。" },
    { id: "a5", role: "assistant", text: "Pi Session JSONL 作为消息事实来源，应用只额外维护任务标题、工作目录和最近打开时间。" },
  ],
};

const changedFiles = [
  { name: "src/agent/transport.ts", status: "M", plus: 64, minus: 12 },
  { name: "src/agent/pi-sdk.ts", status: "A", plus: 82, minus: 0 },
  { name: "src/agent/events.ts", status: "A", plus: 51, minus: 0 },
  { name: "src/components/thread.tsx", status: "M", plus: 31, minus: 18 },
  { name: "src/components/composer.tsx", status: "M", plus: 20, minus: 8 },
  { name: "src/styles/app.css", status: "M", plus: 0, minus: 4 },
];

function StatusIcon({ status }) {
  if (status === "running") return <CircleNotch size={16} weight="bold" className="spin" />;
  if (status === "error") return <WarningCircle size={16} weight="fill" />;
  return <CheckCircle size={16} weight="fill" />;
}

function ActivityRow({ activity }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const output = activity.output || "完成，没有额外输出。";

  const copyOutput = async (event) => {
    event.stopPropagation();
    if (!navigator.clipboard) return;
    await navigator.clipboard.writeText(output);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  if (activity.kind === "reasoning") {
    const thinking = activity.status === "running";
    const expanded = thinking || open;
    return (
      <div className={`reasoning-step ${expanded ? "is-open" : ""}`}>
        <button type="button" className="reasoning-step-heading" aria-expanded={expanded} aria-disabled={thinking} onClick={() => { if (!thinking) setOpen((value) => !value); }}>
          {thinking ? <CircleNotch size={15} weight="bold" className="spin" /> : <Cpu size={15} />}
          <span>{activity.title || "思考过程"}</span>
          <span className="activity-meta">{activity.meta}</span>
          <CaretRight size={14} className="activity-caret" />
        </button>
        {expanded && activity.output && <div className="reasoning-output"><MarkdownContent>{activity.output}</MarkdownContent></div>}
      </div>
    );
  }

  return (
    <div className={`activity ${open ? "is-open" : ""}`}>
      <button className="activity-summary" onClick={() => setOpen((value) => !value)}>
        <StatusIcon status={activity.status} />
        <span>{activity.title}</span>
        <span className="activity-meta">{activity.meta}</span>
        <CaretRight size={14} className="activity-caret" />
      </button>
      {open && (
        <div className="tool-output-wrap">
          <div className="tool-output-toolbar">
            <span>执行输出</span>
            <button type="button" onClick={copyOutput} title={copied ? "已复制" : "复制输出"} aria-label={copied ? "输出已复制" : "复制输出"}>
              {copied ? <Check size={13} /> : <Copy size={13} />}
              <span>{copied ? "已复制" : "复制"}</span>
            </button>
          </div>
          <pre className="tool-output">{output}</pre>
        </div>
      )}
    </div>
  );
}

function formatElapsed(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "";
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 1) return "不到 1 秒";
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (!minutes) return `${seconds} 秒`;
  return remainder ? `${minutes} 分钟 ${remainder} 秒` : `${minutes} 分钟`;
}

function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentList({ attachments = [], onRemove, pending = false }) {
  if (!attachments.length) return null;
  return (
    <div className={`attachment-list ${pending ? "is-pending" : ""}`}>
      {attachments.map((attachment) => (
        <div className={`attachment-item is-${attachment.kind}`} key={attachment.id || `${attachment.name}-${attachment.size}`}>
          {attachment.kind === "image" ? (
            <img className="attachment-thumb" src={`data:${attachment.mimeType};base64,${attachment.data}`} alt={attachment.name} />
          ) : (
            <span className="attachment-file-icon">{/\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|cs|php|sh|sql)$/i.test(attachment.name) ? <FileCode size={17} /> : <FileText size={17} />}</span>
          )}
          <span className="attachment-copy"><strong title={attachment.name}>{attachment.name}</strong><span>{formatFileSize(attachment.size)}</span></span>
          {onRemove && <button className="attachment-remove" type="button" onClick={() => onRemove(attachment.id)} title={`移除 ${attachment.name}`} aria-label={`移除 ${attachment.name}`}><X size={13} /></button>}
        </div>
      ))}
    </div>
  );
}

function ProcessGroup({ message }) {
  const running = message.status === "running" || message.activities.some((activity) => activity.status === "running");
  const thinking = message.activities.some((activity) => activity.kind === "reasoning" && activity.status === "running");
  const failed = message.status === "error" || message.activities.some((activity) => activity.status === "error");
  const [open, setOpen] = useState(running);
  const wasRunning = useRef(running);

  useEffect(() => {
    if (running) setOpen(true);
    else if (wasRunning.current) setOpen(false);
    wasRunning.current = running;
  }, [running]);
  useEffect(() => { if (thinking) setOpen(true); }, [thinking]);

  const elapsed = formatElapsed(message.durationMs ?? (
    Number.isFinite(message.startedAt) && Number.isFinite(message.completedAt)
      ? message.completedAt - message.startedAt
      : undefined
  ));
  const label = running ? "正在处理" : elapsed ? `用时 ${elapsed}` : "处理过程";

  return (
    <div className={`process-group ${open ? "is-open" : ""}`}>
      <button type="button" className="process-summary" onClick={() => { if (!thinking) setOpen((value) => !value); }} aria-expanded={open || thinking} aria-disabled={thinking}>
        {running && <CircleNotch size={15} weight="bold" className="spin" />}
        {!running && failed && <WarningCircle size={15} weight="fill" />}
        <span>{label}</span>
        <CaretRight size={15} className="process-caret" />
      </button>
      {(open || thinking) && (
        <div className="process-body">
          {message.activities.map((activity) => <ActivityRow key={activity.id} activity={activity} />)}
        </div>
      )}
    </div>
  );
}

function markdownText(node) {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(markdownText).join("");
  return node?.props?.children ? markdownText(node.props.children) : "";
}

function MarkdownCodeBlock({ node: _node, children, ...props }) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef();
  const code = markdownText(children).replace(/\n$/, "");
  const codeNode = Array.isArray(children) ? children[0] : children;
  const language = codeNode?.props?.className?.match(/language-([^\s]+)/)?.[1] || "";

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  const copyCode = async () => {
    if (!code || !navigator.clipboard) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-toolbar">
        <span>{language}</span>
        <button type="button" onClick={copyCode} title={copied ? "已复制" : "复制代码"} aria-label={copied ? "代码已复制" : "复制代码"}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
      {language === "mermaid" ? <><div className="markdown-mermaid"><MermaidPreview source={code} /></div><details className="mermaid-source"><summary>查看图表源码</summary><pre {...props}>{children}</pre></details></> : <pre {...props}>{children}</pre>}
    </div>
  );
}

const markdownPlugins = [remarkGfm];

const MarkdownContent = memo(function MarkdownContent({ children, resourceUrl, onOpenFile }) {
  // Stable renderer types keep code blocks, copy state and diagrams mounted
  // when another token arrives instead of replacing their DOM on every update.
  const components = useMemo(() => ({
          a({ node: _node, href, children: linkChildren, ...props }) {
            const external = /^https?:\/\//i.test(href || "");
            if (onOpenFile && href && !/^(?:[a-z][a-z\d+.-]*:|#)/i.test(href)) {
              return <a href={href} {...props} onClick={(event) => {
                event.preventDefault();
                onOpenFile(markdownFilePath(href, resourceUrl));
              }}>{linkChildren}</a>;
            }
            return <a href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})} {...props}>{linkChildren}</a>;
          },
          table({ node: _node, children: tableChildren, ...props }) {
            return <div className="markdown-table-wrap"><table {...props}>{tableChildren}</table></div>;
          },
          img({ node: _node, alt, ...props }) {
            if (resourceUrl?.startsWith("pi-preview:") && props.src && !/^[a-z][a-z\d+.-]*:/i.test(props.src)) {
              const imageUrl = new URL(props.src, resourceUrl);
              imageUrl.searchParams.set("v", new URL(resourceUrl).searchParams.get("v") || "0");
              props.src = imageUrl.href;
            }
            return <img alt={alt || ""} loading="lazy" {...props} />;
          },
          pre: MarkdownCodeBlock,
  }), [resourceUrl, onOpenFile]);
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={markdownPlugins}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

function Message({ message, onReview, onOpenFile }) {
  if (message.role === "user") {
    return <div className="user-message"><AttachmentList attachments={message.attachments} />{message.text && <div className="user-message-text">{message.text}</div>}</div>;
  }
  return (
    <article className="assistant-message">
      {message.activities?.length > 0 && <ProcessGroup message={message} />}
      {message.text && <MarkdownContent onOpenFile={onOpenFile}>{message.text}</MarkdownContent>}
      {message.error && (
        <div className="message-error" role="alert">
          <div className="message-error-title"><WarningCircle size={17} weight="fill" /><strong>请求失败</strong></div>
          <p>{message.error.message}</p>
          {message.error.provider && <div className="message-error-model">{message.error.provider} / {message.error.model}</div>}
          <details><summary>错误详情</summary><pre>{message.error.details}</pre></details>
        </div>
      )}
      {message.changes && (
        <button className="change-summary" onClick={onReview}>
          <span className="change-icon"><GitDiff size={17} /></span>
          <span>修改了 {message.changes.files} 个文件</span>
          <span className="diff-plus">+{message.changes.additions}</span>
          <span className="diff-minus">−{message.changes.deletions}</span>
          <span className="review-label">审查</span>
          <CaretRight size={15} />
        </button>
      )}
    </article>
  );
}

function Sidebar({ tasks, projects, runningSessions, activeProjectId, activeTaskId, onSelect, onProjectSelect, onSessionSelect, onRenameSession, onCreateProject, onCreateSession, onManageProject, onNew, collapsed, onCollapse, runtime, activeView, onManagement }) {
  const [query, setQuery] = useState("");
  const [flyoutProjectId, setFlyoutProjectId] = useState(null);
  const closeFlyout = useCallback((id) => setFlyoutProjectId((current) => current === id ? null : current), []);
  useEffect(() => { setFlyoutProjectId(null); }, [collapsed, activeTaskId, activeView]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => {
    if (!normalizedQuery) return true;
    return `${project.name} ${project.rootPath} ${(project.sessions || []).map((session) => session.title).join(" ")}`.toLowerCase().includes(normalizedQuery);
  }).sort((left, right) => {
    if (left.archived !== right.archived) return Number(left.archived) - Number(right.archived);
    if (left.pinned !== right.pinned) return Number(right.pinned) - Number(left.pinned);
    return (Date.parse(right.lastOpenedAt || right.updatedAt || 0) || 0) - (Date.parse(left.lastOpenedAt || left.updatedAt || 0) || 0);
  });
  const visibleTasks = tasks.filter((task) => task.title.toLowerCase().includes(normalizedQuery));
  return (
    <aside className={`sidebar ${collapsed ? "is-collapsed" : ""}`}>
      <div className="brand-row">
        {collapsed ? (
          <button className="collapsed-brand-toggle" onClick={onCollapse} title="展开侧栏" aria-label="展开侧栏">
            <span className="brand-mark collapsed-brand-mark" aria-hidden="true">
              <TerminalWindow size={18} weight="bold" />
            </span>
            <span className="collapsed-expand-icon" aria-hidden="true">
              <SidebarSimple size={18} />
            </span>
          </button>
        ) : (
          <>
            <div className="brand-mark"><TerminalWindow size={18} weight="bold" /></div>
            <span className="brand-name">Agentx</span>
            <button className="icon-button collapse-button" onClick={onCollapse} title="收起侧栏" aria-label="收起侧栏">
              <SidebarSimple size={18} />
            </button>
          </>
        )}
      </div>

      <button className="new-task-button" onClick={onNew} title="新建会话" aria-label="新建会话">
        <Plus size={17} weight="bold" />
        {!collapsed && <span>新建会话</span>}
      </button>

      {!collapsed && (
        <label className="search-box">
          <MagnifyingGlass size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目和 Session" />
          <kbd>⌘ K</kbd>
        </label>
      )}

      <nav className="task-nav" aria-label="项目与会话">
        {!collapsed && (
          <div className="section-label-row">
            <span className="section-label">项目</span>
            <button className="section-add-button" onClick={onCreateProject} title="新建项目" aria-label="新建项目"><Plus size={15} weight="bold" /></button>
          </div>
        )}
        {visibleProjects.map((project) => (
          <div className={`project-nav-group ${project.archived ? "is-archived" : ""}`} key={project.id}>
            <div className="project-nav-item-wrap">
              {collapsed ? <CollapsedProjectSessions
                project={project}
                active={activeProjectId === project.id}
                activeTaskId={activeTaskId}
                runningSessions={runningSessions}
                open={flyoutProjectId === project.id}
                onOpen={setFlyoutProjectId}
                onClose={closeFlyout}
                onSessionSelect={onSessionSelect}
                onCreateSession={onCreateSession}
              /> : <button
                className={`project-nav-item ${activeProjectId === project.id ? "is-active" : ""}`}
                onClick={() => onProjectSelect(project.id)}
                title={project.rootPath}
              >
                <span className={`project-nav-icon ${project.pathExists === false ? "is-missing" : ""}`}><FolderOpen size={16} /></span>
                {!collapsed && (
                  <span className="task-copy">
                    <span className="task-title">{project.name}</span>
                    <span className="task-meta">{project.archived ? "已归档 · " : ""}{project.sessions?.filter((session) => !session.archived).length || 0} 个 Session</span>
                  </span>
                )}
              </button>}
              {!collapsed && <div className="project-nav-actions">
                <button className="project-nav-action" onClick={() => onCreateSession(project)} title="新建 Session" aria-label="新建 Session"><Plus size={14} weight="bold" /></button>
                <button className="project-nav-action" onClick={() => onManageProject(project.id)} title="编辑当前项目" aria-label="编辑当前项目"><PencilSimple size={14} /></button>
              </div>}
            </div>
            {!collapsed && activeProjectId === project.id && (
              <div className="project-session-list">
                {(project.sessions || []).filter((session) => !session.archived).map((session) => (
                  <div className="project-session-item-wrap" key={session.sessionId}>
                    <button
                      className={`project-session-item ${activeTaskId === session.sessionId ? "is-active" : ""}`}
                      onClick={() => onSessionSelect(project, session)}
                      title={session.title}
                    >
                      {runningSessions[session.sessionId] ? <CircleNotch size={14} className="spin session-running-icon" aria-label="正在处理" /> : <FileText size={14} />}
                      <span>{session.title || "未命名会话"}</span>
                      {runningSessions[session.sessionId] && <small className="session-running-label">进行中</small>}
                    </button>
                    <button className="project-session-action" onClick={() => onRenameSession(project, session)} title="重命名 Session" aria-label="重命名 Session"><PencilSimple size={13} /></button>
                  </div>
                ))}
                {!project.sessions?.filter((session) => !session.archived).length && <span className="project-session-empty">暂无 Session</span>}
              </div>
            )}
          </div>
        ))}
        {visibleProjects.length === 0 && !collapsed && <div className="section-label">最近</div>}
        {visibleProjects.length === 0 && visibleTasks.map((task) => (
          <button
            key={task.id}
            className={`task-item ${activeTaskId === task.id ? "is-active" : ""}`}
            onClick={() => onSelect(task.id)}
            title={task.title}
          >
            <span className="task-state">
              {task.status === "running" ? <CircleNotch size={15} className="spin" /> : <FileText size={15} />}
            </span>
            {!collapsed && (
              <span className="task-copy">
                <span className="task-title">{task.title}</span>
                <span className="task-meta">{task.repo} · {task.time}</span>
              </span>
            )}
          </button>
        ))}
      </nav>

      <div className="sidebar-footer">
        <button className={`footer-action ${activeView === "management" ? "is-active" : ""}`} title={activeView === "management" ? "返回聊天" : "管理"} aria-label="管理" aria-pressed={activeView === "management"} onClick={onManagement}>
          <GearSix size={18} />
          {!collapsed && <span>管理</span>}
        </button>
        {!collapsed && (
          <div className="runtime-status">
            <span className={`online-dot ${runtime.connected ? "" : "is-offline"}`} />
            <span>{runtime.connected ? "Agent Host 已连接" : "等待工作区"}</span>
          </div>
        )}
      </div>
    </aside>
  );
}

function ProjectCreateDialog({ open, onClose, onChooseFolder, onCreate, busy, error, defaultProjectRoot }) {
  const [name, setName] = useState("");
  const [rootPath, setRootPath] = useState("");

  useEffect(() => {
    if (open) {
      setName("");
      setRootPath(defaultProjectRoot || "");
    }
  }, [defaultProjectRoot, open]);

  if (!open) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || !rootPath.trim() || busy) return;
    await onCreate({ name: name.trim(), rootPath: rootPath.trim() });
  };

  return (
    <Modal onClose={() => !busy && onClose()}>
      <section className="small-dialog" role="dialog" aria-modal="true" aria-labelledby="project-create-title">
        <header className="small-dialog-header">
          <div><span className="project-dialog-icon"><FolderOpen size={18} /></span><div><h2 id="project-create-title">新建项目</h2><p>项目目录用于保存工作区关联和 Session 索引</p></div></div>
          <button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button>
        </header>
        <form className="small-dialog-form" onSubmit={submit}>
          <label className="field-control"><span>项目名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：Agentx" /></label>
          <label className="field-control"><span>项目目录</span><div className="path-picker"><input value={rootPath} onChange={(event) => setRootPath(event.target.value)} placeholder="选择或输入项目目录" /><button type="button" className="button-secondary" onClick={async () => { const selected = await onChooseFolder(); if (selected) setRootPath(selected); }}><FolderOpen size={14} />选择</button></div></label>
          {error && <div className="settings-error"><WarningCircle size={15} />{error}</div>}
          <div className="small-dialog-actions"><button type="button" className="button-quiet" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={busy || !name.trim() || !rootPath.trim()}>{busy ? "创建中…" : "创建项目"}</button></div>
        </form>
      </section>
    </Modal>
  );
}

function SessionRenameDialog({ target, onClose, onSave, busy, error }) {
  const [name, setName] = useState("");

  useEffect(() => {
    setName(target?.session?.title || "");
  }, [target]);

  if (!target) return null;

  const submit = async (event) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    await onSave(name.trim());
  };

  return (
    <Modal onClose={() => !busy && onClose()}>
      <section className="small-dialog rename-dialog" role="dialog" aria-modal="true" aria-labelledby="session-rename-title">
        <header className="small-dialog-header"><div><span className="project-dialog-icon"><PencilSimple size={18} /></span><div><h2 id="session-rename-title">重命名 Session</h2><p>{target.project?.name || "当前项目"}</p></div></div><button className="icon-button" onClick={onClose} title="关闭"><X size={18} /></button></header>
        <form className="small-dialog-form" onSubmit={submit}>
          <label className="field-control"><span>Session 名称</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
          {error && <div className="settings-error"><WarningCircle size={15} />{error}</div>}
          <div className="small-dialog-actions"><button type="button" className="button-quiet" onClick={onClose}>取消</button><button type="submit" className="button-primary" disabled={busy || !name.trim()}>{busy ? "保存中…" : "保存名称"}</button></div>
        </form>
      </section>
    </Modal>
  );
}

function CurrentProjectDialog({
  open,
  projects,
  activeProjectId,
  sessions,
  availableModels,
  toolCatalog,
  globalToolIds,
  onClose,
  onUpdate,
  onRelink,
  onOpenTarget,
  onGitStatus,
  onOpenSession,
  onNewSession,
  onRenameSession,
  onArchiveSession,
  onRestoreSession,
  onDeleteDirectory,
}) {
  const [name, setName] = useState("");
  const [modelValue, setModelValue] = useState("");
  const [permissionMode, setPermissionMode] = useState("ask");
  const [toolMode, setToolMode] = useState("inherit");
  const [projectToolIds, setProjectToolIds] = useState([]);
  const [editingSessionId, setEditingSessionId] = useState("");
  const [editingSessionName, setEditingSessionName] = useState("");
  const [gitStatus, setGitStatus] = useState(null);
  const project = projects.find((item) => item.id === activeProjectId) || null;
  const projectSessions = project?.sessions || sessions || [];
  const archivedSessions = projectSessions.filter((item) => item.archived);

  useEffect(() => {
    if (!project) return;
    setName(project.name || "");
    setModelValue(project.settings?.model || "");
    setPermissionMode(project.settings?.permissionMode || "ask");
    setToolMode(project.settings?.tools?.mode === "custom" ? "custom" : "inherit");
    setProjectToolIds(project.settings?.tools?.enabled || []);
    setGitStatus(null);
  }, [project?.id, project?.name, project?.settings?.model, project?.settings?.permissionMode, project?.settings?.tools?.mode, project?.settings?.tools?.enabled]);

  if (!open) return null;

  const saveProject = (patch) => onUpdate(project.id, patch);
  const startRename = (session) => {
    setEditingSessionId(session.sessionId);
    setEditingSessionName(session.title || "");
  };

  return (
    <Modal onClose={onClose}>
      <section className="project-dialog current-project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title">
        <header className="project-dialog-header">
          <div><span className="project-dialog-icon"><FolderOpen size={19} /></span><div><h2 id="project-dialog-title">当前项目设置</h2><p>只修改当前项目、Session 和项目级运行设置</p></div></div>
          <button className="icon-button" onClick={onClose} title="关闭当前项目设置"><X size={18} /></button>
        </header>
        <div className="project-dialog-body current-project-dialog-body">
          <div className="project-detail-pane">
            {!project ? <div className="project-list-empty">选择或创建一个项目开始</div> : (
              <>
                <div className="project-detail-heading">
                  <div className="project-detail-heading-main"><div className="project-title-editor"><input value={name} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") saveProject({ name }); }} aria-label="项目名称" /><button className="icon-button" onClick={() => saveProject({ name })} title="保存项目名称" aria-label="保存项目名称"><Check size={15} /></button></div><code>{project.rootPath}</code></div>
                  <div className="project-detail-actions">
                    <button className="button-quiet" onClick={() => saveProject({ pinned: !project.pinned })}>{project.pinned ? "取消置顶" : "置顶"}</button>
                    <button className="button-quiet" onClick={() => saveProject({ archived: !project.archived })}>{project.archived ? "取消归档" : "归档"}</button>
                  </div>
                </div>
                {!project.pathExists && <div className="project-warning"><WarningCircle size={15} />项目路径不可用，请重新关联目录。</div>}
                <div className="project-section">
                  <div className="project-section-title"><strong>项目基本信息</strong><span>只改变 Desktop 中的项目记录</span></div>
                  <div className="project-action-grid">
                    <button className="button-quiet" onClick={() => onRelink(project.id)}><FolderOpen size={14} />重新关联目录</button>
                    <button className="button-quiet" onClick={() => onOpenTarget(project.id, "finder")}><FolderOpen size={14} />在文件管理器打开</button>
                    <button className="button-quiet" onClick={() => onOpenTarget(project.id, "terminal")}><TerminalWindow size={14} />在终端打开</button>
                    <button className="button-quiet" onClick={async () => setGitStatus(await onGitStatus(project.id))}><GitBranch size={14} />读取 Git 状态</button>
                    <button className="button-quiet" onClick={() => saveProject({ removed: true })}>从最近项目移除</button>
                  </div>
                  {gitStatus && <div className="git-status-line"><GitBranch size={14} /><span>{gitStatus.isGit ? `${gitStatus.branch} · ${gitStatus.clean ? "工作区干净" : `${gitStatus.changedFiles.length} 个文件变更`}` : "不是 Git 仓库"}</span></div>}
                </div>
                <div className="project-section">
                  <div className="project-section-title"><strong>项目默认设置</strong><span>新建会话会继承这些设置</span></div>
                  <div className="settings-grid">
                    <label className="field-control"><span>默认模型</span><select value={modelValue} onChange={(event) => { setModelValue(event.target.value); saveProject({ settings: { model: event.target.value } }); }}><option value="">跟随全局设置</option>{availableModels.map((item) => <option key={`${item.provider}::${item.id}`} value={`${item.provider}::${item.id}`}>{item.name || item.id}</option>)}</select></label>
                    <label className="field-control"><span>权限模式</span><select value={permissionMode} onChange={(event) => { setPermissionMode(event.target.value); saveProject({ settings: { permissionMode: event.target.value } }); }}><option value="read-only">只读</option><option value="ask">执行前询问</option><option value="full">完全访问</option></select></label>
                  </div>
                  <div className="project-tools-control">
                    <label className="field-control"><span>Tools</span><select value={toolMode} onChange={(event) => {
                      const mode = event.target.value;
                      const enabled = mode === "custom" ? [...globalToolIds] : [];
                      setToolMode(mode);
                      setProjectToolIds(enabled);
                      saveProject({ settings: { tools: { mode, enabled } } });
                    }}><option value="inherit">继承全局设置</option><option value="custom">为此项目自定义</option></select></label>
                    <ToolRows
                      tools={toolCatalog}
                      enabledIds={toolMode === "custom" ? projectToolIds : globalToolIds}
                      disabled={toolMode !== "custom"}
                      compact
                      onToggle={(toolId, checked) => {
                        const enabled = checked ? [...new Set([...projectToolIds, toolId])] : projectToolIds.filter((id) => id !== toolId);
                        setProjectToolIds(enabled);
                        saveProject({ settings: { tools: { mode: "custom", enabled } } });
                      }}
                    />
                  </div>
                </div>
                <div className="project-section">
                  <div className="project-section-title"><strong>Sessions</strong><button className="button-secondary" onClick={() => onNewSession(project.id)}><Plus size={14} />新建 Session</button></div>
                  <div className="session-list">
                    {projectSessions.filter((item) => !item.archived).map((session) => (
                      <div className="session-row" key={session.sessionId}>
                        {editingSessionId === session.sessionId ? <input value={editingSessionName} onChange={(event) => setEditingSessionName(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { onRenameSession(project.id, session, editingSessionName); setEditingSessionId(""); } }} autoFocus /> : <span><strong>{session.title || "未命名会话"}</strong><small>{session.messageCount ? `${session.messageCount} 条消息` : session.sessionId}</small></span>}
          <div><button className="icon-button" onClick={() => onOpenSession(project.id, session)} title="打开 Session" aria-label="打开 Session"><FolderOpen size={15} /></button><button className="icon-button" onClick={() => startRename(session)} title="重命名 Session" aria-label="重命名 Session"><PencilSimple size={15} /></button><button className="icon-button" onClick={() => onArchiveSession(project.id, session)} title="删除 Session（归档）" aria-label="删除 Session（归档）"><Trash size={15} /></button></div>
                      </div>
                    ))}
                    {!projectSessions.filter((item) => !item.archived).length && <div className="project-list-empty">暂无 Session</div>}
                  </div>
                </div>
                {archivedSessions.length > 0 && <div className="project-section">
                  <div className="project-section-title"><strong>已归档 Sessions</strong><span>归档只隐藏记录，不删除会话 JSONL</span></div>
                  <div className="session-list">
                    {archivedSessions.map((session) => (
                      <div className="session-row is-archived" key={session.sessionId}>
                        <span><strong>{session.title || "未命名会话"}</strong><small>{session.messageCount ? `${session.messageCount} 条消息` : session.sessionId}</small></span>
                        <div><button className="icon-button" onClick={() => onRestoreSession(project.id, session)} title="恢复 Session" aria-label="恢复 Session"><ArrowCounterClockwise size={15} /></button></div>
                      </div>
                    ))}
                  </div>
                </div>}
                <div className="project-danger-zone"><div><strong>高风险操作</strong><span>删除项目目录会将实际文件夹移到系统回收站。</span></div><button className="button-danger-quiet" onClick={() => onDeleteDirectory(project.id)}>删除项目目录</button></div>
              </>
            )}
          </div>
        </div>
      </section>
    </Modal>
  );
}

const toolRiskLabels = { read: "只读", write: "写入", execute: "执行" };

function ToolRows({ tools = [], enabledIds = [], disabled = false, compact = false, onToggle }) {
  const enabled = new Set(enabledIds);
  return (
    <div className={`tool-list ${compact ? "is-compact" : ""}`}>
      {tools.map((tool) => (
        <label className={`tool-row ${disabled ? "is-disabled" : ""}`} key={tool.id}>
          <span className="tool-row-icon"><Wrench size={compact ? 14 : 16} /></span>
          <span className="tool-row-copy">
            <span className="tool-row-title"><strong>{tool.title}</strong><code>{tool.runtimeName}</code></span>
            {!compact && <span>{tool.description}</span>}
            <small>{tool.source} · {tool.version}</small>
          </span>
          <span className={`tool-risk is-${tool.risk}`}>{toolRiskLabels[tool.risk] || tool.risk}</span>
          <input className="settings-switch" type="checkbox" checked={enabled.has(tool.id)} disabled={disabled} onChange={(event) => onToggle?.(tool.id, event.target.checked)} />
        </label>
      ))}
    </div>
  );
}

function formatBytes(bytes = 0) {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
}

function SkillConfirmDialog({ action, skill, busy, autoReload, onClose, onConfirm }) {
  if (!skill || !action) return null;
  const removing = action === "remove";
  return (
    <Modal onClose={() => !busy && onClose()}>
      <section className="skill-confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="skill-confirm-title">
        <div className={`skill-confirm-icon ${removing ? "is-danger" : ""}`}>
          {removing ? <Trash size={19} /> : <PuzzlePiece size={19} />}
        </div>
        <div className="skill-confirm-copy">
          <h2 id="skill-confirm-title">{removing ? "卸载工作区 Skill" : "安装到当前工作区"}</h2>
          <p>{removing
            ? `将删除 .pi/skills/${skill.name}。只会移除由 Agentx 安装的文件。`
            : `将 ${skill.title} 复制到当前工作区${autoReload ? "，并重新加载 Agentx 会话" : ""}。`}</p>
        </div>
        <div className="skill-confirm-summary">
          <div><span>Skill</span><code>{skill.name}</code></div>
          <div><span>文件</span><code>{skill.fileCount || skill.files?.length || 1} 个 · {formatBytes(skill.totalBytes)}</code></div>
          <div><span>来源</span><code>{skill.sourceType === "bundled" ? "Agentx 内置目录" : skill.sourcePath}</code></div>
        </div>
        <div className="skill-confirm-actions">
          <button type="button" className="button-quiet" onClick={onClose} disabled={busy}>取消</button>
          <button type="button" className={removing ? "button-danger" : "button-primary"} onClick={onConfirm} disabled={busy}>
            {busy ? <><CircleNotch size={14} className="spin" />正在处理</> : removing ? <><Trash size={14} />确认卸载</> : <><Check size={14} />确认安装</>}
          </button>
        </div>
      </section>
    </Modal>
  );
}

function SkillsPage({ transport, connected, workspace, embedded = false, autoReload = true, allowLocalImport = true }) {
  const [skills, setSkills] = useState([]);
  const [localSource, setLocalSource] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("discover");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirm, setConfirm] = useState(null);
  const [installRoot, setInstallRoot] = useState("");

  const updateResult = (result, preferredName) => {
    const next = result?.skills || [];
    setSkills(next);
    setInstallRoot(result?.installRoot || "");
    const selected = next.find((item) => item.name === preferredName) || next[0];
    if (selected) setSelectedId(selected.id);
  };

  const load = async () => {
    if (!connected) return;
    setLoading(true);
    setError("");
    try {
      updateResult(await transport?.listSkills());
    } catch (loadError) {
      setError(loadError.message || "无法读取 Skills");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [connected, workspace?.cwd]);

  const allSkills = useMemo(() => localSource && !skills.some((item) => item.name === localSource.name)
    ? [localSource, ...skills]
    : skills, [localSource, skills]);
  const visibleSkills = allSkills.filter((skill) => {
    if (tab === "installed" && !skill.installed) return false;
    const searchText = `${skill.title} ${skill.name} ${skill.description} ${skill.category}`.toLowerCase();
    return searchText.includes(query.trim().toLowerCase());
  });
  const selected = allSkills.find((skill) => skill.id === selectedId)
    || visibleSkills[0]
    || allSkills[0];

  useEffect(() => {
    if (!selectedId && allSkills[0]) setSelectedId(allSkills[0].id);
  }, [allSkills, selectedId]);

  const importLocal = async () => {
    setError("");
    setNotice("");
    try {
      const sourcePath = await transport?.chooseSkillFolder();
      if (!sourcePath) return;
      const inspected = await transport.inspectSkillSource(sourcePath);
      setLocalSource(inspected);
      setSelectedId(inspected.id);
      setTab("discover");
      setNotice(`已校验本地 Skill：${inspected.name}`);
    } catch (importError) {
      setError(importError.message || "无法导入本地 Skill");
    }
  };

  const performAction = async () => {
    const skill = confirm?.skill;
    if (!skill) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = confirm.action === "remove"
        ? await transport.removeSkill(skill.name, { reload: autoReload })
        : await transport.installSkill({
          catalogId: skill.sourceType === "bundled" ? skill.id : undefined,
          sourcePath: skill.sourceType === "local" ? skill.sourcePath : undefined,
          skillName: skill.name,
          reload: autoReload,
        });
      updateResult(result, skill.name);
      if (confirm.action === "remove" && localSource?.name === skill.name) setLocalSource(null);
      const successMessage = confirm.action === "remove" ? `${skill.title} 已卸载` : `${skill.title} 已安装`;
      setNotice(result?.reloadWarning || `${successMessage}${autoReload ? "并重新加载" : ""}`);
      setConfirm(null);
    } catch (actionError) {
      setError(actionError.message || "Skill 操作失败");
    } finally {
      setBusy(false);
    }
  };

  const reload = async () => {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await transport.reloadSkills();
      updateResult(result, selected?.name);
      setNotice("Agentx Skills 已重新加载");
    } catch (reloadError) {
      setError(reloadError.message || "无法重新加载 Skills");
    } finally {
      setBusy(false);
    }
  };

  if (!connected) {
    return (
      <section className="skills-empty">
        <div className="empty-icon"><PuzzlePiece size={27} /></div>
        <h2>先连接工作区</h2>
        <p>Skills 会按工作区安装到 <code>.pi/skills/</code>，选择目录后即可管理。</p>
      </section>
    );
  }

  return (
    <section className={`skills-page ${embedded ? "is-embedded" : ""}`}>
      <header className="skills-header">
        <div>
          <h1>{embedded ? "当前项目 Skills" : "Skills"}</h1>
          <p>{workspace?.cwd || "当前工作区"}</p>
        </div>
        <div className="skills-header-actions">
          <button className="skills-icon-button" onClick={reload} disabled={busy} title="重新加载 Agentx Skills" aria-label="重新加载 Agentx Skills">
            <ArrowsClockwise size={17} className={busy ? "spin" : ""} />
          </button>
          <button className="skills-import-button" onClick={importLocal} disabled={busy || !allowLocalImport} title={allowLocalImport ? "从本地导入 Skill" : "已在管理设置中禁止本地导入"}>
            <UploadSimple size={16} />从本地导入
          </button>
        </div>
      </header>

      <div className="skills-toolbar">
        <label className="skills-search">
          <MagnifyingGlass size={16} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 Skills" />
        </label>
        <div className="skills-tabs" role="tablist" aria-label="Skill 范围">
          <button className={tab === "discover" ? "is-active" : ""} onClick={() => setTab("discover")}>发现</button>
          <button className={tab === "installed" ? "is-active" : ""} onClick={() => setTab("installed")}>已安装 <span>{skills.filter((item) => item.installed).length}</span></button>
        </div>
      </div>

      {(error || notice) && (
        <div className={`skills-banner ${error ? "is-error" : ""}`}>
          {error ? <WarningCircle size={15} weight="fill" /> : <CheckCircle size={15} weight="fill" />}
          <span>{error || notice}</span>
          <button onClick={() => { setError(""); setNotice(""); }} title="关闭"><X size={14} /></button>
        </div>
      )}

      <div className="skills-layout">
        <div className="skills-list-pane">
          <div className="skills-list-heading">
            <span>{tab === "installed" ? "工作区已安装" : "可用目录"}</span>
            <span>{visibleSkills.length}</span>
          </div>
          {loading ? (
            <div className="skills-loading"><CircleNotch size={16} className="spin" />正在读取 Skills</div>
          ) : visibleSkills.length ? visibleSkills.map((skill) => (
            <button
              key={skill.id}
              className={`skill-row ${selected?.id === skill.id ? "is-selected" : ""}`}
              onClick={() => setSelectedId(skill.id)}
            >
              <span className="skill-row-icon"><PuzzlePiece size={17} /></span>
              <span className="skill-row-copy">
                <strong>{skill.title}</strong>
                <span>{skill.description}</span>
                <small>{skill.category} · {skill.author}</small>
              </span>
              {skill.installed && <span className="installed-mark"><Check size={12} />已安装</span>}
            </button>
          )) : (
            <div className="skills-no-results">没有匹配的 Skill</div>
          )}
        </div>

        <article className="skill-detail">
          {selected ? (
            <>
              <div className="skill-detail-top">
                <div className="skill-detail-title">
                  <span className="skill-detail-icon"><PuzzlePiece size={21} /></span>
                  <div><h2>{selected.title}</h2><code>{selected.name}</code></div>
                </div>
                {selected.installed ? (
                  <button className="skill-remove-button" onClick={() => setConfirm({ action: "remove", skill: selected })} disabled={!selected.managed || busy} title={selected.managed ? "卸载 Skill" : "此 Skill 不由 Agentx 管理"}>
                    <Trash size={16} />卸载
                  </button>
                ) : (
                  <button className="skill-install-button" onClick={() => setConfirm({ action: "install", skill: selected })} disabled={busy}>
                    <Package size={16} />安装到工作区
                  </button>
                )}
              </div>
              <p className="skill-description">{selected.description}</p>
              <dl className="skill-meta-grid">
                <div><dt>版本</dt><dd>{selected.version}</dd></div>
                <div><dt>来源</dt><dd>{selected.sourceType === "bundled" ? "内置目录" : "本地文件夹"}</dd></div>
                <div><dt>文件</dt><dd>{selected.fileCount || selected.files?.length || 0} 个 · {formatBytes(selected.totalBytes)}</dd></div>
                <div><dt>状态</dt><dd>{selected.installed ? "已加载到工作区" : "尚未安装"}</dd></div>
              </dl>
              <div className="skill-security-note">
                <ShieldCheck size={17} />
                <div><strong>安装边界</strong><span>已校验 SKILL.md、文件数量与大小；符号链接会被拒绝。安装只写入当前工作区。</span></div>
              </div>
              <div className="skill-preview-heading"><strong>SKILL.md</strong><span>{selected.files?.join(" · ")}</span></div>
              <div className="skill-preview"><MarkdownContent>{selected.content || "该 Skill 暂无可展示的说明。"}</MarkdownContent></div>
              <div className="skill-install-path"><span>安装位置</span><code>{installRoot || ".pi/skills"}/{selected.name}</code></div>
            </>
          ) : <div className="skills-no-results">从左侧选择一个 Skill 查看详情</div>}
        </article>
      </div>

      <SkillConfirmDialog
        action={confirm?.action}
        skill={confirm?.skill}
        busy={busy}
        autoReload={autoReload}
        onClose={() => !busy && setConfirm(null)}
        onConfirm={performAction}
      />
    </section>
  );
}

function patchForFile(patch, fileName) {
  if (!patch) return "该文件暂无可展示的文本补丁。";
  const sections = patch.split(/(?=^diff --git )/m);
  return sections.find((section) => section.includes(` b/${fileName}`)) || "该文件暂无可展示的文本补丁。";
}

function ReviewPanel({ snapshot, onRefresh, onOpenFile }) {
  const files = snapshot ? snapshot.files : changedFiles;
  const [selectedFile, setSelectedFile] = useState(files[0]?.name || "");
  useEffect(() => {
    if (!files.some((file) => file.name === selectedFile)) setSelectedFile(files[0]?.name || "");
  }, [files, selectedFile]);
  const selectedPatch = snapshot ? patchForFile(snapshot.patch, selectedFile) : null;

  return (
    <div className="diff-panel">
      <div className="review-header">
        <div>
          <strong>工作区变更</strong>
          <span>{files.length} 个文件</span>
        </div>
        <button className="icon-button" disabled={!selectedFile} onClick={() => onOpenFile(selectedFile)} title="预览选中文件" aria-label="预览选中文件"><FileText size={17} /></button>
      </div>
      <div className="review-toolbar">
        <button onClick={onRefresh}><ArrowCounterClockwise size={15} />刷新</button>
        <button onClick={() => navigator.clipboard?.writeText(snapshot?.patch || "")} disabled={!snapshot?.patch}><Copy size={15} />复制补丁</button>
      </div>
      <div className="file-list">
        {files.map((file) => (
          <button key={file.name} className={selectedFile === file.name ? "is-selected" : ""} onClick={() => setSelectedFile(file.name)}>
            <FileCode size={16} />
            <span className="file-name">{file.name}</span>
            <span className="file-status">{file.status}</span>
            <span className="diff-plus">+{file.plus}</span>
            <span className="diff-minus">−{file.minus}</span>
          </button>
        ))}
      </div>
      <div className="diff-view">
        <div className="diff-file-title"><Code size={15} />{selectedFile}</div>
        {selectedPatch ? (
          <pre>{selectedPatch.split("\n").map((line, index) => (
            <span
              key={`${index}-${line}`}
              className={line.startsWith("+") && !line.startsWith("+++") ? "line-add" : line.startsWith("-") && !line.startsWith("---") ? "line-remove" : "line-context"}
            >{line || " "}</span>
          ))}</pre>
        ) : (
          <pre>
            <span className="line-context">  export interface AgentTransport {'{'}</span>
            <span className="line-add">+   connect(): Promise&lt;void&gt;;</span>
            <span className="line-add">+   subscribe(listener: EventListener): Unsubscribe;</span>
            <span className="line-add">+   abort(runId: string): Promise&lt;void&gt;;</span>
            <span className="line-context">  {'}'}</span>
          </pre>
        )}
      </div>
    </div>
  );
}

function ApprovalDialog({ approval, onDecision }) {
  if (!approval) return null;
  return (
    <Modal onClose={() => onDecision(false)}>
      <section className="approval-dialog" role="dialog" aria-modal="true" aria-labelledby="approval-title">
        <div className="approval-icon"><ShieldCheck size={22} weight="fill" /></div>
        <div className="approval-copy">
          <h2 id="approval-title">允许执行命令？</h2>
          <p>{approval.reason}</p>
        </div>
        <div className="command-preview">
          <div><TerminalWindow size={15} /><span>{approval.cwd}</span></div>
          <code>{approval.command}</code>
        </div>
        <p className="approval-note">Agentx 将以当前用户权限运行此命令。请只允许你理解并信任的操作。</p>
        <div className="approval-actions">
          <button className="button-quiet" onClick={() => onDecision(false)}>拒绝</button>
          <button className="button-secondary" onClick={() => onDecision(true)}>本次允许</button>
          <button className="button-primary" onClick={() => onDecision(true, true)}>始终允许测试</button>
        </div>
      </section>
    </Modal>
  );
}

function SettingsDialog({ open, settings, loading, saving, error, onClose, onSave, onClearCredential }) {
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!open || !settings?.providers?.length) return;
    const initialProvider = settings.providers.find((provider) => provider.id === settings.currentModel?.provider) || settings.providers[0];
    const initialModel = initialProvider.models.find((item) => item.id === settings.currentModel?.id) || initialProvider.models[0];
    setProviderId(initialProvider.id);
    setModelId(initialModel?.id || "");
    setBaseUrl(initialProvider.baseUrl || "");
    setApiKey("");
  }, [open, settings]);

  if (!open) return null;
  const provider = settings?.providers?.find((item) => item.id === providerId);

  const changeProvider = (nextId) => {
    const nextProvider = settings.providers.find((item) => item.id === nextId);
    setProviderId(nextId);
    setModelId(nextProvider?.models[0]?.id || "");
    setBaseUrl(nextProvider?.baseUrl || "");
    setApiKey("");
  };

  return (
    <Modal onClose={() => !saving && onClose()}>
      <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div className="settings-header">
          <div>
            <span className="settings-icon"><GearSix size={19} /></span>
            <div>
              <h2 id="settings-title">模型设置</h2>
              <p>配置 Agentx 使用的模型服务</p>
            </div>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭设置"><X size={18} /></button>
        </div>

        {loading ? (
          <div className="settings-loading"><CircleNotch size={18} className="spin" />正在读取 Agentx 配置</div>
        ) : (
          <form className="settings-form" onSubmit={(event) => {
            event.preventDefault();
            onSave({ providerId, modelId, baseUrl, apiKey });
          }}>
            <div className="settings-grid">
              <label className="field-control">
                <span>Provider</span>
                <select value={providerId} onChange={(event) => changeProvider(event.target.value)}>
                  {(settings?.providers || []).map((item) => (
                    <option key={item.id} value={item.id}>{item.name} ({item.id})</option>
                  ))}
                </select>
              </label>

              <label className="field-control">
                <span>模型</span>
                <select value={modelId} onChange={(event) => setModelId(event.target.value)}>
                  {(provider?.models || []).map((item) => (
                    <option key={item.id} value={item.id}>{item.name || item.id}</option>
                  ))}
                </select>
              </label>
            </div>

            <label className="field-control">
              <span>Base URL</span>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder={provider?.defaultBaseUrl || "https://api.example.com/v1"}
                spellCheck="false"
              />
              <small>留空时使用 Provider 默认地址；填写后保存到 models.json。</small>
            </label>

            <label className="field-control">
              <span>API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={provider?.configured ? "已配置，留空保持不变" : "输入 API Key"}
                autoComplete="off"
                disabled={!provider?.apiKeySupported}
              />
              <small>密钥由 Pi SDK 写入 auth.json，不会发送给页面或工作区。</small>
            </label>

            {error && <div className="settings-error"><WarningCircle size={15} weight="fill" />{error}</div>}

            <div className="settings-files">
              <div><span>当前模型</span><code>{settings?.paths?.settings || "~/.pi/agent/settings.json"}</code></div>
              <div><span>服务配置</span><code>{settings?.paths?.models || "~/.pi/agent/models.json"}</code></div>
              <div><span>认证凭据</span><code>{settings?.paths?.auth || "~/.pi/agent/auth.json"}</code></div>
            </div>

            <div className="settings-actions">
              {provider?.configured && (
                <button type="button" className="button-danger-quiet" onClick={() => onClearCredential(providerId)} disabled={saving}>清除凭据</button>
              )}
              <span />
              <button type="button" className="button-quiet" onClick={onClose}>取消</button>
              <button type="submit" className="button-primary" disabled={saving || !providerId || !modelId}>
                {saving ? <><CircleNotch size={14} className="spin" />正在保存</> : <><Check size={14} />保存并使用</>}
              </button>
            </div>
          </form>
        )}
      </section>
    </Modal>
  );
}

function SettingsPage({
  transport,
  modelSettings,
  desktopSettings,
  toolCatalog,
  availableModels,
  loading,
  saving,
  error,
  runtime,
  workspace,
  onSaveModel,
  onClearCredential,
  onSaveDesktop,
  onChooseProjectFolder,
  onReloadModels,
}) {
  const [section, setSection] = useState("general");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [defaultRoot, setDefaultRoot] = useState("");
  const [providerOperation, setProviderOperation] = useState(null);
  const [remoteCatalog, setRemoteCatalog] = useState(null);
  const [catalogSearch, setCatalogSearch] = useState("");
  const providerRequestVersion = useRef(0);

  useEffect(() => {
    providerRequestVersion.current += 1;
    setProviderOperation(null);
    setRemoteCatalog(null);
    setCatalogSearch("");
    return () => { providerRequestVersion.current += 1; };
  }, [providerId, baseUrl, apiKey, modelSettings]);

  useEffect(() => {
    if (!modelSettings?.providers?.length) return;
    const initialProvider = modelSettings.providers.find((provider) => provider.id === modelSettings.currentModel?.provider) || modelSettings.providers[0];
    const initialModel = initialProvider.models.find((item) => item.id === modelSettings.currentModel?.id) || initialProvider.models[0];
    setProviderId(initialProvider.id);
    setModelId(initialModel?.id || "");
    setBaseUrl(initialProvider.baseUrl || "");
    setApiKey("");
  }, [modelSettings]);

  useEffect(() => {
    setDefaultRoot(desktopSettings?.defaultProjectRoot || "");
  }, [desktopSettings?.defaultProjectRoot]);

  const provider = modelSettings?.providers?.find((item) => item.id === providerId);
  const providerBusy = providerOperation?.busy;
  const remoteSelectable = remoteCatalog?.models.filter((item) => item.selectable) || [];
  const visibleRemoteModels = remoteCatalog?.models.filter((item) => `${item.id} ${item.name}`.toLowerCase().includes(catalogSearch.trim().toLowerCase())) || [];
  const runProviderCheck = async (kind) => {
    const version = ++providerRequestVersion.current;
    setProviderOperation({ kind, busy: true });
    try {
      const result = await transport[kind]({ providerId, modelId, baseUrl, apiKey });
      if (version !== providerRequestVersion.current) return;
      setProviderOperation({ kind, ...result, busy: false });
      if (kind === "fetchProviderModels" && result.ok) setRemoteCatalog(result);
    } catch (error) {
      if (version === providerRequestVersion.current) setProviderOperation({ kind, busy: false, ok: false,
        error: { message: "供应商操作失败，请检查 Agent Host 连接后重试。" } });
    }
  };
  const configuredProviders = (modelSettings?.providers || []).filter((item) => item.configured);
  const unconfiguredProviders = (modelSettings?.providers || []).filter((item) => !item.configured);
  const authSourceLabels = { stored: "本地凭据", environment: "环境变量", runtime: "临时凭据" };
  const knownToolIds = new Set(toolCatalog.map((tool) => tool.id));
  const configuredToolIds = desktopSettings?.tools?.enabled;
  const enabledToolIds = (Array.isArray(configuredToolIds) ? configuredToolIds : toolCatalog.map((tool) => tool.id))
    .filter((toolId) => knownToolIds.has(toolId));
  const changeProvider = (nextId) => {
    const nextProvider = modelSettings?.providers?.find((item) => item.id === nextId);
    setProviderId(nextId);
    setModelId(nextProvider?.models[0]?.id || "");
    setBaseUrl(nextProvider?.baseUrl || "");
    setApiKey("");
  };

  const navItems = [
    { id: "general", label: "通用", icon: GearSix, hint: "应用行为与项目目录" },
    { id: "models", label: "模型与服务", icon: Cpu, hint: "Provider、模型与凭据" },
    { id: "agent", label: "Agent 与权限", icon: ShieldCheck, hint: "默认执行策略" },
    { id: "tools", label: "Tools", icon: Wrench, hint: "Agent 可用工具" },
    { id: "skills", label: "Skills", icon: PuzzlePiece, hint: "来源与工作区安装" },
    { id: "defaults", label: "新项目默认值", icon: FolderOpen, hint: "新项目继承的设置" },
    { id: "storage", label: "存储与会话", icon: Package, hint: "配置文件与运行数据" },
    { id: "diagnostics", label: "运行与诊断", icon: ArrowsClockwise, hint: "本地配置与故障排查" },
  ];

  const saveRoot = async () => {
    if (defaultRoot.trim()) await onSaveDesktop({ defaultProjectRoot: defaultRoot.trim() });
  };

  const saveModel = (event) => {
    event.preventDefault();
    onSaveModel({ providerId, modelId, baseUrl, apiKey });
  };

  return (
    <section className="settings-page">
      <header className="settings-page-header">
        <div>
          <span className="settings-page-icon"><GearSix size={21} /></span>
          <div><h1>管理</h1><p>集中管理 Agentx 的配置与运行偏好</p></div>
        </div>
      </header>
      <div className="settings-page-body">
        <nav className="settings-nav" aria-label="设置分类">
          {navItems.map(({ id, label, icon: Icon, hint }) => (
            <button key={id} className={section === id ? "is-active" : ""} onClick={() => setSection(id)}>
              <Icon size={17} />
              <span><strong>{label}</strong><small>{hint}</small></span>
            </button>
          ))}
        </nav>
        <div className={`settings-content ${section === "skills" || section === "tools" ? "is-wide" : ""}`}>
          {section === "general" && (
            <div className="settings-section-stack">
              <div className="settings-content-heading"><div><h2>通用</h2><p>这些设置只影响 Desktop 本身，不会修改项目代码。</p></div></div>
              <section className="settings-block">
                <div className="settings-block-heading"><div><strong>默认项目目录</strong><span>新建项目表单会从这里开始</span></div></div>
                <div className="path-picker settings-path-picker"><input value={defaultRoot} onChange={(event) => setDefaultRoot(event.target.value)} placeholder="例如 /Users/you/Projects" spellCheck="false" /><button type="button" className="button-secondary" onClick={async () => { const selected = await onChooseProjectFolder(); if (selected) { setDefaultRoot(selected); await onSaveDesktop({ defaultProjectRoot: selected }); } }}><FolderOpen size={14} />选择目录</button></div>
                <div className="settings-inline-actions"><span>当前值会保存到 Desktop 的用户配置，不会写入项目目录。</span><button className="button-primary" onClick={saveRoot} disabled={saving || !defaultRoot.trim()}><Check size={14} />保存目录</button></div>
              </section>
              <section className="settings-block settings-option-row"><div><strong>启动时恢复上次工作区</strong><span>应用启动后自动打开最近一次项目和 Session。</span></div><input className="settings-switch" type="checkbox" checked={desktopSettings?.reopenLastWorkspace !== false} onChange={(event) => onSaveDesktop({ reopenLastWorkspace: event.target.checked })} /></section>
              <section className="settings-block settings-system-info" aria-label="系统信息">
                <div className="settings-block-heading"><div><strong>系统信息</strong><span>当前运行环境与服务连接状态</span></div></div>
                <dl className="settings-system-grid">
                  <div><dt>运行环境</dt><dd>{desktopMode ? "本地 Desktop" : "浏览器演示（Mock）"}</dd></div>
                  <div><dt>Agent Host</dt><dd className={runtime.connected ? "is-good" : ""}><span className={`online-dot ${runtime.connected ? "" : "is-offline"}`} />{runtime.connected ? (desktopMode ? "已连接" : "模拟连接") : "未连接"}</dd></div>
                  <div><dt>连接方式</dt><dd>{desktopMode ? "Electron IPC · Pi SDK" : "浏览器 Mock"}</dd></div>
                  <div><dt>可用模型</dt><dd>{desktopMode ? `${availableModels.length} 个` : "演示数据"}</dd></div>
                  <div><dt>模型认证</dt><dd>{desktopMode ? (runtime.authenticated ? "已配置" : "未配置") : "演示模式，不读取本机凭据"}</dd></div>
                  <div><dt>后台服务</dt><dd>未接入</dd></div>
                </dl>
                {runtime.message && <p className="settings-system-note">{runtime.message}</p>}
              </section>
              {error && <div className="settings-error"><WarningCircle size={15} weight="fill" />{error}</div>}
            </div>
          )}

          {section === "models" && (
            <div className="settings-section-stack">
              <div className="settings-content-heading"><div><h2>模型与服务</h2><p>配置 Agentx 使用的 Provider、模型、Base URL 和 API Key。</p></div></div>
              {loading ? <div className="settings-loading"><CircleNotch size={18} className="spin" />正在读取 Agentx 配置</div> : (
                <>
                <section className="settings-block" aria-label="已配置供应商">
                  <div className="settings-block-heading">
                    <div><strong>已配置供应商 · {configuredProviders.length}</strong><span>集中查看已配置的认证，点击供应商即可编辑。</span></div>
                    <button type="button" className="icon-button" title="刷新供应商状态" aria-label="刷新供应商状态" onClick={onReloadModels} disabled={saving}><ArrowsClockwise size={16} /></button>
                  </div>
                  {!desktopMode && <p className="settings-provider-note">当前为浏览器演示；本机真实认证状态请在桌面应用中查看。</p>}
                  {configuredProviders.length ? (
                    <div className="settings-provider-list">
                      {configuredProviders.map((item) => (
                        <button key={item.id} type="button" className={`settings-provider-row ${providerId === item.id ? "is-selected" : ""}`} aria-pressed={providerId === item.id} onClick={() => changeProvider(item.id)}>
                          <CheckCircle size={17} weight="fill" className="settings-provider-check" />
                          <span className="settings-provider-copy"><strong>{item.name}</strong><small>{item.id} · {authSourceLabels[item.authSource] || "已配置认证"}</small></span>
                          {modelSettings.currentModel?.provider === item.id && <span className="settings-provider-current">当前使用</span>}
                          <CaretRight size={14} />
                        </button>
                      ))}
                    </div>
                  ) : <p className="settings-provider-note">尚未发现已配置的供应商。请在下方选择供应商并添加认证。</p>}
                  <p className="settings-provider-note">认证可能来自 API Key、环境变量或登录凭据；不显示密钥内容。</p>
                </section>
                <form className="settings-block settings-model-form" onSubmit={saveModel}>
                  <div className="settings-grid"><label className="field-control"><span>Provider</span><select value={providerId} onChange={(event) => changeProvider(event.target.value)}>{configuredProviders.length > 0 && <optgroup label="已配置">{configuredProviders.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id}) · 已配置</option>)}</optgroup>}{unconfiguredProviders.length > 0 && <optgroup label="未配置">{unconfiguredProviders.map((item) => <option key={item.id} value={item.id}>{item.name} ({item.id})</option>)}</optgroup>}</select></label><label className="field-control"><span>模型</span><select value={modelId} disabled={providerBusy} onChange={(event) => { setModelId(event.target.value); if (providerOperation?.kind === "testModelSettings") setProviderOperation(null); }}>
                    {remoteCatalog ? <>
                      {modelId && !remoteSelectable.some((item) => item.id === modelId) && <option value={modelId}>{provider?.models.find((item) => item.id === modelId)?.name || modelId} · 远端未列出</option>}
                      {!remoteSelectable.length && !modelId && <option value="">没有匹配的对话模型</option>}
                      <optgroup label="供应商返回 · Agentx 已支持">{remoteSelectable.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>
                    </> : (provider?.models || []).map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
                  </select><small>{remoteCatalog ? "当前显示远端列表中 Agentx 已适配的对话模型。" : "当前使用内置模型目录，可向供应商获取实时列表。"}</small></label></div>
                  <label className="field-control"><span>Base URL</span><input type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={provider?.defaultBaseUrl || "https://api.example.com/v1"} spellCheck="false" /><small>留空时使用 Provider 默认地址；填写后保存到 models.json。</small></label>
                  <label className="field-control"><span>API Key</span><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider?.configured ? "已配置，留空保持不变" : "输入 API Key"} autoComplete="off" disabled={!provider?.apiKeySupported} /><small>密钥由 Pi SDK 写入 auth.json，不会写入项目配置或页面存储。</small></label>
                  <div className="settings-provider-tools">
                    <button type="button" className="button-secondary" disabled={saving || providerBusy || !providerId || !modelId} onClick={() => runProviderCheck("testModelSettings")}>
                      {providerBusy && providerOperation.kind === "testModelSettings" ? <CircleNotch size={14} className="spin" /> : <CheckCircle size={14} />}测试当前模型
                    </button>
                    <button type="button" className="button-secondary" disabled={saving || providerBusy || !providerId || provider?.discovery?.supported === false} title={provider?.discovery?.reason || "直接向供应商获取模型列表"} onClick={() => runProviderCheck("fetchProviderModels")}>
                      <ArrowsClockwise size={14} className={providerBusy && providerOperation.kind === "fetchProviderModels" ? "spin" : ""} />获取供应商模型
                    </button>
                    {remoteCatalog && <button type="button" className="button-secondary" disabled={providerBusy} onClick={() => { setRemoteCatalog(null); setProviderOperation(null); }}>恢复内置目录</button>}
                  </div>
                  <p className="settings-muted-note">测试使用当前表单配置，不自动保存；API Key 留空时使用已有认证。测试会发送一条简短请求，可能产生少量费用，不发送聊天内容或调用工具。</p>
                  {provider?.discovery?.supported === false && <p className="settings-muted-note">{provider.discovery.reason}</p>}
                  {providerOperation?.busy && <div className="settings-provider-result" role="status">正在{providerOperation.kind === "testModelSettings" ? "测试当前模型" : "读取供应商模型列表"}…</div>}
                  {providerOperation && !providerOperation.busy && <div className={`settings-provider-result ${providerOperation.ok ? "is-success" : "is-error"}`} role={providerOperation.ok ? "status" : "alert"}>
                    <span>{providerOperation.ok ? providerOperation.message : providerOperation.error?.message}{providerOperation.ok && providerOperation.elapsedMs !== undefined ? `（${(providerOperation.elapsedMs / 1000).toFixed(1)} 秒）` : ""}</span>
                    {!providerOperation.ok && providerOperation.error?.details && <details><summary>查看详情</summary><pre>{providerOperation.error.details}</pre></details>}
                  </div>}
                  {remoteCatalog && <section className="settings-remote-models" aria-label="供应商实时模型列表">
                    <div className="settings-block-heading"><div><strong>供应商模型 · {remoteCatalog.models.length}</strong><span>可直接选择 {remoteSelectable.length} 个 · 获取于 {new Date(remoteCatalog.fetchedAt).toLocaleTimeString()}</span></div></div>
                    <input aria-label="搜索供应商模型" placeholder="搜索模型名称或 ID" value={catalogSearch} onChange={(event) => setCatalogSearch(event.target.value)} />
                    <div className="settings-remote-model-list">
                      {visibleRemoteModels.length ? visibleRemoteModels.map((item) => <button key={item.id} type="button" disabled={!item.selectable || providerBusy} aria-pressed={modelId === item.id} onClick={() => { setModelId(item.id); if (providerOperation?.kind === "testModelSettings") setProviderOperation(null); }}>
                        <span><strong>{item.name}</strong><code>{item.id}</code></span><small>{item.reason}</small>
                      </button>) : <p className="settings-muted-note">没有匹配的模型。</p>}
                    </div>
                    <small className="settings-muted-note">保留供应商返回的全部条目；未收录或非对话模型仅供查看。视觉、推理和上下文能力继续以 Pi 适配信息为准，模型可见不保证有调用权限或额度。</small>
                  </section>}
                  {error && <div className="settings-error"><WarningCircle size={15} weight="fill" />{error}</div>}
                  <div className="settings-files"><div><span>Pi 设置</span><code>{modelSettings?.paths?.settings || "~/.pi/agent/settings.json"}</code></div><div><span>服务配置</span><code>{modelSettings?.paths?.models || "~/.pi/agent/models.json"}</code></div><div><span>认证凭据</span><code>{modelSettings?.paths?.auth || "~/.pi/agent/auth.json"}</code></div></div>
                  <div className="settings-actions">{provider?.configured && <button type="button" className="button-danger-quiet" onClick={() => onClearCredential(providerId)} disabled={saving || providerBusy}>清除凭据</button>}<span /><button type="submit" className="button-primary" disabled={saving || providerBusy || !providerId || !modelId}>{saving ? <><CircleNotch size={14} className="spin" />正在保存</> : <><Check size={14} />保存并使用</>}</button></div>
                </form>
                </>
              )}
            </div>
          )}

          {section === "agent" && (
            <div className="settings-section-stack"><div className="settings-content-heading"><div><h2>Agent 与权限</h2><p>这是新项目和新 Session 的默认执行策略，项目设置可以覆盖它。</p></div></div><section className="settings-block"><label className="field-control"><span>默认权限模式</span><select value={desktopSettings?.defaultPermissionMode || "ask"} onChange={(event) => onSaveDesktop({ defaultPermissionMode: event.target.value })}><option value="read-only">只读</option><option value="ask">执行前询问</option><option value="full">完全访问</option></select><small>权限判断仍在 Agent Host 执行，页面只负责展示和收集审批。</small></label></section></div>
          )}

          {section === "tools" && (
            <div className="settings-section-stack is-wide">
              <div className="settings-content-heading">
                <div><h2>Tools</h2><p>控制 Agentx 默认可调用的本地能力；项目可以单独覆盖。</p></div>
                <span className="tool-count">{enabledToolIds.length} / {toolCatalog.length} 已启用</span>
              </div>
              <section className="settings-block tool-catalog-block">
                <ToolRows
                  tools={toolCatalog}
                  enabledIds={enabledToolIds}
                  onToggle={(toolId, checked) => {
                    const enabled = checked ? [...new Set([...enabledToolIds, toolId])] : enabledToolIds.filter((id) => id !== toolId);
                    onSaveDesktop({ tools: { enabled } });
                  }}
                />
              </section>
              <section className="settings-block settings-info-row"><ArrowsClockwise size={20} /><div><strong>生效范围</strong><span>工具变更会在新建、切换或重新打开 Session 时装载；当前运行中的请求保持不变。</span></div></section>
            </div>
          )}

          {section === "skills" && (
            <div className="settings-section-stack is-wide">
              <div className="settings-content-heading"><div><h2>Skills</h2><p>全局行为和当前项目的 Skills 安装统一在这里管理。</p></div></div>
              <div className="settings-skills-options">
                <section className="settings-block settings-option-row"><div><strong>安装后自动重新加载</strong><span>Skill 安装或卸载完成后刷新当前 Agentx Session。</span></div><input className="settings-switch" type="checkbox" checked={desktopSettings?.skills?.autoReload !== false} onChange={(event) => onSaveDesktop({ skills: { autoReload: event.target.checked } })} /></section>
                <section className="settings-block settings-option-row"><div><strong>允许导入本地 Skill</strong><span>允许从本机选择包含 SKILL.md 的目录。</span></div><input className="settings-switch" type="checkbox" checked={desktopSettings?.skills?.allowLocalImport !== false} onChange={(event) => onSaveDesktop({ skills: { allowLocalImport: event.target.checked } })} /></section>
              </div>
              <SkillsPage
                transport={transport}
                connected={runtime.connected}
                workspace={workspace}
                embedded
                autoReload={desktopSettings?.skills?.autoReload !== false}
                allowLocalImport={desktopSettings?.skills?.allowLocalImport !== false}
              />
            </div>
          )}

          {section === "defaults" && (
            <div className="settings-section-stack"><div className="settings-content-heading"><div><h2>新项目默认值</h2><p>新建项目会继承这些设置；已经存在的项目不会被强制覆盖。</p></div></div><section className="settings-block"><label className="field-control"><span>新项目默认模型</span><select value={desktopSettings?.defaultModel || ""} onChange={(event) => onSaveDesktop({ defaultModel: event.target.value || null })}><option value="">跟随当前全局模型</option>{(modelSettings?.providers || []).flatMap((item) => item.models.map((model) => <option key={`${item.id}::${model.id}`} value={`${item.id}::${model.id}`}>{model.name || model.id} · {item.name}</option>))}</select></label><small className="settings-muted-note">项目创建后仍可通过项目行的铅笔按钮单独修改模型和权限。</small></section><section className="settings-block"><label className="field-control"><span>新项目默认权限</span><select value={desktopSettings?.defaultPermissionMode || "ask"} onChange={(event) => onSaveDesktop({ defaultPermissionMode: event.target.value })}><option value="read-only">只读</option><option value="ask">执行前询问</option><option value="full">完全访问</option></select></label></section></div>
          )}

          {section === "storage" && (
            <div className="settings-section-stack"><div className="settings-content-heading"><div><h2>存储与会话</h2><p>查看配置和 Session 的归属。这里不会删除项目文件。</p></div></div><section className="settings-block"><div className="settings-file-list"><div><span>Desktop 配置</span><code>Electron userData/desktop-settings.json</code></div><div><span>最近项目</span><code>Electron userData/projects.json</code></div><div><span>工作区状态</span><code>Electron userData/workspace-state.json</code></div><div><span>Session 内容</span><code>由 Pi SessionManager 管理的 JSONL</code></div><div><span>当前工作区</span><code>{workspace?.cwd || "尚未选择"}</code></div></div></section><section className="settings-block settings-info-row"><Package size={20} /><div><strong>数据边界</strong><span>从最近项目中移除不会删除实际目录；删除项目目录需要在当前项目设置中单独确认。</span></div></section></div>
          )}

          {section === "diagnostics" && (
            <div className="settings-section-stack"><div className="settings-content-heading"><div><h2>运行与诊断</h2><p>重新读取本地配置并排查运行问题。</p></div></div><section className="settings-block settings-info-row"><Cpu size={20} /><div><strong>系统连接状态</strong><span>运行环境与服务连接信息统一显示在通用页面。</span></div><button className="button-secondary" onClick={() => setSection("general")}>查看系统信息</button></section><section className="settings-block settings-info-row"><ArrowsClockwise size={20} /><div><strong>重新读取模型配置</strong><span>模型设置保存后会通过 Agent Host 重新加载 Provider。</span></div><button className="button-secondary" onClick={onReloadModels}>重新读取</button></section></div>
          )}
        </div>
      </div>
    </section>
  );
}

function modelValue(model) {
  return model ? `${model.provider}::${model.id}` : "";
}

export function App() {
  const transportRef = useRef(null);
  const [tasks, setTasks] = useState(() => desktopMode
    ? [{ id: "workspace", title: "选择工作目录", repo: "未连接", branch: "-", time: "现在", status: "idle" }]
    : initialTasks);
  const [activeTaskId, setActiveTaskId] = useState(desktopMode ? "workspace" : "pi-shell");
  const [sessions, setSessions] = useState(desktopMode ? { workspace: [] } : starterSessions);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
  const [runningSessions, setRunningSessions] = useState({});
  const [inputQueues, setInputQueues] = useState({});
  const [sendingInput, setSendingInput] = useState(false);
  const submittingInput = useRef(false);
  const draftCache = useRef(new Map());
  const draftSession = useRef(activeTaskId);
  useEffect(() => {
    if (draftSession.current !== activeTaskId) {
      const draft = draftCache.current.get(activeTaskId);
      setInput(draft?.text || "");
      setAttachments(draft?.attachments || []);
      setAttachmentError("");
      draftSession.current = activeTaskId;
    }
  }, [activeTaskId]);
  useEffect(() => { draftCache.current.set(activeTaskId, { text: input, attachments }); }, [activeTaskId, input, attachments]);
  const running = Boolean(runningSessions[activeTaskId]);
  const activeSessionRef = useRef(activeTaskId);
  activeSessionRef.current = activeTaskId;
  const pendingApprovals = useRef(new Map());
  const panelStateCache = useRef(new Map());
  const panelOpenCache = useRef(new Map());
  const [approval, setApproval] = useState(null);
  const [reviewOpen, setReviewOpen] = useState(() => window.innerWidth >= 1120);
  const [previewRequest, setPreviewRequest] = useState(null);
  const openPreview = useCallback((path = null) => { setPreviewRequest({ path, sequence: Date.now() }); setReviewOpen(true); }, []);
  const openWebPreview = useCallback((url) => { setPreviewRequest({ url, sequence: Date.now() }); setReviewOpen(true); }, []);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState("conversation");
  const [model, setModel] = useState(desktopMode ? null : { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" });
  const [permission, setPermission] = useState("执行前询问");
  const [runtime, setRuntime] = useState({ connected: !desktopMode, authenticated: !desktopMode, message: "浏览器演示模式" });
  const [runtimeError, setRuntimeError] = useState("");
  const [availableModels, setAvailableModels] = useState([]);
  const [modelSettings, setModelSettings] = useState(null);
  const [desktopSettings, setDesktopSettings] = useState(null);
  const [toolCatalog, setToolCatalog] = useState([]);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectSessions, setProjectSessions] = useState([]);
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createProjectBusy, setCreateProjectBusy] = useState(false);
  const [createProjectError, setCreateProjectError] = useState("");
  const [renameSessionTarget, setRenameSessionTarget] = useState(null);
  const [renameSessionBusy, setRenameSessionBusy] = useState(false);
  const [renameSessionError, setRenameSessionError] = useState("");
  const [changeSnapshots, setChangeSnapshots] = useState({});
  const changeSnapshot = changeSnapshots[activeTaskId] || (desktopMode ? { files: [], additions: 0, deletions: 0, patch: "" } : null);
  const setChangeSnapshot = (snapshot, sessionId = activeSessionRef.current) => setChangeSnapshots((current) => ({ ...current, [sessionId]: snapshot }));
  const activeTask = useMemo(() => tasks.find((task) => task.id === activeTaskId) || tasks[0], [tasks, activeTaskId]);
  const messages = sessions[activeTaskId] || [];
  const threadScroll = useThreadScroll({ sessionId: activeTaskId, messages, running, visible: activeView === "conversation" });
  const currentProject = projects.find((item) => item.id === activeProjectId);
  const currentSession = currentProject?.sessions?.find((item) => item.sessionId === activeTaskId);
  const supportsImages = !desktopMode || model?.input?.includes("image");
  const hasUnsupportedImage = attachments.some((attachment) => attachment.kind === "image") && !supportsImages;

  useEffect(() => { panelOpenCache.current.set(activeTaskId, reviewOpen); }, [activeTaskId, reviewOpen]);

  useEffect(() => {
    const transport = createTransport();
    transportRef.current = transport;
    transport.getDesktopSettings?.().then((settings) => {
      setDesktopSettings(settings);
      const permissionLabels = { "read-only": "只读", ask: "执行前询问", full: "完全访问" };
      if (settings?.defaultPermissionMode && activeSessionRef.current === "workspace") setPermission(permissionLabels[settings.defaultPermissionMode] || "执行前询问");
    }).catch(() => {});
    transport.listTools?.().then((result) => setToolCatalog(result?.tools || [])).catch(() => {});
    transport.listProjects?.().then((items) => {
      setProjects(items || []);
      if (items?.[0]) setActiveProjectId(items[0].id);
    }).catch(() => {});
    const handleEvent = (event) => {
      if (event.type === "workspace.connected") {
        activeSessionRef.current = event.sessionId;
        setActiveProjectId(event.projectId || null);
        const task = {
          id: event.sessionId,
          title: event.repo,
          repo: event.repo,
          branch: event.branch || "workspace",
          cwd: event.cwd,
          time: "刚刚",
          status: event.running ? "running" : "idle",
        };
        setTasks((current) => [task, ...current.filter((item) => item.id !== event.sessionId)]);
        setSessions((current) => ({ ...current, [event.sessionId]: event.running && current[event.sessionId] ? current[event.sessionId] : event.messages || [] }));
        setActiveTaskId(event.sessionId);
        setRunningSessions((current) => ({ ...current, [event.sessionId]: Boolean(event.running) }));
        setInputQueues((current) => ({ ...current, [event.sessionId]: event.pendingInputs || [] }));
        setPermission(({ "read-only": "只读", ask: "执行前询问", full: "完全访问" })[event.permissionMode] || "执行前询问");
        setApproval(event.pendingApprovals?.[0] || pendingApprovals.current.get(event.sessionId) || null);
        setPreviewRequest(null);
        setReviewOpen(panelOpenCache.current.get(event.sessionId) ?? false);
        setAvailableModels(event.availableModels || []);
        setModel(event.model || null);
        setRuntime({ connected: true, authenticated: Boolean(event.authenticated), message: event.authenticated ? "Agentx 已就绪" : "Agentx 已连接，但尚未配置模型凭据" });
        setRuntimeError("");
        transport.listSessions?.({ cwd: event.cwd, projectId: event.projectId }).then((result) => setProjectSessions(result?.sessions || [])).catch(() => {});
        transport.listProjects?.().then((items) => setProjects(items || [])).catch(() => {});
      }
      if (event.type === "projects.updated") setProjects(event.projects || []);
      if (event.type === "queue.updated") setInputQueues((current) => ({ ...current, [event.sessionId]: event.entries || [] }));
      if (event.type === "input.consumed") {
        setSessions((current) => ({ ...current, [event.sessionId]: [
          ...(current[event.sessionId] || []).filter((message) => message.id !== `user-${event.input.id}`),
          { id: `user-${event.input.id}`, role: "user", text: event.input.text, attachments: event.input.attachments },
        ] }));
      }
      const isCurrent = !event.sessionId || event.sessionId === activeSessionRef.current;
      if (event.type === "runtime.status") {
        if (isCurrent) setRuntime({ connected: event.connected, authenticated: event.authenticated, message: event.message });
      }
      if (event.type === "models.updated" && isCurrent) {
        setModel(event.model || null);
        setAvailableModels(event.availableModels || []);
        setRuntime((current) => ({ ...current, authenticated: event.authenticated }));
        setRuntimeError("");
      }
      if (event.type === "runtime.error" && isCurrent) {
        setRuntimeError(event.message || "Agentx 运行失败");
      }
      if (event.type === "run.started") {
        setRunningSessions((current) => ({ ...current, [event.sessionId]: true }));
        if (isCurrent) setRuntimeError("");
        setTasks((current) => current.map((task) => task.id === event.sessionId ? { ...task, status: "running", time: "进行中" } : task));
      }
      if (event.type === "message.started") {
        setSessions((current) => {
          const list = [...(current[event.sessionId] || [])];
          const existing = list.findIndex((message) => message.role === "assistant" && message.runId === event.runId);
          if (existing >= 0) return current;
          list.push({ id: `assistant-${event.runId || event.messageId}`, runId: event.runId, role: "assistant", text: "", activities: [], status: "running", startedAt: event.startedAt || Date.now() });
          return { ...current, [event.sessionId]: list };
        });
      }
      if (event.type === "message.delta") {
        setSessions((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] || []).map((message) => message.runId === event.runId ? { ...message, text: `${message.text}${event.text}` } : message),
        }));
      }
      if (event.type === "message.error") {
        setSessions((current) => {
          const list = [...(current[event.sessionId] || [])];
          const index = list.findIndex((message) => message.role === "assistant" && message.runId === event.runId);
          if (index >= 0) list[index] = { ...list[index], error: event.error, status: "error" };
          else list.push({ id: `assistant-${event.runId}`, runId: event.runId, role: "assistant", text: "", activities: [], error: event.error, status: "error" });
          return { ...current, [event.sessionId]: list };
        });
      }
      if (event.type === "reasoning.started") {
        setSessions((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] || []).map((message) => message.runId === event.runId ? {
            ...message,
            activities: [...(message.activities || []), { id: event.reasoningId, kind: "reasoning", status: "running", title: "思考过程", meta: "思考中", output: "" }],
          } : message),
        }));
      }
      if (event.type === "reasoning.delta" || event.type === "reasoning.completed") {
        setSessions((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] || []).map((message) => message.runId === event.runId ? {
            ...message,
            activities: message.activities?.map((activity) => activity.id === event.reasoningId ? {
              ...activity,
              status: event.type === "reasoning.completed" ? "done" : activity.status,
              meta: event.type === "reasoning.completed" ? "完成" : "思考中",
              output: event.type === "reasoning.completed" ? (event.text || activity.output) : `${activity.output || ""}${event.text || ""}`,
            } : activity),
          } : message),
        }));
      }
      if (event.type === "approval.requested") {
        pendingApprovals.current.set(event.sessionId, event);
        if (isCurrent) setApproval(event);
      }
      if (event.type === "approval.resolved") {
        pendingApprovals.current.delete(event.sessionId);
        if (isCurrent) setApproval(null);
      }
      if (event.type === "tool.started") {
        setSessions((current) => {
          const list = [...(current[event.sessionId] || [])];
          const actualIndex = list.findIndex((item) => item.role === "assistant" && item.runId === event.runId);
          if (actualIndex < 0) return current;
          list[actualIndex] = { ...list[actualIndex], activities: [...(list[actualIndex].activities || []), { id: event.toolCallId, kind: "tool", status: "running", title: event.title, meta: "运行中", output: event.command, startedAt: event.startedAt }] };
          return { ...current, [event.sessionId]: list };
        });
      }
      if (event.type === "tool.progress" || event.type === "tool.completed") {
        setSessions((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] || []).map((message) => message.runId === event.runId ? ({
            ...message,
            activities: message.activities?.map((activity) => activity.id === event.toolCallId ? {
              ...activity,
              status: event.type === "tool.completed" ? (event.isError ? "error" : "done") : activity.status,
              meta: event.type === "tool.completed" ? (event.isError ? "失败" : "完成") : "正在输出",
              output: event.output || activity.output,
              completedAt: event.completedAt || activity.completedAt,
            } : activity),
          }) : message),
        }));
      }
      if (event.type === "changes.available") {
        const files = Array.isArray(event.files) ? event.files : [];
        setChangeSnapshot({ files, additions: event.additions || 0, deletions: event.deletions || 0, patch: event.patch || "" }, event.sessionId);
        setSessions((current) => {
          const list = [...(current[event.sessionId] || [])];
          if (!list.length) return current;
          const last = list.length - 1;
          list[last] = { ...list[last], changes: { files: files.length, additions: event.additions, deletions: event.deletions } };
          return { ...current, [event.sessionId]: list };
        });
      }
      if (event.type === "run.settled" || event.type === "run.segment.settled") {
        const settled = event.type === "run.settled";
        if (settled) setRunningSessions((current) => ({ ...current, [event.sessionId]: false }));
        pendingApprovals.current.delete(event.sessionId);
        if (isCurrent) setApproval(null);
        if (settled) setTasks((current) => current.map((task) => task.id === event.sessionId ? { ...task, status: event.status === "error" ? "error" : "done", time: "刚刚" } : task));
        setSessions((current) => ({
          ...current,
          [event.sessionId]: (current[event.sessionId] || []).map((message) => message.runId === event.runId ? {
            ...message,
            status: event.status === "error" ? "error" : "done",
            completedAt: event.completedAt || Date.now(),
            durationMs: event.durationMs,
            activities: message.activities?.map((activity) => activity.status === "running" ? {
              ...activity,
              status: event.status === "error" ? "error" : "done",
              meta: event.status === "error" ? "已中断" : "已结束",
            } : activity),
          } : message),
        }));
      }
    };
    // Batch high-frequency output without losing event order or final tokens.
    let pendingOutput = [];
    let outputTimer;
    const flushOutput = () => {
      window.clearTimeout(outputTimer);
      outputTimer = undefined;
      const events = pendingOutput;
      pendingOutput = [];
      events.forEach(handleEvent);
    };
    const unsubscribe = transport.subscribe((event) => {
      if (["message.delta", "reasoning.delta", "tool.progress"].includes(event.type)) {
        pendingOutput.push(event);
        outputTimer ??= window.setTimeout(flushOutput, 40);
      } else {
        flushOutput();
        handleEvent(event);
      }
    });
    return () => {
      window.clearTimeout(outputTimer);
      unsubscribe();
      transport.dispose();
    };
  }, []);

  useEffect(() => {
    if (!desktopMode) return;
    transportRef.current?.restoreWorkspace().catch((error) => setRuntimeError(error.message));
  }, []);

  const openWorkspace = async () => {
    if (!desktopMode) return;
    setRuntimeError("");
    try {
      await transportRef.current?.openWorkspace();
    } catch (error) {
      setRuntimeError(error.message || "无法打开工作目录");
    }
  };

  const refreshProjects = async () => {
    const next = await transportRef.current?.listProjects?.();
    if (next) setProjects(next);
    return next || [];
  };

  const openProjectManager = async (projectId = activeProjectId) => {
    const next = await refreshProjects();
    if (projectId && next.some((item) => item.id === projectId)) setActiveProjectId(projectId);
    else if (!projectId && next[0]) setActiveProjectId(next[0].id);
    setProjectDialogOpen(true);
    setReviewOpen(false);
  };

  const openCreateProject = () => {
    setCreateProjectError("");
    setCreateProjectOpen(true);
  };

  const openProject = async (projectId, sessionId) => {
    setRuntimeError("");
    try {
      const result = await transportRef.current?.projectCommand({ type: "open", projectId, sessionId });
      if (result?.pathExists === false) setRuntimeError("项目目录不可用，请重新关联目录");
      await refreshProjects();
    } catch (error) {
      setRuntimeError(error.message || "无法打开项目");
    }
  };

  const createProject = async () => {
    try {
      const result = await transportRef.current?.openProjectFolder?.();
      if (result?.project) {
        setProjects((current) => [result.project, ...current.filter((item) => item.id !== result.project.id)]);
        setActiveProjectId(result.project.id);
      }
    } catch (error) {
      setRuntimeError(error.message || "无法创建项目");
    }
  };

  const createProjectFromForm = async ({ name, rootPath }) => {
    setCreateProjectBusy(true);
    setCreateProjectError("");
    try {
      const result = await transportRef.current?.projectCommand({ type: "create", name, rootPath });
      if (!result?.project) throw new Error("项目创建失败");
      setProjects((current) => [result.project, ...current.filter((item) => item.id !== result.project.id)]);
      setActiveProjectId(result.project.id);
      setCreateProjectOpen(false);
      await openProject(result.project.id);
      setActiveView("conversation");
    } catch (error) {
      setCreateProjectError(error.message || "无法创建项目");
    } finally {
      setCreateProjectBusy(false);
    }
  };

  const updateProject = async (projectId, patch) => {
    try {
      const updated = await transportRef.current?.projectCommand({ type: "update", projectId, patch });
      if (updated) {
        setProjects((current) => current.map((item) => item.id === projectId ? updated : item));
        if (patch.removed === true) {
          setProjectDialogOpen(false);
          setActiveView("conversation");
          setActiveProjectId((current) => current === projectId ? null : current);
        }
      }
    } catch (error) {
      setRuntimeError(error.message || "无法保存项目设置");
    }
  };

  const relinkProject = async (projectId) => {
    try {
      const result = await transportRef.current?.projectCommand({ type: "relink", projectId });
      if (result?.project) {
        setProjects((current) => current.map((item) => item.id === projectId ? result.project : item));
        setActiveProjectId(projectId);
      }
    } catch (error) {
      setRuntimeError(error.message || "无法重新关联项目目录");
    }
  };

  const openProjectTarget = async (projectId, target) => {
    try { await transportRef.current?.projectCommand({ type: "open-target", projectId, target }); } catch (error) { setRuntimeError(error.message || "无法打开项目目录"); }
  };

  const readGitStatus = (projectId) => transportRef.current?.projectCommand({ type: "git-status", projectId });

  const openSession = async (projectId, session) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    try {
      await transportRef.current?.openSession({ cwd: project.rootPath, projectId, sessionFile: session.sessionFile });
      setProjectDialogOpen(false);
      setActiveView("conversation");
    } catch (error) { setRuntimeError(error.message || "无法打开 Session"); }
  };

  const newSession = async (projectId) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project) return;
    try {
      await transportRef.current?.newSession({ cwd: project.rootPath, projectId });
      setProjectDialogOpen(false);
      setActiveView("conversation");
    } catch (error) { setRuntimeError(error.message || "无法创建 Session"); }
  };

  const renameSession = async (projectId, session, name) => {
    const project = projects.find((item) => item.id === projectId);
    if (!project || !name.trim()) return;
    try {
      const result = await transportRef.current?.projectCommand({ type: "rename-session", projectId, sessionId: session.sessionId, sessionFile: session.sessionFile, name: name.trim() });
      if (result?.project) setProjects((current) => current.map((item) => item.id === projectId ? result.project : item));
      if (result?.sessions) setProjectSessions(result.sessions);
      setTasks((current) => current.map((task) => task.id === session.sessionId ? { ...task, title: name.trim() } : task));
      return true;
    } catch (error) {
      setRuntimeError(error.message || "无法重命名 Session");
      throw error;
    }
  };

  const saveSidebarSessionRename = async (name) => {
    if (!renameSessionTarget) return;
    setRenameSessionBusy(true);
    setRenameSessionError("");
    try {
      await renameSession(renameSessionTarget.project.id, renameSessionTarget.session, name);
      setRenameSessionTarget(null);
    } catch (error) {
      setRenameSessionError(error.message || "无法重命名 Session");
    } finally {
      setRenameSessionBusy(false);
    }
  };

  const archiveSession = async (projectId, session) => {
    try {
      const updated = await transportRef.current?.projectCommand({ type: "archive-session", projectId, sessionId: session.sessionId });
      if (updated) {
        setProjects((current) => current.map((item) => item.id === projectId ? updated : item));
        setProjectSessions((current) => current.map((item) => item.sessionId === session.sessionId ? { ...item, archived: true } : item));
      }
    } catch (error) { setRuntimeError(error.message || "无法归档 Session"); throw error; }
  };

  const restoreSession = async (projectId, session) => {
    try {
      const updated = await transportRef.current?.projectCommand({ type: "restore-session", projectId, sessionId: session.sessionId });
      if (updated) {
        setProjects((current) => current.map((item) => item.id === projectId ? updated : item));
        setProjectSessions((current) => current.map((item) => item.sessionId === session.sessionId ? { ...item, archived: false } : item));
      }
    } catch (error) { setRuntimeError(error.message || "无法恢复 Session"); }
  };

  const deleteProjectDirectory = async (projectId) => {
    if (!window.confirm("确定将项目目录移到系统回收站吗？这会影响实际文件，不只是从最近项目中移除。")) return;
    try {
      const updated = await transportRef.current?.projectCommand({ type: "delete-directory", projectId, confirmed: true });
      if (updated) {
        setProjects((current) => current.map((item) => item.id === projectId ? updated : item));
        setProjectDialogOpen(false);
        setActiveView("conversation");
        setActiveProjectId((current) => current === projectId ? null : current);
      }
    } catch (error) { setRuntimeError(error.message || "无法移除项目目录"); }
  };

  const createTask = () => {
    if (desktopMode) {
      if (activeProjectId) newSession(activeProjectId);
      else openWorkspace();
      return;
    }
    const id = `task-${Date.now()}`;
    const task = { id, title: "未命名会话", repo: "选择项目", branch: "main", time: "刚刚", status: "idle" };
    setTasks((current) => [task, ...current]);
    setSessions((current) => ({ ...current, [id]: [] }));
    setActiveTaskId(id);
    setPreviewRequest(null);
    setActiveView("conversation");
    setReviewOpen(false);
  };

  const chooseAttachments = async () => {
    if (attachmentPickerBusy || attachments.length >= 8) return;
    setAttachmentPickerBusy(true);
    setAttachmentError("");
    try {
      const result = await transportRef.current?.chooseAttachments?.({ maxFiles: 8 - attachments.length });
      const rejected = [...(result?.rejected || [])];
      const accepted = [];
      let totalBytes = attachments.reduce((sum, item) => sum + (item.size || 0), 0);
      for (const attachment of (result?.attachments || [])) {
        if (attachment.kind === "image" && !supportsImages) {
          rejected.push({ name: attachment.name, message: "当前模型不支持图片输入" });
          continue;
        }
        if (totalBytes + (attachment.size || 0) > 24 * 1024 * 1024) {
          rejected.push({ name: attachment.name, message: "附件总大小不能超过 24 MB" });
          continue;
        }
        totalBytes += attachment.size || 0;
        accepted.push(attachment);
      }
      if (accepted.length) setAttachments((current) => [...current, ...accepted].slice(0, 8));
      if (rejected.length) setAttachmentError(rejected.map((item) => `${item.name}：${item.message}`).join("；"));
    } catch (error) {
      setAttachmentError(error.message || "无法添加附件");
    } finally {
      setAttachmentPickerBusy(false);
    }
  };

  const removeAttachment = (id) => {
    setAttachments((current) => current.filter((item) => item.id !== id));
    setAttachmentError("");
  };

  const submit = async () => {
    const text = input.trim();
    if ((!text && attachments.length === 0) || submittingInput.current) return;
    if (hasUnsupportedImage) {
      setAttachmentError("当前模型不支持图片输入，请移除图片或切换模型。");
      return;
    }
    if (desktopMode && !runtime.connected) {
      await openWorkspace();
      return;
    }
    const submittedAttachments = attachments;
    const displayText = text || "请阅读并处理所附文件。";
    const submittedSessionId = activeTaskId;
    const wasRunning = running;
    submittingInput.current = true;
    setSendingInput(true);
    if (wasRunning) {
      try {
        await transportRef.current.queueInput({ sessionId: submittedSessionId, inputId: crypto.randomUUID(), text: displayText, attachments: submittedAttachments, behavior: "followUp" });
        const draft = draftCache.current.get(submittedSessionId);
        if (draft) draftCache.current.set(submittedSessionId, { text: draft.text === input ? "" : draft.text, attachments: draft.attachments === submittedAttachments ? [] : draft.attachments });
        if (activeSessionRef.current === submittedSessionId) {
          setInput((current) => current === input ? "" : current);
          setAttachments((current) => current === submittedAttachments ? [] : current);
          setAttachmentError("");
        }
      } catch (error) {
        if (activeSessionRef.current === submittedSessionId) setAttachmentError(error.message || "消息未加入队列，请重试");
      } finally { submittingInput.current = false; setSendingInput(false); }
      return;
    }
    threadScroll.jumpToBottom();
    setInput("");
    setAttachments([]);
    setAttachmentError("");
    draftCache.current.set(submittedSessionId, { text: "", attachments: [] });
    setRunningSessions((current) => ({ ...current, [submittedSessionId]: true }));
    setRuntimeError("");
    setSessions((current) => ({
      ...current,
      [activeTaskId]: [...(current[activeTaskId] || []), { id: `user-${Date.now()}`, role: "user", text: displayText, attachments: submittedAttachments }],
    }));
    if (activeTask.title === "未命名会话") {
      setTasks((current) => current.map((task) => task.id === activeTaskId ? { ...task, title: displayText.slice(0, 24), repo: "pi-desktop" } : task));
    }
    // prompt() resolves after the whole run; release only the submission lock
    // now so another input can be queued while this request is streaming.
    submittingInput.current = false;
    setSendingInput(false);
    try {
      await transportRef.current?.prompt({ sessionId: activeTaskId, text: displayText, attachments: submittedAttachments });
      const nextProjects = await transportRef.current?.listProjects?.();
      if (nextProjects) setProjects(nextProjects);
    } catch (error) {
      setRunningSessions((current) => ({ ...current, [submittedSessionId]: false }));
      if (activeSessionRef.current === submittedSessionId) {
        setInput((current) => current || text);
        setAttachments((current) => current.length ? current : submittedAttachments);
        setRuntimeError(error.message || "任务执行失败");
      }
    }
  };

  const resumeQueuedInput = async (entry) => {
    if (running || submittingInput.current) return;
    const sessionId = activeTaskId;
    setRunningSessions((current) => ({ ...current, [sessionId]: true }));
    try { await transportRef.current.prompt({ sessionId, queuedInputId: entry.id }); }
    catch (error) {
      setRunningSessions((current) => ({ ...current, [sessionId]: false }));
      if (activeSessionRef.current === sessionId) setRuntimeError(error.message || "无法继续发送");
    }
  };

  const removeQueuedInput = async (entry, edit = false) => {
    const sessionId = activeTaskId;
    try {
      await transportRef.current.removeQueuedInput(sessionId, entry.id);
      if (edit) {
        draftCache.current.set(sessionId, { text: entry.text, attachments: entry.attachments || [] });
        if (activeSessionRef.current === sessionId) { setInput(entry.text); setAttachments(entry.attachments || []); }
      }
    } catch (error) { if (activeSessionRef.current === sessionId) setRuntimeError(error.message || "无法移除待处理消息"); }
  };

  const changeQueuedInputBehavior = async (entry, behavior) => {
    const sessionId = activeTaskId;
    try { await transportRef.current.setQueuedInputBehavior(sessionId, entry.id, behavior); }
    catch (error) { if (activeSessionRef.current === sessionId) setRuntimeError(error.message || "无法修改排队方式"); }
  };

  const decideApproval = async (approved, remember = false) => {
    const requestId = approval?.requestId;
    setApproval(null);
    const sessionId = approval?.sessionId;
    pendingApprovals.current.delete(sessionId);
    await transportRef.current?.respondToApproval({ requestId, sessionId, approved, remember });
  };

  const changePermission = async (value) => {
    const modes = { "只读": "read-only", "执行前询问": "ask", "完全访问": "full" };
    try {
      await transportRef.current?.setPermissionMode(modes[value], activeTaskId);
      if (activeSessionRef.current === activeTaskId) setPermission(value);
    } catch (error) {
      setRuntimeError(error.message || "无法更新权限模式");
    }
  };

  const refreshChanges = async () => {
    try {
      const sessionId = activeTaskId;
      const snapshot = await transportRef.current?.getChanges(sessionId);
      if (snapshot) setChangeSnapshot(snapshot, sessionId);
    } catch (error) {
      setRuntimeError(error.message || "无法读取工作区变更");
    }
  };

  const openSettings = async () => {
    if (activeView === "management") {
      setActiveView("conversation");
      return;
    }
    setActiveView("management");
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const [models, desktop, toolsResult] = await Promise.all([
        transportRef.current?.getModelSettings(),
        transportRef.current?.getDesktopSettings(),
        transportRef.current?.listTools?.(),
      ]);
      setModelSettings(models);
      setDesktopSettings(desktop);
      setToolCatalog(toolsResult?.tools || []);
    } catch (error) {
      setSettingsError(error.message || "无法读取模型设置");
    } finally {
      setSettingsLoading(false);
    }
  };

  const saveSettings = async (values) => {
    setSettingsSaving(true);
    setSettingsError("");
    try {
      const next = await transportRef.current?.saveModelSettings(values);
      setModelSettings(next);
      setModel(next?.currentModel || null);
    } catch (error) {
      setSettingsError(error.message || "无法保存模型设置");
    } finally {
      setSettingsSaving(false);
    }
  };

  const saveDesktopSettings = async (patch) => {
    setSettingsError("");
    try {
      const next = await transportRef.current?.saveDesktopSettings(patch);
      if (next) setDesktopSettings(next);
    } catch (error) {
      setSettingsError(error.message || "无法保存 Desktop 设置");
    }
  };

  const reloadModelSettings = async () => {
    setSettingsLoading(true);
    setSettingsError("");
    try {
      const next = await transportRef.current?.getModelSettings();
      setModelSettings(next);
      setModel(next?.currentModel || null);
    } catch (error) {
      setSettingsError(error.message || "无法重新读取模型配置");
    } finally {
      setSettingsLoading(false);
    }
  };

  const clearProviderCredential = async (providerId) => {
    setSettingsSaving(true);
    setSettingsError("");
    try {
      setModelSettings(await transportRef.current?.clearProviderCredential(providerId));
    } catch (error) {
      setSettingsError(error.message || "无法清除凭据");
    } finally {
      setSettingsSaving(false);
    }
  };

  const changeModel = async (value) => {
    const nextModel = availableModels.find((item) => modelValue(item) === value);
    if (!nextModel) return;
    const previous = model;
    setModel(nextModel);
    try {
      const result = await transportRef.current?.setModel({ providerId: nextModel.provider, modelId: nextModel.id });
      setModel(result?.model || nextModel);
      setRuntimeError("");
    } catch (error) {
      setModel(previous);
      setRuntimeError(error.message || "无法切换模型");
    }
  };

  return (
    <div className="app-shell">
      <Sidebar
        tasks={tasks}
        runningSessions={runningSessions}
        projects={projects.filter((item) => !item.removed)}
        activeProjectId={activeProjectId}
        activeTaskId={activeTaskId}
        onSelect={(id) => { setActiveTaskId(id); setPreviewRequest(null); setReviewOpen(panelOpenCache.current.get(id) ?? false); setActiveView("conversation"); setApproval(null); }}
        onProjectSelect={(projectId) => { const project = projects.find((item) => item.id === projectId); setActiveProjectId(projectId); openProject(projectId, project?.lastSessionId); setActiveView("conversation"); setApproval(null); }}
        onSessionSelect={(project, session) => { setActiveProjectId(project.id); openSession(project.id, session); setApproval(null); }}
        onRenameSession={(project, session) => { setRenameSessionError(""); setRenameSessionTarget({ project, session }); }}
        onCreateProject={openCreateProject}
        onCreateSession={(project) => { setActiveProjectId(project.id); newSession(project.id); setApproval(null); }}
        onManageProject={(projectId) => { setActiveProjectId(projectId); openProjectManager(projectId); }}
        onNew={createTask}
        collapsed={sidebarCollapsed}
        onCollapse={() => setSidebarCollapsed((value) => !value)}
        runtime={runtime}
        activeView={activeView}
        onManagement={openSettings}
      />

      <main className="workspace">
        {activeView === "management" ? (
          <SettingsPage
            transport={transportRef.current}
            modelSettings={modelSettings}
            desktopSettings={desktopSettings}
            toolCatalog={toolCatalog}
            availableModels={availableModels}
            loading={settingsLoading}
            saving={settingsSaving}
            error={settingsError}
            runtime={runtime}
            workspace={activeTask}
            onSaveModel={saveSettings}
            onClearCredential={clearProviderCredential}
            onSaveDesktop={saveDesktopSettings}
            onChooseProjectFolder={() => transportRef.current?.chooseProjectFolder?.()}
            onReloadModels={reloadModelSettings}
          />
        ) : null}
        <div className="conversation-view" hidden={activeView === "management"} onClickCapture={(event) => {
          const link = event.target.closest?.("a[href]");
          if (!link || !/^https?:\/\//i.test(link.getAttribute("href") || "")) return;
          event.preventDefault(); event.stopPropagation(); openWebPreview(link.href);
        }} onContextMenuCapture={(event) => {
          const link = event.target.closest?.("a[href]");
          if (!link || !/^https?:\/\//i.test(link.getAttribute("href") || "") || !window.piDesktop?.browser) return;
          event.preventDefault();
          window.piDesktop.browser({ type: "link-menu", url: link.href }).catch(() => {});
        }}>
          <header className="workspace-header">
            <div className="task-heading">
              <h1>{currentSession?.title || activeTask.title}</h1>
              <button className="repo-chip" onClick={openWorkspace} title={activeTask.cwd || "选择工作目录"}><FolderOpen size={14} />{activeTask.repo}</button>
              <button className="repo-chip"><GitBranch size={14} />{activeTask.branch}</button>
            </div>
            <div className="header-actions">
              <SessionActions transport={transportRef.current} sessionId={activeTaskId} session={currentSession} project={currentProject} projects={projects} running={running} demo={!desktopMode}
                onRename={() => { setRenameSessionError(""); setRenameSessionTarget({ project: currentProject, session: currentSession }); }}
                onImported={(result) => { setProjects((current) => current.map((item) => item.id === result.project.id ? result.project : item)); setInput(""); setActiveView("conversation"); }}
                onArchive={() => archiveSession(currentProject.id, currentSession)} />
              {!reviewOpen && <button className="header-button panel-toggle" title="打开工作面板" aria-label="打开工作面板" aria-expanded={false} onClick={() => setReviewOpen(true)}><Columns size={17} /></button>}
            </div>
          </header>

          <div className="workspace-body">
          <section className="conversation">
            {(runtimeError || (desktopMode && runtime.connected && !runtime.authenticated)) && (
              <div className={`runtime-banner ${runtimeError ? "is-error" : ""}`}>
                <WarningCircle size={16} weight="fill" />
                <span>{runtimeError || "Agentx 已连接，但尚未配置模型凭据。请在管理 → 模型与服务中设置；工作区、会话和变更审查仍可使用。"}</span>
              </div>
            )}
            <div className="thread-viewport">
            <div className="thread" ref={threadScroll.threadRef} onScroll={threadScroll.onScroll}>
              <div className="thread-content" ref={threadScroll.contentRef}>
              {messages.length === 0 ? (
                <div className="empty-thread">
                  <div className="empty-icon"><Cpu size={28} /></div>
                  <h2>开始一个任务</h2>
                  <p>选择项目目录，然后告诉 Agentx 你想完成什么。</p>
                  <div className="suggestion-grid">
                    <button onClick={() => setInput("检查这个项目并说明它的结构")}>检查项目结构<CaretRight size={15} /></button>
                    <button onClick={() => setInput("运行测试并修复失败项")}>修复测试<CaretRight size={15} /></button>
                    <button onClick={() => setInput("审查最近的代码变更")}>审查变更<CaretRight size={15} /></button>
                  </div>
                </div>
              ) : messages.map((message) => (
                <Message key={message.id} message={message} onReview={() => openPreview()} onOpenFile={openPreview} />
              ))}
              {running && <div className="working-state"><CircleNotch size={15} className="spin" />Agentx 正在工作</div>}
              </div>
            </div>
            {threadScroll.awayFromBottom && <button className="thread-jump" type="button" onClick={threadScroll.jumpToBottom} title="回到最新消息" aria-label="回到最新消息"><ArrowDown size={16} />最新消息</button>}
            </div>

            <div className="composer-wrap">
              <QueuedInputs key={activeTaskId} entries={inputQueues[activeTaskId] || []} running={running || sendingInput} hasDraft={Boolean(input.trim() || attachments.length)} onResume={resumeQueuedInput} onRemove={removeQueuedInput} onBehavior={changeQueuedInputBehavior} />
              <div className={`composer ${running ? "is-running" : ""}`}>
                <AttachmentList attachments={attachments} onRemove={removeAttachment} pending />
                {attachmentError && <div className="attachment-error"><WarningCircle size={14} /><span>{attachmentError}</span></div>}
                <textarea
                  value={input}
                  onChange={(event) => setInput(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
                      event.preventDefault();
                      submit();
                    }
                  }}
                  placeholder={running ? "继续输入，发送后排队，可点击 Steer 补充当前任务" : "给 Agentx 一个任务"}
                  rows={2}
                />
                <div className="composer-toolbar">
                  <div className="composer-tools">
                    <button
                      type="button"
                      className="tool-button"
                      title={attachments.length >= 8 ? "每条消息最多添加 8 个附件" : "添加图片或文本附件"}
                      aria-label="添加图片或文本附件"
                      onClick={chooseAttachments}
                      disabled={attachmentPickerBusy || attachments.length >= 8}
                    >
                      {attachmentPickerBusy ? <CircleNotch size={17} className="spin" /> : <Paperclip size={17} />}
                    </button>
                    <button className="tool-button" title="选择工作目录" onClick={openWorkspace}><FolderOpen size={17} /></button>
                    <label className="select-control">
                      <Cpu size={15} />
                      <select
                        value={desktopMode ? modelValue(model) : (model?.id || "")}
                        onChange={(event) => desktopMode ? changeModel(event.target.value) : setModel({ provider: "demo", id: event.target.value, name: event.target.selectedOptions[0]?.textContent })}
                        disabled={desktopMode && availableModels.length === 0}
                      >
                        {desktopMode ? (
                          availableModels.length ? availableModels.map((item) => (
                            <option key={modelValue(item)} value={modelValue(item)}>{item.name || item.id} · {item.provider}</option>
                          )) : <option value="">未配置模型</option>
                        ) : (
                          <>
                            <option value="claude-sonnet-4-5">Claude Sonnet 4.5</option>
                            <option value="gpt-5.6-codex">GPT-5.6 Codex</option>
                            <option value="gemini-3-pro">Gemini 3 Pro</option>
                          </>
                        )}
                      </select>
                      <CaretDown size={12} />
                    </label>
                    <label className="select-control permission-control">
                      <ShieldCheck size={15} />
                      <select value={permission} onChange={(event) => changePermission(event.target.value)}>
                        <option>只读</option>
                        <option>执行前询问</option>
                        <option>完全访问</option>
                      </select>
                      <CaretDown size={12} />
                    </label>
                  </div>
                  <div className="composer-send-actions">
                    {running && <button className="send-button stop-button" onClick={() => transportRef.current?.abort(activeTaskId).catch((error) => setRuntimeError(error.message))} title="停止任务" aria-label="停止任务"><Stop size={16} weight="fill" /></button>}
                    <button className="send-button" onClick={submit} disabled={sendingInput || (!input.trim() && attachments.length === 0) || hasUnsupportedImage} title={running ? "排队发送" : "发送"} aria-label={running ? "排队发送" : "发送"}>{sendingInput ? <CircleNotch size={17} className="spin" /> : <ArrowUp size={17} weight="bold" />}</button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          </div>
          <WorkPanel key={activeTaskId} sessionId={activeTaskId} stateCache={panelStateCache.current} open={reviewOpen} visible={activeView === "conversation"} cwd={activeTask.cwd} changeCount={changeSnapshot?.files?.length ?? (desktopMode ? 0 : 6)} onClose={() => setReviewOpen(false)} request={previewRequest} MarkdownContent={MarkdownContent} renderDiff={(onOpenFile) => <ReviewPanel snapshot={changeSnapshot} onRefresh={refreshChanges} onOpenFile={onOpenFile} />} />
        </div>
      </main>

      <ApprovalDialog approval={approval} onDecision={decideApproval} />
      <ProjectCreateDialog
        open={createProjectOpen}
        onClose={() => setCreateProjectOpen(false)}
        onChooseFolder={() => transportRef.current?.chooseProjectFolder?.()}
        onCreate={createProjectFromForm}
        busy={createProjectBusy}
        error={createProjectError}
        defaultProjectRoot={desktopSettings?.defaultProjectRoot}
      />
      <SessionRenameDialog
        target={renameSessionTarget}
        onClose={() => setRenameSessionTarget(null)}
        onSave={saveSidebarSessionRename}
        busy={renameSessionBusy}
        error={renameSessionError}
      />
      <CurrentProjectDialog
        open={projectDialogOpen}
        projects={projects.filter((item) => !item.removed)}
        activeProjectId={activeProjectId}
        sessions={projectSessions}
        availableModels={availableModels}
        toolCatalog={toolCatalog}
        globalToolIds={desktopSettings?.tools?.enabled || toolCatalog.map((tool) => tool.id)}
        onClose={() => setProjectDialogOpen(false)}
        onUpdate={updateProject}
        onRelink={relinkProject}
        onOpenTarget={openProjectTarget}
        onGitStatus={readGitStatus}
        onOpenSession={openSession}
        onNewSession={newSession}
        onRenameSession={renameSession}
        onArchiveSession={(projectId, session) => archiveSession(projectId, session).catch(() => {})}
        onRestoreSession={restoreSession}
        onDeleteDirectory={deleteProjectDirectory}
      />
    </div>
  );
}
