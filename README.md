# WebOps V4 (Flat Layout)

> "One call. Full session. LLM-ready."

V4 把 V3 四步流程 (`start` → `execute` → `wait` → `analyze`) 收敛为一次原子调用 `runSession(script)`,产出可直接送给大模型的 `LLMPayload`。

整个工程是**单层级文件结构**:不需要展开任何子目录就能看完所有文件。原本目录关系通过 `--` 命名前缀保留:`core--kline.ts` 表示"原本属于 core 目录的 kline 模块"。

## 完整文件清单(单层级)

```
webops-v4/
├── README.md
├── package.json
├── tsconfig.json
├── webops.go                                          ← Go 后端,单文件,可直接 go run
│
├── agent.ts                                           ← [入口] window.WebOps,业务代码 import 这个
├── index.ts                                           ← 内部 re-export
│
├── core--kline.ts                                     ← OHLC K 线工具
├── core--visual-attention.ts                          ← 视觉权重计算
├── core--virtual-channel.ts                           ← 信号汇流通道
├── core--dom-telemetry.ts                             ← DOM 探针
├── core--audio-telemetry.ts                           ← 音频探针 (Monkey-Patch AudioContext)
├── core--r3f-bridge.ts                                ← R3F 3D 场景桥接
│
├── script--Script.ts                                  ← Script DSL 链式构建器
├── script--actions.ts                                 ← PointerEvent/键盘事件派发
│
├── session--SessionRunner.ts                          ← 一体化会话引擎
│
├── report--compress.ts                                ← K 线压缩(±400ms 窗口)
├── report--analyzer.ts                                ← 自动诊断(原 V3 Go AnalysisEngine)
├── report--ReportBuilder.ts                           ← LLMPayload 组装
│
├── react--useTrack.ts                                 ← React Hook: 声明式追踪
├── react--zustand-telemetry.ts                        ← Zustand middleware
│
├── llm--prompt.ts                                     ← 前端版 prompt 构造器(可在浏览器内调 LLM)
│
├── examples--angle-sorting--Angle_SortingChaos.instrumented.tsx
├── examples--angle-sorting--scripts.ts
└── examples--angle-sorting--run.ts
```

## 端到端流程

```
[Go 后端 webops.go]              [Headless Chrome]              [Next.js 应用]
                                                                  (已 import @/webops)
POST /webops/diagnose
  url, scenarioId, hypothesis
   │
   ▼
chromedp.Navigate ─────────► 加载页面
                                │
                                ▼
                          window.WebOps 注入完毕
                                │
chromedp.Evaluate ─────────► window.WebOps.run('perfect-player')
                                │
                                ▼ runSession(script)
                          一次性产出 LLMPayload (字符串)
                                │
   ◄────────────────────────── 字符串原文
   │
   ▼ (透传给 LLM,Go 不解析)
POST → Anthropic
   │
   ▼
verdict 字符串原文 + payload 原文
   │
   ▼
返回给调用方,由调用方决定怎么解析
```

## 业务代码接入(三步)

**Step 1.** Next.js 配置一个 alias 指到 agent.ts:
```js
// next.config.mjs
import path from 'path';
export default {
  webpack: (config) => {
    config.resolve.alias['@/webops'] = path.resolve('./webops-v4/agent.ts');
    return config;
  }
};
```

**Step 2.** 应用启动时注册剧本(任何 client 组件里都行):
```tsx
'use client';
import { useEffect } from 'react';
import { webops } from '@/webops';
import { perfectPlayer, lazyPlayer } from '@/games/angle-sorting/scripts';

export function WebOpsBootstrap() {
  useEffect(() => {
    webops.register('perfect-player', {
      build: perfectPlayer,
      hypothesis: '正确按键应能通关 victory,score≥1500'
    });
    webops.register('lazy-player', {
      build: lazyPlayer,
      hypothesis: '永远按 a 应在 lives=0 时 gameover'
    });
  }, []);
  return null;
}
```

**Step 3.** Game 组件用 `useTrack` / `withTelemetry` 暴露信号(见 `examples--angle-sorting--Angle_SortingChaos.instrumented.tsx`)。

## Go 后端启动(单文件)

```bash
go mod init yourorg/webops
go get github.com/chromedp/chromedp
ANTHROPIC_API_KEY=sk-ant-... go run webops.go
```

```bash
curl -X POST http://localhost:8080/webops/diagnose \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "http://localhost:3000/games/angle",
    "scenarioId": "perfect-player",
    "hypothesis": "正确按键应能通关 victory,score≥1500"
  }'
```

返回:
```json
{
  "ok": true,
  "payload": { /* 前端原文 LLMPayload,Go 不解析 */ },
  "verdict": "{ \"verdict\": \"PASS\", \"score\": 92, ... }",
  "durationMs": 8421
}
```

> **注意**:`verdict` 字段是 LLM 输出的字符串(里面通常是 JSON),需要调用方再 `JSON.parse` 一次。这是 Go 侧"不持有任何业务数据类型"原则带来的取舍 —— 后端纯粹做透传,所有 schema 由前端定义。

## V3 → V4 迁移:确切删除清单

V3 项目里需要清理的文件:

**TS 探针侧(全删)**
- `webops-agent.js`、`viztel-agent.js` 及打包产物
- `typescript/AgentEntryPoint.ts`(独立注入入口,V4 不再独立打包)
- `typescript/DOMTelemetryRuntime.ts`、`VirtualChannelManager.ts`、`AudioTelemetryRuntime.ts`、`VisualAttentionModel.ts`、`TelemetryPayloadSchema.ts`
- `typescript/orchestration/TimelineExecutor.ts`(连同 ATP JSON 协议)
- `typescript/diagnosis/MarkerAlignmentAnalyzer.ts`、`TopologyChecker.ts`
- `EntityTracker` / `hashSemantic` / `getMortonCode2D` / `sniffSalientElements` 这一整套智能嗅探代码
- V3 的 `sdk/react-webops/` 目录

**Go 后端(整体替换)**
- ❌ `webops/store.go`(Redis 流式存储)
- ❌ `webops/analysis.go`(AnalysisEngine)
- ❌ `webops/api.go` 中的 `/ouroboros/ingest` 和 `/ouroboros/diagnose` 处理器
- ❌ `chromedp.ExposeFunction("__OUROBOROS_TUNNEL__", ...)` 注册代码
- ❌ Redis 客户端依赖
- ✅ 整体替换为单文件 `webops.go`

## 设计差异(V3 vs V4 速查)

| 维度 | V3 | V4 |
|---|---|---|
| 探针注入 | chromedp 注入独立 bundle,业务零侵入 | 业务 import `@/webops` |
| 数据通道 | 流式 → Redis → AnalysisEngine | 一次性 LLMPayload 直接送 LLM |
| 后端复杂度 | 4 个端点 + Redis + Go 分析引擎 | 1 个文件 + 1 个端点 |
| 适用范围 | 任何 HTML(智能嗅探) | 仅 React/Next.js + R3F |
| 调度 | ATP JSON 时间轴(盲跑) | Script DSL(可 read/branch/loop) |
| 分析时机 | 后端 Go(扫历史 frame) | 前端 TS(同进程内拿到完整 session) |
| Go 侧数据类型 | DTO 全部定义,与前端结构强耦合 | 不定义任何业务结构,JSON 当文本透传 |

## 评分模型

```
overallScore = (intervalScore + expectScore + audioScore) / 3
```

- **intervalScore** ∈ [0, 100]:每对相邻 marker 间是否 HEALTHY
- **expectScore** ∈ [0, 100]:`script.expect()` 通过率
- **audioScore** ∈ [0, 100]:动作后 600ms 内是否有音频 peak

LLM 拿到这三项 + K 线轨迹 + 行为时间线后,产出最终的 PASS/PARTIAL/FAIL 判决。
