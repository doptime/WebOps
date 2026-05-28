// core/audio-capture.ts
// V6 取代 V4 的 core--audio-telemetry.ts。
//
// V4 把音频降维成 RMS/peak 两根 K 线数字。V6 不再降维:它把应用"真正发出的声音"
// 录成一段音频(WebM/Opus),交给多模态模型去听。
//
// 复用 V4 已经验证可行的拦截缝:Monkey-Patch AudioContext,把每个新建 context 的
// destination 换成一个 gain 节点(interceptor)。V4 在这个节点上接 AnalyserNode 算 RMS;
// V6 在同一个节点上多接一条线 → MediaStreamAudioDestinationNode → MediaRecorder。
//
// 关键事实(决定本模块为何这样设计):
//   1. MediaRecorder 录的是 WebAudio 图里的信号,不依赖任何物理声卡。
//      所以在 headless / 无声卡的自动化 Chrome 里也能拿到声音 —— 这是相对
//      "Xvfb + PulseAudio 虚拟声卡 + ffmpeg 抓系统音"路线的最大优势:零 OS 音频管线。
//   2. interceptor 仍然连到原 destination,声音照常播放;录制是旁路 tee,不改变可听性。
//   3. vLLM 部署 Qwen3-Omni 时 use_audio_in_video 不可用(见 FEASIBILITY_AND_PLAN.md),
//      音频要与视频分开喂模型。所以这里产出的就是一段独立音频,正合适。
//
// 产出交付:停止时把录到的 Blob 转 base64,挂到 window.__WEBOPS_AUDIO__,
// 由 Go/chromedp 驱动器读走(chromedp 无法直接拿 Blob,base64 字符串最稳)。

export interface AudioCaptureResult {
  /** MediaRecorder 实际产出的 MIME(通常 audio/webm;codecs=opus)。 */
  mimeType: string;
  /** base64 编码的音频字节(驱动器解码后 ffmpeg 转 wav 喂模型)。 */
  base64: string;
  /** 录制时长(ms),与视频对齐校验用。 */
  durationMs: number;
  /** 是否真的捕获到了 AudioContext(没有则说明这个应用没出声)。 */
  captured: boolean;
}

const PREFERRED_MIME = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
];

export class AudioCapture {
  private originalAudioContext: typeof AudioContext | null = null;
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private streamDest: MediaStreamAudioDestinationNode | null = null;
  private startTs = 0;
  private capturedCtx = false;
  private mimeType = 'audio/webm';

  /** 安装拦截 + 开录。必须在脚本派发第一个动作之前调用。 */
  start(): void {
    if (this.originalAudioContext) return;
    if (typeof window === 'undefined') return;
    const Native = window.AudioContext || (window as any).webkitAudioContext;
    if (!Native) return;
    this.originalAudioContext = Native;

    const self = this;
    const Patched = function (this: AudioContext, ...args: any[]) {
      const ctx = new (Native as any)(...args);
      const interceptor = ctx.createGain();
      interceptor.connect(ctx.destination);     // 声音照常播放
      self.attach(ctx, interceptor);            // 旁路 tee 到 recorder
      Object.defineProperty(ctx, 'destination', { get: () => interceptor });
      return ctx;
    } as unknown as typeof AudioContext;
    Patched.prototype = Native.prototype;
    window.AudioContext = Patched;
    if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = Patched;

    this.startTs = nowMs();
  }

  /** 第一个被 patch 的 context 出现时,建立 recorder。 */
  private attach(ctx: AudioContext, source: AudioNode): void {
    if (this.streamDest) return; // 只挂一次:同一 tab 内多 context 罕见,首个为准
    this.capturedCtx = true;
    this.streamDest = ctx.createMediaStreamDestination();
    source.connect(this.streamDest);

    this.mimeType = pickMime();
    try {
      this.recorder = new MediaRecorder(this.streamDest.stream, { mimeType: this.mimeType });
    } catch {
      this.recorder = new MediaRecorder(this.streamDest.stream); // 退回浏览器默认
      this.mimeType = this.recorder.mimeType || 'audio/webm';
    }
    this.chunks = [];
    this.recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) this.chunks.push(e.data); };
    this.recorder.start(250); // 每 250ms 出一块,降低尾段丢失风险
  }

  /** 停录并卸载拦截,返回可被驱动器读走的结果。 */
  async stop(): Promise<AudioCaptureResult> {
    const durationMs = Math.round(nowMs() - this.startTs);

    // 卸载 monkey-patch
    if (this.originalAudioContext) {
      window.AudioContext = this.originalAudioContext;
      if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = this.originalAudioContext;
      this.originalAudioContext = null;
    }

    if (!this.recorder || !this.capturedCtx) {
      return { mimeType: this.mimeType, base64: '', durationMs, captured: false };
    }

    const blob = await new Promise<Blob>((resolve) => {
      this.recorder!.onstop = () => resolve(new Blob(this.chunks, { type: this.mimeType }));
      if (this.recorder!.state !== 'inactive') this.recorder!.stop();
      else resolve(new Blob(this.chunks, { type: this.mimeType }));
    });

    const base64 = await blobToBase64(blob);
    const result: AudioCaptureResult = { mimeType: this.mimeType, base64, durationMs, captured: true };

    // 暴露给驱动器:chromedp 读 window.__WEBOPS_AUDIO__ 取走 base64。
    (window as any).__WEBOPS_AUDIO__ = result;
    return result;
  }
}

function pickMime(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return 'audio/webm';
  for (const m of PREFERRED_MIME) if (MediaRecorder.isTypeSupported(m)) return m;
  return 'audio/webm';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const s = String(reader.result || '');
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s); // 去掉 data:...;base64, 前缀
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
