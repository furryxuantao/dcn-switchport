/* UI层：Claude暖纸风 + 思科式连线（选线型→选源端口→选目标端口）+ 缩放 + 缓动报文动画 */
(function () {
"use strict";
var Sim = window.DCNSim, CLI = window.DCNCLI, LABS = window.DCNLABS;
var devices = [], links = [], consoles = [], sessions = {}, curId = null;
var history = [], hi = -1, pendingSecret = false, pendingConfirm = null;
var stpInfo = { roles: {} };
var capLog = [];
var linkSeq = 0;
var wireType = null;            // 当前选中的线型（思科式）
var wire = null;                // {type, from, fromPort}
var zoom = 1, panX = 0, panY = 0; // 视图：缩放 + 平移（拖画布空白处平移）
var seenIds = {};                 // 已做过入场动画的设备（避免每次重渲染都重播）

function $(id) { return document.getElementById(id); }
function devById(id) { return devices.find(function (d) { return d.id === id; }); }
function devByName(n) { return devices.find(function (d) { return d.hostname === n; }); }
function sessOf(d) { if (!sessions[d.id]) sessions[d.id] = CLI.createSession(d); return sessions[d.id]; }
function refreshStp() {
  var prev = stpInfo;
  stpInfo = Sim.stpCompute(devices, links);
  render();
  // STP 角色/端口状态变化 → 动画
  var changed = false;
  var cur = stpInfo.roles || {}, was = (prev && prev.roles) || {};
  Object.keys(cur).forEach(function (k) { if (was[k] !== cur[k]) changed = true; });
  if (changed && Object.keys(prevStpRoles).length) animateStpChange();
  else { prevStpRoles = {}; Object.keys(cur).forEach(function (k) { prevStpRoles[k] = cur[k].state; }); }
  updateStormAnim();
}
var statusManualAt = 0;
function status(s) {
  var el = $("status");
  el.innerHTML = (el.textContent && !/^<svg/.test(el.innerHTML) ? "" : "") + escapeHtml(s);
  el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse");
  statusManualAt = Date.now();
}

var WIRE_NAMES = { auto:"自动", copper:"直通线", cross:"交叉线", fiber:"光纤", console:"Console", dce:"DCE串口", dte:"DTE串口" };

/* ---------- 终端 ---------- */
/* ---------- 终端（控制软件式：提示符行内直接输入） ---------- */
function print(html, cls) {
  var t = $("term"); if (!t) return;
  var div = document.createElement("div"); if (cls) div.className = cls; div.innerHTML = html;
  var cur = t.querySelector("#curline");
  if (cur) t.insertBefore(div, cur); else t.appendChild(div);
  fxTypeIn(div);
  t.scrollTop = t.scrollHeight;
}
// 把当前输入行冻结为历史（执行或丢弃时调用）
function freezeEdit(keepText) {
  var t = $("term"); var cur = t.querySelector("#curline"); if (!cur) return "";
  var p = cur.querySelector(".p");
  var ed = cur.querySelector("#edit");
  var line = ed ? ed.textContent : "";
  var div = document.createElement("div");
  var sp = document.createElement("span"); sp.className = "p"; sp.textContent = p ? p.textContent : "";
  div.appendChild(sp); div.appendChild(document.createTextNode(keepText === false ? "" : line));
  cur.replaceWith(div);
  return line;
}
function showPrompt(focus) {
  var d = devById(curId); if (!d) return;
  freezeEdit(true); // 若有未提交的半截输入，原样保留为历史
  var t = $("term");
  var line = document.createElement("div"); line.id = "curline";
  var sp = document.createElement("span"); sp.className = "p"; sp.textContent = CLI.promptFor(d, sessOf(d));
  var ed = document.createElement("span");
  ed.id = "edit"; ed.setAttribute("contenteditable", "true"); ed.setAttribute("spellcheck", "false");
  line.appendChild(sp); line.appendChild(ed);
  t.appendChild(line); t.scrollTop = t.scrollHeight;
  curPromptDev = curId;
  bindEdit(ed);
  if (focus !== false) focusEdit();
}
function focusEdit() {
  var e = $("term").querySelector("#edit");
  if (e && document.activeElement !== e) { e.focus(); setCaret(e, 1); }
}
function setCaret(el, toEnd) {
  try {
    var r = document.createRange(); r.selectNodeContents(el); r.collapse(!toEnd);
    var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
  } catch (e) {}
}
function submitEdit(el) {
  var d = devById(curId);
  if (!d) { freezeEdit(false); print('<span class="dim">先在左侧添加设备并双击它，再输入命令。</span>'); showPrompt(); return; }
  var line = freezeEdit(true);
  if (!line.trim()) { showPrompt(); return; }
  history.push(line); hi = history.length;
  var res = CLI.execLine(ctxFor(d), line);
  if (res.needSecret) pendingSecret = true;
  if (res.streamed) { freezeEdit(false); return; } // 流式：输入行收尾时再补
  if (res.output) print(escapeHtml(res.output));
  showPrompt();
  render();
}

/* ---------- 流式输出队列（ping 逐包浮现） ---------- */
var streamQueue = [], streamTimer = null, busy = false;
function setBusy(b) {
  busy = b;
  var t = $("term");
  var ed = t && t.querySelector("#edit");
  if (ed && ed.getAttribute("contenteditable") !== "false") ed.setAttribute("contenteditable", b ? "false" : "true");
  if (t) t.style.cursor = b ? "progress" : "text";
}
function pumpStream() {
  if (streamTimer) return;
  var next = streamQueue.shift();
  if (!next) {
    setBusy(false);
    var d = devById(curId);
    if (d) { showPrompt(); focusEdit(); }
    return;
  }
  print(escapeHtml(next.text));
  streamTimer = setTimeout(function () { streamTimer = null; pumpStream(); }, next.delay);
}
function tabComplete(el) {
  var d = devById(curId); if (!d) return;
  var cands = CLI.candidatesFor(sessOf(d).mode).map(function (c) { return c.raw; });
  var hits = CLI.resolveAbbrev(el.textContent, cands.map(function (c) { return { raw: c, toks: c.split(" ") }; }));
  if (hits.length === 1) {
    el.textContent = hits[0].raw.replace(/<[^>]+>/g, "").trim() + " ";
    setCaret(el, 1);
  } else if (hits.length > 1) {
    print(hits.map(function (h) { return escapeHtml(h.raw); }).join("<br>"));
  } else print('<span class="e">无匹配</span>');
}
function histNav(el, dir) {
  if (!history.length) return;
  hi = Math.max(0, Math.min(history.length, hi + dir));
  el.textContent = history[hi] || "";
  setCaret(el, 1);
}
function bindEdit(el) {
  el.addEventListener("keydown", function (e) {
    if (e.isComposing) return;
    if (busy && e.key !== "c" && e.key !== "C") { e.preventDefault(); return; } // 输出中锁定输入
    if (e.key === "Enter") { e.preventDefault(); submitEdit(el); }
    else if (e.key === "Tab") { e.preventDefault(); tabComplete(el); }
    else if (e.key === "ArrowUp") { e.preventDefault(); histNav(el, -1); }
    else if (e.key === "ArrowDown") { e.preventDefault(); histNav(el, 1); }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); $("term").innerHTML = ""; showPrompt(); }
    else if (e.key === "c" && e.ctrlKey) { e.preventDefault(); freezeEdit(false); print("^C"); showPrompt(); }
    else if (e.key === "u" && e.ctrlKey) { e.preventDefault(); el.textContent = ""; }
    else if (e.key === "a" && e.ctrlKey) { e.preventDefault(); setCaret(el, 0); }
    else if (e.key === "e" && e.ctrlKey) { e.preventDefault(); setCaret(el, 1); }
  });
  el.addEventListener("paste", function (e) {
    e.preventDefault();
    var t = (e.clipboardData || window.clipboardData).getData("text") || "";
    document.execCommand("insertText", false, t.replace(/\r/g, ""));
  });
}
function setupInput() {
  loadIcons();
  setupFx();
  // 点击终端任意处 → 光标进输入行
  $("term").addEventListener("click", function (e) {
    if (e.target.closest && e.target.closest("#edit")) return;
    focusEdit();
  });
  // Delete 键删除选中的设备（输入框/弹窗内不触发）
  document.addEventListener("keydown", function (e) {
    if ((e.key === "Delete" || e.key === "Backspace") && curId) {
      var ae = document.activeElement;
      var typing = ae && (ae.id === "edit" || ae.id === "modalInput" || ae.tagName === "INPUT" || ae.isContentEditable);
      if (typing) return;
      var d = devById(curId);
      if (d) askConfirm("确定删除设备 " + d.hostname + " 吗？").then(function (ok) { if (ok) delDevice(curId); });
    }
  });
  setupTheme();
}

function ctxFor(dev) {
  return {
    devices: devices, links: links, dev: dev, sess: sessOf(dev),
    stpInfo: function () { return stpInfo; }, refreshStp: refreshStp,
    pendingConfirm: pendingConfirm,
    jump: function (t) { enterCli(t); },
    // 逐包输出：ping 时一行行浮现，而不是一次性全出来
    stream: function (text, delay) {
      setBusy(true);
      streamQueue.push({ text: text, delay: delay || 300 });
      pumpStream();
    },
    factoryReset: function (d) {
      // 恢复出厂设置：hostname 回到设备的出厂名（不能沿用改过的名字）
      var fresh = Sim.createDevice(d.type, d.factoryName || null, d.x, d.y); fresh.id = d.id;
      Object.keys(fresh).forEach(function (k) { d[k] = fresh[k]; });
      sessions[d.id] = CLI.createSession(d); refreshStp();
    },
    ping: function (srcDev, ip) { return doPing(srcDev, ip, false); },
    tracert: function (srcDev, ip) {
      var r = Sim.simulateTracert(devices, links, srcDev, ip);
      if (r.ok) animatePath(r.hops, "ok"); else animateFail(srcDev);
      return r;
    },
    telnetTo: function (srcDev, ip) { return doTelnet(srcDev, ip); }
  };
}
function doPing(srcDev, ip, silent) {
  // 端口安全先行：在第一个包入口即违例（真机行为），而不是通一次再关断
  var sec = checkPortSecurity(srcDev);
  var r = sec.ok ? Sim.simulatePing(devices, links, srcDev, ip, stpInfo)
    : { ok: false, reason: sec.reason, path: [] };
  if (r.storm) {
    print('<span class="e">⚠ 广播风暴阻断：' + escapeHtml(srcDev.hostname + " → " + ip) +
      " 通信失败。请在环路交换机开启 spanning-tree。</span>");
    status("广播风暴 · 通信阻断");
  }
  try {
    var tgt = Sim.findDeviceByIp(devices, ip);
    if (r.ok && tgt) {
      devices.forEach(function (d) {
        if (d.type === "l2" || d.type === "l3") Sim.learnMac(d, srcDev.pcMac || srcDev.mac, Object.keys(d.ports)[0], 1);
      });
    }
  } catch (e) {}
  if (!silent) { if (r.ok) animatePing(srcDev, ip, r); else animateFail(srcDev); }
  pulseNode(srcDev);
  // 延迟信息：同一设备对保持稳定，跨设备不同（真实链路感）
  var latTxt = "";
  if (r.ok && r.latency) {
    latTxt = " " + r.latency.avg + "ms(最短" + r.latency.min + " 最长" + r.latency.max + ")";
  } else if (r.storm) {
    latTxt = " [广播风暴阻断]";
  }
  capLog.unshift((r.ok ? "✓" : "✗") + " " + srcDev.hostname + " ping " + ip + latTxt + (r.ok ? "" : " [" + r.reason + "]"));
  renderCap();
  return r;
}
// 返回 {ok}；违例时直接关断端口并给出原因（供 doPing 先行判定）
function checkPortSecurity(pcDev) {
  if (pcDev.type !== "pc") return { ok: true };
  var l = links.find(function (x) { return x.a.dev === pcDev.id || x.b.dev === pcDev.id; });
  if (!l) return { ok: true };
  var swId = l.a.dev === pcDev.id ? l.b.dev : l.a.dev;
  var swPort = l.a.dev === pcDev.id ? l.b.port : l.a.port;
  var sw = devById(swId); if (!sw || !sw.ports[swPort]) return { ok: true };
  var ps = sw.ports[swPort].portSecurity;
  if (ps.enabled && sw.cpuControl !== false) {
    var mac = pcDev.pcMac;
    if ((ps.staticMacs.length && ps.staticMacs.indexOf(mac) < 0) || (!ps.staticMacs.length && ps.max <= 0)) {
      sw.ports[swPort].violated = true; sw.ports[swPort].shutdown = true; sw.ports[swPort].violatedAt = Date.now();
      print('<span class="e">% Port ' + escapeHtml(swPort) + ' security violation, shutdown.</span>');
      render();
      return { ok: false, reason: "端口安全违例（" + sw.hostname + ":" + swPort + " 已 shutdown）" };
    }
  }
  return { ok: true };
}
function doTelnet(srcDev, ip) {
  var tgt = Sim.findDeviceByIp(devices, ip) || devices.find(function (d) { return d.mgmtIp === ip; });
  if (!tgt) tgt = devices.find(function (d) { return (d.type === "l2" || d.type === "l3") && d.mgmtIp === ip; });
  if (!tgt) return "% 目标不可达 " + ip;
  if (!tgt.telnet.enabled) return "% Telnet服务未开启";
  if (tgt.telnet.securityIp && srcDev.pcIp !== tgt.telnet.securityIp && srcDev.type === "pc") return "% 被 securityip 拒绝（仅允许 " + tgt.telnet.securityIp + "）";
  if (!tgt.users.length) return "% 无用户，请先 username xxx password 0 yyy";
  curId = tgt.id; render(); showPrompt();
  return "连接到 " + tgt.hostname + "（已切换终端上下文，用户名/密码在真机上验证）";
}

function escapeHtml(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

/* ---------- 终端主题（自定义颜色） ---------- */
var THEMES = [
  { name: "陶土暗", bg: "#211C18", ink: "#EDE4D3", acc: "#E8A87C", mut: "#A89C8A" },
  { name: "CRT绿", bg: "#070B07", ink: "#33DD66", acc: "#D6FF5E", mut: "#4E7A5A" },
  { name: "暖纸亮", bg: "#FAF5E9", ink: "#2B2620", acc: "#C15F3C", mut: "#9A8F7F" },
  { name: "冰海蓝", bg: "#0B1220", ink: "#DBE6FF", acc: "#22D3EE", mut: "#8EA0C4" }
];
function curTheme() { try { return JSON.parse(localStorage.getItem("dcn-term-theme")) || null; } catch (e) { return null; } }
function applyTheme(t) {
  var term = $("term"); if (!term || !t) return;
  term.style.setProperty("--tbg", t.bg); term.style.setProperty("--tink", t.ink);
  term.style.setProperty("--tacc", t.acc);
  if (t.mut) term.style.setProperty("--tmut", t.mut);
  term.style.setProperty("--tsize", (t.size || 13) + "px");
  if ($("tcBg")) $("tcBg").value = t.bg;
  if ($("tcInk")) $("tcInk").value = t.ink;
  if ($("tcAcc")) $("tcAcc").value = t.acc;
  if ($("tcSize")) $("tcSize").value = t.size || 13;
  try { localStorage.setItem("dcn-term-theme", JSON.stringify(t)); } catch (e) {}
  Array.prototype.forEach.call(document.querySelectorAll(".swatch"), function (sw) {
    sw.classList.toggle("on", sw.getAttribute("data-t") === t.name);
  });
}
function setupTheme() {
  var row = $("themeRow"); if (!row) return;
  row.innerHTML = THEMES.map(function (t) {
    return '<button class="swatch" data-t="' + t.name + '"><span class="dots"><i style="background:' + t.bg + '"></i><i style="background:' + t.ink + '"></i><i style="background:' + t.acc + '"></i></span>' + t.name + "</button>";
  }).join("");
  Array.prototype.forEach.call(row.querySelectorAll(".swatch"), function (sw) {
    sw.onclick = function () {
      var base = THEMES.filter(function (x) { return x.name === sw.getAttribute("data-t"); })[0] || THEMES[0];
      var cur = curTheme() || {};
      applyTheme(Object.assign({}, base, { size: cur.size || 13 }));
    };
  });
  function custom() {
    var base = curTheme() || THEMES[0];
    applyTheme({ name: "custom", bg: $("tcBg").value, ink: $("tcInk").value, acc: $("tcAcc").value, mut: base.mut, size: +$("tcSize").value || 13 });
  }
  ["tcBg", "tcInk", "tcAcc"].forEach(function (id) { $(id).oninput = custom; $(id).onchange = custom; });
  $("tcSize").oninput = function () {
    var c = curTheme() || Object.assign({}, THEMES[0]);
    c.size = +$("tcSize").value; applyTheme(c);
  };
  $("tcReset").onclick = function () {
    try { localStorage.removeItem("dcn-term-theme"); } catch (e) {}
    applyTheme(Object.assign({}, THEMES[0]));
  };
  applyTheme(curTheme() || Object.assign({}, THEMES[0]));
}

/* ---------- 端口分类与兼容 ---------- */
function isEth(pn) { return pn === "eth0" || pn.charAt(0) === "e" || pn.charAt(0) === "g"; }
function isSer(pn) { return pn.charAt(0) === "s"; }
function usedPorts(devId) {
  var u = {};
  links.forEach(function (l) {
    if (l.a.dev === devId) u[l.a.port] = 1;
    if (l.b.dev === devId) u[l.b.port] = 1;
  });
  return u;
}
function portMeta(dev, pn) {
  if (pn === "eth0") return dev.pcIp || "PC网卡";
  var p = dev.ports[pn]; if (!p) return "";
  var cfg = dev.ifIp[pn];
  if (isSer(pn)) return (cfg && cfg.ip ? cfg.ip : "未配IP") + (p.shutdown ? "·down" : "");
  return (p.mode === "trunk" ? "trunk" : "acc:v" + p.accessVlan) + (cfg && cfg.ip ? "·" + cfg.ip : "") + (p.shutdown ? "·down" : "");
}
// 线型对单端口的要求，返回 null=可用，字符串=不可用原因
function wirePortCheck(type, dev, pn, used) {
  if (used[pn]) return "已连线";
  if (type === "copper" || type === "cross" || type === "fiber" || type === "auto") {
    if (!isEth(pn)) return "此线只接以太网口";
    return null;
  }
  if (type === "dce" || type === "dte") {
    if (!isSer(pn)) return "串口线只接 s 口";
    if (dev.type !== "router") return "串口只连路由器";
    return null;
  }
  return null;
}
// 一对端口能否用某线型相连
function wirePairCheck(type, aDev, aPn, bDev, bPn) {
  if (aDev.id === bDev.id) return "不能自连";
  if (type === "console") return null; // console 走独立逻辑
  if (type === "auto") {
    if (isSer(aPn) && isSer(bPn)) return null;
    if (isEth(aPn) && isEth(bPn)) return null;
    return "两端端口类型不一致（以太网口只能连以太网口，串口只能连串口）";
  }
  if (type === "copper" || type === "cross" || type === "fiber") {
    if (!(isEth(aPn) && isEth(bPn))) return "此线两端都必须是以太网口";
    return null;
  }
  if (type === "dce" || type === "dte") {
    if (!(isSer(aPn) && isSer(bPn))) return "串口线两端都必须是 s 口";
    return null;
  }
  return "未知线型";
}

/* ---------- 通用确认弹窗（替代原生 confirm，风格统一） ---------- */
function askConfirm(msg) {
  return new Promise(function (resolve) {
    var back = $("modalBack"), inp = $("modalInput"), title = $("modalTitle"), okBtn = $("modalOk");
    var hint = $("modalHint");
    var prevTitle = title.textContent, prevMode = inp.getAttribute("data-mode");
    var prevHint = hint.textContent, prevHintDisp = hint.style.display;
    title.textContent = "请确认";
    hint.textContent = msg || ""; hint.style.display = "block";
    inp.style.display = "none";
    okBtn.textContent = "确定";
    back.style.display = "flex";
    okBtn.focus();
    function done(ok) {
      back.style.display = "none";
      title.textContent = prevTitle;
      inp.style.display = "";
      inp.setAttribute("data-mode", prevMode || "rename");
      hint.textContent = prevHint; hint.style.display = prevHintDisp;
      okBtn.onclick = null;
      document.removeEventListener("keydown", onKey, true);
      resolve(ok);
    }
    function onKey(e) {
      if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(e.key === "Enter"); }
      else e.stopPropagation();
    }
    okBtn.onclick = function () { done(true); };
    $("modalCancel").onclick = function () { done(false); };
    back.onclick = function (e) { if (e.target === back) done(false); };
    document.addEventListener("keydown", onKey, true);
  });
}

/* ---------- 端口选择器 ---------- */
function hidePicker() { var p = $("portPicker"); p.classList.remove("show"); p.innerHTML = ""; }
function showPortPicker(dev, title, subtitle, checkFn, onPick) {
  var pk = $("portPicker");
  // 定位：设备逻辑坐标→屏幕坐标
  var wrap = $("canvasWrap");
  var sx = dev.x * zoom + panX + 90, sy = dev.y * zoom + panY - 40;
  sx = Math.max(8, Math.min(wrap.clientWidth - 270, sx));
  sy = Math.max(8, Math.min(wrap.clientHeight - 200, sy));
  pk.style.left = sx + "px"; pk.style.top = sy + "px";
  var used = usedPorts(dev.id);
  var rows = Object.keys(dev.ports).map(function (pn) {
    var reason = checkFn(dev, pn, used);
    var p = dev.ports[pn];
    var dot = p.shutdown ? "#B3402E" : "#2F7D4F";
    var info = reason || portMeta(dev, pn);
    return '<button class="portrow" data-p="' + pn + '"' + (reason ? " disabled" : "") + '>' +
      '<span class="dot" style="background:' + dot + '"></span>' + escapeHtml(pn) +
      '<span class="meta">' + escapeHtml(info) + "</span></button>";
  }).join("");
  pk.innerHTML = "<h4>" + escapeHtml(title) + " <small>" + escapeHtml(subtitle || "") + "</small></h4>" + rows +
    '<button class="ppclose">取消（Esc）</button>';
  pk.classList.add("show");
  try { pk.animate([{ opacity: 0, transform: "translateY(-6px) scale(.98)" }, { opacity: 1, transform: "none" }], { duration: 180, easing: "ease-out" }); } catch (e) {}
  Array.prototype.forEach.call(pk.querySelectorAll(".portrow:not(:disabled)"), function (b) {
    b.onclick = function () { hidePicker(); onPick(b.getAttribute("data-p")); };
  });
  pk.querySelector(".ppclose").onclick = cancelWire;
}

/* ---------- 思科式连线流程 ---------- */
function setWireType(t) {
  wireType = (wireType === t) ? null : t;
  wire = null; hidePicker();
  Array.prototype.forEach.call(document.querySelectorAll(".wirebtn"), function (b) {
    var on = b.getAttribute("data-wire") === wireType;
    b.classList.toggle("armed", on);
    if (on) { try { b.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }], { duration: 240 }); } catch (e) {} }
  });
  var h = $("linkHint");
  if (wireType) {
    h.innerHTML = "当前连线：<b>" + WIRE_NAMES[wireType] + "</b> — ①点击源设备选端口";
    h.classList.add("live");
  } else { h.textContent = "当前连线：无"; h.classList.remove("live"); }
  render();
}
function cancelWire() {
  wire = null; hidePicker();
  var h = $("linkHint");
  if (wireType) { h.innerHTML = "当前连线：<b>" + WIRE_NAMES[wireType] + "</b> — ①点击源设备选端口"; h.classList.add("live"); }
  else { h.textContent = "当前连线：无"; h.classList.remove("live"); }
  render();
}
// Esc / 彻底取消：线型也一并清除
function cancelAllWire() {
  wire = null; hidePicker(); wireType = null;
  Array.prototype.forEach.call(document.querySelectorAll(".wirebtn"), function (b) { b.classList.remove("armed"); });
  var h = $("linkHint");
  if (h) { h.textContent = "当前连线：无"; h.classList.remove("live"); }
  render();
}
var curPromptDev = null; // 当前输入行归属的设备（避免给错设备下发命令）
function onNodeClick(dev, ev) {
  var active = wireType || (ev && ev.shiftKey ? "auto" : null);
  if (!active) {
    // 单击：选中 + 切换 CLI 上下文（不抢焦点，Delete 键可用）；双击才聚焦输入
    var need = (curId !== dev.id) || (curPromptDev !== dev.id);
    curId = dev.id;
    markSelected();
    renderCfg();
    if (need) showPrompt(false);
    status("已选中 " + dev.hostname + "（双击进入 CLI 输入）");
    return;
  }
  var type = wireType || "auto";
  if (type === "console") { wireConsoleFlow(dev); return; }
  if (!wire || wire.type !== type) {
    // 步骤1：选源端口
    showPortPicker(dev, dev.hostname + " — 选择源端口", WIRE_NAMES[type],
      function (d, pn, used) { return wirePortCheck(type, d, pn, used); },
      function (pn) {
        wire = { type: type, from: dev, fromPort: pn };
        var h = $("linkHint");
        h.innerHTML = "当前连线：<b>" + WIRE_NAMES[type] + "</b> " + escapeHtml(dev.hostname + ":" + pn) + " → ②点击目标设备选端口";
        h.classList.add("live");
        render(); toast("已选 " + dev.hostname + ":" + pn + "，再点目标设备");
      });
  } else {
    if (dev.id === wire.from.id) { toast("源与目标不能是同一台"); return; }
    // 步骤2：选目标端口
    var from = wire.from, fp = wire.fromPort;
    // 对端已选端口也视为占用，避免两端选到同一端口
    var peerUsed = Object.assign({}, usedPorts(dev.id));
    peerUsed[fp] = 1;
    showPortPicker(dev, dev.hostname + " — 选择目标端口", WIRE_NAMES[type] + " · 对端 " + from.hostname + ":" + fp,
      function (d, pn, used) {
        var r = wirePortCheck(type, d, pn, peerUsed);
        if (r) return r;
        return wirePairCheck(type, from, fp, d, pn);
      },
      function (tp) { createDataLink(type, from, fp, dev, tp); });
  }
}
function wireConsoleFlow(dev) {
  if (!wire || wire.type !== "console") {
    if (dev.type === "pc") { toast("Console 线请先点交换机/路由器，再点 PC"); return; }
    wire = { type: "console", from: dev };
    var h = $("linkHint"); h.innerHTML = "当前连线：<b>Console</b> " + escapeHtml(dev.hostname) + " → ②点击一台 PC";
    h.classList.add("live"); render(); toast("已选 " + dev.hostname + "，再点一台 PC");
  } else {
    if (dev.type !== "pc") { toast("Console 线目标必须是 PC"); return; }
    if (dev.id === wire.from.id) { cancelWire(); return; }
    consoles.push({ id: "c" + Date.now().toString(36), a: { dev: wire.from.id }, b: { dev: dev.id } });
    toast("Console 已连接 " + wire.from.hostname + " ↔ " + dev.hostname + "（点设备即用 CLI）");
    status("Console：" + wire.from.hostname + " ↔ " + dev.hostname);
    wire = null; setWireType(null); render();
  }
}
function setWireTypeKeep() {
  var h = $("linkHint");
  if (wireType) h.innerHTML = "当前连线：<b>" + WIRE_NAMES[wireType] + "</b> — ①点击源设备选端口";
  else { h.textContent = "当前连线：无"; h.classList.remove("live"); }
}
function createDataLink(type, aDev, aPn, bDev, bPn) {
  var err = wirePairCheck(type, aDev, aPn, bDev, bPn);
  if (err) { toast(err); wire = null; setWireTypeKeep(); return; }
  var real = type;
  if (type === "auto") real = (isSer(aPn) && isSer(bPn)) ? "dte" : "copper";
  var link = { id: "l" + (++linkSeq) + Date.now().toString(36), a: { dev: aDev.id, port: aPn }, b: { dev: bDev.id, port: bPn } };
  if (real === "fiber") link.fiber = true;
  else if (real === "cross") link.cross = true;
  else if (real === "dce" || real === "dte") { link.serial = true; link.dceEnd = real === "dce" ? "a" : "b"; }
  links.push(link);
  var extra = link.serial ? "（串口，" + (aPn === "s1/0" || bPn === "s1/0" ? "s1/0 端配 physical-layer speed 64000" : "需配时钟") + "）" : "";
  toast("已连接 " + aDev.hostname + ":" + aPn + " ↔ " + bDev.hostname + ":" + bPn);
  status("已连接 " + aDev.hostname + ":" + aPn + " ↔ " + bDev.hostname + ":" + bPn + extra);
  setWireType(null); // 连完即收工，避免线型一直 armed 导致点设备进不了 CLI
  refreshStp();
}
document.addEventListener("keydown", function (e) {
  if (e.key === "Escape") cancelAllWire();
});

/* ================= 图标（Lucide SVG，本地加载 + 着色） ================= */
var ICON_SPRITE = {};
function injectSprite(svgStr) {
  var box = document.createElement("span");
  box.innerHTML = svgStr;
  var svg = box.querySelector("svg");
  if (svg) { svg.setAttribute("class", "ic-svg"); box.firstChild.remove(); return svg; }
  return null;
}
function loadIcons() {
  var map = window.DCNICONS || {};
  var paint = function () { paintIcons(); paintIcons(); };
  if (typeof fetch !== "function") { paint(); return; }
  var jobs = Object.keys(map).map(function (name) {
    return fetch(map[name])
      .then(function (r) { return r.text(); })
      .then(function (t) { var svg = injectSprite(t); if (svg) ICON_SPRITE[name] = svg.outerHTML; })
      .catch(function () {});
  });
  // 先上占位骨架，图标到位后替换
  paint();
  Promise.all(jobs).then(paint);
  setTimeout(paint, 120); setTimeout(paint, 500); setTimeout(paint, 1500);
}
function iconHtml(name) {
  if (ICON_SPRITE[name]) return '<span class="ico" aria-hidden="true">' + ICON_SPRITE[name] + "</span>";
  return '<span class="ico ico-ph" aria-hidden="true"></span>';
}
function paintIcons(root) {
  (root || document).querySelectorAll("[data-icon]").forEach(function (el) {
    var n = el.getAttribute("data-icon");
    if (!ICON_SPRITE[n]) return;
    el.innerHTML = ICON_SPRITE[n];
    el.classList.add("icon-ready");
  });
}

/* ================= 全局动效引擎 ================= */
// 按钮/任意可点元素：涟漪
function fxRipple(e, host) {
  var r = host.getBoundingClientRect();
  var size = Math.max(r.width, r.height) * 2.2;
  var s = document.createElement("span");
  s.className = "ripple";
  s.style.width = s.style.height = size + "px";
  s.style.left = ((e.clientX || r.left + r.width / 2) - r.left - size / 2) + "px";
  s.style.top = ((e.clientY || r.top + r.height / 2) - r.top - size / 2) + "px";
  host.appendChild(s);
  setTimeout(function () { s.remove(); }, 620);
}
function setupRipple() {
  document.addEventListener("pointerdown", function (e) {
    var t = e.target.closest && e.target.closest("button, .devbtn, .wirebtn, .ctxitem, .portrow, .task button, .swatch");
    if (t) fxRipple(e, t);
  }, { passive: true });
}
// 彩纸粒子（载入实验 / 一键答案）
function fxConfetti(n, originEl) {
  var layer = $("fxLayer"); if (!layer) return;
  var o = originEl && originEl.getBoundingClientRect ? originEl.getBoundingClientRect() : { left: innerWidth / 2, top: 60, width: 0 };
  var colors = ["#C15F3C", "#E8A87C", "#FDE68A", "#7C5CBF", "#2F7D4F", "#22D3EE"];
  for (var i = 0; i < (n || 42); i++) {
    var p = document.createElement("i");
    p.className = "confetti";
    p.style.background = colors[i % colors.length];
    p.style.left = (o.left + Math.random() * (o.width || 120)) + "px";
    p.style.top = o.top + "px";
    var ang = Math.random() * Math.PI * 2, v = 2 + Math.random() * 5;
    p.style.setProperty("--vx", Math.cos(ang) * v + "px");
    p.style.setProperty("--vy", Math.sin(ang) * v - 3 + "px");
    p.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
    p.style.animationDuration = (900 + Math.random() * 700) + "ms";
    layer.appendChild(p);
    setTimeout(function (el) { return function () { el.remove(); }; }(p), 1800);
  }
}
// 设备“落地”粒子
function fxDeviceSpawn(sx, sy) {
  var layer = $("fxLayer"); if (!layer) return;
  for (var i = 0; i < 14; i++) {
    var p = document.createElement("i");
    var ang = (i / 14) * Math.PI * 2;
    p.className = "spawn";
    p.style.left = sx + "px"; p.style.top = sy + "px";
    p.style.setProperty("--vx", Math.cos(ang) * 44 + "px");
    p.style.setProperty("--vy", Math.sin(ang) * 44 + "px");
    layer.appendChild(p);
    setTimeout(function (el) { return function () { el.remove(); }; }(p), 900);
  }
}
// 终端打印机：逐行淡入上移
function fxTypeIn(el) {
  if (!el || el._typed) return;
  el._typed = true;
  try {
    el.animate([{ opacity: 0, transform: "translateY(5px)" }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
  } catch (e) {}
}
// 状态牌切换闪动
function fxBadgeFlash(el) {
  if (!el) return;
  try { el.animate([{ transform: "scale(1)" }, { transform: "scale(1.14)" }, { transform: "scale(1)" }], { duration: 260 }); } catch (e) {}
}
// toast 弹出带图标 + 弹性
function toast(s, ico) {
  var t = $("toast");
  t.innerHTML = (ico ? iconHtml(ico) : "") + "<span>" + escapeHtml(s) + "</span>";
  t.classList.add("show");
  clearTimeout(t._h);
  t._h = setTimeout(function () { t.classList.remove("show"); }, 2400);
}
function setupFx() {
  setupRipple();
  // 面板入场
  document.querySelectorAll("main .card").forEach(function (c, i) {
    try { c.animate([{ opacity: 0, transform: "translateY(10px)" }, { opacity: 1, transform: "none" }],
      { duration: 420, delay: 60 + i * 70, easing: "cubic-bezier(.2,.8,.2,1)", fill: "backwards" }); } catch (e) {}
  });
}

/* ================= 右键菜单（网页内自定义；Electron 走原生） ================= */
function findCtxTarget(el) {
  if (!el || !el.closest) return { kind: "bg" };
  var node = el.closest(".node");
  if (node) {
    var idx = Array.prototype.indexOf.call($("nodes").children, node);
    var d = devices[idx];
    if (d) return { kind: "device", id: d.id, name: d.hostname };
  }
  var g = el.closest("g[data-link]");
  if (g) {
    var l = links.filter(function (x) { return x.id === g.getAttribute("data-link"); })[0];
    if (l) {
      var a = devById(l.a.dev), b = devById(l.b.dev);
      return { kind: "link", id: l.id, label: (a ? a.hostname : "?") + ":" + l.a.port + " ↔ " + (b ? b.hostname : "?") + ":" + l.b.port };
    }
  }
  return { kind: "bg" };
}
function hideHtmlCtx() { var m = $("ctxmenu"); if (m) { m.classList.remove("show"); m.innerHTML = ""; } }
function showHtmlCtx(t, cx, cy) {
  var m = $("ctxmenu");
  var items = [];
  if (t.kind === "device") {
    items = [
      { label: "进入 " + t.name + " 的 CLI", fn: function () { ctxAction("enter-cli", t.id); } },
      { label: "重命名设备…", fn: function () { ctxAction("rename-dev", t.id); } },
      { sep: 1 },
      { label: "从此连线（直通线）", fn: function () { ctxAction("wire-from", { id: t.id, wire: "copper" }); } },
      { label: "从此连线（串口 DCE）", fn: function () { ctxAction("wire-from", { id: t.id, wire: "dce" }); } },
      { label: "从此连线（Console）", fn: function () { ctxAction("wire-from", { id: t.id, wire: "console" }); } },
      { sep: 1 },
      { label: "ping 本设备", fn: function () { ctxAction("ping-dev", t.id); } },
      { label: "删除设备", danger: 1, fn: function () { ctxAction("del-dev", t.id); } }
    ];
  } else if (t.kind === "link") {
    items = [{ label: "删除连线（" + t.label + "）", danger: 1, fn: function () { ctxAction("del-link", t.id); } }];
  } else {
    items = [
      { label: "添加 PC", fn: function () { ctxAction("add-dev", "pc"); } },
      { label: "添加二层交换机", fn: function () { ctxAction("add-dev", "l2"); } },
      { label: "添加三层交换机", fn: function () { ctxAction("add-dev", "l3"); } },
      { label: "添加路由器", fn: function () { ctxAction("add-dev", "router"); } },
      { sep: 1 },
      { label: "清空画布", danger: 1, fn: function () { ctxAction("clear"); } }
    ];
  }
  m.innerHTML = items.map(function (it, i) {
    return it.sep ? '<div class="ctxsep"></div>'
      : '<button class="ctxitem' + (it.danger ? " danger" : "") + '" data-i="' + i + '">' + escapeHtml(it.label) + "</button>";
  }).join("");
  m.classList.add("show");
  var mw = 240, mh = items.length * 34 + 16;
  m.style.left = Math.min(cx, window.innerWidth - mw - 10) + "px";
  m.style.top = Math.min(cy, window.innerHeight - mh - 10) + "px";
  Array.prototype.forEach.call(m.querySelectorAll(".ctxitem"), function (b) {
    b.onclick = function (ev) { ev.stopPropagation(); hideHtmlCtx(); items[+b.getAttribute("data-i")].fn(); };
  });
}
function delDevice(id) {
  var d = devById(id); if (!d) return;
  devices = devices.filter(function (x) { return x.id !== id; });
  links = links.filter(function (l) { return l.a.dev !== id && l.b.dev !== id; });
  consoles = consoles.filter(function (c) { return c.a.dev !== id && c.b.dev !== id; });
  if (curId === id) curId = devices.length ? devices[0].id : null;
  refreshStp(); toast("已删除 " + d.hostname);
}
function delLink(id) {
  links = links.filter(function (l) { return l.id !== id; });
  refreshStp(); toast("连线已删除");
}
function pingDevice(id) {
  var tgt = devById(id); if (!tgt) return;
  var tip = Sim.deviceIpList(tgt)[0];
  if (!tip) { toast(tgt.hostname + " 还没有 IP，无法 ping"); return; }
  var src = devices.filter(function (d) { return d.type === "pc"; })[0]
    || devices.filter(function (d) { return d.type === "router" || d.type === "l3"; })[0];
  if (!src) { toast("画布上没有可发起 ping 的设备"); return; }
  if (src.id === tgt.id) { print(escapeHtml(tgt.hostname + " 自测 " + tip + " → 连通（本机）")); return; }
  var r = doPing(src, tip);
  print(escapeHtml(src.hostname + " ping " + tip + "（" + tgt.hostname + "）→ " + (r.ok ? "连通" : "不通：" + r.reason)));
}
// 双击/右键统一入口：进入某台设备的 CLI
function enterCli(d) {
  if (!d) return;
  if (wireType) return; // 连线模式下双击不切 CLI
  curId = d.id;
  markSelected();
  renderCfg();
  switchTab("cli");
  showPrompt(); focusEdit();
  status("已进入 " + d.hostname + " 的 CLI");
  toast("已连接 " + d.hostname, "terminal");
}
function switchTab(t) {
  document.querySelectorAll("#rightTabs button").forEach(function (x) { x.classList.toggle("on", x.getAttribute("data-t") === t); });
  document.querySelectorAll(".tabpage").forEach(function (p) { p.classList.remove("on"); });
  var pg = $("pg-" + t); if (pg) pg.classList.add("on");
}
// 右键/菜单动作统一入口（网页菜单与 Electron 原生菜单共用）
function ctxAction(act, arg) {
  if (act === "enter-cli") {
    var d = devById(arg); if (d) enterCli(d);
  } else if (act === "rename-dev") showRename(arg);
  else if (act === "wire-from") {
    var src = devById(arg.id); if (!src) return;
    setWireType(arg.wire);
    wire = { type: arg.wire, from: src };
    var h = $("linkHint");
    h.innerHTML = arg.wire === "console"
      ? "当前连线：<b>Console</b> " + escapeHtml(src.hostname) + " → 再点一台 PC"
      : "当前连线：<b>" + WIRE_NAMES[arg.wire] + "</b> " + escapeHtml(src.hostname) + " → 再点目标设备选端口";
    h.classList.add("live");
    render(); toast("已选源 " + src.hostname + "，再点目标设备");
  } else if (act === "ping-dev") pingDevice(arg);
  else if (act === "del-dev") askConfirm("确定删除这台设备吗？").then(function (ok) { if (ok) delDevice(arg); });
  else if (act === "del-link") askConfirm("确定删除这根连线吗？").then(function (ok) { if (ok) delLink(arg); });
  else if (act === "add-dev") addDevice(arg);
  else if (act === "clear") $("btnClear").click();
}
/* ---------- 重命名（与 CLI 的 hostname 同一字段） ---------- */
var renameTarget = null;
function showRename(id) {
  var d = devById(id); if (!d) return;
  renameTarget = id;
  hideHtmlCtx();
  $("modalTitle").textContent = "重命名设备（当前：" + d.hostname + "）";
  var hint = $("modalHint"); if (hint) { hint.textContent = "名字不能含空格（会破坏 CLI 解析），最长 32 字符"; hint.style.display = "block"; }
  $("modalInput").value = d.hostname;
  $("modalBack").style.display = "flex";
  try { $("modal").animate([{ opacity: 0, transform: "scale(.94)" }, { opacity: 1, transform: "none" }], { duration: 200, easing: "cubic-bezier(.2,1.2,.3,1)" }); } catch (e) {}
  setTimeout(function () { $("modalInput").focus(); $("modalInput").select(); }, 50);
}
function hideRename() { renameTarget = null; $("modalBack").style.display = "none"; }
function confirmRename() {
  var d = devById(renameTarget); if (!d) { hideRename(); return; }
  var v = $("modalInput").value.trim();
  if (!v) { toast("名字不能为空"); return; }
  if (/\s/.test(v)) { toast("名字不能含空格（会破坏 CLI 解析）"); return; }
  if (v.length > 32) { toast("名字最长 32 字符"); return; }
  var old = d.hostname;
  d.hostname = v;
  hideRename(); render(); renderTasks();
  print('<span class="dim">已重命名：' + escapeHtml(old) + " → " + escapeHtml(v) + "（等价于 hostname " + escapeHtml(v) + "）</span>");
  toast("已重命名为 " + v);
}
function setupCtxMenu() {
  var wrap = $("canvasWrap");
  wrap.addEventListener("contextmenu", function (e) {
    e.preventDefault();
    var t = findCtxTarget(e.target);
    if (window.electronAPI) { window.electronAPI.showCtx(t); return; }
    showHtmlCtx(t, e.clientX, e.clientY);
  });
  document.addEventListener("click", function (e) {
    var m = $("ctxmenu");
    if (m && m.classList.contains("show") && !m.contains(e.target)) hideHtmlCtx();
  });
  if (window.electronAPI) {
    window.electronAPI.onCtxAct(function (msg) { ctxAction(msg.act, msg.arg); });
    window.electronAPI.onMenu(function (actName) {
      if (actName === "save-file") saveToFile();
      else if (actName === "load-file") loadFromFile();
      else if (actName === "export-report") exportReport();
      else if (actName === "help") $("btnHelp").click();
    });
  }
}

/* ---------- 拓扑存取（浏览器存 localStorage，exe 存文件） ---------- */
function topoData() { return { app: "dcn-simulator", version: 2, devices: devices, links: links, consoles: consoles, view: { zoom: zoom, panX: panX, panY: panY } }; }
function applyTopoData(o) {
  devices = o.devices || []; links = o.links || []; consoles = o.consoles || [];
  if (o.view) { zoom = o.view.zoom || 1; panX = o.view.panX || 0; panY = o.view.panY || 0; }
  else { zoom = 1; panX = 0; panY = 0; }
  sessions = {}; curId = devices.length ? devices[0].id : null;
  wire = null; hidePicker(); hideHtmlCtx();
  refreshStp(); renderTasks();
  if (!o.view) fitView();
  if (curId) showPrompt();
}
function saveToFile() {
  var text = JSON.stringify(topoData(), null, 2);
  if (!devices.length) { toast("空画布无需保存"); return; }
  if (window.electronAPI) {
    window.electronAPI.saveFile(text, "dcn-topo.json").then(function (p) {
      if (p) { toast("已保存到文件"); status("已保存：" + p); }
    });
  } else {
    try { localStorage.setItem("dcn-topo", text); toast("拓扑已保存到浏览器"); status("拓扑已保存到浏览器"); }
    catch (e) { toast("保存失败"); }
  }
}
function loadFromFile() {
  if (window.electronAPI) {
    window.electronAPI.loadFile().then(function (r) {
      if (!r) return;
      try { applyTopoData(JSON.parse(r.text)); print("已从文件载入拓扑", "ok"); toast("已载入"); }
      catch (e) { toast("文件格式错误"); }
    });
    return;
  }
  try {
    var o = JSON.parse(localStorage.getItem("dcn-topo"));
    if (!o || !o.devices) { toast("没有保存的拓扑"); return; }
    applyTopoData(o); print("已恢复保存的拓扑", "ok");
  } catch (e) { toast("读取失败"); }
}
function exportReport() {
  var lines = ["DCN 实验报告导出 " + new Date().toLocaleString(),
    "拓扑：设备 " + devices.length + " 台，连线 " + links.length + " 条", ""];
  devices.forEach(function (d) {
    lines.push("===== " + d.hostname + "（" + d.type + "） =====");
    lines.push(Sim.showRunningConfig(d));
    lines.push("");
  });
  lines.push("===== 抓包 / ping 记录 =====");
  if (capLog.length) capLog.slice().reverse().forEach(function (l) { lines.push(l); });
  else lines.push("（暂无）");
  var text = lines.join("\n");
  if (window.electronAPI) {
    window.electronAPI.saveFile(text, "dcn-report.txt").then(function (p) { if (p) toast("报告已导出"); });
  } else {
    var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = "dcn-report.txt"; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    toast("报告已下载");
  }
}

/* ---------- 拓扑渲染 ---------- */
function curvePath(a, b) {
  var dx = b.x - a.x, dy = b.y - a.y;
  var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  var len = Math.sqrt(dx * dx + dy * dy) || 1;
  var off = Math.min(34, len * 0.12);
  var nx = -dy / len, ny = dx / len;
  return "M" + a.x + " " + a.y + " Q" + (mx + nx * off) + " " + (my + ny * off) + " " + b.x + " " + b.y;
}
var LINK_STYLE = {
  copper: { c: "#C15F3C", halo: "#D9A07A", dash: null },
  cross: { c: "#7C5CBF", halo: "#C4B2EC", dash: null },
  fiber: { c: "#C9980A", halo: "#EDD489", dash: null },
  serial: { c: "#5B6BC0", halo: "#B9C1EC", dash: "9 5" }
};
function linkKind(l) {
  if (l.serial) return "serial";
  if (l.fiber) return "fiber";
  if (l.cross) return "cross";
  return "copper";
}
function render() {
  sizeSvg();
  drawSvg();
  syncNodes();
  applyZoom();
  renderCfg();
}
function sizeSvg() {
  var svg = $("topo"), wrap = $("canvasWrap");
  var w = wrap.clientWidth || 600, h = wrap.clientHeight || 420;
  svg.setAttribute("width", w); svg.setAttribute("height", h); svg.setAttribute("viewBox", "0 0 " + w + " " + h);
}
function drawSvg() {
  var svg = $("topo");
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  var defs = document.createElementNS("http://www.w3.org/2000/svg", "defs");
  defs.innerHTML = '<filter id="glow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>';
  svg.appendChild(defs);

  links.forEach(function (l) {
    var a = devById(l.a.dev), b = devById(l.b.dev); if (!a || !b) return;
    var up = Sim.linkOperUp(devices, l, stpInfo);
    var st = LINK_STYLE[linkKind(l)];
    var g = document.createElementNS("http://www.w3.org/2000/svg", "g");
    g.setAttribute("data-link", l.id);
    var halo = document.createElementNS("http://www.w3.org/2000/svg", "path");
    halo.setAttribute("d", curvePath(a, b)); halo.setAttribute("fill", "none");
    halo.setAttribute("stroke", up ? st.halo : "#D98880");
    halo.setAttribute("stroke-width", "9"); halo.setAttribute("opacity", ".28"); halo.setAttribute("stroke-linecap", "round");
    var main = document.createElementNS("http://www.w3.org/2000/svg", "path");
    main.setAttribute("d", curvePath(a, b)); main.setAttribute("fill", "none");
    main.setAttribute("stroke", up ? st.c : "#B3402E");
    main.setAttribute("stroke-width", up ? "2.6" : "2"); main.setAttribute("stroke-linecap", "round");
    if (st.dash) main.setAttribute("stroke-dasharray", st.dash);
    else if (!up) main.setAttribute("stroke-dasharray", "4 5");
    main.style.cursor = "pointer"; main.setAttribute("filter", "url(#glow)");
    var kindName = l.serial ? "串口" : l.fiber ? "光纤" : l.cross ? "交叉线" : "直通线";
    main.innerHTML = "<title>" + escapeHtml(kindName + " " + a.hostname + ":" + l.a.port + " ↔ " + b.hostname + ":" + l.b.port) + " · 点击删除</title>";
    main.onclick = function () {
      askConfirm("确定删除这根连线吗？" + (up ? "" : "\n（当前链路是 down 状态）")).then(function (ok) {
        if (!ok) return;
        links = links.filter(function (x) { return x.id !== l.id; });
        refreshStp(); toast("连线已删除");
      });
    };
    g.appendChild(halo); g.appendChild(main);
    if (up) {
      var flow = document.createElementNS("http://www.w3.org/2000/svg", "path");
      flow.setAttribute("d", curvePath(a, b)); flow.setAttribute("fill", "none");
      flow.setAttribute("stroke", "#FFFDF6"); flow.setAttribute("stroke-width", "1.4");
      flow.setAttribute("stroke-dasharray", "2 14"); flow.setAttribute("opacity", ".85"); flow.setAttribute("stroke-linecap", "round");
      var anim = document.createElementNS("http://www.w3.org/2000/svg", "animate");
      anim.setAttribute("attributeName", "stroke-dashoffset"); anim.setAttribute("from", "0"); anim.setAttribute("to", "-32");
      anim.setAttribute("dur", "1.2s"); anim.setAttribute("repeatCount", "indefinite");
      flow.appendChild(anim); g.appendChild(flow);
    }
    svg.appendChild(g);
    var label = document.createElementNS("http://www.w3.org/2000/svg", "text");
    label.setAttribute("x", (a.x + b.x) / 2); label.setAttribute("y", (a.y + b.y) / 2 - 10);
    label.setAttribute("text-anchor", "middle"); label.setAttribute("font-size", "10.5"); label.setAttribute("fill", "#6B6257");
    label.setAttribute("paint-order", "stroke"); label.setAttribute("stroke", "#FAF5E9"); label.setAttribute("stroke-width", "4");
    label.setAttribute("font-family", "JetBrains Mono,Cascadia Code,Consolas,monospace");
    label.textContent = l.a.port + " ↔ " + l.b.port;
    svg.appendChild(label);
  });

  // Console 线（仅展示，不参与仿真）
  consoles.forEach(function (c, idx) {
    var a = devById(c.a.dev), b = devById(c.b.dev); if (!a || !b) return;
    var p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    var off = 26 + idx * 8;
    p.setAttribute("d", "M" + a.x + " " + a.y + " Q" + ((a.x + b.x) / 2) + " " + ((a.y + b.y) / 2 + off) + " " + b.x + " " + b.y);
    p.setAttribute("fill", "none"); p.setAttribute("stroke", "#9A8F7F"); p.setAttribute("stroke-width", "1.6");
    p.setAttribute("stroke-dasharray", "3 4"); p.style.cursor = "pointer";
    p.innerHTML = "<title>Console " + escapeHtml(a.hostname + " ↔ " + b.hostname) + " · 点击删除</title>";
    (function (id) { p.onclick = function () { askConfirm("确定删除这根 Console 线吗？").then(function (ok) { if (ok) { consoles = consoles.filter(function (x) { return x.id !== id; }); render(); } }); }; })(c.id);
    svg.appendChild(p);
  });

  $("stormBar").style.display = detectStorm() ? "block" : "none";
  updateStormAnim();
  $("emptyState").style.display = devices.length ? "none" : "flex";
}
function syncNodes() {
  var nodes = $("nodes");
  nodes.innerHTML = "";
  var typeName = { pc: "PC", l2: "二层", l3: "三层", router: "路由" };
  var typeIcon = { pc: "pc", l2: "switch", l3: "l3", router: "router" };
  // seenIds 声明在模块顶层（doLoadLab 也要用），此处只取当前引用
  devices.forEach(function (d) {
    var el = document.createElement("div");
    var picking = wire && ((wire.from && wire.from.id === d.id) || (wireType && !wire));
    el.className = "node" + (d.id === curId ? " sel" : "") + (wire && wire.from && wire.from.id === d.id ? " picking" : "");
    el.dataset.type = d.type;
    el.style.left = d.x + "px"; el.style.top = d.y + "px";
    var ips = Sim.deviceIpList(d).slice(0, 2).join(" · ");
    var downCount = Object.keys(d.ports).filter(function (pn) { return d.ports[pn].shutdown; }).length;
    var pill = downCount ? "⛔ " + downCount + "口down" : (d.stp.enabled ? "🌳 STP开" : typeName[d.type]);
    if (picking && !(wire && wire.from && wire.from.id === d.id)) pill = "◉ 点我连线";
    var leds = Object.keys(d.ports).slice(0, 8).map(function (pn) {
      var p = d.ports[pn];
      var cls = p.shutdown ? "down" : (Sim.isStpBlocked(d, pn, stpInfo) ? "block" : "up");
      return '<span class="led ' + cls + '" title="' + pn + (p.shutdown ? " down" : "") + '"></span>';
    }).join("");
    el.innerHTML = '<div class="badge">' + iconHtml(typeIcon[d.type]) + "</div>" +
      '<div class="t">' + escapeHtml(d.hostname) + "</div>" +
      '<div class="s">' + escapeHtml(ips || "未配IP") + '</div><div><span class="pill">' + escapeHtml(pill) + '</span></div><div class="leds">' + leds + "</div>";
    // 新设备入场 + 落地粒子
    if (!seenIds[d.id]) {
      seenIds[d.id] = 1;
      el.classList.add("enter");
      var sc = toScreen(d.x, d.y);
      setTimeout(function () { fxDeviceSpawn(sc.x, sc.y); }, 220);
    }
    // 单击：选中并切到该设备会话（不抢输入焦点）；双击：进入 CLI 输入
    // 关键：单击不重建节点 DOM，否则第二次点击会落空导致双击失效
    el.onclick = function (ev) {
      if (ev.detail > 1) return; // 双击的第二次 click 交给 dblclick 处理
      // 连线模式：交给连线流程（不重建 DOM，端口选择器由 showPortPicker 定位显示）
      if (wireType || (ev.shiftKey && !wireType)) {
        onNodeClick(d, ev);
        return;
      }
      var need = (curId !== d.id) || (curPromptDev !== d.id);
      curId = d.id;
      if (need) { showPrompt(false); }
      markSelected();
      renderCfg();
      status("已选中 " + d.hostname + "（双击进入 CLI 输入）");
    };
    el.ondblclick = function (ev) {
      ev.stopPropagation();
      if (wireType) return; // 连线模式下双击不切 CLI
      enterCli(d);
    };
    el.title = "单击选中 · 双击进入CLI · 拖动排布";
    el.onmousedown = function (ev) {
      if (wireType || ev.shiftKey) return; // 连线模式下不拖拽
      ev.stopPropagation();
      var sx = ev.clientX, sy = ev.clientY, ox = d.x, oy = d.y;
      function mv(e2) {
        d.x = Math.max(-800, ox + scr2log(e2.clientX - sx));
        d.y = Math.max(-800, oy + scr2log(e2.clientY - sy));
        paintPositions();
      }
      function up2() { document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up2); render(); }
      document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up2);
    };
    nodes.appendChild(el);
  });
}
// 拖拽设备中：只搬节点 div + 重画连线，不重建 DOM（避免抖动、输入框不丢焦点）
function paintPositions() {
  var kids = $("nodes").children;
  devices.forEach(function (d, i) {
    if (kids[i]) { kids[i].style.left = d.x + "px"; kids[i].style.top = d.y + "px"; }
  });
  drawSvg();
}
// 广播风暴判定（与 sim-core 保持一致：环路 + 未开生成树 + 非聚合）
function detectStorm() {
  return Sim.detectStorm(devices, links, stpInfo);
}
// 只更新选中样式，不重建节点（保证双击的第二次点击仍命中同一元素）
function markSelected() {
  var kids = $("nodes").children;
  for (var i = 0; i < kids.length; i++) {
    var d = devices[i];
    if (!d) continue;
    kids[i].classList.toggle("sel", d.id === curId);
  }
}
function pulseNode(dev) {
  var i = devices.findIndex(function (d) { return d.id === dev.id; });
  var nodes = $("nodes").children;
  if (i >= 0 && nodes[i]) { nodes[i].classList.remove("hop"); void nodes[i].offsetWidth; nodes[i].classList.add("hop"); }
}

/* ---------- 实时状态引擎：不敲回车也刷新 ---------- */
setInterval(tickLive, 500);
function tickLive() {
  if (!devices.length && !$("nodes")) return;
  var now = Date.now(), structural = false;
  devices.forEach(function (d) {
    Object.keys(d.ports).forEach(function (pn) {
      var p = d.ports[pn];
      // 端口安全 recovery 计时到 → 自动恢复（课程：violation shutdown [recovery N]）
      if (p.violated && p.portSecurity.recovery > 0 && p.violatedAt && now - p.violatedAt > p.portSecurity.recovery * 1000) {
        p.violated = false; p.shutdown = false; p.violatedAt = 0; structural = true;
        print('<span class="ok">% Port ' + pn + ' recovery 计时到，已自动恢复 up。</span>');
        toast(d.hostname + ":" + pn + " 已自动恢复");
      }
    });
    // MAC 老化 300s（课程设定），静默清理
    Object.keys(d.macTable).forEach(function (m) {
      if (now - d.macTable[m].age > 300000) delete d.macTable[m];
    });
  });
  if (structural) { stpInfo = Sim.stpCompute(devices, links); render(); return; }
  refreshStatus(); // 轻量原地更新，不重建 DOM（拖拽/输入不受扰）
}
function refreshStatus() {
  var nodes = $("nodes").children;
  if (!nodes.length) return;
  var storm = detectStorm();
  devices.forEach(function (d, i) {
    var el = nodes[i]; if (!el) return;
    var leds = el.querySelectorAll(".led");
    var pns = Object.keys(d.ports).slice(0, 8);
    for (var k = 0; k < pns.length; k++) {
      if (!leds[k]) break;
      var p = d.ports[pns[k]];
      var cls = p.shutdown ? "down" : (Sim.isStpBlocked(d, pns[k], stpInfo) ? "block" : "up");
      var want = "led " + cls + (storm ? " flash" : "");
      if (leds[k].className !== want) leds[k].className = want;
    }
    var pill = el.querySelector(".pill");
    if (pill) {
      var downCount = Object.keys(d.ports).filter(function (pn) { return d.ports[pn].shutdown; }).length;
      var txt = downCount ? "⛔ " + downCount + "口down" : (d.stp.enabled ? "🌳 STP开" : ({ pc: "PC", l2: "二层", l3: "三层", router: "路由" }[d.type]));
      if (pill.textContent !== txt) { pill.textContent = txt; fxBadgeFlash(pill); }
    }
  });
  var sb = $("stormBar"); if (sb) sb.style.display = storm ? "block" : "none";
  // 状态栏汇总（3 秒内有手动消息则不覆盖）
  if (Date.now() - statusManualAt > 3000) {
    var kinds = { copper: 0, cross: 0, fiber: 0, serial: 0 };
    links.forEach(function (l) { kinds[linkKind(l)]++; });
    var kTxt = [];
    if (kinds.copper) kTxt.push("直通" + kinds.copper);
    if (kinds.cross) kTxt.push("交叉" + kinds.cross);
    if (kinds.fiber) kTxt.push("光纤" + kinds.fiber);
    if (kinds.serial) kTxt.push("串口" + kinds.serial);
    var st = devices.length
      ? devices.length + " 台设备 · " + links.length + " 条连线" + (kTxt.length ? "（" + kTxt.join("/") + "）" : "") + (storm ? " · ⚠风暴" : "")
      : "就绪 · 空画布";
    if ($("status").textContent !== st) $("status").textContent = st;
  }
}

/* ---------- 画布平移（拖空白处） + 滚轮缩放 ---------- */
function setupPan() {
  var wrap = $("canvasWrap");
  wrap.addEventListener("mousedown", function (e) {
    if (e.button !== 0) return;
    if (e.target.closest && (e.target.closest(".node") || e.target.closest("#portPicker") || e.target.closest("button") || e.target.closest("#emptyState .row"))) return;
    if (wireType) return; // 连线模式下点空白取消
    var sx = e.clientX, sy = e.clientY, ox = panX, oy = panY, moved = false;
    wrap.style.cursor = "grabbing";
    function mv(e2) {
      moved = true;
      panX = ox + (e2.clientX - sx); panY = oy + (e2.clientY - sy);
      applyZoom();
    }
    function up() {
      document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
      wrap.style.cursor = "";
      if (!moved && !wireType) cancelWire();
    }
    document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
  });
  wrap.addEventListener("wheel", function (e) {
    e.preventDefault();
    var r = wrap.getBoundingClientRect();
    var f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
    setZoom(zoom * f, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
}

/* ---------- 右侧面板 ---------- */
function renderCfg() {
  var d = devById(curId); var box = $("cfgBox"); if (!box) return;
  if (!d) { box.innerHTML = devices.length ? "<div class='hint'>点击拓扑中的设备查看端口 / VLAN / IP，双击删除设备。</div>" : "<div class='hint'>画布为空。左侧点一下即可添加第一台设备，或右上载入实验。</div>"; return; }
  var rows = Object.keys(d.ports).map(function (pn) {
    var p = d.ports[pn]; var ip = d.ifIp[pn];
    var st = p.shutdown ? "down" : "up";
    if (Sim.isStpBlocked(d, pn, stpInfo)) st += "/BLK";
    if (p.violated) st += "/违例";
    return "<tr><td>" + pn + "</td><td>" + p.mode + "</td><td>" + (p.mode === "trunk" ? (p.trunkAllowed ? p.trunkAllowed.join(",") : "all") : p.accessVlan) + "</td><td>" + (ip && ip.ip ? ip.ip : "-") + "</td><td>" + st + "</td></tr>";
  }).join("");
  box.innerHTML = "<b>" + escapeHtml(d.hostname) + "</b> <span style='color:#9A8F7F'>(" + d.type + " · " + escapeHtml(d.mac) + ")</span> " +
    "<button id='btnRename' style='margin-left:6px;background:var(--card);border:1px solid var(--line2);border-radius:7px;padding:2px 10px;cursor:pointer;font-size:12px'>重命名</button>" +
    "<table class='cfg' style='margin-top:8px'><tr><th>端口</th><th>模式</th><th>VLAN</th><th>IP</th><th>状态</th></tr>" + rows + "</table>" +
    "<div class='hint'>单击选中 · 双击进入CLI · Delete键/右键删除设备 · 端口用 <kbd>shutdown</kbd>/<kbd>no shutdown</kbd> 切换</div>" +
    (d.type === "pc" ? pcForm(d) : "");
  var rn = $("btnRename");
  if (rn) rn.onclick = function () { showRename(d.id); };
  var f = $("pcForm");
  if (f) f.onsubmit = function (e) {
    e.preventDefault();
    d.pcIp = $("pcIp").value.trim() || null; d.pcMask = $("pcMask").value.trim() || "255.255.255.0"; d.pcGw = $("pcGw").value.trim() || null;
    render(); toast(d.hostname + " IP已设置"); return false;
  };
}
function pcForm(d) {
  return "<form id='pcForm' style='margin-top:8px;display:flex;gap:6px;flex-wrap:wrap'>" +
    "<input id='pcIp' placeholder='IP 如192.168.1.11' value='" + (d.pcIp || "") + "'>" +
    "<input id='pcMask' placeholder='掩码' value='" + (d.pcMask || "255.255.255.0") + "' style='width:120px'>" +
    "<input id='pcGw' placeholder='网关' value='" + (d.pcGw || "") + "'>" +
    "<button>设IP</button></form>";
}
function renderTasks() {
  var sel = $("labSel").value; var lab = LABS.filter(function (l) { return l.id === sel; })[0];
  var box = $("taskBox"); if (!box) return;
  if (!lab) {
    box.innerHTML = devices.length
      ? "<div class='hint'>当前为自建拓扑。在终端用 <kbd>ping</kbd>/<kbd>tracert</kbd>/<kbd>show</kbd> 验证；载入实验可获得配套测试清单。</div>"
      : "<div class='hint'>暂无测试清单。先添加设备连线，或从右上载入一个实验。</div>";
    return;
  }
  box.innerHTML = "<b>" + lab.no + " · " + escapeHtml(lab.title) + "</b><div class='hint'>" + escapeHtml(lab.desc) + "</div>" +
    (lab.steps ? "<ol class='steps'>" + lab.steps.map(function (s) { return "<li>" + escapeHtml(s) + "</li>"; }).join("") + "</ol>" : "") +
    lab.tasks.map(function (t, i) {
      return "<div class='task'><span>" + (i + 1) + ". " + escapeHtml(t.text) + "</span><button data-i='" + i + "'>测试</button></div>";
    }).join("") + "<div class='hint'>测试按钮按当前拓扑真实仿真并播放报文动画。</div>";
  Array.prototype.forEach.call(box.querySelectorAll("button"), function (b) {
    b.onclick = function () { runTaskTest(lab.tasks[+b.getAttribute("data-i")], b); };
  });
}
function runTaskTest(t, btn) {
  if (t.from && t.target) {
    var src = devByName(t.from) || devices.filter(function (d) { return d.type === "pc"; })[0];
    var tip = t.target;
    // target 可能是设备名（如 PC2）或 R1-G0/0 形式，转成 IP
    var byNm = devByName(tip);
    if (byNm) {
      var ips0 = Sim.deviceIpList(byNm);
      if (!ips0.length) { btn.textContent = "无IP"; print(escapeHtml(tip + " 还没有配置 IP")); return; }
      tip = ips0[0];
    }
    var m = String(tip).match(/^(.*)-(G0\/0|G0\/1|S1\/0|S1\/1|VLAN\d+)$/i);
    if (m) {
      var rd = devByName(m[1]) || devices.filter(function (d) { return d.hostname.toLowerCase() === m[1].toLowerCase(); })[0];
      if (rd) {
        var want = m[2].toLowerCase(); var ip = null;
        if (want.indexOf("vlan") === 0) ip = rd.vlanIf[want.replace("vlan", "")] && rd.vlanIf[want.replace("vlan", "")].ip;
        else ip = rd.ifIp[want] && rd.ifIp[want].ip;
        if (ip) tip = ip;
      }
    }
    if (!src) { btn.textContent = "无源"; return; }
    var r = doPing(src, tip);
    btn.textContent = r.ok ? "✓ 通 " + r.latency.avg + "ms" : (r.storm ? "⚠ 风暴" : "✗ 不通");
    print(escapeHtml(src.hostname + " ping " + tip + " → " +
      (r.ok ? "连通 " + r.latency.avg + "ms（最短" + r.latency.min + " 最长" + r.latency.max + "）" :
        r.storm ? "不通（广播风暴阻断）" : "不通：" + r.reason)));
  } else print(escapeHtml("自查：" + t.text + "（在CLI执行，如 " + (t.cli || "show ?") + "）"));
}
function renderCap() {
  var box = $("capBox"); if (!box) return;
  var ok = capLog.filter(function (l) { return l.charAt(0) === "✓"; }).length;
  var bad = capLog.filter(function (l) { return l.charAt(0) === "✗"; }).length;
  var head = capLog.length
    ? "<div class='capSum'><span class='ok'>✓ " + ok + " 通</span><span class='bad'>✗ " + bad + " 不通</span><span>共 " + capLog.length + " 条</span></div>"
    : "";
  box.innerHTML = head + (capLog.slice(0, 40).map(function (l) {
    return "<div>" + escapeHtml(l) + "</div>";
  }).join("") || "<div class='hint'>暂无抓包。配置镜像后这里会显示复制到目的端口的包（教学示意）。</div>");
}

/* ---------- 状态动效：LED 闪 + STP 收敛 + 提示飘字（无数据包动画） ---------- */
// 两台设备之间的链路（可能多条，如聚合）
function linksBetween(devA, devB) {
  return links.filter(function (l) {
    return (l.a.dev === devA.id && l.b.dev === devB.id) || (l.b.dev === devA.id && l.a.dev === devB.id);
  });
}
// 端口 LED 随流量闪烁
function blinkPortLed(devId, portName, ms) {
  var idx = devices.findIndex(function (d) { return d.id === devId; });
  var el = $("nodes").children[idx]; if (!el) return;
  var d = devById(devId); if (!d) return;
  var pns = Object.keys(d.ports).slice(0, 8);
  var pi = pns.indexOf(portName); if (pi < 0) return;
  var led = el.querySelectorAll(".led")[pi]; if (!led) return;
  led.classList.add("flash");
  setTimeout(function () { led.classList.remove("flash"); }, ms || 700);
}
// STP 端口状态变化动画：BLK 红闪 / FWD 绿闪
var prevStpRoles = {};
function animateStpChange() {
  var cur = (stpInfo && stpInfo.roles) || {};
  var changed = false;
  Object.keys(cur).forEach(function (k) {
    if (prevStpRoles[k] === cur[k].state) return;
    changed = true;
    var parts = k.split(":");
    var d = devById(parts[0]); if (!d) return;
    var el = $("nodes").children[devices.indexOf(d)]; if (!el) return;
    var pns = Object.keys(d.ports).slice(0, 8);
    var pi = pns.indexOf(parts[1]);
    var led = el.querySelectorAll(".led")[pi];
    var isBlk = cur[k].state === "BLK";
    if (led) {
      led.classList.add(isBlk ? "blinkRed" : "blinkGreen");
      setTimeout(function () { led.classList.remove("blinkRed", "blinkGreen"); }, 1500);
    }
    floatTip(d, parts[1] + (isBlk ? " 阻断 BLK" : " 转发 FWD"), isBlk ? "bad" : "ok");
  });
  prevStpRoles = {};
  Object.keys(cur).forEach(function (k) { prevStpRoles[k] = cur[k].state; });
  return changed;
}
// 设备上方飘字提示
function floatTip(dev, text, kind) {
  var s = toScreen(dev.x, dev.y);
  var el = document.createElement("div");
  el.className = "floattip " + (kind || "");
  el.textContent = text;
  el.style.left = s.x + "px"; el.style.top = (s.y - 26) + "px";
  $("canvasWrap").appendChild(el);
  setTimeout(function () { el.remove(); }, 1800);
}
// 广播风暴：不再播放跑包动画，仅用告警条 + 端口快闪提示
var stormTimer = null;
function updateStormAnim() {
  var on = detectStorm();
  if (on && !stormTimer) {
    stormTimer = setInterval(function () {
      if (!detectStorm()) { clearInterval(stormTimer); stormTimer = null; return; }
      devices.forEach(function (d) {
        if (d.type !== "l2" && d.type !== "l3") return;
        var el = $("nodes").children[devices.indexOf(d)];
        if (!el) return;
        var leds = el.querySelectorAll(".led");
        for (var i = 0; i < leds.length; i++) {
          if (Math.random() < 0.5) leds[i].classList.add("flash");
          else leds[i].classList.remove("flash");
        }
      });
    }, 260);
  } else if (!on && stormTimer) {
    clearInterval(stormTimer); stormTimer = null;
    devices.forEach(function (d) {
      var el = $("nodes").children[devices.indexOf(d)];
      if (el) Array.prototype.forEach.call(el.querySelectorAll(".led"), function (x) { x.classList.remove("flash"); });
    });
  }
}
function easeInOut(p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
function blinkNode(name) {
  var i = devices.findIndex(function (d) { return d.hostname === name; });
  var nodes = $("nodes").children;
  if (i >= 0 && nodes[i]) { nodes[i].classList.remove("hop"); void nodes[i].offsetWidth; nodes[i].classList.add("hop"); }
}
/* 说明：按需求已移除"数据包传输动画"（圆点 + 链路流光）。
   保留的是设备状态指示：端口 LED 闪烁、STP 状态变化、提示飘字。 */
function animatePing(src, ip, res) {
  var tgt = Sim.findDeviceByIp(devices, ip);
  if (!tgt || !res.ok) return;
  // 只做状态反馈：途经设备闪一下端口灯 + MAC 学习飘字
  blinkNode(src.hostname); blinkNode(tgt.hostname);
  linksBetween(src, tgt).forEach(function (l) { blinkPortLed(l.a.dev, l.a.port, 500); blinkPortLed(l.b.dev, l.b.port, 500); });
  devices.forEach(function (d) {
    if (d.type === "l2" || d.type === "l3") Sim.learnMac(d, src.pcMac || src.mac, Object.keys(d.ports)[0], 1);
  });
  if (res.path) res.path.forEach(function (h) {
    var d = devByName(h.dev);
    if (d && (d.type === "l2" || d.type === "l3")) floatTip(d, "学习 MAC", "ok");
  });
}
function animatePath(hops, cls) {
  (hops || []).forEach(function (h) { var d = devByName(h.dev); if (d) blinkNode(d.hostname); });
}
function animateFail(srcDev) {
  blinkNode(srcDev.hostname);
  floatTip(srcDev, "不可达", "bad");
}

/* ---------- 缩放 + 平移 ---------- */
function applyZoom() {
  var st = $("stage");
  if (st) st.style.transform = "translate(" + panX + "px," + panY + "px) scale(" + zoom + ")";
  var l = $("zoomLabel"); if (l) l.textContent = Math.round(zoom * 100) + "%";
}
// 以画布某点为中心缩放（默认中心）
function setZoom(z, cx, cy) {
  var wrap = $("canvasWrap");
  var w = wrap.clientWidth || 700, h = wrap.clientHeight || 420;
  if (cx === undefined) cx = w / 2;
  if (cy === undefined) cy = h / 2;
  z = Math.max(0.3, Math.min(2, z));
  panX = cx - (cx - panX) * (z / zoom);
  panY = cy - (cy - panY) * (z / zoom);
  zoom = z; applyZoom();
}
// 自适应：全部设备刚好装进画布
function fitView() {
  var wrap = $("canvasWrap");
  var w = wrap.clientWidth || 700, h = wrap.clientHeight || 420;
  if (!devices.length) { panX = 0; panY = 0; zoom = 1; applyZoom(); return; }
  var xs = devices.map(function (d) { return d.x; }), ys = devices.map(function (d) { return d.y; });
  var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
  var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
  var bw = Math.max(220, maxX - minX), bh = Math.max(160, maxY - minY);
  zoom = Math.max(0.3, Math.min(1.5, Math.min(w / (bw + 190), h / (bh + 190))));
  panX = w / 2 - ((minX + maxX) / 2) * zoom;
  panY = h / 2 - ((minY + maxY) / 2) * zoom;
  applyZoom();
}
// 逻辑坐标 → 屏幕坐标（含平移缩放，用于动画点/弹窗定位）
function toScreen(lx, ly) { return { x: lx * zoom + panX, y: ly * zoom + panY }; }
// 屏幕增量 → 逻辑增量（拖拽用）
function scr2log(dx) { return dx / zoom; }

/* ---------- 实验载入 / 答案 ---------- */
function loadLab(id, opts) {
  var lab = LABS.filter(function (l) { return l.id === id; })[0];
  if (!lab) return;
  // 下拉框/按钮显式切换实验时直接载入；仅"读取文件"等外部来源才确认，避免误挡
  if (opts && opts.confirm && devices.length) {
    askConfirm("载入实验 " + lab.no + " 将替换当前画布上的 " + devices.length + " 台设备，确定吗？").then(function (ok) { if (ok) doLoadLab(lab); });
    return;
  }
  doLoadLab(lab);
}
function doLoadLab(lab) {
  if ($("labSel")) $("labSel").value = lab.id; // 同步下拉框，让"一键标准答案/测试清单"知道当前实验
  seenIds = {};
  devices = []; links = []; consoles = []; sessions = {}; curId = null; capLog = [];
  wire = null; hidePicker();
  $("term").innerHTML = "";
  var byName = {};
  var wrap = $("canvasWrap"); var w = wrap.clientWidth || 760, h = wrap.clientHeight || 420;
  lab.devices.forEach(function (dd) {
    var d = Sim.createDevice(dd.type, dd.name,
      w / 2 + (dd.x - 400) * 0.9, Math.max(80, Math.min(h - 60, 60 + (dd.y / 480) * (h - 120))));
    devices.push(d); byName[dd.name] = d;
  });
  (lab.links || []).forEach(function (lk) {
    var a = byName[lk.a[0]], b = byName[lk.b[0]];
    if (a && b && a.ports[lk.a[1]] && b.ports[lk.b[1]])
      links.push({ id: "l" + (++linkSeq) + Date.now().toString(36), a: { dev: a.id, port: lk.a[1] }, b: { dev: b.id, port: lk.b[1] }, serial: !!lk.serial });
  });
  devices.forEach(function (d) {
    if (d.type === "pc") {
      var has = links.some(function (l) { return l.a.dev === d.id || l.b.dev === d.id; });
      if (!has) {
        var sw = devices.filter(function (x) { return x.type === "l2" || x.type === "l3"; })[0];
        if (sw) {
          var free = Object.keys(sw.ports).filter(function (p) {
            return !links.some(function (l) { return (l.a.dev === sw.id && l.a.port === p) || (l.b.dev === sw.id && l.b.port === p); });
          })[0];
          if (free) links.push({ id: "l" + (++linkSeq) + "a", a: { dev: sw.id, port: free }, b: { dev: d.id, port: "eth0" } });
        }
      }
    }
  });
  curId = devices.length ? devices[0].id : null;
  refreshStp(); renderTasks();
  fitView(); // 载入即自适应，保证所有连线可见
  print('<span class="dim">已载入实验 ' + lab.no + " · " + escapeHtml(lab.title) + "（" + escapeHtml(lab.desc) + "）</span>", "ok");
  if (devices[0]) { print('<span class="dim">选线型后点两台设备选端口连线；单击选中，双击进入其 CLI。</span>'); showPrompt(); }
  status("实验 " + lab.no + " 已载入 · " + devices.length + " 台设备");
  // 载入体检：连线是否都指向存在的端口
  var bad = 0;
  links.forEach(function (l) {
    var a = devById(l.a.dev), b = devById(l.b.dev);
    if (!a || !b || !a.ports[l.a.port] || !b.ports[l.b.port]) bad++;
  });
  if (bad) print('<span class="e">% 有 ' + bad + ' 条连线指向不存在的端口，请检查</span>');
  // 一键标准答案可用性自检（设备名是否齐全）
  print('<span class="dim">提示：点「一键标准答案」可按实验报告参数自动配置并验证；或点「测试清单」查看分步指引。</span>', "dim");
  fxConfetti(46, $("btnLab"));
  toast("实验 " + lab.no + " 已载入", "check");
}
/* ---------- 一键标准答案：按实验报告配出真正能通的网 ---------- */
function devN(name) { return devices.filter(function (d) { return d.hostname === name; })[0] || null; }
// 一键标准答案：先核对实验所需设备是否齐全，缺失就明确报出来
function requiredDevices(sel) {
  var need = {
    lab1: ["switch"], lab2: ["Switch0", "Switch1", "PC0", "PC1", "PC2", "PC3"],
    lab3: ["Switch1", "PC1", "PC2", "PC-Server"],
    lab4: ["Switch1", "Switch2", "PC11", "PC12", "PC21", "PC31", "PC32"],
    lab5: ["S4600-1", "S4600-2", "Switch6200", "PC11", "PC21", "PC31"],
    lab6: ["DCS-3926S", "PC0"], lab7: ["DCS-3926S", "PC0"],
    lab8: ["SwitchA", "SwitchB", "PC0", "PC1"], lab9: ["SwitchA", "PC1", "PC2", "PC3"],
    lab10a: ["SwitchA", "SwitchB", "PC1", "PC2"], lab10b: ["S3-A(根10备20)", "S3-B(根20备10)", "S2"],
    lab11: ["Router1", "Router2"],
    lab12: ["R1", "R2", "R3", "S3", "SW1", "PC11", "PC12", "PC0", "PC21", "PC22", "PC31", "PC32"],
    lab13: ["R1", "R2", "R3", "S3", "SW1", "PC11", "PC12", "PC0", "PC21", "PC22", "PC31", "PC32"],
    lab14: ["R1", "R2", "R3", "S3", "SW1", "PC11", "PC12", "PC0", "PC21", "PC22", "PC31", "PC32"],
    lab15: ["R1", "R2", "R3", "S3", "SW1", "PC11", "PC12", "PC0", "PC21", "PC22", "PC31", "PC32"],
    lab16: ["R1", "R2", "R3", "S3", "SW1", "PC11", "PC12", "PC0", "PC21", "PC22", "PC31", "PC32"]
  };
  return need[sel] || [];
}
// 在设备上按顺序执行命令（自动进特权+全局，忽略中间输出）
function AC(dev, cmds) {
  if (!dev) return;
  ["end", "enable", "config terminal"].concat(cmds).forEach(function (c) { runCmdOn(dev, c); });
}
function setPc(name, ip, mask, gw) {
  var p = devN(name); if (!p) return;
  p.pcIp = ip; p.pcMask = mask || "255.255.255.0"; p.pcGw = gw || null;
}
// 交换机上某台 PC 所接的端口
function swPortFor(swName, pcName) {
  var sw = devN(swName), pc = devN(pcName); if (!sw || !pc) return null;
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    if (l.a.dev === sw.id && l.b.dev === pc.id) return l.a.port;
    if (l.b.dev === sw.id && l.a.dev === pc.id) return l.b.port;
  }
  return null;
}
function accVlan(swName, pcName, vid) {
  var pn = swPortFor(swName, pcName); if (!pn) return;
  AC(devN(swName), ["interface " + pn, "switchport mode access", "switchport access vlan " + vid, "exit", "exit"]);
}
function mkVlan(swName, vid, name) {
  AC(devN(swName), ["vlan " + vid, "name " + name, "exit", "exit"]);
}
// 把两台交换机之间所有直连铜缆做成 trunk
function trunkLink(swA, swB, allowed) {
  var a = devN(swA), b = devN(swB); if (!a || !b) return;
  links.forEach(function (l) {
    if (l.serial) return;
    var pa = null, pb = null;
    if (l.a.dev === a.id && l.b.dev === b.id) { pa = l.a.port; pb = l.b.port; }
    else if (l.b.dev === a.id && l.a.dev === b.id) { pa = l.b.port; pb = l.a.port; }
    else return;
    var c1 = ["interface " + pa, "switchport mode trunk"];
    if (allowed) c1.push("switchport trunk allowed vlan " + allowed);
    AC(a, c1.concat(["exit", "exit"]));
    var c2 = ["interface " + pb, "switchport mode trunk"];
    if (allowed) c2.push("switchport trunk allowed vlan " + allowed);
    AC(b, c2.concat(["exit", "exit"]));
  });
}
// 实验 12-16 公共底座：IP + 时钟 + S3 的 VLAN（严格按实验报告参数）
function baseNet1216() {
  setPc("PC11", "192.168.1.11", "255.255.255.0", "192.168.1.254");
  setPc("PC12", "192.168.1.12", "255.255.255.0", "192.168.1.254");
  setPc("PC0", "192.168.0.1", "255.255.255.0", "192.168.0.254");
  setPc("PC21", "192.168.20.21", "255.255.255.0", "192.168.20.254");
  setPc("PC22", "192.168.20.22", "255.255.255.0", "192.168.20.254");
  setPc("PC31", "192.168.30.31", "255.255.255.0", "192.168.30.254");
  setPc("PC32", "192.168.30.32", "255.255.255.0", "192.168.30.254");
  AC(devN("R1"), ["interface g0/0", "ip address 192.168.1.254 255.255.255.0", "exit",
    "interface s1/0", "ip address 200.199.198.241 255.255.255.252", "physical-layer speed 64000", "exit",
    "interface s1/1", "ip address 200.199.198.245 255.255.255.252", "exit", "exit"]);
  AC(devN("R2"), ["interface g0/0", "ip address 192.168.40.254 255.255.255.0", "exit",
    "interface s1/1", "ip address 200.199.198.242 255.255.255.252", "exit",
    "interface s1/0", "ip address 200.199.198.250 255.255.255.252", "physical-layer speed 64000", "exit", "exit"]);
  AC(devN("R3"), ["interface g0/0", "ip address 192.168.0.254 255.255.255.0", "exit",
    "interface s1/0", "ip address 200.199.198.246 255.255.255.252", "physical-layer speed 64000", "exit",
    "interface s1/1", "ip address 200.199.198.249 255.255.255.252", "exit", "exit"]);
  var s3 = devN("S3");
  AC(s3, ["vlan 20", "name soft", "exit", "vlan 30", "name hard", "exit", "vlan 40", "name con", "exit",
    "interface vlan 20", "ip address 192.168.20.254 255.255.255.0", "exit",
    "interface vlan 30", "ip address 192.168.30.254 255.255.255.0", "exit",
    "interface vlan 40", "ip address 192.168.40.253 255.255.255.0", "exit", "exit"]);
  accVlan("S3", "PC21", 20); accVlan("S3", "PC22", 20);
  accVlan("S3", "PC31", 30); accVlan("S3", "PC32", 30);
  var p24 = swPortFor("S3", "R2");
  if (p24) AC(s3, ["interface " + p24, "switchport mode access", "switchport access vlan 40", "exit", "exit"]);
}
function autoAnswer() {
  if (!devices.length) { toast("画布为空，先载入实验或添加设备"); return; }
  var sel = $("labSel").value;
  // 设备齐全性自检：缺什么直接点名，别让标准答案悄悄失效
  var need = requiredDevices(sel);
  var miss = need.filter(function (n) { return !devN(n); });
  if (need.length && miss.length) {
    print('<span class="e">% 当前画布缺少设备：' + escapeHtml(miss.join("、")) +
      "。请先载入对应实验（实验 " + escapeHtml(sel) + "），再应用标准答案。</span>");
    toast("缺少设备：" + miss.length + " 台", "bell");
    return;
  }
  if (sel === "lab2") {
    setPc("PC0", "192.168.10.1"); setPc("PC1", "192.168.10.2");
    setPc("PC2", "192.168.10.3"); setPc("PC3", "192.168.10.4");
  } else if (sel === "lab3") {
    setPc("PC1", "192.168.10.11"); setPc("PC2", "192.168.10.12"); setPc("PC-Server", "192.168.10.101");
    var sw3 = devN("Switch1"), pc1 = devN("PC1"), pn3 = swPortFor("Switch1", "PC1");
    AC(sw3, ["mac-address-learning cpu-control", "exit"]);
    if (sw3 && pn3 && pc1) AC(sw3, ["interface " + pn3, "switchport mode access",
      "switchport port-security", "switchport port-security maximum 1",
      "switchport port-security mac-address " + pc1.pcMac,
      "switchport port-security violation shutdown", "exit", "exit"]);
  } else if (sel === "lab4") {
    setPc("PC11", "192.168.1.11"); setPc("PC12", "192.168.1.12");
    setPc("PC21", "192.168.1.21"); setPc("PC31", "192.168.2.31"); setPc("PC32", "192.168.2.32");
    mkVlan("Switch1", 10, "hardware"); mkVlan("Switch1", 30, "software");
    mkVlan("Switch2", 10, "hardware"); mkVlan("Switch2", 30, "software");
    accVlan("Switch1", "PC11", 10); accVlan("Switch1", "PC12", 10);
    accVlan("Switch2", "PC21", 10);
    accVlan("Switch2", "PC31", 30); accVlan("Switch2", "PC32", 30);
    trunkLink("Switch1", "Switch2");
  } else if (sel === "lab5") {
    setPc("PC11", "192.168.10.11", "255.255.255.0", "192.168.10.254");
    setPc("PC21", "192.168.20.21", "255.255.255.0", "192.168.20.254");
    setPc("PC31", "192.168.30.31", "255.255.255.0", "192.168.30.254");
    mkVlan("S4600-1", 10, "hardware"); accVlan("S4600-1", "PC11", 10);
    mkVlan("S4600-2", 20, "software"); accVlan("S4600-2", "PC21", 20);
    mkVlan("S4600-2", 30, "network"); accVlan("S4600-2", "PC31", 30);
    trunkLink("S4600-1", "Switch6200"); trunkLink("S4600-2", "Switch6200");
    AC(devN("Switch6200"), ["vlan 10", "name hardware", "exit", "vlan 20", "name software", "exit", "vlan 30", "name network", "exit",
      "interface vlan 10", "ip address 192.168.10.254 255.255.255.0", "exit",
      "interface vlan 20", "ip address 192.168.20.254 255.255.255.0", "exit",
      "interface vlan 30", "ip address 192.168.30.254 255.255.255.0", "exit", "exit"]);
  } else if (sel === "lab6") {
    setPc("PC0", "192.168.1.101");
    AC(devN("DCS-3926S"), ["interface vlan 1", "ip address 192.168.1.100 255.255.255.0", "exit",
      "username xuxp password 0 digital", "exit"]);
  } else if (sel === "lab7") {
    setPc("PC0", "192.168.1.101");
    AC(devN("DCS-3926S"), ["interface vlan 1", "ip address 192.168.1.100 255.255.255.0", "exit",
      "ssh-server enable", "username test password 0 12345678", "exit"]);
  } else if (sel === "lab8") {
    setPc("PC0", "192.168.10.100"); setPc("PC1", "192.168.10.101");
    ["SwitchA", "SwitchB"].forEach(function (n) {
      AC(devN(n), ["vlan 10", "name port-group", "exit",
        "interface e1/0/1-4", "switchport mode trunk", "port-group 1 mode on", "exit", "exit"]);
    });
    accVlan("SwitchA", "PC0", 10); accVlan("SwitchB", "PC1", 10);
  } else if (sel === "lab9") {
    setPc("PC1", "192.168.10.101"); setPc("PC2", "192.168.10.102"); setPc("PC3", "192.168.10.103");
    AC(devN("SwitchA"), ["monitor session 1 source interface e1/0/2 both",
      "monitor session 1 destination interface e1/0/1", "exit"]);
  } else if (sel === "lab10a") {
    setPc("PC1", "192.168.10.100"); setPc("PC2", "192.168.10.101");
    AC(devN("SwitchA"), ["spanning-tree", "exit"]);
    AC(devN("SwitchB"), ["spanning-tree", "exit"]);
  } else if (sel === "lab10b") {
    ["S3-A(根10备20)", "S3-B(根20备10)", "S2"].forEach(function (n) {
      mkVlan(n, 10, "v10"); mkVlan(n, 20, "v20"); mkVlan(n, 50, "v50");
    });
    trunkLink("S3-A(根10备20)", "S3-B(根20备10)");
    trunkLink("S3-A(根10备20)", "S2"); trunkLink("S3-B(根20备10)", "S2");
    AC(devN("S3-A(根10备20)"), ["spanning-tree", "spanning-tree mode mstp", "spanning-tree mst configuration",
      "instance 10 vlan 10,20", "instance 20 vlan 50", "exit",
      "spanning-tree mst 10 priority 4096", "spanning-tree mst 20 priority 8192", "exit"]);
    AC(devN("S3-B(根20备10)"), ["spanning-tree", "spanning-tree mode mstp", "spanning-tree mst configuration",
      "instance 10 vlan 10,20", "instance 20 vlan 50", "exit",
      "spanning-tree mst 20 priority 4096", "spanning-tree mst 10 priority 8192", "exit"]);
  } else if (sel === "lab12") {
    baseNet1216();
  } else if (sel === "lab13") {
    baseNet1216();
    AC(devN("R2"), ["ip route 192.168.1.0 255.255.255.0 200.199.198.241",
      "ip route 192.168.0.0 255.255.255.0 200.199.198.249",
      "ip route 192.168.20.0 255.255.255.0 192.168.40.253",
      "ip route 192.168.30.0 255.255.255.0 192.168.40.253", "exit"]);
    AC(devN("R1"), ["ip route 192.168.0.0 255.255.255.0 200.199.198.246",
      "ip route 192.168.20.0 255.255.255.0 200.199.198.242",
      "ip route 192.168.30.0 255.255.255.0 200.199.198.242",
      "ip route 192.168.40.0 255.255.255.0 200.199.198.242", "exit"]);
    AC(devN("R3"), ["ip route 192.168.1.0 255.255.255.0 200.199.198.245",
      "ip route 192.168.20.0 255.255.255.0 200.199.198.250",
      "ip route 192.168.30.0 255.255.255.0 200.199.198.250",
      "ip route 192.168.40.0 255.255.255.0 200.199.198.250", "exit"]);
  } else if (sel === "lab14") {
    baseNet1216();
    AC(devN("R1"), ["ip route 0.0.0.0 0.0.0.0 200.199.198.246",
      "ip route 0.0.0.0 0.0.0.0 200.199.198.242 50", "exit"]);
    AC(devN("R3"), ["ip route 0.0.0.0 0.0.0.0 200.199.198.250",
      "ip route 0.0.0.0 0.0.0.0 200.199.198.245 50", "exit"]);
    AC(devN("R2"), ["ip route 192.168.1.0 255.255.255.0 200.199.198.241",
      "ip route 192.168.0.0 255.255.255.0 200.199.198.249",
      "ip route 192.168.20.0 255.255.255.0 192.168.40.253",
      "ip route 192.168.30.0 255.255.255.0 192.168.40.253", "exit"]);
  } else if (sel === "lab15") {
    baseNet1216();
    ["R1", "R2", "R3"].forEach(function (n) {
      var r = devN(n); if (!r) return;
      AC(r, ["router rip 1", "version 2", "auto-summary", "exit"]);
      Object.keys(r.ifIp).forEach(function (pn) {
        if (r.ifIp[pn] && r.ifIp[pn].ip) AC(r, ["interface " + pn, "ip rip 1 enable", "exit"]);
      });
      runCmdOn(r, "exit");
    });
    AC(devN("S3"), ["router rip", "version 2", "network vlan 20", "network vlan 30", "network vlan 40", "exit", "exit"]);
  } else if (sel === "lab16") {
    baseNet1216();
    var rids = { R1: "1.1.1.1", R2: "2.2.2.2", R3: "3.3.3.3", S3: "4.4.4.4" };
    ["R1", "R2", "R3", "S3"].forEach(function (n) {
      var d = devN(n); if (!d) return;
      var nets = Sim.connectedNets(d).map(function (x) { return "network " + x.net + " " + x.mask + " area 0"; });
      AC(d, ["router ospf 1", "router-id " + rids[n]].concat(nets).concat(["exit", "exit"]));
    });
  } else {
    devices.forEach(function (d, i) {
      if (d.type === "pc" && !d.pcIp) { d.pcIp = "192.168.1." + (11 + i); d.pcMask = "255.255.255.0"; }
    });
  }
  stpInfo = Sim.stpCompute(devices, links);
  render(); renderTasks();
  print("已应用该实验的标准答案（拓扑按实验报告参数配置），可用 <b>show</b> 系列命令核查，再用测试清单验证。", "ok");
  fxConfetti(54, $("btnAnswer"));
  toast("标准答案已应用", "sparkles");
}
function runCmdOn(dev, line) {
  CLI.execLine({
    devices: devices, links: links, dev: dev, sess: sessOf(dev),
    stpInfo: function () { return stpInfo; }, refreshStp: function () { stpInfo = Sim.stpCompute(devices, links); },
    factoryReset: function () {}, ping: function () { return { ok: true }; }, tracert: function () { return { ok: true, hops: [] }; }, telnetTo: function () { return ""; }
  }, line);
}
function addDevice(type) {
  var names = { pc: "PC", l2: "Switch", l3: "S4600", router: "Router" };
  var n = devices.filter(function (d) { return d.type === type; }).length + 1;
  var wrap = $("canvasWrap"); var w = wrap.clientWidth || 700, h = wrap.clientHeight || 420;
  // 放在当前视图中央（逻辑坐标，含平移）
  var d = Sim.createDevice(type, (names[type] || "Dev") + n,
    (w / 2 - panX) / zoom + (Math.random() * 120 - 60), (h / 2 - panY) / zoom + (Math.random() * 100 - 50));
  devices.push(d); curId = d.id; refreshStp();
  print('<span class="dim">已添加 ' + escapeHtml(d.hostname) + "，单击进入 CLI。</span>");
  showPrompt(); status(devices.length + " 台设备 · 自建拓扑中");
}

/* ---------- 初始化：空画布 ---------- */
function init() {
  var sel = $("labSel");
  var ph = document.createElement("option"); ph.value = ""; ph.textContent = "— 选择实验载入 —"; sel.appendChild(ph);
  LABS.forEach(function (l) { var o = document.createElement("option"); o.value = l.id; o.textContent = l.no + " · " + l.title; sel.appendChild(o); });
  sel.value = "";
  document.querySelectorAll("#palette .devbtn").forEach(function (b) {
    b.onclick = function () { addDevice(b.getAttribute("data-type")); };
  });
  document.querySelectorAll("#wirebox .wirebtn").forEach(function (b) {
    b.onclick = function () { setWireType(b.getAttribute("data-wire")); };
  });
  $("btnLab").onclick = function () {
    if (!sel.value) { toast("先在下拉框选一个实验"); return; }
    loadLab(sel.value);
  };
  sel.onchange = function () { if (sel.value) loadLab(sel.value); };
  $("btnAnswer").onclick = autoAnswer;
  $("btnClear").onclick = function () {
    if (!devices.length && !consoles.length) return;
    askConfirm("将清空画布上所有 " + devices.length + " 台设备与 " + links.length + " 条连线，确定吗？").then(function (ok) {
      if (!ok) return;
      devices = []; links = []; consoles = []; sessions = {}; curId = null; capLog = [];
      wire = null; hidePicker();
      $("term").innerHTML = ""; refreshStp(); renderTasks();
      print('<span class="dim">画布已清空。左侧添加设备，或右上载入实验。</span>');
      status("就绪 · 空画布"); toast("画布已清空");
    });
  };
  $("btnSave").onclick = saveToFile;
  $("btnLoad").onclick = loadFromFile;
  // exe 菜单里再加一个导出报告入口（网页版放在抓包页）
  var capTab = document.querySelector('#rightTabs button[data-t="cap"]');
  if (capTab && !capTab.dataset.exp) {
    capTab.dataset.exp = "1";
    capTab.title = "双击导出实验报告";
    capTab.ondblclick = exportReport;
  }
  $("btnHelp").onclick = function () {
    print("【操作】单击选中设备，双击进入 CLI；右键有快捷菜单；Delete 删选中设备。", "ok");
    print("【连线】先选线型 → 点源设备选端口 → 点目标设备选端口；Shift+点=自动速连；Esc取消。", "ok");
    print("【缩写】每个单词只输唯一前缀即可：", "ok");
    print(" conf t = config terminal\n int e1/0/1 = interface\n swi mode acc = switchport mode access\n swi acc vlan 10\n swi trunk allowed vlan 3;5-8\n sh run = show running-config\n sh ip ro = show ip route\n sh vlan / sh mac / sh int e1/0/1\n no shut = no shutdown（shutd 兼容实验报告）\n ? = 本模式全部命令 · TAB = 补全");
    print("【企业级二层安全】神州数码 DCS 进阶特性，全局配置模式下敲 ip ? / swi ? 可看全部：", "ok");
    print(" ip dhcp snooping [vlan <列表> [rate <n>]]   开启 DHCP Snooping 防欺骗\n 接口下 ip dhcp snooping trust        把上行口设为信任口\n sh dhcp s                             查看绑定表与信任口");
    print(" ip igmp snooping [version 2|3]     开启组播抑制\n sh igm s                              查看组播转发表");
    print(" ip arp inspection vlan <列表>       开启动态ARP检测 DAI\n sh arp i                              查看检测状态");
    print(" switchport loop-guard enable        全局环路保护\n 接口下 loop-guard enable            接入口检测环路");
    print("接口下 swi isolate group <n>         端口隔离（隔离口之间互不相通）\n sh port-is                           查看隔离分组");
    print("接口下 swi priority <0-7>            802.1p 优先级（6=网络控制 3=语音）\n sh qos p                              查看优先级");
    print(" mac-address static <MAC> interface <端口>   静态MAC绑定\n mac-address aging-time <秒> / mac-address maximum <条>\n sh mac-address s / sh mac a");
    print(" lldp enable / snmp-server community <串> ro / snmp-agent sys-contact <串>\n sh lldp / sh snmp");
    print(" mac-address-learning cpu-control    CPU学习MAC（防MAC泛洪攻击）");
    print("【访问控制 / 网关冗余 / DHCP】", "ok");
    print(" ip access-list extended 100        创建ACL并进入配置模式\n seq 10 deny ip 192.168.1.0 0.0.0.255 10.0.0.0 0.0.0.255\n seq 20 permit ip any any\n 接口下 ip access-group 100 in    把ACL绑到端口（命中deny真实阻断流量）\n sh access-lists                    查看规则与应用位置");
    print(" 接口下 vrrp 1 ip 192.168.1.254     配置VRRP虚拟网关\n vrrp 1 priority 120                 优先级大者当Master\n sh vrrp                             查看组状态与当前Master");
    print(" service dhcp                      开启DHCP服务器\n ip dhcp pool office                创建地址池\n network 192.168.10.0 255.255.255.0 / default-router 192.168.10.254 / lease 7200\n sh ip dhcp pool / sh ip dhcp binding");
  };
  var be = $("btnEmptyLab"); if (be) be.onclick = function () { sel.value = "lab4"; loadLab("lab4"); };
  var bh = $("btnEmptyHelp"); if (bh) bh.onclick = function () { $("btnHelp").click(); };
  $("zoomIn").onclick = function () { setZoom(zoom + 0.15); };
  $("zoomOut").onclick = function () { setZoom(zoom - 0.15); };
  $("zoomReset").onclick = function () { fitView(); toast("已自适应画布", "zoomFit"); };
  // 终端真·全屏：调用系统全屏 API（Electron/浏览器都生效），Esc 退出
  function toggleFullTerm(force) {
    var want = force !== undefined ? force : !document.body.classList.contains("term-full");
    document.body.classList.toggle("term-full", want);
    var b = $("btnFullTerm");
    b.querySelector("span").textContent = want ? "退出全屏" : "全屏";
    if (want) switchTab("cli");
    try { b.animate([{ transform: "scale(1)" }, { transform: "scale(.92)" }, { transform: "scale(1)" }], { duration: 220 }); } catch (e) {}
    // 系统全屏：优先 Fullscreen API，失败则退回 Electron 原生全屏
    var el = $("cliCard");
    try {
      if (want) {
        var p = (el.requestFullscreen && el.requestFullscreen()) ||
                (el.webkitRequestFullscreen && el.webkitRequestFullscreen());
        if (p && p.catch) p.catch(function () { nativeFullscreen(true); });
      } else {
        if (document.fullscreenElement || document.webkitFullscreenElement) {
          (document.exitFullscreen && document.exitFullscreen()) ||
          (document.webkitExitFullscreen && document.webkitExitFullscreen());
        } else nativeFullscreen(false);
      }
    } catch (e) { nativeFullscreen(want); }
    setTimeout(function () { if (want) focusEdit(); }, 120);
  }
  function nativeFullscreen(on) {
    try {
      if (window.electronAPI && window.electronAPI.setFullscreen) window.electronAPI.setFullscreen(on);
      else if (window.electronAPI && window.electronAPI.ipc) window.electronAPI.ipc("dcn:fullscreen", on);
    } catch (e) {}
  }
  // 系统全屏被 Esc 退出时同步 UI 状态
  ["fullscreenchange", "webkitfullscreenchange"].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (!document.fullscreenElement && !document.webkitFullscreenElement && document.body.classList.contains("term-full")) {
        document.body.classList.remove("term-full");
        $("btnFullTerm").querySelector("span").textContent = "全屏";
      }
    });
  });
  $("btnFullTerm").onclick = function () { toggleFullTerm(); };
  $("exitFs").onclick = function () { toggleFullTerm(false); };
  document.addEventListener("keydown", function (e) {
    if (e.key === "F11" || (e.key === "f" && e.altKey)) { e.preventDefault(); toggleFullTerm(); }
    else if (e.key === "Escape" && document.body.classList.contains("term-full")) toggleFullTerm(false);
    else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) { e.preventDefault(); saveToFile(); }
    else if ((e.ctrlKey || e.metaKey) && (e.key === "o" || e.key === "O")) { e.preventDefault(); loadFromFile(); }
  });
  document.querySelectorAll("#rightTabs button").forEach(function (b) {
    b.onclick = function () {
      var was = document.querySelector("#rightTabs button.on");
      if (was && was !== b) { try { was.animate([{ transform: "scale(1)" }, { transform: "scale(.96)" }, { transform: "scale(1)" }], { duration: 200 }); } catch (e) {} }
      document.querySelectorAll("#rightTabs button").forEach(function (x) { x.classList.toggle("on", x === b); });
      document.querySelectorAll(".tabpage").forEach(function (p) { p.classList.remove("on"); });
      var pg = $("pg-" + b.getAttribute("data-t"));
      if (pg) {
        pg.classList.add("on");
        try { pg.animate([{ opacity: 0, transform: "translateY(6px)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out" }); } catch (e) {}
      }
    };
  });
  setupInput();
  setupCtxMenu();
  setupPan();
  $("modalOk").onclick = confirmRename;
  $("modalCancel").onclick = hideRename;
  $("modalBack").onclick = function (e) { if (e.target === $("modalBack")) hideRename(); };
  $("modalInput").addEventListener("keydown", function (e) {
    if (e.key === "Enter") confirmRename();
    else if (e.key === "Escape") hideRename();
    e.stopPropagation();
  });
  window.addEventListener("resize", render);
  devices = []; links = []; consoles = []; sessions = {}; curId = null;
  stpInfo = Sim.stpCompute(devices, links);
  render(); renderTasks();
  print('<span class="dim">欢迎使用 DCN 模拟器。画布为空 —— 左侧添加设备并选线型连线，或右上载入 16 个实验。</span>', "");
  print('<span class="dim">缩写全支持：conf t / int e1/0/1 / swi mode acc / sh run / no shut，? 与 TAB 联想。</span>', "");
  status("就绪 · 空画布");
}
document.addEventListener("DOMContentLoaded", init);
// 测试钩子（无头验证用，不影响正常使用）
window.DCNApp = {
  loadLab: loadLab, autoAnswer: autoAnswer,
  loadLabNow: function (id) { var l = LABS.filter(function (x) { return x.id === id; })[0]; if (l) doLoadLab(l); },
  get devices() { return devices; },
  get links() { return links; },
  ping: function (fromName, ip) {
    var src = devices.filter(function (d) { return d.hostname === fromName; })[0];
    if (!src) return { ok: false, reason: "无源设备" };
    return doPing(src, ip, true);
  }
};
})();
