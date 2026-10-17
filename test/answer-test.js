// 端到端：载入实验 → 一键标准答案 → 断言关键 ping（必须全过答案才算合格）
const fs = require("fs");
const path = require("path");
const join = path.join;

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(join(__dirname, "node_modules", "jsdom")));
} catch (e) {
  console.error("需要 jsdom：cd " + join(__dirname) + " && npm install jsdom");
  process.exit(2);
}
const vc = new VirtualConsole();
const errors = [];
vc.on("jsdomError", (e) => errors.push("jsdomError: " + e.message));
const html = fs.readFileSync(join(__dirname, "..", "index.html"), "utf-8");
const dom = new JSDOM(html, {
  url: "file:///" + join(__dirname, "..", "index.html").replace(/\\/g, "/"),
  runScripts: "dangerously", resources: "usable",
  pretendToBeVisual: true, virtualConsole: vc
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function eq(cond, msg, extra) {
  if (cond) { pass++; console.log("PASS " + msg); }
  else { fail++; console.log("FAIL " + msg + (extra ? " [" + extra + "]" : "")); }
}
(async () => {
  await wait(2500);
  const d = dom.window.document;
  const App = dom.window.DCNApp;
  if (!App) { console.log("FAIL DCNApp hook missing"); process.exit(3); }
  const sel = d.getElementById("labSel");
  function load(id) { App.loadLabNow(id); }
  function ipOf(name) {
    const dev = App.devices.find((x) => x.hostname === name);
    if (!dev) return null;
    if (dev.pcIp) return dev.pcIp;
    for (const k of Object.keys(dev.ifIp || {})) if (dev.ifIp[k].ip) return dev.ifIp[k].ip;
    for (const k of Object.keys(dev.vlanIf || {})) if (dev.vlanIf[k].ip) return dev.vlanIf[k].ip;
    if (dev.mgmtIp) return dev.mgmtIp;
    return null;
  }
  function pingOk(from, targetNameOrIp) {
    let tip = targetNameOrIp;
    if (/^[0-9.]+$/.test(tip) === false) tip = ipOf(targetNameOrIp);
    if (!tip) return { ok: false, reason: "无目标IP" };
    return App.ping(from, tip);
  }

  // lab4: 同VLAN通（含跨交换机），跨VLAN不通
  load("lab4"); App.autoAnswer();
  eq(pingOk("PC11", "PC12").ok, "lab4 同VLAN同交换机通");
  eq(pingOk("PC11", "PC21").ok, "lab4 跨交换机同VLAN通", pingOk("PC11", "PC21").reason);
  { const r = pingOk("PC11", "PC31"); eq(!r.ok && /VLAN/.test(r.reason), "lab4 跨VLAN不通且点名VLAN", r.reason); }
  eq(pingOk("PC31", "PC32").ok, "lab4 vlan30内部通");

  // lab5: 跨VLAN经三层通
  load("lab5"); App.autoAnswer();
  eq(pingOk("PC11", "PC21").ok, "lab5 跨VLAN通", pingOk("PC11", "PC21").reason);
  eq(pingOk("PC11", "PC31").ok, "lab5 PC11-PC31通");

  // lab3: 绑定PC1通；把PC2拔线到e1/0/1（报告步骤）则违例不通
  load("lab3"); App.autoAnswer();
  eq(pingOk("PC1", "PC-Server").ok, "lab3 绑定PC通");
  { // 模拟学生拔线：删掉 PC2-e1/0/2，连到已绑定的 e1/0/1
    const devs = App.devices, links = App.links;
    const pc2 = devs.find((x) => x.hostname === "PC2");
    const sw1 = devs.find((x) => x.hostname === "Switch1");
    for (let i = links.length - 1; i >= 0; i--) {
      const l = links[i];
      if (l.a.dev === pc2.id || l.b.dev === pc2.id) links.splice(i, 1);
    }
    links.push({ id: "rewire", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc2.id, port: "eth0" } });
    const r = pingOk("PC2", "PC-Server");
    eq(!r.ok && /违例/.test(r.reason), "lab3 拔线到绑定口违例不通", r.reason);
    eq(sw1.ports["e1/0/1"].violated && sw1.ports["e1/0/1"].shutdown, "lab3 端口已shutdown");
  }

  // lab6: 管理IP通
  load("lab6"); App.autoAnswer();
  eq(pingOk("PC0", "192.168.1.100").ok, "lab6 管理IP通");

  // lab8: 聚合通
  load("lab8"); App.autoAnswer();
  eq(pingOk("PC0", "PC1").ok, "lab8 聚合通");

  // lab10a: STP后通
  load("lab10a"); App.autoAnswer();
  eq(pingOk("PC1", "PC2").ok, "lab10a STP通", pingOk("PC1", "PC2").reason || "无目标IP");

  // 载入健康：lab2 设备清单
  load("lab2");
  {
    const out = App.devices.map((x) => x.hostname).sort().join(",");
    eq(out === "PC0,PC1,PC2,PC3,Switch0,Switch1", "lab2 设备清单正确", out);
  }

  // lab12: 底座直连通
  load("lab12"); App.autoAnswer();
  eq(pingOk("PC11", ipOf("R1")).ok, "lab12 PC11-R1通");
  eq(pingOk("PC11", "PC12").ok, "lab12 PC11-PC12通");
  eq(pingOk("PC21", ipOf("S3")).ok, "lab12 PC21-S3 vlan20通");
  eq(pingOk("PC22", "PC31").ok, "lab12 S3跨VLAN互通（已配vlan虚接口）", pingOk("PC22", "PC31").reason);
  eq(pingOk("PC11", "PC21").ok === false, "lab12 不相邻端口不通（未配路由）", "应不通");

  // lab13: 静态全网通
  load("lab13"); App.autoAnswer();
  eq(pingOk("PC11", "PC31").ok, "lab13 PC11-PC31通", pingOk("PC11", "PC31").reason);
  eq(pingOk("PC0", "PC21").ok, "lab13 PC0-PC21通", pingOk("PC0", "PC21").reason);

  // lab14: 默认路由通
  load("lab14"); App.autoAnswer();
  eq(pingOk("PC11", "PC31").ok, "lab14 默认路由通", pingOk("PC11", "PC31").reason);

  // lab15: RIP通
  load("lab15"); App.autoAnswer();
  eq(pingOk("PC11", "PC31").ok, "lab15 RIP通", pingOk("PC11", "PC31").reason);
  eq(pingOk("PC0", "PC21").ok, "lab15 RIP反向通");

  // lab16: OSPF通
  load("lab16"); App.autoAnswer();
  eq(pingOk("PC11", "PC31").ok, "lab16 OSPF通", pingOk("PC11", "PC31").reason);

  console.log("\n==== " + pass + " passed, " + fail + " failed, jsdomErrors=" + errors.length + " ====");
  errors.forEach((e) => console.log("  " + e));
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => { console.log("HARNESS-FAIL", e); process.exit(3); });
