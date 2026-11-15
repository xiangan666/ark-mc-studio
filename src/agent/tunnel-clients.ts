import path from "node:path";
import { tunnelClients, type TunnelProvider } from "../shared/network";
import { exists, json, safePath } from "./safe";

export interface TunnelClientStatus {
  provider: TunnelProvider;
  tool: "lolia" | "sakura" | "frp";
  name: string;
  format: string;
  ready: boolean;
  version?: string;
  executable?: string;
  detail: string;
}

/** A provider is resolved through its tool receipt, never through an arbitrary frpc.exe. */
export async function resolveTunnelClient(
  toolsRoot: string,
  provider: TunnelProvider,
): Promise<TunnelClientStatus> {
  const spec = tunnelClients[provider];
  const base = {
    provider,
    ...spec,
    tool: spec.tool as TunnelClientStatus["tool"],
  };
  try {
    const receipt = await json<{
      executable?: string;
      version?: string;
    } | null>(path.join(toolsRoot, "bin", spec.tool, "current.json"), null);
    if (receipt?.executable) {
      const executable = await safePath(toolsRoot, receipt.executable, true);
      if (await exists(executable))
        return {
          ...base,
          ready: true,
          executable,
          version: receipt.version,
          detail: "已识别托管客户端",
        };
      return {
        ...base,
        ready: false,
        detail: "登记的客户端文件已缺失，请在工具与环境重新安装",
      };
    }
    return {
      ...base,
      ready: false,
      detail: `尚未安装${spec.name}，请在工具与环境下载`,
    };
  } catch {
    return {
      ...base,
      ready: false,
      detail: "客户端登记无效或路径越界，请重新安装对应工具",
    };
  }
}
