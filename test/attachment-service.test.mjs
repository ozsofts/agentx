import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadAttachments } from "../electron/attachment-service.mjs";

test("loads UTF-8 text and validated images", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-attachments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const textPath = path.join(directory, "notes.md");
  const imagePath = path.join(directory, "pixel.png");
  await writeFile(textPath, "# Notes\n\nHello Pi\n", "utf8");
  await writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const result = await loadAttachments([textPath, imagePath]);

  assert.equal(result.rejected.length, 0);
  assert.equal(result.attachments[0].kind, "text");
  assert.equal(result.attachments[0].content, "# Notes\n\nHello Pi\n");
  assert.equal(result.attachments[1].kind, "image");
  assert.equal(result.attachments[1].mimeType, "image/png");
  assert.equal(result.attachments[1].data, "iVBORw0KGgo=");
});

test("rejects unsupported and binary files without dropping valid selections", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-attachments-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = path.join(directory, "query.sql");
  const pdfPath = path.join(directory, "document.pdf");
  const binaryPath = path.join(directory, "binary.txt");
  await writeFile(validPath, "select 1;", "utf8");
  await writeFile(pdfPath, "%PDF-1.7", "utf8");
  await writeFile(binaryPath, Buffer.from([0x41, 0x00, 0x42]));

  const result = await loadAttachments([validPath, pdfPath, binaryPath]);

  assert.deepEqual(result.attachments.map((item) => item.name), ["query.sql"]);
  assert.deepEqual(result.rejected.map((item) => item.name), ["document.pdf", "binary.txt"]);
});
