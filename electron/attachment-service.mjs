import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

export const MAX_ATTACHMENT_COUNT = 8;
export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 24 * 1024 * 1024;

const IMAGE_TYPES = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
]);

const TEXT_TYPES = new Map([
  [".txt", "text/plain"], [".md", "text/markdown"], [".markdown", "text/markdown"],
  [".json", "application/json"], [".jsonl", "application/x-ndjson"],
  [".csv", "text/csv"], [".tsv", "text/tab-separated-values"],
  [".yaml", "application/yaml"], [".yml", "application/yaml"], [".toml", "application/toml"],
  [".xml", "application/xml"], [".html", "text/html"], [".htm", "text/html"],
  [".css", "text/css"], [".scss", "text/x-scss"], [".less", "text/x-less"],
  [".js", "text/javascript"], [".jsx", "text/jsx"], [".ts", "text/typescript"], [".tsx", "text/tsx"],
  [".mjs", "text/javascript"], [".cjs", "text/javascript"], [".py", "text/x-python"],
  [".rb", "text/x-ruby"], [".go", "text/x-go"], [".rs", "text/x-rust"],
  [".java", "text/x-java"], [".kt", "text/x-kotlin"], [".kts", "text/x-kotlin"],
  [".swift", "text/x-swift"], [".c", "text/x-c"], [".h", "text/x-c"],
  [".cpp", "text/x-c++"], [".hpp", "text/x-c++"], [".cs", "text/x-csharp"],
  [".php", "text/x-php"], [".sh", "text/x-shellscript"], [".bash", "text/x-shellscript"],
  [".zsh", "text/x-shellscript"], [".fish", "text/x-shellscript"], [".ps1", "text/x-powershell"],
  [".sql", "application/sql"], [".ini", "text/plain"], [".conf", "text/plain"],
  [".properties", "text/plain"], [".log", "text/plain"], [".diff", "text/x-diff"],
  [".patch", "text/x-diff"], [".svg", "image/svg+xml"], [".mermaid", "text/plain"], [".mmd", "text/plain"],
]);

export const ATTACHMENT_DIALOG_EXTENSIONS = [
  ...new Set([...IMAGE_TYPES.keys(), ...TEXT_TYPES.keys()].map((extension) => extension.slice(1))),
];

function detectedImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return null;
}

async function loadAttachment(sourcePath) {
  const name = path.basename(sourcePath);
  const extension = path.extname(name).toLowerCase();
  const imageType = IMAGE_TYPES.get(extension);
  const textType = TEXT_TYPES.get(extension);
  if (!imageType && !textType) throw new Error("当前版本仅支持图片、纯文本和常见代码文件");

  const fileInfo = await stat(sourcePath);
  if (!fileInfo.isFile()) throw new Error("选择项不是文件");
  const limit = imageType ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES;
  if (fileInfo.size > limit) throw new Error(imageType ? "图片不能超过 10 MB" : "文本文件不能超过 1 MB");

  const buffer = await readFile(sourcePath);
  if (imageType) {
    if (detectedImageType(buffer) !== imageType) throw new Error("图片内容与扩展名不匹配");
    return { id: randomUUID(), kind: "image", name, mimeType: imageType, size: buffer.length, data: buffer.toString("base64") };
  }

  if (buffer.includes(0)) throw new Error("文件包含二进制内容，不能作为文本附件读取");
  let content;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new Error("当前版本仅支持 UTF-8 编码的文本文件");
  }
  return { id: randomUUID(), kind: "text", name, mimeType: textType, size: buffer.length, content };
}

export async function loadAttachments(sourcePaths, options = {}) {
  const maxFiles = Math.max(0, Math.min(MAX_ATTACHMENT_COUNT, Number(options.maxFiles) || MAX_ATTACHMENT_COUNT));
  const uniquePaths = [...new Set(Array.isArray(sourcePaths) ? sourcePaths : [])];
  const attachments = [];
  const rejected = [];
  let totalBytes = 0;

  for (const [index, sourcePath] of uniquePaths.entries()) {
    const name = path.basename(sourcePath);
    if (index >= maxFiles) {
      rejected.push({ name, message: `每条消息最多添加 ${MAX_ATTACHMENT_COUNT} 个附件` });
      continue;
    }
    try {
      const attachment = await loadAttachment(sourcePath);
      if (totalBytes + attachment.size > MAX_TOTAL_BYTES) throw new Error("附件总大小不能超过 24 MB");
      totalBytes += attachment.size;
      attachments.push(attachment);
    } catch (error) {
      rejected.push({ name, message: error.message || "无法读取文件" });
    }
  }
  return { attachments, rejected };
}
