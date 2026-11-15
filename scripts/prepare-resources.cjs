const fs = require("node:fs/promises"),
  path = require("node:path"),
  { execFile } = require("node:child_process"),
  { createHash } = require("node:crypto"),
  { promisify } = require("node:util"),
  sharp = require("sharp");
async function copyRuntime(source, destination) {
  const sourceData = await fs.readFile(source);
  const destinationData = await fs.readFile(destination).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const digest = (data) => createHash("sha256").update(data).digest("hex");
  if (destinationData && digest(sourceData) === digest(destinationData)) return;
  await fs.copyFile(source, destination);
}
async function main() {
  const root = path.resolve(__dirname, "..");
  const resources = path.join(root, "resources");
  const notices = path.join(resources, "notices");
  await fs.mkdir(notices, { recursive: true });
  const lock = JSON.parse(
    await fs.readFile(path.join(root, "package-lock.json"), "utf8"),
  );
  const licenses = [];
  for (const [relative, item] of Object.entries(lock.packages)) {
    if (!relative || item.dev || item.link) continue;
    const folder = path.join(root, relative);
    const files = await fs.readdir(folder);
    const text = await Promise.all(
      files
        .filter((name) => /^(licen[sc]e|copying|notice)([.-]|$)/i.test(name))
        .map(async (name) => {
          const file = path.join(folder, name);
          return (await fs.stat(file)).isFile()
            ? `${name}\n${await fs.readFile(file, "utf8")}`
            : "";
        }),
    );
    licenses.push(
      `\n${"=".repeat(80)}\n${relative} — ${item.version}\nLicense: ${item.license || "See package source"}\n${text.join("\n\n")}`,
    );
  }
  await fs.writeFile(
    path.join(notices, "npm-licenses.txt"),
    licenses.join("\n"),
  );
  const uv = await promisify(execFile)(
    "powershell.exe",
    ["-NoProfile", "-Command", "(Get-Command uv -ErrorAction Stop).Source"],
    { windowsHide: true, timeout: 30000 },
  ).then((r) => r.stdout.trim());
  const uvVersion = (
    await promisify(execFile)(uv, ["--version"], {
      windowsHide: true,
      timeout: 30000,
    })
  ).stdout.match(/^uv (\d+\.\d+\.\d+)/)?.[1];
  if (!uvVersion) throw new Error("无法核实 uv 版本");
  for (const [filename, url] of [
    [
      "Node-LICENSE.txt",
      `https://raw.githubusercontent.com/nodejs/node/v${process.versions.node}/LICENSE`,
    ],
    [
      "uv-LICENSE-MIT.txt",
      `https://raw.githubusercontent.com/astral-sh/uv/${uvVersion}/LICENSE-MIT`,
    ],
    [
      "uv-LICENSE-APACHE.txt",
      `https://raw.githubusercontent.com/astral-sh/uv/${uvVersion}/LICENSE-APACHE`,
    ],
  ]) {
    const file = path.join(notices, filename);
    const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!response.ok)
      throw new Error(
        `无法读取第三方许可：${filename}（HTTP ${response.status}）`,
      );
    await fs.writeFile(file, await response.text());
  }
  await fs.mkdir(path.join(resources, "runtime"), { recursive: true });
  await fs.mkdir(path.join(resources, "probes"), { recursive: true });
  await copyRuntime(
    process.execPath,
    path.join(resources, "runtime", "node.exe"),
  );
  await copyRuntime(uv, path.join(resources, "runtime", "uv.exe"));
  const probe = path.join(resources, "probes", "route-check.exe");
  await promisify(execFile)("go", ["mod", "download"], {
    cwd: path.join(root, "tools/nethernet-route-check"),
    windowsHide: true,
    timeout: 180000,
  });
  await promisify(execFile)(
    "go",
    ["build", "-mod=readonly", "-trimpath", "-o", probe, "."],
    {
      cwd: path.join(root, "tools/nethernet-route-check"),
      env: { ...process.env, GOOS: "windows", GOARCH: "amd64" },
      windowsHide: true,
      timeout: 180000,
    },
  );
  await promisify(execFile)(
    process.execPath,
    [path.join(__dirname, "collect-go-notices.cjs")],
    { windowsHide: true, timeout: 180000 },
  );
  await sharp(path.join(resources, "icon.svg"))
    .resize(512)
    .png()
    .toFile(path.join(resources, "icon.png"));
  const png = await sharp(path.join(resources, "icon.svg"))
    .resize(256)
    .png()
    .toBuffer();
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10);
  header.writeUInt16LE(32, 12);
  header.writeUInt32LE(png.length, 14);
  header.writeUInt32LE(22, 18);
  await fs.writeFile(
    path.join(resources, "icon.ico"),
    Buffer.concat([header, png]),
  );
  console.log(
    `桌面图标、Node ${process.versions.node}、uv ${uvVersion}、源码重建的握手探针和依赖许可已准备。`,
  );
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
