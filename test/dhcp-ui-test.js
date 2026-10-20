// DHCP 服务器分配 / 中继转发 / 端口安全 UI 联动的检查
const fs = require("fs");
const path = require("path");
const ROOT = path.join("E:\\network\\dcn-simulator");
const { JSDOM, VirtualConsole } = require(path.join(ROOT, "test", "node_modules", "jsdom"));

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf-8");
const errs = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errs.push("jsdomError: " + (e.stack || e.message)));
vc.on("error", (...a) => errs.push("console.error: " + a.join(" ")));
const dom = new JSDOM(html, {
  url: "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"),
  runScripts: "dangerously", resources: "usable", pretendToBeVisual: true, virtualConsole: vc
});
const win = dom.window, d = win.document;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}

(async () => {
  await wait(800);
  const App = win.DCNApp;
  const C = win.DCNCLI;
  const Sim = win.DCNSim;

  console.log("\n===== 1. DHCP 服务器：客户端能拿到地址 =====");
  {
    const sw = Sim.createDevice("l3", "SW1", 0, 0);
    const ctx = {
      devices: [sw], links: [], dev: sw, sess: C.createSession(sw), pendingConfirm: null,
      stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
      factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
    };
    ctx.sess.mode = "global";
    C.execLine(ctx, "service dhcp");
    C.execLine(ctx, "ip dhcp pool office");
    C.execLine(ctx, "network 192.168.10.0 255.255.255.0");
    C.execLine(ctx, "default-router 192.168.10.254");
    C.execLine(ctx, "dns-server 8.8.8.8");
    C.execLine(ctx, "lease 7200");
    C.execLine(ctx, "range 192.168.10.100 192.168.10.200");
    C.execLine(ctx, "exit");
    ok("DHCP 服务已开启", sw.dhcp.enabled === true);
    const pool = sw.dhcp.pools["office"];
    ok("地址池已创建", !!pool, JSON.stringify(Object.keys(sw.dhcp.pools)));
    ok("网段/掩码正确", pool.network === "192.168.10.0" && pool.mask === "255.255.255.0");
    ok("网关正确", pool.gateway === "192.168.10.254");
    ok("DNS 正确", pool.dns === "8.8.8.8");
    ok("租期正确", pool.lease === 7200);
    ok("地址范围正确", pool.start === "192.168.10.100" && pool.end === "192.168.10.200");
    // 分配
    const a = Sim.dhcpAllocate(sw, "AA:AA:AA:AA:AA:AA");
    ok("分配到地址", !!a && a.ip === "192.168.10.100", JSON.stringify(a));
    ok("绑定记录 pool", a && a.pool === "office");
    const b = Sim.dhcpAllocate(sw, "BB:BB:BB:BB:BB:BB");
    ok("第二个客户端拿到下一个地址", b && b.ip === "192.168.10.101", JSON.stringify(b));
    // 排除地址
    sw.dhcp.excluded = ["192.168.10.101"];
    const c = Sim.dhcpAllocate(sw, "CC:CC:CC:CC:CC:CC");
    ok("跳过排除地址", c && c.ip === "192.168.10.102", JSON.stringify(c));
    // show
    ctx.sess.mode = "priv";
    const t = C.execLine(ctx, "show ip dhcp binding").output;
    ok("show ip dhcp binding 列出绑定", t.indexOf("192.168.10.100") >= 0, t);
    const t2 = C.execLine(ctx, "show ip dhcp pool").output;
    ok("show ip dhcp pool 列出池", t2.indexOf("office") >= 0, t2);
  }

  console.log("\n===== 2. DHCP 中继：helper-address 记录与展示 =====");
  {
    const sw = Sim.createDevice("l3", "SW1", 0, 0);
    const ctx = {
      devices: [sw], links: [], dev: sw, sess: C.createSession(sw), pendingConfirm: null,
      stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
      factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
    };
    ctx.sess.mode = "global";
    C.execLine(ctx, "interface vlan 10");
    C.execLine(ctx, "ip helper-address 10.0.0.5");
    C.execLine(ctx, "exit");
    ok("中继已启用", sw.ipHelper.enabled === true);
    ok("服务器已记录", sw.ipHelper.servers.indexOf("10.0.0.5") >= 0, JSON.stringify(sw.ipHelper.servers));
    ok("接口级已记录", !!sw.ipHelper.perIf["vlan10"], JSON.stringify(sw.ipHelper.perIf));
    ctx.sess.mode = "priv";
    const t = C.execLine(ctx, "show ip helper").output;
    ok("show ip helper 输出服务器", t.indexOf("10.0.0.5") >= 0, t);
    // 非法 IP
    ctx.sess.mode = "global";
    const r = C.execLine(ctx, "ip helper-address 999.1.1.1");
    ok("非法 helper IP 被拒", /%/.test(r.output || ""), r.output);
  }

  console.log("\n===== 3. 端口安全在 UI 层的联动 =====");
  {
    App.loadLabNow("lab3");
    await wait(300);
    App.autoAnswer();
    await wait(500);
    const devs = App.devices;
    const sw = devs.find(x => x.type === "l2");
    const pc1 = devs.find(x => x.hostname === "PC1");
    const pc2 = devs.find(x => x.hostname === "PC2");
    ok("端口安全已配", sw.ports["e1/0/1"].portSecurity.enabled === true,
      JSON.stringify(sw.ports["e1/0/1"].portSecurity));
    // 把 PC2 换到 e1/0/1
    const links = App.links.slice();
    const l2 = links.find(l => {
      const a = devs.find(x => x.id === l.a.dev), b = devs.find(x => x.id === l.b.dev);
      return a && b && ((a.hostname === "Switch1" && b.hostname === "PC2") || (b.hostname === "Switch1" && a.hostname === "PC2"));
    });
    ok("找到 PC2 的连线", !!l2);
    if (l2) {
      // 改连线到 e1/0/1
      if (devs.find(x => x.id === l2.a.dev).hostname === "Switch1") l2.a.port = "e1/0/1";
      else l2.b.port = "e1/0/1";
      const r = Sim.simulatePing(devs, links, pc2, pc1.pcIp);
      ok("换线后 PC2 违例", sw.ports["e1/0/1"].violated === true,
        "violated=" + sw.ports["e1/0/1"].violated);
      ok("端口被关断", sw.ports["e1/0/1"].shutdown === true);
      ok("通信被阻断", r.ok === false, r.reason);
      // no shutdown 恢复
      const c = {
        devices: devs, links: links, dev: sw, sess: C.createSession(sw), pendingConfirm: null,
        stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
        factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
      };
      c.sess.mode = "global";
      C.execLine(c, "interface e1/0/1");
      C.execLine(c, "no shutdown");
      C.execLine(c, "exit");
      ok("no shutdown 后端口 up", sw.ports["e1/0/1"].shutdown === false);
    }
  }

  console.log("\n===== 4. DHCP 中继不应影响普通转发 =====");
  {
    App.loadLabNow("lab4");
    await wait(300);
    App.autoAnswer();
    await wait(500);
    const devs = App.devices;
    const sw = devs.find(x => x.type === "l2" || x.type === "l3");
    const pcs = devs.filter(x => x.type === "pc");
    // 给交换机配 helper（不该影响）
    const c = {
      devices: devs, links: App.links, dev: sw, sess: C.createSession(sw), pendingConfirm: null,
      stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
      factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
    };
    c.sess.mode = "global";
    C.execLine(c, "ip helper-address 192.168.99.1");
    const r = Sim.simulatePing(devs, App.links, pcs[0], pcs[1].pcIp);
    ok("配了 helper 后普通转发仍正常", r.ok === true, r.reason);
  }

  console.log("\n===== 5. 页面无脚本错误 =====");
  ok("无 jsdom 错误", errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log("\n=====================================");
  console.log("==== " + pass + " passed, " + fail + " failed ====");
  if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
  try { win.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();