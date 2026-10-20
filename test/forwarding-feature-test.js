// NAT / ACL / DHCP 中继 / 风暴抑制 的真实生效路径检查
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

console.log("\n===== 1. NAT 在转发路径上真实生效 =====");
{
  // 内外网路由器 + 内网 PC + 外网 PC
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  const pcIn = Sim.createDevice("pc", "PC_IN", 0, 0);
  const pcOut = Sim.createDevice("pc", "PC_OUT", 0, 0);
  pcIn.pcIp = "192.168.1.10"; pcIn.pcMask = "255.255.255.0"; pcIn.pcGw = "192.168.1.1";
  pcOut.pcIp = "203.0.113.5"; pcOut.pcMask = "255.255.255.0";
  r1.ifIp["g0/0"] = { ip: "192.168.1.1", mask: "255.255.255.0" };
  r1.ifIp["g0/1"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r2.ifIp["g0/0"] = { ip: "10.0.0.2", mask: "255.255.255.0" };
  r2.ifIp["g0/1"] = { ip: "203.0.113.1", mask: "255.255.255.0" };
  r1.staticRoutes = [{ dest: "203.0.113.0", mask: "255.255.255.0", nextHop: "10.0.0.2", dist: 1 }];
  r2.staticRoutes = [{ dest: "192.168.1.0", mask: "255.255.255.0", nextHop: "10.0.0.1", dist: 1 }];
  const devices = [r1, r2, pcIn, pcOut];
  const links = [
    { id: "i", kind: "copper", a: { dev: r1.id, port: "g0/0" }, b: { dev: pcIn.id, port: "eth0" } },
    { id: "w", kind: "copper", a: { dev: r1.id, port: "g0/1" }, b: { dev: r2.id, port: "g0/0" } },
    { id: "o", kind: "copper", a: { dev: r2.id, port: "g0/1" }, b: { dev: pcOut.id, port: "eth0" } }
  ];
  // 不开 NAT
  let r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("未开 NAT 时内网可达外网（经路由）", r.ok === true, r.reason);
  ok("无 NAT 转换记录", Object.keys(r1.nat.translations).length === 0);
  // 开 NAT
  r1.nat.enabled = true;
  r1.nat.inside = ["g0/0"];
  r1.nat.outside = ["g0/1"];
  r1.nat.pools["POOL"] = { name: "POOL", start: "203.0.113.100", end: "203.0.113.110" };
  r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("开 NAT 后内网仍可达外网", r.ok === true, r.reason);
  ok("生成了转换记录", Object.keys(r1.nat.translations).length >= 1,
    JSON.stringify(r1.nat.translations));
  const tr = Object.keys(r1.nat.translations).map(k => r1.nat.translations[k]).filter(t => t.inside);
  ok("转换记录含内网地址与公网地址", tr.length === 1 && tr[0].inside === "192.168.1.10" && tr[0].global === "203.0.113.100",
    JSON.stringify(tr));
  // 第二次应复用
  r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  const tr2 = Object.keys(r1.nat.translations).map(k => r1.nat.translations[k]).filter(t => t.inside);
  ok("同一内网地址复用同一转换", tr2.length === 1, JSON.stringify(tr2));
}

console.log("\n===== 2. ACL 在转发路径上真实阻断 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  sw.acl.lists["100"] = { id: "100", rules: [
    { seq: 10, action: "deny", proto: "ip", src: "192.168.1.0 0.0.0.255", dst: "any" },
    { seq: 20, action: "permit", proto: "ip", src: "any", dst: "any" }
  ] };
  sw.acl.applied = { port: { "e1/0/1": "100" } };
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("命中 deny 的流量被阻断", r.ok === false, r.reason);
  ok("原因点名 ACL", r.reason.indexOf("ACL") >= 0, r.reason);
  // 换成 permit
  sw.acl.lists["100"].rules[0].action = "permit";
  sw.acl.lists["100"].rules[1].action = "permit";
  const r2 = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("全部 permit 时可通", r2.ok === true, r2.reason);
  // 未应用的 ACL 不应生效
  sw.acl.applied = {};
  const r3 = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("未应用的 ACL 不影响转发", r3.ok === true, r3.reason);
}

console.log("\n===== 3. 风暴抑制（storm-control）=====");
{
  // 风暴抑制目前是显示项，验证它不会误伤正常通信
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  sw.ports["e1/0/1"].storm = { broadcast: true, multicast: false, unicast: false, level: 5 };
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("开启风暴抑制后正常单播仍可通", r.ok === true, r.reason);
}

console.log("\n===== 4. DHCP 中继：helper 指向的服务器能被记录 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  sw.ipHelper.enabled = true;
  sw.ipHelper.servers = ["10.0.0.5"];
  sw.ipHelper.perIf["vlan10"] = ["10.0.0.5"];
  const show = Sim.showIpHelper(sw);
  ok("show ip helper 含服务器", show.indexOf("10.0.0.5") >= 0, show);
  ok("show ip helper 含接口", show.indexOf("vlan10") >= 0 || show.indexOf("Vlan10") >= 0, show);
}

console.log("\n===== 5. NAT 地址池耗尽后不再转换 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.nat.enabled = true;
  r.nat.inside = ["g0/0"];
  r.nat.pools["P"] = { name: "P", start: "203.0.113.1", end: "203.0.113.2" };
  const a = Sim.natTranslate(r, "192.168.1.1", 0, "g0/0", "8.8.8.8");
  const b = Sim.natTranslate(r, "192.168.1.2", 0, "g0/0", "8.8.8.8");
  const c = Sim.natTranslate(r, "192.168.1.3", 0, "g0/0", "8.8.8.8");
  ok("池内有地址可分配", !!a && !!b, JSON.stringify([a, b]));
  ok("池耗尽后返回 null", c === null, String(c));
  // outside 口不转换
  ok("outside 口不转换", Sim.natTranslate(r, "1.2.3.4", 0, "g0/1", "8.8.8.8") === null);
}

console.log("\n===== 6. ACL 在路由器（L3 分支）上真实生效 =====");
{
  // 路由器的 ACL 是 ACL 的主要用途 —— 此前只在 L2 分支生效
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  const pcIn = Sim.createDevice("pc", "PC_IN", 0, 0);
  const pcOut = Sim.createDevice("pc", "PC_OUT", 0, 0);
  pcIn.pcIp = "192.168.1.10"; pcIn.pcMask = "255.255.255.0";
  pcOut.pcIp = "203.0.113.5"; pcOut.pcMask = "255.255.255.0";
  r1.ifIp["g0/0"] = { ip: "192.168.1.1", mask: "255.255.255.0" };
  r1.ifIp["g0/1"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r2.ifIp["g0/0"] = { ip: "10.0.0.2", mask: "255.255.255.0" };
  r2.ifIp["g0/1"] = { ip: "203.0.113.1", mask: "255.255.255.0" };
  r1.staticRoutes = [{ dest: "203.0.113.0", mask: "255.255.255.0", nextHop: "10.0.0.2", dist: 1 }];
  r2.staticRoutes = [{ dest: "192.168.1.0", mask: "255.255.255.0", nextHop: "10.0.0.1", dist: 1 }];
  const devices = [r1, r2, pcIn, pcOut];
  const links = [
    { id: "i", kind: "copper", a: { dev: r1.id, port: "g0/0" }, b: { dev: pcIn.id, port: "eth0" } },
    { id: "w", kind: "copper", a: { dev: r1.id, port: "g0/1" }, b: { dev: r2.id, port: "g0/0" } },
    { id: "o", kind: "copper", a: { dev: r2.id, port: "g0/1" }, b: { dev: pcOut.id, port: "eth0" } }
  ];
  // 不配 ACL 时应通
  let r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("未配 ACL 时路由器转发正常", r.ok === true, r.reason);
  // R2 上按目的地址拒绝
  r2.acl.lists["200"] = { id: "200", rules: [
    { seq: 10, action: "deny", proto: "ip", src: "any", dst: "203.0.113.0 0.0.0.255" }
  ] };
  r2.acl.applied = { global: "200" };
  r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("路由器上的 ACL 生效（被拒）", r.ok === false, r.reason);
  ok("原因点名 ACL", r.reason.indexOf("ACL") >= 0, r.reason);
  // 改 permit 应放行
  r2.acl.lists["200"].rules[0].action = "permit";
  r = Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("改为 permit 后放行", r.ok === true, r.reason);
}

console.log("\n===== 7. 三层交换机未配 SVI IP 时二层仍可转发 =====");
{
  const l3 = Sim.createDevice("l3", "L3SW", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [l3, sw2, pc1, pc2];
  const links = [
    { id: "t", kind: "copper", a: { dev: l3.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/24" } },
    { id: "a", kind: "copper", a: { dev: l3.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw2.id, port: "e1/0/1" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  ok("三层交换机未配 vlanIf", Object.keys(l3.vlanIf).length === 0);
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("未配 SVI IP 时二层仍可通", r.ok === true, r.reason);
  ok("三层交换机学到 MAC", Object.keys(l3.macTable).length > 0, JSON.stringify(l3.macTable));
  ok("对端交换机学到 MAC", Object.keys(sw2.macTable).length > 0, JSON.stringify(sw2.macTable));
}

console.log("\n===== 8. 路由器不维护二层 MAC 表（真机行为）=====");
{
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  const pcIn = Sim.createDevice("pc", "PC_IN", 0, 0);
  const pcOut = Sim.createDevice("pc", "PC_OUT", 0, 0);
  pcIn.pcIp = "192.168.1.10"; pcIn.pcMask = "255.255.255.0";
  pcOut.pcIp = "203.0.113.5"; pcOut.pcMask = "255.255.255.0";
  r1.ifIp["g0/0"] = { ip: "192.168.1.1", mask: "255.255.255.0" };
  r1.ifIp["g0/1"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r2.ifIp["g0/0"] = { ip: "10.0.0.2", mask: "255.255.255.0" };
  r2.ifIp["g0/1"] = { ip: "203.0.113.1", mask: "255.255.255.0" };
  r1.staticRoutes = [{ dest: "203.0.113.0", mask: "255.255.255.0", nextHop: "10.0.0.2", dist: 1 }];
  r2.staticRoutes = [{ dest: "192.168.1.0", mask: "255.255.255.0", nextHop: "10.0.0.1", dist: 1 }];
  const devices = [r1, r2, pcIn, pcOut];
  const links = [
    { id: "i", kind: "copper", a: { dev: r1.id, port: "g0/0" }, b: { dev: pcIn.id, port: "eth0" } },
    { id: "w", kind: "copper", a: { dev: r1.id, port: "g0/1" }, b: { dev: r2.id, port: "g0/0" } },
    { id: "o", kind: "copper", a: { dev: r2.id, port: "g0/1" }, b: { dev: pcOut.id, port: "eth0" } }
  ];
  Sim.simulatePing(devices, links, pcIn, pcOut.pcIp);
  ok("路由器不维护二层 MAC 表", Object.keys(r2.macTable).length === 0, JSON.stringify(r2.macTable));
}

console.log("\n===== 9. 既有功能不受影响 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("默认互通不受影响", r.ok === true, r.reason);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);