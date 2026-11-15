import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { properties, property } from "../editing";
import {
  Archive,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Blocks,
  Box,
  Check,
  ChevronRight,
  Code2,
  FileCode2,
  Folder,
  FolderOpen,
  HardDrive,
  Layers,
  Package,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Trash2,
  Upload,
} from "lucide-react";
import type { FileEntry, Pack, TextFile, World } from "../../shared/types";
import { act, bytes, date, useApp } from "../store";
import {
  Badge,
  Button,
  Confirm,
  Disclosure,
  Drawer,
  Empty,
  Field,
  Heading,
  Loading,
  Notice,
  Panel,
  PathInput,
  QueryError,
  SearchInput,
  Steps,
  useUnsavedChanges,
  useQuery,
} from "../components";

function enabledDependents(packId: string, packs: Pack[]) {
  const ids = new Set([packId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const pack of packs) {
      if (
        pack.enabled &&
        !ids.has(pack.id) &&
        pack.dependencies.some((dependency) => ids.has(dependency))
      ) {
        ids.add(pack.id);
        changed = true;
      }
    }
  }
  return packs.filter(
    (pack) => pack.enabled && ids.has(pack.id) && pack.id !== packId,
  );
}

export function WorldsPage() {
  const { id, snapshot } = useInstance();
  const q = useQuery<World[]>("worlds.list", { id });
  const [importing, setImporting] = useState(false);
  const [source, setSource] = useState("");
  const [name, setName] = useState("");
  const [select, setSelect] = useState<World | null>(null);
  const [detail, setDetail] = useState<World | null>(null);
  const [importStep, setImportStep] = useState(0);
  const [sizes, setSizes] = useState<Record<string, number>>({});
  return (
    <div className="page">
      <Heading
        eyebrow="WORLDS & DIMENSIONS"
        title="世界管理"
        description="查看世界资料，导入、导出或安全切换当前世界。"
        actions={
          <>
            <Button
              onClick={() =>
                void act(
                  "backups.create",
                  { id, kind: "world" },
                  "当前世界备份已排队",
                )
              }
              disabled={!snapshot?.world}
            >
              <Archive size={15} />
              备份当前世界
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setImportStep(0);
                setImporting(true);
              }}
            >
              <Upload size={15} />
              导入世界
            </Button>
          </>
        }
      />
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <Notice>
        切换世界会先创建当前世界备份。请正常关服后切换或导入；已关联的资源包随世界保存。
      </Notice>
      {q.loading && !q.data ? (
        <Loading />
      ) : q.data?.length ? (
        <div className="world-grid">
          {q.data.map((w) => (
            <Panel
              className={`world-card ${w.active ? "active-world" : ""}`}
              key={w.name}
            >
              <div className="world-card-art">
                <Box size={29} />
                {w.active && (
                  <Badge tone="green">
                    <span className="status-dot" />
                    当前世界
                  </Badge>
                )}
                <span className="world-dimension">世界文件</span>
              </div>
              <div className="world-card-body">
                <button className="world-title" onClick={() => setDetail(w)}>
                  <h3>{w.name}</h3>
                  <ChevronRight size={16} />
                </button>
                <div className="world-info">
                  <span>
                    <Blocks size={13} />
                    {w.behaviorPacks} 个行为包
                  </span>
                  <span>
                    <Layers size={13} />
                    {w.resourcePacks} 个资源包
                  </span>
                </div>
                <div className="world-info">
                  <span>
                    <HardDrive size={13} />
                    {sizes[w.name] != null ? (
                      bytes(sizes[w.name])
                    ) : (
                      <button
                        className="text-button"
                        onClick={async () => {
                          const size = await act<number>("worlds.size", {
                            id,
                            name: w.name,
                          });
                          if (size != null)
                            setSizes((s) => ({ ...s, [w.name]: size }));
                        }}
                      >
                        计算大小
                      </button>
                    )}
                  </span>
                  <span>{date(w.modified)}</span>
                </div>
                <div className="world-card-actions">
                  <Button
                    disabled={w.active || !!snapshot?.pid}
                    onClick={() => setSelect(w)}
                  >
                    {w.active ? <Check size={14} /> : <ArrowRight size={14} />}{" "}
                    {w.active ? "正在使用" : "切换到此世界"}
                  </Button>
                  <Button
                    variant="ghost"
                    title="导出为已校验的世界备份"
                    onClick={() =>
                      void act(
                        "worlds.export",
                        { id, name: w.name },
                        "世界导出已排队，可在备份页打开 ZIP",
                      )
                    }
                  >
                    <ArrowDownToLine size={15} />
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      void window.ark.reveal(
                        useApp
                          .getState()
                          .data!.instances.find((i) => i.id === id)!.root +
                          "\\worlds\\" +
                          w.name,
                      )
                    }
                  >
                    <FolderOpen size={15} />
                  </Button>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      ) : (
        <Panel>
          <Empty
            icon={Box}
            title="世界尚未生成"
            description="首次启动服务器会生成默认世界，也可以导入已有 .mcworld 或 ZIP。"
          />
        </Panel>
      )}
      <Drawer
        open={importing}
        onClose={() => setImporting(false)}
        title="导入基岩版世界"
        description="支持 .mcworld、ZIP 或包含 level.dat 和 db 的目录。"
      >
        <div className="form-stack">
          <Steps items={["选择世界", "确认导入"]} current={importStep} />
          {importStep === 0 ? (
            <>
              <Field label="世界名称">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="给这段冒险起个名字"
                />
              </Field>
              <Field label="世界安装包">
                <PathInput
                  value={source}
                  onChange={setSource}
                  file
                  extensions={["mcworld", "zip"]}
                  placeholder="选择 .mcworld 或 ZIP"
                />
              </Field>
              <Button
                onClick={async () => {
                  const directory = await window.ark.chooseDirectory();
                  if (directory) setSource(directory);
                }}
              >
                <FolderOpen size={15} />
                改为选择世界目录
              </Button>
            </>
          ) : (
            <dl className="detail-grid vertical">
              <div>
                <dt>导入名称</dt>
                <dd>{name}</dd>
              </div>
              <div>
                <dt>安装包或目录</dt>
                <dd className="mono">{source}</dd>
              </div>
              <div>
                <dt>后续操作</dt>
                <dd>导入后在列表中切换，已有世界保留。</dd>
              </div>
            </dl>
          )}
          <Notice>导入后在世界列表中切换使用，原有世界会保留。</Notice>
          <div className="modal-actions">
            <Button
              onClick={() =>
                importStep ? setImportStep(0) : setImporting(false)
              }
            >
              {importStep ? "上一步" : "取消"}
            </Button>
            {importStep === 0 ? (
              <Button
                variant="primary"
                disabled={!source || !name}
                onClick={() => setImportStep(1)}
              >
                下一步
                <ArrowRight size={14} />
              </Button>
            ) : (
              <Button
                variant="primary"
                disabled={!source || !name || !!snapshot?.pid}
                onClick={async () => {
                  if (
                    await act(
                      "worlds.import",
                      { id, source, name },
                      "世界导入已排队",
                    )
                  ) {
                    setImporting(false);
                    setSource("");
                    setName("");
                  }
                }}
              >
                开始导入
              </Button>
            )}
          </div>
        </div>
      </Drawer>
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name || "世界详情"}
        description="世界状态与关联内容"
      >
        {detail && (
          <>
            <Badge tone={detail.active ? "green" : "neutral"}>
              {detail.active ? "当前世界" : "未使用"}
            </Badge>
            <dl className="detail-grid">
              <div>
                <dt>行为包</dt>
                <dd>{detail.behaviorPacks}</dd>
              </div>
              <div>
                <dt>资源包</dt>
                <dd>{detail.resourcePacks}</dd>
              </div>
              <div>
                <dt>最近修改</dt>
                <dd>{date(detail.modified)}</dd>
              </div>
              <div>
                <dt>磁盘占用</dt>
                <dd>
                  {sizes[detail.name] == null ? (
                    <Button
                      onClick={async () => {
                        const n = await act<number>("worlds.size", {
                          id,
                          name: detail.name,
                        });
                        if (n != null)
                          setSizes((s) => ({ ...s, [detail.name]: n }));
                      }}
                    >
                      计算大小
                    </Button>
                  ) : (
                    bytes(sizes[detail.name])
                  )}
                </dd>
              </div>
            </dl>
            <Button onClick={() => useApp.getState().navigate("packs")}>
              管理当前世界关联内容
              <ChevronRight size={14} />
            </Button>
          </>
        )}
      </Drawer>
      <Confirm
        open={!!select}
        onClose={() => setSelect(null)}
        title="切换服务器世界"
        description={`备份当前世界后，将 level-name 设置为「${select?.name}」。下次启动生效。`}
        label="备份并切换"
        onConfirm={async () => {
          await act(
            "worlds.select",
            { id, name: select?.name },
            "世界切换已排队",
          );
        }}
      />
    </div>
  );
}

export function PacksPage() {
  const { id, snapshot } = useInstance();
  const q = useQuery<Pack[]>("packs.list", { id });
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [system, setSystem] = useState(false);
  const [install, setInstall] = useState(false);
  const [source, setSource] = useState("");
  const [kind, setKind] = useState<"auto" | "plugin">("auto");
  const [remove, setRemove] = useState<Pack | null>(null);
  const [detail, setDetail] = useState<Pack | null>(null);
  const [stateFilter, setStateFilter] = useState("all");
  const [disablePrompt, setDisablePrompt] = useState<{
    pack: Pack;
    dependents: Pack[];
  } | null>(null);
  const packs = q.data || [];
  const shown = packs.filter(
    (p) =>
      (system || !p.system) &&
      (tab === "all" || p.kind === tab) &&
      (stateFilter === "all" ||
        (stateFilter === "enabled"
          ? p.enabled
          : stateFilter === "disabled"
            ? !p.enabled
            : p.missingDependencies.length > 0)) &&
      (!search ||
        (p.name + " " + p.id).toLowerCase().includes(search.toLowerCase())),
  );
  const requestToggle = (pack: Pack) => {
    if (!pack.enabled) {
      void act(
        "packs.toggle",
        { id, packId: pack.id, enabled: true },
        "模组启用任务已排队",
      );
      return;
    }
    const dependents = enabledDependents(pack.id, packs);
    if (dependents.length) {
      setDisablePrompt({ pack, dependents });
      return;
    }
    void act(
      "packs.toggle",
      { id, packId: pack.id, enabled: false },
      snapshot?.pid ? "关联变更已排队，重启后生效" : "模组停用任务已排队",
    );
  };
  return (
    <div className="page">
      <Heading
        eyebrow="CONTENT & EXTENSIONS"
        title="模组与插件"
        description="管理当前世界的行为包、资源包与插件。"
        actions={
          <Button variant="primary" onClick={() => setInstall(true)}>
            <Plus size={15} />
            安装模组 / 插件
          </Button>
        }
      />
      <div className="mini-stats">
        {[
          {
            label: "已启用内容",
            value: packs.filter((p) => p.enabled).length,
            icon: Check,
          },
          {
            label: "行为包",
            value: packs.filter((p) => p.kind === "behavior" && !p.system)
              .length,
            icon: Blocks,
          },
          {
            label: "资源包",
            value: packs.filter((p) => p.kind === "resource" && !p.system)
              .length,
            icon: Layers,
          },
          {
            label: "Endstone 插件",
            value: packs.filter((p) => p.kind === "plugin").length,
            icon: Package,
          },
        ].map((s) => (
          <Panel key={s.label}>
            <s.icon size={19} />
            <div>
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </div>
          </Panel>
        ))}
      </div>
      {snapshot?.pid && (
        <Notice>
          服务器运行中：可在线取消行为包或资源包的世界关联；已加载内容会继续运行到下次启动。安装、启用、卸载和插件变更仍需停服。
        </Notice>
      )}
      <div className="list-toolbar">
        <div className="segmented">
          {[
            ["all", "全部内容"],
            ["behavior", "行为包"],
            ["resource", "资源包"],
            ["plugin", "插件"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="inline-actions">
          <select
            className="compact-select"
            aria-label="内容状态"
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            <option value="enabled">已启用</option>
            <option value="disabled">未启用</option>
            <option value="missing">缺少依赖</option>
          </select>
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={system}
              onChange={(e) => setSystem(e.target.checked)}
            />
            显示内置包
          </label>
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="搜索模组名称或 UUID…"
          />
        </div>
      </div>
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      <Panel>
        {q.loading && !q.data ? (
          <Loading />
        ) : shown.length ? (
          <div className="pack-list">
            {shown.map((p) => (
              <div className="pack-row" key={p.id}>
                <div className={`pack-avatar ${p.kind}`}>
                  <Package size={23} />
                </div>
                <div className="pack-main">
                  <div>
                    <button
                      className="text-button"
                      onClick={() => setDetail(p)}
                    >
                      <h3>{p.name}</h3>
                    </button>
                    <Badge>
                      {p.kind === "behavior"
                        ? "行为包"
                        : p.kind === "resource"
                          ? "资源包"
                          : "插件"}
                    </Badge>
                    {p.enabled && <Badge tone="green">已启用</Badge>}
                    {p.system && <Badge>原版</Badge>}
                  </div>
                  <p>{p.description || p.path}</p>
                  <small>
                    v{p.version}
                    {p.dependencies.length
                      ? ` · ${p.dependencies.length} 项依赖`
                      : ""}
                  </small>
                  {p.missingDependencies.length > 0 && (
                    <div className="dependency-warning">
                      缺少依赖：{p.missingDependencies.join(", ")}
                    </div>
                  )}
                </div>
                <div className="pack-actions">
                  <Button variant="ghost" onClick={() => setDetail(p)}>
                    详情
                  </Button>
                  <Button
                    disabled={
                      p.system ||
                      (!!snapshot?.pid && (!p.enabled || p.kind === "plugin"))
                    }
                    title={
                      snapshot?.pid && p.enabled && p.kind !== "plugin"
                        ? "仅取消当前世界的包引用；服务器仍运行中的内容会在下次启动时卸载"
                        : undefined
                    }
                    onClick={() => requestToggle(p)}
                  >
                    {snapshot?.pid && p.enabled && p.kind !== "plugin"
                      ? "取消关联"
                      : p.enabled
                        ? "停用"
                        : "启用"}
                  </Button>
                  <button
                    className="icon-button danger-text"
                    aria-label={"卸载 " + p.name}
                    disabled={!!snapshot?.pid || p.system}
                    onClick={() => setRemove(p)}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            icon={Blocks}
            title="没有匹配的内容"
            description="导入 .mcaddon 或 .mcpack，或调整当前筛选条件。"
          />
        )}
      </Panel>
      <Drawer
        open={install}
        onClose={() => setInstall(false)}
        title="安装内容"
        description="安装完成后检查依赖，再在列表中启用。"
      >
        <div className="form-stack">
          <Steps
            items={["选择安装包", "检查依赖", "安装与启用"]}
            current={source ? 1 : 0}
          />
          <Field label="内容类型">
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as any);
                setSource("");
              }}
            >
              <option value="auto">行为包 / 资源包（自动识别）</option>
              <option value="plugin">Endstone 插件</option>
            </select>
          </Field>
          <Field label="本地安装包">
            <PathInput
              value={source}
              onChange={setSource}
              file
              extensions={
                kind === "plugin"
                  ? ["whl", "dll", "py"]
                  : ["mcaddon", "mcpack", "zip"]
              }
            />
          </Field>
          <Notice>
            模组关联随当前世界保存。插件在 Endstone 下次启动时加载。
          </Notice>
          <div className="modal-actions">
            <Button onClick={() => setInstall(false)}>取消</Button>
            <Button
              variant="primary"
              disabled={!source || !!snapshot?.pid}
              onClick={async () => {
                if (
                  await act(
                    "packs.install",
                    { id, source, kind },
                    "安装任务已排队",
                  )
                ) {
                  setInstall(false);
                  setSource("");
                }
              }}
            >
              检查并安装
            </Button>
          </div>
        </div>
      </Drawer>
      <Drawer
        open={!!detail}
        onClose={() => setDetail(null)}
        title={detail?.name || "内容详情"}
        description="版本、世界关联与依赖信息"
      >
        {detail && (
          <>
            <div className="inline-actions">
              <Badge>
                {detail.kind === "behavior"
                  ? "行为包"
                  : detail.kind === "resource"
                    ? "资源包"
                    : "Endstone 插件"}
              </Badge>
              <Badge tone={detail.enabled ? "green" : "neutral"}>
                {detail.enabled ? "已启用" : "未启用"}
              </Badge>
            </div>
            <dl className="detail-grid vertical">
              <div>
                <dt>版本</dt>
                <dd>{detail.version}</dd>
              </div>
              <div>
                <dt>标识</dt>
                <dd className="mono">{detail.id}</dd>
              </div>
              <div>
                <dt>安装路径</dt>
                <dd className="mono">{detail.path}</dd>
              </div>
              <div>
                <dt>描述</dt>
                <dd>{detail.description || "未提供描述"}</dd>
              </div>
            </dl>
            <Panel title="依赖检查">
              {detail.dependencies.length ? (
                <div className="dependency-list">
                  {detail.dependencies.map((d) => (
                    <div key={d}>
                      <code>{d}</code>
                      <Badge
                        tone={
                          detail.missingDependencies.includes(d)
                            ? "red"
                            : "green"
                        }
                      >
                        {detail.missingDependencies.includes(d)
                          ? "缺失"
                          : "已找到"}
                      </Badge>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="detail-note">没有声明依赖</div>
              )}
            </Panel>
            <Notice>
              {detail.kind === "plugin"
                ? "插件在 Endstone 启动时加载。"
                : "启用状态对应当前世界的关联文件。"}
              修改后需要重新启动核心生效。
            </Notice>
            <Button onClick={() => void window.ark.reveal(detail.path)}>
              <FolderOpen size={15} />
              打开所在位置
            </Button>
          </>
        )}
      </Drawer>
      <Confirm
        open={!!disablePrompt}
        onClose={() => setDisablePrompt(null)}
        title="同时取消依赖包关联"
        description={
          "「" +
          (disablePrompt?.pack.name || "") +
          "」仍被以下已启用内容依赖：" +
          (disablePrompt?.dependents.map((pack) => pack.name).join("、") ||
            "") +
          "。确认后会一并取消这些包的世界关联，所有文件保留。" +
          (snapshot?.pid
            ? "服务器不会关闭，已加载内容要到下次启动才会卸载。"
            : "")
        }
        label="同时取消关联并保留文件"
        onConfirm={async () => {
          if (!disablePrompt) return;
          await act(
            "packs.toggle",
            { id, packId: disablePrompt.pack.id, enabled: false },
            snapshot?.pid ? "依赖关联已取消，重启后生效" : "依赖关联已取消",
          );
          setDisablePrompt(null);
        }}
      />
      <Confirm
        open={!!remove}
        onClose={() => setRemove(null)}
        title="卸载内容"
        description={`将停用并移除「${remove?.name}」，原文件会保留到管理程序回收目录。`}
        danger
        label="卸载并保留副本"
        onConfirm={async () => {
          await act(
            "packs.remove",
            { id, packId: remove?.id },
            "卸载任务已排队",
          );
        }}
      />
    </div>
  );
}

export function FilesPage() {
  const { id } = useInstance();
  const [path, setPath] = useState("");
  const [selected, setSelected] = useState("");
  const [file, setFile] = useState<TextFile | null>(null);
  const [text, setText] = useState("");
  const [diff, setDiff] = useState(false);
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<FileEntry | null>(null);
  const [busy, setBusy] = useState(false);
  const [width, setWidth] = useState(260);
  const browser = useRef<HTMLDivElement>(null);
  const workspace = useRef<HTMLDivElement>(null);
  const q = useQuery<FileEntry[]>("files.list", { id, path });
  const changed = !!file && text !== file.text;
  useUnsavedChanges(changed, "文件编辑");
  const entries = useMemo(
    () =>
      (q.data || []).filter((f) =>
        f.name.toLowerCase().includes(search.toLowerCase()),
      ),
    [q.data, search],
  );
  const virtual = useVirtualizer({
    count: entries.length,
    getScrollElement: () => browser.current,
    estimateSize: () => 42,
    overscan: 12,
  });
  async function open(entry: FileEntry, discard = false) {
    if (entry.path === selected && !entry.directory) return;
    if (changed && !discard) {
      setPending(entry);
      return;
    }
    if (entry.directory) {
      setPath(entry.path);
      setSearch("");
      if (discard) {
        setFile(null);
        setText("");
        setSelected("");
      }
      return;
    }
    setBusy(true);
    try {
      const value = await act<TextFile>("files.read", { id, path: entry.path });
      if (value) {
        setFile(value);
        setText(value.text);
        setSelected(entry.path);
      }
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    if (!file || busy) return;
    setBusy(true);
    try {
      const result = await act<TextFile>(
        "files.write",
        { id, path: file.path, text, revision: file.revision },
        "文件已保存，旧版本已留存",
      );
      if (result) {
        setFile(result);
        setText(result.text);
        setDiff(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page file-page">
      <Heading
        title="文件管理"
        description="在实例目录内浏览与编辑，保存前核对外部修改。"
        actions={
          <Button
            onClick={() =>
              void window.ark.reveal(
                useApp.getState().data!.instances.find((i) => i.id === id)!
                  .root,
              )
            }
          >
            <FolderOpen size={15} />
            打开实例目录
          </Button>
        }
      />
      <div
        ref={workspace}
        style={{ "--browser-width": `${width}px` } as CSSProperties}
      >
        <Panel className="file-workspace">
          <div className="file-browser">
            <div className="file-browser-head">
              <Button
                aria-label="上级目录"
                disabled={!path}
                onClick={() =>
                  void open({
                    directory: true,
                    path: path.split("/").slice(0, -1).join("/"),
                    name: "上级目录",
                    size: 0,
                    modified: 0,
                  })
                }
              >
                <ArrowLeft size={15} />
              </Button>
              <strong>实例目录</strong>
              <Button aria-label="刷新文件" onClick={q.reload}>
                <RefreshCw size={14} />
              </Button>
            </div>
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="筛选当前目录…"
            />
            <div className="file-path" title={path}>
              {path || "/ 服务器根目录"}
            </div>
            <div className="file-tree" ref={browser}>
              {q.error && <QueryError error={q.error} retry={q.reload} />}
              {q.loading && !q.data ? (
                <Loading />
              ) : !entries.length ? (
                <Empty title="目录为空或没有匹配项" />
              ) : (
                <div
                  style={{
                    height: virtual.getTotalSize(),
                    position: "relative",
                  }}
                >
                  {virtual.getVirtualItems().map((row) => {
                    const f = entries[row.index];
                    return (
                      <button
                        key={f.path}
                        style={{
                          position: "absolute",
                          top: 0,
                          left: 0,
                          width: "100%",
                          height: 42,
                          transform: `translateY(${row.start}px)`,
                        }}
                        className={selected === f.path ? "active" : ""}
                        onClick={() => void open(f)}
                        title={f.name}
                        disabled={busy}
                      >
                        {f.directory ? (
                          <Folder size={16} />
                        ) : (
                          <FileCode2 size={16} />
                        )}
                        <span>{f.name}</span>
                        {f.directory ? (
                          <ChevronRight size={13} />
                        ) : (
                          <small>{bytes(f.size)}</small>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
          <div
            className="file-resizer"
            role="separator"
            aria-label="调整目录面板宽度"
            aria-orientation="vertical"
            aria-valuenow={width}
            aria-valuemin={190}
            aria-valuemax={420}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                setWidth((w) =>
                  Math.max(
                    190,
                    Math.min(420, w + (e.key === "ArrowRight" ? 20 : -20)),
                  ),
                );
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                const left =
                  workspace.current?.getBoundingClientRect().left || 0;
                setWidth(Math.max(190, Math.min(420, e.clientX - left)));
              }
            }}
            onPointerUp={(e) =>
              e.currentTarget.releasePointerCapture(e.pointerId)
            }
          />
          <div className="file-editor">
            {file ? (
              <>
                <div className="editor-toolbar">
                  <div>
                    <FileCode2 size={16} />
                    <strong title={file.path}>{file.path}</strong>
                    {changed && <Badge tone="amber">未保存</Badge>}
                  </div>
                  <div className="inline-actions">
                    <Button disabled={!changed} onClick={() => setDiff(true)}>
                      修改对比
                    </Button>
                    <Button
                      variant="primary"
                      disabled={!changed || busy}
                      onClick={() => void save()}
                    >
                      <Save size={14} />
                      {busy ? "处理中…" : "保存"}
                    </Button>
                  </div>
                </div>
                <textarea
                  className="code-editor"
                  spellCheck={false}
                  aria-label="文件内容"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                      e.preventDefault();
                      void save();
                    }
                    if (e.key === "Tab") {
                      e.preventDefault();
                      const el = e.currentTarget,
                        start = el.selectionStart,
                        end = el.selectionEnd;
                      setText(text.slice(0, start) + "  " + text.slice(end));
                      requestAnimationFrame(() =>
                        el.setSelectionRange(start + 2, start + 2),
                      );
                    }
                  }}
                />
                <div className="editor-status">
                  <span>
                    {text.split("\n").length} 行 · UTF-8{file.bom ? " BOM" : ""}
                  </span>
                  <span>Ctrl+S 保存 · 自动保留历史副本</span>
                </div>
              </>
            ) : (
              <Empty
                icon={FileCode2}
                title="选择文件开始编辑"
                description="支持常用文本配置。目录分栏可拖动，也可用方向键调整。"
              />
            )}
          </div>
        </Panel>
      </div>
      <Confirm
        open={!!pending}
        onClose={() => setPending(null)}
        title="当前文件有未保存修改"
        description="返回保存当前文件，或放弃这些修改并继续浏览。"
        label="放弃修改并继续"
        danger
        onConfirm={async () => {
          if (pending) await open(pending, true);
        }}
      />
      <Drawer
        open={diff}
        onClose={() => setDiff(false)}
        title="查看文件修改"
        description="左侧为读取时的内容，右侧为待保存内容。"
        wide
      >
        <div className="diff-grid">
          <div>
            <h4>原始内容</h4>
            <pre>{file?.text}</pre>
          </div>
          <div>
            <h4>待保存内容</h4>
            <pre className="diff-new">{text}</pre>
          </div>
        </div>
        <div className="modal-actions">
          <Button onClick={() => setDiff(false)}>返回编辑</Button>
          <Button
            variant="primary"
            disabled={!changed || busy}
            onClick={() => void save()}
          >
            保留历史并保存
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
const groups = [
  {
    title: "基本信息",
    description: "世界名称、连接和玩家容量",
    fields: [
      ["server-name", "服务器名称", "text"],
      ["level-name", "加载的世界", "text"],
      ["max-players", "人数上限", "number"],
      ["server-port", "IPv4 / 信令端口", "number"],
    ],
  },
  {
    title: "游戏规则",
    description: "新玩家默认模式与世界难度",
    fields: [
      ["gamemode", "默认游戏模式", "survival,creative,adventure"],
      ["difficulty", "世界难度", "peaceful,easy,normal,hard"],
      ["allow-cheats", "允许命令与作弊", "boolean"],
      ["force-gamemode", "强制默认游戏模式", "boolean"],
    ],
  },
  {
    title: "网络与访问",
    description: "协议变更需同步检查穿透配置",
    fields: [
      ["transport", "连接协议", "nethernet,raknet"],
      ["online-mode", "Xbox 身份验证", "boolean"],
      ["allow-list", "仅允许名单玩家", "boolean"],
      ["enable-lan-visibility", "局域网可见", "boolean"],
    ],
  },
  {
    title: "性能与资源",
    description: "根据主机配置和世界负载调整",
    fields: [
      ["view-distance", "视距（区块）", "number"],
      ["tick-distance", "模拟距离（区块）", "number"],
      ["texturepack-required", "强制资源包", "boolean"],
      ["server-portv6", "IPv6 端口", "number"],
    ],
  },
];
export function ConfigPage() {
  const { id } = useInstance();
  const q = useQuery<TextFile & { values: Record<string, string> }>(
    "config.get",
    { id },
  );
  const [baseline, setBaseline] = useState<TextFile | null>(null);
  const [text, setText] = useState("");
  const [raw, setRaw] = useState(false);
  const [category, setCategory] = useState(0);
  const [search, setSearch] = useState("");
  const [preview, setPreview] = useState(false);
  const [reload, setReload] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = !!baseline && text !== baseline.text;
  useUnsavedChanges(changed, "服务器配置");
  useEffect(() => {
    // Keep dirty drafts at their original revision when a task refreshes this query.
    if (
      q.data &&
      (!baseline || !changed) &&
      baseline?.revision !== q.data.revision
    ) {
      setBaseline(q.data);
      setText(q.data.text);
    }
  }, [q.data, changed, baseline]);
  const values = useMemo(() => properties(text), [text]);
  const original = useMemo(() => properties(baseline?.text || ""), [baseline]);
  const changes = [
    ...new Set([...Object.keys(values), ...Object.keys(original)]),
  ].filter((k) => values[k] !== original[k]);
  const external =
    !!baseline && !!q.data && baseline.revision !== q.data.revision;
  const visibleGroups = groups
    .map((g, i) => ({
      ...g,
      index: i,
      fields: g.fields.filter(
        (f) =>
          !search || f.join(" ").toLowerCase().includes(search.toLowerCase()),
      ),
    }))
    .filter((g) => (search ? g.fields.length : g.index === category));
  async function save() {
    if (!baseline || busy) return;
    setBusy(true);
    try {
      const result = await act<TextFile>(
        "files.write",
        { id, path: "server.properties", text, revision: baseline.revision },
        "配置已校验并保存，历史副本已留存",
      );
      if (result) {
        q.setData({ ...result, values: properties(result.text) });
        setBaseline(result);
        setText(result.text);
        setPreview(false);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page config-page">
      <Heading
        title="服务器配置"
        description="按类别调整配置，表单与原文共享草稿。"
        actions={
          <div className="segmented">
            <button
              className={!raw ? "active" : ""}
              onClick={() => setRaw(false)}
            >
              <Settings2 size={14} />
              表单
            </button>
            <button
              className={raw ? "active" : ""}
              onClick={() => setRaw(true)}
            >
              <Code2 size={14} />
              原文
            </button>
          </div>
        }
      />
      {q.error && <QueryError error={q.error} retry={q.reload} />}
      {external && (
        <Notice tone="warn">
          磁盘配置已被其他程序修改，当前草稿仍保留。保存时会阻止覆盖，请复制需要的修改后重新读取。
          <Button onClick={() => setReload(true)}>重新读取</Button>
        </Notice>
      )}
      {!baseline ? (
        <Loading />
      ) : (
        <>
          <div className="config-layout">
            <nav className="config-navigation" aria-label="配置分类">
              {groups.map((g, i) => (
                <button
                  key={g.title}
                  className={i === category && !raw ? "active" : ""}
                  onClick={() => {
                    setCategory(i);
                    setRaw(false);
                    setSearch("");
                  }}
                >
                  <span>{g.title}</span>
                  <ChevronRight size={14} />
                </button>
              ))}
              <Disclosure title="保存与历史">
                <p>
                  配置按原编码写入，保留注释和行尾。旧版本保存在管理数据目录的
                  config-history 中。
                </p>
                <Button
                  onClick={() =>
                    void window.ark.reveal(
                      useApp.getState().data!.dataRoot +
                        "\\config-history\\" +
                        id,
                    )
                  }
                >
                  查看历史副本
                </Button>
              </Disclosure>
            </nav>
            <div className="config-workspace">
              {raw ? (
                <Panel className="raw-config">
                  <div className="editor-toolbar">
                    <strong className="mono">server.properties</strong>
                    <Badge tone={changed ? "amber" : "neutral"}>
                      {changed ? "未保存" : "已同步"}
                    </Badge>
                  </div>
                  <textarea
                    className="code-editor"
                    value={text}
                    spellCheck={false}
                    aria-label="server.properties 原文"
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                        e.preventDefault();
                        setPreview(true);
                      }
                    }}
                  />
                </Panel>
              ) : (
                <>
                  <div className="list-toolbar">
                    <SearchInput
                      value={search}
                      onChange={setSearch}
                      placeholder="搜索字段名称或配置键…"
                    />
                    <span className="muted">server.properties</span>
                  </div>
                  {visibleGroups.map((g) => (
                    <Panel
                      title={g.title}
                      subtitle={g.description}
                      key={g.title}
                    >
                      <div className="config-fields">
                        {g.fields.map(([key, label, type]) => (
                          <Field key={key} label={label} hint={key}>
                            {type === "boolean" || type.includes(",") ? (
                              <select
                                value={
                                  values[key] ??
                                  (type === "boolean"
                                    ? "false"
                                    : type.split(",")[0])
                                }
                                onChange={(e) =>
                                  setText((t) =>
                                    property(t, key, e.target.value),
                                  )
                                }
                              >
                                {(type === "boolean"
                                  ? ["true", "false"]
                                  : type.split(",")
                                ).map((v) => (
                                  <option key={v} value={v}>
                                    {
                                      (
                                        {
                                          true: "开启",
                                          false: "关闭",
                                          survival: "生存",
                                          creative: "创造",
                                          adventure: "冒险",
                                          peaceful: "和平",
                                          easy: "简单",
                                          normal: "普通",
                                          hard: "困难",
                                          nethernet: "NetherNet",
                                          raknet: "RakNet",
                                        } as Record<string, string>
                                      )[v]
                                    }
                                  </option>
                                ))}
                              </select>
                            ) : (
                              <input
                                type={type}
                                value={values[key] || ""}
                                onChange={(e) =>
                                  setText((t) =>
                                    property(t, key, e.target.value),
                                  )
                                }
                              />
                            )}
                          </Field>
                        ))}
                      </div>
                    </Panel>
                  ))}
                  {!visibleGroups.length && (
                    <Empty
                      title="没有匹配的配置项"
                      description="可使用原文编辑查看其他核心配置。"
                    />
                  )}
                </>
              )}
            </div>
          </div>
          <div className="sticky-savebar">
            <div>
              <strong>
                {changed
                  ? `${changes.length} 项配置差异，草稿未保存`
                  : "配置已同步"}
              </strong>
              <small>端口、协议、世界与多数规则在下次启动后生效。</small>
            </div>
            <Button disabled={!changed || busy} onClick={() => setReload(true)}>
              放弃更改
            </Button>
            <Button
              variant="primary"
              disabled={!changed || busy}
              onClick={() => setPreview(true)}
            >
              <Save size={15} />
              预览并保存
            </Button>
          </div>
        </>
      )}
      <Confirm
        open={reload}
        onClose={() => setReload(false)}
        title="重新读取配置"
        description="放弃当前草稿，读取磁盘上的最新配置。"
        danger
        label="放弃草稿并读取"
        onConfirm={async () => {
          const result = await act<
            TextFile & { values: Record<string, string> }
          >("config.get", { id });
          if (result) {
            setBaseline(result);
            setText(result.text);
            q.setData(result);
          }
        }}
      />
      <Drawer
        open={preview}
        onClose={() => setPreview(false)}
        title="保存前检查"
        description="校验后原子写入，外部修改冲突会阻止覆盖。"
        wide
      >
        <Notice tone="warn">
          保存不会重启服务器。端口、协议或世界改变后，请核对网络线路并在合适时机重启。
        </Notice>
        {changes.length ? (
          <table className="data-table">
            <thead>
              <tr>
                <th>配置项</th>
                <th>原值</th>
                <th>新值</th>
              </tr>
            </thead>
            <tbody>
              {changes.map((key) => (
                <tr key={key}>
                  <td className="mono">{key}</td>
                  <td>{original[key] ?? "未设置"}</td>
                  <td className="green-text">{values[key] ?? "已移除"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Notice>本次仅修改注释或格式。</Notice>
        )}
        <Disclosure title="完整原文对比">
          <div className="diff-grid">
            <div>
              <h4>原始配置</h4>
              <pre>{baseline?.text}</pre>
            </div>
            <div>
              <h4>待保存配置</h4>
              <pre className="diff-new">{text}</pre>
            </div>
          </div>
        </Disclosure>
        <div className="modal-actions">
          <Button onClick={() => setPreview(false)}>返回编辑</Button>
          <Button
            variant="primary"
            disabled={busy || !changed}
            onClick={() => void save()}
          >
            {busy ? "正在校验…" : "保留历史并保存"}
          </Button>
        </div>
      </Drawer>
    </div>
  );
}
function useInstance() {
  const id = useApp((s) => s.selected);
  const snapshot = useApp((s) => s.data?.snapshots.find((s) => s.id === id));
  return { id, snapshot };
}
