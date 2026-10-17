// 无头冒烟测试：新版行内终端（#edit）+ 单击选中/双击进CLI + 主题
const fs = require("fs");
const path = require("path");
const join = path.join;
let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require(join(__dirname, "node_modules", "jsdom")));
} catch (e) {
  console.error("需要 jsdom：cd " + join(__dirname) + " && npm install");
  process.exit(2);
}

const dir = path.join(__dirname, "..");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", (e) => errors.push("jsdomError: " + (e.stack || e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.join(" ")));

const html = fs.readFileSync(path.join(dir, "index.html"), "utf-8");
const dom = new JSDOM(html, {
  url: "file:///" + join(__dirname, "..", "index.html").replace(/\\/g, "/"),
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole: vc
});
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  await wait(2500);
  const d = dom.window.document;
  const out = {};
  out.welcome = (d.getElementById("term").textContent || "").slice(0, 40);
  out.themeSwatches = d.querySelectorAll(".swatch").length;

  // 加一台交换机：单击选中
  d.querySelector('#palette .devbtn[data-type="l2"]').click();
  await wait(300);
  out.nodes = d.getElementById("nodes").children.length;

  // 双击进 CLI → 应有输入行
  const node = d.getElementById("nodes").children[0];
  node.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true }));
  await wait(300);
  out.hasEdit = !!d.getElementById("edit");

  // 行内输入缩写命令 en
  const ed = d.getElementById("edit");
  ed.textContent = "en";
  ed.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await wait(300);
  const term = d.getElementById("term").textContent;
  out.afterEnable = term.slice(-60);
  out.promptIsPriv = /Switch#$/.test(term.trim().split("\n").pop()) || /#$/.test(term.replace(/\s+$/, "").slice(-3));

  // 主题切换：点 CRT绿
  const sw = Array.from(d.querySelectorAll(".swatch")).find((x) => x.textContent.includes("CRT"));
  if (sw) sw.click();
  await wait(200);
  out.termBg = d.getElementById("term").style.getPropertyValue("--tbg");
  try { out.savedTheme = JSON.parse(dom.window.localStorage.getItem("dcn-term-theme") || "{}").name; }
  catch (e) { out.savedTheme = "storage-unavailable-in-test"; }

  // 自定义颜色
  const bg = d.getElementById("tcBg");
  bg.value = "#112233";
  bg.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await wait(200);
  out.customBg = d.getElementById("term").style.getPropertyValue("--tbg");

  console.log(JSON.stringify({ errors, out }, null, 2));
  process.exit(errors.length ? 2 : 0);
})().catch((e) => { console.error("HARNESS-FAIL", e); process.exit(3); });
