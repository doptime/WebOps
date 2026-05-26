# WebOps V5 — Go-Authored Inline Scripts

> "One call. Full session. LLM-ready. Scripts live with their tests."

V5 把 V4.1 的"TS 端剧本注册 + HTTP 服务"模型收敛为"Go 端直接用 builder 拼脚本,通过 chromedp tab 内联送进浏览器"。结果是:

- **测试脚本与意图同处一处**:每个 scenario 的 `hypothesis` / `intent` / `tags` 与它的步骤实现都在同一个 Go 函数里,agent 读一个文件就能看到全貌。
- **框架代码大幅瘦身**:删除 HTTP 服务 (`webops.go`)、删除 TS 端 registry/describe/register、删除独立 examples TS 文件,~1200 行 → 新增 ~830 行,净减 ~30%。
- **保留全部探针、压缩、analyzer、双入口、`?webops=1` 闸门**:telemetry 一行未改,生产用户依然零侵入。

---

## 目录

- [V5 改了什么](#v5-改了什么)
- [文件清单](#文件清单单层级)
- [一分钟接入](#一分钟接入三步)
- [端到端流程](#端到端流程)
- [并发模型(铁律)](#并发模型铁律)
- [生产安全(双入口 + 动态 import)](#生产安全双入口--动态-import)
- [Go Script DSL 完整参考](#go-script-dsl-完整参考)
- [Predicate 词汇表](#predicate-词汇表)
- [ValueSource 词汇表](#valuesource-词汇表)
- [意图三层结构](#意图三层结构)
- [完整剧本范例](#完整剧本范例)
- [组件接入(TypeScript 侧不变)](#组件接入typescript-侧不变)
- [Go 库 API](#go-库-api)
- [LLMPayload 结构](#llmpayload-结构)
- [V4.1 → V5 迁移指南](#v41--v5-迁移指南)
- [FAQ / 排错](#faq--排错)

---

## V5 改了什么

| 维度 | V4.1 | V5 |
|---|---|---|
| 测试脚本所在地 | TS 文件 (`examples--xxx--scripts.ts`) | Go 文件 (`coffee_cloze_test.go` 等) |
| 脚本如何到浏览器 | TS 文件 import 进 Bootstrap → `webops.register(id, build)` → Go 调 `WebOps.run(id)` | Go builder 产 JSON IR → `chromedp.Evaluate("window.WebOps.runInline(IR)")` |
| Go 后端 | 独立 HTTP server (`webops.go`),3 个端点 | 库 (`webops/webops.go`),调用方直接 import |
| TS 端 registry / describe / register | 都有 | **全删** |
| Bootstrap 复杂度 | 4-10 行 register | 1 行 `await import('@/webops')` |
| 调试开关 | `?webops=1` | **不变** |
| Telemetry / 压缩 / analyzer | — | **一行未改** |
| 双入口 (`@/webops/runtime` 静 + `@/webops` 动) | — | **不变** |

---

## 文件清单(单层级)

```
webops-v5/
├── README.md                                  ← 本文件
├── package.json
├── tsconfig.json
│
├── agent.ts                                   ← V5 改: ~30 行,只剩 runInline 入口
├── runtime.ts                                 ← 不动
├── index.ts                                   ← V5 改: 小改,删 Script 导出
│
├── core--kline.ts                             ← 不动
├── core--visual-attention.ts                  ← 不动
├── core--virtual-channel.ts                   ← 不动
├── core--dom-telemetry.ts                     ← 不动
├── core--audio-telemetry.ts                   ← 不动
├── core--r3f-bridge.ts                        ← 不动
│
├── script--Script.ts                          ← V5 改: 瘦身为类型定义
├── script--ir.ts                              ← V5 新增: IR + compileIR
├── script--actions.ts                         ← 不动
│
├── session--SessionRunner.ts                  ← 不动
│
├── report--compress.ts                        ← 不动
├── report--analyzer.ts                        ← 不动
├── report--ReportBuilder.ts                   ← 不动
│
├── react--useTrack.ts                         ← 不动
├── react--zustand-telemetry.ts                ← 不动
│
└── webops/
    └── webops.go                              ← V5 新增: Go 库,IR + builder + chromedp + LLM
```

**已删除(对比 V4.1):**
- `webops.go`(独立 HTTP server,功能搬入库)
- `examples--*--scripts.ts`(全部剧本搬到 Go)

---

## 一分钟接入(三步)

### Step 1. Next.js 配两个 alias(与 V4.1 一致)

```js
// next.config.mjs
import path from 'path';
export default {
  webpack: (config) => {
    // 完整入口:仅在审计路径动态 import,产出独立 chunk,生产用户不下载
    config.resolve.alias['@/webops'] = path.resolve('./webops-v5/agent.ts');
    // 轻量入口:游戏组件静态 import,生产 bundle 只多 ~5KB 且无副作用
    config.resolve.alias['@/webops/runtime'] = path.resolve('./webops-v5/runtime.ts');
    return config;
  }
};
```

### Step 2. Bootstrap 简化为一行 import

V5 不再 `register()` — Go 端每次 navigate 后直接 inline 送脚本。Bootstrap 只负责把 `window.WebOps` 挂上。

```tsx
'use client';
import { useEffect } from 'react';
import { shouldEnableWebOps } from '@/webops/runtime';

export function WebOpsBootstrap() {
  useEffect(() => {
    if (!shouldEnableWebOps()) return;
    // 动态 import,把 window.WebOps.runInline 挂载。无脚本注册。
    import('@/webops');
  }, []);
  return null;
}
```

`shouldEnableWebOps()` 的判定与 V4.1 一致:
1. URL 含 `?webops=1` → 激活(Go chromedp 走这条)
2. `process.env.NODE_ENV === 'development'` → 激活(本地手动 audit 方便)
3. 否则不激活

### Step 3. 游戏组件三处接入(与 V4.1 完全一致)

```tsx
import { withTelemetry, useTrack } from '@/webops/runtime';   // ← 注意是 /runtime
import { create } from 'zustand';

// (1) store 用 withTelemetry 包
const useGameStore = create<S>()(
  withTelemetry({
    targetId: 'game',
    enums: { status: { playing: 0, gameover: -1, victory: 1 } },
    skip: ['cards']                                            // 大对象用 skip 避免序列化爆炸
  })((set, get) => ({ /* normal store */ }))
);

// (2) 关键 UI 元素加 vt-id
function ClassifyButtons() {
  const acute = useTrack('btn_acute',  { watch: ['opacity'] });
  return <button {...acute} onClick={...}>Acute</button>;
}

// (3) R3F 对象可选挂 userData.signals
<mesh
  name="card_xyz"
  userData={{ signals: { angle: data.angle, typeCode: ANGLE_CODE[data.type] } }}
/>
```

**`window.useGameStore` 暴露**:V5 的 Go builder 通过 `useGameStore.getState()` 访问状态(在 `state_eq` 等谓词内),所以 dev/audit 模式下需要把 store 挂到 window:

```tsx
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as any).useGameStore = useGameStore;
}
```

如果用别的 store 名,在 Go builder 的 IR 里改 `store` 字段(默认 `"useGameStore"`)。

---

## 端到端流程

```
[Go: coffee_cloze_test.go]                   [Headless Chrome tab]            [Next.js 应用]
                                                                              (已 import @/webops)

scenarios := buildScenarios()
  // 5 个 Scenario,每个带 ID/Hypothesis/Intent/Tags/Script
                                                                                    │
webops.Audit(ctx, AuditRequest{...})                                                │
  │                                                                                 │
  │ ensureBrowser(concurrency)                                                      │
  │                                                                                 │
  │ for each scenario (fan-out, sem-bounded):                                       │
  │   ┌── runOneInline(scenario.Script):                                            │
  │   │   chromedp.Navigate(url + "?webops=1")  ───────►   Bootstrap                │
  │   │                                                     ├ shouldEnableWebOps    │
  │   │                                                     └ await import('@/webops')
  │   │   chromedp.Poll(window.WebOps.runInline) ◄─────── 挂载 WebOpsAgent           │
  │   │                                                                              │
  │   │   evaluate `window.WebOps.runInline({...IR}, {...})`                         │
  │   │                                       │                                      │
  │   │                                       ▼  compileIR → CompiledScript          │
  │   │                                       ▼  runSession(script) → SessionReport  │
  │   │                                       ▼  buildLLMPayload → LLMPayload        │
  │   │   ◄────── LLMPayload JSON string ─────┘                                      │
  │   └── close tab                                                                  │
  │                                                                                  │
  └─ aggregate → callLLMBatch (1 次跨场景判决) → AuditResult                          │
       │                                                                              │
       ▼  perScenario verdicts + crossScenarioFindings + rootCauses                   │
                                                                                      │
打印 verdict / 按 -strict 决定 exit code / 进 -fix loop                                │
```

---

## 并发模型(铁律)

**1 次 page navigation = 1 个 scenario,永远**。

理由:游戏状态、AudioContext、R3F scene、Zustand store 都是 tab 内全局单例。即使写 reset 也会留 monkey-patched 原型链、监听器残留、R3F canvas 句柄变化等隐患。

并发只发生在 tab 维度:

- 一个长寿命 Chrome 进程(共享 `ExecAllocator`),首次 `Audit` 时懒启动
- 每个 scenario 开**新 tab**(`chromedp.NewContext(sharedAlloc)`),tab 之间 storage / cookie / window 完全隔离
- 信号量 `sem` 卡死同时打开的 tab 数(默认 8,可在 `AuditRequest.Concurrency` 覆盖)
- **tab 数与 scenario 数完全解耦**:8 worker 跑 20 scenario 排两轮多;4 worker 跑 4 scenario 一轮跑完

TS 侧的 `runSession` 加了 in-flight 锁:同一 tab 内并发调用直接抛异常,而不是数据静默串台。这是防御性设计 — 正常的 V5 部署模型一个 tab 只跑一次 session。

---

## 生产安全(双入口 + 动态 import)

V5 沿用 V4.1 的双入口架构,生产用户不下载任何审计代码。

| 入口 | 何时加载 | 内容 | 体积(gzipped) |
|---|---|---|---|
| `@/webops/runtime` | 静态,组件 import | `useTrack` / `withTelemetry` / `shouldEnableWebOps` | ~5KB |
| `@/webops` | 动态,Bootstrap 命中闸门时 `await import` | `webops` 单例 + IR 编译器 + SessionRunner + ReportBuilder + 6 个 core 探针 | ~25-30KB |

### 链路

```
[Go: chromedp.Navigate(url + "?webops=1")]
        ↓
[chromedp tab 加载页面]
        ↓ Bootstrap 跑 → shouldEnableWebOps() → true
        ↓ await import('@/webops')   ← 此刻才下载审计 chunk
        ↓ window.WebOps.runInline 挂载就绪
        ↓ Go 调 WebOps.runInline(scriptJSON, metaJSON) ✓

[真用户: 直接访问 url(无 query)]
        ↓ Bootstrap 跑 → shouldEnableWebOps() → false
        ↓ 直接 return,await import 永不发生
        ↓ 审计 chunk 永不下载
        ↓ window.WebOps 不存在
        ↓ 生产 bundle 只多 useTrack/withTelemetry 的 ~5KB stub(且无副作用)
```

### 关于 Go 侧

`auditParam = "webops=1"` 在 `webops/webops.go` 里写死成常量。要换名字(改成更隐蔽的串挡偶然访客),修改两个常量:

```
webops/webops.go     const auditParam = "..."
runtime.ts           shouldEnableWebOps({ param: '...', value: '...' })
```

故意采用"成对源码改动"而不是 flag 配置:联动改动用 grep 一眼能审,flag 形式容易出现"一边改了一边没改"的悄悄不一致。

---

## Go Script DSL 完整参考

### 入口

```go
import "yourorg/webops-v5/webops"

s := webops.Script("scenarioId").
    Strategy("human_like").              // "human_like" | "instant"
    Timeout(120_000).                    // session 硬超时(ms)
    ContinueOnExpectFail(true).          // expect 失败是否继续(默认 true)
    // ...动作链...
    Build()                              // 返回 InlineScript
```

### 动作类

| 方法 | 用途 | 必填参数 | 可选 Opts |
|---|---|---|---|
| `Click(target, opts...)` | 单击 | `Target` | `Mark`, `Mode`, `Intent` |
| `Drag(from, to, opts...)` | 拖拽,适合 R3F/Rapier 物理交互 | `Target, Target` | `Duration`, `Mark`, `Intent` |
| `Type(text, opts...)` | 在 focused 元素输入文本 | `string` | `ClearFirst`, `Mark`, `Intent` |
| `Key(key, opts...)` | 派发 keydown+keyup,适合 a/s/d 玩法 | `string` | `Mark`, `Intent` |
| `MarkOnly(name, opts...)` | 仅打因果标记,不做动作 | `string` | `WithMeta`, `Intent` |

`Target` 由三个构造器之一产生:

```go
webops.Vt("btn_acute")          // [data-vt-id="btn_acute"]
webops.Sel(".my-css-class")     // 任意 CSS 选择器
webops.XY(100, 200)             // 绝对坐标
```

**`Mark` vs `Intent` 的区分**(与 V4.1 一致):
- `Mark` 是给 analyzer 用的**结构性标签**(必须稳定),用来配对计算 interval verdict 与 audio sync
- `Intent` 是给 LLM 看的**自然语言注解**("这一步在做什么、期望什么反应"),analyzer 不消费它

二者并存。例:
```go
s.Key("a",
    webops.Mark("CLICK_ACUTE_CORRECT"),                    // 给 analyzer
    webops.Intent("焦点是锐角,按 a 应被判正确并 +100 分"))  // 给 LLM
```

### 等待类

```go
s.Wait(2000, "wait_for_first_spawn")              // 固定等;label 进入 ActionRecord.name
s.WaitFor("focus_set",                            // 轮询等
    webops.StateGt("focusedAngleCode", 0),
    4000)                                          // 超时 ms
```

### 观测 / 读取 / 断言

```go
s.Observe("first_card_appeared",                   // 软观测,失败不中止
    webops.StateLenGt("cards", 0))

s.Read("current_score",                            // 读值,后续 Branch/Dispatch 可拿
    webops.StateGet("score"))

s.Expect("victory_reached",                        // 硬断言,失败按 ContinueOnExpectFail 决定
    webops.StateEq("status", "victory"))
```

### 控制流

#### Branch(底层)

```go
s.Branch(
    webops.ReadEq("angle_type", 1),
    func(b *webops.B) { b.Key("a", webops.Mark("CLICK_ACUTE")) },
    func(b *webops.B) { b.Key("s", webops.Mark("CLICK_OTHER")) },  // 可传 nil
)
```

#### Dispatch(高层 macro,推荐)

读一个值 → 按值走对应分支。等价于 `Read + N*Branch`,但一次写完:

```go
s.Dispatch("angle_type",
    webops.StateGet("focusedAngleCode"),
    webops.Cases{
        "1": func(b *webops.B) { b.Key("a", webops.Mark("CLICK_ACUTE"),  webops.Intent("焦点是锐角")) },
        "2": func(b *webops.B) { b.Key("s", webops.Mark("CLICK_RIGHT"),  webops.Intent("焦点是直角")) },
        "3": func(b *webops.B) { b.Key("d", webops.Mark("CLICK_OBTUSE"), webops.Intent("焦点是钝角")) },
    })
```

cases 的 key 是字符串。`read_eq` 内部用 `String()` 强制转换两端比较,reader 返回 number(如 `focusedAngleCode = 1`)也能匹配 `"1"`。不在 cases 里的值会"什么都不做"继续往下。

Builder 在添加 Dispatch 时**会对 cases keys 排序**再 desugar,确保 IR 输出确定性(便于 diff / hash / 缓存)。

#### Loop

```go
s.Loop(20, func(s *webops.B) {
    s.WaitFor("next_card", webops.StateGt("focusedAngleCode", 0), 4000)
    s.Dispatch(...)
    s.Wait(900, "")
})
```

### 步骤选项(`Opt`)

通过函数式 options 提供。每个 Opt 都是 `func(Step)`,叠加修改 Step map。

| Opt | 适用动作 | 作用 |
|---|---|---|
| `Mark(name)` | Click/Drag/Type/Key/MarkOnly/WaitFor | 打 analyzer 用的结构标签 |
| `Intent(text)` | 所有动作 | LLM 看的自然语言注解 |
| `Mode("native")` | Click | 跳过 PointerEvent 直接 `.click()` |
| `Duration(ms)` | Drag | 拖拽时长(默认 500ms) |
| `ClearFirst(true)` | Type | 输入前清空 |
| `WithMeta(map)` | MarkOnly/任何 | 给 marker 附 metadata |

---

## Predicate 词汇表

谓词描述"返回 boolean 的事实判定"。所有 `Observe` / `Expect` / `WaitFor` / `Branch` 的 check 字段都接收一个 `Predicate`。

`state_*` 系列读 `window[storeName].getState()`(默认 `useGameStore`),path 是点分路径(如 `"phase"`、`"cards.length"`)。

| 构造器 | 翻译为 | 用例 |
|---|---|---|
| `StateEq(path, value)` | `state.path === value` | `StateEq("phase", "COMPLETE")` |
| `StateNe(path, value)` | `state.path !== value` | `StateNe("currentTarget", "none")` |
| `StateGt(path, v)` | `state.path > v` | `StateGt("score", 0)` |
| `StateGe(path, v)` | `state.path >= v` | `StateGe("score", 600)` |
| `StateLt(path, v)` | `state.path < v` | `StateLt("score", 700)` |
| `StateLe(path, v)` | `state.path <= v` | `StateLe("score", 400)` |
| `StateIn(path, v...)` | `[...vs].includes(state.path)` | `StateIn("phase", "CORRECT", "INCORRECT")` |
| `StateTruthy(path)` | `!!state.path` | `StateTruthy("isReady")` |
| `StateLenEq(path, n)` | `Array.isArray && length === n` | `StateLenEq("reviewQueue", 0)` |
| `StateLenGt(path, n)` | `Array.isArray && length > n` | `StateLenGt("cards", 0)` |
| `StateCountEq(path, key, eq, n)` | `arr.filter(x => x[key]===eq).length === n` | `StateCountEq("attempts", "errorType", "position", 4)` |
| `StateEveryEq(path, key, eq)` | `arr.every(x => x[key] === eq)` | `StateEveryEq("attempts", "hintUsed", true)` |
| `DOMExists(sel)` | `!!document.querySelector(...)` | `DOMExists("game-root")` (vt-id 简写) |
| `DOMMissing(sel)` | `!document.querySelector(...)` | `DOMMissing("loading-overlay")` |
| `All(p...)` | `preds.every(...)` | `All(StateEq("phase", "CHOOSING"), StateNe("currentTarget", "none"))` |
| `Any(p...)` | `preds.some(...)` | `Any(StateEq("phase", "CORRECT"), StateEq("phase", "INCORRECT"))` |
| `Not(p)` | `!pred` | `Not(DOMExists("error-modal"))` |
| `ReadEq(name, value)` | `String(read(name)) === String(value)` | `ReadEq("idx", 0)` (仅 Branch 内有效) |
| `ReadModEq(name, mod, v)` | `(Number(read(name)) % mod) === v` | `ReadModEq("idx", 2, 0)` (偶数判定) |
| `ExprP(code)` | `!!new Function('store','read', 'return '+code)(state, read)` | `ExprP("store.attempts.length > 0 && store.attempts[store.attempts.length-1].hintUsed === true")` |

**DOM 选择器约定**:`DOMExists("foo")` 不以 `[` / `.` / `#` 开头时,自动展开为 `[data-vt-id="foo"]`。要用原生 CSS 选择器,显式写完整形式:`DOMExists(".my-class")`。

**Read 系谓词**:`ReadEq` 与 `ReadModEq` 引用 `Read` 步骤的产物。注意它们**只有在 `Branch` 的 when 子句里**有意义 — SessionRunner 只在 branch.predicate 注入 `ReadFn`;其他位置(Observe/Expect/WaitFor)的 reader 永远返回 undefined。

**`ExprP` 是最后的逃生口**:当上面这些组合不够用,直接写 JS 表达式。作用域里有 `store`(整个 state)和 `read`(ReadFn)。`store` 已经是 `.getState()` 后的快照。一行能写清就用 ExprP,涉及超过两行的复杂逻辑应该考虑往 store 里加一个 derived selector,而不是把逻辑塞 Expr。

---

## ValueSource 词汇表

值源描述"返回任意值"。`Read` 步骤和 `Dispatch` 的 source 字段接收一个 `ValueSource`。

| 构造器 | 翻译为 | 用例 |
|---|---|---|
| `StateGet(path)` | `getPath(state, path)` | `StateGet("currentTarget")` |
| `StateLen(path)` | `Array.isArray(v) ? v.length : 0` | `StateLen("reviewQueue")` |
| `StateCount(path, key, eq)` | `arr.filter(x => x[key]===eq).length` | `StateCount("attempts", "errorType", "position")` |
| `StateMap(path, key)` | `arr.map(x => x[key])` | `StateMap("attempts", "errorType")` |
| `ExprV(code)` | 同 ExprP 但返回 any 值 | `ExprV("Object.keys(store.cards).length")` |

---

## 意图三层结构

V5 沿用 V4.1 的"意图三层"划分,服务三个不同消费者:

| 层级 | 字段 | 谁产生 | 谁消费 | 何时记录 |
|---|---|---|---|---|
| Game-level | `gameIntent` | `AuditRequest.GameIntent` | LLM 跨场景判决 | 每次 Audit |
| Scenario-level | `Scenario.Intent` + `Scenario.Hypothesis` | 测试作者写 | LLM 单/跨场景判决 | builder 里 |
| Action-level (intent) | `Intent(...)` step opt | 测试作者写 | LLM 看 timeline | builder 里 |
| Action-level (mark) | `Mark(...)` step opt | 测试作者写 | analyzer 算 interval | builder 里 |

`Intent` 全部 optional,先跑通再回填。强制必填会变成形式主义负担("intent: click button" 这种废话注解反而稀释信号)。

`Hypothesis` vs `Intent` 的区分:
- **Hypothesis** 偏"断言":"按对键应当 +100 分,score ≥ 1500 时进 victory" — 可以被验证真假
- **Intent** 偏"目的":"验证按键-分类的因果链路" — 说明你在审计什么

二者互补:LLM 看 hypothesis 知道你期待什么具体行为,看 intent 知道你这次测试在审计哪个设计目标。

---

## 完整剧本范例

### Happy path:perfect-player

```go
func buildPerfectPlayer() webops.Scenario {
    return webops.Scenario{
        ID:         "perfect-player",
        Tags:       []string{"happy-path"},
        Intent:     "验证按 currentTarget 正确拖放的 happy path",
        Hypothesis: "每次正确拖 → +100 或 +200,无 reviewQueue 入队,6 题后 phase=COMPLETE 且 correctCount=6",
        Script: webops.Script("perfect_all_correct").
            Strategy("human_like").
            Timeout(180_000).
            ContinueOnExpectFail(true).
            Wait(800, "wait_for_first_render").
            Observe("game_root_visible", webops.DOMExists("game-root")).
            Loop(6, func(s *webops.B) {
                s.WaitFor("item_ready",
                    webops.All(
                        webops.StateEq("phase", "CHOOSING"),
                        webops.StateNe("currentTarget", "none"),
                    ), 5000)
                s.Read("target", webops.StateGet("currentTarget"))
                s.Dispatch("lex", webops.StateGet("currentTarget"), webops.Cases{
                    "cup": func(b *webops.B) {
                        b.Drag(webops.Vt("word-card-cup"), webops.Vt("zone-cup-hitarea"),
                            webops.Duration(500),
                            webops.Mark("DRAG_CORRECT_CUP"),
                            webops.Intent("拖 cup 到 cup zone — scene cloze 应判正确并触发庆祝层"))
                    },
                    // saucer / hot / liquid / beverage / coffee...
                })
                s.WaitFor("feedback_shown",
                    webops.Any(
                        webops.StateEq("phase", "CORRECT"),
                        webops.StateEq("phase", "INCORRECT"),
                    ), 3000)
                s.Observe("feedback_is_correct", webops.StateEq("lastFeedbackKind", "correct"))
                s.Wait(700, "wait_celebration")
                s.Click(webops.Vt("next-button"), webops.Mark("CLICK_NEXT"), webops.Intent("进入下一题"))
                s.Wait(400, "")
            }).
            Wait(1500, "wait_complete_screen").
            Read("final_score", webops.StateGet("score")).
            Expect("reached_complete",   webops.StateEq("phase", "COMPLETE")).
            Expect("all_6_attempts",     webops.StateEq("attemptsCount", 6)).
            Expect("all_correct",        webops.StateEq("correctCount", 6)).
            Expect("score_at_least_600", webops.StateGe("score", 600)).
            Expect("review_queue_empty", webops.StateLenEq("reviewQueue", 0)).
            Build(),
    }
}
```

### Failure path:semantic-error-player

```go
func buildSemanticErrorPlayer() webops.Scenario {
    return webops.Scenario{
        ID:         "semantic-error-player",
        Tags:       []string{"failure-path", "semantic-error"},
        Intent:     "验证 classifyError 的 lex !== target 分支与 reviewQueue 完整入队",
        Hypothesis: "6 题全 errorType='semantic',correctCount=0,score=0,reviewQueue 6 项",
        Script: webops.Script("semantic_error_wrong_words").
            Strategy("human_like").
            Timeout(150_000).
            Wait(800, "").
            Loop(6, func(s *webops.B) {
                s.WaitFor("item_ready",
                    webops.All(
                        webops.StateEq("phase", "CHOOSING"),
                        webops.StateNe("currentTarget", "none"),
                    ), 5000)
                s.Dispatch("lex", webops.StateGet("currentTarget"), webops.Cases{
                    "cup": func(b *webops.B) {
                        b.Drag(webops.Vt("word-card-liquid"), webops.Vt("zone-cup-hitarea"),
                            webops.Mark("SEM_ERR_Q1"),
                            webops.Intent("q1 (cup) 实拖 liquid — choices 含 liquid,应判 semantic"))
                    },
                    // ...其它 5 个故意错答
                })
                s.WaitFor("feedback_shown",
                    webops.Any(webops.StateEq("phase", "CORRECT"), webops.StateEq("phase", "INCORRECT")), 3000)
                s.Observe("feedback_is_semantic", webops.StateEq("lastFeedbackKind", "semantic"))
                s.Wait(500, "")
                s.Click(webops.Vt("next-button"), webops.Mark("NEXT"))
                s.Wait(400, "")
            }).
            Wait(1500, "").
            Expect("reached_complete",     webops.StateEq("phase", "COMPLETE")).
            Expect("all_6_semantic",       webops.StateEveryEq("attempts", "errorType", "semantic")).
            Expect("zero_correct",         webops.StateEq("correctCount", 0)).
            Expect("zero_score",           webops.StateEq("score", 0)).
            Expect("review_queue_full_6",  webops.StateLenEq("reviewQueue", 6)).
            Build(),
    }
}
```

完整 5 个剧本(perfect / position-error / semantic-error / hint / mixed)见 `coffee_cloze_test.go`。

---

## 组件接入(TypeScript 侧不变)

V5 一行没动 React hook、Zustand 中间件、R3F 桥接。下面摘录与 V4.1 完全一致。

### (1) Zustand store:`withTelemetry` 包一层

```tsx
import { create } from 'zustand';
import { withTelemetry } from '@/webops/runtime';

const useGameStore = create<S>()(
  withTelemetry({
    targetId: 'game',
    enums: { status: { playing: 0, gameover: -1, victory: 1 } },
    skip: ['cards']
  })((set, get) => ({
    score: 0, lives: 3, status: 'playing', cards: [],
    // 业务方法...
  }))
);

// V5 关键:让 Go 端 Script DSL 能访问到 store
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production') {
  (window as any).useGameStore = useGameStore;
}
```

`withTelemetry` 自动把数值字段(`score`/`lives`)推到 VirtualChannel,枚举字段用 `enums` 映射。`skip` 列表里的字段不推(适合大数组/对象)。

### (2) UI 元素:`useTrack` 拿 vt-id

```tsx
import { useTrack } from '@/webops/runtime';

function ClassifyButtons() {
  const acute = useTrack('btn_acute',  { watch: ['opacity'] });
  const right = useTrack('btn_right',  { watch: ['opacity'] });
  const obtuse = useTrack('btn_obtuse', { watch: ['opacity'] });
  return (
    <>
      <button {...acute}  onClick={...}>Acute</button>
      <button {...right}  onClick={...}>Right</button>
      <button {...obtuse} onClick={...}>Obtuse</button>
    </>
  );
}
```

`watch` 让 DOM K 线追踪指定 CSS 属性(`rotation`/`scale`/`opacity`/`width`/`height`)。Go 脚本里 `webops.Vt("btn_acute")` 就用这个 vt-id 定位。

### (3) R3F 对象(可选):`userData.signals`

```tsx
<mesh
  name="card_xyz"
  userData={{ signals: { angle: data.angle, typeCode: ANGLE_CODE[data.type] } }}
>
  ...
</mesh>
```

R3FBridge 每帧采样,把 `userData.signals` 里的数值字段汇入 VirtualChannel,并把世界坐标 project 到屏幕坐标作为 `sx`/`sy`/`sz` K 线。`name` 不能为空、不能是 `Scene`/`Object_*`/含 `Camera`/`Light`(系统节点会被过滤)。

---

## Go 库 API

### 核心入口

```go
import "yourorg/webops-v5/webops"

result, err := webops.Audit(ctx, webops.AuditRequest{
    URL:         "http://localhost:3000/games/coffee-cloze",
    GameIntent:  "Coffee Cloze: 6 道拖放式 vocabulary cloze 题...",
    Scenarios:   buildScenarios(),                              // []webops.Scenario
    Concurrency: 4,                                              // 0 → 默认 8
    SkipLLM:     false,                                          // true 时只跑不评
    LLMAPIKey:   "",                                             // "" → 读 ANTHROPIC_API_KEY env
    LLMModel:    "",                                             // "" → "claude-opus-4-7"
})
```

### 数据类型

```go
type Scenario struct {
    ID         string
    Hypothesis string
    Intent     string
    Tags       []string
    Script     InlineScript    // 由 webops.Script(...).Build() 产出
}

type ScenarioResult struct {
    ScenarioID string          `json:"scenarioId"`
    Hypothesis string          `json:"hypothesis"`
    Intent     string          `json:"intent,omitempty"`
    Tags       []string        `json:"tags,omitempty"`
    Payload    json.RawMessage `json:"payload,omitempty"`       // LLMPayload JSON
    InfraError string          `json:"infraError,omitempty"`    // 非空 = 该 scenario 网络/超时挂了
    DurationMs int64           `json:"durationMs"`
}

type AuditResult struct {
    GameIntent string
    Results    []ScenarioResult
    Verdict    string    // 原始 LLM JSON 字符串(需要 json.Unmarshal 二次解析)
    LLMError   string    // 非空 = LLM 调用失败
    LLMSkipped string    // 非空 = LLM 被跳过(SkipLLM 或无 API key)
    DurationMs int64
}
```

### 生命周期

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
defer cancel()
defer webops.Close()                  // 关闭共享 chromedp 进程

result, err := webops.Audit(ctx, req)
if err != nil { /* fatal — 一般是参数错或全部 navigate 挂了 */ }

// 单 scenario 失败不导致 err != nil,而是在 result.Results[i].InfraError 里
for _, r := range result.Results {
    if r.InfraError != "" { /* 这个 scenario 没跑通 */ }
}

// 解析 LLM verdict (LLM 输出是 JSON 字符串)
var bv batchVerdict
if result.Verdict != "" {
    json.Unmarshal([]byte(stripCodeFence(result.Verdict)), &bv)
}
```

### 调优常量

包级变量,需要时在程序启动早期改:

```go
webops.DefaultConcurrency = 4             // 默认 8
webops.DefaultLLMModel    = "claude-opus-4-7"
webops.NavTimeout         = 25 * time.Second
webops.RunTimeout         = 180 * time.Second
```

---

## LLMPayload 结构

LLMPayload 是给大模型看的"事实 + verdict"双层结构,由 TS 侧的 `buildLLMPayload` 产出,Go 透传不解析。

```ts
interface LLMPayload {
  meta: {
    scenarioId: string;
    durationMs: number;
    url: string;
    frameCount: number;
    hadErrors: boolean;
    aborted: boolean;
    framesTruncated?: boolean;     // frame buffer 超 maxFrames 时被丢中段
  };
  hypothesis?: string;              // 来自 Scenario.Hypothesis(透传)
  intent?: string;                  // 来自 Scenario.Intent
  tags?: string[];                  // 来自 Scenario.Tags
  facts: {
    timeline: Array<{               // 按时间排序的动作/marker/observe/expect 流
      t: number;                    // 相对开始 ms
      type: string;                 // step kind / marker / observe / expect
      name: string;
      ok?: boolean;
      intent?: string;              // ← 来自 step.Intent(...) opt,LLM 看这里就知道动作目的
      detail?: string;
    }>;
    state: Record<string, any>;     // 全部 .Read() 收集的最终值
    tracks: Array<{                 // 按 activity 排序的 top N 信号轨道
      key: string;
      overall: string;              // K 线人类摘要 "O=.. H=.. L=.. C=.."
      windows: Array<{ around: string; pre: string; post: string; delta: number }>;
      totalActivity: number;
    }>;
  };
  verdict: {
    intervalScore: number;          // 0-100,基于 interval 裁决
    expectScore: number;            // 0-100,基于 expect 通过率
    audioScore: number;             // 0-100,基于音画同步
    overallScore: number;           // 三者均值
    intervals: Array<{ range: string; durationMs: number; verdict: string; correlation: number }>;
    audioSyncs: Array<{ action: string; latencyMs: number; verdict: string }>;
    alerts: string[];
  };
}
```

LLM 的 batch system prompt 要求它产出:

```json
{
  "perScenario": [{"scenarioId": "...", "verdict": "PASS|PARTIAL|FAIL|INFRA_FAIL", "score": 0..100, "evidence": [...]}],
  "crossScenarioFindings": [{"pattern": "...", "scenariosAffected": [...], "evidence": "..."}],
  "rootCauses": [{"issue": "...", "suggestedFix": {"target": "code|script|both", "file": "...", "change": "..."}}],
  "notes": "..."
}
```

---

## V4.1 → V5 迁移指南

### 删除

- **整个 `webops.go`(原 HTTP 服务)**:功能搬入 `webops/webops.go` 库
- **所有 `examples--*--scripts.ts`**:剧本搬到 Go 文件
- **TS 端 `agent.ts` 里的 registry / register / describe / setGameIntent**:V5 不再需要

### 新增

- **`script--ir.ts`(TS)**:JSON-safe IR + `compileIR()`
- **`webops/webops.go`(Go 包)**:IR + builder + chromedp 编排 + LLM batch
- **每个项目自己的 `*_test.go`**:用 builder 拼脚本(模板见 `coffee_cloze_test.go`)

### 修改

- **`agent.ts`**:从 ~130 行降到 ~30 行,只剩 `runInline(scriptJSON, metaJSON)`
- **`script--Script.ts`**:删 `ScriptBuilder` 类和 `Script` 工厂,只留类型定义
- **`index.ts`**:删 `Script` re-export
- **Bootstrap.tsx**:`webops.register(...)` 全删,留 `import('@/webops')` 一行
- **store 文件**:增加 `if (!production) (window as any).useGameStore = useGameStore;`(让 Go 端谓词能读 state)

### 不动

- `runtime.ts`、`react--*`、`core--*`、`script--actions.ts`、`session--SessionRunner.ts`、`report--*`

### Bootstrap 改动 diff

```diff
 'use client';
 import { useEffect } from 'react';
 import { shouldEnableWebOps } from '@/webops/runtime';

 export function WebOpsBootstrap() {
   useEffect(() => {
     if (!shouldEnableWebOps()) return;
-    (async () => {
-      const [{ webops }, { perfectPlayer, lazyPlayer, clickPlayer }] = await Promise.all([
-        import('@/webops'),
-        import('@/games/angle-sorting/scripts'),
-      ]);
-      webops.setGameIntent('...');
-      webops.register('perfect-player', { build: perfectPlayer, ... });
-      webops.register('lazy-player', { build: lazyPlayer, ... });
-      webops.register('click-player', { build: clickPlayer, ... });
-    })();
+    import('@/webops');
   }, []);
   return null;
 }
```

### CLI 调用对比

**V4.1**:启 webops.go 服务 → curl /webops/diagnose-batch

```bash
ANTHROPIC_API_KEY=sk-ant-... go run webops.go &
curl -X POST http://localhost:8080/webops/diagnose-batch \
  -d '{"url": "...", "tags": ["happy-path"]}'
```

**V5**:直接跑测试程序,它内嵌 chromedp,无需先起服务

```bash
ANTHROPIC_API_KEY=sk-ant-... go run coffee_cloze_test.go -url http://localhost:3000/games/coffee-cloze
# 或带 fix loop
go run coffee_cloze_test.go -fix -project-root /path/to/repo -max-rounds 3
```

---

## FAQ / 排错

**Q: navigate 后 chromedp 提示 `window.WebOps.runInline` 不存在,polling 超时**
A: 通常是三种情况之一:
1. URL 没带 `?webops=1`,Bootstrap 没激活 → 检查 `applyAuditParam` 是否被调用(库内部自动加)
2. Bootstrap 组件没挂上 → 检查 React 树根 mount 了 `<WebOpsBootstrap />`
3. 动态 import `@/webops` 编译失败 → 看浏览器 console。`tsconfig.json` 路径 alias 有没配?

**Q: `state_eq("phase", "COMPLETE")` 永远不通过,但实际 store 是 COMPLETE**
A: 9 成是 `window.useGameStore` 没暴露。在 store 文件里加:
```ts
if (typeof window !== 'undefined') (window as any).useGameStore = useGameStore;
```
要确认:浏览器 console 里 `useGameStore.getState()` 能返回对象。

**Q: 想用别的 store 名(不叫 `useGameStore`)**
A: 在 builder 里改 IR 的 `store` 字段。目前 V5 builder 没暴露这个,如果有需求可以加 `b.Store("useMyStore")` 方法。也可以直接 `script.Store = "useMyStore"` 修改 Build() 返回值。

**Q: 我有个谓词组合用上面的词汇表写不出来**
A: 用 `ExprP("...")` 写 JS 表达式。作用域里有 `store`(整个 state)和 `read`(ReadFn)。复杂逻辑建议先在 store 里加个 derived selector,然后用 `StateGet("mySelector")` 取 — 测试代码更清晰也更稳定。

**Q: 一个 tab 能跑多个 scenario 吗?**
A: 不能。框架强制 1 navigation = 1 scenario(`runSession` 有 in-flight 锁,第二次调用立刻 reject)。并发只在 tab 维度发生。如果你有 N 个 scenario 想跑,Audit 会开 N 个 tab(被 sem 限到 Concurrency)。

**Q: Dispatch 的 cases key 排序会影响行为吗?**
A: 不会。所有 case 的 `else` 都是空,branches 顺序对结果无影响。Builder 排序是为了 IR 输出可复现(便于 diff)。

**Q: ExprP 里能不能 `await`?**
A: 不能。Predicate 必须同步返回。如果你需要异步等待状态,用 `WaitFor` + 谓词。

**Q: 我已经在用 V4.1,迁移工作量大不大?**
A: 不大。三个动作:(1) Bootstrap 简化为一行 import,(2) examples TS 文件搬到 Go 用 builder 重写(可参考 `coffee_cloze_test.go` 的模式),(3) store 暴露到 window。框架本体替换 4 个文件即可。
