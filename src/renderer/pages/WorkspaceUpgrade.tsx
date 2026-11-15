import { useState } from "react";
import { CheckCircle2, FolderCheck, RefreshCw } from "lucide-react";
import { Badge, Button, Drawer, Notice, useQuery } from "../components";
import { act, bytes, date } from "../store";
import type { WorkspaceUpgradeReport } from "../../shared/workspace-upgrade";

export default function WorkspaceUpgrade() {
  const q = useQuery<{
    running: boolean;
    report: WorkspaceUpgradeReport | null;
  }>("workspace.upgrade.get", {}, 15000);
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  if (!q.data && !q.error) return null;
  const report = q.data?.report;
  return (
    <>
      <div className="workspace-upgrade-strip">
        <FolderCheck size={16} />
        <div>
          <strong>
            {q.data?.running
              ? "正在检查与整理旧版数据…"
              : report?.status === "complete"
                ? "版本数据检查完成"
                : "版本数据有待处理项"}
          </strong>
          <small>
            {report
              ? `${report.changes.length} 项已整理 · 回收 ${bytes(report.removedBytes)} · ${report.warnings.length} 项待检查`
              : q.error || "等待检查结果"}
          </small>
        </div>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          整理报告
        </Button>
      </div>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title="版本升级与数据整理"
        description="每次打开新版自动检查客户端登记和历史运行时。正在使用的资源与一份回退资源会自动保留。"
      >
        {report && (
          <>
            <Badge tone={report.status === "complete" ? "green" : "amber"}>
              版本 {report.version} · {date(report.checkedAt)}
            </Badge>
            <h3>已完成</h3>
            {report.changes.length ? (
              report.changes.map((text) => (
                <p key={text}>
                  <CheckCircle2 size={13} /> {text}
                </p>
              ))
            ) : (
              <p>目录与客户端登记无需调整。</p>
            )}
            {!!report.warnings.length && (
              <>
                <h3>待处理</h3>
                {report.warnings.map((text) => (
                  <Notice key={text} tone="warn">
                    {text}
                  </Notice>
                ))}
              </>
            )}
            <h3>已保留</h3>
            {report.retained.map((text) => (
              <p key={text}>{text}</p>
            ))}
          </>
        )}
        <Notice>
          整理仅清理已确认未使用的桌面运行时副本，不清理世界、数据库、备份、隧道凭证或未知目录。记录保存在
          managed-tools/maintenance/upgrades。
        </Notice>
        <div className="modal-actions">
          <Button
            disabled={checking || q.data?.running}
            onClick={async () => {
              setChecking(true);
              try {
                await act("workspace.upgrade.run", {}, "数据检查与整理完成");
                q.reload();
              } finally {
                setChecking(false);
              }
            }}
          >
            <RefreshCw size={14} className={checking ? "spin" : ""} />
            重新检查与整理
          </Button>
          <Button onClick={() => setOpen(false)}>关闭</Button>
        </div>
      </Drawer>
    </>
  );
}
