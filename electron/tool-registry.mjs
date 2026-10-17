import desktopPackage from "../package.json" with { type: "json" };

const piVersion = desktopPackage.dependencies["@earendil-works/pi-coding-agent"];

export const TOOL_CATALOG = Object.freeze([
  {
    id: "pi:read",
    runtimeName: "read",
    title: "读取文件",
    description: "读取文本或图片内容，支持分段读取。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "read",
    scopes: ["workspace-read"],
    supportsStreaming: false,
  },
  {
    id: "pi:grep",
    runtimeName: "grep",
    title: "搜索文件内容",
    description: "按文本或正则表达式搜索内容，并遵循 .gitignore。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "read",
    scopes: ["workspace-read"],
    supportsStreaming: false,
  },
  {
    id: "pi:find",
    runtimeName: "find",
    title: "查找文件",
    description: "按 glob 模式查找文件，并遵循 .gitignore。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "read",
    scopes: ["workspace-read"],
    supportsStreaming: false,
  },
  {
    id: "pi:ls",
    runtimeName: "ls",
    title: "浏览目录",
    description: "列出指定目录中的文件和子目录。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "read",
    scopes: ["workspace-read"],
    supportsStreaming: false,
  },
  {
    id: "pi:edit",
    runtimeName: "edit",
    title: "编辑文件",
    description: "通过精确文本替换修改已有文件。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "write",
    scopes: ["workspace-write"],
    supportsStreaming: false,
  },
  {
    id: "pi:write",
    runtimeName: "write",
    title: "写入文件",
    description: "创建新文件或完整覆盖已有文件。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "write",
    scopes: ["workspace-write"],
    supportsStreaming: false,
  },
  {
    id: "pi:bash",
    runtimeName: "bash",
    title: "执行命令",
    description: "在项目工作目录中执行终端命令并流式返回输出。",
    source: "Pi 内置",
    sourceId: "pi",
    version: piVersion,
    risk: "execute",
    scopes: ["process", "filesystem"],
    supportsStreaming: true,
  },
]);

export const DEFAULT_TOOL_IDS = Object.freeze(["pi:read", "pi:bash", "pi:edit", "pi:write"]);

const byId = new Map(TOOL_CATALOG.map((tool) => [tool.id, tool]));
const byRuntimeName = new Map(TOOL_CATALOG.map((tool) => [tool.runtimeName, tool]));

export function normalizeToolIds(ids, fallback = DEFAULT_TOOL_IDS) {
  const requested = Array.isArray(ids) ? ids : fallback;
  return [...new Set(requested)].filter((id) => byId.has(id));
}

export function resolveEffectiveToolIds(globalSettings, projectSettings) {
  const globalIds = normalizeToolIds(globalSettings?.enabled);
  if (projectSettings?.mode !== "custom") return globalIds;
  return normalizeToolIds(projectSettings.enabled, []);
}

export function runtimeToolNames(toolIds) {
  return normalizeToolIds(toolIds, []).map((id) => byId.get(id).runtimeName);
}

export function describeRuntimeTool(runtimeName) {
  return byRuntimeName.get(runtimeName) || {
    id: `extension:${runtimeName}`,
    runtimeName,
    title: `运行 ${runtimeName}`,
    description: "由扩展注册的工具",
    source: "扩展",
    sourceId: "extension",
    version: "unknown",
    risk: "execute",
    scopes: [],
    supportsStreaming: true,
  };
}
