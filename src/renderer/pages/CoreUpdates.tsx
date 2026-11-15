import { useEffect, useState } from "react";
import {
  Download,
  RefreshCw,
  ShieldCheck,
  Clock3,
  ArrowUpRight,
  Settings2,
} from "lucide-react";
import type {
  Core,
  CoreUpdatePolicy,
  CoreUpdateState,
  Job,
} from "../../shared/types";
import { act, date, useApp } from "../store";
import {
  Badge,
  Button,
  Confirm,
  Disclosure,
  Drawer,
  Field,
  Notice,
  Panel,
  QueryError,
  Toggle,
  useQuery,
} from "../components";

export default function CoreUpdates({
  id,
  onUpdate,
}: {
  id: string;
  onUpdate: (version?: string, core?: Core) => void;
}) {
  const query = useQuery<CoreUpdateState>("core-updates.get", { id }, 5000);
  const snapshot = useApp((s) => s.data?.snapshots.find((v) => v.id === id));
  const instance = useApp((s) => s.data?.instances.find((v) => v.id === id));
  const jobs = useApp((s) => s.data?.jobs || []);
  const checking = jobs.find(
    (j) =>
      j.instanceId === id &&
      j.type === "core-check" &&
      ["queued", "running"].includes(j.status),
  );
  const updating = jobs.find(
    (j) =>
      j.instanceId === id &&
      ["update", "auto-core-update"].includes(j.type) &&
      ["queued", "running"].includes(j.status),
  );
  const [draft, setDraft] = useState<CoreUpdatePolicy | null>(null);
  const [confirmAuto, setConfirmAuto] = useState(false);
  const [saving, setSaving] = useState(false);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const policyKey = JSON.stringify(query.data?.policy);
  useEffect(() => {
    if (query.data) setDraft(query.data.policy);
  }, [policyKey]);
  const state = query.data,
    report = state?.report;
  const recommendedCore = report?.targetCore ?? report?.core;
  const recommendedVersion =
    recommendedCore === "bds" ? report?.latestBds : report?.latestEndstone;
  const labels = {
    available: "发现更新",
    current: "当前兼容版本",
    unknown: "需要核对",
    unavailable: "检查未完成",
  };
  const dirty = !!draft && JSON.stringify(draft) !== policyKey;
  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await act<CoreUpdateState>(
        "core-updates.save",
        { id, policy: draft },
        "核心更新策略已保存",
      );
      if (result) query.setData(result);
    } finally {
      setSaving(false);
    }
  }
  return (
    <div id="core-updates">
      <Panel
        className="core-updates dashboard-core-updates"
        title="核心版本与更新"
        subtitle="官方发行源 · 检查兼容版本并更新当前实例"
        aside={
          <div className="inline-actions">
            <Button onClick={() => setPolicyOpen(true)} disabled={!draft}>
              <Settings2 size={14} />
              更新策略
            </Button>
            <Button
              disabled={submitting || !!checking || !!updating}
              onClick={async () => {
                setSubmitting(true);
                try {
                  await act<Job>(
                    "core-updates.check",
                    { id },
                    "核心版本检查已加入任务中心",
                  );
                } finally {
                  setSubmitting(false);
                }
              }}
            >
              <RefreshCw
                size={14}
                className={checking || submitting ? "spin" : ""}
              />
              {checking || submitting ? "正在检查…" : "检查核心更新"}
            </Button>
            <Button
              variant="primary"
              disabled={!!updating || !!checking || submitting}
              onClick={() =>
                onUpdate(
                  report?.updateAvailable ? recommendedVersion : undefined,
                  report?.updateAvailable ? recommendedCore : undefined,
                )
              }
            >
              <Download size={14} />
              {updating
                ? "正在更新…"
                : report?.updateAvailable && recommendedCore !== report.core
                  ? recommendedCore === "bds"
                    ? "切换到官方 BDS"
                    : "切换到 Endstone"
                  : report?.updateAvailable
                    ? "更新核心"
                    : "手动更新核心"}
            </Button>
          </div>
        }
      >
        {query.error && <QueryError error={query.error} retry={query.reload} />}
        <dl className="core-version-grid">
          <div>
            <dt>当前核心</dt>
            <dd>
              {instance?.core === "endstone"
                ? `Endstone ${snapshot?.endstoneVersion || report?.currentEndstone || "版本读取中"}`
                : `BDS ${snapshot?.version || report?.currentBds || "版本读取中"}`}
            </dd>
            <small>
              {instance?.core === "endstone"
                ? `配套 BDS ${snapshot?.version || report?.currentBds || "读取中"}`
                : "官方基岩版服务端"}
            </small>
          </div>
          <div>
            <dt>官方最新 BDS</dt>
            <dd>{report?.latestBds || "尚未检查"}</dd>
            <small>
              {state?.policy.incompatibleEndstone === "official-bds"
                ? "未适配时允许切换官方 BDS"
                : "默认等待 Endstone 适配"}
            </small>
          </div>
          <div>
            <dt>官方可用核心</dt>
            <dd>
              {recommendedVersion
                ? `${recommendedCore === "bds" ? "BDS" : "Endstone"} ${recommendedVersion}`
                : "尚未确认"}
            </dd>
            <small>
              {report?.compatibleBds
                ? recommendedCore === "bds" && report.core === "endstone"
                  ? `当前 Endstone 配套 BDS ${report.compatibleBds}`
                  : `匹配 BDS ${report.compatibleBds}`
                : "点击检查以获取官方版本"}
            </small>
          </div>
        </dl>
        <div className="core-update-status">
          <Badge
            tone={
              report?.status === "available"
                ? "green"
                : report?.status === "unavailable"
                  ? "amber"
                  : "neutral"
            }
          >
            {report ? labels[report.status] : "尚未检查"}
          </Badge>
          <small>
            上次检查：{date(report?.checkedAt)} · 自动检查
            {state?.policy.autoCheck ? "已开启" : "已关闭"} · 自动安装
            {state?.policy.autoUpdate ? "已开启" : "已关闭"}
          </small>
        </div>
        {report && (
          <Disclosure title="兼容说明与检查详情">
            <Notice tone={report.error ? "warn" : undefined}>
              {report.detail}
              {report.error && <span className="cell-sub">{report.error}</span>}
            </Notice>
          </Disclosure>
        )}
        <div className="core-update-footer">
          <p>更新前准备兼容核心、正常关服并创建完整恢复点。</p>
          {report && (
            <a
              className="text-button"
              href={report.releaseUrl}
              target="_blank"
              rel="noreferrer"
            >
              官方发行说明
              <ArrowUpRight size={14} />
            </a>
          )}
        </div>
        {checking && (
          <Notice>
            版本检查：{checking.detail} · {Math.round(checking.progress)}%
          </Notice>
        )}
        {updating && (
          <div className="core-update-progress" aria-live="polite">
            <div>
              <strong>核心更新进行中</strong>
              <span>{Math.round(updating.progress)}%</span>
            </div>
            <div className="progress-track">
              <span style={{ width: `${updating.progress}%` }} />
            </div>
            <small>{updating.detail}</small>
            <Button
              variant="ghost"
              onClick={() => useApp.getState().navigate("tasks")}
            >
              查看任务进度
            </Button>
          </div>
        )}
        <Drawer
          open={policyOpen}
          onClose={() => setPolicyOpen(false)}
          title="核心更新策略"
          description="策略只影响当前实例。默认等待 Endstone 适配最新版 BDS，自动检查和安装可分别开启。"
        >
          {draft ? (
            <>
              <Toggle
                checked={draft.autoCheck}
                label="自动检查核心更新"
                description="后台定期读取官方版本，发现可用更新时记录通知。"
                onChange={(autoCheck) =>
                  setDraft({
                    ...draft,
                    autoCheck,
                    autoUpdate: autoCheck && draft.autoUpdate,
                  })
                }
              />
              <Toggle
                checked={draft.autoUpdate}
                label="自动安装核心更新"
                description="在维护窗口内、无人在线且实例可控时安装；会短暂关服，创建完整恢复点，失败后暂停自动安装。"
                onChange={(autoUpdate) =>
                  setDraft({
                    ...draft,
                    autoUpdate,
                    autoCheck: autoUpdate || draft.autoCheck,
                  })
                }
              />
              <Field
                label="Endstone 未适配最新版 BDS 时"
                hint="默认等待 Endstone 官方适配；也可选择暂时运行官方 BDS。"
              >
                <select
                  value={draft.incompatibleEndstone}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      incompatibleEndstone: e.target.value as
                        "wait" | "official-bds",
                    })
                  }
                >
                  <option value="wait">等待 Endstone 适配（默认）</option>
                  <option value="official-bds">暂时切换官方 BDS</option>
                </select>
              </Field>
              {draft.incompatibleEndstone === "official-bds" && (
                <Notice tone="warn">
                  切换后地图和行为包保留，Endstone
                  插件暂停加载；适配完成后可在手动更新中切回 Endstone。
                </Notice>
              )}
              <div className="form-grid">
                <Field label="自动检查间隔">
                  <select
                    value={draft.intervalHours}
                    onChange={(e) =>
                      setDraft({ ...draft, intervalHours: +e.target.value })
                    }
                  >
                    {[1, 3, 6, 12, 24, 48, 168].map((hours) => (
                      <option value={hours} key={hours}>
                        每 {hours} 小时
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label="自动安装维护时间"
                  hint="使用电脑本地时间；维护窗口 1 小时，忙碌或有玩家时延后 5 分钟。"
                >
                  <input
                    type="time"
                    value={draft.maintenanceTime}
                    onChange={(e) =>
                      setDraft({ ...draft, maintenanceTime: e.target.value })
                    }
                  />
                </Field>
              </div>
              <div className="core-policy-footer">
                <div>
                  <Clock3 size={14} />
                  <small>
                    下次检查：{date(state?.nextCheckAt)}
                    <br />
                    下次维护：{date(state?.nextUpdateAt)}
                  </small>
                </div>
                <Button
                  disabled={!dirty || saving || !draft.maintenanceTime}
                  onClick={() =>
                    draft.autoUpdate && !state?.policy.autoUpdate
                      ? setConfirmAuto(true)
                      : void save()
                  }
                >
                  {saving ? "保存中…" : "保存更新策略"}
                </Button>
              </div>
            </>
          ) : (
            <p className="core-update-help">正在读取更新策略…</p>
          )}
          {state?.lastOutcome && (
            <Notice>
              <ShieldCheck size={16} />
              <span>
                {state.lastOutcome.detail}
                <small className="cell-sub">{date(state.lastOutcome.at)}</small>
              </span>
            </Notice>
          )}
        </Drawer>
        <Confirm
          open={confirmAuto}
          onClose={() => setConfirmAuto(false)}
          title="开启自动核心更新"
          label="开启并保存策略"
          description={`每天 ${draft?.maintenanceTime} 开始的一小时内，无玩家在线时允许程序正常关服、创建完整快照并安装官方兼容组合。开启自动检查，失败后暂停自动安装；电脑暂停错过窗口时不补做更新。`}
          onConfirm={save}
        />
      </Panel>
    </div>
  );
}
