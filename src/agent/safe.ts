import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import yauzl from "yauzl";

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new Error("任务已取消"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
export const exists = async (file: string) =>
  !!(await fs.stat(file).catch(() => null));
export const json = async <T = any>(file: string, fallback: T): Promise<T> => {
  try {
    return JSON.parse((await fs.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
  } catch {
    return fallback;
  }
};
export const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
export async function fileHash(file: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
export const errorText = (error: unknown) =>
  redact(error instanceof Error ? error.message : String(error));
export function redact(text: string) {
  return text
    .replace(/(\bBearer\s+)[a-zA-Z0-9._~+\/-]+=*/gi, "$1[已隐藏]")
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[私钥已隐藏]",
    )
    .replace(/^(\s*user\s*=\s*)\S+/gm, "$1[已隐藏]")
    .replace(/(-t\s+\d+:)[a-zA-Z0-9_-]+/g, "$1[已隐藏]")
    .replace(
      /((?:token|password|secret|authorization|access_token)["'\s:=]+)[^\s,"'}]+/gi,
      "$1[已隐藏]",
    );
}
export function inside(root: string, target: string) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return (
    rel === "" ||
    (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function validateRelative(rel: string) {
  if (
    typeof rel !== "string" ||
    rel.includes("\0") ||
    path.isAbsolute(rel) ||
    /^[a-z]:/i.test(rel)
  )
    throw new Error("路径必须位于实例目录内");
  const parts = rel.replace(/\\/g, "/").split("/").filter(Boolean);
  if (
    parts.some(
      (p) =>
        p === ".." ||
        /[:<>|?*]/.test(p) ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new Error("不支持的路径或文件名");
  return parts.join(path.sep);
}
export async function safePath(root: string, rel = "", allowMissing = false) {
  const base = await fs.realpath(root);
  const target = path.resolve(base, validateRelative(rel));
  if (!inside(base, target)) throw new Error("路径超出实例目录");
  let current = target;
  while (true) {
    try {
      const real = await fs.realpath(current);
      if (!inside(base, real)) throw new Error("目录链接指向实例外部");
      break;
    } catch (error: any) {
      if (!allowMissing || error.code !== "ENOENT" || current === base)
        throw error;
      current = path.dirname(current);
    }
  }
  return target;
}
export async function atomicWrite(file: string, text: string | Buffer) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, text);
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export function properties(text: string) {
  const result: Record<string, string> = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = line.match(/^\s*([^#!\s=]+)\s*=(.*)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}
export function patchProperties(text: string, values: Record<string, string>) {
  const pending = new Map(Object.entries(values));
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\uFEFF?\s*[^#!\s=]+\s*=)(.*)$/);
    if (!match) return line;
    const key = match[1]
      .replace(/^\uFEFF/, "")
      .split("=")[0]
      .trim();
    if (!Object.hasOwn(values, key)) return line;
    pending.delete(key);
    return match[1] + values[key];
  });
  if (pending.size) {
    if (lines.at(-1) !== "") lines.push("");
    for (const [key, value] of pending) lines.push(`${key}=${value}`);
  }
  return lines.join(newline);
}
export function validateProperties(values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) {
    if (!/^[a-z0-9_-]+$/i.test(key) || /[\r\n\0]/.test(value))
      throw new Error("配置名称或值包含无效字符");
    if (
      ["server-port", "server-portv6"].includes(key) &&
      (!/^\d+$/.test(value) || +value < 1 || +value > 65535)
    )
      throw new Error("端口必须为 1–65535 的整数");
    if (
      ["max-players", "view-distance", "tick-distance"].includes(key) &&
      (!/^\d+$/.test(value) || +value < 1 || +value > 10000)
    )
      throw new Error(`${key} 必须为合理的正整数`);
    if (
      key === "gamemode" &&
      !["survival", "creative", "adventure"].includes(value)
    )
      throw new Error("无效的游戏模式");
    if (
      key === "difficulty" &&
      !["peaceful", "easy", "normal", "hard"].includes(value)
    )
      throw new Error("无效的难度");
    if (key === "transport" && !["nethernet", "raknet"].includes(value))
      throw new Error("无效的连接协议");
    if (
      key === "level-name" &&
      (!value || /[\\/:*?"<>|]/.test(value) || value === "..")
    )
      throw new Error("世界名称无效");
  }
}
export async function walk(
  root: string,
  excluded = new Set<string>(),
  prefix = "",
): Promise<{ path: string; size: number }[]> {
  const out: { path: string; size: number }[] = [];
  for (const entry of await fs.readdir(path.join(root, prefix), {
    withFileTypes: true,
  })) {
    if (
      excluded.has(entry.name) ||
      entry.isSymbolicLink() ||
      entry.name.startsWith(".ark-restore-")
    )
      continue;
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(root, excluded, rel)));
    else if (entry.isFile())
      out.push({
        path: rel,
        size: (await fs.stat(await safePath(root, rel))).size,
      });
  }
  return out;
}
export async function availableBytes(root: string) {
  const stat = await fs.statfs(root);
  return Number(stat.bavail) * Number(stat.bsize);
}
export async function copyLimited(
  source: string,
  destination: string,
  length: number,
  signal?: AbortSignal,
) {
  if (!Number.isSafeInteger(length) || length < 0)
    throw new Error("无效的备份文件长度");
  if ((await fs.stat(source)).size < length)
    throw new Error("源文件短于服务器声明的长度");
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (!length) await fs.writeFile(destination, Buffer.alloc(0));
  else
    await pipeline(
      createReadStream(source, { start: 0, end: length - 1 }),
      createWriteStream(destination),
      { signal },
    );
  if ((await fs.stat(destination)).size !== length)
    throw new Error("备份文件长度校验失败");
}
export async function extractZip(
  file: string,
  destination: string,
  signal?: AbortSignal,
  maxBytes = 30 * 1024 ** 3,
) {
  await fs.mkdir(destination, { recursive: true });
  const free = await availableBytes(destination);
  let total = 0;
  let count = 0;
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      file,
      { lazyEntries: true, validateEntrySizes: true, strictFileNames: true },
      (err, value) => (err ? reject(err) : resolve(value!)),
    ),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        zip.close();
        reject(new Error("任务已取消"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      zip.on("error", reject);
      zip.on("end", () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      });
      zip.on("entry", async (entry: yauzl.Entry) => {
        try {
          signal?.throwIfAborted();
          if (++count > 150000) throw new Error("安装包文件数量过多");
          const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
          if (unixType === 0o120000)
            throw new Error("安装包中不允许使用符号链接");
          total += entry.uncompressedSize;
          if (total > maxBytes || total + 128 * 1024 ** 2 > free)
            throw new Error("安装包过大或磁盘剩余空间不足");
          const target = await safePath(
            destination,
            entry.fileName.replace(/\/$/, ""),
            true,
          );
          if (/\/$/.test(entry.fileName))
            await fs.mkdir(target, { recursive: true });
          else {
            await fs.mkdir(path.dirname(target), { recursive: true });
            const stream = await new Promise<Readable>((res, rej) =>
              zip.openReadStream(entry, (err, value) =>
                err ? rej(err) : res(value!),
              ),
            );
            await pipeline(stream, createWriteStream(target, { flags: "wx" }), {
              signal,
            });
          }
          zip.readEntry();
        } catch (error) {
          zip.close();
          reject(error);
        }
      });
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return { files: count, bytes: total };
}
export async function tail(file: string, bytes = 768 * 1024) {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - bytes);
    const buf = Buffer.alloc(Math.min(stat.size, bytes));
    const { bytesRead } = await handle.read(buf, 0, buf.length, start);
    const text = buf.subarray(0, bytesRead).toString("utf8");
    return {
      text: start ? text.slice(text.indexOf("\n") + 1) : text,
      size: stat.size,
    };
  } finally {
    await handle.close();
  }
}
