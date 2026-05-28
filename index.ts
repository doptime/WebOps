// index.ts — WebOps V6 主入口。
//
// V6 把"会话 → 给模型的输入"从 K 线数值 LLMPayload 换成媒体 MediaSessionReport
// (视频帧由驱动器补、音频前端录、timeline 做时间锚)。判决交给多模态模型(Qwen3-Omni)。
//
// 同 tab 仍只能跑一个 session:AudioContext / R3F scene / store 都是 tab 内单例,
// 并发只能在 chromedp tab 维度做。in-flight 锁保留为防御。

export { Script } from './script--Script';
export type { CompiledScript, StepIR, Strategy, TargetSpec } from './script--Script';

export { SessionRunner } from './session--SessionRunner';
export type { RunnerOptions } from './session--SessionRunner';

export { EventSink } from './core--event-sink';
export type { TimedEvent, EventKind } from './core--event-sink';

export { AudioCapture } from './core--audio-capture';
export type { AudioCaptureResult } from './core--audio-capture';

export { buildMediaPayload, summarize } from './report--ReportBuilder';
export type { MediaPayload, MediaSessionReport, MediaRef, AudioRef } from './report--MediaPayload';

export { useTrack, usePushSignal, useSignalBinding } from './react--useTrack';
export { withTelemetry, setTelemetryPushFn, clearTelemetryPushFn } from './react--zustand-telemetry';

import { SessionRunner, RunnerOptions } from './session--SessionRunner';
import { CompiledScript } from './script--Script';
import { MediaSessionReport } from './report--MediaPayload';

export type RunOptions = RunnerOptions & {
  hypothesis?: string;
  intent?: string;
  tags?: string[];
};

let inflight = false;

/**
 * 跑一个 session,返回 MediaSessionReport(JSON 可序列化)。
 *
 * 注意:返回的 report 里 audio 是 base64、video 还没有 —— 视频帧由 Go/chromedp 驱动器
 * 通过 CDP Page.startScreencast 在 session 期间截下,driver 侧再用 buildMediaPayload()
 * 把 frames + 转码后的音频拼成最终 MediaPayload 喂 vLLM。
 *
 * 本地 dev(无驱动器)调用也能跑:armCapture 超时后照常执行,只是没有视频帧。
 */
export async function runSession(
  script: CompiledScript,
  opts: RunOptions = {}
): Promise<MediaSessionReport> {
  if (inflight) {
    throw new Error(
      '[webops] another runSession is already in flight in this tab. ' +
      'Concurrency must be done at the Go/chromedp tab level, not within a single tab.'
    );
  }
  inflight = true;
  try {
    const runner = new SessionRunner(opts);
    return await runner.runSession(script);
  } finally {
    inflight = false;
  }
}
