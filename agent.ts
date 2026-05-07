// agent.ts
// V4 Agent 入口 — 暴露 window.WebOps 与脚本注册表给 Go 后端 / chromedp。
//
// V4.1 新增：
//   - gameIntent: 整页面级别的设计意图(如"角度分类游戏: 玩家根据卡片角度按对应键")。
//   - 每个 scenario 注册时可带 intent + tags。
//   - WebOps.describe() 自描述协议: Go 一次握手拿到全部调度+判决所需上下文。
//
// V4 设计约束:
//   - 框架不再"独立注入"。Next.js 应用 import 一次,把 webops 挂到 window 上。
//   - 业务代码通过 webops.register('scenarioId', { build, hypothesis, intent, tags }) 注册剧本。
//   - Go 后端通过 chromedp.Evaluate 调用 WebOps.run 拿单 scenario 结果,或 WebOps.describe 拿全图。

import { runSession, RunOptions } from './index';
import { Script as ScriptFactory, CompiledScript } from './script--Script';
import type { LLMPayload } from './report--ReportBuilder';

export interface RegisteredScenario {
  /** 工厂函数,每次 run 都重新构造一遍,避免跨 run 的 IR 共享。 */
  build: () => CompiledScript;
  /** 该剧本期望看到什么(测试断言层面的描述,会进 LLMPayload.hypothesis)。 */
  hypothesis: string;
  /** 该剧本在审计什么设计意图(目的层面的描述,与 hypothesis 互补)。 */
  intent?: string;
  /** 标签,便于按类型筛选: 'happy-path' / 'failure-path' / 'stress' / 'regression' 等。 */
  tags?: string[];
  /** 默认 run 参数。可被 run() 时的 override 覆盖。 */
  options?: RunOptions;
}

/** Go 一次握手就能拿到的全部上下文。 */
export interface AgentDescription {
  gameIntent?: string;
  scenarios: Array<{
    id: string;
    hypothesis: string;
    intent?: string;
    tags?: string[];
  }>;
}

class WebOpsAgent {
  private registry = new Map<string, RegisteredScenario>();
  private gameIntent: string | undefined;

  /** 注册一个剧本(脚本工厂 + 假设 + 可选意图/标签)。 */
  register(scenarioId: string, entry: RegisteredScenario): void {
    this.registry.set(scenarioId, entry);
  }

  /** 设置整个游戏页面的设计意图,所有 scenario 共享。 */
  setGameIntent(intent: string): void {
    this.gameIntent = intent;
  }

  /** 查询当前已注册的剧本名(简单调试用)。 */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /** 自描述协议: Go 后端一次握手拿到全部调度信息。 */
  describe(): AgentDescription {
    const scenarios = Array.from(this.registry.entries()).map(([id, e]) => ({
      id,
      hypothesis: e.hypothesis,
      intent: e.intent,
      tags: e.tags
    }));
    return { gameIntent: this.gameIntent, scenarios };
  }

  /** 跑一个剧本,返回完整 LLMPayload(JSON 序列化串)。 */
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
        intent: entry.intent,
        tags: entry.tags,
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

/**
 * webops 单例。
 *
 * **重要**: 这个模块应该被 Bootstrap **动态 import**,而不是静态 import。
 * 静态 import 会让 SessionRunner / ReportBuilder / 6 个 core 探针进入生产 bundle,
 * 即使生产用户永远不审计也要下载 25-30KB(gzipped)。
 *
 * 正确姿势:
 *   import { shouldEnableWebOps } from '@/webops/runtime';  // 静态,轻量
 *   useEffect(() => {
 *     if (!shouldEnableWebOps()) return;
 *     (async () => {
 *       const { webops } = await import('@/webops');         // 动态,重量
 *       webops.register('perfect-player', { ... });
 *     })();
 *   }, []);
 *
 * 游戏组件需要的 useTrack / withTelemetry 在 @/webops/runtime 里,与本文件解耦。
 */
export const webops = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as any;
  if (!g.WebOps) g.WebOps = new WebOpsAgent();
  return g.WebOps as WebOpsAgent;
})();

// Re-export 让动态 import 后能拿到 Script 工厂等审计端工具。
// 注意: 不在这里 re-export useTrack / withTelemetry —— 那些是组件用的,在 @/webops/runtime 里独立导出,
// 避免组件静态 import 它们时把整个 agent.ts 拖进生产 bundle。
export { runSession } from './index';
export { Script as ScriptFactory } from './script--Script';
export type { LLMPayload } from './report--ReportBuilder';
