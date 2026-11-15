$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($true) {
  try {
    $items = @(Get-CimInstance Win32_Process -Filter "Name='bedrock_server.exe' OR Name='python.exe' OR Name='frpc.exe' OR Name='node.exe'" | ForEach-Object {
      @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;path=$_.ExecutablePath;command=$_.CommandLine;memory=[double]$_.WorkingSetSize;cpuTime=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;createdAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}
    })
    [Console]::WriteLine((ConvertTo-Json -InputObject @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();processes=$items} -Depth 4 -Compress))
  # Keep this script ASCII: Windows PowerShell 5.1 uses the system ANSI code page without a BOM.
  } catch { [Console]::WriteLine('{"error":"\u8fdb\u7a0b\u91c7\u6837\u6682\u4e0d\u53ef\u7528"}') }
  Start-Sleep -Seconds 2
}
