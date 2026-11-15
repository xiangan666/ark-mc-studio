const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function main() {
  const root = path.resolve(__dirname, "..");
  const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
  const pkg = JSON.parse(read("package.json"));
  const lock = JSON.parse(read("package-lock.json"));
  const errors = [];
  const check = (condition, message) => {
    if (!condition) errors.push(message);
  };
  check(/^\d+\.\d+\.\d+$/.test(pkg.version), "版本必须是稳定 SemVer");
  check(
    lock.version === pkg.version && lock.packages[""].version === pkg.version,
    "package.json 与锁文件版本不同步",
  );
  for (const field of ["dependencies", "devDependencies", "engines"]) {
    check(
      JSON.stringify(pkg[field]) === JSON.stringify(lock.packages[""][field]),
      `${field} 与锁文件不同步；请使用 npm 更新锁文件`,
    );
  }
  check(/^npm@11\.\d+\.\d+$/.test(pkg.packageManager), "缺少 npm 11 版本约束");
  check(
    /^26\.\d+\.\d+$/.test(read(".node-version").trim()),
    "缺少 Node 26 构建版本",
  );
  const changelog = read("CHANGELOG.md");
  check(changelog.includes("## [Unreleased]"), "CHANGELOG 缺少 Unreleased");
  check(
    changelog.includes(`## [${pkg.version}] - `),
    "CHANGELOG 缺少当前候选版本及日期",
  );
  check(
    read("README.md").includes(`**${pkg.version}**`),
    "README 当前版本与清单不同步",
  );
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", windowsHide: true },
  )
    .split("\0")
    .filter(Boolean);
  check(files.length > 0, "没有找到项目源码；请先初始化或克隆 Git 仓库");
  const forbidden =
    /^(?:managed-tools|_work|_maintenance|_downloads|node_modules|out|dist-[^/]+|release[^/]*|test-results|logs)\/|(?:^|\/)\.env(?:\.|$)|\.(?:sqlite(?:-[^/]*)?|db|pfx|pem|key|dmp|log)$/i;
  const secrets = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
    /\bAKIA[A-Z0-9]{16}\b/,
  ];
  let links = 0;
  for (const relative of files) {
    check(!forbidden.test(relative), `源码包含本机数据或敏感文件：${relative}`);
    const file = path.join(root, relative);
    const stat = fs.lstatSync(file);
    check(!stat.isSymbolicLink(), `源码不应包含本机目录链接：${relative}`);
    if (!stat.isFile()) continue;
    check(stat.size < 10 * 1024 * 1024, `源码文件异常大：${relative}`);
    if (
      !/\.(?:md|json|[cm]?js|tsx?|py|go|ps1|ya?ml|html|css|cmd|txt|in)$/.test(
        relative,
      )
    )
      continue;
    const content = read(relative);
    check(
      !secrets.some((pattern) => pattern.test(content)),
      `疑似真实密钥：${relative}（内容已隐藏）`,
    );
    if (!relative.endsWith(".md")) continue;
    for (const match of content.matchAll(
      /\]\((<?[^\s)]+>?)(?:\s+"[^"]*")?\)/g,
    )) {
      const target = match[1].replace(/^<|>$/g, "");
      if (/^[a-z][a-z0-9+.-]*:|^#/.test(target)) continue;
      const name = decodeURIComponent(target.split("#")[0]);
      if (!name) continue;
      const destination = path.resolve(path.dirname(file), name);
      check(
        destination.startsWith(root + path.sep) && fs.existsSync(destination),
        `无效本地链接：${relative} → ${target}`,
      );
      links++;
    }
  }
  for (const name of fs.readdirSync(path.join(root, "scripts"))) {
    if (!files.includes(`scripts/${name}`) || !name.endsWith(".cjs")) continue;
    execFileSync(
      process.execPath,
      ["--check", path.join(root, "scripts", name)],
      { stdio: "pipe", windowsHide: true },
    );
  }
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `项目检查通过：版本 ${pkg.version}，${files.length} 个源码文件，${links} 个本地文档链接，脚本语法与发布边界一致。`,
  );
}
try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
