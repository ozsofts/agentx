import assert from "node:assert/strict";
import test from "node:test";
import { readAttachmentFiles } from "../src/attachment-files.js";

const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test("clipboard files retain image bytes and UTF-8 text while rejecting disguised binaries", async () => {
  const result = await readAttachmentFiles([
    new File([png], "screenshot.png", { type: "image/png" }),
    new File(["# 项目说明\nconst value = 1;"], "说明.md", { type: "text/plain" }),
    new File(["not a picture"], "disguised.png", { type: "image/png" }),
    new File([Uint8Array.from([0xff])], "bad.txt"),
    new File([Uint8Array.from([0])], "binary.txt"),
    new File(["%PDF-1.7"], "report.pdf"),
  ]);
  assert.deepEqual(result.attachments.map((file) => file.kind), ["image", "text"]);
  assert.deepEqual(new Uint8Array(Buffer.from(result.attachments[0].data, "base64")), png);
  assert.equal(result.attachments[1].content, "# 项目说明\nconst value = 1;");
  assert.equal(result.rejected.length, 4);
  assert.match(result.rejected[0].message, /不匹配/);
  assert.match(result.rejected[1].message, /UTF-8/);
  assert.match(result.rejected[2].message, /二进制/);
});

test("clipboard limits reject overlarge files before reading them and honor remaining slots", async () => {
  const result = await readAttachmentFiles([
    { name: "huge.txt", size: 1024 * 1024 + 1, arrayBuffer: () => { throw new Error("Should not read"); } },
    new File(["ok"], "notes.txt"),
    new File([png], "extra.png"),
  ], { maxFiles: 2 });
  assert.deepEqual(result.attachments.map((file) => file.name), ["notes.txt"]);
  assert.match(result.rejected[0].message, /1 MB/);
  assert.match(result.rejected[1].message, /8 个/);
  assert.equal((await readAttachmentFiles([new File(["ok"], "notes.txt")], { maxFiles: 0 })).attachments.length, 0);
});
