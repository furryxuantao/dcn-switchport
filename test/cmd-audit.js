const path = require("path");
const join = path.join;
// 命令体系全量检查：show 系列 / 配置系列 / 显示正确性 / 关联生效
global.window = global;
require(join(__dirname, "..", "src", "sim-core.js"));
require(join(__dirname, "..", "src", "cli-engine.js"));
const Sim = global.DCNSim, CLI = global.DCNCLI;
let pass = 0, fail = 0;
const errs = [];
function ok(c, m, x) { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x ? " [" + String(x).slice(0, 120) + "]" : "")); } }

function mk(dev, devices, links) {
  const sess = CLI.createSession(dev);
  const ctx = {
    devices, links, dev, sess,
    stpInfo: () => Sim.stpCompute(devices, links),
    refreshStp: () => {},
    factoryReset: (d) => { const f = Sim.createDevice(d.type, d.hostname, d.x, d.y); f.id = d.id; Object.assign(d, f); },
    ping: (s, ip) => Sim.simulatePing(devices, links, s, ip),
    tracert: (s, ip) => Sim.simulateTracert(devices, links, s, ip),
    telnetTo: () => ""
  };
  return ctx;
}
function run(ctx, ...cmds) {
  let out = "";
  for (const c of cmds) {
    const r = CLI.execLine(ctx, c);
    if (r && r.output) out += r.output + "\n";
    if (r && r.prompt) ctx.sess._p = r.prompt;
  }
  return out;
}

/* ---------- 1. 二层交换机 show 全家桶 ---------- */
(function () {
  const sw = Sim.createDevice("l2", "Switch1", 0, 0);
  const sw2 = Sim.createDevice("l2", "Switch2", 0, 0);
  const pc = Sim.createDevice("pc", "PC1", 0, 0);
  const devs = [sw, sw2, pc];
  const links = [
    { id: "l1", a: { dev: sw.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/24" } },
    { id: "l2", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc.id, port: "eth0" } }
  ];
  const ctx = mk(sw, devs, links);
  run(ctx, "enable", "config terminal",
    "vlan 10", "name hardware", "exit",
    "vlan 20", "name software", "exit",
    "interface e1/0/1", "switchport mode access", "switchport access vlan 10", "exit",
    "interface e1/0/24", "switchport mode trunk", "exit",
    "interface vlan 1", "ip address 192.168.1.100 255.255.255.0", "exit",
    "enable password 0 abcd1234", "hostname SW-CORE", "exit");
  console.log("--- 提示符:", ctx.sess._p, "| 模式:", ctx.sess.mode);

  const t = (label, cond, out) => ok(cond, label, out);

  run(ctx, "exit"); // 到 priv
  let o = run(ctx, "show vlan");
  t("show vlan 列出 vlan 10/20", /10.*hardware/.test(o) && /20.*software/.test(o), o);
  t("show vlan 含 trunk 端口 e1/0/24", /e1\/0\/24/.test(o), o);

  o = run(ctx, "show running-config");
  t("show run 含 hostname", /hostname SW-CORE/.test(o), o);
  t("show run 含 enable password", /enable password level 15 abcd1234/.test(o), o);
  t("show run 含 vlan 名", /name hardware/.test(o), o);
  t("show run 含 vlan 接口 IP", /interface vlan1[\s\S]*192\.168\.1\.100/.test(o), o);

  o = run(ctx, "show ip interface brief");
  t("show ip int brief 有端口行", /e1\/0\/1/.test(o), o);
  t("show ip int brief 显示 vlan1 管理IP", /192\.168\.1\.100/.test(o), o);

  o = run(ctx, "show interface e1/0/1");
  t("show int e1/0/1 显示 access vlan 10", /access vlan 10/.test(o), o);
  o = run(ctx, "show interface e1/0/24");
  t("show int e1/0/24 显示 trunk", /trunk/.test(o), o);

  o = run(ctx, "show mac-address-table");
  t("show mac 表有表头", /Mac Address/.test(o), o);

  o = run(ctx, "show spanning-tree");
  t("show spanning-tree 有 MSTP 头", /MSTP Bridge Config Info/.test(o), o);

  o = run(ctx, "show port-group brief");
  t("show port-group brief 可用", /port-group/.test(o), o);

  o = run(ctx, "show monitor");
  t("show monitor 空时提示", /No monitor session/.test(o), o);

  o = run(ctx, "show port-security");
  t("show port-security 未启用提示", /No port-security/.test(o), o);

  o = run(ctx, "show flash");
  t("show flash 含 nos.img", /nos\.img/.test(o), o);

  o = run(ctx, "show ip route");
  t("二层 show ip route 有管理直连", /192\.168\.1\.0/.test(o), o);

  // 缩写
  o = run(ctx, "sh vlan"); t("缩写 sh vlan", /hardware/.test(o), o);
  o = run(ctx, "sh run"); t("缩写 sh run", /hostname/.test(o), o);
  o = run(ctx, "sh int e1/0/1"); t("缩写 sh int", /access vlan 10/.test(o), o);
  o = run(ctx, "sh mac"); t("缩写 sh mac", /Mac Address/.test(o), o);
  o = run(ctx, "sho vlan"); t("缩写 sho vlan", /hardware/.test(o), o);

  // ? 帮助（此设备设过 enable 密码，需真实走密码流程）
  run(ctx, "exit"); // 确保在 user 模式
  run(ctx, "enable");            // 提示 Password
  run(ctx, "abcd1234");          // 输入密码
  o = run(ctx, "show ?");
  t("show ? 列出子命令", /running-config/.test(o) && /vlan/.test(o), o);
  o = run(ctx, "?");
  t("裸 ? 列出当前模式命令", /config terminal/.test(o), o);
  run(ctx, "config terminal");
  o = run(ctx, "interface ?");
  t("global 下 interface ? 列出接口/vlan", /interface <port>/.test(o) && /vlan/.test(o), o);
  run(ctx, "interface e1/0/1");
  o = run(ctx, "switchport ?");
  t("接口下 switchport ? 列出子命令", /access/.test(o), o);
  run(ctx, "exit");

  // 未知命令
  o = run(ctx, "show foobar");
  t("未知 show 子命令有提示", /未知|歧义|未知show/.test(o), o);
})();

/* ---------- 2. 端口安全 / 聚合 / 镜像 关联 ---------- */
(function () {
  const sw = Sim.createDevice("l2", "SW", 0, 0);
  const devs = [sw];
  const ctx = mk(sw, devs, []);
  run(ctx, "enable", "config terminal", "mac-address-learning cpu-control",
    "interface e1/0/1", "switchport mode access", "switchport port-security",
    "switchport port-security maximum 2", "switchport port-security mac-address AA-BB-CC-DD-EE-01",
    "switchport port-security violation shutdown", "exit", "exit");
  let o = run(ctx, "show port-security");
  ok(/e1\/0\/1/.test(o) && /Shutdown/.test(o), "端口安全写入后可 show", o);
  o = run(ctx, "show port-security interface e1/0/1");
  ok(/e1\/0\/1/.test(o), "show port-security interface 过滤", o);

  // 聚合
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const c2 = mk(sw, [sw, sw2], []);
  run(c2, "enable", "config terminal", "port-group 1", "interface e1/0/1-4", "switchport mode trunk", "port-group 1 mode on", "exit", "exit", "exit");
  ok(sw.ports["e1/0/1"].aggGroup === 1 && sw.ports["e1/0/4"].aggGroup === 1, "聚合 1-4 口全部入组");
  ok(sw.portGroups["1"].ports.length === 4, "聚合组成员数为 4");
  o = run(c2, "show port-group brief");
  ok(/Number of ports/.test(o), "show port-group brief 显示成员数", o);

  // 镜像（用独立设备，避免共享状态）
  const swm = Sim.createDevice("l2", "SWM", 0, 0);
  const c3 = mk(swm, [swm, sw2], []);
  run(c3, "enable", "config terminal",
    "monitor session 1 source interface e1/0/2 both",
    "monitor session 1 destination interface e1/0/1", "exit");
  o = run(c3, "show monitor");
  ok(/Session number : 1/.test(o) && /Ethernet1\/0\/2/.test(o) && /Ethernet1\/0\/1/.test(o), "show monitor 显示源/目的", o);
  ok(swm.monitor["1"].sources[0].dir === "both" && swm.monitor["1"].dest === "e1/0/1", "镜像配置已存入");
  o = run(c3, "show running-config");
  ok(o.length > 10, "show run 在镜像配置后仍正常", o);
})();

/* ---------- 3. 路由器 show 系列 ---------- */
(function () {
  const r = Sim.createDevice("router", "RT-R1", 0, 0);
  const r2 = Sim.createDevice("router", "RT-R2", 0, 0);
  const devs = [r, r2];
  const links = [{ id: "s1", a: { dev: r.id, port: "s1/0" }, b: { dev: r2.id, port: "s1/1" }, serial: true }];
  const ctx = mk(r, devs, links);
  run(ctx, "enable", "config terminal",
    "interface g0/0", "ip address 192.168.1.254 255.255.255.0", "exit",
    "interface s1/0", "ip address 200.199.198.241 255.255.255.252", "physical-layer speed 64000", "exit",
    "ip route 0.0.0.0 0.0.0.0 200.199.198.242 50", "exit", "exit");
  ok(r.ifIp["g0/0"] && r.ifIp["g0/0"].ip === "192.168.1.254", "R1 g0/0 IP 已写入", JSON.stringify(r.ifIp));
  let o = run(ctx, "show ip interface brief");
  ok(/g0\/0/.test(o) && /192\.168\.1\.254/.test(o), "路由器 show ip int brief", o);
  ok(/s1\/0/.test(o) && /200\.199\.198\.241/.test(o), "串口 IP 显示", o);
  o = run(ctx, "show interface s1/0");
  ok(/Clock 64000/.test(o), "show int s1/0 显示 DCE 时钟", o);
  o = run(ctx, "show ip route");
  ok(/S\*/.test(o) && /0\.0\.0\.0\/0/.test(o), "默认路由 S* 显示", o);
  o = run(ctx, "show running-config");
  ok(/physical-layer speed 64000/.test(o), "show run 含时钟配置", o);
  ok(/ip route 0\.0\.0\.0/.test(o), "show run 含默认路由", o);

  // OSPF / RIP 写入后 show（先确保在 priv 模式）
  run(ctx, "enable");
  ok(/RT-R1#/.test(CLI.promptFor(r, ctx.sess)), "enable 后处于 priv 模式", CLI.promptFor(r, ctx.sess));
  run(ctx, "config terminal", "router ospf 1", "router-id 1.1.1.1", "network 192.168.1.0 255.255.255.0 area 0", "exit", "exit");
  ok(r.ospf.enabled && r.ospf.routerId === "1.1.1.1", "OSPF 配置已写入", JSON.stringify(r.ospf));
  o = run(ctx, "show run");
  ok(/router ospf 1/.test(o) && /router-id 1\.1\.1\.1/.test(o) && /area 0/.test(o), "show run 含 OSPF 配置", o);
  run(ctx, "config terminal", "router rip 1", "version 2", "auto-summary",
    "interface g0/0", "ip rip 1 enable", "exit",
    "interface s1/0", "ip rip 1 enable", "exit", "exit");
  ok(r.rip.enabled && r.rip.version === 2, "RIP 配置已写入", JSON.stringify(r.rip));
  ok(Object.keys(r.rip.enabledIfs).length === 2, "R1 两个接口均使能 RIP", JSON.stringify(r.rip.enabledIfs));
  o = run(ctx, "show running-config");
  ok(/router rip 1/.test(o) && /version 2/.test(o), "show run 含 RIP 配置", o);
  // 邻居也要开 RIP 才能互相学习
  const r2ctx = mk(r2, devs, links);
  run(r2ctx, "enable", "config terminal",
    "interface s1/1", "ip address 200.199.198.242 255.255.255.252", "exit",
    "interface g0/0", "ip address 192.168.9.254 255.255.255.0", "exit", "exit");
  ok(r2.ifIp["g0/0"] && r2.ifIp["g0/0"].ip === "192.168.9.254", "R2 g0/0 IP 已配置", JSON.stringify(r2.ifIp));
  run(r2ctx, "config terminal", "router rip 1", "version 2", "auto-summary",
    "interface s1/1", "ip rip 1 enable", "exit", "exit");
  ok(r2.rip.enabled && r2.rip.enabledIfs["s1/1"], "R2 s1/1 已使能 RIP", JSON.stringify(r2.rip.enabledIfs));
  ok(Sim.linkOperUp(devs, links[0]), "串口链路 up");
  // R1 同时配了 RIP 和 OSPF，OSPF 优先级更高 → 标记为 O（符合协议优先级语义）
  o = run(ctx, "show ip route");
  ok(/[RO]\s+192\.168\.9\.0/.test(o), "R1 通过动态路由学到 R2 的内网段", o);
  const r2out = run(r2ctx, "show ip route");
  ok(/R\s+192\.168\.1\.0/.test(r2out), "R2 通过 RIP 学到 R1 的内网段", r2out);
  // 未配 RIP 的邻居不应被学到（实验语义：双方都要配）
  const r4 = Sim.createDevice("router", "RT-R4", 0, 0);
  r4.ifIp["g0/0"] = { ip: "10.7.7.254", mask: "255.255.255.0" };
  const devs2 = [r, r4];
  const links2 = [{ id: "q", a: { dev: r.id, port: "g0/1" }, b: { dev: r4.id, port: "g0/0" } }];
  r.ifIp["g0/1"] = { ip: "10.7.7.253", mask: "255.255.255.0" };
  const t2 = Sim.buildRouteTable(r, devs2, links2);
  const learned = t2.filter((x) => x.dest === "10.7.7.0");
  ok(learned.length === 1 && learned[0].proto === "C", "邻居未开 RIP 时其网段仅为直连C，无学习路由",
    JSON.stringify(t2.map((x) => x.proto + " " + x.dest)));
})();

/* ---------- 4. 三层交换机 ---------- */
(function () {
  const l3 = Sim.createDevice("l3", "Switch6200", 0, 0);
  const ctx = mk(l3, [l3], []);
  run(ctx, "enable", "config terminal",
    "interface vlan 10", "ip address 192.168.10.254 255.255.255.0", "exit",
    "interface vlan 20", "ip address 192.168.20.254 255.255.255.0", "exit");
  let o = run(ctx, "show ip route");
  ok(/192\.168\.10\.0/.test(o) && /192\.168\.20\.0/.test(o), "三层交换机直连路由 C", o);
  o = run(ctx, "show ip interface brief");
  ok(/vlan10/.test(o) && /192\.168\.10\.254/.test(o), "三层 show ip int brief 含 vlan 接口", o);
  o = run(ctx, "show running-config");
  ok(/interface vlan10[\s\S]*192\.168\.10\.254/.test(o), "show run 含 vlan 虚接口", o);
})();

/* ---------- 5. PC 命令 ---------- */
(function () {
  const pc = Sim.createDevice("pc", "PC1", 0, 0);
  pc.pcIp = "192.168.1.11"; pc.pcMask = "255.255.255.0"; pc.pcGw = "192.168.1.254";
  const ctx = mk(pc, [pc], []);
  let o = run(ctx, "ipconfig");
  ok(/192\.168\.1\.11/.test(o), "PC ipconfig", o);
  o = run(ctx, "ipconfig /all");
  ok(/MAC/.test(o), "PC ipconfig /all 含 MAC", o);
  o = run(ctx, "?");
  ok(/tracert/.test(o), "PC ? 列出 tracert", o);
})();

/* ---------- 6. 模式机与提示符 ---------- */
(function () {
  const sw = Sim.createDevice("l2", "Switch1", 0, 0);
  const ctx = mk(sw, [sw], []);
  ok(CLI.promptFor(sw, ctx.sess) === "Switch1>", "user 模式提示符 >");
  run(ctx, "enable");
  ok(CLI.promptFor(sw, ctx.sess) === "Switch1#", "priv 提示符 #");
  run(ctx, "config terminal");
  ok(CLI.promptFor(sw, ctx.sess) === "Switch1(Config)#", "global 提示符 (Config)#");
  run(ctx, "interface e1/0/1");
  ok(/Config-if-e1\/0\/1\)#/.test(CLI.promptFor(sw, ctx.sess)), "接口提示符含端口名", CLI.promptFor(sw, ctx.sess));
  run(ctx, "exit");
  run(ctx, "vlan 10");
  ok(/Config-vlan10\)#/.test(CLI.promptFor(sw, ctx.sess)), "vlan 提示符", CLI.promptFor(sw, ctx.sess));
  run(ctx, "exit"); run(ctx, "config terminal"); run(ctx, "spanning-tree mst configuration");
  ok(/Config-mstp-region\)#/.test(CLI.promptFor(sw, ctx.sess)), "mstp 提示符", CLI.promptFor(sw, ctx.sess));
  run(ctx, "exit"); run(ctx, "config terminal"); run(ctx, "router rip 1");
  ok(/Config-rip-1\)#/.test(CLI.promptFor(sw, ctx.sess)), "rip 提示符", CLI.promptFor(sw, ctx.sess));
  // enable 密码
  const sw2 = Sim.createDevice("l2", "Switch2", 0, 0);
  const c2 = mk(sw2, [sw2], []);
  run(c2, "enable", "config terminal", "enable password 0 secret", "exit", "exit");
  run(c2, "exit"); // 退出到 user
  let r = CLI.execLine(c2, "enable");
  ok(r.needSecret === true, "有密码时 enable 要求输入密码", r.output);
  let r2 = CLI.execLine(c2, "wrong");
  ok(/密码错误/.test(r2.output), "错误密码被拒");
  // 重新 enable 再输正确密码
  CLI.execLine(c2, "enable");
  CLI.execLine(c2, "secret");
  ok(/#$/.test(CLI.promptFor(sw2, c2.sess)), "正确密码进入特权", CLI.promptFor(sw2, c2.sess));
})();

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
if (errs.length) console.log(errs);
process.exit(fail ? 1 : 0);