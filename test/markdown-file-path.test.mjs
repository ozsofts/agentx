import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { markdownFilePath } from "../src/markdown-file-path.js";
import { PreviewService } from "../electron/preview-service.mjs";

test("chat file links decode Chinese, spaces and reserved filename characters", () => {
  const file = "/Users/jack/Documents/Codex/projects/建筑行业/output/阜阳新工厂-V0.36/reviewed/model/modeling-report.json";
  const href = file.split("/").map(encodeURIComponent).join("/");
  assert.equal(markdownFilePath(href), file);
  assert.equal(markdownFilePath(file), file);
  assert.equal(markdownFilePath("/目录/报告%20副本%23%3F.json?view=source#L2"), "/目录/报告 副本#?.json");
  assert.equal(markdownFilePath("/report%2520.json"), "/report%20.json");
  assert.equal(markdownFilePath("/100%.json"), "/100%.json");
  assert.equal(markdownFilePath("/%E5.json"), "/%E5.json");
});

test("document links resolve relative to preview URLs and decode once", () => {
  const base = "pi-preview://token/%E9%A1%B5%E9%9D%A2/guide.md?v=1";
  assert.equal(markdownFilePath("../%E6%8A%A5%E5%91%8A%20%E5%89%AF%E6%9C%AC.json#L2", base), "报告 副本.json");
  assert.equal(markdownFilePath("part%2520.json", base), "页面/part%20.json");
});

test("encoded chat links open real Unicode files without decoding filesystem paths twice", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-markdown-link-"));
  const service = new PreviewService();
  t.after(async () => { service.dispose(); await rm(root, { recursive: true, force: true }); });
  await service.setWorkspace(root);
  const folder = path.join(root, "建筑行业", "阜阳新工厂-V0.36");
  await mkdir(folder, { recursive: true });
  for (const name of ["modeling-report.json", "报告 副本.json", "literal%20.json"]) {
    const file = path.join(folder, name);
    await writeFile(file, '{"status":"ready-with-assumptions"}');
    const href = file.split("/").map(encodeURIComponent).join("/");
    const doc = await service.read(markdownFilePath(href));
    assert.equal(doc.name, name);
    assert.equal(JSON.parse(doc.content).status, "ready-with-assumptions");
    const refreshed = await service.read(doc.path);
    assert.equal(refreshed.path, doc.path);
  }
});
