// Markdown hrefs are URL paths; the filesystem bridge expects decoded paths.
// Decode only at this boundary so literal percent sequences survive later reads.
export function markdownFilePath(href, resourceUrl) {
  const pathname = resourceUrl?.startsWith("pi-preview:")
    ? new URL(href, resourceUrl).pathname.slice(1)
    : href.split(/[?#]/)[0];
  try {
    return decodeURIComponent(pathname);
  } catch {
    // A literal or malformed percent sequence must not break the click handler.
    return pathname;
  }
}
