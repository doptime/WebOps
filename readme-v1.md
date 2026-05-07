# WebOps (Project Ouroboros) 开发指南

**版本**: 2.4 (Full-Stack Closed Loop)

**核心哲学**: "Code is Context. The runtime is the sole source of visual truth."

**使命**: 将不可观测的物理触感、逻辑状态与音画表现，转化为可度量、可验证、具备因果关联的工程指标。

---

## 1. 系统架构 (The Trinity)

WebOps 模拟数字神经系统，前端感知 → 后端诊断形成完整闭环：

```
┌─ Frontend (TypeScript) ────────────────────────────────────┐
│  Sensing          Orchestration        Diagnosis (Client)  │
│  ┌────────────┐   ┌───────────────┐    ┌────────────────┐  │
│  │ DOM Runtime│   │ TimelineExec  │    │ TopologyChecker│  │
│  │ VirtualCh  │──▶│ ATP Protocol  │    │ (Client-side)  │  │
│  │ AudioRT    │   │ Mock Isolate  │    └────────────────┘  │
│  └─────┬──────┘   └───────┬───────┘                        │
│        │  Unified Frame   │ Markers                        │
│        ▼                  ▼                                 │
│   __OUROBOROS_TUNNEL__ (JSON)                               │
└────────────────────┬───────────────────────────────────────┘
                     │ POST /ouroboros/ingest
                     ▼
┌─ Backend (Go) ─────────────────────────────────────────────┐
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────┐  │
│  │ Ingest   │──▶│ Redis Store  │──▶│ AnalysisEngine    │  │
│  │ Endpoint │   │ Stream+Index │   │ Variance/Corr/AV  │  │
│  └──────────┘   └──────────────┘   └─────────┬─────────┘  │
│                                               │            │
│                POST /ouroboros/diagnose ───────▼            │
│                                        DiagnoseRes         │
└────────────────────────────────────────────────────────────┘
```

### 1.1 感知 (Sensing - The Nerve Endings)

**DOM Runtime** (`DOMTelemetryRuntime`)：60fps 物理采样。通过 `MutationObserver` 自动发现带有 `data-vt-id` 的元素，监控位移、缩放、层级（Rank）及视觉权重（Weight）。支持 `data-vt-watch` 声明式监控 CSS 属性（rotation、scale、opacity 等）。在每帧采样中自动检查 `isConnected`，剔除已被框架卸载的残留节点（惰性清理）。

**Virtual Channel** (`VirtualChannelManager`)：逻辑信道。提供 `pushMetric`（原子推送）、`pushAggregated`（OHLC 直传）、`pushBatch`（批量推送）三种 API。内置环形缓冲区（上限 200 帧）保障传输可靠性——当隧道未就绪时暂存数据，就绪后自动补发。支持 Standalone 模式独立运行，也支持被 `DOMTelemetryRuntime` 在 `flush` 时合流收割（`harvest`）。提供 `pruneStaleSignals` 方法清理超时信号。

**Audio Runtime** (`AudioTelemetryRuntime`)：听觉采样。挂载到 `AudioContext`，通过 `AnalyserNode` 捕捉 RMS 能量与 Peak 峰值。使用 `pushAggregated` 直传 OHLC 到 Virtual Channel，避免二次聚合丢失极值（`@fix Case_Double_Aggregation`）。采样率 10Hz，与视觉采样对齐。

**Visual Attention Model** (`VisualAttentionModel`)：视觉物理引擎。根据面积、位置（高斯衰减模拟中心视觉）、透明度和 z-index 计算元素的绝对视觉权重。算法版本 v2.0 Stable。

**生命周期保护**：`stop()` 会断开 `MutationObserver`、取消 `requestAnimationFrame`、清空注册表，确保 SPA 路由切换或压测停止后无资源泄露。

### 1.2 编排 (Orchestration - The Motor Cortex)

**ATP 协议** (`TimelineExecutor`)：动作时间轴协议。支持 `CLICK`、`TYPE`、`SCROLL`、`WAIT` 等动作类型，按 `offset_ms` 精确编排。内置 `mock_context` 实现网络副作用隔离——场景执行期间劫持 `window.fetch`，结束后硬恢复原始引用（`@fix Case_Fetch_Leak`）。

**Intent Markers**：在动作流中注入因果标记（如 `CLICK_PAY`），通过 Virtual Channel 以高精度信号 (`pushMetric('__markers__', name, 1.0)`) 写入遥测流。自动注入 `__SCENARIO_START__`、`__SCENARIO_END__`、`__SCENARIO_ERROR__` 生命周期标记（`@fix Case_Headless_Hang`）。

### 1.3 诊断 (Diagnosis - The Frontal Lobe)

诊断分为前端客户端诊断与后端服务端诊断两层：

**前端诊断**：

- **相关性分析** (`MarkerAlignmentAnalyzer`)：按 Marker 切分时间区间，提取 Input/Output 信号序列，计算方差与 Pearson 相关系数。自动裁决五种状态。
- **拓扑契约** (`TopologyChecker`)：验证 DOM 层级正确性。支持四种契约类型，内置帧容差机制。

**后端诊断** (`AnalysisEngine`, Go)：

- **区间方差分析**：从 Redis 加载场景帧数据，按 Marker 切分区间，计算 Input/Output 信号方差并裁决。
- **音画同步检测**：在关键动作 Marker（含 COLLISION、EXPLOSION、CLICK 等关键词）后 300ms 窗口内搜索音频能量峰值，判定是否存在静音或延迟。
- **健康评分**：综合区间裁决与音画同步结果，输出 0-100 健康分。

---

## 2. 数据协议 (Data Protocol)

### 2.1 统一 K 线 (Universal K-Line)

所有信号通过 `AggregatedMetric`（前端）/ `Metric`（后端）结构聚合：

```
前端 TypeScript                    后端 Go
─────────────────                  ─────────────────
AggregatedMetric {                 Metric {
    o: number | null               O   float64 `json:"o"`
    h: number | null               H   float64 `json:"h"`
    l: number | null               L   float64 `json:"l"`
    c: number | null               C   float64 `json:"c"`
    cnt?: number                   Cnt int     `json:"cnt,omitempty"`
}                                  }
```

后端 `Metric` 提供两个便捷方法：`IsEmpty()`（检查哨兵值 `-1`）和 `Activity()`（返回 `(H-L) + |C-O|`，即波动范围加趋势变化，作为信号活跃度的度量）。

> **哨兵值约定**：`DOMTelemetryRuntime` 使用 `-1` 作为空指标哨兵，`VirtualChannelManager` 使用 `null`。后端 `Metric.IsEmpty()` 以 `-1` 判定。两者在前端 `flush` 合流时自动对齐，后端消费者使用 `IsEmpty()` 即可。

### 2.2 统一遥测帧 (Unified Telemetry Frame)

前端帧结构与后端 DTO 的映射：

```
前端 TelemetryFrame               后端 TelemetryReq
─────────────────                  ─────────────────
ts: number                         Timestamp int64       `json:"ts"`
dur?: number                       Duration  int         `json:"dur"`
sources: string[]                  Sources   []string    `json:"sources"`
data: Record<string,               Data      map[string]
      ElementTelemetry>                      *ElementData `json:"data"`

                                   // 后端注入字段（框架自动填充）
                                   UserID    string      `json:"@@sub"`
                                   ClientIP  string      `json:"@@remoteAddr"`
```

每个节点 `ElementData` 包含：`W`（视觉权重）、`R`（注意力位序）、`Attrs`（属性/信号字典，对应前端的 `a` 字段）。DOM 元素通常携带 `W` 和 `R`，Virtual/Audio 信号仅携带 `Attrs`。

### 2.3 多源合流

`DOMTelemetryRuntime` 在每个 flush 周期（默认 100ms）自动调用 `VirtualChannelManager.harvest()`，将 DOM 物理数据与 Virtual/Audio 逻辑数据合并到同一帧。帧的 `sources` 字段标记了数据来源（`dom`、`virtual`、`audio`），帮助后端快速路由。最终帧通过 `window.__OUROBOROS_TUNNEL__` 或 `window.telemetryTunnel` 发出。

---

## 3. 后端架构 (Go Backend)

### 3.1 文件结构

```
webops/
├── dto.go        # 数据传输对象（前后端协议映射）
├── store.go      # Redis 存储层（Stream + Scenario Index）
├── api.go        # API 端点（Ingest + Diagnose）
└── analysis.go   # 核心诊断引擎（方差/相关性/音画同步）
```

### 3.2 API 端点

**Ingest** (`POST /ouroboros/ingest`)：高吞吐数据接收。接收前端发送的 `TelemetryReq` 帧，写入 Redis 原始数据流。如帧包含 `__markers__` 数据，额外建立场景索引以支持后续按场景诊断。

```
请求体: TelemetryReq (JSON)
响应体: { "Status": "ok" }
```

**Diagnose** (`POST /ouroboros/diagnose`)：按需诊断。根据 `ScenarioID` 从 Redis 场景索引加载帧数据，执行全维分析，返回诊断报告。

```
请求体: { "scenario_id": "purchase_flow" }
响应体: DiagnoseRes (JSON)
```

### 3.3 Redis 存储设计

```
Key Pattern                                  TTL     用途
───────────────────────────────────────      ─────   ────────────────────
usr/telemetry/stream:<UserID>                2h      原始数据流（分析后即焚）
usr/telemetry/scenario:<UserID>:<ScenarioID> 24h     场景索引（按场景快速提取）
```

两个 Key 均使用 `redisdb.NewListKey` 定义，支持 `RPush`（追加）和 `LRange`（范围读取）操作。`TelemetryStreamKey` 的 `@sub` 占位符由框架自动注入用户 ID；`ScenarioIndexKey` 通过 `SetArgs(scenarioID)` 动态填充场景 ID。

### 3.4 诊断引擎 (AnalysisEngine)

`AnalysisEngine` 是后端核心，执行三层分析：

**第一层：Marker 提取**。遍历所有帧，从 `__markers__` 节点提取语义标记点，按时间排序。Marker 的时间戳存储在 `Metric.C`（Close 值）中。

**第二层：区间方差分析**。按相邻 Marker 切分时间区间（忽略 < 50ms 的极短区间），对每个区间：

1. 提取 Input 信号（`__cursor__`、`__input__`）的活跃度序列
2. 自动检测 Output 信号（排除 `__` 前缀的系统信号）的活跃度序列
3. 计算两组序列的方差与相关系数
4. 根据阈值裁决

配置阈值（可注入）：

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `ThresholdInputVar` | 0.01 | Input 信号被认定为"活跃"的最小方差 |
| `ThresholdOutputVar` | 0.001 | Output 信号被认定为"有响应"的最小方差 |
| `ThresholdAudioPeak` | 0.05 | 音频能量被认定为"有声"的最小峰值（0-1 RMS） |

**第三层：音画同步检测**。扫描所有 Marker，对名称中包含关键词（`COLLISION`、`EXPLOSION`、`SUCCESS`、`FAIL`、`CLICK`）的标记，在其后 300ms 窗口内搜索 `__system__/audio` 节点的 `peak_level`（或 `energy_rms`）峰值。裁决三种结果：

| 裁决 | 条件 | 含义 |
| --- | --- | --- |
| `PASS` | 峰值 ≥ 阈值 且 延迟 ≤ 200ms | 音画同步正常 |
| `FAIL_SILENT` | 峰值 < 阈值 | 关键动作后静音 |
| `FAIL_LAG` | 峰值 ≥ 阈值 但 延迟 > 200ms | 音效反馈延迟过高 |

**健康评分**：`Score = max(0, 100 - (fails / total) * 50)`，其中 `fails` 包含 `NO_RESPONSE` 区间数和非 `PASS` 的音画同步事件数。

### 3.5 诊断报告结构 (DiagnoseRes)

```json
{
    "scenario_id": "purchase_flow",
    "score": 85.0,
    "intervals": [
        {
            "name": "CART_ADD -> CHECKOUT",
            "duration": 500,
            "input_var": 0.032,
            "output_var": 0.018,
            "correlation": 0.72,
            "verdict": "HEALTHY",
            "message": ""
        },
        {
            "name": "PAY_CLICK -> ANIMATION_DONE",
            "duration": 1000,
            "input_var": 0.045,
            "output_var": 0.0001,
            "correlation": 0.1,
            "verdict": "NO_RESPONSE",
            "message": "Deadlock detected: Input active but Output frozen"
        }
    ],
    "audio_sync": {
        "sync_events": [
            {
                "marker": "CLICK_PAY",
                "latency_ms": 85,
                "is_silent": false,
                "verdict": "PASS"
            }
        ]
    },
    "alerts": [
        "[PAY_CLICK -> ANIMATION_DONE] NO_RESPONSE: Deadlock detected: Input active but Output frozen"
    ]
}
```

---

## 4. 前端快速开始 (Frontend Guide)

### 4.1 初始化感知引擎

```typescript
import { DOMTelemetryRuntime } from './visual-telemetry';

const runtime = DOMTelemetryRuntime.getInstance();
runtime.start();

// SPA 路由卸载时
runtime.stop();
```

### 4.2 初始化音频感知

```typescript
import { AudioTelemetryRuntime } from './visual-telemetry/AudioTelemetryRuntime';

const audioCtx = new AudioContext();
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

const audioRuntime = AudioTelemetryRuntime.getInstance();
audioRuntime.attach(audioCtx, masterGain); // 必须传入源节点
audioRuntime.start();
```

### 4.3 声明式埋点 (React)

**基础 DOM 追踪**：

```tsx
import { useTrack } from './visual-telemetry';

function Avatar() {
    const props = useTrack('player_avatar', { watch: ['rotation', 'scale'] });
    return <div {...props} className="avatar">...</div>;
}
```

**逻辑信号绑定**：

```tsx
import { useSignalBinding } from './visual-telemetry';

function ScoreBoard({ score }) {
    useSignalBinding('game_score', score, { strategy: 'onChange', threshold: 10 });
    return <span>{score}</span>;
}
```

**批量绑定**：

```tsx
import { useSignalBindings } from './visual-telemetry';

function Player({ hp, mp, stamina }) {
    useSignalBindings('player', { hp, mp, stamina });
    return <div>...</div>;
}
```

**混合遥测**（DOM + Virtual）：

```tsx
import { useHybridTelemetry } from './visual-telemetry';

function GameEntity({ velocity }) {
    const { domProps, bindSignal } = useHybridTelemetry('entity', {
        watch: ['opacity', 'scale']
    });
    useEffect(() => { bindSignal('velocity', velocity); }, [velocity]);
    return <div {...domProps}>...</div>;
}
```

**高频引用**（游戏循环 / Canvas）：

```tsx
import { useSignalRef } from './visual-telemetry';

function Engine() {
    const thrust = useSignalRef('engine', 'thrust', 0.01);
    useFrame(() => { thrust.current = getEngineThrust(); });
    return null;
}
```

### 4.4 作用域嵌套

```tsx
import { TelemetryScope } from './visual-telemetry';

<TelemetryScope name="Game">
    <TelemetryScope name="Player">
        {/* useTrack('health_bar') → fullId = "Game/Player/health_bar" */}
        <HealthBar />
    </TelemetryScope>
</TelemetryScope>
```

### 4.5 纯逻辑信号推送（非 React）

```typescript
import { virtualChannel } from './visual-telemetry';

virtualChannel.pushMetric('game/player', 'health', 85);
virtualChannel.pushBatch('game/player', { health: 85, mana: 42, speed: 3.7 });
```

---

## 5. 编排测试剧本 (Choreography)

```typescript
import { choreography } from './visual-telemetry';

await choreography.execute({
    op: "EXECUTE_CHOREOGRAPHY",
    scenario_id: "purchase_flow",
    strategy: "human_like",
    timeline: [
        { offset_ms: 0,    action: "CLICK",  params: { target: "add_to_cart" }, marker: "CART_ADD" },
        { offset_ms: 500,  action: "CLICK",  params: { target: "checkout_btn" }, marker: "CHECKOUT" },
        { offset_ms: 1200, action: "TYPE",   params: { target: "#card-input", text: "4242..." } },
        {
            offset_ms: 2000,
            action: "CLICK",
            params: { target: "pay_btn" },
            marker: "PAY_CLICK",
            mock_context: {
                url_pattern: "/api/payment",
                response_body: { status: "success", order_id: "mock-001" },
                delay: 300
            }
        },
        { offset_ms: 3000, action: "WAIT", params: { timeout: 500 }, marker: "ANIMATION_DONE" }
    ]
});
```

`mock_context` 在场景执行期间劫持匹配的 fetch 请求，结束后自动恢复。通过 `choreography.abort()` 可中途终止。

---

## 6. 前端诊断 (Client-Side)

### 6.1 相关性分析

```typescript
import { diagnose } from './visual-telemetry';

frames.forEach(f => diagnose.ingest(f));
const report = diagnose.analyze('purchase_flow');
```

### 6.2 拓扑契约

```typescript
import { topology } from './visual-telemetry';

const checker = topology.create()
    .register(topology.contracts.modalAboveMask('modal_dialog', 'overlay_mask'))
    .register(topology.contracts.criticalActionVisible('pay_button'));

const violations = checker.check(frames);
```

---

## 7. 诊断裁决参考 (全维)

### 7.1 区间裁决（前后端共用）

| 裁决 | 现象 | 含义 |
| --- | --- | --- |
| `HEALTHY` | Input/Output 方差均存在且相关 | 交互响应正常 |
| `NO_RESPONSE` | Input 方差高，Output 方差为 0 | UI 死锁——操作了但屏幕没反应 |
| `CHAOTIC` | Input/Output 方差均高，相关性低 | 交互逻辑错误——点 A 导致 B 乱跳 |
| `AUTONOMOUS` | 无 Input，Output 方差高 | 自主动画或定时器（通常无害） |
| `IDLE` | Input/Output 方差均低 | 空闲区间 |

### 7.2 音画同步裁决（后端）

| 裁决 | 条件 | 含义 |
| --- | --- | --- |
| `PASS` | 峰值 ≥ 5% 且延迟 ≤ 200ms | 音画同步正常 |
| `FAIL_SILENT` | 峰值 < 5% | 关键动作后静音（资源缺失或加载失败） |
| `FAIL_LAG` | 延迟 > 200ms | 音效反馈延迟过高（影响手感） |

### 7.3 拓扑违规（前端）

| 契约类型 | 含义 |
| --- | --- |
| `STRICT_ORDER` | A > B > C 严格顺序被打破 |
| `PARTIAL_ORDER` | A > B 相对顺序被打破 |
| `TOP_N` | 关键元素未在前 N 名可见性排序中 |
| `NEVER_BELOW` | A 被 B 遮挡（如 Modal 被 Mask 遮挡） |

---

## 8. 文件结构

```
src/visual-telemetry/                    # 前端 (TypeScript)
├── index.ts                             # 公共 API 出口
├── TelemetryPayloadSchema.ts            # 数据协议定义
├── VisualAttentionModel.ts              # 视觉权重算法
├── DOMTelemetryRuntime.ts               # DOM 物理采样引擎
├── VirtualChannelManager.ts             # 虚拟信道（通用信号插座）
├── AudioTelemetryRuntime.ts             # 音频能量采样
├── react/
│   ├── contexts.ts                      # 共享 Context（解决循环引用）
│   ├── toolkit.tsx                      # TelemetryScope, useTrack, track
│   └── useSignalBinding.ts              # useSignalBinding, useSignalBindings,
│                                        # useHybridTelemetry, useSignalRef
├── orchestration/
│   └── TimelineExecutor.ts              # ATP 剧本执行器
└── diagnosis/
    ├── MarkerAlignmentAnalyzer.ts       # 相关性诊断引擎
    └── TopologyChecker.ts               # 拓扑契约检查器

webops/                                  # 后端 (Go)
├── dto.go                               # 数据传输对象（前后端协议映射）
├── store.go                             # Redis 存储层（Stream + Scenario Index）
├── api.go                               # API 端点（Ingest + Diagnose）
└── analysis.go                          # 核心诊断引擎（方差/相关性/音画同步）
```

---

## 9. 最佳实践

1. **最小侵入**：优先使用 `data-vt-id` 声明式埋点，避免修改业务逻辑。
2. **关注方差**：诊断系统的核心是"变化"。永远不动的元素不需要 `watch`。
3. **Marker 驱动**：编写 ATP 剧本时，在关键帧添加 `marker`。没有 Marker，就没有因果分析——前后端诊断引擎均依赖 Marker 切分时间区间。
4. **选择正确的 Hook**：离散状态用 `useSignalBinding`（onChange），连续物理量用 `useSignalRef`（everyFrame），混合场景用 `useHybridTelemetry`。
5. **作用域嵌套**：使用 `TelemetryScope` 构建 ID 层级，避免手动拼接路径。
6. **生命周期管理**：SPA 环境中务必在路由卸载时调用 `runtime.stop()`，音频运行时同理。
7. **Mock 隔离**：测试涉及网络副作用时，使用 ATP 的 `mock_context` 而非手动 Mock，确保自动恢复。
8. **音频节点传入**：`AudioTelemetryRuntime.attach()` 必须显式传入源节点（如 MasterGain），WebAudio 不支持反向遍历音频图。
9. **场景索引**：确保前端在遥测帧中携带 ScenarioID，以便后端建立场景索引，支持按需诊断。
10. **短期存储**：原始遥测流 TTL 为 2 小时（分析后即焚），场景索引 TTL 为 24 小时。长期存储需另行归档。

---

**"If it moves, track it. If it matters, mark it. If it fails, correlate it."** —— *Project Ouroboros Manifest*