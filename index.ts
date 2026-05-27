// index.ts — webops V4 主入口。
//
// V4.1 改动:
//   - 加 runSession in-flight 锁,防止同一 tab 内并发调用导致 push 函数互相覆盖。
//     V4 部署模型是"一个 chromedp tab 跑一次 session",在 tab 内是单实例。
//     这把锁是防御性的:让误调用变成显式报错,而不是数据静默串台。
//   - runSession opts 接收 intent / tags,透传给 buildLLMPayload(进 LLMPayload)。
//   - 不再导出 LLM 前端调用工具(原 llm--prompt.ts 已删除)。LLM 调用全部走 Go 后端。

export { Script } from './script--Script';
export type { CompiledScript, StepIR, Strategy, TargetSpec } from './script--Script';

export { SessionRunner } from './session--SessionRunner';
export type { SessionReport, TelemetryFrame, ActionRecord, RunnerOptions } from './session--SessionRunner';

export { buildLLMPayload, summarize } from './report--ReportBuilder';
export type { LLMPayload } from './report--ReportBuilder';

export { compressReport } from './report--compress';
export { diagnose } from './report--analyzer';
export type { Verdict, DiagnosisReport } from './report--analyzer';

export { useTrack, usePushSignal, useSignalBinding } from './react--useTrack';
export { withTelemetry, setTelemetryPushFn, clearTelemetryPushFn } from './react--zustand-telemetry';

import { SessionRunner, RunnerOptions } from './session--SessionRunner';
import { CompiledScript } from './script--Script';
import { buildLLMPayload, LLMPayload } from './report--ReportBuilder';
import { setTelemetryPushFn, clearTelemetryPushFn } from './react--zustand-telemetry';

export type RunOptions = RunnerOptions & {
  hypothesis?: string;
  intent?: string;
  tags?: string[];
  includeRaw?: boolean;
};

let inflight = false;

/**
 * 一站式: 跑一个 session 并直接拿到 LLM-ready payload。
 * 这是最常用的入口 —— 业务侧 `import { runSession } from '@/webops'` 就够了。
 *
 * 同 tab 同时只能跑一个 session: 第二次调用会立刻 reject。
 * 如果你需要并发,在 Go 后端用多个 chromedp tab(每 tab 各自有独立的 window)。
 */
export async function runSession(
  script: CompiledScript,
  opts: RunOptions = {}
): Promise<LLMPayload> {
  if (inflight) {
    throw new Error(
      '[webops] another runSession is already in flight in this tab. ' +
      'Concurrency must be done at the Go/chromedp tab level, not within a single tab.'
    );
  }
  inflight = true;

  const runner = new SessionRunner(opts);

  // 把 pushMetric 暴露成全局 + 注入到 zustand 中间件
  const w = window as any;
  const pushFn = (id: string, key: string, value: number) => {
    (runner as any).vc.pushMetric(id, key, value);
  };
  w.__WEBOPS_PUSH_FN__ = pushFn;
  setTelemetryPushFn(pushFn);

  try {
    const report = await runner.runSession(script);
    return buildLLMPayload(report, {
      hypothesis: opts.hypothesis,
      intent: opts.intent,
      tags: opts.tags,
      includeRaw: opts.includeRaw
    });
  } finally {
    delete w.__WEBOPS_PUSH_FN__;
    clearTelemetryPushFn();
    inflight = false;
  }
}
