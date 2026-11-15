# 贡献指南

感谢你愿意改进 ArkMC Studio。请先搜索已有 Issue；较大的功能调整可以先开 Issue 讨论范围，再提交 Pull Request。

## 开发环境

- Windows x64
- Node.js 24.10+ 的 24 系列或 26 系列，以及 npm 11；发行构建使用 `.node-version` 中的版本
- `npm run prepare:resources` 需要 uv 0.12.20，以及 `tools/nethernet-route-check/go.mod` 指定的 Go 版本；每次从源码重建探针
- Git；仅发布和恢复 Release 时需要已登录的 GitHub CLI

首次安装依赖并准备本机资源：

```powershell
npm ci
npm run prepare:resources
```

本项目会自动发现本机已有的基岩版服务器。开发或 UI 测试时请使用隔离的数据和工具目录，并关闭自动发现：

```powershell
$env:ARK_MC_DATA = Join-Path $env:TEMP "arkmc-dev-data"
$env:ARK_MC_TOOLS = Join-Path $env:TEMP "arkmc-dev-tools"
$env:ARK_MC_NO_DISCOVER = "1"
npm run dev
```

不要将正式服务器目录、管理数据库、备份或真实隧道配置作为开发测试数据。

## 提交前验证

与改动范围相符地运行以下检查，并在 Pull Request 中写明结果：

```powershell
npm run check
npm audit --omit=dev --audit-level=moderate
npm run test:python
npm run test:go
npm run build
npm run test:program-ui
npm run test:session
```

`check` 串行执行 Prettier、项目一致性与本地文档链接检查、脚本语法、TypeScript 和单元测试。修改文件后运行 `npm run format`，不要手动改生成物。Python 测试依赖锁定在 `tests/requirements.txt`；Go 依赖由 `go.mod` 和 `go.sum` 管理。

## 依赖维护

项目级 `.npmrc` 使用官方 npm registry，确保审计接口可用。更新依赖后核对 `npm audit` 的完整结果和 `npm audit --omit=dev` 的运行依赖结果。当前 `overrides` 仅将 `readdir-glob`、`@electron/universal` 和 `app-builder-lib` 使用的 `minimatch` 固定为 11.0.1，以修复 GHSA-g3hv-75wg-m249；这些调用方使用已核对的命名导出和 `Minimatch` API，兼容性由备份测试及便携打包验证。上游依赖消除相关受影响版本后，应移除对应覆盖并重跑检查与打包。

npm 11 的 `allowScripts` 按实际包版本批准 esbuild、sharp，便携分发不使用 electron-winstaller，因此拒绝其安装脚本。新增或升级含安装脚本的依赖时，先审阅用途，再使用 `npm install-scripts approve <包名>` 或 `deny` 更新策略与锁文件；不要一次性批准所有依赖。

涉及页面或桌面流程时，先阅读 [界面设计规范](.github/INTERFACE.md)，再运行 `npm run test:ui`。该检查覆盖十五页、180 组主题／密度／窗口组合和任务分区；`scripts/ui-workspace-design.cjs` 检查分类键盘、ARIA 面板、固定实例范围、文件分栏与隐藏分区快捷入口，并生成脱敏截图。修改分区时应保留旧操作及安全限制的验证，不能只修改选择器使检查通过。涉及 Windows 便携程序时运行 `npm run package` 和 `npm run test:portable`。`npx tsx scripts/acceptance.ts` 会联网下载并启动隔离的官方服务器核心，使用测试端口 29482 及其相邻端口、临时目录和较多下载空间；它不是默认 CI，需要手动按脚本前置条件执行。

完整布局矩阵验证后，`npm run test:ui -- --skip-layout-matrix` 可重跑功能交互，报告中会记录跳过布局矩阵。不要在界面回归运行期间重建 `out/`，以免正在运行的页面缺少懒加载文件。测试数据和样本进程必须与正式服务器隔离。

## Pull Request

- 说明用户可观察到的变化、涉及的风险和验证结果。
- 界面改动附上脱敏截图，并说明 Windows 窗口尺寸或显示缩放。
- 数据迁移或文件操作改动说明失败和中断时的回退行为。
- 不提交 `node_modules`、`out`、`dist-agent`、`dist-direct`、`dist-network`、`dist-server`、`release`、`managed-tools`、`test-results` 或本机生成资源。
- 使用入口维护在 README，架构、配置、故障和发布流程分别维护于 `docs/`，不要重复复制同一事实；所有实际项目修改均更新版本与 CHANGELOG。
- 不提交凭证、服务器地址、玩家信息、真实世界数据、数据库、日志或诊断报告。

从真实默认分支 `main` 建立围绕任务的短期分支，按 Conventional Commits 提交，例如 `fix(config): 保留显式超时` 或 `docs: 更新开发说明`。PR 说明具体触发条件、改后行为、实际验证和必要回滚方式；不要暂存其他任务的文件。合并遵循远程保护与必需检查。

每轮修改都必须递增版本、提交与推送、创建版本标签并完成 GitHub Release 和远程资产核对；配套动作属于交付的一部分，详见 [发布指南](docs/releasing.md)。不能把只创建 PR、只推送标签、草稿或本地 EXE 当作正式发版。
