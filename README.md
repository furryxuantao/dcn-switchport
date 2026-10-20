# 神州数码 DCN 网络模拟器（类 Packet Tracer）

**Digital China DCN Network Simulator** — a Packet Tracer-style simulator for the DCN device family,
with commands, prompts and parameter values aligned to the course PPT slides and laboratory reports.

<img src="assets/icon.png" width="96" align="right" alt="应用图标 / Application icon">

双击 `index.html` 即可使用，无需安装、无需联网。

Windows 用户可下载绿色单文件版 `DCN-Network-Simulator-<版本>-portable.exe`。

## 对照课程（E:\network\神码搭建）
| 实验 | 覆盖命令（神州数码 DCN / RGNOS） |
|------|------------------|
| 1 交换机初始配置 | `enable / config terminal / exit / show running-config / show startup-config / show flash / set default / write / reload / enable password 0|7 / hostname / language chinese\|english / show vlan / show ip interface brief / ping` |
| 2 以太网原理 | `show mac-address-table / show ip interface brief / ipconfig`（PC） |
| 3 端口安全 | `mac-address-learning cpu-control / interface e1/0/x / shutdown / no shutdown / switchport mode access / switchport port-security / switchport port-security maximum N / switchport port-security mac-address XX / switchport port-security violation shutdown [recovery N] / show port-security` |
| 4 VLAN | `vlan XX / name YYY / switchport interface e1/0/x / interface e1/0/x-y / switchport access vlan XX / switchport mode trunk / switchport trunk allowed vlan / show vlan` |
| 5 三层VLAN互通 | `interface vlan X / ip address A M / show ip route` |
| 6 Telnet | `interface vlan 1 / ip address / no shutdown / telnet-server enable / username xxx password 0\|7 yyy / no username / authentication securityip / telnet-server max-connection N / ping / telnet <ip>` |
| 7 SSH | `ssh-server enable / username / authentication securityip / ssh-server max-connection N` |
| 8 链路聚合 | `vlan / switchport mode trunk / port-group N / interface e1/0/1-4 / port-group N mode on\|active\|passive / show port-group brief / show vlan` |
| 9 端口镜像 | `monitor session ID source interface ... rx\|tx\|both / monitor session ID destination interface ... / show monitor / no monitor session` |
| 10 STP/MSTP | `spanning-tree / spanning-tree mode mstp / spanning-tree mst configuration / instance X vlan ... / exit / spanning-tree mst X priority Y / show spanning-tree` |
| 11 路由基础 | `enable / config terminal / interface g/s / show ip route / show running-config / write / delete / reboot / show ip interface brief` |
| 12 路由器IP | `show ip interface brief / show interface <name> / interface serial 1/0 / ip address / physical-layer speed 64000 / no shutdown` |
| 13 静态 | `ip route 目的网段 掩码 下一跳 [N] / show ip route / tracert` |
| 14 默认 | `ip route 0.0.0.0 0.0.0.0 下一跳 [N]`（备份默认路由带管理距离） |
| 15 RIP | 路由器：`router rip 1 / version 2 / auto-summary / interface g/s / ip rip 1 enable / passive-interface / show ip route`；三层：`router rip / network vlan X` |
| 16 OSPF | `router ospf N / router-id X.X.X.X / network 直连网段 掩码 area N / show ip route` |

> 提示符严格按 PPT：`switch> / switch# / switch(Config)# / switch(Config-if-...)# / Router(config)# / Router(config-if-...)# / Router(config_rip...)#`，
> 支持 `?` 帮助、`TAB` 补全、`↑↓` 历史、命令缩写（如 `swi / acc / int / conf t`）。

## 课程外的进阶功能（神州数码 DCS 企业级特性）

除了 16 个实验用到的命令，还实现了 DCS 系列真机常见的进阶特性，全部可用 `show` 验证，
部分（如**端口隔离**）会真实影响转发路径：

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| DHCP Snooping 防欺骗 | `ip dhcp snooping [vlan <列表> [rate <n>]]`、接口下 `ip dhcp snooping trust` | `show dhcp snooping` |
| IGMP Snooping 组播抑制 | `ip igmp snooping [version 2\|3]` | `show igmp snooping` |
| 动态 ARP 检测 DAI | `ip arp inspection vlan <列表>` | `show arp inspection` |
| 端口隔离 | 接口下 `switchport isolate group <n>` | `show port-isolate` |
| QoS 优先级 802.1p | 接口下 `switchport priority <0-7>` | `show qos priority` |
| 环路保护 | 全局 `switchport loop-guard enable`、接口下 `loop-guard enable` | `show loop-guard` |
| 静态 MAC 绑定 | `mac-address static <MAC> interface <端口>` | `show mac-address static` |
| MAC 表管理 | `mac-address aging-time <秒>`、`mac-address maximum <条>` | `show mac aging` |
| LLDP 邻居发现 | `lldp enable` | `show lldp` |
| SNMP | `snmp-server community <串> ro`、`snmp-agent sys-contact/sys-location <串>` | `show snmp` |
| 镜像调试 | `debug mirror` | — |

所有命令同样支持唯一前缀缩写，例如 `ip dhcp s`、`ip arp i vlan 10`、`swi isolate g 1`、
`swi prio 6`、`mac-address aging-t 600`、`sh dhcp s`、`sh mac a`。

**端口隔离是真实生效的**：把两台 PC 接入都开了 `switchport isolate group` 的端口后，
`ping` 会返回「端口隔离阻断」，`diagnoseFail` 会指名是哪两个口。

## 三层与网关类功能

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| ACL 访问控制列表 | `ip access-list extended <编号>` → `seq <n> permit\|deny <协议> <源> <目的> [eq <端口>] [log]`、接口下 `ip access-group <编号> in` | `show access-lists` |
| VRRP 网关冗余 | 接口下 `vrrp <组号> ip <虚IP>`、`vrrp <组号> priority <1-254>` | `show vrrp` |
| DHCP 服务器 | `service dhcp`、`ip dhcp pool <名>` → `network`/`default-router`/`dns-server`/`lease`/`range`、`ip dhcp excluded-address` | `show ip dhcp pool`、`show ip dhcp binding` |

**ACL 会真实阻断流量**：把 `deny` 规则应用到接口后，对应源/目的网段的 `ping` 会返回
「ACL 阻断：报文 x → y 被 ... 拒绝（deny）」，不在规则内的流量放行。

**ACL 地址写法为反掩码**（与真机一致）：`192.168.1.0 0.0.0.255` 表示整个 /24。

## 思科对标增强（设备仍为神州数码 DCS）

在课程命令之外，额外实现了思科 IOS 上企业网常用的功能，命令语法对齐思科：

### 二层

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| VTP VLAN 集中管理 | `vtp mode server\|client\|transparent`、`vtp domain <名>`、`vtp version <1\|2\|3>`、`vtp pruning` | `show vtp`、`show vtp status` |
| 边缘口 PortFast | 接口下 `spanning-tree portfast`、全局 `spanning-tree portfast default` | `show spanning-tree detail` |
| BPDU Guard | 接口下 `spanning-tree bpduguard` | 同上 |
| BPDU Filter | 接口下 `spanning-tree bpdufilter` | 同上 |
| 根守卫 | 接口下 `spanning-tree guard root`、全局 `spanning-tree guard root` | 同上 |
| 生成树计时器 | `spanning-tree forward-time\|hello-time\|max-age <秒>` | 同上 |
| 聚合负载分担 | `port-group <n> load-balance src-dst-mac` | `show etherchannel load-balance` |
| 聚合最小链路 | `port-group <n> min-links <n>` | `show etherchannel summary` |
| 端口速率/双工 | 接口下 `speed <10\|100\|1000>`、`duplex <auto\|full\|half>`、`negotiation auto` | `show interfaces status` |
| 端口描述 | 接口下 `description <文本>` | 同上 |
| 风暴抑制 | 接口下 `storm-control broadcast level <n>` | 同上 |
| UDLD | 接口下 `udld enable` | 同上 |
| 802.1X | 接口下 `dot1x port-control auto` | 同上 |

**VTP 真实生效**：server 上 `vlan N` + `name X` 会发布到 VTP 库，同域的 client
调用 `vtpSync` 时自动学到这些 VLAN；`transparent` 模式不学习，不同域不同步。

**BPDU Guard 真实生效**：接入口若连着启用了生成树的交换机，会被判为收到 BPDU，
端口自动置为 error-disable 并 shutdown，`ping` 返回「BPDU Guard：…已自动 shutdown」。

### 三层

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| 辅助地址 | 接口下 `ip address <IP> <掩码> secondary` | `show ip interface` |
| DHCP 中继 | 接口下 `ip helper-address <服务器IP>` | `show ip helper` |
| 代理 ARP | 接口下 `proxy arp`、全局 `ip proxy-arp` | `show ip proxy-arp` |
| RIP 增强 | `router rip` 下 `timers update\|invalid\|hold\|flush <秒>`、`no poison-reverse`、`no split-horizon`、`default-information originate` | `show ip rip` |
| OSPF 增强 | `router ospf` 下 `auto-cost reference-bandwidth <Mbit>`、`log-adjacency-changes`、`default-information originate [always]`、`area <id>` | `show ip ospf` |
| 静态路由 | — | `show ip route static` |

**辅助地址真实生效**：会生成直连路由、可被 ping 通，并出现在 `show ip interface` 中。

### 设备管理与运维

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| 系统信息 | — | `show version`、`show device-info` |
| 日志 syslog | `logging host <IP>`、`logging trap <级别>`、`no logging` | `show logging` |
| 时钟与 NTP | `clock timezone <±时区>`、`ntp server <IP>` | `show clock` |
| AAA | `aaa new-model`、`aaa authentication login <local\|tacacs\|radius>` | `show aaa` |
| TACACS+/RADIUS | `tacacs-server host <IP>`、`radius-server host <IP>` | `show aaa` |
| SNMPv3 | `snmp-server user <名> <组> auth sha <密钥>` | — |
| 用户特权级 | `username <名> privilege <0-15> <0\|7> <口令>` | `show users` |
| 登录横幅 | `banner motd <文本>` | — |
| 配置寄存器 | `config-register <值>` | `show version` |
| 密码恢复 | `service password-recovery` | — |
| 命令历史 | `history size <条数>` | — |

### NAT / 策略路由 / 环路检测

| 功能 | 配置命令 | 查看命令 |
|------|----------|----------|
| NAT 地址转换 | 接口下 `ip nat inside` / `ip nat outside`、全局 `ip nat pool <名> <起> <止>`、`ip nat overload`、`ip nat inside source list <ACL>` | `show ip nat` |
| 策略路由 | `route-map <名> permit <序号>` → `match <条件>` / `set <下一跳>` | `show route-map` |
| 二层环路检测 | `loop-detect enable`、`loop-detect threshold <n>` | `show loop-detect` |

**NAT 真实生效**：内网地址经 inside 口进入后会被转换成地址池中的公网地址，
同一内网地址复用同一转换，地址池耗尽则不再转换；`ip nat inside source list <ACL>`
可限定只转换匹配 ACL 的流量。

**二层环路检测真实生效**：MAC 在端口间反复漂移达到阈值即告警并中断转发，
`ping` 返回「二层环路告警：MAC … 在端口间反复漂移（疑似环路）」。

## 目录
- `index.html` 入口（拓扑画布 + CLI 终端 + 测试清单 + 抓包）
- `src/sim-core.js` 转发/路由/MAC/STP/聚合/镜像/安全仿真（无 DOM，可 node 单测）
- `src/cli-engine.js` DCN 命令解析与执行（无 DOM，可 node 单测）
- `src/labs.js` 16 个实验一键拓扑 + 预设 + 测试清单
- `src/ui.js` 画布、动画、终端 UI
- `styles.css` 深色高颜值主题

## Python 环境说明
本项目主体为免构建纯前端（双击即用，不污染全局）。
仓库内仅课程文本提取脚本使用 Python，且已按要求使用 `uv venv` 隔离：
`E:\network\.venv`，用 `uv pip install --python .venv\Scripts\python.exe ...` 安装，
未污染全局 conda 环境。

## 交互与动画
- 终端：行内输入（提示符后直接敲），TAB 补全、↑↓ 历史、Ctrl+C/L/U/A/E、`?` 联想；4 套预设主题 + 三色自定义 + 字号，localStorage 记忆
- 画布：拖空白平移、滚轮缩放（30%~200%）、⤾ 自适应；单击选中、双击进 CLI、Delete 删除
- 连线：思科式「选线型 → 点源设备选端口 → 点目标设备选端口」，7 种线型（自动/直通/交叉/光纤/Console/DCE/DTE），端口占用与类型不兼容会提示
- 动画：逐跳报文（ICMP 请求+应答）、链路流光、端口 LED 随流量闪、STP 收敛时 BLK 红闪 / FWD 绿闪并飘字、广播风暴环路跑包、端口镜像紫包复制
- 状态实时刷新（500ms）：端口 LED/状态牌/风暴条/路由概览原地更新，不用敲回车
- 一键标准答案：按实验报告参数表真实配出可通网络（12~16 含 IP/时钟/静态/默认/RIP/OSPF），23 项端到端 ping 验证

## 快速验证（node 单测）

无需构建依赖即可跑大部分测试：

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
node src\run-tests.js       # CLI 引擎 23 项
node test\cmd-audit.js      # 命令审计 70 项
node test\enterprise-test.js # 企业级新功能 121 项
node test\runtime-behavior-test.js # 运行时行为（安全特性是否真生效）42 项
node test\edge-case-test.js # 边界与异常输入 56 项
node test\advanced-feature-test.js # ACL/VRRP/DHCP 78 项
node test\consistency-test.js # 多特性组合 43 项
node test\factory-reset-test.js # 出厂重置完整性 22 项
node test\ip-math-test.js   # IP 换算与位运算 33 项
node test\cisco-parity-1-test.js # 思科对标：二层增强 83 项
node test\cisco-parity-2-test.js # 思科对标：三层增强 62 项
node test\cisco-parity-3-test.js # 思科对标：运维管理 72 项
node test\cisco-parity-4-test.js # 思科对标：NAT/PBR/环路检测 53 项
node test\cisco-parity-audit-test.js # 新增代码专项审计 20 项
node test\mac-portsecurity-test.js # MAC 学习与端口安全 45 项
node test\routing-protocol-test.js # MSTP/OSPF/RIP/静态路由 34 项
node test\auth-portsec-test.js  # 认证与端口安全链路 50 项
node test\ping-tracert-test.js  # ping/tracert 与延迟模型 36 项
node test\labs-integrity-test.js # 16 个实验完整性 31 项
node test\latency-storm-test.js
```

共 1095 项自动化测试，全部通过。

跑无头页面测试（载入实验、点击交互、标准答案端到端）需要 jsdom：

```powershell
cd test
npm install                 # 只装 jsdom 一个依赖
cd ..
node test\answer-test.js    # 端到端 24 项
node test\link-flow-test.js
node test\click-test.js
node test\lab-health.js     # 17 个实验载入体检
```

Electron 真机自检（必须在 `electron/` 目录执行）：

```powershell
cd electron
npm install
npx electron . --selftest --no-sandbox
```

## 打包 exe（Electron）
```powershell
cd electron
npm install
npm start    # 开发运行
npm run dist # 产出 release\DCN网络模拟器-1.0.0-绿色版.exe（单文件免安装）
```
