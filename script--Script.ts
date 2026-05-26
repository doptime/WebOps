// script/Script.ts — V5: 只留类型,builder 搬到 Go。
//
// 历史: V4.1 这个文件包含 ScriptBuilder / Script() 工厂 / dispatch macro。
// V5: 业务侧不再用 JS 写 script,改由 Go 端 builder 直接产 JSON IR。
// 这里只剩 SessionRunner / actions / IR 编译器都要用的几个基础类型。

export type Strategy = 'human_like' | 'instant';

/** 步骤的中间表示 (IR),便于后续不同 Runner 实现。 */
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
  /** 失败时是否继续执行下一步(默认 true,让我们能采集"失败之后"的反应)。 */
  continueOnExpectFail: boolean;
  /** 整个 session 的硬超时(ms)。 */
  sessionTimeoutMs: number;
}
