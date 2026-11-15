# 常见故障排查

## npm 审计返回镜像 404

部分镜像没有实现 npm 的安全审计接口。本仓库 `.npmrc` 使用官方 registry；检查是否被当前终端环境或命令参数覆盖：

```powershell
npm config get registry
npm audit --omit=dev --registry=https://registry.npmjs.org
```

接口失败不代表审计无漏洞，不应通过关闭审计掩盖结果。

## Node 或 npm 版本不受支持

使用 `.node-version` 指定的 Node.js 和 npm 11，再运行 `npm ci`。项目支持 Node 24.10+ 的 24 系列和 Node 26 系列；其他主版本未列入承诺范围。不要删除锁文件解决版本错误。

## 打包缺少运行时或探针

`prepare:resources` 需要 PATH 中的 `uv` 和 Go，并访问对应版本的许可及模块源。它每次重建探针，失败会阻止打包，避免把旧探针或缺失功能当作成功发行：

```powershell
Get-Command uv,go
uv --version
go version
npm run prepare:resources
```

准备和打包应在项目目录运行，不手工复制其他版本的生成资源。

## 页面回归报告找不到懒加载文件

运行 UI 测试时重建 `out/` 会删除旧文件名。等待测试进程完全退出，先运行 `npm run build`，再串行运行 `test:ui`、`test:program-ui` 与 `test:session`。不要对正式运行中的开发工作台覆盖构建资源。测试失败报告位于忽略提交的 `test-results/`。

## Windows CI 将隔离临时目录识别为重定向

部分 Windows runner 的 `TEMP` / `TMP` 使用 8.3 短路径（例如 `RUNNER~1`），而文件系统返回长路径。若测试报“工具根目录不能通过链接重定向”或工具页无法显示，先核对 `node -p "require('node:os').tmpdir()"` 与 `node -p "require('node:fs').realpathSync(require('node:os').tmpdir())"`。

工作流在运行测试前将 `TEMP` / `TMP` 统一为真实路径，后续步骤通过 `GITHUB_ENV` 继承。手动运行测试时，可在当前 PowerShell 进程设置同样的临时目录；不要关闭产品的目录重定向保护或删除测试断言。

```powershell
$tempPath = node -p "require('node:fs').realpathSync(require('node:os').tmpdir())"
if ($LASTEXITCODE -ne 0) { throw '无法解析临时目录的真实路径' }
$env:TEMP = $tempPath
$env:TMP = $tempPath
```

## 新版拒绝替换管理服务

先查看应用提示：活动任务、进程采样未就绪或旧架构活动会话都会阻止替换。等任务完成，或按 README 中的旧架构迁移说明手动处理首次切换。不要删除状态文件或强制结束真实游戏进程以消除提示。

## 便携启动器提示当前版本尚未生成

根目录 `启动方舟MC.cmd` 从 `package.json` 读取版本，只启动对应文件，不按文件名猜测最新版本。源码使用者先运行 `npm run package`；普通使用者从 [Releases](https://github.com/xiangan666/ark-mc-studio/releases) 下载便携 EXE 直接运行。

## 发布未完成

区分源码已推送、标签已推送、草稿已创建、资产已核对和正式发布五个状态。通过 GitHub Actions 的具体失败日志定位问题，按 [发布指南](releasing.md) 恢复草稿；不得将本地文件、失败工作流或草稿描述为成功发布。
