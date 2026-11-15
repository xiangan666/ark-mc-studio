import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ZipArchive } from "archiver";
import {
  atomicWrite,
  copyLimited,
  digest,
  extractZip,
  patchProperties,
  properties,
  redact,
  safePath,
  validateProperties,
  validateRelative,
} from "../src/agent/safe";
import { parseSaveQuery } from "../src/agent/backups";

test("保留中文、BOM、CRLF、注释与未知配置，追加新属性", () => {
  const input =
    "\uFEFF# 中文注释\r\nserver-name=原名称\r\ncustom-future=true\r\nmax-players=10\r\n";
  const output = patchProperties(input, {
    "server-name": "新的世界",
    "max-players": "20",
    transport: "nethernet",
  });
  assert(output.startsWith("\uFEFF# 中文注释\r\n"));
  assert(output.includes("custom-future=true\r\n"));
  assert(!output.replace(/\r\n/g, "").includes("\n"));
  assert.equal(properties(output)["server-name"], "新的世界");
  assert.equal(properties(output).transport, "nethernet");
});
test("拒绝端口越界、换行命令、非法世界名与错误模式", () => {
  for (const values of [
    { "server-port": "65536" },
    { "server-port": "-1" },
    { "max-players": "0" },
    { "level-name": "../世界" },
    { "server-name": "foo\nstop" },
    { gamemode: "invalid" },
  ])
    assert.throws(() =>
      validateProperties(values as unknown as Record<string, string>),
    );
  validateProperties({
    "server-port": "19132",
    "max-players": "20",
    "level-name": "问云-云境方舟",
  });
});
test("阻止路径穿越、盘符、ADS 与 Windows 保留设备名", () => {
  for (const rel of [
    "../secret",
    "a/../../secret",
    "C:\\secret",
    "a:b",
    "foo/CON.txt",
    "nul",
    "a/thing.",
    "a/thing ",
  ])
    assert.throws(() => validateRelative(rel));
  assert.equal(
    validateRelative("worlds/中文地图/db/CURRENT"),
    path.join("worlds", "中文地图", "db", "CURRENT"),
  );
});
test("实际文件系统限制链接逃逸及写入冲突", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-safe-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-outside-"));
  try {
    await fs.symlink(outside, path.join(root, "escape"), "junction");
    await assert.rejects(safePath(root, "escape/file", true), /外部/);
    await atomicWrite(path.join(root, "中文.txt"), "新值");
    assert.equal(
      await fs.readFile(path.join(root, "中文.txt"), "utf8"),
      "新值",
    );
    await assert.rejects(safePath(root, "../outside", true));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});
test("按服务端声明长度复制文件，不复制增长后的尾部", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-copy-"));
  try {
    await fs.writeFile(path.join(root, "source"), "12345append");
    await copyLimited(path.join(root, "source"), path.join(root, "dest"), 5);
    assert.equal(await fs.readFile(path.join(root, "dest"), "utf8"), "12345");
    await assert.rejects(
      copyLimited(path.join(root, "source"), path.join(root, "too-long"), 50),
      /短于/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("解析官方 save query 中文路径及精确文件长度", () => {
  const text =
    "[12:00:01 INFO]: Data saved. Files are now ready to be copied.\n[12:00:01 INFO]: 问云/db/CURRENT:16, 问云/db/000123.ldb:123456\n";
  assert.deepEqual(parseSaveQuery(text, "问云"), [
    { path: path.join("worlds", "问云", "db", "CURRENT"), size: 16 },
    { path: path.join("worlds", "问云", "db", "000123.ldb"), size: 123456 },
  ]);
  assert.equal(parseSaveQuery("[INFO]: Data not ready", "问云").length, 0);
});
test("诊断与错误信息隐藏 URL 令牌、访问命令与密码", () => {
  const text = redact(
    'https://api.lolia.link/?token=secret_value&id=3 password="secretpass" ./frpc -t 34727:private_token_123',
  );
  assert(!text.includes("secret_value"));
  assert(!text.includes("secretpass"));
  assert(!text.includes("private_token_123"));
});
async function zip(file: string, entry: string, data: string) {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file);
    const archive = new ZipArchive();
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    archive.append(data, { name: entry });
    void archive.finalize();
  });
}
test("ZIP 正常解包与炸弹体积限制", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-zip-"));
  try {
    await zip(path.join(root, "a.zip"), "中文/配置.json", "{}");
    await extractZip(path.join(root, "a.zip"), path.join(root, "ok"));
    assert.equal(
      await fs.readFile(path.join(root, "ok", "中文", "配置.json"), "utf8"),
      "{}",
    );
    await assert.rejects(
      extractZip(
        path.join(root, "a.zip"),
        path.join(root, "reject"),
        undefined,
        1,
      ),
      /过大/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("ZIP 中符号链接不被释放", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-linkzip-"));
  try {
    await new Promise<void>((resolve, reject) => {
      const out = createWriteStream(path.join(root, "a.zip"));
      const archive = new ZipArchive();
      out.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(out);
      archive.symlink("escape", "C:/Windows");
      void archive.finalize();
    });
    await assert.rejects(
      extractZip(path.join(root, "a.zip"), path.join(root, "out")),
      /符号链接/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
