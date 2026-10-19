// 边界与异常输入测试：找出会崩溃、返回矛盾结果或静默出错的地方
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
  return { devices: [dev], links: [], dev: dev, sess: CLI.createSession(dev), pendingConfirm: null,
    stream: null, ping: () => ({ ok: false, reason: "n/a" }),
    tracert: () => ({ ok: false, hops: [] }),
    telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {} };
}

console.log("\n===== 1. 畸形输入不得抛异常 =====");
{
  const nasty = [
    "", " ", "?", "??", "???", "show", "show ", "conf", "conf t", "int", "int ",
    "interface", "interface ", "interface e1/0/", "interface e999/9/9",
    "interface vlan", "interface vlan 99999", "interface vlan -1", "interface vlan abc",
    "vlan", "vlan 99999", "vlan -5", "vlan abc", "vlan 0",
    "ping", "ping ", "ping 999.999.999.999", "ping abc", "ping 1.1.1.1 2.2.2.2",
    "tracert", "tracert ", "tracert abc",
    "ip route", "ip route 1.1.1.1", "ip route 1.1.1.1 255.255.255.0",
    "ip route abc def ghi", "ip route 0.0.0.0 0.0.0.0",
    "ip address", "ip address 1.1.1.1", "ip address 1.1.1.1 999.1.1.1",
    "spanning-tree mst 999 priority 12345", "spanning-tree mst 0 priority 0",
    "port-group", "port-group 999", "port-group -1", "port-group abc",
    "monitor session 999 source interface e1/0/1",
    "router rip", "router rip 999", "router ospf", "router ospf 999",
    "network 1.1.1.1 255.255.255.0 area 999", "router-id abc",
    "mac-address static", "mac-address static abc interface e1/0/1",
    "mac-address static AA-AA-AA-AA-AA-AA interface", "mac-address aging-time abc",
    "mac-address aging-time -1", "mac-address maximum 0",
    "username", "username u", "username u password", "username u password 99 x",
    "telnet", "telnet 1.1.1.1", "telnet 999.999.999.999",
    "write", "reload", "delete", "set default", "erase",
    "sh run; ping 1.1.1.1", "sh run && ping 1.1.1.1", "`id`", "$(id)",
    "javascript:alert(1)", "<script>alert(1)</script>",
    "a".repeat(500), "ip route " + "1".repeat(200),
    "interface " + "e1/0/1-".repeat(50), "vlan 10;".repeat(60)
  ];
  const devs = [Sim.createDevice("l2", "SW1", 0, 0),
                Sim.createDevice("router", "R1", 0, 0),
                Sim.createDevice("pc", "PC1", 0, 0)];
  let crashed = null;
  for (const d of devs) {
    for (const mode of ["priv", "global", "if", "user", "vlan", "mstp", "rip", "ospf"]) {
      for (const cmd of nasty) {
        try {
          const c = ctxOf(d);
          c.sess.mode = mode;
          if (mode === "if") c.sess.ifPorts = ["e1/0/1"];
          if (mode === "vlan") c.sess.vlanId = "10";
          CLI.execLine(c, cmd);
        } catch (e) {
          crashed = crashed || (mode + " / " + cmd.slice(0, 40) + " -> " + e.message);
        }
      }
    }
  }
  ok("畸形输入全部不抛异常 (" + (devs.length * 8 * nasty.length) + " 组合)", crashed === null, crashed);
}

console.log("\n===== 2. 数值边界必须被拒绝或钳制 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const r1 = CLI.execLine(c, "interface e1/0/1");
  ok("进入接口模式", /Config-if/.test(r1.prompt || ""), r1.prompt);
  // STP 优先级必须是 4096 倍数
  c.sess.mode = "global";
  const r2 = CLI.execLine(c, "spanning-tree mst 1 priority 4095");
  ok("非 4096 倍数被拒", /倍/.test(r2.output || "") || /%/.test(r2.output || ""), r2.output);
  const r3 = CLI.execLine(c, "spanning-tree mst 1 priority 8192");
  ok("合法倍数接受", !(r3.output || "").match(/^%/), r3.output);
  ok("优先级确实写入 stp.priorities", sw.stp.priorities["1"] === 8192,
    JSON.stringify(sw.stp.priorities));
  // show spanning-tree 在无 stpInfo 时也不得崩（真机总有，但接口层可能传空）
  try {
    const t = Sim.showSpanningTree(sw, {});
    ok("showSpanningTree 接受空 stpInfo", typeof t === "string", String(t).slice(0, 40));
    const t2 = Sim.showSpanningTree(sw, null);
    ok("showSpanningTree 接受 null stpInfo", typeof t2 === "string");
  } catch (e) { ok("showSpanningTree 空 stpInfo 不崩", false, e.message); }
}
{
  // MAC 地址格式校验
  const sw = Sim.createDevice("l2", "SW2", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const bad = ["ZZ-ZZ-ZZ-ZZ-ZZ-ZZ", "1-2-3-4-5-6", "AA-BB-CC-DD-EE-FF-00", "not-a-mac", "AA:BB:CC:DD:EE", "GG:HH:II:JJ:KK:LL"];
  let accepted = [];
  for (const m of bad) {
    const r = CLI.execLine(c, "mac-address static " + m + " interface e1/0/1");
    if (!(r.output || "").match(/^%/)) accepted.push(m);
  }
  ok("非法 MAC 全部被拒", accepted.length === 0, JSON.stringify(accepted));
  const good = ["AA-BB-CC-DD-EE-FF", "aa:bb:cc:dd:ee:ff", "AABB.CCDD.EEFF"];
  let rejected = [];
  for (const m of good) {
    const r = CLI.execLine(c, "mac-address static " + m + " interface e1/0/" + (good.indexOf(m) + 2));
    if ((r.output || "").match(/^%/)) rejected.push(m);
  }
  ok("三种合法 MAC 写法均接受", rejected.length === 0, JSON.stringify(rejected));
}
{
  // 端口号越界
  const sw = Sim.createDevice("l2", "SW3", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const r = CLI.execLine(c, "interface e1/0/99");
  ok("越界端口被拒或无害", typeof r.output === "string", r.output);
  ok("未创建越界端口", !sw.ports["e1/0/99"], JSON.stringify(Object.keys(sw.ports).length));
}

console.log("\n===== 3. VLAN 号边界 =====");
{
  const sw = Sim.createDevice("l2", "SW4", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  CLI.execLine(c, "vlan 4094");
  ok("vlan 4094 可创建", !!sw.vlans["4094"]);
  const r = CLI.execLine(c, "vlan 4095");
  ok("vlan 4095 被拒或无害", (r.output || "").match(/^%/) || !sw.vlans["4095"], r.output);
  ok("vlan 1 始终存在", !!sw.vlans["1"]);
  const r2 = CLI.execLine(c, "vlan 0");
  ok("vlan 0 被拒或无害", (r2.output || "").match(/^%/) || !sw.vlans["0"], r2.output);
}

console.log("\n===== 4. 缩写歧义必须被识别而非静默误判 =====");
{
  const sw = Sim.createDevice("l2", "SW5", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const ambiguous = ["sh m", "sh p", "sh i", "sh s", "sh l", "sh d", "sh a", "sh n"];
  let wrong = [];
  for (const cmd of ambiguous) {
    const r = CLI.execLine(c, cmd);
    const o = r.output || "";
    // 要么报歧义，要么唯一解析成功；不能静默返回错误内容
    const isAmbig = /歧义/.test(o);
    const isUnknown = /未知/.test(o);
    if (!isAmbig && !isUnknown && o.length === 0) wrong.push(cmd);
  }
  ok("无静默失败", wrong.length === 0, JSON.stringify(wrong));
  // 关键：show 系列不能被前缀吃掉
  const r = CLI.execLine(c, "sh run");
  ok("sh run 不被 sh 吃掉", /hostname|interface|vlan|当前|Current|no /.test(r.output || "") ||
    (r.output || "").indexOf("%") === 0, (r.output || "").slice(0, 60));
}
{
  // show 各子命令互不串味
  const sw = Sim.createDevice("l2", "SW6", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const cases = [
    ["sh vlan", "VLAN"], ["sh mac", "Mac Address|MAC|歧义"], ["sh int e1/0/1", "e1/0/1"],
    // sh por 存在真实歧义（port-security / port-isolate），报歧义才是正确行为
    ["sh por", "歧义|port-security|port-isolate"],
    ["sh por-sec", "Secure Port|port-security|歧义"],
    ["sh port-is", "隔离|Isolat|歧义"],
    ["sh mon", "monitor|Session|无"],
    ["sh span", "生成树|Spanning|Bridge|Root|%"],
    ["sh dhcp s", "Snooping"], ["sh igm s", "IGMP"],
    ["sh lldp", "LLDP"], ["sh snmp", "SNMP"]
  ];
  for (const [cmd, kw] of cases) {
    const r = CLI.execLine(c, cmd);
    ok(cmd + " 命中 " + kw, new RegExp(kw).test(r.output || ""), (r.output || "").slice(0, 80));
  }
}

console.log("\n===== 5. 模式机状态一致性 =====");
{
  const sw = Sim.createDevice("l2", "SW7", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const seq = ["interface e1/0/1", "exit", "interface e1/0/2", "exit", "exit"];
  let prompt = "";
  for (const cmd of seq) prompt = CLI.execLine(c, cmd).prompt;
  ok("连续进出后回到 priv", /#\s*$/.test(prompt) && !/Config/.test(prompt), prompt);
  const c2 = ctxOf(sw); c2.sess.mode = "global";
  const r = CLI.execLine(c2, "interface vlan 10");
  ok("进入 vlan 接口模式", /Config-if-vlan10/.test(r.prompt || ""), r.prompt);
  const r2 = CLI.execLine(c2, "exit");
  // 退出接口模式应回到全局配置模式：<host>(Config)#
  ok("vlan 接口退出回 global", /\(Config\)#$/.test((r2.prompt || "").trim()), JSON.stringify(r2.prompt));
  // 多层嵌套退出不应越界
  const c3 = ctxOf(sw); c3.sess.mode = "global";
  CLI.execLine(c3, "vlan 10");
  let p = "";
  for (let i = 0; i < 5; i++) p = CLI.execLine(c3, "exit").prompt;
  ok("反复 exit 不崩且最终稳定", typeof p === "string" && p.length > 0, p);
}
{
  // priv 模式下不应执行 global 配置
  const sw = Sim.createDevice("l2", "SW8", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const before = JSON.stringify(sw.ports["e1/0/1"]);
  CLI.execLine(c, "switchport mode trunk");
  ok("priv 模式不能改端口", JSON.stringify(sw.ports["e1/0/1"]) === before, sw.ports["e1/0/1"].mode);
  const r = CLI.execLine(c, "hostname NEW");
  ok("priv 模式不能改主机名", sw.hostname === "SW8", sw.hostname);
}

console.log("\n===== 6. 端口范围解析 =====");
{
  const sw = Sim.createDevice("l2", "SW9", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "global";
  const r = CLI.execLine(c, "interface e1/0/1-5");
  ok("范围 1-5 展开为 5 口", (c.sess.ifPorts || []).length === 5, JSON.stringify(c.sess.ifPorts));
  const r2 = CLI.execLine(c, "interface e1/0/1,3,5");
  ok("逗号列表正确", (c.sess.ifPorts || []).length === 3, JSON.stringify(c.sess.ifPorts));
  const r3 = CLI.execLine(c, "interface e1/0/5-1");
  ok("逆序范围不崩", typeof r3.prompt === "string", r3.prompt);
  const r4 = CLI.execLine(c, "interface e1/0/0");
  ok("0 号口被拒", (r4.output || "").match(/^%/) || !sw.ports["e1/0/0"], r4.output);
}

console.log("\n===== 7. show 输出不得为 undefined/null =====");
{
  const sw = Sim.createDevice("l2", "SW10", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const shows = ["sh run", "sh startup", "sh flash", "sh vlan", "sh mac", "sh ip int br",
    "sh ip ro", "sh span", "sh por gr", "sh mon", "sh port-sec",
    "sh dhcp s", "sh igm s", "sh arp i", "sh port-is", "sh qos p",
    "sh loop-g", "sh mac-address s", "sh mac a", "sh lldp", "sh snmp"];
  let bad = [];
  for (const cmd of shows) {
    const r = CLI.execLine(c, cmd);
    if (typeof r.output !== "string" || r.output === null) bad.push(cmd);
    if (r.output && r.output.indexOf("undefined") >= 0) bad.push(cmd + "(undefined)");
    if (r.output && r.output.indexOf("NaN") >= 0) bad.push(cmd + "(NaN)");
    if (r.output && r.output.indexOf("null") >= 0) bad.push(cmd + "(null)");
  }
  ok("21 条 show 无 undefined/NaN/null", bad.length === 0, JSON.stringify(bad));
}

console.log("\n===== 8. 拓扑健壮性 =====");
{
  // 空拓扑 + null 源设备：防御性检查应给出失败而非抛异常
  try {
    const r = Sim.simulatePing([], [], null, "1.1.1.1");
    ok("空拓扑+null源不崩且返回失败", r && r.ok === false, JSON.stringify(r));
  } catch (e) { ok("空拓扑+null源不崩", false, e.message); }
  // 空拓扑但源存在
  try {
    const only = Sim.createDevice("pc", "SOLO", 0, 0);
    only.pcIp = "10.0.0.1";
    const r2 = Sim.simulatePing([only], [], only, "10.0.0.1");
    ok("单机 ping 自己成功", r2 && r2.ok === true, JSON.stringify(r2));
  } catch (e) { ok("单机 ping 自己不崩", false, e.message); }
  // 孤立设备
  const lone = Sim.createDevice("l2", "LONE", 0, 0);
  try {
    const r = Sim.simulatePing([lone], [], lone, "1.1.1.1");
    ok("孤立设备不崩", typeof r.ok === "boolean");
  } catch (e) { ok("孤立设备不崩", false, e.message); }
  // 断链
  const sw = Sim.createDevice("l2", "SW", 0, 0);
  const pc = Sim.createDevice("pc", "PC", 0, 0);
  pc.pcIp = "10.0.0.2"; pc.pcMask = "255.255.255.0";
  const links = [{ id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc.id, port: "eth0" } }];
  sw.ports["e1/0/1"].shutdown = true;
  const r = Sim.simulatePing([sw, pc], links, pc, "10.0.0.2");
  ok("链路 down 时 ping 自己仍通（本机回复）", r.ok === true, r.reason);
  const rDown = Sim.simulatePing([sw, pc], links, pc, "10.0.0.99");
  ok("链路 down 时 ping 他机失败", rDown.ok === false, rDown.reason);
  ok("失败原因提到链路", /down|未连线|shutdown|链路/.test(rDown.reason || ""), rDown.reason);
  // 引用不存在的设备 id
  const badLinks = [{ id: "x", kind: "copper", a: { dev: "nonexistent", port: "e1/0/1" }, b: { dev: sw.id, port: "e1/0/2" } }];
  try {
    const r2 = Sim.simulatePing([sw, pc], badLinks, pc, "10.0.0.2");
    ok("悬空设备 id 不崩", typeof r2.ok === "boolean");
  } catch (e) { ok("悬空设备 id 不崩", false, e.message); }
  // 引用不存在的端口
  const badPorts = [{ id: "y", kind: "copper", a: { dev: sw.id, port: "e1/0/99" }, b: { dev: pc.id, port: "eth0" } }];
  try {
    const r3 = Sim.simulatePing([sw, pc], badPorts, pc, "10.0.0.2");
    ok("悬空端口不崩", typeof r3.ok === "boolean");
  } catch (e) { ok("悬空端口不崩", false, e.message); }
}

console.log("\n===== 9. 路由表自洽性 =====");
{
  // 直连路由的 nextHop 必须是本机直连
  const r1 = Sim.createDevice("router", "R1", 0, 0);
  const r2 = Sim.createDevice("router", "R2", 0, 0);
  r1.ifIp["s1/0"] = { ip: "10.1.1.1", mask: "255.255.255.0" };
  r2.ifIp["s1/0"] = { ip: "10.1.1.2", mask: "255.255.255.0" };
  r1.staticRoutes = [{ dest: "192.168.2.0", mask: "255.255.255.0", nextHop: "10.1.1.2", dist: 1 }];
  r2.ifIp["g0/0"] = { ip: "192.168.2.2", mask: "255.255.255.0" };
  const links = [{ id: "s", kind: "serial", a: { dev: r1.id, port: "s1/0" }, b: { dev: r2.id, port: "s1/0" } }];
  const tbl = Sim.buildRouteTable(r1, [r1, r2], links);   // 签名：(dev, allDevices, links)
  const staticR = tbl.filter(x => x.proto === "S")[0];
  ok("静态路由在表中", !!staticR, JSON.stringify(tbl.map(x => x.proto)));
  ok("静态路由下一跳正确", staticR && staticR.nextHop === "10.1.1.2", JSON.stringify(staticR));
  // 下一跳不可达时不应产生路由
  r1.staticRoutes = [{ dest: "172.16.0.0", mask: "255.255.0.0", nextHop: "99.99.99.99", dist: 1 }];
  // 非 createDevice 构造的对象（缺 staticRoutes 字段）也不得崩溃
  const bare = { id: "bare", type: "router", ports: {}, ifIp: {}, vlanIf: {}, vlans: {}, stp: { enabled: false } };
  try {
    Sim.buildRouteTable(bare, [bare], []);
    ok("缺 staticRoutes/rip/ospf 字段不崩", true);
  } catch (e) { ok("缺 staticRoutes/rip/ospf 字段不崩", false, e.message); }
  const tbl2 = Sim.buildRouteTable(r1, [r1, r2], links);
  // 课程行为：静态路由照常进表（show ip route 可见），转发时才因下一跳不可达而失败
  ok("下一跳不可达的静态路由仍进表（可被 show 看到）",
    tbl2.some(x => x.dest === "172.16.0.0"), JSON.stringify(tbl2.map(x => x.dest)));
  const r = Sim.simulatePing([r1, r2], links, r1, "172.16.0.5");
  ok("但转发不通", r.ok === false, r.reason);
  ok("失败原因提到下一跳/不可达",
    /下一跳|不可达|路由/.test(r.reason || ""), r.reason);
}

console.log("\n===== 10. 最长前缀匹配 =====");
{
  const r = Sim.createDevice("l3", "SW", 0, 0);
  r.vlanIf["10"] = { ip: "10.1.1.1", mask: "255.255.255.0" };
  r.vlanIf["20"] = { ip: "10.1.2.1", mask: "255.255.255.0" };
  const devices = [r];
  const hit = Sim.routeLookup(r, "10.1.1.55", devices, []);
  ok("同网段命中 C 路由", hit && hit.proto === "C", JSON.stringify(hit));
  const miss = Sim.routeLookup(r, "192.168.1.1", devices, []);
  ok("无匹配返回 null", miss === null, JSON.stringify(miss));
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);