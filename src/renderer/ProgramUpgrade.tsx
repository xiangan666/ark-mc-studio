import { useEffect, useState } from "react";
import { Box, Power, RefreshCw } from "lucide-react";
import { Button, Notice, useQuery } from "./components";
import { act, useApp } from "./store";
import type { ProgramTransition } from "../shared/program-lifecycle";

export default function ProgramUpgrade() {
  const q = useQuery<ProgramTransition>("program.upgrade.get", {}, 1000);
  const [submitting, setSubmitting] = useState(false);
  const running = q.data?.phase === "running" || submitting;
  async function upgrade() {
    setSubmitting(true);
    try {
      await act("program.upgrade.run");
      q.reload();
    } finally {
      setSubmitting(false);
    }
  }
  useEffect(() => {
    if (q.data?.phase === "complete") void useApp.getState().refresh();
  }, [q.data?.phase]);
  return (
    <div className="program-upgrade-screen">
      <div
        className="program-upgrade-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="program-upgrade-title"
      >
        <span className="program-upgrade-icon">
          <Box size={30} />
        </span>
        <small>ARKMC STUDIO · 程序版本 {window.ark.versions.app}</small>
        <h1 id="program-upgrade-title">
          {running ? "正在更新管理程序" : "检测到旧版管理服务"}
        </h1>
        <p>保留运行中的服务器和线路，更新程序？</p>
        <ol>
          <li>核对实例、线路与当前任务，保留运行状态。</li>
          <li>独立会话宿主持有游戏控制台，管理服务单独更换。</li>
          <li>验证新服务版本、游戏进程和控制能力。</li>
          <li>检查历史数据，整理未使用的运行资源。</li>
        </ol>
        <Notice>
          更新不执行服务器、穿透、信令或 IPv6
          的停止／重启。旧版直接持有控制台的会话无法无损转交，首次切换需手动处理；未完成时明确拒绝更新，不兼容运行旧服务。
        </Notice>
        {q.error && <Notice tone="warn">{q.error}</Notice>}
        {q.data?.error && <Notice tone="warn">{q.data.error}</Notice>}
        {running && (
          <div className="program-upgrade-progress" aria-live="polite">
            <strong>{q.data?.detail || "准备更新…"}</strong>
            <div className="progress-track">
              <span style={{ width: `${q.data?.progress || 5}%` }} />
            </div>
          </div>
        )}
        <div className="modal-actions">
          <Button
            disabled={running}
            onClick={() => void window.ark.call("program.upgrade.exit")}
          >
            <Power size={14} />
            取消并退出新版
          </Button>
          <Button
            variant="primary"
            disabled={running}
            onClick={() => void upgrade()}
          >
            <RefreshCw size={14} className={running ? "spin" : ""} />
            {running ? "正在更新，请稍候…" : "保留运行并更新"}
          </Button>
        </div>
      </div>
    </div>
  );
}
