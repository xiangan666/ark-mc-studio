import { test } from "node:test";
import assert from "node:assert/strict";
import { assessUdpBinding } from "../src/agent/network";

test("NetherNet 空闲时未创建 UDP 监听不误报断网，经公网握手后确认可用", () => {
  const evidence = {
    targetIP: "192.168.1.144",
    targetPort: 19132,
    transport: "nethernet",
    addresses: [],
  };
  const idle = assessUdpBinding(evidence);
  assert.equal(idle.status, "warn");
  assert.match(idle.detail, /按连接创建/);
  const verified = assessUdpBinding(evidence, true);
  assert.equal(verified.status, "pass");
  assert.match(verified.detail, /公网传输握手已验证成功/);
  assert.equal(
    assessUdpBinding({ ...evidence, addresses: [evidence.targetIP] }).status,
    "pass",
  );
});

test("UDP 绑定诊断仍识别错误网卡与 RakNet 未监听，缺少采样须明确提示", () => {
  const evidence = {
    targetIP: "192.168.1.144",
    targetPort: 19132,
    transport: "nethernet",
  };
  assert.equal(
    assessUdpBinding({ ...evidence, addresses: ["192.168.1.99"] }, true).status,
    "fail",
  );
  assert.equal(
    assessUdpBinding({ ...evidence, transport: "raknet", addresses: [] })
      .status,
    "fail",
  );
  assert.equal(assessUdpBinding(evidence).status, "warn");
  assert.equal(
    assessUdpBinding({ ...evidence, addresses: ["0.0.0.0"] }).status,
    "pass",
  );
});
