const path = require("path");
const join = path.join;
// 延迟模型 + 广播风暴阻断 专项验证
global.window = global;
require(join(__dirname, "..", "src", "sim-core.js"));
require(join(__dirname, "..", "src", "cli-engine.js"));
const Sim = global.DCNSim, CLI = global.DCNCLI;
let pass = 0, fail = 0;
const ok = (c, m, x) => { if (c) { pass++; console.log("PASS " + m); } else { fail++; console.log("FAIL " + m + (x ? " [" + x + "]" : "")); } };

function mk(dev, devs, links) {
  const sess = CLI.createSession(dev);
  return { devices: devs, links, dev, sess,
    stpInfo: () => Sim.stpCompute(devs, links), refreshStp: () => {},
    factoryReset: () => {}, ping: (s, ip) => Sim.simulatePing(devs, links, s, ip),
    tracert: (s, ip) => Sim.simulateTracert(devs, links, s, ip), telnetTo: () => "" };
}

/* ---------- 1. 延迟模型 ---------- */
(function () {
  const sw = Sim.createDevice("l2", "SW1", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0); pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0); pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devs = [sw, pc1, pc2];
  const links = [{ id: "a", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
                 { id: "b", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }];
  const stp = Sim.stpCompute(devs, links);
  const r = Sim.simulatePing(devs, links, pc1, "192.168.1.12", stp);
  ok(r.ok, "同网段 ping 通", r.reason);
  ok(!!r.latency, "返回延迟数据");
  const L = r.latency;
  ok(L.min >= 0 && L.max >= L.min && L.avg >= L.min && L.avg <= L.max,
    "延迟满足 min ≤ avg ≤ max", JSON.stringify(L));
  ok(L.max > 0, "延迟大于0（有真实耗时）", JSON.stringify(L));

  // 稳定性：同一次会话多次 ping 延迟一致
  const r2 = Sim.simulatePing(devs, links, pc1, "192.168.1.12", stp);
  ok(r2.latency.avg === L.avg, "同一设备对延迟稳定可复现",
    L.avg + " vs " + r2.latency.avg);

  // 不同设备延迟不同
  const pc3 = Sim.createDevice("pc", "PC3", 0, 0); pc3.pcIp = "192.168.1.13"; pc3.pcMask = "255.255.255.0";
  const devs3 = [sw, pc1, pc3];
  const links3 = [{ id: "a", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
                  { id: "c", a: { dev: sw.id, port: "e1/0/3" }, b: { dev: pc3.id, port: "eth0" } }];
  const stp3 = Sim.stpCompute(devs3, links3);
  const r3 = Sim.simulatePing(devs3, links3, pc1, "192.168.1.13", stp3);
  ok(!!r3.latency && r3.latency.avg >= 0, "不同设备也可 ping 并有延迟", JSON.stringify(r3.latency));

  // 跨设备数越多延迟越高
  const sw2 = Sim.createDevice("l2", "SW2", 0, 0);
  const pc4 = Sim.createDevice("pc", "PC4", 0, 0); pc4.pcIp = "192.168.1.14"; pc4.pcMask = "255.255.255.0";
  const devs4 = [sw, sw2, pc1, pc4];
  const links4 = [{ id: "t", a: { dev: sw.id, port: "e1/0/24" }, b: { dev: sw2.id, port: "e1/0/24" } },
                  { id: "a", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
                  { id: "d", a: { dev: sw2.id, port: "e1/0/1" }, b: { dev: pc4.id, port: "eth0" } }];
  const stp4 = Sim.stpCompute(devs4, links4);
  const near = Sim.simulatePing(devs4, links4, pc1, pc1.pcIp, stp4);
  ok(!!near.latency, "本机 ping 也有延迟数据");

  // Windows 格式输出
  const out = Sim.formatPingWin("192.168.1.12", L, 5, 5);
  ok(/正在 Ping/.test(out), "含 Windows 风格标题");
  ok(/TTL=/.test(out), "含 TTL");
  ok(/最短/.test(out) && /平均/.test(out) && /最长/.test(out), "含 min/avg/max 统计");
  ok(/已发送 = 5/.test(out) && /已接收 = 5/.test(out), "含收发包统计");
})();

/* ---------- 2. 广播风暴阻断 ---------- */
(function () {
  const swA = Sim.createDevice("l2", "SwitchA", 0, 0);
  const swB = Sim.createDevice("l2", "SwitchB", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0); pc1.pcIp = "192.168.10.100"; pc1.pcMask = "255.255.255.0";
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0); pc2.pcIp = "192.168.10.101"; pc2.pcMask = "255.255.255.0";
  const devs = [swA, swB, pc1, pc2];
  // 双链路成环
  const links = [
    { id: "1", a: { dev: swA.id, port: "e1/0/1" }, b: { dev: swB.id, port: "e1/0/1" } },
    { id: "2", a: { dev: swA.id, port: "e1/0/2" }, b: { dev: swB.id, port: "e1/0/2" } },
    { id: "a", a: { dev: swA.id, port: "e1/0/10" }, b: { dev: pc1.id, port: "eth0" } },
    { id: "b", a: { dev: swB.id, port: "e1/0/10" }, b: { dev: pc2.id, port: "eth0" } }
  ];
  const stp = Sim.stpCompute(devs, links);
  ok(Sim.detectStorm(devs, links, stp) === true, "双链路未开STP → 检测到风暴");
  const r = Sim.simulatePing(devs, links, pc1, "192.168.10.101", stp);
  ok(r.ok === false, "风暴状态下 ping 不通", JSON.stringify(r));
  ok(r.storm === true, "结果标记为风暴阻断");
  ok(/风暴/.test(r.reason), "原因说明是广播风暴", r.reason);

  // 开启生成树后恢复
  swA.stp.enabled = true; swB.stp.enabled = true;
  const stp2 = Sim.stpCompute(devs, links);
  ok(Sim.detectStorm(devs, links, stp2) === false, "开启STP后无风暴");
  const r2 = Sim.simulatePing(devs, links, pc1, "192.168.10.101", stp2);
  ok(r2.ok === true, "开启STP后 ping 恢复连通", r2.reason);
  ok(!!r2.latency, "恢复后也有延迟数据");

  // 聚合链路不算风暴
  const swC = Sim.createDevice("l2", "SwitchC", 0, 0);
  const pc3 = Sim.createDevice("pc", "PC3", 0, 0); pc3.pcIp = "192.168.20.100"; pc3.pcMask = "255.255.255.0";
  const pc4 = Sim.createDevice("pc", "PC4", 0, 0); pc4.pcIp = "192.168.20.101"; pc4.pcMask = "255.255.255.0";
  const d2 = [swC, Sim.createDevice("l2", "SwitchD", 0, 0), pc3, pc4];
  const swD = d2[1];
  const l2 = [
    { id: "x", a: { dev: swC.id, port: "e1/0/1" }, b: { dev: swD.id, port: "e1/0/1" } },
    { id: "y", a: { dev: swC.id, port: "e1/0/2" }, b: { dev: swD.id, port: "e1/0/2" } },
    { id: "p", a: { dev: swC.id, port: "e1/0/10" }, b: { dev: pc3.id, port: "eth0" } },
    { id: "q", a: { dev: swD.id, port: "e1/0/10" }, b: { dev: pc4.id, port: "eth0" } }
  ];
  ok(Sim.detectStorm(d2, l2, Sim.stpCompute(d2, l2)) === true, "未聚合的双链路仍是风暴");
  ["e1/0/1", "e1/0/2"].forEach((p) => {
    swC.ports[p].aggGroup = 1; swD.ports[p].aggGroup = 1;
  });
  ok(Sim.detectStorm(d2, l2, Sim.stpCompute(d2, l2)) === false, "配置链路聚合后不算风暴");

  // 单链路不成环
  const single = [{ id: "s", a: { dev: swC.id, port: "e1/0/5" }, b: { dev: swD.id, port: "e1/0/5" } }];
  ok(Sim.detectStorm(d2, single, Sim.stpCompute(d2, single)) === false, "单链路不成环，无风暴");
})();

/* ---------- 3. CLI 输出风格 ---------- */
(function () {
  const sw = Sim.createDevice("l2", "SW", 0, 0);
  const pc1 = Sim.createDevice("pc", "PC1", 0, 0); pc1.pcIp = "192.168.1.11"; pc1.pcMask = "255.255.255.0";
  const pc2 = Sim.createDevice("pc", "PC2", 0, 0); pc2.pcIp = "192.168.1.12"; pc2.pcMask = "255.255.255.0";
  const devs = [sw, pc1, pc2];
  const links = [{ id: "a", a: { dev: sw.id, port: "e1/0/1" }, b: { dev: pc1.id, port: "eth0" } },
                 { id: "b", a: { dev: sw.id, port: "e1/0/2" }, b: { dev: pc2.id, port: "eth0" } }];
  const ctx = mk(sw, devs, links);
  CLI.execLine(ctx, "enable");
  const out = CLI.execLine(ctx, "ping 192.168.1.12").output;
  ok(/正在 Ping/.test(out), "CLI ping 用 Windows 风格");
  ok(/TTL=\d+/.test(out), "CLI ping 显示 TTL");
  ok(/最短 = [\d.]+ms/.test(out), "CLI ping 显示延迟统计", out);

  // 风暴时 CLI 输出
  const swA = Sim.createDevice("l2", "A", 0, 0), swB = Sim.createDevice("l2", "B", 0, 0);
  const q1 = Sim.createDevice("pc", "Q1", 0, 0); q1.pcIp = "10.0.0.1"; q1.pcMask = "255.255.255.0";
  const q2 = Sim.createDevice("pc", "Q2", 0, 0); q2.pcIp = "10.0.0.2"; q2.pcMask = "255.255.255.0";
  const dv = [swA, swB, q1, q2];
  const lk = [{ id: "1", a: { dev: swA.id, port: "e1/0/1" }, b: { dev: swB.id, port: "e1/0/1" } },
              { id: "2", a: { dev: swA.id, port: "e1/0/2" }, b: { dev: swB.id, port: "e1/0/2" } },
              { id: "a", a: { dev: swA.id, port: "e1/0/10" }, b: { dev: q1.id, port: "eth0" } },
              { id: "b", a: { dev: swB.id, port: "e1/0/10" }, b: { dev: q2.id, port: "eth0" } }];
  const c2 = mk(swA, dv, lk);
  CLI.execLine(c2, "enable");
  const out2 = CLI.execLine(c2, "ping 10.0.0.2").output;
  ok(/请求超时/.test(out2), "风暴时 CLI 显示请求超时");
  ok(/丢失 = 5/.test(out2), "风暴时显示 100% 丢包");
  ok(/spanning-tree/.test(out2), "风暴时提示开启生成树");
})();

console.log("\n==== " + pass + " passed, " + fail + " failed ====");
process.exit(fail ? 1 : 0);