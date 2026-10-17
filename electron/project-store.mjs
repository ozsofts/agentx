import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const emptyStore = () => ({ version: 1, projects: [] });

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function normalizeProject(project) {
  return {
    id: project.id,
    name: project.name || path.basename(project.rootPath) || "未命名项目",
    rootPath: project.rootPath,
    createdAt: project.createdAt || new Date().toISOString(),
    updatedAt: project.updatedAt || project.createdAt || new Date().toISOString(),
    lastOpenedAt: project.lastOpenedAt || null,
    lastSessionId: project.lastSessionId || null,
    pinned: Boolean(project.pinned),
    archived: Boolean(project.archived),
    removed: Boolean(project.removed),
    sessions: Array.isArray(project.sessions) ? project.sessions.map((session) => ({
      sessionId: session.sessionId,
      title: session.title || "未命名会话",
      sessionFile: session.sessionFile || "",
      createdAt: session.createdAt || null,
      lastOpenedAt: session.lastOpenedAt || null,
      messageCount: Number.isFinite(session.messageCount) ? session.messageCount : null,
      firstMessage: session.firstMessage || "",
      archived: Boolean(session.archived),
    })).filter((session) => Boolean(session.sessionId)) : [],
    settings: {
      model: project.settings?.model || null,
      permissionMode: project.settings?.permissionMode || "ask",
      tools: project.settings?.tools?.mode === "custom"
        ? { mode: "custom", enabled: Array.isArray(project.settings.tools.enabled) ? project.settings.tools.enabled : [] }
        : { mode: "inherit", enabled: [] },
    },
  };
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeSessions(indexedSessions = [], discoveredSessions = []) {
  const discoveredById = new Map(discoveredSessions.map((session) => [session.sessionId, session]));
  const merged = indexedSessions.map((session) => {
    const discovered = discoveredById.get(session.sessionId);
    if (!discovered) return session;
    discoveredById.delete(session.sessionId);
    return {
      ...session,
      sessionFile: discovered.sessionFile || session.sessionFile,
      createdAt: session.createdAt || discovered.createdAt || null,
      lastOpenedAt: discovered.lastOpenedAt || session.lastOpenedAt || null,
      messageCount: Number.isFinite(discovered.messageCount) ? discovered.messageCount : session.messageCount,
      firstMessage: discovered.firstMessage || session.firstMessage || "",
      title: session.title || discovered.title || "未命名会话",
    };
  });

  for (const session of discoveredById.values()) {
    const hasMessages = (Number.isFinite(session.messageCount) && session.messageCount > 0) || Boolean(session.firstMessage);
    if (hasMessages) merged.push({ ...session, archived: false });
  }

  return merged.sort((left, right) => {
    const leftTime = timestamp(left.lastOpenedAt || left.createdAt);
    const rightTime = timestamp(right.lastOpenedAt || right.createdAt);
    return rightTime - leftTime;
  });
}

export class ProjectStore {
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.filePath = path.join(userDataPath, "projects.json");
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      if (!parsed || !Array.isArray(parsed.projects)) return emptyStore();
      return { version: 1, projects: parsed.projects.map(normalizeProject) };
    } catch (error) {
      if (error.code === "ENOENT") return emptyStore();
      throw error;
    }
  }

  async write(store) {
    await mkdir(this.userDataPath, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
    await rename(temporaryPath, this.filePath);
  }

  async list() {
    const store = await this.read();
    const projects = await Promise.all(store.projects.map(async (project) => ({
      ...project,
      pathExists: await exists(project.rootPath),
    })));
    return projects.sort((left, right) => {
      if (left.archived !== right.archived) return Number(left.archived) - Number(right.archived);
      if (left.pinned !== right.pinned) return Number(right.pinned) - Number(left.pinned);
      const leftTime = timestamp(left.lastOpenedAt || left.updatedAt || left.createdAt);
      const rightTime = timestamp(right.lastOpenedAt || right.updatedAt || right.createdAt);
      return rightTime - leftTime;
    });
  }

  async get(id) {
    const store = await this.read();
    return store.projects.find((project) => project.id === id) || null;
  }

  async ensure(rootPath, name) {
    const resolvedPath = path.resolve(rootPath);
    const store = await this.read();
    const manifest = await this.readManifest(resolvedPath);
    let existing = store.projects.find((project) => project.rootPath === resolvedPath);
    if (!existing && manifest?.projectId) {
      const manifestProject = store.projects.find((project) => project.id === manifest.projectId);
      if (manifestProject && !await exists(manifestProject.rootPath)) existing = manifestProject;
    }
    if (existing) {
      existing.rootPath = resolvedPath;
      if (manifest) {
        existing.sessions = mergeSessions(existing.sessions, manifest.sessions);
        existing.lastSessionId ||= manifest.lastSessionId || null;
        existing.settings = { ...manifest.settings, ...existing.settings };
      }
      if (name?.trim()) existing.name = name.trim();
      existing.removed = false;
      existing.archived = false;
      existing.updatedAt = new Date().toISOString();
      await this.write(store);
      return normalizeProject(existing);
    }
    const now = new Date().toISOString();
    const manifestIdAvailable = manifest?.projectId && !store.projects.some((item) => item.id === manifest.projectId);
    const project = normalizeProject({
      id: manifestIdAvailable ? manifest.projectId : `project_${randomUUID()}`,
      name: name || manifest?.name || path.basename(resolvedPath),
      rootPath: resolvedPath,
      createdAt: manifest?.createdAt || now,
      updatedAt: now,
      lastSessionId: manifest?.lastSessionId || null,
      sessions: manifest?.sessions || [],
      settings: manifest?.settings,
    });
    store.projects.unshift(project);
    await this.write(store);
    return project;
  }

  async update(id, patch) {
    const store = await this.read();
    const project = store.projects.find((item) => item.id === id);
    if (!project) throw new Error("找不到项目");
    if (patch.name !== undefined) project.name = String(patch.name).trim() || project.name;
    if (patch.rootPath !== undefined) project.rootPath = path.resolve(patch.rootPath);
    for (const key of ["pinned", "archived", "removed"]) {
      if (patch[key] !== undefined) project[key] = Boolean(patch[key]);
    }
    if (patch.settings) project.settings = { ...project.settings, ...patch.settings };
    if (patch.lastOpenedAt !== undefined) project.lastOpenedAt = patch.lastOpenedAt;
    if (patch.lastSessionId !== undefined) project.lastSessionId = patch.lastSessionId;
    if (patch.sessions) project.sessions = patch.sessions;
    project.updatedAt = new Date().toISOString();
    await this.write(store);
    return normalizeProject(project);
  }

  async updateSession(projectId, sessionId, patch) {
    const project = await this.get(projectId);
    if (!project) throw new Error("找不到项目");
    const sessions = [...project.sessions];
    const index = sessions.findIndex((session) => session.sessionId === sessionId);
    if (index < 0) throw new Error("找不到会话");
    sessions[index] = { ...sessions[index], ...patch };
    const nextProjectPatch = { sessions };
    if (patch.archived === true && project.lastSessionId === sessionId) {
      nextProjectPatch.lastSessionId = sessions.find((session) => !session.archived)?.sessionId || null;
    }
    return this.update(projectId, nextProjectPatch);
  }

  async reconcileSessions(projectId, discoveredSessions = []) {
    const project = await this.get(projectId);
    if (!project) throw new Error("找不到项目");
    const sessions = mergeSessions(project.sessions, discoveredSessions);
    const lastSessionId = sessions.some((session) => session.sessionId === project.lastSessionId && !session.archived)
      ? project.lastSessionId
      : sessions.find((session) => !session.archived)?.sessionId || null;
    return this.update(projectId, { sessions, lastSessionId });
  }

  async readManifest(rootPath) {
    try {
      const manifestPath = path.join(path.resolve(rootPath), ".pi", "project.json");
      const parsed = JSON.parse(await readFile(manifestPath, "utf8"));
      if (parsed?.schemaVersion !== 1 || !parsed.projectId) return null;
      return {
        projectId: String(parsed.projectId),
        name: typeof parsed.name === "string" ? parsed.name : "",
        createdAt: parsed.createdAt || null,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
        lastSessionId: parsed.lastSessionId || null,
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : {},
      };
    } catch (error) {
      if (error.code === "ENOENT" || error instanceof SyntaxError) return null;
      throw error;
    }
  }

  async syncManifest(project) {
    try {
      const piDir = path.join(project.rootPath, ".pi");
      await mkdir(piDir, { recursive: true });
      const manifestPath = path.join(piDir, "project.json");
      const temporaryPath = `${manifestPath}.${randomUUID()}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify({
        schemaVersion: 1,
        projectId: project.id,
        name: project.name,
        createdAt: project.createdAt,
        sessions: project.sessions,
        lastSessionId: project.lastSessionId,
        settings: project.settings,
      }, null, 2)}\n`, "utf8");
      await rename(temporaryPath, manifestPath);
    } catch {
      // Project metadata remains available in the app registry when the workspace is read-only.
    }
  }
}
