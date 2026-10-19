## 神州数码 DCN 网络模拟器 v1.0.0

对标思科 Packet Tracer 的网络实验模拟器，命令与提示符严格对照本课程 PPT 与实验报告。

### 下载
- `DCN-Simulator-1.0.0-portable.exe` — 绿色单文件版，Windows 64 位，双击即用，无需安装

> 首次运行需解压约 30 秒（单文件 exe 会自解压到临时目录），窗口不会立刻出现属正常现象。
> 未做代码签名，Windows SmartScreen 可能提示"未知发布者"，选择"仍要运行"即可。

### 功能
- **16 个课程实验**一键载入：交换机初始配置 / 以太网原理 / 端口安全 / VLAN / 三层交换 /
  Telnet / SSH / 链路聚合 / 端口镜像 / STP / MSTP / 路由技术 / 路由器 IP / 静态路由 /
  默认路由 / RIP / OSPF
- **完整 DCN 命令集**：支持命令缩写（每个单词只输唯一前缀，如 `conf t`、`int e1/0/1`、
  `swi mode acc`、`sh run`）、TAB 补全、`?` 联想、历史记录
- **思科式连线**：选线型 → 点源设备选端口 → 点目标设备选端口，支持直通线/交叉线/光纤/
  Console/DCE/DTE 串口
- **真实链路延迟**：ping 采用 Windows 风格输出，逐包浮现，含最短/最长/平均与丢包统计
- **广播风暴模拟**：二层成环且未开启生成树时通信阻断，开启 `spanning-tree` 后恢复
- **一键标准答案**：按实验报告参数表自动配置，可直接验证 ping 是否通
- **企业级进阶特性**（神州数码 DCS 真机常见，均可用 show 验证）：
  - DHCP Snooping 防欺骗（`ip dhcp snooping`、接口下 `ip dhcp snooping trust`）
  - IGMP Snooping 组播抑制（`ip igmp snooping`）
  - 动态 ARP 检测 DAI（`ip arp inspection vlan <列表>`）
  - 端口隔离（`switchport isolate group <n>`）—— **真实阻断通信**，ping 会报「端口隔离阻断」
  - QoS 优先级 802.1p（`switchport priority <0-7>`）
  - 环路保护（`switchport loop-guard enable`、`loop-guard enable`）
  - 静态 MAC 绑定 / MAC 表上限 / 老化时间（`mac-address static`/`maximum`/`aging-time`）
  - LLDP 邻居发现、SNMP Agent、端口限速、`debug mirror`
- **ACL 访问控制列表**：`ip access-list extended <编号>` → `seq <n> permit|deny <协议> <源> <目的> [eq 端口] [log]`，
  接口下 `ip access-group <编号> in` 应用。**命中 deny 会真实阻断流量**（地址用反掩码，与真机一致）
- **VRRP 网关冗余**：接口下 `vrrp <组号> ip <虚IP>`、`vrrp <组号> priority <1-254>`，
  按优先级自动选举 Master，`show vrrp` 查看
- **DHCP 服务器**：`service dhcp`、`ip dhcp pool <名>`（network / default-router / dns-server /
  lease / range）、`ip dhcp excluded-address`，`show ip dhcp pool` 与 `show ip dhcp binding`

### 本地运行（无需 exe）
直接用浏览器打开 `index.html` 即可，无需安装任何依赖。

### 目录结构
```
index.html          入口
styles.css          Claude 风格暖纸主题
src/sim-core.js     转发/VLAN/STP/路由/延迟/风暴 仿真核心
src/cli-engine.js   DCN 命令解析与执行
src/labs.js         16 个实验预设
src/ui.js           界面与交互
src/icons.js        图标映射（Lucide, ISC License）
test/               自动化测试（496 项）
electron/           Electron 打包配置
```

### 测试
```powershell
node src\run-tests.js          # CLI 引擎单测（23 项）
node test\cmd-audit.js         # 命令审计（70 项）
node test\enterprise-test.js   # 企业级新功能（121 项）
node test\runtime-behavior-test.js  # 运行时行为（42 项）
node test\edge-case-test.js    # 边界与异常输入（56 项）
node test\advanced-feature-test.js  # ACL/VRRP/DHCP（78 项）
cd test; npm install; cd ..    # jsdom 依赖（仅页面测试需要）
node test\answer-test.js       # 端到端（24 项）
```
共 496 项自动化测试，全部通过。

### 图标许可
[Lucide](https://lucide.dev) Icons，ISC License。