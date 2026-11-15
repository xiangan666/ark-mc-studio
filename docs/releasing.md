# 版本与 GitHub Release

唯一发布仓库是 [xiangan666/ark-mc-studio](https://github.com/xiangan666/ark-mc-studio)，下载入口是 [GitHub Releases](https://github.com/xiangan666/ark-mc-studio/releases)。每轮实际项目修改统一升版一次，文档、配置及内部维护默认升 PATCH；公共行为新增或破坏性变化按实际兼容性选择更高版本。

`package.json` 是版本事实源，`package-lock.json` 必须同步。桌面、后台、EXE 文件名和本地启动器均由该版本派生。1.5.0 及更早 CHANGELOG 是已有本地版本历史，本仓库不补造旧 Git 提交、标签或 Release。

## 发布前置条件

- Windows x64、Git、`.node-version` 中的 Node.js、npm 11、Go `go.mod` 指定版本和 uv 0.12.20。
- 可从 npm、PyPI、GitHub 和 Go 模块源获取锁定依赖与许可。
- 目标账号对仓库有推送权限；执行发布脚本时 GitHub CLI 已登录且有 Release 写权限。不要把令牌保存到源码或命令参数。
- 适用的本地检查、CI、评审和远程保护已满足。发布工作流的构建任务仅持有 `contents: read`，正式发布任务才有 `contents: write`。

## 维护者流程

在仓库根目录的 PowerShell 操作：

```powershell
# 实施阶段先在 Unreleased 记录变化；准备发行时整理成有实际日期的新版本节。
npm version patch --no-git-tag-version
npm run format
npm run check
npm audit --omit=dev --audit-level=moderate
npm run test:python
npm run test:go
npm run audit:go
npm run prepare:resources
npm run build
npm run test:ui
npm run test:program-ui
npm run test:session
```

`npm version` 同步两份清单后，还需更新 README 的当前版本、CHANGELOG 和相关使用说明。依赖变更使用 npm 更新锁文件；Python 测试依赖由 `tests/requirements.in` 生成，更新命令为：

```powershell
uv pip compile tests/requirements.in --python-version 3.13 --generate-hashes --output-file tests/requirements.txt
```

审核完整差异，显式暂存本任务文件并按 Conventional Commits 提交。源码提交通过默认分支的 CI 后，创建匹配版本的带注释标签：

```powershell
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
git tag -a "v$version" -m "ArkMC Studio $version"
git push origin "v$version"
```

将提交推送到真实开发分支并按仓库保护合并；上例不替代 PR 和必需检查。不得强推、移动已发布标签或覆盖旧 Release。

## 自动流程与资产

标签推送触发 `.github/workflows/release.yml`：

1. 调用 CI，执行 Node 24/26 的格式、一致性、类型、单元测试、生产依赖审计和构建，以及隔离 Python、Go、UI、版本更新和游戏宿主回归；govulncheck 检查 Go 探针及标准库的已知漏洞可达性。
2. 在标签提交重新构建 Windows x64 便携 EXE，执行 `test:portable`，生成版本、提交和资产清单。
3. 上传工作流产物，在独立发布任务创建或恢复 Release 草稿，上传资产并下载回来核对名称、大小、内容及 SHA-256。
4. 校验通过后正式发布为稳定版，核实标签、`latest` 和 Release 状态。

每版有三个显式下载资产：

| 资产                                  | 作用                                         |
| ------------------------------------- | -------------------------------------------- |
| `ArkMC-Studio-<版本>-Windows-x64.exe` | 可运行便携程序，包含必要说明及许可证         |
| `ArkMC-Studio-<版本>-SHA256SUMS.txt`  | EXE 的 SHA-256，用于核对下载一致性           |
| `ArkMC-Studio-<版本>-release.json`    | 源码提交 SHA、版本、平台、文件名、大小和摘要 |

GitHub 自动源码归档供审阅和开发使用，不等同于已构建的可执行程序；本项目不使用 LFS 或子模块。EXE 当前未做代码签名，摘要不证明发布者身份。世界、核心、穿透客户端及用户数据不预装。GitHub 当前单资产限制见 [官方 Releases 说明](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)，不得把未签名状态描述成已签名或已完成来源证明。

## 本地构建与恢复草稿

`npm run package` 需要已存在的真实 Git 提交，生成 `_work/package/` 中间文件和 `release/` 三个版本资产；`npm run release:verify` 根据当前提交重新核对。`release/` 也可能保留本地旧版，上传时只选择当前版本的三个文件。

自动流程失败时先查看真实失败步骤。修复未发布的流程后继续同一轮候选版本，不删除或移动已发布的标签。如果标签还未发布，可按项目实际情况推进新的候选提交；不要静默移动已推送的标签。

可在 GitHub Actions 手动运行 Release，填写已推送的标签；它重新验证该标签。草稿上传中断时可恢复；如果已有正式发布，脚本只核对，绝不替换其资产。需要从已验证的本地产物恢复发布时：

```powershell
npm run release:verify
npm run release:notes
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
./scripts/publish-release.ps1 -Tag "v$version"
```

该脚本先核实远程标签，再创建或恢复草稿，下载校验后发布。复用它只用于恢复同一发布流程，不与正在执行的 Actions 并行发版。仓库若启用 Immutable Releases，全部资产必须在草稿阶段完成；发布后不能追加或替换。只有 Release 正式发布且远程资产校验成功，才算完成发版。
