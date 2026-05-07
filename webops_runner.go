package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"text/template"
	"time"

	"github.com/playwright-community/playwright-go"

	"github.com/doptime/llm"
)

// =============================================================================
// 【第一部分：肌肉】WebOpsRunner (底层物理外壳与探针调度器)
// =============================================================================

type WebOpsRunner struct {
	pw      *playwright.Playwright
	browser playwright.Browser
	page    playwright.Page
	logs    []string // 收集前端控制台日志，用于演化反馈
}

func NewWebOpsRunner(agentJsPath string, targetURL string) (*WebOpsRunner, error) {
	runner := &WebOpsRunner{
		logs: make([]string, 0),
	}

	// 1. 读取本地探针脚本内容
	agentJsBytes, err := os.ReadFile(agentJsPath)
	if err != nil {
		return nil, fmt.Errorf("读取探针脚本失败 [%s]: %v", agentJsPath, err)
	}

	// 2. 初始化 Playwright
	runner.pw, err = playwright.Run()
	if err != nil {
		return nil, fmt.Errorf("启动 Playwright 失败: %v", err)
	}

	runner.browser, err = runner.pw.Chromium.Launch(playwright.BrowserTypeLaunchOptions{
		Headless: playwright.Bool(true),
	})
	if err != nil {
		return nil, fmt.Errorf("启动浏览器失败: %v", err)
	}

	runner.page, err = runner.browser.NewPage()
	if err != nil {
		return nil, fmt.Errorf("创建页面失败: %v", err)
	}

	// 3. 监听控制台和页面崩溃日志
	runner.page.On("console", func(msg playwright.ConsoleMessage) {
		logLine := fmt.Sprintf("[Browser %s] %s", strings.ToUpper(msg.Type()), msg.Text())
		runner.logs = append(runner.logs, logLine)
	})
	runner.page.On("pageerror", func(err error) {
		runner.logs = append(runner.logs, fmt.Sprintf("[Browser FATAL] %v", err))
	})

	// 4. 在任何业务 JS 执行前，强行注入 WebOps 单体探针
	err = runner.page.AddInitScript(playwright.Script{
		Content: playwright.String(string(agentJsBytes)),
	})
	if err != nil {
		return nil, fmt.Errorf("注入 WebOps 探针失败: %v", err)
	}

	// 5. 导航至目标页面
	fmt.Printf("🌐 Navigating to %s...\n", targetURL)
	if _, err := runner.page.Goto(targetURL, playwright.PageGotoOptions{
		WaitUntil: playwright.WaitUntilStateNetworkidle,
	}); err != nil {
		return nil, fmt.Errorf("页面加载失败: %v", err)
	}

	// 6. 启动底层监控
	if _, err := runner.page.Evaluate(`window.WebOps.start();`); err != nil {
		return nil, fmt.Errorf("唤醒 WebOps 探针失败: %v", err)
	}

	return runner, nil
}

// ObserveEnvironment [新增] 静默观察一段时间，并提取当前页面的实体坐标状态喂给 LLM
func (r *WebOpsRunner) ObserveEnvironment(duration time.Duration) (string, error) {
	fmt.Printf("👀 正在静默观察页面环境 (等待物理引擎稳定) %v...\n", duration)
	time.Sleep(duration)

	// 通过 JS 提取所有被追踪的元素的实时位置信息
	script := `
		() => {
			const elements = document.querySelectorAll('[data-vt-id]');
			const state = {};
			elements.forEach(el => {
				const rect = el.getBoundingClientRect();
				// 提取中心点坐标，供 LLM 编排动作时使用
				state[el.getAttribute('data-vt-id')] = {
					x: Math.round(rect.x + rect.width/2),
					y: Math.round(rect.y + rect.height/2),
					width: Math.round(rect.width),
					height: Math.round(rect.height),
					text: el.innerText ? el.innerText.trim().substring(0, 10) : ''
				};
			});
			return JSON.stringify(state);
		}
	`
	result, err := r.page.Evaluate(script)
	if err != nil {
		return "", fmt.Errorf("提取环境状态失败: %v", err)
	}

	stateStr, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("环境状态返回类型异常")
	}
	return stateStr, nil
}

// ExecuteChoreography 接收 JSON 格式的剧本执行并返回本地结算的诊断报告
func (r *WebOpsRunner) ExecuteChoreography(scenarioJSON string, timeout time.Duration) (string, error) {
	fmt.Println("🎬 开始执行动作编排 (Choreography)...")

	script := fmt.Sprintf(`
		async () => {
			const timeline = %s;
			return await window.WebOps.runScenario(timeline);
		}
	`, scenarioJSON)

	r.page.SetDefaultTimeout(float64(timeout.Milliseconds()))

	result, err := r.page.Evaluate(script)
	if err != nil {
		crashLog := strings.Join(r.logs, "\n")
		return "", fmt.Errorf("剧本执行异常: %v\n---BROWSER_CRASH_LOG---\n%s\n-----------------------", err, crashLog)
	}

	reportStr, ok := result.(string)
	if !ok {
		return "", fmt.Errorf("前端探针返回了非字符串类型的异常数据")
	}

	return reportStr, nil
}
func (r *WebOpsRunner) PrintCollectedLogs() {
	fmt.Println("=== Browser Console Logs ===")
	for _, log := range r.logs {
		fmt.Println(log)
	}
	fmt.Println("=== End Logs ===")
}
func (r *WebOpsRunner) Close() {
	if r.browser != nil {
		r.browser.Close()
	}
	if r.pw != nil {
		r.pw.Stop()
	}
}

// =============================================================================
// 【第二部分：数据协议】LLM 工具参数结构
// =============================================================================

type ATPToolArgs struct {
	ScenarioID string        `json:"scenario_id" jsonschema:"description=测试场景的唯一标识"`
	Strategy   string        `json:"strategy" jsonschema:"description=执行策略, enum=human_like,mechanical"`
	Timeline   []interface{} `json:"timeline" jsonschema:"description=JSON格式的动作时间轴。DRAG 必须包含 x,y,endX,endY 参数。"`
}

type FinishToolArgs struct {
	FinalVerdict string `json:"final_verdict" jsonschema:"description=最终结论, enum=SUCCESS,FAILED_UNFIXABLE"`
	Summary      string `json:"summary" jsonschema:"description=对本次诊断和交互结果的分析总结"`
}

// =============================================================================
// 【第三部分：大脑】WebOpsMissionAgent (大模型测试代理)
// =============================================================================

type WebOpsMissionAgent struct {
	Runner      *WebOpsRunner
	LLMAgent    *llm.Agent
	FinalReport string
	IsSuccess   bool
}

func NewWebOpsMissionAgent(runner *WebOpsRunner) *WebOpsMissionAgent {
	missionAgent := &WebOpsMissionAgent{
		Runner: runner,
	}

	promptTpl := template.Must(template.New("Agent").Parse(`
你是一个自动化的 3D/GUI 测试专家 (WebOps Agent)。
你的任务是通过无头浏览器，完成以下测试意图：
<Intent>
{{.Intent}}
</Intent>

这是在目标页面静默观察 5 秒后收集到的实体快照信息（包含中心坐标 x, y）：
<EnvironmentState>
{{.EnvState}}
</EnvironmentState>

【规则与流程】
1. 分析意图与环境：在 EnvironmentState 中寻找符合意图的元素的 x 和 y 坐标。
2. 动作编排：使用 'ExecuteATP' 工具生成动作流。例如你要拖拽 A 到 B，就使用 DRAG 动作，将 A 的 x,y 作为起点，B 的 x,y 作为 endX, endY。
3. 审阅报告：执行后，系统会返回前端实时计算的诊断报告。
   - 若 verdict 为 HEALTHY，说明交互响应正常。
   - 若 verdict 为 NO_RESPONSE，说明发生了 UI 死锁或穿模（拖了但没反应）。
4. 结案：根据执行报告调用 'FinishMission' 结束测试，并将报错或成功细节写入 Summary。
`))

	// 工具 A：执行动作并获取诊断
	toolExecute := llm.NewTool("ExecuteATP", "执行物理动作剧本并获取底层诊断报告", func(args *ATPToolArgs) {
		fmt.Printf("\n🤖 [LLM Brain] 正在下发剧本: %s\n", args.ScenarioID)

		payload, _ := json.Marshal(args)

		report, err := missionAgent.Runner.ExecuteChoreography(string(payload), 15*time.Second)
		if err != nil {
			missionAgent.FinalReport = fmt.Sprintf("执行崩溃: %v", err)
			return
		}

		fmt.Printf("📊 [LLM Brain] 获取到底层反馈，正在分析...\n")
		missionAgent.FinalReport = report
	})

	// 工具 B：结束任务
	toolFinish := llm.NewTool("FinishMission", "结束测试任务并输出结论", func(args *FinishToolArgs) {
		fmt.Printf("\n🏁 [任务完结] 结论: %s\n💡 总结: %s\n", args.FinalVerdict, args.Summary)
		missionAgent.IsSuccess = (args.FinalVerdict == "SUCCESS")
	})

	missionAgent.LLMAgent = llm.NewAgent(promptTpl).UseTools(toolExecute, toolFinish).UseModels(llm.ModelDefault)

	return missionAgent
}

// Run 启动闭环：先观察环境，再调用 LLM 推理
func (a *WebOpsMissionAgent) Run(intent string) error {
	// 1. 静默观察 5 秒钟（等待 R3F 和物理引擎加载完成，碎片散落就位）
	envStateJSON, err := a.Runner.ObserveEnvironment(5 * time.Second)
	if err != nil {
		return fmt.Errorf("环境观察失败: %v", err)
	}

	fmt.Println("🧠 将环境状态与意图交由 LLM 大脑分析...")
	// 2. 调用大模型
	return a.LLMAgent.Call(map[string]any{
		"Intent":   intent,
		"EnvState": envStateJSON,
	})
}

// =============================================================================
// 【第四部分：入口】主程序
// =============================================================================

func main() {
	// 配置参数
	agentJsPath := "./webops-agent.js"
	targetURL := "http://localhost:3000/lesson/484"

	// 1. 初始化底层物理外壳
	runner, err := NewWebOpsRunner(agentJsPath, targetURL)
	if err != nil {
		log.Fatalf("沙盒初始化失败: %v", err)
	}
	defer runner.Close()

	// 2. 组装代理闭环
	missionAgent := NewWebOpsMissionAgent(runner)

	// 3. 执行测试任务
	intent := "找到场上的部首 '火' 和 '少' 的坐标，使用 DRAG 动作将 '火' 拖拽到 '少' 的位置上进行合并测试。操作完成后等待 2000ms 观察现象。"
	fmt.Printf("🎯 接收意图: %s\n", intent)

	err = missionAgent.Run(intent)
	if err != nil {
		log.Fatalf("Agent 运行异常: %v", err)
	}

	// 4. 将最终报告标准格式输出给外部的 AlphaEvolve 引擎
	fmt.Printf("\n---ALPHA_EVOLVE_REPORT_START---\n%s\n---ALPHA_EVOLVE_REPORT_END---\n", missionAgent.FinalReport)
}
