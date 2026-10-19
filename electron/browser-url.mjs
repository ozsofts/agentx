export function websiteUrl(value) {
  const text = String(value || "").trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:/i.test(text) ? text : `https://${text}`);
  if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("请输入有效的 HTTP 或 HTTPS 网页地址。");
  }
  return url.href;
}
