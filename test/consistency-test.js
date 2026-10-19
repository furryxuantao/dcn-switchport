// 组合与一致性测试：多个功能同时启用时是否互相干扰、状态是否自洽
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
function star(n, base) {
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const devices = [sw], links = [], pcs = [];
  for (let i = 0; i < n; i++) {
    const pc = Sim.createDevice("pc", "PC" + (i + 1), 0, 0);
    pc.pcIp = (base || "192.168.1.") + (11 + i);
    pc.pcMask = "255.255.255.0";
    pcs.push(pc); devices.push(pc);
    links.push({ id: "l" + i, kind: "copper", a: { dev: sw.id, port: "e1/0/" + (i + 1) }, b: { dev: pc.id, port: "eth0" } });
  }
  return { sw: sw, devices: devices, links: links, pcs: pcs };
}

console.log("\n===== 1. 安全特性组合：ACL + 隔离 + DAI 同时启用 =====");
{
  const { sw, devices, links, pcs } = star(3);
  run(sw, ["@global", "ip access-list extended 100",
    "seq 10 deny ip 192.168.1.0 0.0.0.255 10.0.0.0 0.0.0.255",
    "seq 20 permit ip any any", "exit"], devices, links);
  run(sw, ["@global", "interface e1/0/1-2", "switchport isolate group 1", "exit"], devices, links);
  sw.dhcpSnooping.enabled = true;
  sw.arpInspection.enabled = true;
  sw.arpInspection.perVlan["1"] = "enabled";
  // 先建立绑定
  Sim.simulatePing(devices, links, pcs[0], pcs[2].pcIp);
  ok("绑定已建立", Object.keys(sw.dhcpSnooping.bindings).length >= 1,
    JSON.stringify(Object.keys(sw.dhcpSnooping.bindings)));
  // 隔离口互访应被阻断
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("隔离优先阻断", r.ok === false, r.reason);
  ok("原因提到隔离", r.reason.indexOf("隔离") >= 0, r.reason);
  // 正常口互通
  const r2 = Sim.simulatePing(devices, links, pcs[0], pcs[2].pcIp);
  ok("非隔离口仍通", r2.ok === true, r2.reason);
}

console.log("\n===== 2. ACL 优先级：先命中先生效 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.acl.lists["1"] = { id: "1", rules: [
    { seq: 10, action: "permit", proto: "ip", src: "192.168.1.0 0.0.0.255", dst: "any" },
    { seq: 20, action: "deny", proto: "ip", src: "any", dst: "any" }
  ] };
  sw.acl.applied = { global: "1" };
  ok("seq 10 的 permit 优先", Sim.aclDecide(sw, { srcIp: "192.168.1.5", dstIp: "1.1.1.1" }) === "permit");
  // seq 倒序定义仍按 seq 排序
  sw.acl.lists["2"] = { id: "2", rules: [
    { seq: 30, action: "deny", proto: "ip", src: "any", dst: "any" },
    { seq: 5, action: "permit", proto: "ip", src: "any", dst: "any" }
  ] };
  sw.acl.applied = { global: "2" };
  ok("按 seq 排序而非定义顺序", Sim.aclDecide(sw, { srcIp: "8.8.8.8", dstIp: "1.1.1.1" }) === "permit");
  // 同 seq 覆盖
  const c = ctxOf(sw); c.sess.mode = "global";
  CLI.execLine(c, "ip access-list extended 2");
  CLI.execLine(c, "seq 5 deny ip any any");
  ok("同 seq 被覆盖", sw.acl.lists["2"].rules.filter(r => r.seq === 5).length === 1,
    JSON.stringify(sw.acl.lists["2"].rules.map(r => r.seq)));
  ok("覆盖后动作更新", sw.acl.lists["2"].rules.find(r => r.seq === 5).action === "deny");
}

console.log("\n===== 3. 端口隔离 + ACL 应用到同一端口 =====");
{
  const { sw, devices, links, pcs } = star(2);
  run(sw, ["@global", "ip access-list extended 100",
    "seq 10 permit ip any any", "exit"], devices, links);
  run(sw, ["@global", "interface e1/0/1", "ip access-group 100 in", "exit"], devices, links);
  ok("ACL 已应用", sw.acl.applied.port["e1/0/1"] === "100");
  sw.ports["e1/0/1"].isolateGroup = 1;
  sw.ports["e1/0/2"].isolateGroup = 1;
  const r = Sim.simulatePing(devices, links, pcs[0], pcs[1].pcIp);
  ok("两者同时启用不冲突，仍正确阻断", r.ok === false, r.reason);
  const rc = Sim.showRunningConfig(sw);
  ok("running-config 同时回显两者", rc.indexOf("ip access-group 100 in") >= 0 && rc.indexOf("switchport isolate group 1") >= 0, rc);
}

console.log("\n===== 4. VRRP + 静态路由 + 三层互通 =====");
{
  const sw1 = Sim.createDevice("l3", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l3", "SW2", 0, 0);
  const pc = Sim.createDevice("pc", "PC1", 0, 0);
  pc.pcIp = "192.168.1.100"; pc.pcMask = "255.255.255.0"; pc.pcGw = "192.168.1.254";
  sw1.vlanIf["10"] = { ip: "192.168.1.2", mask: "255.255.255.0" };
  sw2.vlanIf["10"] = { ip: "192.168.1.3", mask: "255.255.255.0" };
  sw1.vrrp.groups["1"] = { vrid: 1, ip: "192.168.1.254", priority: 120, hold: 3, advert: 1, interface: "vlan10" };
  sw2.vrrp.groups["1"] = { vrid: 1, ip: "192.168.1.254", priority: 100, hold: 3, advert: 1, interface: "vlan10" };
  const devices = [sw1, sw2, pc];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } }
  ];
  const m = Sim.vrrpElect(devices, links, 1);
  ok("SW1 当选 Master", m && m.dev === sw1, m ? m.dev.hostname : "null");
  const vi = Sim.vrrpVirtualIp(devices, links, 1);
  ok("虚 IP 正确", vi && vi.ip === "192.168.1.254", JSON.stringify(vi));
  ok("Master 是 SW1", vi && vi.master === sw1);
  const show = Sim.showVrrp(sw1, devices, links);
  ok("show vrrp 含 Master 信息", show.indexOf("Master") >= 0, show);
}

console.log("\n===== 5. DHCP 池与 VLAN 配合 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  run(sw, ["@global", "service dhcp", "ip dhcp pool v10",
    "network 192.168.10.0 255.255.255.0", "default-router 192.168.10.254",
    "vlan 10", "lease 3600", "exit"]);
  const p = sw.dhcp.pools["v10"];
  ok("池关联 vlan 10", p.vlan === 10, String(p.vlan));
  ok("租期 3600", p.lease === 3600, String(p.lease));
  const a = Sim.dhcpAllocate(sw, "AA:AA:AA:AA:AA:AA");
  // 未配 range 时默认用整个网段：.0 是网络地址、.255 是广播地址，都不可分配
  ok("分配成功且跳过网络地址", a && a.ip === "192.168.10.1", JSON.stringify(a));
  // 广播地址不可分配
  const sw2 = Sim.createDevice("l3", "SW2", 0, 0);
  run(sw2, ["@global", "service dhcp", "ip dhcp pool tiny",
    "network 10.9.9.0 255.255.255.252", "exit"]);
  const alloc = [];
  for (let i = 0; i < 6; i++) {
    const r = Sim.dhcpAllocate(sw2, "AA:00:00:00:00:" + String(i).padStart(2, "0"));
    alloc.push(r ? r.ip : null);
  }
  ok("不分配网络地址 .0", alloc[0] !== "10.9.9.0" && alloc[0] !== null, JSON.stringify(alloc));
  ok("不分配广播地址 .3", alloc.indexOf("10.9.9.3") < 0, JSON.stringify(alloc));
  ok("可用地址用尽后返回 null", alloc.slice(2).every(x => x === null), JSON.stringify(alloc));
  ok("绑定记录池名", a && a.pool === "v10", a ? a.pool : "");
  ok("绑定记录租期", a && a.lease === 3600, a ? String(a.lease) : "");
}

console.log("\n===== 6. running-config 与 show 一致性 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, [
    "@global", "ip access-list extended 100", "seq 10 permit ip any any", "exit",
    "interface e1/0/1", "switchport isolate group 2", "switchport priority 5", "exit",
    "mac-address static 00-11-22-33-44-55 interface e1/0/2",
    "mac-address aging-time 900", "mac-address maximum 512"
  ]);
  const rc = Sim.showRunningConfig(sw);
  const aclShow = Sim.showAcl(sw);
  ok("ACL 规则同时出现在两处", rc.indexOf("permit ip any any") >= 0 && aclShow.indexOf("permit") >= 0);
  ok("隔离组一致", rc.indexOf("switchport isolate group 2") >= 0 &&
    Sim.showPortIsolate(sw).indexOf("Group 2") >= 0);
  ok("MAC 上限一致", rc.indexOf("mac-address maximum 512") >= 0);
  ok("老化时间一致", rc.indexOf("mac-address aging-time 900") >= 0);
  const aging = Sim.showMacAging(sw);
  ok("show mac aging 数值一致", aging.indexOf("900") >= 0 && aging.indexOf("512") >= 0, aging);
}

console.log("\n===== 7. 命令不残留状态（连续执行不同命令） =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw);
  c.sess.mode = "global";
  CLI.execLine(c, "ip access-list extended 100");
  CLI.execLine(c, "permit ip any any");
  const inAcl = c.sess.mode;
  CLI.execLine(c, "exit");
  ok("退出 ACL 后模式为 global", c.sess.mode === "global", c.sess.mode);
  // 再进别的模式，确认不串
  CLI.execLine(c, "ip dhcp pool p");
  ok("可进入 DHCP 池模式", c.sess.mode === "dhcp-pool", c.sess.mode);
  CLI.execLine(c, "exit");
  ok("退出后回 global", c.sess.mode === "global", c.sess.mode);
  CLI.execLine(c, "interface e1/0/1");
  ok("可进入接口模式", c.sess.mode === "if", c.sess.mode);
  ok("接口模式不残留 aclId", c.sess.aclId === undefined || c.sess.aclId === null, String(c.sess.aclId));
  ok("接口模式不残留 dhcpPool", c.sess.dhcpPool === undefined || c.sess.dhcpPool === null, String(c.sess.dhcpPool));
}

console.log("\n===== 8. 极端配置不崩 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw);
  c.sess.mode = "global";
  // 超长规则
  CLI.execLine(c, "ip access-list extended 100");
  CLI.execLine(c, "seq 999999 permit ip 1.1.1.1 255.255.255.255 2.2.2.2 255.255.255.255 log");
  ok("超大 seq 不崩", !!sw.acl.lists["100"]);
  CLI.execLine(c, "seq 10 permit tcp any any eq 0");
  ok("eq 0 不崩", !!sw.acl.lists["100"]);
  CLI.execLine(c, "seq 20 permit tcp any any gt 65535");
  ok("gt 超范围不崩", !!sw.acl.lists["100"]);
  CLI.execLine(c, "seq 30 permit ip 1.1.1.1 2.2.2.2 3.3.3.3 4.4.4.4");
  ok("IP 当通配符不崩", !!sw.acl.lists["100"]);
  const show = Sim.showAcl(sw);
  ok("show 不崩且有内容", typeof show === "string" && show.length > 0);
  // VRRP 极端值
  const c2 = ctxOf(sw);
  c2.sess.mode = "if";
  c2.sess.ifPorts = ["e1/0/1"];
  CLI.execLine(c2, "vrrp 99999 ip 1.1.1.1");
  ok("超大 vrid 不崩", !!sw.vrrp.groups["99999"]);
  CLI.execLine(c2, "vrrp 1 priority 999");
  ok("超大 priority 不崩", sw.vrrp.groups["1"].priority === 999);
  CLI.execLine(c2, "vrrp 2 ip 999.999.999.999");
  ok("非法虚 IP 不崩", true);
}

console.log("\n===== 9. 全部 show 命令的输出健壮性 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const shows = ["sh run", "sh vlan", "sh mac", "sh ip int br", "sh ip ro", "sh span",
    "sh por gr", "sh mon", "sh port-sec", "sh dhcp s", "sh igm s", "sh arp i",
    "sh port-is", "sh qos p", "sh loop-g", "sh mac-address s", "sh mac a",
    "sh lldp", "sh snmp", "sh access-l", "sh vrrp", "sh ip dhcp pool", "sh ip dhcp binding"];
  let bad = [];
  for (const cmd of shows) {
    let r;
    try { r = CLI.execLine(c, cmd); }
    catch (e) { bad.push(cmd + "(抛异常:" + e.message + ")"); continue; }
    const o = r.output || "";
    if (typeof r.output !== "string") bad.push(cmd + "(非字符串)");
    if (/undefined|NaN|\[object/.test(o)) bad.push(cmd + "(" + o.slice(0, 40) + ")");
    if (!r.prompt) bad.push(cmd + "(无提示符)");
  }
  ok("24 条 show 全部健壮", bad.length === 0, JSON.stringify(bad));
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);