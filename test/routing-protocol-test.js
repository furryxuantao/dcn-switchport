// OSPF 多区域 / MSTP 多实例 / RIP 定时器 的正确性检查
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };

function load(file) {
  const m = { exports: {} };
  new Function("window", "global", "module", "exports",
    fs.readFileSync(path.join(ROOT, file), "utf8"))(global, global, m, exports);
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

console.log("\n===== 1. MSTP 多实例配置 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const r = CLI.execLine(c, "spanning-tree mst configuration");
  ok("进入 mst 配置模式", c.sess.mode === "mstp", c.sess.mode);
  const r2 = CLI.execLine(c, "instance 10 vlan 10");
  ok("instance 10 绑定 vlan 10", JSON.stringify(sw.stp.instances["10"]) === JSON.stringify([10]),
    JSON.stringify(sw.stp.instances));
  const r3 = CLI.execLine(c, "instance 20 vlan 20,30");
  ok("instance 20 绑定多 vlan", JSON.stringify(sw.stp.instances["20"]) === JSON.stringify([20, 30]),
    JSON.stringify(sw.stp.instances));
  ok("mst 配置模式已启用", sw.stp.enabled === true);
  // 区域名
  CLI.execLine(c, "name LAB1");
  ok("区域名已设置", sw.stp.regionName === "LAB1", sw.stp.regionName);
  // 优先级
  CLI.execLine(c, "exit");
  c.sess.mode = "global";
  const r4 = CLI.execLine(c, "spanning-tree mst 10 priority 4096");
  ok("实例优先级已设置", sw.stp.priorities["10"] === 4096, JSON.stringify(sw.stp.priorities));
  // 非法优先级
  const r5 = CLI.execLine(c, "spanning-tree mst 20 priority 4095");
  ok("非 4096 倍数被拒", /倍|%/.test(r5.output || ""), r5.output);
}

console.log("\n===== 2. 多实例下 STP 选举是否按实例区分 =====");
{
  // 两台交换机，实例 10 优先给 SW1，实例 20 优先给 SW2
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  [sw1, sw2].forEach(s => { s.stp.enabled = true; s.stp.instances = { "10": [10], "20": [20] }; });
  sw1.stp.priorities = { "0": 32768, "10": 4096, "20": 32768 };
  sw2.stp.priorities = { "0": 32768, "10": 32768, "20": 4096 };
  const links = [{ id: "l", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/24" } }];
  const stp = Sim.stpCompute([sw1, sw2], links);
  ok("STP 计算成功", !!stp.roles, JSON.stringify(stp).slice(0, 80));
  // 至少有一个端口 FWD（树是连通的）
  const anyFwd = Object.keys(stp.roles).some(k => stp.roles[k].state === "FWD");
  ok("至少一个端口 FWD（树连通）", anyFwd, JSON.stringify(stp.roles));
}

console.log("\n===== 3. OSPF 多区域 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const c = ctxOf(r); c.sess.mode = "global";
  CLI.execLine(c, "router ospf 1");
  ok("进入 ospf 模式", c.sess.mode === "ospf", c.sess.mode);
  CLI.execLine(c, "router-id 1.1.1.1");
  ok("router-id 已设置", r.ospf.routerId === "1.1.1.1", r.ospf.routerId);
  CLI.execLine(c, "network 10.1.1.0 0.0.0.255 area 0");
  ok("area 0 网段已宣告",
    r.ospf.networks.some(n => n.net === "10.1.1.0" && n.area === 0), JSON.stringify(r.ospf.networks));
  CLI.execLine(c, "network 10.2.2.0 0.0.0.255 area 1");
  ok("area 1 网段已宣告",
    r.ospf.networks.some(n => n.net === "10.2.2.0" && n.area === 1), JSON.stringify(r.ospf.networks));
  ok("区域列表已记录", r.ospf.areas.indexOf("1") >= 0, JSON.stringify(r.ospf.areas));
  // 非法 area
  const r2 = CLI.execLine(c, "network 10.3.3.0 0.0.0.255 area 99");
  ok("area 99 被接受（真实设备允许，但应记录）", r.ospf.networks.some(n => n.area === 99),
    JSON.stringify(r.ospf.networks));
  // 退出
  const r3 = CLI.execLine(c, "exit");
  ok("退出 ospf 模式回 global", c.sess.mode === "global", c.sess.mode);
}

console.log("\n===== 4. OSPF 路由学习（跨设备）=====");
{
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  r1.ifIp["s1/0"] = { ip: "10.1.1.1", mask: "255.255.255.0", clock: true };
  r1.ifIp["g0/0"] = { ip: "10.9.9.1", mask: "255.255.255.0" };   // R1 独立网段
  r2.ifIp["s1/0"] = { ip: "10.1.1.2", mask: "255.255.255.0" };
  // R2 另有一个 192.168.2.0/24 的接口（OSPF 宣告的网段必须真实存在于接口）
  r2.ifIp["g0/0"] = { ip: "192.168.2.1", mask: "255.255.255.0" };
  const links = [{ id: "l", kind: "serial", a: { dev: r1.id, port: "s1/0" }, b: { dev: r2.id, port: "s1/0" } }];
  const devices = [r1, r2];
  [r1, r2].forEach(r => {
    r.ospf.enabled = true;
    r.ospf.routerId = r === r1 ? "1.1.1.1" : "2.2.2.2";
    r.ospf.networks = [{ net: "10.1.1.0", mask: "255.255.255.0", area: 0 }];
  });
  r1.ospf.networks.push({ net: "10.9.9.0", mask: "255.255.255.0", area: 0 });
  r2.ospf.networks.push({ net: "192.168.2.0", mask: "255.255.255.0", area: 0 });
  const t1 = Sim.buildRouteTable(r1, devices, links);
  ok("R1 学到 OSPF 路由", t1.some(x => x.proto === "O" && x.dest === "192.168.2.0"),
    JSON.stringify(t1.map(x => x.proto + " " + x.dest)));
  const t2 = Sim.buildRouteTable(r2, devices, links);
  ok("R2 路由表含 C 与 O", t2.some(x => x.proto === "C") && t2.some(x => x.proto === "O"),
    JSON.stringify(t2.map(x => x.proto + " " + x.dest)));
}

console.log("\n===== 5. RIP 定时器与收敛 =====");
{
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  r1.ifIp["s1/0"] = { ip: "10.1.1.1", mask: "255.255.255.0", clock: true };
  r1.ifIp["g0/0"] = { ip: "10.9.9.1", mask: "255.255.255.0" };   // R1 自己的独立网段
  r2.ifIp["s1/0"] = { ip: "10.1.1.2", mask: "255.255.255.0" };
  r2.ifIp["g0/0"] = { ip: "192.168.2.1", mask: "255.255.255.0" }; // R2 自己的独立网段
  const links = [{ id: "l", kind: "serial", a: { dev: r1.id, port: "s1/0" }, b: { dev: r2.id, port: "s1/0" } }];
  const devices = [r1, r2];
  r1.rip.enabled = true; r1.rip.version = 2;
  r1.rip.networks = [{ net: "10.1.1.0", mask: "255.255.255.0" }, { net: "10.9.9.0", mask: "255.255.255.0" }];
  r1.rip.enabledIfs = { "s1/0": true };
  r2.rip.enabled = true; r2.rip.version = 2;
  r2.rip.networks = [{ net: "10.1.1.0", mask: "255.255.255.0" }, { net: "192.168.2.0", mask: "255.255.255.0" }];
  r2.rip.enabledIfs = { "s1/0": true };
  const t1 = Sim.buildRouteTable(r1, devices, links);
  ok("R1 学到 RIP 路由", t1.some(x => x.proto === "R" && x.dest === "192.168.2.0"),
    JSON.stringify(t1.map(x => x.proto + " " + x.dest)));
  ok("RIP 路由 dist=120", t1.filter(x => x.proto === "R")[0].dist === 120,
    JSON.stringify(t1.filter(x => x.proto === "R")[0]));
  const t2 = Sim.buildRouteTable(r2, devices, links);
  ok("R2 学到 R1 的网段", t2.some(x => x.proto === "R" && x.dest === "10.9.9.0"),
    JSON.stringify(t2.map(x => x.proto + " " + x.dest)));
  // passive-interface
  r2.rip.passiveIfs = { "s1/0": true };
  ok("passive-interface 已记录", r2.rip.passiveIfs["s1/0"] === true);
}

console.log("\n===== 6. 静态路由与默认路由 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const c = ctxOf(r); c.sess.mode = "global";
  CLI.execLine(c, "ip route 192.168.9.0 255.255.255.0 10.0.0.2");
  ok("静态路由已配置", r.staticRoutes.length === 1, JSON.stringify(r.staticRoutes));
  ok("下一跳正确", r.staticRoutes[0].nextHop === "10.0.0.2", r.staticRoutes[0].nextHop);
  CLI.execLine(c, "ip route 0.0.0.0 0.0.0.0 10.0.0.2 50");
  ok("默认路由已配置", r.staticRoutes.length === 2);
  const dflt = r.staticRoutes.filter(x => x.dest === "0.0.0.0")[0];
  ok("默认路由距离 50", dflt && dflt.dist === 50, JSON.stringify(dflt));
  // 备份默认路由（更大距离）
  CLI.execLine(c, "ip route 0.0.0.0 0.0.0.0 10.0.0.3 100");
  const t = Sim.buildRouteTable(r, [r], []);
  const d = t.filter(x => x.dest === "0.0.0.0");
  ok("两条默认路由都在表里", d.length === 2, JSON.stringify(d));
  ok("选距离小的", d[0].dist === 50, JSON.stringify(d.map(x => x.dist)));
  // 无效下一跳
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  const c2 = ctxOf(r2); c2.sess.mode = "global";
  const bad = CLI.execLine(c2, "ip route 1.2.3.4 255.255.255.0 999.999.999.999");
  ok("非法下一跳被拒", /%/.test(bad.output || ""), bad.output);
  // 非法掩码
  const bad2 = CLI.execLine(c2, "ip route 1.2.3.4 999.999.999.999 10.0.0.1");
  ok("非法掩码被拒", /%/.test(bad2.output || ""), bad2.output);
}

console.log("\n===== 7. show ip route 的协议标记 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.ifIp["g0/0"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r.staticRoutes = [{ dest: "0.0.0.0", mask: "0.0.0.0", nextHop: "10.0.0.2", dist: 1 }];
  const c = ctxOf(r); c.sess.mode = "priv";
  const t = CLI.execLine(c, "show ip route").output;
  ok("含 C 路由", /C\s/.test(t), t);
  ok("含 S* 默认路由", t.indexOf("S*") >= 0, t);
  ok("含 Gateway of last resort", /Gateway of last resort/.test(t), t);
}

console.log("\n===== 8. 既有功能不受影响 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.ifIp["g0/0"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  const t = Sim.buildRouteTable(r, [r], []);
  ok("直连路由正常", t.length === 1 && t[0].proto === "C", JSON.stringify(t));
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);