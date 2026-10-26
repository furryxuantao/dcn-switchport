// 思科对标增强 批次2：三层增强（DHCP中继/辅助地址/代理ARP/RIP-OSPF增强）
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
function ctxOf(dev, devices, links) {
  return {
    devices: devices || [dev], links: links || [], dev: dev,
    sess: CLI.createSession(dev), pendingConfirm: null, stream: null,
    ping: () => ({ ok: false }), tracert: () => ({ hops: [] }), telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => Sim.stpCompute(devices || [dev], links || []), refreshStp: () => {}
  };
}
function run(dev, cmds, devices, links) {
  const c = ctxOf(dev, devices, links);
  const out = [];
  for (const cmd of cmds) {
    if (cmd === "@global") { c.sess.mode = "global"; continue; }
    if (cmd === "@priv") { c.sess.mode = "priv"; continue; }
    const r = CLI.execLine(c, cmd);
    out.push({ cmd: cmd, output: r.output || "", prompt: r.prompt, mode: c.sess.mode });
  }
  return { out: out, ctx: c };
}

console.log("\n===== 1. 辅助地址（secondary address）=====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "interface g0/0", "ip address 192.168.1.1 255.255.255.0",
    "ip address 192.168.2.1 255.255.255.0 secondary", "exit",
    "@priv", "show ip interface"
  ]);
  ok("主地址已设置", r.ifIp["g0/0"].ip === "192.168.1.1", r.ifIp["g0/0"].ip);
  ok("辅助地址已记录", !!r.ifIp["g0/0"].secondary && r.ifIp["g0/0"].secondary.length === 1,
    JSON.stringify(r.ifIp["g0/0"].secondary));
  ok("辅助地址内容正确", r.ifIp["g0/0"].secondary[0].ip === "192.168.2.1", JSON.stringify(r.ifIp["g0/0"].secondary));
  ok("辅助地址产生直连路由", Sim.connectedNets(r).some(n => n.net === "192.168.2.0"),
    JSON.stringify(Sim.connectedNets(r)));
  ok("deviceIpList 含辅助地址", Sim.deviceIpList(r).indexOf("192.168.2.1") >= 0, JSON.stringify(Sim.deviceIpList(r)));
  const t = out[out.length - 1].output;
  ok("show ip interface 含辅助地址", t.indexOf("192.168.2.1") >= 0, t);
  ok("show ip interface 含主地址", t.indexOf("192.168.1.1") >= 0, t);
}
{
  // 三层交换机 VLAN 接口辅助地址
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  run(sw, ["@global", "interface vlan 10", "ip address 10.0.0.1 255.255.255.0",
    "ip address 10.0.1.1 255.255.255.0 secondary", "exit"]);
  ok("vlan 接口辅助地址", !!sw.vlanIf["10"].secondary && sw.vlanIf["10"].secondary[0].ip === "10.0.1.1",
    JSON.stringify(sw.vlanIf["10"]));
  ok("vlan 辅助地址进直连路由", Sim.connectedNets(sw).some(n => n.net === "10.0.1.0"));
  ok("vlan 辅助地址进 deviceIpList", Sim.deviceIpList(sw).indexOf("10.0.1.1") >= 0);
}
{
  // 辅助地址可被 ping 通
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const pc = Sim.createDevice("pc", "PC1", 0, 0);
  pc.pcIp = "192.168.2.50"; pc.pcMask = "255.255.255.0";
  r1.ifIp["g0/0"] = { ip: "192.168.1.1", mask: "255.255.255.0", secondary: [{ ip: "192.168.2.1", mask: "255.255.255.0" }] };
  const devices = [r1, pc];
  const links = [{ id: "l", kind: "copper", a: { dev: r1.id, port: "g0/0" }, b: { dev: pc.id, port: "eth0" } }];
  const res = Sim.simulatePing(devices, links, pc, "192.168.2.1");
  ok("ping 辅助地址成功", res.ok === true, res.reason);
}

console.log("\n===== 2. DHCP 中继（ip helper-address）=====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "interface vlan 10", "ip helper-address 10.0.0.100", "exit",
    "@priv", "show ip helper"
  ]);
  ok("helper 已启用", sw.ipHelper.enabled === true);
  ok("服务器地址已记录", sw.ipHelper.servers.indexOf("10.0.0.100") >= 0, JSON.stringify(sw.ipHelper.servers));
  ok("接口级已记录", !!sw.ipHelper.perIf["vlan10"], JSON.stringify(sw.ipHelper.perIf));
  const t = out[out.length - 1].output;
  ok("show ip helper 输出服务器", t.indexOf("10.0.0.100") >= 0, t);
  ok("show ip helper 含接口", t.indexOf("Vlan10") >= 0 || t.indexOf("vlan10") >= 0, t);
}
{
  // 非法 IP 被拒
  const sw = Sim.createDevice("l3", "SW2", 0, 0);
  const { out } = run(sw, ["@global", "ip helper-address 999.999.999.999"]);
  ok("非法 helper 地址被拒", out[0].output.indexOf("Usage:") >= 0, out[0].output);
}

console.log("\n===== 3. 代理 ARP =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "interface g0/0", "proxy arp", "exit",
    "ip proxy-arp",
    "@priv", "show ip proxy-arp"
  ]);
  ok("接口级代理 ARP", r.proxyArp.perIf["g0/0"] === true, JSON.stringify(r.proxyArp));
  ok("全局代理 ARP", r.proxyArp.enabled === true);
  const t = out[out.length - 1].output;
  ok("show ip proxy-arp 输出", t.indexOf("Proxy ARP") >= 0, t);
  ok("列出启用接口", t.indexOf("g0/0") >= 0, t);
}

console.log("\n===== 4. RIP 增强 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  run(r, ["@global", "router rip 1", "version 2", "auto-summary", "exit"]);
  ok("RIP 已启用", r.rip.enabled === true);
  ok("version 2", r.rip.version === 2);
  ok("auto-summary", r.rip.autoSummary === true);
  // 计时器
  const { out } = run(r, ["@global", "router rip 1", "timers update 20", "timers invalid 120", "exit"]);
  ok("timers update 生效", r.rip.timers.update === 20, String(r.rip.timers.update));
  ok("timers invalid 生效", r.rip.timers.invalid === 120, String(r.rip.timers.invalid));
  // poison reverse / split horizon
  run(r, ["@global", "router rip 1", "no poison-reverse", "no split-horizon", "exit"]);
  ok("no poison-reverse 生效", r.rip.poisonReverse === false);
  ok("no split-horizon 生效", r.rip.splitHorizon === false);
  // show
  const c = ctxOf(r); c.sess.mode = "priv";
  const t = CLI.execLine(c, "show ip rip").output;
  ok("show ip rip 含协议名", t.indexOf("RIP") >= 0, t);
  ok("show ip rip 含 poison reverse", t.indexOf("Poison reverse") >= 0, t);
  ok("show ip rip 含 split horizon", t.indexOf("Split horizon") >= 0, t);
  ok("show ip rip 含计时器", t.indexOf("Sending updates") >= 0, t);
}

console.log("\n===== 5. OSPF 增强 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  run(r, ["@global", "router ospf 1", "router-id 1.1.1.1", "network 10.0.0.0 0.0.0.0 area 0", "exit"]);
  ok("OSPF 已启用", r.ospf.enabled === true);
  ok("router-id", r.ospf.routerId === "1.1.1.1");
  // auto-cost
  run(r, ["@global", "router ospf 1", "auto-cost reference-bandwidth 1000", "exit"]);
  ok("auto-cost 生效", r.ospf.referenceBandwidth === 1000, String(r.ospf.referenceBandwidth));
  // log-adjacency
  run(r, ["@global", "router ospf 1", "log-adjacency-changes", "exit"]);
  ok("log-adjacency 生效", r.ospf.logAdjacency === true);
  // default-information
  run(r, ["@global", "router ospf 1", "default-information originate always", "exit"]);
  ok("default-information 生效", r.ospf.defaultOriginate === true);
  ok("default-information always 生效", r.ospf.defaultOriginateAlways === true);
  // show
  const c = ctxOf(r); c.sess.mode = "priv";
  const t = CLI.execLine(c, "show ip ospf").output;
  ok("show ip ospf 含进程号", t.indexOf("Routing Process 1") >= 0, t);
  ok("show ip ospf 含 router id", t.indexOf("1.1.1.1") >= 0, t);
  ok("show ip ospf 含参考带宽", t.indexOf("Reference bandwidth") >= 0, t);
  ok("show ip ospf 含宣告网段", t.indexOf("10.0.0.0") >= 0, t);
}

console.log("\n===== 6. show ip interface / ip route static =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.ifIp["g0/0"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r.ifIp["g0/1"] = { ip: "10.0.1.1", mask: "255.255.255.0" };
  r.staticRoutes = [{ dest: "192.168.9.0", mask: "255.255.255.0", nextHop: "10.0.0.2", dist: 1 }];
  const c = ctxOf(r); c.sess.mode = "priv";
  const t = CLI.execLine(c, "show ip interface").output;
  ok("show ip interface 含表头", t.indexOf("IP Address") >= 0, t);
  ok("列出 g0/0", t.indexOf("10.0.0.1") >= 0, t);
  ok("列出 g0/1", t.indexOf("10.0.1.1") >= 0, t);
  const t2 = CLI.execLine(c, "show ip route static").output;
  ok("show ip route static 列出路由", t2.indexOf("192.168.9.0") >= 0, t2);
  ok("含下一跳", t2.indexOf("10.0.0.2") >= 0, t2);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  const c2 = ctxOf(r2); c2.sess.mode = "priv";
  ok("无静态路由时提示", CLI.execLine(c2, "show ip route static").output.indexOf("No static routes") >= 0);
}

console.log("\n===== 7. 默认路由显示 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.staticRoutes = [{ dest: "0.0.0.0", mask: "0.0.0.0", nextHop: "10.0.0.2", dist: 1 }];
  ok("defaultRouteOf 正确", Sim.defaultRouteOf(r) === "10.0.0.2", Sim.defaultRouteOf(r));
  const c = ctxOf(r); c.sess.mode = "priv";
  ok("show ip interface 含默认网关", CLI.execLine(c, "show ip interface").output.indexOf("10.0.0.2") >= 0);
}

console.log("\n===== 8. 缩写兼容 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "interface g0/0", "ip address 10.0.0.1 255.255.255.0",
    "ip address 10.0.9.1 255.255.255.0 secondary", "exit",
    "ip helper-address 10.0.0.100",
    "@priv", "sh ip int", "sh ip help", "sh ip rip", "sh ip ospf"
  ]);
  ok("缩写 ip address secondary 生效", !!r.ifIp["g0/0"].secondary, JSON.stringify(r.ifIp["g0/0"]));
  ok("缩写 ip helper-address 生效", r.ipHelper.servers.length === 1);
  const shows = out.slice(-4).map(o => o.output);
  ok("4 条 show 缩写全部有效", shows.every(s => s && s.length > 0 &&
    s.indexOf("未知") < 0 && s.indexOf("歧义") < 0), JSON.stringify(shows.map(s => s.slice(0, 30))));
}

console.log("\n===== 9. TAB 候选 =====");
{
  const g = CLI.candidatesFor("global").map(x => x.raw);
  ok("global TAB 有 ip helper-address", g.some(x => x.indexOf("ip helper-address") === 0));
  ok("global TAB 有 ip proxy-arp", g.some(x => x.indexOf("ip proxy-arp") === 0));
  const p = CLI.candidatesFor("priv").map(x => x.raw);
  ok("priv TAB 有 show ip interface", p.indexOf("show ip interface") >= 0);
  ok("priv TAB 有 show ip helper", p.indexOf("show ip helper") >= 0);
  ok("priv TAB 有 show ip rip", p.indexOf("show ip rip") >= 0);
  ok("priv TAB 有 show ip ospf", p.indexOf("show ip ospf") >= 0);
  const i = CLI.candidatesFor("if").map(x => x.raw);
  ok("if TAB 有 proxy arp", i.some(x => x.indexOf("proxy arp") === 0));
}

console.log("\n===== 10. 既有功能不受影响 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.ifIp["g0/0"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r.staticRoutes = [{ dest: "0.0.0.0", mask: "0.0.0.0", nextHop: "10.0.0.2", dist: 1 }];
  const nets = Sim.connectedNets(r);
  ok("直连网段仍正常", nets.length === 1 && nets[0].net === "10.0.0.0", JSON.stringify(nets));
  const tbl = Sim.buildRouteTable(r, [r], []);
  ok("路由表含 C 和 S*", tbl.some(x => x.proto === "C") && tbl.some(x => x.proto === "S*"),
    JSON.stringify(tbl.map(x => x.proto)));
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);