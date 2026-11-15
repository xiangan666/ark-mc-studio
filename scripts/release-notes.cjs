const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const version = require("../package.json").version;
const changelog = fs.readFileSync(path.join(root, "CHANGELOG.md"), "utf8");
const section = changelog
  .split(/^## /m)
  .find((value) => value.startsWith(`[${version}] - `));
if (!section) throw new Error(`CHANGELOG 缺少 ${version} 的发布记录`);
const notes = `# ArkMC Studio ${version}\n\n${section.slice(section.indexOf("\n") + 1).trim()}\n\n完整记录：[CHANGELOG](https://github.com/xiangan666/ark-mc-studio/blob/v${version}/CHANGELOG.md)。\n\n下载 Windows x64 便携 EXE，按发布页的 SHA256SUMS 核对文件；校验和用于确认下载一致性，不代表代码签名。升级前正常退出旧工作台并保留用户数据与 managed-tools 目录。\n`;
const output = path.join(root, "_work", "release-notes.md");
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, notes);
console.log(`发布说明已生成：${output}`);
