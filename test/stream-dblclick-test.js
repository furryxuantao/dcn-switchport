// 流式 ping 输出 + 双击进 CLI 验证
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
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x ? " [" + String(x).slice(0, 100) + "]" : "")); } };

(async () => {
  await wait(2200);
  const d = dom.window.document, App = dom.window.DCNApp;
  const term = () => d.getElementById("term").textContent;

  /* --- 双击进 CLI --- */
  App.loadLabNow("lab2");
  await wait(400);
  const nodes = d.querySelectorAll("#nodes .node");
  ok(nodes.length === 6, "lab2 渲染 6 个节点", nodes.length);

  // 模拟真实双击：两次 click + dblclick
  const sw0 = d.querySelectorAll("#nodes .node")[0];
  sw0.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(120);
  ok(sw0.classList.contains("sel"), "单击后节点高亮（未重建 DOM）");
  ok(!!d.getElementById("edit"), "单击后已切到该设备会话并出现输入行");
  sw0.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  await wait(300);
  ok(d.getElementById("pg-cli").classList.contains("on"), "双击后切到终端页");
  ok(term().includes("Switch0"), "终端提示符为 Switch0", term().slice(-30));
  const ed = d.getElementById("edit");
  ok(ed && ed.getAttribute("contenteditable") !== "false", "双击后输入行可编辑");

  // 在该设备上敲命令
  ed.textContent = "show vlan";
  ed.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  ok(/VLAN Name/.test(term()), "双击进入后可直接执行命令", term().slice(-40));

  // 切到另一台设备
  const sw1 = d.querySelectorAll("#nodes .node")[1];
  sw1.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
  await wait(150);
  ok(d.querySelectorAll("#nodes .node")[1].classList.contains("sel"), "单击另一台设备可切换选中");
  ok(d.querySelectorAll("#nodes .node")[0].classList.contains("sel") === false, "原设备取消高亮");
  ok(term().includes("Switch1"), "提示符切到 Switch1", term().slice(-30));
  // 在新设备上敲命令，验证上下文正确
  const ed2 = d.getElementById("edit");
  ed2.textContent = "show vlan";
  ed2.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  ok(term().split("\n").pop().includes("Switch1"), "命令发给了正确设备", term().slice(-30));

  /* --- 流式 ping --- */
  App.loadLabNow("lab2");
  await wait(400);
  App.autoAnswer();
  await wait(400);
  const pc0 = App.devices.find((x) => x.hostname === "PC0");
  const pc1 = App.devices.find((x) => x.hostname === "PC1");
  ok(!!pc0.pcIp, "标准答案已给 PC 配 IP", pc0 && pc0.pcIp);
  // 切到 PC0 终端
  const allNodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
  const pc0Node = allNodes.filter((n) => n.textContent.includes("PC0"))[0];
  pc0Node.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
  await wait(250);
  const before = (term().match(/正在 Ping/g) || []).length;
  const ed3 = d.getElementById("edit");
  ed3.textContent = "ping " + pc1.pcIp;
  ed3.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(250);
  const midText = term();
  const midReplies = (midText.match(/来自 /g) || []).length;
  ok(midReplies < 5, "输出是渐进的（此时尚未全部打印）", "已出 " + midReplies + " 行");
  ok(midText.includes("正在 Ping"), "已输出起始行");
  await wait(2600);
  const finText = term();
  const finReplies = (finText.match(/来自 /g) || []).length;
  ok(finReplies === 5, "最终打印 5 条回复", finReplies);
  ok(/Ping 统计信息/.test(finText), "输出统计信息");
  ok(/最短 = /.test(finText), "输出延迟统计");
  ok(!!d.getElementById("edit"), "结束后恢复输入行");
  ok(errs.length === 0, "无页面错误", errs.join("|"));

  console.log("\n==== " + pass + " passed, " + fail + " failed ====");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log("HARNESS-FAIL", e.message, e.stack); process.exit(3); });