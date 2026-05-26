// agent.ts — V5 Agent 入口。
//
// 与 V4.1 的区别:
//   - 没有 register / describe / Map registry → 删干净。
//   - 唯一 API 是 runInline(scriptJSON, metaJSON):接收 Go 端 builder 直送的 IR,执行,
//     回 LLMPayload JSON。
//   - "每个 tab 一个 scenario" 的并发模型不变,但脚本是 per-call 传入,不是预注册。
//
// 业务侧 Bootstrap 现在只需 `await import('@/webops')` 触发挂载,不再 register。
// 完整脚本在 Go 端 builder 里,见 webops/webops.go 和 coffee_cloze_test.go。

import { runSession } from './index';
import { compileIR, InlineScript } from './script--ir';

interface RunMeta {
  hypothesis?: string;
  intent?: string;
  tags?: string[];
}

class WebOpsAgent {
  /**
   * Go 调用入口。两个参数都是 JSON 对象(JS 字面量也行,因为 JSON ⊂ JS)。
   * 返回 JSON 字符串形式的 LLMPayload(由 buildLLMPayload 产出)。
   * 错误情况返回 { error: '...', message: '...' } 形态的 JSON。
   */
  async runInline(script: InlineScript, meta: RunMeta = {}): Promise<string> {
    try {
      const compiled = compileIR(script);
      const payload = await runSession(compiled, {
        hypothesis: meta.hypothesis,
        intent: meta.intent,
        tags: meta.tags,
      });
      return JSON.stringify(payload);
    } catch (e) {
      return JSON.stringify({
        error: 'SESSION_FAILED',
        scenarioId: script?.scenarioId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  }
}

declare global {
  interface Window { WebOps?: WebOpsAgent }
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
 *     import('@/webops');     // 动态,重量。挂载 window.WebOps,然后由 Go 端调用。
 *   }, []);
 *
 * 游戏组件需要的 useTrack / withTelemetry 在 @/webops/runtime 里,与本文件解耦。
 */
export const webops = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as any;
  if (!g.WebOps) g.WebOps = new WebOpsAgent();
  return g.WebOps as WebOpsAgent;
})();

export type { InlineScript } from './script--ir';
export { runSession } from './index';
