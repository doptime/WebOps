// webops.go — V4 Go 后端,单文件全闭环。
//
// 设计原则:不定义任何业务数据类型。
//   - 从浏览器拿到的 LLMPayload 当作字符串(json.RawMessage)直接透传给 LLM
//   - LLM 返回的 verdict 也作为字符串原样回给调用方,由前端/调用方自行解析
//   - 后端只负责"导航 + 调脚本 + 调 LLM + 拼包返回",对载荷一无所知
//
// 用法:
//   go mod init yourorg/webops
//   go get github.com/chromedp/chromedp
//   ANTHROPIC_API_KEY=sk-ant-... go run webops.go
//
//   curl -X POST http://localhost:8080/webops/diagnose \
//     -H 'Content-Type: application/json' \
//     -d '{"url":"http://localhost:3000/games/angle","scenarioId":"perfect-player"}'

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"

	"github.com/chromedp/chromedp"
)

// 与前端 llm--prompt.ts 中的 SYSTEM_PROMPT 保持完全一致。
const systemPrompt = `You are an expert game design auditor. You receive structured telemetry from automated playthroughs of a web game (React + Next.js + R3F). Your job:

1. Read the developer's HYPOTHESIS — what should happen if the game is implemented correctly.
2. Read the FACTS — actions taken, observations, state reads, and signal tracks.
3. Read the AUTO_VERDICT — pre-computed scores and per-interval HEALTHY/NO_RESPONSE/CHAOTIC labels.
4. Output a clear judgment: did the game fulfill its design intent? If not, what specific issue occurred and where (cite step indices, marker names, or signal names).

Output STRICT JSON with this schema:
{
  "verdict": "PASS" | "PARTIAL" | "FAIL",
  "score": 0..100,
  "hypothesis_satisfied": [string],
  "hypothesis_violated": [string],
  "root_causes": [
    { "issue": string, "evidence": string, "suggested_fix": string }
  ],
  "notes": string
}

Rules:
- Be concrete: cite step names like "click@5" or marker names like "CLICK_ACUTE_CORRECT".
- Don't invent signals that aren't in the FACTS.
- If a signal's overall K-line is ∅ (empty), treat it as "never observed".
- An interval verdict of NO_RESPONSE is strong evidence of a UI deadlock.
- FAIL_SILENT in audioSyncs means the action did not produce expected sound feedback.
- expectScore < 100 means at least one explicit assertion failed.`

// runSessionInBrowser — 启动 chromedp,跑一次剧本,返回 window.WebOps.run() 的原文字符串。
// 该字符串由前端定义结构,本函数完全不解析。
func runSessionInBrowser(ctx context.Context, url, scenarioID string) (string, error) {
	allocCtx, cancelA := chromedp.NewExecAllocator(ctx)
	defer cancelA()
	bctx, cancelB := chromedp.NewContext(allocCtx)
	defer cancelB()

	navCtx, cancelNav := context.WithTimeout(bctx, 20*time.Second)
	defer cancelNav()
	if err := chromedp.Run(navCtx,
		chromedp.Navigate(url),
		chromedp.Poll(
			`typeof window.WebOps === 'object' && typeof window.WebOps.run === 'function'`,
			nil,
		),
	); err != nil {
		return "", fmt.Errorf("navigate / wait WebOps: %w", err)
	}

	runCtx, cancelRun := context.WithTimeout(bctx, 90*time.Second)
	defer cancelRun()
	var payload string
	expr := fmt.Sprintf(`window.WebOps.run(%q)`, scenarioID)
	if err := chromedp.Run(runCtx, chromedp.Evaluate(expr, &payload)); err != nil {
		return "", fmt.Errorf("evaluate run: %w", err)
	}
	return payload, nil
}

// callLLM — 把前端原文 payload + hypothesis 拼成 user prompt 送给 Anthropic,
// 返回 LLM 输出的纯文本(应当是 JSON 字符串,但本函数不解析)。
func callLLM(ctx context.Context, apiKey, payload, hypothesis string) (string, error) {
	if hypothesis == "" {
		hypothesis = "(no hypothesis provided — judge based on intuitive game design correctness)"
	}
	userPrompt := fmt.Sprintf(
		"# HYPOTHESIS\n%s\n\n# FACTS\n\n```json\n%s\n```\n\nNow output your JSON judgment.",
		hypothesis, payload,
	)

	body, _ := json.Marshal(map[string]any{
		"model":      "claude-opus-4-7",
		"max_tokens": 2000,
		"system":     systemPrompt,
		"messages":   []map[string]string{{"role": "user", "content": userPrompt}},
	})

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		"https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", apiKey)
	req.Header.Set("anthropic-version", "2023-06-01")

	resp, err := (&http.Client{Timeout: 60 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("anthropic %d: %s", resp.StatusCode, string(respBody))
	}

	// Anthropic 响应外壳很稳定,只取 content[].text 拼起来,
	// 至于 text 里是不是合法 JSON、verdict 字段什么的,不在 Go 这一层关心。
	var shell struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBody, &shell); err != nil {
		return string(respBody), nil // 解析失败就返回原文
	}
	var sb bytes.Buffer
	for _, c := range shell.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	return sb.String(), nil
}

// 单一端点:导航 + 跑剧本 + 调 LLM + 返回。
// 请求体只有四个字段,响应体把 payload / verdict 都当字符串塞回去。
func handleDiagnose(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		URL        string `json:"url"`
		ScenarioID string `json:"scenarioId"`
		Hypothesis string `json:"hypothesis,omitempty"`
		SkipLLM    bool   `json:"skipLLM,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json: " + err.Error()})
		return
	}
	if req.URL == "" || req.ScenarioID == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "url and scenarioId required"})
		return
	}

	startedAt := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 150*time.Second)
	defer cancel()

	payload, err := runSessionInBrowser(ctx, req.URL, req.ScenarioID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "error": err.Error(),
			"durationMs": time.Since(startedAt).Milliseconds(),
		})
		return
	}

	out := map[string]any{
		"ok":         true,
		"payload":    json.RawMessage(payload), // 透传原始前端 JSON,不重新编码
		"durationMs": time.Since(startedAt).Milliseconds(),
	}

	if !req.SkipLLM {
		apiKey := os.Getenv("ANTHROPIC_API_KEY")
		if apiKey == "" {
			out["llmSkipped"] = "ANTHROPIC_API_KEY not set"
		} else {
			verdict, err := callLLM(ctx, apiKey, payload, req.Hypothesis)
			if err != nil {
				out["llmError"] = err.Error()
			} else {
				// verdict 是 LLM 输出的字符串(里面通常是 JSON),原样回传
				// 调用方决定是否再 JSON.parse 一次
				out["verdict"] = verdict
			}
		}
		out["durationMs"] = time.Since(startedAt).Milliseconds()
	}

	writeJSON(w, http.StatusOK, out)
}

// 列出前端注册的剧本名,方便调试 / 后台面板。
func handleScenarios(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, "url query param required", http.StatusBadRequest)
		return
	}
	allocCtx, cancelA := chromedp.NewExecAllocator(r.Context())
	defer cancelA()
	bctx, cancelB := chromedp.NewContext(allocCtx)
	defer cancelB()
	timed, cancelT := context.WithTimeout(bctx, 30*time.Second)
	defer cancelT()

	var raw string
	if err := chromedp.Run(timed,
		chromedp.Navigate(url),
		chromedp.Poll(`typeof window.WebOps === 'object'`, nil),
		chromedp.Evaluate(`JSON.stringify(window.WebOps.list())`, &raw),
	); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scenarios": json.RawMessage(raw)})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/webops/diagnose", handleDiagnose)
	mux.HandleFunc("/webops/scenarios", handleScenarios)

	addr := os.Getenv("ADDR")
	if addr == "" {
		addr = ":8080"
	}
	log.Printf("[webops] listening on %s", addr)
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		log.Println("[warn] ANTHROPIC_API_KEY not set; LLM calls will be skipped or noted")
	}
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatal(err)
	}
}
