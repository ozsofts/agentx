import assert from "node:assert/strict";
import test from "node:test";
import { modelDiscoverySupport, runProviderOperation } from "../electron/provider-settings.mjs";

function fixture(id, api) {
  const model = { id: "known-chat", name: "Known chat", provider: id, api, baseUrl: "https://provider.test" };
  const provider = { id, auth: { apiKey: {} }, baseUrl: model.baseUrl };
  return {
    getProvider: (value) => value === id ? provider : undefined,
    getModels: () => [model],
    getModel: (_provider, value) => value === model.id ? model : undefined,
    getAuth: async (_model, overrides) => ({ auth: { apiKey: overrides.apiKey || "stored-secret" } }),
  };
}

test("live catalogs use provider-specific auth, pagination and Pi compatibility", async () => {
  for (const [id, api, endpoint, header, cursor] of [
    ["openai", "openai-responses", "/v1/models", "authorization", "after"],
    ["anthropic", "anthropic-messages", "/v1/models", "x-api-key", "after_id"],
    ["google", "google-generative-ai", "/v1beta/models", "x-goog-api-key", "pageToken"],
  ]) {
    const runtime = fixture(id, api);
    const requests = [];
    const result = await runProviderOperation(runtime, { type: "fetchProviderModels", providerId: id,
      baseUrl: id === "openai" ? "https://provider.test/v1/" : "https://provider.test", apiKey: "draft-secret" }, {
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        assert.equal(url.pathname, endpoint);
        assert.equal(options.headers.get(header), id === "openai" ? "Bearer draft-secret" : "draft-secret");
        assert.equal(options.redirect, "error");
        if (requests.length === 1) return Response.json(id === "google"
          ? { models: [{ name: "models/known-chat", supportedGenerationMethods: ["generateContent"] }], nextPageToken: "next" }
          : { data: [{ id: "known-chat" }], has_more: true, last_id: "next" });
        assert.equal(url.searchParams.get(cursor), "next");
        return Response.json(id === "google"
          ? { models: [{ name: "models/new-embedding", supportedGenerationMethods: ["embedContent"] }] }
          : { data: [{ id: "new-embedding" }, { id: "known-chat" }], has_more: false });
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(requests.length, 2);
    assert.equal(result.models.length, 2);
    assert.equal(result.models.find((model) => model.id === "known-chat").selectable, true);
    assert.equal(result.models.find((model) => model.id === "new-embedding").selectable, false);
    assert.ok(!JSON.stringify(result).includes("secret"));
  }
});

test("catalog failures are readable, redacted, bounded and preserve unsupported providers", async () => {
  const runtime = fixture("openai", "openai-responses");
  const command = { type: "fetchProviderModels", providerId: "openai" };
  const failure = await runProviderOperation(runtime, command, {
    fetchImpl: async () => new Response(JSON.stringify({ error: "invalid api key: stored-secret" }), { status: 401 }),
  });
  assert.equal(failure.ok, false);
  assert.match(failure.error.message, /认证失败/);
  assert.ok(!JSON.stringify(failure).includes("stored-secret"));
  assert.match(failure.error.details, /已隐藏/);
  const timeout = await runProviderOperation(runtime, command, { timeoutMs: 20,
    fetchImpl: (_url, options) => new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new Error("timeout")))),
  });
  assert.equal(timeout.ok, false);
  assert.match(timeout.error.message, /超时/);
  const repeated = await runProviderOperation(runtime, command, {
    fetchImpl: async () => Response.json({ data: [{ id: "known-chat" }], has_more: true, last_id: "same" }),
  });
  assert.equal(repeated.ok, false);
  assert.match(repeated.error.message, /分页游标/);
  const invalid = await runProviderOperation(runtime, { ...command, baseUrl: "file:///secret" });
  assert.match(invalid.error.message, /HTTP/);
  const unsupported = fixture("amazon-bedrock", "bedrock-converse-stream");
  assert.equal(modelDiscoverySupport(unsupported.getProvider("amazon-bedrock"), unsupported.getModels()).supported, false);
  assert.match((await runProviderOperation(unsupported, { ...command, providerId: "amazon-bedrock" })).error.message, /暂未适配/);
});
