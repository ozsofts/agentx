import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PreviewService } from "../electron/preview-service.mjs";

async function fixture(t, onChange) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-preview-"));
  const workspace = path.join(root, "project");
  await mkdir(workspace);
  const service = new PreviewService(onChange);
  await service.setWorkspace(workspace);
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  return { root, workspace, service };
}

test("preview serves relative HTML resources, UTF-8 paths and static SVG with restrictive headers", async (t) => {
  const { workspace, service } = await fixture(t);
  await mkdir(path.join(workspace, "页面"));
  await writeFile(path.join(workspace, "页面/index.html"), '<link rel="stylesheet" href="../style.css"><img src="图.svg">');
  await writeFile(path.join(workspace, "style.css"), "body { color: red; }");
  await writeFile(path.join(workspace, "页面/图.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const doc = await service.read("页面/index.html");
  assert.equal(doc.kind, "html");
  const html = await service.resource(doc.url);
  assert.match(html.headers.get("Content-Security-Policy"), /script-src 'none'/);
  assert.equal(html.headers.get("Cache-Control"), "no-store");
  assert.match(await html.text(), /style.css/);
  const css = await service.resource(new URL("../style.css", doc.url));
  assert.equal(css.status, 200);
  assert.equal(css.headers.get("Content-Type"), "text/css");
  const svg = await service.resource(new URL("图.svg", doc.url));
  assert.equal(svg.headers.get("Content-Type"), "image/svg+xml");
  service.close(doc.path);
  assert.equal((await service.resource(doc.url)).status, 404);
});

test("preview rejects traversal, external symlinks, private formats and oversized text", async (t) => {
  const { root, workspace, service } = await fixture(t);
  await writeFile(path.join(root, "outside.md"), "outside");
  await symlink(path.join(root, "outside.md"), path.join(workspace, "linked.md"));
  await writeFile(path.join(workspace, ".env"), "PRIVATE=test");
  await writeFile(path.join(workspace, "safe.md"), "# safe");
  await writeFile(path.join(workspace, "large.md"), "");
  await truncate(path.join(workspace, "large.md"), 2 * 1024 * 1024 + 1);
  await assert.rejects(service.read("../outside.md"), /当前项目/);
  await assert.rejects(service.read("linked.md"), /项目外/);
  await assert.rejects(service.read(".env"), /不支持/);
  await assert.rejects(service.read("large.md"), /超过/);
  const doc = await service.read("safe.md");
  assert.equal((await service.resource(new URL(".env", doc.url))).status, 415);
  assert.equal((await service.resource(new URL("linked.md", doc.url))).status, 404);
  await service.setWorkspace(root);
  assert.equal((await service.resource(doc.url)).status, 404, "workspace switch revokes old URLs");
});

test("preview observes referenced resources and atomic file replacement", async (t) => {
  const events = [];
  const { workspace, service } = await fixture(t, (event) => events.push(event));
  await writeFile(path.join(workspace, "index.html"), "first");
  await writeFile(path.join(workspace, "style.css"), "first");
  const doc = await service.read("index.html");
  await service.resource(new URL("style.css", doc.url));
  await writeFile(path.join(workspace, "style.css"), "updated");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(events.some((event) => event.path === "index.html"));
  events.length = 0;
  await writeFile(path.join(workspace, "replacement.tmp"), "replaced");
  await rename(path.join(workspace, "replacement.tmp"), path.join(workspace, "index.html"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.ok(events.some((event) => event.path === "index.html"));
  assert.equal((await service.read("index.html")).content, "replaced");
});

test("preview accepts canonical paths and directory aliases without allowing escapes", async (t) => {
  const { root, workspace, service } = await fixture(t);
  await writeFile(path.join(workspace, "guide.md"), "# alias");
  const alias = path.join(root, "alias");
  await symlink(workspace, alias, "dir");
  const document = await service.read(path.join(alias, "guide.md"));
  assert.equal(document.path, "guide.md");
  assert.equal(document.content, "# alias");
});

function headerFixture() {
  const header = Buffer.alloc(12);
  header.write("glTF", 0, "ascii");
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12, 8);
  return header;
}

test("preview serves binary GLB models with model/gltf-binary and its own size budget", async (t) => {
  const { root, workspace, service } = await fixture(t);
  const header = headerFixture();
  await writeFile(path.join(root, "outside.glb"), header);
  await writeFile(path.join(workspace, "总图模型.glb"), header);
  const doc = await service.read("总图模型.glb");
  assert.equal(doc.kind, "model");
  assert.equal(doc.content, null, "binary models are not read as text");
  const response = await service.resource(doc.url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "model/gltf-binary");
  assert.equal((await response.arrayBuffer()).byteLength, 12);

  await writeFile(path.join(workspace, "huge.glb"), "");
  await truncate(path.join(workspace, "huge.glb"), 150 * 1024 * 1024 + 1);
  await assert.rejects(service.read("huge.glb"), /三维模型超过 150 MB/);
  assert.equal((await service.resource(new URL("huge.glb", doc.url))).status, 415);
  await assert.rejects(service.read("../outside.glb"), /当前项目/);
});

test("explicit authorization opens files outside the project and stays revocable", async (t) => {
  const { root, workspace, service } = await fixture(t);
  const outside = path.join(root, "外部");
  await mkdir(outside);
  const model = path.join(outside, "总图.glb");
  const header = headerFixture();
  await writeFile(model, header);
  await writeFile(path.join(outside, "报告.md"), "# 外部");

  await assert.rejects(service.read(model), /只能预览当前项目或已授权文件/);
  const granted = await service.authorize(model);
  assert.equal(granted, await realpath(model));
  assert.deepEqual(service.grantsList(), [{ path: granted, kind: "file" }]);

  const doc = await service.read(granted);
  assert.equal(doc.external, true);
  assert.equal(doc.base, await realpath(outside));
  assert.equal(doc.path, granted);
  assert.equal(doc.kind, "model");
  const response = await service.resource(doc.url);
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 12);

  // A file grant never widens to its siblings.
  await assert.rejects(service.read(path.join(outside, "报告.md")), /只能预览当前项目或已授权文件/);
  await assert.rejects(service.read(outside), /当前项目或已授权文件/);

  assert.equal(service.revoke(granted), true);
  assert.deepEqual(service.grantsList(), []);
  await assert.rejects(service.read(granted), /当前项目或已授权文件/);
  assert.equal((await service.resource(doc.url)).status, 404, "revoking closes the open document");
});

test("authorizing a folder grants its relative resources but not other folders", async (t) => {
  const { root, workspace, service } = await fixture(t);
  const assets = path.join(root, "图纸");
  await mkdir(assets);
  await writeFile(path.join(assets, "index.html"), '<img src="图.svg">');
  await writeFile(path.join(assets, "图.svg"), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(root, "secret.md"), "secret");

  const directory = await service.authorizeDirectory(assets);
  assert.deepEqual(service.grantsList(), [{ path: directory, kind: "directory" }]);
  const doc = await service.read(path.join(directory, "index.html"));
  assert.equal(doc.external, true);
  assert.equal(doc.base, directory);
  assert.equal((await service.resource(doc.url)).status, 200);
  assert.equal((await service.resource(new URL("图.svg", doc.url))).headers.get("Content-Type"), "image/svg+xml");
  assert.equal((await service.resource(new URL("../secret.md", doc.url))).status, 404);

  await service.setWorkspace(root);
  assert.deepEqual(service.grantsList(), [], "switching projects drops external grants");
  assert.equal((await service.resource(doc.url)).status, 404);
});
