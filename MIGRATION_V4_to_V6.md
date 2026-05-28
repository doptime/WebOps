# WebOps V4 → V6 迁移说明

V6 的一句话定位:**把“给文本 LLM 看的 K 线数值”换成“给多模态模型看的真画面 + 听的真声音 + 毫秒时间锚”。**
驱动浏览器的那一半(脚本 DSL、生产门、动作派发)基本不动;遥测/压缩/判决那一半整体重写。

完整的“为什么这么改、可行性如何”见 `FEASIBILITY_AND_PLAN.md`。本文档只讲“迁移时删什么、换什么、注意什么”。

---

## 一、删除清单(V4 → V6)

以下文件/能力在 V6 中**移除**,因为它们是“K 线 + 文本 LLM”时代的产物:

| 删除项 | 原职责 | 为何删 |
|---|---|---|
| `core--kline.ts` | OHLC K 线数据类型与聚合 | V6 不再把信号聚合成数值;模型直接看帧/听音 |
| `core--virtual-channel.ts` | K 线信号总线 | 由 `core--event-sink.ts`(毫秒锚事件)取代 |
| `core--dom-telemetry.ts` | DOM 位置/视觉权重 → K 线 | 视觉事实改由截屏帧承载 |
| `core--r3f-bridge.ts` | R3F 3D 投影坐标 → K 线 | 同上,3D 表现直接看帧 |
| `core--visual-attention.ts` | 视觉权重/rank 计算 | 同上 |
| `report--compress.ts` | “K 线压缩” | 帧/音频不需要这种数值压缩 |
| `report--analyzer.ts` | `intervalScore/audioScore/audio-sync` 数值判决 | **判决整段交给模型**,前端不再算分 |
| `LLMPayload`(原 ReportBuilder 产物) | 纯文本/JSON 负载 | 由 `MediaPayload`(帧引用 + 音频引用 + 时间锚)取代 |

> 注意:`core--audio-telemetry.ts` 的**思路**被保留并改造——它对 `AudioContext` 的 monkey-patch
> 拦截点正是 V6 录真实音频的接入处(见 `core--audio-capture.ts`)。但它原来产出的是 RMS/peak
> **数值**(非录音),那部分数值遥测随 K 线一起取消。

---

## 二、新增/重写清单

| 文件 | 取代 | 职责 |
|---|---|---|
| `core--event-sink.ts` | `virtual-channel` + `kline` | 记录毫秒锚事件流 `TimedEvent[]`,作为模型的时间锚 |
| `core--audio-capture.ts` | (新) | 复用 AudioContext 拦截点,`MediaRecorder` 录 WebAudio 图 → base64 |
| `report--MediaPayload.ts` | `LLMPayload` 类型 | `MediaPayload` / `MediaSessionReport` 等媒体导向类型 |
| `report--ReportBuilder.ts` | 旧 ReportBuilder + compress + analyzer | 只剩“组装 MediaPayload” + console 小结,**无数值判决** |
| `session--SessionRunner.ts` | 旧 SessionRunner | `withCapture()` 生命周期:启音频→握手→锚 t0→跑→收尾 |
| `script--actions.ts` | 旧 actions(写 VirtualChannel) | 派发逻辑不变,出口从 VirtualChannel 改为 EventSink |
| `agent.ts` | 旧 agent | `window.WebOps` 的 V4 `run` / V5 `runScript`,均产 `MediaSessionReport` |
| `driver/cdp_screencast.go` | 旧 `webops.go` 的取 JSON 部分 | CDP 截帧 + 音频 base64 回收 + ffmpeg 转码,与握手对齐 |
| `serving/vllm_client.py` | (新) | 读产物,组装多模态请求发 vLLM(帧/音频**分两路**) |

**原样保留**(驱动浏览器那一半):`script--Script.ts`、`runtime.ts`(生产门 `shouldEnableWebOps()` /
`?webops=1`)、`react--useTrack.ts`、`react--zustand-telemetry.ts`、`examples/`、`tsconfig.json`。

> React/zustand 接入现在是**惰性**的:V4 时它们 push 信号进 VirtualChannel,V6 没有 push 消费者了,
> 业务状态改为通过脚本 `read()` 主动读取并写进 `state`。文件保留是为了不破坏现有 import,
> 但不再驱动遥测,已在文件内注明。

---

## 三、字段/接口层面的迁移点

- **不再有 `verdict`**:V4 的报告里有 `intervalVerdict` 等前端判决字段;V6 的 `MediaSessionReport`
  / `MediaPayload` **没有任何分数或判决**。判断来自模型输出的文本。下游若读过 `verdict`,需改读模型回答。
- **`tracks` → `timeline`**:V4 的 `facts.tracks`(K 线轨道)没了;改读 `timeline`(`TimedEvent[]`,
  字段:`t / kind / name / ok? / intent? / detail?`,`t` 为相对 `captureT0` 的毫秒)。
- **新增 `media`**:`MediaPayload.media.video`(`MediaRef`,帧目录/帧率)与 `media.audio`
  (`AudioRef`,wav 路径 + `captured`)。前端阶段 `video` 为 `null`,由驱动器回填。
- **音频在前端是 base64**:`MediaSessionReport.audio = { mimeType, base64, durationMs, captured }`。
  驱动器解码 + ffmpeg 转 wav 后,把路径填进 `MediaPayload.media.audio.path`。

---

## 四、运行链路(V6)

```
浏览器(TS)  window.WebOps.run(scenarioId)
  → SessionRunner.withCapture():启音频录制 → armCapture 握手 → 拿 ACK → anchor(t0)
  → 跑脚本步骤:动作进 EventSink,read() 进 state
  → 收尾 600ms 尾音 → 停录 → 返回 MediaSessionReport(JSON,含音频 base64)

驱动器(Go)  go run driver/cdp_screencast.go <urlBase> <scenarioId> ./out 4
  → 见 arm 启 startScreencast 截帧落盘 → 置 ACK
  → 收 report.json → 解码音频 base64 → ffmpeg 转 audio.wav
  → 产出 out/<scenarioId>/{frames/, audio.wav, report.json}

服务(Python)  python serving/vllm_client.py out/<scenarioId> --model Qwen/Qwen3-Omni-30B-A3B-Thinking
  → 读三样产物 → 帧→image_url[]、音频→input_audio、时间锚→text(分两路)
  → POST vLLM /v1/chat/completions → 打印模型的逐锚分析 + 结论
```

---

## 五、迁移时最容易踩的三个坑

1. **模型选错线**:用了 VL 系(如 “qwen3.6-27B”)→ 音轨被 vLLM 丢弃,“保留声音”落空。
   必须用 **Omni**(`Qwen3-Omni-30B-A3B-Thinking`)。详见 `FEASIBILITY_AND_PLAN.md` 第 1 节。
2. **想用 `use_audio_in_video`**:vLLM serve 当前不支持,别传;帧和音频要**分两路**送(客户端已这么做)。
3. **t0 漂移**:握手 ACK 必须早于首帧与首个动作;慢机器上要验证,否则时间锚与视频/音频对不齐。
