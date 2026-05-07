# WebOps (Project Ouroboros) 开发指南

**版本**: 3.0 (Agent Injected Closed Loop)
**演进法则**: 沉积式 (Sedimentary Accumulation) - 优先追加接口，历史意图严格驻留，只增不减。

**核心哲学**: "Code is Context. The runtime is the sole source of visual truth."

**使命**: 将不可观测的物理触感、逻辑状态与音画表现，转化为可度量、可验证、具备因果关联的工程指标。

---

## 1. 系统架构 (The Trinity)

WebOps 模拟数字神经系统，前端感知 → 后端诊断形成完整闭环。
*注：V3.0 架构在 V2 基础上，叠加了“无侵入全局沙箱（Agent Injection）”层，实现了物理代码隔离。*

```text
┌─ Headless Browser (e.g., Chromedp / Playwright) ───────────┐
│  ┌──────────────────────────────────────────────────────┐  │
│  │ Target Web App (React / Vue / Vanilla / 3D WebGL)    │  │
│  └──────────────────────────────────────────────────────┘  │
│         ▲ (V3.0: Zero-Code Sandbox Injection)              │
│  ┌─ webops-agent.js (Injected Global Sandbox) ──────────┐  │
│  │ Sensing          Orchestration        Diagnosis      │  │
│  │ ┌────────────┐   ┌───────────────┐    ┌────────────┐ │  │
│  │ │ DOM Runtime│   │ TimelineExec  │    │ Topology   │ │  │
│  │ │ VirtualCh  │◀──│ ATP Protocol  │    │ Checker    │ │  │
│  │ │ AudioRT    │   │ Mock Isolate  │    └────────────┘ │  │
│  │ └─────┬──────┘   └───────────────┘                   │  │
│  │       │ Unified Frame & Markers                      │  │
│  │       ▼                                              │  │
│  │  __OUROBOROS_TUNNEL__ (Exposed by Go Backend)        │  │
│  └──────────────────────────────────────────────────────┘  │
└───────────────────────┬────────────────────────────────────┘
                        │ POST (Streaming to Redis)
                        ▼
┌─ Backend (Go Agent) ───────────────────────────────────────┐
│  [Ingest] ──▶ [Redis] ──▶ [Analysis Engine] ──▶ [LLM]      │
└────────────────────────────────────────────────────────────┘

```

### 1.1 感知 (Sensing - The Nerve Endings)

**DOM Runtime** (`DOMTelemetryRuntime`)：60fps 物理采样。通过 `MutationObserver` 自动发现带有 `data-vt-id` 的元素，监控位移、缩放、层级（Rank）及视觉权重（Weight）。支持 `data-vt-watch` 声明式监控 CSS 属性（rotation、scale、opacity 等）。在每帧采样中自动检查 `isConnected`，剔除已被框架卸载的残留节点（惰性清理）。

**Virtual Channel** (`VirtualChannelManager`)：逻辑信道。提供 `pushMetric`（原子推送）、`pushAggregated`（OHLC 直传）、`pushBatch`（批量推送）三种 API。内置环形缓冲区（上限 200 帧）保障传输可靠性——当隧道未就绪时暂存数据，就绪后自动补发。支持 Standalone 模式独立运行，也支持被 `DOMTelemetryRuntime` 在 `flush` 时合流收割（`harvest`）。

**Audio Runtime** (`AudioTelemetryRuntime`)：听觉采样。捕捉 RMS 能量与 Peak 峰值。使用 `pushAggregated` 直传 OHLC 到 Virtual Channel，避免二次聚合丢失极值（`@fix Case_Double_Aggregation`）。采样率 10Hz，与视觉采样对齐。
*(V3.0 演进：通过 Monkey Patching 自动劫持全局 `AudioContext`，不再强制要求业务端手动 attach)*。

**Visual Attention Model** (`VisualAttentionModel`)：视觉物理引擎。根据面积、位置（高斯衰减模拟中心视觉）、透明度和 z-index 计算元素的绝对视觉权重。算法版本 v2.0 Stable。

### 1.2 编排 (Orchestration - The Motor Cortex)

**ATP 协议** (`TimelineExecutor`)：动作时间轴协议。支持 `CLICK`、`TYPE`、`SCROLL`、`WAIT` 等动作类型，按 `offset_ms` 精确编排。内置 `mock_context` 实现网络副作用隔离——场景执行期间劫持 `window.fetch`，结束后硬恢复原始引用（`@fix Case_Fetch_Leak`）。
*(V3.0 演进：底层事件派发由 `MouseEvent` 升级为 `PointerEvent`，以支持 3D WebGL 和 React Three Fiber 的射线检测 Raycaster)*。

**Intent Markers**：在动作流中注入因果标记（如 `CLICK_PAY`），通过 Virtual Channel 以高精度信号 (`pushMetric('__markers__', name, 1.0)`) 写入遥测流。自动注入 `__SCENARIO_START__`、`__SCENARIO_END__`、`__SCENARIO_ERROR__` 生命周期标记。

### 1.3 诊断 (Diagnosis - The Frontal Lobe)

包含前端客户端诊断（拓扑契约 `TopologyChecker`）与后端服务端诊断（相关性分析、音画同步检测、健康评分）。详细规则见后文第 8 节。

---

## 2. 数据协议 (Data Protocol)

### 2.1 统一 K 线 (Universal K-Line)

所有信号通过 `AggregatedMetric`（前端）/ `Metric`（后端）结构聚合：
包含 `O` (Open), `H` (High), `L` (Low), `C` (Close), `Cnt` (Sample Count)。后端提供 `IsEmpty()`（检查哨兵值）和 `Activity()`（返回 `(H-L) + |C-O|`，即波动范围加趋势变化）方法。

> **哨兵值约定**：`DOMTelemetryRuntime` 使用 `-1` 作为空指标哨兵，`VirtualChannelManager` 使用 `null`。

### 2.2 多源合流 (Unified Telemetry Frame)

前端在每个 flush 周期（默认 100ms）自动调用 `harvest()`，将 DOM 物理数据与 Virtual/Audio 逻辑数据合并到同一帧 `TelemetryFrame`。帧的 `sources` 字段标记数据来源（`dom`、`virtual`、`audio`），最终通过 `window.__OUROBOROS_TUNNEL__` 发出。

---

## 3. 后端架构 (Go Backend)

* **Ingest (`POST /ouroboros/ingest`)**: 接收遥测帧，写入 Redis `usr/telemetry/stream:<UserID>` (TTL 2h)。如包含 `__markers__`，建立场景索引 `usr/telemetry/scenario:<UserID>:<ScenarioID>` (TTL 24h)。
* **Diagnose (`POST /ouroboros/diagnose`)**: 根据 `ScenarioID` 从 Redis 加载数据，执行 `AnalysisEngine` 全维分析。
* **AnalysisEngine**:
* **区间方差分析**：计算 Input (`__cursor__`, `__input__`) 与 Output 信号活跃度，根据 `ThresholdInputVar` (0.01) 和 `ThresholdOutputVar` (0.001) 裁决区间状态。
* **音画同步检测**：在关键动作 Marker (如 COLLISION, CLICK) 后 **300ms** 窗口内搜索 `peak_level`，依据 `ThresholdAudioPeak` (0.05) 裁决同步状态。



---

## 4. [V3.0 现行范式] 探针注入与 3D 物理引擎 (Agent Injection)

WebOps 现采用**无侵入式探针注入**。目标业务项目无需引入任何核心引擎代码（@solves Case_Zero_Code_Injection）。

### 4.1 编译与注入探针

在源码目录执行 Bun 打包：

```bash
bun build ./AgentEntryPoint.ts --outfile=./webops-agent.js --minify

```

在 Golang 后端通过 Chromedp 注入：

```go
// 1. 暴露数据接收隧道
chromedp.ExposeFunction("__OUROBOROS_TUNNEL__", func(payload string) { /* 写入 Redis */ }),
// 2. 页面加载前注入单体 JS
chromedp.AddScriptToEvaluateOnNewDocument(webopsAgentJsCode),
// 3. 启动探针
chromedp.Evaluate(`window.WebOps.start();`, nil),

```

### 4.2 WebGL / 3D 物理引擎追踪 (@solves Case_3D_Physical_Interaction)

对于不可见 DOM 的 3D 游戏 (如 React Three Fiber)，通过 `<Html>` 叠加层将 3D 坐标映射为 2D 探针追踪点。

```tsx
import { Html } from '@react-three/drei';

<Html transform>
  {/* 探针将实时捕捉该隐形 DOM 的屏幕二维物理坐标并发送给 Go Agent */}
  <div data-vt-id="radical_口" className="invisible-tracker" />
</Html>

```

### 4.3 编排测试剧本 (Choreography)

Go Agent 动态生成剧本，通过沙箱执行（利用 V3 升级的 `PointerEvent` 触发物理引擎拖拽）：

```javascript
await window.WebOps.choreography.execute({
    op: "EXECUTE_CHOREOGRAPHY",
    scenario_id: "solve_puzzle",
    strategy: "human_like",
    timeline: [
        { offset_ms: 0, action: "DRAG", params: { x: 200, y: 300, endX: 500, endY: 400 }, marker: "MERGE_START" }
    ]
});

```

---

## 5. [V2.0 历史地层] 声明式埋点与引擎侵入 (Intent Residency)

*(本节内容为 V2 遗留接口。在 V3 中，React 相关逻辑已剥离为独立的 `sdk/react-webops`，以防依赖倒置。出于“严格驻留”原则，保留此处文档以供回溯。)*

**1. 初始化引擎 (V2 强侵入方式)**

```typescript
import { DOMTelemetryRuntime } from './visual-telemetry';
const runtime = DOMTelemetryRuntime.getInstance();
runtime.start(); // SPA 路由卸载时调用 runtime.stop();

```

**2. 音频手动挂载 (V2 方式)**

```typescript
const audioRuntime = AudioTelemetryRuntime.getInstance();
audioRuntime.attach(audioCtx, masterGain); // V2 必须传入源节点，WebAudio 不支持反向遍历

```

**3. React 逻辑绑定 (现由 `react-webops` SDK 提供安全空转降级)**

* **基础 DOM 追踪**: `const props = useTrack('avatar', { watch: ['rotation'] });`
* **逻辑绑定**: `useSignalBinding('score', score, { strategy: 'onChange', threshold: 10 });`
* **高频引用 (Canvas)**: `const thrust = useSignalRef('engine', 'thrust', 0.01);`

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

### 7.1 交互相关性裁决 (后端/前端共用)

| 裁决 | 现象 | 含义 |
| --- | --- | --- |
| `HEALTHY` | Input/Output 方差均存在且相关 | 交互响应正常 |
| `NO_RESPONSE` | Input 方差高，Output 方差为 0 | UI 死锁——操作了但屏幕没反应 |
| `CHAOTIC` | Input/Output 方差均高，相关性低 | 交互逻辑错误——点 A 导致 B 乱跳 |
| `AUTONOMOUS` | 无 Input，Output 方差高 | 自主动画或定时器（通常无害） |
| `IDLE` | Input/Output 方差均低 | 空闲区间 |

### 7.2 音画同步裁决 (后端 AnalysisEngine)

| 裁决 | 条件 | 含义 |
| --- | --- | --- |
| `PASS` | 峰值 ≥ 5% 且延迟 ≤ 200ms | 音画同步正常 |
| `FAIL_SILENT` | 峰值 < 5% | 关键动作后静音（资源缺失或加载失败） |
| `FAIL_LAG` | 延迟 > 200ms | 音效反馈延迟过高（影响手感） |

### 7.3 拓扑违规契约 (前端 TopologyChecker)

| 契约类型 | 含义 |
| --- | --- |
| `STRICT_ORDER` | A > B > C 严格顺序被打破 |
| `PARTIAL_ORDER` | A > B 相对顺序被打破 |
| `TOP_N` | 关键元素未在前 N 名可见性排序中 |
| `NEVER_BELOW` | A 被 B 遮挡（如 Modal 被 Mask 遮挡） |

---

## 8. 文件结构与地层分布

依据 V3.0 解耦原则，核心引擎与业务 SDK 已物理分离：

```text
SysEvoV2/
├── webops/                              # 后端 (Go)
│   ├── dto.go, store.go, api.go, analysis.go
├── typescript/                          # 探针核心引擎 (Vanilla TS) -> 打包目标
│   ├── AgentEntryPoint.ts               # [V3.0 入口] 全局探针封装 (window.WebOps)
│   ├── TelemetryPayloadSchema.ts        
│   ├── DOMTelemetryRuntime.ts           
│   ├── VirtualChannelManager.ts         
│   ├── AudioTelemetryRuntime.ts         
│   ├── orchestration/
│   │   └── TimelineExecutor.ts          
│   └── diagnosis/
│       ├── MarkerAlignmentAnalyzer.ts   
│       └── TopologyChecker.ts           
│   ├── react/                           # [DEPRECATED CORPSE] 
│   │                                    # 历史尸体：原强耦合 React 代码，已被移除以避免依赖倒置。
└── sdk/
    └── react-webops/                    # [V3.0 新生] 独立的轻量级 React SDK
        ├── hooks.ts                     # 仅包含针对 window.WebOps 的安全空转调用
        ├── components.tsx               
        └── index.ts                     

```

---

**"If it moves, track it. If it matters, mark it. If it fails, correlate it."** —— *Project Ouroboros Manifest*
