## Digital China DCN Network Simulator v1.4.0

Command-line feedback, English diagnostics and laboratory address pre-configuration.

### Download

- `DCN-Network-Simulator-1.4.0-portable.exe` — single-file portable build for Windows 64-bit

### What's new in 1.4.0

- **VLAN feedback**: creating a VLAN prints `VLAN 10 created.`; adding ports answers port by port
  (`Port e1/0/1 added to VLAN 10.`) in both places it can be done — interface mode
  (`switchport access vlan 10`, including ranges) and VLAN mode (`switchport interface e1/0/1`, comma/semicolon lists).
- **English diagnostics**: about 70 error, usage and empty-state messages were translated from Chinese
  (`% Unknown command. Type ? for help.`, `% Invalid port. Example: ...`, `% Ambiguous command: ...`,
  broadcast-storm explanations, ACL / DHCP / route-map / OSPF usage lines and empty-state `show` output).
- **Laboratory address pre-configuration**: loading a lab now seeds every PC with the address from the
  course report, so `ipconfig` shows IP / subnet mask / gateway immediately. Labs 12–16 share the
  NET1216 plan (192.168.1.11–.12, 192.168.0.1, 192.168.20.x, 192.168.30.x).
- **VLAN default names**: new VLANs are auto-named (`default` for VLAN 1, `VLAN0010` style otherwise)
  and appear in `show vlan`.
- **`ipconfig`**: always prints IP address, subnet mask and gateway.
- **`show interface`**: now a real per-port report — description, MAC, access/trunk mode with PVID and
  VLAN name, duplex/speed/flow-control, spanning-tree state and counters; `show interface` without a
  port lists every port, and the duplicated `trunk trunk` label is fixed.
- **English `show` output**: `show version`, `show device-info`, `show clock`, `show vtp` and
  `show ip rip` no longer contain Chinese text.

### Verification

- `node src/run-tests.js` → 23 passed / 0 failed
- `node ../simtest/run-dcn-tests.js` → 1250 passed / 0 failed across 37 test files (new `test/dcn-feedback-test.js`, 29 checks)
- `node ../simtest/dcn-audit-cycle1.js` / `dcn-audit-cycle2.js` / `dcn-audit-lab-ips.js` → all clean
- Portable build `DCN-Network-Simulator-1.4.0-portable.exe`, `--selftest` all green

## Digital China DCN Network Simulator v1.3.0（历史版本）

A Packet Tracer-style network simulator for the "Digital China (神州数码) DCN" device family.
All commands, prompts and parameter values follow the course PPT slides and laboratory reports verbatim.

[中文说明](#中文说明)

### Download

- `DCN-Network-Simulator-1.3.0-portable.exe` — single-file portable build for Windows 64-bit

The file requires no installation. On first launch it extracts to a temporary directory, which takes
approximately 30 seconds; the application window appears only after extraction completes.
The executable is not code-signed, therefore Windows SmartScreen may report an unknown publisher.
Select "More info" → "Run anyway" to proceed.

### Included features

- **All 16 course laboratory scenarios**, each with step-by-step guidance and a one-click reference configuration.
- **Complete DCN command set** with unique-prefix abbreviation (`conf t`, `int e1/0/1`, `swi mode acc`,
  `sh run`), TAB completion, contextual `?` assistance and command history.
- **Cisco-equivalent feature set**, implemented on top of the DCN device model: VTP, STP/MSTP
  enhancements (PortFast, BPDU Guard, BPDU Filter, Root Guard), EtherChannel load balancing,
  secondary addresses, DHCP relay, proxy ARP, AAA with TACACS+/RADIUS/SNMPv3, route maps, UDLD and 802.1X.
- **Enterprise layer-2 security**: DHCP snooping, IGMP snooping, dynamic ARP inspection, port isolation,
  QoS priority and loop guard.
- **Layer-3 capability**: standard and extended ACL, VRRP, NAT, static and default routes, RIP and
  multi-area OSPF.
- **Realistic behaviour**: per-path latency model, broadcast storm simulation, port mirroring,
  link aggregation and terminal-based port security.

### Corrections made in this release

The following defects were identified and resolved. Each item affected observable behaviour in the
laboratory exercises.

1. **Spanning tree failed to block redundant paths in rings of three or more switches.** The previous
   implementation only resolved parallel links between the same pair of switches; a ring spanning three
   switches left every port in the forwarding state. STP has been rewritten as a standard spanning-tree
   construction: breadth-first search from the root bridge, root ports oriented towards the root, and
   redundant links blocked at the end furthest from the root. This restores laboratory 10 (STP/MSTP).

2. **The MAC address table was never populated through frame forwarding.** The learning routine was
   defined and exported but never invoked on the forwarding path, so `show mac-address-table` remained
   empty and the forwarding behaviour described in laboratory 2 could not be reproduced. Source MAC
   addresses are now learned on ingress, and the forwarding decision follows the standard
   known-unicast/unknown-multicast model.

3. **Access control lists had no effect on routers.** Evaluation was implemented only on the layer-2
   path, leaving ACLs on routers — the primary deployment scenario — without effect. Layer-3
   ingress evaluation has been added.

4. **Layer-3 switches could not forward at layer 2 without an SVI address.** A layer-3 switch
   without a matching route discarded frames instead of forwarding them within the VLAN broadcast
   domain. Forwarding now falls back to layer 2 when no layer-3 route applies.

5. **Dynamic routing did not satisfy laboratory 15 (RIP) and laboratory 16 (OSPF).** The previous
   implementation learned every directly connected subnet of every neighbour, without regard to the
   interface on which an advertisement was received and without propagating learned routes. Routing
   has been rewritten as a standard distance-vector computation: advertisements are evaluated per
   interface, routes are accepted only when the distance improves, and learned routes are propagated
   between routers. The propagation follows the procedure prescribed in the laboratory 15 report.

6. **Port security never detected a violation.** The previous condition did not compare the number of
   learned addresses against the configured maximum. Detection has been reimplemented, supporting the
   `shutdown`, `protect` and `restrict` violation modes.

7. **The user interface corrupted the MAC address table.** Two code paths recorded the source MAC
   address against the first port of every switch, regardless of the actual connection. Entries
   therefore pointed to incorrect ports and unidirectional communication failed.

8. **Port speed, UDLD and 802.1X were configurable but had no effect.** Speed now influences path
   latency, UDLD renders a link unusable when the configured rates or duplex settings disagree across
   the link, and 802.1X blocks traffic on ports that have not completed authentication.

9. **The `ip address` abbreviation never matched the full keyword.** The pattern `add(?:r|ess)?`
   does not backtrack and therefore matched only `addr`, so an IP address could not be assigned to a
   physical router interface.

10. **A missing DCE clock on a serial link was reported as a VLAN or routing misconfiguration.**
    The diagnostic now identifies the affected interfaces and states that one end must provide the
    clock via `physical-layer speed 64000`.

11. **Laboratory 12 targeted an incorrect interface.** The second task referenced R2-G0/0, which the
    layer-3 switch reaches by routing and which is therefore reachable, contradicting the stated
    objective. The target has been changed to R2-S1/1 in accordance with the laboratory report.

### Verification

The automated test suite comprises 1250 assertions covering end-to-end verification of all 16
laboratory scenarios, CLI command auditing, forwarding-path behaviour, boundary and malformed
input handling, user interface interaction and index consistency, and routing protocol correctness.
All assertions pass.

### Project

Source code, issue tracker and additional documentation:
<https://github.com/furryxuantao/dcn-switchport>

### Iconography

Interface icons are derived from [Lucide](https://lucide.dev) (ISC License).

---

<a name="中文说明"></a>
## 神州数码 DCN 网络模拟器 v1.4.0

本版聚焦「敲完命令有反馈、报错看得懂、实验一载入就能通」：

- **VLAN 生效反馈**：`vlan 10` 回车后回显 `VLAN 10 created.`；两条加端口路径都会逐口回显
  `Port e1/0/1 added to VLAN 10.` —— 接口模式 `switchport access vlan 10`（支持 `int e1/0/1-4` 范围）
  与 VLAN 模式 `switchport interface e1/0/1`（支持 `;`、`,` 列表）；非法端口回 `% Invalid port: xxx`。
- **报错与用法全部英文**：约 70 条中文提示换成英文（未知命令、端口不存在、模式误用、参数越界、
  ACL / DHCP / route-map / OSPF 用法行、`show` 空态、广播风暴解释等），便于和真实设备/考题对照。
- **载入实验自动配好电脑 IP**：按实验报告写入每台 PC 的 `ipconfig`（IP / 子网掩码 / 网关），
  双击电脑直接能 ping；lab12–16 共用 NET1216 地址规划。
- **VLAN 自动命名**：VLAN 1 为 `default`，其余 `VLAN0010` 四位补零。
- **`ipconfig`** 固定输出 IP / 子网掩码 / 网关三行。

验证：`node src/run-tests.js` 23 通过；`simtest/run-dcn-tests.js` 1245 通过（37 个测试文件）；打包 exe 自检全绿。

---

## 神州数码 DCN 网络模拟器 v1.3.0（历史版本）

面向神州数码 DCN 设备系列的网络实验模拟器，交互形态参照思科 Packet Tracer。
全部命令、提示符与参数取值严格对照本课程 PPT 与实验报告。

### 下载

- `DCN-Network-Simulator-1.3.0-portable.exe` — Windows 64 位单文件绿色版

无需安装。首次启动时解压至临时目录，耗时约 30 秒，窗口在解压完成后才会出现。
程序未做代码签名，Windows SmartScreen 可能提示"未知发布者"，请选择"更多信息"→"仍要运行"。

### 功能范围

- **16 个课程实验**全部内置，每个实验均提供分步指导与一键标准答案。
- **完整 DCN 命令集**，支持唯一前缀缩写（`conf t`、`int e1/0/1`、`swi mode acc`、`sh run`）、
  TAB 补全、上下文 `?` 提示与命令历史。
- **思科对标能力**，均基于 DCN 设备模型实现：VTP、生成树增强（PortFast、BPDU Guard、
  BPDU Filter、Root Guard）、链路聚合负载分担、辅助地址、DHCP 中继、代理 ARP、
  AAA（TACACS+/RADIUS/SNMPv3）、路由映射、UDLD、802.1X。
- **企业级二层安全**：DHCP Snooping、IGMP Snooping、动态 ARP 检测、端口隔离、QoS 优先级、环路保护。
- **三层能力**：标准与扩展 ACL、VRRP、NAT、静态路由与默认路由、RIP、多区域 OSPF。
- **行为仿真**：按路径长度计算链路时延、广播风暴模拟、端口镜像、链路聚合、终端侧端口安全。

### 本版修复的问题

以下缺陷均已在实际实验场景中产生可观察影响，逐项修复如下。

1. **生成树无法阻断三台及以上交换机构成的环路。** 原实现仅能处理同一对设备之间的并行链路，
   三台交换机成环时全部端口保持转发状态，实验 10（STP/MSTP）的核心场景无法复现。
   已重写为标准生成树构建：从根桥广度优先搜索，根端口朝向根桥，冗余链路在远离根桥的一端阻断。

2. **MAC 地址表在转发过程中从不学习。** 学习函数虽已定义并导出，但转发路径从未调用，
   `show mac-address-table` 始终为空，实验 2 描述的转发行为无法演示。
   现已在入端口学习源 MAC，转发决策按"已知单播优先、未知泛洪"的标准模型执行。

3. **访问控制列表在路由器上不生效。** 判定逻辑仅实现在二层路径，而路由器上的 ACL 才是主要用途。
   已补充三层入向判定。

4. **三层交换机未配置虚接口 IP 时二层转发亦中断。** 无匹配路由时设备直接丢弃报文，
   而真机仍应按 VLAN 广播域转发。现改为无三层路由时回退至二层转发。

5. **动态路由不满足实验 15（RIP）与实验 16（OSPF）的要求。** 原实现会学习每个邻居的全部直连网段，
   既不区分接收通告的接口，也不传递已学到的路由。已重写为标准距离向量计算：按接口判定通告来源，
   仅在距离更优时接受路由，并在路由器之间传递已学路由，传递方式依实验 15 报告所载流程执行。

6. **端口安全从未检出违例。** 原判定条件实际含义为"未配置静态 MAC 且 max≤0"才判违例，
   从未校验已学习地址数量是否超出上限。已重新实现，支持 `shutdown`、`protect`、`restrict` 三种处置方式。

7. **用户界面污染 MAC 地址表。** 两处代码将源 MAC 记录到每台交换机的第一个端口，
   与实际连线无关，导致表项指向错误端口，单向通信中断。

8. **端口速率、UDLD 与 802.1X 虽可配置却不影响转发。** 现端口速率参与时延计算；
   UDLD 在链路两端速率或双工不一致时判定链路不可用；802.1X 在端口未完成认证时阻断业务。

9. **`ip address` 缩写无法匹配完整关键字。** 模式 `add(?:r|ess)?` 不回溯，实际仅匹配到 `addr`，
   导致路由器物理口始终无法配置 IP 地址。

10. **串口缺少 DCE 时钟被误报为 VLAN 或路由配置问题。** 现可准确指出涉及的接口，
    并说明需由一端通过 `physical-layer speed 64000` 提供时钟。

11. **实验 12 的验证目标选择有误。** 第二个任务原指向 R2-G0/0，该接口可经三层交换机的路由到达，
    与任务文字所述的验证目的不符。已依据实验报告改为 R2-S1/1。

### 验证

自动化测试共 1250 项断言，覆盖 16 个实验的端到端验证、CLI 命令审计、转发路径行为、
边界与异常输入处理、用户界面交互与索引一致性、路由协议正确性，全部通过。

### 项目地址

源码、问题反馈与补充文档：<https://github.com/furryxuantao/dcn-switchport>

### 图标许可

界面图标取自 [Lucide](https://lucide.dev)，采用 ISC 许可协议。