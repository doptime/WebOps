// script/Script.ts
// Script DSL — 一体化的"动作 + 观测 + 断言"编排。
//
// V4.1 新增：
//   - 每个动作步骤可带 `intent` 字段：自然语言一句话，说明这一步在做什么、期望什么反应。
//     analyzer 不消费 intent，它只给 LLM 看，让 timeline 上每条动作旁带语义注解。
//   - dispatch(reader, cases) macro：消除"读一个值 → branch×N"的高频臃肿模式。
//     在 builder 层 desugar 为 `read + branch+branch+...`，IR 层不变。
//
// 用法（链式）：
//   Script('classify_acute_card')
//     .strategy('human_like')
//     .wait(2000)
//     .observe('first_card_visible', () => document.querySelector('[data-vt-id="card_focus"]') !== null)
//     .dispatch(
//       () => useGameStore.getState().focusedAngleCode,
//       {
//         1: (b) => b.key('a', { mark: 'CLICK_ACUTE', intent: '焦点是锐角，按 a 应当 +100 分' }),
//         2: (b) => b.key('s', { mark: 'CLICK_RIGHT', intent: '焦点是直角，按 s 应当 +100 分' }),
//         3: (b) => b.key('d', { mark: 'CLICK_OBTUSE', intent: '焦点是钝角，按 d 应当 +100 分' }),
//       },
//       { name: 'angle_type' }
//     )
//     .wait(800)
//     .expect('score_increased', () => useGameStore.getState().score > 0)
//     .build();

export type Strategy = 'human_like' | 'instant';

/** 步骤的中间表示 (IR)，便于后续不同 Runner 实现。 */
export type StepIR =
  | { kind: 'wait'; ms: number; label?: string; intent?: string }
  | { kind: 'click'; target: TargetSpec; mark?: string; mode?: 'pointer' | 'native'; intent?: string }
  | { kind: 'drag';  from: TargetSpec; to: TargetSpec; durationMs?: number; mark?: string; intent?: string }
  | { kind: 'type';  text: string; clearFirst?: boolean; mark?: string; intent?: string }
  | { kind: 'key';   key: string; mark?: string; intent?: string }
  | { kind: 'mark';  name: string; meta?: Record<string, any>; intent?: string }
  | { kind: 'observe'; name: string; fn: () => boolean; required?: boolean; intent?: string }
  | { kind: 'read';    name: string; fn: () => any; intent?: string }
  | { kind: 'expect';  name: string; fn: () => boolean; intent?: string }
  | { kind: 'branch'; predicate: (read: ReadFn) => boolean; thenSteps: StepIR[]; elseSteps: StepIR[]; intent?: string }
  | { kind: 'loop';   times: number; steps: StepIR[]; intent?: string }
  | { kind: 'wait_for'; name: string; fn: () => boolean; timeoutMs: number; intent?: string };

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
  click(target: TargetSpec, opts: { mark?: string; mode?: 'pointer' | 'native'; intent?: string } = {}): this {
    this.steps.push({ kind: 'click', target, mark: opts.mark, mode: opts.mode, intent: opts.intent });
    return this;
  }

  /** 拖拽（用于 R3F/Rapier 物理交互）。 */
  drag(from: TargetSpec, to: TargetSpec, opts: { durationMs?: number; mark?: string; intent?: string } = {}): this {
    this.steps.push({ kind: 'drag', from, to, durationMs: opts.durationMs, mark: opts.mark, intent: opts.intent });
    return this;
  }

  type(text: string, opts: { clearFirst?: boolean; mark?: string; intent?: string } = {}): this {
    this.steps.push({ kind: 'type', text, clearFirst: opts.clearFirst, mark: opts.mark, intent: opts.intent });
    return this;
  }

  /** 模拟按键 — 适合本游戏的 'a'/'s'/'d' 三键玩法。 */
  key(key: string, opts: { mark?: string; intent?: string } = {}): this {
    this.steps.push({ kind: 'key', key, mark: opts.mark, intent: opts.intent });
    return this;
  }

  /** 仅打因果标记，不做动作。 */
  mark(name: string, meta?: Record<string, any>, intent?: string): this {
    this.steps.push({ kind: 'mark', name, meta, intent });
    return this;
  }

  /** 观测一个布尔事实（不中止执行，只记录）。 */
  observe(name: string, fn: () => boolean): this {
    this.steps.push({ kind: 'observe', name, fn, required: false });
    return this;
  }

  /** 读取一个值（任意类型）—— 后续 branch / dispatch / read 可以用。 */
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

  /**
   * dispatch — 读一个值，按值走对应分支。
   *
   * 等价于 `.read(name, reader).branch(...).branch(...).branch(...)`，但 1 行写完。
   *
   * 注意：cases 的 key 是字符串（JS 对象 key 永远是字符串），但 reader 返回 number 也 OK——
   * 内部用 String() 强制转换两端做相等比较，这覆盖了 number/string/boolean 的常见值。
   *
   * @param reader  返回当前要分发的值的函数
   * @param cases   值 → 子构建器 的映射；不在 cases 里的值会"什么都不做"继续往下
   * @param opts.name  生成的 read 步骤名（默认 `_dispatch_<index>`），便于之后用 read('name') 回读
   */
  dispatch<V extends string | number | boolean>(
    reader: () => V,
    cases: Partial<Record<string, (s: ScriptBuilder) => ScriptBuilder>>,
    opts: { name?: string } = {}
  ): this {
    const name = opts.name ?? `_dispatch_${this.steps.length}`;
    this.steps.push({ kind: 'read', name, fn: reader });
    for (const key of Object.keys(cases)) {
      const branchFn = cases[key];
      if (!branchFn) continue;
      const inner = new ScriptBuilder(this.scenarioId);
      branchFn(inner);
      this.steps.push({
        kind: 'branch',
        predicate: (read) => String(read(name)) === key,
        thenSteps: inner.steps,
        elseSteps: []
      });
    }
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
