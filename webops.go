// webops.go — V4 Go 后端,单文件全闭环。
//
// V4.1 改动:
//   - 共享长寿命 ExecAllocator:不再每次请求 spawn 新 Chrome 进程。
//     Per-request 用 chromedp.NewContext(sharedAlloc) 开新 tab,Chrome 进程复用,内存占用降一个量级。
//   - 信号量 sem 卡死并发上限,超过排队等(防 OOM)。
//   - 新增 POST /webops/diagnose-batch:fan-out N 个 scenario 并发跑,
//     聚合所有 LLMPayload 后做一次 LLM 调用,产出跨场景判决。
//   - 新增 GET /webops/describe:用 WebOps.describe() 替代旧的 /webops/scenarios,
//     拿到 gameIntent + scenarios[] 全量元数据。
//
// 设计原则不变:不定义任何业务数据类型。所有载荷当 string/RawMessage 透传。
//
// 用法:
//   go mod init yourorg/webops
//   go get github.com/chromedp/chromedp golang.org/x/sync/errgroup
//   ANTHROPIC_API_KEY=sk-ant-... go run webops.go

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/chromedp"
	"golang.org/x/sync/errgroup"
)

// ---------- 配置 ----------

var (
	maxConcurrency = 8 // 同时打开的 tab 上限,可由 -concurrency 覆盖
	llmModel       = "claude-opus-4-7"
	listenAddr     = ":8080"
)

// auditParam 是 Go chromedp tab 与业务侧 Bootstrap 之间的"审计开关"。
//
// 每次 chromedp.Navigate 把它拼到 URL 后,Bootstrap 用 shouldEnableWebOps() 检测到才注册剧本。
// 普通用户访问的 URL 不带它,所以审计 chunk 不下载、window.WebOps 不存在。
//
// 故意写死成常量而不是 flag:
//   - Go 二进制就是审计工具本身,不存在"关掉审计"的运行模式,flag 是配置噪音。
//   - 真要改名(比如换成更隐蔽的串挡偶然访客),请同时修改 webops.go 和 runtime.ts
//     里的常量 —— 两边一起改才能保持约定一致,这种"成对改动"用源码 grep 比 flag 安全。
const auditParam = "webops=1"

// applyAuditParam — 把 auditParam 安全地拼到 URL 上,处理已有 query / fragment 的情况。
func applyAuditParam(rawURL string) string {
	parts := strings.SplitN(auditParam, "=", 2)
	key := parts[0]
	val := "1"
	if len(parts) == 2 {
		val = parts[1]
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		// URL 解析失败兜底:粗暴拼接,起码不会让请求崩。
		sep := "?"
		if strings.Contains(rawURL, "?") {
			sep = "&"
		}
		return rawURL + sep + auditParam
	}
	q := u.Query()
	q.Set(key, val)
	u.RawQuery = q.Encode()
	return u.String()
}

// ---------- 共享 Browser ----------
//
// 整个进程一个长寿命 Chrome,所有 tab 在它里面开。
// chromedp.NewContext(sharedAllocCtx) 创建一个新 tab(BrowserContext),互相隔离。
// 第一次 Run 之后 Chrome 才真正起来; 后续 tab 复用进程,无冷启动。

var (
	sharedAllocCtx context.Context
	sharedCancel   context.CancelFunc
	sharedOnce     sync.Once
	sem            chan struct{}
)

func ensureBrowser() {
	sharedOnce.Do(func() {
		opts := append(chromedp.DefaultExecAllocatorOptions[:],
			chromedp.Flag("headless", true),
			chromedp.Flag("disable-gpu", true),
			chromedp.Flag("no-sandbox", true),
			chromedp.Flag("disable-dev-shm-usage", true),
		)
		sharedAllocCtx, sharedCancel = chromedp.NewExecAllocator(context.Background(), opts...)
		sem = make(chan struct{}, maxConcurrency)
		log.Printf("[webops] shared browser pool ready, concurrency=%d", maxConcurrency)
	})
}

// ---------- LLM ----------

// 与前端 ReportBuilder 输出的 LLMPayload 格式约定保持一致(但 Go 不解析其中字段)。
const singleScenarioSystemPrompt = `You are an expert game design auditor. You receive structured telemetry from automated playthroughs of a web game (React + Next.js + R3F). Your job:

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
- expectScore < 100 means at least one explicit assertion failed.
- Prefer the action's intent annotation (timeline[].intent) over guessing what an action was for.`

const batchSystemPrompt = `You are an expert game design auditor. You receive a BATCH of automated playthroughs of the same web game, each playthrough exercising a different aspect of the design (different scenarios with their own hypotheses).

Your job is twofold:

1. PER-SCENARIO judgment: for each scenario, decide PASS / PARTIAL / FAIL with concrete evidence.
2. CROSS-SCENARIO root-cause analysis: identify patterns that span multiple scenarios. If two scenarios fail with related symptoms, propose a single root cause and a single fix that addresses both. This is the highest-value output.

For every suggested fix, you MUST classify whether the fix lives in the GAME SOURCE CODE, the TEST SCRIPT, or BOTH. The same symptom can mean either: (a) the game logic is wrong, or (b) the script is testing the wrong thing. Be explicit.

Output STRICT JSON with this schema:
{
  "perScenario": [
    {
      "scenarioId": string,
      "verdict": "PASS" | "PARTIAL" | "FAIL" | "INFRA_FAIL",
      "score": 0..100,
      "evidence": [string]
    }
  ],
  "crossScenarioFindings": [
    {
      "pattern": string,
      "scenariosAffected": [string],
      "evidence": string
    }
  ],
  "rootCauses": [
    {
      "issue": string,
      "suggestedFix": {
        "target": "code" | "script" | "both",
        "file": string,
        "change": string
      }
    }
  ],
  "notes": string
}

Rules:
- Cite specific step names, marker names, and timeline timestamps.
- A scenario marked INFRA_FAIL (set by the harness, not by you) means chromedp/network/setup failed; do not score it.
- Prefer cross-scenario patterns over per-scenario noise: if 3 scenarios all show "audioScore: 0", that's a single root cause, not three.
- Use the intent field on timeline events to ground your reasoning in what the test author meant.
- Keep notes short; put real content in rootCauses.`

func callLLMSingle(ctx context.Context, apiKey, payload, hypothesis string) (string, error) {
	if hypothesis == "" {
		hypothesis = "(no hypothesis provided — judge based on intuitive game design correctness)"
	}
	userPrompt := fmt.Sprintf(
		"# HYPOTHESIS\n%s\n\n# FACTS\n\n```json\n%s\n```\n\nNow output your JSON judgment.",
		hypothesis, payload,
	)
	return callAnthropic(ctx, apiKey, singleScenarioSystemPrompt, userPrompt)
}

// callLLMBatch — 把 gameIntent + 多 scenario 的 payload 拼成一次 prompt 送 LLM,产出跨场景判决。
func callLLMBatch(ctx context.Context, apiKey, gameIntent string, results []scenarioResult) (string, error) {
	var sb bytes.Buffer
	sb.WriteString("# GAME DESIGN INTENT\n")
	if gameIntent == "" {
		sb.WriteString("(none provided — infer from scenario hypotheses)\n")
	} else {
		sb.WriteString(gameIntent)
		sb.WriteString("\n")
	}

	sb.WriteString("\n# SCENARIOS IN THIS BATCH\n")
	for _, r := range results {
		fmt.Fprintf(&sb, "- %s\n", r.ScenarioID)
		if r.Intent != "" {
			fmt.Fprintf(&sb, "    intent:     %s\n", r.Intent)
		}
		fmt.Fprintf(&sb, "    hypothesis: %s\n", r.Hypothesis)
		if len(r.Tags) > 0 {
			fmt.Fprintf(&sb, "    tags:       %v\n", r.Tags)
		}
		if r.InfraError != "" {
			fmt.Fprintf(&sb, "    INFRA_FAIL: %s\n", r.InfraError)
		}
	}

	sb.WriteString("\n# PAYLOADS (one per scenario)\n")
	for _, r := range results {
		fmt.Fprintf(&sb, "\n## scenario: %s\n", r.ScenarioID)
		if r.InfraError != "" {
			sb.WriteString("(no payload — infrastructure error, see SCENARIOS section)\n")
			continue
		}
		sb.WriteString("```json\n")
		sb.Write(r.Payload)
		sb.WriteString("\n```\n")
	}

	sb.WriteString("\nNow output your JSON judgment per the schema in the system prompt.\n")

	return callAnthropic(ctx, apiKey, batchSystemPrompt, sb.String())
}

func callAnthropic(ctx context.Context, apiKey, system, userPrompt string) (string, error) {
	body, _ := json.Marshal(map[string]any{
		"model":      llmModel,
		"max_tokens": 4000,
		"system":     system,
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

	resp, err := (&http.Client{Timeout: 120 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return "", fmt.Errorf("anthropic %d: %s", resp.StatusCode, string(respBody))
	}

	var shell struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBody, &shell); err != nil {
		return string(respBody), nil
	}
	var out bytes.Buffer
	for _, c := range shell.Content {
		if c.Type == "text" {
			out.WriteString(c.Text)
		}
	}
	return out.String(), nil
}

// ---------- 浏览器侧调用 ----------

// runOneScenario — 在共享 browser 里开新 tab,navigate,跑指定 scenario,关 tab,返回 payload 原文。
// 调用方负责 ctx 超时控制。
func runOneScenario(ctx context.Context, url, scenarioID string) (string, error) {
	ensureBrowser()

	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		return "", ctx.Err()
	}
	defer func() { <-sem }()

	// 每次新 tab,跨请求隔离 storage / cookie / window。
	bctx, cancelB := chromedp.NewContext(sharedAllocCtx)
	defer cancelB()

	navCtx, cancelNav := context.WithTimeout(bctx, 25*time.Second)
	defer cancelNav()
	if err := chromedp.Run(navCtx,
		chromedp.Navigate(applyAuditParam(url)),
		chromedp.Poll(
			`typeof window.WebOps === 'object' && typeof window.WebOps.run === 'function'`,
			nil,
		),
	); err != nil {
		return "", fmt.Errorf("navigate / wait WebOps: %w", err)
	}

	runCtx, cancelRun := context.WithTimeout(bctx, 120*time.Second)
	defer cancelRun()
	var payload string
	expr := fmt.Sprintf(`window.WebOps.run(%q)`, scenarioID)
	if err := chromedp.Run(runCtx, chromedp.Evaluate(expr, &payload)); err != nil {
		return "", fmt.Errorf("evaluate run: %w", err)
	}
	return payload, nil
}

// describePage — 调 window.WebOps.describe() 拿元数据(gameIntent + scenarios[])。
func describePage(ctx context.Context, url string) (json.RawMessage, error) {
	ensureBrowser()

	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	defer func() { <-sem }()

	bctx, cancelB := chromedp.NewContext(sharedAllocCtx)
	defer cancelB()

	timed, cancelT := context.WithTimeout(bctx, 30*time.Second)
	defer cancelT()

	var raw string
	if err := chromedp.Run(timed,
		chromedp.Navigate(applyAuditParam(url)),
		chromedp.Poll(`typeof window.WebOps === 'object' && typeof window.WebOps.describe === 'function'`, nil),
		chromedp.Evaluate(`JSON.stringify(window.WebOps.describe())`, &raw),
	); err != nil {
		return nil, fmt.Errorf("describe: %w", err)
	}
	return json.RawMessage(raw), nil
}

// pageDescription — Go 侧只取批量调度需要的字段,其它当 RawMessage 透传给 LLM。
type pageDescription struct {
	GameIntent string             `json:"gameIntent"`
	Scenarios  []scenarioMetadata `json:"scenarios"`
}

type scenarioMetadata struct {
	ID         string   `json:"id"`
	Hypothesis string   `json:"hypothesis"`
	Intent     string   `json:"intent"`
	Tags       []string `json:"tags"`
}

type scenarioResult struct {
	ScenarioID string          `json:"scenarioId"`
	Hypothesis string          `json:"hypothesis"`
	Intent     string          `json:"intent,omitempty"`
	Tags       []string        `json:"tags,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	InfraError string          `json:"infraError,omitempty"`
	DurationMs int64           `json:"durationMs"`
}

// ---------- HTTP handlers ----------

// /webops/diagnose — 单 scenario 模式,保留 V4.0 行为兼容。
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
	ctx, cancel := context.WithTimeout(r.Context(), 180*time.Second)
	defer cancel()

	payload, err := runOneScenario(ctx, req.URL, req.ScenarioID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "error": err.Error(),
			"durationMs": time.Since(startedAt).Milliseconds(),
		})
		return
	}

	out := map[string]any{
		"ok":         true,
		"payload":    json.RawMessage(payload),
		"durationMs": time.Since(startedAt).Milliseconds(),
	}

	if !req.SkipLLM {
		apiKey := os.Getenv("ANTHROPIC_API_KEY")
		if apiKey == "" {
			out["llmSkipped"] = "ANTHROPIC_API_KEY not set"
		} else {
			verdict, err := callLLMSingle(ctx, apiKey, payload, req.Hypothesis)
			if err != nil {
				out["llmError"] = err.Error()
			} else {
				out["verdict"] = verdict
			}
		}
		out["durationMs"] = time.Since(startedAt).Milliseconds()
	}

	writeJSON(w, http.StatusOK, out)
}

// /webops/diagnose-batch — 多 scenario 并发模式,聚合后一次 LLM 调用产出跨场景判决。
func handleDiagnoseBatch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "POST only", http.StatusMethodNotAllowed)
		return
	}
	var req struct {
		URL         string   `json:"url"`
		Scenarios   []string `json:"scenarios,omitempty"` // nil 或空 = 跑 describe 列表里的全部
		Tags        []string `json:"tags,omitempty"`      // 按 tag 过滤(与 Scenarios 取并集后再过滤)
		Concurrency int      `json:"concurrency,omitempty"`
		SkipLLM     bool     `json:"skipLLM,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad json: " + err.Error()})
		return
	}
	if req.URL == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "url required"})
		return
	}

	startedAt := time.Now()
	ctx, cancel := context.WithTimeout(r.Context(), 600*time.Second)
	defer cancel()

	// 1. 拉 page description 拿 gameIntent + scenarios 元数据。
	rawDesc, err := describePage(ctx, req.URL)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "error": "describe failed: " + err.Error(),
		})
		return
	}
	var desc pageDescription
	if err := json.Unmarshal(rawDesc, &desc); err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"ok": false, "error": "describe parse: " + err.Error(),
		})
		return
	}

	// 2. 决定要跑哪些 scenario:Scenarios 显式列表优先,然后 tags 再筛。
	selected := selectScenarios(desc.Scenarios, req.Scenarios, req.Tags)
	if len(selected) == 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"ok":    false,
			"error": "no scenarios selected (empty registry, or filters excluded everything)",
			"available": desc.Scenarios,
		})
		return
	}

	// 3. fan-out:每个 scenario 一个 fresh tab,errgroup 收集结果。
	//    单个失败不取消整批,记 InfraError 让 LLM 看到"哪些没跑通"。
	results := make([]scenarioResult, len(selected))
	g, gctx := errgroup.WithContext(ctx)
	for i, s := range selected {
		i, s := i, s
		g.Go(func() error {
			t0 := time.Now()
			payload, err := runOneScenario(gctx, req.URL, s.ID)
			res := scenarioResult{
				ScenarioID: s.ID,
				Hypothesis: s.Hypothesis,
				Intent:     s.Intent,
				Tags:       s.Tags,
				DurationMs: time.Since(t0).Milliseconds(),
			}
			if err != nil {
				res.InfraError = err.Error()
			} else {
				res.Payload = json.RawMessage(payload)
			}
			results[i] = res
			return nil // 单个失败不污染整批
		})
	}
	_ = g.Wait()

	out := map[string]any{
		"ok":         true,
		"gameIntent": desc.GameIntent,
		"results":    results,
		"durationMs": time.Since(startedAt).Milliseconds(),
	}

	// 4. 聚合判决:一次 LLM 调用拿跨场景 verdict。
	if !req.SkipLLM {
		apiKey := os.Getenv("ANTHROPIC_API_KEY")
		if apiKey == "" {
			out["llmSkipped"] = "ANTHROPIC_API_KEY not set"
		} else {
			verdict, err := callLLMBatch(ctx, apiKey, desc.GameIntent, results)
			if err != nil {
				out["llmError"] = err.Error()
			} else {
				out["verdict"] = verdict
			}
		}
		out["durationMs"] = time.Since(startedAt).Milliseconds()
	}

	writeJSON(w, http.StatusOK, out)
}

// selectScenarios — 应用 scenarios 显式列表 + tags 过滤。
//
// 规则:
//   - scenarios 非空: 只保留这些 ID。其它的丢掉。
//   - tags 非空:    再保留至少有一个 tag 命中的。
//   - 两者都空:    返回全部。
//   - scenarios 里给了不存在的 ID: 跳过(不报错,不影响其它合法 ID)。
func selectScenarios(all []scenarioMetadata, ids, tags []string) []scenarioMetadata {
	idSet := map[string]bool{}
	for _, id := range ids {
		idSet[id] = true
	}
	tagSet := map[string]bool{}
	for _, t := range tags {
		tagSet[t] = true
	}

	out := make([]scenarioMetadata, 0, len(all))
	for _, s := range all {
		if len(idSet) > 0 && !idSet[s.ID] {
			continue
		}
		if len(tagSet) > 0 {
			hit := false
			for _, t := range s.Tags {
				if tagSet[t] {
					hit = true
					break
				}
			}
			if !hit {
				continue
			}
		}
		out = append(out, s)
	}
	return out
}

// /webops/describe — 拿 gameIntent + scenarios 元数据,便于做后台面板。
func handleDescribe(w http.ResponseWriter, r *http.Request) {
	url := r.URL.Query().Get("url")
	if url == "" {
		http.Error(w, "url query param required", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
	defer cancel()
	raw, err := describePage(ctx, url)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"description": raw})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// ---------- main ----------

func main() {
	flag.IntVar(&maxConcurrency, "concurrency", envInt("CONCURRENCY", maxConcurrency), "max parallel browser tabs")
	flag.StringVar(&listenAddr, "addr", envStr("ADDR", listenAddr), "listen address")
	flag.StringVar(&llmModel, "model", envStr("LLM_MODEL", llmModel), "Anthropic model id")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/webops/diagnose", handleDiagnose)
	mux.HandleFunc("/webops/diagnose-batch", handleDiagnoseBatch)
	mux.HandleFunc("/webops/describe", handleDescribe)

	log.Printf("[webops] listening on %s (concurrency=%d, model=%s, audit-param=%q)",
		listenAddr, maxConcurrency, llmModel, auditParam)
	if os.Getenv("ANTHROPIC_API_KEY") == "" {
		log.Println("[warn] ANTHROPIC_API_KEY not set; LLM calls will be skipped or noted")
	}

	srv := &http.Server{Addr: listenAddr, Handler: mux}
	if err := srv.ListenAndServe(); err != nil {
		log.Fatal(err)
	}
}

func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}
