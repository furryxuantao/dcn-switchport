// 批次1-4 新增代码的专项审计：变量遮蔽、状态残留、边界
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

console.log("\n===== 1. 变量遮蔽检查：ipt/pt 的下标不越界 =====");
{
  // 逐条测试所有新命令在各种参数长度下的行为，确保不抛异常
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const cmds = [
    "ip nat pool", "ip nat pool P", "ip nat pool P 1.1.1.1", "ip nat pool P 1.1.1.1 2.2.2.2",
    "ip nat inside source list", "ip nat inside source list 100",
    "ip nat overload", "ip nat inside", "ip nat outside",
    "route-map", "route-map M", "route-map M permit", "route-map M permit 10",
    "loop-detect", "loop-detect enable", "loop-detect threshold", "loop-detect threshold 5",
    "vtp", "vtp mode", "vtp mode server", "vtp domain", "vtp domain D", "vtp version", "vtp version 2",
    "vtp pruning", "no vtp pruning",
    "spanning-tree guard root", "spanning-tree portfast default", "spanning-tree bpduguard default",
    "spanning-tree forward-time", "spanning-tree forward-time 10",
    "spanning-tree hello-time", "spanning-tree max-age", "spanning-tree max-age 30",
    "port-group 1 load-balance", "port-group 1 load-balance xxx", "port-group 1 load-balance src-dst-mac",
    "port-group 1 min-links", "port-group 1 min-links 2",
    "logging host", "logging host 1.1.1.1", "logging trap", "logging trap xxx", "logging trap warnings",
    "logging timestamps", "no logging",
    "clock timezone", "clock timezone 8", "clock timezone 99", "clock set 10:00:00",
    "ntp server", "ntp server 1.1.1.1", "ntp source", "ntp source g0/0", "no ntp",
    "aaa new-model", "no aaa new-model", "aaa authentication login", "aaa authentication login tacacs",
    "aaa group server", "aaa group server tacacs G1",
    "tacacs-server host", "tacacs-server host 1.1.1.1", "radius-server host", "radius-server host 1.1.1.1",
    "snmp-server user", "snmp-server user U G", "snmp-server group G",
    "banner motd", "banner motd hello", "banner login hi",
    "config-register", "config-register 0x102",
    "service password-recovery", "no service password-recovery",
    "service timestamps", "history size", "history size 50",
    "ip helper-address", "ip helper-address 1.1.1.1", "no ip helper-address",
    "ip proxy-arp", "no ip proxy-arp"
  ];
  let crashed = null;
  for (const cmd of cmds) {
    try {
      const c = ctxOf(sw); c.sess.mode = "global";
      CLI.execLine(c, cmd);
    } catch (e) { crashed = crashed || (cmd + " -> " + e.message); }
  }
  ok("全局模式 " + cmds.length + " 条命令不抛异常", crashed === null, crashed);

  const ifCmds = [
    "ip nat inside", "ip nat outside", "ip helper-address", "ip helper-address 1.1.1.1",
    "proxy arp", "no proxy arp", "spanning-tree portfast", "no spanning-tree portfast",
    "spanning-tree bpduguard", "spanning-tree bpdufilter", "spanning-tree guard root",
    "spanning-tree edge", "description", "description TEXT", "speed", "speed 100",
    "duplex", "duplex xxx", "duplex full", "negotiation", "negotiation auto",
    "storm-control", "storm-control broadcast", "storm-control broadcast level 5",
    "udld", "udld enable", "dot1x", "dot1x port-control auto", "ip dhcp client"
  ];
  crashed = null;
  for (const cmd of ifCmds) {
    try {
      const c = ctxOf(sw); c.sess.mode = "if"; c.sess.ifPorts = ["e1/0/1"];
      CLI.execLine(c, cmd);
    } catch (e) { crashed = crashed || (cmd + " -> " + e.message); }
  }
  ok("接口模式 " + ifCmds.length + " 条命令不抛异常", crashed === null, crashed);
}

console.log("\n===== 2. 模式切换后状态不残留 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw);
  c.sess.mode = "global";
  CLI.execLine(c, "route-map M permit 10");
  ok("进入 route-map 模式", c.sess.mode === "route-map", c.sess.mode);
  ok("记录 routeMapName", c.sess.routeMapName === "M", c.sess.routeMapName);
  CLI.execLine(c, "exit");
  ok("退出后回 global", c.sess.mode === "global", c.sess.mode);
  // 其它模式不应带 routeMapName
  c.sess.mode = "if"; c.sess.ifPorts = ["e1/0/1"];
  CLI.execLine(c, "exit");
  ok("接口模式不残留 routeMapName", c.sess.routeMapName === undefined || c.sess.routeMapName === null,
    String(c.sess.routeMapName));
}
{
  // acl / dhcp-pool 模式与新模式互不干扰
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  const c = ctxOf(sw);
  c.sess.mode = "global";
  CLI.execLine(c, "ip access-list extended 100");
  ok("进入 acl 模式", c.sess.mode === "acl");
  CLI.execLine(c, "exit");
  c.sess.mode = "global";
  CLI.execLine(c, "ip dhcp pool p");
  ok("进入 dhcp-pool 模式", c.sess.mode === "dhcp-pool");
  ok("dhcp-pool 模式不残留 aclId", c.sess.aclId === undefined || c.sess.aclId === null, String(c.sess.aclId));
  CLI.execLine(c, "exit");
  c.sess.mode = "global";
  CLI.execLine(c, "route-map M permit 10");
  ok("route-map 模式不残留 dhcpPool", c.sess.dhcpPool === undefined || c.sess.dhcpPool === null,
    String(c.sess.dhcpPool));
}

console.log("\n===== 3. VTP 同步不影响非 VTP 设备 =====");
{
  const srv = Sim.createDevice("l2", "SERVER", 0, 0);
  const plain = Sim.createDevice("l2", "PLAIN", 0, 0);
  const devices = [srv, plain];
  run2(srv, ["@global", "vtp mode server", "vtp domain D", "vlan 50", "name X", "exit"], devices);
  const before = Object.keys(plain.vlans).length;
  Sim.vtpSync(devices, []);
  ok("未启用 VTP 的设备不受影响", Object.keys(plain.vlans).length === before,
    before + " -> " + Object.keys(plain.vlans).length);
}
{
  // VTP server 关闭后不发布
  const srv = Sim.createDevice("l2", "SERVER", 0, 0);
  run2(srv, ["@global", "vtp mode off", "vlan 60", "name Y", "exit"], [srv]);
  ok("vtp mode off 时不发布 VLAN", !srv.vtp.config["60"], JSON.stringify(Object.keys(srv.vtp.config)));
}
function run2(dev, cmds, devices) {
  const c = ctxOf(dev);
  c.devices = devices || [dev];
  for (const cmd of cmds) {
    if (cmd === "@global") { c.sess.mode = "global"; continue; }
    CLI.execLine(c, cmd);
  }
  return c;
}

console.log("\n===== 4. NAT 转换表不无限增长 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.nat.enabled = true;
  r.nat.pools["P"] = { name: "P", start: "203.0.113.1", end: "203.0.113.5" };
  r.nat.inside = ["g0/0"];
  for (let i = 0; i < 50; i++) Sim.natTranslate(r, "10.0.0." + i, 0, "g0/0", "8.8.8.8");
  const used = Object.keys(r.nat.translations).filter(k => r.nat.translations[k].inside).length;
  ok("转换记录数不超过池大小", used <= 5, "used=" + used);
  ok("池耗尽后不再新增", Sim.natTranslate(r, "10.9.9.9", 0, "g0/0", "8.8.8.8") === null);
}

console.log("\n===== 5. 环路检测不误报正常通信 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.loopDetect.enabled = true;
  sw.loopDetect.threshold = 3;
  // 同一 MAC 一直走同一端口
  for (let i = 0; i < 10; i++) Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/1");
  ok("同端口不产生告警", sw.loopDetect.alerts.length === 0, JSON.stringify(sw.loopDetect.alerts));
  ok("漂移计数保持 0", sw.loopDetect.flaps["AA:AA:AA:AA:AA:AA"].count === 0,
    String(sw.loopDetect.flaps["AA:AA:AA:AA:AA:AA"].count));
}
{
  // 未开启时不记录
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  for (let i = 0; i < 5; i++) Sim.loopDetectFlap(sw, "BB:BB:BB:BB:BB:BB", "e1/0/" + (i + 1));
  ok("未开启时不记录", Object.keys(sw.loopDetect.flaps).length === 0,
    JSON.stringify(Object.keys(sw.loopDetect.flaps)));
}

console.log("\n===== 6. 告警列表不无限增长 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.loopDetect.enabled = true;
  sw.loopDetect.threshold = 1;
  for (let i = 0; i < 100; i++) {
    Sim.loopDetectFlap(sw, "CC:CC:CC:CC:CC:0" + (i % 10), "e1/0/" + (i % 24 + 1));
  }
  ok("告警列表有上限", sw.loopDetect.alerts.length <= 50, String(sw.loopDetect.alerts.length));
}

console.log("\n===== 7. 新功能的 show 不得输出 undefined =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const shows = ["sh vtp", "sh vtp status", "sh spanning-tree detail", "sh etherchannel summary",
    "sh etherchannel load-balance", "sh interfaces status", "sh interfaces trunk",
    "sh ip interface", "sh ip helper", "sh ip proxy-arp", "sh ip rip", "sh ip ospf",
    "sh ip route static", "sh version", "sh device-info", "sh logging", "sh clock",
    "sh aaa", "sh users", "sh ip nat", "sh route-map", "sh loop-detect"];
  let bad = [];
  for (const cmd of shows) {
    let r;
    try { r = CLI.execLine(c, cmd); }
    catch (e) { bad.push(cmd + "(抛异常:" + e.message + ")"); continue; }
    const o = r.output || "";
    if (typeof r.output !== "string") bad.push(cmd + "(非字符串)");
    if (/undefined|NaN|\[object/.test(o)) bad.push(cmd + " -> " + o.slice(0, 50));
  }
  ok("22 条新 show 全部健壮", bad.length === 0, JSON.stringify(bad));
}

console.log("\n===== 8. 出厂重置覆盖新功能 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.vtp.enabled = true; sw.vtp.domain = "D"; sw.vtp.config["10"] = { name: "X" };
  sw.nat.enabled = true; sw.nat.pools["P"] = { name: "P", start: "1.1.1.1", end: "1.1.1.5" };
  sw.nat.inside = ["e1/0/1"]; sw.nat.translations["10.0.0.1:0"] = { global: "1.1.1.1", inside: "10.0.0.1" };
  sw.pbr.routeMaps["M"] = { name: "M", clauses: [{ seq: 10, match: "a", set: "b" }] };
  sw.loopDetect.enabled = true; sw.loopDetect.alerts.push({ msg: "x" });
  sw.logging.enabled = true; sw.logging.servers = ["1.1.1.1"];
  sw.clock.timezone = 8;
  sw.ntp.enabled = true;
  sw.aaa.enabled = true;
  sw.snmpv3.enabled = true;
  sw.tacacs.enabled = true; sw.radius.enabled = true;
  sw.banner.motd = "hi";
  sw.configRegister = "0x103";
  sw.historySize = 99;
  sw.ports["e1/0/1"].portFast = true;
  sw.ports["e1/0/2"].bpduGuard = true;
  sw.ports["e1/0/3"].rootGuard = true;
  sw.ports["e1/0/4"].qosPrio = 6;
  sw.ports["e1/0/5"].speed = "1000";
  sw.ports["e1/0/6"].description = "D";
  sw.ports["e1/0/7"].storm.broadcast = true;
  sw.ports["e1/0/8"].udld = true;
  sw.ports["e1/0/9"].dot1x = true;
  sw.portGroups["1"] = { mode: "on", ports: [], loadBalance: "src-dst-mac", minLinks: 2 };

  const fresh = Sim.createDevice("l2", sw.hostname, 0, 0);
  Object.keys(fresh).forEach(k => { sw[k] = fresh[k]; });

  const checks = [
    ["vtp", sw.vtp.enabled === false], ["nat enabled", sw.nat.enabled === false],
    ["nat pools", Object.keys(sw.nat.pools).length === 0],
    ["nat translations", Object.keys(sw.nat.translations).length === 0],
    ["nat inside", sw.nat.inside.length === 0],
    ["pbr routeMaps", Object.keys(sw.pbr.routeMaps).length === 0],
    ["loopDetect", sw.loopDetect.enabled === false && sw.loopDetect.alerts.length === 0],
    ["logging", sw.logging.enabled === false && sw.logging.servers.length === 0],
    ["clock", sw.clock.timezone === 0],
    ["ntp", sw.ntp.enabled === false],
    ["aaa", sw.aaa.enabled === false],
    ["snmpv3", sw.snmpv3.enabled === false],
    ["tacacs", sw.tacacs.enabled === false],
    ["radius", sw.radius.enabled === false],
    ["banner", sw.banner.motd === ""],
    ["configRegister", sw.configRegister === "default"],
    ["historySize", sw.historySize === 20],
    ["portFast", sw.ports["e1/0/1"].portFast === false],
    ["bpduGuard", sw.ports["e1/0/2"].bpduGuard === false],
    ["rootGuard", sw.ports["e1/0/3"].rootGuard === false],
    ["qosPrio", sw.ports["e1/0/4"].qosPrio === 0],
    ["speed", sw.ports["e1/0/5"].speed === "auto"],
    ["description", sw.ports["e1/0/6"].description === ""],
    ["storm", sw.ports["e1/0/7"].storm.broadcast === false],
    ["udld", sw.ports["e1/0/8"].udld === false],
    ["dot1x", sw.ports["e1/0/9"].dot1x === false],
    ["portGroups", Object.keys(sw.portGroups).length === 0]
  ];
  let bad = [];
  checks.forEach(([n, c]) => { if (!c) bad.push(n); });
  ok("出厂重置覆盖全部 " + checks.length + " 项新配置", bad.length === 0, JSON.stringify(bad));
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);