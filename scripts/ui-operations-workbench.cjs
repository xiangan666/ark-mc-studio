const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const dialog = (page) => page.getByRole("dialog");
const button = (page, name) => page.getByRole("button", { name, exact: true });
const folder = (artifacts) => path.join(artifacts, "operations-workbench");

async function firstUse(page, artifacts) {
  await fs.mkdir(folder(artifacts), { recursive: true });
  await page.screenshot({
    path: path.join(folder(artifacts), "first-use.png"),
  });
  for (const [action, mode] of [
    ["关联已有目录", "接入已有服务器"],
    ["创建新实例", "创建新服务器"],
  ]) {
    await button(page, action).click();
    await dialog(page)
      .getByRole("button", { name: mode, pressed: true })
      .waitFor();
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "hidden" });
    await page.waitForFunction(
      (name) => document.activeElement?.textContent.trim() === name,
      action,
    );
  }
  assert.equal(
    (await page.evaluate(() => window.ark.call("bootstrap"))).instances.length,
    0,
  );
}

async function workbench(page, temp, artifacts) {
  const rpc = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.ark.call(method, args), {
      method,
      args,
    });
  const nav = async (key) => {
    const item = page.locator(`.nav-item[data-page="${key}"]`);
    if (!(await item.isVisible()))
      await item
        .locator("xpath=ancestor::div[contains(@class,'nav-group')]")
        .locator(".nav-group-label")
        .click();
    await item.click();
    await page
      .getByRole("heading", {
        name: await item.getAttribute("aria-label"),
        exact: true,
        level: 1,
      })
      .waitFor();
  };
  const boot = await rpc("bootstrap");
  assert(
    boot.instances.length >= 2 &&
      boot.instances.every((i) => {
        const rel = path.relative(temp, i.root);
        return rel && !path.isAbsolute(rel) && !rel.startsWith("..");
      }),
  );
  assert(boot.snapshots.every((s) => s.pid === null));
  const id = await page.getByLabel("选择服务器实例").inputValue();
  // Use a future date rather than a frequent cron that could start work during this test.
  const future = new Date(Date.now() + 2 * 86400000);
  const plan = await rpc("schedules.save", {
    instanceId: id,
    name: "隔离维护计划",
    action: "backup",
    enabled: true,
    cron: `0 0 ${future.getDate()} ${future.getMonth() + 1} *`,
  });
  await page.reload();
  await nav("overview");
  const brief = page.getByRole("region", { name: "当前实例值班摘要" });
  const issues = boot.jobs.filter(
    (j) => j.instanceId === id && ["failed", "interrupted"].includes(j.status),
  );
  assert(issues.length > 0);
  await brief
    .getByRole("button", { name: new RegExp(issues.length + " 项失败或中断") })
    .click();
  await page.waitForFunction(
    (id) =>
      document.querySelector('[aria-label="筛选任务所属实例"]')?.value === id,
    id,
  );
  assert.equal(await page.getByLabel("筛选任务结果").inputValue(), "issues");
  const titles = await page.locator(".task-main strong").allTextContents();
  assert.deepEqual(titles.sort(), issues.map((j) => j.title).sort());

  await nav("overview");
  const attention = brief.getByRole("button", { name: /\d+ 条需检查/ });
  await attention.waitFor();
  const expected = Number(
    (await attention.innerText()).match(/(\d+) 条需检查/)[1],
  );
  await attention.click();
  await page.waitForFunction(
    (n) =>
      document.querySelector('[aria-label="筛选玩家入口"]')?.value ===
        "attention" &&
      document.querySelectorAll("#network-routes > .route-card").length === n,
    expected,
  );
  await nav("overview");
  await brief.getByRole("button", { name: /隔离维护计划/ }).click();
  await page.waitForFunction(
    (id) =>
      document.activeElement?.closest(".schedule-card")?.id === "plan-" + id,
    plan.id,
  );
  await nav("overview");
  await page.locator(".kpi-card").filter({ hasText: "内存占用" }).click();
  await page.getByRole("img", { name: /内存工作集趋势图/ }).waitFor();
  await button(page, "放大图表时间轴").focus();
  await page.keyboard.press("Enter");
  await page
    .locator(".chart-zoom output")
    .filter({ hasText: /^50%$/ })
    .waitFor();
  await button(page, "还原完整时间轴").click();
  await page
    .locator(".chart-zoom output")
    .filter({ hasText: /^100%$/ })
    .waitFor();
  await page.locator(".kpi-card").filter({ hasText: "服务器 TPS" }).click();
  await page.getByText("此时段暂无有效样本", { exact: true }).waitFor();
  await page.locator(".kpi-card").filter({ hasText: "CPU 使用率" }).click();
  await page.getByRole("img", { name: /CPU 使用率趋势图/ }).waitFor();
  await page.locator("main").evaluate((e) => e.scrollTo(0, 0));
  await page.screenshot({ path: path.join(folder(artifacts), "overview.png") });

  const trigger = button(page, "搜索功能、实例与操作");
  const input = page.getByRole("combobox", { name: "搜索全部功能" });
  const recent = button(page, "最近使用");
  const open = async () => {
    await page.keyboard.press("Control+k");
    await input.waitFor();
  };
  await trigger.focus();
  await open();
  await button(page, "实例").click();
  assert.equal(await page.getByRole("option").count(), boot.instances.length);
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.getByRole("option").nth(1).getAttribute("aria-selected"),
    "true",
  );
  await input.fill("not-a-fixture-name");
  await page.keyboard.press("Enter");
  await page.getByText("没有找到相关功能").waitFor();
  await recent.click();
  await button(page, "清空命令搜索").click();
  const clear = button(page, "清除最近记录");
  if (await clear.count()) await clear.click();
  await page.getByText("暂无最近使用记录").waitFor();
  await page.keyboard.press("Escape");
  await page.waitForFunction(() =>
    document.activeElement?.classList.contains("command-trigger"),
  );
  await open();
  await button(page, "操作").click();
  await input.fill("线路 检测");
  await input.dispatchEvent("keydown", {
    key: "Enter",
    code: "Enter",
    isComposing: true,
    keyCode: 229,
  });
  assert.equal(await input.isVisible(), true);
  assert.equal(await page.getByRole("option").count(), 1);
  await page.screenshot({ path: path.join(folder(artifacts), "commands.png") });
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.activeElement?.closest("#network-diagnostics"),
  );
  await nav("config");
  const name = page.getByLabel("服务器名称", { exact: true });
  await name.fill("命令搜索草稿");
  await open();
  await input.fill("世界管理");
  await page.keyboard.press("Enter");
  await dialog(page).getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(await name.inputValue(), "命令搜索草稿");
  await open();
  await recent.click();
  assert.equal(await page.getByRole("option").count(), 1);
  assert.match(await page.getByRole("option").innerText(), /线路质量/);
  await button(page, "全部").click();
  await input.fill("世界管理");
  await page.keyboard.press("Enter");
  await button(page, "放弃修改并继续").click();
  await page
    .getByRole("heading", { name: "世界管理", exact: true, level: 1 })
    .waitFor();
  await page.reload();
  await page
    .getByRole("heading", { name: "世界管理", exact: true, level: 1 })
    .waitFor();
  await open();
  await recent.click();
  assert.match(await page.getByRole("option").first().innerText(), /世界管理/);
  await clear.click();
  await page.getByText("暂无最近使用记录").waitFor();
  await page.keyboard.press("Escape");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await rpc("settings.save", { reducedMotion: false });
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "reduced",
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "full",
  );
  await rpc("settings.save", { reducedMotion: true });
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "reduced",
  );
  await rpc("schedules.remove", { id: plan.id });
  assert.deepEqual(
    (await rpc("bootstrap")).jobs.map((j) => j.id).sort(),
    boot.jobs.map((j) => j.id).sort(),
  );
  console.log(
    "1.6 工作台交互通过：首次接入、任务/线路/计划跳转、图表缩放、输入法、历史、草稿及动态减少动画。",
  );
}

module.exports = { firstUse, workbench };
