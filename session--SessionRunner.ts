// session/SessionRunner.ts  (V6)
// 一体化 Session 执行器 —— 仍是单点入口,仍跑 Script DSL 的 steps。
//
// 与 V4 的根本差别:V4 在 RAF 循环里 60fps 采 DOM/audio/r3f 数值 → K 线 → frames。
// V6 不采任何数值。它做三件事:
//   1. 与驱动器握手,确保"视频 screencast / 音频录制"在脚本派发任何动作之前已经开始,
//      并把这一刻锁成统一时间零点 t0(captureT0)。
//   2. 照常执行 steps;每个动作/marker/observe/expect/read 落成一条 EventSink 时间锚事件。
//   3. 结束时停音频录制,返回 MediaSessionReport(timeline + state + 音频 base64)。
//      视频帧由驱动器侧 CDP 截帧补齐,与 t0 对齐。
//
// 捕获生命周期(armCapture/anchor/音频起停)抽到 withCapture(),V4(runSession)与
// V5(runWith)共用,保证两条路径的媒体采集行为完全一致。

import { CompiledScript, StepIR, ReadFn } from './script--Script';
import { ActionDispatcher } from './script--actions';
import { EventSink } from './core--event-sink';
import { AudioCapture } from './core--audio-capture';
import { MediaSessionReport } from './report--MediaPayload';

export interface RunnerOptions {
  enableAudio?: boolean;
  captureAckTimeoutMs?: number;
  recordCursor?: boolean;
}

/** 给 V5 脚本体的执行上下文:同一个 sink/dispatcher + 可写的 state 快照。
 *  body 可回传它自己收集的 observations(V5 脚本经 helper 的 observe/expect/waitFor 产生),
 *  withCapture 会并入 report.observations —— 否则 V5 路径的 observations 会是空的。 */
export interface SessionBody {
  (sink: EventSink, dispatcher: ActionDispatcher, state: Record<string, unknown>):
    Promise<{ aborted?: string | null; observations?: MediaSessionReport['observations'] } | void>;
}

export class SessionRunner {
  private sink: EventSink;
  private audio: AudioCapture;
  private dispatcher: ActionDispatcher;
  private enableAudio: boolean;
  private captureAckTimeoutMs: number;

  constructor(opts: RunnerOptions = {}) {
    this.enableAudio = opts.enableAudio ?? true;
    this.captureAckTimeoutMs = opts.captureAckTimeoutMs ?? 2000;
    this.sink = new EventSink({ recordCursor: opts.recordCursor });
    this.audio = new AudioCapture();
    this.dispatcher = new ActionDispatcher(this.sink);
  }

  mark(name: string, meta?: Record<string, unknown>): void {
    this.sink.push('marker', name, { detail: meta });
  }

  /** [V4] 跑一个 CompiledScript。 */
  async runSession(script: CompiledScript): Promise<MediaSessionReport> {
    return this.withCapture(async (sink, dispatcher, state) => {
      let aborted: string | null = null;
      await this.executeSteps(script.steps, script, sink, dispatcher, state,
        () => aborted !== null, (r) => { aborted = r; });
      return { aborted };
    }, script.scenarioId);
  }

  /** [V5] 跑任意脚本体(agent.runScript 用),共用同一套捕获生命周期。 */
  async runWith(body: SessionBody, ctx: { scenarioId: string }): Promise<MediaSessionReport> {
    return this.withCapture(body, ctx.scenarioId);
  }

  // ---------- 捕获生命周期(V4/V5 共用) ----------

  private async withCapture(body: SessionBody, scenarioId: string): Promise<MediaSessionReport> {
    const url = typeof window !== 'undefined' ? window.location.href : '';
    const state: Record<string, unknown> = {};
    this.observations = [];
    this.errors = [];

    if (this.enableAudio) this.audio.start();
    const t0 = await this.armCapture();
    this.sink.anchor(t0);

    let aborted = false;
    try {
      const r = await body(this.sink, this.dispatcher, state);
      if (r && r.aborted) aborted = true;
      if (r && r.observations && r.observations.length) {
        this.observations.push(...r.observations);
      }
    } catch (e) {
      this.errors.push(`Top-level: ${String(e)}`);
    }

    await sleep(600); // 收尾动画/音效落地
    const endTs = nowMs();
    this.disarmCapture();
    const audio = this.enableAudio
      ? await this.audio.stop()
      : { mimeType: '', base64: '', durationMs: 0, captured: false };

    return {
      scenarioId, url, startTs: t0, endTs, durationMs: Math.round(endTs - t0),
      timeline: this.sink.harvest(),
      state,
      observations: this.observations,
      errors: this.errors,
      aborted,
      audio,
    };
  }

  /**
   * 通知驱动器开始录像,等待确认。协议见 driver/cdp-screencast：
   *   window.__WEBOPS_CAPTURE__ = { state:'arm' } → 驱动器 startScreencast → 置 __WEBOPS_CAPTURE_ACK__=true
   * 无驱动器(本地 dev)超时直接返回当前时刻,session 照跑(只是没视频帧)。
   */
  private async armCapture(): Promise<number> {
    if (typeof window === 'undefined') return nowMs();
    (window as any).__WEBOPS_CAPTURE__ = { state: 'arm' };
    (window as any).__WEBOPS_CAPTURE_ACK__ = false;
    const deadline = nowMs() + this.captureAckTimeoutMs;
    while (nowMs() < deadline) {
      if ((window as any).__WEBOPS_CAPTURE_ACK__ === true) break;
      await sleep(25);
    }
    return nowMs();
  }

  private disarmCapture(): void {
    if (typeof window === 'undefined') return;
    (window as any).__WEBOPS_CAPTURE__ = { state: 'stop' };
  }

  // ---------- step 执行(与 V4.1 同构,去掉 vc 推送) ----------

  private observations: MediaSessionReport['observations'] = [];
  private errors: string[] = [];

  private async executeSteps(
    steps: StepIR[], script: CompiledScript,
    sink: EventSink, dispatcher: ActionDispatcher, state: Record<string, unknown>,
    isAborted: () => boolean, setAborted: (r: string) => void
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      if (isAborted()) return;
      const step = steps[i];
      const intent = (step as { intent?: string }).intent;
      try {
        await this.executeOne(step, script, sink, dispatcher, state, intent);
      } catch (e) {
        this.errors.push(`Step ${i} (${step.kind}): ${e}`);
        sink.push('error', this.stepName(step), { intent, detail: String(e) });
      }
      if (step.kind === 'expect') {
        const last = this.observations[this.observations.length - 1];
        if (last && !last.passed && !script.continueOnExpectFail) {
          setAborted('expect_fail');
          sink.push('marker', '__SCENARIO_ABORT__', { detail: { stepIndex: i } });
          return;
        }
      }
    }
  }

  private async executeOne(
    step: StepIR, script: CompiledScript,
    sink: EventSink, dispatcher: ActionDispatcher, state: Record<string, unknown>, intent?: string
  ): Promise<void> {
    const readFn: ReadFn = (name) => state[name];

    switch (step.kind) {
      case 'wait': return void await sleep(step.ms);
      case 'wait_for': {
        const start = nowMs();
        while (nowMs() - start < step.timeoutMs) {
          if (step.fn()) { sink.push('observe', step.name, { ok: true, intent }); return; }
          await sleep(50);
        }
        sink.push('observe', step.name, { ok: false, intent });
        return;
      }
      case 'click': {
        const ok = await dispatcher.click(step.target, script.strategy, step.mode);
        if (step.mark) sink.push('marker', step.mark, { intent });
        if (!ok) sink.push('error', `click:${this.stepName(step)}`, { intent });
        return;
      }
      case 'drag': {
        const ok = await dispatcher.drag(step.from, step.to, step.durationMs, script.strategy);
        if (step.mark) sink.push('marker', step.mark, { intent });
        if (!ok) sink.push('error', 'drag', { intent });
        return;
      }
      case 'type': {
        await dispatcher.type(step.text, !!step.clearFirst, script.strategy);
        if (step.mark) sink.push('marker', step.mark, { intent });
        return;
      }
      case 'key': {
        dispatcher.key(step.key);
        if (step.mark) sink.push('marker', step.mark, { intent });
        return;
      }
      case 'mark': {
        sink.push('marker', step.name, { intent, detail: step.meta });
        return;
      }
      case 'observe': {
        const passed = !!step.fn();
        this.observations.push({ name: step.name, t: sink.relNow(), passed, required: false, intent });
        sink.push('observe', step.name, { ok: passed, intent });
        return;
      }
      case 'read': {
        const v = step.fn();
        state[step.name] = v;
        sink.push('read', step.name, { intent, detail: v });
        return;
      }
      case 'expect': {
        const passed = !!step.fn();
        this.observations.push({ name: step.name, t: sink.relNow(), passed, required: true, intent });
        sink.push('expect', step.name, { ok: passed, intent });
        if (!passed) sink.push('marker', `__EXPECT_FAIL__:${step.name}`, { intent });
        return;
      }
      case 'branch': {
        const taken = step.predicate(readFn);
        await this.executeSteps(taken ? step.thenSteps : step.elseSteps, script,
          sink, dispatcher, state, () => false, () => {});
        return;
      }
      case 'loop': {
        for (let n = 0; n < step.times; n++) {
          await this.executeSteps(step.steps, script, sink, dispatcher, state, () => false, () => {});
        }
        return;
      }
    }
  }

  private stepName(step: StepIR): string {
    switch (step.kind) {
      case 'wait': return step.label ? `wait:${step.label}` : `wait:${step.ms}ms`;
      case 'wait_for': return `wait_for:${step.name}`;
      case 'click': return `click:${typeof step.target === 'string' ? step.target : JSON.stringify(step.target)}`;
      case 'drag': return 'drag';
      case 'type': return `type:${step.text.slice(0, 12)}`;
      case 'key': return `key:${step.key}`;
      case 'mark': return `mark:${step.name}`;
      case 'observe': return `observe:${step.name}`;
      case 'read': return `read:${step.name}`;
      case 'expect': return `expect:${step.name}`;
      case 'branch': return 'branch';
      case 'loop': return `loop:${step.times}`;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function nowMs(): number { return typeof performance !== 'undefined' ? performance.now() : Date.now(); }
