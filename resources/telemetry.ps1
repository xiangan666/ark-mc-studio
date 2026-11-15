$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
while ($true) {
  try {
    $items = @(Get-CimInstance Win32_Process -Filter "Name='bedrock_server.exe' OR Name='python.exe' OR Name='frpc.exe' OR Name='node.exe'" | ForEach-Object {
      @{pid=[int]$_.ProcessId;ppid=[int]$_.ParentProcessId;name=$_.Name;path=$_.ExecutablePath;command=$_.CommandLine;memory=[double]$_.WorkingSetSize;cpuTime=([double]$_.KernelModeTime+[double]$_.UserModeTime)/10000000;createdAt=([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds()}
    })
    [Console]::WriteLine((ConvertTo-Json -InputObject @{at=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();processes=$items} -Depth 4 -Compress))
  } catch { [Console]::WriteLine('{"error":"进程采样暂不可用"}') }
  Start-Sleep -Seconds 2
}
