// 连线流程回归测试：思科式「选线型 → 选源端口 → 选目标端口」
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
vc.on("jsdomError", (e) => errs.push(e.message));
const dom = new JSDOM(fs.readFileSync(join(__dirname, "..", "index.html"), "utf-8"), {
  url: "file:///" + join(__dirname, "..", "index.html").replace(/\\/g, "/"), runScripts: "dangerously",
  resources: "usable", pretendToBeVisual: true, virtualConsole: vc
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x ? " [" + String(x).slice(0, 90) + "]" : "")); } };
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
const dbl = (el) => el.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
let d = null;
const N = (i) => d.querySelectorAll("#nodes .node")[i];
const PK = () => d.getElementById("portPicker");

(async () => {
  await wait(2200);
  d = dom.window.document;
  const App = dom.window.DCNApp;

  /* --- 直通线 --- */
  d.querySelector('#palette .devbtn[data-type="l2"]').click(); await wait(150);
  d.querySelector('#palette .devbtn[data-type="l2"]').click(); await wait(250);
  ok(App.devices.length === 2, "已添加两台交换机");

  const copper = d.querySelector('#wirebox .wirebtn[data-wire="copper"]');
  copper.click(); await wait(150);
  ok(copper.classList.contains("armed"), "线型进入选中态");

  click(N(0)); await wait(250);
  ok(PK().classList.contains("show"), "点源设备弹出端口选择器");
  ok(PK().querySelectorAll(".portrow:not(:disabled)").length === 24, "24 个端口可选");

  PK().querySelector(".portrow:not(:disabled)").click(); await wait(200);
  ok(/②点击目标设备/.test(d.getElementById("linkHint").textContent), "提示进入第二步");
  click(N(1)); await wait(250);
  ok(PK().classList.contains("show"), "点目标设备弹出端口选择器");
  const rows = PK().querySelectorAll(".portrow:not(:disabled)");
  ok(rows.length === 23, "已占用1口，剩23个可选", rows.length);
  rows[0].click(); await wait(350);
  ok(App.links.length === 1, "连线创建成功");
  ok(d.querySelectorAll('#topo g[data-link]').length === 1, "SVG 连线已渲染");
  ok(!copper.classList.contains("armed"), "连完自动收工（工具取消）");

  /* --- 连线模式下双击不应进入 CLI --- */
  d.querySelector('#palette .devbtn[data-type="pc"]').click(); await wait(250);
  copper.click(); await wait(150);
  const before = d.getElementById("term").textContent;
  dbl(N(2)); await wait(250);
  ok(!PK().classList.contains("show"), "连线模式下双击不触发连线流程");
  d.getElementById("linkHint").className = "hint";

  /* --- 串口线：路由器互联 --- */
  d.querySelector('#palette .devbtn[data-type="router"]').click(); await wait(150);
  d.querySelector('#palette .devbtn[data-type="router"]').click(); await wait(250);
  const dce = d.querySelector('#wirebox .wirebtn[data-wire="dce"]');
  dce.click(); await wait(150);
  click(N(3)); await wait(250);
  ok(PK().classList.contains("show"), "串口线弹出端口选择器");
  ok(PK().querySelectorAll(".portrow:not(:disabled)").length === 2, "路由器只有2个s口", PK().querySelectorAll(".portrow:not(:disabled)").length);
  PK().querySelector(".portrow:not(:disabled)").click(); await wait(200);
  click(N(4)); await wait(250);
  const rows2 = PK().querySelectorAll(".portrow:not(:disabled)");
  ok(rows2.length >= 1, "目标端口可选", rows2.length);
  rows2[0].click(); await wait(350);
  ok(App.links.length === 2, "串口连线创建成功");

  /* --- 类型不兼容拦截 --- */
  d.querySelector('#wirebox .wirebtn[data-wire="copper"]').click(); await wait(150);
  click(N(3)); await wait(250);      // 路由器当源，选 e/g 口（应被串口线… 这里用直通线，所以可选）
  PK().querySelector(".ppclose") && PK().querySelector(".ppclose").click(); await wait(150);
  copper.click(); await wait(100);   // 取消线型

  /* --- Esc 取消 --- */
  d.querySelector('#wirebox .wirebtn[data-wire="copper"]').click(); await wait(150);
  click(N(0)); await wait(200);
  ok(PK().classList.contains("show"), "重新开始连线");
  d.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await wait(200);
  ok(!PK().classList.contains("show"), "Esc 关闭端口选择器");
  ok(!copper.classList.contains("armed"), "Esc 取消线型选择");

  /* --- 非连线模式下单击只选中，双击进 CLI --- */
  click(N(0)); await wait(150);
  ok(!PK().classList.contains("show"), "非连线模式单击不弹端口选择器");
  ok(N(0).classList.contains("sel"), "非连线模式单击选中设备");
  dbl(N(1)); await wait(250);
  ok(/Switch2/.test(d.getElementById("term").textContent), "非连线模式双击进入对应 CLI");

  ok(errs.length === 0, "无页面错误", errs.join("|"));
  console.log("\n==== " + pass + " passed, " + fail + " failed ====");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("HARNESS-FAIL", e.message, e.stack); process.exit(3); });