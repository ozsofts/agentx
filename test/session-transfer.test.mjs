import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { importSessionContent, inspectSessionContent, readSessionImport } from "../electron/session-transfer.mjs";

const timestamp = new Date().toISOString();
const entries = [
  { type: "session", version: 3, id: "source-session", timestamp, cwd: "/old/project" },
  { type: "message", id: "user1", parentId: null, timestamp, message: { role: "user", content: "Question", timestamp: Date.now() } },
  { type: "message", id: "assistant1", parentId: "user1", timestamp, message: { role: "assistant", content: [{ type: "thinking", thinking: "Saved reasoning" }, { type: "toolCall", id: "call1", name: "read", arguments: { path: "notes.txt" } }], timestamp: Date.now() } },
  { type: "message", id: "tool1", parentId: "assistant1", timestamp, message: { role: "toolResult", toolCallId: "call1", toolName: "read", content: [{ type: "text", text: "Saved output" }], isError: false, timestamp: Date.now() } },
  { type: "message", id: "branch2", parentId: "user1", timestamp, message: { role: "assistant", content: [{ type: "text", text: "Other branch" }], timestamp: Date.now() } },
  { type: "session_info", id: "name1", parentId: "branch2", timestamp, name: "Imported history" },
];
const content = `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

test("session imports create distinct IDs in the chosen project and retain full history", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-transfer-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "new-project");
  await mkdir(cwd);
  const source = path.join(root, "source.jsonl");
  await writeFile(source, content);
  const inspected = await readSessionImport(source);
  assert.equal(inspected.title, "Imported history");
  assert.equal(inspected.messageCount, 4);
  const first = await importSessionContent(inspected.content, cwd, path.join(root, "sessions"));
  const second = await importSessionContent(inspected.content, cwd, path.join(root, "sessions"));
  assert.notEqual(first.sessionId, "source-session");
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(await readFile(source, "utf8"), content);
  const exported = (await readFile(first.sessionFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(exported[0].cwd, cwd);
  assert.deepEqual(exported.slice(1), entries.slice(1));
  const session = SessionManager.open(first.sessionFile, undefined, cwd);
  assert.equal(session.getSessionName(), "Imported history");
  assert.equal(session.getEntries().length, entries.length - 1);
});

test("imports reject malformed, incomplete, empty and unsupported sessions", () => {
  for (const invalid of ["", "not json", '{"type":"message"}', content + "broken", JSON.stringify(entries[0]),
    content.replace('"version":3', '"version":99'), content.replace('"parentId":"assistant1"', '"parentId":"missing"'),
    content.replace('"id":"tool1"', '"id":"assistant1"')]) assert.throws(() => inspectSessionContent(invalid));
  assert.equal(inspectSessionContent(`\uFEFF${content}`).messageCount, 4);
});
