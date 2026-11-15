const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

const assetNames = (version) => {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("无效发行版本");
  const prefix = `ArkMC-Studio-${version}`;
  return {
    executable: `${prefix}-Windows-x64.exe`,
    checksum: `${prefix}-SHA256SUMS.txt`,
    manifest: `${prefix}-release.json`,
  };
};

async function fileHash(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

async function atomicWrite(file, data) {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temporary, data, { flag: "wx" });
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function finalizeRelease({ source, directory, version, commit }) {
  const names = assetNames(version);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("缺少真实发布提交 SHA");
  await fs.mkdir(directory, { recursive: true });
  const pending = path.join(
    directory,
    `.${names.executable}.${process.pid}.tmp`,
  );
  try {
    const sourceHash = await fileHash(source);
    await fs.copyFile(source, pending);
    if (sourceHash !== (await fileHash(pending)))
      throw new Error("便携程序复制校验失败");
    const handle = await fs.open(pending, "r");
    try {
      const header = Buffer.alloc(2);
      await handle.read(header, 0, 2, 0);
      if (header.toString("ascii") !== "MZ")
        throw new Error("便携程序不是 Windows 可执行文件");
    } finally {
      await handle.close();
    }
    const size = (await fs.stat(pending)).size;
    await fs.rename(pending, path.join(directory, names.executable));
    await atomicWrite(
      path.join(directory, names.checksum),
      `${sourceHash}  ${names.executable}\n`,
    );
    await atomicWrite(
      path.join(directory, names.manifest),
      JSON.stringify(
        {
          schemaVersion: 1,
          version,
          commit,
          platform: "win32",
          arch: "x64",
          files: [{ name: names.executable, size, sha256: sourceHash }],
        },
        null,
        2,
      ) + "\n",
    );
    return await verifyRelease({ directory, version, commit });
  } finally {
    await fs.rm(pending, { force: true });
  }
}

async function verifyRelease({ directory, version, commit }) {
  const names = assetNames(version);
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, names.manifest), "utf8"),
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.version !== version ||
    manifest.commit !== commit ||
    manifest.platform !== "win32" ||
    manifest.arch !== "x64"
  )
    throw new Error("发行清单版本、平台或提交不匹配");
  if (
    manifest.files?.length !== 1 ||
    manifest.files[0].name !== names.executable
  )
    throw new Error("发行清单文件名或数量不匹配");
  const file = manifest.files[0];
  const digest = await fileHash(path.join(directory, names.executable));
  const size = (await fs.stat(path.join(directory, names.executable))).size;
  const checksum = await fs.readFile(
    path.join(directory, names.checksum),
    "utf8",
  );
  if (
    digest !== file.sha256 ||
    size !== file.size ||
    checksum !== `${digest}  ${names.executable}\n`
  )
    throw new Error("发行资产摘要或大小不匹配");
  return manifest;
}

async function main() {
  const root = path.resolve(__dirname, "..");
  const version = require("../package.json").version;
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  const directory = process.argv[3]
    ? path.resolve(process.argv[3])
    : path.join(root, "release");
  const result =
    process.argv[2] === "verify"
      ? await verifyRelease({ directory, version, commit })
      : await finalizeRelease({
          source: path.join(
            root,
            "_work/package",
            assetNames(version).executable,
          ),
          directory,
          version,
          commit,
        });
  console.log(
    `发行资产已核对：${result.version}，提交 ${result.commit}，${result.files[0].size} 字节，SHA-256 ${result.files[0].sha256}`,
  );
}

module.exports = { assetNames, finalizeRelease, verifyRelease };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
