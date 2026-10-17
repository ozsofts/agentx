export function describeRequestError(raw, model) {
  const details = String(raw || "模型请求失败，未返回具体原因。");
  let message = "模型请求失败，请查看错误详情。";
  if (/insufficient[_ ]?(balance|quota)|credit balance|余额不足/i.test(details)) {
    message = "模型供应商余额或额度不足，请检查账户额度，或切换其他供应商。";
  } else if (/\b401\b|invalid[_ ]?api[_ ]?key|unauthorized|authentication/i.test(details)) {
    message = "模型认证失败，请在管理 → 模型中检查 API Key。";
  } else if (/\b403\b|forbidden|permission denied/i.test(details)) {
    message = "模型接口拒绝访问，请检查账户权限和模型访问权限。";
  } else if (/\b429\b|rate limit|too many requests/i.test(details)) {
    message = "模型请求受到频率限制，请稍后重试。";
  } else if (/timeout|timed out/i.test(details)) {
    message = "模型请求超时，请检查网络或稍后重试。";
  } else if (/fetch failed|ECONN|ENOTFOUND|network|connection/i.test(details)) {
    message = "无法连接模型接口，请检查网络和 Base URL。";
  } else if (/\b5\d{2}\b/i.test(details)) {
    message = "模型供应商服务异常，请稍后重试或切换供应商。";
  }
  return { message, details, provider: model?.provider, model: model?.model || model?.id };
}
