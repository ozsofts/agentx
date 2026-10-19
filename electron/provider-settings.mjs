import { describeRequestError } from "./request-error.mjs";

const TIMEOUT_MS = 15_000;

export function modelDiscoverySupport(provider, models) {
  const apis = new Set(models.map((model) => model.api));
  if (provider.id === "google") return { supported: true, protocol: "google" };
  if (provider.auth?.apiKey && apis.size && [...apis].every((api) => api === "anthropic-messages")) {
    return { supported: true, protocol: "anthropic" };
  }
  if (provider.auth?.apiKey && apis.size && [...apis].every((api) => ["openai-completions", "openai-responses"].includes(api))) {
    return { supported: true, protocol: "openai" };
  }
  return { supported: false, reason: "此供应商暂未适配模型列表接口，可继续使用内置模型目录并测试当前模型。" };
}

function redact(value, secrets) {
  let result = String(value || "");
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join("[已隐藏]");
    result = result.split(encodeURIComponent(secret)).join("[已隐藏]");
  }
  return result.replace(/(Bearer\s+)[^\s"',}]+/gi, "$1[已隐藏]")
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, "$1[已隐藏]").slice(0, 4000);
}

function validateBaseUrl(value) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Base URL 只支持 HTTP 或 HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("Base URL 不能包含账号密码、查询参数或片段");
  return url.href.replace(/\/$/, "");
}

async function readJson(response) {
  if (Number(response.headers.get("content-length")) > 5 * 1024 * 1024) throw new Error("供应商返回的模型列表过大");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 5 * 1024 * 1024) throw new Error("供应商返回的模型列表过大");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 4000)}`);
  try { return JSON.parse(text); } catch { throw new Error("供应商未返回有效的 JSON 模型列表，请检查 Base URL"); }
}

// Runs with Host-only credentials. Neither operation saves a draft, switches a
// session model, nor sends project/chat content to the provider.
export async function runProviderOperation(runtime, command, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const secrets = [String(command.apiKey || "").trim()];
  let timer;
  const startedAt = Date.now();
  try {
    const operation = (async () => {
      const provider = runtime.getProvider(command.providerId);
      if (!provider) throw new Error("请选择有效的供应商");
      const models = runtime.getModels(provider.id);
      const model = runtime.getModel(provider.id, command.modelId) || models[0];
      if (!model) throw new Error("此供应商没有可用的对话模型");
      const discovery = modelDiscoverySupport(provider, models);
      if (command.type === "fetchProviderModels" && !discovery.supported) throw new Error(discovery.reason);
      if (command.type === "testModelSettings" && !runtime.getModel(provider.id, command.modelId)) throw new Error("请先选择 Agentx 支持的对话模型");
      const resolution = await runtime.getAuth(model, { apiKey: secrets[0] || undefined, signal: controller.signal });
      if (!resolution) throw new Error("请填写 API Key，或先配置此供应商的认证");
      const auth = resolution.auth;
      secrets.push(auth.apiKey, ...Object.values(auth.headers || {}).filter((value) => typeof value === "string"));
      for (const [name, value] of Object.entries(auth.headers || {})) {
        if (typeof value !== "string") continue;
        if (/authorization/i.test(name)) secrets.push(value.replace(/^Bearer\s+/i, ""));
      }
      const baseUrl = validateBaseUrl(String(command.baseUrl || "").trim() || auth.baseUrl || provider.baseUrl || model.baseUrl);
      controller.signal.throwIfAborted();
      if (command.type === "testModelSettings") {
        const result = await provider.streamSimple({ ...model, baseUrl }, {
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with OK only." }], timestamp: Date.now() }],
        }, {
          apiKey: auth.apiKey, headers: auth.headers, env: resolution.env,
          signal: controller.signal, maxTokens: 32, timeoutMs, maxRetries: 0, transport: "sse",
        }).result();
        if (result.stopReason === "error" || result.stopReason === "aborted") throw new Error(result.errorMessage || "测试请求未能完成");
        if (!(result.content || []).some((item) => item.type === "text" && item.text?.trim())) {
          throw new Error("接口已响应，但未返回可见文本；请检查模型兼容性或输出额度后重试");
        }
        return { ok: true, providerId: provider.id, modelId: model.id, elapsedMs: Date.now() - startedAt,
          message: "测试成功，当前模型已返回文本。配置尚未自动保存。" };
      }

      const headers = new Headers();
      if (auth.apiKey) {
        if (discovery.protocol === "anthropic") headers.set("x-api-key", auth.apiKey);
        else if (discovery.protocol === "google") headers.set("x-goog-api-key", auth.apiKey);
        else headers.set("authorization", `Bearer ${auth.apiKey}`);
      }
      if (discovery.protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
      for (const [name, value] of Object.entries(auth.headers || {})) {
        if (value === null) headers.delete(name);
        else headers.set(name, value);
      }
      const prefix = discovery.protocol === "anthropic" && !/\/v1$/.test(baseUrl) ? "/v1"
        : discovery.protocol === "google" && !/\/v\d+(?:beta\d*)?$/.test(baseUrl) ? "/v1beta" : "";
      const endpoint = `${baseUrl}${prefix}/models`;
      const found = new Map();
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 100; page += 1) {
        const url = new URL(endpoint);
        if (discovery.protocol === "google") url.searchParams.set("pageSize", "1000");
        if (discovery.protocol === "anthropic") url.searchParams.set("limit", "1000");
        if (cursor) url.searchParams.set(discovery.protocol === "google" ? "pageToken" : discovery.protocol === "anthropic" ? "after_id" : "after", cursor);
        const response = await fetchImpl(url, { headers, signal: controller.signal, redirect: "error" });
        const payload = await readJson(response);
        const items = discovery.protocol === "google" ? payload.models : payload.data;
        if (!Array.isArray(items)) throw new Error("供应商返回的模型列表格式不兼容");
        for (const item of items) {
          const id = discovery.protocol === "google" ? item.name?.replace(/^models\//, "") : item.id;
          if (typeof id !== "string" || !id || id.length > 500) continue;
          const known = runtime.getModel(provider.id, id);
          const supported = discovery.protocol !== "google" || !Array.isArray(item.supportedGenerationMethods)
            || item.supportedGenerationMethods.includes("generateContent");
          found.set(id, { id, name: String(item.display_name || item.displayName || known?.name || id).slice(0, 500),
            selectable: Boolean(known && supported), reason: !supported ? "非对话模型" : !known ? "尚未收录到内置对话模型目录" : "Agentx 已支持" });
        }
        cursor = discovery.protocol === "google" ? payload.nextPageToken
          : payload.has_more ? payload.last_id || items.at(-1)?.id : undefined;
        if (!cursor && payload.has_more) throw new Error("模型列表分页缺少游标，无法确认已获取完整列表");
        if (!cursor) return { ok: true, providerId: provider.id, models: [...found.values()].sort((a, b) => a.id.localeCompare(b.id)), fetchedAt: Date.now(),
          message: `已从供应商获取 ${found.size} 个模型；列表可见不代表每个模型都拥有调用额度。` };
        if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("供应商返回了无效的模型分页游标");
        cursors.add(cursor);
      }
      throw new Error("模型列表超过分页上限，请缩小供应商返回范围后重试");
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Error("请求超时，请检查网络和 Base URL")); }, timeoutMs);
    });
    return await Promise.race([operation, timeout]);
  } catch (error) {
    const details = redact(error.message, secrets);
    const friendly = describeRequestError(details).message;
    return { ok: false, error: { message: friendly === "模型请求失败，请查看错误详情。" ? details : friendly, details } };
  } finally { clearTimeout(timer); }
}
