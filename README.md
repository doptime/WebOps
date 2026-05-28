# WebOps V6

驱动一个 React/Next.js/R3F 应用，把整个 session 录成**视频帧 + 音频 + 毫秒级事件时间线**，
交给多模态模型判断。没有 K 线、没有数值降维 —— 模型直接看画面、听声音。

> 你的用法:用 **oh-my-pi (omp)** 当 agent harness。omp 把下面的 Go 程序当黑盒 CLI 调，
> 读它产出的产物喂自己的多模态模型。所以本包**不含也不需要** `vllm_client.py`(已移除)。

---

## 目录速览

```
webops_v6/
├── go.mod                      # Go 模块(go mod tidy 自动补依赖)
├── *.ts                        # 浏览器侧 WebOps 运行时(注入被测页面)
│   ├── agent.ts                #   window.WebOps:run(id) / runScript(src,ctx) → MediaSessionReport
│   ├── session--SessionRunner.ts  # 捕获握手 + EventSink + 音频生命周期
│   ├── core--event-sink.ts     #   毫秒锚事件时间线
│   ├── core--audio-capture.ts  #   AudioContext tee → MediaRecorder → base64
│   ├── report--MediaPayload.ts #   MediaSessionReport 类型
│   ├── runtime.ts              #   生产闸 shouldEnableWebOps + 惰性 hook/中间件
│   └── react--*.ts, script--*.ts, index.ts, report--ReportBuilder.ts
├── driver/
│   └── cdp_screencast.go       # 通用驱动器:CDP screencast 截帧 + 取音频 + ffmpeg(走 run(id))
├── apps/coffee-cloze/          # ★ Coffee Cloze 的 V6 审计(本次工作重点)
│   ├── coffee_cloze_audit.go   #   单文件 CLI:握手+截帧+录音+report+确定性断言报告(走 runScript)
│   ├── webops_bootstrap.ts     #   页面编排修复 #1(必须):挂 window.WebOps
│   ├── game_audio_sfx.ts       #   页面编排修复 #2(推荐):可被录到的 WebAudio 音效
│   └── PAGE_ORCHESTRATION_V6.md #  两处页面编排调整 + 逐行 diff
├── examples/angle-sorting/     # 另一个游戏的脚本示例(参考用)
├── FEASIBILITY_AND_PLAN.md     # 可行性分析(VL vs Omni、为什么音视频分开喂)
└── MIGRATION_V4_to_V6.md       # 从 V4(K 线)迁移到 V6(媒体)的对照
```

---

## 需要下载的东西(仔细核对过的清单)

把代码拿到你的机器后，按用途装这些。**本环境离线、无 Go/Chrome/GPU，所以下面全部未实跑验证**，
但依赖项是逐文件扫 import 列出的。

### 1. Go 侧(跑 driver / audit）

只有两个直接外部依赖，外加 chromedp 间接拖入的 cdproto；`go mod tidy` 会全部搞定:

```bash
cd webops_v6
go mod tidy        # 联网一次:拉 github.com/chromedp/chromedp、golang.org/x/sync,
                   # 以及间接的 github.com/chromedp/cdproto 等,并生成 go.sum
```

直接依赖:
- `github.com/chromedp/chromedp` —— CDP 驱动(导航、Evaluate、ListenTarget、screencast)
- `golang.org/x/sync/errgroup` —— 并行跑多场景

间接依赖(tidy 自动带):`github.com/chromedp/cdproto`(用到 `page`、`runtime` 子包)、
`github.com/gobwas/ws`、`github.com/mailru/easyjson` 等。

### 2. 系统二进制(Go 程序运行时要找的外部命令）

- **Chrome / Chromium** —— chromedp 要启一个无头浏览器。装系统 Chrome 即可,或设
  `CHROME_PATH` 指向 Chromium。**这是必须的,没有它一帧都截不到。**
- **ffmpeg** —— 把录到的 webm/opus 转成 16k mono `audio.wav`。
  缺失时 `audit.go` 不会崩,会保留 `audio.webm` 并在报告里标 `media warn: ffmpeg not found`。
  装法:`apt install ffmpeg` / `brew install ffmpeg`。

> 注意:**不需要 Xvfb,也不需要 PulseAudio 虚拟声卡。** V6 的音频走 WebAudio 图内部 tee
> (MediaRecorder),不依赖任何 OS 声卡 —— 这正是相对"抓系统音"路线的最大好处。

### 3. 浏览器侧 TS(把 WebOps 编进被测页面的 bundle)

WebOps 的 TS **没有自己的运行时 npm 依赖**;它只 peer-depend 宿主应用已经有的:
- `react >= 18`、`zustand >= 4`(被测游戏本来就装了)

构建/类型检查用(dev):
- `typescript ^5.4`、`@types/react ^18`
- `npm i` 即可(见 `package.json`),`npm run typecheck` 跑 `tsc --noEmit`。

### 4. 模型侧(omp 那边,不在本包内)

omp 用什么多模态模型由你定,但有一条硬约束:**要判"声音",模型必须能吃音频**
(如 Qwen3-Omni 这类 omni 模型),纯视觉的 Qwen-VL 在推理时会把视频解码成帧后丢掉音频。
详见 `FEASIBILITY_AND_PLAN.md`。

---

## omp 集成契约(Go 程序 = 黑盒 CLI)

omp 看不见 Go 代码内部,只把它当 CLI 调、读产物。契约如下:

**调用:**
```bash
go run ./apps/coffee-cloze \
  -url http://localhost:3001 \
  -out ./out -fps 4 \
  -json                 # 给 omp 解析就加 -json;给人看就去掉(着色文本)
  # -strict             # 任一 expect 失败则退出码非 0
```

**stdout（`-json` 时):** 一个 JSON 对象,每个场景含 `status`(PASS/FAIL/PARTIAL/INFRA_FAIL/ABORTED)、
`outDir`、`frameCount`、`audioWav`、`mediaWarn`、以及完整 `report`(MediaSessionReport)。

**落盘产物(omp 喂模型的输入):**
```
out/<scenarioId>/
├── frames/000000.jpg, 000001.jpg, ...   # 按 fps 抽的帧(无声画面)
├── audio.wav                            # 16k mono;没采到声音则缺席(见 mediaWarn)
└── report.json                          # 时间线 + 业务状态 + 断言,带毫秒锚,和帧/音频同一个 t0
```

**两层判断,职责分开:**
- Go 侧 `expect` 断言判**状态机对不对**(便宜、确定,是廉价闸门);
- omp 的多模态模型判**画面/声音对不对**(答对有没有变绿、答错有没有摇晃、音效是否与画面同步)。

omp 典型流程:跑 CLI → 读 `-json` 的 status 做粗筛 → 把 `frames/ + audio.wav + report.json`
组成多模态 prompt 交模型出细判。

---

## 跑之前别忘了页面编排两处调整

`apps/coffee-cloze/PAGE_ORCHESTRATION_V6.md` 有逐行 diff。一句话:

1. **(必须)** 在游戏组件加 `useWebOpsBootstrap()` —— 否则 `window.WebOps` 不存在,审计 attach 不上。
2. **(推荐)** 接入 `game_audio_sfx.ts` —— 否则游戏只有 Web Speech,录音录到的是静音。
