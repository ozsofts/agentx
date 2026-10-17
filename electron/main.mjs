import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from "electron";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ProjectStore } from "./project-store.mjs";
import { ATTACHMENT_DIALOG_EXTENSIONS, loadAttachments } from "./attachment-service.mjs";
import { DEFAULT_TOOL_IDS, TOOL_CATALOG, resolveEffectiveToolIds, runtimeToolNames } from "./tool-registry.mjs";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const isDevelopment = process.argv.includes("--dev");

let mainWindow;
let agentHost;
let requestSequence = 0;
const pendingRequests = new Map();
const execFileAsync = promisify(execFile);
let projectStore;

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
  if (agentHost) return agentHost;

  agentHost = utilityProcess.fork(path.join(appDir, "agent-host.mjs"), [], {
    serviceName: "Pi Agent Host",
    stdio: "pipe",
  });

  agentHost.stdout?.on("data", (chunk) => console.log(`[agent-host] ${chunk}`.trimEnd()));
  agentHost.stderr?.on("data", (chunk) => console.error(`[agent-host] ${chunk}`.trimEnd()));
  agentHost.on("message", (message) => {
    if (message?.kind === "event") {
      mainWindow?.webContents.send("agent:event", message.event);
      return;
    }

    if (message?.kind === "response") {
      const pending = pendingRequests.get(message.requestId);
      if (!pending) return;
      pendingRequests.delete(message.requestId);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || "Agent Host request failed"));
    }
  });
  agentHost.on("exit", (code) => {
    agentHost = undefined;
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error(`Agent Host exited with code ${code}`));
    }
    pendingRequests.clear();
    mainWindow?.webContents.send("agent:event", {
      type: "runtime.error",
      message: `Agent Host 已退出（code ${code}）`,
      timestamp: Date.now(),
    });
  });

  return agentHost;
}

function commandHost(command) {
  const host = startAgentHost();
  const requestId = `host-${++requestSequence}`;
  return new Promise((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    host.postMessage({ kind: "command", requestId, command });
  });
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
    lastSessionId: result.sessionId,
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
  const project = projectId ? await projectStore?.get(projectId) : null;
  const desktopSettings = await readDesktopSettings();
  const effectiveToolIds = resolveEffectiveToolIds(desktopSettings.tools, project?.settings?.tools);
  const result = await commandHost({
    type: "initialize",
    cwd,
    projectId,
    permissionMode: project?.settings?.permissionMode || desktopSettings.defaultPermissionMode,
    modelValue: project?.settings?.model || desktopSettings.defaultModel,
    toolIds: effectiveToolIds,
    tools: runtimeToolNames(effectiveToolIds),
    sessionFile: sessionFile && existsSync(sessionFile) ? sessionFile : undefined,
  });
  await writeState({ cwd, sessionFile: result.sessionFile, projectId: projectId || null, updatedAt: Date.now() });
  const updatedProject = await syncProjectWorkspace(projectId, result);
  if (updatedProject) await reconcileProjectSessions(updatedProject);
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
      title: "选择 Pi 工作目录",
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
  });

  ipcMain.handle("skills:choose-folder", async () => {
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: "选择包含 SKILL.md 的文件夹",
      properties: ["openDirectory"],
    });
    if (selection.canceled || !selection.filePaths[0]) return null;
    return selection.filePaths[0];
  });

  ipcMain.handle("agent:command", async (_event, command) => {
    const result = await commandHost(command);
    if (command?.type === "prompt" && result?.sessionFile) {
      const state = await readState();
      if (state?.cwd) {
        await writeState({ ...state, sessionFile: result.sessionFile, updatedAt: Date.now() });
        await syncProjectWorkspace(state.projectId, { ...result, cwd: state.cwd });
      }
    }
    return result;
  });
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 680,
    title: "Pi Agent Desktop",
    backgroundColor: "#f6f6f4",
    webPreferences: {
      preload: path.join(appDir, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

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
  projectStore = new ProjectStore(app.getPath("userData"));
  registerIpc();
  startAgentHost();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (agentHost) {
    agentHost.postMessage({ kind: "command", requestId: `host-${++requestSequence}`, command: { type: "dispose" } });
    agentHost.kill();
  }
});
