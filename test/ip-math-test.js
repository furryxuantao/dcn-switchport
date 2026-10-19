// IP 转换与位运算测试：防止「>2^31 的整数」类静默精度错误复发
// 背景：曾因 n*256 精度丢失、| 与 >>> 优先级问题，导致 192.168.10.0 被算错
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
const Sim = global.DCNSim;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}

console.log("\n===== 1. IP ↔ 整数转换互逆 =====");
{
  const ips = [
    "0.0.0.0", "0.0.0.1", "1.2.3.4", "10.0.0.1", "10.1.1.1", "10.255.255.254",
    "172.16.0.1", "172.31.255.255", "192.168.0.1", "192.168.1.1",
    "192.168.10.0", "192.168.10.1", "192.168.10.100", "192.168.10.255",
    "192.168.100.1", "192.168.111.222", "192.168.200.250",
    "223.255.255.255", "255.255.255.254", "255.255.255.255",
    "100.64.0.1", "169.254.1.1", "8.8.8.8", "114.114.114.114"
  ];
  let bad = [];
  for (const ip of ips) {
    const n = Sim.ipToInt(ip);
    if (n === null) { bad.push(ip + "(返回null)"); continue; }
    const back = Sim.intToIp(n);
    if (back !== ip) bad.push(ip + " -> " + n + " -> " + back);
    // 独立校验：手算期望值
    const o = ip.split(".").map(Number);
    const expect = ((o[0] * 256 + o[1]) * 256 + o[2]) * 256 + o[3];
    if (n !== expect) bad.push(ip + " 值不符: " + n + " != " + expect);
  }
  ok(ips.length + " 个 IP 全部正确往返", bad.length === 0, JSON.stringify(bad));
}
{
  // 超过 2^31 的 IP 必须是精确值
  const n = Sim.ipToInt("192.168.10.0");
  ok("192.168.10.0 精确值 = 0xC0A80A00", n === 0xC0A80A00, n.toString(16));
  ok("值 > 2^31 仍为正数", n > 0, String(n));
  const n2 = Sim.ipToInt("255.255.255.255");
  ok("255.255.255.255 = 4294967295", n2 === 4294967295, String(n2));
  const n3 = Sim.ipToInt("128.0.0.1");
  ok("128.0.0.1 = 0x80000001", n3 === 0x80000001, n3.toString(16));
}

console.log("\n===== 2. 非法 IP 必须返回 null =====");
{
  const bad = ["", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.256.1.1", "1.1.256.1", "1.1.1.256",
    "-1.1.1.1", "a.b.c.d", "1.1.1.x", " 1.1.1.1x", "1.1.1.1/24", "1..1.1"];
  let wrong = [];
  for (const ip of bad) {
    const n = Sim.ipToInt(ip);
    if (n !== null) wrong.push(ip + " => " + n);
  }
  ok("非法 IP 全部返回 null", wrong.length === 0, JSON.stringify(wrong));
}

console.log("\n===== 3. 同网段判断（第三段 ≥ 8 的地址）=====");
{
  // 192.168.10.x 段
  ok("192.168.10.1 与 192.168.10.200 同网段",
    Sim.sameSubnet("192.168.10.1", "192.168.10.200", "255.255.255.0") === true);
  ok("192.168.10.1 与 192.168.11.1 不同网段",
    Sim.sameSubnet("192.168.10.1", "192.168.11.1", "255.255.255.0") === false);
  ok("192.168.10.1 与 192.168.20.1 不同网段",
    Sim.sameSubnet("192.168.10.1", "192.168.20.1", "255.255.255.0") === false);
  ok("192.168.100.1 与 192.168.100.99 同网段",
    Sim.sameSubnet("192.168.100.1", "192.168.100.99", "255.255.255.0") === true);
  ok("10.1.1.1 与 10.2.1.1 不同网段",
    Sim.sameSubnet("10.1.1.1", "10.2.1.1", "255.255.255.0") === false);
  ok("172.16.5.1 与 172.16.5.9 同网段",
    Sim.sameSubnet("172.16.5.1", "172.16.5.9", "255.255.255.0") === true);
}

console.log("\n===== 4. networkOf 计算 =====");
{
  ok("networkOf(192.168.10.77, /24) = 192.168.10.0",
    Sim.networkOf("192.168.10.77", "255.255.255.0") === "192.168.10.0",
    Sim.networkOf("192.168.10.77", "255.255.255.0"));
  ok("networkOf(192.168.100.77, /24) = 192.168.100.0",
    Sim.networkOf("192.168.100.77", "255.255.255.0") === "192.168.100.0",
    Sim.networkOf("192.168.100.77", "255.255.255.0"));
  ok("networkOf(10.1.2.3, /16) = 10.1.0.0",
    Sim.networkOf("10.1.2.3", "255.255.0.0") === "10.1.0.0",
    Sim.networkOf("10.1.2.3", "255.255.0.0"));
  ok("networkOf(172.16.5.9, /24) = 172.16.5.0",
    Sim.networkOf("172.16.5.9", "255.255.255.0") === "172.16.5.0",
    Sim.networkOf("172.16.5.9", "255.255.255.0"));
}

console.log("\n===== 5. DHCP 池地址边界 =====");
{
  const sw = Sim.createDevice("l3", "SW1", 0, 0);
  sw.dhcp.enabled = true;
  sw.dhcp.pools["p"] = { name: "p", network: "192.168.10.0", mask: "255.255.255.0", lease: 3600 };
  const a = Sim.dhcpAllocate(sw, "AA:00:00:00:00:01");
  ok("第一个地址是 .1", a && a.ip === "192.168.10.1", JSON.stringify(a));
  // 填满到 .253
  for (let i = 2; i <= 253; i++) {
    Sim.dhcpAllocate(sw, "AA:00:00:00:" + String(Math.floor(i / 256)).padStart(2, "0") + ":" + String(i % 256).padStart(2, "0"));
  }
  const last = Sim.dhcpAllocate(sw, "BB:00:00:00:00:01");
  ok("不会分到 .254 之后的广播地址", !last || last.ip !== "192.168.10.255", JSON.stringify(last));
  const over = Sim.dhcpAllocate(sw, "CC:00:00:00:00:01");
  ok("地址用尽返回 null", over === null, JSON.stringify(over));
  // 小子网
  const sw2 = Sim.createDevice("l3", "SW2", 0, 0);
  sw2.dhcp.enabled = true;
  sw2.dhcp.pools["s"] = { name: "s", network: "10.9.9.0", mask: "255.255.255.252", lease: 3600 };
  const got = [];
  for (let i = 0; i < 6; i++) {
    const r = Sim.dhcpAllocate(sw2, "AA:00:00:00:00:0" + i);
    got.push(r ? r.ip : null);
  }
  ok("不分配网络地址 .0", got.indexOf("10.9.9.0") < 0, JSON.stringify(got));
  ok("不分配广播地址 .3", got.indexOf("10.9.9.3") < 0, JSON.stringify(got));
  ok("只有 .1 .2 可用", got.filter(x => x !== null).length === 2, JSON.stringify(got));
}

console.log("\n===== 6. ACL 反掩码匹配（第三段 ≥ 8）=====");
{
  ok("192.168.10.0 0.0.0.255 匹配 .10.55", Sim.aclIpMatch("192.168.10.0 0.0.0.255", "192.168.10.55") === true);
  ok("192.168.10.0 0.0.0.255 不匹配 .11.55", Sim.aclIpMatch("192.168.10.0 0.0.0.255", "192.168.11.55") === false);
  ok("192.168.100.0 0.0.0.255 匹配 .100.7", Sim.aclIpMatch("192.168.100.0 0.0.0.255", "192.168.100.7") === true);
  // 0.0.255.255 是 /16 的反掩码：只比较前两段（10.0.x.x）
  ok("10.0.0.0 0.0.255.255 匹配 10.0.2.3", Sim.aclIpMatch("10.0.0.0 0.0.255.255", "10.0.2.3") === true);
  ok("10.0.0.0 0.0.255.255 不匹配 10.1.2.3", Sim.aclIpMatch("10.0.0.0 0.0.255.255", "10.1.2.3") === false);
  ok("10.0.0.0 0.255.255.255 匹配 10.1.2.3", Sim.aclIpMatch("10.0.0.0 0.255.255.255", "10.1.2.3") === true);
}

console.log("\n===== 7. 路由最长前缀匹配（第三段 ≥ 8）=====");
{
  const r = Sim.createDevice("l3", "SW1", 0, 0);
  r.vlanIf["10"] = { ip: "192.168.10.1", mask: "255.255.255.0" };
  r.vlanIf["100"] = { ip: "192.168.100.1", mask: "255.255.255.0" };
  const devices = [r];
  const hit = Sim.routeLookup(r, "192.168.10.55", devices, []);
  ok("192.168.10.55 命中 vlan10", hit && String(hit.dest) === "192.168.10.0", JSON.stringify(hit));
  const hit2 = Sim.routeLookup(r, "192.168.100.55", devices, []);
  ok("192.168.100.55 命中 vlan100", hit2 && String(hit2.dest) === "192.168.100.0", JSON.stringify(hit2));
  const miss = Sim.routeLookup(r, "192.168.200.1", devices, []);
  ok("无匹配返回 null", miss === null, JSON.stringify(miss));
}

console.log("\n===== 8. 端到端：高第三段 IP 的 ping =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.10.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.10.22"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "l1", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "l2", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("192.168.10.x 网段互通", r.ok === true, r.reason);
  // 注意：模拟器的二层隔离判据是 VLAN 广播域，不是 IP 网段
  // （课程实验 4/5 的判据就是 VLAN），因此同 VLAN 内跨 IP 网段仍可二层到达
  const pc3 = Sim.createDevice("pc", "PC3", 0, 0);
  pc3.pcIp = "192.168.20.22"; pc3.pcMask = "255.255.255.0";
  devices.push(pc3);
  links.push({ id: "l3", kind: "copper", a: { dev: sw.id, port: "e1/0/3" }, b: { dev: pc3.id, port: "eth0" } });
  const r2 = Sim.simulatePing(devices, links, pc1, pc3.pcIp);
  ok("同 VLAN 内跨 IP 网段仍二层可达（按 VLAN 判定隔离）", r2.ok === true, r2.reason);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);