import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectStore } from "../electron/project-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-desktop-project-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userData = path.join(root, "user-data");
  const workspace = path.join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  return { root, userData, workspace, store: new ProjectStore(userData) };
}

test("restores a project from its portable manifest", async (t) => {
  const { store, workspace } = await fixture(t);
  await mkdir(path.join(workspace, ".pi"), { recursive: true });
  await writeFile(path.join(workspace, ".pi", "project.json"), JSON.stringify({
    schemaVersion: 1,
    projectId: "project_portable",
    name: "Portable project",
    lastSessionId: "session_1",
    sessions: [{
      sessionId: "session_1",
      title: "Recovered session",
      sessionFile: "/tmp/session-1.jsonl",
      archived: false,
    }],
    settings: { model: "provider::model", permissionMode: "full" },
  }));

  const project = await store.ensure(workspace);

  assert.equal(project.id, "project_portable");
  assert.equal(project.name, "Portable project");
  assert.equal(project.sessions[0].title, "Recovered session");
  assert.deepEqual(project.settings, {
    model: "provider::model",
    permissionMode: "full",
    tools: { mode: "inherit", enabled: [] },
  });
});

test("keeps the project identity when a manifest-backed directory moves", async (t) => {
  const { root, store, workspace } = await fixture(t);
  const original = await store.ensure(workspace, "Move me");
  await store.syncManifest(original);
  const movedWorkspace = path.join(root, "moved-workspace");
  await rename(workspace, movedWorkspace);

  const moved = await store.ensure(movedWorkspace);

  assert.equal(moved.id, original.id);
  assert.equal(moved.rootPath, movedWorkspace);
  assert.equal((await store.list()).length, 1);
});

test("reconciles Pi sessions without losing Desktop metadata", async (t) => {
  const { store, workspace } = await fixture(t);
  const project = await store.ensure(workspace, "Sessions");
  await store.update(project.id, {
    lastSessionId: "session_archived",
    sessions: [{
      sessionId: "session_archived",
      title: "Custom title",
      sessionFile: "/old/session.jsonl",
      archived: true,
    }],
  });

  const reconciled = await store.reconcileSessions(project.id, [
    {
      sessionId: "session_archived",
      title: "Pi title",
      sessionFile: "/new/session.jsonl",
      messageCount: 3,
      firstMessage: "hello",
      lastOpenedAt: "2026-09-09T10:00:00.000Z",
    },
    {
      sessionId: "session_new",
      title: "New persisted session",
      sessionFile: "/new/session-2.jsonl",
      messageCount: 2,
      firstMessage: "new message",
      lastOpenedAt: "2026-09-09T11:00:00.000Z",
    },
    {
      sessionId: "session_empty",
      title: "新建会话",
      sessionFile: "/new/empty.jsonl",
      messageCount: 0,
      firstMessage: "",
    },
  ]);

  assert.equal(reconciled.sessions.length, 2);
  const archived = reconciled.sessions.find((item) => item.sessionId === "session_archived");
  assert.equal(archived.title, "Custom title");
  assert.equal(archived.archived, true);
  assert.equal(archived.sessionFile, "/new/session.jsonl");
  assert.equal(reconciled.lastSessionId, "session_new");
  assert.equal(reconciled.sessions.some((item) => item.sessionId === "session_empty"), false);
});

test("sorts active pinned projects before recent and archived projects", async (t) => {
  const { root, store } = await fixture(t);
  const firstRoot = path.join(root, "first");
  const secondRoot = path.join(root, "second");
  await mkdir(firstRoot);
  await mkdir(secondRoot);
  const first = await store.ensure(firstRoot, "First");
  const second = await store.ensure(secondRoot, "Second");
  await store.update(first.id, { pinned: true });

  let projects = await store.list();
  assert.equal(projects[0].id, first.id);

  await store.update(first.id, { archived: true });
  projects = await store.list();
  assert.equal(projects[0].id, second.id);
  assert.equal(projects.at(-1).id, first.id);
});

test("keeps a persisted session whose title is 新建会话", async (t) => {
  const { store, workspace } = await fixture(t);
  const project = await store.ensure(workspace, "Title edge case");
  await store.update(project.id, {
    sessions: [{ sessionId: "session_named_new", title: "新建会话", sessionFile: "/tmp/named-new.jsonl" }],
  });

  const restored = await store.get(project.id);

  assert.equal(restored.sessions.length, 1);
  assert.equal(restored.sessions[0].sessionId, "session_named_new");
});

test("moves the default session when the current session is archived", async (t) => {
  const { store, workspace } = await fixture(t);
  const project = await store.ensure(workspace, "Archive default");
  await store.update(project.id, {
    lastSessionId: "session_current",
    sessions: [
      { sessionId: "session_current", title: "Current", sessionFile: "/tmp/current.jsonl" },
      { sessionId: "session_next", title: "Next", sessionFile: "/tmp/next.jsonl" },
    ],
  });

  const updated = await store.updateSession(project.id, "session_current", { archived: true });

  assert.equal(updated.lastSessionId, "session_next");
  assert.equal(updated.sessions[0].archived, true);
});

test("persists project tool overrides in the portable manifest", async (t) => {
  const { store, workspace } = await fixture(t);
  const project = await store.ensure(workspace, "Tool settings");
  const updated = await store.update(project.id, {
    settings: { tools: { mode: "custom", enabled: ["pi:read", "pi:grep"] } },
  });
  await store.syncManifest(updated);

  const manifest = await store.readManifest(workspace);

  assert.deepEqual(manifest.settings.tools, { mode: "custom", enabled: ["pi:read", "pi:grep"] });
});
