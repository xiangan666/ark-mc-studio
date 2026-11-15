export function compareVersions(a: string, b: string): number | null {
  if (!/^\d+(?:\.\d+){1,3}$/.test(a) || !/^\d+(?:\.\d+){1,3}$/.test(b))
    return null;
  const av = a.split(".").map(Number),
    bv = b.split(".").map(Number);
  for (let i = 0; i < Math.max(av.length, bv.length); i++) {
    const diff = (av[i] || 0) - (bv[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

export function windowsEndstoneVersions(metadata: any): string[] {
  return Object.keys(metadata.releases || {})
    .filter(
      (v) =>
        /^\d+\.\d+\.\d+$/.test(v) &&
        metadata.releases[v].some(
          (f: any) =>
            !f.yanked && /-cp313-cp313-win_amd64\.whl$/.test(f.filename),
        ),
    )
    .sort((a, b) => compareVersions(b, a) || 0);
}

export async function officialJSON(url: string, signal?: AbortSignal) {
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
      : AbortSignal.timeout(20000),
    headers: { "User-Agent": "ArkMC-Studio", Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`官方发行源返回 HTTP ${response.status}`);
  return response.json() as Promise<any>;
}

export async function githubFile(
  repository: string,
  ref: string,
  file: string,
  signal?: AbortSignal,
) {
  const data = await officialJSON(
    `https://api.github.com/repos/${repository}/contents/${file}?ref=${encodeURIComponent(ref)}`,
    signal,
  );
  if (
    data.encoding !== "base64" ||
    typeof data.content !== "string" ||
    data.size > 1024 * 1024
  )
    throw new Error("官方兼容元数据格式无效");
  return Buffer.from(data.content, "base64").toString("utf8");
}

export async function compatibleBedrock(
  minecraft: string,
  signal?: AbortSignal,
) {
  const version = minecraft.startsWith("1.") ? minecraft : `1.${minecraft}`;
  if (!/^1\.\d+\.\d+(?:\.\d+)?$/.test(version))
    throw new Error("官方 Minecraft 兼容版本格式无效");
  const metadata = JSON.parse(
    await githubFile(
      "EndstoneMC/bedrock-server-data",
      "v2",
      `release/${version}/metadata.json`,
      signal,
    ),
  );
  const binary = metadata.binary?.windows;
  const bdsVersion = binary?.url?.match(
    /^https:\/\/www\.minecraft\.net\/bedrockdedicatedserver\/bin-win\/bedrock-server-(\d+(?:\.\d+){2,3})\.zip$/,
  )?.[1];
  if (
    metadata.version !== version ||
    !bdsVersion ||
    !/^[a-f\d]{64}$/i.test(binary?.sha256 || "")
  )
    throw new Error("未取得兼容的 Windows BDS 官方安装元数据");
  return {
    version: bdsVersion as string,
    url: binary.url as string,
    sha256: binary.sha256 as string,
  };
}

export async function endstoneCompatibility(
  version: string,
  signal?: AbortSignal,
) {
  if (!/^\d+\.\d+\.\d+$/.test(version))
    throw new Error("Endstone 正式版本无效");
  const source = await githubFile(
    "EndstoneMC/endstone",
    `v${version}`,
    "endstone/__init__.pyi",
    signal,
  );
  const minecraft = source.match(
    /^__minecraft_version__\s*=\s*["']([\d.]+)["']/m,
  )?.[1];
  if (!minecraft)
    throw new Error("官方尚未提供可识别的 Endstone / BDS 兼容声明，请手动核对");
  return compatibleBedrock(minecraft, signal);
}
