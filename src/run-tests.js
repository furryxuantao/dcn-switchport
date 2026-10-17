// node 单测：缩写 + 核心命令（无需 npm install）
global.window = global;
require("./sim-core.js");
require("./cli-engine.js");
var Sim = global.DCNSim, CLI = global.DCNCLI;
var pass = 0, fail = 0;
function ok(cond, msg) { if (cond) { pass++; console.log("PASS " + msg); } else { fail++; console.log("FAIL " + msg); } }
function mkCtx(dev, devices, links) {
  var sess = CLI.createSession(dev);
  var stp = Sim.stpCompute(devices, links);
  return { devices: devices, links: links, dev: dev, sess: sess,
    stpInfo: function(){ return Sim.stpCompute(devices, links); },
    refreshStp: function(){}, factoryReset: function(){},
    ping: function(s, ip){ return Sim.simulatePing(devices, links, s, ip); },
    tracert: function(s, ip){ return Sim.simulateTracert(devices, links, s, ip); },
    telnetTo: function(){ return "ok"; } };
}
(function(){
  var sw = Sim.createDevice("l2", "Switch", 0, 0);
  var ctx = mkCtx(sw, [sw], []);
  function cmd(l){ return CLI.execLine(ctx, l); }
  // 缩写：en -> priv
  cmd("en");
  ok(ctx.sess.mode === "priv", "缩写 en 进入特权");
  cmd("conf t");
  ok(ctx.sess.mode === "global", "缩写 conf t 进入全局");
  cmd("vlan 10");
  ok(ctx.sess.mode === "vlan" && sw.vlans["10"], "vlan 10 建VLAN并进vlan模式");
  cmd("exit"); // 回global
  cmd("int e1/0/1");
  ok(ctx.sess.mode === "if" && ctx.sess.ifPorts[0] === "e1/0/1", "缩写 int e1/0/1 进接口");
  cmd("swi mode acc");
  ok(sw.ports["e1/0/1"].mode === "access", "缩写 swi mode acc");
  cmd("swi acc vlan 10");
  ok(sw.ports["e1/0/1"].accessVlan === 10, "缩写 swi acc vlan 10");
  cmd("exit");
  cmd("exit"); // 回priv
  var r = cmd("sh run");
  ok(/hostname/.test(r.output), "缩写 sh run 显示配置");
  var r2 = cmd("sh vlan");
  ok(/10/.test(r2.output), "sh vlan 含10");
  // no shut 缩写
  cmd("conf t"); cmd("int e1/0/1"); cmd("shutd");
  ok(sw.ports["e1/0/1"].shutdown === true, "实验报告写法 shutd 关闭端口");
  cmd("no shut");
  ok(sw.ports["e1/0/1"].shutdown === false, "缩写 no shut 打开");
  cmd("exit"); cmd("exit");
  // spanning-tree + priority 校验
  cmd("conf t"); cmd("spanning-tree");
  ok(sw.stp.enabled, "spanning-tree 开启");
  cmd("spanning-tree mst 10 priority 4096");
  ok(sw.stp.priorities["10"] === 4096, "mst priority 4096倍数通过");
  var bad = cmd("spanning-tree mst 10 priority 5000");
  ok(/4096/.test(bad.output), "priority 非4096倍数拒绝");
  cmd("exit");
  // ip route
  var rt = Sim.createDevice("router", "Router", 0, 0);
  var ctx2 = mkCtx(rt, [rt], []);
  CLI.execLine(ctx2, "enable"); CLI.execLine(ctx2, "config terminal");
  CLI.execLine(ctx2, "ip route 192.168.1.0 255.255.255.0 200.199.198.241");
  ok(rt.staticRoutes.length === 1, "ip route 静态写入");
  CLI.execLine(ctx2, "ip route 0.0.0.0 0.0.0.0 200.199.198.246 50");
  ok(rt.staticRoutes[1].dist === 50, "备份默认路由距离50");
  // RIP
  CLI.execLine(ctx2, "router rip 1");
  ok(ctx2.sess.mode === "rip" && rt.rip.enabled, "router rip 进rip模式");
  CLI.execLine(ctx2, "version 2");
  ok(rt.rip.version === 2, "RIP version 2");
  // OSPF
  var ctx3 = mkCtx(rt, [rt], []);
  ctx3.sess.mode = "global";
  CLI.execLine(ctx3, "router ospf 1");
  ok(ctx3.sess.mode === "ospf", "router ospf 进ospf");
  CLI.execLine(ctx3, "router-id 1.1.1.1");
  ok(rt.ospf.routerId === "1.1.1.1", "router-id 设置");
  CLI.execLine(ctx3, "network 192.168.1.0 255.255.255.0 area 0");
  ok(rt.ospf.networks.length >= 1, "ospf network 宣告");
  // 端口安全缩写
  var sw2 = Sim.createDevice("l2", "S", 0, 0);
  var c4 = mkCtx(sw2, [sw2], []); CLI.execLine(c4, "enable"); CLI.execLine(c4, "config terminal");
  CLI.execLine(c4, "mac-address-learning cpu-control");
  CLI.execLine(c4, "interface e1/0/1");
  CLI.execLine(c4, "swi mode acc"); CLI.execLine(c4, "swi port-sec"); CLI.execLine(c4, "swi port-sec max 1");
  ok(sw2.ports["e1/0/1"].portSecurity.enabled && sw2.ports["e1/0/1"].portSecurity.max === 1, "端口安全缩写 swi port-sec max");
  // 聚合
  var c5 = mkCtx(sw2, [sw2], []); c5.sess.mode = "global";
  CLI.execLine(c5, "port-group 1");
  c5.sess.mode = "global"; CLI.execLine(c5, "interface e1/0/1-4");
  CLI.execLine(c5, "port-group 1 mode on");
  ok(sw2.ports["e1/0/1"].aggGroup === 1, "聚合 port-group mode on");
  // 镜像
  c5.sess.mode = "global";
  CLI.execLine(c5, "monitor session 1 source interface e1/0/2 both");
  CLI.execLine(c5, "monitor session 1 destination interface e1/0/1");
  ok(sw2.monitor["1"] && sw2.monitor["1"].dest === "e1/0/1", "镜像 source/destination");
  console.log("\\n==== " + pass + " passed, " + fail + " failed ====");
  process.exit(fail ? 1 : 0);
})();
