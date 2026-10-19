import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const run = promisify(execFile);

// app.setName() only changes Electron's internal name. macOS reads its menu
// and Dock labels from the running .app bundle, including during development.
export async function desktopRuntime() {
  const electronBinary = require("electron");
  if (process.platform !== "darwin") return electronBinary;

  const source = path.resolve(path.dirname(electronBinary), "../..");
  const sourceInfo = await stat(path.join(source, "Contents/Info.plist"));
  const version = require("electron/package.json").version;
  const cache = path.join(path.dirname(require.resolve("electron/package.json")), "../.cache/agentx-electron");
  const destination = path.join(cache, `${version}-${Math.trunc(sourceInfo.mtimeMs)}-v2`);
  const bundle = path.join(destination, "Agentx.app");
  // Keep Electron's executable name: it identifies the un-packaged runtime.
  // Renaming it flips app.isPackaged and can change application/data behavior.
  const binary = path.join(bundle, "Contents/MacOS/Electron");
  try {
    await access(path.join(destination, "ready.json"));
    await access(binary, constants.X_OK);
    return binary;
  } catch { /* Prepare a fresh runtime when Electron changes or the cache is absent. */ }

  await mkdir(cache, { recursive: true });
  const staging = await mkdtemp(path.join(cache, ".prepare-"));
  try {
    console.log("[desktop] Preparing Agentx.app for macOS…");
    const stagedBundle = path.join(staging, "Agentx.app");
    await cp(source, stagedBundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    const info = path.join(stagedBundle, "Contents/Info.plist");
    for (const [key, value] of Object.entries({
      CFBundleName: "Agentx",
      CFBundleDisplayName: "Agentx",
      CFBundleIdentifier: "com.piagent.desktop.development",
    })) {
      await run("/usr/bin/plutil", ["-replace", key, "-string", value, info]);
    }
    // Re-sign only the cached copy; keep the installed Electron runtime intact.
    await run("/usr/bin/codesign", ["--force", "--deep", "--sign", "-", stagedBundle]);
    await writeFile(path.join(staging, "ready.json"), JSON.stringify({ version }));
    try {
      await rename(staging, destination);
    } catch (error) {
      // Another launcher may have finished preparing the same runtime first.
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      await readFile(path.join(destination, "ready.json"));
    }
    return binary;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
