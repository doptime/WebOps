# WebOps — 单文件平铺布局(V4.1 + V5.2 双协议)

> "One call. Full session. LLM-ready. Now in batch."

**V4** 把 V3 的四步流程 (`start → execute → wait → analyze`) 收敛为一次原子调用 `runSession(script)`,产出可直接送给大模型的 `LLMPayload`。脚本作者用 TS 写,业务侧 `register('id', { build, hypothesis, ... })`,Go HTTP 后端通过 `window.WebOps.run(id)` 触发。

**V5.2** 在 V4 之上另开一条路径,为 **AgentHarness(oh-my-pi)** 优化:**每个 app 一个自给自足的 `audit.go`**——JS 场景脚本作为 Go 反引号字符串内嵌,chromedp 编排、CLI、报告全在同一文件,**无 webops 库依赖,无 Anthropic 调用**。LLM 推理由 AgentHarness 上层负责,测试程序只产数据。

| | V4(TS-first, HTTP) | V5.2(JS-script-first, AgentHarness) |
|---|---|---|
| 脚本载体 | TypeScript Script DSL,`register/build` 工厂 | 普通 JS 反引号 inline 在 Go 文件里 |
| Go 端职责 | HTTP server,`register` 调度 | 单文件二进制:chromedp + 本地判决 + stdout 报告 |
| 浏览器入口 | `window.WebOps.run(scenarioId)` | `window.WebOps.runScript(source, ctx)` |
| LLM 调用 | Go 端 `callLLMBatch` 调 Anthropic | **无**(AgentHarness 上层做) |
| 判决来源 | LLM JSON 输出 | 本地 `deriveStatus`,基于 `expect` 全过与否 |
| 文件数(一个 app) | game.tsx + audit binary 一份 | game.tsx + 一份 audit.go,没了 |
| 适合 | 富前端遥测、HTTP 驱动器、独立服务 | AgentHarness / Claude Code 风格的工具调用 |

两条路径共用 `agent.ts`,业务侧的游戏组件代码不需要任何修改。

V4.1 的**三件事**在 V5.2 仍然成立:意图三层结构(game → scenario → action)、批量并发测试、`dispatch` macro(在 JS 里就是 `switch` / 对象字面量 dispatch)。

整个工程是**单层级文件结构**:不需要展开任何子目录就能看完所有 TS 文件。原本目录关系通过 `--` 命名前缀保留:`core--kline.ts` 表示"原本属于 core 目录的 kline 模块"。

---

## 完整文件清单(单层级)

```
webops-v5/
├── README.md                                          ← 单一文档源(本文件)
├── package.json
├── tsconfig.json
├── go.mod                                             ← Go 模块根,module name = yourorg/webops-v5
├── webops.go                                          ← [V4] Go HTTP 后端 (AgentHarness 不用,可删)
│
├── agent.ts                                           ← V4 register/run + V5.2 runScript + describe
├── runtime.ts                                         ← [运行时入口] 静态 import,含 hooks + 闸门
├── index.ts                                           ← runSession 主入口 + in-flight 锁(V4 路径)
│
├── core--kline.ts                                     ← OHLC K 线工具
├── core--visual-attention.ts                          ← 视觉权重计算
├── core--virtual-channel.ts                          ← 信号汇流通道(V4 + V5.2 共用)
├── core--dom-telemetry.ts                            ← DOM 探针
├── core--audio-telemetry.ts                          ← 音频探针
├── core--r3f-bridge.ts                               ← R3F 3D 场景桥接
│
├── script--Script.ts                                  ← [V4] TS Script DSL 链式构建器
├── script--actions.ts                                 ← PointerEvent/键盘事件派发(V4 + V5.2 共用)
│
├── session--SessionRunner.ts                          ← [V4] 一体化会话引擎
│
├── report--compress.ts                                ← [V4] K 线压缩(±400ms 窗口)
├── report--analyzer.ts                                ← [V4] 自动诊断
├── report--ReportBuilder.ts                           ← [V4] LLMPayload 组装
│
├── react--useTrack.ts                                 ← React Hook: 声明式追踪
├── react--zustand-telemetry.ts                       ← Zustand middleware(V4 + V5.2 共用)
│
├── examples/
│   └── angle-sorting/
│       └── scripts.ts                                 ← [V4] TS-side 示范剧本
│
└── apps/
    └── coffee-cloze/                                  ← [V5.2] Coffee Cloze 应用 + audit
        ├── coffee_cloze_game.tsx                      ←   游戏组件
        ├── coffee_cloze_audit.go                      ←   单文件审计 (1184 行,自给自足)
        └── README.md                                  ←   audit 修复记录
```

---

## 一分钟接入(三步)

**Step 1.** Next.js 配两个 alias(完整 + 轻量):

```js
// next.config.mjs
import path from 'path';
export default {
  webpack: (config) => {
    // 完整入口: 仅在审计路径动态 import,产出独立 chunk,生产用户不下载
    config.resolve.alias['@/webops'] = path.resolve('./webops-v4/agent.ts');
    // 轻量入口: 游戏组件静态 import,生产 bundle 只多约 5KB 且无副作用
    config.resolve.alias['@/webops/runtime'] = path.resolve('./webops-v4/runtime.ts');
    return config;
  }
};
```

**Step 2.** 应用启动时动态加载审计 chunk + 注册剧本:

```tsx
'use client';
import { useEffect } from 'react';
// 静态 import: 仅 shouldEnableWebOps 闸门,~1KB
import { shouldEnableWebOps } from '@/webops/runtime';

export function WebOpsBootstrap() {
  useEffect(() => {
    if (!shouldEnableWebOps()) return;

    // 动态 import: 审计 chunk + 剧本 chunk 并行下载,生产用户永远不会到这里
    (async () => {
      const [{ webops }, { perfectPlayer, lazyPlayer, clickPlayer }] = await Promise.all([
        import('@/webops'),
        import('@/games/angle-sorting/scripts'),
      ]);

      webops.setGameIntent(
        '角度分类游戏:玩家根据落下卡片的角度类型(锐角/直角/钝角),' +
        '按对应的 a/s/d 键(或点击按钮)分类。20 张卡 + 3 条命。'
      );

      webops.register('perfect-player', {
        build: perfectPlayer,
        intent: '验证按键-分类的因果链路实现正确',
        hypothesis: '每次正确按键 → +100 分 + SFX_SUCCESS。20 张全对应得 ≥ 1500 分进 victory。',
        tags: ['happy-path']
      });

      webops.register('lazy-player', {
        build: lazyPlayer,
        intent: '验证错误反馈与 gameover 终止逻辑',
        hypothesis: '永远按 a:碰到 right/obtuse 卡应判错并扣 lives。3 次错误后进 gameover。',
        tags: ['failure-path']
      });

      webops.register('click-player', {
        build: clickPlayer,
        intent: '验证鼠标 onClick 链路与键盘等价',
        hypothesis: '点击 btn_acute 应等价于按 a。结果应与 perfect-player 一致。',
        tags: ['happy-path', 'regression']
      });
    })();
  }, []);
  return null;
}
```

`shouldEnableWebOps()` 的判定规则:
1. URL 含 `?webops=1` → 激活(Go chromedp 走这条)
2. `process.env.NODE_ENV === 'development'` → 激活(本地手动 audit 方便)
3. 否则不激活

异步启动是安全的: chromedp 用 `chromedp.Poll` 等待 `window.WebOps.describe` 出现才发起调用,审计 chunk 下载几百毫秒不影响功能,只在 timing 日志里能看到。

**Step 3.** Game 组件三处接入(详见 [组件接入](#组件接入)),**注意从 `/runtime` 入口 import**:

```tsx
import { withTelemetry, useTrack } from '@/webops/runtime';   // ← 关键:不是 '@/webops'

// (1) store 用 withTelemetry 包
const useGameStore = create<S>()(
  withTelemetry({ targetId: 'game', enums: { status: { ... } }, skip: [...] })((set, get) => ({ ... }))
);

// (2) 关键 UI 元素加 vt-id
const acuteBtn = useTrack('btn_acute', { watch: ['opacity'] });
return <button {...acuteBtn} onClick={...}>...</button>;

// (3) R3F 对象可选挂 userData.signals
<mesh userData={{ signals: { angle: 45, typeCode: 1 } }} name="card_xyz">...</mesh>
```

`@/webops/runtime` 与 `@/webops` 的区别见下面"[生产安全](#生产安全重要)"章节。

---

## 端到端流程

```
[Go: webops.go]                  [Headless Chrome]              [Next.js 应用]
                                                                   (已 import @/webops)
POST /webops/diagnose-batch
  url, scenarios?, tags?, concurrency
   │
   ▼
chromedp(共享 Browser):
  describe ─────────────► fresh tab → window.WebOps.describe()
                              │  返回 { gameIntent, scenarios[] }
                              ▼
  fan-out (sem-bounded):
    tab #1: navigate → window.WebOps.run('perfect-player') → payload₁
    tab #2: navigate → window.WebOps.run('lazy-player')    → payload₂
    tab #3: navigate → window.WebOps.run('click-player')   → payload₃
    [errgroup: 单失败不取消整批,记 InfraError]
   │
   ▼ aggregate(gameIntent, [payload₁..N])
   │
   ▼ POST → Anthropic (single call, batch system prompt)
   │
   ▼ verdict: { perScenario, crossScenarioFindings, rootCauses }
   │
返回给调用方
```

---

## 并发模型(铁律)

**1 次 page navigation = 1 个 scenario,永远**。

理由:游戏状态、AudioContext、R3F scene、zustand store 都是 tab 内全局单例。即使写 reset 也会留 monkey-patched 原型链、监听器残留、R3F canvas 句柄变化等隐患。

所以并发只发生在 tab 维度:

- 一个长寿命 Chrome 进程(共享 ExecAllocator)
- 每个请求开**新 tab**(`chromedp.NewContext(sharedAlloc)`),tab 之间 storage / cookie / window 完全隔离
- 信号量 `sem` 卡死同时打开的 tab 数(默认 8,可由 `-concurrency` flag 或 `CONCURRENCY` env 改)
- **tab 数与注册的 scenario 数完全解耦**:8 worker 跑 20 scenario 排两轮多;4 worker 跑 4 scenario 一轮跑完

TS 侧的 `runSession` 加了 in-flight 锁:同一 tab 内并发调用直接抛异常,而不是数据静默串台。这是防御性设计——正常的 V4 部署模型一个 tab 只跑一次 session。

### Register N 个 ≠ 自动开 N 个 tab

`webops.register('xxx', ...)` 只是往 Map 里加一条,**任何**页面加载(真用户、Go chromedp tab、本地手动 audit)都会跑这段代码。真正"开 tab"的主语只有 Go——`/webops/diagnose-batch` 收到请求后 fan-out N 个 tab,每个 tab navigate 同一个 URL、注册同一批剧本,但只调 `WebOps.run('id')` 跑其中一个。tab 数由 `selected scenarios` 决定,受 `concurrency` 上限约束。

---

## 生产安全(双入口 + 动态 import)

V4.0 的所有页面加载都会无条件 register。这意味着真用户的 Chrome 里 `window.WebOps` 一直挂着,Script DSL IR 全进了生产 bundle,本就只该出现在 audit 场景的入口被生产用户白白下载几十 KB。

V4.1 用**双入口 + 动态 import**彻底解决:

| 入口 | 何时加载 | 内容 | 体积(gzipped) |
|---|---|---|---|
| `@/webops/runtime` | 静态,组件 import | useTrack / withTelemetry / shouldEnableWebOps | ~5KB |
| `@/webops` | 动态,Bootstrap 命中闸门时 await import | webops 单例 + SessionRunner + ReportBuilder + Script DSL + 6 个 core 探针 | ~25-30KB |

### 链路

```
[Go: chromedp.Navigate(applyAuditParam(url))]
        ↓ URL = "http://app/games/angle?webops=1"
        ↓
[chromedp tab: 加载页面]
        ↓ Bootstrap 跑 → shouldEnableWebOps() → true
        ↓ await import('@/webops')   ← 此刻才下载审计 chunk
        ↓ webops.register × N
        ↓ Go 调 WebOps.describe() / WebOps.run() ✓

[真用户: 直接访问 http://app/games/angle (无 query)]
        ↓ Bootstrap 跑 → shouldEnableWebOps() → false
        ↓ 直接 return,await import 永不发生
        ↓ 审计 chunk 永不下载
        ↓ window.WebOps 不存在
        ↓ 生产 bundle 只多 useTrack/withTelemetry 的 ~5KB stub(且无副作用)
```

### 为什么需要拆 runtime 入口

游戏组件每次 render 都用 `useTrack` / `withTelemetry`,它们必须能**静态** import,不可能走动态。但这两个 hook 在生产环境本就是 stub(没有 push 函数时全部 set / render 走原路,零开销),让它们独立成 `runtime.ts` 文件、不引用 SessionRunner 等重型模块,就能放心进生产 bundle。

如果 hooks 还从 `@/webops` 拿,Next.js 的静态分析会把 agent.ts 整条依赖图(SessionRunner / ReportBuilder / analyzer / 6 探针)都视为组件依赖,塞进生产 bundle,前面的动态 import 努力前功尽弃。

### 关于 Go 侧

`auditParam = "webops=1"` 在 webops.go 里写死成常量。Go 二进制本身就是审计工具,不存在"非审计"运行模式,flag 形式的开关纯属配置噪音。要换名字(改成更隐蔽的串挡偶然访客,例如 `audit_2025=x9`),修改两个常量:

```
webops.go      const auditParam = "..."
runtime.ts     shouldEnableWebOps({ param: '...', value: '...' })
```

故意采用"成对源码改动"而不是 flag 配置:这种联动改动用 grep 一眼能审,而 flag 形式容易出现"一边改了一边没改"的悄悄不一致。

---

## Script DSL 完整参考

### 入口

```ts
import { Script } from '@/webops';
const script = Script('scenarioId')   // 工厂
  .strategy('human_like')              // 'human_like' | 'instant'
  .timeout(120_000)                    // session 硬超时
  .continueOnExpectFail(true)          // expect 失败是否继续(默认 true)
  // ...动作链...
  .build();                            // 返回 CompiledScript
```

> **重要**: register 时传的是**工厂函数** `() => script`,不是直接传 `script`。这样每次 run 都重新构造 IR,避免跨 run 共享状态。

### 动作类

| 方法 | 用途 | 可选参数 |
|---|---|---|
| `.click(target, opts?)` | 单击。target 可以是 vt-id / CSS 选择器 / 绝对坐标 / `{ vtId }` / `{ selector }` | `mark`、`mode: 'pointer'\|'native'`、`intent` |
| `.drag(from, to, opts?)` | 拖拽,适合 R3F/Rapier 物理交互 | `durationMs`、`mark`、`intent` |
| `.type(text, opts?)` | 在当前 focus 元素输入文本 | `clearFirst`、`mark`、`intent` |
| `.key(key, opts?)` | 派发 keydown+keyup,适合 a/s/d 玩法 | `mark`、`intent` |
| `.mark(name, meta?, intent?)` | 仅打因果标记,不做动作 | meta、intent |

**`mark` vs `intent` 的区分**:
- `mark` 是给 analyzer 用的**结构性标签**(必须稳定),用来配对计算 interval verdict 与 audio sync。
- `intent` 是给 LLM 看的**自然语言注解**("这一步在做什么、期望什么反应")。analyzer 不消费它。

二者并存。例:
```ts
.key('a', {
  mark: 'CLICK_ACUTE_CORRECT',                         // 给 analyzer
  intent: '焦点是锐角,按 a 应被判正确并 +100 分'         // 给 LLM
})
```

### 等待类

```ts
.wait(2000, 'wait_for_first_spawn')          // 固定等
.waitFor('focus_set',                         // 轮询等
  () => useGameStore.getState().focusedAngleCode > 0,
  4000                                        // 超时 ms
)
```

### 观测/读取/断言

```ts
.observe('first_card_appeared',               // 软观测,失败不中止
  () => useGameStore.getState().cards.length > 0)

.read('current_score',                        // 读值,后续 branch/dispatch 可拿
  () => useGameStore.getState().score)

.expect('victory_reached',                    // 硬断言,失败按 continueOnExpectFail 决定
  () => useGameStore.getState().status === 'victory')
```

### 控制流

#### branch(底层)

```ts
.branch(
  (read) => read('angle_type') === 1,
  (b) => b.key('a', { mark: 'CLICK_ACUTE' }),
  (b) => b.key('s', { mark: 'CLICK_OTHER' })   // 可选 else 分支
)
```

#### dispatch(高层 macro,推荐)

读一个值 → 按值走对应分支。等价于 `.read(name, reader).branch(...).branch(...)`,但一次写完:

```ts
.dispatch(
  () => useGameStore.getState().focusedAngleCode,
  {
    1: (b) => b.key('a', { mark: 'CLICK_ACUTE',  intent: '焦点是锐角' }),
    2: (b) => b.key('s', { mark: 'CLICK_RIGHT',  intent: '焦点是直角' }),
    3: (b) => b.key('d', { mark: 'CLICK_OBTUSE', intent: '焦点是钝角' }),
  },
  { name: 'angle_type' }    // 可选,默认 _dispatch_<index>
)
```

cases 的 key 是字符串,但 reader 返回 number 也 OK——内部用 `String()` 强制转换两端比较。不在 cases 里的值会"什么都不做"继续往下。

#### loop

```ts
.loop(20, (s) =>
  s.waitFor('next_card', () => ..., 4000)
   .dispatch(() => ..., { ... })
   .wait(900)
)
```

---

## 意图三层结构

V4.1 的核心改进是把"意图"明确分到三个层次,服务三个不同消费者:

| 层级 | 字段 | 谁产生 | 谁消费 | 何时记录 |
|---|---|---|---|---|
| Game-level | `gameIntent` | `webops.setGameIntent('...')` 一次 | LLM 跨场景判决 | 注册阶段 |
| Scenario-level | `intent` + `hypothesis` | `webops.register('id', { intent, hypothesis })` | LLM 单/跨场景判决 | 注册阶段 |
| Action-level | `intent` 在 step opts 里 | `.click(t, { intent: '...' })` | LLM 看 timeline | 编译阶段 |
| Action-level (analyzer) | `mark` | `.click(t, { mark: '...' })` | analyzer 算 interval | 运行阶段 |

`intent` 全部 optional,先跑通再回填。强制必填会变成形式主义负担("intent: click button" 这种废话注解反而稀释信号)。

`hypothesis` vs `intent` 的区分:
- **hypothesis** 偏"断言":"按对键应当 +100 分,score ≥ 1500 时进 victory"——可以被验证真假。
- **intent** 偏"目的":"验证按键-分类的因果链路"——说明你在审计什么。

二者互补:LLM 看 hypothesis 知道你期待看到什么具体行为,看 intent 知道你这次测试在审计哪个设计目标。

---

## 完整剧本范例

### Happy path:perfectPlayer(用 dispatch)

```ts
import { Script } from '@/webops';
declare const useGameStore: any;

export const perfectPlayer = () =>
  Script('perfect_classify_20_cards')
    .strategy('human_like')
    .timeout(120_000)
    .wait(1500, 'wait_for_first_spawn')
    .observe('first_card_appeared', () => useGameStore.getState().cards.length > 0)
    .loop(20, (s) =>
      s
        .waitFor('next_card_focused', () => useGameStore.getState().focusedAngleCode > 0, 4000)
        .dispatch(
          () => useGameStore.getState().focusedAngleCode,
          {
            1: (b) => b.key('a', { mark: 'CLICK_ACUTE_CORRECT',  intent: '焦点锐角,按 a 应得分' }),
            2: (b) => b.key('s', { mark: 'CLICK_RIGHT_CORRECT',  intent: '焦点直角,按 s 应得分' }),
            3: (b) => b.key('d', { mark: 'CLICK_OBTUSE_CORRECT', intent: '焦点钝角,按 d 应得分' }),
          }
        )
        .wait(900, 'wait_card_animation')
    )
    .wait(2000, 'wait_for_victory')
    .read('final_score',  () => useGameStore.getState().score)
    .read('final_status', () => useGameStore.getState().status)
    .expect('victory_reached',     () => useGameStore.getState().status === 'victory')
    .expect('score_at_least_1500', () => useGameStore.getState().score >= 1500)
    .build();
```

### Failure path:lazyPlayer

```ts
export const lazyPlayer = () =>
  Script('lazy_always_acute')
    .strategy('instant')
    .timeout(60_000)
    .wait(1500)
    .loop(15, (s) =>
      s
        .waitFor('card_appears', () => useGameStore.getState().cards.length > 0, 4000)
        .key('a', {
          mark: 'PRESS_A',
          intent: '盲按 a:right/obtuse 卡应判错扣 lives,acute 卡应得分'
        })
        .wait(800)
    )
    .read('end_status', () => useGameStore.getState().status)
    .read('end_lives',  () => useGameStore.getState().lives)
    .expect('eventually_gameover', () => useGameStore.getState().status === 'gameover')
    .build();
```

完整三个剧本(perfect / lazy / click)见 `examples--angle-sorting--scripts.ts`。

---

## 组件接入

只有三处需要动业务代码,加起来不到 30 行。

### (1) Zustand store:withTelemetry 包一层

```tsx
import { create } from 'zustand';
import { withTelemetry } from '@/webops';

const useGameStore = create<S>()(
  withTelemetry({
    targetId: 'game',
    enums: { status: { playing: 0, gameover: -1, victory: 1 } },  // 字符串枚举映射成数字
    skip: ['cards']                                                 // 大对象用 skip 避免序列化爆炸
  })((set, get) => ({
    score: 0, lives: 3, status: 'playing', cards: [],
    // 业务方法...
  }))
);
```

`withTelemetry` 自动把数值字段(score/lives)推到 VirtualChannel,枚举字段用 `enums` 映射。`skip` 列表里的字段不推(适合大数组/对象)。

### (2) UI 元素:useTrack 拿 vt-id

```tsx
import { useTrack } from '@/webops';

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

`watch` 让 DOM K 线追踪指定 CSS 属性(rotation / scale / opacity / width / height)。脚本里 `.click('btn_acute')` 就用这个 vt-id 定位。

### (3) R3F 对象(可选):userData.signals

```tsx
<mesh
  name="card_xyz"
  userData={{ signals: { angle: data.angle, typeCode: ANGLE_CODE[data.type] } }}
>
  ...
</mesh>
```

R3FBridge 每帧采样,把 `userData.signals` 里的数值字段汇入 VirtualChannel,并把世界坐标 project 到屏幕坐标作为 sx/sy/sz K 线。`name` 不能为空、不能是 'Scene'/'Object_*'/含 'Camera'/'Light'(系统节点会被过滤)。

---

## Go 后端使用

Go 端有两种部署形态,二选一,**互不冲突**:

- **V4: HTTP server** —— `go run webops.go`,业务侧用 `webops.register(...)` 在浏览器里挂剧本,Go 通过 chromedp 触发 `window.WebOps.run(scenarioId)`,适合"后台面板配 N 个剧本",外部驱动器通过 HTTP 调用。
- **V5.2: Audit-in-one-file** —— 每个 app 自己有一个 `audit.go`,把 chromedp 编排、JS 场景脚本、CLI 全部塞在同一文件。**无 webops 库依赖**,无 HTTP server。完全为 AgentHarness(oh-my-pi)而生:测试程序只产数据,LLM 推理由 AgentHarness 上层负责。

---

### V5.2 单文件审计模式(推荐用于 AgentHarness)

一个 audit.go 文件 = 一整个测试套件。内部包含:

1. **类型 + chromedp 池** —— 从前 webops 库吸收过来,~100 行
2. **JS 场景脚本(反引号 inline)** —— 没有外部 `.js` 文件,每个场景就是一个 Go const string
3. **场景清单** —— `[]Scenario{{ID,Intent,Hypothesis,ScriptSource: perfectPlayerScript},...}`
4. **`Audit()` 编排** —— 并发跑全部场景,产 payload
5. **`deriveStatus()` 本地判决** —— PASS/PARTIAL/FAIL/INFRA_FAIL/ABORTED,**完全确定性**(根据 expect 是否全过 + 有无运行时错决定),不调任何外部服务
6. **CLI + 文本/JSON 报告器**

关键点:**没有任何对 Anthropic API 的调用**。AgentHarness 自己是 LLM agent loop,读取这个二进制的 stdout 后自行推理,不需要测试代码再调一次。

调用方式(AgentHarness 视角):

```bash
go run coffee_cloze_audit.go -url http://localhost:3001         # 着色文本到 stdout
go run coffee_cloze_audit.go -url http://localhost:3001 -json   # JSON 到 stdout(程序化消费)
go run coffee_cloze_audit.go -scenarios mixed-player,hint-player  # 子集
go run coffee_cloze_audit.go -strict                            # FAIL → 退出码 1
```

退出码:0 = 审计跑完(无论 PASS/FAIL),1 = `-strict` 下有场景 FAIL,2 = 参数错误。

**JS 脚本写法**(就是 `apps/coffee-cloze/coffee_cloze_audit.go` 里的 `perfectPlayerScript` 常量内容):

```js
await webops.wait(800);
webops.observe("game_root_visible", !!webops.dom("game-root"));

for (let i = 0; i < 6; i++) {
  if (!(await webops.waitFor("item_ready",
    () => webops.state().phase === "CHOOSING",
    5000))) break;

  const target = webops.state().currentTarget;
  await webops.drag("word-card-" + target, "zone-" + target + "-hitarea", {
    duration: 500, mark: "DRAG_CORRECT", intent: "拖正确词 " + target,
  });

  await webops.waitFor("feedback",
    () => ["CORRECT","INCORRECT"].includes(webops.state().phase), 3000);
  await webops.click("next-button", { mark: "NEXT" });
}

webops.expect("complete", webops.state().phase === "COMPLETE");
webops.expect("score_high", webops.state().score >= 400);
```

> **写法约束**: JS 字符串字面量用 `"..."` 或单引号,**不要用反引号模板字符串**(`\`xxx ${y}\``),因为整个 JS 是 Go 反引号原始字符串,内嵌反引号会切断字符串。用 `"..." + var + "..."` 拼接代替。

**`webops` 助手 API**(由 agent.ts 注入到脚本作用域):

| 类型 | 方法 | 说明 |
|---|---|---|
| 时序 | `wait(ms)` | sleep |
| | `waitFor(name, predFn, timeoutMs?, opts?)` | 轮询直到 predFn() 返真,超时返 false |
| 状态 | `state()` | 当前 `window.useGameStore.getState()` 快照 |
| | `dom(sel)` | querySelector,裸名自动包成 `[data-vt-id="..."]` |
| 记录 | `observe(name, passed, opts?)` | 记观察事实 |
| | `expect(name, passed, opts?)` | 同上,决定 PASS/FAIL 的是它 |
| | `read(name, value)` | 把一个值写进 `payload.reads[name]` |
| 动作 | `click(target, opts?)` | 点击,target 是裸 vt-id 或显式 CSS |
| | `drag(from, to, opts?)` | 拖拽 |
| | `key(key, opts?)` | 键盘事件 |
| | `abort(reason)` | 主动终止脚本 |
| 元数据 | `ctx` | `{scenarioId, intent, hypothesis, tags}` |

opts 都接 `{intent, mark, duration}` 之类。`expect` 失败**不会**中止脚本(脚本想停就显式 `webops.abort(...)`);所有 expect 收集完后,`deriveStatus` 一次性决定该场景是否 PASS。

**新增/修改一个场景的完整流程**(只需碰一个文件):

1. 在 audit.go 里加一个 `const fooScenarioScript = \`...JS...\``
2. 在 `buildScenarios()` 里加一项 `{ID:"foo", Intent:"...", Hypothesis:"...", ScriptSource: fooScenarioScript}`
3. 完事

完整的端到端例子见 `apps/coffee-cloze/coffee_cloze_audit.go`(单文件 1184 行,自给自足)。

---

### V4 HTTP server 模式(TS-first,适合后台面板)

> ⚠️ 在 AgentHarness 工作流里此模式**用不上**。它服务的是"外部 Go 进程通过 HTTP 调用驻留的 webops server"这种部署模型,与 AgentHarness 直接调本地二进制并读 stdout 的范式不同。如果你只用 AgentHarness,可以删掉 `webops.go` 整个文件。

### 启动

```bash
go mod init yourorg/webops
go get github.com/chromedp/chromedp golang.org/x/sync/errgroup
ANTHROPIC_API_KEY=sk-ant-... go run webops.go

# 可选:
go run webops.go -concurrency=4 -addr=:9000 -model=claude-opus-4-7
# 或用环境变量 CONCURRENCY / ADDR / LLM_MODEL
```

### 端点

#### `GET /webops/describe?url=...`

```bash
curl 'http://localhost:8080/webops/describe?url=http://localhost:3000/games/angle'
```

返回 `{ description: { gameIntent, scenarios: [{ id, hypothesis, intent, tags }] } }`。
后台面板用这个端点列出可跑的 scenario。

#### `POST /webops/diagnose`(单 scenario)

```bash
curl -X POST http://localhost:8080/webops/diagnose \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://localhost:3000/games/angle",
    "scenarioId": "perfect-player",
    "skipLLM": false
  }'
```

返回:
```json
{
  "ok": true,
  "payload": { /* 前端 LLMPayload 原文 */ },
  "verdict": "{ \"verdict\": \"PASS\", \"score\": 92, ... }",
  "durationMs": 8421
}
```

注意 `verdict` 是 LLM 输出的字符串(里面通常是 JSON),需要调用方再 `JSON.parse` 一次。这是"Go 不持有任何业务数据类型"原则的取舍。

#### `POST /webops/diagnose-batch`(多 scenario,推荐)

```bash
curl -X POST http://localhost:8080/webops/diagnose-batch \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://localhost:3000/games/angle",
    "scenarios": null,
    "tags": ["happy-path", "failure-path"],
    "concurrency": 4
  }'
```

参数:
- `scenarios`: 显式 ID 列表,`null` 或缺省 = 跑 describe 列表里的全部
- `tags`: 按 tag 过滤(与 scenarios 取并集后再过滤)
- `concurrency`: 本次请求的并发上限,**不会超过**进程级 `-concurrency`
- `skipLLM`: true 则只跑不评

返回:
```json
{
  "ok": true,
  "gameIntent": "...",
  "results": [
    { "scenarioId": "perfect-player", "hypothesis": "...", "intent": "...",
      "tags": ["happy-path"], "payload": { ... }, "durationMs": 7200 },
    { "scenarioId": "lazy-player",    "hypothesis": "...", "infraError": "navigate timeout",
      "durationMs": 25000 }
  ],
  "verdict": "{ \"perScenario\": [...], \"crossScenarioFindings\": [...], \"rootCauses\": [...] }",
  "durationMs": 18430
}
```

单个 scenario 失败(网络、chromedp 超时等)不取消整批,记 `infraError` 让 LLM 看到"哪些没跑通"——这本身也是诊断信号。

---

## LLMPayload 结构

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
  hypothesis?: string;              // 来自 register 时的 hypothesis
  intent?: string;                  // 来自 register 时的 intent
  tags?: string[];                  // 来自 register 时的 tags
  facts: {
    timeline: Array<{               // 按时间排序的动作/marker/observe/expect 流
      t: number;                    // 相对开始 ms
      type: string;                 // step kind / marker / observe / expect
      name: string;
      ok?: boolean;
      intent?: string;              // ← 来自 step.intent,LLM 看这里就知道动作目的
      detail?: string;
    }>;
    state: Record<string, any>;     // .read() 收集的最终值
    tracks: Array<{                 // 按 activity 排序的 top N 信号轨道
      key: string;
      overall: string;              // O=... H=... L=... C=... 摘要
      windows: { around, pre, post, delta }[];  // 动作前后的局部 K 线
      totalActivity: number;
    }>;
  };
  verdict: {
    intervalScore: number;          // 相邻 marker 间是否 HEALTHY
    expectScore: number;            // expect() 通过率
    audioScore: number;             // 动作后 600ms 是否有 audio peak
    overallScore: number;
    intervals: { range, durationMs, verdict, correlation }[];
    audioSyncs: { action, latencyMs, verdict }[];
    alerts: string[];
  };
}
```

`overallScore = (intervalScore + expectScore + audioScore) / 3`。
LLM 拿到这三项 + K 线轨迹 + 行为时间线 + 三层 intent 后,给出最终 PASS/PARTIAL/FAIL 判决。

### Frame buffer 上限

SessionRunner 默认 `maxFrames=800`(可由 `RunnerOptions.maxFrames` 覆盖)。超过时丢中段保两端(60%/40%),`meta.framesTruncated=true` 让 LLM 知道信号不完整。这避免了长跑 session 让 LLMPayload 爆炸。

---

## 跨场景判决:单次 LLM 聚合

`/webops/diagnose-batch` 不是"N 个 scenario 调 N 次 LLM 再做汇总"——而是把所有 payload 一次丢给 LLM,让它在统一上下文里做跨场景根因分析。

聚合 prompt 大致结构(见 webops.go `callLLMBatch`):

```
# GAME DESIGN INTENT
{gameIntent}

# SCENARIOS IN THIS BATCH
- perfect-player
    intent:     验证按键-分类的因果链路实现正确
    hypothesis: 每次正确按键 → +100 分...
    tags:       [happy-path]
- lazy-player
    intent:     验证错误反馈与 gameover 终止逻辑
    ...

# PAYLOADS (one per scenario)
## scenario: perfect-player
```json
{ ... LLMPayload 原文 ... }
```
## scenario: lazy-player
...

Now output your JSON judgment.
```

LLM 输出 strict JSON,关键字段:

```json
{
  "perScenario": [{ "scenarioId", "verdict", "score", "evidence" }, ...],
  "crossScenarioFindings": [{ "pattern", "scenariosAffected", "evidence" }, ...],
  "rootCauses": [{
    "issue": "...",
    "suggestedFix": {
      "target": "code" | "script" | "both",
      "file":   "Angle_SortingChaos.tsx | scripts.ts | ...",
      "change": "..."
    }
  }],
  "notes": "..."
}
```

`suggestedFix.target` 强制 LLM 声明本次建议改的是源码、脚本还是两者——同一症状可能两种解读(游戏逻辑错 vs 脚本期待错),不让 LLM 模糊带过。

---

## V3 → V4 迁移:确切删除清单

V3 项目里需要清理的文件:

**TS 探针侧(全删)**
- `webops-agent.js`、`viztel-agent.js` 及打包产物
- `typescript/AgentEntryPoint.ts`(独立注入入口,V4 不再独立打包)
- `typescript/DOMTelemetryRuntime.ts`、`VirtualChannelManager.ts`、`AudioTelemetryRuntime.ts`、`VisualAttentionModel.ts`、`TelemetryPayloadSchema.ts`
- `typescript/orchestration/TimelineExecutor.ts`(连同 ATP JSON 协议)
- `typescript/diagnosis/MarkerAlignmentAnalyzer.ts`、`TopologyChecker.ts`
- `EntityTracker` / `hashSemantic` / `getMortonCode2D` / `sniffSalientElements` 整套智能嗅探代码
- V3 的 `sdk/react-webops/` 目录

**Go 后端(整体替换)**
- ❌ `webops/store.go`(Redis 流式存储)
- ❌ `webops/analysis.go`(AnalysisEngine)
- ❌ `webops/api.go` 中的 `/ouroboros/ingest` 和 `/ouroboros/diagnose` 处理器
- ❌ `chromedp.ExposeFunction("__OUROBOROS_TUNNEL__", ...)` 注册代码
- ❌ Redis 客户端依赖
- ✅ 整体替换为单文件 `webops.go`

---

## V3 vs V4 设计差异速查

| 维度 | V3 | V4 |
|---|---|---|
| 探针注入 | chromedp 注入独立 bundle,业务零侵入 | 业务 `import @/webops` |
| 数据通道 | 流式 → Redis → AnalysisEngine | 一次性 LLMPayload 直接送 LLM |
| 后端复杂度 | 4 个端点 + Redis + Go 分析引擎 | 1 个文件 + 3 个端点 |
| 适用范围 | 任何 HTML(智能嗅探) | 仅 React/Next.js + R3F |
| 调度 | ATP JSON 时间轴(盲跑) | Script DSL(read/branch/loop/dispatch) |
| 分析时机 | 后端 Go(扫历史 frame) | 前端 TS(同进程拿到完整 session) |
| Go 侧数据类型 | DTO 全部定义,与前端结构强耦合 | 不定义任何业务结构,JSON 当文本透传 |
| 并发 | 单流单 worker | 共享 Browser + 信号量 + batch fan-out |
| 意图建模 | 无 | 三层(game / scenario / action) |
