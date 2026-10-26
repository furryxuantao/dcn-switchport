// Electron 主进程：窗口 + 应用菜单 + 原生右键菜单 + 文件存取
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
const path = require("path");
const fs = require("fs");

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    title: "DCN网络模拟器",
    backgroundColor: "#F6F1E7",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  // 打包后 main.js 与 index.html 同处 asar 根；开发时 main.js 在 electron/ 子目录。按存在性兜底，避免空白窗口。
  const tryPaths = [
    path.join(__dirname, "index.html"),
    path.join(__dirname, "..", "index.html")
  ];
  const page = tryPaths.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; }; });
  if (!page) {
    dialog.showErrorBox("启动失败", "找不到 index.html（" + tryPaths.join("；") + "）");
    return;
  }
  win.loadFile(page).catch((err) => {
    dialog.showErrorBox("页面加载失败", String(err && err.message || err));
  });
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) console.log("[page]", message);
  });
  win.webContents.on("did-fail-load", (_e, code, desc) => {
    dialog.showErrorBox("页面加载失败", code + " " + desc);
  });

  const menu = Menu.buildFromTemplate([
    {
      label: "文件",
      submenu: [
        { label: "拓扑另存为文件…", click: () => win.webContents.send("dcn:menu", "save-file") },
        { label: "从文件载入拓扑…", click: () => win.webContents.send("dcn:menu", "load-file") },
        { type: "separator" },
        { label: "导出实验报告（txt）…", click: () => win.webContents.send("dcn:menu", "export-report") },
        { type: "separator" },
        { label: "退出", role: "quit" }
      ]
    },
    {
      label: "视图",
      submenu: [
        { label: "放大", role: "zoomIn" },
        { label: "缩小", role: "zoomOut" },
        { label: "实际大小", role: "resetZoom" },
        { type: "separator" },
        { label: "重载", role: "reload" },
        { label: "开发者工具", role: "toggleDevTools" }
      ]
    },
    {
      label: "帮助",
      submenu: [
        {
          label: "命令手册",
          click: () => win.webContents.send("dcn:menu", "help")
        },
        {
          label: "关于",
          click: () => dialog.showMessageBox(win, {
            type: "info",
            title: "关于",
            message: "DCN网络模拟器 v1.4.0",
            detail: "神州数码指令仿真（对标 Packet Tracer），指令严格按课程 PPT / 实验报告。\n支持命令缩写、TAB 补全、? 联想。"
          })
        }
      ]
    }
  ]);
  Menu.setApplicationMenu(menu);

  win.on("closed", () => { win = null; });
}

app.whenReady().then(() => {
  createWindow();
  // 自检模式：node/electron . --selftest  跑真实页面交互检查后退出
  if (process.argv.includes("--selftest")) runSelfTest();
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });

function runSelfTest() {
  const probe = `(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    await sleep(1200);
    const R = [];
    const ok = (c, m) => R.push((c ? "PASS " : "FAIL ") + m);
    ok(!!window.DCNApp, "测试钩子存在");
    const d = document, sel = d.getElementById("labSel");
    R.push("INFO btnLab.onclick=" + typeof d.getElementById("btnLab").onclick + " sel.onchange=" + typeof sel.onchange + " btnAnswer=" + typeof d.getElementById("btnAnswer").onclick);
    ok(sel && sel.children.length === 18, "下拉框 18 项", sel ? sel.children.length : "无");
    // 图标是否加载（file:// 下 fetch 常失败）
    ok(d.querySelectorAll("[data-icon] svg").length > 20, "图标已注入", d.querySelectorAll("[data-icon] svg").length);
    // 点载入按钮（未选）
    d.getElementById("btnLab").click(); await sleep(150);
    // 选实验 → change → 按钮
    try {
      sel.value = "lab12"; sel.dispatchEvent(new Event("change", {bubbles:true})); await sleep(500);
      R.push("INFO dev=" + window.DCNApp.devices.length);
    } catch (e) { R.push("FAIL change 抛错: " + e.message + " @ " + (e.stack||"").split("\\n")[1]); }
    try {
      window.DCNApp.loadLab("lab12"); await sleep(400);
      R.push("INFO 直调loadLab dev=" + window.DCNApp.devices.length);
    } catch (e) { R.push("FAIL 直调抛错: " + e.message + " @ " + (e.stack||"").split("\\n")[1]); }
    ok(window.DCNApp.devices.length === 12, "载入 lab12 = 12 台设备", window.DCNApp.devices.length);
    R.push("INFO 终端输出=" + JSON.stringify((d.getElementById("term").textContent||"").slice(-160)));
    R.push("INFO 模态框=" + d.getElementById("modalBack").style.display + " 提示=" + JSON.stringify(d.getElementById("modalHint").textContent||""));
    sel.value = "lab8"; d.getElementById("btnLab").click(); await sleep(400);
    ok(window.DCNApp.devices.length === 4, "点按钮载入 lab8 = 4 台", window.DCNApp.devices.length);
    ok(d.getElementById("modalBack").style.display === "none", "未误弹确认框");
    // 标准答案
    d.getElementById("btnAnswer").click(); await sleep(600);
    const pc0 = window.DCNApp.devices.find(x => x.hostname === "PC0");
    ok(pc0 && pc0.pcIp === "192.168.10.100", "标准答案生效", pc0 ? pc0.pcIp : "无");
    // ping
    const pc1 = window.DCNApp.devices.find(x => x.hostname === "PC1");
    const r = window.DCNApp.ping("PC0", pc1.pcIp);
    ok(r && r.ok === true, "PC0 ping PC1 通", r ? (r.reason || "ok") : "null");
    // 画布可见性
    ok(d.querySelectorAll("#nodes .node").length === 4, "画布渲染 4 个节点", d.querySelectorAll("#nodes .node").length);
    ok(d.querySelectorAll("#topo g[data-link]").length >= 6, "连线渲染", d.querySelectorAll("#topo g[data-link]").length);
    R.push("INFO 页面错误=" + JSON.stringify(window.__errs));
    return R.join("\\n");
  })()`;
  win.webContents
    .executeJavaScript("window.__errs=[];window.addEventListener('error',e=>window.__errs.push(String(e.message)));" + probe, true)
    .then((out) => {
      console.log("=== ELECTRON SELFTEST ===\n" + out);
      const bad = out.split("\n").filter((l) => l.startsWith("FAIL"));
      process.exitCode = bad.length ? 1 : 0;
      setTimeout(() => app.exit(bad.length ? 1 : 0), 300);
    })
    .catch((e) => {
      console.log("=== ELECTRON SELFTEST ===\nFAIL 执行异常: " + e.message);
      process.exitCode = 1;
      setTimeout(() => app.exit(1), 300);
    });
}

/* ---- 窗口原生全屏（渲染进程请求） ---- */
ipcMain.on("dcn:fullscreen", (ev, on) => {
  const w = BrowserWindow.fromWebContents(ev.sender);
  if (w) w.setFullScreen(!!on);
});

/* ---- 右键原生菜单：渲染进程上报上下文，主进程弹出 ---- */
ipcMain.on("dcn:ctx", (ev, info) => {
  const wc = ev.sender;
  const send = (act, arg) => wc.send("dcn:ctx-act", { act, arg });
  const tpl = [];
  if (info.kind === "device") {
    tpl.push({ label: "进入 " + info.name + " 的 CLI", click: () => send("enter-cli", info.id) });
    tpl.push({ label: "重命名设备…", click: () => send("rename-dev", info.id) });
    tpl.push({ type: "separator" });
    tpl.push({ label: "从此设备连线（直通线）", click: () => send("wire-from", { id: info.id, wire: "copper" }) });
    tpl.push({ label: "从此设备连线（串口 DCE）", click: () => send("wire-from", { id: info.id, wire: "dce" }) });
    tpl.push({ label: "从此设备连线（Console）", click: () => send("wire-from", { id: info.id, wire: "console" }) });
    tpl.push({ type: "separator" });
    tpl.push({ label: "ping 本设备（自测连通）", click: () => send("ping-dev", info.id) });
    tpl.push({ label: "删除设备 " + info.name, click: () => send("del-dev", info.id) });
  } else if (info.kind === "link") {
    tpl.push({ label: "删除这根连线（" + info.label + "）", click: () => send("del-link", info.id) });
  } else {
    tpl.push({ label: "添加 PC", click: () => send("add-dev", "pc") });
    tpl.push({ label: "添加二层交换机", click: () => send("add-dev", "l2") });
    tpl.push({ label: "添加三层交换机", click: () => send("add-dev", "l3") });
    tpl.push({ label: "添加路由器", click: () => send("add-dev", "router") });
    tpl.push({ type: "separator" });
    tpl.push({ label: "清空画布", click: () => send("clear") });
  }
  Menu.buildFromTemplate(tpl).popup({ window: BrowserWindow.fromWebContents(wc) });
});

/* ---- 文件存取 ---- */
ipcMain.handle("dcn:save-file", async (ev, text, defaultName) => {
  const r = await dialog.showSaveDialog(win, {
    title: "保存拓扑",
    defaultPath: defaultName || "dcn-topo.json",
    filters: [{ name: "DCN 拓扑", extensions: ["json"] }, { name: "文本报告", extensions: ["txt"] }]
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, text, "utf-8");
  return r.filePath;
});
ipcMain.handle("dcn:load-file", async () => {
  const r = await dialog.showOpenDialog(win, {
    title: "载入拓扑",
    filters: [{ name: "DCN 拓扑", extensions: ["json"] }],
    properties: ["openFile"]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return { path: r.filePaths[0], text: fs.readFileSync(r.filePaths[0], "utf-8") };
});
