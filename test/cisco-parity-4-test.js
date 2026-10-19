// 思科对标增强 批次4：NAT / 策略路由 / 二层环路检测
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

console.log("\n===== 1. NAT 配置 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "ip nat pool POOL1 203.0.113.10 203.0.113.20", "ip nat overload",
    "interface g0/0", "ip nat inside", "exit",
    "interface g0/1", "ip nat outside", "exit",
    "@priv", "show ip nat"
  ]);
  ok("NAT 已启用", r.nat.enabled === true);
  ok("地址池已创建", !!r.nat.pools["POOL1"], JSON.stringify(Object.keys(r.nat.pools)));
  ok("地址池范围", r.nat.pools["POOL1"].start === "203.0.113.10" && r.nat.pools["POOL1"].end === "203.0.113.20",
    JSON.stringify(r.nat.pools["POOL1"]));
  ok("overload 已开启", r.nat.overload === true);
  ok("inside 接口已标记", r.nat.inside.indexOf("g0/0") >= 0, JSON.stringify(r.nat.inside));
  ok("outside 接口已标记", r.nat.outside.indexOf("g0/1") >= 0, JSON.stringify(r.nat.outside));
  const t = out[out.length - 1].output;
  ok("show ip nat 含 inside 口", t.indexOf("g0/0") >= 0, t);
  ok("show ip nat 含 outside 口", t.indexOf("g0/1") >= 0, t);
  ok("show ip nat 含地址池", t.indexOf("POOL1") >= 0, t);
  ok("show ip nat 含转换方式", t.indexOf("overload") >= 0, t);
}
{
  // 非法地址池被拒
  const r = Sim.createDevice("router", "R2", 0, 0);
  const { out } = run(r, ["@global", "ip nat pool P 999.1.1.1 999.1.1.5"]);
  ok("非法地址池 IP 被拒", out[0].output.indexOf("IP 格式错误") >= 0, out[0].output);
}

console.log("\n===== 2. NAT 真实转换 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.nat.enabled = true;
  r.nat.pools["POOL1"] = { name: "POOL1", start: "203.0.113.10", end: "203.0.113.20" };
  r.nat.inside = ["g0/0"];
  r.nat.outside = ["g0/1"];
  const t1 = Sim.natTranslate(r, "192.168.1.10", 0, "g0/0", "8.8.8.8");
  ok("内网地址被转换为公网地址", t1 === "203.0.113.10", String(t1));
  const t2 = Sim.natTranslate(r, "192.168.1.11", 0, "g0/0", "8.8.8.8");
  ok("不同内网主机得到不同公网地址", t2 === "203.0.113.11", String(t2));
  const t3 = Sim.natTranslate(r, "192.168.1.10", 0, "g0/0", "8.8.8.8");
  ok("同一内网地址复用同一转换", t3 === "203.0.113.10", String(t3));
  const t4 = Sim.natTranslate(r, "192.168.1.10", 0, "g0/1", "8.8.8.8");
  ok("outside 口不做转换", t4 === null, String(t4));
  ok("转换表有记录", Object.keys(r.nat.translations).length >= 2, JSON.stringify(Object.keys(r.nat.translations)));
  const show = Sim.showNat(r);
  ok("show ip nat 列出转换表", show.indexOf("203.0.113.10") >= 0 && show.indexOf("192.168.1.10") >= 0, show);
}
{
  // 地址池耗尽
  const r = Sim.createDevice("router", "R2", 0, 0);
  r.nat.enabled = true;
  r.nat.pools["P"] = { name: "P", start: "203.0.113.1", end: "203.0.113.2" };
  r.nat.inside = ["g0/0"];
  Sim.natTranslate(r, "10.0.0.1", 0, "g0/0", "8.8.8.8");
  Sim.natTranslate(r, "10.0.0.2", 0, "g0/0", "8.8.8.8");
  const t3 = Sim.natTranslate(r, "10.0.0.3", 0, "g0/0", "8.8.8.8");
  ok("地址池耗尽返回 null", t3 === null, String(t3));
}
{
  // 关联 ACL 时只转换匹配流量
  const r = Sim.createDevice("router", "R3", 0, 0);
  r.nat.enabled = true;
  r.nat.pools["P"] = { name: "P", start: "203.0.113.1", end: "203.0.113.10" };
  r.nat.inside = ["g0/0"];
  r.nat.acl = "100";
  r.acl.lists["100"] = { id: "100", rules: [
    { seq: 10, action: "permit", proto: "ip", src: "192.168.1.0 0.0.0.255", dst: "any" }
  ] };
  const matched = Sim.natTranslate(r, "192.168.1.5", 0, "g0/0", "8.8.8.8");
  ok("匹配 ACL 的流量被转换", matched === "203.0.113.1", String(matched));
  const unmatched = Sim.natTranslate(r, "172.16.1.5", 0, "g0/0", "8.8.8.8");
  ok("不匹配 ACL 的流量不转换", unmatched === null, String(unmatched));
}

console.log("\n===== 3. 策略路由 route-map =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "route-map MYMAP permit 10",
    "match ip address 100",
    "set ip next-hop 10.0.0.2",
    "exit",
    "@priv", "show route-map"
  ]);
  ok("route-map 已创建", !!r.pbr.routeMaps["MYMAP"], JSON.stringify(Object.keys(r.pbr.routeMaps)));
  const cl = r.pbr.routeMaps["MYMAP"].clauses[0];
  ok("match 条件已记录", cl && cl.match === "ip address 100", JSON.stringify(cl));
  ok("set 动作已记录", cl && cl.set === "ip next-hop 10.0.0.2", JSON.stringify(cl));
  const t = out[out.length - 1].output;
  ok("show route-map 输出", t.indexOf("MYMAP") >= 0, t);
  ok("show route-map 含 match", t.indexOf("match") >= 0, t);
  ok("show route-map 含 set", t.indexOf("set") >= 0, t);
}
{
  const r = Sim.createDevice("router", "R2", 0, 0);
  const c = ctxOf(r); c.sess.mode = "priv";
  ok("未配置时提示", CLI.execLine(c, "show route-map").output.indexOf("未配置") >= 0);
}

console.log("\n===== 4. 二层环路检测 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "loop-detect enable", "loop-detect threshold 3",
    "@priv", "show loop-detect"
  ]);
  ok("环路检测已开启", sw.loopDetect.enabled === true);
  ok("阈值已设置", sw.loopDetect.threshold === 3, String(sw.loopDetect.threshold));
  const t = out[out.length - 1].output;
  ok("show loop-detect 输出", t.indexOf("enabled") >= 0, t);
}
{
  // MAC 漂移检测逻辑
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.loopDetect.enabled = true;
  sw.loopDetect.threshold = 3;
  ok("首次不告警", Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/1") === false);
  ok("同端口不告警", Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/1") === false);
  ok("第 1 次漂移不告警", Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/2") === false);
  ok("第 2 次漂移不告警", Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/3") === false);
  ok("第 3 次漂移告警", Sim.loopDetectFlap(sw, "AA:AA:AA:AA:AA:AA", "e1/0/4") === true);
  ok("告警已记录", sw.loopDetect.alerts.length === 1, JSON.stringify(sw.loopDetect.alerts));
  ok("告警内容含 MAC", sw.loopDetect.alerts[0].msg.indexOf("AA:AA:AA:AA:AA:AA") >= 0,
    sw.loopDetect.alerts[0].msg);
  const show = Sim.showLoopDetect(sw);
  ok("show loop-detect 列出告警", show.indexOf("疑似二层环路") >= 0, show);
}

console.log("\n===== 5. 缩写兼容 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  const { out } = run(r, [
    "@global", "ip nat pool P 203.0.113.1 203.0.113.5", "ip nat overload",
    "interface g0/0", "ip nat ins", "exit",
    "loop-detect enable",
    "@priv", "sh ip nat", "sh route-map", "sh loop-detect"
  ]);
  ok("缩写 ip nat pool", !!r.nat.pools["P"]);
  ok("缩写 ip nat ins", r.nat.inside.indexOf("g0/0") >= 0, JSON.stringify(r.nat.inside));
  ok("缩写 loop-detect enable", r.loopDetect.enabled === true);
  const shows = out.slice(-3).map(o => o.output);
  ok("3 条 show 缩写全部有效", shows.every(s => s && s.length > 0 &&
    s.indexOf("未知") < 0 && s.indexOf("歧义") < 0), JSON.stringify(shows.map(s => s.slice(0, 25))));
}

console.log("\n===== 6. TAB 候选 =====");
{
  const g = CLI.candidatesFor("global").map(x => x.raw);
  ok("global TAB 有 ip nat pool", g.some(x => x.indexOf("ip nat pool") === 0));
  ok("global TAB 有 ip nat overload", g.some(x => x.indexOf("ip nat overload") === 0));
  ok("global TAB 有 route-map", g.some(x => x.indexOf("route-map") === 0));
  ok("global TAB 有 loop-detect enable", g.some(x => x.indexOf("loop-detect enable") === 0));
  const p = CLI.candidatesFor("priv").map(x => x.raw);
  ok("priv TAB 有 show ip nat", p.indexOf("show ip nat") >= 0);
  ok("priv TAB 有 show route-map", p.indexOf("show route-map") >= 0);
  ok("priv TAB 有 show loop-detect", p.indexOf("show loop-detect") >= 0);
  const i = CLI.candidatesFor("if").map(x => x.raw);
  ok("if TAB 有 ip nat inside", i.some(x => x.indexOf("ip nat inside") === 0));
  ok("if TAB 有 ip nat outside", i.some(x => x.indexOf("ip nat outside") === 0));
}

console.log("\n===== 7. 既有功能不受影响 =====");
{
  const r = Sim.createDevice("router", "R1", 0, 0);
  r.ifIp["g0/0"] = { ip: "10.0.0.1", mask: "255.255.255.0" };
  r.staticRoutes = [{ dest: "0.0.0.0", mask: "0.0.0.0", nextHop: "10.0.0.2", dist: 1 }];
  const tbl = Sim.buildRouteTable(r, [r], []);
  ok("路由表不受 NAT 影响", tbl.some(x => x.proto === "C") && tbl.some(x => x.proto === "S*"),
    JSON.stringify(tbl.map(x => x.proto)));
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  const res = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("默认配置互通不受影响", res.ok === true, res.reason);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);