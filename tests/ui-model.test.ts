import {
  networkSectionForTarget,
  networkSections,
} from "../src/renderer/network-navigation";
import test from "node:test";
import assert from "node:assert/strict";
import { backendCompatible } from "../src/shared/backend";
import { version } from "../package.json";
import { property, properties, safeResult } from "../src/renderer/editing";
import {
  groups,
  isGlobal,
  navigation,
  readPreference,
} from "../src/renderer/navigation";

const memory = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (key: string) => memory.get(key) ?? null,
    setItem: (key: string, value: string) => memory.set(key, value),
    removeItem: (key: string) => memory.delete(key),
  },
  configurable: true,
});

test("十五页按四组覆盖，实例范围与工作空间范围明确", () => {
  assert.equal(navigation.length, 15);
  assert.equal(new Set(navigation.map((n) => n.page)).size, 15);
  assert.equal(groups.length, 4);
  assert.deepEqual(
    groups.map((_, i) => navigation.filter((n) => n.group === i).length),
    [4, 4, 3, 4],
  );
  assert.equal(isGlobal("instances"), true);
  assert.equal(isGlobal("tasks"), true);
  assert.equal(isGlobal("network"), false);
  assert.equal(isGlobal("analysis"), false);
});
test("程序使用统一版本，旧版或其他版本服务必须先确认管理服务更新", () => {
  assert.equal(backendCompatible(version), true);
  for (const old of [
    "1.1.3",
    "1.2.0",
    "1.3.0",
    "2.0.0",
    "broken",
    "1.4.0-beta",
  ])
    assert.equal(backendCompatible(old), false);
});
test("配置表单与原文同一草稿，保留中文、注释与 CRLF", () => {
  const original =
    "# 中文说明\r\nserver-name = 原世界\r\nmax-players=20\r\nunknown-key=preserved\r\n";
  const updated = property(original, "server-name", "新世界");
  assert.equal(
    updated,
    "# 中文说明\r\nserver-name = 新世界\r\nmax-players=20\r\nunknown-key=preserved\r\n",
  );
  const appended = property(updated, "difficulty", "hard");
  assert.deepEqual(properties(appended), {
    "server-name": "新世界",
    "max-players": "20",
    "unknown-key": "preserved",
    difficulty: "hard",
  });
  assert.ok(!appended.replaceAll("\r\n", "").includes("\n"));
});
test("损坏的本地偏好回退，任务技术数据递归脱敏", () => {
  memory.set("broken", "{bad");
  assert.deepEqual(readPreference("broken", [0]), [0]);
  assert.deepEqual(
    safeResult({
      name: "线路",
      token: "secret",
      nested: [{ password: "private", command: "./frpc -t 123:private-token" }],
    }),
    {
      name: "线路",
      token: "已隐藏",
      nested: [{ password: "已隐藏", command: "./frpc -t 123:***" }],
    },
  );
});
test("未保存时延迟页面与实例跳转，确认后恢复目标和各实例位置", async () => {
  const { useApp } = await import("../src/renderer/store");
  useApp.setState({
    selected: "first",
    page: "files",
    dirty: "文件编辑",
    pendingNavigation: null,
  });
  useApp.getState().navigate("network", "network-routes");
  assert.equal(useApp.getState().page, "files");
  assert.deepEqual(useApp.getState().pendingNavigation, {
    page: "network",
    target: "network-routes",
  });
  useApp.getState().completeNavigation();
  assert.equal(useApp.getState().page, "network");
  assert.equal(useApp.getState().focusTarget, "network-routes");
  useApp.setState({ page: "config", dirty: "服务器配置" });
  useApp.getState().select("second");
  assert.equal(useApp.getState().selected, "first");
  useApp.getState().completeNavigation();
  assert.equal(useApp.getState().selected, "second");
  assert.equal(useApp.getState().dirty, "");
  useApp.getState().select("first");
  assert.equal(useApp.getState().page, "config");
  useApp.getState().navigate("tasks");
  useApp.getState().select("second");
  assert.equal(useApp.getState().page, "tasks");
  const key = useApp.getState().navigationKey;
  useApp.getState().navigate("overview", "core-updates");
  useApp.getState().navigate("overview", "core-updates");
  assert.equal(useApp.getState().navigationKey, key + 2);
});
test("侧栏及分组展开状态可切换并持久保存", async () => {
  const { useApp } = await import("../src/renderer/store");
  useApp.setState({ openGroups: [0], sidebarCollapsed: false });
  useApp.getState().toggleGroup(0);
  assert.deepEqual(useApp.getState().openGroups, []);
  useApp.getState().toggleGroup(3);
  assert.deepEqual(JSON.parse(memory.get("ark.nav-groups")!), [3]);
  useApp.getState().toggleSidebar();
  assert.equal(JSON.parse(memory.get("ark.sidebar-collapsed")!), true);
});

test("网络快捷入口映射到正确任务分区", () => {
  assert.deepEqual(
    networkSections.map((i) => i.value),
    ["routes", "signals", "diagnostics", "clients"],
  );
  for (const [target, section] of [
    ["network-signaling", "signals"],
    ["network-diagnostics", "diagnostics"],
    ["route-diagnostics-850", "diagnostics"],
    ["network-clients", "clients"],
    ["network-routes", "routes"],
    ["route-tunnel-850", "routes"],
    ["route-direct", "routes"],
  ] as const)
    assert.equal(networkSectionForTarget(target), section);
  assert.equal(networkSectionForTarget("unknown"), null);
});
