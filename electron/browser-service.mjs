import { clipboard, Menu, session, shell, WebContentsView } from "electron";
import { websiteUrl } from "./browser-url.mjs";

// Remote pages have a separate in-memory browser session and no app preload,
// IPC bridge, Node integration or access to local preview URL handlers.
export class BrowserService {
  constructor(window) {
    this.window = window;
    this.views = new Map();
    this.browserSession = session.fromPartition("agentx-web-pages");
    this.browserSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
    this.browserSession.setPermissionCheckHandler(() => false);
    this.browserSession.on("will-download", (event) => event.preventDefault());
    window.once("closed", () => this.dispose());
    window.webContents.on("did-start-navigation", (_event, _url, _inPlace, mainFrame) => {
      if (mainFrame) this.dispose();
    });
  }

  emit(payload) {
    if (!this.window.isDestroyed()) this.window.webContents.send("browser:changed", payload);
  }

  snapshot(entry) {
    const contents = entry.view.webContents;
    return { id: entry.id, url: entry.url, title: contents.getTitle() || new URL(entry.url).host,
      loading: contents.isLoading(), canBack: contents.navigationHistory.canGoBack(), canForward: contents.navigationHistory.canGoForward(), error: entry.error || "" };
  }

  create(id, url) {
    if (this.views.size >= 24) throw new Error("最多同时打开 24 个网页，请先关闭不需要的标签。");
    const view = new WebContentsView({ webPreferences: {
      session: this.browserSession, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, disableDialogs: true,
    } });
    const entry = { id, view, url, error: "" };
    this.views.set(id, entry);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    const contents = view.webContents;
    const update = () => { if (!contents.isDestroyed()) this.emit({ type: "state", ...this.snapshot(entry) }); };
    const checkNavigation = (event, target) => {
      try { websiteUrl(target); }
      catch { event.preventDefault(); entry.error = "此链接不是可打开的网页地址。"; update(); }
    };
    contents.on("will-navigate", checkNavigation);
    contents.on("will-redirect", checkNavigation);
    contents.setWindowOpenHandler(({ url: target }) => {
      try { this.emit({ type: "open", openerId: id, url: websiteUrl(target) }); } catch { /* No arbitrary protocols or windows. */ }
      return { action: "deny" };
    });
    contents.on("did-start-loading", () => { entry.error = ""; update(); });
    contents.on("did-start-navigation", (_event, target, _inPlace, isMainFrame) => {
      if (!isMainFrame) return;
      try { entry.url = websiteUrl(target); update(); } catch { /* Navigation policy reports unsupported targets. */ }
    });
    for (const event of ["did-stop-loading", "did-navigate", "did-navigate-in-page", "page-title-updated"]) contents.on(event, update);
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      entry.error = `网页加载失败：${description}（${code}）`;
      view.setVisible(false);
      update();
    });
    contents.on("render-process-gone", () => { entry.error = "网页进程已停止，请刷新后重试。"; view.setVisible(false); update(); });
    contents.on("context-menu", (_event, params) => {
      const link = /^https?:\/\//i.test(params.linkURL || "") ? params.linkURL : null;
      Menu.buildFromTemplate(link ? [
        { label: "在工作面板中打开", click: () => this.emit({ type: "open", openerId: id, url: websiteUrl(link) }) },
        { label: "复制链接", click: () => clipboard.writeText(link) },
        { label: "在系统浏览器中打开", click: () => shell.openExternal(websiteUrl(link)) },
      ] : [{ role: "copy", enabled: Boolean(params.selectionText) }, { label: "刷新", click: () => contents.reload() }]).popup({ window: this.window });
    });
    this.navigate(entry, url);
    return entry;
  }

  navigate(entry, url) {
    entry.url = websiteUrl(url);
    entry.error = "";
    entry.view.webContents.loadURL(entry.url).catch(() => {}); // did-fail-load reports errors.
  }

  async command(command = {}) {
    if (command.type === "external") return shell.openExternal(websiteUrl(command.url));
    if (command.type === "link-menu") {
      const url = websiteUrl(command.url);
      Menu.buildFromTemplate([
        { label: "复制链接", click: () => clipboard.writeText(url) },
        { label: "在系统浏览器中打开", click: () => shell.openExternal(url) },
      ]).popup({ window: this.window });
      return;
    }
    const id = command.id;
    if (typeof id !== "string" || !id || id.length > 600) throw new Error("无效的网页标签。");
    let entry = this.views.get(id);
    if (command.type === "open") {
      const url = websiteUrl(command.url);
      entry ||= this.create(id, url);
    }
    if (!entry) return null;
    const contents = entry.view.webContents;
    switch (command.type) {
      case "open": case "state": break;
      case "navigate": this.navigate(entry, command.url); break;
      case "back": if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case "forward": if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case "reload": if (entry.error) this.navigate(entry, entry.url); else contents.reload(); break;
      case "stop": contents.stop(); break;
      case "hide": entry.view.setVisible(false); break;
      case "bounds": {
        const bounds = command.bounds;
        if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error("无效的网页显示区域。");
        const factor = this.window.webContents.getZoomFactor();
        const [width, height] = this.window.getContentSize();
        const x = Math.max(0, Math.min(width, Math.round(bounds.x * factor)));
        const y = Math.max(0, Math.min(height, Math.round(bounds.y * factor)));
        const rect = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * factor))), height: Math.max(0, Math.min(height - y, Math.round(bounds.height * factor))) };
        for (const other of this.views.values()) if (other !== entry) other.view.setVisible(false);
        entry.view.setBounds(rect);
        entry.view.setVisible(!entry.error && rect.width > 0 && rect.height > 0);
        break;
      }
      case "close":
        this.window.contentView.removeChildView(entry.view);
        contents.close();
        this.views.delete(id);
        return null;
      default: throw new Error("未知网页操作。");
    }
    return this.snapshot(entry);
  }

  dispose() {
    for (const { view } of this.views.values()) {
      if (!this.window.isDestroyed()) this.window.contentView.removeChildView(view);
      if (!view.webContents.isDestroyed()) view.webContents.close();
    }
    this.views.clear();
  }
}
