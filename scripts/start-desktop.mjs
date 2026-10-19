import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { desktopRuntime } from "./desktop-runtime.mjs";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const desktop = spawn(await desktopRuntime(), args.length ? args : [projectRoot], {
  cwd: projectRoot,
  env: process.env,
  stdio: "inherit",
});
desktop.once("error", (error) => {
  console.error(`[desktop] Agentx 启动失败：${error.message}`);
  process.exitCode = 1;
});
desktop.once("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => desktop.kill(signal));
