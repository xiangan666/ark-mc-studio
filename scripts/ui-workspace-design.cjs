const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

// Use only the temporary instances owned by ui-check.cjs.
module.exports = async ({ page, app, artifacts }) => {
  const folder = path.join(artifacts, "workspace-1.5");
  await fs.mkdir(folder, { recursive: true });
  const nav = async (key) => {
    const item = page.locator(`.nav-item[data-page="${key}"]`);
    const group = item.locator(
      "xpath=ancestor::div[contains(@class,'nav-group')]",
    );
    const trigger = group.locator(".nav-group-label");
    if ((await trigger.getAttribute("aria-expanded")) === "false")
      await trigger.click();
    await item.click();
    await page.locator("main h1").waitFor();
    await page.locator("main").evaluate((e) => e.scrollTo(0, 0));
  };
  const checkTabs = async () => {
    const tabs = page.getByRole("tablist").first();
    const all = tabs.getByRole("tab");
    const count = await all.count();
    assert(count >= 2);
    for (let i = 0; i < count; i++) {
      const tab = all.nth(i);
      await tab.click();
      assert.equal(await tab.getAttribute("aria-selected"), "true");
      const panelId = await tab.getAttribute("aria-controls");
      const panel = page.locator(`[id="${panelId}"]`);
      assert.equal(await panel.count(), 1);
      assert(
        await panel.isVisible(),
        `selected panel ${panelId} must be visible`,
      );
      assert.equal(
        await panel.getAttribute("aria-labelledby"),
        await tab.getAttribute("id"),
      );
      assert.equal(await tabs.locator('[role="tab"][tabindex="0"]').count(), 1);
      assert(
        await page.evaluate(() => {
          const main = document.querySelector("main");
          return main.scrollWidth <= main.clientWidth + 1;
        }),
        `tab ${panelId} must fit within the workspace`,
      );
    }
    await all.last().focus();
    await page.keyboard.press("Home");
    await all.first().evaluate((e) => {
      if (e !== document.activeElement)
        throw new Error("Home did not focus first tab");
    });
    await page.keyboard.press("End");
    await all.last().evaluate((e) => {
      if (e !== document.activeElement)
        throw new Error("End did not focus last tab");
    });
    await page.keyboard.press("ArrowRight");
    assert.equal(await all.first().getAttribute("aria-selected"), "true");
    await page.keyboard.press("ArrowLeft");
    assert.equal(await all.last().getAttribute("aria-selected"), "true");
    await all.first().click();
  };
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 940),
  );
  const pages = [
    "overview",
    "analysis",
    "console",
    "players",
    "worlds",
    "packs",
    "files",
    "config",
    "network",
    "backups",
    "schedules",
    "instances",
    "tools",
    "tasks",
    "settings",
  ];
  const global = new Set(["instances", "tools", "tasks", "settings"]);
  const reports = [];
  for (const theme of ["dark", "light"]) {
    await page.evaluate(
      (theme) =>
        window.ark.call("settings.save", { theme, reducedMotion: true }),
      theme,
    );
    await page.waitForFunction(
      (theme) => document.documentElement.dataset.theme === theme,
      theme,
    );
    for (const key of pages) {
      await nav(key);
      if (key === "overview")
        await page.locator("button.route-summary").first().waitFor();
      if (key === "network")
        await page.locator(".route-card").first().waitFor();
      if (key === "tools") await page.locator(".tool-card").first().waitFor();
      assert.equal(await page.getByLabel("选择服务器实例").count(), 1);
      assert.equal(
        await page.locator(".workspace-context").getAttribute("data-scope"),
        global.has(key) ? "workspace" : "instance",
      );
      assert.equal(
        await page.locator(".topbar .server-actions").count(),
        global.has(key) ? 0 : 1,
      );
      if (
        ["overview", "analysis", "network", "tools", "settings"].includes(key)
      )
        await checkTabs();
      if (key === "files") {
        const splitter = page.getByRole("separator", {
          name: "调整目录面板宽度",
        });
        const browser = page.locator(".file-browser");
        await page.locator(".file-tree button").first().waitFor();
        const search = await browser.locator(".search-input").boundingBox();
        assert(search.height <= 48, "file search must not stretch vertically");
        const before = await browser.boundingBox();
        await splitter.focus();
        await page.keyboard.press("ArrowRight");
        await page.waitForFunction(
          (width) =>
            document.querySelector(".file-browser").getBoundingClientRect()
              .width >
            width + 10,
          before.width,
        );
        const after = await browser.boundingBox();
        assert(
          after.width > before.width + 10,
          "keyboard resize must change actual file column width",
        );
        await page.keyboard.press("ArrowLeft");
      }
      await page.waitForTimeout(180);
      const layout = await page.evaluate(() => {
        const main = document.querySelector("main");
        const tools = document.querySelector(".topbar-tools");
        return {
          document: document.documentElement.scrollWidth <= innerWidth + 1,
          main: main.scrollWidth <= main.clientWidth + 1,
          header: tools.getBoundingClientRect().right <= innerWidth + 1,
        };
      });
      assert(
        Object.values(layout).every(Boolean),
        `${theme}/${key}: ${JSON.stringify(layout)}`,
      );
      await page.screenshot({ path: path.join(folder, `${theme}-${key}.png`) });
      reports.push({ theme, page: key, ...layout });
      if (key === "network") {
        for (const label of ["信令转接", "检测结果", "客户端"]) {
          await page.getByRole("tab", { name: label, exact: true }).click();
          await page.screenshot({
            path: path.join(folder, `${theme}-network-${label}.png`),
          });
        }
        await page.getByRole("tab", { name: "玩家入口", exact: true }).click();
      }
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1060, 700),
    );
    for (const key of [
      "overview",
      "analysis",
      "network",
      "tools",
      "settings",
    ]) {
      await nav(key);
      await checkTabs();
    }
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 940),
    );
  }
  // A deep link must open a previously hidden task area and move focus there.
  await nav("network");
  const firstRoute = page.locator('.route-card[id^="route-tunnel-"]').first();
  const routeId = (await firstRoute.getAttribute("id")).replace(
    "route-tunnel-",
    "",
  );
  await firstRoute
    .getByRole("button", { name: "检测结果", exact: true })
    .click();
  await page.waitForFunction(
    (target) => document.activeElement?.closest(target),
    `#route-diagnostics-${routeId}`,
  );
  for (const [search, label, target] of [
    ["线路质量", "检测结果", "#network-diagnostics"],
    ["统一信令", "信令转接", "#network-signaling"],
    ["核心检查", "核心维护", "#core-updates"],
  ]) {
    await page.keyboard.press("Control+k");
    await page.getByLabel("搜索全部功能").fill(search);
    await page.keyboard.press("Enter");
    await page.getByRole("tab", { name: label, exact: true }).waitFor();
    await page.waitForFunction(
      (target) => document.activeElement?.closest(target),
      target,
    );
    assert.equal(
      await page
        .getByRole("tab", { name: label, exact: true })
        .getAttribute("aria-selected"),
      "true",
    );
  }
  // Reusing the same deep link after a manual tab change must reopen it.
  await page.getByRole("tab", { name: "运行概况", exact: true }).click();
  await page.keyboard.press("Control+k");
  await page.getByLabel("搜索全部功能").fill("核心检查");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.activeElement?.closest("#core-updates"),
  );
  assert.equal(
    await page
      .getByRole("tab", { name: "核心维护", exact: true })
      .getAttribute("aria-selected"),
    "true",
  );
  await page.evaluate(() =>
    window.ark.call("settings.save", { theme: "dark" }),
  );
  await nav("overview");
  await page.getByRole("tab", { name: "运行概况", exact: true }).click();
  await fs.writeFile(
    path.join(folder, "results.json"),
    JSON.stringify(
      {
        passed: true,
        pages: 15,
        screenshots: reports.length + 6,
        keyboardTabs: true,
        fileResize: true,
        deepLinks: true,
        layouts: reports,
      },
      null,
      2,
    ),
  );
  console.log(
    "1.5.0 界面验收通过：十五页深浅主题、固定实例范围、功能分区与键盘操作、文件分栏、隐藏区域深链接。",
  );
};
