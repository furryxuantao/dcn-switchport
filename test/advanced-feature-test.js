// ACL / VRRP / DHCP 服务器 测试：验证配置、显示与运行时行为
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

console.log("\n===== 1. ACL 配置与显示 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "ip access-list extended 100",
    "remark 禁止访问服务器网段",
    "seq 10 deny ip 192.168.1.0 0.0.0.255 10.0.0.0 0.0.0.255",
    "seq 20 permit ip any any",
    "exit", "@priv", "show access-lists"
  ]);
  const lst = sw.acl.lists["100"];
  ok("ACL 已创建", !!lst, JSON.stringify(Object.keys(sw.acl.lists)));
  ok("remark 记录", lst.name === "禁止访问服务器网段", lst.name);
  ok("两条规则", lst.rules.length === 2, JSON.stringify(lst.rules.length));
  ok("deny 规则正确", lst.rules[0].action === "deny" && lst.rules[0].src === "192.168.1.0 0.0.0.255",
    JSON.stringify(lst.rules[0]));
  ok("permit 规则正确", lst.rules[1].action === "permit" && lst.rules[1].src === "any", JSON.stringify(lst.rules[1]));
  const show = out[out.length - 1].output;
  ok("show 显示 ACL 编号", show.indexOf("ACL 100") >= 0, show);
  ok("show 显示规则", show.indexOf("deny") >= 0 && show.indexOf("permit") >= 0, show);
  ok("show 显示 remark", show.indexOf("禁止访问") >= 0, show);
}
{
  // 缩写
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  run(sw, ["@global", "ip access-list extended 100", "permit ip any any", "exit", "@priv", "sh access-l"]);
  ok("缩写 ip access-list 生效", !!sw.acl.lists["100"], JSON.stringify(Object.keys(sw.acl.lists)));
  const c = ctxOf(sw); c.sess.mode = "priv";
  ok("缩写 sh access-l 输出", CLI.execLine(c, "sh access-l").output.indexOf("ACL 100") >= 0);
}
{
  // 编号越界
  const sw = Sim.createDevice("l2", "SW3", 0, 0);
  const { out } = run(sw, ["@global", "ip access-list extended 0"]);
  ok("ACL 编号 0 被拒", out[0].output.indexOf("1-1999") >= 0, out[0].output);
  const { out: o2 } = run(sw, ["@global", "ip access-list extended 5000"]);
  ok("ACL 编号 5000 被拒", o2[0].output.indexOf("1-1999") >= 0, o2[0].output);
}

console.log("\n===== 2. ACL 真实阻断流量 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "10.0.0.22"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  let r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("未配 ACL 时互通", r.ok === true, r.reason);
  // 配置 ACL 并应用到入口
  run(sw, ["@global", "ip access-list extended 100",
    "seq 10 deny ip 192.168.1.0 0.0.0.255 10.0.0.0 0.0.0.255",
    "seq 20 permit ip any any", "exit"], devices, links);
  run(sw, ["@global", "interface e1/0/1", "ip access-group 100 in", "exit"], devices, links);
  ok("ACL 已应用到端口", sw.acl.applied.port["e1/0/1"] === "100", JSON.stringify(sw.acl.applied));
  r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("命中 deny 后被阻断", r.ok === false, "未被阻断 - ACL 未生效");
  ok("阻断原因点名 ACL", r.reason.indexOf("ACL") >= 0, r.reason);
  // 换源网段 → permit 放行
  const pc3 = Sim.createDevice("pc", "PC3", 0, 0);
  pc3.pcIp = "172.16.1.11"; pc3.pcMask = "255.255.255.0";
  devices.push(pc3);
  links.push({ id: "l3", kind: "copper", a: { dev: sw.id, port: "e1/0/3" }, b: { dev: pc3.id, port: "eth0" } });
  const r2 = Sim.simulatePing(devices, links, pc3, pc2.pcIp);
  ok("不匹配 deny 的源被 permit 放行", r2.ok === true, r2.reason);
}
{
  // 只配 deny（无 permit any）时，未匹配流量的行为
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "10.0.0.22"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  run(sw, ["@global", "ip access-list extended 100",
    "seq 10 deny ip 192.168.1.0 0.0.0.255 10.0.0.0 0.0.0.255", "exit"], devices, links);
  run(sw, ["@global", "interface e1/0/1", "ip access-group 100 in", "exit"], devices, links);
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("仅 deny 规则时目标被阻断", r.ok === false, r.reason);
  const pc3 = Sim.createDevice("pc", "PC3", 0, 0);
  pc3.pcIp = "172.16.1.11"; pc3.pcMask = "255.255.255.0";
  devices.push(pc3);
  links.push({ id: "l3", kind: "copper", a: { dev: sw.id, port: "e1/0/3" }, b: { dev: pc3.id, port: "eth0" } });
  const r2 = Sim.simulatePing(devices, links, pc3, pc2.pcIp);
  ok("未命中任何规则的流量放行（真机默认放行）", r2.ok === true, r2.reason);
}
{
  // 匹配引擎单元测试
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  sw.acl.lists["1"] = { id: "1", rules: [
    { seq: 10, action: "permit", proto: "ip", src: "192.168.1.0 0.0.0.255", dst: "10.0.0.0 0.0.0.255" },
    { seq: 20, action: "deny", proto: "ip", src: "any", dst: "any" }
  ] };
  // 未应用时 ACL 不参与裁决
  ok("未应用时返回 null", Sim.aclDecide(sw, { srcIp: "192.168.1.5", dstIp: "10.0.0.1" }) === null);
  sw.acl.applied = { global: "1" };
  ok("全局应用后同网段命中 permit", Sim.aclDecide(sw, { srcIp: "192.168.1.5", dstIp: "10.0.0.1" }) === "permit");
  ok("全局应用后不同网段命中 deny", Sim.aclDecide(sw, { srcIp: "172.16.1.5", dstIp: "10.0.0.1" }) === "deny");
  ok("无规则时不匹配 null", Sim.aclIpMatch("any", "1.1.1.1") === true);
  ok("掩码匹配", Sim.aclIpMatch("192.168.1.0 0.0.0.255", "192.168.1.99") === true);
  ok("掩码不匹配", Sim.aclIpMatch("192.168.1.0 0.0.0.255", "192.168.2.99") === false);
  ok("非法 IP 不匹配", Sim.aclIpMatch("192.168.1.0 0.0.0.255", "not-an-ip") === false);
}

console.log("\n===== 3. VRRP =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "interface vlan 10",
    "ip address 192.168.1.2 255.255.255.0",
    "vrrp 1 ip 192.168.1.254",
    "vrrp 1 priority 120",
    "exit", "@priv", "show vrrp"
  ]);
  const g = sw.vrrp.groups["1"];
  ok("VRRP 组已创建", !!g, JSON.stringify(sw.vrrp.groups));
  ok("虚 IP 正确", g.ip === "192.168.1.254", g.ip);
  ok("优先级正确", g.priority === 120, String(g.priority));
  ok("接口已记录", g.interface === "vlan10", g.interface);
  const show = out[out.length - 1].output;
  ok("show vrrp 输出组号", show.indexOf("VRRP Group 1") >= 0, show);
  ok("show vrrp 输出虚IP", show.indexOf("192.168.1.254") >= 0, show);
  ok("show vrrp 输出优先级", show.indexOf("120") >= 0, show);
}
{
  // 选举：priority 大者为主
  const sw1 = Sim.createDevice("l3", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l3", "SW2", 0, 0);
  [sw1, sw2].forEach(d => { d.vlanIf["10"] = { ip: "192.168.1.2", mask: "255.255.255.0" }; });
  sw1.vrrp.groups["1"] = { vrid: 1, ip: "192.168.1.254", priority: 120, hold: 3, advert: 1, interface: "vlan10" };
  sw2.vrrp.groups["1"] = { vrid: 1, ip: "192.168.1.254", priority: 100, hold: 3, advert: 1, interface: "vlan10" };
  const m = Sim.vrrpElect([sw1, sw2], [], 1);
  ok("priority 高的当选 Master", m && m.dev === sw1, m ? m.dev.hostname : "null");
  // 同优先级按 IP 大者
  sw2.vrrp.groups["1"].priority = 120;
  sw2.vlanIf["10"] = { ip: "192.168.1.9", mask: "255.255.255.0" };
  const m2 = Sim.vrrpElect([sw1, sw2], [], 1);
  ok("同优先级 IP 大者当选", m2 && m2.dev === sw2, m2 ? m2.dev.hostname : "null");
  // 无组时不崩
  ok("无 VRRP 组不崩", Sim.vrrpElect([sw1], [], 9) === null);
  ok("vrrpVirtualIp 无组返回 null", Sim.vrrpVirtualIp([sw1], [], 9) === null);
  const vi = Sim.vrrpVirtualIp([sw1, sw2], [], 1);
  ok("vrrpVirtualIp 返回虚IP", vi && vi.ip === "192.168.1.254", JSON.stringify(vi));
}

console.log("\n===== 4. DHCP 服务器 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "service dhcp",
    "ip dhcp pool office",
    "network 192.168.10.0 255.255.255.0",
    "default-router 192.168.10.254",
    "dns-server 8.8.8.8",
    "lease 7200",
    "range 192.168.10.100 192.168.10.200",
    "exit",
    "ip dhcp excluded-address 192.168.10.100 192.168.10.110",
    "@priv", "show ip dhcp pool"
  ]);
  ok("DHCP 服务已开启", sw.dhcp.enabled === true);
  const p = sw.dhcp.pools["office"];
  ok("地址池已创建", !!p, JSON.stringify(Object.keys(sw.dhcp.pools)));
  ok("网段与掩码", p.network === "192.168.10.0" && p.mask === "255.255.255.0", JSON.stringify(p));
  ok("网关", p.gateway === "192.168.10.254", p.gateway);
  ok("DNS", p.dns === "8.8.8.8", p.dns);
  ok("租期", p.lease === 7200, String(p.lease));
  ok("地址范围", p.start === "192.168.10.100" && p.end === "192.168.10.200", JSON.stringify([p.start, p.end]));
  ok("排除地址 11 条", sw.dhcp.excluded.length === 11, String(sw.dhcp.excluded.length));
  const show = out[out.length - 1].output;
  ok("show ip dhcp pool 输出池名", show.indexOf("office") >= 0, show);
  ok("show 显示范围", show.indexOf("192.168.10.100") >= 0, show);
}
{
  // 分配地址：跳过 excluded 与已占用
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  run(sw, ["@global", "service dhcp", "ip dhcp pool p1",
    "network 192.168.10.0 255.255.255.0", "range 192.168.10.100 192.168.10.110", "exit"]);
  const a = Sim.dhcpAllocate(sw, "AA:AA:AA:AA:AA:AA");
  ok("分配到地址", a && a.ip === "192.168.10.100", JSON.stringify(a));
  const b = Sim.dhcpAllocate(sw, "BB:BB:BB:BB:BB:BB");
  ok("第二个客户端拿到下一个地址", b && b.ip === "192.168.10.101", JSON.stringify(b));
  ok("绑定表记录 2 条", Object.keys(sw.dhcp.bindings).length === 2);
  const show = Sim.showDhcpBinding(sw);
  ok("show ip dhcp binding 列出地址", show.indexOf("192.168.10.100") >= 0, show);
  ok("show 显示剩余租期", /\d+s/.test(show), show);
  // 排除地址
  sw.dhcp.excluded.push("192.168.10.102");
  const c = Sim.dhcpAllocate(sw, "CC:CC:CC:CC:CC:CC");
  ok("跳过已排除地址", c && c.ip === "192.168.10.103", JSON.stringify(c));
  // 池耗尽
  const sw2 = Sim.createDevice("l3", "SW2", 0, 0);
  run(sw2, ["@global", "service dhcp", "ip dhcp pool s", "network 10.0.0.0 255.255.255.0", "range 10.0.0.1 10.0.0.1", "exit"]);
  Sim.dhcpAllocate(sw2, "DD:DD:DD:DD:DD:DD");
  const d = Sim.dhcpAllocate(sw2, "EE:EE:EE:EE:EE:EE");
  ok("池耗尽返回 null", d === null, JSON.stringify(d));
  // 服务未开启时不分配
  const sw3 = Sim.createDevice("l3", "SW3", 0, 0);
  ok("服务未开启不分配", Sim.dhcpAllocate(sw3, "FF:FF:FF:FF:FF:FF") === null);
}

console.log("\n===== 5. 提示符与 TAB =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  const c = ctxOf(sw);
  c.sess.mode = "global";
  const r = CLI.execLine(c, "ip access-list extended 100");
  ok("ACL 模式提示符", /\(Config-acl-100\)#$/.test((r.prompt || "").trim()), r.prompt);
  const r2 = CLI.execLine(c, "exit");
  ok("退出 ACL 回 global", /\(Config\)#$/.test((r2.prompt || "").trim()), r2.prompt);
  const c2 = ctxOf(sw);
  c2.sess.mode = "global";
  const r3 = CLI.execLine(c2, "ip dhcp pool office");
  ok("DHCP 池模式提示符", /\(Config-dhcp-pool-office\)#$/.test((r3.prompt || "").trim()), r3.prompt);
  // TAB 候选
  const cg = CLI.candidatesFor("global").map(x => x.raw);
  ok("TAB 含 ip access-list", cg.some(x => x.indexOf("ip access-list") === 0));
  ok("TAB 含 service dhcp", cg.indexOf("service dhcp") >= 0);
  ok("TAB 含 ip dhcp pool", cg.some(x => x.indexOf("ip dhcp pool") === 0));
  const ca = CLI.candidatesFor("acl").map(x => x.raw);
  ok("acl 模式 TAB 有 permit", ca.some(x => x.indexOf("permit") === 0));
  const cd = CLI.candidatesFor("dhcp-pool").map(x => x.raw);
  ok("dhcp-pool 模式 TAB 有 network", cd.some(x => x.indexOf("network") === 0));
  const ci = CLI.candidatesFor("if").map(x => x.raw);
  ok("接口 TAB 有 ip access-group", ci.some(x => x.indexOf("ip access-group") === 0));
  ok("接口 TAB 有 vrrp", ci.some(x => x.indexOf("vrrp") === 0));
  const cp = CLI.candidatesFor("priv").map(x => x.raw);
  ok("priv TAB 有 show vrrp", cp.indexOf("show vrrp") >= 0);
  ok("priv TAB 有 show access-lists", cp.indexOf("show access-lists") >= 0);
}

console.log("\n===== 6. show running-config 回显 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  run(sw, [
    "@global", "ip access-list extended 100",
    "seq 10 permit ip any any", "exit",
    "service dhcp", "ip dhcp pool p", "network 10.0.0.0 255.255.255.0", "exit",
    "interface vlan 10", "vrrp 1 ip 10.0.0.254", "vrrp 1 priority 120", "exit"
  ]);
  const rc = Sim.showRunningConfig(sw);
  ok("回显含 ACL", rc.indexOf("ip access-list") >= 0, rc);
  ok("回显含 DHCP 服务", rc.indexOf("service dhcp") >= 0, rc);
  ok("回显含 DHCP 池", rc.indexOf("ip dhcp pool") >= 0, rc);
  ok("回显含 VRRP", rc.indexOf("vrrp 1 ip 10.0.0.254") >= 0, rc);
  ok("回显含 VRRP 优先级", rc.indexOf("vrrp 1 priority 120") >= 0, rc);
}

console.log("\n===== 7. 未配置时的友好提示 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  ok("show access-lists 提示", CLI.execLine(c, "show access-lists").output.indexOf("ACL") >= 0);
  ok("show vrrp 提示", CLI.execLine(c, "show vrrp").output.indexOf("VRRP") >= 0);
  ok("show ip dhcp pool 提示", CLI.execLine(c, "show ip dhcp pool").output.indexOf("DHCP") >= 0);
  ok("show ip dhcp binding 提示", CLI.execLine(c, "show ip dhcp binding").output.indexOf("DHCP") >= 0);
}

console.log("\n===== 8. 既有功能不受影响 =====");
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