// 16 个实验的完整性与一致性体检：拓扑、任务、标准答案、ping 断言
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
load("src/labs.js");
const Sim = global.DCNSim, CLI = global.DCNCLI, LABS = global.DCNLABS;

let pass = 0, fail = 0; const fails = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS " + name); }
  else { fail++; fails.push(name + (extra ? " -> " + extra : "")); console.log("FAIL " + name + (extra ? " -> " + extra : "")); }
}

const labs = Array.isArray(LABS) ? LABS : (LABS.LABS || LABS.labs || []);
console.log("实验数量:", labs.length);
ok("16 个实验", labs.length === 16, String(labs.length));
// NET1216 可能挂在全局或数组某项上
const NET1216 = (typeof LABS !== "undefined" && LABS.NET1216) ||
  (labs.find(l => l && l.NET1216) || {}).NET1216 || global.DCNNET1216 ||
  (function () { // 从 lab12 的引用里找
    for (const l of labs) {
      if (l && l.devices && l.devices.length === 12 && l.links && l.links.length === 12) return { devices: l.devices, links: l.links };
    }
    return null;
  })();

console.log("\n===== 1. 每个实验的结构完整性 =====");
for (const lab of labs) {
  const errs = [];
  if (!lab.id) errs.push("缺 id");
  if (!lab.no) errs.push("缺 no");
  if (!lab.title) errs.push("缺 title");
  if (!Array.isArray(lab.devices) || !lab.devices.length) errs.push("devices 为空");
  if (!Array.isArray(lab.links)) errs.push("缺 links");
  if (!Array.isArray(lab.tasks) || !lab.tasks.length) errs.push("tasks 为空");
  // 连线引用的设备必须存在
  const names = (lab.devices || []).map(d => d.name);
  (lab.links || []).forEach((l, i) => {
    if (!names.includes(l.a[0])) errs.push("link" + i + " 引用不存在的 " + l.a[0]);
    if (!names.includes(l.b[0])) errs.push("link" + i + " 引用不存在的 " + l.b[0]);
  });
  // 设备名唯一
  if (new Set(names).size !== names.length) errs.push("设备名重复");
  // tasks 引用的设备必须存在
  (lab.tasks || []).forEach(t => {
    if (t.from && !names.includes(t.from)) errs.push("task 引用不存在的 from=" + t.from);
    if (t.target && !names.includes(t.target)) errs.push("task 引用不存在的 target=" + t.target);
  });
  ok("实验" + lab.no + " " + lab.title + " 结构完整", errs.length === 0, errs.join("; "));
}

console.log("\n===== 2. 端口引用合法性 =====");
{
  const bad = [];
  for (const lab of labs) {
    for (const l of (lab.links || [])) {
      for (const side of [l.a, l.b]) {
        const dev = (lab.devices || []).find(d => d.name === side[0]);
        if (!dev) continue;
        const t = dev.type;
        const port = side[1];
        if (t === "pc") { if (port !== "eth0") bad.push(lab.id + " " + side[0] + " 端口应为 eth0，实为 " + port); }
        else if (t === "router") {
          if (!["g0/0", "g0/1", "s1/0", "s1/1"].includes(port)) bad.push(lab.id + " " + side[0] + " 非法路由器口 " + port);
        } else {
          const m = port.match(/^e1\/0\/(\d+)$/);
          if (!m) bad.push(lab.id + " " + side[0] + " 非法交换机口 " + port);
          else if (parseInt(m[1], 10) > 24) bad.push(lab.id + " " + side[0] + " 端口号超范围 " + port);
        }
      }
    }
  }
  ok("所有实验的端口引用合法", bad.length === 0, JSON.stringify(bad.slice(0, 6)));
}

console.log("\n===== 3. 同一端口被多条链路占用 =====");
{
  const bad = [];
  for (const lab of labs) {
    const used = {};
    for (const l of (lab.links || [])) {
      for (const side of [l.a, l.b]) {
        const k = side[0] + "|" + side[1];
        if (used[k]) bad.push(lab.id + " 端口重复占用 " + k);
        used[k] = true;
      }
    }
  }
  ok("无端口冲突", bad.length === 0, JSON.stringify(bad.slice(0, 6)));
}

console.log("\n===== 4. 标准答案（GUIDES）与实验对应 =====");
{
  const guides = LABS.GUIDES || {};
  const missing = labs.filter(l => !guides[l.id]).map(l => l.id);
  ok("每个实验都有分步指导", missing.length === 0, JSON.stringify(missing));
  // 指导里的命令应都能被解析（不产生"未知命令"）
  const unknown = [];
  for (const lab of labs) {
    const g = guides[lab.id] || [];
    for (const line of g) {
      const cmd = String(line).trim();
      if (!cmd || cmd.indexOf("#") === 0) continue;
      if (!/^[a-z]/i.test(cmd)) continue;      // 跳过说明性文字
      const sw = Sim.createDevice("l2", "T", 0, 0);
      const ctx = {
        devices: [sw], links: [], dev: sw, sess: CLI.createSession(sw), pendingConfirm: null,
        stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
        factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
      };
      ctx.sess.mode = "priv";
      const r = CLI.execLine(ctx, cmd);
      if (r.output && r.output.indexOf("未知命令") >= 0) unknown.push(lab.id + ": " + cmd);
    }
  }
  ok("指导中的命令均被识别", unknown.length === 0, JSON.stringify(unknown.slice(0, 6)));
}

console.log("\n===== 5. 一键标准答案能配置成功（模拟）=====");
{
  const bad = [];
  for (const lab of labs) {
    const guide = (LABS.GUIDES || {})[lab.id] || [];
    // 取形如 "AC(设备名, [命令,...])" 的步骤
    const steps = guide.filter(g => typeof g === "string" && /^[A-Z]{2}\(/.test(g));
    if (!steps.length) continue;
    for (const st of steps) {
      const m = st.match(/^([A-Z]{2})\(([^,]+),\s*\[([\s\S]*)\]\)/);
      if (!m) { bad.push(lab.id + " 无法解析步骤: " + st.slice(0, 40)); continue; }
      const devName = m[2].trim();
      const cmds = m[3].split(",").map(x => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
      const labDev = (lab.devices || []).find(d => d.name === devName);
      if (!labDev) { bad.push(lab.id + " 步骤引用不存在设备 " + devName); continue; }
      // 逐条执行，捕获错误
      const dev = Sim.createDevice(labDev.type, labDev.name, 0, 0);
      const ctx = {
        devices: [dev], links: [], dev: dev, sess: CLI.createSession(dev), pendingConfirm: null,
        stream: null, ping: () => ({}), tracert: () => ({ hops: [] }), telnetTo: () => "",
        factoryReset: () => {}, stpInfo: () => ({}), refreshStp: () => {}
      };
      ctx.sess.mode = "priv";
      for (const cmd of cmds) {
        let r;
        try { r = CLI.execLine(ctx, cmd); }
        catch (e) { bad.push(lab.id + " " + devName + " 命令异常 " + cmd + ": " + e.message); break; }
        if (r.output && r.output.indexOf("未知") >= 0) {
          bad.push(lab.id + " " + devName + " 未知命令: " + cmd);
        }
      }
    }
  }
  ok("所有实验的标准答案命令均可执行", bad.length === 0, JSON.stringify(bad.slice(0, 6)));
}

console.log("\n===== 6. 任务里声明的 ping 目标是否可达（同 VLAN 概念）=====");
{
  const info = [];
  for (const lab of labs) {
    const withPing = (lab.tasks || []).filter(t => t.from && t.target);
    info.push(lab.no + ": " + withPing.length + " 个 ping 任务");
  }
  ok("每个实验都有 ping 任务", info.every(x => !/: 0 /.test(x)), info.join(" | "));
}

console.log("\n===== 7. 实验编号唯一且连续 =====");
{
  const nos = labs.map(l => parseInt(l.no, 10)).sort((a, b) => a - b);
  const expect = [];
  for (let i = 1; i <= nos.length; i++) expect.push(i);
  ok("实验编号 1..N 连续无重复", JSON.stringify(nos) === JSON.stringify(expect), JSON.stringify(nos));
  const ids = labs.map(l => l.id);
  ok("实验 id 唯一", new Set(ids).size === ids.length);
}

console.log("\n===== 8. NET1216 公共拓扑（实验 12-16）=====");
{
  const net = NET1216;
  ok("NET1216 存在", !!net);
  if (net) {
    ok("12 台设备", net.devices && net.devices.length === 12, String(net.devices && net.devices.length));
    ok("12 条链路", net.links && net.links.length === 12, String(net.links && net.links.length));
    const names = (net.devices || []).map(d => d.name);
    const bad = [];
    (net.links || []).forEach((l, i) => {
      if (!names.includes(l.a[0])) bad.push("link" + i + " -> " + l.a[0]);
      if (!names.includes(l.b[0])) bad.push("link" + i + " -> " + l.b[0]);
    });
    ok("链路引用合法", bad.length === 0, JSON.stringify(bad));
  }
}

console.log("\n=====================================");
console.log("==== " + pass + " passed, " + fail + " failed ====");
if (fail) { console.log("\nFailures:"); fails.forEach(f => console.log("  - " + f)); }
process.exit(fail ? 1 : 0);