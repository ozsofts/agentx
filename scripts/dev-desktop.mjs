import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopRuntime } from "./desktop-runtime.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electronBinary = await desktopRuntime();
const preferredPort = Number(process.env.PI_DESKTOP_RENDERER_PORT || 4174);

function canListen(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

async function findPort(start) {
  for (let port = start; port < start + 20; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`找不到可用的渲染器端口（尝试了 ${start}-${start + 19}）`);
}

function waitForRenderer(url, timeoutMs = 20_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = fetch(url).then((response) => {
        if (response.ok) resolve();
        else retry();
      }).catch(retry);
      return request;
    };
    const retry = () => {
      if (Date.now() - startedAt > timeoutMs) reject(new Error(`渲染器未能在 ${timeoutMs}ms 内启动：${url}`));
      else setTimeout(check, 150);
    };
    check();
  });
}

const port = await findPort(preferredPort);
const rendererUrl = `http://127.0.0.1:${port}`;
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const vite = spawn(process.execPath, [viteBin, "--host", "127.0.0.1", "--port", String(port), "--strictPort"], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});
let desktop;
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (desktop && !desktop.killed) desktop.kill();
  if (vite && !vite.killed) vite.kill();
  setTimeout(() => process.exit(code), 100);
}

vite.once("error", (error) => {
  console.error(`[desktop-dev] Vite 启动失败：${error.message}`);
  shutdown(1);
});
vite.once("exit", (code, signal) => {
  if (!shuttingDown && code !== 0) {
    console.error(`[desktop-dev] Vite 已退出（code=${code}, signal=${signal || "none"}）`);
    shutdown(code || 1);
  }
});

try {
  await waitForRenderer(rendererUrl);
  console.log(`[desktop-dev] Renderer ready: ${rendererUrl}`);
  desktop = spawn(electronBinary, [projectRoot, "--dev"], {
    cwd: projectRoot,
    env: { ...process.env, PI_DESKTOP_RENDERER_URL: rendererUrl },
    stdio: "inherit",
  });
  desktop.once("error", (error) => {
    console.error(`[desktop-dev] Electron 启动失败：${error.message}`);
    shutdown(1);
  });
  desktop.once("exit", (code) => shutdown(code || 0));
} catch (error) {
  console.error(`[desktop-dev] ${error.message}`);
  shutdown(1);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

await delay(60_000_000);
