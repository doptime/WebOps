// Package webops 提供 V5 的"Go-authored inline scripts"能力。
//
// V5 设计:
//   - 测试脚本用 Go 端 builder (webops.Script(id).Wait().Loop().Build()) 拼成 InlineScript IR。
//   - chromedp 每次 navigate 后,evaluate `window.WebOps.runInline(IR, meta)` 把脚本送进 tab。
//   - 一次 Audit() 调用 = 把多个 scenario 并行跑(每个独立 tab)+ 跨场景汇总送 LLM。
//
// 与 V4.1 webops.go (独立 HTTP server) 的差异:
//   - 没有 HTTP 端点。调用方直接 import 这个包,wires Audit() 进自己的 CLI / harness。
//   - 没有 TS 端 register/describe — 脚本直接随每次 navigate 内联送达。
package webops

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// ---------- 常量与可调参数 ----------

// 与 runtime.ts shouldEnableWebOps() 默认值必须保持一致。要换名挡偶然访客,两边一起改。
const auditParam = "webops=1"

// 包级可调常量。需要时在程序启动早期改。
var (
	DefaultConcurrency = 8
	DefaultLLMModel    = "claude-opus-4-7"
	NavTimeout         = 25 * time.Second
	RunTimeout         = 180 * time.Second
)

// ---------- IR 类型 ----------

// Predicate / ValueSource / Target / Step 都是 map[string]any 的定义类型,
// 直接 marshal 成 JSON 即与 TS 端 script--ir.ts 的 Predicate / ValueSource / IRStep 对齐。
type Predicate map[string]any
type ValueSource map[string]any
type Target map[string]any
type Step map[string]any

// Cases 是 Dispatch 的 case 表(value → branch 构造器)。
type Cases map[string]func(*B)

// InlineScript 由 builder Build() 产出,送入 chromedp evaluate 时直接 marshal 成 JSON。
type InlineScript struct {
	ScenarioID           string `json:"scenarioId"`
	Strategy             string `json:"strategy"`
	ContinueOnExpectFail bool   `json:"continueOnExpectFail"`
	SessionTimeoutMs     int    `json:"sessionTimeoutMs"`
	Steps                []Step `json:"steps"`
	Store                string `json:"store,omitempty"`
}

// ---------- Target 构造器 ----------

// Vt 用 vt-id 定位元素(底层 selector = [data-vt-id="..."])。
func Vt(id string) Target  { return Target{"vtId": id} }
func Sel(s string) Target  { return Target{"selector": s} }
func XY(x, y int) Target   { return Target{"x": x, "y": y} }

// ---------- Predicate 构造器 ----------

func StateEq(path string, v any) Predicate { return Predicate{"op": "state_eq", "path": path, "value": v} }
func StateNe(path string, v any) Predicate { return Predicate{"op": "state_ne", "path": path, "value": v} }
func StateGt(path string, v float64) Predicate { return Predicate{"op": "state_gt", "path": path, "value": v} }
func StateGe(path string, v float64) Predicate { return Predicate{"op": "state_ge", "path": path, "value": v} }
func StateLt(path string, v float64) Predicate { return Predicate{"op": "state_lt", "path": path, "value": v} }
func StateLe(path string, v float64) Predicate { return Predicate{"op": "state_le", "path": path, "value": v} }
func StateIn(path string, vs ...any) Predicate { return Predicate{"op": "state_in", "path": path, "values": vs} }
func StateTruthy(path string) Predicate    { return Predicate{"op": "state_truthy", "path": path} }
func StateLenEq(path string, n int) Predicate { return Predicate{"op": "state_len_eq", "path": path, "value": n} }
func StateLenGt(path string, n int) Predicate { return Predicate{"op": "state_len_gt", "path": path, "value": n} }
func StateCountEq(path, key string, eq any, count int) Predicate {
	return Predicate{"op": "state_count_eq", "path": path, "key": key, "eq": eq, "count": count}
}
func StateEveryEq(path, key string, eq any) Predicate {
	return Predicate{"op": "state_every_eq", "path": path, "key": key, "eq": eq}
}
func DOMExists(sel string) Predicate  { return Predicate{"op": "dom_exists", "selector": sel} }
func DOMMissing(sel string) Predicate { return Predicate{"op": "dom_missing", "selector": sel} }

func All(preds ...Predicate) Predicate { return Predicate{"op": "all", "preds": preds} }
func Any(preds ...Predicate) Predicate { return Predicate{"op": "any", "preds": preds} }
func Not(p Predicate) Predicate        { return Predicate{"op": "not", "pred": p} }

func ReadEq(name string, v any) Predicate { return Predicate{"op": "read_eq", "name": name, "value": v} }
func ReadModEq(name string, mod, v int) Predicate {
	return Predicate{"op": "read_mod_eq", "name": name, "mod": mod, "value": v}
}
func ExprP(code string) Predicate { return Predicate{"op": "expr", "code": code} }

// ---------- ValueSource 构造器 ----------

func StateGet(path string) ValueSource     { return ValueSource{"op": "state_get", "path": path} }
func StateLen(path string) ValueSource     { return ValueSource{"op": "state_len", "path": path} }
func StateCount(path, key string, eq any) ValueSource {
	return ValueSource{"op": "state_count", "path": path, "key": key, "eq": eq}
}
func StateMap(path, key string) ValueSource {
	return ValueSource{"op": "state_map", "path": path, "key": key}
}
func ExprV(code string) ValueSource { return ValueSource{"op": "expr", "code": code} }

// ---------- 步骤 Options ----------

// Opt 是步骤的函数式 option。
type Opt func(Step)

func Mark(name string) Opt     { return func(s Step) { s["mark"] = name } }
func Intent(text string) Opt   { return func(s Step) { s["intent"] = text } }
func Mode(m string) Opt        { return func(s Step) { s["mode"] = m } }                // "native" / "pointer"
func Duration(ms int) Opt      { return func(s Step) { s["durationMs"] = ms } }
func ClearFirst(b bool) Opt    { return func(s Step) { s["clearFirst"] = b } }
func WithMeta(m map[string]any) Opt { return func(s Step) { s["meta"] = m } }

func applyOpts(s Step, opts []Opt) Step {
	for _, o := range opts {
		o(s)
	}
	return s
}

// ---------- Builder ----------

// B 是 Script builder。所有方法返回 *B,链式调用。
//
// 用法:
//   webops.Script("perfect_player").
//       Strategy("human_like").
//       Wait(800, "warmup").
//       Loop(6, func(s *webops.B) {
//           s.WaitFor("ready", webops.StateEq("phase", "CHOOSING"), 4000)
//           s.Dispatch("kind", webops.StateGet("currentTarget"), webops.Cases{...})
//       }).
//       Expect("victory", webops.StateEq("phase", "COMPLETE")).
//       Build()
type B struct {
	scenarioID         string
	strategy           string
	timeoutMs          int
	continueOnFail     bool
	store              string
	steps              []Step
}

// Script 创建一个新 builder。
func Script(id string) *B {
	return &B{
		scenarioID:     id,
		strategy:       "human_like",
		timeoutMs:      120_000,
		continueOnFail: true,
		steps:          []Step{},
	}
}

func (b *B) Strategy(s string) *B               { b.strategy = s; return b }
func (b *B) Timeout(ms int) *B                  { b.timeoutMs = ms; return b }
func (b *B) ContinueOnExpectFail(yes bool) *B   { b.continueOnFail = yes; return b }
func (b *B) Store(name string) *B               { b.store = name; return b }

// 等待
func (b *B) Wait(ms int, label string) *B {
	s := Step{"kind": "wait", "ms": ms}
	if label != "" {
		s["label"] = label
	}
	b.steps = append(b.steps, s)
	return b
}

func (b *B) WaitFor(name string, check Predicate, timeoutMs int, opts ...Opt) *B {
	s := Step{"kind": "wait_for", "name": name, "check": check, "timeoutMs": timeoutMs}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

// 动作
func (b *B) Click(target Target, opts ...Opt) *B {
	s := Step{"kind": "click", "target": target}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) Drag(from, to Target, opts ...Opt) *B {
	s := Step{"kind": "drag", "from": from, "to": to}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) Type(text string, opts ...Opt) *B {
	s := Step{"kind": "type", "text": text}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) Key(key string, opts ...Opt) *B {
	s := Step{"kind": "key", "key": key}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) MarkOnly(name string, opts ...Opt) *B {
	s := Step{"kind": "mark", "name": name}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

// 观测 / 读取 / 断言
func (b *B) Observe(name string, check Predicate, opts ...Opt) *B {
	s := Step{"kind": "observe", "name": name, "check": check}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) Read(name string, source ValueSource, opts ...Opt) *B {
	s := Step{"kind": "read", "name": name, "source": source}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

func (b *B) Expect(name string, check Predicate, opts ...Opt) *B {
	s := Step{"kind": "expect", "name": name, "check": check}
	b.steps = append(b.steps, applyOpts(s, opts))
	return b
}

// 控制流
//
// Branch / Loop / Dispatch 接受 builder 函数,允许嵌套构造子树。
// 子树共享父 builder 的 strategy/timeout,但 steps 独立。
func (b *B) Branch(when Predicate, thenBuild func(*B), elseBuild func(*B)) *B {
	thenSteps := buildSub(b, thenBuild)
	elseSteps := buildSub(b, elseBuild)
	s := Step{"kind": "branch", "when": when, "then": thenSteps}
	if len(elseSteps) > 0 {
		s["else"] = elseSteps
	}
	b.steps = append(b.steps, s)
	return b
}

func (b *B) Loop(times int, body func(*B)) *B {
	bodySteps := buildSub(b, body)
	b.steps = append(b.steps, Step{"kind": "loop", "times": times, "body": bodySteps})
	return b
}

// Dispatch 读一个值 → 按值走对应分支。等价于 read + 嵌套 branch。
//
// 实现细节:为了 IR 输出确定性(便于 diff / 缓存 hash),cases 的 key 在编译时排序后展开。
// 排序对运行时行为无影响 — 所有 branch 的 else 都是空,顺序不会改变结果。
func (b *B) Dispatch(name string, source ValueSource, cases Cases, opts ...Opt) *B {
	b.Read(name, source, opts...)

	keys := make([]string, 0, len(cases))
	for k := range cases {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	// 嵌套展开:case_1 命中 → branch_1.then;否则 case_2 命中 → branch_2.then;...
	// else 链最终落到空 step list。
	for _, k := range keys {
		fn := cases[k]
		b.Branch(ReadEq(name, k), fn, nil)
	}
	return b
}

// buildSub 用父 builder 的 strategy/timeout/store 新建一个临时 builder,跑用户的 build fn,
// 返回它产出的 steps。nil build fn 返回空 slice(供 Branch 的 else 用)。
func buildSub(parent *B, fn func(*B)) []Step {
	if fn == nil {
		return []Step{}
	}
	sub := &B{
		scenarioID:     parent.scenarioID,
		strategy:       parent.strategy,
		timeoutMs:      parent.timeoutMs,
		continueOnFail: parent.continueOnFail,
		store:          parent.store,
		steps:          []Step{},
	}
	fn(sub)
	return sub.steps
}

// Build 把 builder 收尾为 InlineScript。
func (b *B) Build() InlineScript {
	return InlineScript{
		ScenarioID:           b.scenarioID,
		Strategy:             b.strategy,
		ContinueOnExpectFail: b.continueOnFail,
		SessionTimeoutMs:     b.timeoutMs,
		Steps:                b.steps,
		Store:                b.store,
	}
}

// ---------- Scenario / Audit 类型 ----------

type Scenario struct {
	ID         string       `json:"id"`
	Hypothesis string       `json:"hypothesis,omitempty"`
	Intent     string       `json:"intent,omitempty"`
	Tags       []string     `json:"tags,omitempty"`
	Script     InlineScript `json:"-"`
}

type ScenarioResult struct {
	ScenarioID string          `json:"scenarioId"`
	Hypothesis string          `json:"hypothesis,omitempty"`
	Intent     string          `json:"intent,omitempty"`
	Tags       []string        `json:"tags,omitempty"`
	Payload    json.RawMessage `json:"payload,omitempty"`
	InfraError string          `json:"infraError,omitempty"`
	DurationMs int64           `json:"durationMs"`
}

type AuditRequest struct {
	URL         string
	GameIntent  string
	Scenarios   []Scenario
	Concurrency int
	SkipLLM     bool
	LLMAPIKey   string
	LLMModel    string
}

type AuditResult struct {
	GameIntent string           `json:"gameIntent"`
	Results    []ScenarioResult `json:"results"`
	Verdict    string           `json:"verdict,omitempty"`    // 原始 LLM JSON 字符串
	LLMError   string           `json:"llmError,omitempty"`
	LLMSkipped string           `json:"llmSkipped,omitempty"`
	DurationMs int64            `json:"durationMs"`
}

// ---------- 共享 chromedp 进程 ----------

var (
	browserMu    sync.Mutex
	browserAlloc context.Context
	browserCanc  context.CancelFunc
	browserOnce  sync.Once
)

func ensureBrowser() (context.Context, error) {
	browserMu.Lock()
	defer browserMu.Unlock()
	if browserAlloc != nil {
		return browserAlloc, nil
	}
	opts := append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.Flag("headless", true),
		chromedp.Flag("disable-gpu", true),
		chromedp.Flag("no-sandbox", true),
		chromedp.Flag("disable-dev-shm-usage", true),
	)
	browserAlloc, browserCanc = chromedp.NewExecAllocator(context.Background(), opts...)
	return browserAlloc, nil
}

// Close 关闭共享 chromedp 进程。一般在程序退出前调一次。
func Close() {
	browserMu.Lock()
	defer browserMu.Unlock()
	if browserCanc != nil {
		browserCanc()
		browserCanc = nil
		browserAlloc = nil
	}
}

// ---------- applyAuditParam ----------

func applyAuditParam(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		// 解析不动就拼字符串
		sep := "?"
		if strings.Contains(rawURL, "?") {
			sep = "&"
		}
		return rawURL + sep + auditParam
	}
	q := u.Query()
	parts := strings.SplitN(auditParam, "=", 2)
	if len(parts) == 2 {
		q.Set(parts[0], parts[1])
	} else {
		q.Set(parts[0], "1")
	}
	u.RawQuery = q.Encode()
	return u.String()
}

// ---------- runOneInline ----------

// awaitPromise 是 chromedp.EvaluateAction 的修饰器:让 evaluate 等待返回值是 Promise 时 await。
func awaitPromise(p *runtime.EvaluateParams) *runtime.EvaluateParams {
	return p.WithAwaitPromise(true)
}

// runOneInline 跑一个 scenario:开新 tab → navigate → 等 WebOps.runInline 就位 → evaluate → 收 payload → 关 tab。
//
// 注意:这里把 IR 与 meta 都序列化为 JSON,然后字面量嵌入到 evaluate 表达式里。
// 这是安全的 — JSON 是 JS 字面量的合法子集,不需要额外转义。
func runOneInline(ctx context.Context, sharedAlloc context.Context, fullURL string, sc Scenario) ScenarioResult {
	start := time.Now()
	res := ScenarioResult{
		ScenarioID: sc.ID,
		Hypothesis: sc.Hypothesis,
		Intent:     sc.Intent,
		Tags:       sc.Tags,
	}

	tabCtx, cancelTab := chromedp.NewContext(sharedAlloc)
	defer cancelTab()

	navCtx, cancelNav := context.WithTimeout(tabCtx, NavTimeout)
	defer cancelNav()
	if err := chromedp.Run(navCtx, chromedp.Navigate(fullURL)); err != nil {
		res.InfraError = "navigate: " + err.Error()
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}

	// 等 window.WebOps.runInline 挂载
	pollCtx, cancelPoll := context.WithTimeout(tabCtx, 15*time.Second)
	defer cancelPoll()
	if err := chromedp.Run(pollCtx,
		chromedp.Poll(`typeof window.WebOps === 'object' && typeof window.WebOps.runInline === 'function'`, nil),
	); err != nil {
		res.InfraError = "wait WebOps.runInline: " + err.Error()
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}

	// 编码 IR 与 meta
	scriptJSON, err := json.Marshal(sc.Script)
	if err != nil {
		res.InfraError = "marshal script: " + err.Error()
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}
	meta := map[string]any{}
	if sc.Hypothesis != "" {
		meta["hypothesis"] = sc.Hypothesis
	}
	if sc.Intent != "" {
		meta["intent"] = sc.Intent
	}
	if len(sc.Tags) > 0 {
		meta["tags"] = sc.Tags
	}
	metaJSON, _ := json.Marshal(meta)

	// 执行
	runCtxInner, cancelRun := context.WithTimeout(tabCtx, RunTimeout)
	defer cancelRun()

	var payloadStr string
	expr := fmt.Sprintf(`window.WebOps.runInline(%s, %s)`, scriptJSON, metaJSON)
	if err := chromedp.Run(runCtxInner,
		chromedp.ActionFunc(func(c context.Context) error {
			p := runtime.Evaluate(expr).WithReturnByValue(true)
			p = awaitPromise(p)
			r, ex, err := p.Do(c)
			if err != nil {
				return err
			}
			if ex != nil {
				return errors.New(ex.Text)
			}
			// runInline 返回 JSON 字符串
			if err := json.Unmarshal(r.Value, &payloadStr); err != nil {
				return fmt.Errorf("decode result: %w (raw=%s)", err, string(r.Value))
			}
			return nil
		}),
	); err != nil {
		res.InfraError = "evaluate runInline: " + err.Error()
		res.DurationMs = time.Since(start).Milliseconds()
		return res
	}

	res.Payload = json.RawMessage(payloadStr)
	res.DurationMs = time.Since(start).Milliseconds()
	return res
}

// ---------- Audit ----------

// Audit 是 V5 唯一对外的核心入口。
//
// 行为:
//   - 启动(或复用)共享 chromedp 进程
//   - 按 Concurrency 限流并发跑所有 scenario(每个独立 tab)
//   - 收齐 LLMPayload 后,如果没禁 LLM,做一次 batch verdict 调用
//   - 返回 AuditResult,InfraError 在 ScenarioResult 内,LLM 错误在顶层
//
// 单个 scenario 的失败不会让 Audit 整体返回 error;只有"全员都没跑通"或"参数错"才会。
func Audit(ctx context.Context, req AuditRequest) (*AuditResult, error) {
	if req.URL == "" {
		return nil, errors.New("AuditRequest.URL is empty")
	}
	if len(req.Scenarios) == 0 {
		return nil, errors.New("AuditRequest.Scenarios is empty")
	}

	start := time.Now()
	conc := req.Concurrency
	if conc <= 0 {
		conc = DefaultConcurrency
	}

	sharedAlloc, err := ensureBrowser()
	if err != nil {
		return nil, fmt.Errorf("browser: %w", err)
	}

	fullURL := applyAuditParam(req.URL)
	results := make([]ScenarioResult, len(req.Scenarios))
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup

	for i, sc := range req.Scenarios {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, sc Scenario) {
			defer wg.Done()
			defer func() { <-sem }()
			results[idx] = runOneInline(ctx, sharedAlloc, fullURL, sc)
		}(i, sc)
	}
	wg.Wait()

	out := &AuditResult{
		GameIntent: req.GameIntent,
		Results:    results,
		DurationMs: time.Since(start).Milliseconds(),
	}

	// 至少一个 scenario 有 payload 才送 LLM
	hasPayload := false
	for _, r := range results {
		if len(r.Payload) > 0 {
			hasPayload = true
			break
		}
	}
	if !hasPayload {
		out.LLMSkipped = "no scenario produced a payload"
		return out, nil
	}
	if req.SkipLLM {
		out.LLMSkipped = "SkipLLM=true"
		return out, nil
	}

	apiKey := req.LLMAPIKey
	if apiKey == "" {
		apiKey = os.Getenv("ANTHROPIC_API_KEY")
	}
	if apiKey == "" {
		out.LLMSkipped = "no API key (LLMAPIKey nor ANTHROPIC_API_KEY)"
		return out, nil
	}
	model := req.LLMModel
	if model == "" {
		model = DefaultLLMModel
	}

	verdict, llmErr := callLLMBatch(ctx, apiKey, model, req.GameIntent, results)
	if llmErr != nil {
		out.LLMError = llmErr.Error()
	} else {
		out.Verdict = verdict
	}
	out.DurationMs = time.Since(start).Milliseconds()
	return out, nil
}

// ---------- LLM batch verdict ----------

const batchSystemPrompt = `你是一个游戏审计代理,负责跨多个场景对一款游戏做综合判决。
输入:
  - gameIntent:游戏的总体设计意图。
  - scenarios:每个场景包含 hypothesis、intent、tags 和实测产出的 LLMPayload(facts + verdict)。
任务:
  1. 对每个场景给出 verdict (PASS / PARTIAL / FAIL / INFRA_FAIL) 和 0-100 的 score。
  2. 找出跨场景的共同问题(同一根因导致多个场景失败)。
  3. 给出 root cause 与建议的修复方向(target: code / script / both;file 给出最可能的文件;change 给出修改思路)。
输出严格 JSON,格式:
{
  "perScenario": [{"scenarioId": "...", "verdict": "PASS|PARTIAL|FAIL|INFRA_FAIL", "score": 0-100, "evidence": ["..."]}],
  "crossScenarioFindings": [{"pattern": "...", "scenariosAffected": ["..."], "evidence": "..."}],
  "rootCauses": [{"issue": "...", "suggestedFix": {"target": "code|script|both", "file": "...", "change": "..."}}],
  "notes": "..."
}
不要输出 Markdown 或代码围栏,只输出 JSON 对象本体。`

func callLLMBatch(ctx context.Context, apiKey, model, gameIntent string, results []ScenarioResult) (string, error) {
	payload := map[string]any{
		"gameIntent": gameIntent,
		"scenarios":  results,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return "", err
	}

	return callAnthropic(ctx, apiKey, model, batchSystemPrompt, string(body))
}

// ---------- Anthropic HTTP + 重试 ----------

func callAnthropic(ctx context.Context, apiKey, model, systemPrompt, userContent string) (string, error) {
	const maxAttempts = 4
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			d := backoff(attempt)
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(d):
			}
		}
		text, retryAfter, err := callAnthropicOnce(ctx, apiKey, model, systemPrompt, userContent)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if retryAfter > 0 {
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(retryAfter):
			}
		}
	}
	return "", lastErr
}

func callAnthropicOnce(ctx context.Context, apiKey, model, systemPrompt, userContent string) (string, time.Duration, error) {
	reqBody := map[string]any{
		"model":      model,
		"max_tokens": 8192,
		"system":     systemPrompt,
		"messages": []map[string]any{
			{"role": "user", "content": userContent},
		},
	}
	body, _ := json.Marshal(reqBody)

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", strings.NewReader(string(body)))
	if err != nil {
		return "", 0, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", apiKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 5 * time.Minute}
	resp, err := client.Do(httpReq)
	if err != nil {
		return "", 0, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode == 429 || resp.StatusCode >= 500 {
		return "", parseRetryAfter(resp.Header.Get("Retry-After")), fmt.Errorf("anthropic HTTP %d: %s", resp.StatusCode, string(respBody))
	}
	if resp.StatusCode != 200 {
		return "", 0, fmt.Errorf("anthropic HTTP %d: %s", resp.StatusCode, string(respBody))
	}

	var parsed struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", 0, err
	}
	var sb strings.Builder
	for _, c := range parsed.Content {
		if c.Type == "text" {
			sb.WriteString(c.Text)
		}
	}
	return sb.String(), 0, nil
}

func parseRetryAfter(s string) time.Duration {
	if s == "" {
		return 0
	}
	if n, err := strconv.Atoi(s); err == nil {
		return time.Duration(n) * time.Second
	}
	return 0
}

func backoff(attempt int) time.Duration {
	base := time.Duration(1<<attempt) * time.Second
	if base > 30*time.Second {
		base = 30 * time.Second
	}
	return base
}
