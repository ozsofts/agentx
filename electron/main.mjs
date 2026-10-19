import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProjectStore } from "./project-store.mjs";
import { ATTACHMENT_DIALOG_EXTENSIONS, loadAttachments } from "./attachment-service.mjs";
import { DEFAULT_TOOL_IDS, TOOL_CATALOG, resolveEffectiveToolIds, runtimeToolNames } from "./tool-registry.mjs";
import { PREVIEW_EXTENSIONS, PreviewService } from "./preview-service.mjs";
import { readSessionImport } from "./session-transfer.mjs";
import { BrowserService } from "./browser-service.mjs";

protocol.registerSchemesAsPrivileged([{ scheme: "pi-preview", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const previews = new PreviewService((event) => mainWindow?.webContents.send("preview:changed", event));

const appDir = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = process.argv.includes("--dev");

// Brand the app without moving existing Desktop settings or project indexes.
const currentUserData = app.getPath("userData");
const legacyUserData = app.isPackaged
  ? [currentUserData, ...["Pi Agent Desktop", "pi-desktop-prototype"].map((name) => path.join(app.getPath("appData"), name))]
    .find((directory) => ["projects.json", "desktop-settings.json", "workspace-state.json"].some((file) => existsSync(path.join(directory, file))))
  : null;
app.setName("Agentx");
app.setPath("userData", legacyUserData || currentUserData);

let mainWindow;
let browserService;
let agentHost;
const agentHosts = new Set();
const sessionRuntimeSettings = new Map();
let projectSync = Promise.resolve();
let requestSequence = 0;
const pendingRequests = new Map();
const execFileAsync = promisify(execFile);
let projectStore;
let sessionOperation = false;
const sessionImports = new Map();

function statePath() {
  return path.join(app.getPath("userData"), "workspace-state.json");
}

function desktopSettingsPath() {
  return path.join(app.getPath("userData"), "desktop-settings.json");
}

function defaultDesktopSettings() {
  return {
    version: 1,
    defaultProjectRoot: app.getPath("home"),
    reopenLastWorkspace: true,
    defaultPermissionMode: "ask",
    defaultModel: null,
    tools: {
      enabled: [...DEFAULT_TOOL_IDS],
    },
    skills: {
      autoReload: true,
      allowLocalImport: true,
    },
  };
}

async function readDesktopSettings() {
  const defaults = defaultDesktopSettings();
  try {
    const parsed = JSON.parse(await readFile(desktopSettingsPath(), "utf8"));
    return {
      ...defaults,
      ...parsed,
      skills: { ...defaults.skills, ...(parsed.skills || {}) },
      tools: { ...defaults.tools, ...(parsed.tools || {}) },
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaults;
    throw error;
  }
}

async function writeDesktopSettings(patch = {}) {
  const current = await readDesktopSettings();
  const next = {
    ...current,
    ...patch,
    skills: { ...current.skills, ...(patch.skills || {}) },
    tools: { ...current.tools, ...(patch.tools || {}) },
    version: 1,
  };
  await mkdir(path.dirname(desktopSettingsPath()), { recursive: true });
  await writeFile(desktopSettingsPath(), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

async function readState() {
  try {
    return JSON.parse(await readFile(statePath(), "utf8"));
  } catch {
    return null;
  }
}

async function writeState(state) {
  await mkdir(path.dirname(statePath()), { recursive: true });
  await writeFile(statePath(), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function startAgentHost() {
  const process = utilityProcess.fork(path.join(appDir, "agent-host.mjs"), [], {
    serviceName: "Agentx Host",
    stdio: "pipe",
  });

  const host = { process, workspace: null, running: false };
  agentHosts.add(host);
  process.stdout?.on("data", (chunk) => console.log(`[agent-host] ${chunk}`.trimEnd()));
  process.stderr?.on("data", (chunk) => console.error(`[agent-host] ${chunk}`.trimEnd()));
  process.on("message", (message) => {
    if (message?.kind === "event") {
      const event = { ...message.event, sessionId: message.event.sessionId || host.workspace?.sessionId };
      if (event.type === "workspace.connected") { host.workspace = event; return; }
      if (event.type === "run.started") host.running = true;
      if (event.type === "run.settled") host.running = false;
      if (event.type === "models.updated" && host.workspace) host.workspace.model = event.model;
      if (event.type === "session.updated") {
        host.workspace = { ...host.workspace, sessionFile: event.sessionFile };
        projectSync = projectSync.then(async () => {
          await syncProjectWorkspace(host.workspace.projectId, event);
          const state = await readState();
          if (state?.sessionId === event.sessionId) await writeState({ ...state, sessionFile: event.sessionFile, updatedAt: Date.now() });
          mainWindow?.webContents.send("agent:event", { type: "projects.updated", projects: await projectStore.list() });
        }).catch((error) => mainWindow?.webContents.send("agent:event", { type: "runtime.error", sessionId: event.sessionId, message: `无法登记会话：${error.message}` }));
      }
      if (event.sessionId || host === agentHost) mainWindow?.webContents.send("agent:event", event);
      return;
    }

    if (message?.kind === "response") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      if (message.ok && pending.command.type === "setPermissionMode" && host.workspace) host.workspace.permissionMode = message.result.mode;
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Agent Host request failed"));
    }
  });
  process.on("exit", (code) => {
    agentHosts.delete(host);
    if (agentHost === host) agentHost = undefined;
    for (const [requestId, pending] of pendingRequests) {
      if (pending.host !== host) continue;
      pending.reject(new Error(`Agent Host exited with code ${code}`));
      pendingRequests.delete(requestId);
    }
    if (host.closing) return;
    mainWindow?.webContents.send("agent:event", {
      type: "runtime.error",
      sessionId: host.workspace?.sessionId,
      message: `Agent Host 已退出（code ${code}）`,
      timestamp: Date.now(),
    });
    if (host.running) mainWindow?.webContents.send("agent:event", { type: "run.settled", sessionId: host.workspace?.sessionId, status: "error" });
  });

  return host;
}

function commandHost(command, target) {
  const host = target || (command.sessionId && [...agentHosts].find((item) => item.workspace?.sessionId === command.sessionId)) || agentHost || (agentHost = startAgentHost());
  if (command.sessionId && host.workspace?.sessionId !== command.sessionId && command.type !== "renameSession") return Promise.reject(new Error("会话已切换或未加载，请重新打开后重试"));
  const requestId = `host-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject, host, command });
    host.process.postMessage({ kind: "command", requestId, command });
  });
}

// Only foreground and busy sessions need live runtimes. Keep lightweight
// overrides for reopening idle sessions, rather than retaining a process per tab.
function releaseIdleHosts() {
  for (const host of agentHosts) {
    if (host === agentHost || host.running || !host.workspace || [...pendingRequests.values()].some((item) => item.host === host)) continue;
    const { sessionFile, permissionMode, model } = host.workspace;
    if (sessionFile) sessionRuntimeSettings.set(sessionFile, { permissionMode, modelValue: model ? `${model.provider}::${model.id}` : null });
    host.closing = true;
    agentHosts.delete(host);
    host.process.kill();
  }
}

async function syncProjectWorkspace(projectId, result) {
  if (!projectId || !projectStore || !result?.sessionId) return null;
  const project = await projectStore.get(projectId);
  if (!project) return null;
  const existing = project.sessions.find((item) => item.sessionId === result.sessionId);
  const hasUserMessage = Array.isArray(result.messages) && result.messages.some((message) => message.role === "user");
  if (!existing && !hasUserMessage) return project;
  const now = new Date().toISOString();
  const firstMessage = result.messages?.find((message) => message.role === "user")?.text?.slice(0, 48);
  const sessions = existing
    ? project.sessions.map((item) => item.sessionId === result.sessionId
      ? { ...item, title: item.title === "新建会话" && firstMessage ? firstMessage : item.title, sessionFile: result.sessionFile, lastOpenedAt: now, archived: false }
      : item)
    : [{
      sessionId: result.sessionId,
      title: firstMessage || "新建会话",
      sessionFile: result.sessionFile,
      createdAt: now,
      lastOpenedAt: now,
      archived: false,
    }, ...project.sessions];
  const updated = await projectStore.update(projectId, {
    rootPath: result.cwd,
    lastOpenedAt: now,
    lastSessionId: agentHost?.workspace?.sessionId === result.sessionId ? result.sessionId : project.lastSessionId,
    sessions,
  });
  await projectStore.syncManifest(updated);
  return updated;
}

async function reconcileProjectSessions(project) {
  if (!project?.id || !existsSync(project.rootPath)) return project;
  const result = await commandHost({ type: "listSessions", cwd: project.rootPath, projectId: project.id });
  const updated = await projectStore.reconcileSessions(project.id, result?.sessions || []);
  await projectStore.syncManifest(updated);
  return updated;
}

function resolveProjectSessionFile(project, requestedSessionId) {
  const sessionId = requestedSessionId || project?.lastSessionId;
  const session = project?.sessions.find((item) => item.sessionId === sessionId && !item.archived)
    || (!requestedSessionId ? project?.sessions.find((item) => !item.archived) : null);
  return session?.sessionFile && existsSync(session.sessionFile) ? session.sessionFile : undefined;
}

async function initializeWorkspace(cwd, sessionFile, projectId) {
  await projectSync;
  const project = projectId ? await projectStore?.get(projectId) : null;
  const desktopSettings = await readDesktopSettings();
  const effectiveToolIds = resolveEffectiveToolIds(desktopSettings.tools, project?.settings?.tools);
  const rememberedSettings = sessionFile ? sessionRuntimeSettings.get(sessionFile) : null;
  const existing = sessionFile && [...agentHosts].find((item) => item.workspace?.sessionFile === sessionFile && item.workspace?.cwd === path.resolve(cwd));
  const host = existing || (!agentHost?.workspace ? agentHost : null) || startAgentHost();
  const result = existing ? await commandHost({ type: "getWorkspace" }, host) : await commandHost({
    type: "initialize",
    cwd,
    projectId,
    permissionMode: rememberedSettings?.permissionMode || project?.settings?.permissionMode || desktopSettings.defaultPermissionMode,
    modelValue: rememberedSettings?.modelValue || project?.settings?.model || desktopSettings.defaultModel,
    toolIds: effectiveToolIds,
    tools: runtimeToolNames(effectiveToolIds),
    sessionFile: sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
  }, host);
  agentHost = host;
  host.workspace = { ...result, projectId: projectId || null };
  await writeState({ cwd, sessionId: result.sessionId, sessionFile: result.sessionFile, projectId: projectId || null, updatedAt: Date.now() });
  await previews.setWorkspace(cwd);
  mainWindow?.webContents.send("agent:event", { type: "workspace.connected", ...result });
  const updatedProject = await syncProjectWorkspace(projectId, result);
  if (updatedProject) await reconcileProjectSessions(updatedProject);
  releaseIdleHosts();
  return result;
}

async function chooseProjectFolder(title = "选择项目目录") {
  const selection = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openDirectory", "createDirectory"],
  });
  return selection.canceled || !selection.filePaths[0] ? null : selection.filePaths[0];
}

async function getGitStatus(rootPath) {
  try {
    const branchResult = await execFileAsync("git", ["branch", "--show-current"], { cwd: rootPath });
    const statusResult = await execFileAsync("git", ["status", "--short"], { cwd: rootPath });
    const changedFiles = statusResult.stdout.trim() ? statusResult.stdout.trim().split("\n") : [];
    return { isGit: true, branch: branchResult.stdout.trim() || "detached", changedFiles, clean: changedFiles.length === 0 };
  } catch {
    return { isGit: false, branch: null, changedFiles: [], clean: true };
  }
}

async function openProjectTarget(rootPath, target) {
  if (target === "terminal") {
    if (process.platform === "darwin") return execFileAsync("open", ["-a", "Terminal", rootPath]);
    if (process.platform === "win32") return execFileAsync("cmd.exe", ["/c", "start", "", rootPath]);
    return execFileAsync("x-terminal-emulator", ["--working-directory", rootPath]);
  }
  return shell.openPath(rootPath);
}

function registerIpc() {
  ipcMain.handle("browser:command", (event, command) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error("不允许此页面访问浏览器操作。");
    return browserService?.command(command);
  });
  ipcMain.handle("preview:command", async (_event, command = {}) => {
    if (!previews.root) {
      const state = await readState();
      if (state?.cwd) await previews.setWorkspace(state.cwd);
    }
    if (command.type === "read") return previews.read(command.path, command.base);
    if (command.type === "close") { previews.close(command.path); return null; }
    if (command.type === "choose") {
      if (!previews.root) throw new Error("请先打开项目，再选择预览文件。");
      const result = await dialog.showOpenDialog(mainWindow, { title: "预览文件", defaultPath: command.defaultPath || previews.root, properties: ["openFile", "multiSelections"], filters: [{ name: "可预览的文件", extensions: PREVIEW_EXTENSIONS }] });
      if (result.canceled) return [];
      // Picking a file in the native dialog is the user's explicit grant.
      return Promise.all(result.filePaths.map((file) => previews.authorize(file)));
    }
    if (command.type === "authorize-folder") {
      if (!previews.root) throw new Error("请先打开项目，再选择预览文件。");
      const selection = await dialog.showOpenDialog(mainWindow, { title: "授权项目外文件夹", defaultPath: command.defaultPath || previews.root, properties: ["openDirectory"] });
      if (selection.canceled || !selection.filePaths[0]) return null;
      const granted = await previews.authorizeDirectory(selection.filePaths[0]);
      const files = await dialog.showOpenDialog(mainWindow, { title: "打开已授权文件夹中的预览文件", defaultPath: granted, properties: ["openFile", "multiSelections"], filters: [{ name: "可预览的文件", extensions: PREVIEW_EXTENSIONS }] });
      if (files.canceled) return { granted, opened: [] };
      return { granted, opened: await Promise.all(files.filePaths.map((file) => previews.authorize(file))) };
    }
    if (command.type === "revoke") return { revoked: previews.revoke(command.base) };
    if (command.type === "grants") return previews.grantsList();
    throw new Error("未知预览操作。");
  });
  ipcMain.handle("desktop-settings:read", () => readDesktopSettings());
  ipcMain.handle("desktop-settings:write", (_event, patch = {}) => writeDesktopSettings(patch));
  ipcMain.handle("tools:list", () => ({ tools: TOOL_CATALOG }));

  ipcMain.handle("attachments:choose", async (_event, options = {}) => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "添加附件",
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "图片与文本文件", extensions: ATTACHMENT_DIALOG_EXTENSIONS },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (selection.canceled) return { attachments: [], rejected: [] };
    return loadAttachments(selection.filePaths, { maxFiles: options.maxFiles });
  });

  ipcMain.handle("workspace:open", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "选择 Agentx 工作目录",
      properties: ["openDirectory", "createDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    let project = await projectStore.ensure(selection.filePaths[0]);
    project = await reconcileProjectSessions(project);
    await projectStore.syncManifest(project);
    return initializeWorkspace(project.rootPath, resolveProjectSessionFile(project), project.id);
  });

  ipcMain.handle("workspace:restore", async () => {
    const desktopSettings = await readDesktopSettings();
    if (desktopSettings.reopenLastWorkspace === false) return null;
    const state = await readState();
    if (!state?.cwd) return null;
    const project = state.projectId ? await projectStore.get(state.projectId) : await projectStore.ensure(state.cwd);
    const rootPath = project?.rootPath || state.cwd;
    if (!existsSync(rootPath)) return null;
    if (!project) return initializeWorkspace(rootPath, state.sessionFile);
    const reconciled = await reconcileProjectSessions(project);
    const sessionFile = state.sessionFile && existsSync(state.sessionFile)
      ? state.sessionFile
      : resolveProjectSessionFile(reconciled);
    return initializeWorkspace(reconciled.rootPath, sessionFile, reconciled.id);
  });

  ipcMain.handle("projects:list", () => projectStore.list());

  ipcMain.handle("projects:choose-folder", () => chooseProjectFolder());

  ipcMain.handle("projects:open-folder", async () => {
    const rootPath = await chooseProjectFolder("打开已有项目");
    if (!rootPath) return null;
    let project = await projectStore.ensure(rootPath);
    project = await reconcileProjectSessions(project);
    await projectStore.syncManifest(project);
    const workspace = await initializeWorkspace(project.rootPath, resolveProjectSessionFile(project), project.id);
    return { project: await projectStore.get(project.id), workspace };
  });

  ipcMain.handle("projects:command", async (_event, command = {}) => {
    const locksSession = ["open", "new-session", "open-session", "rename-session", "archive-session", "relink", "delete-directory"].includes(command.type);
    if (locksSession) {
      if (sessionOperation) throw new Error("会话操作进行中，请稍后重试");
      sessionOperation = true;
    }
    try {
    await projectSync;
    if (["relink", "delete-directory"].includes(command.type) && [...agentHosts].some((host) => host.workspace?.projectId === command.projectId && host.running)) {
      throw new Error("此项目仍有会话正在运行，请先停止任务");
    }
    if (locksSession && !["open", "new-session", "open-session"].includes(command.type)) {
      const target = command.sessionId && [...agentHosts].find((host) => host.workspace?.sessionId === command.sessionId);
      if (!command.sessionId || target) await commandHost({ type: "assertSessionIdle" }, target || agentHost);
    }
    if (command.type === "create") {
      if (!command.rootPath) throw new Error("项目目录不能为空");
      await mkdir(command.rootPath, { recursive: true });
      const project = await projectStore.ensure(command.rootPath, command.name);
      const desktopSettings = await readDesktopSettings();
      const updated = command.name?.trim() && project.name !== command.name.trim()
        ? await projectStore.update(project.id, { name: command.name.trim(), removed: false, archived: false, settings: { model: project.settings.model || desktopSettings.defaultModel, permissionMode: project.settings.permissionMode || desktopSettings.defaultPermissionMode } })
        : await projectStore.update(project.id, { removed: false, archived: false, settings: { model: project.settings.model || desktopSettings.defaultModel, permissionMode: project.settings.permissionMode || desktopSettings.defaultPermissionMode } });
      await projectStore.syncManifest(updated);
      return { project: updated };
    }
    if (command.type === "open") {
      let project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      if (!existsSync(project.rootPath)) return { project, pathExists: false };
      project = await reconcileProjectSessions(project);
      const workspace = await initializeWorkspace(project.rootPath, resolveProjectSessionFile(project, command.sessionId), project.id);
      return { project: await projectStore.get(project.id), workspace };
    }
    if (command.type === "new-session") {
      const project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      const workspace = await initializeWorkspace(project.rootPath, undefined, project.id);
      return { project: await projectStore.get(project.id), workspace };
    }
    if (command.type === "open-session") {
      const project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      const workspace = await initializeWorkspace(project.rootPath, command.sessionFile, project.id);
      return { project: await projectStore.get(project.id), workspace };
    }
    if (command.type === "update") {
      const updated = await projectStore.update(command.projectId, command.patch || {});
      await projectStore.syncManifest(updated);
      return updated;
    }
    if (command.type === "relink") {
      const rootPath = await chooseProjectFolder("重新关联项目目录");
      if (!rootPath) return null;
      let updated = await projectStore.update(command.projectId, { rootPath, removed: false, archived: false });
      updated = await reconcileProjectSessions(updated);
      await projectStore.syncManifest(updated);
      const workspace = await initializeWorkspace(updated.rootPath, resolveProjectSessionFile(updated), updated.id);
      return { project: await projectStore.get(updated.id), workspace };
    }
    if (command.type === "open-target") {
      const project = await projectStore.get(command.projectId);
      if (!project || !existsSync(project.rootPath)) throw new Error("项目目录不存在");
      await openProjectTarget(project.rootPath, command.target);
      return { opened: true };
    }
    if (command.type === "git-status") {
      const project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      return getGitStatus(project.rootPath);
    }
    if (command.type === "delete-directory") {
      if (command.confirmed !== true) throw new Error("删除项目目录需要明确确认");
      const project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      if (existsSync(project.rootPath)) await shell.trashItem(project.rootPath);
      const updated = await projectStore.update(project.id, { removed: true, archived: true });
      return updated;
    }
    if (command.type === "archive-session") {
      const updated = await projectStore.updateSession(command.projectId, command.sessionId, { archived: true });
      await projectStore.syncManifest(updated);
      const state = await readState();
      if (state?.projectId === command.projectId && updated.sessions.find((item) => item.sessionId === command.sessionId)?.sessionFile === state.sessionFile) {
        await initializeWorkspace(updated.rootPath, undefined, updated.id);
      }
      return updated;
    }
    if (command.type === "rename-session") {
      const project = await projectStore.get(command.projectId);
      if (!project) throw new Error("找不到项目");
      const result = await commandHost({
        type: "renameSession",
        cwd: project.rootPath,
        projectId: project.id,
        sessionId: command.sessionId,
        sessionFile: command.sessionFile,
        name: command.name,
      });
      const sessions = project.sessions.map((item) => item.sessionId === command.sessionId ? { ...item, title: command.name } : item);
      const updated = await projectStore.update(project.id, { sessions });
      await projectStore.syncManifest(updated);
      return { project: updated, sessions: result.sessions };
    }
    if (command.type === "restore-session") {
      const updated = await projectStore.updateSession(command.projectId, command.sessionId, { archived: false });
      await projectStore.syncManifest(updated);
      return updated;
    }
    throw new Error(`Unknown project command: ${command.type}`);
    } finally { if (locksSession) sessionOperation = false; }
  });

  ipcMain.handle("skills:choose-folder", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "选择包含 SKILL.md 的文件夹",
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return selection.filePaths[0];
  });

  ipcMain.handle("sessions:command", async (_event, command = {}) => {
    if (command.type === "cancel-import") { sessionImports.delete(command.token); return { canceled: true }; }
    if (command.type === "info") return commandHost({ type: "sessionInfo", sessionId: command.sessionId });
    if (sessionOperation) throw new Error("会话操作进行中，请稍后重试");
    sessionOperation = true;
    try {
      await commandHost({ type: "assertSessionIdle" });
      if (command.type === "choose-import") {
        const selection = await dialog.showOpenDialog(mainWindow, { title: "导入 Agentx 会话", properties: ["openFile"], filters: [{ name: "JSONL 会话", extensions: ["jsonl"] }] });
        if (selection.canceled || !selection.filePaths[0]) return null;
        const { content, ...summary } = await readSessionImport(selection.filePaths[0]);
        sessionImports.clear();
        const token = randomUUID();
        sessionImports.set(token, { content, expiresAt: Date.now() + 10 * 60_000 });
        return { ...summary, token, fileName: path.basename(selection.filePaths[0]) };
      }
      const project = await projectStore.get(command.projectId);
      if (!project || project.removed || project.archived || !existsSync(project.rootPath)) throw new Error("请选择有效的项目目录");
      if (command.type === "import") {
        const source = sessionImports.get(command.token);
        if (!source || source.expiresAt < Date.now()) throw new Error("文件选择已过期，请重新选择 JSONL 文件");
        const imported = await commandHost({ type: "importSession", content: source.content, cwd: project.rootPath });
        sessionImports.delete(command.token);
        const now = new Date().toISOString();
        const updated = await projectStore.update(project.id, { sessions: [{ ...imported, createdAt: now, lastOpenedAt: now, archived: false }, ...project.sessions] });
        await projectStore.syncManifest(updated);
        const workspace = await initializeWorkspace(project.rootPath, imported.sessionFile, project.id);
        return { project: await projectStore.get(project.id), workspace };
      }
      if (command.type === "export") {
        if (!["html", "jsonl"].includes(command.format)) throw new Error("不支持的导出格式");
        const target = project.sessions.find((item) => item.sessionId === command.sessionId);
        if (!target?.sessionFile || !existsSync(target.sessionFile)) throw new Error("会话尚未保存或记录已不存在");
        const info = await commandHost({ type: "sessionInfo", sessionId: command.sessionId });
        if (info.sessionFile !== target.sessionFile) throw new Error("当前会话已切换，请重试");
        const name = target.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").slice(0, 80) || "session";
        const selection = await dialog.showSaveDialog(mainWindow, { title: "导出会话", defaultPath: `${name}.${command.format}`, filters: [{ name: command.format === "html" ? "HTML 阅读副本" : "Pi JSONL 备份", extensions: [command.format] }] });
        if (selection.canceled || !selection.filePath) return null;
        const outputPath = selection.filePath;
        if (path.extname(outputPath).toLowerCase() !== `.${command.format}`) throw new Error(`导出文件需要使用 .${command.format} 扩展名`);
        const sourceDirectory = await realpath(path.dirname(target.sessionFile));
        const outputDirectory = await realpath(path.dirname(outputPath));
        const outputFile = await realpath(outputPath).catch(() => null);
        if (sourceDirectory === outputDirectory || outputFile === await realpath(target.sessionFile)) throw new Error("请将备份保存到会话存储目录以外的位置");
        await commandHost({ type: "assertSessionIdle" });
        if (command.format === "jsonl") await writeFile(outputPath, await readFile(target.sessionFile));
        else {
          const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-session-export-"));
          try {
            const htmlPath = path.join(temporary, "session.html");
            await commandHost({ type: "exportSession", sessionId: command.sessionId, format: "html", outputPath: htmlPath });
            await writeFile(outputPath, await readFile(htmlPath));
          } finally { await rm(temporary, { recursive: true, force: true }); }
        }
        return { exported: true, filePath: outputPath };
      }
      throw new Error("未知会话操作");
    } finally { sessionOperation = false; }
  });

  ipcMain.handle("agent:command", async (_event, command) => {
    if (sessionOperation && command?.type === "prompt") throw new Error("会话操作进行中，请稍后发送消息");
    const target = (command?.sessionId && [...agentHosts].find((item) => item.workspace?.sessionId === command.sessionId)) || agentHost;
    const result = await commandHost(command);
    if (command?.type === "prompt" && result?.sessionFile) {
      await projectSync;
      if (target?.workspace) {
        const workspace = target.workspace;
        const synced = projectSync.then(() => syncProjectWorkspace(workspace.projectId, { ...result, cwd: workspace.cwd }));
        projectSync = synced.catch(() => {});
        await synced;
        mainWindow?.webContents.send("agent:event", { type: "projects.updated", projects: await projectStore.list() });
      }
    }
    releaseIdleHosts();
    return result;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 680,
    title: "Agentx",
    backgroundColor: "#f6f6f4",
    webPreferences: {
      preload: path.join(appDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  browserService = new BrowserService(mainWindow);

  if (isDevelopment) {
    await mainWindow.loadURL(process.env.PI_DESKTOP_RENDERER_URL || "http://127.0.0.1:4174");
  } else {
    await mainWindow.loadFile(path.join(appDir, "..", "dist", "index.html"));
  }

  const testWorkspace = isDevelopment ? process.env.PI_DESKTOP_TEST_WORKSPACE : undefined;
  if (testWorkspace && existsSync(testWorkspace)) {
    const workspace = await initializeWorkspace(testWorkspace);
    const changes = await commandHost({ type: "getChanges" });
    const skillCatalog = await commandHost({ type: "listSkills" });
    console.log(`[desktop-smoke] session=${workspace.sessionId} authenticated=${workspace.authenticated} changes=${changes.files.length} skills=${skillCatalog.skills.length}`);
    if (process.env.PI_DESKTOP_TEST_SKILLS === "1") {
      const installed = await commandHost({ type: "installSkill", catalogId: "project-overview", skillName: "project-overview" });
      const installedSkill = installed.skills.find((skill) => skill.name === "project-overview");
      const removed = await commandHost({ type: "removeSkill", name: "project-overview" });
      const removedSkill = removed.skills.find((skill) => skill.name === "project-overview");
      console.log(`[desktop-smoke] skill-install=${installedSkill?.installed === true} skill-remove=${removedSkill?.installed === false}`);
    }
    if (process.env.PI_DESKTOP_TEST_PROMPT) {
      try {
        await commandHost({ type: "prompt", text: process.env.PI_DESKTOP_TEST_PROMPT });
      } catch (error) {
        console.log(`[desktop-smoke] prompt-error=${error.message}`);
      }
    }
  }
}

app.whenReady().then(async () => {
  app.setAboutPanelOptions({ applicationName: "Agentx", applicationVersion: app.getVersion() });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ label: "Agentx", submenu: [
      { role: "about", label: "关于 Agentx" }, { type: "separator" }, { role: "services" },
      { type: "separator" }, { role: "hide", label: "隐藏 Agentx" }, { role: "hideOthers" }, { role: "unhide" },
      { type: "separator" }, { role: "quit", label: "退出 Agentx" },
    ] }, { role: "fileMenu" }] : [{ label: "文件", submenu: [{ role: "quit", label: "退出 Agentx" }] }]),
    { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" },
  ]));
  protocol.handle("pi-preview", (request) => previews.resource(request.url));
  projectStore = new ProjectStore(app.getPath("userData"));
  registerIpc();
  agentHost = startAgentHost();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  browserService?.dispose();
  previews.dispose();
  for (const host of agentHosts) {
    host.process.postMessage({ kind: "command", requestId: `host-${++requestSequence}`, command: { type: "dispose" } });
    host.process.kill();
  }
});
