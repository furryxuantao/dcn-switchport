// ping/tracert 细节与统计的正确性检查
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

global.window = global;
global.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
global.document = { createElement: () => ({ style: {}, classList: { add() {}, remove() {} }, setAttribute() {}, appendChild() {} }), getElementById: () => null, querySelectorAll: () => [], addEventListener() {} };

function load(file) {
  const m = { exports: {} };
  new Function("window", "global", "module", "exports",
    fs.readFileSync(path.join(ROOT, file), "utf8"))(global, global, m, m.exports);
}
load("src/sim-core.js");
load("src/cli-engine.js");
const Sim = global.DCNSim, CLI = global.DCNCLI;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}
function ctxOf(dev, devices, links) {
  return {
    devices: devices || [dev], links: links || [], dev: dev,
    sess: CLI.createSession(dev), pendingConfirm: null, stream: null,
    ping: (d, ip) => Sim.simulatePing(devices || [d], links || [], d, ip),
    tracert: () => ({ ok: false, hops: [] }), telnetTo: () => "",
    factoryReset: () => {}, stpInfo: () => Sim.stpCompute(devices || [dev], links || []), refreshStp: () => {}
  };
}

// 三台设备串联
function chain() {
  const sw1 = Sim.createDevice("l2", "SW1", 0, 0);
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const sw3 = Sim.createDevice("l2", "SW3", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0);
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0);
  pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devices = [sw1, sw2, sw3, pc1, pc2];
  const links = [
    { id: "a", kind: "copper", a: { dev: sw1.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "t1", kind: "copper", a: { dev: sw1.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/1" } },
    { id: "t2", kind: "copper", a: { dev: sw2.id, port: "e1/0/24" }, b: { dev: sw3.id, port: "e1/0/1" } },
    { id: "b", kind: "copper", a: { dev: sw3.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  return { sw1, sw2, sw3, devices, links, pc1, pc2 };
}

console.log("\n===== 1. tracert 路径与跳数 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  const t = Sim.simulateTracert(devices, links, pc1, pc2.pcIp);
  ok("tracert 成功", t.ok === true, t.reason);
  ok("有跳数记录", Array.isArray(t.hops) && t.hops.length > 0, JSON.stringify(t.hops));
  ok("经过 3 台交换机 + 2 台 PC = 5 跳",
    t.hops && t.hops.length === 5, "实际 " + (t.hops ? t.hops.length : 0) + " 跳: " + JSON.stringify(t.hops));
  ok("第一跳是源 PC", t.hops[0] && (t.hops[0].dev === "PC1" || t.hops[0].name === "PC1"),
    JSON.stringify(t.hops[0]));
  ok("最后一跳是目的 PC", JSON.stringify(t.hops[t.hops.length - 1]).indexOf("PC2") >= 0,
    JSON.stringify(t.hops[t.hops.length - 1]));
}
{
  // 不可达时 tracert 应给出失败信息
  const { devices, links, pc1 } = chain();
  const t = Sim.simulateTracert(devices, links, pc1, "10.9.9.9");
  ok("不可达目标 tracert 返回失败", t.ok === false, JSON.stringify(t));
  ok("有原因说明", !!t.reason, JSON.stringify(t));
}

console.log("\n===== 2. 延迟模型：稳定且随跳数增长 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  const r1 = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  const r2 = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  ok("两次 ping 的平均延迟稳定", r1.latency && r2.latency && r1.latency.avg === r2.latency.avg,
    r1.latency && r2.latency ? r1.latency.avg + " vs " + r2.latency.avg : "缺 latency");
  ok("min <= avg <= max", r1.latency.min <= r1.latency.avg && r1.latency.avg <= r1.latency.max,
    JSON.stringify(r1.latency));
  // 近距离应比远距离快：同一对 PC（同一 MAC → 同一设备画像），只改拓扑长度
  const swA = Sim.createDevice("l2", "SWA", 0, 0);
  const n1 = Sim.createDevice("pc", "N1", 0, 0);
  const n2 = Sim.createDevice("pc", "N2", 0, 0);
  n1.pcMac = pc1.pcMac; n1.mac = pc1.mac; n1.pcIp = "192.168.9.11"; n1.pcMask = "255.255.255.0";
  n2.pcMac = pc2.pcMac; n2.mac = pc2.mac; n2.pcIp = "192.168.9.12"; n2.pcMask = "255.255.255.0";
  const ndev = [swA, n1, n2];
  const nlinks = [
    { id: "na", kind: "copper", a: { dev: swA.id, port: "e1/0/1" }, b: { dev: n1.id, port: "eth0" } },
    { id: "nb", kind: "copper", a: { dev: swA.id, port: "e1/0/2" }, b: { dev: n2.id, port: "eth0" } }
  ];
  const rn = Sim.simulatePing(ndev, nlinks, n1, n2.pcIp);
  ok("近距 ping 成功", rn.ok === true, rn.reason);
  ok("近距延迟 < 远距延迟", rn.latency && r1.latency && rn.latency.avg < r1.latency.avg,
    "近 " + (rn.latency && rn.latency.avg) + " vs 远 " + (r1.latency && r1.latency.avg));
}

console.log("\n===== 3. Windows 风格 ping 输出 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  const out = Sim.formatPingWin(pc2.pcIp, r.latency, 5, 5);
  ok("输出含「正在 Ping」", out.indexOf("正在 Ping") >= 0, out.slice(0, 60));
  ok("输出含 32 字节数据", out.indexOf("32 字节的数据") >= 0, out.slice(0, 80));
  ok("含回显统计", out.indexOf("Ping 统计信息") >= 0 || out.indexOf("统计") >= 0, out.slice(-80));
  ok("含丢包数", /丢失\s*=\s*\d+/.test(out) || /丢失/.test(out), out.slice(-80));
  ok("含往返时间", /往返/.test(out) || /ms/.test(out), out.slice(-80));
  ok("含 TTL", out.indexOf("TTL=") >= 0, out.slice(-80));
  // 失败时
  const rf = Sim.simulatePing(devices, links, pc1, "10.9.9.9");
  const outf = Sim.formatPingWin("10.9.9.9", rf.latency || { min: 0, avg: 0, max: 0 }, 0, 5);
  ok("失败时含超时", outf.indexOf("请求超时") >= 0, outf.slice(0, 80));
}

console.log("\n===== 4. ping 统计块 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
  const blk = Sim.pingStatsBlock(pc2.pcIp, r.latency, 5, 5);
  ok("统计块含 发送 = 5", blk.indexOf("发送 = 5") >= 0, blk);
  ok("统计块含 接收 = 5", blk.indexOf("接收 = 5") >= 0, blk);
  ok("统计块含 丢失 = 0", blk.indexOf("丢失 = 0") >= 0, blk);
  ok("统计块含 最短/最长/平均",
    blk.indexOf("最短") >= 0 && blk.indexOf("最长") >= 0 && blk.indexOf("平均") >= 0, blk);
  const blk2 = Sim.pingStatsBlock("1.1.1.1", { min: 0, avg: 0, max: 0 }, 0, 5);
  ok("全丢包时 接收 = 0", blk2.indexOf("接收 = 0") >= 0, blk2);
  ok("全丢包时 丢失 = 5", blk2.indexOf("丢失 = 5") >= 0, blk2);
}

console.log("\n===== 5. ping 命令输出（CLI 层）=====");
{
  const { devices, links, pc1, pc2 } = chain();
  const c = ctxOf(pc1, devices, links);
  c.sess.mode = "priv";
  const r = CLI.execLine(c, "ping " + pc2.pcIp);
  ok("ping 命令有输出", !!r.output && r.output.length > 0);
  ok("输出含目标 IP", r.output.indexOf(pc2.pcIp) >= 0, r.output.slice(0, 60));
  ok("输出含统计", /统计|丢失|请求超时/.test(r.output), r.output.slice(-80));
  // 不存在的 IP
  const r2 = CLI.execLine(c, "ping 10.9.9.9");
  ok("ping 不存在 IP 不抛异常", typeof r2.output === "string");
  ok("提示不可达", r2.output.indexOf("不可达") >= 0 || r2.output.indexOf("超时") >= 0, r2.output.slice(0, 80));
}

console.log("\n===== 6. 广播风暴下 ping 与 tracert =====");
{
  // 三台交换机成环，未开 STP
  const s1 = Sim.createDevice("l2", "S1", 0, 0);
  const s2 = Sim.createDevice("l2", "S2", 0, 0);
  const s3 = Sim.createDevice("l2", "S3", 0, 0);
  const p1 = Sim.createDevice("pc", "P1", 0, 0);
  const p2 = Sim.createDevice("pc", "P2", 0, 0);
  p1.pcIp = "192.168.1.11"; p1.pcMask = "255.255.255.0";
  p2.pcIp = "192.168.1.12"; p2.pcMask = "255.255.255.0";
  const devices = [s1, s2, s3, p1, p2];
  const links = [
    { id: "a", kind: "copper", a: { dev: s1.id, port: "e1/0/1" }, b: { dev: p1.id, port: "eth0" } },
    { id: "r1", kind: "copper", a: { dev: s1.id, port: "e1/0/24" }, b: { dev: s2.id, port: "e1/0/24" } },
    { id: "r2", kind: "copper", a: { dev: s2.id, port: "e1/0/1" }, b: { dev: s3.id, port: "e1/0/24" } },
    { id: "r3", kind: "copper", a: { dev: s3.id, port: "e1/0/1" }, b: { dev: s1.id, port: "e1/0/2" } },
    { id: "b", kind: "copper", a: { dev: s3.id, port: "e1/0/2" }, b: { dev: p2.id, port: "eth0" } }
  ];
  const r = Sim.simulatePing(devices, links, p1, p2.pcIp);
  ok("成环未开 STP 时 ping 失败", r.ok === false, r.reason);
  ok("标记为风暴", r.storm === true, JSON.stringify({ storm: r.storm, reason: r.reason }));
  ok("原因提到广播风暴", r.reason.indexOf("广播风暴") >= 0, r.reason);
  // 开 STP 后恢复
  [s1, s2, s3].forEach(s => { s.stp.enabled = true; });
  const r2 = Sim.simulatePing(devices, links, p1, p2.pcIp);
  ok("开启 STP 后恢复", r2.ok === true, r2.reason);
}

console.log("\n===== 7. ping 数量与 stream 回调 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  const c = ctxOf(pc1, devices, links);
  c.sess.mode = "priv";
  let streamed = 0;
  c.stream = (line, delay) => { streamed++; };
  const r = CLI.execLine(c, "ping " + pc2.pcIp);
  ok("ping 通过 stream 逐包输出", streamed > 0, "streamed=" + streamed);
  // 1 次表头 + 5 个包 + 1 次统计 = 7
  ok("流式输出 7 次（表头+5包+统计）", streamed === 7, "streamed=" + streamed);
}

console.log("\n===== 8. 多次 ping 的结果一致 =====");
{
  const { devices, links, pc1, pc2 } = chain();
  let allOk = true;
  for (let i = 0; i < 10; i++) {
    const r = Sim.simulatePing(devices, links, pc1, pc2.pcIp);
    if (!r.ok) { allOk = false; break; }
  }
  ok("连续 10 次 ping 全部成功", allOk);
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);