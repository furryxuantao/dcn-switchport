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
  var s = { devId: dev.id, mode: dev.type === "pc" ? "pc" : "user", ifPorts: [], vlanId: null, ripProc: null, ospfProc: null, authed: false };
  // 统一的模式切换：进入新模式时清掉其它模式遗留的上下文，避免状态串味
  s.enter = function (m) {
    s.mode = m;
    if (m !== "if") s.ifPorts = [];
    if (m !== "vlan") s.vlanId = null;
    if (m !== "rip") s.ripProc = null;
    if (m !== "ospf") s.ospfProc = null;
    if (m !== "acl") s.aclId = null;
    if (m !== "dhcp-pool") s.dhcpPool = null;
    return s.mode;
  };
  return s;
}
// 兼容没有 enter 的外部 session（兜底：直接改 mode）
function enterMode(sess, m) {
  if (typeof sess.enter === "function") return sess.enter(m);
  sess.mode = m;
  if (m !== "if") sess.ifPorts = [];
  if (m !== "vlan") sess.vlanId = null;
  if (m !== "rip") sess.ripProc = null;
  if (m !== "ospf") sess.ospfProc = null;
  if (m !== "acl") sess.aclId = null;
  if (m !== "dhcp-pool") sess.dhcpPool = null;
  return m;
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
    case "acl": return h + "(Config-acl-" + (sess.aclId || "") + ")#";
    case "dhcp-pool": return h + "(Config-dhcp-pool-" + (sess.dhcpPool || "") + ")#";
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
    ["show dhcp snooping", "查看DHCP Snooping 表与信任口"],
    ["show igmp snooping", "查看IGMP Snooping 组播表"],
    ["show arp inspection", "查看动态ARP检测状态"],
    ["show port-isolate", "查看端口隔离分组"],
    ["show qos priority", "查看端口优先级"],
    ["show loop-guard", "查看环路保护"],
    ["show mac-address static", "查看静态MAC绑定"],
    ["show mac aging", "查看MAC老化与表项上限"],
    ["show lldp", "查看LLDP状态"],
    ["show snmp", "查看SNMP配置"],
    ["show access-lists", "查看ACL规则与应用位置"],
    ["show vrrp", "查看VRRP组状态与Master"],
    ["show ip dhcp pool", "查看DHCP地址池"],
    ["show ip dhcp binding", "查看DHCP地址绑定"],
    // ---- 思科对标 ----
    ["show vtp / show vtp status", "查看VTP状态"],
    ["show spanning-tree detail", "查看生成树详细（角色/保护口）"],
    ["show etherchannel summary", "查看链路聚合摘要"],
    ["show etherchannel load-balance", "查看聚合负载分担算法"],
    ["show interfaces status", "查看接口状态一览"],
    ["show interfaces trunk", "查看trunk接口与允许VLAN"],
    ["show ip interface", "查看接口IP与辅助地址"],
    ["show ip helper", "查看DHCP中继配置"],
    ["show ip proxy-arp", "查看代理ARP"],
    ["show ip rip", "查看RIP详细配置"],
    ["show ip ospf", "查看OSPF详细配置"],
    ["show ip route static", "查看静态路由"],
    ["show version", "查看系统版本与运行时间"],
    ["show device-info", "查看设备信息一览"],
    ["show logging", "查看日志配置"],
    ["show clock", "查看时钟与NTP"],
    ["show aaa", "查看AAA配置"],
    ["show users", "查看本地用户与特权级"],
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
    // ---- DCN 企业级特性 ----
    ["ip dhcp snooping [vlan <列表> [rate <n>]]", "开启DHCP Snooping 防欺骗（接口下 ip dhcp snooping trust 指定信任口）"],
    ["ip igmp snooping [version <2|3>]", "开启IGMP Snooping 组播抑制"],
    ["ip arp inspection [vlan <列表>]", "开启动态ARP检测 DAI"],
    ["switchport loop-guard enable", "全局开启环路保护"],
    ["mac-address aging-time <秒>", "设置MAC老化时间"],
    ["mac-address maximum <N>", "设置MAC表项上限"],
    ["mac-address static <MAC> interface <端口>", "静态绑定MAC到端口"],
    ["lldp enable", "开启LLDP 邻居发现"],
    ["snmp-server community <串> [ro]", "开启SNMP并设置团体字"],
    ["snmp-agent sys-contact <串>", "设置SNMP联系人"],
    ["snmp-agent sys-location <串>", "设置SNMP位置"],
    ["debug mirror", "调试端口镜像（课程实验用）"],
    // ---- 思科对标增强 ----
    ["vtp mode server|client|transparent", "VTP模式（VLAN统一管理）"],
    ["vtp domain <名>", "设置VTP域"],
    ["vtp version <1|2|3>", "VTP版本"],
    ["vtp pruning", "开启VTP修剪"],
    ["spanning-tree guard root", "全局根守卫"],
    ["spanning-tree portfast default", "全局边缘口（接入口秒进FWD）"],
    ["spanning-tree bpduguard default", "全局BPDU Guard"],
    ["spanning-tree forward-time|hello-time|max-age <秒>", "生成树计时器"],
    // ---- 三层增强 ----
    ["ip helper-address <DHCP服务器IP>", "DHCP中继（接口下配，转发给远端DHCP服务器）"],
    ["ip proxy-arp", "全局开启代理ARP"],
    ["ip address <IP> <掩码> secondary", "配置辅助地址（接口下）"],
    ["auto-cost reference-bandwidth <Mbit>", "OSPF参考带宽"],
    // ---- 设备管理与运维 ----
    ["logging host <IP>", "指定日志服务器（syslog）"],
    ["logging trap <级别>", "设置日志级别"],
    ["clock timezone <±时区>", "设置时区"],
    ["ntp server <IP>", "配置NTP时间同步服务器"],
    ["aaa new-model", "启用AAA新模型"],
    ["tacacs-server host <IP> [key <密钥>]", "配置TACACS+服务器"],
    ["radius-server host <IP> [key <密钥>]", "配置RADIUS服务器"],
    ["snmp-server user <名> <组> auth sha <密钥>", "配置SNMPv3用户"],
    ["banner motd <文本>", "设置登录提示语"],
    ["username <名> privilege <0-15> <口令>", "创建带特权级的用户"],
    ["config-register <值>", "设置配置寄存器"],
    ["service password-recovery", "启用密码恢复"],
    ["history size <条数>", "设置命令历史条数"],
    // ---- ACL / VRRP / DHCP 服务器 ----
    ["ip access-list <standard|extended> <编号>", "创建ACL并进入配置模式"],
    ["ip access-list extended <编号> → permit/deny", "ACL规则：seq <n> permit ip <源> <目的> [eq 端口] [log]"],
    ["service dhcp", "开启DHCP服务器"],
    ["ip dhcp pool <名字>", "创建DHCP地址池并进入配置模式"],
    ["ip dhcp excluded-address <起> [止]", "排除地址池中的地址"],
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
    hits.push(c);
  });
  if (hits.length) return hits;
  // 兜底：允许跨连字符的分段缩写（真机行为）。
  // 输入的每一段都必须是模式各段的前缀——如 por-sec 命中 port-security，
  // por-gr 命中 port-group brief。只在前缀匹配完全落空时才启用，避免改变既有语义。
  var inSegs = inT.join("").toLowerCase().split(/[-_]+/).filter(Boolean);
  if (inSegs.length < 2) return hits;
  candidates.forEach(function (c) {
    var pSegs = c.toks.join("").toLowerCase().split(/[-_]+/).filter(Boolean);
    var si = 0, all = true;
    for (var i = 0; i < inSegs.length; i++) {
      var seg = inSegs[i], found = -1;
      for (var j = si; j < pSegs.length; j++) {
        if (pSegs[j].indexOf(seg) === 0) { found = j; break; }
      }
      if (found < 0) { all = false; break; }
      si = found + 1;                       // 段必须顺序推进，不可重复占用
    }
    if (all) hits.push(c);
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
    add("show dhcp snooping"); add("show igmp snooping"); add("show arp inspection");
    add("show port-isolate"); add("show qos priority"); add("show loop-guard");
    add("show mac-address static"); add("show mac aging"); add("show lldp"); add("show snmp");
    add("show access-lists"); add("show vrrp");
    add("show ip dhcp pool"); add("show ip dhcp binding");
    add("show ip interface"); add("show ip helper"); add("show ip proxy-arp");
    add("show ip rip"); add("show ip ospf"); add("show ip route static");
    add("show version"); add("show device-info"); add("show logging");
    add("show clock"); add("show aaa"); add("show users");
    add("show vtp"); add("show vtp status");
    add("show spanning-tree detail"); add("show spanning-tree root");
    add("show etherchannel summary"); add("show etherchannel load-balance");
    add("show interfaces status"); add("show interfaces trunk");
    add("reload"); add("reboot"); add("delete"); add("language chinese"); add("language english");
    add("ping <ip>"); add("tracert <ip>"); add("telnet <ip>");
    return list;
  }
  if (mode === "global") {
    add("enable password 0 <pass>"); add("enable password 7 <pass>");
    add("hostname <name>"); add("language chinese"); add("language english");
    add("interface <port>"); add("interface vlan <id>"); add("vlan <id>");
    add("mac-address-learning cpu-control"); add("spanning-tree");
    add("ip dhcp snooping"); add("ip dhcp snooping vlan <list> rate <n>");
    add("ip igmp snooping"); add("ip igmp version <2|3>");
    add("ip arp inspection"); add("ip arp inspection vlan <list>");
    add("switchport loop-guard enable"); add("no switchport loop-guard");
    add("mac-address aging-time <sec>"); add("mac-address maximum <n>");
    add("mac-address static <mac> interface <port>"); add("no mac-address static interface <port>");
    add("lldp enable"); add("no lldp"); add("snmp-server enable");
    add("snmp-server community <str> ro"); add("snmp-agent sys-contact <str>"); add("snmp-agent sys-location <str>");
    add("debug mirror");
    add("vtp mode <server|client|transparent>"); add("vtp domain <name>");
    add("vtp version <1|2|3>"); add("vtp pruning"); add("no vtp pruning");
    add("spanning-tree guard root"); add("no spanning-tree guard root");
    add("spanning-tree portfast default"); add("spanning-tree bpduguard default");
    add("spanning-tree forward-time <sec>"); add("spanning-tree hello-time <sec>");
    add("spanning-tree max-age <sec>");
    add("ip helper-address <ip>"); add("no ip helper-address");
    add("ip proxy-arp"); add("no ip proxy-arp");
    add("auto-cost reference-bandwidth <mbit>"); add("log-adjacency-changes");
    add("logging host <ip>"); add("logging trap <level>"); add("no logging");
    add("clock timezone <±hh>"); add("ntp server <ip>"); add("no ntp");
    add("aaa new-model"); add("aaa authentication login <local|tacacs|radius>");
    add("tacacs-server host <ip>"); add("radius-server host <ip>");
    add("snmp-server user <name> <group>"); add("banner motd <text>");
    add("username <name> privilege <0-15> <0|7> <pass>");
    add("config-register <val>"); add("service password-recovery");
    add("service timestamps"); add("history size <n>");
    add("ip access-list <standard|extended> <num>");
    add("ip access-list extended <num>"); add("no ip access-list <num>");
    add("service dhcp"); add("no service dhcp");
    add("ip dhcp pool <name>"); add("no ip dhcp pool <name>");
    add("ip dhcp excluded-address <start> [end]");
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
    add("switchport isolate group <n>"); add("no switchport isolate group");
    add("ip access-group <num> in"); add("ip access-group <num> out"); add("no ip access-group");
    add("vrrp <id> ip <vip>"); add("vrrp <id> priority <1-254>");
    add("vrrp <id> timers advertise <sec> hold <sec>");
    add("spanning-tree portfast"); add("no spanning-tree portfast");
    add("spanning-tree bpduguard"); add("no spanning-tree bpduguard");
    add("spanning-tree bpdufilter"); add("spanning-tree guard root");
    add("spanning-tree edge"); add("description <text>");
    add("speed <10|100|1000>"); add("duplex <auto|full|half>"); add("negotiation auto");
    add("storm-control broadcast level <n>"); add("udld enable"); add("dot1x port-control auto"); add("proxy arp"); add("ip helper-address <ip>");
    add("switchport priority <0-7>"); add("ip dhcp snooping trust"); add("no ip dhcp snooping trust");
    add("loop-guard enable"); add("no loop-guard"); add("switchport speed limit <kbps>");
    add("shutdown"); add("no shutdown"); add("no shutdown"); add("ip address <a> <m>");
    add("physical-layer speed 64000"); add("ip rip 1 enable");
    add("passive-interface <port>"); add("authentication securityip <ip>");
    add("port-group 1 mode on"); add("port-group 1 mode active"); add("port-group 1 mode passive");
    add("port-group <n> load-balance <算法>"); add("port-group <n> min-links <n>");
    add("telnet-server max-connection <n>"); add("exit");
    return list;
  }
  if (mode === "vlan") { add("name <n>"); add("switchport interface <port>"); add("exit"); return list; }
  if (mode === "acl") {
    add("remark <描述>"); add("seq <n> permit ip <源> <目的>");
    add("permit ip any any"); add("deny ip any any");
    add("permit tcp <源> <目的> eq <端口>"); add("deny ip any any log");
    add("exit"); return list;
  }
  if (mode === "dhcp-pool") {
    add("network <网段> <掩码>"); add("default-router <网关>");
    add("dns-server <IP>"); add("lease <秒>"); add("range <起始> <结束>");
    add("vlan <id>"); add("exit"); return list;
  }
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
    if (sess.mode === "priv") { enterMode(sess, "user"); return { output: "", prompt: promptFor(dev, sess) }; }
    if (sess.mode === "global") { enterMode(sess, "priv"); return { output: "", prompt: promptFor(dev, sess) }; }
    enterMode(sess, "global"); sess.ifPorts = [];
    return { output: "", prompt: promptFor(dev, sess) };
  }
  if (uniq(toks[0], ["end"]) === "end" && sess.mode !== "user" && sess.mode !== "priv") {
    enterMode(sess, "priv"); sess.ifPorts = [];
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
      enterMode(sess, "priv"); return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "", prompt: promptFor(dev, sess) };
  }
  // enable密码输入（终端UI以needSecret标记后把下一行当密码）
  if (sess.pendingEnable) {
    sess.pendingEnable = false;
    if (line === dev.enablePassword) { enterMode(sess, "priv"); sess.authed = true; return { output: "", prompt: promptFor(dev, sess) }; }
    // 密码错误后仍停留在 user 模式，允许重试 enable
    enterMode(sess, "user");
    return { output: "% 密码错误", prompt: promptFor(dev, sess) };
  }
  // 改过 enable 密码后，旧的登录态失效，需重新输入
  if (/^enable\s+password/i.test(line) && dev.enablePassword) sess.authed = false;
  var ctHit = uniq(line, ["config terminal"]);
  if (ctHit === "config terminal" || uniq(line, ["config"]) === "config") {
    if (sess.mode === "priv") {
      if (dev.configLocked) return { output: "The CONFIG mode is locked by other user, now only one user can login!", prompt: promptFor(dev, sess) };
      enterMode(sess, "global"); return { output: "", prompt: promptFor(dev, sess) };
    }
  }

  // ===== 特权/用户 show 系列（缩写：sh run / sh ip ro / sh vlan ...） =====
  // 注意：分支顺序必须是 show|sho|sh，否则 "show" 会被 "sh" 先吃掉变成 "ow vlan"
  if (/^(show|sho|sh)\b/i.test(line)) {
    var rest = line.replace(/^(show|sho|sh)\s+/i, "");
    // 归一：用缩写解析定位子命令
    var showCands = ["running-config", "startup-config", "flash", "vlan", "mac-address-table",
      "ip interface brief", "ip route", "interface", "spanning-tree", "port-group brief", "monitor",
      "port-security", "run",
      // ---- DCN 企业级特性 ----
      "dhcp snooping", "igmp snooping", "arp inspection", "port-isolate",
      "qos priority", "loop-guard", "mac-address static", "mac aging", "lldp", "snmp",
      // ---- ACL / VRRP / DHCP 服务器 ----
      "access-lists", "acl", "vrrp", "ip dhcp pool", "ip dhcp binding",
      // ---- 思科对标增强 ----
      "vtp", "vtp status", "spanning-tree detail", "spanning-tree interface",
      "spanning-tree root", "spanning-tree portfast", "spanning-tree bpduguard",
      "spanning-tree bpdufilter", "spanning-tree guard root", "spanning-tree vtp",
      "etherchannel summary", "etherchannel load-balance", "port-group summary",
      "interfaces status", "interfaces trunk", "ip eigrp",
      // ---- 三层增强 ----
      "ip interface", "ip route static", "ip helper", "ip proxy-arp", "ip rip", "ip ospf",
      // ---- 设备管理与运维 ----
      "version", "device-info", "logging", "clock", "aaa", "users", "system-info"];
    var restT = tokensOf(rest);
    var r0 = restT[0] || "";
    // show running-config（sh run / sh ru / sh running-config）
    if (/^run/i.test(r0) && (restT.length === 1)) { rest = "running-config"; restT = ["running-config"]; }
    // 候选词数必须与输入词数一致：否则 "sh mac aging" 会被单词候选 "mac-address-table" 抢走
    var showCandObjs = showCands.map(function (c) { return { raw: c, toks: tokensOf(c) }; })
      .filter(function (c) { return c.toks.length === restT.length; });
    var hit = resolveAbbrev(rest, showCandObjs);
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
    // ---- 思科对标：show 子命令 ----
    if (key === "vtp") return { output: Sim.showVtp(dev, ctx.devices), prompt: promptFor(dev, sess) };
    if (key === "vtp status") return { output: Sim.showVtpStatus(dev, ctx.devices), prompt: promptFor(dev, sess) };
    if (key === "spanning-tree detail") return { output: Sim.showStpDetail(dev, ctx.stpInfo()), prompt: promptFor(dev, sess) };
    if (key === "spanning-tree interface") return { output: Sim.showStpDetail(dev, ctx.stpInfo()), prompt: promptFor(dev, sess) };
    if (key === "spanning-tree root") return { output: Sim.showStpDetail(dev, ctx.stpInfo()), prompt: promptFor(dev, sess) };
    if (key === "spanning-tree portfast" || key === "spanning-tree bpduguard" ||
      key === "spanning-tree bpdufilter" || key === "spanning-tree guard root" ||
      key === "spanning-tree vtp") {
      return { output: Sim.showStpDetail(dev, ctx.stpInfo()), prompt: promptFor(dev, sess) };
    }
    if (key === "etherchannel summary" || key === "port-group summary") {
      return { output: Sim.showPortGroup(dev), prompt: promptFor(dev, sess) };
    }
    if (key === "etherchannel load-balance") {
      return { output: Sim.showLoadBalance(dev), prompt: promptFor(dev, sess) };
    }
    if (key === "interfaces status") {
      return { output: Sim.showInterfacesStatus(dev), prompt: promptFor(dev, sess) };
    }
    if (key === "interfaces trunk") {
      return { output: Sim.showInterfacesTrunk(dev), prompt: promptFor(dev, sess) };
    }
    if (key === "ip eigrp") {
      return { output: "% 未配置 EIGRP（本模拟器支持 RIP / OSPF / 静态路由）", prompt: promptFor(dev, sess) };
    }
    // ---- 三层增强 ----
    if (key === "ip interface") return { output: Sim.showIpInterfaceFull(dev, ctx.devices), prompt: promptFor(dev, sess) };
    if (key === "ip helper") return { output: Sim.showIpHelper(dev), prompt: promptFor(dev, sess) };
    if (key === "ip proxy-arp") return { output: Sim.showProxyArp(dev), prompt: promptFor(dev, sess) };
    if (key === "ip rip") return { output: Sim.showRip(dev), prompt: promptFor(dev, sess) };
    if (key === "ip ospf") return { output: Sim.showOspf(dev), prompt: promptFor(dev, sess) };
    if (key === "ip route static") {
      const st = (dev.staticRoutes || []).map(r =>
        "      " + r.dest + " " + r.mask + " is directly connected, " + r.nextHop +
        (r.dist && r.dist !== 1 ? ", " + r.dist : ""));
      return { output: st.length ? st.join("\n") : "% 无静态路由", prompt: promptFor(dev, sess) };
    }
    // ---- 设备管理与运维 ----
    if (key === "version") return { output: Sim.showVersion(dev), prompt: promptFor(dev, sess) };
    if (key === "device-info" || key === "system-info") {
      return { output: Sim.showDeviceInfo(dev), prompt: promptFor(dev, sess) };
    }
    if (key === "logging") return { output: Sim.showLogging(dev), prompt: promptFor(dev, sess) };
    if (key === "clock") return { output: Sim.showClock(dev), prompt: promptFor(dev, sess) };
    if (key === "aaa") return { output: Sim.showAaa(dev), prompt: promptFor(dev, sess) };
    if (key === "users") return { output: Sim.showUsers(dev), prompt: promptFor(dev, sess) };
    if (key === "monitor") return { output: Sim.showMonitor(dev), prompt: promptFor(dev, sess) };
    if (key === "port-security") return { output: Sim.showPortSecurity(dev, null), prompt: promptFor(dev, sess) };
    // ---- DCN 企业级特性 show ----
    if (key === "dhcp snooping") return { output: Sim.showDhcpSnooping(dev), prompt: promptFor(dev, sess) };
    if (key === "igmp snooping") return { output: Sim.showIgmpSnooping(dev), prompt: promptFor(dev, sess) };
    if (key === "arp inspection") return { output: Sim.showArpInspection(dev), prompt: promptFor(dev, sess) };
    if (key === "port-isolate") return { output: Sim.showPortIsolate(dev), prompt: promptFor(dev, sess) };
    if (key === "qos priority") return { output: Sim.showQosPriority(dev), prompt: promptFor(dev, sess) };
    if (key === "loop-guard") return { output: Sim.showLoopGuard(dev), prompt: promptFor(dev, sess) };
    if (key === "mac-address static") return { output: Sim.showStaticMac(dev), prompt: promptFor(dev, sess) };
    if (key === "mac aging") return { output: Sim.showMacAging(dev), prompt: promptFor(dev, sess) };
    if (key === "lldp") return { output: Sim.showLldp(dev), prompt: promptFor(dev, sess) };
    if (key === "snmp") return { output: Sim.showSnmp(dev), prompt: promptFor(dev, sess) };
    // ---- ACL / VRRP / DHCP 服务器 ----
    if (key === "access-lists" || key === "acl") return { output: Sim.showAcl(dev), prompt: promptFor(dev, sess) };
    if (key === "vrrp") return { output: Sim.showVrrp(dev, ctx.devices, ctx.links), prompt: promptFor(dev, sess) };
    if (key === "ip dhcp pool") return { output: Sim.showDhcpPool(dev), prompt: promptFor(dev, sess) };
    if (key === "ip dhcp binding") return { output: Sim.showDhcpBinding(dev), prompt: promptFor(dev, sess) };
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
    enterMode(sess, "priv");
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
    // ===== DCN 企业级特性：全局配置模式 =====
    // 统一的逐词前缀匹配入口：pt("switchport loop-guard") 支持 swi loop-g / switchport loo-guard
    var _isNo = !!matchPattern([toks[0]], ["no"]);
    var _pt = _isNo ? toks.slice(1) : toks;
    var _no = function () { return _isNo; };
    function pt(s) {
      var pT = s.split(/\s+/);
      if (_pt.length < pT.length) return false;
      return matchPattern(_pt.slice(0, pT.length), pT);
    }
    // ip dhcp snooping [vlan <list> [rate <n>]]
    if (pt("ip dhcp snooping")) {
      if (_no()) { dev.dhcpSnooping.enabled = false; return { output: "", prompt: promptFor(dev, sess) }; }
      dev.dhcpSnooping.enabled = true;
      if (pt("ip dhcp snooping vlan")) {
        var vl = parseVlanList(_pt[4] || "");
        if (!vl) return { output: "% vlan列表格式如 10;20-30", prompt: promptFor(dev, sess) };
        var rate = (_pt[5] && /^r/i.test(_pt[5])) ? _pt[6] : "unlimited";
        vl.forEach(function (v) { dev.dhcpSnooping.perVlan[v] = { rate: rate, bindings: 0 }; });
      }
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip igmp snooping [version <2|3>]
    if (pt("ip igmp snooping")) {
      if (_no()) { dev.igmpSnooping.enabled = false; return { output: "", prompt: promptFor(dev, sess) }; }
      if (pt("ip igmp snooping version") && _pt[4]) {
        dev.igmpSnooping.version = parseInt(_pt[4], 10); dev.igmpSnooping.enabled = true;
      } else dev.igmpSnooping.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip igmp version <N>（无 snooping 词）
    if (pt("ip igmp version") && _pt[3]) {
      dev.igmpSnooping.version = parseInt(_pt[3], 10); dev.igmpSnooping.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip arp inspection [vlan <list>]
    if (pt("ip arp inspection")) {
      if (_no()) { dev.arpInspection.enabled = false; dev.arpInspection.perVlan = {}; return { output: "", prompt: promptFor(dev, sess) }; }
      dev.arpInspection.enabled = true;
      if (pt("ip arp inspection vlan") && _pt[4]) {
        var al = parseVlanList(_pt[4]);
        if (!al) return { output: "% vlan列表格式如 10;20-30", prompt: promptFor(dev, sess) };
        al.forEach(function (v) { dev.arpInspection.perVlan[v] = "enabled"; });
      }
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // switchport loop-guard [enable]
    if (pt("switchport loop-guard") && _pt.length <= 3) {
      dev.loopGuard.enabled = !_no(); return { output: "", prompt: promptFor(dev, sess) };
    }
    // mac-address aging-time <sec>
    if (pt("mac-address aging-time") && _pt[2]) { dev.agingTime = parseInt(_pt[2], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    // mac-address maximum <N>
    if (pt("mac-address maximum") && _pt[2]) { dev.macLimit = parseInt(_pt[2], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    // mac-address static <MAC> interface <port>
    if (pt("mac-address static") && _pt.length >= 3) {
      if (_no()) {
        if (pt("mac-address static interface") && _pt[3]) {
          var rpn = S().normalizePort(_pt[3]); if (rpn) delete dev.staticMac[rpn];
        } else dev.staticMac = {};
        return { output: "", prompt: promptFor(dev, sess) };
      }
      var nm2 = S().normMac(_pt[2]);
      var pn2 = S().normalizePort(_pt[4] || "");
      if (!nm2) return { output: "% MAC格式如 00-11-22-33-44-55", prompt: promptFor(dev, sess) };
      if (!pn2 || !dev.ports[pn2]) return { output: "% 端口不存在", prompt: promptFor(dev, sess) };
      dev.staticMac[pn2] = dev.staticMac[pn2] || [];
      if (dev.staticMac[pn2].indexOf(nm2) < 0) dev.staticMac[pn2].push(nm2);
      dev.macTable[nm2] = { port: pn2, vlan: dev.ports[pn2].accessVlan || 1, age: 0, static: true };
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // lldp [global] enable
    if (pt("lldp") && _pt.length <= 3) { dev.lldp.enabled = !_no(); return { output: "", prompt: promptFor(dev, sess) }; }
    // snmp-server community <str> [ro|rw]
    if (pt("snmp-server community") && _pt[2]) {
      dev.snmp.enabled = !_no(); dev.snmp.community = _no() ? null : _pt[2];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("snmp-server enable")) { dev.snmp.enabled = !_no(); return { output: "", prompt: promptFor(dev, sess) }; }
    // snmp-agent sys-contact / sys-location <str>
    if (pt("snmp-agent sys-contact") && _pt[2]) {
      dev.snmp.enabled = true; dev.snmp.contact = _pt.slice(2).join(" ");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("snmp-agent sys-location") && _pt[2]) {
      dev.snmp.enabled = true; dev.snmp.location = _pt.slice(2).join(" ");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (_isNo && pt("snmp-server")) { dev.snmp.enabled = false; return { output: "", prompt: promptFor(dev, sess) }; }
    // debug mirror（课程 9.端口镜像 中出现）
    if (pt("debug mirror") && _pt.length <= 2) {
      var ids = Object.keys(dev.monitor);
      if (!ids.length) return { output: "% No monitor session（先用 monitor session N source ...）", prompt: promptFor(dev, sess) };
      var dbg = ids.map(function (id) {
        var s = dev.monitor[id];
        return "  Session " + id + ": RX/TX from [" + s.sources.map(function (x) { return x.port; }).join(",") + "] to [" + (s.dest || "none") + "]";
      });
      return { output: "Monitor Debug:\n" + dbg.join("\n") + "\n  （调试输出已开启，抓包报文将复制到目的口）", prompt: promptFor(dev, sess) };
    }
    // ===== 三层增强：全局形式 =====
    // ip proxy-arp（全局开启代理ARP）
    if (pt("ip proxy-arp")) {
      if (!dev.proxyArp) dev.proxyArp = { enabled: false, perIf: {} };
      dev.proxyArp.enabled = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip helper-address（全局形式：登记服务器，接口级配置才生效中继）
    if (pt("ip helper-address")) {
      var gHelper = _pt[2];
      if (!gHelper || S().ipToInt(gHelper) === null) {
        return { output: "% 用法：ip helper-address <DHCP服务器IP>", prompt: promptFor(dev, sess) };
      }
      if (!dev.ipHelper) dev.ipHelper = { enabled: false, servers: [], perIf: {} };
      dev.ipHelper.enabled = true;
      if (dev.ipHelper.servers.indexOf(gHelper) < 0) dev.ipHelper.servers.push(gHelper);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== 设备管理与运维：全局配置 =====
    // logging host <ip> / logging trap <level> / no logging console
    if (pt("logging host")) {
      var logIp = _pt[2];
      if (!logIp || S().ipToInt(logIp) === null) {
        return { output: "% 用法：logging host <日志服务器IP>", prompt: promptFor(dev, sess) };
      }
      dev.logging.enabled = true;
      if (dev.logging.servers.indexOf(logIp) < 0) dev.logging.servers.push(logIp);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("logging trap") || pt("logging buffered")) {
      var lvl = _pt[2] || _pt[3];
      var lvls = ["emergencies", "alerts", "critical", "errors", "warnings", "notifications", "informational", "debugging"];
      if (lvl && lvls.indexOf(String(lvl).toLowerCase()) < 0) {
        return { output: "% 日志级别：" + lvls.join(" / "), prompt: promptFor(dev, sess) };
      }
      if (lvl) dev.logging.consoleLevel = String(lvl).toLowerCase();
      dev.logging.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("logging timestamps")) {
      dev.logging.timestamps = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (_no() && pt("logging")) {
      dev.logging.enabled = false; dev.logging.servers = [];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 时钟：clock timezone <区> / clock set hh:mm:ss
    if (pt("clock timezone")) {
      var tz = parseInt(_pt[2], 10);
      if (isNaN(tz) || tz < -12 || tz > 14) return { output: "% 时区范围 -12 ~ +14", prompt: promptFor(dev, sess) };
      dev.clock.timezone = tz;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("clock set")) {
      return { output: "% 时钟已设置（仿真中按系统时间显示）", prompt: promptFor(dev, sess) };
    }
    // NTP：ntp server <ip> / ntp source
    if (pt("ntp server")) {
      var ntpIp = _pt[2];
      if (!ntpIp || S().ipToInt(ntpIp) === null) {
        return { output: "% 用法：ntp server <NTP服务器IP>", prompt: promptFor(dev, sess) };
      }
      dev.ntp.enabled = true;
      if (dev.ntp.servers.indexOf(ntpIp) < 0) dev.ntp.servers.push(ntpIp);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("ntp source")) {
      dev.ntp.enabled = true; dev.ntp.source = _pt[2] || null;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (_no() && pt("ntp")) {
      dev.ntp.enabled = false; dev.ntp.servers = [];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // AAA：aaa new-model / aaa authentication login local / aaa authorization exec
    if (pt("aaa new-model")) {
      dev.aaa.enabled = true; dev.aaa.protocol = "local";
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("aaa authentication") || pt("aaa authorization") || pt("aaa accounting")) {
      dev.aaa.enabled = true;
      var meth = _pt[3] || _pt[2] || "local";
      dev.aaa.methods = meth;
      if (/^tacacs/i.test(meth)) dev.tacacs.enabled = true;
      if (/^radius/i.test(meth)) dev.radius.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("aaa group server")) {
      // aaa group server tacacs|radius <name>
      var sType = _pt[3], sName = _pt[4];
      if (!sType || !sName) return { output: "% 用法：aaa group server <tacacs|radius> <组名>", prompt: promptFor(dev, sess) };
      if (/^tacacs/i.test(sType)) dev.tacacs.enabled = true;
      else dev.radius.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (_no() && pt("aaa new-model")) {
      dev.aaa.enabled = false;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // TACACS+/RADIUS 服务器
    if (pt("tacacs-server host")) {
      var tacIp = _pt[2];
      if (!tacIp || S().ipToInt(tacIp) === null) {
        return { output: "% 用法：tacacs-server host <IP> [key <密钥>]", prompt: promptFor(dev, sess) };
      }
      dev.tacacs.enabled = true;
      if (dev.tacacs.servers.indexOf(tacIp) < 0) dev.tacacs.servers.push(tacIp);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("radius-server host")) {
      var radIp = _pt[2];
      if (!radIp || S().ipToInt(radIp) === null) {
        return { output: "% 用法：radius-server host <IP> [key <密钥>]", prompt: promptFor(dev, sess) };
      }
      dev.radius.enabled = true;
      if (dev.radius.servers.indexOf(radIp) < 0) dev.radius.servers.push(radIp);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // SNMPv3：snmp-server user <名> <组> auth sha <密钥> priv aes 128 <密钥>
    if (pt("snmp-server user")) {
      dev.snmpv3.enabled = true;
      dev.snmpv3.user = _pt[2] || null;
      dev.snmpv3.group = _pt[3] || null;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("snmp-server group")) {
      dev.snmpv3.enabled = true;
      dev.snmpv3.group = _pt[2] || null;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 横幅：banner motd <文本>（一行版）
    if (pt("banner motd")) {
      dev.banner.motd = _pt.slice(2).join(" ");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("banner login")) {
      dev.banner.login = _pt.slice(2).join(" ");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // config-register
    if (pt("config-register")) {
      dev.configRegister = _pt[2] || "0x102";
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // service password-recovery
    if (pt("service password-recovery")) {
      dev.servicePasswordRecovery = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // service timestamps
    if (pt("service timestamps")) {
      dev.logging.timestamps = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // history size
    if (pt("history size")) {
      var hs = parseInt(_pt[2], 10);
      if (!isNaN(hs) && hs > 0) dev.historySize = hs;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== 思科对标：VTP =====
    if (pt("vtp mode")) {
      var vtMode = _pt[2];
      if (!/^(server|client|transparent|off)$/i.test(vtMode)) {
        return { output: "% VTP 模式：server / client / transparent / off", prompt: promptFor(dev, sess) };
      }
      dev.vtp.enabled = !/^off$/i.test(vtMode);
      dev.vtp.mode = /^off$/i.test(vtMode) ? "server" : vtMode.toLowerCase();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("vtp domain")) {
      dev.vtp.domain = _pt[2] || "";
      dev.vtp.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("vtp version")) {
      var vv = parseInt(_pt[2], 10);
      if (vv !== 1 && vv !== 2 && vv !== 3) return { output: "% VTP 版本支持 1/2/3", prompt: promptFor(dev, sess) };
      dev.vtp.version = vv; dev.vtp.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("vtp pruning")) {
      dev.vtp.pruning = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("vtp password")) {
      dev.vtp.password = _no() ? null : (_pt[2] || "");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // vtp <server|client|transparent>（v2/v3 简写）
    if (/^vtp\s+(server|client|transparent)$/i.test(line)) {
      dev.vtp.mode = line.split(/\s+/)[1].toLowerCase();
      dev.vtp.enabled = true;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== 思科对标：三层增强（全局） =====
    // 思科式聚合负载分担：port-group <n> load-balance <算法>（全局配置）
    if (pt("port-group") && _pt[2] && /^l/i.test(_pt[2])) {
      var lbNum2 = _pt[1], lbAlgo2 = (_pt[3] || "").toLowerCase();
      var lbOk2 = ["src-dst-ip", "src-dst-mac", "src-dst-port", "dst-ip", "dst-mac", "dst-port", "src-ip", "src-mac"];
      if (lbOk2.indexOf(lbAlgo2) < 0) {
        return { output: "% 负载分担算法：" + lbOk2.join(" / "), prompt: promptFor(dev, sess) };
      }
      if (!dev.portGroups[lbNum2]) dev.portGroups[lbNum2] = { mode: "on", ports: [] };
      dev.portGroups[lbNum2].loadBalance = lbAlgo2;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 聚合组最小链路数：port-group <n> min-links <n>（全局配置）
    if (pt("port-group") && _pt[2] && /^m/i.test(_pt[2])) {
      if (!dev.portGroups[_pt[1]]) dev.portGroups[_pt[1]] = { mode: "on", ports: [] };
      dev.portGroups[_pt[1]].minLinks = parseInt(_pt[3], 10);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== 思科对标：生成树全局增强 =====
    if (pt("spanning-tree guard root")) {
      dev.stp.rootGuard = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("spanning-tree portfast default") || pt("spanning-tree portfast")) {
      // 全局默认边缘口
      Object.keys(dev.ports).forEach(function (pn) { dev.ports[pn].portFast = !_no(); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("spanning-tree bpduguard default")) {
      Object.keys(dev.ports).forEach(function (pn) { dev.ports[pn].bpduGuard = !_no(); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (pt("spanning-tree mode")) {
      // 已有逻辑在下面处理，这里只拦下 rpvst+/rapid-pvst
      var stpMode = _pt[2];
      if (/^(rpvst|rapid|rapid-pvst|rstp)$/i.test(stpMode)) {
        dev.stp.mode = "rstp"; dev.stp.enabled = true;
        ctx.refreshStp();
        return { output: "", prompt: promptFor(dev, sess) };
      }
    }
    if (pt("spanning-tree forward-time")) { dev.stp.timers.forward = parseInt(_pt[2], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    if (pt("spanning-tree hello-time")) { dev.stp.timers.hello = parseInt(_pt[2], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    if (pt("spanning-tree max-age")) { dev.stp.timers.maxAge = parseInt(_pt[2], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    // ===== ACL 访问控制列表 =====
    // ip access-list <standard|extended> <编号>  进入 ACL 配置模式
    if (pt("ip access-list")) {
      var aclNum = _pt[3] !== undefined ? _pt[3] : _pt[2];
      var aclType = _pt[2] !== undefined && /^(s\w+|standard)$/i.test(_pt[2]) ? "standard" : "extended";
      if (aclNum === undefined || !/^\d+$/.test(String(aclNum))) {
        return { output: "% 用法：ip access-list <standard|extended> <编号>", prompt: promptFor(dev, sess) };
      }
      if (parseInt(aclNum, 10) < 1 || parseInt(aclNum, 10) > 1999) {
        return { output: "% ACL 编号范围 1-1999（1-99 标准，100-199 扩展，1000-1999 扩展）", prompt: promptFor(dev, sess) };
      }
      dev.acl = dev.acl || { lists: {} };
      dev.acl.lists[String(aclNum)] = dev.acl.lists[String(aclNum)] || { id: String(aclNum), name: "", rules: [] };
      dev.acl.lists[String(aclNum)].type = aclType;
      enterMode(sess, "acl");
      sess.aclId = String(aclNum);
      sess.aclType = aclType;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // no ip access-list <编号>
    if (_no() && pt("ip access-list") && _pt[3] !== undefined) {
      if (dev.acl && dev.acl.lists) delete dev.acl.lists[_pt[3]];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== DHCP 服务器 =====
    // service dhcp
    if (pt("service dhcp")) {
      if (!dev.dhcp) dev.dhcp = { enabled: false, pools: {}, excluded: [], bindings: {} };
      dev.dhcp.enabled = !_no();
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip dhcp pool <名字>
    if (pt("ip dhcp pool")) {
      if (!dev.dhcp) dev.dhcp = { enabled: false, pools: {}, excluded: [], bindings: {} };
      if (_no()) { delete dev.dhcp.pools[_pt[3]]; return { output: "", prompt: promptFor(dev, sess) }; }
      var pname = _pt[3];
      if (!pname) return { output: "% 用法：ip dhcp pool <名字>", prompt: promptFor(dev, sess) };
      dev.dhcp.pools[pname] = dev.dhcp.pools[pname] || { name: pname, lease: 3600 };
      dev.dhcp.enabled = true;
      enterMode(sess, "dhcp-pool");
      sess.dhcpPool = pname;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ip dhcp excluded-address <start> <end>
    if (pt("ip dhcp excluded-address")) {
      if (!dev.dhcp) dev.dhcp = { enabled: false, pools: {}, excluded: [], bindings: {} };
      if (_no()) { dev.dhcp.excluded = []; return { output: "", prompt: promptFor(dev, sess) }; }
      var exs = _pt[3], exe = _pt[4];
      if (!exs) return { output: "% 用法：ip dhcp excluded-address <起始IP> [结束IP]", prompt: promptFor(dev, sess) };
      if (exe) {
        var a = S().ipToInt(exs), b = S().ipToInt(exe);
        if (a === null || b === null) return { output: "% IP 格式错误", prompt: promptFor(dev, sess) };
        for (var q = Math.min(a, b); q <= Math.max(a, b); q++) dev.dhcp.excluded.push(S().intToIp(q));
      } else dev.dhcp.excluded.push(exs);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // vlan XX
    if (matchPattern([toks[0]], ["vlan"]) && toks.length === 2 && /^\d+$/.test(toks[1])) {
      Sim.ensureVlan(dev, toks[1]); enterMode(sess, "vlan"); sess.vlanId = toks[1];
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // interface X（支持 interface e1/0/1-4 / int vlan 20 / int g0/0）
    if (matchPattern([toks[0]], ["interface"]) && toks.length >= 2) {
      var restIf = toks.slice(1).join(" ");
      // interface vlan XX
      var mv = restIf.match(/^vlan\s*(\d+)$/i);
      if (mv) {
        var vid = mv[1]; Sim.ensureVlan(dev, vid);
        enterMode(sess, "if"); sess.ifPorts = ["vlan" + vid];
        return { output: "", prompt: promptFor(dev, sess) };
      }
      // 去空格后解析范围
      var ports = [];
      // 整体交给 expandPortRange 处理（它内部已支持 , 与 ; 分隔及裸数字继承前缀）
      Sim.expandPortRange(restIf).forEach(function (p) {
        if (ports.indexOf(p) < 0) ports.push(p);
      });
      ports = ports.filter(function (p) { return dev.ports[p] || p.indexOf("vlan") === 0; });
      if (!ports.length) return { output: "% 端口不存在（例：e1/0/1, e1/0/1-4, g0/0, s1/0, vlan10）", prompt: promptFor(dev, sess) };
      enterMode(sess, "if"); sess.ifPorts = ports;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // spanning-tree 系列
    if (/^spanning-tree/i.test(line)) {
      var st = line.replace(/^spanning-tree\s*/i, "").trim();
      if (!st) { dev.stp.enabled = true; ctx.refreshStp(); return { output: "MSTP is starting now, please wait...........\nMSTP is enabled successfully.", prompt: promptFor(dev, sess) }; }
      if (uniq(st, ["mode mstp"]) === "mode mstp") { dev.stp.mode = "mstp"; dev.stp.enabled = true; ctx.refreshStp(); return { output: "", prompt: promptFor(dev, sess) }; }
      if (uniq(st, ["mst configuration"]) === "mst configuration") { enterMode(sess, "mstp"); return { output: "", prompt: promptFor(dev, sess) }; }
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
    // 思科扩展：username xxx privilege <0-15> <口令>
    var upm = line.match(/^username\s+(\S+)\s+privilege\s+(\d+)\s+(0|7)\s+(\S+)$/i);
    if (upm) {
      if (upm[1].length > 16) return { output: "% 用户名最长16字符", prompt: promptFor(dev, sess) };
      var priv = parseInt(upm[2], 10);
      if (priv < 0 || priv > 15) return { output: "% 特权级别范围 0~15", prompt: promptFor(dev, sess) };
      dev.users = dev.users.filter(function (u) { return u.name !== upm[1]; });
      dev.users.push({ name: upm[1], enc: upm[3], pass: upm[4], privilege: priv });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    var um = line.match(/^username\s+(\S+)\s+password\s+(0|7)\s+(\S+)$/i);
    if (um) {
      if (um[1].length > 16) return { output: "% 用户名最长16字符", prompt: promptFor(dev, sess) };
      dev.users = dev.users.filter(function (u) { return u.name !== um[1]; });
      dev.users.push({ name: um[1], enc: um[2], pass: um[3], privilege: 1 });
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
        dev.rip.enabled = true; dev.rip.proc = proc || 1; enterMode(sess, "rip"); sess.ripProc = dev.rip.proc;
        return { output: "", prompt: promptFor(dev, sess) };
      } else {
        var op = tail ? parseInt(tail, 10) : 1;
        if (!(op >= 1 && op <= 65535)) return { output: "% OSPF进程号1-65535", prompt: promptFor(dev, sess) };
        dev.ospf.enabled = true; dev.ospf.proc = op; enterMode(sess, "ospf"); sess.ospfProc = op;
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
    // ===== DCN 企业级特性：接口模式 =====
    var _it = tokensOf(line);
    var _ifNo = !!matchPattern([_it[0]], ["no"]);
    var _itp = _ifNo ? _it.slice(1) : _it;
    function ipt(s) {
      var pT = s.split(/\s+/);
      if (_itp.length < pT.length) return false;
      return matchPattern(_itp.slice(0, pT.length), pT);
    }
    // 端口隔离：swi isolate group 1 / swi port-isolate / swi isolate 1
    if (ipt("switchport isolate group") || ipt("switchport port-isolate") || ipt("switchport isolate")) {
      if (_ifNo) {
        eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].isolateGroup = 0; });
        return { output: "", prompt: promptFor(dev, sess) };
      }
      var gArg = null;
      for (var gi = 2; gi < _itp.length; gi++) { if (/^\d+$/.test(_itp[gi])) { gArg = _itp[gi]; break; } }
      var gno = gArg ? parseInt(gArg, 10) : 1;
      eachPort(function (pn) {
        if (!dev.ports[pn]) return;
        dev.ports[pn].isolateGroup = gno;
        if (dev.ports[pn].mode !== "access") dev.ports[pn].mode = "access"; // 隔离口只能是 access
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // QoS 优先级：swi priority 5 / swi cos 5
    if ((ipt("switchport priority") || ipt("switchport cos")) && /^\d/.test(_itp[2] || "")) {
      var pri = parseInt(_itp[2], 10);
      if (pri < 0 || pri > 7) return { output: "% 优先级范围 0~7（802.1p）", prompt: promptFor(dev, sess) };
      if (_ifNo) { eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].qosPrio = 0; }); }
      else eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].qosPrio = pri; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // DHCP 中继（接口下）：ip helper-address <服务器IP>
    if (ipt("ip helper-address")) {
      var helperIp = _itp[2];
      if (!helperIp || S().ipToInt(helperIp) === null) {
        return { output: "% 用法：ip helper-address <DHCP服务器IP>", prompt: promptFor(dev, sess) };
      }
      if (!dev.ipHelper) dev.ipHelper = { enabled: false, servers: [], perIf: {} };
      dev.ipHelper.enabled = true;
      if (dev.ipHelper.servers.indexOf(helperIp) < 0) dev.ipHelper.servers.push(helperIp);
      eachPort(function (pn) {
        if (!dev.ports[pn] && pn.indexOf("vlan") !== 0) return;
        if (!dev.ipHelper.perIf[pn]) dev.ipHelper.perIf[pn] = [];
        if (dev.ipHelper.perIf[pn].indexOf(helperIp) < 0) dev.ipHelper.perIf[pn].push(helperIp);
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (_ifNo && ipt("ip helper-address")) {
      if (dev.ipHelper) { dev.ipHelper.servers = []; dev.ipHelper.perIf = {}; dev.ipHelper.enabled = false; }
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 代理 ARP（接口下）：proxy arp
    if (ipt("proxy arp") || ipt("proxy-arp")) {
      if (!dev.proxyArp) dev.proxyArp = { enabled: false, perIf: {} };
      eachPort(function (pn) {
        if (!dev.ports[pn]) return;
        if (_ifNo) delete dev.proxyArp.perIf[pn];
        else dev.proxyArp.perIf[pn] = true;
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // DHCP 客户端：ip dhcp client
    if (ipt("ip dhcp client")) {
      if (!dev.dhcpClient) dev.dhcpClient = { enabled: false, server: null, leases: {} };
      dev.dhcpClient.enabled = !_ifNo;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // DHCP Snooping 信任口：ip dhcp snooping trust（可缩写 ip dhcp s trust）
    if (ipt("ip dhcp snooping trust")) {
      eachPort(function (pn) {
        if (!dev.ports[pn]) return;
        dev.ports[pn].trust = !_ifNo;
        var i = dev.dhcpSnooping.trustedPorts.indexOf(pn);
        if (!_ifNo && i < 0) dev.dhcpSnooping.trustedPorts.push(pn);
        if (_ifNo && i >= 0) dev.dhcpSnooping.trustedPorts.splice(i, 1);
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 应用 ACL：ip access-group <编号> <in|out>
    if (ipt("ip access-group")) {
      var agId = _itp[2], agDir = _itp[3] || "in";
      if (!dev.acl) dev.acl = { lists: {} };
      if (!dev.acl.applied) dev.acl.applied = {};
      if (!dev.acl.applied.port) dev.acl.applied.port = {};
      eachPort(function (pn) {
        if (!dev.ports[pn]) return;
        if (_ifNo) delete dev.acl.applied.port[pn];
        else dev.acl.applied.port[pn] = String(agId);
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // VRRP：vrrp <vrid> ip <虚IP> / vrrp <vrid> priority <n> / vrrp <vrid> timers ...
    if (ipt("vrrp")) {
      var vrid = _itp[1];
      if (!/^\d+$/.test(String(vrid))) {
        return { output: "% 用法：vrrp <组号> ip <虚拟IP> | vrrp <组号> priority <1-254> | vrrp <组号> timers advertise <秒> hold <秒>", prompt: promptFor(dev, sess) };
      }
      if (!dev.vrrp) dev.vrrp = { groups: {} };
      var vg = dev.vrrp.groups[String(vrid)] = dev.vrrp.groups[String(vrid)] || {
        vrid: parseInt(vrid, 10), ip: null, priority: 100, hold: 3, advert: 1, state: "Init", interface: ""
      };
      // 记录所在接口
      (sess.ifPorts || []).forEach(function (p) { if (!vg.interface) vg.interface = p; });
      var vi2 = 2;
      if (_itp[vi2] && /^i(p)?$/i.test(_itp[vi2])) { vg.ip = _itp[vi2 + 1]; vi2 += 2; }
      else if (_itp[vi2] && /^p(r)?(i)?(o)?(r)?(i)?(t)?(y)?$/i.test(_itp[vi2])) { vg.priority = parseInt(_itp[vi2 + 1], 10); vi2 += 2; }
      else if (_itp[vi2] && /^t/i.test(_itp[vi2])) {
        // vrrp <id> timers advertise <s> hold <s>
        if (_itp[vi2 + 1] && /^a/i.test(_itp[vi2 + 1]) && _itp[vi2 + 2]) { vg.advert = parseInt(_itp[vi2 + 2], 10); vi2 += 3; }
        if (_itp[vi2] && /^h/i.test(_itp[vi2]) && _itp[vi2 + 1]) { vg.hold = parseInt(_itp[vi2 + 1], 10); vi2 += 2; }
      }
      if (_ifNo) { vg.state = "Init"; }
      else vg.state = "Master";
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // ===== 思科对标：接口级增强 =====
    // spanning-tree portfast / bpduguard / bpdufilter / guard root
    if (ipt("spanning-tree portfast")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].portFast = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (ipt("spanning-tree bpduguard") || ipt("spanning-tree guard bpduguard")) {
      eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].bpduGuard = !_ifNo; dev.ports[pn].pduGuard = !_ifNo; } });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (ipt("spanning-tree bpdufilter") || ipt("spanning-tree guard bpdufilter")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].bpduFilter = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (ipt("spanning-tree guard root")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].rootGuard = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 思科式 edge / trunk 候选（DTP）
    if (ipt("spanning-tree edge")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].edgePort = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 端口描述
    var descM = _itp[0] && /^d/i.test(_itp[0]) ? _itp.slice(1).join(" ") : null;
    if (descM !== null && _itp.length >= 1 && /^des/i.test(_itp[0])) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].description = _ifNo ? "" : descM; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 速率与双工：speed 100 / duplex full / negotiation auto
    if (ipt("speed") && /^\d/.test(_itp[1] || "")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].speed = _itp[1]; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (ipt("duplex")) {
      var dx = _itp[1];
      if (!/^(auto|full|half)$/i.test(dx)) return { output: "% 双工：auto / full / half", prompt: promptFor(dev, sess) };
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].duplex = dx.toLowerCase(); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (ipt("negotiation")) {
      var ng = _itp[1] || "auto";
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].negotiation = !/^non/i.test(ng); });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 风暴抑制：storm-control broadcast|multicast|unicast [level <n>]
    if (ipt("storm-control")) {
      var stKind = _itp[1] || "broadcast";
      // 等级可能在 "level 5" 之后，扫描第一个数字 token
      var stLevel = 0;
      for (var sgi = 2; sgi < _itp.length; sgi++) {
        if (/^\d+$/.test(_itp[sgi])) { stLevel = parseInt(_itp[sgi], 10); break; }
      }
      eachPort(function (pn) {
        if (!dev.ports[pn]) return;
        var s = dev.ports[pn].storm;
        if (/^b/i.test(stKind)) s.broadcast = stLevel > 0;
        else if (/^m/i.test(stKind)) s.multicast = stLevel > 0;
        else if (/^u/i.test(stKind)) s.unicast = stLevel > 0;
        s.level = stLevel;
      });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // UDLD
    if (ipt("udld")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].udld = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 802.1X
    if (ipt("dot1x") || ipt("authentication port-control")) {
      eachPort(function (pn) { if (dev.ports[pn]) dev.ports[pn].dot1x = !_ifNo; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 环路保护 / BPDU Guard
    if (ipt("loop-guard") || ipt("bpdu-guard")) {
      var lgOn = !_ifNo && (!_itp[1] || !/^d/i.test(_itp[1]));
      eachPort(function (pn) { if (dev.ports[pn]) { dev.ports[pn].loopGuard = lgOn; dev.ports[pn].BPDUGuard = lgOn; } });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // 端口速率限制：swi speed limit 1000 / switchport rate-limit 1000
    if ((ipt("switchport speed limit") || ipt("switchport rate-limit") || ipt("switchport speed")) && /^\d/.test(_itp[2] || "")) {
      return { output: "% 端口限速已生效：" + _itp[2] + " kbps（仿真不改变转发速率）", prompt: promptFor(dev, sess) };
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
    var iam = line.match(/^ip\s+(add(?:r(?:ess)?)?)\s+(\S+)\s+(\S+)(\s+secondary)?$/i);
    if (iam) {
      if (S().ipToInt(iam[2]) === null || S().ipToInt(iam[3]) === null) return { output: "% IP/掩码错误", prompt: promptFor(dev, sess) };
      var isSecondary = !!iam[4];
      ports.forEach(function (pn) {
        if (pn.indexOf("vlan") === 0) {
          var v = pn.replace("vlan", "");
          dev.vlanIf[v] = dev.vlanIf[v] || {};
          if (isSecondary) {
            dev.vlanIf[v].secondary = dev.vlanIf[v].secondary || [];
            if (dev.vlanIf[v].secondary.every(function (x) { return x.ip !== iam[2]; })) {
              dev.vlanIf[v].secondary.push({ ip: iam[2], mask: iam[3] });
            }
          } else {
            dev.vlanIf[v].ip = iam[2]; dev.vlanIf[v].mask = iam[3];
            if (v === "1") { dev.mgmtIp = iam[2]; dev.mgmtMask = iam[3]; }
          }
        } else if (dev.ports[pn]) {
          dev.ifIp[pn] = dev.ifIp[pn] || {};
          if (isSecondary) {
            dev.ifIp[pn].secondary = dev.ifIp[pn].secondary || [];
            if (dev.ifIp[pn].secondary.every(function (x) { return x.ip !== iam[2]; })) {
              dev.ifIp[pn].secondary.push({ ip: iam[2], mask: iam[3] });
            }
          } else {
            dev.ifIp[pn].ip = iam[2]; dev.ifIp[pn].mask = iam[3];
          }
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
    // 思科式聚合负载分担：port-group <n> load-balance <算法>
  var pglb = line.match(/^port-group\s+(\d+)\s+load-balance\s+(\S+)$/i);
  if (pglb) {
    var lbNum = pglb[1], lbAlgo = pglb[2].toLowerCase();
    var lbOk = ["src-dst-ip", "src-dst-mac", "src-dst-port", "dst-ip", "dst-mac", "dst-port", "src-ip", "src-mac"];
    if (lbOk.indexOf(lbAlgo) < 0) {
      return { output: "% 负载分担算法：" + lbOk.join(" / "), prompt: promptFor(dev, sess) };
    }
    if (!dev.portGroups[lbNum]) dev.portGroups[lbNum] = { mode: "on", ports: [] };
    dev.portGroups[lbNum].loadBalance = lbAlgo;
    return { output: "", prompt: promptFor(dev, sess) };
  }
  // 聚合组最小链路数：port-group <n> min-links <n>
  var pgml = line.match(/^port-group\s+(\d+)\s+min-links\s+(\d+)$/i);
  if (pgml) {
    if (!dev.portGroups[pgml[1]]) dev.portGroups[pgml[1]] = { mode: "on", ports: [] };
    dev.portGroups[pgml[1]].minLinks = parseInt(pgml[2], 10);
    return { output: "", prompt: promptFor(dev, sess) };
  }
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
    // interface 嵌套切换：直接透传 ctx，避免手工列举字段漏掉新能力（如 stream）
    if (/^interface\b/i.test(line)) {
      enterMode(sess, "global");
      var sub = {}, k;
      for (k in ctx) if (Object.prototype.hasOwnProperty.call(ctx, k)) sub[k] = ctx[k];
      sub.dev = dev; sub.sess = sess;
      return execLine(sub, line);
    }
    return { output: "% 未知接口命令（输入 ? 查看；支持缩写如 swi mode acc / no shut / ip add）", prompt: promptFor(dev, sess) };
  }

  // ===== vlan配置模式 =====
  if (sess.mode === "vlan") {
    var nm2 = line.match(/^name\s+(\S+)$/i);
    if (nm2) {
      S().ensureVlan(dev, sess.vlanId).name = nm2[1];
      // VTP server 模式下把 VLAN 发布到 VTP 库
      if (S().vtpPublish) S().vtpPublish(dev, sess.vlanId, nm2[1]);
      return { output: "", prompt: promptFor(dev, sess) };
    }
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
  // ===== ACL 配置模式 =====
  if (sess.mode === "acl") {
    var lst = dev.acl.lists[sess.aclId];
    if (/^exit$/i.test(line)) { enterMode(sess, "global"); return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^no\s+ip\s+access-list\s+(\d+)$/i.test(line)) {
      delete dev.acl.lists[sess.aclId]; enterMode(sess, "global");
      return { output: "", prompt: promptFor(dev, sess) };
    }
    // remark 描述
    var rmk = line.match(/^remark\s+(.+)$/i);
    if (rmk) { lst.name = rmk[1].trim(); return { output: "", prompt: promptFor(dev, sess) }; }
    // 规则： [seq <n>] permit|deny <proto> <src> [srcwild] <dst> [dstwild] [eq port] [log]
    var aclRule = line.match(/^(?:seq\s+(\d+)\s+)?(permit|deny)\s+(.+)$/i);
    if (aclRule) {
      var seq = aclRule[1] ? parseInt(aclRule[1], 10) : ((lst.rules.length ? Math.max.apply(null, lst.rules.map(function (r) { return r.seq || 0; })) : 0) + 10);
      var body = aclRule[3].trim();
      var action = aclRule[2].toLowerCase();
      // 拆出 log
      var hasLog = false;
      if (/\blog\b/i.test(body)) { hasLog = true; body = body.replace(/\blog\b/i, "").trim(); }
      var bT = body.split(/\s+/);
      // 协议
      var proto = "ip";
      if (/^(tcp|udp|ip|icmp|any)$/i.test(bT[0])) {
        proto = bT[0].toLowerCase() === "any" ? "any" : bT[0].toLowerCase();
        bT = bT.slice(1);
      }
      // 源地址（可带通配符）
      var src = "any", dst = "any", srcWild = null, dstWild = null, ports = null, srcPorts = null;
      var vi = 0;
      if (bT[vi]) { src = bT[vi]; vi++; if (bT[vi] && /^\d+\.\d+\.\d+\.\d+$/.test(bT[vi])) { srcWild = bT[vi]; vi++; } }
      if (bT[vi]) { dst = bT[vi]; vi++; if (bT[vi] && /^\d+\.\d+\.\d+\.\d+$/.test(bT[vi])) { dstWild = bT[vi]; vi++; } }
      // eq / gt / lt 端口
      var eqm = body.match(/\b(eq|gt|lt)\s+(\d+)\b/i);
      if (eqm) {
        if (eqm[1].toLowerCase() === "eq") ports = (eqm[2] === "eq" ? eqm[2] : eqm[2]) + " " + eqm[2];
        else if (eqm[1].toLowerCase() === "gt") ports = (+eqm[2] + 1) + " 65535";
        else ports = "0 " + (+eqm[2] - 1);
      }
      var srcm = body.match(/\bsource-port\s+(\d+)\s+(\d+)/i);
      if (srcm) srcPorts = srcm[1] + " " + srcm[2];
      // vlan 限定
      var vlm2 = body.match(/\bvlan\s+(\d+)/i);
      var vlanCond = vlm2 ? parseInt(vlm2[1], 10) : null;
      // 目的地址规范化：带通配符时合成 "net wild"
      function normPair(ip, wild) {
        if (wild) return ip + " " + wild;
        if (ip === "any") return "any";
        // 无通配符视为 /32 主机
        return ip + " 255.255.255.255";
      }
      var rule = {
        seq: seq, action: action, proto: proto,
        src: normPair(src, srcWild), dst: normPair(dst, dstWild),
        ports: ports, srcPorts: srcPorts, vlan: vlanCond, log: hasLog
      };
      // 覆盖同 seq
      lst.rules = lst.rules.filter(function (r) { return r.seq !== seq; });
      lst.rules.push(rule);
      lst.rules.sort(function (a, b) { return a.seq - b.seq; });
      return { output: "", prompt: promptFor(dev, sess) };
    }
    return { output: "% ACL模式：seq <n> permit|deny <proto> <src> <dst> [eq <port>] [log] / remark <描述> / exit", prompt: promptFor(dev, sess) };
  }
  // ===== DHCP pool 配置模式 =====
  if (sess.mode === "dhcp-pool") {
    var pool = dev.dhcp.pools[sess.dhcpPool];
    if (/^exit$/i.test(line)) { enterMode(sess, "global"); return { output: "", prompt: promptFor(dev, sess) }; }
    var pn3 = line.match(/^network\s+(\S+)\s+(\S+)$/i);
    if (pn3) { pool.network = pn3[1]; pool.mask = pn3[2]; return { output: "", prompt: promptFor(dev, sess) }; }
    var dr3 = line.match(/^default-router\s+(\S+)$/i);
    if (dr3) { pool.gateway = dr3[1]; return { output: "", prompt: promptFor(dev, sess) }; }
    var dns3 = line.match(/^dns-server\s+(.+)$/i);
    if (dns3) { pool.dns = dns3[1].trim(); return { output: "", prompt: promptFor(dev, sess) }; }
    var ls3 = line.match(/^lease\s+(\d+)$/i);
    if (ls3) { pool.lease = parseInt(ls3[1], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    var rg3 = line.match(/^range\s+(\S+)\s+(\S+)$/i);
    if (rg3) { pool.start = rg3[1]; pool.end = rg3[2]; return { output: "", prompt: promptFor(dev, sess) }; }
    var vl3 = line.match(/^vlan\s+(\d+)$/i);
    if (vl3) { pool.vlan = parseInt(vl3[1], 10); return { output: "", prompt: promptFor(dev, sess) }; }
    return { output: "% DHCP池模式：network <网段> <掩码> / default-router <网关> / dns-server <IP> / lease <秒> / range <起> <止> / exit", prompt: promptFor(dev, sess) };
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
    if (/^timers\s+(update|invalid|hold|flush)\s+(\d+)$/i.test(line)) {
      var tm = line.match(/^timers\s+(update|invalid|hold|flush)\s+(\d+)$/i);
      dev.rip.timers[tm[1].toLowerCase()] = parseInt(tm[2], 10);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (/^no\s+poison-reverse$/i.test(line)) { dev.rip.poisonReverse = false; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^poison-reverse$/i.test(line)) { dev.rip.poisonReverse = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^no\s+split-horizon$/i.test(line)) { dev.rip.splitHorizon = false; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^split-horizon$/i.test(line)) { dev.rip.splitHorizon = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^default-information\s+originate$/i.test(line)) { dev.rip.defaultOriginate = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^no\s+default-information\s+originate$/i.test(line)) { dev.rip.defaultOriginate = false; return { output: "", prompt: promptFor(dev, sess) }; }
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
    if (/^interface\b/i.test(line)) { enterMode(sess, "global"); return execLine(ctx, line); }
    return { output: "% rip模式：version 2 / auto-summary / network vlan X / passive-interface（?查看）", prompt: promptFor(dev, sess) };
  }
  // ===== ospf =====
  if (sess.mode === "ospf") {
    if (/^auto-cost\s+reference-bandwidth\s+(\d+)$/i.test(line)) {
      var bwM = line.match(/^auto-cost\s+reference-bandwidth\s+(\d+)$/i);
      var bw = parseInt(bwM[1], 10);
      if (isNaN(bw) || bw <= 0) return { output: "% 参考带宽需为正整数（Mbit）", prompt: promptFor(dev, sess) };
      dev.ospf.referenceBandwidth = bw;
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (/^log-adjacency-changes$/i.test(line)) { dev.ospf.logAdjacency = true; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^no\s+log-adjacency-changes$/i.test(line)) { dev.ospf.logAdjacency = false; return { output: "", prompt: promptFor(dev, sess) }; }
    if (/^default-information\s+originate(\s+always)?$/i.test(line)) {
      dev.ospf.defaultOriginate = true;
      dev.ospf.defaultOriginateAlways = /always/i.test(line);
      return { output: "", prompt: promptFor(dev, sess) };
    }
    if (/^no\s+default-information\s+originate$/i.test(line)) { dev.ospf.defaultOriginate = false; return { output: "", prompt: promptFor(dev, sess) }; }
    var arM = line.match(/^area\s+(\S+)$/i);
    if (arM) {
      if ((dev.ospf.areas || []).indexOf(arM[1]) < 0) dev.ospf.areas.push(arM[1]);
      return { output: "", prompt: promptFor(dev, sess) };
    }
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
