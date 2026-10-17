import { DEFAULT_TOOL_IDS, TOOL_CATALOG } from "../electron/tool-registry.mjs";

const browserImageExtensions = new Set(["png", "jpg", "jpeg", "gif", "webp"]);
const browserTextExtensions = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "htm",
  "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "kts", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "ini",
  "conf", "properties", "log", "diff", "patch", "svg", "mermaid", "mmd",
]);

function chooseBrowserAttachments({ maxFiles = 8 } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = [...browserImageExtensions, ...browserTextExtensions].map((extension) => `.${extension}`).join(",");
    const finish = async () => {
      const attachments = [];
      const rejected = [];
      const files = [...(input.files || [])];
      for (const [index, file] of files.entries()) {
        const extension = file.name.split(".").pop()?.toLowerCase() || "";
        try {
          if (index >= maxFiles) throw new Error("每条消息最多添加 8 个附件");
          if (browserImageExtensions.has(extension)) {
            if (file.size > 10 * 1024 * 1024) throw new Error("图片不能超过 10 MB");
            const bytes = new Uint8Array(await file.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
            attachments.push({ id: crypto.randomUUID(), kind: "image", name: file.name, mimeType: file.type || `image/${extension === "jpg" ? "jpeg" : extension}`, size: file.size, data: btoa(binary) });
          } else if (browserTextExtensions.has(extension)) {
            if (file.size > 1024 * 1024) throw new Error("文本文件不能超过 1 MB");
            attachments.push({ id: crypto.randomUUID(), kind: "text", name: file.name, mimeType: file.type || "text/plain", size: file.size, content: await file.text() });
          } else {
            throw new Error("当前版本仅支持图片、纯文本和常见代码文件");
          }
        } catch (error) {
          rejected.push({ name: file.name, message: error.message || "无法读取文件" });
        }
      }
      resolve({ attachments, rejected });
    };
    input.addEventListener("change", finish, { once: true });
    input.addEventListener("cancel", () => resolve({ attachments: [], rejected: [] }), { once: true });
    input.click();
  });
}

const wait = (fn, delay, timers) => {
  const timer = window.setTimeout(fn, delay);
  timers.add(timer);
  return timer;
};

export function createMockTransport() {
  const listeners = new Set();
  const timers = new Set();
  let activeRun = null;
  let sequence = 0;
  let skills = [
    {
      id: "project-overview",
      name: "project-overview",
      title: "项目概览",
      description: "快速梳理代码库结构、技术栈、关键入口与运行方式。",
      category: "项目理解",
      version: "1.0.0",
      author: "Pi Desktop",
      sourceType: "bundled",
      installed: true,
      managed: true,
      installedAt: new Date(Date.now() - 86400000).toISOString(),
      files: ["SKILL.md"],
      fileCount: 1,
      totalBytes: 642,
      content: "# Project overview\n\nUse this skill when the user asks to understand an unfamiliar repository.\n\n1. Read repository instructions and package manifests first.\n2. Identify runtime entry points and major modules.\n3. Verify commands before presenting them.\n4. Report a compact map with direct file references.",
    },
    {
      id: "test-and-fix",
      name: "test-and-fix",
      title: "测试与修复",
      description: "运行最相关的测试，定位失败原因并完成小范围修复。",
      category: "工程质量",
      version: "1.0.0",
      author: "Pi Desktop",
      sourceType: "bundled",
      installed: false,
      managed: false,
      files: ["SKILL.md"],
      fileCount: 1,
      totalBytes: 594,
      content: "# Test and fix\n\n1. Reproduce the failure with the smallest relevant test target.\n2. Trace the behavioral cause before editing.\n3. Make a focused fix.\n4. Re-run focused and broader tests.",
    },
    {
      id: "code-review",
      name: "code-review",
      title: "代码审查",
      description: "审查当前改动中的缺陷、回归风险、安全问题和测试缺口。",
      category: "工程质量",
      version: "1.0.0",
      author: "Pi Desktop",
      sourceType: "bundled",
      installed: false,
      managed: false,
      files: ["SKILL.md"],
      fileCount: 1,
      totalBytes: 552,
      content: "# Code review\n\nPrioritize actionable findings over summary.\n\n- Inspect the exact diff in scope.\n- Trace changed behavior through callers.\n- Validate error paths and permission checks.\n- Report findings with precise file references.",
    },
  ];
  let projects = [];
  let desktopSettings = {
    version: 1,
    defaultProjectRoot: "~/Projects",
    reopenLastWorkspace: true,
    defaultPermissionMode: "ask",
    defaultModel: null,
    skills: { autoReload: true, allowLocalImport: true },
    tools: { enabled: [...DEFAULT_TOOL_IDS] },
  };

  const emit = (event) => {
    sequence += 1;
    const envelope = {
      eventId: `evt-${sequence}`,
      sequence,
      timestamp: Date.now(),
      ...event,
    };
    listeners.forEach((listener) => listener(envelope));
  };

  const clearTimers = () => {
    timers.forEach((timer) => window.clearTimeout(timer));
    timers.clear();
  };

  return {
    kind: "mock",

    async restoreWorkspace() {
      return null;
    },

    async getDesktopSettings() {
      return structuredClone(desktopSettings);
    },

    async saveDesktopSettings(patch) {
      desktopSettings = {
        ...desktopSettings,
        ...patch,
        skills: { ...desktopSettings.skills, ...(patch?.skills || {}) },
        tools: { ...desktopSettings.tools, ...(patch?.tools || {}) },
      };
      return structuredClone(desktopSettings);
    },

    async listTools() {
      return { tools: structuredClone(TOOL_CATALOG) };
    },

    async listProjects() {
      return structuredClone(projects);
    },

    async chooseProjectFolder() {
      return null;
    },

    chooseAttachments(options) {
      return chooseBrowserAttachments(options);
    },

    async openProjectFolder() {
      return null;
    },

    async projectCommand() {
      return null;
    },

    async listSessions() {
      return { sessions: [] };
    },

    async newSession() {
      return null;
    },

    async openSession() {
      return null;
    },

    async renameSession() {
      return { sessions: [] };
    },

    async openWorkspace() {
      return null;
    },

    async chooseSkillFolder() {
      return "mock://local-skill";
    },

    async listSkills() {
      return { skills: structuredClone(skills), installRoot: "~/Projects/pi-desktop/.pi/skills" };
    },

    async inspectSkillSource() {
      return {
        id: "local:release-notes",
        name: "release-notes",
        title: "Release Notes",
        description: "Generate concise release notes from the current changes and commit history.",
        category: "本地导入",
        version: "本地",
        author: "本地文件夹",
        sourceType: "local",
        sourcePath: "~/Desktop/release-notes",
        installed: false,
        managed: false,
        files: ["SKILL.md", "references/template.md"],
        fileCount: 2,
        totalBytes: 1240,
        hash: "mock-release-notes",
        content: "# Release notes\n\nSummarize user-facing changes from commits and the working tree.\n\n1. Group changes by impact.\n2. Omit internal implementation details.\n3. Call out migrations and breaking changes.",
      };
    },

    async installSkill(skill) {
      const identifier = skill.catalogId || skill.skillName;
      const index = skills.findIndex((item) => item.id === identifier || item.name === skill.skillName);
      if (index >= 0) {
        skills[index] = { ...skills[index], installed: true, managed: true, installedAt: new Date().toISOString() };
      } else {
        const imported = await this.inspectSkillSource();
        skills = [...skills, { ...imported, id: `installed:${imported.name}`, installed: true, managed: true, installedAt: new Date().toISOString() }];
      }
      emit({ type: "skills.operation", operation: "install", status: "completed", skillName: skill.skillName });
      return this.listSkills();
    },

    async removeSkill(name) {
      skills = skills.map((item) => item.name === name && item.sourceType === "bundled"
        ? { ...item, installed: false, managed: false, installedAt: undefined }
        : item).filter((item) => item.name !== name || item.sourceType === "bundled");
      emit({ type: "skills.operation", operation: "remove", status: "completed", skillName: name });
      return this.listSkills();
    },

    async reloadSkills() {
      emit({ type: "skills.operation", operation: "reload", status: "completed" });
      return this.listSkills();
    },

    async getModelSettings() {
      return {
        currentModel: { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            defaultBaseUrl: "https://api.anthropic.com",
            baseUrl: "",
            configured: true,
            authSource: "stored",
            apiKeySupported: true,
            models: [{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" }],
          },
          {
            id: "openai",
            name: "OpenAI",
            defaultBaseUrl: "https://api.openai.com/v1",
            baseUrl: "",
            configured: false,
            apiKeySupported: true,
            models: [{ provider: "openai", id: "gpt-5.6-codex", name: "GPT-5.6 Codex" }],
          },
        ],
        paths: {
          settings: "~/.pi/agent/settings.json",
          models: "~/.pi/agent/models.json",
          auth: "~/.pi/agent/auth.json",
        },
      };
    },

    async saveModelSettings() {
      return this.getModelSettings();
    },

    async clearProviderCredential() {
      return this.getModelSettings();
    },

    async setModel({ providerId, modelId }) {
      return { model: { provider: providerId, id: modelId, name: modelId } };
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async prompt({ sessionId, text, attachments = [] }) {
      clearTimers();
      const runId = `run-${Date.now()}`;
      const messageId = `msg-${Date.now()}`;
      activeRun = { runId, sessionId, messageId, text, attachments, waiting: false };

      emit({ type: "run.started", sessionId, runId });
      emit({ type: "message.started", sessionId, runId, messageId });

      wait(
        () => emit({
          type: "message.delta",
          sessionId,
          runId,
          messageId,
          text: "我会先检查当前工作区和运行配置，然后用最小改动完成这项任务。",
        }),
        250,
        timers,
      );

      wait(
        () => {
          if (!activeRun) return;
          activeRun.waiting = true;
          emit({
            type: "approval.requested",
            sessionId,
            runId,
            requestId: `approval-${Date.now()}`,
            tool: "bash",
            command: "pnpm test --run",
            cwd: "~/Projects/pi-desktop",
            reason: "运行项目测试以验证修改",
          });
        },
        850,
        timers,
      );

      return { accepted: true, runId };
    },

    async respondToApproval({ approved }) {
      if (!activeRun?.waiting) return;
      const { sessionId, runId, messageId } = activeRun;
      activeRun.waiting = false;
      emit({ type: "approval.resolved", sessionId, runId, approved });

      if (!approved) {
        emit({
          type: "message.delta",
          sessionId,
          runId,
          messageId,
          text: "\n\n测试命令已取消。我保留了当前工作区，没有继续执行写入操作。",
        });
        emit({ type: "run.settled", sessionId, runId, status: "cancelled" });
        activeRun = null;
        return;
      }

      const toolCallId = `tool-${Date.now()}`;
      wait(
        () => emit({
          type: "tool.started",
          sessionId,
          runId,
          toolCallId,
          tool: "bash",
          title: "运行测试",
          command: "pnpm test --run",
        }),
        180,
        timers,
      );
      wait(
        () => emit({
          type: "tool.progress",
          sessionId,
          runId,
          toolCallId,
          output: "Test Files  8 passed (8)\nTests       24 passed (24)",
        }),
        850,
        timers,
      );
      wait(
        () => emit({
          type: "tool.completed",
          sessionId,
          runId,
          toolCallId,
          exitCode: 0,
          duration: "2.8s",
        }),
        1250,
        timers,
      );
      wait(
        () => emit({
          type: "message.delta",
          sessionId,
          runId,
          messageId,
          text: "\n\n实现已经完成。Transport 边界保持稳定，页面只消费标准化事件；Pi SDK 和 RPC 可以在 Agent Host 内自由切换。测试全部通过。",
        }),
        1480,
        timers,
      );
      wait(
        () => emit({
          type: "changes.available",
          sessionId,
          runId,
          files: [
            { name: "src/agent/transport.ts", status: "M", plus: 64, minus: 12 },
            { name: "src/agent/pi-sdk.ts", status: "A", plus: 82, minus: 0 },
            { name: "src/agent/events.ts", status: "A", plus: 40, minus: 11 },
          ],
          additions: 186,
          deletions: 31,
          patch: "diff --git a/src/agent/transport.ts b/src/agent/transport.ts\n--- a/src/agent/transport.ts\n+++ b/src/agent/transport.ts\n@@ -1,2 +1,4 @@\n+export interface AgentTransport {\n+  subscribe(listener: EventListener): Unsubscribe;\n+}\n",
        }),
        1750,
        timers,
      );
      wait(
        () => {
          emit({ type: "run.settled", sessionId, runId, status: "completed" });
          activeRun = null;
        },
        2000,
        timers,
      );
    },

    async abort() {
      if (!activeRun) return;
      const { sessionId, runId } = activeRun;
      clearTimers();
      activeRun = null;
      emit({ type: "run.settled", sessionId, runId, status: "aborted" });
    },

    async setPermissionMode() {},

    async getChanges() {
      return null;
    },

    dispose() {
      clearTimers();
      listeners.clear();
      activeRun = null;
    },
  };
}

function createElectronTransport(bridge) {
  const listeners = new Set();
  const unsubscribeBridge = bridge.onEvent((event) => {
    listeners.forEach((listener) => listener(event));
  });

  return {
    kind: "electron-ipc",

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    restoreWorkspace() {
      return bridge.restoreWorkspace();
    },

    getDesktopSettings() {
      return bridge.getDesktopSettings();
    },

    saveDesktopSettings(patch) {
      return bridge.saveDesktopSettings(patch);
    },

    listTools() {
      return bridge.listTools();
    },

    listProjects() {
      return bridge.listProjects();
    },

    chooseProjectFolder() {
      return bridge.chooseProjectFolder();
    },

    chooseAttachments(options) {
      return bridge.chooseAttachments(options);
    },

    openProjectFolder() {
      return bridge.openProjectFolder();
    },

    projectCommand(command) {
      return bridge.projectCommand(command);
    },

    listSessions({ cwd, projectId } = {}) {
      return bridge.command({ type: "listSessions", cwd, projectId });
    },

    newSession({ cwd, projectId } = {}) {
      return bridge.projectCommand({ type: "new-session", cwd, projectId });
    },

    openSession({ cwd, projectId, sessionFile } = {}) {
      return bridge.projectCommand({ type: "open-session", cwd, projectId, sessionFile });
    },

    renameSession({ cwd, projectId, sessionId, sessionFile, name } = {}) {
      return bridge.command({ type: "renameSession", cwd, projectId, sessionId, sessionFile, name });
    },

    openWorkspace() {
      return bridge.openWorkspace();
    },

    chooseSkillFolder() {
      return bridge.chooseSkillFolder();
    },

    listSkills() {
      return bridge.command({ type: "listSkills" });
    },

    inspectSkillSource(sourcePath) {
      return bridge.command({ type: "inspectSkillSource", sourcePath });
    },

    installSkill(skill) {
      return bridge.command({ type: "installSkill", ...skill });
    },

    removeSkill(name, options = {}) {
      return bridge.command({ type: "removeSkill", name, ...options });
    },

    reloadSkills() {
      return bridge.command({ type: "reloadSkills" });
    },

    getModelSettings() {
      return bridge.command({ type: "getModelSettings" });
    },

    saveModelSettings(settings) {
      return bridge.command({ type: "saveModelSettings", ...settings });
    },

    clearProviderCredential(providerId) {
      return bridge.command({ type: "clearProviderCredential", providerId });
    },

    setModel({ providerId, modelId }) {
      return bridge.command({ type: "setModel", providerId, modelId });
    },

    prompt({ text, attachments }) {
      return bridge.command({ type: "prompt", text, attachments });
    },

    respondToApproval({ requestId, approved, remember }) {
      return bridge.command({ type: "approvalResponse", requestId, approved, remember });
    },

    abort() {
      return bridge.command({ type: "abort" });
    },

    setPermissionMode(mode) {
      return bridge.command({ type: "setPermissionMode", mode });
    },

    getChanges() {
      return bridge.command({ type: "getChanges" });
    },

    dispose() {
      unsubscribeBridge();
      listeners.clear();
    },
  };
}

export function createTransport() {
  return window.piDesktop ? createElectronTransport(window.piDesktop) : createMockTransport();
}
