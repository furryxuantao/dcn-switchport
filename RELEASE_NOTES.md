## 神州数码 DCN 网络模拟器 v1.3.0

对标思科 Packet Tracer 的网络实验模拟器，命令与提示符严格对照本课程 PPT 与实验报告。

### 下载
- `DCN-Simulator-1.3.0-portable.exe` — 绿色单文件版，Windows 64 位，双击即用，无需安装

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

### 思科对标增强（设备仍为神州数码 DCS）

除课程命令外，补充了思科 IOS 上企业网常用的功能，命令语法对齐思科：

**二层**
- VTP 集中管理 VLAN：`vtp mode server|client|transparent`、`vtp domain`、`vtp version`、`vtp pruning`
- 生成树保护：PortFast / BPDU Guard / BPDU Filter / Root Guard、生成树计时器
- 聚合负载分担：`port-group N load-balance <算法>`、`min-links`
- 端口属性：`speed` / `duplex` / `negotiation` / `description` / `storm-control` / `udld` / `dot1x`
- 新增 `show vtp`、`show spanning-tree detail`、`show etherchannel summary`、`show interfaces status/trunk`

**三层**
- 辅助地址 `ip address <IP> <掩码> secondary`、DHCP 中继 `ip helper-address`、代理 ARP `proxy arp`
- RIP 增强：计时器 / poison-reverse / split-horizon / default-information originate
- OSPF 增强：auto-cost reference-bandwidth / log-adjacency-changes / default-information originate
- 新增 `show ip interface` / `ip helper` / `ip proxy-arp` / `ip rip` / `ip ospf`

**NAT / 策略路由 / 环路检测**
- NAT：`ip nat inside|outside`、`ip nat pool`、`ip nat overload`、`ip nat inside source list <ACL>`，
  **真实转换**并维护转换表（`show ip nat`）
- 策略路由：`route-map` → `match` / `set`（`show route-map`）
- 二层环路检测：`loop-detect enable`，MAC 反复漂移即告警并中断转发（`show loop-detect`）

**设备管理与运维**
- `show version` / `show device-info`
- 日志 `logging host|trap`、时钟 `clock timezone`、NTP `ntp server`
- AAA `aaa new-model`、TACACS+/RADIUS 服务器、SNMPv3 用户
- 用户特权级 `username <名> privilege <0-15>`、`banner motd`、`config-register`、
  `service password-recovery`、`history size`

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
test/               自动化测试（1095 项）
electron/           Electron 打包配置
```

### v1.3.0 修复的问题

**核心算法**
- **STP 无法处理多台交换机成环** —— 原实现只会阻塞「同一对交换机之间的并行链路」，
  三台及以上交换机构成的环路完全不会阻塞，导致课程实验 10（STP/MSTP）的核心场景失效。
  已重写为标准生成树构建（BFS 建树 → 根端口朝根 FWD → 冗余边阻塞离根更远的一端）。
  三台成环时只阻塞 1 个端口，其余 5 个 FWD。
- **广播风暴检测有同样盲区** —— 改用 Union-Find 判环。
- **MAC 地址表从不在转发时自动学习** —— `learnMac` 定义了、导出了，但转发路径从不调用，
  `show mac-address-table` 永远为空，实验 2「以太网交换机工作原理」的核心行为缺失。
  现已在入端口学习源 MAC，并接入「已知单播优先、未知泛洪」的真实交换机转发逻辑。
- **UI 层污染 MAC 表** —— `doPing` 与 `animatePing` 各有一处把源 MAC 记到
  「每台交换机的第一个口」的代码，导致表项指向错误端口，**反向通信不通**。

**端口安全**
- 旧判定条件实际含义是「没配静态 MAC 且 max≤0」才违例，**从未检查 MAC 数量超上限**。
  已重写为仿真核心实现，并支持 `violation shutdown|protect|restrict` 三种动作。

**诊断准确性**
- 串口未配 DCE 时钟导致链路 down 时，此前被误报为「VLAN/网关/路由配置不匹配」，
  现在明确提示「串口时钟未配置：R1:s1/0 —— 需要其中一端提供 DCE 时钟」。
- MAC 表指向错误端口时明确报「MAC 地址表错误：…记在 e1/0/1，但该口连接的是…」。

**其它**
- `ip address` 的缩写正则 `add(?:r|ess)?` 对 "address" 不回溯，导致
  **路由器物理口上配 IP 一直失败**（课程实验走 vlan 接口路径侥幸可用）。
- 延迟模型的跳数只统计「源设备直连的链路数」，与实际路径长度无关。
- `enable password` 未记录加密类型（0=明文 / 7=加密）。
- MSTP 配置模式下 `name <区域名>` 无任何处理。
- `show ip route` 有默认路由时不显示「Gateway of last resort」。
- ping 全超时时仍输出「来自 X 的回复」，应为「请求超时」。

### v1.2.0 修复的问题
- **IP 换算精度丢失**：`192.168.10.0` 曾被算成 `192.168.0.0`（整数乘法超过 2^31 后精度丢失），
  影响所有第三段 ≥ 8 的地址（DHCP 池、ACL 匹配、路由查找）
- **广播地址计算优先级错误**：`|` 优先于 `>>>`，导致 DHCP 地址池分配到 `.254` 而非 `.1`
- **PC 充当中继器**：转发路径中间的 PC 会把报文原路送回，
  绕过端口隔离、ACL 等所有二层安全机制
- **非法 IP 被判合法**：`1.1.1.1x` 会被 `parseInt` 宽松解析成 `1.1.1.1`
- **`set default` 不重置主机名**
- **模式切换残留状态**：`aclId` / `dhcpPool` 等在其它模式下未清理
- **DHCP 分配了网络地址/广播地址**
- `show spanning-tree` 在无生成树信息时崩溃
- `interface e1/0/1,3,5` 只生效第一个口（逗号列表被截断）
- `sh por-sec` 这类跨连字符缩写不识别
- MAC 表上限、老化时间、静态 MAC 绑定此前只存不生效，现已真实生效

### 测试
```powershell
node src\run-tests.js          # CLI 引擎单测（23 项）
node test\cmd-audit.js         # 命令审计（70 项）
node test\enterprise-test.js   # 企业级新功能（121 项）
node test\runtime-behavior-test.js  # 运行时行为（42 项）
node test\edge-case-test.js    # 边界与异常输入（56 项）
node test\advanced-feature-test.js  # ACL/VRRP/DHCP（78 项）
node test\consistency-test.js  # 多特性组合（43 项）
node test\factory-reset-test.js # 出厂重置完整性（22 项）
node test\ip-math-test.js      # IP 换算与位运算（33 项）
node test\cisco-parity-1-test.js # 思科对标：二层（83 项）
node test\cisco-parity-2-test.js # 思科对标：三层（62 项）
node test\cisco-parity-3-test.js # 思科对标：运维（72 项）
node test\cisco-parity-4-test.js # 思科对标：NAT/PBR/环路（53 项）
node test\cisco-parity-audit-test.js # 新增代码专项审计（20 项）
node test\mac-portsecurity-test.js # MAC 学习与端口安全（45 项）
node test\routing-protocol-test.js # MSTP/OSPF/RIP/静态路由（34 项）
node test\auth-portsec-test.js  # 认证与端口安全链路（50 项）
node test\ping-tracert-test.js  # ping/tracert 与延迟模型（36 项）
node test\labs-integrity-test.js # 16 个实验完整性（31 项）
node test\ui-regression-test.js # UI 回归（15 项）
cd test; npm install; cd ..    # jsdom 依赖（仅页面测试需要）
node test\answer-test.js       # 端到端（24 项）
```
共 1095 项自动化测试，全部通过。

### 图标许可
[Lucide](https://lucide.dev) Icons，ISC License。