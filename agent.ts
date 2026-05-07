// agent.ts
// V4 Agent 入口 — 暴露 window.WebOps 与脚本注册表给 Go 后端 / chromedp。
//
// 与 V3 不同:V4 不再"独立注入"。这个文件被 Next.js 应用 import 一次
// (放在 layout.tsx 或 _app.tsx 中即可),把框架挂到 window 上;
// 业务代码通过 webops.register('scenarioId', scriptBuilder) 注册剧本;
// Go 后端通过 chromedp.Evaluate 调用 window.WebOps.run('scenarioId') 拿结果。

import { runSession, Script as ScriptFactory, RunOptions } from './index';
import type { LLMPayload } from './report--ReportBuilder';

type Registered = {
  build: () => ReturnType<typeof ScriptFactory>;
  hypothesis?: string;
  options?: RunOptions;
};

class WebOpsAgent {
  private registry = new Map<string, Registered>();

  /** 业务代码用这个注册一个剧本(脚本工厂 + 假设描述)。 */
  register(scenarioId: string, entry: Registered): void {
    this.registry.set(scenarioId, entry);
  }

  /** 查询当前已注册的剧本名(供 Go 后端 / 调试) */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /** 真正驱动:跑一个剧本,返回完整 LLMPayload(JSON 序列化串)。 */
  async run(scenarioId: string, override?: Partial<RunOptions>): Promise<string> {
    const entry = this.registry.get(scenarioId);
    if (!entry) {
      const err = { error: 'SCENARIO_NOT_FOUND', scenarioId, available: this.list() };
      return JSON.stringify(err);
    }
    try {
      const script = entry.build();
      const payload: LLMPayload = await runSession(script, {
        hypothesis: entry.hypothesis,
        ...entry.options,
        ...override
      });
      return JSON.stringify(payload);
    } catch (e) {
      return JSON.stringify({
        error: 'SESSION_FAILED',
        scenarioId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
    }
  }

  /** 暴露原始构造器给业务代码(用于动态构建脚本) */
  Script = ScriptFactory;
}

declare global {
  interface Window {
    WebOps?: WebOpsAgent;
  }
}

export const webops = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as any;
  if (!g.WebOps) g.WebOps = new WebOpsAgent();
  return g.WebOps as WebOpsAgent;
})();

// 重新 re-export 让业务代码可以从单一入口拿到所有东西
export { runSession, Script as ScriptFactory } from './index';
export * from './react--useTrack';
export * from './react--zustand-telemetry';
export type { LLMPayload } from './report--ReportBuilder';
