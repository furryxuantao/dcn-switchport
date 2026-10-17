// 真实点击路径测试：模拟用户点按钮/下拉框，检查是否真的载入
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
const errs = [];
vc.on("jsdomError", (e) => errs.push("jsdomError: " + e.message));
vc.on("error", (...a) => errs.push("console.error: " + a.join(" ")));
const dom = new JSDOM(fs.readFileSync(join(__dirname, "..", "index.html"), "utf-8"), {
  url: "file:///" + join(__dirname, "..", "index.html").replace(/\\/g, "/"), runScripts: "dangerously",
  resources: "usable", pretendToBeVisual: true, virtualConsole: vc
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function eq(c, m, x) { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x ? " [" + x + "]" : "")); } }
(async () => {
  await wait(2500);
  const d = dom.window.document, App = dom.window.DCNApp;
  const sel = d.getElementById("labSel");

  // 1) 直接点「载入实验」按钮（未选实验 → 应有提示而非静默）
  d.getElementById("btnLab").click();
  await wait(200);
  eq(/先在下拉框/.test(d.getElementById("toast").textContent) || App.devices.length === 0,
    "未选实验点按钮有提示，不静默");

  // 2) 选实验后点按钮 → 应真实载入
  sel.value = "lab4";
  sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await wait(400);
  const afterChange = App.devices.length;
  eq(afterChange === 7, "下拉框 change 触发载入 lab4", "dev=" + afterChange);

  // 3) 切换到另一个实验再点按钮
  sel.value = "lab8";
  d.getElementById("btnLab").click();
  await wait(400);
  eq(App.devices.length === 4, "点按钮载入 lab8", "dev=" + App.devices.length);
  eq(App.devices.some(x => x.hostname === "SwitchA"), "lab8 设备正确");

  // 4) 一键标准答案按钮
  d.getElementById("btnAnswer").click();
  await wait(500);
  eq(App.devices.find(x => x.hostname === "PC0").pcIp === "192.168.10.100", "标准答案按钮生效");

  // 5) 终端全屏按钮
  const b = d.getElementById("btnFullTerm");
  eq(!!b, "全屏按钮存在");
  b.click(); await wait(250);
  eq(d.body.classList.contains("term-full"), "全屏切换 class 生效");
  eq(/退出全屏/.test(b.textContent), "按钮文案切换");
  b.click(); await wait(250);
  eq(!d.body.classList.contains("term-full"), "再次点击退出全屏");

  // 6) 清空按钮（确认框 → 确定）
  d.getElementById("btnClear").click();
  await wait(200);
  eq(d.getElementById("modalBack").style.display === "flex", "清空弹出确认框");
  d.getElementById("modalOk").click();
  await wait(300);
  eq(App.devices.length === 0, "确认后画布清空");

  // 7) 再点载入（此时画布空，不应有确认框）
  sel.value = "lab5";
  d.getElementById("btnLab").click();
  await wait(400);
  eq(App.devices.length === 6 && d.getElementById("modalBack").style.display === "none",
    "空画布载入无确认框且成功", "dev=" + App.devices.length);

  // 8) 有设备时点载入 → 应立即载入（不卡确认框）
  sel.value = "lab9";
  d.getElementById("btnLab").click();
  await wait(400);
  eq(App.devices.length === 4, "有设备时点按钮也直接载入", "dev=" + App.devices.length);
  eq(d.getElementById("modalBack").style.display === "none", "未误弹确认框");

  console.log("\n==== " + pass + " passed, " + fail + " failed, errs=" + errs.length + " ====");
  errs.slice(0, 5).forEach(e => console.log("  " + e));
  process.exit(fail ? 1 : 0);
})().catch(e => { console.log("HARNESS-FAIL", e.message); process.exit(3); });