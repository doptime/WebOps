// core/audio-telemetry.ts
// 音频探针 — 通过 Monkey-Patch AudioContext 自动捕捉所有声音输出。
//
// V4 改动：
//   - sample() 由 SessionRunner 在统一时钟下驱动，不再独立 RAF。
//   - flush 直接调用 VirtualChannel.pushAggregated，避免双层聚合丢失极值。

import { AggregatedMetric, emptyMetric, pushValue, isEmpty } from './core--kline';
import { VirtualChannel } from './core--virtual-channel';

export class AudioTelemetry {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array | null = null;
  private bufferRMS: AggregatedMetric = emptyMetric();
  private bufferPeak: AggregatedMetric = emptyMetric();
  private virtualChannel: VirtualChannel;
  private originalAudioContext: typeof AudioContext | null = null;

  constructor(virtualChannel: VirtualChannel) {
    this.virtualChannel = virtualChannel;
  }

  /** 启动 — 安装 Monkey-Patch，新建的所有 AudioContext 都会被自动捕获。 */
  start(): void {
    if (this.originalAudioContext) return;
    if (typeof window === 'undefined') return;
    this.originalAudioContext = window.AudioContext || (window as any).webkitAudioContext;
    if (!this.originalAudioContext) return;

    const self = this;
    const Patched = function (this: AudioContext, ...args: any[]) {
      const ctx = new (self.originalAudioContext as any)(...args);
      const interceptor = ctx.createGain();
      interceptor.connect(ctx.destination);
      self.attach(ctx, interceptor);
      Object.defineProperty(ctx, 'destination', { get: () => interceptor });
      return ctx;
    } as unknown as typeof AudioContext;
    Patched.prototype = this.originalAudioContext.prototype;
    window.AudioContext = Patched;
    if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = Patched;
  }

  stop(): void {
    if (this.originalAudioContext) {
      window.AudioContext = this.originalAudioContext;
      if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = this.originalAudioContext;
      this.originalAudioContext = null;
    }
    this.context = null;
    this.analyser = null;
    this.dataArray = null;
  }

  /** 单帧采样 — 由 SessionRunner 驱动。 */
  sample(): void {
    if (!this.analyser || !this.dataArray) return;
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    let peak = 0;
    const len = this.dataArray.length;
    for (let i = 0; i < len; i++) {
      const v = this.dataArray[i] / 255;
      sum += v * v;
      if (v > peak) peak = v;
    }
    pushValue(this.bufferRMS, Math.sqrt(sum / len));
    pushValue(this.bufferPeak, peak);
  }

  /** 把已聚合的 K 线推入 VirtualChannel —— 避免二次聚合丢失极值。 */
  flush(): void {
    if (!isEmpty(this.bufferRMS)) {
      this.virtualChannel.pushAggregated('__audio__', 'rms', this.bufferRMS);
      this.bufferRMS = emptyMetric();
    }
    if (!isEmpty(this.bufferPeak)) {
      this.virtualChannel.pushAggregated('__audio__', 'peak', this.bufferPeak);
      this.bufferPeak = emptyMetric();
    }
  }

  private attach(ctx: AudioContext, source: AudioNode): void {
    if (this.context === ctx) return;
    this.context = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    source.connect(this.analyser);
  }
}
