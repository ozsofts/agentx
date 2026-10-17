import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app } from "electron";

// Exercise the production renderer, preload, main IPC and real utility process.
// All Desktop and Pi state is isolated from the user's settings and sessions.
const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-electron-"));
const agentDir = path.join(root, "agent");
const userData = path.join(root, "desktop");
const workspace = path.join(root, "workspace");
await Promise.all([agentDir, userData, workspace].map((directory) => mkdir(directory)));
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the local test request. */ }
  response.writeHead(402, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ error: { message: "Insufficient Balance", type: "invalid_request_error" } }));
});
modelServer.listen(0, "127.0.0.1");
await once(modelServer, "listening");
const baseUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
await writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { openai: {
  baseUrl, api: "openai-completions", models: [{ id: "error-smoke", name: "Error Smoke", input: ["text"],
    contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
} } }));
app.setPath("userData", userData);
process.env.PI_CODING_AGENT_DIR = agentDir;
let exitCode = 1;
const deadline = setTimeout(() => {
  console.error("[desktop-smoke] Timed out");
  app.quit();
}, 30_000);
app.once("will-quit", async (event) => {
  event.preventDefault();
  clearTimeout(deadline);
  try {
    modelServer.closeAllConnections();
    await new Promise((resolve) => modelServer.close(resolve));
    await rm(root, { recursive: true, force: true });
  } finally {
    app.exit(exitCode);
  }
});
app.once("browser-window-created", (_event, window) => {
  window.webContents.once("did-finish-load", async () => {
    try {
      let mounted = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        mounted = await window.webContents.executeJavaScript("Boolean(document.querySelector('#root')?.children.length)");
        if (mounted) break;
        await delay(100);
      }
      assert.ok(mounted, "Production renderer did not mount");
      const invoke = (method, argument) => window.webContents.executeJavaScript(
        `window.piDesktop[${JSON.stringify(method)}](${JSON.stringify(argument)})`,
      );
      const catalog = await invoke("listTools");
      assert.ok(catalog.tools.every((tool) => tool.version === "1.3.0"));
      await invoke("command", { type: "saveModelSettings", providerId: "openai", modelId: "error-smoke", baseUrl, apiKey: "local-test-key" });
      const created = await invoke("projectCommand", { type: "create", rootPath: workspace, name: "Upgrade smoke" });
      const opened = await invoke("projectCommand", { type: "open", projectId: created.project.id });
      assert.equal(opened.workspace.cwd, workspace);
      assert.ok(opened.workspace.sessionId);
      const skills = await invoke("command", { type: "listSkills" });
      assert.ok(skills.skills.length > 0);
      const changes = await invoke("command", { type: "getChanges" });
      assert.ok(Array.isArray(changes.files));
      const restored = await invoke("restoreWorkspace");
      assert.equal(restored.cwd, workspace);
      await invoke("command", { type: "setModel", providerId: "openai", modelId: "error-smoke" });
      const failed = await invoke("command", { type: "prompt", text: "Local billing-error smoke test" });
      assert.equal(failed.status, "error");
      const visibleError = async (requireBanner = true) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const visible = await window.webContents.executeJavaScript(`(() => {
            const card = document.querySelector('.message-error');
            return Boolean(card?.textContent.includes('余额或额度不足') && card.textContent.includes('Insufficient Balance')
              && (${requireBanner} ? document.querySelector('.runtime-banner.is-error') : true)
              && !document.querySelector('.working-state, .stop-button, .composer.is-running'));
          })()`);
          if (visible) return;
          await delay(100);
        }
        assert.fail("The model failure was not visible in the renderer");
      };
      await visibleError();
      await window.webContents.executeJavaScript("document.querySelector('.message-error details').open = true");
      await delay(100);
      await writeFile(path.join(os.tmpdir(), "pi-desktop-request-error.png"), (await window.webContents.capturePage()).toPNG());
      const reloaded = await invoke("restoreWorkspace");
      assert.equal(reloaded.messages.at(-1).status, "error");
      await visibleError(false);
      console.log("[desktop-smoke] PASS: production renderer, preload, IPC, Pi 1.3.0 utility process, projects, skills, live HTTP 402 error display and session restore");
      exitCode = 0;
    } catch (error) {
      console.error("[desktop-smoke] FAIL:", error);
    } finally {
      app.quit();
    }
  });
});
await import("../electron/main.mjs");
