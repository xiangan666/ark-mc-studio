import { runFile } from "./runtime";
import type { ProcessInfo } from "../shared/types";

/** Fresh bounded process identities; command lines are never included in reports. */
export async function networkProcesses(): Promise<ProcessInfo[]> {
  const output = await runFile(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -Filter \"Name='frpc.exe' OR Name='python.exe' OR Name='node.exe' OR Name='bedrock_server.exe' OR Name='ArkMC Studio.exe'\" | ForEach-Object { @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;path=$_.ExecutablePath;command=$_.CommandLine;memory=0;cpuTime=0;createdAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()} }) | ConvertTo-Json -Compress -Depth 3",
    ],
    { timeout: 15000 },
  );
  const values = JSON.parse(output || "[]");
  return Array.isArray(values) ? values : [values];
}
