// 验证打包产物的 asar 是否正确包含 web 资源（别人下载 exe 后能否正常运行）
// 用法：先 npm run dist，再 node test/verify-asar.js
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
let asar;
try {
  asar = require(path.join(ROOT, "electron", "node_modules", "@electron", "asar"));
} catch (e) {
  console.log("SKIP: 未找到 @electron/asar（先在 electron/ 目录执行 npm install）");
  process.exit(0);
}

const asarPath = path.join(ROOT, "electron", "release", "win-unpacked", "resources", "app.asar");
if (!fs.existsSync(asarPath)) {
  console.log("SKIP: 尚未打包（先在 electron/ 目录执行 npm run dist）");
  process.exit(0);
}

const files = asar.listPackage(asarPath);
const norm = (f) => f.replace(/\\/g, "/").replace(/^\//, "");

console.log("asar 内文件总数:", files.length);

const need = ["index.html", "styles.css", "src/ui.js", "src/sim-core.js", "src/cli-engine.js",
  "src/labs.js", "src/icons.js", "main.js", "preload.js", "package.json"];

let miss = 0, bad = 0;
for (const n of need) {
  const hit = files.filter(x => norm(x) === n)[0];
  if (!hit) { console.log("MISS " + n); miss++; continue; }
  // extractFile 要求不带前导分隔符的相对路径
  const buf = asar.extractFile(asarPath, norm(hit));
  const txt = buf.toString("utf8");
  const mojibake = txt.indexOf("\uFFFD") >= 0;
  console.log((mojibake ? "BAD  " : "OK   ") + n + "  (" + buf.length + " bytes)" + (mojibake ? "  <-- 编码损坏!" : ""));
  if (mojibake) bad++;
}

const icons = files.filter(f => norm(f).endsWith(".svg") && norm(f).includes("assets/icons/"));
console.log("图标数量:", icons.length);

const ih = asar.extractFile(asarPath, "index.html").toString("utf8");
console.log("index.html 引用 src/sim-core.js:", ih.indexOf("src/sim-core.js") >= 0);
console.log("index.html 引用 styles.css:", ih.indexOf("styles.css") >= 0);

const pass = miss === 0 && bad === 0 && icons.length > 0;
console.log(pass ? "\n结论: asar 内容完整、无乱码，exe 可正常分发"
  : "\n结论: 缺失 " + miss + " 个 / 编码损坏 " + bad + " 个 / 图标 " + icons.length + " 个");
process.exit(pass ? 0 : 1);