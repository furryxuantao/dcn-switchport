// MAC 学习 + 端口安全 运行时行为测试
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
  return { sw: sw, devices: devices, links: links, pcs: pcs };
}

console.log("\n===== 1. MAC 地址表自动学习 =====");
{
  const { sw, devices, links, pcs } = build(2);
  ok("初始 MAC 表为空", Object.keys(sw.macTable).length === 0);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("ping 成功", r.ok === true, r.reason);
  ok("学到了源 MAC", !!sw.macTable[pcs[0].pcMac], JSON.stringify(Object.keys(sw.macTable)));
  ok("记录了正确端口", sw.macTable[pcs[0].pcMac].port === "e1/0/1", sw.macTable[pcs[0].pcMac].port);
  ok("记录了正确 VLAN", sw.macTable[pcs[0].pcMac].vlan === 1, String(sw.macTable[pcs[0].pcMac].vlan));
  const show = Sim.showMacTable(sw);
  ok("show mac-address-table 有内容", show.indexOf("(empty)") < 0, show);
  ok("show 标为 DYNAMIC", show.indexOf("DYNAMIC") >= 0, show);
}
{
  // 静态 MAC 优先
  const { sw, devices, links, pcs } = build(2);
  const c = ctxOf(sw); c.sess.mode = "global";
  CLI.execLine(c, "interface e1/0/1");
  CLI.execLine(c, "swi port-sec mac-add " + pcs[0].pcMac);
  CLI.execLine(c, "exit");
  Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("静态绑定不被动态学习覆盖", sw.macTable[pcs[0].pcMac].static === true,
    JSON.stringify(sw.macTable[pcs[0].pcMac]));
}

console.log("\n===== 2. 已知单播优先（按 MAC 表转发）=====");
{
  // 目的 MAC 已知 → 只走目的口
  const { sw, devices, links, pcs } = build(3);
  Sim.learnMac(sw, pcs[1].pcMac, "e1/0/2", 1);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("已知单播仍能通", r.ok === true, r.reason);
  // 路径不应经过 PC3 所在的 e1/0/3
  const via = r.path.map(p => p.via || "").join(" ");
  ok("路径不经过 e1/0/3（未无谓泛洪）", via.indexOf("e1/0/3") < 0, via);
}
{
  // MAC 表指向错误端口 → 不通，并给出准确原因
  const { sw, devices, links, pcs } = build(2);
  Sim.learnMac(sw, pcs[1].pcMac, "e1/0/1", 1);   // 错误：记在 PC1 的口
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("MAC 表错误导致不通", r.ok === false);
  ok("原因点名 MAC 地址表错误", r.reason.indexOf("MAC 地址表错误") >= 0, r.reason);
}
{
  // 目的 MAC 未知 → 泛洪，仍能通
  const { sw, devices, links, pcs } = build(2);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("未知单播泛洪仍能通", r.ok === true, r.reason);
}

console.log("\n===== 3. 端口安全：静态 MAC 不在列表 → 违例 =====");
{
  const { sw, devices, links, pcs } = build(1);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.staticMacs = ["00-11-22-33-44-55"];   // 不是 PC1 的 MAC
  const r = Sim.simulatePing(devices, links, pcs[0], "192.168.1.99");
  ok("非白名单 MAC 触发违例", sw.ports["e1/0/1"].violated === true,
    "violated=" + sw.ports["e1/0/1"].violated);
  ok("端口被 shutdown", sw.ports["e1/0/1"].shutdown === true);
  ok("有 err-disable 标记", sw.ports["e1/0/1"].errDisable === true);
  ok("原因记录", sw.ports["e1/0/1"].errDisableReason === "Port-security violation",
    sw.ports["e1/0/1"].errDisableReason);
  ok("ping 失败", r.ok === false);
  ok("原因点名端口安全违例", r.reason.indexOf("端口安全违例") >= 0, r.reason);
}
{
  // 白名单内的 MAC → 正常
  const { sw, devices, links, pcs } = build(1);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.staticMacs = [pcs[0].pcMac];
  const r = Sim.simulatePing(devices, links, pcs[0], "192.168.1.99");
  ok("白名单内 MAC 不违例", sw.ports["e1/0/1"].violated !== true);
  ok("端口保持 up", sw.ports["e1/0/1"].shutdown === false);
}

console.log("\n===== 4. 端口安全：MAC 数量超上限 → 违例 =====");
{
  const { sw, devices, links, pcs } = build(3);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.max = 1;
  // 让 e1/0/1 上先学一个 MAC（PC1），再来第二个不同的 MAC
  Sim.learnMac(sw, pcs[0].pcMac, "e1/0/1", 1);
  sw.ports["e1/0/1"].portSecurity.learnedMacs = {};
  const v = Sim.checkPortSecurityViolation(sw, "e1/0/1", pcs[0].pcMac);
  ok("第 1 个 MAC 不违例", v === null, JSON.stringify(v));
  const v2 = Sim.checkPortSecurityViolation(sw, "e1/0/1", pcs[1].pcMac);
  ok("第 2 个 MAC 违例（上限 1）", v2 && v2.violated === true, JSON.stringify(v2));
  ok("违例原因提到上限", v2 && v2.reason.indexOf("上限") >= 0, v2 ? v2.reason : "");
}
{
  // 端到端：超过 max 的第二个 MAC 触发 shutdown
  const { sw, devices, links, pcs } = build(2);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.max = 1;
  // 手动把 PC1 的 MAC 记为已学习
  sw.ports["e1/0/1"].portSecurity.learnedMacs = {};
  Sim.checkPortSecurityViolation(sw, "e1/0/1", pcs[0].pcMac);
  // 让 PC2（不同 MAC）从 e1/0/1 进来：把 PC2 的连线改接到 e1/0/1
  links[1].a.port = "e1/0/1";
  const r = Sim.simulatePing(devices, links, pcs[1], "192.168.1.99");
  ok("超限 MAC 触发端口关断", sw.ports["e1/0/1"].shutdown === true,
    "shutdown=" + sw.ports["e1/0/1"].shutdown);
  ok("端口标记违例", sw.ports["e1/0/1"].violated === true);
  ok("ping 失败", r.ok === false);
  ok("原因点名端口安全违例", r.reason.indexOf("端口安全违例") >= 0, r.reason);
}

console.log("\n===== 5. 端口安全：violation protect / restrict =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.violation = "protect";
  sw.ports["e1/0/1"].portSecurity.staticMacs = ["00-11-22-33-44-55"];
  const v = Sim.checkPortSecurityViolation(sw, "e1/0/1", "AA:BB:CC:DD:EE:FF");
  ok("protect 模式也判违例", v && v.violated === true);
  Sim.applyPortSecurityAction(sw, "e1/0/1", v);
  ok("protect 不关断端口", sw.ports["e1/0/1"].shutdown === false);
  ok("protect 标记丢弃", sw.ports["e1/0/1"].protectDrop === true);

  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  sw2.ports["e1/0/1"].portSecurity.enabled = true;
  sw2.ports["e1/0/1"].portSecurity.violation = "restrict";
  sw2.ports["e1/0/1"].portSecurity.staticMacs = ["00-11-22-33-44-55"];
  const v2 = Sim.checkPortSecurityViolation(sw2, "e1/0/1", "AA:BB:CC:DD:EE:FF");
  Sim.applyPortSecurityAction(sw2, "e1/0/1", v2);
  ok("restrict 不关断端口", sw2.ports["e1/0/1"].shutdown === false);
  ok("restrict 计数累加", sw2.ports["e1/0/1"].restrictCount === 1,
    String(sw2.ports["e1/0/1"].restrictCount));
}
{
  // CLI 支持三种 violation
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  CLI.execLine(c, "interface e1/0/1");
  const r1 = CLI.execLine(c, "swi port-sec violation protect");
  ok("violation protect 接受", sw.ports["e1/0/1"].portSecurity.violation === "protect",
    sw.ports["e1/0/1"].portSecurity.violation);
  CLI.execLine(c, "swi port-sec violation restrict");
  ok("violation restrict 接受", sw.ports["e1/0/1"].portSecurity.violation === "restrict");
  CLI.execLine(c, "swi port-sec violation shutdown recovery 60");
  ok("violation shutdown 接受", sw.ports["e1/0/1"].portSecurity.violation === "shutdown");
  ok("recovery 时间记录", sw.ports["e1/0/1"].portSecurity.recovery === 60,
    String(sw.ports["e1/0/1"].portSecurity.recovery));
  const bad = CLI.execLine(c, "swi port-sec violation xxx");
  ok("非法 violation 被拒", bad.output.indexOf("Usage:") >= 0, bad.output);
}

console.log("\n===== 6. show port-security 反映真实状态 =====");
{
  const { sw, devices, links, pcs } = build(2);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.ports["e1/0/1"].portSecurity.max = 2;
  Sim.learnMac(sw, pcs[0].pcMac, "e1/0/1", 1);
  const show = Sim.showPortSecurity(sw);
  ok("显示端口", show.indexOf("e1/0/1") >= 0, show);
  ok("显示最大地址数", show.indexOf("2") >= 0, show);
  ok("违例前显示 Shutdown", show.indexOf("Shutdown") >= 0, show);
  // 触发违例
  sw.ports["e1/0/1"].violated = true;
  const show2 = Sim.showPortSecurity(sw);
  ok("违例后显示 violated", show2.indexOf("violated") >= 0, show2);
}

console.log("\n===== 7. cpu-control 未开启时不限制 =====");
{
  const { sw, devices, links, pcs } = build(1);
  sw.ports["e1/0/1"].portSecurity.enabled = true;
  sw.cpuControl = false;
  const v = Sim.checkPortSecurityViolation(sw, "e1/0/1", pcs[0].pcMac);
  ok("未开 cpu-control 不判违例", v === null, JSON.stringify(v));
}

console.log("\n===== 8. 既有功能不受影响 =====");
{
  const { sw, devices, links, pcs } = build(2);
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("默认配置互通", r.ok === true, r.reason);
  ok("默认不违例", !sw.ports["e1/0/1"].violated);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);