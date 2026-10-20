export const imageExtensions = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"]]);
export const textExtensions = new Set([
  "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "yaml", "yml", "toml", "xml", "html", "htm",
  "css", "scss", "less", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt",
  "kts", "swift", "c", "h", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "ini",
  "conf", "properties", "log", "diff", "patch", "svg", "mermaid", "mmd",
]);

function imageType(bytes) {
  if ([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((byte, index) => bytes[index] === byte)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const header = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
  if (["GIF87a", "GIF89a"].includes(header(0, 6))) return "image/gif";
  if (bytes.length >= 12 && header(0, 4) === "RIFF" && header(8, 12) === "WEBP") return "image/webp";
  return null;
}

export async function readAttachmentFiles(files, { maxFiles = 8 } = {}) {
  const attachments = [];
  const rejected = [];
  let totalBytes = 0;
  for (const [index, file] of Array.from(files).entries()) {
    const name = file.name || `粘贴图片.${[...imageExtensions].find(([, type]) => type === file.type)?.[0] || "bin"}`;
    const extension = name.split(".").pop().toLowerCase();
    try {
      if (index >= maxFiles) throw new Error("每条消息最多添加 8 个附件");
      const mimeType = imageExtensions.get(extension);
      if (!mimeType && !textExtensions.has(extension)) throw new Error("当前版本仅支持图片、纯文本和常见代码文件");
      if (file.size > (mimeType ? 10 : 1) * 1024 * 1024) throw new Error(mimeType ? "图片不能超过 10 MB" : "文本文件不能超过 1 MB");
      if (totalBytes + file.size > 24 * 1024 * 1024) throw new Error("附件总大小不能超过 24 MB");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const metadata = { id: crypto.randomUUID(), name, size: bytes.length };
      if (mimeType) {
        if (imageType(bytes) !== mimeType) throw new Error("图片内容与扩展名不匹配");
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        attachments.push({ ...metadata, kind: "image", mimeType, data: btoa(binary) });
      } else {
        if (bytes.includes(0)) throw new Error("文件包含二进制内容，不能作为文本附件读取");
        let content;
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { throw new Error("当前版本仅支持 UTF-8 编码的文本文件"); }
        attachments.push({ ...metadata, kind: "text", mimeType: file.type || "text/plain", content });
      }
      totalBytes += bytes.length;
    } catch (error) { rejected.push({ name, message: error.message || "无法读取文件" }); }
  }
  return { attachments, rejected };
}
