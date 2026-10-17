import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_TOOL_IDS,
  TOOL_CATALOG,
  describeRuntimeTool,
  normalizeToolIds,
  resolveEffectiveToolIds,
  runtimeToolNames,
} from "../electron/tool-registry.mjs";

test("exposes every Pi coding tool while preserving the Pi SDK defaults", () => {
  assert.deepEqual(TOOL_CATALOG.map((tool) => tool.runtimeName), ["read", "grep", "find", "ls", "edit", "write", "bash"]);
  assert.deepEqual(runtimeToolNames(DEFAULT_TOOL_IDS), ["read", "bash", "edit", "write"]);
  assert.equal(new Set(TOOL_CATALOG.map((tool) => tool.id)).size, TOOL_CATALOG.length);
});

test("normalizes unknown and duplicate tool ids", () => {
  assert.deepEqual(normalizeToolIds(["pi:read", "unknown", "pi:read", "pi:bash"]), ["pi:read", "pi:bash"]);
});

test("project tools inherit global settings unless explicitly customized", () => {
  const global = { enabled: ["pi:read", "pi:grep", "pi:bash"] };
  assert.deepEqual(resolveEffectiveToolIds(global, { mode: "inherit", enabled: [] }), global.enabled);
  assert.deepEqual(resolveEffectiveToolIds(global, { mode: "custom", enabled: ["pi:read"] }), ["pi:read"]);
  assert.deepEqual(resolveEffectiveToolIds(global, { mode: "custom", enabled: [] }), []);
});

test("unknown extension tools fail closed as executable operations", () => {
  const descriptor = describeRuntimeTool("external-tool");
  assert.equal(descriptor.risk, "execute");
  assert.equal(descriptor.sourceId, "extension");
});
