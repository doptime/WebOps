// core/event-sink.ts
// V6 取代 V4 的 VirtualChannel + core--kline。
//
// 设计转向:V4 把每个信号聚合成 OHLC K 线喂给"文本 LLM"。V6 改喂"多模态模型"
// (Qwen3-Omni via vLLM)——模型直接看视频帧、听音频,不再需要数值轨道。
// 因此这里不再有任何 open/high/low/close 聚合,只保留一件事:
//
//   把"脚本驱动器派发了什么输入 / 业务打了什么 marker"记成带毫秒时间戳的事件。
//
// 这些事件是给模型的"时间锚":让它把"在第 1240ms 脚本按了 a 键、期望加分"
// 与它在视频里看到/听到的画面声音对齐。时间戳一律相对 capture 起点(captureT0)。

export type EventKind =
  | 'click'
  | 'drag'
  | 'key'
  | 'type'
  | 'cursor'      // 指针移动(可选,默认不记,噪声大)
  | 'marker'      // 业务/脚本显式打点
  | 'observe'
  | 'expect'
  | 'read'
  | 'error';

export interface TimedEvent {
  /** 相对 capture 起点的毫秒数。对齐视频帧用。 */
  t: number;
  kind: EventKind;
  /** 事件名(动作目标 / marker 名 / 断言名)。 */
  name: string;
  /** observe/expect 是否通过;动作是否成功。 */
  ok?: boolean;
  /** 自然语言意图(来自 StepIR.intent),直接进模型 prompt。 */
  intent?: string;
  /** read() 的值 / 坐标 / 额外上下文。 */
  detail?: unknown;
}

/**
 * EventSink —— 单次 session 的事件账本。
 * 时间锚:所有 push 进来的 ts(performance.now())统一减去 t0 得到相对毫秒。
 * t0 必须在媒体捕获(audio/video)真正开始的同一时刻设置,否则锚会漂。
 */
export class EventSink {
  private t0 = 0;
  private events: TimedEvent[] = [];
  private recordCursor: boolean;

  constructor(opts: { recordCursor?: boolean } = {}) {
    this.recordCursor = opts.recordCursor ?? false;
  }

  /** 在媒体捕获开始的同一时刻调用,锁定时间基准。 */
  anchor(t0: number): void {
    this.t0 = t0;
    this.events = [];
  }

  push(kind: EventKind, name: string, opts: { ok?: boolean; intent?: string; detail?: unknown; ts?: number } = {}): void {
    if (kind === 'cursor' && !this.recordCursor) return;
    const ts = opts.ts ?? now();
    this.events.push({
      t: Math.max(0, Math.round(ts - this.t0)),
      kind,
      name,
      ok: opts.ok,
      intent: opts.intent,
      detail: opts.detail,
    });
  }

  /** 当前时刻相对锚点的毫秒数(给需要"现在是第几毫秒"的调用方)。 */
  relNow(): number {
    return Math.max(0, Math.round(now() - this.t0));
  }

  /** 取出按时间排序的事件流(给 ReportBuilder)。 */
  harvest(): TimedEvent[] {
    return [...this.events].sort((a, b) => a.t - b.t);
  }

  reset(): void {
    this.events = [];
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
