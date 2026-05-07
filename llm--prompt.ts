// llm/prompt.ts
// LLM Prompt 模板 — 把 LLMPayload 打包成大模型友好的 prompt。
//
// 设计原则：
//   - 给大模型"事实 + 假设 + 自动诊断"三层结构，让它做高级判断。
//   - 不要让大模型 reverse engineer 数据，verdict 已经把 K 线压成 verdict 词条。
//   - 给一个明确的输出 schema，方便后端 JSON parse。

import { LLMPayload } from './report--ReportBuilder';

export interface LLMRequest {
  systemPrompt: string;
  userPrompt: string;
}

const SYSTEM_PROMPT = `You are an expert game design auditor. You receive structured telemetry from automated playthroughs of a web game (React + Next.js + R3F). Your job:

1. Read the developer's HYPOTHESIS — what should happen if the game is implemented correctly.
2. Read the FACTS — actions taken, observations, state reads, and signal tracks.
3. Read the AUTO_VERDICT — pre-computed scores and per-interval HEALTHY/NO_RESPONSE/CHAOTIC labels.
4. Output a clear judgment: did the game fulfill its design intent? If not, what specific issue occurred and where (cite step indices, marker names, or signal names).

Output STRICT JSON with this schema:
{
  "verdict": "PASS" | "PARTIAL" | "FAIL",
  "score": 0..100,                              // your final aggregated score
  "hypothesis_satisfied": [string],             // which parts of the hypothesis were demonstrably met
  "hypothesis_violated": [string],              // which were not, with evidence
  "root_causes": [                              // your inferences about why things failed
    { "issue": string, "evidence": string, "suggested_fix": string }
  ],
  "notes": string                                // free-form additional observations
}

Rules:
- Be concrete: cite step names like "click@5" or marker names like "CLICK_ACUTE_CORRECT".
- Don't invent signals that aren't in the FACTS.
- If a signal's overall K-line is ∅ (empty), treat it as "never observed".
- An interval verdict of NO_RESPONSE is strong evidence of a UI deadlock.
- FAIL_SILENT in audioSyncs means the action did not produce expected sound feedback.
- expectScore < 100 means at least one explicit assertion failed.`;

export function buildLLMRequest(payload: LLMPayload): LLMRequest {
  // 体积控制：tracks 已经在 ReportBuilder 里限制为 top N，这里再做最后一道 trim
  const trimmedPayload = {
    ...payload,
    facts: {
      ...payload.facts,
      // timeline 太长时只保留前 200 个事件 + 后 50 个，中间用 ellipsis 标记
      timeline: payload.facts.timeline.length > 250
        ? [
            ...payload.facts.timeline.slice(0, 200),
            { t: -1, type: 'ellipsis', name: `... ${payload.facts.timeline.length - 250} events omitted ...` },
            ...payload.facts.timeline.slice(-50)
          ]
        : payload.facts.timeline
    }
  };

  const userPrompt = `# HYPOTHESIS
${payload.hypothesis ?? '(no hypothesis provided — judge based on intuitive game design correctness)'}

# FACTS

\`\`\`json
${JSON.stringify(trimmedPayload, null, 2)}
\`\`\`

Now output your JSON judgment.`;

  return { systemPrompt: SYSTEM_PROMPT, userPrompt };
}

/**
 * 直接 POST 给 Anthropic API（V4 在前端跑也行，让浏览器直接喂大模型）。
 * 注意：生产环境通常应在 Go 后端代理（避免 API key 暴露）。
 */
export async function judgeViaAnthropic(
  payload: LLMPayload,
  opts: {
    apiKey: string;
    model?: string;
    endpoint?: string;
  }
): Promise<any> {
  const { systemPrompt, userPrompt } = buildLLMRequest(payload);
  const endpoint = opts.endpoint ?? 'https://api.anthropic.com/v1/messages';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: opts.model ?? 'claude-opus-4-7',
      max_tokens: 2000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await res.json();
  const text = data.content?.map((c: any) => c.text || '').join('\n') ?? '';
  // 尝试提取 JSON
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[0]); } catch { return { raw: text }; }
  }
  return { raw: text };
}
