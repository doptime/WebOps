// index.ts — webops V4 主入口。
//
// 设计：SessionRunner 在 runSession() 时会把 vc.pushMetric 写到 window.__WEBOPS_PUSH_FN__，
//      所有 useSignalBinding / Zustand 中间件都从这个全局拿，没设就空转。
//      这样业务代码可以放心保留 telemetry 调用，不影响生产构建。

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

/**
 * 一站式：跑一个 session 并直接拿到 LLM-ready payload。
 * 这是最常用的入口 —— 业务侧 `import { runSession } from '@/webops'` 就够了。
 */
export async function runSession(
  script: CompiledScript,
  opts: RunnerOptions & { hypothesis?: string; includeRaw?: boolean } = {}
): Promise<LLMPayload> {
  const runner = new SessionRunner(opts);

  // 把 pushMetric 暴露成全局 + 注入到 zustand 中间件
  const w = window as any;
  const pushFn = (id: string, key: string, value: number) => {
    // SessionRunner 内部的 vc 是 private，通过 mark + 自定义 push 接口暴露
    (runner as any).vc.pushMetric(id, key, value);
  };
  w.__WEBOPS_PUSH_FN__ = pushFn;
  setTelemetryPushFn(pushFn);

  try {
    const report = await runner.runSession(script);
    return buildLLMPayload(report, {
      hypothesis: opts.hypothesis,
      includeRaw: opts.includeRaw
    });
  } finally {
    delete w.__WEBOPS_PUSH_FN__;
    clearTelemetryPushFn();
  }
}
