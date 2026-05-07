# WebOps (Project Ouroboros) 开发指南

**版本**: 3.1 (Semantic Spatial Tracking & Autonomous Agent)
**演进法则**: 沉积式 (Sedimentary Accumulation) - 优先追加接口，历史意图严格驻留，只增不减。

**核心哲学**: "Code is Context. The runtime is the sole source of visual truth."

**使命**: 将不可观测的物理触感、逻辑状态与音画表现，转化为可度量、可验证、具备因果关联的工程指标。

---

## 1. 系统架构 (The Trinity)

WebOps 模拟数字神经系统，前端感知 → 后端诊断形成完整闭环。
*注：V3.1 架构在 V3.0 基础上，彻底废弃了显式 ID 埋点，引入了基于“语义哈希 + Morton Code 空间索引”的多目标视觉追踪技术；同时废弃了 Redis 网络流，实现了完全的本地内存自治闭环，与后端语言彻底解耦。*

```text
┌─ Headless Browser (e.g., Node Playwright / Go Chromedp) ───┐
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Target Web App (React / Vue / Vanilla / 3D WebGL)    │  │
│  └──────────────────────────────────────────────────────┘  │
│         ▲ (V3.1: Zero-Code Sandbox Injection & Tracking)   │
│  ┌─ webops-agent.js (Injected Global Sandbox) ──────────┐  │
│  │ Sensing          Orchestration        Diagnosis      │  │
│  │ ┌────────────┐   ┌───────────────┐    ┌────────────┐ │  │
│  │ │ DOM Runtime│   │ TimelineExec  │    │ Topology   │ │  │
│  │ │ VirtualCh  │◀──│ ATP Protocol  │    │ Checker    │ │  │
│  │ │ AudioRT    │   │ Mock Isolate  │    └────────────┘ │  │
│  │ └─────┬──────┘   └───────────────┘                   │  │
│  │       │ Unified Frame & Markers                      │  │
│  │       ▼                                              │  │
│  │  [Local Autonomous Analyzer] ──▶ JSON Report         │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────┬────────────────────────────────────┘
                        │ Sync Return (JS Evaluate)
                        ▼
┌─ Any Backend (Go / Python / Node / LLM Agent) ─────────────┐
│  [Browser Host] ──▶ [Report Parser] ──▶ [LLM Evaluator]    │
└────────────────────────────────────────────────────────────┘
```

### 1.1 感知 (Sensing - The Nerve Endings)

**DOM Runtime** (`DOMTelemetryRuntime`)：60fps 物理采样。**[V3.1 核心升级] 彻底废弃 `data-vt-id` 与 `data-vt-watch`。** 通过 `MutationObserver` 自动嗅探页面显著元素，提取语义特征（文本、类名、SVG拓扑）生成短哈希。结合 Morton Code (Z-Order) 一维空间索引与历史快照池，实现无侵入的跨渲染帧实体追踪（Object Permanence）。

**Virtual Channel** (`VirtualChannelManager`)：逻辑信道。提供 `pushMetric`、`pushAggregated`、`pushBatch` 三种 API。支持 Standalone 模式独立运行，也支持被 `DOMTelemetryRuntime` 收割合流。

**Audio Runtime** (`AudioTelemetryRuntime`)：听觉采样。捕捉 RMS 能量与 Peak 峰值。

**Visual Attention Model** (`VisualAttentionModel`)：视觉物理引擎。根据面积、位置、透明度和 z-index 计算元素的绝对视觉权重。

### 1.2 编排 (Orchestration - The Motor Cortex)

**ATP 协议** (`TimelineExecutor`)：动作时间轴协议。支持 `CLICK`、`TYPE`、`DRAG`、`WAIT` 等动作类型，按 `offset_ms` 精确编排。
*(V3.0 演进：底层事件派发由 `MouseEvent` 升级为 `PointerEvent`，以支持 3D WebGL 和 React Three Fiber 的射线检测 Raycaster)*。

### 1.3 诊断 (Diagnosis - The Frontal Lobe)

包含前端客户端诊断（拓扑契约 `TopologyChecker`）与内部自治全维分析（`MarkerAlignmentAnalyzer`）。详细规则见后文第 7 节。

---

## 2. 数据协议 (Data Protocol)

### 2.1 统一 K 线 (Universal K-Line)

所有信号通过 `AggregatedMetric` 结构聚合：包含 `O` (Open), `H` (High), `L` (Low), `C` (Close)。

### 2.2 多源合流 (Unified Telemetry Frame)

前端在每个 flush 周期（默认 100ms）自动合并 DOM 物理数据与 Virtual/Audio 逻辑数据，最终推入本地自治分析器进行结算。

---

## 3. 宿主集成架构 (Host Integration)

*注：V3.1 架构已彻底重构通信闭环。为消除网络 IO 延迟，原有的 Redis 依赖与网络流式传输已被废弃。现采用**语言无关的本地自治模式 (Local Autonomous Mode)***。

* **[V3.1 现行] 宿主同步闭环**: 无论是 Go(Playwright)、Node(Puppeteer) 还是 Python(Selenium)，宿主只需通过无头浏览器注入 `webops-agent.js`，下发 `ATP` 剧本。前端沙盒内部拦截并摄入物理与逻辑帧，执行完毕后通过 `JS Evaluate` 直接返回同步的 JSON 格式 `DiagnosisReport` 供大模型使用。
* **[V2.0 历史地层] Ingest (`POST /ouroboros/ingest`)**: *(已废弃)* 接收遥测帧，写入 Redis。
* **[V2.0 历史地层] Diagnose (`POST /ouroboros/diagnose`)**: *(已废弃)* 根据 ScenarioID 从 Redis 加载数据分析。

---

## 4. [V3.1 现行范式] 语义追踪、环境监听与无痕编排

WebOps 现采用**完全无侵入式探针注入与零埋点追踪**。目标业务项目无需引入任何核心引擎代码，也无需硬编码任何 ID。

### 4.1 探针注入与启动环境监听

探针注入后，大模型或宿主程序需要先**“观察环境”**，探针会自动扫描所有视觉显著的元素（DOM 或被 `<Html>` 映射的 WebGL 元素），并为它们分配**语义空间 ID**。

```javascript
// 1. 在浏览器注入编译好的探针
await page.addInitScript({ path: './webops-agent.js' });

// 2. 导航并唤醒探针
await page.goto('http://localhost:3000/lesson/484');
await page.evaluate(`window.WebOps.start();`);

// 3. 【核心步骤】静默观察环境，获取当前可操作实体的坐标字典
const envStateJSON = await page.evaluate(`
    () => {
        // 探针会自动提取语义和空间索引
        const state = {};
        document.querySelectorAll('[data-ouroboros-id]').forEach(el => {
            const rect = el.getBoundingClientRect();
            state[el.getAttribute('data-ouroboros-id')] = {
                x: Math.round(rect.x + rect.width/2),
                y: Math.round(rect.y + rect.height/2)
            };
        });
        return JSON.stringify(state);
    }
`);
// 返回示例: { "m9j2kq_0": {x: 100, y: 200}, "m9j2kq_1": {x: 500, y: 300} }
```

### 4.2 零埋点语义 ID 约定规则 (The Object Permanence)

在 V3.1 中，大模型操控元素的唯一凭证是探针自动生成的 `data-ouroboros-id`（即上述返回字典的 Key）。
该 ID 的生成规则为：`[语义短哈希]_[空间排序索引]`。

* **语义推断 (Semantic Hash)**: 探针会尝试读取元素的 `innerText`（如 "火"）、特征 `class`（如 `radical-entity`），或者组件类型（如 `svg`）。它将这些语义特征压缩为一个稳定的 Base36 短哈希（如 `m9j2kq`）。
* **空间索引 (Morton Code)**: 为了区分屏幕上两个长得一模一样的元素（孪生兄弟问题），探针通过 Z-Order 曲线将元素的 `(x, y)` 坐标降维，并按照空间接近度分配后缀编号 `_0`, `_1`。

**优势**：即使 React 刷新了 DOM，只要元素在相近的位置且语义一致，探针就能瞬间将其与前世身份匹配（实体转世绑定），大模型永远不会面临“DOM 失效抓空”的问题。

### 4.3 基于语义 ID 的动作编排 (Choreography)

大模型根据 `envStateJSON` 了解到环境后，生成 ATP 时间轴剧本。剧本中不再使用脆弱的 DOM Selector 或硬编码 ID，而是直接使用 `target: "[语义短哈希]_[空间排序索引]"`。

宿主将剧本下发给探针执行：

```javascript
const reportJSON = await page.evaluate(`
    async () => {
        return await window.WebOps.runScenario({
            scenario_id: "E2E_MERGE_TEST",
            strategy: "human_like",
            timeline: [
                { 
                    offset_ms: 0, 
                    action: "DRAG", 
                    params: { 
                        target: "m9j2kq_0",   // 探针自动嗅探到的对象 A
                        endX: 500,            // 对象 B 的 X 坐标
                        endY: 400             // 对象 B 的 Y 坐标
                    }, 
                    marker: "MERGE_START" 
                },
                { 
                    offset_ms: 2000, 
                    action: "WAIT", 
                    params: { timeout: 1000 } 
                }
            ]
        });
    }
`);
```
*执行完毕后，`runScenario` 会自动停止记录，调用内部 `MarkerAlignmentAnalyzer` 进行结算，并直接返回 `reportJSON`。*

---

## 6. 前端客户端诊断 (Client-Side Topology)

支持在前端验证 DOM 静态层级结构：

```typescript
import { topology } from './visual-telemetry';
const checker = topology.create()
    .register(topology.contracts.modalAboveMask('modal_dialog', 'overlay_mask'))
    .register(topology.contracts.criticalActionVisible('pay_button'));
const violations = checker.check(frames);
```

---

## 7. 诊断裁决标准库 (Verdict Dictionary)

### 7.1 交互相关性裁决 (内部 Analyzer 生成)

| 裁决 | 现象 | 含义 |
| --- | --- | --- |
| `HEALTHY` | Input/Output 方差均存在且相关 | 交互响应正常 |
| `NO_RESPONSE` | Input 方差高，Output 方差为 0 | UI 死锁——操作了但屏幕没反应 |
| `CHAOTIC` | Input/Output 方差均高，相关性低 | 交互逻辑错误——点 A 导致 B 乱跳 |
| `AUTONOMOUS` | 无 Input，Output 方差高 | 自主动画或定时器（通常无害） |
| `IDLE` | Input/Output 方差均低 | 空闲区间 |

### 7.2 音画同步裁决

| 裁决 | 条件 | 含义 |
| --- | --- | --- |
| `PASS` | 峰值 ≥ 5% 且延迟 ≤ 200ms | 音画同步正常 |
| `FAIL_SILENT` | 峰值 < 5% | 关键动作后静音（资源缺失或加载失败） |
| `FAIL_LAG` | 延迟 > 200ms | 音效反馈延迟过高（影响手感） |

---

## 8. 文件结构与地层分布

依据 V3.0 解耦原则，核心引擎与业务 SDK 已物理分离：

```text
SysEvoV2/
├── webops/                              # 后端 - [V3.1 精简: 已移除 Redis Ingest 与流处理]
│   ├── dto.go, api.go                   
├── typescript/                          # 探针核心引擎 (Vanilla TS) -> 打包目标
│   ├── AgentEntryPoint.ts               # [V3.0 入口] 全局探针封装 (window.WebOps)
│   ├── TelemetryPayloadSchema.ts        
│   ├── DOMTelemetryRuntime.ts           # [V3.1 核心重构] 无痕语义追踪与空间绑定
│   ├── VirtualChannelManager.ts         
│   ├── AudioTelemetryRuntime.ts         
│   ├── orchestration/
│   │   └── TimelineExecutor.ts          # [V3.1] 基于 data-ouroboros-id 的新版驱动
│   └── diagnosis/
│       ├── MarkerAlignmentAnalyzer.ts   # [V3.1 下沉] 本地内存全维分析器
│       └── TopologyChecker.ts           
└── sdk/
    └── react-webops/                    # [V3.0 新生] 独立的轻量级 React SDK
```

---

**"If it moves, track it. If it matters, mark it. If it fails, correlate it."** —— *Project Ouroboros Manifest*
```