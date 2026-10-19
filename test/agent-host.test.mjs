import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION } from "@earendil-works/pi-coding-agent";
import { TOOL_CATALOG } from "../electron/tool-registry.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const hostUrl = new URL("../electron/agent-host.mjs", import.meta.url).href;
const childSource = `
  process.parentPort = {
    postMessage: (message) => process.send(message),
    on: (name, handler) => process.on(name, (data) => handler({ data })),
  };
  await import(${JSON.stringify(hostUrl)});
`;

function startHost(agentDir) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", childSource], {
    cwd: projectRoot,
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const events = [];
  const pending = new Map();
  let sequence = 0;
  let diagnostics = "";
  child.stderr.on("data", (data) => { diagnostics += data; });
  child.stdout.resume();
  child.on("message", (message) => {
    if (message.kind === "event") events.push(message.event);
    if (message.kind !== "response") return;
    const operation = pending.get(message.requestId);
    if (!operation) return;
    pending.delete(message.requestId);
    clearTimeout(operation.timeout);
    if (message.ok) operation.resolve(message.result);
    else operation.reject(new Error(message.error));
  });
  child.on("exit", (code) => {
    for (const operation of pending.values()) {
      clearTimeout(operation.timeout);
      operation.reject(new Error(`Agent Host exited (${code}): ${diagnostics}`));
    }
    pending.clear();
  });
  return {
    events,
    command(command) {
      const requestId = `test-${++sequence}`;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId);
          reject(new Error(`Agent Host timed out: ${command.type}\n${diagnostics}`));
        }, 20_000);
        pending.set(requestId, { resolve, reject, timeout });
        child.send({ kind: "command", requestId, command });
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, "exit");
      child.kill();
      await exited;
    },
  };
}

async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await delay(20);
  }
  throw new Error("Expected Agent Host event was not received");
}

test("provider checks use draft config without saving credentials or creating a chat", { timeout: 45_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-provider-check-"));
  const agentDir = path.join(root, "agent");
  await mkdir(agentDir);
  let host;
  let status = 200;
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, key: request.headers.authorization, body: body && JSON.parse(body) });
    if (status !== 200) {
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Insufficient Balance ${request.headers.authorization}` } }));
    } else if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "check-chat" }, { id: "not-in-pi" }] }));
    } else {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ id: "check", object: "chat.completion.chunk", model: "check-chat", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    }
  });
  t.after(async () => {
    await host?.stop();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: {
    baseUrl, api: "openai-completions", models: [{ id: "check-chat", name: "Check Chat", reasoning: false, input: ["text"],
      contextWindow: 32000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  host = startHost(agentDir);
  await host.command({ type: "saveModelSettings", providerId: "openai", modelId: "check-chat", baseUrl, apiKey: "saved-key" });
  const authBefore = await readFile(path.join(agentDir, "auth.json"), "utf8");
  const modelsBefore = await readFile(path.join(agentDir, "models.json"), "utf8");
  const eventCountBefore = host.events.length;
  const draft = { providerId: "openai", modelId: "check-chat", baseUrl: `${baseUrl}/draft`, apiKey: "draft-key" };
  const tested = await host.command({ type: "testModelSettings", ...draft });
  assert.equal(tested.ok, true, JSON.stringify(tested));
  assert.equal(requests[0].url, "/v1/draft/chat/completions");
  assert.equal(requests[0].key, "Bearer draft-key");
  assert.equal(requests[0].body.messages.length, 1);
  assert.deepEqual(requests[0].body.messages[0].content, [{ type: "text", text: "Reply with OK only." }]);
  assert.ok(!requests[0].body.tools?.length);
  const catalog = await host.command({ type: "fetchProviderModels", ...draft });
  assert.equal(catalog.ok, true, JSON.stringify(catalog));
  assert.equal(requests.at(-1).url, "/v1/draft/models");
  assert.equal(catalog.models.find((model) => model.id === "check-chat").selectable, true);
  assert.equal(catalog.models.find((model) => model.id === "not-in-pi").selectable, false);
  const stored = await host.command({ type: "fetchProviderModels", providerId: "openai", modelId: "check-chat" });
  assert.equal(stored.ok, true, JSON.stringify(stored));
  assert.equal(requests.at(-1).key, "Bearer saved-key");
  assert.equal(requests.at(-1).url, "/v1/models");
  status = 402;
  const failed = await host.command({ type: "testModelSettings", ...draft });
  assert.equal(failed.ok, false);
  assert.match(failed.error.message, /余额或额度不足/);
  assert.ok(!JSON.stringify(failed).includes("draft-key"));
  assert.equal(await readFile(path.join(agentDir, "auth.json"), "utf8"), authBefore);
  assert.equal(await readFile(path.join(agentDir, "models.json"), "utf8"), modelsBefore);
  assert.equal((await host.command({ type: "getModelSettings" })).currentModel, null);
  assert.equal(host.events.length, eventCountBefore, "Provider checks must not emit chat or settings changes");
});

test("Pi upgrade preserves the real Host protocol, permissions, attachments and sessions", { timeout: 90_000 }, async (t) => {
  assert.equal(VERSION, "1.3.0");
  assert.ok(TOOL_CATALOG.every((tool) => tool.version === VERSION));
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-host-"));
  const agentDir = path.join(root, "agent");
  const workspace = path.join(root, "workspace");
  await mkdir(agentDir);
  await mkdir(workspace);
  await writeFile(path.join(workspace, "notes.txt"), "original content");
  const requests = [];
  const responses = [];
  let host;
  let heldResponse;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push(JSON.parse(body));
    const next = responses.shift();
    if (next?.error) {
      response.writeHead(next.status, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: { message: next.error, type: "invalid_request_error" } }));
      return;
    }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finishReason = null) => response.write(`data: ${JSON.stringify({
      id: "desktop-smoke", object: "chat.completion.chunk", model: "desktop-smoke",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    })}\n\n`);
    chunk({ role: "assistant" });
    if (next?.hold) {
      chunk({ content: "Working" });
      heldResponse = response;
      return;
    }
    if (next?.tools) {
      chunk({ tool_calls: next.tools.map(([name, args], index) => ({
        index, id: `call-${requests.length}-${index}`, type: "function",
        function: { name, arguments: JSON.stringify(args) },
      })) });
      chunk({}, "tool_calls");
    } else {
      chunk({ reasoning_content: "Checking the result." });
      chunk({ content: next?.text || "Done." });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  t.after(async () => {
    await host?.stop();
    heldResponse?.destroy();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: {
    baseUrl, api: "openai-completions",
    models: [{ id: "desktop-smoke", name: "Desktop Smoke", reasoning: true, input: ["text", "image"],
      contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: false } }));
  host = startHost(agentDir);
  await host.command({ type: "saveModelSettings", providerId: "openai", modelId: "desktop-smoke", baseUrl, apiKey: "local-test-key" });
  const initialize = (extra = {}) => host.command({ type: "initialize", cwd: workspace,
    tools: ["read", "write", "edit", "bash"], modelValue: "openai::desktop-smoke", permissionMode: "read-only", ...extra });
  const connected = await initialize();
  assert.equal(connected.permissionMode, "read-only");
  assert.equal(connected.model.id, "desktop-smoke");
  assert.equal(connected.authenticated, true);
  assert.equal(connected.availableModels.find((model) => model.id === "desktop-smoke").input.includes("image"), true);

  responses.push({ tools: [["read", { path: "notes.txt" }]] }, { text: "Read complete." });
  const first = await host.command({ type: "prompt", text: "Read the notes", attachments: [
    { id: "text", kind: "text", name: "context.md", mimeType: "text/markdown", content: "attachment context", size: 18 },
    { id: "image", kind: "image", name: "pixel.png", mimeType: "image/png", size: 70,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==" },
  ] });
  assert.ok(host.events.some((event) => event.type === "message.delta" && event.text.includes("Read complete")));
  assert.ok(host.events.some((event) => event.type === "reasoning.delta"));
  assert.ok(host.events.some((event) => event.type === "tool.completed" && event.output.includes("original content")));
  const userInput = requests[0].messages.filter((message) => message.role === "user");
  assert.match(JSON.stringify(userInput), /data:image\/(png|jpeg|webp);base64,/);
  assert.ok(JSON.stringify(requests[0].messages).includes("attachment context"));
  await access(first.sessionFile);

  responses.push({ tools: [["write", { path: "blocked.txt", content: "blocked" }]] }, { text: "Write blocked." });
  await host.command({ type: "prompt", text: "Try a write" });
  await assert.rejects(access(path.join(workspace, "blocked.txt")), { code: "ENOENT" });
  assert.ok(host.events.some((event) => event.type === "tool.completed" && event.isError && event.output.includes("只读模式")));

  await host.command({ type: "setPermissionMode", mode: "ask" });
  responses.push({ tools: [["write", { path: "approved.txt", content: "approved" }]] }, { text: "Write approved." });
  const prompt = host.command({ type: "prompt", text: "Write after approval" });
  const approval = await waitFor(() => host.events.find((event) => event.type === "approval.requested"));
  await assert.rejects(access(path.join(workspace, "approved.txt")), { code: "ENOENT" });
  await host.command({ type: "approvalResponse", requestId: approval.requestId, approved: true });
  await prompt;
  assert.equal(await readFile(path.join(workspace, "approved.txt"), "utf8"), "approved");

  await host.command({ type: "setPermissionMode", mode: "full" });
  const approvalsBeforeFull = host.events.filter((event) => event.type === "approval.requested").length;
  responses.push({ tools: [["edit", { path: "approved.txt", edits: [{ oldText: "approved", newText: "edited" }] }], ["bash", { command: "printf desktop-smoke" }]] }, { text: "Tools complete." });
  await host.command({ type: "prompt", text: "Edit and run a command" });
  assert.equal(await readFile(path.join(workspace, "approved.txt"), "utf8"), "edited");
  assert.ok(host.events.some((event) => event.type === "tool.completed" && event.output.includes("desktop-smoke")));
  assert.equal(host.events.filter((event) => event.type === "approval.requested").length, approvalsBeforeFull);
  assert.equal((await host.command({ type: "getWorkspace" })).permissionMode, "full");
  await host.command({ type: "renameSession", sessionId: first.sessionId, sessionFile: first.sessionFile, name: "Upgrade smoke" });
  const installed = await host.command({ type: "installSkill", catalogId: "project-overview", skillName: "project-overview" });
  assert.ok(installed.skills.some((skill) => skill.name === "project-overview" && skill.installed));
  const skillCommand = "/skill:project-overview Summarize the workspace";
  responses.push({ text: "Skill complete." });
  const skillRun = await host.command({ type: "prompt", text: skillCommand, attachments: [
    { id: "skill-context", kind: "text", name: "scope.md", mimeType: "text/markdown", content: "Only summarize notes.txt", size: 24 },
  ] });
  const skillUser = skillRun.messages.filter((message) => message.role === "user").at(-1);
  assert.equal(skillUser.text, skillCommand);
  assert.equal(skillUser.attachments[0].name, "scope.md");
  const modelSkillInput = JSON.stringify(requests.at(-1).messages.filter((message) => message.role === "user").at(-1));
  assert.ok(modelSkillInput.includes('<skill name=\\"project-overview\\"'));
  assert.ok(modelSkillInput.includes("Only summarize notes.txt"));
  assert.match(await readFile(skillRun.sessionFile, "utf8"), /<skill name=/);
  const skillSaved = host.events.filter((event) => event.type === "session.updated").at(-1);
  assert.equal(skillSaved.messages.filter((message) => message.role === "user").at(-1).text, skillCommand);
  const removed = await host.command({ type: "removeSkill", name: "project-overview" });
  assert.ok(removed.skills.some((skill) => skill.name === "project-overview" && !skill.installed));
  await host.stop();

  host = startHost(agentDir);
  const settings = await host.command({ type: "getModelSettings" });
  assert.ok(settings.providers.find((provider) => provider.id === "openai").configured);
  assert.equal(settings.providers.find((provider) => provider.id === "openai").baseUrl, baseUrl);
  const restored = await initialize({ sessionFile: first.sessionFile });
  assert.equal(restored.sessionId, first.sessionId);
  const restoredSkill = restored.messages.find((message) => message.role === "user" && message.text === skillCommand);
  assert.equal(restoredSkill.attachments[0].name, "scope.md");
  const user = restored.messages.find((message) => message.role === "user");
  assert.equal(user.attachments.length, 2);
  assert.ok(user.attachments.find((item) => item.kind === "image").data);
  const activities = restored.messages.flatMap((message) => message.activities || []);
  assert.ok(activities.some((activity) => activity.kind === "reasoning" && activity.output.includes("Checking")));
  assert.ok(activities.some((activity) => activity.kind === "tool" && activity.output.includes("original content")));
  const listed = await host.command({ type: "listSessions" });
  assert.ok(listed.sessions.some((item) => item.title === "Upgrade smoke"));
  responses.push({ text: "Resumed." });
  await host.command({ type: "prompt", text: "Continue" });
  assert.ok(host.events.some((event) => event.type === "message.delta" && event.text.includes("Resumed")));

  responses.push({ hold: true });
  const active = host.command({ type: "prompt", text: "Wait for cancellation" });
  await waitFor(() => host.events.find((event) => event.type === "message.delta" && event.text === "Working"));
  const liveWorkspace = await host.command({ type: "getWorkspace" });
  assert.equal(liveWorkspace.running, true);
  const savedEvent = host.events.filter((event) => event.type === "session.updated").at(-1);
  assert.equal(savedEvent.sessionId, restored.sessionId);
  assert.ok(savedEvent.messages.some((message) => message.role === "user" && message.text === "Wait for cancellation"));
  assert.match(await readFile(savedEvent.sessionFile, "utf8"), /Wait for cancellation/);
  await assert.rejects(host.command({ type: "assertSessionIdle" }), /会话正在运行/);
  await assert.rejects(initialize(), /会话正在运行/);
  await assert.rejects(host.command({ type: "exportSession", format: "html" }), /会话正在运行/);
  await host.command({ type: "abort" });
  await active;
  assert.equal(host.events.filter((event) => event.type === "run.settled").at(-1).status, "aborted");

  // The previous SDK (0.84.1) used version 3 JSONL and the single-edit argument shape.
  const legacyFile = path.join(root, "legacy-session.jsonl");
  const timestamp = Date.now() - 60_000;
  const iso = new Date(timestamp).toISOString();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const entries = [{ type: "session", version: 3, id: "legacy-session", timestamp: iso, cwd: workspace }];
  const append = (message) => entries.push({ type: "message", id: `legacy-${entries.length}`,
    parentId: entries.length === 1 ? null : entries.at(-1).id, timestamp: iso, message });
  append({ role: "user", content: "Old session", timestamp });
  append({ role: "assistant", content: [
    { type: "thinking", thinking: "Legacy reasoning" },
    { type: "toolCall", id: "legacy-edit", name: "edit", arguments: { path: "notes.txt", oldText: "a", newText: "b" } },
  ], api: "openai-completions", provider: "openai", model: "desktop-smoke", usage, stopReason: "toolUse", timestamp });
  append({ role: "toolResult", toolCallId: "legacy-edit", toolName: "edit",
    content: [{ type: "text", text: "Legacy edit result" }], isError: false, timestamp });
  append({ role: "assistant", content: [{ type: "text", text: "Legacy reply" }], api: "openai-completions",
    provider: "openai", model: "desktop-smoke", usage, stopReason: "stop", timestamp });
  await writeFile(legacyFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const legacy = await initialize({ sessionFile: legacyFile });
  assert.equal(legacy.sessionId, "legacy-session");
  const oldReply = legacy.messages.find((message) => message.role === "assistant");
  assert.equal(oldReply.text, "Legacy reply");
  assert.ok(oldReply.activities.some((activity) => activity.output === "Legacy reasoning"));
  assert.ok(oldReply.activities.some((activity) => activity.output === "Legacy edit result" && activity.status === "done"));
  responses.push({ text: "Legacy continued." });
  await host.command({ type: "prompt", text: "Continue old session" });
  assert.ok(host.events.some((event) => event.type === "message.delta" && event.text.includes("Legacy continued")));

  await initialize({ tools: [] });
  responses.push({ text: "No tools enabled." });
  await host.command({ type: "prompt", text: "Reply without tools" });
  assert.equal(requests.at(-1).tools?.length || 0, 0);

  // Provider failures are returned as assistant messages by Pi, not thrown exceptions.
  for (const [status, error, expected] of [
    [402, "Insufficient Balance", "余额或额度不足"],
    [401, "Invalid API Key", "认证失败"],
    [429, "Rate limit exceeded", "频率限制"],
  ]) {
    const eventStart = host.events.length;
    responses.push({ status, error });
    const failed = await host.command({ type: "prompt", text: `Request failing with ${status}` });
    const events = host.events.slice(eventStart);
    assert.equal(failed.status, "error");
    assert.equal(events.filter((event) => event.type === "run.settled").length, 1);
    assert.equal(events.find((event) => event.type === "run.settled").status, "error");
    assert.ok(events.find((event) => event.type === "runtime.error").message.includes(expected));
    const failure = events.find((event) => event.type === "message.error");
    assert.ok(failure.error.details.includes(error));
    assert.equal(failure.runId, failed.runId);
    assert.equal(failed.messages.at(-1).status, "error");
    assert.deepEqual(failed.messages.at(-1).error, failure.error);

    await host.stop();
    host = startHost(agentDir);
    const restoredFailure = await initialize({ sessionFile: failed.sessionFile, tools: [] });
    assert.deepEqual(restoredFailure.messages.at(-1).error, failure.error);
    assert.equal(restoredFailure.messages.at(-1).status, "error");
    responses.push({ text: "Recovered after failure." });
    const recovered = await host.command({ type: "prompt", text: "Try again" });
    assert.equal(recovered.status, "completed");
    assert.equal(recovered.messages.at(-1).error, undefined);
    assert.ok(recovered.messages.at(-1).text.includes("Recovered after failure"));
  }

  await writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 10 } }));
  await initialize({ tools: [] });
  const retryStart = host.events.length;
  responses.push({ status: 429, error: "Rate limit exceeded" }, { text: "Automatic retry succeeded." });
  const retried = await host.command({ type: "prompt", text: "Recover with automatic retry" });
  assert.equal(retried.status, "completed");
  assert.equal(retried.messages.at(-1).error, undefined);
  assert.ok(retried.messages.at(-1).text.includes("Automatic retry succeeded"));
  assert.equal(host.events.slice(retryStart).some((event) => event.type === "message.error"), false);
});
