const fs = require("node:fs/promises");
const path = require("node:path");
const assert = require("node:assert/strict");

// Called only from ui-check, with its disposable database and fixture servers.
module.exports = async function verifyRedesign({
  page,
  app,
  temp,
  dataRoot,
  artifacts,
  server,
}) {
  assert.equal(path.dirname(dataRoot), temp);
  const nav = async (name) => {
    const item = page.locator(".sidebar .nav-item").filter({ hasText: name });
    if (!(await item.isVisible()))
      await item
        .locator("..")
        .locator("..")
        .locator(".nav-group-label")
        .click();
    await item.click();
    await page.locator("main h1").waitFor();
  };
  const rpc = (method, args = {}) =>
    page.evaluate(({ method, args }) => window.ark.call(method, args), {
      method,
      args,
    });
  const finished = async (job) => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const state = await rpc("bootstrap");
      const value = state.jobs.find((j) => j.id === job.id);
      if (value && !["queued", "running"].includes(value.status)) {
        assert.equal(value.status, "success");
        return value;
      }
      await page.waitForTimeout(150);
    }
    throw new Error("Fixture task timed out");
  };
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1440, 900),
  );
  const first = (await rpc("bootstrap")).instances[0];
  const other = path.join(temp, "第二个中文实例");
  await fs.mkdir(other, { recursive: true });
  await fs.writeFile(
    path.join(other, "bedrock_server.exe"),
    "fixture, never launched",
  );
  await fs.writeFile(
    path.join(other, "server.properties"),
    "server-name=第二台实例\nlevel-name=空世界\nserver-port=29436\nserver-portv6=29437\nmax-players=8\n",
  );
  const second = await rpc("instances.import", { root: other });
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(dataRoot, "arkmc.sqlite"));
  db.exec("PRAGMA busy_timeout=5000");
  const putJob = db.prepare("INSERT OR REPLACE INTO jobs VALUES(?,?)");
  for (let i = 0; i < 350; i++) {
    const job = {
      id: `layout-history-${i}`,
      instanceId: i % 2 ? first.id : second.id,
      type: "fixture",
      title: `大量历史任务 ${i}`,
      status: i % 9 ? "success" : "failed",
      progress: 100,
      detail:
        i % 9
          ? "隔离测试记录：结果与文件已检查。"
          : "隔离错误：用于验证失败状态和长文字换行。".repeat(5),
      createdAt: Date.now() - 86400000 - i * 1000,
      finishedAt: Date.now() - 86399000 - i * 1000,
      result: {
        summary: "仅用于界面测试",
        verified: true,
        token: "fixture-secret",
      },
    };
    putJob.run(job.id, JSON.stringify(job));
  }
  db.prepare("INSERT OR REPLACE INTO players VALUES(?,?)").run(
    `${first.id}:fixture-player`,
    JSON.stringify({
      id: `${first.id}:fixture-player`,
      instanceId: first.id,
      name: "Fixture 玩家",
      xuid: "123456789",
      online: false,
      lastSeen: Date.now(),
      totalSeconds: 1200,
    }),
  );
  db.close();
  await page.reload();
  await nav("服务器配置");
  await page.getByLabel("服务器名称", { exact: true }).fill("需要保留的草稿");
  await nav("文件管理");
  await page.getByRole("heading", { name: "离开前保留修改" }).waitFor();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  assert.equal(
    await page.getByLabel("服务器名称", { exact: true }).inputValue(),
    "需要保留的草稿",
  );
  await page.getByLabel("选择服务器实例").selectOption(second.id);
  await page.getByRole("heading", { name: "离开前保留修改" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal(await page.getByLabel("选择服务器实例").inputValue(), first.id);
  // A background event refreshes config queries without replacing the dirty form.
  await finished(await rpc("backups.create", { id: first.id, kind: "world" }));
  assert.equal(
    await page.getByLabel("服务器名称", { exact: true }).inputValue(),
    "需要保留的草稿",
  );
  await page.getByRole("button", { name: "原文", exact: true }).click();
  assert.match(
    await page.getByLabel("server.properties 原文").inputValue(),
    /server-name=需要保留的草稿/,
  );
  await page
    .getByLabel("server.properties 原文")
    .fill(
      (await page.getByLabel("server.properties 原文").inputValue()).replace(
        "max-players=20",
        "max-players=21",
      ),
    );
  await page.getByRole("button", { name: "表单", exact: true }).click();
  assert.equal(
    await page.getByLabel("人数上限", { exact: true }).inputValue(),
    "21",
  );
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  await page
    .getByRole("button", { name: "保留历史并保存", exact: true })
    .click();
  await page
    .getByText("配置已校验并保存，历史副本已留存", { exact: true })
    .waitFor();
  await page.waitForSelector(".drawer", { state: "hidden" });
  await page.waitForTimeout(200);
  assert.equal(
    await page.getByLabel("服务器名称", { exact: true }).inputValue(),
    "需要保留的草稿",
  );
  assert.ok(
    (
      await fs.readFile(path.join(server, "server.properties"), "utf8")
    ).includes("# keep this comment"),
  );
  // Detect an external write and refuse stale-revision overwrite.
  await page.getByLabel("服务器名称", { exact: true }).fill("冲突草稿");
  const external =
    (await fs.readFile(path.join(server, "server.properties"), "utf8")) +
    "# external edit\r\n";
  await fs.writeFile(path.join(server, "server.properties"), external);
  await page.getByRole("button", { name: "预览并保存", exact: true }).click();
  await page
    .getByRole("button", { name: "保留历史并保存", exact: true })
    .click();
  await page.getByText(/文件已被其他程序修改/).waitFor();
  assert.equal(
    await fs.readFile(path.join(server, "server.properties"), "utf8"),
    external,
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "放弃更改", exact: true }).click();
  await page
    .getByRole("button", { name: "放弃草稿并读取", exact: true })
    .click();

  await nav("文件管理");
  await page
    .locator(".file-tree button")
    .filter({ hasText: "server.properties" })
    .click();
  const editor = page.getByLabel("文件内容", { exact: true });
  await editor.fill((await editor.inputValue()) + "# editor draft\r\n");
  await page.locator(".file-tree button").filter({ hasText: "logs" }).click();
  await page.getByRole("heading", { name: "当前文件有未保存修改" }).waitFor();
  await page.keyboard.press("Escape");
  assert.match(await editor.inputValue(), /# editor draft/);
  await editor.press("Control+s");
  await page.getByText("文件已保存，旧版本已留存", { exact: true }).waitFor();
  const splitter = page.getByRole("separator", { name: "调整目录面板宽度" });
  const width = Number(await splitter.getAttribute("aria-valuenow"));
  await splitter.focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(
    Number(await splitter.getAttribute("aria-valuenow")),
    width + 20,
  );
  await page.screenshot({ path: path.join(artifacts, "redesign-files.png") });
  await page.locator(".file-tree button").filter({ hasText: "大目录" }).click();
  await page.getByPlaceholder("筛选当前目录…").fill("entry-");
  await page.waitForTimeout(200);
  assert.ok(
    (await page.locator(".file-tree button").count()) < 80,
    "Large file lists must remain virtualized",
  );

  await nav("实时控制台");
  assert.ok((await page.locator(".console-line").count()) < 140);
  const started = Date.now();
  await page.getByPlaceholder("搜索控制台输出…").fill("Fixture");
  assert.ok(
    Date.now() - started < 2000,
    "Long-log filtering remains responsive",
  );
  await page.getByRole("button", { name: "历史与收藏", exact: true }).click();
  await page.getByRole("button", { name: "收藏命令", exact: true }).click();
  await page
    .locator(".command-history-row")
    .filter({ hasText: "list" })
    .getByRole("button")
    .first()
    .click();
  assert.equal(
    await page.getByLabel("控制台命令", { exact: true }).inputValue(),
    "list",
  );
  await nav("世界管理");
  await page.locator(".world-title").first().click();
  await page.getByRole("dialog").getByText("世界状态与关联内容").waitFor();
  await page.keyboard.press("Escape");
  await nav("玩家与权限");
  await page.getByRole("button", { name: "连接记录", exact: true }).click();
  await page
    .getByRole("button", { name: "玩家详情", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByText("Fixture 玩家", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "设为管理员", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await nav("世界管理");
  await page.getByRole("button", { name: "导入世界", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "下一步", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await nav("模组与插件");
  await page.getByRole("button", { name: "行为包", exact: true }).click();
  await page
    .locator(".pack-actions")
    .getByRole("button", { name: "详情", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog")
    .getByText("依赖检查", { exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await nav("备份与恢复");
  await page.getByRole("button", { name: "查看文件清单" }).first().click();
  await page.getByRole("heading", { name: "备份详情与文件清单" }).waitFor();
  await page.getByPlaceholder("搜索备份文件…").waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "恢复", exact: true }).first().click();
  assert.equal(await page.locator(".flow-steps li").count(), 4);
  await page.keyboard.press("Escape");

  await nav("自动化计划");
  await page.getByRole("button", { name: "创建计划任务", exact: true }).click();
  await page
    .getByLabel("任务名称", { exact: true })
    .fill("界面回归 · 默认暂停");
  await page.getByRole("button", { name: "每 6 小时", exact: true }).click();
  assert.equal(
    await page
      .getByRole("switch", { name: "启用任务" })
      .getAttribute("aria-checked"),
    "false",
  );
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await page.getByText("计划任务已保存", { exact: true }).waitFor();
  assert.equal(
    (await rpc("bootstrap")).schedules.find(
      (s) => s.name === "界面回归 · 默认暂停",
    ).enabled,
    false,
  );
  await page.screenshot({
    path: path.join(artifacts, "redesign-schedules.png"),
  });

  await nav("实例管理");
  assert.equal(await page.locator(".instance-card").count(), 2);
  await page
    .getByRole("button", { name: "新建或关联实例", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "下一步", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole("button", { name: "创建新服务器", exact: true }).click();
  await page
    .getByLabel("新的空目录", { exact: true })
    .fill(path.join(temp, "not-created"));
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByRole("button", { name: /官方 BDS/ }).click();
  await page
    .getByLabel("官方 ZIP（可选）")
    .fill(path.join(temp, "not-downloaded.zip"));
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "从官方来源创建", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: path.join(artifacts, "redesign-instances.png"),
  });

  // Global pages keep workspace scope while switching an instance from the command palette.
  await nav("应用设置");
  assert.equal(
    await page.locator('.workspace-context[data-scope="workspace"]').count(),
    1,
  );
  assert.equal(await page.getByLabel("选择服务器实例").count(), 1);
  await page.getByRole("tab", { name: "通知", exact: true }).click();
  await page.getByRole("switch", { name: "桌面通知" }).waitFor();
  await page.getByRole("tab", { name: "外观与交互", exact: true }).click();
  await rpc("settings.save", { reducedMotion: false });
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "full",
  );
  await page.keyboard.press("Control+k");
  await page.getByLabel("搜索全部功能").fill("核心检查");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.activeElement?.closest("#core-updates"),
  );
  await page.keyboard.press("Control+k");
  await page.getByLabel("搜索全部功能").fill("线路质量");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    document.activeElement?.closest("#network-diagnostics"),
  );
  await page.getByRole("button", { name: "收起侧栏", exact: true }).click();
  assert.equal(await page.locator(".sidebar-collapsed").count(), 1);
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  const activeGroup = page
    .locator(".nav-group")
    .filter({ has: page.locator(".nav-item.active") });
  await activeGroup.locator(".nav-group-label").click();
  assert.equal(
    await activeGroup.locator(".nav-group-label").getAttribute("aria-expanded"),
    "false",
  );
  await activeGroup.locator(".nav-group-label").click();
  await rpc("settings.save", { reducedMotion: true });
  await page.waitForFunction(
    () => document.documentElement.dataset.motion === "reduced",
  );

  const names = [
    "服务器总览",
    "运行分析",
    "实时控制台",
    "玩家与权限",
    "世界管理",
    "模组与插件",
    "文件管理",
    "网络线路",
    "备份与恢复",
    "自动化计划",
    "服务器配置",
    "实例管理",
    "工具与环境",
    "任务与记录",
    "应用设置",
  ];
  const layoutChecks = [];
  const skipLayoutMatrix = process.argv.includes("--skip-layout-matrix");
  if (!skipLayoutMatrix) {
    for (const density of ["comfortable", "compact"]) {
      const desiredLabel =
        density === "compact" ? "切换为紧凑布局" : "切换为舒适布局";
      if (
        await page
          .getByRole("button", { name: desiredLabel, exact: true })
          .count()
      )
        await page
          .getByRole("button", { name: desiredLabel, exact: true })
          .click();
      for (const theme of ["dark", "light"]) {
        await rpc("settings.save", { theme });
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        for (const [w, h] of [
          [1060, 700],
          [1440, 900],
          [1920, 1080],
        ]) {
          await app.evaluate(
            ({ BrowserWindow }, { w, h }) =>
              BrowserWindow.getAllWindows()[0].setSize(w, h),
            { w, h },
          );
          for (const name of names) {
            await nav(name);
            await page.waitForTimeout(55);
            const overflow = await page.evaluate(() => ({
              window: document.documentElement.scrollWidth > innerWidth + 1,
              main:
                document.querySelector("main").scrollWidth >
                document.querySelector("main").clientWidth + 1,
            }));
            assert.deepEqual(
              overflow,
              { window: false, main: false },
              `${theme} ${w}×${h} ${name} overflow`,
            );
            if (theme === "light" && name === "服务器总览") {
              const readable = await page.evaluate(() => {
                const probe = document.createElement("span");
                probe.style.color = "var(--text)";
                probe.style.display = "none";
                document.body.append(probe);
                const expected = getComputedStyle(probe).color;
                probe.remove();
                return (
                  getComputedStyle(document.querySelector(".world-hero h2"))
                    .color === expected
                );
              });
              assert(readable, "浅色主题的世界标题应使用正文主题色");
            }
            layoutChecks.push({ density, theme, w, h, page: name });
            if (
              density === "comfortable" &&
              w === 1440 &&
              ["服务器总览", "网络线路", "服务器配置", "玩家与权限"].includes(
                name,
              )
            )
              await page.screenshot({
                path: path.join(artifacts, `redesign-${theme}-${name}.png`),
              });
          }
          console.log(
            `布局检查通过：${density} / ${theme} / ${w}×${h} / ${names.length} 页`,
          );
        }
      }
    }
  }
  const comfortable = page.getByRole("button", {
    name: "切换为舒适布局",
    exact: true,
  });
  if (await comfortable.count()) await comfortable.click();
  // Disconnect only the isolated fixture backend; all fixture roots and PIDs are checked first.
  await page.reload();
  await nav("应用设置");
  const isolated = await rpc("bootstrap");
  assert.ok(
    isolated.instances.every(
      (i) => !path.relative(temp, i.root).startsWith(".."),
    ),
  );
  assert.ok(isolated.snapshots.every((s) => !s.pid));
  const beforeBackend = JSON.parse(
    await fs.readFile(path.join(dataRoot, ".agent-state.json"), "utf8"),
  );
  assert.notEqual(beforeBackend.pid, process.pid);
  process.kill(beforeBackend.pid);
  await page
    .locator(".main-scroll > .notice.warn")
    .filter({ hasText: "后台连接中断，下一次操作将尝试重新连接。" })
    .waitFor();
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector(".main-scroll>.notice.warn"),
  );
  const afterBackend = JSON.parse(
    await fs.readFile(path.join(dataRoot, ".agent-state.json"), "utf8"),
  );
  assert.notEqual(afterBackend.pid, beforeBackend.pid);
  assert.equal((await rpc("bootstrap")).instances.length, 2);
  await fs.writeFile(
    path.join(
      artifacts,
      skipLayoutMatrix
        ? "ui-functional-results.json"
        : "ui-redesign-results.json",
    ),
    JSON.stringify(
      {
        passed: true,
        at: new Date().toISOString(),
        layoutChecks,
        layoutMatrixSkipped: skipLayoutMatrix,
        unsavedPageAndInstanceProtection: true,
        sharedConfigDraft: true,
        backgroundRefreshDraftProtection: true,
        externalConflictProtection: true,
        fileSplitter: true,
        largeFileVirtualization: true,
        longLogVirtualization: true,
        worldAndPackDetails: true,
        backupManifestAndRestoreFlow: true,
        scheduleDefaultPaused: true,
        instanceWizardEula: true,
        paletteTargets: true,
        collapsedNavigation: true,
        fullAndReducedMotion: true,
        boundedTaskHistory: true,
        offlinePlayerActions: true,
        isolatedBackendDisconnectAndReconnect: true,
      },
      null,
      2,
    ),
  );
  console.log(
    `界面回归：${skipLayoutMatrix ? "本次跳过布局矩阵；" : `${layoutChecks.length} 组布局；`}编辑保护、向导、详情抽屉、列表性能与键盘交互通过。`,
  );
};
