import { SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_SESSION_BYTES = 50 * 1024 * 1024;

export function inspectSessionContent(content) {
  if (Buffer.byteLength(content, "utf8") > MAX_SESSION_BYTES) throw new Error("会话文件不能超过 50 MB");
  let entries;
  try { entries = content.replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch { throw new Error("JSONL 格式有误，请选择 Pi 导出的完整会话文件"); }
  const header = entries[0];
  if (!header || header.type !== "session" || typeof header.id !== "string" || !header.id || ![1, 2, 3].includes(header.version) || typeof header.cwd !== "string") {
    throw new Error("文件不是受支持的 Pi 会话（需要有效的 session 文件头）");
  }
  const ids = new Set();
  for (const entry of entries.slice(1)) {
    if (!entry || typeof entry.type !== "string" || entry.type === "session") throw new Error("会话包含无效的记录");
    if (header.version >= 2) {
      if (typeof entry.id !== "string" || ids.has(entry.id) || (entry.parentId !== null && !ids.has(entry.parentId))) throw new Error("会话记录的 ID 或父级引用无效");
      ids.add(entry.id);
    }
    if (entry.type === "message" && (!entry.message || typeof entry.message.role !== "string")) throw new Error("会话消息格式无效");
  }
  const messages = entries.filter((entry) => entry.type === "message");
  if (!messages.some((entry) => entry.message.role === "user")) throw new Error("文件没有用户消息，不能导入空会话");
  const name = entries.filter((entry) => entry.type === "session_info").at(-1)?.name;
  return { sessionId: header.id, title: name || "导入的会话", sourceCwd: header.cwd, messageCount: messages.length };
}

export async function readSessionImport(filePath) {
  if (path.extname(filePath).toLowerCase() !== ".jsonl") throw new Error("请选择 .jsonl 会话文件");
  if ((await stat(filePath)).size > MAX_SESSION_BYTES) throw new Error("会话文件不能超过 50 MB");
  const content = await readFile(filePath, "utf8");
  return { content, ...inspectSessionContent(content) };
}

export async function importSessionContent(content, cwd, sessionDir) {
  inspectSessionContent(content);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-session-import-"));
  try {
    const source = path.join(temporary, "source.jsonl");
    await writeFile(source, content.replace(/^\uFEFF/, ""), "utf8");
    const imported = SessionManager.forkFrom(source, cwd, sessionDir);
    return { sessionId: imported.getSessionId(), sessionFile: imported.getSessionFile(), title: imported.getSessionName() || "导入的会话" };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
