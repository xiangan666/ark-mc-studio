# 配置与数据目录

本程序通过桌面表单、实例的 `server.properties` 和用户数据保存配置，不读取项目 `.env` 文件。开发时无需新增 `.env` 或把真实配置复制到源码目录。

## 启动环境变量

| 变量                 | 默认值与用途                                | 使用注意                                                                          |
| -------------------- | ------------------------------------------- | --------------------------------------------------------------------------------- |
| `ARK_MC_DATA`        | 未设置时为 Windows `%APPDATA%\ArkMC Studio` | 覆盖管理数据根目录；桌面偏好在其 `desktop/`，数据库、备份和会话资料也依赖此根目录 |
| `ARK_MC_TOOLS`       | 工作空间或便携程序目录下的 `managed-tools/` | 覆盖工具根目录；保存客户端、下载、运行环境及部署的后台资源                        |
| `ARK_MC_NO_DISCOVER` | 仅值 `1` 禁用本机已有服务器自动发现         | 开发和测试必须设为 `1`，不会禁用显式关联实例                                      |

便携 EXE 的程序目录由 electron-builder 设置的 `PORTABLE_EXECUTABLE_DIR` 确定；若其父目录有 `启动方舟MC.cmd`，采用父目录作为工作空间。因此仓库中 `release/` 的程序默认沿用仓库根目录的 `managed-tools/`，单独下载的程序默认使用自身所在目录。`ARK_MC_TOOLS` 显式值优先。

`PORTABLE_EXECUTABLE_FILE` 和 `ELECTRON_RENDERER_URL` 分别供便携启动器和开发服务器使用，不是普通部署配置。不要手动覆盖它们来迁移正式数据。

## 隔离开发

在仓库根目录的 PowerShell 执行：

```powershell
$env:ARK_MC_DATA = Join-Path $env:TEMP 'arkmc-dev-data'
$env:ARK_MC_TOOLS = Join-Path $env:TEMP 'arkmc-dev-tools'
$env:ARK_MC_NO_DISCOVER = '1'
npm run dev
```

这些设置仅作用于当前 PowerShell 及其子进程。测试脚本自己创建临时目录；不要把正式数据目录作为参数传入。开发结束后可关闭此终端恢复原环境。

## 迁移与恢复

1. 通过托盘正常退出旧工作台，确认保存关服与后台退出完成。
2. 分别备份用户数据根目录、`managed-tools/` 和实际服务器目录；它们可能位于三个位置。
3. 替换便携 EXE，保留上述目录，或通过两个 `ARK_MC_*` 目录变量显式指向原位置。
4. 检查实例路径、世界、备份列表、工具登记及 Windows 用户身份，确认后再启动服务器或线路。

不要手动改写 `.agent-state.json`、`server-hosts/` 鉴权文件或 SQLite。复制 DPAPI 保护的凭据到另一 Windows 用户后，需要在应用中重新保存凭据。

1.6.0 不引入数据模型迁移。命令面板新增的本机最近记录只保存入口标识，不保存搜索词、服务器路径或凭证；可从“最近使用”清除。若升级后发现问题，正常退出新程序，使用旧版 EXE 和升级前的对应数据备份恢复；正在运行的会话不能仅靠替换文件完成回滚。
