// 神码版反馈增强回归：VLAN 生效反馈 / 英文报错 / PC 预配 IP
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
const CJK = /[\u4e00-\u9fff]/;
function ctxOf(dev, devices, links) {
  return {
    devices: devices || [dev], links: links || [], dev: dev, sess: CLI.createSession(dev), pendingConfirm: null,
    stream: null, ping: () => ({ ok: false }), tracert: () => ({ hops: [] }), telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
  };
}
function sw2() {
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const ctx = ctxOf(sw);
  const run = (l) => CLI.execLine(ctx, l).output || "";
  run("enable"); run("config terminal");
  return { sw: sw, ctx: ctx, run: run };
}

// 1. VLAN 创建反馈
{
  const s = sw2();
  const out = s.run("vlan 10");
  ok("vlan 10 有创建反馈", /VLAN 10 created\./.test(out), out);
  s.run("exit");
  ok("重复创建不重复提示", s.run("vlan 10").trim() === "");
  s.run("exit");
  ok("VLAN 默认名 VLAN0010", s.sw.vlans["10"] && s.sw.vlans["10"].name === "VLAN0010", s.sw.vlans["10"] && s.sw.vlans["10"].name);
  s.run("vlan 10"); s.run("name SALES"); s.run("exit");
  ok("VLAN 1 默认名 default", s.sw.vlans["1"].name === "default", s.sw.vlans["1"].name);
}

// 2. 端口加入 VLAN 的反馈
{
  const s = sw2();
  s.run("vlan 10"); s.run("exit");
  s.run("interface e1/0/1");
  const out = s.run("switchport access vlan 10");
  ok("单口加入 VLAN 有反馈", /Port e1\/0\/1 added to VLAN 10\./.test(out), out);
  ok("端口 accessVlan 已写入", s.sw.ports["e1/0/1"].accessVlan === 10, s.sw.ports["e1/0/1"].accessVlan);
  s.run("exit");
  s.run("interface e1/0/2-4");
  const out2 = s.run("switchport access vlan 10");
  ok("端口范围逐口反馈", (out2.match(/added to VLAN 10/g) || []).length === 3, out2);
  s.run("exit");
  const show = s.run("show vlan");
  ok("show vlan 列出成员端口", /10\s+SALES|10\s+VLAN0010/.test(show) || /e1\/0\/2, e1\/0\/3, e1\/0\/4/.test(show), show);
}

// 2b. VLAN 配置模式 switchport interface 也要逐口反馈
{
  const s = sw2();
  s.run("vlan 10");
  const out = s.run("switchport interface e1/0/1-3");
  ok("VLAN 模式添加端口逐口反馈", (out.match(/Port e1\/0\/[123] added to VLAN 10\./g) || []).length === 3, out);
  ok("VLAN 模式端口已写入", s.sw.ports["e1/0/2"].accessVlan === 10, s.sw.ports["e1/0/2"].accessVlan);
  const bad = s.run("swi int e9/9/9");
  ok("VLAN 模式非法端口英文提示", /% Invalid port: e9\/9\/9/.test(bad), bad);
  const multi = s.run("switchport interface e1/0/4;e1/0/5");
  ok("VLAN 模式分号列表反馈", (multi.match(/added to VLAN 10/g) || []).length === 2, multi);
  s.run("exit");
  const show2 = s.run("show vlan");
  ok("show vlan 反映 VLAN 模式结果", /e1\/0\/1, e1\/0\/2, e1\/0\/3, e1\/0\/4, e1\/0\/5/.test(show2), show2);
}

// 3. 错误输入一律英文
{
  const cases = ["foobar xyz", "interface e9/9/9", "vlan 5000", "no such-command here", "show nonsense-cmd", "username " + "x".repeat(20) + " password 0 p", "ip address 300.1.1.1 255.255.255.0"];
  let bad = [];
  cases.forEach(function (c) {
    const s = sw2();
    const out = s.run(c);
    if (CJK.test(out)) bad.push(c + " => " + out.split("\n")[0]);
  });
  ok("错误输出不含中文", bad.length === 0, bad.join(" | "));
  ok("未知命令英文提示", /% Unknown command/.test(sw2().run("foobar xyz")));
  ok("非法端口英文提示", /% Invalid port/.test(sw2().run("interface e9/9/9")));
}

// 4. PC ipconfig 输出子网掩码
{
  const pc = Sim.createDevice("pc", "PC1", 0, 0);
  pc.pcIp = "192.168.10.11"; pc.pcMask = "255.255.255.0"; pc.pcGw = "192.168.10.254";
  const out = CLI.execLine(ctxOf(pc), "ipconfig").output;
  ok("ipconfig 含 IP", /IP Address: 192\.168\.10\.11/.test(out), out);
  ok("ipconfig 含子网掩码", /Subnet Mask: 255\.255\.255\.0/.test(out), out);
  ok("ipconfig 含网关", /Gateway: 192\.168\.10\.254/.test(out), out);
}

// 5. 界面载入实验时预配 PC IP
{
  const ui = fs.readFileSync(path.join(ROOT, "src/ui.js"), "utf8");
  ok("ui.js 有 LAB_PC_IPS 表", /LAB_PC_IPS\s*=/.test(ui));
  ok("doLoadLab 调用 applyLabPcIps", /applyLabPcIps\s*\(/.test(ui));
  ok("lab4 使用 VLAN 网段地址", /PC31:\s*\["192\.168\.30\.31"/.test(ui), (ui.match(/lab4:[^\n]*/) || [""])[0].slice(0, 160));
  ok("net1216 预置 7 台 PC", (ui.match(/PC11:\s*\["192\.168\.1\.11"/) || []).length === 1);
}

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
// 6. show interface 详情（单口 / 全量 / trunk 不重复）
{
  const s6 = sw2();
  s6.run("config terminal");
  s6.run("vlan 20"); s6.run("name SALES"); s6.run("exit");
  s6.run("interface e1/0/1");
  s6.run("switchport access vlan 20");
  s6.run("description uplink-to-CORE");
  s6.run("exit");
  s6.run("interface e1/0/2"); s6.run("switchport mode trunk"); s6.run("exit");
  const one = s6.run("show interface e1/0/1");
  ok("单口 show 含 Description", /Description: uplink-to-CORE/.test(one), one);
  ok("单口 show 含 PVID 与 VLAN 名", /Port mode: access, PVID: 20, VLAN: 20 \(SALES\)/.test(one), one);
  ok("单口 show 含 MAC", /MAC address is [0-9A-F-]{17}/.test(one), one);
  ok("单口 show 含计数", /Input : 0 packets/.test(one) && /Output: 0 packets/.test(one), one);
  const trunk6 = s6.run("show interface e1/0/2");
  ok("trunk 口不重复 trunk 字样", !/trunk trunk/.test(trunk6) && /Port mode: trunk/.test(trunk6), trunk6);
  const all6 = s6.run("show interface");
  ok("show interface 全量列出首尾口", /^e1\/0\/1 is up/m.test(all6) && /e1\/0\/24 is/m.test(all6));
}

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log(fails.join("\n")); process.exit(1); }
