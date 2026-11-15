import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowDownToLine,
  BarChart3,
  Bookmark,
  ChevronRight,
  Clock3,
  Command,
  Pause,
  Play,
  Send,
  Terminal,
  Trash2,
} from "lucide-react";
import type { LogLine } from "../../shared/types";
import { act, time, useApp, message } from "../store";
import { readPreference } from "../navigation";
import { analyzeLogs } from "../analysis";
import {
  Badge,
  Button,
  Drawer,
  Empty,
  Heading,
  IconButton,
  Panel,
  SearchInput,
  Status,
} from "../components";

export default function ConsolePage() {
  const { selected, data, logs, mergeLogs, toast } = useApp();
  const snap = data!.snapshots.find((s) => s.id === selected);
  const [search, setSearch] = useState("");
  const [level, setLevel] = useState("ALL");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LogLine[]>([]);
  const [command, setCommand] = useState("");
  const [history, setHistory] = useState<string[]>(() =>
    readPreference<string[]>("ark.command-history", []),
  );
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [follow, setFollow] = useState(true);
  const [clearBefore, setClearBefore] = useState(0);
  const [sending, setSending] = useState(false);
  const [aux, setAux] = useState(false);
  const [auxTab, setAuxTab] = useState("history");
  const scroll = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void window.ark
      .call<LogLine[]>("console.logs", { id: selected })
      .then((lines) => mergeLogs(selected, lines))
      .catch((e) => toast(message(e), "error"));
    setClearBefore(0);
  }, [selected]);
  const all = logs[selected] || [];
  const logSummary = useMemo(
    () => analyzeLogs(paused ? frozen : all),
    [all, frozen, paused],
  );
  const shown = useMemo(
    () =>
      (paused ? frozen : all).filter(
        (line) =>
          line.seq > clearBefore &&
          (level === "ALL" || line.level === level) &&
          (!search || line.text.toLowerCase().includes(search.toLowerCase())),
      ),
    [all, frozen, paused, level, search, clearBefore],
  );
  const virtual = useVirtualizer({
    count: shown.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 29,
    overscan: 15,
  });
  useEffect(() => {
    if (follow && !paused && shown.length)
      virtual.scrollToIndex(shown.length - 1, { align: "end" });
  }, [shown.length, follow, paused]);
  async function send() {
    if (!command.trim() || sending) return;
    setSending(true);
    try {
      await window.ark.call("console.send", {
        id: selected,
        command: command.trim(),
      });
      const next = [
        command.trim(),
        ...history.filter((h) => h !== command.trim()),
      ].slice(0, 100);
      setHistory(next);
      localStorage.setItem("ark.command-history", JSON.stringify(next));
      setCommand("");
      setHistoryIndex(-1);
      setFollow(true);
    } catch (error) {
      toast(message(error), "error");
    } finally {
      setSending(false);
      input.current?.focus();
    }
  }
  return (
    <div className="page console-page">
      <Heading
        eyebrow="LIVE TERMINAL"
        title="实时控制台"
        description="搜索实时日志，筛选问题并向当前服务器发送命令。"
        actions={
          <>
            <Status status={snap?.status || "unknown"} />
            <Button onClick={() => setAux(true)}>
              <Clock3 size={15} />
              历史与收藏
            </Button>
            <Button
              onClick={() =>
                void window.ark.saveFile(
                  `mc-console-${new Date().toISOString().slice(0, 10)}.log`,
                  shown.map((l) => l.text).join("\n"),
                )
              }
            >
              <ArrowDownToLine size={15} />
              导出日志
            </Button>
          </>
        }
      />
      <div className="console-insights toolbar-surface">
        <span>
          缓存日志 <strong>{logSummary.total}</strong>
        </span>
        <button
          className={level === "ERROR" ? "selected" : ""}
          onClick={() => setLevel(level === "ERROR" ? "ALL" : "ERROR")}
          aria-pressed={level === "ERROR"}
        >
          错误 <strong>{logSummary.counts.ERROR}</strong>
        </button>
        <button
          className={level === "WARN" ? "selected" : ""}
          onClick={() => setLevel(level === "WARN" ? "ALL" : "WARN")}
          aria-pressed={level === "WARN"}
        >
          警告 <strong>{logSummary.counts.WARN}</strong>
        </button>
        <span>{paused ? "按暂停时的缓存统计" : "仅汇总后台保留的记录"}</span>
        <Button
          variant="ghost"
          onClick={() => useApp.getState().navigate("analysis")}
        >
          <BarChart3 size={14} />
          日志归类与分析
        </Button>
      </div>
      <Panel className="console-panel">
        <div className="console-toolbar">
          <div className="terminal-title">
            <Terminal size={16} />
            <strong>
              {data!.instances.find((i) => i.id === selected)?.name}
            </strong>
            <Badge>{shown.length} 行</Badge>
          </div>
          <div className="inline-actions">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="搜索控制台输出…"
            />
            <select
              aria-label="筛选日志等级"
              className="compact-select"
              value={level}
              onChange={(e) => setLevel(e.target.value)}
            >
              <option value="ALL">全部等级</option>
              <option value="INFO">INFO</option>
              <option value="WARN">WARN</option>
              <option value="ERROR">ERROR</option>
              <option value="DEBUG">DEBUG</option>
            </select>
            <IconButton
              label={paused ? "继续显示日志" : "暂停显示（服务器继续运行）"}
              onClick={() => {
                if (!paused) setFrozen(all);
                setPaused(!paused);
              }}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
            </IconButton>
            <IconButton
              label="清空当前显示，不删除日志文件"
              onClick={() => setClearBefore(all.at(-1)?.seq || 0)}
            >
              <Trash2 size={16} />
            </IconButton>
          </div>
        </div>
        <div className="console-meta">
          <span>
            <span className={`small-dot ${snap?.pid ? "green" : ""}`} />
            标准输出 / 错误输出
          </span>
          <span>
            {paused
              ? "显示已暂停，后台仍接收日志"
              : `保留最近 ${all.length} 行`}
            <span className="muted">UTF-8</span>
          </span>
        </div>
        <div
          className="console-output"
          ref={scroll}
          onScroll={() => {
            if (scroll.current) {
              const el = scroll.current;
              setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
            }
          }}
        >
          {shown.length ? (
            <div
              style={{
                height: virtual.getTotalSize(),
                position: "relative",
                width: "100%",
              }}
            >
              {virtual.getVirtualItems().map((row) => {
                const line = shown[row.index];
                return (
                  <div
                    key={line.seq}
                    data-index={row.index}
                    ref={virtual.measureElement}
                    className={`console-line ${line.level.toLowerCase()}`}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${row.start}px)`,
                    }}
                  >
                    <span className="line-number">{row.index + 1}</span>
                    <time>{time(line.at)}</time>
                    <span className="log-level">{line.level}</span>
                    <span className="log-text">
                      {line.text.replace(/^\[[^\]]+\]:\s*/, "")}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <Empty
              icon={Terminal}
              title={search ? "没有匹配的日志" : "控制台已就绪"}
              description={
                search
                  ? "尝试其他关键词或日志等级。"
                  : "启动服务器后，这里会显示真实的运行输出。"
              }
            />
          )}
        </div>
        {!follow && shown.length > 0 && (
          <button
            className="follow-button"
            onClick={() => {
              setFollow(true);
              virtual.scrollToIndex(shown.length - 1, { align: "end" });
            }}
          >
            <ArrowDown size={14} />
            回到最新输出
          </button>
        )}
        <div className="console-command">
          <ChevronRight size={20} />
          <input
            ref={input}
            aria-label="控制台命令"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            disabled={!snap?.capabilities.command}
            placeholder={
              snap?.capabilities.command
                ? "输入命令，按 Enter 执行…"
                : "启动或接管服务器后即可发送命令"
            }
            onKeyDown={(e) => {
              if (e.key === "Enter") void send();
              if (e.key === "ArrowUp") {
                e.preventDefault();
                const index = Math.min(history.length - 1, historyIndex + 1);
                setHistoryIndex(index);
                setCommand(history[index] || "");
              }
              if (e.key === "ArrowDown") {
                e.preventDefault();
                const index = Math.max(-1, historyIndex - 1);
                setHistoryIndex(index);
                setCommand(index < 0 ? "" : history[index]);
              }
            }}
          />
          <kbd>Enter</kbd>
          <Button
            variant="primary"
            onClick={() => void send()}
            disabled={sending || !snap?.capabilities.command || !command.trim()}
          >
            <Send size={14} />
            执行
          </Button>
        </div>
        <div className="command-shortcuts">
          <span>
            <Bookmark size={13} />
            常用命令
          </span>
          {data!.settings.commandFavorites.slice(0, 4).map((c) => (
            <button
              key={c}
              onClick={() => {
                setCommand(c);
                input.current?.focus();
              }}
            >
              {c}
            </button>
          ))}
          <button
            className="add-favorite"
            disabled={!command.trim()}
            onClick={() =>
              void act(
                "settings.save",
                {
                  commandFavorites: [
                    ...new Set([
                      ...data!.settings.commandFavorites,
                      command.trim(),
                    ]),
                  ].slice(0, 30),
                },
                "已收藏命令",
              )
            }
          >
            + 收藏当前命令
          </button>
        </div>
      </Panel>
      <div className="console-hint">
        <Command size={13} />
        <span>↑ ↓ 浏览命令历史</span>
        <span>·</span>
        <span>Ctrl + ` 快速打开控制台</span>
        <span className="push-right">命令直接交给 MC 控制台处理</span>
      </div>
      <Drawer
        open={aux}
        onClose={() => setAux(false)}
        title="命令历史与收藏"
        description="选中后填入输入框，确认后按 Enter 执行。"
      >
        <div className="segmented">
          <button
            className={auxTab === "history" ? "active" : ""}
            onClick={() => setAuxTab("history")}
          >
            最近命令
          </button>
          <button
            className={auxTab === "favorites" ? "active" : ""}
            onClick={() => setAuxTab("favorites")}
          >
            收藏命令
          </button>
        </div>
        <div className="console-aux">
          {(auxTab === "history"
            ? history
            : data!.settings.commandFavorites
          ).map((c) => (
            <div className="command-history-row" key={c}>
              <button
                onClick={() => {
                  setCommand(c);
                  setAux(false);
                  requestAnimationFrame(() => input.current?.focus());
                }}
              >
                <code>{c}</code>
                <ChevronRight size={14} />
              </button>
              {auxTab === "favorites" && (
                <IconButton
                  label={`取消收藏 ${c}`}
                  onClick={() =>
                    void act(
                      "settings.save",
                      {
                        commandFavorites:
                          data!.settings.commandFavorites.filter(
                            (f) => f !== c,
                          ),
                      },
                      "已取消收藏",
                    )
                  }
                >
                  <Trash2 size={14} />
                </IconButton>
              )}
            </div>
          ))}
          {!(auxTab === "history" ? history : data!.settings.commandFavorites)
            .length && (
            <Empty
              icon={Bookmark}
              title={auxTab === "history" ? "尚未执行命令" : "还没有收藏命令"}
            />
          )}
        </div>
        {auxTab === "history" && !!history.length && (
          <Button
            onClick={() => {
              setHistory([]);
              localStorage.setItem("ark.command-history", "[]");
            }}
          >
            清空本机命令历史
          </Button>
        )}
      </Drawer>
    </div>
  );
}
