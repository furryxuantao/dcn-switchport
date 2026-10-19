// 运行时行为测试：验证「存了配置」的功能确实影响转发，不只是能被 show 出来
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

// 建一个 SW + 若干 PC 的星型拓扑
function star(pcCount) {
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const devices = [sw], links = [], pcs = [];
  for (let i = 0; i < pcCount; i++) {
    const pc = Sim.createDevice("pc", "PC" + (i + 1), 0, 0);
    pc.pcIp = "192.168.1." + (11 + i);
    pc.pcMask = "255.255.255.0";
    pc.pcGw = "192.168.1.254";
    pcs.push(pc); devices.push(pc);
    links.push({ id: "l" + i, kind: "copper", a: { dev: sw.id, port: "e1/0/" + (i + 1) }, b: { dev: pc.id, port: "eth0" } });
  }
  return { sw: sw, devices: devices, links: links, pcs: pcs };
}

console.log("\n===== 1. MAC 表上限：满表后不再学习 =====");
{
  const { sw } = star(3);
  ok("初始表空", Object.keys(sw.macTable).length === 0);
  Sim.learnMac(sw, "AA-AA-AA-AA-AA-AA", "e1/0/1", 1);
  Sim.learnMac(sw, "BB-BB-BB-BB-BB-BB", "e1/0/2", 1);
  ok("学习 2 条", Object.keys(sw.macTable).length === 2, JSON.stringify(Object.keys(sw.macTable)));
  sw.macLimit = 2;
  const r = Sim.learnMac(sw, "CC-CC-CC-CC-CC-CC", "e1/0/3", 1);
  ok("满表后拒绝学习", r === null, String(r));
  ok("表未增长", Object.keys(sw.macTable).length === 2);
  ok("置 macTableFull 标志", sw.macTableFull === true);
  ok("已存在项可更新（不受上限影响）",
    (Sim.learnMac(sw, "AA-AA-AA-AA-AA-AA", "e1/0/9", 1) !== null));
  ok("更新后端口已变", sw.macTable["AA-AA-AA-AA-AA-AA"].port === "e1/0/9",
    sw.macTable["AA-AA-AA-AA-AA-AA"].port);
}
{
  const { sw } = star(1);
  Sim.learnMac(sw, "AA-AA-AA-AA-AA-AA", "e1/0/1", 1);
  Sim.learnMac(sw, "BB-BB-BB-BB-BB-BB", "e1/0/2", 1);
  ok("未设上限时不限制", Object.keys(sw.macTable).length === 2);
}

console.log("\n===== 2. MAC 老化：超时自动清除 =====");
{
  const { sw } = star(2);
  sw.agingTime = 1; // 1 秒
  Sim.learnMac(sw, "AA-AA-AA-AA-AA-AA", "e1/0/1", 1);
  ok("刚学习存在", !!sw.macTable["AA-AA-AA-AA-AA-AA"]);
  // 人为把 age 改旧，模拟超时
  sw.macTable["AA-AA-AA-AA-AA-AA"].age = Date.now() - 5000;
  Sim.learnMac(sw, "BB-BB-BB-BB-BB-BB", "e1/0/2", 1);
  ok("超时项被清除", !sw.macTable["AA-AA-AA-AA-AA-AA"], JSON.stringify(Object.keys(sw.macTable)));
  ok("新项仍在", !!sw.macTable["BB-BB-BB-BB-BB-BB"]);
}
{
  const { sw } = star(2);
  sw.agingTime = 5;
  sw.macTable["AA-AA-AA-AA-AA-AA"] = { port: "e1/0/1", vlan: 1, age: Date.now() - 1000, static: true };
  Sim.learnMac(sw, "BB-BB-BB-BB-BB-BB", "e1/0/2", 1);
  ok("静态项不被老化清除", !!sw.macTable["AA-AA-AA-AA-AA-AA"]);
}

console.log("\n===== 3. 静态 MAC 保护 =====");
{
  const { sw } = star(2);
  // 通过 CLI 配静态绑定（这才是真实入口，会写 static:true）
  const ctx = { devices: [sw], links: [], dev: sw, sess: CLI.createSession(sw), pendingConfirm: null, ping: () => ({}), factoryReset: () => {}, stpInfo: () => ({}) };
  ctx.sess.mode = "global";
  CLI.execLine(ctx, "mac-address static AA-AA-AA-AA-AA-AA interface e1/0/1");
  const SMAC = "AA:AA:AA:AA:AA:AA"; // normMac 归一化后的形式
  ok("CLI 写入 staticMac", !!sw.staticMac["e1/0/1"] && sw.staticMac["e1/0/1"][0] === SMAC,
    JSON.stringify(sw.staticMac));
  ok("CLI 写入 macTable 且带 static 标记",
    !!sw.macTable[SMAC] && sw.macTable[SMAC].static === true, JSON.stringify(sw.macTable[SMAC]));
  const r = Sim.learnMac(sw, SMAC, "e1/0/5", 1);
  ok("静态项拒绝被动态改写", sw.macTable[SMAC].port === "e1/0/1", sw.macTable[SMAC].port);
  ok("learnMac 返回原记录", r && r.port === "e1/0/1", JSON.stringify(r));
}

console.log("\n===== 4. DAI 双向检测 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.arpInspection.enabled = true;
  sw.arpInspection.perVlan["10"] = "enabled";
  sw.dhcpSnooping.bindings["00:11:22:33:44:55"] = { ip: "10.1.1.5", port: "e1/0/2", vlan: 10 };
  ok("冒用他人 MAC 判违例",
    Sim.checkArpViolation(sw, 10, [{ mac: "00:11:22:33:44:55", ip: "10.1.1.9" }]) === true);
  ok("伪造他人 IP 判违例（主攻击面）",
    Sim.checkArpViolation(sw, 10, [{ mac: "AA:BB:CC:DD:EE:FF", ip: "10.1.1.5" }]) === true);
  ok("完全匹配放行",
    Sim.checkArpViolation(sw, 10, [{ mac: "00:11:22:33:44:55", ip: "10.1.1.5" }]) === false);
  ok("完全陌生主机放行",
    Sim.checkArpViolation(sw, 10, [{ mac: "99:99:99:99:99:99", ip: "10.1.1.77" }]) === false);
  ok("未纳入 DAI 的 VLAN 放行",
    Sim.checkArpViolation(sw, 99, [{ mac: "00:11:22:33:44:55", ip: "10.1.1.9" }]) === false);
  ok("空数组不抛异常", Sim.checkArpViolation(sw, 10, []) === false);
  ok("undefined 不抛异常", Sim.checkArpViolation(sw, 10) === false);
}

console.log("\n===== 5. DHCP Snooping 端到端阻断 =====");
{
  const { sw, devices, links, pcs } = star(2);
  sw.dhcpSnooping.enabled = true;
  // 先让 PC1 正常通信以建立绑定
  let r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("开启 snooping 后正常主机仍通", r.ok === true, r.reason);
  ok("已建立绑定", !!sw.dhcpSnooping.bindings[pcs[0].pcMac], JSON.stringify(Object.keys(sw.dhcpSnooping.bindings)));
}
{
  // 伪造：攻击者 MAC 声称受害者的 IP
  const { sw, devices, links, pcs } = star(2);
  sw.dhcpSnooping.enabled = true;
  sw.arpInspection.enabled = true;
  sw.arpInspection.perVlan["1"] = "enabled";
  Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp); // 建立 PC1 绑定
  const victimMac = pcs[1].pcMac, victimIp = pcs[1].pcIp;
  // 攻击者 PC3 挂着受害者 IP
  const atk = Sim.createDevice("pc", "ATK", 0, 0);
  atk.pcIp = victimIp; atk.pcMask = "255.255.255.0"; atk.pcMac = "DE:AD:BE:EF:00:01";
  devices.push(atk);
  links.push({ id: "atk", kind: "copper", a: { dev: sw.id, port: "e1/0/5" }, b: { dev: atk.id, port: "eth0" } });

  // 先让受害者自己发一次包，建立它的绑定（等价于它正常从 DHCP 拿到 lease）
  Sim.simulatePing(devices, links, pcs[1], pcs[0].pcIp);
  ok("受害者已建立绑定", !!sw.dhcpSnooping.bindings[victimMac],
    JSON.stringify(Object.keys(sw.dhcpSnooping.bindings)));

  const r2 = Sim.simulatePing(devices, links, atk, pcs[0].pcIp);
  ok("伪造 IP 的攻击者被阻断", r2.ok === false, "未被阻断 - DAI 未生效");
  ok("阻断原因点名 DAI/ARP", r2.reason.indexOf("ARP") >= 0 || r2.reason.indexOf("DHCP") >= 0, r2.reason);
}
{
  // 信任口放行
  const { sw, devices, links, pcs } = star(2);
  sw.dhcpSnooping.enabled = true;
  sw.dhcpSnooping.bindings["00:11:22:33:44:55"] = { ip: "192.168.1.11", port: "e1/0/1", vlan: 1 };
  sw.ports["e1/0/1"].trust = true;
  const guard = Sim.__testIngressGuard ? null : null;
  // 通过 simulatePing 间接验证：PC1 在信任口上，不应因绑定不符被拦
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("信任口上的主机不受绑制限制", r.ok === true, r.reason);
}

console.log("\n===== 6. 未开启时完全不影响转发 =====");
{
  const { sw, devices, links, pcs } = star(3);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[2].pcIp);
  ok("默认配置下互通不受影响", r.ok === true, r.reason);
  ok("macTableFull 未置位", sw.macTableFull !== true);
}

console.log("\n===== 7. IGMP Snooping 学习接口 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  ok("未开启不学习", (function () { Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/1", 3); return Object.keys(sw.igmpSnooping.groups).length === 0; })());
  sw.igmpSnooping.enabled = true;
  Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/1", 3);
  ok("开启后学习", !!sw.igmpSnooping.groups["10"]["239.1.1.1"]);
  Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/1", 3);
  ok("重复学习不产生重复端口", sw.igmpSnooping.groups["10"]["239.1.1.1"].ports.length === 1,
    JSON.stringify(sw.igmpSnooping.groups["10"]["239.1.1.1"].ports));
  Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/2", 3);
  ok("不同端口追加", sw.igmpSnooping.groups["10"]["239.1.1.1"].ports.length === 2);
  Sim.learnIgmp(sw, "20", "239.1.1.1", "e1/0/3", 3);
  ok("不同 vlan 分开记录", !!sw.igmpSnooping.groups["20"]["239.1.1.1"]);
}

console.log("\n===== 8. 边界与健壮性 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  ok("learnMac 不抛异常（空 mac）", Sim.learnMac(sw, "", "e1/0/1", 1) !== undefined || true);
  ok("checkDhcpViolation 端口不存在不抛异常", Sim.checkDhcpViolation(sw, "e9/9/9", "A", "1.1.1.1") === false);
  ok("isIsolated 端口不存在不抛异常", Sim.isIsolated(sw, "e9/9/9", "e1/0/1") === false);
  const t = Sim.showDhcpSnooping(Sim.createDevice("l2", "S2", 0, 0));
  ok("未配置 DHCP 时 show 正常", typeof t === "string" && t.indexOf("disabled") >= 0);
  ok("showRunningConfig 无新配置时不报错",
    Sim.showRunningConfig(Sim.createDevice("l2", "S3", 0, 0)).indexOf("ip dhcp") < 0);
}

console.log("\n===== 9. 性能：安全特性开启后的开销 =====");
{
  const devices = [], links = [];
  for (let i = 0; i < 120; i++) devices.push(Sim.createDevice("l2", "SW" + i, 0, 0));
  for (let i = 0; i < 119; i++) {
    links.push({
      id: "l" + i, kind: "copper",
      a: { dev: devices[i].id, port: "e1/0/" + ((i % 20) + 1) },
      b: { dev: devices[i + 1].id, port: "e1/0/" + (((i + 1) % 20) + 1) }
    });
  }
  devices.forEach(d => {
    d.stp.enabled = true;
    d.dhcpSnooping.enabled = true;
    d.arpInspection.enabled = true;
    d.arpInspection.perVlan["1"] = "enabled";
  });
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) Sim.simulatePing(devices, links, devices[0], "10.0.0.1");
  const dt = Date.now() - t0;
  ok("120 节点 + 全安全特性 10 次 ping < 2500ms (" + dt + "ms)", dt < 2500);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);