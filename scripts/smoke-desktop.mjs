import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { app, dialog, Menu, webContents } from "electron";

// Exercise the production renderer, preload, main IPC and real utility process.
// All Desktop and Pi state is isolated from the user's settings and sessions.
const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-electron-"));
const agentDir = path.join(root, "agent");
const userData = path.join(root, "desktop");
const workspace = path.join(root, "workspace");
await Promise.all([agentDir, userData, workspace].map((directory) => mkdir(directory)));
await mkdir(path.join(workspace, "assets"));
const previewFiles = ["README.md", "diagram.svg", "pixel.png", "flow.mmd", "index.html"];
await Promise.all([
  writeFile(path.join(workspace, "README.md"), '# 预览工作面板\n\n| 类型 | 状态 |\n| --- | --- |\n| Markdown | 已接入 |\n\n![图](assets/chart.svg)\n\n```mermaid\nflowchart LR\n A[文件] --> B[预览]\n```'),
  writeFile(path.join(workspace, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140"><rect width="240" height="140" fill="#e5f3eb"/><text x="30" y="75">Static SVG</text><script>window.svgRan=true</script></svg>'),
  writeFile(path.join(workspace, "assets/chart.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="60"><rect width="180" height="60" fill="#def0e5"/></svg>'),
  writeFile(path.join(workspace, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN1kAAAAASUVORK5CYII=", "base64")),
  writeFile(path.join(workspace, "flow.mmd"), "flowchart LR\n A[文件] --> B[预览] --> C[自动刷新]"),
  writeFile(path.join(workspace, "style.css"), "body { background: rgb(230, 240, 250); }"),
  writeFile(path.join(workspace, "index.html"), '<link rel="stylesheet" href="style.css"><h1>HTML relative assets</h1><img style="position:absolute;left:20px;top:100px" src="assets/chart.svg"><script>document.body.style.background="red";window.previewScriptRan=true</script>'),
]);
let importFile;
let saveFile;
dialog.showOpenDialog = async (_window, options) => ({ canceled: false, filePaths: options.title === "导入 Agentx 会话" ? [importFile] : previewFiles.map((file) => path.join(workspace, file)) });
dialog.showSaveDialog = async (_window, options) => ({ canceled: false, filePath: saveFile || path.join(root, `backup.${options.filters[0].extensions[0]}`) });
const modelResponses = [];
const heldResponses = [];
const modelServer = createServer(async (request, response) => {
  for await (const _chunk of request) { /* Consume the local test request. */ }
  if (request.method === "GET" && request.url.startsWith("/browser/")) {
    response.writeHead(200, { "Content-Type": "text/html", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'" });
    response.end(`<title>Browser ${request.url.split("/").at(-1)}</title><body style="background:#e5f3eb"><h1>Native browser preview</h1><a id="next" href="/browser/second">Next</a><a id="popup" href="/browser/popup" target="_blank">Popup</a><script>window.browserScriptRan = true</script></body>`);
    return;
  }
  if (request.method === "GET" && request.url === "/v1/models") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "error-smoke" }, { id: "unknown-remote" }] }));
    return;
  }
  if (modelResponses.length) {
    const next = modelResponses.shift();
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish = null) => response.write(`data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", model: "error-smoke", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: "assistant" });
    if (next.hold) {
      chunk({ content: next.text });
      heldResponses.push(() => { chunk({ content: " Finished." }, "stop"); response.end("data: [DONE]\n\n"); });
      return;
    }
    if (next.text) {
      chunk({ content: next.text }, "stop");
      response.end("data: [DONE]\n\n");
      return;
    }
    chunk({ tool_calls: [{ index: 0, id: `write-${Date.now()}`, type: "function", function: { name: "write", arguments: JSON.stringify({ path: "full-access.txt", content: "Written without confirmation" }) } }] }, "tool_calls");
    response.end("data: [DONE]\n\n");
    return;
  }
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
}, 60_000);
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
      assert.equal(app.isPackaged, false, "The local branded runtime must remain an unpackaged Electron runtime");
      assert.equal(app.getName(), "Agentx");
      assert.equal(app.getPath("userData"), userData, "Branding changed the existing Desktop data directory");
      if (process.platform === "darwin") {
        assert.equal(Menu.getApplicationMenu().items[0].label, "Agentx");
        const nativeName = execFileSync("/usr/bin/osascript", ["-l", "JavaScript", "-e",
          `ObjC.import('AppKit'); ObjC.unwrap($.NSRunningApplication.runningApplicationWithProcessIdentifier(${process.pid}).localizedName);`,
        ], { encoding: "utf8" }).trim();
        assert.equal(nativeName, "Agentx", "macOS still identifies the running app as Electron in its menu/Dock");
      }
      assert.equal(window.getTitle(), "Agentx");
      assert.equal(await window.webContents.executeJavaScript("document.title"), "Agentx");
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.brand-name').textContent"), "Agentx");
      assert.equal(await window.webContents.executeJavaScript("document.querySelector('.composer textarea').placeholder"), "给 Agentx 一个任务");
      console.log("[desktop-smoke] PASS: native macOS Agentx identity, app/menu/window/renderer branding and unchanged userData");
      const invoke = (method, argument) => window.webContents.executeJavaScript(
        `window.piDesktop[${JSON.stringify(method)}](${JSON.stringify(argument)})`,
      );
      const catalog = await invoke("listTools");
      assert.ok(catalog.tools.every((tool) => tool.version === "1.3.0"));
      await invoke("command", { type: "saveModelSettings", providerId: "openai", modelId: "error-smoke", baseUrl, apiKey: "local-test-key" });
      const created = await invoke("projectCommand", { type: "create", rootPath: workspace, name: "Upgrade smoke" });
      await invoke("projectCommand", { type: "update", projectId: created.project.id, patch: { settings: { model: "openai::error-smoke" } } });
      const opened = await invoke("projectCommand", { type: "open", projectId: created.project.id });
      assert.equal(opened.workspace.cwd, workspace);
      assert.ok(opened.workspace.sessionId);
      const skills = await invoke("command", { type: "listSkills" });
      assert.ok(skills.skills.length > 0);
      const changes = await invoke("command", { type: "getChanges" });
      assert.ok(Array.isArray(changes.files));
      const restored = await invoke("restoreWorkspace");
      assert.equal(restored.cwd, workspace);
      const evaluate = async (code) => {
        try { return await window.webContents.executeJavaScript(code); }
        catch (error) { throw new Error(`${error.message}\nRenderer command: ${code}`); }
      };
      const waitFor = async (code, label) => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (await evaluate(code)) return;
          await delay(100);
        }
        assert.fail(label);
      };
      // A long approval in a short window must survive wheel input, keep
      // decisions reachable, and release background interaction on dismissal.
      const modalSize = window.getContentSize();
      const modalMinimum = window.getMinimumSize();
      window.setMinimumSize(320, 320);
      window.setContentSize(900, 420);
      await waitFor("innerHeight <= 440", "Short-window test did not resize");
      await evaluate("document.querySelector('[aria-label=\"新建项目\"]').click()");
      await waitFor("Boolean(document.querySelector('#project-create-title'))", "Project dialog did not open");
      const backgroundBeforeModal = await evaluate("[window.scrollX, window.scrollY, document.querySelector('.thread').scrollTop]");
      window.webContents.send("agent:event", { type: "approval.requested", sessionId: restored.sessionId, requestId: "modal-scroll-smoke", reason: "检查长命令确认框的滚动。", cwd: workspace, command: Array.from({ length: 100 }, (_, index) => `echo '${index}: ${"long-command-content-".repeat(8)}'`).join("\n") });
      await waitFor("Boolean(document.querySelector('.approval-dialog'))", "Approval did not appear");
      assert.ok(await evaluate("(() => { const dialog = document.querySelector('.approval-dialog'); const r = dialog.getBoundingClientRect(); const code = dialog.querySelector('code'); return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth && code.scrollHeight > code.clientHeight && dialog.closest('.modal-backdrop').parentElement === document.body; })()"), "Long approval escaped the viewport or did not scroll internally");
      window.webContents.sendInputEvent({ type: "mouseWheel", x: 8, y: 8, deltaY: -600, deltaX: 0 });
      await delay(100);
      const codePoint = await evaluate("(() => { const r = document.querySelector('.command-preview code').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
      window.webContents.sendInputEvent({ type: "mouseWheel", ...codePoint, deltaY: -600, deltaX: 0 });
      await waitFor("document.querySelector('.command-preview code').scrollTop > 0", "Approval content did not scroll");
      assert.deepEqual(await evaluate("[window.scrollX, window.scrollY, document.querySelector('.thread').scrollTop]"), backgroundBeforeModal, "Modal wheel input scrolled the background");
      assert.ok(await evaluate("(() => { const r = document.querySelector('.approval-dialog').getBoundingClientRect(); const a = document.querySelector('.approval-actions').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && a.top >= 0 && a.bottom <= innerHeight && document.querySelector('#root').inert; })()"), "Wheel input hid approval decisions");
      await evaluate("document.querySelector('.approval-actions button:last-child').focus()");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Tab" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Tab" });
      await waitFor("document.activeElement === document.querySelector('.approval-actions button')", "Tab focus escaped the approval");
      const escapeModal = () => {
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
      };
      escapeModal();
      await waitFor("!document.querySelector('.approval-dialog')", "Escape did not dismiss approval");
      assert.ok(await evaluate("document.querySelectorAll('.modal-backdrop').length === 1 && document.querySelector('#root').inert && !document.querySelector('.modal-backdrop').inert && document.querySelector('.modal-backdrop').contains(document.activeElement)"), "Nested modal did not retain focus and background lock");
      escapeModal();
      await waitFor("!document.querySelector('.modal-backdrop') && !document.querySelector('#root').inert && !document.documentElement.style.overflow", "Closing dialogs left a backdrop or scroll lock behind");
      window.setContentSize(...modalSize);
      window.setMinimumSize(...modalMinimum);
      await waitFor(`innerHeight === ${modalSize[1]}`, "Original window size was not restored");
      console.log("[desktop-smoke] PASS: short-window long approval, wheel isolation, internal scrolling, focus trap, Escape cancellation and nested modal cleanup");
      await evaluate("if (document.querySelector('.work-panel').hidden) document.querySelector('.header-actions .header-button').click()");
      assert.equal(await evaluate("document.querySelectorAll('.work-tab').length"), 0, "An empty panel should not default to Diff");
      assert.ok(await evaluate("Boolean(document.querySelector('.work-empty-actions'))"));
      assert.ok(await evaluate("Math.abs(document.querySelector('.work-panel-tabbar').getBoundingClientRect().top - document.querySelector('.workspace-header').getBoundingClientRect().top) < 1"), "Panel tabs were not moved to the top header");
      await writeFile(path.join(os.tmpdir(), "agentx-panel-empty.png"), (await window.webContents.capturePage()).toPNG());
      const browserUrl = `http://127.0.0.1:${modelServer.address().port}/browser/first`;
      await evaluate("[...document.querySelectorAll('.work-empty-actions button')].find(button => button.textContent.includes('打开网页')).click()");
      await evaluate(`(() => { const input = document.querySelector('.web-address-form input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(browserUrl)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await evaluate("document.querySelector('.web-address-form').requestSubmit()");
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Native website did not load");
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === browserUrl);
      assert.ok(guest, "No native browser WebContents was created");
      assert.equal(await guest.executeJavaScript("window.browserScriptRan && !window.piDesktop && typeof require === 'undefined'"), true);
      assert.equal(guest.getLastWebPreferences().sandbox, true);
      assert.notEqual(guest.session, window.webContents.session);
      const browserView = () => window.contentView.children.find((view) => view.webContents === guest);
      const waitForNative = async (condition, label) => {
        for (let attempt = 0; attempt < 50; attempt++) { if (condition()) return; await delay(50); }
        assert.fail(label);
      };
      await waitForNative(() => browserView()?.getVisible(), "Browser view was not shown inside the panel");
      const browserBounds = await evaluate("(() => { const r = document.querySelector('.browser-surface').getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }; })()");
      assert.deepEqual(browserView().getBounds(), browserBounds);
      await evaluate("document.querySelector('[aria-label=\"展开工作面板\"]').click()");
      await waitFor("document.querySelector('.workspace-header').getClientRects().length === 0", "Expanded panel did not fill the workspace");
      await waitForNative(() => browserView().getBounds().width > browserBounds.width, "Native browser did not follow the expanded panel");
      await evaluate("document.querySelector('[aria-label=\"恢复分栏\"]').click()");
      await waitForNative(() => browserView().getBounds().width === browserBounds.width, "Restoring split view lost the browser width");
      await evaluate("document.querySelector('[aria-label=\"新建项目\"]').click()");
      await waitFor("Boolean(document.querySelector('.modal-backdrop'))", "Dialog over browser did not appear");
      await waitForNative(() => !browserView().getVisible(), "Native webpage covered a confirmation dialog");
      escapeModal();
      await waitFor("!document.querySelector('.modal-backdrop')", "Dialog did not close");
      await waitForNative(() => browserView().getVisible(), "Browser did not return after the dialog closed");
      await evaluate("document.querySelector('[aria-label=\"管理\"]').click()");
      await waitForNative(() => !browserView().getVisible(), "Native browser covered management");
      await evaluate("document.querySelector('[aria-label=\"管理\"]').click()");
      await waitForNative(() => browserView().getVisible(), "Management toggle discarded the browser view");
      await guest.executeJavaScript("document.querySelector('#next').click()", true);
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser second'", "Page navigation did not update the tab title");
      await waitFor("!document.querySelector('[aria-label=\"网页后退\"]').disabled", "Back button did not become available");
      await evaluate("document.querySelector('[aria-label=\"网页后退\"]').click()");
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Browser back did not restore the previous page");
      await evaluate("document.querySelector('[aria-label=\"关闭工作面板\"]').click()");
      await delay(150);
      assert.equal(browserView().getVisible(), false, "Collapsed browser covered the chat");
      await evaluate("document.querySelector('.header-actions .header-button').click()");
      await delay(150);
      assert.equal(browserView().getVisible(), true);
      await evaluate("document.querySelector('[aria-label=\"添加面板内容\"]').click()");
      await delay(150);
      assert.equal(browserView().getVisible(), false, "Native browser covered the operation menu");
      await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      await evaluate("document.querySelector('[aria-label=\"关闭 Browser first\"]').click()");
      await waitFor("Boolean(document.querySelector('.work-empty-actions')) && document.querySelectorAll('.work-tab').length === 0", "Closing the last tab did not restore the empty chooser");
      assert.ok(guest.isDestroyed());
      console.log("[desktop-smoke] PASS: empty chooser, top-aligned tabs, isolated native browser, scripts, navigation history, collapse/menu visibility and last-tab cleanup");
      await evaluate("[...document.querySelectorAll('.work-empty-actions button')].find(button => button.textContent.includes('查看变更')).click()");
      await evaluate("document.querySelector('[aria-label=\"添加面板内容\"]').click()");
      await evaluate("document.querySelector('[aria-label=\"打开预览文件\"]').click()");
      await waitFor("document.querySelectorAll('.work-tab').length === 6", "File preview tabs did not open");
      console.log("[desktop-smoke] Preview tabs opened");
      assert.ok(await evaluate("Boolean(document.querySelector('[aria-label=\"向右滚动标签\"]'))"), "Overflowing tabs did not expose scroll controls");
      const selectTab = async (name) => {
        await evaluate(`[...document.querySelectorAll('.work-tab [role=tab]')].find(tab => tab.textContent === ${JSON.stringify(name)}).click()`);
        await delay(150);
      };
      await selectTab("README.md");
      await waitFor("Boolean(document.querySelector('.work-tab-content:not([hidden]) table') && document.querySelector('.work-tab-content:not([hidden]) .mermaid-image'))", "Markdown table or fenced Mermaid did not render");
      await waitFor("[...document.querySelectorAll('.work-tab-content:not([hidden]) .document-preview img')].every(img => img.complete && img.naturalWidth > 0)", "Markdown relative image did not load");
      console.log("[desktop-smoke] Markdown and Mermaid rendered");
      await writeFile(path.join(os.tmpdir(), "pi-desktop-work-panel.png"), (await window.webContents.capturePage()).toPNG());
      await selectTab("diagram.svg");
      await waitFor("document.querySelector('.work-tab-content:not([hidden]) .image-canvas img')?.naturalWidth === 240", "Static SVG did not load");
      assert.equal(await evaluate("Boolean(window.svgRan)"), false);
      await selectTab("pixel.png");
      await waitFor("document.querySelector('.work-tab-content:not([hidden]) .image-canvas img')?.naturalWidth === 1", "PNG did not load");
      await selectTab("flow.mmd");
      await waitFor("Boolean(document.querySelector('.work-tab-content:not([hidden]) .mermaid-image'))", "Mermaid file did not render");
      await selectTab("index.html");
      console.log("[desktop-smoke] Inspecting HTML frame");
      const expectPixel = async (x, y, expected) => {
        for (let attempt = 0; attempt < 50; attempt += 1) {
          const rect = await evaluate(`(() => { const rect = document.querySelector('.html-preview').getBoundingClientRect(); return { x: Math.round(rect.left + ${x}), y: Math.round(rect.top + ${y}), width: 1, height: 1 }; })()`);
          const bytes = (await window.webContents.capturePage(rect)).toBitmap();
          if ([bytes[2], bytes[1], bytes[0]].join() === expected.join()) return;
          await delay(100);
        }
        assert.fail(`HTML resource pixel ${x},${y} did not match ${expected}`);
      };
      // Script execution is disabled even for Electron's frame.executeJavaScript.
      // Verify actual rendering through pixels without weakening the iframe sandbox.
      await expectPixel(10, 250, [230, 240, 250]);
      await expectPixel(30, 110, [222, 240, 229]);
      const frame = window.webContents.mainFrame.frames.find((item) => item.url.startsWith("pi-preview:"));
      assert.ok(frame);
      await assert.rejects(frame.executeJavaScript("Boolean(window.piDesktop || window.previewScriptRan)"));
      assert.equal(await evaluate("document.querySelector('.html-preview').getAttribute('sandbox')"), "");
      // Real pointer capture must keep working while dragging across the iframe.
      const panelWidth = () => evaluate("Math.round(document.querySelector('.work-panel').getBoundingClientRect().width)");
      const originalPanelWidth = await panelWidth();
      const dragPanel = async (distance) => {
        const point = await evaluate("(() => { const r = document.querySelector('.work-panel-resizer').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
        window.webContents.sendInputEvent({ type: "mouseMove", ...point });
        window.webContents.sendInputEvent({ type: "mouseDown", ...point, button: "left", clickCount: 1 });
        await waitFor("document.querySelector('.work-panel').classList.contains('is-resizing')", "Panel drag did not start");
        const destination = { x: point.x + distance, y: point.y };
        window.webContents.sendInputEvent({ type: "mouseMove", ...destination, modifiers: ["leftButtonDown"] });
        await waitFor(`Math.abs(document.querySelector('.work-panel').getBoundingClientRect().width - ${originalPanelWidth - distance}) <= 1`, "Panel did not follow the pointer");
        window.webContents.sendInputEvent({ type: "mouseUp", ...destination, button: "left", clickCount: 1 });
        await waitFor("!document.querySelector('.work-panel').classList.contains('is-resizing')", "Panel drag did not finish");
      };
      await dragPanel(80);
      await waitFor(`Math.abs(document.querySelector('.work-panel').getBoundingClientRect().width - ${originalPanelWidth - 80}) <= 1`, "Dragging across the HTML preview did not resize the panel");
      assert.equal(await evaluate("document.querySelector('.work-tab [aria-selected=true]').textContent"), "index.html");
      assert.equal(await evaluate("Number(localStorage.getItem('pi-desktop.work-panel-width'))"), await panelWidth());
      const resizeKey = async (key) => {
        await evaluate("document.querySelector('.work-panel-resizer').focus()");
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
      };
      await resizeKey("Home");
      await waitFor("document.querySelector('.work-panel').getBoundingClientRect().width === 320", "Minimum panel width was not enforced");
      await resizeKey("Right");
      assert.equal(await panelWidth(), 320, "Panel shrank below its minimum");
      await resizeKey("End");
      await waitFor("document.querySelector('.conversation').getBoundingClientRect().width >= 359 && Math.abs(document.querySelector('.work-panel').getBoundingClientRect().width - Number(document.querySelector('.work-panel-resizer').getAttribute('aria-valuemax'))) < 2", "Maximum panel width did not preserve the chat area");
      await resizeKey("Left");
      assert.ok(await evaluate("document.querySelector('.conversation').getBoundingClientRect().width >= 359"));
      await evaluate("document.querySelector('.work-panel-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
      await waitFor(`Math.abs(document.querySelector('.work-panel').getBoundingClientRect().width - ${originalPanelWidth}) <= 1`, "Double click did not restore the default width");
      console.log("[desktop-smoke] PASS: pointer resize across iframe, remembered width, keyboard resize, minimum/maximum limits and reset");
      const previousFrameUrl = frame.url;
      await writeFile(path.join(workspace, "style.css"), "body { background: rgb(250, 230, 240); }");
      await waitFor(`document.querySelector('.html-preview')?.src !== ${JSON.stringify(previousFrameUrl)}`, "CSS update did not refresh HTML");
      await expectPixel(10, 250, [250, 230, 240]);
      await writeFile(path.join(workspace, "README.md"), "# 更新后\n\n自动刷新成功");
      await waitFor("document.querySelector('.document-preview')?.textContent.includes('自动刷新成功')", "Markdown did not automatically refresh");
      assert.equal(await evaluate("document.querySelector('.work-tab [aria-selected=true]').textContent"), "index.html", "Automatic refresh stole the active tab");
      await selectTab("README.md");
      await evaluate("[...document.querySelectorAll('.work-tab-content:not([hidden]) .preview-modes button')].find(button => button.textContent === '源码').click()");
      assert.match(await evaluate("document.querySelector('.work-tab-content:not([hidden]) .preview-source').textContent"), /# 更新后/);
      await evaluate("document.querySelector('[aria-label=\"关闭工作面板\"]').click()");
      await waitFor("document.querySelector('.work-panel').hidden", "Panel did not collapse");
      await evaluate("document.querySelector('.header-actions .header-button').click()");
      assert.equal(await evaluate("document.querySelector('.work-tab [aria-selected=true]').textContent"), "README.md", "Closing the panel lost the active tab");
      await selectTab("变更");
      assert.ok(await evaluate("Boolean(document.querySelector('.diff-panel .diff-view'))"));
      console.log("[desktop-smoke] PASS: tab switching, images, static SVG, Markdown with Mermaid, sandboxed HTML with relative CSS/images, dependency updates and active-tab retention");
      await evaluate("document.querySelector('.suggestion-grid button').click(); window.__chatBeforeSettings = document.querySelector('.thread'); document.querySelector('[aria-label=\"管理\"]').click()");
      await waitFor("Boolean(document.querySelector('[aria-label=\"系统信息\"]'))", "General system information did not appear");
      assert.match(await evaluate("document.querySelector('[aria-label=\"系统信息\"]').textContent"), /Electron IPC · Pi SDK/);
      assert.ok(await evaluate("!document.querySelector('.composer-meta, .settings-page-status')"), "Duplicate status remained in chat or management header");
      assert.equal(await evaluate("document.querySelector('[aria-label=\"管理\"]').getAttribute('aria-pressed')"), "true");
      await evaluate("[...document.querySelectorAll('.settings-nav button')].find(button => button.textContent.includes('模型与服务')).click()");
      await waitFor("Boolean(document.querySelector('.settings-model-form'))", "Model settings did not appear");
      await evaluate("(() => { const select = document.querySelector('.settings-model-form select'); select.value = 'openai'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
      await waitFor("document.querySelector('.settings-model-form select').value === 'openai'", "Local test provider was not selected");
      await evaluate("[...document.querySelectorAll('.settings-provider-tools button')].find(button => button.textContent.includes('获取供应商模型')).click()");
      await waitFor("document.querySelector('.settings-remote-models')?.textContent.includes('unknown-remote')", "Live model discovery did not reach the renderer");
      assert.equal(await evaluate("document.querySelectorAll('.settings-remote-model-list button:disabled').length"), 1, "Unknown remote model should remain visible but not selectable");
      assert.ok(await evaluate("document.querySelector('.settings-remote-model-list button:not(:disabled)').textContent.includes('error-smoke')"));
      await evaluate("[...document.querySelectorAll('.settings-provider-tools button')].find(button => button.textContent.includes('测试当前模型')).click()");
      await waitFor("document.querySelector('.settings-provider-result.is-error')?.textContent.includes('余额或额度不足')", "Provider test failure was not readable");
      assert.ok(await evaluate("!document.querySelector('.settings-model-form').textContent.includes('local-test-key') && document.querySelector('.settings-model-form input[type=password]').value === ''"), "Stored credential reached the renderer");
      console.log("[desktop-smoke] PASS: live model discovery, unsupported-model visibility, readable connection test errors and Host-only saved credentials");
      await evaluate("document.querySelector('[aria-label=\"管理\"]').click()");
      await waitFor("!document.querySelector('.conversation-view').hidden", "Gear did not return to chat");
      assert.ok(await evaluate("window.__chatBeforeSettings === document.querySelector('.thread')"), "Management discarded the existing chat view");
      assert.equal(await evaluate("document.querySelector('.composer textarea').value"), "检查这个项目并说明它的结构");
      assert.equal(await evaluate("document.querySelector('.work-tab [aria-selected=true]').textContent"), "变更");
      assert.equal(await evaluate("document.querySelectorAll('.work-tab').length"), 6, "Management discarded work-panel tabs");
      console.log("[desktop-smoke] PASS: centralized system information, gear toggle, preserved chat draft and work-panel tabs");
      // Deliver deterministic streaming events through the real preload bridge.
      // These renderer-only fixtures never reach Pi's persisted transcript.
      const streamEvent = (event) => window.webContents.send("agent:event", { sessionId: restored.sessionId, runId: "scroll-smoke", messageId: "scroll-message", ...event });
      streamEvent({ type: "run.started" });
      streamEvent({ type: "message.started" });
      streamEvent({ type: "reasoning.started", reasoningId: "scroll-reasoning" });
      streamEvent({ type: "reasoning.delta", reasoningId: "scroll-reasoning", text: "测试流式推理与完成后的折叠。" });
      await waitFor("Boolean(document.querySelector('.reasoning-output'))", "Streaming reasoning was not expanded");
      await evaluate("document.querySelector('.reasoning-step-heading').click(); document.querySelector('.process-summary').click()");
      assert.ok(await evaluate("Boolean(document.querySelector('.reasoning-output'))"), "Active reasoning could be collapsed");
      assert.ok(await evaluate("!document.querySelector('.composer textarea').disabled && Boolean(document.querySelector('[aria-label=\"排队发送\"]'))"), "Running composer did not allow additional input");
      streamEvent({ type: "reasoning.completed", reasoningId: "scroll-reasoning" });
      await waitFor("!document.querySelector('.reasoning-output')", "Completed reasoning did not collapse independently");
      await evaluate("document.querySelector('.reasoning-step-heading').click()");
      await waitFor("document.querySelector('.reasoning-output')?.textContent.includes('测试流式推理')", "Completed reasoning could not be reopened");
      await evaluate("document.querySelector('.reasoning-step-heading').click()");
      streamEvent({ type: "message.delta", text: "```text\nKeep this code block mounted\n```\n\n" + "流式消息内容，用于检查滚动位置和末尾可见性。\n\n".repeat(65) });
      const atBottom = "document.querySelector('.thread').scrollHeight - document.querySelector('.thread').clientHeight - document.querySelector('.thread').scrollTop < 2";
      await waitFor("document.querySelector('.thread').textContent.includes('Keep this code block mounted')", "Streaming content did not render");
      await waitFor(atBottom, "Streaming output did not follow the bottom");
      assert.ok(await evaluate("document.querySelector('.thread').getBoundingClientRect().bottom <= document.querySelector('.composer-wrap').getBoundingClientRect().top + 1"), "Composer covered the conversation viewport");
      assert.ok(await evaluate("document.querySelector('.working-state').getBoundingClientRect().bottom <= document.querySelector('.composer-wrap').getBoundingClientRect().top"), "Last output was hidden behind the composer");
      await evaluate("window.__streamCode = document.querySelector('.thread .markdown-code-block'); document.querySelector('.thread').scrollTop = 50;");
      await waitFor("Boolean(document.querySelector('.thread-jump'))", "Reading older messages did not pause following");
      for (let index = 0; index < 80; index += 1) streamEvent({ type: "message.delta", text: `片段${index} ` });
      streamEvent({ type: "message.delta", text: "\n\n最后一条流式输出。" });
      await waitFor("document.querySelector('.thread').textContent.includes('最后一条流式输出。')", "Batched stream lost its last tokens");
      assert.ok(await evaluate("Math.abs(document.querySelector('.thread').scrollTop - 50) < 2"), "New output pulled the reader away from history");
      assert.ok(await evaluate("window.__streamCode === document.querySelector('.thread .markdown-code-block')"), "Streaming remounted the existing code block");
      await evaluate("document.querySelector('.thread-jump').click()");
      await waitFor(atBottom, "Return-to-latest did not reach the bottom");
      // Growing attachments/validation messages also change the available height.
      await evaluate("document.querySelector('.composer-wrap').style.paddingTop = '100px'");
      await waitFor(atBottom, "Composer resizing lost bottom following");
      await evaluate("document.querySelector('.composer-wrap').style.paddingTop = ''");
      streamEvent({ type: "run.settled", status: "completed", durationMs: 1000 });
      await waitFor("!document.querySelector('.working-state') && !document.querySelector('.process-body')", "Completed process did not collapse");
      await waitFor(atBottom, "Process folding lost the final output");
      const previousSize = window.getContentSize();
      window.setContentSize(640, 720);
      await waitFor(atBottom, "Narrow window lost bottom following");
      assert.ok(await evaluate("document.querySelector('.work-panel').getBoundingClientRect().right <= innerWidth + 1 && document.querySelector('.work-panel').getBoundingClientRect().width >= 320"), "Narrow window panel exceeded its available width");
      assert.ok(await evaluate("document.querySelector('.thread').getBoundingClientRect().bottom <= document.querySelector('.composer-wrap').getBoundingClientRect().top + 1"), "Mobile composer covered output");
      window.setContentSize(...previousSize);
      await invoke("restoreWorkspace");
      await waitFor("!document.querySelector('.thread').textContent.includes('Keep this code block mounted')", "Streaming fixture was not cleared");
      console.log("[desktop-smoke] PASS: batched streaming, stable Markdown DOM, paused history reading, return-to-latest, process folding and unobstructed desktop/mobile output");
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

      const menuAction = async (label) => {
        await evaluate("document.querySelector('[aria-label=\"会话操作\"]').click()");
        await waitFor("Boolean(document.querySelector('.session-menu'))", "Session menu did not open");
        await waitFor(`[...document.querySelectorAll('.session-menu button')].some(button => button.textContent === ${JSON.stringify(label)} && !button.disabled)`, "Session action remained disabled");
        await evaluate(`[...document.querySelectorAll('.session-menu button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`);
        await waitFor("Boolean(document.querySelector('.session-operation-dialog, .rename-dialog'))", "Session action did not open");
      };
      const closeAction = () => evaluate("document.querySelector('.session-operation-dialog [title=\"关闭\"]').click()");
      await menuAction("会话信息");
      await waitFor(`document.querySelector('.session-info-list')?.textContent.includes(${JSON.stringify(reloaded.sessionId)})`, "Session information was not loaded");
      await closeAction();
      for (const [format, label] of [["html", "HTML 阅读副本"], ["jsonl", "JSONL 完整备份"]]) {
        await menuAction("导出会话…");
        await evaluate(`[...document.querySelectorAll('.session-export-options button')].find(button => button.textContent === ${JSON.stringify(label)}).click()`);
        await waitFor("!document.querySelector('.session-operation-dialog')", "Export did not finish");
        const backup = await readFile(path.join(root, `backup.${format}`), "utf8");
        assert.match(backup, format === "html" ? /<html/i : /"type":"session"/);
        const transcript = format === "html" ? Buffer.from(backup.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)[1], "base64").toString("utf8") : backup;
        assert.match(transcript, /Insufficient Balance/);
      }
      const originalContent = await readFile(reloaded.sessionFile, "utf8");
      saveFile = reloaded.sessionFile;
      await assert.rejects(invoke("sessionCommand", { type: "export", format: "jsonl", projectId: created.project.id, sessionId: reloaded.sessionId }), /存储目录以外/);
      assert.equal(await readFile(reloaded.sessionFile, "utf8"), originalContent);
      saveFile = null;
      await menuAction("重命名会话");
      await evaluate("(() => { const input = document.querySelector('.rename-dialog input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '会话菜单验证'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await evaluate("document.querySelector('.rename-dialog button[type=submit]').click()");
      await waitFor("document.querySelector('.task-heading h1')?.textContent === '会话菜单验证'", "Rename did not update the header");
      const renamedContent = await readFile(reloaded.sessionFile, "utf8");

      await menuAction("导入会话…");
      assert.equal(await evaluate("document.querySelector('.session-operation-dialog select').value"), created.project.id);
      importFile = path.join(root, "invalid.jsonl");
      await writeFile(importFile, '{"not":"a Pi session"}');
      await evaluate("document.querySelector('.session-file-picker').click()");
      await waitFor("document.querySelector('.session-operation-dialog [role=alert]')?.textContent.includes('session 文件头')", "Invalid import was not explained");
      importFile = path.join(root, "backup.jsonl");
      await evaluate("document.querySelector('.session-file-picker').click()");
      await waitFor("Boolean(document.querySelector('.session-import-summary'))", "Import summary did not appear");
      assert.equal(await evaluate("document.querySelector('.task-heading h1').textContent"), "会话菜单验证");
      await evaluate("document.querySelector('.session-operation-dialog .button-primary').click()");
      await waitFor("!document.querySelector('.session-operation-dialog')", "Import did not finish");
      const projects = await invoke("listProjects");
      const imported = projects.find((item) => item.id === created.project.id).sessions.find((item) => item.sessionId !== reloaded.sessionId);
      assert.ok(imported);
      assert.equal(await readFile(reloaded.sessionFile, "utf8"), renamedContent, "Original session was overwritten");
      const importedEntries = (await readFile(imported.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
      assert.equal(importedEntries[0].cwd, workspace);
      assert.equal(importedEntries[0].id, imported.sessionId);
      await visibleError(false);
      await evaluate("document.querySelector('[aria-label=\"会话操作\"]').click()");
      await delay(100);
      await writeFile(path.join(os.tmpdir(), "pi-desktop-session-menu.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate("document.querySelector('[aria-label=\"会话操作\"]').click()");
      await menuAction("归档会话");
      await evaluate("document.querySelector('.session-operation-dialog .button-primary').click()");
      await waitFor("Boolean(document.querySelector('.empty-thread'))", "Archive did not open an empty draft");
      const afterArchive = (await invoke("listProjects")).find((item) => item.id === created.project.id);
      assert.equal(afterArchive.sessions.find((item) => item.sessionId === imported.sessionId).archived, true);
      assert.equal(afterArchive.sessions.length, 2, "Empty draft created a persisted session");
      await access(imported.sessionFile);
      await invoke("projectCommand", { type: "restore-session", projectId: created.project.id, sessionId: imported.sessionId });
      const reopened = await invoke("projectCommand", { type: "open", projectId: created.project.id, sessionId: imported.sessionId });
      assert.equal(reopened.workspace.sessionId, imported.sessionId);
      await visibleError(false);
      console.log("[desktop-smoke] PASS: session menu, rename, info, HTML/JSONL export, overwrite protection, invalid import, project confirmation, independent import, reversible archive and unpersisted draft");
      // Keep A's preview, start a first-turn B in full mode, and switch both ways
      // while inference is held open by the local provider.
      await evaluate("if (document.querySelector('.work-panel').hidden) document.querySelector('.header-actions .header-button').click()");
      await evaluate("[...document.querySelectorAll('.work-empty-actions button')].find(button => button.textContent.includes('查看变更')).click()");
      await evaluate("document.querySelector('[aria-label=\"添加面板内容\"]').click()");
      await evaluate("document.querySelector('[aria-label=\"打开预览文件\"]').click()");
      await waitFor("document.querySelectorAll('.work-tab').length === 6", "Session A previews did not open");
      await selectTab("README.md");
      const sessionB = await invoke("projectCommand", { type: "new-session", projectId: created.project.id });
      await waitFor("Boolean(document.querySelector('.empty-thread')) && document.querySelectorAll('.work-tab').length === 0", "New session reused the previous session's work panel");
      assert.ok(await evaluate("document.querySelector('.work-panel').hidden"), "New session inherited panel visibility");
      assert.equal(await evaluate("document.querySelector('.permission-control select').value"), "执行前询问");
      await evaluate("(() => { const select = document.querySelector('.permission-control select'); select.value = '完全访问'; select.dispatchEvent(new Event('change', { bubbles: true })); })()");
      await waitFor("document.querySelector('.permission-control select').value === '完全访问'", "Full access was not applied");
      modelResponses.push({ tool: true }, { hold: true, text: `B is still working. [Preview webpage](${browserUrl}) [Project readme](README.md)` });
      const send = async (text) => {
        await evaluate(`(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(text)}); input.dispatchEvent(new Event('input', { bubbles: true })); })()`);
        await evaluate("document.querySelector('.send-button:not(.stop-button)').click()");
      };
      await send("Background B first request");
      await waitFor("[...document.querySelectorAll('.project-session-item')].some(button => button.textContent.includes('Background B first request') && button.querySelector('.session-running-icon'))", "First-turn session was not indexed and marked running before completion");
      await waitFor("document.querySelector('.thread').textContent.includes('B is still working')", "Full access blocked tool execution");
      assert.match(await evaluate("document.querySelector('.working-state').textContent"), /Agentx 正在工作/);
      assert.equal(await evaluate("document.querySelector('.composer textarea').placeholder"), "继续输入，发送后排队，可点击 Steer 补充当前任务");
      await writeFile(path.join(os.tmpdir(), "agentx-running.png"), (await window.webContents.capturePage()).toPNG());
      assert.equal(await readFile(path.join(workspace, "full-access.txt"), "utf8"), "Written without confirmation");
      assert.ok(await evaluate("!document.querySelector('.approval-dialog')"), "Full access requested confirmation");
      const clickChatLink = () => evaluate(`[...document.querySelectorAll('.thread a')].find(link => link.href === ${JSON.stringify(browserUrl)}).click()`);
      await clickChatLink();
      await waitFor("!document.querySelector('.work-panel').hidden && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Chat web link did not open the side panel");
      await clickChatLink();
      await delay(100);
      assert.equal(await evaluate("document.querySelectorAll('.work-tab').length"), 1, "Repeated chat link created a duplicate web tab");
      const sessionBrowser = webContents.getAllWebContents().find((contents) => contents.getURL() === browserUrl);
      assert.ok(sessionBrowser);
      await sessionBrowser.executeJavaScript("document.querySelector('#popup').click()", true);
      await waitFor("document.querySelectorAll('.work-tab').length === 2 && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser popup'", "Website new-window link did not open a panel tab");
      await evaluate("document.querySelector('[aria-label=\"关闭 Browser popup\"]').click()");
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Closing the popup did not restore the previous browser tab");
      const browserId = await evaluate("document.querySelector('.browser-preview').dataset.browserId");
      await assert.rejects(invoke("browser", { type: "navigate", id: browserId, url: "file:///etc/passwd" }));
      await invoke("browser", { type: "navigate", id: browserId, url: "http://127.0.0.1:1/unreachable" });
      await waitFor("Boolean(document.querySelector('.browser-preview .preview-error'))", "Browser failure was not displayed");
      assert.ok(await evaluate("document.querySelector('[aria-label=\"网页地址\"]').value.includes(':1/unreachable')"), "Failed navigation lost its target address");
      await invoke("browser", { type: "navigate", id: browserId, url: browserUrl });
      await waitFor("!document.querySelector('.browser-preview .preview-error') && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Browser did not recover after a failed navigation");
      await writeFile(path.join(os.tmpdir(), "agentx-web-content.png"), (await sessionBrowser.capturePage()).toPNG());
      // In dev mode, DOM href resolves relative files against the HTTP renderer.
      // Classification must still use the original attribute and open a file tab.
      await evaluate(`(() => { const base = document.createElement('base'); base.id = 'dev-link-base'; base.href = ${JSON.stringify(browserUrl)}; document.head.append(base); [...document.querySelectorAll('.thread a')].find(link => link.getAttribute('href') === 'README.md').click(); })()`);
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'README.md' && document.querySelectorAll('.work-tab').length === 2", "Relative file link was incorrectly treated as an HTTP website");
      await evaluate("document.querySelector('#dev-link-base').remove(); document.querySelector('[aria-label=\"关闭 README.md\"]').click()");
      await waitFor("document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Closing a linked file did not restore the website");
      await access(sessionB.workspace.sessionFile);
      await invoke("projectCommand", { type: "open", projectId: created.project.id, sessionId: imported.sessionId });
      await waitFor("document.querySelectorAll('.work-tab').length === 6 && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'README.md'", "Returning to session A lost its work-panel state");
      assert.ok(await evaluate("!document.querySelector('.work-panel').hidden && !document.querySelector('.stop-button')"), "Background B changed A's running state");
      modelResponses.push({ hold: true, text: "A is still working" });
      await send("Concurrent A request");
      await waitFor("document.querySelector('.thread').textContent.includes('A is still working')", "Session A could not run while B was active");
      await evaluate("[...document.querySelectorAll('.project-session-item')].find(button => button.textContent.includes('Background B first request')).click()");
      await waitFor("document.querySelector('.thread').textContent.includes('B is still working') && document.querySelectorAll('.work-tab').length === 1", "Running session B could not be reopened with its own panel");
      assert.ok(await evaluate("!document.querySelector('.work-panel').hidden && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'"), "Returning to B lost its browser state");
      console.log("[desktop-smoke] PASS: chat links, URL reuse, popup tabs, blocked local URLs, readable browser errors and Session-scoped browser state");
      assert.equal(await evaluate("document.querySelector('.permission-control select').value"), "完全访问", "Session-specific permissions were reset on switch");
      assert.equal(await evaluate("document.querySelectorAll('.session-running-icon').length"), 2, "Both active sessions should be marked running");
      await evaluate("document.querySelector('[aria-label=\"收起侧栏\"]').click()");
      await delay(220);
      const projectIcon = ".sidebar.is-collapsed .project-nav-item.is-active";
      const moveTo = async (selector) => {
        const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()`);
        window.webContents.sendInputEvent({ type: "mouseMove", ...point });
      };
      await moveTo(projectIcon);
      await waitFor("Boolean(document.querySelector('.project-session-popover'))", "Hovering a collapsed project did not open its sessions");
      assert.ok(await evaluate("(() => { const r = document.querySelector('.project-session-popover').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })()"), "Project list overflowed the viewport");
      assert.equal(await evaluate("document.querySelectorAll('.project-session-popover .session-running-icon').length"), 2, "Collapsed project list lost running session states");
      assert.equal(await evaluate("document.querySelectorAll('.project-session-popover [aria-current=page]').length"), 1, "Current session was not identified in the popover");
      const sessionBrowserView = () => window.contentView.children.find((view) => view.webContents === sessionBrowser);
      await waitForNative(() => !sessionBrowserView().getVisible(), "Native webpage covered the project session list");
      await moveTo(".project-session-popover .project-session-item");
      await delay(260);
      assert.ok(await evaluate("Boolean(document.querySelector('.project-session-popover'))"), "Moving from project icon into the list closed it");
      const sessionIds = await evaluate("[...document.querySelectorAll('.project-session-popover [data-session-id]')].map(button => button.dataset.sessionId)");
      assert.ok(sessionIds.includes(imported.sessionId) && sessionIds.includes(sessionB.workspace.sessionId), "Collapsed list omitted other sessions in the project");
      await writeFile(path.join(os.tmpdir(), "agentx-collapsed-project-sessions.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate(`document.querySelector('.project-session-popover [data-session-id="${imported.sessionId}"]').click()`);
      await waitFor("!document.querySelector('.project-session-popover') && document.querySelector('.thread').textContent.includes('A is still working')", "Collapsed list could not switch to another running session");
      assert.ok(await evaluate("Boolean(document.querySelector('.sidebar.is-collapsed'))"), "Selecting a session expanded the sidebar");
      await moveTo(".composer textarea");
      await moveTo(projectIcon);
      await waitFor("Boolean(document.querySelector('.project-session-popover'))", "Project list did not reopen after session selection");
      await evaluate(`document.querySelector('.project-session-popover [data-session-id="${sessionB.workspace.sessionId}"]').click()`);
      await waitFor("document.querySelector('.thread').textContent.includes('B is still working') && document.querySelector('.work-tab [aria-selected=true]')?.textContent === 'Browser first'", "Switching back through the collapsed list lost the session or its browser");
      await moveTo(".composer textarea");
      window.webContents.focus();
      await evaluate("document.querySelector('.collapsed-brand-toggle').focus()");
      await evaluate(`document.querySelector(${JSON.stringify(projectIcon)}).focus()`);
      await waitFor("Boolean(document.querySelector('.project-session-popover'))", "Keyboard focus did not open project sessions");
      window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Down" });
      window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Down" });
      await waitFor("Boolean(document.activeElement?.closest('.project-session-popover'))", "Keyboard could not enter project sessions");
      escapeModal();
      await waitFor("!document.querySelector('.project-session-popover')", "Escape did not dismiss the project session list");
      assert.ok(await evaluate("document.activeElement?.matches('.project-nav-item')"), "Escape did not restore focus to the project icon");
      await waitForNative(() => sessionBrowserView().getVisible(), "Native browser did not return after the list closed");
      await moveTo(projectIcon);
      await waitFor("Boolean(document.querySelector('.project-session-popover'))", "Project list did not reopen on hover");
      await moveTo(".composer textarea");
      await waitFor("!document.querySelector('.project-session-popover')", "Leaving the project list did not dismiss it");
      await evaluate("document.querySelector('[aria-label=\"展开侧栏\"]').click()");
      console.log("[desktop-smoke] PASS: collapsed project hover list, pointer crossing, current/running states, session switching, keyboard/Escape dismissal and native browser layering");
      heldResponses[1]();
      await waitFor("document.querySelectorAll('.session-running-icon').length === 1", "Background completion did not update the sidebar");
      assert.ok(await evaluate("Boolean(document.querySelector('.stop-button')) && document.querySelector('.thread').textContent.includes('B is still working')"), "A's completion stopped or replaced the active B view");
      heldResponses[0]();
      await waitFor("!document.querySelector('.session-running-icon, .stop-button')", "Completed sessions remained marked running");
      assert.ok(await evaluate("!document.querySelector('.thread').textContent.includes('A is still working')"), "Background transcript leaked into the active session");
      await writeFile(path.join(os.tmpdir(), "pi-desktop-session-isolation.png"), (await window.webContents.capturePage()).toPNG());
      console.log("[desktop-smoke] PASS: full access, first-message indexing, unpersisted drafts, per-session previews and permissions, concurrent sessions, background streaming and scoped completion");
      modelResponses.push({ hold: true, text: "Queue original response." }, { text: "Steer finished." }, { text: "Follow-up finished." });
      await send("Queue original input");
      await waitFor("document.querySelector('.thread').textContent.includes('Queue original response.')", "Queue test did not begin streaming");
      await send("Queue later input");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 1", "Follow-up was not queued");
      await send("Cancel this pending input");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 2", "Cancellation fixture was not queued");
      await evaluate("[...document.querySelectorAll('.input-queue-item')].find(element => element.textContent.includes('Cancel this pending input')).querySelector('[aria-label=\"移除待处理消息\"]').click()");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 1", "Queued input could not be canceled during a run");
      await send("Queue steering input");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 2", "Steering was not queued");
      await evaluate("[...document.querySelectorAll('.input-queue-item')].find(element => element.textContent.includes('Queue steering input')).querySelector('.queue-primary-action').click()");
      await waitFor("[...document.querySelectorAll('.input-queue-item')].find(element => element.textContent.includes('Queue steering input')).querySelector('.queue-primary-action').disabled", "Inline Steer did not promote the pending message");
      await waitFor("document.querySelector('.composer textarea').value === ''", "Queue submission did not clear the sent draft");
      const queueMore = () => evaluate("[...document.querySelectorAll('.input-queue-item')].find(element => element.textContent.includes('Queue later input')).querySelector('[aria-label=\"待处理消息更多操作\"]').click()");
      await queueMore();
      await waitFor("Boolean(document.querySelector('.input-queue-menu'))", "Queue more menu did not open");
      await waitForNative(() => !sessionBrowserView().getVisible(), "Native browser covered the queued input menu");
      await evaluate("[...document.querySelectorAll('.input-queue-menu button')].find(button => button.textContent.includes('查看完整内容')).click()");
      await waitFor("document.querySelector('.queued-input-detail')?.textContent.includes('Queue later input')", "Queue full message details were not readable");
      escapeModal();
      await waitFor("!document.querySelector('.modal-backdrop')", "Closing queued message details left a blocking overlay");
      await queueMore();
      await waitFor("Boolean(document.querySelector('.input-queue-menu'))", "Queue more menu did not reopen");
      await evaluate("[...document.querySelectorAll('.input-queue-menu button')].find(button => button.textContent.includes('移回输入框编辑')).click()");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 1 && document.querySelector('.composer textarea').value === 'Queue later input'", "Editing did not remove the pending input and restore the draft");
      await send("Queue later input");
      await waitFor("document.querySelectorAll('.input-queue-item').length === 2 && document.querySelector('.composer textarea').value === ''", "Edited input could not be queued again");
      assert.ok(await evaluate("![...document.querySelectorAll('.user-message')].some(element => /Queue later input|Queue steering input/.test(element.textContent))"), "Pending input was shown as an already-consumed message");
      await delay(100);
      await writeFile(path.join(os.tmpdir(), "agentx-pending-inputs.png"), (await window.webContents.capturePage()).toPNG());
      await evaluate("(() => { const input = document.querySelector('.composer textarea'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'B unsent draft'); input.dispatchEvent(new Event('input', { bubbles: true })); })()");
      await invoke("projectCommand", { type: "open", projectId: created.project.id, sessionId: imported.sessionId });
      await waitFor("!document.querySelector('.input-queue') && document.querySelector('.composer textarea').value !== 'B unsent draft'", "Queue or draft leaked into session A");
      await invoke("projectCommand", { type: "open", projectId: created.project.id, sessionId: sessionB.workspace.sessionId });
      await waitFor("document.querySelectorAll('.input-queue-item').length === 2 && document.querySelector('.composer textarea').value === 'B unsent draft'", "Switching sessions lost queued inputs or draft");
      heldResponses[2]();
      await waitFor("!document.querySelector('.input-queue, .stop-button') && document.querySelector('.thread').textContent.includes('Follow-up finished.')", "Queued messages did not finish");
      assert.deepEqual(await evaluate("[...document.querySelectorAll('.user-message-text')].map(element => element.textContent).filter(text => text.startsWith('Queue '))"), ["Queue original input", "Queue steering input", "Queue later input"]);
      assert.equal(await evaluate("[...document.querySelectorAll('.assistant-message')].filter(element => /Queue original response\.|Steer finished\.|Follow-up finished\./.test(element.textContent)).length"), 3, "Queued exchanges were merged into one assistant bubble");
      assert.equal(await evaluate("document.querySelector('.composer textarea').value"), "B unsent draft", "Queue completion discarded the next draft");
      assert.ok(await evaluate("!document.querySelector('.thread').textContent.includes('Cancel this pending input')"), "Canceled input was still executed or persisted");
      modelResponses.push({ hold: true, text: "Task to pause." });
      await send("Task to stop from UI");
      await waitFor("document.querySelector('.thread').textContent.includes('Task to pause.')", "Stop test did not begin streaming");
      await send("Resume pending message");
      await waitFor("Boolean(document.querySelector('.input-queue-item'))", "Stop test did not queue a message");
      await evaluate("document.querySelector('.stop-button').click()");
      await waitFor("!document.querySelector('.stop-button') && Boolean(document.querySelector('.input-queue-item.is-held'))", "Stop lost the pending message");
      modelResponses.push({ text: "Resumed from UI." });
      await evaluate("document.querySelector('[aria-label=\"继续发送待处理消息\"]').click()");
      await waitFor("!document.querySelector('.input-queue, .stop-button') && document.querySelector('.thread').textContent.includes('Resumed from UI.')", "Paused message did not resume");
      console.log("[desktop-smoke] PASS: editable running composer, reasoning folding, inline Steer/cancel, more/details/edit, native browser layering, queue order, scoped drafts, distinct exchanges, stop and explicit resume");
      exitCode = 0;
    } catch (error) {
      console.error("[desktop-smoke] FAIL:", error);
      console.error("[desktop-smoke] State:", await window.webContents.executeJavaScript("JSON.stringify({ panelHidden: document.querySelector('.work-panel')?.hidden, tabs: document.querySelector('.work-tabs')?.textContent, images: [...document.querySelectorAll('.document-preview img')].map(image => ({ src: image.src.slice(0, 160), complete: image.complete, width: image.naturalWidth })) })"));
      console.error("[desktop-smoke] Frames:", window.webContents.mainFrame.frames.map((frame) => frame.url));
      await writeFile(path.join(os.tmpdir(), "pi-desktop-preview-failure.png"), (await window.webContents.capturePage()).toPNG());
    } finally {
      app.quit();
    }
  });
});
await import("../electron/main.mjs");
