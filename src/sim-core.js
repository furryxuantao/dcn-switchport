/* DCN 神州数码仿真核心：转发 / VLAN / MAC / STP / 聚合 / 镜像 / 安全 / 路由 / ping
 * 无 DOM 依赖，可在浏览器 <script> 与 node 下运行。
 * 缩写支持由 cli-engine.js 负责；本文件只做网络语义。
 */
(function (global) {
"use strict";

// ---------- IP 工具 ----------
function ipToInt(ip) {
  var p = String(ip).trim().split(".");
  if (p.length !== 4) return null;
  var n = 0;
  for (var i = 0; i < 4; i++) {
    var v = parseInt(p[i], 10);
    if (isNaN(v) || v < 0 || v > 255) return null;
    n = (n * 256) + v;
  }
  return n >>> 0;
}
function intToIp(n) {
  n = n >>> 0;
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
}
function maskToPrefix(mask) {
  var m = ipToInt(mask);
  if (m === null) return null;
  var bits = 0, seen0 = false;
  for (var i = 31; i >= 0; i--) {
    var b = (m >>> i) & 1;
    if (b === 1) { if (seen0) return null; bits++; }
    else seen0 = true;
  }
  return bits;
}
function prefixToMask(p) {
  var m = p === 0 ? 0 : ((0xFFFFFFFF << (32 - p)) >>> 0);
  return intToIp(m);
}
function networkOf(ip, mask) {
  var a = ipToInt(ip), m = ipToInt(mask);
  if (a === null || m === null) return null;
  return intToIp((a & m) >>> 0);
}
function sameSubnet(ip1, ip2, mask) {
  return networkOf(ip1, mask) === networkOf(ip2, mask);
}
function isValidMask(mask) { return maskToPrefix(mask) !== null; }

var _macCounter = 0;
function genMac(seed) {
  _macCounter++;
  var h = (seed || 0) * 7919 + _macCounter * 104729 + 0x000d28;
  function hx(v) { var s = (v & 255).toString(16); return s.length === 1 ? "0" + s : s; }
  return ("00:0d:28:" + hx(h >> 16) + ":" + hx(h >> 8) + ":" + hx(h)).toUpperCase();
}
function normMac(mac) {
  // 接受 XX-XX-XX-XX-XX-XX / XX:XX.. / XXXX.XXXX.XXXX
  var s = String(mac || "").trim().toLowerCase().replace(/[-:.]/g, "");
  if (/^[0-9a-f]{12}$/.test(s)) {
    return (s.substr(0,2)+":"+s.substr(2,2)+":"+s.substr(4,2)+":"+s.substr(6,2)+":"+s.substr(8,2)+":"+s.substr(10,2)).toUpperCase();
  }
  return null;
}

// ---------- 端口名归一化 ----------
function normalizePort(input) {
  if (!input) return null;
  var s = String(input).trim().toLowerCase().replace(/\s+/g, "");
  // 缩写展开：e->ethernet, f->fastethernet(按e1/0/x处理), g->gigabit, s->serial
  // 形如 e1/0/1, eth1/0/1, ethernet1/0/1, ethernet0/0/1, f0/1, g0/0, s1/0, serial1/0, vlan1
  var m;
  if ((m = s.match(/^(vlan)(\d+)$/))) return "vlan" + m[2];
  if ((m = s.match(/^(e|eth|ethernet|f|fast|fa)(.*)$/))) {
    var rest = m[2].replace(/^(ernet|thernet)?/, "");
    // rest 形如 1/0/1, 0/1, 0/0/1
    rest = rest.replace(/^\/+/, "");
    if (/^\d+\/\d+\/\d+$/.test(rest)) return "e" + rest;
    if (/^\d+\/\d+$/.test(rest)) {
      // f0/1 / e0/1 -> 映射为 e1/0/x ? 课程里 f0/x 与 e1/0/x 混用，按末段端口号映射
      var parts = rest.split("/");
      return "e1/0/" + parts[parts.length - 1];
    }
    if (/^\d+$/.test(rest)) return "e1/0/" + rest;
    return null;
  }
  if ((m = s.match(/^(g|gi|giga|gigabit)(.*)$/))) {
    var r2 = m[2].replace(/^igabit|^iga|^i/, "").replace(/^\/+/, "");
    if (/^\d+\/\d+$/.test(r2)) return "g" + r2;
    if (/^\d+$/.test(r2)) return "g0/" + r2;
    return null;
  }
  if ((m = s.match(/^(s|se|ser|serial)(.*)$/))) {
    var r3 = m[2].replace(/^erial|^er|^e/, "").replace(/^\/+/, "");
    if (/^\d+\/\d+$/.test(r3)) return "s" + r3;
    if (/^\d+$/.test(r3)) return "s1/" + r3;
    return null;
  }
  return null;
}
function expandPortRange(input) {
  // 支持 e1/0/1-4 / e1/0/1-2,4 / e1/0/1,3,5 / 1-4（interface range 上下文由调用方补前缀）
  // 逗号/分号分隔多片段；裸数字自动继承前一片段的前缀
  var s = String(input).trim();
  if (!s) return [];
  var out = [];
  var prefix = "";
  var parts = s.split(/[,;]/);
  for (var pi = 0; pi < parts.length; pi++) {
    var part = parts[pi].trim();
    if (!part) continue;
    // 记住这一段里的端口名前缀（形如 e1/0/）
    var pm = part.match(/^([a-z]+\d+\/\d+\/|[a-z]+\d+\/)/i);
    if (pm) prefix = pm[1];
    var m = part.match(/^(.*?)(\d+)\s*-\s*(\d+)$/);
    if (m) {
      var pre = m[1] || prefix;
      var start = parseInt(m[2], 10), end = parseInt(m[3], 10);
      if (start > end) { var t = start; start = end; end = t; }  // 容错逆序写法
      if (end - start > 512) end = start + 512;                   // 上限保护，防误输入卡死
      for (var i = start; i <= end; i++) {
        var n = normalizePort(pre + i);
        if (n && out.indexOf(n) < 0) out.push(n);
      }
      continue;
    }
    var bare = part.match(/^(\d+)$/);
    var single = bare ? normalizePort(prefix + bare[1]) : normalizePort(part);
    if (single && out.indexOf(single) < 0) out.push(single);
  }
  return out;
}

// ---------- 设备创建 ----------
var DEV_DEFAULTS = {
  l2: { ports: 24, pfx: "e1/0/" },
  l3: { ports: 24, pfx: "e1/0/" },
  router: { ports: null },
  pc: { ports: 1 }
};

function makePorts(type) {
  var ports = {};
  function mk(name) {
    return {
      name: name, shutdown: false, stpBlock: false,
      mode: "access", accessVlan: 1, trunkAllowed: null, // null=all
      portSecurity: { enabled: false, max: 1, staticMacs: [], violation: "shutdown", recovery: 0, violated: false },
      aggGroup: 0, mirrorRole: null,
      trust: false,            // DHCP Snooping 信任端口
      isolateGroup: 0,         // 端口隔离组号，0=不隔离
      qosPrio: 0,              // 802.1p 优先级 0~7
      loopGuard: false,        // 环路保护
      BPDUGuard: false
    };
  }
  if (type === "l2" || type === "l3") {
    for (var i = 1; i <= 24; i++) ports["e1/0/" + i] = mk("e1/0/" + i);
  } else if (type === "router") {
    ports["g0/0"] = mk("g0/0"); ports["g0/1"] = mk("g0/1");
    ports["s1/0"] = mk("s1/0"); ports["s1/1"] = mk("s1/1");
  } else if (type === "pc") {
    ports["eth0"] = mk("eth0");
  }
  return ports;
}

function createDevice(type, name, x, y) {
  var d = {
    id: "d" + Math.random().toString(36).substr(2, 8),
    type: type, // l2|l3|router|pc
    hostname: name || (type === "router" ? "Router" : type === "pc" ? "PC" : "Switch"),
    factoryName: name || (type === "router" ? "Router" : type === "pc" ? "PC" : "Switch"),
    x: x || 0, y: y || 0,
    ports: makePorts(type),
    vlans: { "1": { id: 1, name: "default", members: [] } },
    vlanIf: {}, // vlanId -> {ip, mask}
    mgmtIp: null, mgmtMask: null, // L2 vlan1 管理IP（等价 vlanIf[1]）
    pcIp: null, pcMask: null, pcGw: null, pcMac: genMac(Math.floor(Math.random() * 65535)),
    mac: genMac(Math.floor(Math.random() * 65535)),
    macTable: {}, // MAC -> {port, vlan, age}
    cpuControl: false,
    stp: { enabled: false, mode: "stp", priorities: { "0": 32768 }, instances: {}, regionName: "" },
    portGroups: {}, // num -> {mode, ports:[]}
    monitor: {}, // sessionId -> {sources:[{port,dir}], dest}
    users: [], // {name, pass, enc} enc:0明文 7加密(模拟)
    telnet: { enabled: true, maxConn: 8, securityIp: null },
    ssh: { enabled: true, maxConn: 8 },
    enablePassword: null, enableEnc: 0,
    language: "english",
    ifIp: {}, // router/l3物理口: portName -> {ip, mask, clock:false, dce:false}
    staticRoutes: [], // {dest, mask, nextHop, dist}
    rip: { enabled: false, proc: 1, version: 1, autoSummary: false, enabledIfs: {}, passiveIfs: {}, networks: [] },
    ospf: { enabled: false, proc: 1, routerId: null, networks: [] }, // {net, mask, area}
    configLocked: false,
    startupConfig: null,
    // ---- 二层安全与控制平面（DCN 企业级交换机特性） ----
    dhcpSnooping: { enabled: false, perVlan: {}, trustedPorts: [], bindings: {} },
    //   bindings: mac -> {ip, port, vlan}
    igmpSnooping: { enabled: false, groups: {}, version: 3 }, // groups: vlan -> {groupAddr:{ports:[],version}}
    arpInspection: { enabled: false, perVlan: {} },
    staticMac: {},      // portName -> [mac...]
    macLimit: 0,        // MAC 表条目上限，0=不限
    agingTime: 300,     // MAC 老化时间（秒）
    lldp: { enabled: false },
    snmp: { enabled: false, community: null, contact: null, location: null },
    loopGuard: { enabled: false },
    // ---- ACL（访问控制列表）----
    // 数字范围 1-99 / 100-199 / 1000-1999 预留
    acl: { lists: {} },   // listId -> {id, name, rules:[{seq,action,proto,src,dst,ports,vlan,log}], applied:{}}
    // ---- VRRP（网关冗余）----
    vrrp: { groups: {} },  // vrid -> {vrid, ip, priority, timers, virtualMac, state, master, peers:{}}
    // ---- DHCP 服务器 ----
    dhcp: { enabled: false, pools: {}, excluded: [], bindings: {} },
    //   pools: poolName -> {name, network, mask, gateway, dns, lease, start, end, vlan}
    //   bindings: mac -> {ip, pool, lease, expire}
    // ---- NAT ----
    nat: { enabled: false, inside: [], outside: [], overload: false, translations: {} }
  };
  if (type === "l2" || type === "l3" || type === "router") {
    // 默认所有access口在vlan1
    d.vlans["1"].members = Object.keys(d.ports);
  }
  return d;
}

// ---------- VLAN 操作 ----------
function ensureVlan(dev, id) {
  id = String(id);
  if (!dev.vlans[id]) dev.vlans[id] = { id: parseInt(id, 10), name: "", members: [] };
  return dev.vlans[id];
}
function setAccessVlan(dev, portName, vlanId) {
  vlanId = String(vlanId);
  ensureVlan(dev, vlanId);
  var p = dev.ports[portName];
  if (!p) return false;
  // 从旧vlan移除
  Object.keys(dev.vlans).forEach(function (vid) {
    var arr = dev.vlans[vid].members;
    var ix = arr.indexOf(portName);
    if (String(vid) !== vlanId && ix >= 0) arr.splice(ix, 1);
  });
  p.mode = "access"; p.accessVlan = parseInt(vlanId, 10);
  var mem = dev.vlans[vlanId].members;
  if (mem.indexOf(portName) < 0) mem.push(portName);
  return true;
}
function portVlanList(dev, portName) {
  var p = dev.ports[portName];
  if (!p) return [];
  if (p.mode === "trunk") {
    if (!p.trunkAllowed) return Object.keys(dev.vlans).map(function (x) { return parseInt(x, 10); });
    return p.trunkAllowed.slice();
  }
  return [p.accessVlan || 1];
}
function vlanOfPacketIngress(dev, portName) {
  var p = dev.ports[portName];
  if (!p) return 1;
  if (p.mode === "trunk") return null; // trunk需按包vlan tag，本仿真取对端access vlan
  return p.accessVlan || 1;
}

// ---------- STP 计算（简化但符合PPT语义） ----------
function stpCompute(allDevices, links) {
  // 只考虑启用了 spanning-tree 的交换机之间的 e口互联
  var switches = allDevices.filter(function (d) { return (d.type === "l2" || d.type === "l3") && d.stp.enabled; });
  if (switches.length === 0) return { rootId: null, roles: {} };
  function bid(d, inst) {
    var pri = d.stp.priorities[String(inst || "0")];
    if (pri === undefined) pri = d.stp.priorities["0"];
    if (pri === undefined) pri = 32768;
    return { pri: pri, mac: d.mac, dev: d };
  }
  // 根 = pri最小，相同则MAC最小
  var sorted = switches.slice().sort(function (a, b) {
    var ba = bid(a), bb = bid(b);
    if (ba.pri !== bb.pri) return ba.pri - bb.pri;
    return ba.mac < bb.mac ? -1 : 1;
  });
  var root = sorted[0];
  var roles = {}; // devId:port -> {role:'ROOT'|'DSGN'|'ALTR'(BLK), state:'FWD'|'BLK'}
  // 构建交换机间邻接（仅up且同vlan trunk/access可通的链路）
  function linkUp(l) {
    var da = devById(allDevices, l.a.dev), db = devById(allDevices, l.b.dev);
    if (!da || !db) return false;
    var pa = da.ports[l.a.port], pb = db.ports[l.b.port];
    if (!pa || !pb) return false;
    if (pa.shutdown || pb.shutdown || pa.violated || pb.violated) return false;
    if (pa.stpBlock || pb.stpBlock) return false;
    return true;
  }
  // BFS cost（每跳cost=19，百兆；简化）
  var dist = {}; switches.forEach(function (d) { dist[d.id] = (d.id === root.id ? 0 : Infinity); });
  var changed = true, iter = 0;
  while (changed && iter++ < 20) {
    changed = false;
    links.forEach(function (l) {
      if (!linkUp(l)) return;
      var da = devById(allDevices, l.a.dev), db = devById(allDevices, l.b.dev);
      if (!da || !db) return;
      var aIsSw = switches.indexOf(da) >= 0, bIsSw = switches.indexOf(db) >= 0;
      if (aIsSw && bIsSw) {
        if (dist[da.id] + 19 < dist[db.id]) { dist[db.id] = dist[da.id] + 19; changed = true; }
        if (dist[db.id] + 19 < dist[da.id]) { dist[da.id] = dist[db.id] + 19; changed = true; }
      }
    });
  }
  // 对每台非根，选到达根cost最小的端口为ROOT；每条交换机间链路选一端为DSGN，另一端若不是ROOT则BLK
  // 简化：若两台交换机有多条并行链路（无聚合），只保留第一条FWD，其余BLK（形成环则阻断）
  var interLinks = links.filter(function (l) {
    var da = devById(allDevices, l.a.dev), db = devById(allDevices, l.b.dev);
    return da && db && switches.indexOf(da) >= 0 && switches.indexOf(db) >= 0 && linkUp(l);
  });
  // 按 (dist远端) 排序决定阻塞
  var seenPair = {};
  interLinks.forEach(function (l, idx) {
    var da = devById(allDevices, l.a.dev), db = devById(allDevices, l.b.dev);
    var key = [da.id, db.id].sort().join("|");
    // 若该pair已有一条FWD（且无聚合），其余阻塞
    var inAggA = da.ports[l.a.port].aggGroup, inAggB = db.ports[l.b.port].aggGroup;
    var aggregated = inAggA && inAggA === inAggB && inAggA !== 0;
    // 检查同组聚合在对端一致才算聚合成功（简化：组号相同即聚合）
    if (!aggregated && seenPair[key]) {
      roles[da.id + ":" + l.a.port] = { role: "ALTR", state: "BLK" };
      roles[db.id + ":" + l.b.port] = { role: "ALTR", state: "BLK" };
    } else {
      seenPair[key] = true;
      // 粗略指定角色
      if (da.id === root.id) {
        roles[da.id + ":" + l.a.port] = { role: "DSGN", state: "FWD" };
        roles[db.id + ":" + l.b.port] = { role: "ROOT", state: "FWD" };
      } else if (db.id === root.id) {
        roles[db.id + ":" + l.b.port] = { role: "DSGN", state: "FWD" };
        roles[da.id + ":" + l.a.port] = { role: "ROOT", state: "FWD" };
      } else {
        // 距根近的一端为DSGN
        if (dist[da.id] <= dist[db.id]) {
          roles[da.id + ":" + l.a.port] = { role: "DSGN", state: "FWD" };
          roles[db.id + ":" + l.b.port] = { role: "ROOT", state: "FWD" };
        } else {
          roles[db.id + ":" + l.b.port] = { role: "DSGN", state: "FWD" };
          roles[da.id + ":" + l.a.port] = { role: "ROOT", state: "FWD" };
        }
      }
    }
  });
  // 交换机接PC的端口全部DSGN FWD
  switches.forEach(function (d) {
    Object.keys(d.ports).forEach(function (pn) {
      var k = d.id + ":" + pn;
      if (!roles[k]) roles[k] = { role: "DSGN", state: "FWD" };
    });
  });
  return { rootId: root.id, root: root, dist: dist, roles: roles };
}
function devById(list, id) {
  for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}
function isStpBlocked(dev, port, stpInfo) {
  if (!dev.stp.enabled) return false;
  var r = (stpInfo && stpInfo.roles) ? stpInfo.roles[dev.id + ":" + port] : null;
  return r ? r.state === "BLK" : false;
}

// ---------- 路由表计算 ----------
function connectedNets(dev) {
  var nets = [];
  if (dev.type === "router") {
    Object.keys(dev.ifIp).forEach(function (pn) {
      var c = dev.ifIp[pn];
      if (!c || !c.ip) return;
      var p = dev.ports[pn];
      if (p && p.shutdown) return;
      nets.push({ net: networkOf(c.ip, c.mask), mask: c.mask, port: pn, ip: c.ip });
    });
  }
  if (dev.type === "l3") {
    Object.keys(dev.vlanIf).forEach(function (vid) {
      var c = dev.vlanIf[vid];
      if (!c || !c.ip) return;
      nets.push({ net: networkOf(c.ip, c.mask), mask: c.mask, port: "vlan" + vid, ip: c.ip });
    });
    Object.keys(dev.ifIp).forEach(function (pn) {
      var c2 = dev.ifIp[pn];
      if (!c2 || !c2.ip) return;
      nets.push({ net: networkOf(c2.ip, c2.mask), mask: c2.mask, port: pn, ip: c2.ip });
    });
  }
  if (dev.type === "l2") {
    if (dev.mgmtIp) nets.push({ net: networkOf(dev.mgmtIp, dev.mgmtMask), mask: dev.mgmtMask, port: "vlan1", ip: dev.mgmtIp });
  }
  return nets;
}
function buildRouteTable(dev, allDevices, links) {
  // 返回 [{proto:'C'|'S'|'R'|'O'|'S*', dest, mask, nextHop, port, dist}]
  var table = [];
  connectedNets(dev).forEach(function (n) {
    table.push({ proto: "C", dest: n.net, mask: n.mask, nextHop: "direct", port: n.port, dist: 0 });
  });
  // 静态路由：字段缺失时按空处理，避免非 createDevice 构造的对象导致崩溃
  (dev.staticRoutes || []).forEach(function (r) {
    if (!r || !r.dest || !r.mask) return;
    table.push({ proto: r.dest === "0.0.0.0" ? "S*" : "S", dest: r.dest, mask: r.mask, nextHop: r.nextHop, port: "-", dist: r.dist || 1 });
  });
  // RIP/ OSPF 学习：若全网拓扑物理连通且协议配置正确，则学习到远端直连网段
  // 协议字段防御：非 createDevice 构造的对象可能没有 rip/ospf 字段
  var _rip = dev.rip || { enabled: false, enabledIfs: {}, networks: [] };
  var _ospf = dev.ospf || { enabled: false, networks: [] };
  var ripOn = dev.type === "router" ? (_rip.enabled && Object.keys(_rip.enabledIfs || {}).length > 0) :
    dev.type === "l3" ? (_rip.enabled && (_rip.networks || []).length > 0) : false;
  var ospfOn = !!(_ospf.enabled && (_ospf.networks || []).length > 0);
  if (ripOn || ospfOn) {
    // 简化：学习所有其他设备的直连网段（假设 area 0 / version 2 / auto-summary 正确）
    allDevices.forEach(function (other) {
      if (other.id === dev.id) return;
      // 对端也必须真正跑起协议：路由器至少一个口使能 RIP 或宣告了 OSPF；三层需 network 已配
      var oRip = other.rip || { enabled: false, enabledIfs: {}, networks: [] };
      var oOspf = other.ospf || { enabled: false, networks: [] };
      var otherRip = (other.type === "router")
        ? (oRip.enabled && Object.keys(oRip.enabledIfs || {}).length > 0)
        : (other.type === "l3" ? (oRip.enabled && (oRip.networks || []).length > 0) : false);
      var otherOspf = (other.type === "router" || other.type === "l3")
        ? (oOspf.enabled && (oOspf.networks || []).length > 0) : false;
      var otherOn = otherRip || otherOspf;
      // 三层交换机的vlan网段需要宣告才被学习；简化要求双方都开协议
      if (!otherOn && other.type !== "pc") {
        // 若本端OSPF/RIP开但对端没开，仍可通过静态学到？按实验要求：必须都开才通
        // 这里要求至少本端开且物理连通才学习，但为了体现"没配RIP就不通"，要求对端同协议也开
        return;
      }
      connectedNets(other).forEach(function (n) {
        // 本地已有则跳过
        var exists = table.some(function (t) { return t.dest === n.net && t.mask === n.mask; });
        if (exists) return;
        // 下一跳：沿最短设备路径找第一跳邻居及其共享网段 IP
        var nh = l3NextHop(dev, other, allDevices, links);
        if (!nh) return; // 拥有者不可达则不学
        table.push({ proto: ripOn && !ospfOn ? "R" : "O", dest: n.net, mask: n.mask, nextHop: nh.ip, port: nh.port, dist: ripOn && !ospfOn ? 120 : 110 });
      });
    });
    // PC网段经由L3 vlan口：若L3开了rip且network包含，则R学习（上面已通过connectedNets of L3覆盖）
  }
  // 最长掩码优先排序由查找函数处理
  return table;
}
// 下一跳：从 dev 到网段拥有者 owner 的最短设备路径第一跳，取共享直连网段 IP
function l3NextHop(dev, owner, allDevices, links) {
  if (!owner || owner.id === dev.id) return null;
  function linkUp(l) {
    var da = devById(allDevices, l.a.dev), db = devById(allDevices, l.b.dev);
    if (!da || !db) return false;
    var pa = da.ports[l.a.port], pb = db.ports[l.b.port];
    if (pa && pa.shutdown) return false;
    if (pb && pb.shutdown) return false;
    return true;
  }
  var seen = {}, prev = {}, q = [dev.id];
  seen[dev.id] = true;
  while (q.length) {
    var cur = q.shift();
    if (cur === owner.id) break;
    for (var i = 0; i < links.length; i++) {
      var l = links[i], nxt = null;
      if (l.a.dev === cur) nxt = l.b.dev;
      else if (l.b.dev === cur) nxt = l.a.dev;
      else continue;
      if (seen[nxt] || !linkUp(l)) continue;
      seen[nxt] = true; prev[nxt] = { from: cur, link: l };
      q.push(nxt);
    }
  }
  if (!seen[owner.id]) return null;
  var curId = owner.id, first = null;
  while (curId !== dev.id) {
    first = prev[curId];
    if (!first) return null;
    curId = first.from;
  }
  var lk = first.link;
  var nextDev = devById(allDevices, lk.a.dev === dev.id ? lk.b.dev : lk.a.dev);
  var localPort = lk.a.dev === dev.id ? lk.a.port : lk.b.port;
  if (!nextDev) return null;
  var mine = connectedNets(dev), theirs = connectedNets(nextDev);
  for (var a = 0; a < mine.length; a++)
    for (var b = 0; b < theirs.length; b++)
      if (mine[a].net === theirs[b].net && mine[a].mask === theirs[b].mask)
        return { ip: theirs[b].ip, port: localPort };
  var any = deviceIpList(nextDev)[0];
  return any ? { ip: any, port: localPort } : null;
}
function routeLookup(dev, dstIp, allDevices, links) {
  var table = buildRouteTable(dev, allDevices, links);
  var dst = ipToInt(dstIp);
  if (dst === null) return null;
  var best = null, bestLen = -1;
  table.forEach(function (r) {
    // S* 默认路由 dest 0.0.0.0
    var net = r.dest === "0.0.0.0" ? 0 : ipToInt(r.dest);
    var m = r.dest === "0.0.0.0" ? 0 : ipToInt(r.mask);
    if (((dst & m) >>> 0) === (net >>> 0)) {
      var len = r.dest === "0.0.0.0" ? -1 : maskToPrefix(r.mask);
      // 默认路由优先级最低；静态> RIP/OSPF? 按管理距离+最长匹配：先比掩码长度，再比dist
      if (len > bestLen || (len === bestLen && best && (r.dist || 1) < (best.dist || 1))) {
        best = r; bestLen = len;
      } else if (!best && len === -1) { best = r; }
    }
  });
  // 多条默认路由选dist小
  var defaults = table.filter(function (t) { return t.dest === "0.0.0.0"; });
  if (!best && defaults.length) {
    defaults.sort(function (a, b) { return (a.dist || 1) - (b.dist || 1); });
    best = defaults[0];
  } else if (best && best.dest === "0.0.0.0" && defaults.length > 1) {
    defaults.sort(function (a, b) { return (a.dist || 1) - (b.dist || 1); });
    best = defaults[0];
  }
  return best;
}

// ---------- 二层可达性 ----------
function l2PathExists(sw, fromPort, toPort, vlan, allDevices, links, stpInfo) {
  // 同一交换机内：vlan允许 + 未shutdown + 未BLK 即通
  var p1 = sw.ports[fromPort], p2 = sw.ports[toPort];
  if (!p1 || !p2 || p1.shutdown || p2.shutdown) return false;
  if (isStpBlocked(sw, fromPort, stpInfo) || isStpBlocked(sw, toPort, stpInfo)) return false;
  function allows(p, v) {
    if (p.mode === "access") return (p.accessVlan || 1) === v;
    if (!p.trunkAllowed) return true;
    return p.trunkAllowed.indexOf(v) >= 0;
  }
  return allows(p1, vlan) && allows(p2, vlan);
}

// ---------- ping / tracert 仿真 ----------
function deviceIpList(dev) {
  var out = [];
  if (dev.type === "pc" && dev.pcIp) out.push(dev.pcIp);
  if (dev.type === "router") Object.keys(dev.ifIp).forEach(function (k) { if (dev.ifIp[k].ip) out.push(dev.ifIp[k].ip); });
  if (dev.type === "l3") {
    Object.keys(dev.vlanIf).forEach(function (k) { if (dev.vlanIf[k].ip) out.push(dev.vlanIf[k].ip); });
    Object.keys(dev.ifIp).forEach(function (k) { if (dev.ifIp[k].ip) out.push(dev.ifIp[k].ip); });
  }
  if (dev.type === "l2" && dev.mgmtIp) out.push(dev.mgmtIp);
  return out;
}
function findDeviceByIp(allDevices, ip) {
  for (var i = 0; i < allDevices.length; i++) {
    if (deviceIpList(allDevices[i]).indexOf(ip) >= 0) return allDevices[i];
    // PC也可能用网关测试
  }
  return null;
}
function neighborOnLink(allDevices, links, devId, port) {
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    if (l.a.dev === devId && l.a.port === port) return { dev: devById(allDevices, l.b.dev), port: l.b.port, link: l };
    if (l.b.dev === devId && l.b.port === port) return { dev: devById(allDevices, l.a.dev), port: l.a.port, link: l };
  }
  return null;
}
function linkOperUp(allDevices, link, stpInfo) {
  var da = devById(allDevices, link.a.dev), db = devById(allDevices, link.b.dev);
  if (!da || !db) return false;
  var pa = da.ports[link.a.port], pb = db.ports[link.b.port];
  if (!pa || !pb) return false;
  if (pa.shutdown || pb.shutdown) return false;
  if (isStpBlocked(da, link.a.port, stpInfo) || isStpBlocked(db, link.b.port, stpInfo)) return false;
  // 串口DCE时钟检查：两端s口若有DCE端未配时钟则down（简化：任一s口所在router未配clock则down）
  function isSerial(pn) { return pn.charAt(0) === "s"; }
  if (isSerial(link.a.port) || isSerial(link.b.port)) {
    // 找到DCE端（约定s1/0为DCE需配时钟；实验：R1 s1/0配clock，R2 s1/0配clock）
    var needClock = false;
    [ [da, link.a.port], [db, link.b.port] ].forEach(function (pair) {
      var d = pair[0], pn = pair[1];
      if (d.type === "router" && pn === "s1/0") {
        var cfg = d.ifIp[pn];
        if (!cfg || !cfg.clock) needClock = true;
      }
    });
    if (needClock) {
      // 若任一DCE端缺时钟，链路down
      var ok = false;
      [ [da, link.a.port], [db, link.b.port] ].forEach(function (pair) {
        var d2 = pair[0], pn2 = pair[1];
        if (d2.type === "router" && pn2 === "s1/0" && d2.ifIp[pn2] && d2.ifIp[pn2].clock) ok = true;
      });
      if (!ok) return false;
    }
    // 串口IP必须同网段
    if (da.type === "router" && db.type === "router") {
      var ca = da.ifIp[link.a.port], cb = db.ifIp[link.b.port];
      if (!ca || !cb || !ca.ip || !cb.ip) return false;
      if (networkOf(ca.ip, ca.mask) !== networkOf(cb.ip, cb.mask)) return false;
    }
  }
  return true;
}

// 核心：从srcDev ping dstIp，BFS跨L2/L3，返回 {ok, path:[{dev,via,ip}], reason}
// ================= ACL 访问控制列表 =================
// 规则结构：{seq, action:'permit'|'deny', proto:'ip'|'tcp'|'udp'|'any',
//            src, dst, ports, vlan, log}
// src/dst 形如 "192.168.1.0 0.0.0.255"（网络+反掩码），"any" 表示任意
function aclIpMatch(rule, ip) {
  var v = ipToInt(ip);
  if (v === null) return false;
  var parts = String(rule || "").split(/\s+/);
  var net = parts[0], mask = parts[1] || "0.0.0.0";
  if (!net || net.toLowerCase() === "any") return true;
  if (net.indexOf(":") >= 0) return false;         // IPv6 不在课程范围
  var n = ipToInt(net), m = ipToInt(mask);
  if (n === null || m === null) return false;
  // ACL 用的是「反掩码」(wildcard mask)：0 表示必须匹配，1 表示忽略该位
  // 例：192.168.1.0 0.0.0.255 匹配整个 /24
  var keep = (~m) >>> 0;
  return ((v & keep) >>> 0) === ((n & keep) >>> 0);
}
function aclRuleMatch(rule, pkt) {
  // 协议
  if (rule.proto && rule.proto !== "any") {
    if (rule.proto !== (pkt.proto || "ip")) return false;
  }
  // 源地址
  if (!aclIpMatch(rule.src, pkt.srcIp)) return false;
  // 目的地址
  if (!aclIpMatch(rule.dst, pkt.dstIp)) return false;
  // 端口（仅 TCP/UDP 有意义）
  if (rule.ports) {
    var m = String(rule.ports).match(/^(\S+)\s+(\S+)$/);
    if (m) {
      var lo = m[1], hi = m[2];
      if (lo !== "any" && hi !== "any") {
        var pl = parseInt(lo, 10), ph = parseInt(hi, 10);
        var sp = parseInt(pkt.srcPort, 10), dp = parseInt(pkt.dstPort, 10);
        if (!isNaN(pl) && !isNaN(ph) && !isNaN(sp) && !isNaN(dp)) {
          if (!(sp >= pl && sp <= ph) && !(dp >= pl && dp <= ph)) return false;
        }
      }
    }
  }
  // 源端口限制
  if (rule.srcPorts) {
    var ms = String(rule.srcPorts).match(/^(\d+)\s+(\d+)$/);
    if (ms) {
      var sl = parseInt(ms[1], 10), sh = parseInt(ms[2], 10);
      var sp2 = parseInt(pkt.srcPort, 10);
      if (!isNaN(sl) && !isNaN(sh) && !isNaN(sp2) && !(sp2 >= sl && sp2 <= sh)) return false;
    }
  }
  // VLAN
  if (rule.vlan !== undefined && rule.vlan !== null && rule.vlan !== "any") {
    if (String(rule.vlan) !== String(pkt.vlan)) return false;
  }
  return true;
}
// 对给定报文求 ACL 裁决：返回 'permit' | 'deny' | null(无规则命中)
// 真机语义：自上而下首次匹配即决定；列表末尾隐含 deny（若无 permit any）
function aclDecide(dev, pkt, inPort) {
  var lists = dev.acl && dev.acl.lists;
  if (!lists) return null;
  // 已应用的 ACL：按应用位置（全局/接口/VLAN）依次求值
  var applied = [];
  var a = dev.acl.applied || {};
  if (a.global) applied.push(a.global);
  if (inPort && a.port && a.port[inPort]) applied.push(a.port[inPort]);
  if (pkt.vlan !== undefined && pkt.vlan !== null && a.vlan && a.vlan[String(pkt.vlan)]) applied.push(a.vlan[String(pkt.vlan)]);
  for (var i = 0; i < applied.length; i++) {
    var lst = lists[applied[i]];
    if (!lst) continue;
    var rules = lst.rules.slice().sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); });
    for (var j = 0; j < rules.length; j++) {
      if (aclRuleMatch(rules[j], pkt)) {
        if (rules[j].log) {
          dev.acl.logCount = (dev.acl.logCount || 0) + 1;
          dev.acl.lastHit = { list: applied[i], seq: rules[j].seq, action: rules[j].action, at: Date.now() };
        }
        return rules[j].action;
      }
    }
  }
  return null;   // 无命中：放行（交由上层默认策略决定）
}
function showAcl(dev) {
  var lists = (dev.acl && dev.acl.lists) || {};
  var ids = Object.keys(lists);
  if (!ids.length) return "% 未配置 ACL（配置示例：ip access-list extended 10 / permit ip 192.168.1.0 0.0.0.255 any / deny ip any any）";
  var L = [];
  ids.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); });
  ids.forEach(function (id) {
    var l = lists[id];
    L.push("ACL " + id + (l.name ? " (" + l.name + ")" : ""));
    var rules = l.rules.slice().sort(function (x, y) { return (x.seq || 0) - (y.seq || 0); });
    if (!rules.length) L.push("  （空）");
    rules.forEach(function (r) {
      var line = "  " + String(r.seq || 10).padEnd(4, " ") + (r.action === "permit" ? "permit " : "deny   ");
      line += (r.proto || "ip").padEnd(6, " ");
      line += (r.src || "any").padEnd(24, " ");
      line += (r.dst || "any");
      if (r.ports) line += " " + r.ports;
      if (r.vlan !== undefined && r.vlan !== null) line += " vlan " + r.vlan;
      if (r.log) line += " log";
      L.push(line);
    });
    // 应用位置
    var where = [];
    var a = dev.acl.applied || {};
    if (a.global === id) where.push("global");
    if (a.port) Object.keys(a.port).forEach(function (p) { if (a.port[p] === id) where.push("interface " + p); });
    if (a.vlan) Object.keys(a.vlan).forEach(function (v) { if (a.vlan[v] === id) where.push("vlan " + v); });
    L.push(where.length ? "  Applied: " + where.join(", ") : "  （未应用）");
    L.push("");
  });
  if (dev.acl.logCount) L.push("命中计数: " + dev.acl.logCount + " 条（带 log 的规则）");
  return L.join("\n");
}
function showAclBrief(dev) {
  var lists = (dev.acl && dev.acl.lists) || {};
  var ids = Object.keys(lists);
  if (!ids.length) return "% No ACL configured";
  var L = ["Number of ACLs: " + ids.length];
  ids.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); }).forEach(function (id) {
    L.push("  " + id.padEnd(6, " ") + lists[id].rules.length + " rule(s)");
  });
  return L.join("\n");
}
function portAllows(dev, port, vlan) {
  var p = dev.ports[port];
  if (!p || p.shutdown || p.violated) return false;
  if (vlan === null || vlan === undefined) return true;
  if (p.mode === "trunk") {
    if (!p.trunkAllowed) return true;
    return p.trunkAllowed.indexOf(vlan) >= 0;
  }
  return (p.accessVlan || 1) === vlan;
}
// 包经某端口进入交换机后的 vlan 归属（access 定死，trunk 保持携带，缺省 native 1）
function l2ingress(remoteDev, remotePort, carry) {
  var p = remoteDev.ports[remotePort];
  if (!p) return (carry === undefined ? null : carry);
  if (p.mode === "trunk") return (carry === null || carry === undefined) ? 1 : carry;
  return p.accessVlan || 1;
}
// PC 所接交换机端口的 vlan（trunk 返回 "trunk"；直连路由器口返回 null：无 vlan 约束）
function edgeVlan(dev, allDevices, links) {
  if (!dev || dev.type !== "pc") return null;
  var nb = firstLinkNeighbor(allDevices, links, dev);
  if (!nb || !nb.dev || nb.dev.type === "router" || !nb.dev.ports[nb.port]) return null;
  var p = nb.dev.ports[nb.port];
  return p.mode === "trunk" ? "trunk" : (p.accessVlan || 1);
}
function simulatePing(allDevices, links, srcDev, dstIp, stpInfo) {
  stpInfo = stpInfo || stpCompute(allDevices, links);
  dstIp = String(dstIp).trim();
  if (!srcDev) return { ok: false, reason: "无源设备", path: [] };
  if (ipToInt(dstIp) === null) return { ok: false, reason: "无效IP地址", path: [] };
  // 广播风暴：环路占满带宽，业务流量无法正常收发（真实设备表现）
  if (detectStorm(allDevices, links, stpInfo)) {
    return {
      ok: false, path: [], storm: true,
      reason: "广播风暴：二层环路未开生成树，带宽被广播帧占满，通信无法进行"
    };
  }
  // 目标是本机自己的IP
  if (deviceIpList(srcDev).indexOf(dstIp) >= 0) return { ok: true, path: [{ dev: srcDev.hostname, ip: dstIp, via: "local" }], reason: "本机", latency: measurePing(allDevices, links, srcDev, dstIp, stpInfo) };
  var visited = {}, queue = [];
  // 端口隔离索引：只有配置了隔离口的设备才需要按「入端口」细分 BFS 状态，
  // 否则退化为 devId|vlan 的快路径，保证大拓扑性能不受影响
  var isoDevs = {};
  allDevices.forEach(function (d) {
    var has = Object.keys(d.ports).some(function (pn) { return d.ports[pn].isolateGroup; });
    if (has) isoDevs[d.id] = true;
  });
  // 源身份在整次 BFS 中恒定：起点设备的 MAC 与源 IP（供入向安全检查使用）
  var srcMac = (srcDev.type === "pc" && srcDev.pcMac) ? srcDev.pcMac
    : (srcDev.mac || null);
  var srcIp = (srcDev.type === "pc" && srcDev.pcIp) ? srcDev.pcIp
    : (deviceIpList(srcDev)[0] || null);
  function push(devId, vlan, path, fromPort) {
    var k = devId + "|" + (vlan === null || vlan === undefined ? "-" : vlan);
    if (isoDevs[devId]) k += "|" + (fromPort || "-");
    if (visited[k]) return false;
    visited[k] = true;
    queue.push({ devId: devId, vlan: vlan, path: path, fromPort: fromPort || null,
      srcMac: srcMac, srcIp: srcIp });
    return true;
  }
  // 起点：PC 从所接端口进入 vlan；交换机/路由 CLI 发起为无标签
  if (srcDev.type === "pc") {
    var snb = firstLinkNeighbor(allDevices, links, srcDev);
    if (!snb || !snb.dev) return { ok: false, reason: "本机未连线", path: [] };
    if (!linkOperUp(allDevices, snb.link, stpInfo)) return { ok: false, reason: "本机链路down", path: [] };
    var svlan = l2ingress(snb.dev, snb.port, null);
    push(snb.dev.id, svlan, [{ dev: srcDev.hostname, via: "src" }, { dev: snb.dev.hostname, via: srcDev.hostname + "->" + snb.port }], snb.port);
  } else {
    push(srcDev.id, null, [{ dev: srcDev.hostname, via: "src" }]);
  }
  var hops = 0;
  while (queue.length && hops++ < 80) {
    var cur = queue.shift();
    var dev = devById(allDevices, cur.devId);
    if (!dev) continue;
    // 到达目标IP？（入向已做 vlan/STP 门控；设备自身 IP 直接应答）
    if (deviceIpList(dev).indexOf(dstIp) >= 0) {
      return { ok: true, path: cur.path, reason: "到达", latency: measurePing(allDevices, links, srcDev, dstIp, stpInfo) };
    }
    if (dev.type === "pc") {
      // PC 发包：从所接端口进入其所属 vlan 广播域
      var nb2 = firstLinkNeighbor(allDevices, links, dev);
      if (!nb2 || !nb2.dev || !linkOperUp(allDevices, nb2.link, stpInfo)) continue;
      var v2 = l2ingress(nb2.dev, nb2.port, cur.vlan);
      push(nb2.dev.id, v2, cur.path.concat([{ dev: nb2.dev.hostname, via: dev.hostname + "->" + nb2.port }]), nb2.port);
      continue;
    }
    if (dev.type === "l2") {
      // 二层：只在同一 vlan 内泛洪，且收发端口都要放行该 vlan、未被 STP 阻断
      var vlan = (cur.vlan === null || cur.vlan === undefined) ? 1 : cur.vlan;
      // ---- 入向安全检查：DHCP Snooping（防欺骗）与 DAI（防 ARP 中间人）----
      if (cur.srcIp && cur.fromPort && dev.ports[cur.fromPort]) {
        var guard = ingressGuard(dev, cur.fromPort, cur.srcMac, cur.srcIp, vlan);
        if (guard) return { ok: false, path: [], reason: guard };
      }
      // ---- ACL 入向裁决：命中 deny 则丢弃该报文 ----
      if (cur.srcIp && cur.fromPort) {
        var aclPkt = {
          srcIp: cur.srcIp, dstIp: dstIp, proto: "ip", vlan: vlan,
          srcPort: 0, dstPort: 0, inPort: cur.fromPort
        };
        var aclAct = aclDecide(dev, aclPkt, cur.fromPort);
        if (aclAct === "deny") {
          return {
            ok: false, path: [],
            reason: "ACL 阻断：报文 " + cur.srcIp + " → " + dstIp + " 被 " +
              dev.hostname + " 上的访问控制列表拒绝（deny）"
          };
        }
      }
      var ports = Object.keys(dev.ports);
      for (var i = 0; i < ports.length; i++) {
        var pn = ports[i];
        if (!portAllows(dev, pn, vlan)) continue;
        if (isStpBlocked(dev, pn, stpInfo)) continue;
        // 端口隔离：入端口与出端口同属隔离组 → 丢弃（真机行为）
        if (cur.fromPort && isIsolated(dev, cur.fromPort, pn)) continue;
        var nb = neighborOnLink(allDevices, links, dev.id, pn);
        if (!nb || !nb.dev || !linkOperUp(allDevices, nb.link, stpInfo)) continue;
        if (isStpBlocked(nb.dev, nb.port, stpInfo)) continue;
        var nd = nb.dev;
        if (nd.type === "pc") {
          // 网卡不认 tag：access 口只会发出本 vlan，不会串域；trunk 直连 PC 则放行
          push(nd.id, null, cur.path.concat([{ dev: nd.hostname, via: dev.hostname + ":" + pn }]), nb.port);
        } else if (nd.type === "l2" || nd.type === "l3") {
          if (!portAllows(nd, nb.port, vlan)) continue;
          push(nd.id, l2ingress(nd, nb.port, vlan), cur.path.concat([{ dev: nd.hostname, via: dev.hostname + ":" + pn + "(vlan" + vlan + ")" }]), nb.port);
        } else {
          // 路由器口剥除 tag
          push(nd.id, null, cur.path.concat([{ dev: nd.hostname, via: dev.hostname + ":" + pn }]), nb.port);
        }
      }
      continue;
    }
    // L3 / Router：查路由表决定下一跳
    var rt = routeLookup(dev, dstIp, allDevices, links);
    if (!rt) continue; // 无路由
    var egressPort = rt.port, nextHopIp = rt.nextHop;
    if (rt.proto === "C") {
      if (egressPort && String(egressPort).indexOf("vlan") === 0) {
        // vlan 直连：带着 vid 从放行该 vlan 的口出去
        var vid = parseInt(String(egressPort).replace("vlan", ""), 10);
        var outLinks = links.filter(function (l) { return l.a.dev === dev.id || l.b.dev === dev.id; });
        for (var o = 0; o < outLinks.length; o++) {
          var l = outLinks[o];
          var lp = l.a.dev === dev.id ? l.a.port : l.b.port;
          var rp = l.a.dev === dev.id ? { dev: devById(allDevices, l.b.dev), port: l.b.port } : { dev: devById(allDevices, l.a.dev), port: l.a.port };
          if (!rp.dev || !linkOperUp(allDevices, l, stpInfo)) continue;
          var dp = dev.ports[lp];
          var allows = !dp ? true : (dp.mode === "trunk" ? (!dp.trunkAllowed || dp.trunkAllowed.indexOf(vid) >= 0) : (dp.accessVlan === vid));
          if (!allows) continue;
          if (isStpBlocked(dev, lp, stpInfo)) continue;
          if ((rp.dev.type === "l2" || rp.dev.type === "l3") && (!portAllows(rp.dev, rp.port, vid) || isStpBlocked(rp.dev, rp.port, stpInfo))) continue;
          push(rp.dev.id, l2ingress(rp.dev, rp.port, vid), cur.path.concat([{ dev: rp.dev.hostname, via: dev.hostname + ":" + lp + "(vlan" + vid + ")" }]), rp.port);
        }
      } else {
        // 物理直连口：无标签出去
        var candPorts = egressPort === "-" ? Object.keys(dev.ifIp) : [egressPort];
        for (var c = 0; c < candPorts.length; c++) {
          var nb3 = neighborOnLink(allDevices, links, dev.id, candPorts[c]);
          if (!nb3 || !nb3.dev || !linkOperUp(allDevices, nb3.link, stpInfo)) continue;
          var nv3 = (nb3.dev.type === "l2" || nb3.dev.type === "l3") ? l2ingress(nb3.dev, nb3.port, null) : null;
          push(nb3.dev.id, nv3, cur.path.concat([{ dev: nb3.dev.hostname, via: dev.hostname + ":" + candPorts[c] }]), nb3.port);
        }
      }
    } else {
      // 非直连：下一跳 IP 必须在直连邻居上可达
      var nhDev = findDeviceByIp(allDevices, nextHopIp);
      var found = false;
      var ol = links.filter(function (l) { return l.a.dev === dev.id || l.b.dev === dev.id; });
      for (var q = 0; q < ol.length; q++) {
        var ll = ol[q];
        var other = ll.a.dev === dev.id ? devById(allDevices, ll.b.dev) : devById(allDevices, ll.a.dev);
        if (!other || !linkOperUp(allDevices, ll, stpInfo)) continue;
        var hit = (nhDev && other.id === nhDev.id) || deviceIpList(other).indexOf(nextHopIp) >= 0;
        if (!hit) continue;
        var nv4 = (other.type === "l2" || other.type === "l3") ? l2ingress(other, ll.a.dev === dev.id ? ll.b.port : ll.a.port, null) : null;
        if (push(other.id, nv4, cur.path.concat([{ dev: other.hostname, via: dev.hostname + "->" + nextHopIp }]), ll.a.dev === dev.id ? ll.b.port : ll.a.port)) found = true;
      }
      if (!found) continue; // 下一跳不可达
    }
  }
  // 失败原因推断
  var reason = diagnoseFail(allDevices, links, srcDev, dstIp, stpInfo);
  return { ok: false, path: [], reason: reason };
}
function firstLinkNeighbor(allDevices, links, dev) {
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    if (l.a.dev === dev.id) return { dev: devById(allDevices, l.b.dev), port: l.b.port, link: l, localPort: l.a.port };
    if (l.b.dev === dev.id) return { dev: devById(allDevices, l.a.dev), port: l.a.port, link: l, localPort: l.b.port };
  }
  return null;
}
function diagnoseFail(allDevices, links, srcDev, dstIp, stpInfo) {
  var target = findDeviceByIp(allDevices, dstIp);
  if (!target) {
    // 目标可能是未建模的IP（如外网），检查路由
    if (srcDev.type === "router" || srcDev.type === "l3") {
      var rt = routeLookup(srcDev, dstIp, allDevices, links);
      if (!rt) return "无路由（需配置静态/默认/RIP/OSPF）";
    }
    return "目标不可达（目标IP不存在或无路由）";
  }
  // PC 互 ping 失败且分属不同 vlan：直接点名
  if (target.type === "pc") {
    var sv = edgeVlan(srcDev, allDevices, links), tv = edgeVlan(target, allDevices, links);
    if (sv !== null && tv !== null && sv !== "trunk" && tv !== "trunk" && sv !== tv)
      return "VLAN不一致（源vlan" + sv + "，目标vlan" + tv + "）：需同VLAN同网段";
  }
  // 端口隔离：源与目的所接的交换机端口都开了隔离 → 互相隔离
  var sn = srcDev.type === "pc" ? firstLinkNeighbor(allDevices, links, srcDev) : null;
  var tn = target.type === "pc" ? firstLinkNeighbor(allDevices, links, target) : null;
  var pairs = [];
  if (sn && sn.dev && sn.dev.ports && sn.dev.ports[sn.port]) pairs.push([sn.dev, sn.port]);
  if (tn && tn.dev && tn.dev.ports && tn.dev.ports[tn.port]) pairs.push([tn.dev, tn.port]);
  for (var pi = 0; pi < pairs.length; pi++) {
    for (var pj = pi + 1; pj < pairs.length; pj++) {
      if (pairs[pi][0] === pairs[pj][0] && isIsolated(pairs[pi][0], pairs[pi][1], pairs[pj][1]))
        return "端口隔离阻断：" + pairs[pi][0].hostname + " 的 " + pairs[pi][1] + " 与 " +
          pairs[pj][1] + " 同为隔离口，彼此不能通信（switchport isolate group）";
    }
  }
  // 检查端口shutdown / 安全违例 / STP阻断
  var badPorts = [];
  allDevices.forEach(function (d) {
    Object.keys(d.ports).forEach(function (pn) {
      var p = d.ports[pn];
      if (p.shutdown) badPorts.push(d.hostname + ":" + pn + " shutdown");
      if (p.violated) badPorts.push(d.hostname + ":" + pn + " port-security违例shutdown");
      if (isStpBlocked(d, pn, stpInfo)) badPorts.push(d.hostname + ":" + pn + " STP阻断(BLK)");
    });
  });
  // 路由检查
  if (srcDev.type === "router" || srcDev.type === "l3") {
    var r = routeLookup(srcDev, dstIp, allDevices, links);
    if (!r) return "无路由（检查 ip route / RIP / OSPF 是否配置）";
    if (r.nextHop !== "direct") {
      var nh = findDeviceByIp(allDevices, r.nextHop);
      if (!nh) return "下一跳 " + r.nextHop + " 不可达";
    }
  }
  if (badPorts.length) return "链路/端口问题：" + badPorts.slice(0, 2).join("；");
  return "VLAN/网关/路由配置不匹配（检查VLAN划分、trunk允许列表、网关）";
}
function simulateTracert(allDevices, links, srcDev, dstIp) {
  var stpInfo = stpCompute(allDevices, links);
  var res = simulatePing(allDevices, links, srcDev, dstIp, stpInfo);
  if (!res.ok) return { ok: false, hops: res.path, reason: res.reason };
  return { ok: true, hops: res.path, reason: "" };
}

// ---------- 广播风暴检测 ----------
// 真实设备：二层出现环路且未启用生成树 → 广播风暴占满带宽 → 业务流量无法正常收发
// 检测：交换机间存在两条及以上并行 up 链路（形成环），且相关交换机未开启 spanning-tree
function detectStorm(allDevices, links, stpInfo) {
  stpInfo = stpInfo || stpCompute(allDevices, links);
  var pairs = {};
  for (var i = 0; i < links.length; i++) {
    var l = links[i];
    if (l.serial) continue;
    var a = devById(allDevices, l.a.dev), b = devById(allDevices, l.b.dev);
    if (!a || !b) continue;
    var aSw = a.type === "l2" || a.type === "l3";
    var bSw = b.type === "l2" || b.type === "l3";
    if (!aSw || !bSw) continue;          // 只看交换机之间的以太网互联
    if (!linkOperUp(allDevices, l, stpInfo)) continue;
    var k = [a.id, b.id].sort().join("|");
    pairs[k] = (pairs[k] || 0) + 1;
  }
  var keys = Object.keys(pairs);
  for (var j = 0; j < keys.length; j++) {
    if (pairs[keys[j]] < 2) continue;
    var ids = keys[j].split("|");
    var d1 = devById(allDevices, ids[0]), d2 = devById(allDevices, ids[1]);
    if (!d1 || !d2) continue;
    // 两端都没开生成树 → 风暴
    if (d1.stp.enabled || d2.stp.enabled) continue;
    // 例外：并行链路若已配置链路聚合（同一 port-group），真机不会形成环路
    var aggOk = false;
    for (var m = 0; m < links.length; m++) {
      var al = links[m];
      if (al.serial) continue;
      var pa = null, pb = null;
      if (al.a.dev === d1.id && al.b.dev === d2.id) { pa = al.a.port; pb = al.b.port; }
      else if (al.b.dev === d1.id && al.a.dev === d2.id) { pa = al.b.port; pb = al.a.port; }
      else continue;
      var ga = d1.ports[pa] && d1.ports[pa].aggGroup;
      var gb = d2.ports[pb] && d2.ports[pb].aggGroup;
      if (ga && ga === gb) { aggOk = true; break; }
    }
    if (!aggOk) return true;
  }
  return false;
}

// ---------- 真实链路延迟模型 ----------
// 按设备 MAC 派生一个稳定的"延迟画像"，保证同一对设备每次 ping 结果一致，
// 同时不同链路耗时不同（同网段 < 跨路由器 < 跨三层交换）。
var LAT_PROFILE = { pc: [0, 1], l2: [0, 1], l3: [0, 1], router: [0, 0] };
function latencyProfile(dev) {
  if (!dev || !dev.mac) return { same: 1, hop: 1, jitter: 0 };
  var h = 0;
  for (var i = 0; i < dev.mac.length; i++) h = (h * 31 + dev.mac.charCodeAt(i)) >>> 0;
  var base = (h % 7) / 10;            // 0 ~ 0.6 ms 基准
  var jump = ((h >> 8) % 5) / 10;     // 跨设备额外
  var jit = ((h >> 16) % 4) / 10;     // 同设备抖动
  return { same: Math.max(0, base * 0.4), hop: base + jump, jitter: jit };
}
// 计算一次 ping 的完整时序（Windows 风格：min/avg/max + 丢包）
// ping 输出（贴近 Windows：逐包列出 + 统计行）
function formatPingWin(dstIp, m, okCount, total) {
  var lines = [];
  lines.push("");
  lines.push("正在 Ping " + dstIp + " [" + dstIp + "] 具有 32 字节的数据:");
  lines.push("来自 " + dstIp + " 的回复: 字节=32 时间=" + m.min + "ms TTL=" + (64));
  lines.push("");
  lines.push(dstIp + " 的 Ping 统计信息:");
  lines.push("    数据包: 已发送 = " + total + "，已接收 = " + okCount +
    "，丢失 = " + (total - okCount) + " (" + (total ? Math.round((total - okCount) * 100 / total) : 0) + "%)，");
  if (okCount) {
    lines.push("往返行程的估计时间(以毫秒为单位):");
    lines.push("    最短 = " + m.min + "ms，最长 = " + m.max + "ms，平均 = " + m.avg + "ms");
  }
  return lines.join("\n");
}
// 单个 ping 包的回复行（供终端逐包实时输出）
function formatPingOne(dstIp, t, ttl) {
  return "来自 " + dstIp + " 的回复: 字节=32 时间=" + t + "ms TTL=" + (ttl || 64);
}
function pingStatsBlock(dstIp, m, okCount, total) {
  var lines = [];
  lines.push("");
  lines.push(dstIp + " 的 Ping 统计信息:");
  lines.push("    数据包: 已发送 = " + total + "，已接收 = " + okCount +
    "，丢失 = " + (total - okCount) + " (" + (total ? Math.round((total - okCount) * 100 / total) : 0) + "%)，");
  if (okCount) {
    lines.push("往返行程的估计时间(以毫秒为单位):");
    lines.push("    最短 = " + m.min + "ms，最长 = " + m.max + "ms，平均 = " + m.avg + "ms");
  }
  return lines.join("\n");
}
// 生成 5 个包的逐包时间序列（确定性，可复现）
function pingTimes(m, count, seedIp) {
  var out = [];
  for (var i = 0; i < count; i++) {
    var x = ((ipToInt(seedIp) || 1) + i * 2654435761) >>> 0;
    var r = (x % 1000) / 1000;
    out.push(Math.round((m.min + (m.max - m.min) * r) * 10) / 10);
  }
  return out;
}

// ---------- show 输出生成（DCN格式） ----------
function showVlan(dev) {
  var lines = ["VLAN Name                             Status    Ports", "---- -------------------------------- --------- -------------------------------"];
  Object.keys(dev.vlans).sort(function (a, b) { return +a - +b; }).forEach(function (vid) {
    var v = dev.vlans[vid];
    var ports = v.members.join(", ");
    lines.push((String(vid) + "   " + (v.name || "VLAN" + vid)).padEnd(38, " ") + "active    " + ports);
  });
  return lines.join("\n");
}
function showMacTable(dev) {
  var lines = ["Mac Address Table", "-------------------------------------------", "Vlan    Mac Address       Type        Ports", "----    -----------       ----        -----"];
  Object.keys(dev.macTable).forEach(function (mac) {
    var e = dev.macTable[mac];
    lines.push(String(e.vlan).padEnd(8, " ") + mac.padEnd(18, " ") + "DYNAMIC     " + e.port);
  });
  if (!Object.keys(dev.macTable).length) lines.push("(empty)");
  return lines.join("\n");
}
function showIpInterfaceBrief(allDevices, dev) {
  var lines = ["Interface                  IP-Address      OK? Method Status                Protocol"];
  function row(name, ip, up) {
    var st = up ? "up" : "down";
    lines.push((name).padEnd(27, " ") + (ip || "unassigned").padEnd(16, " ") + "YES manual " + st.padEnd(22, " ") + st);
  }
  if (dev.type === "pc") { row("eth0", dev.pcIp || "unassigned", !!dev.pcIp); return lines.join("\n"); }
  if (dev.type === "router") {
    ["g0/0", "g0/1", "s1/0", "s1/1"].forEach(function (pn) {
      var c = dev.ifIp[pn], p = dev.ports[pn];
      row(pn, c && c.ip, c && c.ip && !(p && p.shutdown));
    });
    return lines.join("\n");
  }
  Object.keys(dev.ports).forEach(function (pn) { row("e" + pn.substr(1), "-", !dev.ports[pn].shutdown); });
  Object.keys(dev.vlanIf).forEach(function (vid) { row("vlan" + vid, dev.vlanIf[vid].ip, true); });
  if (dev.mgmtIp) row("vlan1", dev.mgmtIp, true);
  return lines.join("\n");
}
function showIpRoute(dev, allDevices, links) {
  var t = buildRouteTable(dev, allDevices, links);
  var lines = ["Codes: C - connected, S - static, R - RIP, O - OSPF, S* - default", ""];
  if (!t.length) lines.push("% No routes");
  // 按C/S/R/O排序
  var order = { "C": 0, "S": 1, "S*": 1, "R": 2, "O": 3 };
  t.sort(function (a, b) { return (order[a.proto] - order[b.proto]) || (a.dest < b.dest ? -1 : 1); });
  t.forEach(function (r) {
    lines.push(r.proto + "       " + (r.dest + "/" + maskToPrefix(r.mask)) + " via " + r.nextHop + ", " + r.port);
  });
  return lines.join("\n");
}
function showSpanningTree(dev, stpInfo) {
  var lines = ["-- MSTP Bridge Config Info --", "Standard     :  IEEE 802.1s", "Bridge MAC   :  " + dev.mac.replace(/:/g, "-"),
    "Force Version:  3", "########################### Instance 0 ###########################",
    "Self Bridge Id   : 32768 -  " + dev.mac,
    "Root Id          : " + (stpInfo && stpInfo.root ? ("32768." + stpInfo.root.mac) : "(none)")];
  lines.push("Current port list in Instance 0:");
  Object.keys(dev.ports).slice(0, 4).forEach(function () {});
  lines.push(" PortName      ID      ExtRPC   IntRPC  State Role     DsgBridge     DsgPort");
  lines.push(" -------------- ------- --------- --------- --- ---- ------------------ -------");
  Object.keys(dev.ports).forEach(function (pn) {
    if (pn.indexOf("e") !== 0) return;
    var r = (stpInfo && stpInfo.roles) ? stpInfo.roles[dev.id + ":" + pn] : null;
    var state = r ? r.state : "FWD", role = r ? (r.role === "ROOT" ? "ROOT" : r.role === "DSGN" ? "DSGN" : "ALTR") : "DSGN";
    lines.push(("  Ethernet" + pn.substr(1)).padEnd(16, " ") + "128.001         0         0 " + state + " " + role);
  });
  return lines.join("\n");
}
function showPortGroup(dev) {
  var lines = ["Port-group number : " + (Object.keys(dev.portGroups).join(",") || "1"), "", "the attributes of the port-group are as follows:", ""];
  Object.keys(dev.portGroups).forEach(function (n) {
    var g = dev.portGroups[n];
    lines.push("Number of ports in port-group : " + g.ports.length);
    lines.push("Maxports in port-channel = 8");
  });
  if (!Object.keys(dev.portGroups).length) { lines.push("Number of ports in port-group : 0"); lines.push("Maxports in port-channel = 8"); }
  return lines.join("\n");
}
function showMonitor(dev) {
  var ids = Object.keys(dev.monitor);
  if (!ids.length) return "% No monitor session";
  var out = [];
  ids.forEach(function (id) {
    var s = dev.monitor[id];
    out.push("Session number : " + id);
    out.push("Source ports:   " + s.sources.map(function (x) { return "Ethernet" + x.port.substr(1) + "(" + x.dir + ")"; }).join(", "));
    out.push("Destination port: " + (s.dest ? "Ethernet" + s.dest.substr(1) : "(none)"));
  });
  return out.join("\n");
}
function showPortSecurity(dev, portFilter) {
  var lines = ["Secure Port  MaxSecureAddr  CurrentAddr  Security Action"];
  Object.keys(dev.ports).forEach(function (pn) {
    var p = dev.ports[pn];
    if (portFilter && pn !== portFilter) return;
    if (!p.portSecurity.enabled && !portFilter) return;
    if (portFilter || p.portSecurity.enabled) {
      lines.push(("e" + pn.substr(1)).padEnd(13, " ") + String(p.portSecurity.max).padEnd(15, " ") + String(p.portSecurity.staticMacs.length).padEnd(13, " ") + (p.violated ? "Shutdown(violated)" : "Shutdown"));
    }
  });
  if (lines.length === 1) return "% No port-security enabled";
  return lines.join("\n");
}
// ================= 二层安全与控制平面 =================
function portLabel(pn) { return pn.indexOf("e") === 0 ? "Ethernet" + pn.substr(1) : pn; }

// --- DHCP Snooping ---
function showDhcpSnooping(dev) {
  var L = [];
  L.push("DHCP Snooping : " + (dev.dhcpSnooping.enabled ? "enabled" : "disabled"));
  if (!dev.dhcpSnooping.enabled) return L.join("\n");
  var vks = Object.keys(dev.dhcpSnooping.perVlan);
  L.push("");
  L.push("Vlan     Rate(L/s)   Bindings");
  if (!vks.length) L.push("  （未配置速率限制）");
  vks.forEach(function (v) {
    var c = dev.dhcpSnooping.perVlan[v];
    L.push("  " + String(v).padEnd(8, " ") + String(c.rate || "unlimited").padEnd(12, " ") +
      (c.bindings === undefined ? 0 : c.bindings));
  });
  L.push("");
  L.push("Trusted ports : " + (dev.dhcpSnooping.trustedPorts.length ? dev.dhcpSnooping.trustedPorts.join(", ") : "(none)"));
  var bks = Object.keys(dev.dhcpSnooping.bindings);
  if (bks.length) {
    L.push("");
    L.push("MAC Address          IP Address       Port        VLAN");
    bks.forEach(function (m) {
      var b = dev.dhcpSnooping.bindings[m];
      L.push("  " + m.padEnd(20, " ") + b.ip.padEnd(16, " ") + portLabel(b.port).padEnd(11, " ") + b.vlan);
    });
  }
  return L.join("\n");
}
// DHCP 欺骗检测：非信任端口收到与既有绑定不符的 DHCP 报文
function checkDhcpViolation(dev, port, srcMac, srcIp) {
  if (!dev.dhcpSnooping.enabled) return false;
  if (dev.ports[port] && dev.ports[port].trust) return false;
  var ex = dev.dhcpSnooping.bindings[srcMac];
  if (ex && ex.ip !== srcIp) return true;      // 同一 MAC 伪造不同 IP
  var dup = Object.keys(dev.dhcpSnooping.bindings).some(function (m) {
    return m !== srcMac && dev.dhcpSnooping.bindings[m].ip === srcIp;
  });
  return dup;                                   // 同一 IP 被不同 MAC 占用
}

// --- IGMP Snooping ---
function learnIgmp(dev, vlan, group, port, version) {
  if (!dev.igmpSnooping.enabled) return;
  var V = String(vlan);
  if (!dev.igmpSnooping.groups[V]) dev.igmpSnooping.groups[V] = {};
  var g = dev.igmpSnooping.groups[V][group];
  if (!g) g = dev.igmpSnooping.groups[V][group] = { ports: [], version: version || 3 };
  if (g.ports.indexOf(port) < 0) g.ports.push(port);
}
function showIgmpSnooping(dev) {
  var L = [];
  L.push("IGMP Snooping : " + (dev.igmpSnooping.enabled ? "enabled" : "disabled"));
  L.push("IGMP Version  : " + dev.igmpSnooping.version);
  if (!dev.igmpSnooping.enabled) return L.join("\n");
  var vks = Object.keys(dev.igmpSnooping.groups);
  if (!vks.length) { L.push(""); L.push("% 组播表为空（尚无 IGMP 报文）"); return L.join("\n"); }
  L.push("");
  L.push("VLAN   Group Address        Ports                          Version");
  vks.forEach(function (v) {
    var gk = Object.keys(dev.igmpSnooping.groups[v]);
    if (!gk.length) return;
    gk.forEach(function (g) {
      var it = dev.igmpSnooping.groups[v][g];
      L.push("  " + String(v).padEnd(6, " ") + g.padEnd(22, " ") +
        (it.ports.map(portLabel).join(",") || "(none)").padEnd(31, " ") + "v" + it.version);
    });
  });
  return L.join("\n");
}

// --- 动态 ARP 检测 DAI ---
function showArpInspection(dev) {
  var L = [];
  L.push("Dynamic ARP Inspection : " + (dev.arpInspection.enabled ? "enabled" : "disabled"));
  if (!dev.arpInspection.enabled) return L.join("\n");
  L.push("");
  L.push("VLAN     Status");
  var ks = Object.keys(dev.arpInspection.perVlan);
  if (!ks.length) L.push("  （未配置 VLAN 范围）");
  ks.forEach(function (v) {
    L.push("  " + String(v).padEnd(8, " ") + dev.arpInspection.perVlan[v]);
  });
  return L.join("\n");
}
// ARP 欺骗检测：需 DAI 开启且该 VLAN 已启用，否则放行。
// 双向比对（与真机 DAI 一致）：
//   1) 该 MAC 的绑定 IP 不是本 IP  → 冒用他人身份
//   2) 该 IP 已绑定给别的 MAC      → 伪造他人地址（主要攻击面）
//   3) 双向都没有绑定信息          → 放行（真机同样放行未纳管主机）
function checkArpViolation(dev, vlan, ipMacPairs) {
  if (!dev.arpInspection.enabled) return false;
  var v = String(vlan);
  if (!dev.arpInspection.perVlan[v]) return false;
  var binds = dev.dhcpSnooping.bindings || {};
  return (ipMacPairs || []).some(function (p) {
    if (!p || !p.mac || !p.ip) return false;
    var byMac = binds[p.mac];
    if (byMac && byMac.ip !== p.ip) return true;
    var byIp = null;
    for (var k in binds) { if (binds[k].ip === p.ip) { byIp = k; break; } }
    return !!byIp && byIp !== p.mac;
  });
}

// --- 端口隔离 ---
// DCN 真机语义：凡是开启了端口隔离的接入口，彼此之间不能通信（可与未隔离的上联口通信）
function isIsolated(dev, p1, p2) {
  if (!p1 || p1 === p2) return false;
  var a = dev.ports[p1], b = dev.ports[p2];
  if (!a || !b) return false;
  if (a.shutdown || b.shutdown) return false;
  return !!(a.isolateGroup && b.isolateGroup);
}
function showPortIsolate(dev) {
  var groups = {};
  Object.keys(dev.ports).forEach(function (pn) {
    var g = dev.ports[pn].isolateGroup;
    if (g) { if (!groups[g]) groups[g] = []; groups[g].push(pn); }
  });
  var ks = Object.keys(groups);
  if (!ks.length) return "% 端口隔离未配置（switchport isolate group N 开启）";
  var L = ["Port Isolation Groups:", ""];
  ks.forEach(function (g) {
    L.push("  Group " + g + " : " + groups[g].map(portLabel).join(", "));
    L.push("      同组端口之间相互隔离，不能通信");
  });
  return L.join("\n");
}

// --- QoS 优先级 ---
function showQosPriority(dev) {
  var ks = Object.keys(dev.ports).filter(function (p) { return dev.ports[p].qosPrio; });
  if (!ks.length) return "% 未配置端口优先级（switchport priority N）";
  var L = ["Port                Priority  Description"];
  ks.forEach(function (pn) {
    var p = dev.ports[pn].qosPrio;
    var desc = p >= 6 ? "网络控制" : p >= 4 ? "视频" : p >= 2 ? "语音" : p >= 1 ? "关键数据" : "普通数据";
    L.push("  " + portLabel(pn).padEnd(19, " ") + String(p).padEnd(10, " ") + desc);
  });
  return L.join("\n");
}

// --- 环路保护 Loop Guard ---
function showLoopGuard(dev) {
  var ks = Object.keys(dev.ports).filter(function (p) { return dev.ports[p].loopGuard; });
  if (!dev.loopGuard.enabled) return "% Loop Guard : disabled（全局 switchport loop-guard enable）";
  if (!ks.length) return "Loop Guard : enabled\n% 尚未指定受保护端口（接口下 loop-guard enable）";
  return "Loop Guard : enabled\n受保护端口 : " + ks.map(portLabel).join(", ") +
    "\n  接入口收到 BPDU 将被自动 shutdown，防止误接形成环路";
}

// --- 静态 MAC / 表项上限 / 老化时间 ---
function showStaticMac(dev) {
  var ks = Object.keys(dev.staticMac).filter(function (p) { return dev.staticMac[p].length; });
  if (!ks.length) return "% 无静态 MAC 绑定（mac-address static X 接口 Y）";
  var L = ["Port                 MAC Address"];
  ks.forEach(function (pn) {
    dev.staticMac[pn].forEach(function (m) {
      L.push("  " + portLabel(pn).padEnd(20, " ") + m);
    });
  });
  return L.join("\n");
}
function showMacAging(dev) {
  var L = [];
  L.push("MAC Aging Time : " + dev.agingTime + " 秒");
  L.push("MAC Table Limit: " + (dev.macLimit ? dev.macLimit + " 条" : "unlimited"));
  L.push("Learned entries: " + Object.keys(dev.macTable).length + " 条");
  return L.join("\n");
}
// --- LLDP / SNMP ---
function showLldp(dev) {
  if (!dev.lldp.enabled) return "% LLDP : disabled";
  var L = ["LLDP : enabled", "", "Chassis ID        Local Port        Neighbor"];
  var n = 0;
  Object.keys(dev.ports).forEach(function (pn) { if (dev.ports[pn].shutdown) return; n++; });
  L.push("  （已启用，本机 " + n + " 个端口参与 LLDP 通告）");
  return L.join("\n");
}
function showSnmp(dev) {
  if (!dev.snmp.enabled) return "% SNMP Agent : disabled";
  var L = ["SNMP Agent : enabled", "Community : " + (dev.snmp.community || "(未设置)")];
  if (dev.snmp.contact) L.push("Contact    : " + dev.snmp.contact);
  if (dev.snmp.location) L.push("Location   : " + dev.snmp.location);
  return L.join("\n");
}

// 二层入向安全守卫：DHCP Snooping 防欺骗 + DAI 防 ARP 中间人
// 返回 null 表示放行，否则返回阻断原因（真机行为）
function ingressGuard(dev, port, srcMac, srcIp, vlan) {
  if (!dev.dhcpSnooping.enabled && !dev.arpInspection.enabled) return null;
  var p = dev.ports[port];
  if (!p || p.shutdown) return null;
  // 首次见到 (mac,ip,port) 组合时写入 DHCP 绑定表，等价于从信任口拿到 lease
  var binds = dev.dhcpSnooping.bindings;
  var known = srcMac ? binds[srcMac] : null;
  if (dev.dhcpSnooping.enabled && srcMac && srcIp) {
    if (!known) binds[srcMac] = { ip: srcIp, port: port, vlan: vlan };
    else if (known.ip !== srcIp) {
      // 同一 MAC 换 IP / 同 IP 换 MAC —— 未信任口上的典型 DHCP 欺骗
      if (!p.trust) return "DHCP Snooping 阻断：" + portLabel(port) + " 上 " +
        srcMac + " 声称拥有 " + srcIp + "，但绑定表记录的是 " + known.ip + "（伪造 DHCP 响应）";
    }
  }
  // DAI：需 DHCP 绑定信息可比对，否则不判违例（真机同样放行未知主机）
  if (dev.arpInspection.enabled && dev.arpInspection.perVlan[String(vlan)]) {
    var pairs = srcMac && srcIp ? [{ mac: srcMac, ip: srcIp }] : [];
    if (checkArpViolation(dev, vlan, pairs)) {
      var b = binds[srcMac];
      return "ARP 检测(DAI)阻断：" + portLabel(port) + " 上 " + srcMac +
        " 声称 " + srcIp + " 为本机，但绑定表记录 " + (b ? b.ip : "未知") + "（ARP 中间人攻击）";
    }
  }
  return null;
}
// ================= VRRP 虚拟路由冗余 =================
// 选举：同 vrid 同虚 IP 的设备按 priority 大者为主；同优先级比 IP 大者为主
// 真机规则：priority 大者为 Master；相同则比较接口 IP，IP 大者为 Master
function vrrpElect(allDevices, links, vrid) {
  var cands = [];
  allDevices.forEach(function (d) {
    var g = d.vrrp && d.vrrp.groups && d.vrrp.groups[String(vrid)];
    if (!g) return;
    cands.push({ dev: d, g: g });
  });
  if (!cands.length) return null;
  // 候选者必须两两可达（同一 vlan 内二层连通）
  var reach = [];
  cands.forEach(function (c) {
    var ok = cands.every(function (o) {
      if (o === c) return true;
      return vrrpPeersReach(allDevices, links, c.dev, o.dev, c.g.ip);
    });
    if (ok) reach.push(c);
  });
  if (!reach.length) reach = cands;
  reach.sort(function (a, b) {
    var pa = a.g.priority || 100, pb = b.g.priority || 100;
    if (pa !== pb) return pb - pa;                         // priority 大者为主
    var ia = vrrpOwnIp(a), ib = vrrpOwnIp(b);
    if (ia !== ib) return ipToInt(ib) - ipToInt(ia);      // 同优先级 IP 大者为主
    return (a.dev.mac || "").localeCompare(b.dev.mac || "");
  });
  return reach[0];
}
function vrrpOwnIp(c) {
  var g = c.g;
  if (g.interface && c.dev.ifIp && c.dev.ifIp[g.interface]) return c.dev.ifIp[g.interface].ip;
  if (g.interface && c.dev.vlanIf && c.dev.vlanIf[String(g.interface).replace("vlan", "")]) {
    return c.dev.vlanIf[String(g.interface).replace("vlan", "")].ip;
  }
  return c.dev.mgmtIp || "";
}
// 两台设备是否二层可达（用于判断 VRRP 候选者是否互相看得见）
// 判据：双方接口 IP 处于同一子网（真机还需链路 up，此处按同网段近似）
function vrrpPeersReach(allDevices, links, a, b, vip) {
  var ga = (a.vrrp.groups && Object.values(a.vrrp.groups)[0]) || {};
  var gb = (b.vrrp.groups && Object.values(b.vrrp.groups)[0]) || {};
  var sa = vrrpOwnIp({ dev: a, g: ga }), sb = vrrpOwnIp({ dev: b, g: gb });
  if (!sa || !sb) return false;
  var ma = vrrpMaskOf(a, ga), mb = vrrpMaskOf(b, gb);
  if (ma && mb && ma === mb) return sameSubnet(sa, sb, ma);
  return sameSubnet(sa, sb, "255.255.255.0");
}
function vrrpMaskOf(dev, g) {
  if (g.interface && dev.ifIp && dev.ifIp[g.interface]) return dev.ifIp[g.interface].mask;
  if (g.interface && dev.vlanIf && dev.vlanIf[String(g.interface).replace("vlan", "")]) {
    return dev.vlanIf[String(g.interface).replace("vlan", "")].mask;
  }
  return dev.mgmtMask || null;
}
// 取某设备在某 vrid 上的虚 IP（若为主机则该虚 IP 就是网关）
function vrrpVirtualIp(allDevices, links, vrid) {
  var cands = [];
  allDevices.forEach(function (d) {
    var g = d.vrrp && d.vrrp.groups && d.vrrp.groups[String(vrid)];
    if (g) cands.push({ dev: d, g: g });
  });
  if (!cands.length) return null;
  var master = vrrpElect(allDevices, links, vrid);
  if (!master) return null;
  return { ip: master.g.ip, master: master.dev, vrid: vrid };
}
function showVrrp(dev, allDevices, links) {
  var groups = (dev.vrrp && dev.vrrp.groups) || {};
  var ids = Object.keys(groups);
  if (!ids.length) return "% 未配置 VRRP（配置示例：interface vlan 10 / vrrp 1 ip 192.168.1.254 / vrrp 1 priority 120）";
  var L = [];
  ids.sort(function (a, b) { return parseInt(a, 10) - parseInt(b, 10); }).forEach(function (id) {
    var g = groups[id];
    L.push("VRRP Group " + id);
    L.push("  State        : " + (g.state || "Init"));
    L.push("  Virtual IP   : " + g.ip);
    L.push("  Priority     : " + (g.priority || 100));
    L.push("  Hold Time    : " + (g.hold || 3) + " 秒");
    L.push("  Advert Int   : " + (g.advert || 1) + " 秒");
    L.push("  Virtual MAC  : " + (g.virtualMac || "00:00:5e:00:01:" + (parseInt(id, 10) < 10 ? "0" : "") + id));
    L.push("  Master IP    : " + (g.masterIp || "(未选举)"));
    L.push("  Interface    : " + (g.interface || "(全局)"));
    L.push("");
  });
  if (allDevices && links) {
    var master = vrrpElect(allDevices, links, ids[0]);
    if (master) L.push("当前 Master: " + master.dev.hostname + "（虚 IP " + master.g.ip + "）");
  }
  return L.join("\n");
}
// ================= DHCP 服务器 =================
// 地址池分配：跳过 excluded 与已占用地址
function dhcpAllocate(dev, mac, poolName) {
  if (!dev.dhcp || !dev.dhcp.enabled) return null;
  var pools = dev.dhcp.pools;
  var pool = poolName ? pools[poolName] : pools[Object.keys(pools)[0]];
  if (!pool) return null;
  var excluded = (dev.dhcp.excluded || []).map(function (e) { return ipToInt(e); });
  var used = {};
  Object.keys(dev.dhcp.bindings).forEach(function (m) { used[ipToInt(dev.dhcp.bindings[m].ip)] = m; });
  var net = ipToInt(pool.network), mask = ipToInt(pool.mask);
  if (net === null || mask === null) return null;
  var start = ipToInt(pool.start || pool.network), end = ipToInt(pool.end || pool.network);
  if (start > end) { var t = start; start = end; end = t; }
  for (var v = start; v <= end; v++) {
    if (excluded.indexOf(v) >= 0) continue;
    if (used[v]) continue;
    var ip = intToIp(v);
    var rec = { ip: ip, pool: pool.name, lease: pool.lease || 3600, expire: Date.now() + (pool.lease || 3600) * 1000 };
    dev.dhcp.bindings[mac] = rec;
    return rec;
  }
  return null;
}
function showDhcpPool(dev) {
  if (!dev.dhcp || !dev.dhcp.enabled) return "% DHCP Server : disabled";
  var pools = dev.dhcp.pools;
  var ids = Object.keys(pools);
  var L = ["DHCP Server : enabled", ""];
  L.push("Pool name    Network            Gateway           DNS                 Range");
  if (!ids.length) L.push("  （未配置地址池）");
  ids.forEach(function (n) {
    var p = pools[n];
    L.push("  " + String(n).padEnd(12, " ") + String(p.network + " " + p.mask).padEnd(19, " ") +
      String(p.gateway || "-").padEnd(18, " ") + String(p.dns || "-").padEnd(20, " ") +
      String(p.start || p.network) + " - " + String(p.end || p.network));
    L.push("      租约 " + (p.lease || 3600) + " 秒" + (p.vlan ? "  vlan " + p.vlan : ""));
  });
  if ((dev.dhcp.excluded || []).length) {
    L.push("");
    L.push("Excluded addresses : " + dev.dhcp.excluded.join(", "));
  }
  return L.join("\n");
}
function showDhcpBinding(dev) {
  var binds = (dev.dhcp && dev.dhcp.bindings) || {};
  var ks = Object.keys(binds);
  if (!ks.length) return "% 无 DHCP 绑定（客户端申请地址后出现）";
  var L = ["IP Address       MAC Address        Lease  Pool"];
  ks.forEach(function (m) {
    var b = binds[m];
    var left = Math.max(0, Math.round((b.expire - Date.now()) / 1000));
    L.push("  " + String(b.ip).padEnd(16, " ") + m.padEnd(19, " ") + String(left + "s").padEnd(7, " ") + b.pool);
  });
  return L.join("\n");
}
function showRunningConfig(dev) {
  var lines = ["Current configuration:", "!", "hostname " + dev.hostname];
  if (dev.enablePassword) lines.push("enable password level 15 " + dev.enablePassword);
  dev.users.forEach(function (u) { lines.push("username " + u.name + " privilege 15 password " + u.enc + " " + u.pass); });
  Object.keys(dev.vlans).sort(function (a, b) { return +a - +b; }).forEach(function (vid) {
    if (vid === "1" && !dev.vlans[vid].name) return;
    lines.push("vlan " + vid);
    if (dev.vlans[vid].name) lines.push(" name " + dev.vlans[vid].name);
  });
  if (dev.type === "router" || dev.type === "l3") {
    Object.keys(dev.ifIp).forEach(function (pn) {
      var c = dev.ifIp[pn];
      if (c && c.ip) { lines.push("interface " + pn); lines.push(" ip address " + c.ip + " " + c.mask); if (c.clock) lines.push(" physical-layer speed 64000"); }
    });
    Object.keys(dev.vlanIf).forEach(function (vid) {
      var c2 = dev.vlanIf[vid];
      lines.push("interface vlan" + vid); lines.push(" ip address " + c2.ip + " " + c2.mask);
    });
    (dev.staticRoutes || []).forEach(function (r) {
    if (!r || !r.dest) return;
    lines.push("ip route " + r.dest + " " + r.mask + " " + r.nextHop + (r.dist && r.dist !== 1 ? " " + r.dist : ""));
  });
    if (dev.rip.enabled) {
      lines.push("router rip " + (dev.rip.proc || 1)); lines.push(" version " + dev.rip.version);
      if (dev.rip.autoSummary) lines.push(" auto-summary");
      dev.rip.networks.forEach(function (n) { lines.push(" network vlan " + n); });
      Object.keys(dev.rip.enabledIfs).forEach(function (pn) { lines.push(" interface " + pn); lines.push("  ip rip " + (dev.rip.proc || 1) + " enable"); });
    }
    if (dev.ospf.enabled) {
      lines.push("router ospf " + dev.ospf.proc);
      if (dev.ospf.routerId) lines.push(" router-id " + dev.ospf.routerId);
      dev.ospf.networks.forEach(function (n) { lines.push(" network " + n.net + " " + n.mask + " area " + n.area); });
    }
  }
  if (dev.mgmtIp) { lines.push("interface vlan1"); lines.push(" ip address " + dev.mgmtIp + " " + dev.mgmtMask); }
  if (dev.stp.enabled) {
    lines.push("spanning-tree"); lines.push("spanning-tree mode " + dev.stp.mode);
    Object.keys(dev.stp.instances).forEach(function (k) { lines.push("spanning-tree mst configuration"); });
  }
  // ---- 二层安全与控制平面 ----
  if (dev.dhcpSnooping.enabled) {
    lines.push("ip dhcp snooping");
    dev.dhcpSnooping.trustedPorts.forEach(function (p) {
      lines.push("interface " + p); lines.push(" ip dhcp snooping trust"); lines.push("exit");
    });
    Object.keys(dev.dhcpSnooping.perVlan).forEach(function (v) {
      var c = dev.dhcpSnooping.perVlan[v];
      lines.push("vlan " + v);
      lines.push(" ip dhcp snooping rate " + (c.rate || "unlimited"));
      lines.push("exit");
    });
  }
  if (dev.igmpSnooping.enabled) { lines.push("ip igmp snooping"); lines.push("ip igmp version " + dev.igmpSnooping.version); }
  if (dev.arpInspection.enabled) {
    lines.push("ip arp inspection");
    Object.keys(dev.arpInspection.perVlan).forEach(function (v) { lines.push(" ip arp inspection vlan " + v); });
  }
  if (dev.loopGuard.enabled) lines.push("switchport loop-guard enable");
  if (dev.lldp.enabled) lines.push("lldp enable");
  if (dev.snmp.enabled) {
    lines.push("snmp-server enable");
    if (dev.snmp.community) lines.push("snmp-server community " + dev.snmp.community + " ro");
    if (dev.snmp.contact) lines.push("snmp-agent sys-contact " + dev.snmp.contact);
    if (dev.snmp.location) lines.push("snmp-agent sys-location " + dev.snmp.location);
  }
  if (dev.agingTime !== 300) lines.push("mac-address aging-time " + dev.agingTime);
  if (dev.macLimit) lines.push("mac-address maximum " + dev.macLimit);
  // 静态 MAC 与端口级配置
  Object.keys(dev.staticMac).forEach(function (pn) {
    dev.staticMac[pn].forEach(function (m) {
      lines.push("mac-address static " + m + " interface " + pn);
    });
  });
  Object.keys(dev.ports).forEach(function (pn) {
    var p = dev.ports[pn];
    var extra = [];
    if (p.isolateGroup) extra.push("switchport isolate group " + p.isolateGroup);
    if (p.qosPrio) extra.push("switchport priority " + p.qosPrio);
    if (p.loopGuard) extra.push("loop-guard enable");
    if (dev.acl && dev.acl.applied && dev.acl.applied.port && dev.acl.applied.port[pn]) {
      extra.push("ip access-group " + dev.acl.applied.port[pn] + " in");
    }
    if (!extra.length) return;
    lines.push("interface " + pn);
    extra.forEach(function (e) { lines.push(" " + e); });
    lines.push("exit");
  });
  lines.push("!");
  // ---- ACL ----
  if (dev.acl && dev.acl.lists) {
    Object.keys(dev.acl.lists).forEach(function (id) {
      var l = dev.acl.lists[id];
      lines.push("ip access-list " + (l.type || "extended") + " " + id);
      if (l.name) lines.push(" remark " + l.name);
      l.rules.forEach(function (r) {
        var t = " " + r.seq + " " + r.action + " " + (r.proto || "ip") + " " + r.src + " " + r.dst;
        if (r.ports) t += " " + r.ports;
        if (r.srcPorts) t += " source-port " + r.srcPorts;
        if (r.vlan !== undefined && r.vlan !== null) t += " vlan " + r.vlan;
        if (r.log) t += " log";
        lines.push(t);
      });
      lines.push("exit");
    });
  }
  // ---- VRRP ----
  if (dev.vrrp && dev.vrrp.groups) {
    Object.keys(dev.vrrp.groups).forEach(function (id) {
      var g = dev.vrrp.groups[id];
      if (g.interface) lines.push("interface " + g.interface);
      if (g.ip) lines.push(" vrrp " + id + " ip " + g.ip);
      if (g.priority && g.priority !== 100) lines.push(" vrrp " + id + " priority " + g.priority);
      if (g.advert !== 1 || g.hold !== 3) lines.push(" vrrp " + id + " timers advertise " + g.advert + " hold " + g.hold);
      if (g.interface) lines.push("exit");
    });
  }
  // ---- DHCP 服务器 ----
  if (dev.dhcp && dev.dhcp.enabled) {
    lines.push("service dhcp");
    Object.keys(dev.dhcp.pools || {}).forEach(function (n) {
      var p = dev.dhcp.pools[n];
      lines.push("ip dhcp pool " + n);
      if (p.network) lines.push(" network " + p.network + " " + p.mask);
      if (p.gateway) lines.push(" default-router " + p.gateway);
      if (p.dns) lines.push(" dns-server " + p.dns);
      if (p.start) lines.push(" range " + p.start + " " + p.end);
      if (p.lease) lines.push(" lease " + p.lease);
      if (p.vlan) lines.push(" vlan " + p.vlan);
      lines.push("exit");
    });
    if ((dev.dhcp.excluded || []).length) {
      lines.push("ip dhcp excluded-address " + dev.dhcp.excluded[0] +
        (dev.dhcp.excluded.length > 1 ? " " + dev.dhcp.excluded[dev.dhcp.excluded.length - 1] : ""));
    }
  }
  lines.push("!");
  lines.push("end");
  return lines.join("\n");
}

// MAC 学习（ping/流量触发）
function learnMac(dev, mac, port, vlan) {
  var ex = dev.macTable[mac];
  if (ex && ex.static) return ex;              // 静态绑定不被动态学习覆盖
  // MAC 表项上限：满表后不再学习新地址（真机行为：未知单播泛洪加剧）
  if (!ex && dev.macLimit && Object.keys(dev.macTable).length >= dev.macLimit) {
    dev.macTableFull = true;
    return null;
  }
  var rec = { port: port, vlan: vlan || 1, age: Date.now() };
  dev.macTable[mac] = rec;
  // 老化：超过 agingTime 的动态项自动清除
  var maxAge = (dev.agingTime || 300) * 1000;
  if (maxAge > 0) {
    var now = Date.now(), ks = Object.keys(dev.macTable);
    for (var i = 0; i < ks.length; i++) {
      var e = dev.macTable[ks[i]];
      if (e && !e.static && now - (e.age || 0) > maxAge) delete dev.macTable[ks[i]];
    }
  }
  return rec;
}

function measurePing(allDevices, links, srcDev, dstIp, stpInfo) {
  var hops = 0;
  if (srcDev && srcDev.type === "pc" && srcDev.pcIp) {
    for (var i = 0; i < links.length; i++) {
      var l = links[i];
      if ((l.a.dev === srcDev.id || l.b.dev === srcDev.id)) hops++;
    }
  }
  var lp = latencyProfile(srcDev);
  var base = lp.same + Math.min(hops, 6) * (lp.hop * 0.35 + 0.15);
  var seed = ipToInt(dstIp) || 1;
  var mk = function (k) { var x = (seed + k * 2654435761) >>> 0; return (x % 1000) / 1000; };
  var min = Math.round(base * 10) / 10;
  var spread = Math.max(0.1, lp.jitter * 2 + mk(1) * 0.6);
  var max = Math.round((min + spread) * 10) / 10;
  var avg = Math.round((min + spread * (0.3 + mk(2) * 0.4)) * 10) / 10;
  // 取整后强制维持 min ≤ avg ≤ max
  if (max < min) max = min;
  if (avg < min) avg = min;
  if (avg > max) avg = max;
  return { min: min, avg: avg, max: max, loss: 0 };
}

var api = {
  ipToInt: ipToInt, intToIp: intToIp, maskToPrefix: maskToPrefix, prefixToMask: prefixToMask,
  networkOf: networkOf, sameSubnet: sameSubnet, normMac: normMac, genMac: genMac,
  normalizePort: normalizePort, expandPortRange: expandPortRange,
  createDevice: createDevice, ensureVlan: ensureVlan, setAccessVlan: setAccessVlan,
  devById: devById, stpCompute: stpCompute, isStpBlocked: isStpBlocked,
  connectedNets: connectedNets, buildRouteTable: buildRouteTable, routeLookup: routeLookup,
  simulatePing: simulatePing, simulateTracert: simulateTracert, linkOperUp: linkOperUp, neighborOnLink: neighborOnLink,
  showVlan: showVlan, showMacTable: showMacTable, showIpInterfaceBrief: showIpInterfaceBrief,
  showIpRoute: showIpRoute, showSpanningTree: showSpanningTree, showPortGroup: showPortGroup,
  showMonitor: showMonitor, showPortSecurity: showPortSecurity, showRunningConfig: showRunningConfig,
  learnMac: learnMac, deviceIpList: deviceIpList, findDeviceByIp: findDeviceByIp,
  portAllows: portAllows, l2ingress: l2ingress, edgeVlan: edgeVlan,
  measurePing: measurePing, formatPingWin: formatPingWin, detectStorm: detectStorm,
  formatPingOne: formatPingOne, pingStatsBlock: pingStatsBlock, pingTimes: pingTimes,
  // ---- 二层安全与控制平面 ----
  portLabel: portLabel, isIsolated: isIsolated,
  showDhcpSnooping: showDhcpSnooping, checkDhcpViolation: checkDhcpViolation,
  learnIgmp: learnIgmp, showIgmpSnooping: showIgmpSnooping,
  showArpInspection: showArpInspection, checkArpViolation: checkArpViolation,
  showPortIsolate: showPortIsolate, showQosPriority: showQosPriority,
  showLoopGuard: showLoopGuard, showStaticMac: showStaticMac, showMacAging: showMacAging,
  showLldp: showLldp, showSnmp: showSnmp,
  // ---- ACL ----
  aclDecide: aclDecide, aclRuleMatch: aclRuleMatch, aclIpMatch: aclIpMatch,
  showAcl: showAcl, showAclBrief: showAclBrief,
  // ---- VRRP ----
  vrrpElect: vrrpElect, showVrrp: showVrrp, vrrpVirtualIp: vrrpVirtualIp,
  // ---- DHCP 服务器 ----
  dhcpAllocate: dhcpAllocate, showDhcpPool: showDhcpPool, showDhcpBinding: showDhcpBinding
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
global.DCNSim = api;
})(typeof window !== "undefined" ? window : global);
