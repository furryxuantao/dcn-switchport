// 预加载脚本：安全地给页面暴露 Electron 能力（文件对话框 + 原生右键 + 菜单事件）
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  // 右键：上报上下文，主进程弹原生菜单
  showCtx: (info) => ipcRenderer.send("dcn:ctx", info),
  // 主进程菜单 / 右键动作回执
  onMenu: (cb) => ipcRenderer.on("dcn:menu", (_e, act) => cb(act)),
  onCtxAct: (cb) => ipcRenderer.on("dcn:ctx-act", (_e, msg) => cb(msg)),
  // 文件存取
  saveFile: (text, defaultName) => ipcRenderer.invoke("dcn:save-file", text, defaultName),
  loadFile: () => ipcRenderer.invoke("dcn:load-file"),
  // 原生窗口全屏（网页 Fullscreen API 不可用时兜底）
  ipc: (channel, arg) => ipcRenderer.send(channel, arg)
});
