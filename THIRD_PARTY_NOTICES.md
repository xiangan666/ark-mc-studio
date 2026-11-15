# 第三方组件

本项目代码使用 MIT 协议。打包程序包含下列第三方组件；版权和使用条款属于各自作者：

- Electron / Chromium：Electron MIT 及 Chromium 随附许可。便携程序解包内容保留 `LICENSE.electron.txt` 和 `LICENSES.chromium.html`。
- Node.js：MIT 及其依赖许可，构建时根据实际 Node.js 版本从对应标签收集 `LICENSE`。
- uv：MIT 或 Apache-2.0，https://github.com/astral-sh/uv 。
- React、Radix UI、Tailwind CSS、Lucide、Zustand、Motion、Vite、TypeScript 及其他 npm 组件：详见各包 `LICENSE`，版本由 `package-lock.json` 固定。
- Apache ECharts：Apache-2.0，https://github.com/apache/echarts 。
- NetherNet route-check：从 `tools/nethernet-route-check` 源码及 `go.mod` / `go.sum` 重建，实际 Go 工具链标准库与模块许可汇总至 `resources/notices/Go-LICENSES.txt`；它用于网络诊断，不实现完整游戏客户端。
- lego：可选的本机 ACME 签发与续期工具，MIT 许可；通过官方 go-acme/lego 发行渠道单独部署于 `managed-tools`，不预装在桌面包中。

Minecraft Bedrock Dedicated Server 和 Endstone 核心不预装进桌面包，安装时从官方渠道下载。Minecraft EULA：https://www.minecraft.net/eula 。Endstone 项目：https://github.com/EndstoneMC/endstone 。Lolia 服务：https://lolia.link 。

SakuraFrp 客户端不预装进桌面包，工具中心按需从其官方 API 与官方 CDN 下载，遵循 SakuraFrp 项目的许可及服务条款。官网：https://www.natfrp.com/ ，文档：https://doc.natfrp.com/ 。SakuraFrp 与 LoliaFRP 的客户端不互相替代。

ArkMC Studio 为独立管理工具，与 Mojang、Microsoft、EndstoneMC 或 Lolia 不存在官方隶属关系。

`npm run prepare:resources` 生成并内置 npm、Go、Node.js、uv 的许可文本；实际版本由锁文件与构建环境决定，生成的 `resources/notices/` 不手工编辑或提交。原有 MIT 版权、各组件作者与上游声明继续保留。
