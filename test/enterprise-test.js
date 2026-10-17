// DCN 企业级新功能测试：DHCP Snooping / IGMP Snooping / ARP DAI /
// 端口隔离 / QoS / 环路保护 / 静态MAC / LLDP / SNMP / debug mirror
const fs = require("fs");
const path = require("path");
const join = path.join;
const ROOT = path.join(__dirname, "..");

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };

function load(file) {
  const code = fs.readFileSync(path.join(ROOT, file), "utf8");
  const m = { exports: {} };
  new Function("window", "global", "module", "exports", code)(global, global, m, m.exports);
  return null;
}
load("src/sim-core.js");
load("src/cli-engine.js");
const Sim = global.DCNSim, CLI = global.DCNCLI;

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}

const MAC = "00-11-22-33-44-55";       // 6 字节 = 12 位十六进制
const MACN = "00:11:22:33:44:55";      // normMac 输出形式

function mkSwitch(name) { return Sim.createDevice("l2", name || "SW1", 0, 0); }

function newCtx(dev) {
  const devices = [dev];
  const ctx = {
    devices: devices, links: [], dev: dev,
    sess: CLI.createSession(dev),
    pendingConfirm: null, stream: null,
    ping: () => ({ ok: false, reason: "n/a" }),
    factoryReset: () => {},
    stpInfo: () => Sim.stpCompute(devices, ctx.links || [])
  };
  return ctx;
}

function run(dev, cmds, mode0) {
  const ctx = newCtx(dev);
  ctx.sess.mode = mode0 || "priv";
  const out = [];
  for (const c of cmds) {
    if (c === "@priv") { ctx.sess.mode = "priv"; continue; }
    if (c === "@global") { ctx.sess.mode = "global"; continue; }
    const r = CLI.execLine(ctx, c);
    out.push({ cmd: c, output: r.output || "", prompt: r.prompt, mode: ctx.sess.mode });
  }
  return { out, ctx };
}

console.log("\n===== 1. DHCP Snooping =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "ip dhcp snooping",
    "interface e1/0/1", "ip dhcp snooping trust", "exit",
    "ip dhcp snooping vlan 10;20-30 rate 15", "exit",
    "@priv", "show dhcp snooping"
  ]);
  const last = out[out.length - 1].output;
  ok("global ip dhcp snooping", last.indexOf("enabled") >= 0, last);
  ok("trustedPorts recorded", sw.dhcpSnooping.trustedPorts.indexOf("e1/0/1") >= 0, JSON.stringify(sw.dhcpSnooping.trustedPorts));
  ok("port trust flag", sw.ports["e1/0/1"].trust === true);
  ok("vlan list 10;20-30", !!sw.dhcpSnooping.perVlan["10"] && !!sw.dhcpSnooping.perVlan["20"] && !!sw.dhcpSnooping.perVlan["30"],
    JSON.stringify(Object.keys(sw.dhcpSnooping.perVlan)));
  ok("rate stored", sw.dhcpSnooping.perVlan["10"].rate === "15", JSON.stringify(sw.dhcpSnooping.perVlan["10"]));
  ok("show lists trusted port", last.indexOf("e1/0/1") >= 0, last);
}
{
  const sw = mkSwitch();
  const { out } = run(sw, ["@global", "ip dhcp s", "@priv", "sh dhcp s"]);
  ok("abbrev ip dhcp s", sw.dhcpSnooping.enabled === true);
  ok("abbrev sh dhcp s output", out[out.length - 1].output.indexOf("Snooping : enabled") >= 0, out[out.length - 1].output);
}
{
  const sw = mkSwitch();
  sw.dhcpSnooping.bindings[MACN] = { ip: "10.1.1.5", port: "e1/0/2", vlan: 10 };
  ok("disabled -> no violation", Sim.checkDhcpViolation(sw, "e1/0/3", MACN, "10.1.1.99") === false);
  sw.dhcpSnooping.enabled = true;
  ok("same MAC diff IP = violation", Sim.checkDhcpViolation(sw, "e1/0/3", MACN, "10.1.1.99") === true);
  ok("same IP diff MAC = violation", Sim.checkDhcpViolation(sw, "e1/0/3", "AA-AA-AA-AA-AA-AA", "10.1.1.5") === true);
  ok("consistent = pass", Sim.checkDhcpViolation(sw, "e1/0/3", MACN, "10.1.1.5") === false);
  sw.ports["e1/0/1"].trust = true;
  ok("trusted port exempt", Sim.checkDhcpViolation(sw, "e1/0/1", MACN, "10.1.1.99") === false);
}

console.log("\n===== 2. IGMP Snooping =====");
{
  const sw = mkSwitch();
  run(sw, ["@global", "ip igmp snooping version 2", "@priv", "sh igm s"]);
  ok("ip igmp snooping version 2", sw.igmpSnooping.enabled === true && sw.igmpSnooping.version === 2,
    JSON.stringify(sw.igmpSnooping));
  Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/3", 2);
  Sim.learnIgmp(sw, 10, "239.1.1.1", "e1/0/4", 2);
  Sim.learnIgmp(sw, 20, "239.2.2.2", "e1/0/5", 2);
  const t = Sim.showIgmpSnooping(sw);
  ok("2 groups learned", t.indexOf("239.1.1.1") >= 0 && t.indexOf("239.2.2.2") >= 0, t);
  ok("ports merged dedup", t.indexOf("Ethernet1/0/3,Ethernet1/0/4") >= 0, t);
  ok("version shown", t.indexOf("v2") >= 0, t);
  const sw2 = mkSwitch("SW2");
  Sim.learnIgmp(sw2, 10, "239.9.9.9", "e1/0/1", 3);
  ok("disabled -> no learning", Object.keys(sw2.igmpSnooping.groups).length === 0);
}

console.log("\n===== 3. ARP Inspection (DAI) =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, ["@global", "ip arp inspection vlan 10;20", "@priv", "sh arp i"]);
  ok("DAI enabled", sw.arpInspection.enabled === true);
  ok("DAI vlan 10;20", !!sw.arpInspection.perVlan["10"] && !!sw.arpInspection.perVlan["20"],
    JSON.stringify(Object.keys(sw.arpInspection.perVlan)));
  ok("show arp inspection output", out[out.length - 1].output.indexOf("enabled") >= 0, out[out.length - 1].output);
  sw.dhcpSnooping.bindings[MACN] = { ip: "10.1.1.5", port: "e1/0/2", vlan: 10 };
  ok("mac/ip mismatch = spoof", Sim.checkArpViolation(sw, 10, [{ mac: MACN, ip: "10.1.1.9" }]) === true);
  ok("match = pass", Sim.checkArpViolation(sw, 10, [{ mac: MACN, ip: "10.1.1.5" }]) === false);
  ok("vlan not inspected = pass", Sim.checkArpViolation(sw, 99, [{ mac: MACN, ip: "10.1.1.9" }]) === false);
  ok("no binding info = pass", Sim.checkArpViolation(sw, 10, [{ mac: "99-99-99-99-99-99", ip: "1.1.1.1" }]) === false);
}

console.log("\n===== 4. Port isolation (blocks traffic) =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "interface e1/0/1-3", "switchport isolate group 1", "exit", "@priv", "sh port-isolate"
  ]);
  ok("isolate group set", sw.ports["e1/0/1"].isolateGroup === 1 && sw.ports["e1/0/3"].isolateGroup === 1);
  ok("show port-isolate output", out[out.length - 1].output.indexOf("Group 1") >= 0, out[out.length - 1].output);
  ok("two isolated ports blocked", Sim.isIsolated(sw, "e1/0/1", "e1/0/2") === true);
  ok("isolated vs normal allowed", Sim.isIsolated(sw, "e1/0/1", "e1/0/10") === false);
  ok("same port not isolated", Sim.isIsolated(sw, "e1/0/1", "e1/0/1") === false);
  const t = sw.ports["e1/0/4"]; t.isolateGroup = 1; t.shutdown = true;
  ok("shutdown port exempt", Sim.isIsolated(sw, "e1/0/1", "e1/0/4") === false);
}
{
  const sw = mkSwitch();
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "10.1.1.1"; pc1.pcMask = "255.255.255.0"; pc1.pcGw = "10.1.1.254";
  pc2.pcIp = "10.1.1.2"; pc2.pcMask = "255.255.255.0"; pc2.pcGw = "10.1.1.254";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  let r = Sim.simulatePing(devices, links, pc1, "10.1.1.2");
  ok("ping OK without isolation", r.ok === true, r.reason);
  sw.ports["e1/0/1"].isolateGroup = 1;
  sw.ports["e1/0/2"].isolateGroup = 1;
  r = Sim.simulatePing(devices, links, pc1, "10.1.1.2");
  ok("ping blocked by isolation", r.ok === false, "still reachable - isolation not effective");
  ok("reason mentions isolation", r.reason.indexOf("隔离") >= 0, r.reason);
}

console.log("\n===== 5. QoS priority =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "interface e1/0/1-2", "switchport priority 6", "exit",
    "interface e1/0/3", "switchport priority 3", "exit", "@priv", "sh qos prio"
  ]);
  ok("priority set", sw.ports["e1/0/1"].qosPrio === 6 && sw.ports["e1/0/3"].qosPrio === 3);
  const t = out[out.length - 1].output;
  ok("show qos priority lists", t.indexOf("Ethernet1/0/1") >= 0, t);
  ok("prio 6 = network control", t.indexOf("网络控制") >= 0, t);
  ok("prio 3 = voice", t.indexOf("语音") >= 0, t);
  const bad = run(mkSwitch("SW2"), ["@global", "interface e1/0/1", "switchport priority 9"]);
  ok("out-of-range rejected", bad.out[1].output.indexOf("0~7") >= 0, bad.out[1].output);
}

console.log("\n===== 6. Loop Guard =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "switchport loop-guard enable", "interface e1/0/1-4", "loop-guard enable", "exit", "@priv", "sh loop-g"
  ]);
  ok("global loop-guard on", sw.loopGuard.enabled === true);
  ok("port loop-guard flag", sw.ports["e1/0/1"].loopGuard === true && sw.ports["e1/0/4"].loopGuard === true);
  ok("show loop-guard output", out[out.length - 1].output.indexOf("enabled") >= 0, out[out.length - 1].output);
}

console.log("\n===== 7. Static MAC / limit / aging =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global",
    "mac-address static " + MAC + " interface e1/0/5",
    "mac-address aging-time 600", "mac-address maximum 2048",
    "@priv", "sh mac-address static", "sh mac aging"
  ]);
  ok("static mac bound", !!sw.staticMac["e1/0/5"] && sw.staticMac["e1/0/5"][0] === MACN, JSON.stringify(sw.staticMac));
  ok("static mac in mac table", !!sw.macTable[MACN], JSON.stringify(Object.keys(sw.macTable)));
  ok("aging time set", sw.agingTime === 600, String(sw.agingTime));
  ok("mac limit set", sw.macLimit === 2048, String(sw.macLimit));
  ok("sh mac-address static output", out[out.length - 2].output.indexOf(MACN) >= 0, out[out.length - 2].output);
  ok("sh mac aging shows 600", out[out.length - 1].output.indexOf("600") >= 0, out[out.length - 1].output);
  ok("sh mac aging shows limit", out[out.length - 1].output.indexOf("2048") >= 0, out[out.length - 1].output);
  run(sw, ["@global", "no mac-address static interface e1/0/5"]);
  ok("no mac-address static clears", !sw.staticMac["e1/0/5"], JSON.stringify(sw.staticMac));
}

console.log("\n===== 8. LLDP / SNMP =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "lldp enable", "snmp-server community public ro",
    "snmp-agent sys-contact zhangsan", "snmp-agent sys-location lab301",
    "@priv", "sh lldp", "sh snmp"
  ]);
  ok("lldp on", sw.lldp.enabled === true);
  ok("snmp community", sw.snmp.community === "public", String(sw.snmp.community));
  ok("snmp contact", sw.snmp.contact === "zhangsan");
  ok("snmp location", sw.snmp.location === "lab301");
  ok("sh lldp output", out[out.length - 2].output.indexOf("enabled") >= 0, out[out.length - 2].output);
  const s = out[out.length - 1].output;
  ok("sh snmp community", s.indexOf("public") >= 0, s);
  ok("sh snmp contact", s.indexOf("zhangsan") >= 0, s);
}

console.log("\n===== 9. debug mirror =====");
{
  const sw = mkSwitch();
  run(sw, [
    "@global",
    "monitor session 1 source interface e1/0/1 both",
    "monitor session 1 destination interface e1/0/2",
    "@priv", "debug mirror"
  ]);
  const dbg = Sim.__testDebugMirror
    ? null
    : (function () {
      const ctx = newCtx(sw); ctx.sess.mode = "global";
      ctx.dev.monitor = sw.monitor;
      CLI.execLine(ctx, "debug mirror");
      return CLI.execLine(ctx, "debug mirror").output;
    })();
  // 直接用同一 ctx 复查
  const ctx = newCtx(sw);
  ctx.sess.mode = "global";
  CLI.execLine(ctx, "monitor session 1 source interface e1/0/1 both");
  CLI.execLine(ctx, "monitor session 1 destination interface e1/0/2");
  const r = CLI.execLine(ctx, "debug mirror");
  ok("debug mirror lists session", r.output.indexOf("Session 1") >= 0, r.output);
  ok("debug mirror lists source", r.output.indexOf("e1/0/1") >= 0, r.output);
  const sw2 = mkSwitch("SW2");
  const r2 = run(sw2, ["@global", "debug mirror"]);
  ok("debug mirror without session warns", r2.out[0].output.indexOf("No monitor session") >= 0, r2.out[0].output);
}

console.log("\n===== 10. show running-config echoes new config =====");
{
  const sw = mkSwitch();
  run(sw, [
    "@global", "ip dhcp snooping", "interface e1/0/1", "ip dhcp snooping trust", "exit",
    "ip igmp snooping", "ip arp inspection vlan 10",
    "switchport loop-guard enable", "lldp enable",
    "snmp-server community public ro",
    "mac-address static " + MAC + " interface e1/0/5",
    "interface e1/0/6", "switchport isolate group 1", "switchport priority 6", "exit",
    "mac-address aging-time 600", "mac-address maximum 2048"
  ]);
  const rc = Sim.showRunningConfig(sw);
  ["ip dhcp snooping", "ip dhcp snooping trust", "ip igmp snooping", "ip arp inspection",
    "switchport loop-guard enable", "lldp enable", "snmp-server community public ro",
    "mac-address static " + MACN, "switchport isolate group 1",
    "switchport priority 6", "mac-address aging-time 600", "mac-address maximum 2048"
  ].forEach(n => ok("running-config has " + n, rc.indexOf(n) >= 0, rc));
}

console.log("\n===== 11. Abbreviation compatibility =====");
{
  const sw = mkSwitch();
  const { out } = run(sw, [
    "@global", "ip dhcp s", "ip igm s", "ip arp i vlan 10",
    "swi loop-g en", "lldp en", "mac-address aging-t 450", "mac-address maxim 1024",
    "interface e1/0/1", "swi isolate g 2", "swi prio 7", "ip dhcp s trust", "loop-g en",
    "exit", "@priv",
    "sh dhcp s", "sh igm s", "sh arp i", "sh port-is", "sh qos p", "sh loop-g",
    "sh mac-address s", "sh mac a", "sh lldp", "sh snmp"
  ]);
  ok("ip arp i vlan 10", !!sw.arpInspection.perVlan["10"], JSON.stringify(sw.arpInspection.perVlan));
  ok("mac-address aging-t 450", sw.agingTime === 450, String(sw.agingTime));
  ok("mac-address maxim 1024", sw.macLimit === 1024, String(sw.macLimit));
  ok("swi isolate g 2", sw.ports["e1/0/1"].isolateGroup === 2, String(sw.ports["e1/0/1"].isolateGroup));
  ok("swi prio 7", sw.ports["e1/0/1"].qosPrio === 7, String(sw.ports["e1/0/1"].qosPrio));
  ok("ip dhcp s trust", sw.ports["e1/0/1"].trust === true);
  ok("loop-g en", sw.ports["e1/0/1"].loopGuard === true);
  ok("swi loop-g en (global)", sw.loopGuard.enabled === true);
  ok("lldp en", sw.lldp.enabled === true);
  ok("ip igm s", sw.igmpSnooping.enabled === true);
  const shows = out.slice(-10).map(o => o.output);
  ok("all 10 show abbrevs resolve", shows.every(s => s && s.length > 0 &&
    s.indexOf("未知") < 0 && s.indexOf("歧义") < 0 && s.indexOf("用法") < 0), JSON.stringify(shows));
}

console.log("\n===== 12. TAB completion / ? hint =====");
{
  const g = CLI.candidatesFor("global").map(c => c.raw);
  ["ip dhcp snooping", "ip igmp snooping", "ip arp inspection", "switchport loop-guard enable",
    "lldp enable", "mac-address aging-time <sec>", "debug mirror"].forEach(c => {
      ok("global TAB has " + c, g.indexOf(c) >= 0);
    });
  const p = CLI.candidatesFor("priv").map(c => c.raw);
  ["show dhcp snooping", "show igmp snooping", "show arp inspection", "show port-isolate",
    "show qos priority", "show loop-guard", "show mac-address static", "show mac aging",
    "show lldp", "show snmp"].forEach(c => {
      ok("priv TAB has " + c, p.indexOf(c) >= 0);
    });
  const i = CLI.candidatesFor("if").map(c => c.raw);
  ["switchport isolate group <n>", "switchport priority <0-7>", "ip dhcp snooping trust"].forEach(c => {
    ok("if TAB has " + c, i.indexOf(c) >= 0);
  });
  const ctx = newCtx(mkSwitch()); ctx.sess.mode = "priv";
  const r = CLI.execLine(ctx, "show ?");
  ok("show ? lists new commands", r.output.indexOf("show dhcp snooping") >= 0 && r.output.indexOf("show lldp") >= 0, r.output);
  const ctx2 = newCtx(mkSwitch()); ctx2.sess.mode = "global";
  const r2 = CLI.execLine(ctx2, "ip ?");
  ok("ip ? lists dhcp/igmp/arp", r2.output.indexOf("ip dhcp snooping") >= 0 && r2.output.indexOf("ip igmp snooping") >= 0 && r2.output.indexOf("ip arp inspection") >= 0, r2.output);
}

console.log("\n===== 13. Friendly output when disabled =====");
{
  const ctx = newCtx(mkSwitch()); ctx.sess.mode = "priv";
  [["sh dhcp s", "disabled"], ["sh igm s", "disabled"], ["sh arp i", "disabled"],
  ["sh loop-g", "disabled"], ["sh lldp", "disabled"], ["sh snmp", "disabled"]].forEach(pair => {
    const r = CLI.execLine(ctx, pair[0]);
    ok(pair[0] + " shows " + pair[1], r.output.indexOf(pair[1]) >= 0, r.output);
  });
  ok("sh port-is hint", CLI.execLine(ctx, "sh port-is").output.indexOf("端口隔离") >= 0);
  ok("sh qos p hint", CLI.execLine(ctx, "sh qos p").output.indexOf("优先级") >= 0);
  ok("sh mac-address s hint", CLI.execLine(ctx, "sh mac-address s").output.indexOf("静态 MAC") >= 0);
  ok("sh mac a not ambiguous", CLI.execLine(ctx, "sh mac a").output.indexOf("歧义") < 0, CLI.execLine(ctx, "sh mac a").output);
}

console.log("\n===== 14. Performance: 120 nodes =====");
{
  const devices = [], links = [];
  for (let i = 0; i < 120; i++) {
    devices.push(i % 3 === 0 ? Sim.createDevice("l3", "SW" + i, 0, 0)
      : i % 3 === 1 ? Sim.createDevice("pc", "PC" + i, 0, 0) : Sim.createDevice("router", "R" + i, 0, 0));
  }
  for (let i = 0; i < 40; i++) {
    const sw = devices[i * 3];
    if (!sw.ports["e1/0/1"]) continue;
    const next = devices[((i + 1) % 40) * 3];
    links.push({ id: "l" + i, kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: next.id, port: "e1/0/2" } });
    const pc = devices[i * 3 + 1];
    links.push({ id: "p" + i, kind: "copper", a: { dev: sw.id, port: "e1/0/" + ((i % 20) + 3) }, b: { dev: pc.id, port: "eth0" } });
  }
  devices.forEach(d => { if (d.type !== "pc") d.stp.enabled = true; });
  let t0 = Date.now();
  Sim.stpCompute(devices, links);
  let t1 = Date.now();
  ok("120-node STP < 50ms (" + (t1 - t0) + "ms)", (t1 - t0) < 50);
  t0 = Date.now();
  Sim.simulatePing(devices, links, devices[1], "10.9.9.1");
  t1 = Date.now();
  ok("120-node ping < 200ms (" + (t1 - t0) + "ms)", (t1 - t0) < 200);
}

console.log("\n===== 15. No perf regression without isolation =====");
{
  const devices = [], links = [];
  for (let i = 0; i < 120; i++) devices.push(Sim.createDevice("l2", "SW" + i, 0, 0));
  for (let i = 0; i < 119; i++) {
    links.push({
      id: "l" + i, kind: "copper",
      a: { dev: devices[i].id, port: "e1/0/" + ((i % 20) + 1) },
      b: { dev: devices[i + 1].id, port: "e1/0/" + (((i + 1) % 20) + 1) }
    });
  }
  devices.forEach(d => { d.stp.enabled = true; });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) Sim.simulatePing(devices, links, devices[0], "10.0.0.1");
  const t1 = Date.now();
  ok("120 nodes x20 ping < 1500ms (" + (t1 - t0) + "ms)", (t1 - t0) < 1500);
}

console.log("\n===== 16. Existing VLAN behaviour intact =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pcs = [];
  for (let i = 0; i < 4; i++) {
    const pc = Sim.createDevice("pc", "PC" + (i + 1), 0, 0);
    pc.pcIp = "192.168.1." + (10 + i); pc.pcMask = "255.255.255.0";
    pcs.push(pc);
  }
  const devices = [sw].concat(pcs);
  const links = pcs.map((pc, i) => ({
    id: "l" + i, kind: "copper",
    a: { dev: sw.id, port: "e1/0/" + (i + 1) }, b: { dev: pc.id, port: "eth0" }
  }));
  let r = Sim.simulatePing(devices, links, pcs[0], "192.168.1.11");
  ok("same vlan reachable", r.ok === true, r.reason);
  Sim.ensureVlan(sw, "2");
  sw.ports["e1/0/2"].accessVlan = 2;
  r = Sim.simulatePing(devices, links, pcs[0], "192.168.1.11");
  ok("cross-vlan still blocked", r.ok === false, "VLAN isolation broken");
  ok("reason mentions vlan", r.reason.indexOf("VLAN") >= 0 || r.reason.indexOf("vlan") >= 0, r.reason);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);