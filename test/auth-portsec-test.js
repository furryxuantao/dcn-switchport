// Telnet/SSH 登录流程与端口安全的端到端行为
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
    ping: (d, ip) => Sim.simulatePing(devices || [d], links || [], d, ip),
    tracert: () => ({ ok: false, hops: [] }), telnetTo: () => "", telnetTo2: () => "",
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

console.log("\n===== 1. 用户管理 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "username xuxp password 0 digital",
    "username admin password 7 encrypted",
    "@priv", "show users"
  ]);
  ok("创建了两个用户", sw.users.length === 2, JSON.stringify(sw.users));
  ok("用户 xuxp 已建", !!sw.users.find(u => u.name === "xuxp"));
  ok("密码加密标记 7", sw.users.find(u => u.name === "admin").enc === "7",
    sw.users.find(u => u.name === "admin").enc);
  ok("明文标记 0", sw.users.find(u => u.name === "xuxp").enc === "0");
  const t = out[out.length - 1].output;
  ok("show users 列出用户", t.indexOf("xuxp") >= 0 && t.indexOf("admin") >= 0, t);
  ok("show users 显示加密状态", t.indexOf("encrypted") >= 0 || t.indexOf("clear text") >= 0, t);
  // 重复用户应覆盖
  run(sw, ["@global", "username xuxp password 0 newpass"]);
  ok("重复用户被覆盖", sw.users.filter(u => u.name === "xuxp").length === 1);
  // 删除
  run(sw, ["@global", "no username xuxp"]);
  ok("删除用户生效", !sw.users.find(u => u.name === "xuxp"));
  // 超长用户名
  const bad = run(sw, ["@global", "username " + "a".repeat(20) + " password 0 x"]);
  ok("超长用户名被拒", bad.out[0].output.indexOf("16") >= 0, bad.out[0].output);
}

console.log("\n===== 2. enable 密码流程 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, ["@global", "enable password 0 secret123"]);
  ok("enable 密码已设置", sw.enablePassword === "secret123", sw.enablePassword);
  ok("明文标记 0", sw.enableEnc === "0", sw.enableEnc);
  const c = ctxOf(sw);
  c.sess.mode = "user";
  const r1 = CLI.execLine(c, "enable");
  ok("要求输入密码", r1.needSecret === true, JSON.stringify(r1));
  ok("提示 Password:", (r1.output || "").indexOf("Password") >= 0, r1.output);
  // 错误密码
  c.sess.pendingEnable = true;
  const r2 = CLI.execLine(c, "wrongpass");
  ok("错误密码被拒", (r2.output || "").indexOf("Invalid password") >= 0, r2.output);
  ok("错误后回到 user 模式", c.sess.mode === "user", c.sess.mode);
  // 正确密码
  c.sess.pendingEnable = true;
  const r3 = CLI.execLine(c, "secret123");
  ok("正确密码进入 priv", c.sess.mode === "priv", c.sess.mode);
  ok("标记已认证", c.sess.authed === true);
  ok("提示符带 #", /#$/.test(r3.prompt || ""), r3.prompt);
}
{
  // 改密码后旧登录态失效
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw);
  // 先在全局模式设置 enable 密码
  c.sess.mode = "global";
  CLI.execLine(c, "enable password 0 pw");
  ok("enable 密码已设置", sw.enablePassword === "pw", sw.enablePassword);
  ok("enableEnc 记录为 0", sw.enableEnc === "0", String(sw.enableEnc));
  // 回到 user 模式登录
  c.sess.mode = "user";
  c.sess.authed = true;
  CLI.execLine(c, "enable");
  c.sess.pendingEnable = true;
  CLI.execLine(c, "pw");
  ok("正确密码进入 priv", c.sess.mode === "priv", c.sess.mode);
  c.sess.mode = "global";
  CLI.execLine(c, "enable password 7 newpw");
  ok("改密码后认证态失效", c.sess.authed === false);
  ok("enableEnc 更新为 7", sw.enableEnc === "7", String(sw.enableEnc));
}

console.log("\n===== 3. Telnet / SSH 服务开关 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "no telnet-server enable", "no ssh-server enable",
    "telnet-server max-connection 4", "ssh-server max-connection 2"
  ]);
  ok("telnet 已关闭", sw.telnet.enabled === false);
  ok("ssh 已关闭", sw.ssh.enabled === false);
  ok("telnet 最大连接数", sw.telnet.maxConn === 4, String(sw.telnet.maxConn));
  ok("ssh 最大连接数", sw.ssh.maxConn === 2, String(sw.ssh.maxConn));
  run(sw, ["@global", "telnet-server enable", "ssh-server enable"]);
  ok("telnet 可重新开启", sw.telnet.enabled === true);
  ok("ssh 可重新开启", sw.ssh.enabled === true);
}

console.log("\n===== 4. 端口安全完整链路（实验 3）=====");
{
  // Switch1 的 e1/0/1 配了端口安全，maximum 1
  const sw = Sim.createDevice("l2", "Switch1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.10.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.10.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  // 按课程配置
  run(sw, [
    "@global", "mac-address-learning cpu-control",
    "interface e1/0/1", "switchport mode access", "switchport port-security",
    "switchport port-security maximum 1", "exit"
  ], devices, links);
  ok("端口安全已启用", sw.ports["e1/0/1"].portSecurity.enabled === true);
  ok("maximum = 1", sw.ports["e1/0/1"].portSecurity.max === 1);
  // PC1 正常使用
  let r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("PC1 正常通信", r.ok === true, r.reason);
  ok("端口未违例", !sw.ports["e1/0/1"].violated);
  // 把 PC2 挪到 e1/0/1（换线）
  links[1].a.port = "e1/0/1";
  r = Sim.simulatePing(devices, links, pc2, pc1.pcIp);
  ok("PC2 接入后违例", sw.ports["e1/0/1"].violated === true,
    "violated=" + sw.ports["e1/0/1"].violated);
  ok("端口被 shutdown", sw.ports["e1/0/1"].shutdown === true);
  ok("通信被阻断", r.ok === false, r.reason);
  ok("原因点名端口安全违例", r.reason.indexOf("端口安全违例") >= 0, r.reason);
  // no shutdown 恢复
  run(sw, ["@global", "interface e1/0/1", "no shutdown", "exit"], devices, links);
  ok("no shutdown 解除 shutdown", sw.ports["e1/0/1"].shutdown === false);
  // 换回 PC1
  links[1].a.port = "e1/0/2";
  r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("换回 PC1 后恢复通信", r.ok === true, r.reason);
}

console.log("\n===== 5. 端口安全静态 MAC 绑定 =====");
{
  const sw = Sim.createDevice("l2", "Switch1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.10.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.10.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  run(sw, [
    "@global", "interface e1/0/1", "switchport port-security",
    "switchport port-security mac-address " + pc1.pcMac, "exit"
  ], devices, links);
  ok("静态 MAC 已绑定", sw.ports["e1/0/1"].portSecurity.staticMacs.length === 1,
    JSON.stringify(sw.ports["e1/0/1"].portSecurity.staticMacs));
  ok("绑定的就是 PC1 的 MAC", sw.ports["e1/0/1"].portSecurity.staticMacs[0] === pc1.pcMac,
    sw.ports["e1/0/1"].portSecurity.staticMacs[0]);
  // PC1 正常
  let r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("白名单主机正常", r.ok === true, r.reason);
  // PC2 换到 e1/0/1 → 违例
  links[1].a.port = "e1/0/1";
  r = Sim.simulatePing(devices, links, pc2, pc1.pcIp);
  ok("非白名单主机违例", sw.ports["e1/0/1"].violated === true);
  ok("端口 shutdown", sw.ports["e1/0/1"].shutdown === true);
  ok("原因提到不在静态列表", r.reason.indexOf("静态") >= 0 || r.reason.indexOf("违例") >= 0, r.reason);
}

console.log("\n===== 6. show port-security 反映真实状态 =====");
{
  const sw = Sim.createDevice("l2", "Switch1", 0, 0);
  run(sw, ["@global", "interface e1/0/1", "switchport port-security",
    "switchport port-security maximum 3", "exit"]);
  const c = ctxOf(sw);
  c.sess.mode = "priv";
  const t = CLI.execLine(c, "show port-security").output;
  ok("显示端口", t.indexOf("e1/0/1") >= 0, t);
  ok("显示最大地址数 3", /3/.test(t), t);
  const t2 = CLI.execLine(c, "show port-security interface e1/0/1").output;
  ok("按接口过滤可用", t2.indexOf("e1/0/1") >= 0, t2);
}

console.log("\n===== 7. 认证与既有功能不受影响 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", kind: "copper", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("默认配置互通不受影响", r.ok === true, r.reason);
  // 未配端口安全时 MAC 数量不限制
  ok("未配端口安全不违例", !sw.ports["e1/0/1"].violated);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);