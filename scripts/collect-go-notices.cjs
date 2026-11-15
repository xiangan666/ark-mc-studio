const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
async function main() {
  const root = path.resolve(__dirname, "..");
  const output = execFileSync(
    "go",
    ["list", "-m", "-f", "{{.Path}}|{{.Version}}|{{.Dir}}", "all"],
    {
      cwd: path.join(root, "tools/nethernet-route-check"),
      encoding: "utf8",
      windowsHide: true,
    },
  );
  const go = JSON.parse(
    execFileSync("go", ["env", "-json", "GOROOT", "GOVERSION"], {
      cwd: path.join(root, "tools/nethernet-route-check"),
      encoding: "utf8",
      windowsHide: true,
    }),
  );
  const collected = [
    `Go ${go.GOVERSION} standard library\nLICENSE\n${await fs.readFile(path.join(go.GOROOT, "LICENSE"), "utf8")}`,
  ];
  for (const line of output.trim().split(/\r?\n/)) {
    const [name, version, directory] = line.split("|");
    if (!directory || name.startsWith("local/")) continue;
    const files = (await fs.readdir(directory)).filter((name) =>
      /^(license|copying|notice)([.-]|$)/i.test(name),
    );
    for (const file of files) {
      const target = path.join(directory, file);
      if (!(await fs.stat(target)).isFile()) continue;
      collected.push(
        `${name} ${version}\n${file}\n${await fs.readFile(target, "utf8")}`,
      );
    }
  }
  const notices = path.join(root, "resources/notices");
  await fs.mkdir(notices, { recursive: true });
  await fs.writeFile(
    path.join(notices, "Go-LICENSES.txt"),
    collected.join("\n\n" + "=".repeat(80) + "\n\n"),
  );
  console.log(`已汇总 ${collected.length} 份探针依赖许可。`);
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
