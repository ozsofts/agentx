import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  getAgentDir,
  parseSkillBlock,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SkillsService } from "./skills-service.mjs";
import { describeRuntimeTool } from "./tool-registry.mjs";
import { describeRequestError } from "./request-error.mjs";
import { importSessionContent } from "./session-transfer.mjs";
import { modelDiscoverySupport, runProviderOperation } from "./provider-settings.mjs";

const execFileAsync = promisify(execFile);
const parentPort = process.parentPort;
const agentDir = getAgentDir();
const authPath = path.join(agentDir, "auth.json");
const modelsPath = path.join(agentDir, "models.json");
const settingsPath = path.join(agentDir, "settings.json");

let session;
let unsubscribeSession;
let modelRuntime;
let resourceLoader;
let skillsService;
let cwd;
let workspaceInfo;
let permissionMode = "ask";
let activeRunId;
let activeRunStartedAt;
let activeRunAborted = false;
let activeRunError;
let activeMessageId;
let sequence = 0;
const approvals = new Map();
const rememberedApprovals = new Set();

function post(message) {
  parentPort.postMessage(message);
}

function emit(event) {
  post({
    kind: "event",
    event: {
      eventId: `evt-${++sequence}`,
      sequence,
      timestamp: Date.now(),
      ...event,
    },
  });
}

function stringifyContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((item) => item?.type === "text").map((item) => item.text).join("");
}

const ATTACHMENT_BLOCK_START = "\n\n<pi-desktop-attachments version=\"1\">\n";
const ATTACHMENT_BLOCK_END = "\n</pi-desktop-attachments>";

function normalizeAttachments(value) {
  if (!Array.isArray(value)) return [];
  if (value.length > 8) throw new Error("每条消息最多添加 8 个附件");
  return value.map((item) => {
    const kind = item?.kind === "image" ? "image" : item?.kind === "text" ? "text" : null;
    const name = path.basename(String(item?.name || "attachment")).replace(/[\u0000-\u001f]/g, "").slice(0, 240);
    const mimeType = String(item?.mimeType || "application/octet-stream");
    const size = Number(item?.size) || 0;
    if (!kind) throw new Error(`附件 ${name} 的类型不受支持`);
    if (kind === "image") {
      if (!/^image\/(png|jpeg|gif|webp)$/.test(mimeType) || typeof item.data !== "string") throw new Error(`图片 ${name} 的内容无效`);
      if (item.data.length > 14 * 1024 * 1024) throw new Error(`图片 ${name} 不能超过 10 MB`);
      return { id: String(item.id || ""), kind, name, mimeType, size, data: item.data };
    }
    if (typeof item.content !== "string" || Buffer.byteLength(item.content, "utf8") > 1024 * 1024) throw new Error(`文本附件 ${name} 不能超过 1 MB`);
    return { id: String(item.id || ""), kind, name, mimeType, size, content: item.content };
  });
}

function buildPromptWithAttachments(text, attachments) {
  const visibleText = String(text || "").trim() || "请阅读并处理所附文件。";
  if (!attachments.length) return visibleText;
  const payload = attachments.map((item) => item.kind === "text"
    ? { id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, size: item.size, content: item.content }
    : { id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, size: item.size });
  return `${visibleText}${ATTACHMENT_BLOCK_START}${JSON.stringify(payload)}${ATTACHMENT_BLOCK_END}`;
}

function parsePromptAttachments(text) {
  const value = String(text || "");
  const start = value.lastIndexOf(ATTACHMENT_BLOCK_START);
  if (start < 0 || !value.endsWith(ATTACHMENT_BLOCK_END)) return { text: value, attachments: [] };
  const jsonStart = start + ATTACHMENT_BLOCK_START.length;
  const jsonEnd = value.length - ATTACHMENT_BLOCK_END.length;
  try {
    const parsed = JSON.parse(value.slice(jsonStart, jsonEnd));
    if (!Array.isArray(parsed)) return { text: value, attachments: [] };
    return { text: value.slice(0, start), attachments: parsed };
  } catch {
    return { text: value, attachments: [] };
  }
}

function asTimestamp(value, fallback = Date.now()) {
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}

function serializeMessages(messages) {
  const result = [];
  const tools = new Map();
  let assistant;
  let turnStartedAt;

  const ensureAssistant = (timestamp, index) => {
    if (assistant) return assistant;
    const completedAt = asTimestamp(timestamp);
    assistant = {
      id: `history-assistant-${timestamp || index}`,
      role: "assistant",
      text: "",
      activities: [],
      status: "done",
      startedAt: turnStartedAt || completedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - (turnStartedAt || completedAt)),
    };
    result.push(assistant);
    return assistant;
  };

  messages.forEach((message, index) => {
    const timestamp = asTimestamp(message.timestamp);
    if (message.role === "user") {
      assistant = undefined;
      turnStartedAt = timestamp;
      const rawText = stringifyContent(message.content);
      const skill = parseSkillBlock(rawText);
      // Pi persists expanded skill instructions for inference. Project them back
      // to the invocation for chat without changing the model/session content.
      const displayText = skill ? `/skill:${skill.name}${skill.userMessage ? ` ${skill.userMessage}` : ""}` : rawText;
      const parsed = parsePromptAttachments(displayText);
      const imageContent = Array.isArray(message.content) ? message.content.filter((item) => item?.type === "image") : [];
      let imageIndex = 0;
      const attachments = parsed.attachments.map((item) => {
        const metadata = { id: item.id, kind: item.kind, name: item.name, mimeType: item.mimeType, size: item.size };
        if (item.kind !== "image") return metadata;
        const image = imageContent[imageIndex++];
        return image ? { ...metadata, data: image.data } : metadata;
      });
      for (; imageIndex < imageContent.length; imageIndex += 1) {
        const image = imageContent[imageIndex];
        attachments.push({ id: `history-image-${index}-${imageIndex}`, kind: "image", name: `图片 ${imageIndex + 1}`, mimeType: image.mimeType, data: image.data });
      }
      result.push({ id: `history-user-${message.timestamp || index}`, role: "user", text: parsed.text, attachments });
      return;
    }
    if (message.role === "assistant") {
      const target = ensureAssistant(timestamp, index);
      const text = stringifyContent(message.content);
      if (text) target.text += `${target.text ? "\n\n" : ""}${text}`;
      if (message.stopReason === "error" || message.errorMessage) {
        target.error = describeRequestError(message.errorMessage, message);
        target.status = "error";
      }

      for (const [contentIndex, item] of (message.content || []).entries()) {
        if (item?.type === "thinking") {
          const output = item.thinking || (item.redacted ? "推理内容由模型隐藏。" : "");
          if (!output) continue;
          target.activities.push({
            id: `history-reasoning-${message.timestamp || index}-${contentIndex}`,
            kind: "reasoning",
            status: "done",
            title: "思考过程",
            meta: item.redacted ? "已隐藏" : "完成",
            output,
          });
        }
        if (item?.type === "toolCall") {
          const summary = summarizeTool(item.name, item.arguments);
          const activity = {
            id: item.id,
            kind: "tool",
            tool: item.name,
            status: "running",
            title: summary.title,
            meta: "等待结果",
            output: summary.command,
          };
          target.activities.push(activity);
          tools.set(item.id, activity);
        }
      }
      target.completedAt = Math.max(target.completedAt, timestamp);
      target.durationMs = Math.max(0, target.completedAt - target.startedAt);
      return;
    }
    if (message.role === "toolResult") {
      const activity = tools.get(message.toolCallId);
      if (!activity) return;
      activity.status = message.isError ? "error" : "done";
      activity.meta = message.isError ? "失败" : "完成";
      activity.output = stringifyContent(message.content) || activity.output;
      if (assistant) {
        assistant.completedAt = Math.max(assistant.completedAt, timestamp);
        assistant.durationMs = Math.max(0, assistant.completedAt - assistant.startedAt);
      }
    }
  });

  for (const activity of tools.values()) {
    if (activity.status === "running") {
      activity.status = "error";
      activity.meta = "未完成";
    }
  }
  return result.filter((message) => message.role !== "assistant" || message.text || message.error || message.activities.length);
}

function serializeSessionInfo(info) {
  const firstMessage = parsePromptAttachments(info.firstMessage || "").text;
  return {
    sessionId: info.id,
    title: info.name || firstMessage.slice(0, 80) || "新建会话",
    sessionFile: info.path,
    cwd: info.cwd,
    createdAt: info.created,
    lastOpenedAt: info.modified,
    messageCount: info.messageCount,
    firstMessage,
    archived: false,
  };
}

function serializeModel(model) {
  return {
    id: model.id,
    name: model.name || model.id,
    provider: model.provider,
    api: model.api,
    reasoning: Boolean(model.reasoning),
    input: Array.isArray(model.input) ? [...model.input] : ["text"],
  };
}

async function readModelsConfig() {
  try {
    const parsed = JSON.parse(await readFile(modelsPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("根节点必须是对象");
    if (parsed.providers !== undefined && (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers))) {
      throw new Error("providers 必须是对象");
    }
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { providers: {} };
    throw new Error(`无法读取 models.json：${error.message}`);
  }
}

async function writeModelsConfig(config) {
  const temporaryPath = `${modelsPath}.${process.pid}.tmp`;
  await mkdir(path.dirname(modelsPath), { recursive: true, mode: 0o700 });
  await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, modelsPath);
}

async function ensureModelRuntime() {
  modelRuntime ||= await ModelRuntime.create({ allowModelNetwork: false });
  return modelRuntime;
}

async function getModelSettings() {
  const runtime = await ensureModelRuntime();
  const config = await readModelsConfig();
  const providers = runtime.getProviders().map((provider) => {
    const override = config.providers?.[provider.id];
    const authStatus = runtime.getProviderAuthStatus(provider.id);
    return {
      id: provider.id,
      name: provider.name || provider.id,
      defaultBaseUrl: provider.baseUrl || "",
      baseUrl: typeof override?.baseUrl === "string" ? override.baseUrl : "",
      configured: authStatus.configured,
      authSource: authStatus.source,
      apiKeySupported: Boolean(provider.auth?.apiKey),
      discovery: modelDiscoverySupport(provider, runtime.getModels(provider.id)),
      models: runtime.getModels(provider.id).map(serializeModel),
    };
  }).filter((provider) => provider.models.length > 0);

  return {
    currentModel: session?.model ? serializeModel(session.model) : null,
    providers,
    paths: {
      settings: settingsPath,
      models: modelsPath,
      auth: authPath,
    },
  };
}

async function saveModelSettings(command) {
  const providerId = String(command.providerId || "").trim();
  const modelId = String(command.modelId || "").trim();
  const baseUrl = String(command.baseUrl || "").trim();
  const apiKey = String(command.apiKey || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(providerId)) throw new Error("Provider ID 不合法");
  if (!modelId) throw new Error("请选择模型");
  if (baseUrl) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error("Base URL 只支持 HTTP 或 HTTPS");
  }

  const runtime = await ensureModelRuntime();
  const provider = runtime.getProvider(providerId);
  if (!provider) throw new Error(`未知 Provider：${providerId}`);
  if (!runtime.getModel(providerId, modelId)) throw new Error(`Provider ${providerId} 中不存在模型 ${modelId}`);

  const config = await readModelsConfig();
  config.providers ||= {};
  const previous = config.providers[providerId] || {};
  const next = { ...previous };
  if (baseUrl) next.baseUrl = baseUrl;
  else delete next.baseUrl;
  if (Object.keys(next).length) config.providers[providerId] = next;
  else delete config.providers[providerId];
  await writeModelsConfig(config);
  await runtime.refresh({ allowNetwork: false, providers: [providerId] });

  if (apiKey) {
    if (!provider.auth?.apiKey?.login) throw new Error(`${provider.name || providerId} 不支持在此处保存 API Key`);
    await runtime.login(providerId, "api_key", {
      prompt: async (prompt) => {
        if (prompt.type !== "secret") throw new Error(`${provider.name || providerId} 需要额外认证信息，请使用 Pi 登录流程`);
        return apiKey;
      },
      notify: () => {},
    });
  }

  const selectedModel = runtime.getModel(providerId, modelId);
  if (!selectedModel) throw new Error(`刷新后找不到模型 ${providerId}/${modelId}`);
  if (!runtime.hasConfiguredAuth(providerId)) throw new Error("请填写 API Key，或先通过环境变量/OAuth 配置该 Provider");
  if (session) await session.setModel(selectedModel);

  const settings = await getModelSettings();
  emit({
    type: "models.updated",
    model: settings.currentModel,
    availableModels: runtime.getAvailableSnapshot().map(serializeModel),
    authenticated: runtime.getAvailableSnapshot().length > 0,
  });
  emit({
    type: "runtime.status",
    connected: Boolean(session),
    authenticated: runtime.getAvailableSnapshot().length > 0,
    model: settings.currentModel,
    message: session ? "模型配置已更新" : "模型配置已保存，将在打开工作区后使用",
  });
  return settings;
}

async function clearProviderCredential(command) {
  const providerId = String(command.providerId || "").trim();
  const runtime = await ensureModelRuntime();
  if (!runtime.getProvider(providerId)) throw new Error(`未知 Provider：${providerId}`);
  await runtime.logout(providerId);
  return getModelSettings();
}

function summarizeTool(toolName, input) {
  const descriptor = describeRuntimeTool(toolName);
  if (toolName === "bash") return { title: descriptor.title, command: input?.command || "bash" };
  if (["read", "edit", "write", "grep", "find", "ls"].includes(toolName)) {
    return { title: descriptor.title, command: input?.path || input?.pattern || "" };
  }
  return { title: descriptor.title, command: JSON.stringify(input || {}) };
}

function formatToolOutput(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return stringifyContent(result.content);
  if (Array.isArray(result)) return stringifyContent(result);
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function requestApproval(event) {
  const requestId = `approval-${event.toolCallId}`;
  const summary = summarizeTool(event.toolName, event.input);
  const approvalKey = `${event.toolName}:${summary.command}`;
  if (rememberedApprovals.has(approvalKey)) return Promise.resolve(true);
  const approvalEvent = {
    type: "approval.requested",
    sessionId: session.sessionId,
    runId: activeRunId,
    requestId,
    toolCallId: event.toolCallId,
    tool: event.toolName,
    command: summary.command,
    cwd,
    reason: `${summary.title}需要你的确认`,
  };
  emit(approvalEvent);
  return new Promise((resolve) => approvals.set(requestId, { resolve, approvalKey, event: approvalEvent }));
}

const permissionExtension = {
  name: "desktop-permission-gate",
  hidden: true,
  factory(pi) {
    pi.on("tool_call", async (event) => {
      const mutatingTool = describeRuntimeTool(event.toolName).risk !== "read";
      if (!mutatingTool || permissionMode === "full") return;
      if (permissionMode === "read-only") {
        return { block: true, reason: `只读模式禁止 ${event.toolName} 工具`, terminate: false };
      }
      const approved = await requestApproval(event);
      if (!approved) return { block: true, reason: "用户拒绝了本次工具执行", terminate: false };
    });
  },
};

async function collectChanges() {
  try {
    const { stdout: statusOutput } = await execFileAsync("git", ["status", "--short"], { cwd, maxBuffer: 2_000_000 });
    if (!statusOutput.trim()) return { files: [], additions: 0, deletions: 0, patch: "" };

    const { stdout: numstatOutput } = await execFileAsync("git", ["diff", "--numstat", "--", "."], { cwd, maxBuffer: 2_000_000 });
    const stats = new Map();
    for (const line of numstatOutput.trim().split("\n")) {
      if (!line) continue;
      const [plus, minus, ...nameParts] = line.split("\t");
      stats.set(nameParts.join("\t"), {
        plus: Number.isFinite(Number(plus)) ? Number(plus) : 0,
        minus: Number.isFinite(Number(minus)) ? Number(minus) : 0,
      });
    }

    const files = statusOutput.trim().split("\n").map((line) => {
      const status = line.slice(0, 2).trim() || "M";
      const name = line.slice(3).trim();
      return { name, status, plus: stats.get(name)?.plus || 0, minus: stats.get(name)?.minus || 0 };
    });
    const { stdout: patch } = await execFileAsync("git", ["diff", "--no-ext-diff", "--unified=3", "--", "."], { cwd, maxBuffer: 5_000_000 });
    return {
      files,
      additions: files.reduce((sum, file) => sum + file.plus, 0),
      deletions: files.reduce((sum, file) => sum + file.minus, 0),
      patch,
    };
  } catch {
    return { files: [], additions: 0, deletions: 0, patch: "" };
  }
}

function reportRunError(error) {
  emit({ type: "message.error", sessionId: session.sessionId, runId: activeRunId, messageId: activeMessageId, error });
  emit({ type: "runtime.error", sessionId: session.sessionId, runId: activeRunId, message: error.message });
}

function onSessionEvent(event) {
  const sessionId = session.sessionId;
  if (event.type === "message_end" && event.message.role === "user") {
    // Public listeners run just before Pi appends the message. Wait for that
    // synchronous append, then announce the durable session before inference ends.
    queueMicrotask(() => {
      emit({ type: "session.updated", ...workspaceInfo, sessionId, cwd, sessionFile: session.sessionFile,
        messages: serializeMessages(session.messages) });
    });
  }
  if (event.type === "agent_settled") {
    activeRunAborted = event.aborted;
    return;
  }
  if (event.type === "agent_start") {
    activeRunId ||= `run-${Date.now()}`;
    activeRunStartedAt ||= Date.now();
    emit({ type: "run.started", sessionId, runId: activeRunId, startedAt: activeRunStartedAt });
    return;
  }
  if (event.type === "message_start" && event.message.role === "assistant") {
    // A later attempt may recover from a retryable provider error.
    activeRunError = undefined;
    activeMessageId = `message-${event.message.timestamp || Date.now()}`;
    emit({ type: "message.started", sessionId, runId: activeRunId, messageId: activeMessageId, startedAt: activeRunStartedAt || Date.now() });
    return;
  }
  if (event.type === "message_end" && event.message.role === "assistant") {
    if (event.message.stopReason === "error") {
      activeRunError = describeRequestError(event.message.errorMessage, event.message);
    }
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    const reasoningId = `${activeMessageId}-reasoning-${update.contentIndex}`;
    if (update.type === "text_delta") {
      emit({ type: "message.delta", sessionId, runId: activeRunId, messageId: activeMessageId, text: update.delta });
      return;
    }
    if (update.type === "thinking_start") {
      emit({ type: "reasoning.started", sessionId, runId: activeRunId, messageId: activeMessageId, reasoningId });
      return;
    }
    if (update.type === "thinking_delta") {
      emit({ type: "reasoning.delta", sessionId, runId: activeRunId, messageId: activeMessageId, reasoningId, text: update.delta });
      return;
    }
    if (update.type === "thinking_end") {
      emit({ type: "reasoning.completed", sessionId, runId: activeRunId, messageId: activeMessageId, reasoningId, text: update.content });
      return;
    }
  }
  if (event.type === "tool_execution_start") {
    const summary = summarizeTool(event.toolName, event.args);
    emit({
      type: "tool.started",
      sessionId,
      runId: activeRunId,
      toolCallId: event.toolCallId,
      tool: event.toolName,
      title: summary.title,
      command: summary.command,
      startedAt: Date.now(),
    });
    return;
  }
  if (event.type === "tool_execution_update") {
    emit({
      type: "tool.progress",
      sessionId,
      runId: activeRunId,
      toolCallId: event.toolCallId,
      output: formatToolOutput(event.partialResult),
    });
    return;
  }
  if (event.type === "tool_execution_end") {
    emit({
      type: "tool.completed",
      sessionId,
      runId: activeRunId,
      toolCallId: event.toolCallId,
      output: formatToolOutput(event.result),
      isError: event.isError,
      duration: "完成",
      completedAt: Date.now(),
    });
    return;
  }
  if (event.type === "compaction_start") emit({ type: "compaction.started", sessionId, runId: activeRunId });
  if (event.type === "compaction_end") emit({ type: "compaction.completed", sessionId, runId: activeRunId, aborted: event.aborted });
}

async function initialize(command) {
  if (session) {
    unsubscribeSession?.();
    session.dispose();
  }
  for (const approval of approvals.values()) approval.resolve(false);
  approvals.clear();
  rememberedApprovals.clear();

  cwd = path.resolve(command.cwd);
  await access(cwd);
  permissionMode = command.permissionMode || permissionMode;
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir);
  resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    extensionFactories: [permissionExtension],
    noExtensions: true,
  });
  await resourceLoader.reload();

  modelRuntime = await ModelRuntime.create({ allowModelNetwork: false });
  const sessionManager = command.sessionFile
    ? SessionManager.open(command.sessionFile, undefined, cwd)
    : SessionManager.create(cwd);
  const created = await createAgentSession({
    cwd,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader,
    tools: Array.isArray(command.tools) ? command.tools : undefined,
  });
  session = created.session;
  if (command.modelValue) {
    const [providerId, modelId] = String(command.modelValue).split("::");
    const configuredModel = providerId && modelId ? modelRuntime.getModel(providerId, modelId) : null;
    if (configuredModel) await session.setModel(configuredModel);
  }
  unsubscribeSession = session.subscribe(onSessionEvent);
  skillsService = new SkillsService({
    cwd,
    reload: async () => {
      if (!session) throw new Error("请先选择工作目录");
      await session.reload();
    },
  });

  const availableModels = modelRuntime.getAvailableSnapshot();
  let branch = "workspace";
  try {
    const result = await execFileAsync("git", ["branch", "--show-current"], { cwd });
    branch = result.stdout.trim() || "detached";
  } catch {
    // Non-Git directories are still valid Pi workspaces.
  }
  const result = {
    cwd,
    projectId: command.projectId || null,
    repo: path.basename(cwd),
    branch,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    model: session.model ? serializeModel(session.model) : null,
    thinkingLevel: session.thinkingLevel,
    toolIds: Array.isArray(command.toolIds) ? command.toolIds : [],
    availableModels: availableModels.slice(0, 200).map(serializeModel),
    authenticated: availableModels.length > 0,
    permissionMode,
    messages: serializeMessages(session.messages),
  };
  workspaceInfo = result;
  emit({ type: "workspace.connected", ...result });
  emit({
    type: "runtime.status",
    connected: true,
    authenticated: result.authenticated,
    model: result.model,
    message: result.authenticated ? "Agentx 已就绪" : "Agentx 已连接，但尚未配置模型凭据",
  });
  return result;
}

async function handleCommand(command) {
  if (["initialize", "newSession", "openSession", "renameSession", "assertSessionIdle", "importSession", "exportSession"].includes(command.type) && (activeRunId || session?.isStreaming)) throw new Error("会话正在运行，请等待完成或先停止任务");
  if (command.type === "assertSessionIdle") return { idle: true };
  if (command.type === "getWorkspace") {
    if (!session) throw new Error("请先选择工作目录");
    return { ...workspaceInfo, sessionId: session.sessionId, sessionFile: session.sessionFile, permissionMode,
      model: session.model ? serializeModel(session.model) : null, messages: serializeMessages(session.messages),
      running: Boolean(activeRunId || session.isStreaming), pendingApprovals: [...approvals.values()].map((item) => item.event).filter(Boolean) };
  }
  if (command.type === "importSession") return importSessionContent(command.content, path.resolve(command.cwd));
  if (command.type === "sessionInfo" || command.type === "exportSession") {
    if (!session || (command.sessionId && command.sessionId !== session.sessionId)) throw new Error("当前会话已切换，请重试");
    if (command.type === "exportSession") {
      if (!session.sessionFile) throw new Error("请先发送消息并保存会话");
      if (command.format === "html") { await session.exportToHtml(command.outputPath); return { exported: true }; }
      throw new Error("不支持的导出格式");
    }
    return { sessionId: session.sessionId, sessionFile: session.sessionFile || null, cwd, model: session.model ? serializeModel(session.model) : null, permissionMode, stats: session.getSessionStats() };
  }
  if (command.type === "initialize") return initialize(command);
  if (command.type === "listSessions") {
    const listCwd = path.resolve(command.cwd || cwd || process.cwd());
    await access(listCwd);
    const items = await SessionManager.list(listCwd);
    return { sessions: items.map(serializeSessionInfo) };
  }
  if (command.type === "newSession") {
    return initialize({ cwd: command.cwd || cwd, projectId: command.projectId });
  }
  if (command.type === "openSession") {
    return initialize({ cwd: command.cwd || cwd, sessionFile: command.sessionFile, projectId: command.projectId });
  }
  if (command.type === "renameSession") {
    if (!command.sessionId || !command.name?.trim()) throw new Error("会话名称不能为空");
    const target = command.sessionFile || (await SessionManager.list(path.resolve(command.cwd || cwd))).find((item) => item.id === command.sessionId)?.path;
    if (!target) throw new Error("找不到会话文件");
    if (session?.sessionId === command.sessionId && session.sessionFile === target) {
      session.setSessionName(command.name.trim());
    } else {
      const temporary = SessionManager.open(target, undefined, path.resolve(command.cwd || cwd));
      temporary.appendSessionInfo(command.name.trim());
      temporary.dispose?.();
    }
    const items = await SessionManager.list(path.resolve(command.cwd || cwd));
    return { sessions: items.map(serializeSessionInfo) };
  }
  if (command.type === "getModelSettings") return getModelSettings();
  if (["testModelSettings", "fetchProviderModels"].includes(command.type)) return runProviderOperation(await ensureModelRuntime(), command);
  if (command.type === "saveModelSettings") return saveModelSettings(command);
  if (command.type === "clearProviderCredential") return clearProviderCredential(command);
  if (command.type === "listSkills") {
    if (!skillsService) throw new Error("请先选择工作目录");
    return skillsService.list();
  }
  if (command.type === "inspectSkillSource") {
    if (!skillsService) throw new Error("请先选择工作目录");
    return skillsService.inspect(command.sourcePath);
  }
  if (command.type === "installSkill") {
    if (!skillsService) throw new Error("请先选择工作目录");
    emit({ type: "skills.operation", operation: "install", status: "running", skillName: command.skillName });
    const result = await skillsService.install(command);
    emit({ type: "skills.operation", operation: "install", status: "completed", skillName: command.skillName });
    return result;
  }
  if (command.type === "removeSkill") {
    if (!skillsService) throw new Error("请先选择工作目录");
    emit({ type: "skills.operation", operation: "remove", status: "running", skillName: command.name });
    const result = await skillsService.remove(command.name, { reload: command.reload !== false });
    emit({ type: "skills.operation", operation: "remove", status: "completed", skillName: command.name });
    return result;
  }
  if (command.type === "reloadSkills") {
    if (!skillsService) throw new Error("请先选择工作目录");
    emit({ type: "skills.operation", operation: "reload", status: "running" });
    const result = await skillsService.reloadSkills();
    emit({ type: "skills.operation", operation: "reload", status: "completed" });
    return result;
  }
  if (command.type === "setModel") {
    if (!session || !modelRuntime) throw new Error("请先选择工作目录");
    const selectedModel = modelRuntime.getModel(command.providerId, command.modelId);
    if (!selectedModel) throw new Error(`找不到模型 ${command.providerId}/${command.modelId}`);
    await session.setModel(selectedModel);
    const model = serializeModel(session.model);
    emit({ type: "models.updated", model, availableModels: modelRuntime.getAvailableSnapshot().map(serializeModel), authenticated: true });
    return { model };
  }
  if (command.type === "setPermissionMode") {
    if (!["read-only", "ask", "full"].includes(command.mode)) throw new Error("Unknown permission mode");
    permissionMode = command.mode;
    if (permissionMode === "full") {
      for (const [requestId, approval] of approvals) {
        approvals.delete(requestId);
        approval.resolve(true);
        emit({ type: "approval.resolved", sessionId: session?.sessionId, requestId, approved: true });
      }
    }
    return { mode: permissionMode };
  }
  if (command.type === "prompt") {
    if (!session) throw new Error("请先选择工作目录");
    if (activeRunId || session.isStreaming) throw new Error("此会话正在运行，请等待完成或先停止任务");
    const attachments = normalizeAttachments(command.attachments);
    const images = attachments.filter((item) => item.kind === "image");
    if (images.length && !session.model?.input?.includes("image")) throw new Error(`当前模型 ${session.model?.name || session.model?.id || ""} 不支持图片输入`);
    const promptText = buildPromptWithAttachments(command.text, attachments);
    activeRunId = `run-${Date.now()}`;
    activeRunStartedAt = Date.now();
    activeRunAborted = false;
    activeRunError = undefined;
    try {
      await session.prompt(promptText, {
        source: "rpc",
        images: images.map((item) => ({ type: "image", data: item.data, mimeType: item.mimeType })),
      });
      const changes = await collectChanges();
      if (changes.files.length) emit({ type: "changes.available", sessionId: session.sessionId, runId: activeRunId, ...changes });
      const completedAt = Date.now();
      const status = activeRunAborted ? "aborted" : activeRunError ? "error" : "completed";
      if (status === "error") reportRunError(activeRunError);
      emit({ type: "run.settled", sessionId: session.sessionId, runId: activeRunId, status, completedAt, durationMs: completedAt - activeRunStartedAt });
      return { accepted: true, status, runId: activeRunId, sessionId: session.sessionId, sessionFile: session.sessionFile, messages: serializeMessages(session.messages) };
    } catch (error) {
      reportRunError(describeRequestError(error.message || String(error), session.model));
      const completedAt = Date.now();
      emit({ type: "run.settled", sessionId: session.sessionId, runId: activeRunId, status: "error", completedAt, durationMs: completedAt - activeRunStartedAt });
      throw error;
    } finally {
      activeRunId = undefined;
      activeRunStartedAt = undefined;
      activeRunAborted = false;
      activeRunError = undefined;
      activeMessageId = undefined;
    }
  }
  if (command.type === "approvalResponse") {
    const approval = approvals.get(command.requestId);
    if (!approval) return { resolved: false };
    approvals.delete(command.requestId);
    if (command.approved && command.remember) rememberedApprovals.add(approval.approvalKey);
    approval.resolve(Boolean(command.approved));
    emit({ type: "approval.resolved", requestId: command.requestId, approved: Boolean(command.approved) });
    return { resolved: true };
  }
  if (command.type === "abort") {
    for (const approval of approvals.values()) approval.resolve(false);
    approvals.clear();
    await session?.abort();
    return { aborted: true };
  }
  if (command.type === "getChanges") return collectChanges();
  if (command.type === "dispose") {
    unsubscribeSession?.();
    session?.dispose();
    session = undefined;
    resourceLoader = undefined;
    skillsService = undefined;
    return { disposed: true };
  }
  throw new Error(`Unknown command: ${command.type}`);
}

parentPort.on("message", async (event) => {
  const message = event.data;
  if (message?.kind !== "command") return;
  try {
    const result = await handleCommand(message.command);
    post({ kind: "response", requestId: message.requestId, ok: true, result });
  } catch (error) {
    post({ kind: "response", requestId: message.requestId, ok: false, error: error.message || String(error) });
  }
});
