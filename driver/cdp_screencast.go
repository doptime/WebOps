// driver/cdp_screencast.go
// WebOps V6 驱动器 —— 取代 V4 webops.go 里"调 WebOps.run 拿 JSON 就完事"的部分。
// 新增职责:在 session 期间用 CDP Page.startScreencast 抓视频帧、收尾后取走 in-page 录的音频,
// 与前端 SessionRunner 的"捕获握手"对齐,产出 frames/ + audio.wav 喂多模态模型。
//
// 为什么视频走 CDP 截帧而不是 in-page canvas.captureStream:
//   - 通用:DOM/WebGL/R3F/视频元素全覆盖,不依赖应用恰好只有一个 canvas;
//   - 干净:headless Chrome(--headless=new)用 SwiftShader/GPU 正常渲染 WebGL,无需 Xvfb;
//   - 对口:vLLM 给 Qwen3-VL/Omni 喂视频本就是"按帧采样",我们直接产帧最省一道转码。
// 音频则走 in-page MediaRecorder(core--audio-capture.ts),因为 CDP screencast 不含音轨,
// 且 headless Chrome 默认不向 OS 输出音频 —— in-page 录制零 OS 音频管线最稳。
//
// 依赖: go get github.com/chromedp/chromedp github.com/chromedp/cdproto
//        系统装 ffmpeg。
//
// 注意:本文件经设计审阅,但未在本环境跑通(无 Go/Chrome)。它是可直接落地的实现骨架。

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/chromedp/cdproto/page"
	"github.com/chromedp/chromedp"
)

const auditParam = "webops=1" // 必须与 runtime.ts shouldEnableWebOps 的 param/value 一致

// 一次 session 的产物目录布局:
//   out/<scenarioId>/frames/000001.jpg ...   (CDP 截帧)
//   out/<scenarioId>/audio.wav               (in-page 音频转码)
//   out/<scenarioId>/report.json             (MediaSessionReport)
type sessionArtifacts struct {
	Dir        string
	FramesDir  string
	AudioPath  string
	ReportJSON string
	FPS        int
}

// RunScenario: navigate → 等 WebOps.describe 就绪 → 起截帧协程 → 调 WebOps.run(id)
// → 收尾取音频 base64 → 落盘 + ffmpeg 转码。
func RunScenario(parent context.Context, urlBase, scenarioID, outRoot string, fps int) (*sessionArtifacts, error) {
	ctx, cancel := chromedp.NewContext(parent)
	defer cancel()

	art := &sessionArtifacts{
		Dir:       filepath.Join(outRoot, scenarioID),
		FPS:       fps,
	}
	art.FramesDir = filepath.Join(art.Dir, "frames")
	art.AudioPath = filepath.Join(art.Dir, "audio.wav")
	art.ReportJSON = filepath.Join(art.Dir, "report.json")
	if err := os.MkdirAll(art.FramesDir, 0o755); err != nil {
		return nil, err
	}

	url := applyAuditParam(urlBase)

	// ---- 截帧状态机 ----
	var (
		mu        sync.Mutex
		frameIdx  int
		recording bool
	)

	// Page.screencastFrame 回调:落盘 JPEG + Ack(否则 Chrome 停止推帧)。
	chromedp.ListenTarget(ctx, func(ev interface{}) {
		if f, ok := ev.(*page.EventScreencastFrame); ok {
			// 必须 Ack,否则 Chrome 不再推下一帧。
			go func(sid int64) {
				_ = chromedp.Run(ctx, page.ScreencastFrameAck(sid))
			}(f.SessionID)

			mu.Lock()
			rec := recording
			idx := frameIdx
			frameIdx++
			mu.Unlock()
			if !rec {
				return
			}
			data, err := base64.StdEncoding.DecodeString(f.Data)
			if err != nil {
				return
			}
			name := filepath.Join(art.FramesDir, fmt.Sprintf("%06d.jpg", idx))
			_ = os.WriteFile(name, data, 0o644)
		}
	})

	// ---- 导航 + 等待 agent 就绪 ----
	if err := chromedp.Run(ctx,
		chromedp.Navigate(url),
		chromedp.Poll(`!!(window.WebOps && window.WebOps.describe)`, nil, chromedp.WithPollingTimeout(20*time.Second)),
	); err != nil {
		return nil, fmt.Errorf("navigate/agent-ready: %w", err)
	}

	// ---- 捕获握手 ----
	// 前端 SessionRunner.armCapture 会置 window.__WEBOPS_CAPTURE__={state:'arm'} 然后轮询
	// __WEBOPS_CAPTURE_ACK__。我们在调用 run 之前先起一个协程:等到 arm → 开 screencast →
	// 置 ack=true。这样视频帧的起点严格早于脚本第一个动作,与前端 t0 对齐。
	armed := make(chan struct{}, 1)
	go func() {
		// 轮询 arm 标志
		_ = chromedp.Run(ctx, chromedp.Poll(
			`window.__WEBOPS_CAPTURE__ && window.__WEBOPS_CAPTURE__.state==='arm'`,
			nil, chromedp.WithPollingTimeout(25*time.Second)))
		// 开 screencast(JPEG,按 fps 控质量/频率由 EveryNthFrame 近似)
		_ = chromedp.Run(ctx, page.StartScreencast().
			WithFormat(page.ScreencastFormatJpeg).
			WithQuality(70).
			WithEveryNthFrame(1))
		mu.Lock()
		recording = true
		mu.Unlock()
		// 通知前端:录像已开
		_ = chromedp.Run(ctx, chromedp.Evaluate(`window.__WEBOPS_CAPTURE_ACK__=true;`, nil))
		armed <- struct{}{}
	}()

	// ---- 调 run,拿 MediaSessionReport(JSON 字符串)----
	var reportJSON string
	runExpr := fmt.Sprintf(`window.WebOps.run(%q)`, scenarioID)
	if err := chromedp.Run(ctx,
		chromedp.Evaluate(runExpr, &reportJSON, awaitPromise),
	); err != nil {
		return nil, fmt.Errorf("WebOps.run: %w", err)
	}

	// ---- 停截帧 ----
	mu.Lock()
	recording = false
	mu.Unlock()
	_ = chromedp.Run(ctx, page.StopScreencast())

	// ---- 取 in-page 音频 base64 ----
	// SessionRunner 收尾时 AudioCapture.stop() 会把结果挂到 window.__WEBOPS_AUDIO__。
	var audio struct {
		MimeType string `json:"mimeType"`
		Base64   string `json:"base64"`
		Captured bool   `json:"captured"`
	}
	_ = chromedp.Run(ctx, chromedp.Evaluate(`window.__WEBOPS_AUDIO__ || {captured:false}`, &audio))

	// ---- 落盘 report ----
	if err := os.WriteFile(art.ReportJSON, []byte(reportJSON), 0o644); err != nil {
		return nil, err
	}

	// ---- 音频:base64(webm/opus) → ffmpeg → wav 16k mono(模型友好)----
	if audio.Captured && audio.Base64 != "" {
		raw, err := base64.StdEncoding.DecodeString(audio.Base64)
		if err == nil {
			tmp := filepath.Join(art.Dir, "audio.webm")
			if os.WriteFile(tmp, raw, 0o644) == nil {
				// ffmpeg -i audio.webm -ac 1 -ar 16000 audio.wav
				cmd := exec.Command("ffmpeg", "-y", "-i", tmp, "-ac", "1", "-ar", "16000", art.AudioPath)
				cmd.Stderr = os.Stderr
				if err := cmd.Run(); err != nil {
					return art, fmt.Errorf("ffmpeg transcode: %w", err)
				}
			}
		}
	} else {
		art.AudioPath = "" // 本次没采到声音
	}

	// 可选:把 frames 再 mux 成 mp4 便于人工回看(模型侧仍用 frames):
	//   ffmpeg -framerate <fps> -i frames/%06d.jpg -i audio.wav -c:v libx264 -pix_fmt yuv420p -c:a aac out.mp4
	return art, nil
}

func applyAuditParam(u string) string {
	if u == "" {
		return u
	}
	sep := "?"
	for i := 0; i < len(u); i++ {
		if u[i] == '?' {
			sep = "&"
			break
		}
	}
	return u + sep + auditParam
}

// awaitPromise 让 Evaluate 等待返回的 Promise resolve(WebOps.run 是 async)。
func awaitPromise(p *chromedp.EvaluateParams) *chromedp.EvaluateParams {
	return p.WithAwaitPromise(true)
}

// main: 简易 CLI。真实部署里通常是 HTTP 服务 / AgentHarness 工具调用。
func main() {
	if len(os.Args) < 3 {
		fmt.Println("usage: cdp_screencast <urlBase> <scenarioId> [outRoot] [fps]")
		os.Exit(1)
	}
	urlBase, scenarioID := os.Args[1], os.Args[2]
	outRoot := "out"
	fps := 4 // 4fps 足够多模态模型理解 UI 反馈;高帧率只增 token 不增信息
	if len(os.Args) > 3 {
		outRoot = os.Args[3]
	}
	if len(os.Args) > 4 {
		fmt.Sscanf(os.Args[4], "%d", &fps)
	}

	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),       // --headless=new 由新版 chromedp 默认
		chromedp.Flag("hide-scrollbars", true),
		chromedp.Flag("mute-audio", false),     // 不静音:in-page MediaRecorder 才有信号
		chromedp.WindowSize(1280, 720),
	)
	alloc, cancelA := chromedp.NewExecAllocator(context.Background(), opts...)
	defer cancelA()

	art, err := RunScenario(alloc, urlBase, scenarioID, outRoot, fps)
	if err != nil {
		fmt.Fprintln(os.Stderr, "ERROR:", err)
		os.Exit(1)
	}
	b, _ := json.MarshalIndent(map[string]any{
		"framesDir": art.FramesDir, "audio": art.AudioPath, "report": art.ReportJSON, "fps": art.FPS,
	}, "", "  ")
	fmt.Println(string(b))
}
