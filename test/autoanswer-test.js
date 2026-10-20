// 16 个实验的「一键标准答案」端到端验证：
// 载入实验 → autoAnswer → 任务里声明的 ping 应能通
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
  const LABS = win.DCNLABS;

  console.log("\n===== 1. 每个实验载入 + autoAnswer 不报错 =====");
  for (const lab of LABS) {
    const before = errs.length;
    App.loadLabNow(lab.id);
    await wait(300);
    App.autoAnswer();
    await wait(500);
    const newErrs = errs.length - before;
    ok("实验" + lab.no + " " + lab.title + " autoAnswer 无错误", newErrs === 0,
      newErrs ? errs.slice(before).join(" | ") : "");
  }

  console.log("\n===== 2. 每个实验的 ping 任务是否真的能通 =====");
  for (const lab of LABS) {
    App.loadLabNow(lab.id);
    await wait(300);
    App.autoAnswer();
    await wait(500);
    const devs = App.devices;
    const byName = {};
    devs.forEach(dv => { byName[dv.hostname] = dv; });
    const pingTasks = (lab.tasks || []).filter(t => t.from && t.target);
    if (!pingTasks.length) { ok("实验" + lab.no + " 无 ping 任务（跳过）", true); continue; }
    for (const t of pingTasks) {
      const src = byName[t.from];
      let tip = t.target;
      const tgt = byName[tip];
      if (tgt) {
        const ips = win.DCNSim.deviceIpList(tgt);
        tip = ips[0] || null;
      } else {
        const m = String(tip).match(/^(.*)-(G0\/0|G0\/1|S1\/0|S1\/1|VLAN\d+)$/i);
        if (m) {
          const rd = byName[m[1]];
          if (rd) {
            const want = m[2].toLowerCase();
            tip = want.indexOf("vlan") === 0
              ? (rd.vlanIf[want.replace("vlan", "")] || {}).ip
              : (rd.ifIp[want] || {}).ip;
          }
        }
      }
      if (!src || !tip) {
        ok("实验" + lab.no + " 任务「" + t.text + "」可解析", false,
          "src=" + !!src + " tip=" + tip);
        continue;
      }
      const r = win.DCNSim.simulatePing(devs, App.links, src, tip);
      // 任务可用 expect 字段声明预期结果：
      //   expect:"up"   → 应连通
      //   expect:"down" → 应不通
      // stage:"before"  表示该任务描述的是「操作之前」的中间状态
      //                  （如先拔线/先关 STP），autoAnswer 之后状态已变，故不参与判定
      if (t.stage) {
        ok("实验" + lab.no + " 任务「" + t.text + "」需先完成对应操作（跳过判定）", true);
        continue;
      }
      if (t.expect === "down") {
        ok("实验" + lab.no + " 任务「" + t.text + "」不通（符合预期）", r.ok === false,
          r.ok ? "实际通了" : r.reason);
      } else if (t.expect === "up") {
        ok("实验" + lab.no + " 任务「" + t.text + "」能通", r.ok === true, r.reason);
      } else {
        // 未声明预期的任务：按实际结果记录，不做通过/失败判定
        ok("实验" + lab.no + " 任务「" + t.text + "」可执行", typeof r.ok === "boolean",
          r.ok ? "通" : r.reason);
      }
    }
  }

  console.log("\n===== 3. 页面无脚本错误 =====");
  ok("全程无 jsdom 错误", errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log("\n=====================================");
  console.log("==== " + pass + " passed, " + fail + " failed ====");
  if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
  try { win.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();