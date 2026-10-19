import { randomBytes } from "node:crypto";
import { watch } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const PREVIEW_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "md", "markdown", "html", "htm", "mmd", "mermaid", "glb", "txt", "json", "css", "js", "ts", "jsx", "tsx", "py", "yml", "yaml"];
const images = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp"]);
const types = { ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".glb": "model/gltf-binary", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf" };
const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 20 * 1024 * 1024;
// Review models from the CAD3D pipeline are commonly 5-30 MB; textures and
// re-exported scenes can exceed that, so models get a wider read budget.
export const MODEL_LIMIT = 150 * 1024 * 1024;
const CSP = "default-src 'none'; img-src pi-preview: data:; style-src pi-preview: 'unsafe-inline'; font-src pi-preview: data:; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
export function previewKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (images.has(ext)) return "image";
  if (ext === ".glb") return "model";
  return ({ ".svg": "svg", ".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html", ".mmd": "mermaid", ".mermaid": "mermaid" })[ext] || "text";
}

// Each open document has a revocable URL and watches its own requested dependencies.
// Files outside the workspace need an explicit user grant; the renderer never widens
// the scope on its own.
export class PreviewService {
  constructor(onChange = () => {}) { this.onChange = onChange; this.documents = new Map(); this.grants = new Map(); }
  async setWorkspace(root) {
    const canonical = await realpath(root);
    if (this.root === canonical) return;
    this.dispose();
    this.grants.clear();
    this.root = canonical;
  }
  async authorize(file) {
    const resolved = await realpath(path.resolve(file));
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("请选择文件，不能授权目录。");
    if (!this.scopeFor(resolved)) this.grants.set(resolved, "file");
    return resolved;
  }
  async authorizeDirectory(directory) {
    const resolved = await realpath(path.resolve(directory));
    const info = await stat(resolved);
    if (!info.isDirectory()) throw new Error("请选择文件夹。");
    if (!this.scopeFor(resolved)) this.grants.set(resolved, "directory");
    return resolved;
  }
  grantsList() { return [...this.grants].map(([target, kind]) => ({ path: target, kind })); }
  revoke(target) {
    const resolved = path.resolve(target);
    let removed = false;
    for (const granted of [...this.grants.keys()]) {
      if (granted !== resolved && !inside(granted, resolved) && !inside(resolved, granted)) continue;
      this.grants.delete(granted);
      removed = true;
    }
    for (const document of [...this.documents.values()]) {
      if (!this.scopeFor(path.resolve(document.base, document.path))) this.close(document.path);
    }
    return removed;
  }
  scopeFor(target) {
    if (this.root && inside(this.root, target)) return { base: this.root, external: false };
    for (const [granted, kind] of this.grants) {
      if (kind === "file" ? target === granted : inside(granted, target)) {
        return { base: kind === "file" ? path.dirname(granted) : granted, external: true };
      }
    }
    return null;
  }
  async resolve(file, base = this.root) {
    if (!this.root) throw new Error("请先打开项目，再预览文件。");
    const requested = path.resolve(base, file);
    const resolved = await realpath(requested).catch((error) => {
      if (error.code === "ENOENT") throw new Error("文件不存在或已被移动。");
      throw error;
    });
    const scope = this.scopeFor(resolved);
    if (!scope) throw new Error(inside(base, requested) ? "文件链接指向项目外或已授权范围外，无法预览。" : "只能预览当前项目或已授权文件。");
    const info = await stat(resolved);
    if (!info.isFile()) throw new Error("请选择文件，不能预览目录。");
    if (this.scopeFor(resolved)?.base !== scope.base) throw new Error("授权已撤销，请重新打开文件。");
    return { root: scope.base, external: scope.external, resolved, info, relative: path.relative(scope.base, resolved).split(path.sep).join("/") };
  }
  track(document, file) {
    if (document.files.has(file)) return;
    if (document.files.size >= 128) throw new Error("预览引用的资源过多，请减少到 128 个以内。");
    document.files.add(file);
    const directory = path.dirname(file);
    if (document.watchers.has(directory)) return;
    const notify = (event, name) => {
      if (name && !document.files.has(path.join(directory, String(name)))) return;
      clearTimeout(document.timer);
      document.timer = setTimeout(() => this.onChange({ path: document.path }), 180);
    };
    try {
      const watcher = watch(directory, { persistent: false }, notify);
      watcher.on("error", () => { document.autoRefresh = false; this.onChange({ path: document.path }); });
      document.watchers.set(directory, watcher);
    } catch { document.autoRefresh = false; }
  }
  async read(file, base) {
    const { root, external, resolved, info, relative } = await this.resolve(file, base);
    const ext = path.extname(resolved).slice(1).toLowerCase();
    if (!PREVIEW_EXTENSIONS.includes(ext)) throw new Error("暂不支持此文件格式，请选择图片、Markdown、HTML、Mermaid 或文本文件。");
    const kind = previewKind(resolved);
    const binary = kind === "image" || kind === "model";
    const limit = kind === "model" ? MODEL_LIMIT : binary ? IMAGE_LIMIT : TEXT_LIMIT;
    if (info.size > limit) {
      if (kind === "model") throw new Error(`三维模型超过 ${Math.round(limit / 1024 / 1024)} MB，无法预览。`);
      throw new Error(binary ? "图片超过 20 MB，无法预览。" : "文本超过 2 MB，无法预览。");
    }
    const content = binary ? null : await readFile(resolved, "utf8");
    // A project switch or a revoked grant invalidates the read that just finished.
    if (this.scopeFor(resolved)?.base !== root) throw new Error("项目或授权已变更，请重新打开文件。");
    const documentPath = external ? resolved : relative;
    let document = [...this.documents.values()].find((entry) => entry.path === documentPath && entry.base === root);
    if (!document) {
      if (this.documents.size >= 24) throw new Error("最多同时预览 24 个文件，请先关闭部分标签。");
      document = { token: randomBytes(16).toString("hex"), path: documentPath, base: root, external, files: new Set(), watchers: new Map(), autoRefresh: true };
      this.documents.set(document.token, document);
    }
    this.track(document, path.resolve(root, relative));
    this.track(document, resolved);
    const url = `pi-preview://${document.token}/${relative.split("/").map(encodeURIComponent).join("/")}`;
    return { path: documentPath, name: path.basename(relative), kind, content, url, base: root, external, version: `${info.mtimeMs}-${info.size}`, autoRefresh: document.autoRefresh };
  }
  async resource(url) {
    try {
      const parsed = new URL(url);
      const document = this.documents.get(parsed.hostname);
      if (!document) return new Response("预览已关闭", { status: 404 });
      const relative = decodeURIComponent(parsed.pathname.slice(1));
      const { resolved, info } = await this.resolve(relative, document.base);
      const mime = types[path.extname(resolved).toLowerCase()];
      const limit = mime === "model/gltf-binary" ? MODEL_LIMIT : 20 * 1024 * 1024;
      if (!mime || info.size > limit) return new Response("不支持的预览资源", { status: 415 });
      this.track(document, resolved);
      const content = await readFile(resolved);
      if (!this.documents.has(document.token) || this.scopeFor(resolved)?.base !== document.base) return new Response("预览已关闭", { status: 404 });
      return new Response(content, { headers: { "Content-Type": mime, "Content-Security-Policy": CSP, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
    } catch { return new Response("文件不存在或超出项目范围", { status: 404 }); }
  }
  close(file) {
    for (const [token, document] of this.documents) {
      if (document.path !== file) continue;
      clearTimeout(document.timer);
      for (const watcher of document.watchers.values()) watcher.close();
      this.documents.delete(token);
    }
  }
  dispose() { for (const document of [...this.documents.values()]) this.close(document.path); }
}
