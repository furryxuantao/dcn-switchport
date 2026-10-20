// UI 层索引假设、连线校验、状态刷新时序的检查
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

  console.log("\n===== 1. 设备节点与 devices 数组的索引对应 =====");
  {
    App.loadLabNow("lab4");
    await wait(400);
    const devs = App.devices;
    const nodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    ok("节点数与设备数一致", nodes.length === devs.length,
      "nodes=" + nodes.length + " devices=" + devs.length);
    // 每个节点的文本应包含对应设备的 hostname
    let mismatch = [];
    devs.forEach((dv, i) => {
      if (!nodes[i]) { mismatch.push("i=" + i + " 缺节点"); return; }
      if (nodes[i].textContent.indexOf(dv.hostname) < 0) {
        mismatch.push("i=" + i + " 期望 " + dv.hostname + " 实为 " + nodes[i].textContent.slice(0, 20));
      }
    });
    ok("节点与设备按索引对应", mismatch.length === 0, JSON.stringify(mismatch.slice(0, 3)));
  }

  console.log("\n===== 2. 选中状态与 curId 一致 =====");
  {
    const devs = App.devices;
    const nodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    // 点击第 3 个设备
    nodes[2].dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(200);
    const selNodes = nodes.filter(n => n.classList.contains("sel"));
    ok("恰好一个节点被选中", selNodes.length === 1, "选中数=" + selNodes.length);
    ok("选中的是被点击的设备", selNodes[0] === nodes[2] || selNodes[0].textContent.indexOf(devs[2].hostname) >= 0,
      "sel=" + (selNodes[0] ? selNodes[0].textContent.slice(0, 20) : "null") + " 期望 " + devs[2].hostname);
    // 再点另一个
    nodes[4].dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(200);
    const sel2 = Array.prototype.slice.call(d.querySelectorAll("#nodes .node")).filter(n => n.classList.contains("sel"));
    ok("切换后仍只有一个选中", sel2.length === 1, "选中数=" + sel2.length);
    ok("切换到新设备", sel2[0].textContent.indexOf(devs[4].hostname) >= 0,
      sel2[0] ? sel2[0].textContent.slice(0, 20) : "null");
  }

  console.log("\n===== 3. 删除设备后索引不错位 =====");
  {
    App.loadLabNow("lab4");
    await wait(400);
    const before = App.devices.length;
    // 删除一个中间设备：先点选，再让焦点离开输入框（Delete 在输入时不应删除）
    const nodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    nodes[2].dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(150);
    // 焦点移出 contenteditable（真实用户点击画布空白处）
    const ed0 = d.querySelector("#edit");
    if (ed0) ed0.blur();
    d.body.focus();
    await wait(100);
    // 监听器挂在 document 上，事件必须从 document/body 派发
    d.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Delete", bubbles: true }));
    await wait(400);
    // Delete 需确认弹窗（防误删），点「确定」
    const okBtn = d.getElementById("modalOk");
    ok("弹出删除确认框", !!okBtn && d.getElementById("modalBack").style.display !== "none",
      "modalBack display=" + (d.getElementById("modalBack") ? d.getElementById("modalBack").style.display : "?"));
    if (okBtn) { okBtn.dispatchEvent(new win.MouseEvent("click", { bubbles: true })); await wait(500); }
    ok("设备数减少", App.devices.length === before - 1, before + " -> " + App.devices.length);
    const nodes2 = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    ok("节点数与设备数仍一致", nodes2.length === App.devices.length,
      "nodes=" + nodes2.length + " devices=" + App.devices.length);
    // 索引对应仍正确
    let mismatch = [];
    App.devices.forEach((dv, i) => {
      if (!nodes2[i]) { mismatch.push("i=" + i + " 缺节点"); return; }
      if (nodes2[i].textContent.indexOf(dv.hostname) < 0) {
        mismatch.push("i=" + i + " 期望 " + dv.hostname);
      }
    });
    ok("删除后索引对应仍正确", mismatch.length === 0, JSON.stringify(mismatch.slice(0, 3)));
  }

  console.log("\n===== 4. 状态刷新定时器不影响用户操作 =====");
  {
    App.loadLabNow("lab2");
    await wait(400);
    App.autoAnswer();
    await wait(400);
    // 连续快速切换设备，观察是否丢失上下文
    const nodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    for (let i = 0; i < 6; i++) {
      nodes[i % nodes.length].dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
      await wait(80);
    }
    await wait(300);
    const term = d.getElementById("term");
    ok("快速切换后终端仍有输入行", !!(term && term.querySelector("#edit")),
      term ? "无 #edit" : "无 term");
    const sel = Array.prototype.slice.call(d.querySelectorAll("#nodes .node")).filter(n => n.classList.contains("sel"));
    ok("快速切换后仍恰好一个选中", sel.length === 1, "选中数=" + sel.length);
  }

  console.log("\n===== 5. 设备重命名后索引与提示符 =====");
  {
    App.loadLabNow("lab1");
    await wait(400);
    const nodes = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
    nodes[0].dispatchEvent(new win.MouseEvent("click", { bubbles: true, detail: 1 }));
    await wait(200);
    const devs = App.devices;
    const newName = "RENAME_TEST";
    const term = d.getElementById("term");
    const ed = term && term.querySelector("#edit");
    ok("有输入行可输入命令", !!ed);
    if (ed) {
      // hostname 是全局配置命令，需先 config terminal
      const run2 = async (cmd) => {
        const e = term.querySelector("#edit");
        e.textContent = cmd;
        e.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await wait(200);
        return (term.textContent || "").slice(-200);
      };
      const t0 = await run2("enable");
      ok("enable 进入 priv", t0.indexOf("未知") < 0, t0);
      const t1 = await run2("config terminal");
      ok("config terminal 成功", t1.indexOf("未知") < 0, t1);
      const t2 = await run2("hostname " + newName);
      ok("hostname 无未知命令", t2.indexOf("未知") < 0, t2);
      ok("hostname 已生效", devs[0].hostname === newName, devs[0].hostname);
      const nodes2 = Array.prototype.slice.call(d.querySelectorAll("#nodes .node"));
      ok("节点文本同步新名字", nodes2[0] && nodes2[0].textContent.indexOf(newName) >= 0,
        nodes2[0] ? nodes2[0].textContent.slice(0, 30) : "null");
      ok("提示符同步新名字", (term.textContent || "").indexOf(newName) >= 0,
        (term.textContent || "").slice(-40));
    }
  }

  console.log("\n===== 6. 页面无脚本错误 =====");
  ok("无 jsdom 错误", errs.length === 0, JSON.stringify(errs.slice(0, 3)));

  console.log("\n=====================================");
  console.log("==== " + pass + " passed, " + fail + " failed ====");
  if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
  try { win.close(); } catch (e) {}
  process.exit(fail ? 1 : 0);
})();