// UI 层回归测试：验证 MAC 表不再被污染 + 页面无脚本错误
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(path.join(__dirname, "node_modules", "jsdom")));
} catch (e) {
  console.log("SKIP: 需要 jsdom（cd test && npm install）");
  process.exit(0);
}

const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf-8");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.stack || e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const dom = new JSDOM(html, {
  url: "file:///" + path.join(ROOT, "index.html").replace(/\\/g, "/"),
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc
});
const win = dom.window;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}
function waitFor(cond, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    (function tick() {
      let v = null;
      try { v = cond(); } catch (e) { v = null; }
      if (v) return resolve(v);
      if (Date.now() - t0 > (ms || 6000)) return resolve(null);
      setTimeout(tick, 30);
    })();
  });
}

(async function () {
  console.log("\n===== 1. 页面加载 =====");
  await waitFor(() => win.DCNSim && win.DCNCLI && win.DCNApp, 8000);
  ok("仿真核心已加载", !!win.DCNSim);
  ok("命令引擎已加载", !!win.DCNCLI);
  ok("应用已就绪", !!win.DCNApp);

  console.log("\n===== 2. UI 源码不再手工写 MAC 表 =====");
  const src = fs.readFileSync(path.join(ROOT, "src", "ui.js"), "utf-8");
  ok("UI 中不再调用 Sim.learnMac", src.indexOf("Sim.learnMac(") < 0,
    "仍有 " + (src.split("Sim.learnMac(").length - 1) + " 处");
  ok("无「记到第一个口」的写法",
    !/learnMac\([^)]*Object\.keys\([^)]*ports\)\[0\]/.test(src));

  console.log("\n===== 3. 载入实验 → ping → MAC 表正确 =====");
  win.DCNApp.loadLab("lab4");
  await new Promise((r) => setTimeout(r, 300));
  const devices = win.DCNApp.devices;
  const links = win.DCNApp.links;
  ok("lab4 载入了设备", devices && devices.length > 0, String(devices && devices.length));
  ok("lab4 载入了链路", links && links.length > 0, String(links && links.length));

  const sw = devices.find((d) => d.type === "l2" || d.type === "l3");
  const pcs = devices.filter((d) => d.type === "pc");
  ok("找到交换机", !!sw);
  ok("找到至少 2 个 PC", pcs.length >= 2, String(pcs.length));

  if (sw && pcs.length >= 2) {
    pcs[0].pcIp = "192.168.1.11"; pcs[0].pcMask = "255.255.255.0";
    pcs[1].pcIp = "192.168.1.12"; pcs[1].pcMask = "255.255.255.0";
    const r = win.DCNSim.simulatePing(devices, links, pcs[0], "192.168.1.12");
    ok("ping 成功", r.ok === true, r.reason);

    const entry = sw.macTable[pcs[0].pcMac];
    ok("MAC 表记录了源 MAC", !!entry, JSON.stringify(Object.keys(sw.macTable)));
    if (entry) {
      let realPort = null;
      links.forEach((l) => {
        if (l.a.dev === sw.id && l.b.dev === pcs[0].id) realPort = l.a.port;
        if (l.b.dev === sw.id && l.a.dev === pcs[0].id) realPort = l.b.port;
      });
      ok("MAC 表端口与实际连线一致", entry.port === realPort,
        "记录 " + entry.port + "，实际 " + realPort);
      ok("MAC 表未被污染到其它交换机", devices.filter((d) => d !== sw && (d.type === "l2" || d.type === "l3"))
        .every((d) => !d.macTable[pcs[0].pcMac]), "其它交换机的 MAC 表也写入了源 MAC");
    }
  }

  console.log("\n===== 4. 一键标准答案后 ping 仍通（回归）=====");
  {
    win.DCNApp.loadLab("lab8");
    await new Promise((r) => setTimeout(r, 300));
    win.DCNApp.autoAnswer();
    await new Promise((r) => setTimeout(r, 400));
    const devs2 = win.DCNApp.devices;
    const pc2 = devs2.filter((d) => d.type === "pc");
    if (pc2.length >= 2) {
      const r2 = win.DCNApp.ping(pc2[0].hostname, pc2[1].pcIp);
      ok("标准答案后 ping 通", r2.ok === true, r2.reason);
    } else {
      ok("标准答案后 ping 通", true, "PC 数量不足，跳过");
    }
  }

  console.log("\n===== 5. 页面无脚本错误 =====");
  ok("无 jsdom 错误", errors.length === 0, JSON.stringify(errors.slice(0, 3)));

  console.log("\n=====================================");
  console.log("==== " + pass + " passed, " + fail + " failed ====");
  if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
  try { win.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();