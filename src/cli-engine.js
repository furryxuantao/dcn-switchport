/* DCN CLI 引擎：模式机 + 缩写识别 + ?/TAB + 神州数码命令执行
 * 依赖 window.DCNSim（sim-core.js）。无 DOM，可 node 单测。
 * 缩写规则（真机一致）：每个输入单词是目标命令单词的唯一大小写不敏感前缀即可，
 *   如 swi→switchport, acc→access, int→interface, conf→config, t→terminal, sh→show, run→running-config
 */
(function (global) {
"use strict";
function S() { return global.DCNSim; }

// ---------- 会话 ----------
function createSession(dev) {
  return { devId: dev.id, mode: dev.type === "pc" ? "pc" : "user", ifPorts: [], vlanId: null, ripProc: null, ospfProc: null, authed: false };
}
function promptFor(dev, sess) {
  var h = dev.hostname || (dev.type === "router" ? "Router" : "Switch");
  if (dev.type === "pc") return dev.hostname + ">";
  switch (sess.mode) {
    case "user": return h + ">";
    case "priv": return h + "#";
    case "global": return h + "(Config)#";
    case "if": return h + "(Config-if-" + sess.ifPorts.join(",") + ")#";
    case "vlan": return h + "(Config-vlan" + sess.vlanId + ")#";
    case "mstp": return h + "(Config-mstp-region)#";
    case "rip": return h + "(Config-rip-" + (sess.ripProc || 1) + ")#";
    case "ospf": return h + "(Config-ospf-" + (sess.ospfProc || 1) + ")#";
    default: return h + "#";
  }
}

// ---------- 命令表（help文本严格按PPT中文） ----------
var HELP = {
  user: [
    ["enable", "进入特权用户模式"],
    ["jump <设备名>", "切换到画布上另一台设备"],
    ["sessions", "列出画布所有设备与IP"],
    ["show vlan", "查看当前vlan或IP的配置"],
    ["show ip interface brief", "查看当前端口的配置"],
    ["show ip route", "查看当前路由"],
    ["ping <ip>", "测试连通性"],
    ["exit", "退出"]
  ],
  priv: [
    ["config terminal", "进入全局配置模式"],
    ["exit", "退到上一级模式"],
    ["show running-config", "查看当前交换机的配置"],
    ["show startup-config", "查看启动配置"],
    ["show flash", "查看设备中的文件名及其大小"],
    ["show vlan", "查看当前的vlan配置"],
    ["show mac-address-table", "查看当前MAC地址表"],
    ["show ip interface brief", "查看端口名称、状态、IP"],
    ["show interface <端口>", "查看该端口的详细信息"],
    ["show ip route", "显示路由表"],
    ["show spanning-tree", "查看生成树"],
    ["show port-group brief", "查看链路聚合"],
    ["show monitor", "查看端口镜像"],
    ["show port-security [interface ..]", "查看端口安全"],
    ["set default", "恢复到出厂设置"],
    ["write", "保存当前配置信息"],
    ["reload / reboot", "重新启动"],
    ["delete", "清除startup-config配置信息（路由器）"],
    ["ping <ip>", "测试连通性"],
    ["telnet <ip>", "远程登录"]
  ],
  global: [
    ["enable password 0|7 <密码>", "设置进入特权模式的密码"],
    ["hostname <名>", "给设备重新命名"],
    ["language chinese|english", "命令解释用中文/英文"],
    ["interface <端口/范围>", "进入端口配置模式（如 interface e1/0/1, interface e1/0/1-4）"],
    ["interface vlan <id>", "进入VLAN虚接口"],
    ["vlan <id>", "创建vlan"],
    ["mac-address-learning cpu-control", "开启cpu学习mac地址（端口安全前提）"],
    ["spanning-tree", "开启STP"],
    ["spanning-tree mode mstp", "开启多实例MST"],
    ["spanning-tree mst configuration", "进入MST配置模式"],
    ["spanning-tree mst <实例> priority <值>", "改变优先级（4096倍数，小的优先成根）"],
    ["port-group <1-16>", "创建聚合组"],
    ["monitor session <id> source interface <口> rx|tx|both", "指定镜像源端口"],
    ["monitor session <id> destination interface <口>", "指定镜像目的端口"],
    ["no monitor session <id>", "删除镜像"],
    ["telnet-server enable", "打开Telnet服务（缺省已打开）"],
    ["no telnet-server enable", "关闭Telnet"],
    ["ssh-server enable", "打开SSH服务"],
    ["username <名> password 0|7 <密码>", "创建telnet/ssh登录用户（名≤16，密码≤8）"],
    ["no username <名>", "删除用户"],
    ["telnet-server max-connection <n>", "限定Telnet并发数"],
    ["ssh-server max-connection <n>", "限定SSH并发数"],
    ["ip route <网段> <掩码> <下一跳> [距离]", "静态/默认/备份路由"],
    ["router rip [1]", "启动RIP"],
    ["router ospf <1-65535>", "启动OSPF"],
    ["exit", "回到特权模式"]
  ],
  "if": [
    ["switchport mode access|trunk", "设为access/trunk口"],
    ["switchport access vlan <id>", "将端口加入vlan"],
    ["switchport trunk allowed vlan <3;5-8>", "设置trunk允许通过的vlan"],
    ["switchport port-security", "开启端口安全"],
    ["switchport port-security maximum <N>", "端口最多N个MAC"],
    ["switchport port-security mac-address <XX-XX-XX-XX-XX-XX>", "绑定MAC"],
    ["switchport port-security violation shutdown [recovery <秒>]", "违例则关闭端口（可选N秒后恢复）"],
    ["shutdown / no shutdown", "关闭/打开端口"],
    ["ip address <A> <M>", "配IP（路由口/VLAN虚接口）"],
    ["physical-layer speed 64000", "给DCE串口配时钟"],
    ["ip rip <n> enable", "将该口网段作为RIP交流"],
    ["passive-interface <口>", "设为被动接口，不发路由信息"],
    ["authentication securityip <ip>", "限定可登录的Telnet/SSH客户端IP"],
    ["port-group <n> mode on|active|passive", "加入聚合（on对on，active对active/passive）"],
    ["exit", "返回上一级"]
  ],
  vlan: [
    ["name <名>", "将vlan命名"],
    ["switchport interface <e1/0/x>", "将端口加入该vlan"],
    ["exit", "返回"]
  ],
  mstp: [
    ["instance <实例> vlan <10;20>", "将vlan加入实例"],
    ["exit", "返回"]
  ],
  rip: [
    ["version 2", "设RIP版本2"],
    ["auto-summary", "自动汇总"],
    ["network vlan <id>", "将vlan网段作为RIP交流（三层）"],
    ["interface <口> + ip rip <n> enable", "路由器口使能RIP（先interface再ip rip）"],
    ["passive-interface <口>", "被动接口"],
    ["exit", "返回"]
  ],
  ospf: [
    ["router-id <X.X.X.X>", "设置router-id"],
    ["network <网段> <掩码> area <N>", "宣告直连网段进OSPF"],
    ["exit", "返回"]
  ],
  pc: [
    ["ipconfig", "查看IP"],
    ["ipconfig /all", "查看IP+MAC"],
    ["ping <ip>", "测试连通"],
    ["tracert <ip>", "查看数据包路径"]
  ]
};

// ---------- 缩写匹配核心 ----------
// pattern形如 "switchport mode access"；input tokens与pattern tokens逐词前缀匹配
function tokensOf(s) { return String(s).trim().split(/\s+/).filter(Boolean); }
function matchPattern(inputToks, patternToks) {
  if (inputToks.length > patternToks.length) return false;
  for (var i = 0; i < inputToks.length; i++) {
    var a = inputToks[i].toLowerCase(), b = patternToks[i].toLowerCase();
    if (b.indexOf(a) !== 0) return false; // 输入必须是目标前缀
    if (a.length === 0) return false;
  }
  return true;
}
// 在候选命令集中找唯一匹配（支持参数占位 <...> 通配）
// 规则：输入的每个词必须是对应 pattern 词的唯一前缀；输入可带额外参数
function resolveAbbrev(input, candidates) {
  var inT = tokensOf(input);
  var hits = [];
  candidates.forEach(function (c) {
    var pT = c.toks;
    // 输入词数不能少于 pattern 词数
    if (inT.length < pT.length) return;
    var ok = true;
    for (var i = 0; i < pT.length; i++) {
      var p = pT[i], q = inT[i];
      if (/^<.*>$/.test(p)) { if (!q) { ok = false; break; } continue; }
      if (!p) continue;
      if (p.toLowerCase().indexOf(q.toLowerCase()) !== 0) { ok = false; break; }
    }
    if (!ok) return;
    // 唯一前缀校验：若输入词同时是多个候选的同一位置前缀，视为歧义（由调用方判断）
    hits.push(c);
  });
  return hits;
}
function completeHint(input, candidates) {
  var hits = resolveAbbrev(input, candidates);
  return hits.map(function (h) { return h.raw; });
}

// 当前模式可用命令（用于?与TAB）
function candidatesFor(mode) {
  var list = [];
  function add(raw, toks) { list.push({ raw: raw, toks: toks || tokensOf(raw) }); }
  if (mode === "pc") {
    add("ipconfig"); add("ping <ip>"); add("tracert <ip>"); add("exit"); add("help"); return list;
  }
  if (mode === "user") {
    add("enable"); add("jump <name>"); add("sessions"); add("show vlan"); add("show ip interface brief"); add("show ip route");
    add("show mac-address-table"); add("ping <ip>"); add("tracert <ip>"); add("telnet <ip>"); add("exit"); return list;
  }
  if (mode === "priv") {
    add("config terminal"); add("config"); add("exit");
    add("jump <name>"); add("sessions");
    add("show running-config"); add("show startup-config"); add("show flash");
    add("show vlan"); add("show mac-address-table"); add("show ip interface brief");
    add("show interface <port>"); add("show ip route"); add("show spanning-tree");
    add("show port-group brief"); add("show monitor"); add("show port-security");
    add("show port-security interface <port>"); add("set default"); add("write");
    add("reload"); add("reboot"); add("delete"); add("language chinese"); add("language english");
    add("ping <ip>"); add("tracert <ip>"); add("telnet <ip>");
    return list;
  }
  if (mode === "global") {
    add("enable password 0 <pass>"); add("enable password 7 <pass>");
    add("hostname <name>"); add("language chinese"); add("language english");
    add("interface <port>"); add("interface vlan <id>"); add("vlan <id>");
    add("mac-address-learning cpu-control"); add("spanning-tree");
    add("spanning-tree mode mstp"); add("spanning-tree mst configuration");
    add("spanning-tree mst <id> priority <v>");
    add("port-group <n>"); add("monitor session <id> source interface <port> both");
    add("monitor session <id> destination interface <port>");
    add("no monitor session <id>"); add("telnet-server enable"); add("no telnet-server enable");
    add("ssh-server enable"); add("no ssh-server enable");
    add("username <u> password 0 <p>"); add("username <u> password 7 <p>");
    add("no username <u>"); add("telnet-server max-connection <n>"); add("ssh-server max-connection <n>");
    add("ip route <dest> <mask> <nexthop>"); add("router rip 1"); add("router rip"); add("router ospf <n>");
    add("exit"); add("end");
    return list;
  }
  if (mode === "if") {
    add("switchport mode access"); add("switchport mode trunk");
    add("switchport access vlan <id>"); add("switchport trunk allowed vlan <list>");
    add("switchport port-security"); add("switchport port-security maximum <n>");
    add("switchport port-security mac-address <mac>"); add("switchport port-security violation shutdown");
    add("shutdown"); add("no shutdown"); add("no shutdown"); add("ip address <a> <m>");
    add("physical-layer speed 64000"); add("ip rip 1 enable");
    add("passive-interface <port>"); add("authentication securityip <ip>");
    add("port-group 1 mode on"); add("port-group 1 mode active"); add("port-group 1 mode passive");
    add("telnet-server max-connection <n>"); add("exit");
    return list;
  }
  if (mode === "vlan") { add("name <n>"); add("switchport interface <port>"); add("exit"); return list; }
  if (mode === "mstp") { add("instance <i> vlan <list>"); add("exit"); return list; }
  if (mode === "rip") {
    add("version 2"); add("version 1"); add("auto-summary"); add("no auto-summary");
    add("network vlan <id>"); add("passive-interface <port>"); add("exit"); return list;
  }
  if (mode === "ospf") { add("router-id <ip>"); add("network <net> <mask> area <n>"); add("exit"); return list; }
  return list;
}

// ---------- 执行 ----------
function execLine(ctx, rawLine) {
  // ctx: {devices, links, dev, sess, extra:{ping, telnet...}}
  var Sim = S();
  var dev = ctx.dev, sess = ctx.sess;
  var line = String(rawLine || "").trim();
  if (!line) return { output: "", prompt: promptFor(dev, sess) };
  // ? 处理：空?列全部；"xxx ?"列联想；"xxx?"按前缀补全提示
  if (line === "?" || line === "help") {
    var h = HELP[sess.mode] || HELP.priv;
    var list = h.map(function (x) { return ("  " + x[0]).padEnd(48, " ") + x[1]; });
    list.push("  <命令> ?".padEnd(48, " ") + "查看该命令可用的后续关键字");
    return { output: list.join("\n"), prompt: promptFor(dev, sess) };
  }
  // "xxx ?" 联想：xxx 后面紧跟问号（如 show ? / swi ? / interface ?）
  var qm = line.match(/^(.+?)\s*\?\s*$/);
  if (qm) {
    var base = qm[1].trim();
    var cands = candidatesFor(sess.mode).map(function (c) { return c.raw; });
    var pool;
    if (!base) {
      pool = cands;
    } else {
      var bT = tokensOf(base);
      // 逐词前缀匹配候选（输入 "show" 命中 "show vlan"，输入 "swi" 命中 "switchport ..."）
      pool = cands.filter(function (raw) {
        var rT = tokensOf(raw);
        if (bT.length > rT.length) return false;
        for (var i = 0; i < bT.length; i++) {
          if (rT[i].toLowerCase().indexOf(bT[i].toLowerCase()) !== 0) return false;
        }
        return true;
      });
      // 没命中就退回唯一前缀解析（处理 vlan 10 ? 这类）
      if (!pool.length) {
        pool = resolveAbbrev(base, cands.map(function (c) { return { raw: c, toks: tokensOf(c) }; }))
          .map(function (h2) { return h2.raw; });
      }
    }
    if (!pool.length) {
      return { output: "% 未知命令，输入 ? 查看本模式命令", prompt: promptFor(dev, sess) };
    }
    return { output: pool.join("\n"), prompt: promptFor(dev, sess) };
  }
  var toks = tokensOf(line);
  var low = line.toLowerCase();

  function needPriv() {
    if (sess.mode === "user" || sess.mode === "pc") return "% 需要先 enable 进入特权模式";
    return null;
  }
  function uniq(input, cands) {
    var hits = resolveAbbrev(input, cands.map(function (c) { return { raw: c, toks: tokensOf(c) }; }));
    if (hits.length === 1) return hits[0].raw;
    if (hits.length === 0) return null;
    return "AMB:" + hits.map(function (h) { return h.raw; }).join(" | ");
  }

  // ===== PC模式 =====
  if (sess.mode === "pc") {
    var head = toks[0].toLowerCase();
    if ("ipconfig".indexOf(head) === 0) {
      var all = toks.length >= 2 && /^\/?a(ll)?$/i.test(toks[1]);
      if (all) {
        return { output: "IP Address: " + (dev.pcIp || "(未配置)") + "\nSubnet Mask: " + (dev.pcMask || "-") + "\nGateway: " + (dev.pcGw || "-") + "\nMAC: " + dev.pcMac, prompt: promptFor(dev, sess) };
      }
      return { output: "IP Address: " + (dev.pcIp || "(未配置)") + "\nGateway: " + (dev.pcGw || "-"), prompt: promptFor(dev, sess) };
    }
    if ("ping".indexOf(head) === 0 && head.length >= 2) {
      var ip = toks[1];
      if (!ip) return { output: "用法：ping <ip地址>", prompt: promptFor(dev, sess) };
      var res = ctx.ping(dev, ip);
      var T5 = 5;
      var hd = "正在 Ping " + ip + " [ " + ip + " ] 具有 32 字节的数据:";
      if (res.storm) {
        return {
          output: hd + "\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n" +
            Sim.pingStatsBlock(ip, { min: 0, avg: 0, max: 0 }, 0, T5) +
            "\n% 广播风暴：二层环路未启用生成树，无法通信。请在交换机上开启 spanning-tree。",
          prompt: promptFor(dev, sess)
        };
      }
      if (res.ok) {
        var mm = res.latency || { min: 1, avg: 1, max: 1 };
        if (ctx.stream) {
          var tms = Sim.pingTimes(mm, T5, ip);
          ctx.stream(hd, 0);
          tms.forEach(function (t) { ctx.stream(Sim.formatPingOne(ip, t, 64), 340 + Math.round(t * 60)); });
          ctx.stream(Sim.pingStatsBlock(ip, mm, T5, T5), 420);
          return { output: "", prompt: promptFor(dev, sess), streamed: true };
        }
        return { output: Sim.formatPingWin(ip, mm, T5, T5), prompt: promptFor(dev, sess) };
      }
      return {
        output: hd + "\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n" +
          Sim.pingStatsBlock(ip, { min: 0, avg: 0, max: 0 }, 0, T5) + "\n% " + res.reason,
        prompt: promptFor(dev, sess)
      };
    }
    if ("tracert".indexOf(head) === 0 || "traceroute".indexOf(head) === 0) {
      var ip2 = toks[1];
      if (!ip2) return { output: "用法： tracert <目标ip>", prompt: promptFor(dev, sess) };
      var tr = ctx.tracert(dev, ip2);
      if (!tr.ok) return { output: "无法到达 " + ip2 + "： " + tr.reason, prompt: promptFor(dev, sess) };
      var out = tr.hops.map(function (h, i) { return "  " + (i + 1) + "  " + h.dev + (h.via ? "  (" + h.via + ")" : ""); }).join("\n");
      return { output: "Tracing route to " + ip2 + "\n" + out, prompt: promptFor(dev, sess) };
    }
    return { output: "% 未知命令（试试 ?）", prompt: promptFor(dev, sess) };
  }

  // ===== 通用：exit / enable / config =====
  if (uniq(line, ["exit"]) === "exit") {
    if (sess.mode === "user") return { output: "", prompt: promptFor(dev, sess) };
    if (sess.mode === "priv") { sess.mode = "user"; return { output: "", prompt: promptFor(dev, sess) }; }
    if (sess.mode === "global") { sess.mode = "priv"; return { output: "", prompt: promptFor(dev, sess) }; }
    sess.mode = "global"; sess.ifPorts = [];
    return { output: "", prompt: promptFor(dev, sess) };
  }
  if (uniq(toks[0], ["end"]) === "end" && sess.mode !== "user" && sess.mode !== "priv") {
    sess.mode = "priv"; sess.ifPorts = [];
    return { output: "", prompt: promptFor(dev, sess) };
  }
  // 会话管理：jump <设备名> 切换终端上下文 / sessions 看所有设备
  if (/^(jump|j)\s+/i.test(line)) {
    var t2 = line.replace(/^\S+\s+/, "").trim();
    var list = (ctx.devices || []).map(function (x) { return x; });
    var tgt = list.filter(function (x) { return x.hostname === t2; })[0]
      || list.filter(function (x) { return x.hostname.toLowerCase() === t2.toLowerCase(); })[0];
    if (!tgt) return { output: "% 设备不存在：" + t2, prompt: promptFor(dev, sess) };
    if (ctx.jump) ctx.jump(tgt);
    return { output: "→ 切换到 " + tgt.hostname, prompt: promptFor(dev, sess) };
  }
  if (uniq(line, ["sessions"]) === "sessions") {
    var lines = ["当前终端：" + dev.hostname + "（" + dev.type + "）", ""];
    (ctx.devices || []).forEach(function (x) {
      var ips = S().deviceIpList(x).join(" ") || "无IP";
      lines.push("  " + x.hostname + "  " + x.type + "  " + ips + "   [jump " + x.hostname + "]");
    });
    return { output: lines.join("\n"), prompt: promptFor(dev, sess) };
  }
  if (uniq(toks[0], ["enable"]) === "enable" && toks.length === 1) {
    if (sess.mode === "user") {
      if (dev.enablePassword && !sess.authed) {
        sess.pendingEnable = true;
        return { output: "Password:", prompt: promptFor(dev, sess), needSecret: true };
      }
      sess.mode = "priv"; return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "", prompt: promptFor(dev, sess) };
  }
  // enable密码输入（终端UI以needSecret标记后把下一行当密码）
  if (sess.pendingEnable) {
    sess.pendingEnable = false;
    if (line === dev.enablePassword) { sess.mode = "priv"; sess.authed = true; return { output: "", prompt: promptFor(dev, sess) }; }
    // 密码错误后仍停留在 user 模式，允许重试 enable
    sess.mode = "user";
    return { output: "% 密码错误", prompt: promptFor(dev, sess) };
  }
  // 改过 enable 密码后，旧的登录态失效，需重新输入
  if (/^enable\s+password/i.test(line) && dev.enablePassword) sess.authed = false;
  var ctHit = uniq(line, ["config terminal"]);
  if (ctHit === "config terminal" || uniq(line, ["config"]) === "config") {
    if (sess.mode === "priv") {
      if (dev.configLocked) return { output: "The CONFIG mode is locked by other user, now only one user can login!", prompt: promptFor(dev, sess) };
      sess.mode = "global"; return { output: "", prompt: promptFor(dev, sess) };
    }
  }

  // ===== 特权/用户 show 系列（缩写：sh run / sh ip ro / sh vlan ...） =====
  // 注意：分支顺序必须是 show|sho|sh，否则 "show" 会被 "sh" 先吃掉变成 "ow vlan"
  if (/^(show|sho|sh)\b/i.test(line)) {
    var rest = line.replace(/^(show|sho|sh)\s+/i, "");
    // 归一：用缩写解析定位子命令
    var showCands = ["running-config", "startup-config", "flash", "vlan", "mac-address-table",
      "ip interface brief", "ip route", "interface", "spanning-tree", "port-group brief", "monitor",
      "port-security", "run"];
    var restT = tokensOf(rest);
    var r0 = restT[0] || "";
    // show running-config（sh run / sh ru / sh running-config）
    if (/^run/i.test(r0) && (restT.length === 1)) { rest = "running-config"; restT = ["running-config"]; }
    var hit = resolveAbbrev(rest, showCands.map(function (c) { return { raw: c, toks: tokensOf(c) }; }));
    var key = hit.length === 1 ? hit[0].raw : null;
    // 带参数的 show interface X / show int e1/0/1
    if (/^int(erface)?$/i.test(r0) && restT.length >= 2) {
      var pn = Sim.normalizePort(restT[1]);
      if (!pn || !dev.ports[pn]) return { output: "% 端口不存在（例：e1/0/1, g0/0, s1/0）", prompt: promptFor(dev, sess) };
      var p = dev.ports[pn], cfg = dev.ifIp[pn];
      return { output: pn + " is " + (p.shutdown ? "down" : "up") + ", line protocol is " + (p.shutdown ? "down" : "up") + "\n  Mode: " + p.mode + (p.mode === "access" ? (" vlan " + p.accessVlan) : " trunk") + "\n  IP: " + (cfg && cfg.ip ? cfg.ip + " " + cfg.mask : "unassigned") + (cfg && cfg.clock ? "\n  Clock 64000 (DCE)" : ""), prompt: promptFor(dev, sess) };
    }
    // show port-security [interface X]
    if (/^port-sec/i.test(r0)) {
      var t2 = restT;
      var fIdx = t2.findIndex(function (t, i) { return i > 0 && "interface".indexOf(t.toLowerCase()) === 0; });
      var fp = null;
      if (fIdx >= 0 && t2[fIdx + 1]) fp = Sim.normalizePort(t2[fIdx + 1]);
      return { output: Sim.showPortSecurity(dev, fp), prompt: promptFor(dev, sess) };
    }
    if (!key) {
      if (hit.length > 1) return { output: "% 歧义： " + hit.map(function (h) { return "show " + h.raw; }).join(" / "), prompt: promptFor(dev, sess) };
      return { output: "% 未知show命令，输入 show ? 查看", prompt: promptFor(dev, sess) };
    }
    if (key === "running-config" || key === "run") return { output: Sim.showRunningConfig(dev), prompt: promptFor(dev, sess) };
    if (key === "startup-config") return { output: dev.startupConfig || "This is first time start up system.", prompt: promptFor(dev, sess) };
    if (key === "flash") return { output: "file name           file length\nnos.img             1720035 bytes\nstartup-config      " + (dev.startupConfig ? dev.startupConfig.length + " bytes" : "0 bytes") + "\nrunning-config      783 bytes", prompt: promptFor(dev, sess) };
    if (key === "vlan") return { output: Sim.showVlan(dev), prompt: promptFor(dev, sess) };
    if (key === "mac-address-table") return { output: Sim.showMacTable(dev), prompt: promptFor(dev, sess) };
    if (key === "ip interface brief") return { output: Sim.showIpInterfaceBrief(ctx.devices, dev), prompt: promptFor(dev, sess) };
    if (key === "ip route") return { output: Sim.showIpRoute(dev, ctx.devices, ctx.links), prompt: promptFor(dev, sess) };
    if (key === "spanning-tree") return { output: Sim.showSpanningTree(dev, ctx.stpInfo()), prompt: promptFor(dev, sess) };
    if (key === "port-group brief") return { output: Sim.showPortGroup(dev), prompt: promptFor(dev, sess) };
    if (key === "monitor") return { output: Sim.showMonitor(dev), prompt: promptFor(dev, sess) };
    if (key === "port-security") return { output: Sim.showPortSecurity(dev, null), prompt: promptFor(dev, sess) };
  }

  // ===== 特权：write/reload/set default/delete/reboot/ping/telnet =====
  var wHit = uniq(line, ["write"]);
  if (wHit === "write" && (sess.mode === "priv" || sess.mode === "global")) {
    dev.startupConfig = Sim.showRunningConfig(dev);
    return { output: "Write OK.", prompt: promptFor(dev, sess) };
  }
  if ((uniq(line, ["reload"]) === "reload" || uniq(line, ["reboot"]) === "reboot") && sess.mode === "priv") {
    return { output: "Process with reboot? [Y/N]", prompt: promptFor(dev, sess), needConfirm: "reload" };
  }
  if (ctx.pendingConfirm === "reload" && /^(y|yes)$/i.test(line)) {
    ctx.pendingConfirm = null;
    // reload后running回到startup（若无startup则出厂）
    return { output: "Reloading...", prompt: promptFor(dev, sess) };
  }
  if (uniq(line, ["set default"]) === "set default" && sess.mode === "priv") {
    // 出厂：保留实现为重置动态状态（由UI层真正重置，这里给提示）
    ctx.factoryReset(dev);
    sess.mode = "priv";
    return { output: "Set default OK. 请 write + reload 生效。", prompt: promptFor(dev, sess) };
  }
  if (uniq(line, ["delete"]) === "delete" && sess.mode === "priv") {
    dev.startupConfig = null;
    return { output: "Delete startup-config OK.", prompt: promptFor(dev, sess) };
  }
  // ping：Windows 风格 + 真实延迟 + 风暴阻断
// 通过 ctx.stream(行文本, 间隔ms) 逐包输出；无 stream 时一次性返回
  function doPingCmd(dev, sess, target) {
    var pr = ctx.ping(dev, target);
    var TOTAL = 5;
    var head = "正在 Ping " + target + " [ " + target + " ] 具有 32 字节的数据:";
    if (pr.storm) {
      return {
        output: head + "\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n" +
          Sim.pingStatsBlock(target, { min: 0, avg: 0, max: 0 }, 0, TOTAL) +
          "\n% 广播风暴：二层环路未启用生成树，带宽被广播帧占满，无法通信。" +
          "\n  解决：在环路交换机上执行 spanning-tree 开启生成树。",
        prompt: promptFor(dev, sess)
      };
    }
    if (pr.ok) {
      var m = pr.latency || { min: 1, avg: 1, max: 1 };
      if (ctx.stream) {
        var times = Sim.pingTimes(m, TOTAL, target);
        ctx.stream(head, 0);
        times.forEach(function (t, i) {
          ctx.stream(Sim.formatPingOne(target, t, 64), 340 + Math.round(t * 60));
        });
        ctx.stream(Sim.pingStatsBlock(target, m, TOTAL, TOTAL), 420);
        return { output: "", prompt: promptFor(dev, sess), streamed: true };
      }
      return { output: Sim.formatPingWin(target, m, TOTAL, TOTAL), prompt: promptFor(dev, sess) };
    }
    return {
      output: head + "\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n请求超时。\n" +
        Sim.pingStatsBlock(target, { min: 0, avg: 0, max: 0 }, 0, TOTAL) +
        "\n% " + pr.reason,
      prompt: promptFor(dev, sess)
    };
  }
  if (/^ping\b/i.test(line) && toks.length >= 2 && "ping".indexOf(toks[0].toLowerCase()) === 0) {
    return doPingCmd(dev, sess, toks[1]);
  }
  if (/^tracert\b/i.test(line) || (/^traceroute\b/i.test(line))) {
    var tip = toks[1];
    if (!tip) return { output: "用法： tracert <目标ip>", prompt: promptFor(dev, sess) };
    var tr2 = ctx.tracert(dev, tip);
    if (!tr2.ok) return { output: "无法到达：" + tr2.reason, prompt: promptFor(dev, sess) };
    return { output: tr2.hops.map(function (h, i) { return "  " + (i + 1) + "  " + h.dev; }).join("\n"), prompt: promptFor(dev, sess) };
  }
  if (/^telnet\b/i.test(line) && toks.length >= 2 && "telnet".indexOf(toks[0].toLowerCase()) === 0) {
    return { output: ctx.telnetTo(dev, toks[1]), prompt: promptFor(dev, sess) };
  }

  // ===== 全局模式命令 =====
  if (sess.mode === "global") {
    // hostname（支持缩写 hostname / hostn）
    if (matchPattern(toks.slice(0, 1), ["hostname"]) && toks.length === 2) {
      dev.hostname = toks[1]; return { output: "", prompt: promptFor(dev, sess) };
    }
    // enable password 0|7 xxx（支持 enab passw）
    if (toks.length === 4 && matchPattern([toks[0]], ["enable"]) && matchPattern([toks[1]], ["password"]) && (toks[2] === "0" || toks[2] === "7")) {
      dev.enablePassword = toks[3]; return { output: "", prompt: promptFor(dev, sess) };
    }
    // language
    if (toks.length === 2 && matchPattern([toks[0]], ["language"]) && ("chinese".indexOf(toks[1].toLowerCase()) === 0 || "english".indexOf(toks[1].toLowerCase()) === 0)) {
      dev.language = toks[1].toLowerCase().indexOf("c") === 0 ? "chinese" : "english";
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // mac-address-learning cpu-control
    if (uniq(line, ["mac-address-learning cpu-control"]) === "mac-address-learning cpu-control") {
      dev.cpuControl = true; return { output: "", prompt: promptFor(dev, sess) };
    }
    // vlan XX
    if (matchPattern([toks[0]], ["vlan"]) && toks.length === 2 && /^\d+$/.test(toks[1])) {
      Sim.ensureVlan(dev, toks[1]); sess.mode = "vlan"; sess.vlanId = toks[1];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // interface X（支持 interface e1/0/1-4 / int vlan 20 / int g0/0）
    if (matchPattern([toks[0]], ["interface"]) && toks.length >= 2) {
      var restIf = toks.slice(1).join(" ");
      // interface vlan XX
      var mv = restIf.match(/^vlan\s*(\d+)$/i);
      if (mv) {
        var vid = mv[1]; Sim.ensureVlan(dev, vid);
        sess.mode = "if"; sess.ifPorts = ["vlan" + vid];
        return { output: "", prompt: promptFor(dev, sess) };
      }
      // 去空格后解析范围
      var ports = [];
      restIf.split(",").forEach(function (part) {
        part.split(";").forEach(function (pp) {
          var ex = Sim.expandPortRange(pp.trim());
          ex.forEach(function (p) { if (ports.indexOf(p) < 0) ports.push(p); });
        });
      });
      ports = ports.filter(function (p) { return dev.ports[p] || p.indexOf("vlan") === 0; });
      if (!ports.length) return { output: "% 端口不存在（例：e1/0/1, e1/0/1-4, g0/0, s1/0, vlan10）", prompt: promptFor(dev, sess) };
      sess.mode = "if"; sess.ifPorts = ports;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // spanning-tree 系列
    if (/^spanning-tree/i.test(line)) {
      var st = line.replace(/^spanning-tree\s*/i, "").trim();
      if (!st) { dev.stp.enabled = true; ctx.refreshStp(); return { output: "MSTP is starting now, please wait...........\nMSTP is enabled successfully.", prompt: promptFor(dev, sess) }; }
      if (uniq(st, ["mode mstp"]) === "mode mstp") { dev.stp.mode = "mstp"; dev.stp.enabled = true; ctx.refreshStp(); return { output: "", prompt: promptFor(dev, sess) }; }
      if (uniq(st, ["mst configuration"]) === "mst configuration") { sess.mode = "mstp"; return { output: "", prompt: promptFor(dev, sess) }; }
      var mm = st.match(/^mst\s+(\d+)\s+priority\s+(\d+)$/i);
      if (mm) {
        var pri = parseInt(mm[2], 10);
        if (pri % 4096 !== 0) return { output: "% 优先级必须为4096的倍数", prompt: promptFor(dev, sess) };
        dev.stp.priorities[mm[1]] = pri; dev.stp.priorities["0"] = dev.stp.priorities["0"] || 32768;
        ctx.refreshStp(); return { output: "", prompt: promptFor(dev, sess) };
      }
      return { output: "% 未知spanning-tree命令（试试 spanning-tree ?）", prompt: promptFor(dev, sess) };
    }
    // port-group N（创建）
    var pgm = line.match(/^port-group\s+(\d+)$/i);
    if (pgm) {
      var gn = pgm[1];
      if (!dev.portGroups[gn]) dev.portGroups[gn] = { mode: "on", ports: [] };
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // monitor session
    var monm = line.match(/^monitor\s+session\s+(\d+)\s+(source|destination)\s+.*$/i);
    if (monm) {
      var mres = parseMonitor(dev, line);
      if (mres.err) return { output: mres.err, prompt: promptFor(dev, sess) };
      return { output: "", prompt: promptFor(dev, sess) };
    }
    var nomon = line.match(/^no\s+monitor\s+session\s+(\d+).*$/i);
    if (nomon) { delete dev.monitor[nomon[1]]; return { output: "", prompt: promptFor(dev, sess) }; }
    // telnet/ssh server
    if (uniq(line, ["telnet-server enable"]) === "telnet-server enable") { dev.telnet.enabled = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (uniq(line, ["no telnet-server enable"]) === "no telnet-server enable") { dev.telnet.enabled = false; return { output: "", prompt: promptFor(dev, sess) }; }
    if (uniq(line, ["ssh-server enable"]) === "ssh-server enable") { dev.ssh.enabled = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (uniq(line, ["no ssh-server enable"]) === "no ssh-server enable") { dev.ssh.enabled = false; return { output: "", prompt: promptFor(dev, sess) }; }
    var mc = line.match(/^(telnet-server|ssh-server)\s+max-connection\s+(\d+)$/i);
    if (mc) {
      var n = parseInt(mc[2], 10);
      if (mc[1].toLowerCase().indexOf("telnet") === 0) dev.telnet.maxConn = n; else dev.ssh.maxConn = n;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // username xxx password 0|7 yyy（课程：名≤16，密码≤8）
    var um = line.match(/^username\s+(\S+)\s+password\s+(0|7)\s+(\S+)$/i);
    if (um) {
      if (um[1].length > 16) return { output: "% 用户名最长16字符", prompt: promptFor(dev, sess) };
      dev.users = dev.users.filter(function (u) { return u.name !== um[1]; });
      dev.users.push({ name: um[1], enc: um[2], pass: um[3] });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    var num = line.match(/^no\s+username\s+(\S+)$/i);
    if (num) { dev.users = dev.users.filter(function (u) { return u.name !== num[1]; }); return { output: "", prompt: promptFor(dev, sess) }; }
    // ip route（含默认/备份）
    var ipm = line.match(/^ip\s+route\s+(\S+)\s+(\S+)\s+(\S+)(\s+(\d+))?$/i);
    if (ipm) {
      if (Sim.ipToInt(ipm[1]) === null || Sim.ipToInt(ipm[2]) === null || Sim.ipToInt(ipm[3]) === null)
        return { output: "% IP/掩码格式错误", prompt: promptFor(dev, sess) };
      dev.staticRoutes.push({ dest: ipm[1], mask: ipm[2], nextHop: ipm[3], dist: ipm[5] ? parseInt(ipm[5], 10) : 1 });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // router rip / router ospf
    var rm = line.match(/^router\s+(rip|ospf)(.*)$/i);
    if (rm) {
      var proto = rm[1].toLowerCase(), tail = rm[2].trim();
      if (proto === "rip") {
        var proc = tail ? parseInt(tail, 10) : 1;
        dev.rip.enabled = true; dev.rip.proc = proc || 1; sess.mode = "rip"; sess.ripProc = dev.rip.proc;
        return { output: "", prompt: promptFor(dev, sess) };
      } else {
        var op = tail ? parseInt(tail, 10) : 1;
        if (!(op >= 1 && op <= 65535)) return { output: "% OSPF进程号1-65535", prompt: promptFor(dev, sess) };
        dev.ospf.enabled = true; dev.ospf.proc = op; sess.mode = "ospf"; sess.ospfProc = op;
        return { output: "", prompt: promptFor(dev, sess) };
      }
    }
    return { output: "% 未知命令（输入 ? 查看本模式命令，支持缩写如 conf t / int e1/0/1 / sh run）", prompt: promptFor(dev, sess) };
  }

  // ===== 接口模式 =====
  if (sess.mode === "if") {
    var ports = sess.ifPorts;
    function eachPort(fn) { ports.forEach(function (pn) { fn(pn); }); }
    // switchport mode access|trunk（缩写 swi mode acc/trunk）
    var smm = line.match(/^swi\w*\s+mode\s+(\S+)$/i) || line.match(/^switchport\s+mode\s+(\S+)$/i);
    if (smm) {
      var md = smm[1].toLowerCase();
      var full = ("access".indexOf(md) === 0) ? "access" : ("trunk".indexOf(md) === 0 ? "trunk" : null);
      if (!full) return { output: "% 模式应为 access/trunk", prompt: promptFor(dev, sess) };
      eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].mode = full; if (full === "access" && !dev.ports[pn].accessVlan) dev.ports[pn].accessVlan = 1; } });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // switchport access vlan（缩写 swi acc vlan 10 / swi acc 10）
    var sam = line.match(/^swi\w*\s+acc\w*\s+(vlan\s+)?(\d+)$/i) || line.match(/^switchport\s+access\s+vlan\s+(\d+)$/i);
    if (sam) {
      var vid2 = sam[2] || sam[1];
      eachPort(function (pn) { if (dev.ports[pn]) S().setAccessVlan(dev, pn, vid2); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // switchport trunk allowed vlan（缩写 swi trunk allowed vlan 3;5-8）
    if (/^swi\w*\s+trunk\s+allowed\s+vlan/i.test(line) || /^switchport\s+trunk\s+allowed\s+vlan/i.test(line)) {
      var listStr = line.replace(/^.*vlan\s*/i, "");
      var list = parseVlanList(listStr);
      if (!list) return { output: "% vlan列表格式如 3;5-8", prompt: promptFor(dev, sess) };
      eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].mode = "trunk"; dev.ports[pn].trunkAllowed = list; } });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // switchport port-security 系列（缩写 swi port-sec ...）
    if (/^swi\w*\s+port-sec/i.test(line) || /^switchport\s+port-security/i.test(line)) {
      var tail2 = line.replace(/^swi\w*\s+port-sec\w*|^switchport\s+port-security/i, "").trim();
      if (!tail2) { eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].portSecurity.enabled = true; }); return { output: "", prompt: promptFor(dev, sess) }; }
      var mmax = tail2.match(/^(max\w*|maximum)\s+(\d+)$/i);
      if (mmax) { eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].portSecurity.enabled = true; dev.ports[pn].portSecurity.max = parseInt(mmax[2], 10); } }); return { output: "", prompt: promptFor(dev, sess) }; }
      var mmac = tail2.match(/^(mac-add\w*|mac-address)\s+(\S+)$/i);
      if (mmac) {
        var nm = S().normMac(mmac[2]);
        if (!nm) return { output: "% MAC格式如 XX-XX-XX-XX-XX-XX", prompt: promptFor(dev, sess) };
        eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].portSecurity.enabled = true; dev.ports[pn].portSecurity.staticMacs.push(nm); } });
        return { output: "", prompt: promptFor(dev, sess) };
      }
      var mv = tail2.match(/^violation\s+shutdown(\s+recovery\s+(\d+))?$/i);
      if (mv) { eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].portSecurity.enabled = true; dev.ports[pn].portSecurity.violation = "shutdown"; if (mv[2]) dev.ports[pn].portSecurity.recovery = parseInt(mv[2], 10); } }); return { output: "", prompt: promptFor(dev, sess) }; }
      return { output: "% 用法：swi port-sec [maximum N | mac-add XX | violation shutdown [recovery N]]", prompt: promptFor(dev, sess) };
    }
    // shutdown / no shutdown（真机缩写：任意唯一前缀 shut/shutd/shutdown，no shut 同理）
    var _t = tokensOf(line);
    if (_t.length === 1 && "shutdown".indexOf(_t[0].toLowerCase()) === 0 && _t[0].length >= 3) { eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].shutdown = true; }); return { output: "", prompt: promptFor(dev, sess) }; }
    if (_t.length === 2 && _t[0].toLowerCase() === "no" && "shutdown".indexOf(_t[1].toLowerCase()) === 0 && _t[1].length >= 3) {
      eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].shutdown = false; dev.ports[pn].violated = false; } });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // swi 别名：swi mode acc 等已处理；swi access vlan 兜底
    // ip address
    // ip address / ip add / ip addr 都能识别
    var iam = line.match(/^ip\s+(add(?:r|ress)?)\s+(\S+)\s+(\S+)$/i);
    if (iam) {
      if (S().ipToInt(iam[2]) === null || S().ipToInt(iam[3]) === null) return { output: "% IP/掩码错误", prompt: promptFor(dev, sess) };
      ports.forEach(function (pn) {
        if (pn.indexOf("vlan") === 0) {
          var v = pn.replace("vlan", "");
          dev.vlanIf[v] = { ip: iam[2], mask: iam[3] };
          if (v === "1") { dev.mgmtIp = iam[2]; dev.mgmtMask = iam[3]; }
        } else if (dev.ports[pn]) {
          dev.ifIp[pn] = dev.ifIp[pn] || {};
          dev.ifIp[pn].ip = iam[2]; dev.ifIp[pn].mask = iam[3];
        }
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // no ip address
    if (/^no\s+ip\s+address/i.test(line)) {
      ports.forEach(function (pn) {
        if (pn.indexOf("vlan") === 0) delete dev.vlanIf[pn.replace("vlan", "")];
        else delete dev.ifIp[pn];
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // physical-layer speed 64000
    if (/^physical-layer\s+speed\s+64000$/i.test(line)) {
      ports.forEach(function (pn) { dev.ifIp[pn] = dev.ifIp[pn] || {}; dev.ifIp[pn].clock = true; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip rip N enable
    var ripm = line.match(/^ip\s+rip\s+(\d+)\s+enable$/i);
    if (ripm) {
      dev.rip.enabled = true; dev.rip.proc = parseInt(ripm[1], 10);
      ports.forEach(function (pn) { dev.rip.enabledIfs[pn] = true; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // passive-interface
    var pim = line.match(/^passive-interface\s+(\S+)$/i);
    if (pim) {
      var pp = S().normalizePort(pim[1]);
      if (pp) dev.rip.passiveIfs[pp] = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // authentication securityip
    var secm = line.match(/^authentication\s+securityip\s+(\S+)$/i);
    if (secm) {
      if (S().ipToInt(secm[1]) === null) return { output: "% IP格式错误", prompt: promptFor(dev, sess) };
      dev.telnet.securityIp = secm[1]; dev.ssh.securityIp = secm[1];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    var nsecm = line.match(/^no\s+authentication\s+securityip/i);
    if (nsecm) { dev.telnet.securityIp = null; return { output: "", prompt: promptFor(dev, sess) }; }
    // telnet-server max-connection（课程写在vlan口下，也兼容）
    var tmc = line.match(/^(telnet-server|ssh-server)\s+max-connection\s+(\d+)$/i);
    if (tmc) {
      if (tmc[1].toLowerCase().indexOf("telnet") === 0) dev.telnet.maxConn = parseInt(tmc[2], 10);
      else dev.ssh.maxConn = parseInt(tmc[2], 10);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // port-group N mode on|active|passive
    var pgm = line.match(/^port-group\s+(\d+)\s+mode\s+(on|active|passive)$/i);
    if (pgm) {
      var gnum = pgm[1], gmode = pgm[2].toLowerCase();
      if (!dev.portGroups[gnum]) dev.portGroups[gnum] = { mode: gmode, ports: [] };
      dev.portGroups[gnum].mode = gmode;
      ports.forEach(function (pn) {
        if (dev.ports[pn]) {
          dev.ports[pn].aggGroup = parseInt(gnum, 10);
          if (dev.portGroups[gnum].ports.indexOf(pn) < 0) dev.portGroups[gnum].ports.push(pn);
        }
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // interface 嵌套切换
    if (/^interface\b/i.test(line)) {
      sess.mode = "global";
      var r2 = execLine({ devices: ctx.devices, links: ctx.links, dev: dev, sess: sess, ping: ctx.ping, tracert: ctx.tracert, telnetTo: ctx.telnetTo, stpInfo: ctx.stpInfo, refreshStp: ctx.refreshStp, factoryReset: ctx.factoryReset }, line.replace(/^interface/i, "interface"));
      // 上面已把mode切到global又执行了一次，会进global分支；简化直接处理
      return r2;
    }
    return { output: "% 未知接口命令（输入 ? 查看；支持缩写如 swi mode acc / no shut / ip add）", prompt: promptFor(dev, sess) };
  }

  // ===== vlan配置模式 =====
  if (sess.mode === "vlan") {
    var nm2 = line.match(/^name\s+(\S+)$/i);
    if (nm2) { S().ensureVlan(dev, sess.vlanId).name = nm2[1]; return { output: "", prompt: promptFor(dev, sess) }; }
    var swm = line.match(/^(switchport\s+interface|swi\w*\s+int\w*)\s+(.+)$/i);
    if (swm) {
      var plist = [];
      swm[2].split(/[;,]/).forEach(function (pp) {
        S().expandPortRange(pp.trim()).forEach(function (p) { plist.push(p); });
      });
      plist.forEach(function (p) { if (dev.ports[p]) S().setAccessVlan(dev, p, sess.vlanId); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "% vlan模式：name / switchport interface（?查看）", prompt: promptFor(dev, sess) };
  }
  // ===== mstp region =====
  if (sess.mode === "mstp") {
    var im = line.match(/^instance\s+(\d+)\s+vlan\s+(.+)$/i);
    if (im) {
      var inst = im[1], vlist = parseVlanList(im[2].replace(/,/g, ";"));
      if (!vlist) return { output: "% vlan列表如 10;20", prompt: promptFor(dev, sess) };
      dev.stp.instances[inst] = vlist; dev.stp.enabled = true; ctx.refreshStp();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "% 用法：instance <号> vlan <列表>", prompt: promptFor(dev, sess) };
  }
  // ===== rip =====
  if (sess.mode === "rip") {
    if (/^version\s+2$/i.test(line)) { dev.rip.version = 2; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^version\s+1$/i.test(line)) { dev.rip.version = 1; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^auto-summary$/i.test(line)) { dev.rip.autoSummary = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^no\s+auto-summary$/i.test(line)) { dev.rip.autoSummary = false; return { output: "", prompt: promptFor(dev, sess) }; }
    var nwm = line.match(/^network\s+vlan\s+(\d+)$/i);
    if (nwm) { dev.rip.networks.push(nwm[1]); dev.rip.enabled = true; return { output: "", prompt: promptFor(dev, sess) }; }
    var nwm2 = line.match(/^network\s+(\S+)(\s+(\S+))?$/i);
    if (nwm2 && nwm2[1].toLowerCase() !== "vlan") {
      dev.rip.networks.push(nwm2[1]); dev.rip.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    var pi2 = line.match(/^passive-interface\s+(\S+)$/i);
    if (pi2) { var pp2 = S().normalizePort(pi2[1]); if (pp2) dev.rip.passiveIfs[pp2] = true; return { output: "", prompt: promptFor(dev, sess) }; }
    // 允许在rip模式直接 interface xxx（跳回global处理）
    if (/^interface\b/i.test(line)) { sess.mode = "global"; return execLine(ctx, line); }
    return { output: "% rip模式：version 2 / auto-summary / network vlan X / passive-interface（?查看）", prompt: promptFor(dev, sess) };
  }
  // ===== ospf =====
  if (sess.mode === "ospf") {
    var rid = line.match(/^router-id\s+(\S+)$/i);
    if (rid) {
      if (S().ipToInt(rid[1]) === null) return { output: "% router-id格式 X.X.X.X", prompt: promptFor(dev, sess) };
      dev.ospf.routerId = rid[1]; return { output: "", prompt: promptFor(dev, sess) };
    }
    var netm = line.match(/^network\s+(\S+)\s+(\S+)\s+area\s+(\d+)$/i);
    if (netm) {
      if (S().ipToInt(netm[1]) === null || S().ipToInt(netm[2]) === null) return { output: "% network格式：network 网段 掩码 area 号", prompt: promptFor(dev, sess) };
      dev.ospf.networks.push({ net: netm[1], mask: netm[2], area: netm[3] });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "% ospf模式：router-id / network 网段 掩码 area 号", prompt: promptFor(dev, sess) };
  }

  return { output: "% 未知命令（?查看，TAB补全，支持缩写）", prompt: promptFor(dev, sess) };
}

function parseVlanList(s) {
  // 接受 "3;5-8" "10,20" "10;20"
  var out = [];
  var parts = String(s).split(/[;, ]+/).filter(Boolean);
  for (var i = 0; i < parts.length; i++) {
    var m = parts[i].match(/^(\d+)-(\d+)$/);
    if (m) {
      for (var v = parseInt(m[1], 10); v <= parseInt(m[2], 10); v++) out.push(v);
    } else if (/^\d+$/.test(parts[i])) out.push(parseInt(parts[i], 10));
    else return null;
  }
  return out;
}
function parseMonitor(dev, line) {
  // monitor session 1 source int e1/0/2 both
  // monitor session 1 destination int e1/0/1
  var m = line.match(/^monitor\s+session\s+(\d+)\s+(source|destination)\s+(?:int\w*\s+|interface\s+)?(\S+)(?:\s+(rx|tx|both))?$/i);
  if (!m) return { err: "% 用法：monitor session <1-100> source|destination interface <口> [rx|tx|both]" };
  var id = m[1], dir = m[2].toLowerCase(), portRaw = m[3], flow = (m[4] || "both").toLowerCase();
  var Sim = S();
  var pn = Sim.normalizePort(portRaw);
  if (!pn || !dev.ports[pn]) return { err: "% 端口不存在" };
  if (!dev.monitor[id]) dev.monitor[id] = { sources: [], dest: null };
  if (dir === "source") dev.monitor[id].sources.push({ port: pn, dir: flow });
  else dev.monitor[id].dest = pn;
  return { ok: true };
}

var api = {
  createSession: createSession, promptFor: promptFor, execLine: execLine,
  candidatesFor: candidatesFor, resolveAbbrev: resolveAbbrev, HELP: HELP, parseVlanList: parseVlanList
};
if (typeof module !== "undefined" && module.exports) module.exports = api;
global.DCNCLI = api;
})(typeof window !== "undefined" ? window : global);
