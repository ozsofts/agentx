import assert from "node:assert/strict";
import test from "node:test";
import { websiteUrl } from "../electron/browser-url.mjs";

test("web addresses normalize for tab reuse without losing query or fragment", () => {
  assert.equal(websiteUrl(" example.com "), "https://example.com/");
  assert.equal(websiteUrl("HTTPS://EXAMPLE.COM:443/path?q=1#part"), "https://example.com/path?q=1#part");
  assert.equal(websiteUrl("http://127.0.0.1:4175/"), "http://127.0.0.1:4175/");
});

test("remote tabs reject local resources, executable protocols and embedded credentials", () => {
  for (const value of ["", "file:///etc/passwd", "pi-preview://token/private.md", "javascript:alert(1)", "data:text/html,hello", "about:blank", "https://user:secret@example.com", "http://"]) {
    assert.throws(() => websiteUrl(value), undefined, value);
  }
});
