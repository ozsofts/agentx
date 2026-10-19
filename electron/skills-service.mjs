import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const bundledRoot = path.join(moduleDir, "bundled-skills");
const MAX_FILES = 300;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

const bundledCatalog = [
  {
    id: "project-overview",
    name: "project-overview",
    title: "项目概览",
    description: "快速梳理代码库结构、技术栈、关键入口与运行方式。",
    category: "项目理解",
    version: "1.0.0",
    author: "Agentx",
    sourceType: "bundled",
  },
  {
    id: "test-and-fix",
    name: "test-and-fix",
    title: "测试与修复",
    description: "运行最相关的测试，定位失败原因并完成小范围修复。",
    category: "工程质量",
    version: "1.0.0",
    author: "Agentx",
    sourceType: "bundled",
  },
  {
    id: "code-review",
    name: "code-review",
    title: "代码审查",
    description: "审查当前改动中的缺陷、回归风险、安全问题和测试缺口。",
    category: "工程质量",
    version: "1.0.0",
    author: "Agentx",
    sourceType: "bundled",
  },
];

function assertWorkspace(cwd) {
  if (!cwd) throw new Error("请先选择工作目录");
  return path.resolve(cwd);
}

function assertSkillName(name) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(name)) {
    throw new Error(`Skill 名称不合法：${name || "未命名"}`);
  }
  return name;
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readInstallState(cwd) {
  const stateFile = path.join(cwd, ".pi", "desktop-skills.json");
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    if (parsed?.version !== 1 || !parsed.skills || typeof parsed.skills !== "object") throw new Error("格式无效");
    return parsed;
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, skills: {} };
    throw new Error(`无法读取桌面端 Skill 安装记录：${error.message}`);
  }
}

async function writeInstallState(cwd, state) {
  const stateFile = path.join(cwd, ".pi", "desktop-skills.json");
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  await mkdir(path.dirname(stateFile), { recursive: true });
  await writeFile(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporaryFile, stateFile);
}

async function inspectDirectory(sourcePath) {
  const resolved = await realpath(path.resolve(sourcePath));
  const rootStat = await lstat(resolved);
  if (!rootStat.isDirectory()) throw new Error("请选择包含 SKILL.md 的文件夹");
  const skillFile = path.join(resolved, "SKILL.md");
  const skillStat = await lstat(skillFile).catch(() => null);
  if (!skillStat?.isFile()) throw new Error("所选文件夹根目录中没有 SKILL.md");

  const loaded = loadSkillsFromDir({ dir: resolved, source: "desktop-local" });
  const errors = loaded.diagnostics.filter((item) => item.type === "error");
  if (errors.length) throw new Error(errors.map((item) => item.message).join("；"));
  const rootSkill = loaded.skills.find((skill) => path.resolve(skill.baseDir) === resolved);
  if (!rootSkill) throw new Error("无法从所选文件夹读取有效的 Skill");
  assertSkillName(rootSkill.name);

  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      const relativePath = path.relative(resolved, absolutePath);
      if (entry.isSymbolicLink()) throw new Error(`Skill 中不允许符号链接：${relativePath}`);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) throw new Error(`Skill 中包含不支持的文件类型：${relativePath}`);
      const stat = await lstat(absolutePath);
      totalBytes += stat.size;
      files.push({ absolutePath, relativePath, size: stat.size });
      if (files.length > MAX_FILES) throw new Error(`Skill 文件数不能超过 ${MAX_FILES}`);
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("Skill 总大小不能超过 8 MB");
    }
  }
  await visit(resolved);

  const markdown = await readFile(rootSkill.filePath, "utf8");
  const body = markdown.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(await readFile(file.absolutePath));
    hash.update("\0");
  }

  return {
    sourcePath: resolved,
    name: rootSkill.name,
    title: rootSkill.name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" "),
    description: rootSkill.description,
    content: body,
    files: files.map((file) => file.relativePath),
    fileCount: files.length,
    totalBytes,
    hash: hash.digest("hex"),
    diagnostics: loaded.diagnostics,
    disableModelInvocation: rootSkill.disableModelInvocation,
  };
}

async function copyDirectory(files, sourceRoot, targetRoot) {
  for (const relativePath of files) {
    const source = path.join(sourceRoot, relativePath);
    const target = path.join(targetRoot, relativePath);
    const sourceStat = await lstat(source);
    if (!sourceStat.isFile()) throw new Error(`复制期间文件类型发生变化：${relativePath}`);
    const resolvedSource = await realpath(source);
    if (!isWithin(sourceRoot, resolvedSource)) throw new Error(`复制来源超出 Skill 目录：${relativePath}`);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
}

export class SkillsService {
  constructor({ cwd, reload }) {
    this.cwd = assertWorkspace(cwd);
    this.reload = reload;
  }

  async inspect(sourcePath) {
    const skill = await inspectDirectory(sourcePath);
    return { ...skill, id: `local:${skill.hash}`, sourceType: "local", category: "本地导入", author: "本地文件夹", version: "本地" };
  }

  async list() {
    const state = await readInstallState(this.cwd);
    const catalog = await Promise.all(bundledCatalog.map(async (entry) => {
      const sourcePath = path.join(bundledRoot, entry.id);
      const inspected = await inspectDirectory(sourcePath);
      const record = state.skills[entry.name];
      return {
        ...entry,
        content: inspected.content,
        files: inspected.files,
        fileCount: inspected.fileCount,
        totalBytes: inspected.totalBytes,
        hash: inspected.hash,
        installed: Boolean(record),
        installedAt: record?.installedAt,
        managed: Boolean(record),
      };
    }));

    const loaded = [];
    for (const record of Object.values(state.skills)) {
      if (catalog.some((entry) => entry.name === record.name)) continue;
      const targetPath = path.join(this.cwd, ".pi", "skills", record.name);
      try {
        const inspected = await inspectDirectory(targetPath);
        loaded.push({
          id: `installed:${record.name}`,
          name: record.name,
          title: record.title || inspected.title,
          description: inspected.description,
          category: "已安装",
          version: record.version || "本地",
          author: record.author || "本地文件夹",
          sourceType: record.sourceType,
          sourcePath: record.sourcePath,
          content: inspected.content,
          files: inspected.files,
          fileCount: inspected.fileCount,
          totalBytes: inspected.totalBytes,
          hash: inspected.hash,
          installed: true,
          installedAt: record.installedAt,
          managed: true,
        });
      } catch (error) {
        loaded.push({
          id: `installed:${record.name}`,
          name: record.name,
          title: record.title || record.name,
          description: `安装目录不可用：${error.message}`,
          category: "需要处理",
          version: record.version || "本地",
          author: record.author || "本地文件夹",
          sourceType: record.sourceType,
          sourcePath: record.sourcePath,
          content: "",
          files: [],
          fileCount: 0,
          totalBytes: 0,
          installed: true,
          installedAt: record.installedAt,
          managed: true,
          broken: true,
        });
      }
    }
    return { skills: [...catalog, ...loaded], installRoot: path.join(this.cwd, ".pi", "skills") };
  }

  async install(command) {
    const catalogEntry = command.catalogId ? bundledCatalog.find((entry) => entry.id === command.catalogId) : null;
    const sourcePath = catalogEntry ? path.join(bundledRoot, catalogEntry.id) : command.sourcePath;
    if (!sourcePath) throw new Error("缺少 Skill 来源");
    const inspected = await inspectDirectory(sourcePath);
    if (catalogEntry && inspected.name !== catalogEntry.name) throw new Error("内置 Skill 元数据不一致");

    const skillsRoot = path.join(this.cwd, ".pi", "skills");
    const targetPath = path.join(skillsRoot, inspected.name);
    if (!isWithin(skillsRoot, targetPath)) throw new Error("安装路径超出工作区 Skills 目录");
    const state = await readInstallState(this.cwd);
    if (state.skills[inspected.name]) throw new Error(`${inspected.name} 已安装`);
    try {
      await lstat(targetPath);
      throw new Error(`${targetPath} 已存在；桌面端不会覆盖未登记的目录`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await mkdir(skillsRoot, { recursive: true });
    const temporaryPath = path.join(skillsRoot, `.${inspected.name}.${process.pid}.tmp`);
    await rm(temporaryPath, { recursive: true, force: true });
    await mkdir(temporaryPath, { recursive: true });
    let targetCreated = false;
    try {
      await copyDirectory(inspected.files, inspected.sourcePath, temporaryPath);
      const copied = await inspectDirectory(temporaryPath);
      if (copied.hash !== inspected.hash) throw new Error("复制后的 Skill 完整性校验失败");
      await rename(temporaryPath, targetPath);
      targetCreated = true;
      state.skills[inspected.name] = {
        name: inspected.name,
        title: catalogEntry?.title || inspected.title,
        sourceType: catalogEntry ? "bundled" : "local",
        sourcePath: catalogEntry ? undefined : inspected.sourcePath,
        catalogId: catalogEntry?.id,
        version: catalogEntry?.version || "本地",
        author: catalogEntry?.author || "本地文件夹",
        hash: inspected.hash,
        installedAt: new Date().toISOString(),
      };
      await writeInstallState(this.cwd, state);
    } catch (error) {
      await rm(temporaryPath, { recursive: true, force: true });
      if (targetCreated) await rm(targetPath, { recursive: true, force: true });
      throw error;
    }
    let reloadWarning;
    if (command.reload !== false) {
      try {
        await this.reload?.();
      } catch (error) {
        reloadWarning = `Skill 已安装，但 Agentx 重载失败：${error.message}`;
      }
    }
    return { ...await this.list(), reloadWarning };
  }

  async remove(name, options = {}) {
    assertSkillName(name);
    const state = await readInstallState(this.cwd);
    if (!state.skills[name]) throw new Error("只能卸载由 Agentx 安装的 Skill");
    const skillsRoot = path.join(this.cwd, ".pi", "skills");
    const targetPath = path.join(skillsRoot, name);
    if (!isWithin(skillsRoot, targetPath)) throw new Error("卸载路径超出工作区 Skills 目录");
    const temporaryPath = path.join(skillsRoot, `.${name}.${process.pid}.remove`);
    await rm(temporaryPath, { recursive: true, force: true });
    let moved = false;
    try {
      await rename(targetPath, temporaryPath);
      moved = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      delete state.skills[name];
      await writeInstallState(this.cwd, state);
      if (moved) await rm(temporaryPath, { recursive: true, force: true });
    } catch (error) {
      if (moved) await rename(temporaryPath, targetPath);
      throw error;
    }
    let reloadWarning;
    if (options.reload !== false) {
      try {
        await this.reload?.();
      } catch (error) {
        reloadWarning = `Skill 已卸载，但 Agentx 重载失败：${error.message}`;
      }
    }
    return { ...await this.list(), reloadWarning };
  }

  async reloadSkills() {
    await this.reload?.();
    return this.list();
  }
}
