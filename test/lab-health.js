// 载入实验体检：逐个载入，检查设备/连线/视图/异常
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
const html = fs.readFileSync(join(__dirname, "..", "index.html"), "utf-8");
const dom = new JSDOM(html, {
  url: "file:///" + join(__dirname, "..", "index.html").replace(/\\/g, "/"),
  runScripts: "dangerously", resources: "usable",
  pretendToBeVisual: true, virtualConsole: vc
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  await wait(2200);
  const d = dom.window.document;
  const App = dom.window.DCNApp;
  const LABS = dom.window.DCNLABS;
  const sel = d.getElementById("labSel");
  console.log("下拉框选项数 =", sel.children.length, "（应为 1 个占位 + 17 个实验）");
  for (const lab of LABS) {
    sel.value = lab.id;
    App.loadLab(lab.id);           // 走 UI 真实路径（有确认门）
    const devs = App.devices, links = App.links;
    const dup = devs.map(x => x.hostname).filter((n, i, a) => a.indexOf(n) !== i);
    const missingPort = links.filter(l => {
      const da = devs.find(x => x.id === l.a.dev), db = devs.find(x => x.id === l.b.dev);
      return !da || !db || !da.ports[l.a.port] || !db.ports[l.b.port];
    });
    const term = (d.getElementById("term").textContent || "").trim().split("\n");
    const last = term[term.length - 1] || "";
    console.log(
      lab.no.padEnd(5),
      ("dev=" + devs.length).padEnd(9),
      ("link=" + links.length).padEnd(10),
      dup.length ? "重名:" + dup.join(",") + " " : "",
      missingPort.length ? "坏端口:" + missingPort.length + " " : "",
      "| 终端末行: " + last.slice(0, 46)
    );
  }
  console.log("\njsdom 错误:", errs.length ? errs : "无");
  process.exit(0);
})().catch((e) => { console.log("HARNESS-FAIL", e.message); process.exit(3); });