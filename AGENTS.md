# 项目执行约定

## 目标与边界

ArkMC Studio 是 Windows x64 的 Electron 桌面应用。保持现有 TypeScript、React、独立管理服务和游戏会话宿主架构，依据真实代码自主完成最高质量的实现、验证与文档同步。

- 先检查 Git 状态和相关代码，保护已有改动、MIT 版权及第三方声明。
- 开发与测试必须使用临时数据、工具目录和 `ARK_MC_NO_DISCOVER=1`，不得操作正式世界、凭据或运行中的服务器。
- `_work/`、`managed-tools/` 和 `.gitignore` 列出的本机维护脚本不纳入提交或发布。
- 不强推，不覆盖已发布版本或标签，不绕过远程保护和检查。

## 命令

使用 Windows PowerShell、`.node-version` 指定的 Node.js 和 npm 11；依赖通过 `npm ci` 安装。

```powershell
npm run check
npm run build
npm run test:python
npm run test:go
npm run prepare:resources
npm run test:ui
npm run test:program-ui
npm run test:session
npm run package
npm run test:portable
```

`check` 包括格式、项目一致性、类型和单元测试。页面回归启动后不得重建 `out/`。联网核心验收仅按 [贡献指南](CONTRIBUTING.md) 的前置条件执行。

## 每轮修改必须升版和发布

每轮实际项目修改（包括文档、配置与维护）统一递增一次版本，更新 CHANGELOG，验证并提交本任务内容，推送提交与 `v<版本>` 标签，跟进 GitHub Release 和资产摘要核对。版本事实源为 `package.json`；同步锁文件，禁止手动维护另一份版本事实源。

发布目标为 `xiangan666/ark-mc-studio`，流程及恢复方法见 [发布指南](docs/releasing.md)。发布受阻时继续完成独立工作，明确报告“修改已完成，发布未完成”及具体阻塞，不把本地打包或草稿当成正式发布。

源码入口和信任边界见 [架构说明](docs/architecture.md)，环境变量见 [配置参考](docs/configuration.md)，页面约定见 [界面规范](.github/INTERFACE.md)。新文档默认中文，不复制整份通用提示词。
