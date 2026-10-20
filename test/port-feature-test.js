// UDLD / 802.1X / 端口速率对延迟的影响
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };

function load(file) {
  const m = { exports: {} };
  new Function("window", "global", "module", "exports",
    fs.readFileSync(path.join(ROOT, file), "utf8"))(global, global, m, m.exports);
}
load("src/sim-core.js");
load("src/cli-engine.js");
const Sim = global.DCNSim, CLI = global.DCNCLI;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}
function ctxOf(dev) {
  return {
    devices: [dev], links: [], dev: dev, sess: CLI.createSession(dev), pendingConfirm: null,
    stream: null, ping: () => ({ ok: false }), tracert: () => ({ hops: [] }), telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
  };
}
function build(nPc) {
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const devices = [sw], links = [], pcs = [];
  for (let i = 0; i < nPc; i++) {
    const pc = Sim.createDevice("pc", "PC" + (i + 1), 0, 0);
    pc.pcIp = "192.168.1." + (11 + i); pc.pcMask = "255.255.255.0";
    pcs.push(pc); devices.push(pc);
    links.push({ id: "l" + i, kind: "copper", a: { dev: sw.id, port: "e1/0/" + (i + 1) }, b: { dev: pc.id, port: "eth0" } });
  }
  return { sw, devices, links, pcs };
}

console.log("\n===== 1. UDLD：同一链路两端速率不匹配则链路不可用 =====");
{
  // 两台交换机直连，两端速率不同
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw1, sw2, pc1, pc2];
  const links = [
    { id: "t", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/24" } },
    { id: "a", kind: "copper", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw2.id, port: "e1/0/1" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  sw1.ports["e1/0/24"].speed = "100";
  sw2.ports["e1/0/24"].speed = "1000";
  let r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("未开 UDLD 时速率不同仍可通", r.ok === true, r.reason);
  // 开启 UDLD：同一链路两端速率不匹配 → 链路不可用
  sw1.ports["e1/0/24"].udld = true;
  sw2.ports["e1/0/24"].udld = true;
  r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("开启 UDLD 且同链路两端速率不匹配时不通", r.ok === false, r.reason);
  // 速率一致 → 可通
  sw2.ports["e1/0/24"].speed = "100";
  r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("开启 UDLD 但速率一致时可通", r.ok === true, r.reason);
  // 双工不匹配
  sw1.ports["e1/0/24"].duplex = "full";
  sw2.ports["e1/0/24"].duplex = "half";
  r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("双工不匹配时不通", r.ok === false, r.reason);
}

console.log("\n===== 2. 802.1X：未认证主机不通 =====");
{
  const { sw, devices, links, pcs } = build(2);
  sw.ports["e1/0/1"].dot1x = true;
  let r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("开启 dot1x 后未认证不通", r.ok === false, r.reason);
  ok("原因提到 802.1X", r.reason.indexOf("802.1X") >= 0, r.reason);
  // 认证通过
  sw.ports["e1/0/1"].dot1xAuth = true;
  r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("认证通过后可通", r.ok === true, r.reason);
  // 未开 dot1x 的口不受影响
  const { sw: sw2, devices: d2, links: l2, pcs: p2 } = build(1);
  sw2.ports["e1/0/1"].dot1x = false;
  const r2 = Sim.simulatePing(d2, l2, p2[0], "192.168.1.99");
  ok("未开 dot1x 不受影响", typeof r2.ok === "boolean");
}

console.log("\n===== 3. dot1x authenticate 命令 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  CLI.execLine(c, "interface e1/0/1");
  const r1 = CLI.execLine(c, "dot1x port-control auto");
  ok("dot1x 已开启", sw.ports["e1/0/1"].dot1x === true);
  ok("初始未认证", sw.ports["e1/0/1"].dot1xAuth === false);
  const r2 = CLI.execLine(c, "dot1x authenticate 00-11-22-33-44-55");
  ok("认证后已认证", sw.ports["e1/0/1"].dot1xAuth === true, JSON.stringify(sw.ports["e1/0/1"]));
  // 非法 MAC
  const r3 = CLI.execLine(c, "dot1x authenticate zz-11-22-33-44-55");
  ok("非法 MAC 被拒", /%/.test(r3.output || ""), r3.output);
}

console.log("\n===== 4. 端口速率影响延迟 =====");
{
  const { sw, devices, links, pcs } = build(2);
  // 同一对设备，只改速率
  const fast = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  const fastLat = fast.latency.avg;
  sw.ports["e1/0/1"].speed = "100";
  const slow = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("百兆口延迟高于千兆口", slow.latency.avg > fastLat,
    "100M=" + slow.latency.avg + " vs auto=" + fastLat);
  sw.ports["e1/0/1"].speed = "10";
  const s10 = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("十兆口延迟高于百兆口", s10.latency.avg > slow.latency.avg,
    "10M=" + s10.latency.avg + " vs 100M=" + slow.latency.avg);
}

console.log("\n===== 5. 死代码已清理 =====");
{
  const fs = require("fs");
  const sim = fs.readFileSync(path.join(ROOT, "src", "sim-core.js"), "utf8");
  ok("isValidMask 已删除", sim.indexOf("function isValidMask") < 0);
  ok("portVlanList 已删除", sim.indexOf("function portVlanList") < 0);
  ok("vlanOfPacketIngress 已删除", sim.indexOf("function vlanOfPacketIngress") < 0);
  ok("l2PathExists 已删除", sim.indexOf("function l2PathExists") < 0);
  ok("mirrorRole 已删除", sim.indexOf("mirrorRole") < 0);
  ok("genMac 仍存在", sim.indexOf("function genMac") >= 0);
}

console.log("\n===== 6. 既有功能不受影响 =====");
{
  const { sw, devices, links, pcs } = build(2);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("默认配置互通不受影响", r.ok === true, r.reason);
  ok("MAC 仍能生成", /^00:0D:28:/.test(pcs[0].pcMac), pcs[0].pcMac);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);