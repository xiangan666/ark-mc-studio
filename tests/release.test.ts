import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const {
  assetNames,
  finalizeRelease,
  verifyRelease,
} = require("../scripts/finalize-release.cjs");
const commit = "a".repeat(40);

test("发行资产保留精确内容，重试可恢复，并拒绝篡改、错误提交及越界文件名", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "arkmc-release-"));
  try {
    const source = path.join(temp, "fixture.exe");
    const directory = path.join(temp, "release");
    const version = "1.5.1";
    const content = Buffer.from("MZ-isolated-release-fixture");
    await fs.writeFile(source, content);
    const options = { source, directory, version, commit };
    const manifest = await finalizeRelease(options);
    assert.equal(manifest.files[0].size, content.length);
    assert.deepEqual(
      await fs.readFile(path.join(directory, assetNames(version).executable)),
      content,
    );
    assert.deepEqual(await finalizeRelease(options), manifest);
    await assert.rejects(
      verifyRelease({ ...options, commit: "b".repeat(40) }),
      /提交不匹配/,
    );
    await fs.appendFile(
      path.join(directory, assetNames(version).executable),
      "tampered",
    );
    await assert.rejects(verifyRelease(options), /摘要或大小不匹配/);
    await finalizeRelease(options);
    const manifestPath = path.join(directory, assetNames(version).manifest);
    manifest.files[0].name = "../outside.exe";
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyRelease(options), /文件名或数量不匹配/);
    assert.throws(() => assetNames("../1.5.1"), /无效发行版本/);
    await fs.writeFile(source, "not an executable");
    await assert.rejects(finalizeRelease(options), /不是 Windows 可执行文件/);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
});
