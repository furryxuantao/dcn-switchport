// 思科对标增强 批次3：设备管理与运维
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
  return {
    devices: [dev], links: [], dev: dev, sess: CLI.createSession(dev), pendingConfirm: null,
    stream: null, ping: () => ({ ok: false }), tracert: () => ({ hops: [] }), telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
  };
}
function run(dev, cmds) {
  const c = ctxOf(dev);
  const out = [];
  for (const cmd of cmds) {
    if (cmd === "@global") { c.sess.mode = "global"; continue; }
    if (cmd === "@priv") { c.sess.mode = "priv"; continue; }
    const r = CLI.execLine(c, cmd);
    out.push({ cmd: cmd, output: r.output || "", prompt: r.prompt, mode: c.sess.mode });
  }
  return { out: out, ctx: c };
}

console.log("\n===== 1. show version / device-info =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const c = ctxOf(sw); c.sess.mode = "priv";
  const v = CLI.execLine(c, "show version").output;
  ok("show version 含设备名", v.indexOf("SW1") >= 0, v);
  ok("show version 含神州数码", v.indexOf("神州数码") >= 0, v);
  ok("show version 含 uptime", v.indexOf("uptime") >= 0, v);
  ok("show version 含系统镜像", v.indexOf("nos.img") >= 0, v);
  ok("show version 含配置寄存器", v.indexOf("config-register") >= 0 || v.indexOf("Configuration register") >= 0, v);
  const d = CLI.execLine(c, "show device-info").output;
  ok("device-info 含设备名", d.indexOf("SW1") >= 0, d);
  ok("device-info 含端口数", d.indexOf("端口总数") >= 0, d);
  ok("device-info 含 MAC 地址", d.indexOf("MAC 地址") >= 0, d);
  ok("device-info 含设备型号", d.indexOf("DCS-") >= 0, d);
}

console.log("\n===== 2. 日志（syslog）=====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "logging host 192.168.1.100", "logging trap warnings", "logging timestamps",
    "@priv", "show logging"
  ]);
  ok("日志已启用", sw.logging.enabled === true);
  ok("日志服务器已记录", sw.logging.servers.indexOf("192.168.1.100") >= 0, JSON.stringify(sw.logging.servers));
  ok("日志级别已设置", sw.logging.consoleLevel === "warnings", sw.logging.consoleLevel);
  ok("时间戳已开启", sw.logging.timestamps === true);
  const t = out[out.length - 1].output;
  ok("show logging 含服务器", t.indexOf("192.168.1.100") >= 0, t);
  ok("show logging 含级别", t.indexOf("warnings") >= 0, t);
  // 非法级别
  const bad = run(sw, ["@global", "logging trap xxx"]);
  ok("非法日志级别被拒", bad.out[0].output.indexOf("emergencies") >= 0, bad.out[0].output);
  // 非法 IP
  const bad2 = run(sw, ["@global", "logging host 999.1.1.1"]);
  ok("非法日志服务器 IP 被拒", bad2.out[0].output.indexOf("用法") >= 0, bad2.out[0].output);
  // 关闭
  run(sw, ["@global", "no logging"]);
  ok("no logging 关闭", sw.logging.enabled === false && sw.logging.servers.length === 0);
}

console.log("\n===== 3. 时钟与 NTP =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "clock timezone 8", "ntp server 192.168.1.1",
    "@priv", "show clock"
  ]);
  ok("时区已设置", sw.clock.timezone === 8, String(sw.clock.timezone));
  ok("NTP 已启用", sw.ntp.enabled === true);
  ok("NTP 服务器已记录", sw.ntp.servers.indexOf("192.168.1.1") >= 0, JSON.stringify(sw.ntp.servers));
  const t = out[out.length - 1].output;
  ok("show clock 含时间", /\d\d:\d\d:\d\d/.test(t), t);
  ok("show clock 含时区", t.indexOf("+8") >= 0, t);
  ok("show clock 含 NTP 服务器", t.indexOf("192.168.1.1") >= 0, t);
  // 非法时区
  const bad = run(sw, ["@global", "clock timezone 99"]);
  ok("非法时区被拒", bad.out[0].output.indexOf("-12") >= 0, bad.out[0].output);
}

console.log("\n===== 4. AAA =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "aaa new-model", "aaa authentication login local",
    "tacacs-server host 10.0.0.5", "radius-server host 10.0.0.6",
    "@priv", "show aaa"
  ]);
  ok("AAA 已启用", sw.aaa.enabled === true);
  ok("认证方式已设置", sw.aaa.methods === "local", sw.aaa.methods);
  ok("TACACS+ 服务器已记录", sw.tacacs.enabled && sw.tacacs.servers.indexOf("10.0.0.5") >= 0,
    JSON.stringify(sw.tacacs));
  ok("RADIUS 服务器已记录", sw.radius.enabled && sw.radius.servers.indexOf("10.0.0.6") >= 0,
    JSON.stringify(sw.radius));
  const t = out[out.length - 1].output;
  ok("show aaa 含协议", t.indexOf("Protocol") >= 0, t);
  ok("show aaa 含 TACACS 服务器", t.indexOf("10.0.0.5") >= 0, t);
  ok("show aaa 含 RADIUS 服务器", t.indexOf("10.0.0.6") >= 0, t);
  // AAA 走 tacacs 时自动启用 tacacs
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  run(sw2, ["@global", "aaa authentication login tacacs"]);
  ok("AAA 指定 tacacs 会启用 TACACS+", sw2.tacacs.enabled === true);
  const sw3 = Sim.createDevice("l2", "SW3", 0, 0);
  run(sw3, ["@global", "aaa authentication login radius"]);
  ok("AAA 指定 radius 会启用 RADIUS", sw3.radius.enabled === true);
}

console.log("\n===== 5. SNMPv3 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, ["@global", "snmp-server user monitor grp1 auth sha mypass priv aes 128 mypriv"]);
  ok("SNMPv3 已启用", sw.snmpv3.enabled === true);
  ok("SNMPv3 用户", sw.snmpv3.user === "monitor", sw.snmpv3.user);
  ok("SNMPv3 组", sw.snmpv3.group === "grp1", sw.snmpv3.group);
  run(sw, ["@global", "snmp-server group grp2 v3 priv"]);
  ok("SNMPv3 组可单独配置", sw.snmpv3.group === "grp2", sw.snmpv3.group);
}

console.log("\n===== 6. 用户与特权级 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "username admin privilege 15 0 adminpass",
    "username guest password 0 guest123",
    "@priv", "show users"
  ]);
  ok("admin 用户已建", sw.users.some(u => u.name === "admin"), JSON.stringify(sw.users));
  ok("admin 特权级 15", sw.users.find(u => u.name === "admin").privilege === 15,
    String(sw.users.find(u => u.name === "admin").privilege));
  ok("guest 用户已建", sw.users.some(u => u.name === "guest"));
  ok("guest 默认特权级 1", sw.users.find(u => u.name === "guest").privilege === 1,
    String(sw.users.find(u => u.name === "guest").privilege));
  const t = out[out.length - 1].output;
  ok("show users 列出用户", t.indexOf("admin") >= 0 && t.indexOf("guest") >= 0, t);
  ok("show users 显示特权级", t.indexOf("15") >= 0, t);
  // 越界特权级
  const bad = run(sw, ["@global", "username x privilege 99 0 p"]);
  ok("越界特权级被拒", bad.out[0].output.indexOf("0~15") >= 0, bad.out[0].output);
}

console.log("\n===== 7. 横幅与配置寄存器 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  run(sw, ["@global", "banner motd 欢迎使用神州数码交换机", "config-register 0x102"]);
  ok("横幅已保存", sw.banner.motd.indexOf("欢迎") >= 0, sw.banner.motd);
  ok("配置寄存器已保存", sw.configRegister === "0x102", sw.configRegister);
  run(sw, ["@global", "service password-recovery", "service timestamps", "history size 50"]);
  ok("密码恢复已开启", sw.servicePasswordRecovery === true);
  ok("命令历史条数", sw.historySize === 50, String(sw.historySize));
}

console.log("\n===== 8. 缩写兼容 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const { out } = run(sw, [
    "@global", "logging host 1.1.1.1", "clock timezone 8", "ntp server 2.2.2.2",
    "aaa new-model", "banner motd HI",
    "@priv", "sh ver", "sh device", "sh logg", "sh clock", "sh aaa", "sh users"
  ]);
  ok("缩写 logging host", sw.logging.servers.length === 1);
  ok("缩写 clock timezone", sw.clock.timezone === 8);
  ok("缩写 ntp server", sw.ntp.servers.length === 1);
  ok("缩写 aaa new-model", sw.aaa.enabled === true);
  ok("缩写 banner motd", sw.banner.motd === "HI");
  const shows = out.slice(-6).map(o => o.output);
  ok("6 条 show 缩写全部有效", shows.every(s => s && s.length > 0 &&
    s.indexOf("未知") < 0 && s.indexOf("歧义") < 0), JSON.stringify(shows.map(s => s.slice(0, 25))));
}

console.log("\n===== 9. TAB 候选 =====");
{
  const g = CLI.candidatesFor("global").map(x => x.raw);
  ok("global TAB 有 logging host", g.some(x => x.indexOf("logging host") === 0));
  ok("global TAB 有 clock timezone", g.some(x => x.indexOf("clock timezone") === 0));
  ok("global TAB 有 ntp server", g.some(x => x.indexOf("ntp server") === 0));
  ok("global TAB 有 aaa new-model", g.some(x => x.indexOf("aaa new-model") === 0));
  ok("global TAB 有 banner motd", g.some(x => x.indexOf("banner motd") === 0));
  ok("global TAB 有 tacacs-server host", g.some(x => x.indexOf("tacacs-server host") === 0));
  ok("global TAB 有 radius-server host", g.some(x => x.indexOf("radius-server host") === 0));
  const p = CLI.candidatesFor("priv").map(x => x.raw);
  ok("priv TAB 有 show version", p.indexOf("show version") >= 0);
  ok("priv TAB 有 show device-info", p.indexOf("show device-info") >= 0);
  ok("priv TAB 有 show logging", p.indexOf("show logging") >= 0);
  ok("priv TAB 有 show clock", p.indexOf("show clock") >= 0);
  ok("priv TAB 有 show aaa", p.indexOf("show aaa") >= 0);
  ok("priv TAB 有 show users", p.indexOf("show users") >= 0);
}

console.log("\n===== 10. 既有功能不受影响 =====");
{
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  // 课程的用户名命令仍工作
  run(sw, ["@global", "username test password 0 12345"]);
  ok("课程 username 命令仍工作", sw.users.length === 1 && sw.users[0].name === "test");
  ok("默认 privilege 1", sw.users[0].privilege === 1);
  // telnet/ssh 开关仍工作
  run(sw, ["@global", "no telnet-server enable", "no ssh-server enable"]);
  ok("telnet 关闭仍生效", sw.telnet.enabled === false);
  ok("ssh 关闭仍生效", sw.ssh.enabled === false);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);