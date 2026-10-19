// 出厂重置（set default）完整性测试：所有配置项都应被清空
require("E:/network/dcn-simulator/src/sim-core.js");
require("E:/network/dcn-simulator/src/cli-engine.js");
const Sim = global.DCNSim, CLI = global.DCNCLI;

let pass = 0, fail = 0; const fails = [];
function ok(n, c, e) {
  if (c) { pass++; console.log("PASS " + n); }
  else { fail++; fails.push(n + (e ? " -> " + e : "")); console.log("FAIL " + n + (e ? " -> " + e : "")); }
}

const sw = Sim.createDevice("l2", "SW1", 0, 0);
// 配一堆东西
sw.acl.lists["100"] = { id: "100", rules: [{ seq: 10, action: "deny", proto: "ip", src: "any", dst: "any" }] };
sw.acl.applied = { global: "100", port: { "e1/0/1": "100" } };
sw.vrrp.groups["1"] = { vrid: 1, ip: "1.1.1.1", priority: 120, interface: "vlan10" };
sw.dhcp.enabled = true;
sw.dhcp.pools["p"] = { name: "p", network: "10.0.0.0", mask: "255.255.255.0" };
sw.dhcp.excluded = ["10.0.0.1"];
sw.dhcp.bindings["AA:AA:AA:AA:AA:AA"] = { ip: "10.0.0.5", pool: "p" };
sw.dhcpSnooping.enabled = true;
sw.igmpSnooping.enabled = true;
sw.arpInspection.enabled = true;
sw.ports["e1/0/1"].isolateGroup = 1;
sw.ports["e1/0/1"].qosPrio = 6;
sw.ports["e1/0/1"].loopGuard = true;
sw.ports["e1/0/1"].trust = true;
sw.staticMac["e1/0/1"] = ["00:11:22:33:44:55"];
sw.macLimit = 100;
sw.agingTime = 600;
sw.lldp.enabled = true;
sw.snmp.enabled = true;
sw.hostname = "RENAMED";
sw.ports["e1/0/1"].shutdown = true;
sw.ports["e1/0/2"].portSecurity.enabled = true;

const ctx = {
  devices: [sw], links: [], dev: sw, sess: CLI.createSession(sw), pendingConfirm: null,
  ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
  factoryReset: (d) => {
    const fresh = Sim.createDevice(d.type, d.factoryName || null, d.x, d.y);
    fresh.id = d.id;
    Object.keys(fresh).forEach((k) => { d[k] = fresh[k]; });
  },
  stpInfo: () => ({}), refreshStp: () => {}
};
ctx.sess.mode = "priv";
CLI.execLine(ctx, "set default");

ok("ACL 已清空", Object.keys(sw.acl.lists).length === 0, JSON.stringify(sw.acl.lists));
ok("ACL 应用已清空", !sw.acl.applied || !sw.acl.applied.global, JSON.stringify(sw.acl.applied));
ok("VRRP 已清空", Object.keys(sw.vrrp.groups).length === 0);
ok("DHCP 已关闭", sw.dhcp.enabled === false);
ok("DHCP 池已清空", Object.keys(sw.dhcp.pools).length === 0);
ok("DHCP 排除地址已清空", sw.dhcp.excluded.length === 0);
ok("DHCP 绑定已清空", Object.keys(sw.dhcp.bindings).length === 0);
ok("DHCP Snooping 已关闭", sw.dhcpSnooping.enabled === false);
ok("IGMP Snooping 已关闭", sw.igmpSnooping.enabled === false);
ok("DAI 已关闭", sw.arpInspection.enabled === false);
ok("端口隔离已清空", sw.ports["e1/0/1"].isolateGroup === 0, String(sw.ports["e1/0/1"].isolateGroup));
ok("QoS 优先级已清空", sw.ports["e1/0/1"].qosPrio === 0, String(sw.ports["e1/0/1"].qosPrio));
ok("环路保护已清空", sw.ports["e1/0/1"].loopGuard === false);
ok("DHCP trust 已清空", sw.ports["e1/0/1"].trust === false);
ok("静态 MAC 已清空", Object.keys(sw.staticMac).length === 0);
ok("MAC 上限已复位", sw.macLimit === 0, String(sw.macLimit));
ok("老化时间已复位", sw.agingTime === 300, String(sw.agingTime));
ok("LLDP 已关闭", sw.lldp.enabled === false);
ok("SNMP 已关闭", sw.snmp.enabled === false);
ok("主机名已复位", sw.hostname === "SW1", sw.hostname);
ok("端口 shutdown 已复位", sw.ports["e1/0/1"].shutdown === false);
ok("端口安全已复位", sw.ports["e1/0/2"].portSecurity.enabled === false);

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach((f) => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);