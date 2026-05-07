// script/Script.ts
// Script DSL — 一体化的"动作 + 观测 + 断言"编排。
//
// 核心理念：
//   V3 的 ATP 协议是纯动作 JSON（offset_ms + action）。
//   V4 的 Script 让每个 step 既能"做动作"，又能"看结果"，并能在结果不符合预期时立即中止。
//
// 用法（链式）：
//   Script('classify_acute_card')
//     .strategy('human_like')
//     .wait(2000)
//     .observe('first_card_visible', () => document.querySelector('[data-vt-id="card_focus"]') !== null)
//     .read('current_angle_type', () => useGameStore.getState().cards[0]?.type)
//     .branch(
//       (read) => read('current_angle_type') === 'acute',
//       (s) => s.click('[data-vt-id="btn_acute"]', { mark: 'CLICK_CORRECT' }),
//       (s) => s.click('[data-vt-id="btn_obtuse"]', { mark: 'CLICK_WRONG' })
//     )
//     .wait(800)
//     .expect('score_increased', () => useGameStore.getState().score > 0)
//     .build();

export type Strategy = 'human_like' | 'instant';

/** 步骤的中间表示 (IR)，便于后续不同 Runner 实现。 */
export type StepIR =
  | { kind: 'wait'; ms: number; label?: string }
  | { kind: 'click'; target: TargetSpec; mark?: string; mode?: 'pointer' | 'native' }
  | { kind: 'drag';  from: TargetSpec; to: TargetSpec; durationMs?: number; mark?: string }
  | { kind: 'type';  text: string; clearFirst?: boolean; mark?: string }
  | { kind: 'key';   key: string; mark?: string }
  | { kind: 'mark';  name: string; meta?: Record<string, any> }
  | { kind: 'observe'; name: string; fn: () => boolean; required?: boolean }
  | { kind: 'read';    name: string; fn: () => any }
  | { kind: 'expect';  name: string; fn: () => boolean }
  | { kind: 'branch'; predicate: (read: ReadFn) => boolean; thenSteps: StepIR[]; elseSteps: StepIR[] }
  | { kind: 'loop';   times: number; steps: StepIR[] }
  | { kind: 'wait_for'; name: string; fn: () => boolean; timeoutMs: number };

export type TargetSpec =
  | string                                        // CSS 选择器或 vt-id
  | { x: number; y: number }                      // 绝对坐标
  | { vtId: string }                              // 显式 vt-id
  | { selector: string };                         // 显式选择器

export type ReadFn = (name: string) => any;

export interface CompiledScript {
  scenarioId: string;
  strategy: Strategy;
  steps: StepIR[];
  /** 失败时是否继续执行下一步（默认 true，让我们能采集"失败之后"的反应）。 */
  continueOnExpectFail: boolean;
  /** 整个 session 的硬超时（ms）。 */
  sessionTimeoutMs: number;
}

class ScriptBuilder {
  private steps: StepIR[] = [];
  private _strategy: Strategy = 'human_like';
  private _continueOnExpectFail = true;
  private _sessionTimeoutMs = 60_000;

  constructor(private scenarioId: string) {}

  strategy(s: Strategy): this { this._strategy = s; return this; }
  continueOnExpectFail(b: boolean): this { this._continueOnExpectFail = b; return this; }
  timeout(ms: number): this { this._sessionTimeoutMs = ms; return this; }

  /** 等待固定时间。 */
  wait(ms: number, label?: string): this {
    this.steps.push({ kind: 'wait', ms, label });
    return this;
  }

  /** 等待直到条件成立或超时。 */
  waitFor(name: string, fn: () => boolean, timeoutMs = 5000): this {
    this.steps.push({ kind: 'wait_for', name, fn, timeoutMs });
    return this;
  }

  /** 单击。target 可以是 vt-id、选择器或绝对坐标。 */
  click(target: TargetSpec, opts: { mark?: string; mode?: 'pointer' | 'native' } = {}): this {
    this.steps.push({ kind: 'click', target, mark: opts.mark, mode: opts.mode });
    return this;
  }

  /** 拖拽（用于 R3F/Rapier 物理交互）。 */
  drag(from: TargetSpec, to: TargetSpec, opts: { durationMs?: number; mark?: string } = {}): this {
    this.steps.push({ kind: 'drag', from, to, durationMs: opts.durationMs, mark: opts.mark });
    return this;
  }

  type(text: string, opts: { clearFirst?: boolean; mark?: string } = {}): this {
    this.steps.push({ kind: 'type', text, clearFirst: opts.clearFirst, mark: opts.mark });
    return this;
  }

  /** 模拟按键 — 适合本游戏的 'a'/'s'/'d' 三键玩法。 */
  key(key: string, opts: { mark?: string } = {}): this {
    this.steps.push({ kind: 'key', key, mark: opts.mark });
    return this;
  }

  /** 仅打因果标记，不做动作。 */
  mark(name: string, meta?: Record<string, any>): this {
    this.steps.push({ kind: 'mark', name, meta });
    return this;
  }

  /** 观测一个布尔事实（不中止执行，只记录）。 */
  observe(name: string, fn: () => boolean): this {
    this.steps.push({ kind: 'observe', name, fn, required: false });
    return this;
  }

  /** 读取一个值（任意类型）—— 后续 branch / read 可以用。 */
  read(name: string, fn: () => any): this {
    this.steps.push({ kind: 'read', name, fn });
    return this;
  }

  /** 断言 —— 失败会按 continueOnExpectFail 设置决定是否中止。 */
  expect(name: string, fn: () => boolean): this {
    this.steps.push({ kind: 'expect', name, fn });
    return this;
  }

  /** 条件分支 — 根据已 read 的值决定走哪边。 */
  branch(
    predicate: (read: ReadFn) => boolean,
    thenFn: (s: ScriptBuilder) => ScriptBuilder,
    elseFn?: (s: ScriptBuilder) => ScriptBuilder
  ): this {
    const thenBuilder = new ScriptBuilder(this.scenarioId);
    thenFn(thenBuilder);
    const elseBuilder = new ScriptBuilder(this.scenarioId);
    if (elseFn) elseFn(elseBuilder);
    this.steps.push({
      kind: 'branch',
      predicate,
      thenSteps: thenBuilder.steps,
      elseSteps: elseBuilder.steps
    });
    return this;
  }

  /** 循环 — 适合"玩 N 张牌" 这种重复动作。 */
  loop(times: number, body: (s: ScriptBuilder) => ScriptBuilder): this {
    const inner = new ScriptBuilder(this.scenarioId);
    body(inner);
    this.steps.push({ kind: 'loop', times, steps: inner.steps });
    return this;
  }

  build(): CompiledScript {
    return {
      scenarioId: this.scenarioId,
      strategy: this._strategy,
      steps: this.steps,
      continueOnExpectFail: this._continueOnExpectFail,
      sessionTimeoutMs: this._sessionTimeoutMs
    };
  }
}

/** 工厂函数 —— 用 const s = Script('my_test') 起步。 */
export function Script(scenarioId: string): ScriptBuilder {
  return new ScriptBuilder(scenarioId);
}

export type { ScriptBuilder };
