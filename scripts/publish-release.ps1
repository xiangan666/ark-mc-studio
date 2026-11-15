param(
    [Parameter(Mandatory = $true)][string]$Tag,
    [string]$AssetDirectory = 'release',
    [string]$Notes = '_work/release-notes.md'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $root
$version = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
if ($Tag -ne "v$version") { throw '标签与 package.json 版本不一致' }
$repository = if ($env:GH_REPO) { $env:GH_REPO } else { 'xiangan666/ark-mc-studio' }
$commit = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw '无法确定发布提交' }
node scripts/finalize-release.cjs verify $AssetDirectory
if ($LASTEXITCODE -ne 0) { throw '本地发行资产校验失败' }
$refs = @(git ls-remote origin "refs/tags/$Tag" "refs/tags/$Tag^{}")
if ($LASTEXITCODE -ne 0 -or $refs.Count -eq 0) { throw '远程标签不存在或无法读取' }
$peeled = @($refs | Where-Object { $_.EndsWith('^{}') })
$tagCommit = if ($peeled.Count) { ($peeled[0] -split '\s+')[0] } else { ($refs[0] -split '\s+')[0] }
if ($tagCommit -ne $commit) { throw '远程标签与构建提交不一致' }
$prefix = "ArkMC-Studio-$version"
$names = @("$prefix-Windows-x64.exe", "$prefix-SHA256SUMS.txt", "$prefix-release.json")
$assets = @($names | ForEach-Object { (Resolve-Path -LiteralPath (Join-Path $AssetDirectory $_)).Path })
if (-not (Test-Path -LiteralPath $Notes -PathType Leaf)) { throw '发布说明不存在' }
$releaseJson = & gh release view $Tag --repo $repository --json 'isDraft,isPrerelease,tagName,url,assets' 2>$null
if ($LASTEXITCODE -ne 0) {
    & gh release create $Tag --repo $repository --verify-tag --draft --title "ArkMC Studio $version" --notes-file $Notes --latest=false
    if ($LASTEXITCODE -ne 0) { throw '创建 Release 草稿失败；请检查权限或已有发布' }
    $releaseJson = & gh release view $Tag --repo $repository --json 'isDraft,isPrerelease,tagName,url,assets'
    if ($LASTEXITCODE -ne 0) { throw '读取 Release 草稿失败' }
}
$release = $releaseJson | ConvertFrom-Json
if ($release.tagName -ne $Tag) { throw '远程 Release 标签不匹配' }
if ($release.isDraft) {
    & gh release upload $Tag @assets --repo $repository --clobber
    if ($LASTEXITCODE -ne 0) { throw '上传草稿资产失败；草稿可恢复，未正式发布' }
}
$downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('arkmc-release-verify-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $downloadRoot | Out-Null
try {
    $remoteJson = & gh release view $Tag --repo $repository --json 'assets'
    if ($LASTEXITCODE -ne 0) { throw '读取远程资产清单失败' }
    $remote = ($remoteJson | ConvertFrom-Json).assets
    if ($remote.Count -ne $names.Count) { throw '远程资产数量不匹配' }
    foreach ($file in $assets) {
        $local = Get-Item -LiteralPath $file
        $matches = @($remote | Where-Object { $_.name -eq $local.Name -and $_.size -eq $local.Length })
        if ($matches.Count -ne 1) { throw "远程资产名称或大小不匹配：$($local.Name)" }
        & gh release download $Tag --repo $repository --pattern $local.Name --dir $downloadRoot
        if ($LASTEXITCODE -ne 0) { throw "远程资产下载失败：$($local.Name)" }
        $download = Join-Path $downloadRoot $local.Name
        if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash) { throw "远程下载内容不一致：$($local.Name)" }
    }
    node scripts/finalize-release.cjs verify $downloadRoot
    if ($LASTEXITCODE -ne 0) { throw '远程下载资产校验失败' }
} finally {
    $resolvedDownload = [IO.Path]::GetFullPath($downloadRoot)
    $temporaryRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $resolvedDownload.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) { throw '临时目录范围异常，未执行清理' }
    Remove-Item -LiteralPath $resolvedDownload -Recurse -Force
}
if ($release.isDraft) {
    & gh release edit $Tag --repo $repository --draft=false --prerelease=false --latest
    if ($LASTEXITCODE -ne 0) { throw '正式发布失败；已核对的草稿仍可恢复' }
}
$finalJson = & gh release view $Tag --repo $repository --json 'isDraft,isPrerelease,tagName,url,assets'
if ($LASTEXITCODE -ne 0) { throw '发布后状态核对失败' }
$final = $finalJson | ConvertFrom-Json
if ($final.isDraft -or $final.isPrerelease -or $final.tagName -ne $Tag) { throw 'Release 尚未成为正式稳定发布' }
$latest = & gh api "repos/$repository/releases/latest" --jq '.tag_name'
if ($LASTEXITCODE -ne 0 -or $latest -ne $Tag) { throw 'latest 稳定发布标记不匹配' }
Write-Output "已发布并核对全部资产：$($final.url)；提交 $commit"
