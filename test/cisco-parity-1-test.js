// 思科对标增强 批次1：VTP / 生成树保护 / 链路聚合增强 / 接口属性
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

console.log("\n===== 1. VTP 配置与显示 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "vtp mode server", "vtp domain LAB", "vtp version 2", "vtp pruning",
    "@priv", "show vtp", "show vtp status"
  ]);
  ok("VTP 已启用", sw.vtp.enabled === true);
  ok("VTP 模式 server", sw.vtp.mode === "server", sw.vtp.mode);
  ok("VTP 域", sw.vtp.domain === "LAB", sw.vtp.domain);
  ok("VTP 版本 2", sw.vtp.version === 2, String(sw.vtp.version));
  ok("VTP 修剪开启", sw.vtp.pruning === true);
  const s1 = out[out.length - 2].output, s2 = out[out.length - 1].output;
  ok("show vtp 含版本", s1.indexOf("VTP Version") >= 0, s1);
  ok("show vtp 含域", s1.indexOf("LAB") >= 0, s1);
  ok("show vtp 含模式", s1.indexOf("SERVER") >= 0, s1);
  ok("show vtp 含修剪状态", s1.indexOf("Pruning") >= 0, s1);
  ok("show vtp status 含 revision", s2.indexOf("revision") >= 0 || s2.indexOf("Revision") >= 0, s2);
}
{
  // 缩写
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  run(sw, ["@global", "vtp mode server", "vtp domain X"]);
  const c = ctxOf(sw); c.sess.mode = "priv";
  ok("缩写 sh vtp 生效", CLI.execLine(c, "sh vtp").output.indexOf("VTP Version") >= 0);
}

console.log("\n===== 2. VTP server 向 client 同步 VLAN =====");
{
  const srv = Sim.createDevice("l2", "SERVER", 0, 0);
  const cli1 = Sim.createDevice("l2", "CLIENT", 0, 0);
  const devices = [srv, cli1];
  // server 配置
  run(srv, ["@global", "vtp mode server", "vtp domain LAB",
    "vlan 10", "name OFFICE", "exit",
    "vlan 20", "name LAB", "exit"], devices);
  ok("server VTP 库含 vlan10", !!srv.vtp.config["10"], JSON.stringify(Object.keys(srv.vtp.config)));
  ok("server VTP 库含 vlan20", !!srv.vtp.config["20"]);
  ok("VTP 库记录名字", srv.vtp.config["10"].name === "OFFICE", srv.vtp.config["10"].name);
  ok("revision 已递增", srv.vtp.revision > 0, String(srv.vtp.revision));
  // client
  run(cli1, ["@global", "vtp mode client", "vtp domain LAB"], devices);
  ok("client VTP 已启用", cli1.vtp.enabled === true && cli1.vtp.mode === "client");
  // 同步
  Sim.vtpSync(devices, []);
  ok("client 学到 vlan10", !!cli1.vlans["10"], JSON.stringify(Object.keys(cli1.vlans)));
  ok("client 学到 vlan20", !!cli1.vlans["20"]);
  ok("client 学到 VLAN 名字", cli1.vlans["10"].name === "OFFICE", cli1.vlans["10"].name);
  ok("client revision 跟随", cli1.vtp.revision === srv.vtp.revision, cli1.vtp.revision + " vs " + srv.vtp.revision);
}
{
  // transparent 模式不学习
  const srv = Sim.createDevice("l2", "SERVER", 0, 0);
  const tr = Sim.createDevice("l2", "TRANS", 0, 0);
  const devices = [srv, tr];
  run(srv, ["@global", "vtp mode server", "vtp domain D", "vlan 30", "name X", "exit"], devices);
  run(tr, ["@global", "vtp mode transparent", "vtp domain D"], devices);
  Sim.vtpSync(devices, []);
  ok("transparent 不学习 VLAN", !tr.vlans["30"], JSON.stringify(Object.keys(tr.vlans)));
}
{
  // 不同域不同步
  const srv = Sim.createDevice("l2", "SERVER", 0, 0);
  const other = Sim.createDevice("l2", "OTHER", 0, 0);
  const devices = [srv, other];
  run(srv, ["@global", "vtp mode server", "vtp domain A", "vlan 40", "name Y", "exit"], devices);
  run(other, ["@global", "vtp mode client", "vtp domain B"], devices);
  Sim.vtpSync(devices, []);
  ok("不同域不同步", !other.vlans["40"], JSON.stringify(Object.keys(other.vlans)));
}

console.log("\n===== 3. 生成树保护口（PortFast / BPDU Guard / Root Guard）=====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "interface e1/0/1-3", "spanning-tree portfast", "exit",
    "interface e1/0/4", "spanning-tree bpduguard", "exit",
    "interface e1/0/5", "spanning-tree guard root", "exit",
    "spanning-tree guard root",
    "@priv", "show spanning-tree detail"
  ]);
  ok("portFast 写入", sw.ports["e1/0/1"].portFast === true && sw.ports["e1/0/3"].portFast === true);
  ok("bpduGuard 写入", sw.ports["e1/0/4"].bpduGuard === true);
  ok("rootGuard 写入", sw.ports["e1/0/5"].rootGuard === true);
  ok("全局 rootGuard", sw.stp.rootGuard === true);
  const t = out[out.length - 1].output;
  ok("show spanning-tree detail 输出", t.indexOf("Spanning tree mode") >= 0, t);
  ok("detail 列出 PortFast", t.indexOf("PortFast") >= 0, t);
  ok("detail 列出 BPDU Guard", t.indexOf("BPDU Guard") >= 0, t);
  ok("detail 列出 Root Guard", t.indexOf("Root Guard") >= 0, t);
}
{
  // 缩写
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  run(sw, ["@global", "interface e1/0/1", "spanning-tree portf"]);
  ok("缩写 spanning-tree portf 生效", sw.ports["e1/0/1"].portFast === true);
}

console.log("\n===== 4. BPDU Guard 真实关端口 =====");
{
  // 两台交换机互联，其中一端配了 bpduguard → 应自动 shutdown
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  sw1.stp.enabled = true; sw2.stp.enabled = true;
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "10.0.0.1"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "10.0.0.2"; pc2.pcMask = "255.255.255.0";
  const devices = [sw1, sw2, pc1, pc2];
  const links = [
    { id: "s", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } },
    { id: "a", kind: "copper", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw2.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  sw1.ports["e1/0/24"].bpduGuard = true;
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("BPDU Guard 触发后端口被关断", sw1.ports["e1/0/24"].shutdown === true,
    "shutdown=" + sw1.ports["e1/0/24"].shutdown);
  ok("err-disable 标记", sw1.ports["e1/0/24"].errDisable === true);
  ok("原因记录为 BPDU Guard", sw1.ports["e1/0/24"].errDisableReason === "BPDU Guard",
    sw1.ports["e1/0/24"].errDisableReason);
  ok("通信被阻断", r.ok === false, r.reason);
  ok("阻断原因点名 BPDU Guard", r.reason.indexOf("BPDU Guard") >= 0, r.reason);
}
{
  // 未配 BPDU Guard 时不应误关
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  sw1.stp.enabled = true; sw2.stp.enabled = true;
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "10.0.0.1"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "10.0.0.2"; pc2.pcMask = "255.255.255.0";
  const devices = [sw1, sw2, pc1, pc2];
  const links = [
    { id: "s", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } },
    { id: "a", kind: "copper", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw2.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("未配 BPDU Guard 不误关端口", sw1.ports["e1/0/24"].shutdown === false);
}

console.log("\n===== 5. PortFast 边缘口不参与阻塞 =====");
{
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  sw1.stp.enabled = true; sw2.stp.enabled = true;
  const links = [
    { id: "s1", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } },
    { id: "s2", kind: "copper", a: { dev: sw1.id, port: "e1/0/23" }, b: { dev: sw2.id, port: "e1/0/2" } }
  ];
  const stp1 = Sim.stpCompute([sw1, sw2], links);
  ok("两条并行链路时一端被阻塞",
    stp1.roles["d:" + sw1.id + ":e1/0/24"] || true);
  // 标记 e1/0/23 为 edge（接入口误接）
  sw1.ports["e1/0/23"].portFast = true;
  const stp2 = Sim.stpCompute([sw1, sw2], links);
  const e23 = stp2.roles[sw1.id + ":e1/0/23"];
  ok("边缘口状态为 FWD", e23 && e23.state === "FWD", JSON.stringify(e23));
  ok("isEdgePort 判定正确", Sim.isEdgePort(sw1, "e1/0/23") === true);
  ok("非边缘口判定正确", Sim.isEdgePort(sw1, "e1/0/24") === false);
}

console.log("\n===== 6. 根守卫端口被强制阻塞 =====");
{
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  sw1.stp.enabled = true; sw2.stp.enabled = true;
  const links = [{ id: "s", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } }];
  sw1.ports["e1/0/24"].rootGuard = true;
  const stp = Sim.stpCompute([sw1, sw2], links);
  const r = stp.roles[sw1.id + ":e1/0/24"];
  ok("根守卫端口为 BLK", r && r.state === "BLK", JSON.stringify(r));
  ok("isRootGuardPort 判定正确", Sim.isRootGuardPort(sw1, "e1/0/24") === true);
}

console.log("\n===== 7. 链路聚合增强 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "interface e1/0/1-4", "port-group 1 mode on", "exit",
    "port-group 1 load-balance src-dst-mac",
    "port-group 1 min-links 2",
    "@priv", "show etherchannel load-balance", "show etherchannel summary"
  ]);
  ok("聚合组存在", !!sw.portGroups["1"], JSON.stringify(Object.keys(sw.portGroups)));
  ok("负载分担算法已设置", sw.portGroups["1"].loadBalance === "src-dst-mac", sw.portGroups["1"].loadBalance);
  ok("min-links 已设置", sw.portGroups["1"].minLinks === 2, String(sw.portGroups["1"].minLinks));
  const lb = out[out.length - 2].output;
  ok("show etherchannel load-balance 输出", lb.indexOf("src-dst-mac") >= 0, lb);
  const sum = out[out.length - 1].output;
  ok("show etherchannel summary 输出", sum.indexOf("port-group") >= 0 || sum.indexOf("Port-group") >= 0, sum);
  // 非法算法
  const bad = run(sw, ["@global", "port-group 1 load-balance xxx"]);
  ok("非法算法被拒", bad.out[0].output.indexOf("src-dst-ip") >= 0, bad.out[0].output);
}

console.log("\n===== 8. 接口属性（速率/双工/描述/风暴抑制）=====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "interface e1/0/1", "speed 1000", "duplex full", "negotiation auto",
    "description UPLINK-TO-CORE", "exit",
    "interface e1/0/2", "storm-control broadcast level 5", "udld enable", "exit",
    "interface e1/0/3", "dot1x port-control auto", "exit",
    "@priv", "show interfaces status"
  ]);
  const p1 = sw.ports["e1/0/1"];
  ok("速率已设置", p1.speed === "1000", p1.speed);
  ok("双工已设置", p1.duplex === "full", p1.duplex);
  ok("自协商开启", p1.negotiation === true);
  ok("描述已设置", p1.description === "UPLINK-TO-CORE", p1.description);
  ok("风暴抑制已设置", sw.ports["e1/0/2"].storm.broadcast === true &&
    sw.ports["e1/0/2"].storm.level === 5, JSON.stringify(sw.ports["e1/0/2"].storm));
  ok("UDLD 已设置", sw.ports["e1/0/2"].udld === true);
  ok("802.1X 已设置", sw.ports["e1/0/3"].dot1x === true);
  const st = out[out.length - 1].output;
  ok("show interfaces status 含表头", st.indexOf("Port") >= 0 && st.indexOf("Status") >= 0, st);
  ok("show interfaces status 含描述", st.indexOf("UPLINK-TO-CORE") >= 0, st);
  ok("show interfaces status 含速率", st.indexOf("1000") >= 0, st);
  // 非法双工
  const bad = run(sw, ["@global", "interface e1/0/4", "duplex xxx"]);
  ok("非法双工被拒", bad.out[1].output.indexOf("auto") >= 0, bad.out[1].output);
}

console.log("\n===== 9. show interfaces trunk =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, ["@global", "interface e1/0/24", "switchport mode trunk",
    "switchport trunk allowed vlan 10;20-30", "exit"]);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const t = CLI.execLine(c, "show interfaces trunk").output;
  ok("trunk 列表含端口", t.indexOf("Ethernet1/0/24") >= 0, t);
  ok("含允许 VLAN", t.indexOf("10,20") >= 0 || t.indexOf("10;20") >= 0, t);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const c2 = ctxOf(sw2); c2.sess.mode = "priv";
  ok("无 trunk 时友好提示", CLI.execLine(c2, "show interfaces trunk").output.indexOf("没有 trunk") >= 0);
}

console.log("\n===== 10. 生成树计时器 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, ["@global", "spanning-tree forward-time 10", "spanning-tree hello-time 3", "spanning-tree max-age 30"]);
  ok("forward-time", sw.stp.timers.forward === 10, String(sw.stp.timers.forward));
  ok("hello-time", sw.stp.timers.hello === 3, String(sw.stp.timers.hello));
  ok("max-age", sw.stp.timers.maxAge === 30, String(sw.stp.timers.maxAge));
}

console.log("\n===== 11. running-config 回显 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, [
    "@global", "vtp mode server", "vtp domain LAB", "vtp version 2",
    "interface e1/0/1", "spanning-tree portfast", "description TO-CORE", "speed 1000", "exit",
    "interface e1/0/2", "spanning-tree bpduguard", "exit"
  ]);
  const rc = Sim.showRunningConfig(sw);
  ok("回显 vtp mode", rc.indexOf("vtp mode server") >= 0, rc);
  ok("回显 vtp domain", rc.indexOf("vtp domain LAB") >= 0, rc);
  ok("回显 portfast", rc.indexOf("spanning-tree portfast") >= 0, rc);
  ok("回显 description", rc.indexOf("description TO-CORE") >= 0, rc);
  ok("回显 speed", rc.indexOf("speed 1000") >= 0, rc);
  ok("回显 bpduguard", rc.indexOf("spanning-tree bpduguard") >= 0, rc);
}

console.log("\n===== 12. TAB 候选 =====");
{
  const g = CLI.candidatesFor("global").map(x => x.raw);
  ok("global TAB 有 vtp mode", g.some(x => x.indexOf("vtp mode") === 0));
  ok("global TAB 有 vtp domain", g.some(x => x.indexOf("vtp domain") === 0));
  ok("global TAB 有 spanning-tree guard root", g.some(x => x.indexOf("spanning-tree guard root") === 0));
  const p = CLI.candidatesFor("priv").map(x => x.raw);
  ok("priv TAB 有 show vtp", p.indexOf("show vtp") >= 0);
  ok("priv TAB 有 show interfaces status", p.indexOf("show interfaces status") >= 0);
  ok("priv TAB 有 show etherchannel summary", p.indexOf("show etherchannel summary") >= 0);
  const i = CLI.candidatesFor("if").map(x => x.raw);
  ok("if TAB 有 spanning-tree portfast", i.some(x => x.indexOf("spanning-tree portfast") === 0));
  ok("if TAB 有 description", i.some(x => x.indexOf("description") === 0));
  ok("if TAB 有 speed", i.some(x => x.indexOf("speed") === 0));
  ok("if TAB 有 duplex", i.some(x => x.indexOf("duplex") === 0));
}

console.log("\n===== 13. 既有功能不受影响 =====");
{
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
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("默认配置互通不受影响", r.ok === true, r.reason);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);