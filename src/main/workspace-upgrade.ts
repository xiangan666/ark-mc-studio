import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite, exists, json, safePath } from "../agent/safe";
import { networkProcesses } from "../agent/processes";
import { resolveTunnelClient } from "../agent/tunnel-clients";
import type { Bootstrap, ProcessInfo } from "../shared/types";
import type { WorkspaceUpgradeReport } from "../shared/workspace-upgrade";
import { tunnelClients, type TunnelProvider } from "../shared/network";

const normalized = (p: string) => path.resolve(p).toLowerCase();
async function treeSize(root: string): Promise<number> {
  let size = 0;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) throw new Error("资源目录含链接，已保留待检查");
    size += stat.isDirectory() ? await treeSize(file) : stat.size;
  }
  return size;
}

export async function upgradeWorkspace(options: {
  toolsRoot: string;
  currentResources: string;
  version: string;
  state: Pick<Bootstrap, "instances" | "jobs">;
  processes?: ProcessInfo[];
}): Promise<WorkspaceUpgradeReport> {
  const { toolsRoot, currentResources, version, state } = options;
  const report: WorkspaceUpgradeReport = {
    version,
    checkedAt: Date.now(),
    status: "complete",
    changes: [],
    retained: [],
    warnings: [],
    removedBytes: 0,
  };
  await fs.mkdir(toolsRoot, { recursive: true });
  const root = await fs.realpath(toolsRoot);
  if (normalized(root) !== normalized(toolsRoot))
    throw new Error("工具目录含重定向，未执行自动整理");
  // Repair the historical provider/tool alias without moving an installed binary.
  const legacy = path.join(root, "bin", "frp-panel", "current.json");
  const canonical = path.join(root, "bin", "frp", "current.json");
  if (!(await exists(canonical)) && (await exists(legacy))) {
    try {
      const receipt = await json<{ executable: string }>(legacy, {
        executable: "",
      });
      await safePath(root, receipt.executable);
      await atomicWrite(canonical, JSON.stringify(receipt, null, 2));
      report.changes.push(
        "旧 frp-panel 客户端登记已统一为官方 FRP；原登记保留以便回退",
      );
    } catch {
      report.warnings.push("旧 FRP 客户端登记失效，已保留原文件");
    }
  }
  const providers = new Set<TunnelProvider>();
  for (const instance of state.instances) {
    if (!instance.tunnelRoot) continue;
    try {
      const summaries = await json<{ provider?: TunnelProvider }[]>(
        path.join(instance.tunnelRoot, "tunnel-summary.json"),
        [],
      );
      for (const item of summaries)
        if (Object.hasOwn(tunnelClients, item.provider || "lolia"))
          providers.add(item.provider || "lolia");
    } catch {
      report.warnings.push(`${instance.name} 的网络摘要需要检查，原文件未修改`);
    }
  }
  for (const provider of providers) {
    const client = await resolveTunnelClient(root, provider);
    if (!client.ready) report.warnings.push(`${client.name}：${client.detail}`);
  }
  const processes = options.processes ?? (await networkProcesses());
  const hosts = path.join(root, "desktop-host");
  if (await exists(hosts)) {
    const entries = await fs.readdir(hosts, { withFileTypes: true });
    const candidates: { file: string; name: string; at: number }[] = [];
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^\d+\.\d+\.\d+-[a-f0-9]{16}$/.test(entry.name)
      )
        continue;
      const file = path.join(hosts, entry.name);
      const real = await fs.realpath(file);
      const prefix = normalized(file) + path.sep;
      const referenced =
        normalized(currentResources) === normalized(file) ||
        processes.some(
          (p) =>
            normalized(p.path || ".").startsWith(prefix) ||
            (p.command || "").toLowerCase().includes(prefix),
        ) ||
        state.instances.some((i) => normalized(i.root).startsWith(prefix));
      if (
        referenced ||
        real.toLowerCase() !== path.resolve(file).toLowerCase()
      ) {
        report.retained.push(
          `${entry.name}：当前版本、运行进程或目录链接仍在使用`,
        );
        continue;
      }
      if (
        !(await exists(path.join(file, ".ready"))) ||
        !(await exists(path.join(file, "agent", "agent.cjs")))
      ) {
        report.retained.push(`${entry.name}：未确认来源的目录已保留`);
        continue;
      }
      candidates.push({
        file,
        name: entry.name,
        at: (await fs.stat(file)).mtimeMs,
      });
    }
    candidates.sort((a, b) => b.at - a.at);
    // Keep one inactive host for rollback, in addition to every active host.
    if (candidates[0])
      report.retained.push(`${candidates[0].name}：保留一份回退资源`);
    if (state.jobs.some((j) => ["running", "queued"].includes(j.status)))
      report.warnings.push("有后台任务进行中，旧运行时清理已延后");
    else
      for (const candidate of candidates.slice(1)) {
        try {
          const checked = await safePath(
            root,
            path.relative(root, candidate.file),
          );
          if (path.dirname(checked).toLowerCase() !== hosts.toLowerCase())
            throw new Error("目录边界不符");
          const bytes = await treeSize(checked);
          // Recheck live references immediately before each removal.
          const live = options.processes ?? (await networkProcesses());
          const prefix = normalized(checked) + path.sep;
          if (
            live.some(
              (p) =>
                normalized(p.path || ".").startsWith(prefix) ||
                (p.command || "").toLowerCase().includes(prefix),
            )
          ) {
            report.retained.push(`${candidate.name}：新检测到进程引用，已保留`);
            continue;
          }
          await fs.rm(checked, { recursive: true });
          report.removedBytes += bytes;
          report.changes.push(`清理未使用的旧桌面运行时 ${candidate.name}`);
        } catch {
          report.warnings.push(`${candidate.name} 暂无法清理，已延后`);
        }
      }
  }
  report.status = report.warnings.length ? "attention" : "complete";
  const directory = path.join(root, "maintenance", "upgrades");
  // Each run has a receipt; the latest report is only an index, not the migration guard.
  const file = path.join(directory, `${version}-${report.checkedAt}.json`);
  await atomicWrite(file, JSON.stringify(report, null, 2));
  await atomicWrite(
    path.join(directory, "latest.json"),
    JSON.stringify(report, null, 2),
  );
  return report;
}
