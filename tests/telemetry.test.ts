import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { Runtime } from "../src/agent/runtime";
import { Store } from "../src/agent/store";

test(
  "进程采样脚本在 Windows PowerShell 5.1 西文编码下仍可解析",
  {
    skip: process.platform !== "win32",
  },
  () => {
    const command = `
    $ErrorActionPreference = 'Stop'
    $source = [Text.Encoding]::GetEncoding(1252).GetString([IO.File]::ReadAllBytes($env:ARK_MC_TELEMETRY_SOURCE))
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw ($parseErrors.ErrorId -join ', ') }
  `;
    execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(command, "utf16le").toString("base64"),
      ],
      {
        env: {
          ...process.env,
          ARK_MC_TELEMETRY_SOURCE: path.resolve("resources/telemetry.ps1"),
        },
        timeout: 10000,
        windowsHide: true,
        stdio: "pipe",
      },
    );
  },
);

test(
  "真实 Windows 采样能识别当前进程并提供新鲜结果",
  {
    skip: process.platform !== "win32",
    timeout: 30000,
  },
  async (t) => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-telemetry-"));
    const store = new Store(temp);
    const runtime = new Runtime(store, () => {}, path.resolve("resources"));
    t.after(async () => {
      runtime.dispose();
      store.close();
      await fs.rm(temp, { recursive: true, force: true });
    });
    await runtime.init();
    const deadline = Date.now() + 20000;
    while (!runtime.samplerReady && Date.now() < deadline)
      await setTimeout(100);
    assert.equal(runtime.samplerReady, true, "Windows 进程采样未就绪");
    assert.equal(runtime.telemetryFresh, true);
    const current = runtime.processes.find((item) => item.pid === process.pid);
    assert.ok(current, "采样应包含当前 Node.js 测试进程");
    assert.match(current.name, /^node\.exe$/i);
    assert.ok(current.memory > 0);
    assert.ok(current.createdAt > 0);
  },
);
