import { useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  BarChart3,
  Box,
  Globe2,
  History,
  Plus,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { Empty, IconButton, Modal } from "./components";
import {
  searchCommands,
  type CommandScope,
  type SearchCommand,
} from "./command-search";
import { groups, isGlobal, navigation, type Page } from "./navigation";
import { useApp } from "./store";

const actions: {
  key: string;
  label: string;
  description: string;
  icon: typeof Box;
  page: Page;
  target?: string;
}[] = [
  {
    key: "analysis",
    label: "运行分析与趋势",
    description: "性能统计、日志归类与导出",
    icon: BarChart3,
    page: "analysis",
  },
  {
    key: "core",
    label: "核心检查与更新",
    description: "版本、兼容组合与更新策略",
    icon: RefreshCw,
    page: "overview",
    target: "core-updates",
  },
  {
    key: "quality",
    label: "线路质量与连接检测",
    description: "信令、握手与重连检测结果",
    icon: Globe2,
    page: "network",
    target: "network-diagnostics",
  },
  {
    key: "signal",
    label: "统一信令转接",
    description: "上游配置与独立 UDP 映射",
    icon: Globe2,
    page: "network",
    target: "network-signaling",
  },
  {
    key: "clients",
    label: "穿透客户端进程与日志",
    description: "客户端、独立 UDP 与进程日志",
    icon: Globe2,
    page: "network",
    target: "network-clients",
  },
];
const scopes: [CommandScope, string][] = [
  ["all", "全部"],
  ["page", "页面"],
  ["action", "操作"],
  ["instance", "实例"],
  ["recent", "最近使用"],
];
type Command = SearchCommand & { icon: typeof Box; run: () => void };
export default function CommandPalette({
  open,
  onClose,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const handoff = useRef(false);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="命令与导航"
      description="工作空间搜索"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        input.current?.focus();
      }}
      onCloseAutoFocus={(event) => {
        if (!handoff.current) return;
        event.preventDefault();
        handoff.current = false;
        const state = useApp.getState();
        if (
          state.pendingNavigation ||
          document.querySelector('[role="dialog"][data-state="open"]')
        )
          return;
        if (state.focusTarget)
          useApp.setState((s) => ({ navigationKey: s.navigationKey + 1 }));
        else
          document
            .querySelector<HTMLElement>("main")
            ?.focus({ preventScroll: true });
      }}
    >
      <PaletteBody
        input={input}
        onCreate={onCreate}
        finish={(moved) => {
          handoff.current = moved;
          onClose();
        }}
      />
    </Modal>
  );
}
function PaletteBody({
  input,
  onCreate,
  finish,
}: {
  input: React.RefObject<HTMLInputElement | null>;
  onCreate: () => void;
  finish: (moved: boolean) => void;
}) {
  const { data, selected, navigate, select } = useApp(
    useShallow((s) => ({
      data: s.data,
      selected: s.selected,
      navigate: s.navigate,
      select: s.select,
    })),
  );
  const [scope, setScope] = useState<CommandScope>("all");
  const [query, setQuery] = useState("");
  const recent = useApp((s) => s.recentCommands);
  const [index, setIndex] = useState(0);
  const hasInstance = data?.instances.some((i) => i.id === selected);
  const commands: Command[] = [
    ...(hasInstance ? actions : []).map((a) => ({
      ...a,
      key: "action:" + a.key,
      kind: "action" as const,
      run: () => navigate(a.page, a.target),
    })),
    ...(data
      ? [
          {
            key: "action:create",
            kind: "action" as const,
            label: "新建或关联实例",
            description: "工作空间 / 添加服务器",
            icon: Plus,
            run: onCreate,
          },
        ]
      : []),
    ...navigation
      .filter((n) => hasInstance || isGlobal(n.page))
      .map((n) => ({
        key: "page:" + n.page,
        kind: "page" as const,
        label: n.label,
        keywords: n.keywords,
        description: groups[n.group],
        icon: n.icon,
        run: () => navigate(n.page),
      })),
    ...(data?.instances || []).map((i) => ({
      key: "instance:" + i.id,
      kind: "instance" as const,
      label: i.name,
      description: "服务器实例 · " + i.core,
      icon: Box,
      run: () => {
        if (useApp.getState().dirty) {
          useApp.setState({
            pendingNavigation: { instance: i.id, page: "overview" },
          });
          return;
        }
        select(i.id);
        navigate("overview");
      },
    })),
  ];
  const results = searchCommands(commands, query, scope, recent);
  const active = Math.min(index, results.length - 1);
  const activeKey = results[active]?.key;
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    list.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, activeKey]);
  function run(command?: Command) {
    if (!command) return;
    const previous = useApp.getState().navigationKey;
    command.run();
    const next = useApp.getState();
    if (next.pendingNavigation)
      useApp.setState({
        pendingNavigation: {
          ...next.pendingNavigation,
          commandKey: command.key,
        },
      });
    else next.recordCommand(command.key);
    finish(
      !!next.pendingNavigation ||
        command.key === "action:create" ||
        next.navigationKey !== previous,
    );
  }
  return (
    <>
      <div className="palette-search">
        <Search size={19} />
        <input
          ref={input}
          aria-label="搜索全部功能"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls="palette-results"
          aria-activedescendant={
            active >= 0 ? "palette-result-" + active : undefined
          }
          value={query}
          onChange={(e) => {
            setIndex(0);
            setQuery(e.target.value);
          }}
          placeholder="搜索页面、操作或实例…"
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
              return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              setIndex(
                Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    active + (e.key === "ArrowDown" ? 1 : -1),
                  ),
                ),
              );
            }
            if (e.key === "Enter") {
              e.preventDefault();
              run(results[active]);
            }
          }}
        />
        {query && (
          <IconButton
            label="清空命令搜索"
            onClick={() => {
              setQuery("");
              setIndex(0);
              input.current?.focus();
            }}
          >
            <X size={14} />
          </IconButton>
        )}
      </div>
      <div className="command-filters" role="group" aria-label="搜索范围">
        {scopes.map(([key, label]) => (
          <button
            type="button"
            key={key}
            aria-pressed={key === scope}
            onClick={() => {
              setScope(key);
              setIndex(0);
              input.current?.focus();
            }}
          >
            {key === "recent" && <History size={13} />} {label}
          </button>
        ))}
      </div>
      <div
        ref={list}
        className="palette-results"
        id="palette-results"
        role="listbox"
        aria-label="功能搜索结果"
      >
        {results.map((r, i) => (
          <button
            key={r.key}
            type="button"
            tabIndex={-1}
            id={"palette-result-" + i}
            role="option"
            aria-selected={active === i}
            className={active === i ? "selected" : ""}
            onPointerMove={() => setIndex(i)}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => run(r)}
          >
            <r.icon size={18} />
            <span>
              <strong>{r.label}</strong>
              <small>{r.description}</small>
            </span>
            <ArrowUpRight size={15} />
          </button>
        ))}
      </div>
      {!results.length && (
        <Empty
          icon={scope === "recent" ? History : Search}
          title={
            scope === "recent" && !query
              ? "暂无最近使用记录"
              : "没有找到相关功能"
          }
        />
      )}
      <div className="command-footer">
        <span role="status">{results.length} 个结果</span>
        {scope === "recent" && recent.length > 0 && (
          <button
            className="text-button"
            onClick={() => {
              useApp.getState().recordCommand(null);
              setIndex(0);
              input.current?.focus();
            }}
          >
            清除最近记录
          </button>
        )}
      </div>
    </>
  );
}
