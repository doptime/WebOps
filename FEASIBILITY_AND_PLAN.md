# WebOps V6 可行性分析与实施方案

> 目标:取消 K 线(OHLC)数值遥测链路,把审计输入改成**真实视频帧 + 真实音频 + 时间锚**,
> 交给 vLLM 上的多模态 Qwen 模型判断。**声音和画面都保留。**
>
> 本文是你明确要的“深度分析、确保方案可行性”。先读第 1 节——它直接决定你选哪个模型、要不要改预算。

---

## 1. 最关键的结论:你点名的 “qwen3.6-27B” 大概率**听不见声音**

这是整个方案的成败开关,必须放在最前面。

Qwen 的多模态分两条产品线,能力**不对称**:

- **VL 线**(Qwen3-VL,以及命名里带 “VL / 35B-A3B / 27B” 这类视觉语言模型)是**纯视觉**的。
  在 vLLM 上它确实能吃“视频”,但所谓视频 = vLLM 把 mp4 **抽成 JPEG 帧**再喂进去;
  **音轨在解码阶段就被丢弃**。也就是说,你给一个 VL 模型送带声音的 mp4,它**只看得到画面,
  根本拿不到声音**。这无法满足你“声音画面都要保留”的硬要求。

- **Omni 线**(Qwen2.5-Omni、**Qwen3-Omni-30B-A3B**)才**同时支持音频 + 视频 + 文本**。
  这是唯一能“既看又听”的选择。

你给的型号名 “qwen3.6-27B” 没有 “Omni” 字样,按命名习惯几乎可以肯定是 **VL 系**。
**如果直接用它,你会买一堆 GPU、跑通整条流水线,最后发现模型从头到尾没听过一秒声音**——
而“音画同步 / 有没有播音效”恰恰是这次改造最想让模型判断的东西。

### 建议的模型

**Qwen3-Omni-30B-A3B-Thinking**(MoE,总参 ~30B、激活 ~3B)。
- 能 听+看+读,输出文本分析,正好匹配“审计判断”这种纯文本产出的需求。
- 注意:当前 vLLM serve 对 Qwen3-Omni **只起 Thinker(出文本)**,不起 Talker(出语音)。
  对我们没影响——我们要的就是文字诊断。

> 如果你受限于显存只能上 VL,那必须**接受“放弃声音”**,并把方案降级为“纯画面审计”。
> 这是一个产品决策,不该由代码默默替你做掉,所以我把它显式摆在这里。

---

## 2. 第二个硬约束:vLLM 上必须把“帧”和“音频”**分两路**送

Qwen3-Omni 原生有个 `use_audio_in_video` 开关,能让模型把“视频里的声音”和画面自动对齐。
**但这个参数在 vLLM serve 上当前不可用。**

因此本方案的捕获侧刻意产出两份独立产物:

- 一组**无声视频帧**(`frames/000001.jpg ...`)
- 一份**独立音频**(`audio.wav`)

请求里它们作为两路 content part 分别送入(帧 = 多张 `image_url`,音频 = `input_audio`)。
模型靠 `report.json` 里每条事件的**毫秒锚 `t`** 在时间上把两路对齐——这就是 V6 用“时间锚”
取代 K 线的核心理由:K 线时代用数字逼近“第几毫秒发生了什么”,现在改成把真实毫秒时间戳
直接喂给能看能听的模型,让它自己对齐。

`serving/vllm_client.py` 已按这个约束实现(两路独立 part)。

---

## 3. 为什么是“帧”,不是“mp4”——顺便天然满足你的“图片兜底”

你说“转化为视频,视频做不到就图片”。结论是:**直接以帧为主产物,是最优解,而不是退而求其次。**

理由:
1. vLLM 给 VL/Omni 喂视频时,**内部本来就是抽帧**。我们直接产出帧,等于跳过一次“编码成 mp4
   再被解码抽帧”的无谓往返,**没有信息损失,反而更省**。
2. 帧序列对 headless Chrome 截屏(CDP `Page.startScreencast`)是最自然的产物,落盘即用。
3. “图片兜底”不再是降级——它就是主路径。需要人工回看时,驱动器可选地再用 ffmpeg 把
   `frames/ + audio.wav` mux 成一个 mp4(代码里已留命令注释),但**喂模型的始终是帧**。

帧率默认 **4 fps**:足够让模型看清 UI 反馈(按钮高亮、计分跳变、弹窗出现);
更高帧率只增 token、不增有效信息。10 秒交互 ≈ 40 帧,客户端 `--max-frames` 还会在过长时
按时间均匀下采样。

---

## 4. 捕获架构:视频走驱动器,音频走页内,靠一次握手对齐 t0

最棘手的是**音频**。headless Chrome 默认没有声卡,常见做法是 Xvfb + PulseAudio 虚拟声卡 +
ffmpeg 录系统声——又重又脆。

V6 绕开了它:原框架里**本就 monkey-patch 了 `AudioContext`** 来做 RMS/peak 数值遥测。
我们复用这个“拦截点”,把被拦截的音频节点 tee 一路进 `MediaStreamAudioDestinationNode` →
`MediaRecorder`,直接在页内把 **WebAudio 图本身**录成 webm/opus。
**MediaRecorder 录的是音频图,不依赖物理声卡**,所以 headless 下零 OS 音频配置即可拿到声音。
(`core--audio-capture.ts` 已实现。)

视频则走驱动器:Go/chromedp 通过 CDP `Page.startScreencast` 抓 JPEG 帧,DOM/WebGL/R3F 都能截,
`--headless=new` 下无需 Xvfb。(`driver/cdp_screencast.go` 已实现。)

**两路怎么共享同一个 t=0?** 一次握手:
1. 前端 `SessionRunner` 在开跑前置 `window.__WEBOPS_CAPTURE__ = {state:'arm'}` 并启动页内音频录制;
2. 驱动器轮询到 `arm`,启动 screencast,然后置 `window.__WEBOPS_CAPTURE_ACK__ = true`;
3. 前端见到 ACK,**此刻**锁定 `captureT0 = performance.now()`,`EventSink.anchor(t0)`,才开始派发脚本步骤。

于是 `timeline` 里每条 `t`、视频第一帧、音频第 0 毫秒,**共用同一个起点**。
(`session--SessionRunner.ts` 的 `withCapture()` 已实现这套生命周期。)

数据流总览:

```
┌─ 浏览器页内 (TypeScript) ────────────────────────────────┐
│ SessionRunner.withCapture()                              │
│   ├─ AudioCapture: AudioContext 拦截 → MediaRecorder     │  → window.__WEBOPS_AUDIO__ (base64 webm)
│   ├─ armCapture 握手 → 拿 ACK → anchor(t0)               │
│   ├─ ActionDispatcher: 派发 click/key/... → EventSink    │  → timeline[] (毫秒锚)
│   └─ read(): 业务状态 → state{}                          │
└──────────────────────────────────────────────────────────┘
                    ▲ CDP                         │ JSON (MediaSessionReport)
                    │ startScreencast              ▼
┌─ 驱动器 (Go / chromedp) ─────────────────────────────────┐
│ RunScenario(): 截帧落盘 frames/*.jpg                     │
│   ├─ 见 arm → startScreencast → 置 ACK                   │
│   ├─ 收 report.json,解码 __WEBOPS_AUDIO__ base64        │
│   └─ ffmpeg → audio.wav (16k mono)                       │
└──────────────────────────────────────────────────────────┘
                    │ out/<scenarioId>/{frames/, audio.wav, report.json}
                    ▼
┌─ 服务侧 (Python) ────────────────────────────────────────┐
│ serving/vllm_client.py                                   │
│   ├─ 读三样产物,组装 OpenAI 多模态请求                  │
│   ├─ 帧→image_url[]   音频→input_audio   时间锚→text     │
│   └─ POST vLLM /v1/chat/completions (Qwen3-Omni)         │
└──────────────────────────────────────────────────────────┘
                    ▼  模型输出:逐时间锚的“看到/听到了什么 + 异常 + 结论”
```

---

## 5. 删了什么,换成了什么

| 维度 | V4(K 线 / 文本 LLM) | V6(媒体 / 多模态) |
|---|---|---|
| 视觉“事实” | DOM 位置 / 视觉权重的 OHLC K 线 | 真实截屏帧 |
| 听觉“事实” | AudioContext 的 RMS/peak **数值**(非录音) | 真实录下的 WebAudio 音频 |
| 信号总线 | `VirtualChannel`(K 线信号) | `EventSink`(毫秒锚事件) |
| 压缩 | `report--compress`(K 线压缩) | 删除(帧/音频不需要这种压缩) |
| 判决 | 前端算 `intervalScore/audioScore/audio-sync` | **删除**,判决交给模型 |
| 模型输入 | `LLMPayload`(纯文本/JSON) | `MediaPayload`(帧引用 + 音频引用 + 时间锚) |
| 模型 | 文本 LLM | Qwen3-Omni(看+听+读) |

**保留不动**的是“驱动浏览器”那一半:`script--Script.ts`(DSL)、`runtime.ts`(生产门 `?webops=1`)、
React 的 `useTrack`/zustand 接入(现为惰性,状态改由 `read()` 取)。详见 `MIGRATION_V4_to_V6.md`。

---

## 6. 可行性判定逐项核对

| 要求 | 可行? | 依据 / 前提 |
|---|---|---|
| 取消 K 线逻辑 | ✅ 已做 | kline / virtual-channel / compress / analyzer 已从 V6 移除,TS 编译通过 |
| 转视频(或图片) | ✅ 已做 | CDP 截帧产出 `frames/`;可选 ffmpeg mux mp4。帧即“图片兜底”,且是模型最优输入 |
| 保留声音 | ✅ 可行 | MediaRecorder 录 WebAudio 图,headless 零声卡配置;**前提是模型选 Omni** |
| 保留画面 | ✅ 可行 | 同上,CDP 截帧 |
| vLLM 分析 | ✅ 可行 | 客户端按 OpenAI 兼容接口实现,帧/音频分两路送 |
| 用 “qwen3.6-27B” | ⚠️ **有条件** | 若它是 VL 系→**听不见声音,不满足要求**。需换 Qwen3-Omni-30B-A3B-Thinking |

---

## 7. 诚实的测试状态(没粉饰)

本环境**无 Go、无 Chrome、无网络、无 GPU**,所以验证程度分三档:

- **已编译验证**:全部 TypeScript 用 `tsc` 严格编译通过(`tsconfig.check.json`,退出码 0)。
  Python 客户端 `py_compile` 通过,且 `--dry-run` 实跑过合成数据,时间锚组装正确。
- **已按真实规范编写、但未实跑**:Go 驱动器(CDP screencast + 音频 base64 回收 + ffmpeg 转码)、
  vLLM 请求体格式。它们是“照接口写对的代码”,不是“跑过的代码”。
- **上真机后必查的点**:
  1. 先确认模型是 **Omni** 不是 VL(`/v1/models` 看到的名字、或喂一段纯音频测试它是否“听得见”)。
  2. vLLM 版本:Qwen3-VL 需 `vllm>=0.11.0`;Qwen3-Omni 按其 model card 对齐版本与 `--allowed-local-media-path` 等启动参数。
  3. 音频:确认被测页**确实建了 AudioContext**(没建则 `captured=false`,客户端会告警);
     确认 `MediaRecorder` 的 mime 在目标 Chrome 可用,ffmpeg 能把 webm/opus 转 wav。
  4. 握手时序:在慢机器上验证 ACK 不晚于首帧,避免 t0 漂移。
  5. token 预算:按 `--max-frames` 与音频时长估算单场景 token,必要时下调 fps 或下采样。

---

## 8. 上手顺序

1. 起 vLLM(**Omni** 模型):
   `vllm serve Qwen/Qwen3-Omni-30B-A3B-Thinking`(按其 model card 配 dtype / 显存 / 多模限制)。
2. 构建并跑驱动器(需 Go + Chrome):
   `go run driver/cdp_screencast.go <urlBase> <scenarioId> ./out 4`
   产出 `out/<scenarioId>/{frames/, audio.wav, report.json}`。
3. 跑分析:
   `python serving/vllm_client.py out/<scenarioId> --model Qwen/Qwen3-Omni-30B-A3B-Thinking`
   先加 `--dry-run` 看组装的文本锚对不对,再正式发。

---

**一句话总结**:方案整体可行,K 线已彻底换成“真画面 + 真声音 + 毫秒时间锚”。
唯一会让它失败的,是模型选成**只会看不会听的 VL**——所以请把 “qwen3.6-27B” 换成
**Qwen3-Omni-30B-A3B-Thinking**,否则“保留声音”这条做不到。
