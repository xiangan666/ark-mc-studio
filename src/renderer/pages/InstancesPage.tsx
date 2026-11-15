import { useState } from "react";
import {
  Box,
  FolderOpen,
  Plus,
  Server,
  ArrowUpRight,
  Pencil,
  Trash2,
} from "lucide-react";
import type { Instance } from "../../shared/types";
import { act, useApp } from "../store";
import {
  Badge,
  Button,
  Confirm,
  Drawer,
  Empty,
  Field,
  Heading,
  Panel,
  SearchInput,
  Status,
} from "../components";

export default function InstancesPage({ onCreate }: { onCreate: () => void }) {
  const { data, select, navigate } = useApp();
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Instance | null>(null);
  const [name, setName] = useState("");
  const [remove, setRemove] = useState<Instance | null>(null);
  const items = data!.instances.filter((i) =>
    `${i.name} ${i.root} ${i.core}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
  return (
    <div className="page instances-page">
      <Heading
        eyebrow="WORKSPACE / INSTANCES"
        title="实例管理"
        description="每个世界独立运行，所有实例集中掌握。"
        actions={
          <Button variant="primary" onClick={onCreate}>
            <Plus size={16} />
            新建或关联实例
          </Button>
        }
      />
      <div className="list-toolbar">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="搜索名称、核心或目录…"
        />
        <Badge>{data!.instances.length} 个服务器实例</Badge>
      </div>
      <div className="instance-grid">
        {items.map((i) => {
          const s = data!.snapshots.find((s) => s.id === i.id);
          return (
            <Panel className="instance-card" key={i.id}>
              <div className="instance-card-top">
                <span className="tool-glyph">
                  <Server size={24} />
                </span>
                <Status status={s?.status || "unknown"} />
              </div>
              <h2>{i.name}</h2>
              <div className="inline-actions">
                <Badge tone="green">
                  {i.core === "endstone" ? "Endstone" : "官方 BDS"}
                </Badge>
                <span className="muted">{s?.version || "版本读取中"}</span>
              </div>
              <dl className="detail-grid">
                <div>
                  <dt>当前世界</dt>
                  <dd>{s?.world || "尚未生成"}</dd>
                </div>
                <div>
                  <dt>在线人数</dt>
                  <dd>
                    {s?.metric.players ?? "—"} / {s?.maxPlayers ?? "—"}
                  </dd>
                </div>
              </dl>
              <div className="instance-path">
                <FolderOpen size={15} />
                <code>{i.root}</code>
              </div>
              <div className="panel-footer">
                <Button
                  variant="primary"
                  onClick={() => {
                    select(i.id);
                    navigate("overview");
                  }}
                >
                  进入服务器
                  <ArrowUpRight size={15} />
                </Button>
                <Button
                  onClick={() => {
                    setEditing(i);
                    setName(i.name);
                  }}
                >
                  <Pencil size={14} />
                  管理
                </Button>
              </div>
            </Panel>
          );
        })}
      </div>
      {!items.length && (
        <Empty
          icon={Box}
          title={search ? "没有匹配的实例" : "从一个世界开始"}
          description="关联已有目录，或从官方来源创建服务器。"
          action={<Button onClick={onCreate}>添加服务器</Button>}
        />
      )}
      <Drawer
        open={!!editing}
        onClose={() => setEditing(null)}
        title="实例资料"
        description="名称只影响管理界面，服务器目录继续保留。"
      >
        <Field label="实例名称">
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <dl className="detail-grid vertical">
          <div>
            <dt>核心目录</dt>
            <dd>
              <code>{editing?.root}</code>
            </dd>
          </div>
          <div>
            <dt>Python 环境</dt>
            <dd>
              <code>{editing?.python || "此核心无需 Python"}</code>
            </dd>
          </div>
          <div>
            <dt>网络工具</dt>
            <dd>
              <code>{editing?.tunnelRoot || "尚未关联"}</code>
            </dd>
          </div>
        </dl>
        <Button onClick={() => editing && void window.ark.reveal(editing.root)}>
          <FolderOpen size={15} />
          打开实例目录
        </Button>
        <div className="modal-actions">
          <Button
            variant="primary"
            disabled={!name.trim()}
            onClick={async () => {
              if (
                await act(
                  "instances.rename",
                  { id: editing?.id, name: name.trim() },
                  "实例名称已更新",
                )
              )
                setEditing(null);
            }}
          >
            保存名称
          </Button>
        </div>
        <div className="danger-zone">
          <h3>移除实例关联</h3>
          <p>地图、核心文件与备份会保留。运行中的实例需先正常关闭。</p>
          <Button
            variant="danger"
            disabled={!!data!.snapshots.find((s) => s.id === editing?.id)?.pid}
            onClick={() => {
              setRemove(editing);
              setEditing(null);
            }}
          >
            <Trash2 size={14} />
            移除关联
          </Button>
        </div>
      </Drawer>
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title="移除实例关联"
        description={`从工作空间移除「${remove?.name}」，保留服务器文件与备份。`}
        danger
        label="移除关联"
        onConfirm={async () => {
          await act("instances.remove", { id: remove?.id }, "实例关联已移除");
        }}
      />
    </div>
  );
}
