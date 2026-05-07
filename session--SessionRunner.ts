// session/SessionRunner.ts
// 一体化 Session 执行器 — V4 的单点入口。
//
// V4.1 新增：
//   - ActionRecord 携带 `intent`：从 StepIR 透传，给 LLM 看的语义注解。
//   - maxFrames 上限：避免长跑 session 把 frames 数组堆爆，超过时丢中段保两端。

import { CompiledScript, StepIR, ReadFn } from './script--Script';
import { ActionDispatcher } from './script--actions';
import { VirtualChannel } from './core--virtual-channel';
import { DOMTelemetry, DOMSnapshot } from './core--dom-telemetry';
import { AudioTelemetry } from './core--audio-telemetry';
import { R3FBridge } from './core--r3f-bridge';
import { AggregatedMetric } from './core--kline';

export interface TelemetryFrame {
  ts: number;
  dur: number;
  sources: ('dom' | 'virtual' | 'audio' | 'r3f')[];
  domNodes: DOMSnapshot['nodes'];
  virtual: Record<string, Record<string, AggregatedMetric>>;
}

export interface ActionRecord {
  index: number;
  kind: StepIR['kind'];
  name: string;
  startTs: number;
  endTs: number;
  ok: boolean;
  /** 自然语言解释这一步在做什么 / 期望什么反应（来自 StepIR.intent）。 */
  intent?: string;
  // 对 observe / expect / read 步骤而言，记录其结果
  result?: any;
  // 对 click / drag 等而言，记录目标坐标
  meta?: Record<string, any>;
  error?: string;
}

export interface SessionReport {
  scenarioId: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  url: string;
  frames: TelemetryFrame[];
  actions: ActionRecord[];
  /** 显式打的 markers（不含 __SCENARIO_*__）。 */
  markers: { name: string; ts: number; meta?: Record<string, any> }[];
  /** read() 收集的最终值（便于 LLM 看上下文）。 */
  reads: Record<string, any>;
  /** observe() 与 expect() 的总览。 */
  observations: { name: string; ts: number; passed: boolean; required: boolean }[];
  errors: string[];
  /** 是否因为 expect 失败而中止。 */
  abortedAt?: number;
  /** 是否因为 frame buffer 上限触发了截断（信息字段，便于 LLM 判断信号是否完整）。 */
  framesTruncated?: boolean;
}

export interface RunnerOptions {
  flushIntervalMs?: number;
  enableAudio?: boolean;
  enableR3F?: boolean;
  /** Frame 缓冲上限。超过时丢中段、保两端，避免长跑 session 让 LLMPayload 爆炸。 */
  maxFrames?: number;
}

export class SessionRunner {
  private vc: VirtualChannel;
  private dom: DOMTelemetry;
  private audio: AudioTelemetry;
  private r3f: R3FBridge;
  private actions: ActionDispatcher;
  private rafId: number | null = null;
  private active = false;
  private flushIntervalMs: number;
  private enableAudio: boolean;
  private enableR3F: boolean;
  private maxFrames: number;

  constructor(opts: RunnerOptions = {}) {
    this.flushIntervalMs = opts.flushIntervalMs ?? 100;
    this.enableAudio = opts.enableAudio ?? true;
    this.enableR3F = opts.enableR3F ?? true;
    this.maxFrames = opts.maxFrames ?? 800;
    this.vc = new VirtualChannel();
    this.dom = new DOMTelemetry(this.vc);
    this.audio = new AudioTelemetry(this.vc);
    this.r3f = new R3FBridge(this.vc);
    this.actions = new ActionDispatcher(this.vc);
  }

  /** 从 SessionRunner 外部直接打 marker（适合在业务回调里用）。 */
  mark(name: string, meta?: Record<string, any>): void {
    this.vc.pushMetric('__markers__', name, performance.now());
    if (meta) {
      // 把 meta 里的数值字段也挂到 vc 上 — 让 LLM 在帧里能看到上下文
      for (const [k, v] of Object.entries(meta)) {
        if (typeof v === 'number') this.vc.pushMetric('__markers__', `${name}:${k}`, v);
      }
    }
    this.markersMeta.push({ name, ts: performance.now(), meta });
  }

  /** 主入口 —— 跑完返回完整 Report。 */
  async runSession(script: CompiledScript): Promise<SessionReport> {
    const startTs = performance.now();
    const startUrl = typeof window !== 'undefined' ? window.location.href : '';
    this.frames = [];
    this.actionRecords = [];
    this.observations = [];
    this.reads = {};
    this.markersMeta = [];
    this.errors = [];
    this.framesTruncated = false;

    // 1. 启动所有探针
    this.dom.start();
    if (this.enableAudio) this.audio.start();
    this.startTickLoop();
    this.active = true;
    this.vc.pushMetric('__markers__', '__SCENARIO_START__', startTs);
    this.markersMeta.push({ name: '__SCENARIO_START__', ts: startTs });

    // 2. 设置硬超时
    const deadline = startTs + script.sessionTimeoutMs;
    const isTimedOut = () => performance.now() > deadline;

    let abortedAt: number | undefined;
    try {
      await this.executeSteps(script.steps, script, isTimedOut, () => abortedAt !== undefined,
        (idx) => { abortedAt = idx; });
    } catch (e) {
      this.errors.push(`Top-level: ${String(e)}`);
    }

    // 3. 给最后的动画/音效落地时间
    await new Promise((r) => setTimeout(r, 600));

    const endTs = performance.now();
    this.vc.pushMetric('__markers__', '__SCENARIO_END__', endTs);
    this.markersMeta.push({ name: '__SCENARIO_END__', ts: endTs });

    // 4. 最后再 flush 一次，捕获扫尾的动画和音效。
    this.tickOnce(true);

    // 5. 关停
    this.active = false;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.dom.stop();
    if (this.enableAudio) this.audio.stop();

    return {
      scenarioId: script.scenarioId,
      startTs, endTs,
      durationMs: endTs - startTs,
      url: startUrl,
      frames: this.frames,
      actions: this.actionRecords,
      markers: this.markersMeta.filter((m) => !m.name.startsWith('__SCENARIO_')),
      reads: { ...this.reads },
      observations: this.observations,
      errors: this.errors,
      abortedAt,
      framesTruncated: this.framesTruncated
    };
  }

  // ---------- internals ----------

  private frames: TelemetryFrame[] = [];
  private actionRecords: ActionRecord[] = [];
  private observations: SessionReport['observations'] = [];
  private reads: Record<string, any> = {};
  private markersMeta: SessionReport['markers'] = [];
  private errors: string[] = [];
  private lastFlushTs = 0;
  private framesTruncated = false;

  private async executeSteps(
    steps: StepIR[],
    script: CompiledScript,
    isTimedOut: () => boolean,
    isAborted: () => boolean,
    setAborted: (idx: number) => void
  ): Promise<void> {
    for (let i = 0; i < steps.length; i++) {
      if (isAborted() || isTimedOut()) return;
      const step = steps[i];
      const startTs = performance.now();
      // intent 字段在所有 StepIR variant 上都是可选,这里统一透传
      const stepIntent = (step as { intent?: string }).intent;
      let record: ActionRecord = {
        index: i,
        kind: step.kind,
        name: this.stepName(step),
        startTs,
        endTs: startTs,
        ok: true,
        intent: stepIntent
      };
      try {
        await this.executeOne(step, script, record);
      } catch (e) {
        record.ok = false;
        record.error = String(e);
        this.errors.push(`Step ${i} (${step.kind}): ${e}`);
      }
      record.endTs = performance.now();
      this.actionRecords.push(record);

      // expect 失败 + 不允许继续 → 中止
      if (step.kind === 'expect' && !record.ok && !script.continueOnExpectFail) {
        setAborted(i);
        this.vc.pushMetric('__markers__', '__SCENARIO_ABORT__', performance.now());
        this.markersMeta.push({ name: '__SCENARIO_ABORT__', ts: performance.now(), meta: { stepIndex: i } });
        return;
      }
    }
  }

  private async executeOne(step: StepIR, script: CompiledScript, rec: ActionRecord): Promise<void> {
    const readFn: ReadFn = (name) => this.reads[name];

    switch (step.kind) {
      case 'wait': {
        await sleep(step.ms);
        return;
      }
      case 'wait_for': {
        const start = performance.now();
        while (performance.now() - start < step.timeoutMs) {
          if (step.fn()) {
            rec.result = true;
            return;
          }
          await sleep(50);
        }
        rec.ok = false;
        rec.result = false;
        return;
      }
      case 'click': {
        const ok = await this.actions.click(step.target, script.strategy, step.mode);
        if (step.mark) this.pushMarker(step.mark, { kind: 'click' });
        rec.ok = ok;
        rec.meta = { target: step.target };
        return;
      }
      case 'drag': {
        const ok = await this.actions.drag(step.from, step.to, step.durationMs, script.strategy);
        if (step.mark) this.pushMarker(step.mark, { kind: 'drag' });
        rec.ok = ok;
        rec.meta = { from: step.from, to: step.to };
        return;
      }
      case 'type': {
        const ok = await this.actions.type(step.text, !!step.clearFirst, script.strategy);
        if (step.mark) this.pushMarker(step.mark, { kind: 'type', length: step.text.length });
        rec.ok = ok;
        return;
      }
      case 'key': {
        const ok = this.actions.key(step.key);
        if (step.mark) this.pushMarker(step.mark, { kind: 'key', key: step.key });
        rec.ok = ok;
        rec.meta = { key: step.key };
        return;
      }
      case 'mark': {
        this.pushMarker(step.name, step.meta);
        return;
      }
      case 'observe': {
        const passed = !!step.fn();
        rec.ok = true; // observe 不影响 flow
        rec.result = passed;
        this.observations.push({ name: step.name, ts: performance.now(), passed, required: false });
        return;
      }
      case 'read': {
        const v = step.fn();
        this.reads[step.name] = v;
        rec.result = v;
        return;
      }
      case 'expect': {
        const passed = !!step.fn();
        rec.ok = passed;
        rec.result = passed;
        this.observations.push({ name: step.name, ts: performance.now(), passed, required: true });
        if (!passed) {
          this.pushMarker(`__EXPECT_FAIL__:${step.name}`);
        }
        return;
      }
      case 'branch': {
        const taken = step.predicate(readFn);
        const branch = taken ? step.thenSteps : step.elseSteps;
        rec.meta = { taken: taken ? 'then' : 'else', size: branch.length };
        await this.executeSteps(
          branch, script,
          () => false, () => false, () => {}
        );
        return;
      }
      case 'loop': {
        for (let n = 0; n < step.times; n++) {
          await this.executeSteps(step.steps, script, () => false, () => false, () => {});
        }
        rec.meta = { iterations: step.times };
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

  private pushMarker(name: string, meta?: Record<string, any>): void {
    const ts = performance.now();
    this.vc.pushMetric('__markers__', name, ts);
    this.markersMeta.push({ name, ts, meta });
  }

  private startTickLoop(): void {
    this.lastFlushTs = performance.now();
    const tick = () => {
      if (!this.active) return;
      this.tickOnce(false);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private tickOnce(force: boolean): void {
    this.dom.sample();
    if (this.enableAudio) this.audio.sample();
    if (this.enableR3F) this.r3f.sample();

    const now = performance.now();
    if (force || now - this.lastFlushTs >= this.flushIntervalMs) {
      this.flushFrame(now);
      this.lastFlushTs = now;
    }
  }

  private flushFrame(ts: number): void {
    if (this.enableAudio) this.audio.flush();
    const domSnap = this.dom.harvest();
    const vData = this.vc.harvest();

    const sources: TelemetryFrame['sources'] = [];
    if (Object.keys(domSnap.nodes).length > 0) sources.push('dom');
    if (Object.keys(vData).length > 0) sources.push('virtual');
    // audio 和 r3f 已通过 vc 汇入 virtual

    if (sources.length === 0) return;

    this.frames.push({
      ts: Math.floor(ts),
      dur: this.flushIntervalMs,
      sources,
      domNodes: domSnap.nodes,
      virtual: vData
    });

    // 防爆：超过 maxFrames 后做"丢中段保两端"，确保 LLMPayload 不会无界增长。
    // 保留前半 60% + 后半 40% 是经验比例 —— 起始通常含 setup 信号，结尾含 victory/gameover 信号，
    // 中段是稳态循环，丢一些不影响 LLM 推断。
    if (this.frames.length > this.maxFrames) {
      const head = Math.floor(this.maxFrames * 0.6);
      const tail = this.maxFrames - head;
      this.frames = [
        ...this.frames.slice(0, head),
        ...this.frames.slice(this.frames.length - tail)
      ];
      this.framesTruncated = true;
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
