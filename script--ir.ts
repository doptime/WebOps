// script/ir.ts — V5 新增。
// IR (Intermediate Representation): JSON-safe 的脚本表示,由 Go 端 builder 产生,
// 通过 window.WebOps.runInline(scriptJSON, metaJSON) 送进浏览器。
//
// 为什么不直接传 JS 闭包: 闭包不能跨 JSON 边界。Predicate / ValueSource 是
// 一组离散的"算子",每个算子描述一种常见的访问/比较模式 (state_eq, dom_exists,
// state_count_eq...),覆盖 ≥95% 的实测用例。剩余 5% 用 expr 算子直传 JS 代码字符串。
//
// 编译时机: compileIR() 在 runInline() 入口被调用一次,把所有 Predicate / ValueSource
// 提前烘成闭包。运行时 SessionRunner 看到的 CompiledScript 与以前手写 DSL 产物结构完全一致,
// 所以 SessionRunner / actions / report 全部不需要改一行。

import type { CompiledScript, StepIR, TargetSpec, Strategy, ReadFn } from './script--Script';

// ---------- 谓词 (Predicate) — 返回 boolean 的事实判定 ----------

export type Predicate =
  | { op: 'state_eq'; path: string; value: any }
  | { op: 'state_ne'; path: string; value: any }
  | { op: 'state_gt'; path: string; value: number }
  | { op: 'state_ge'; path: string; value: number }
  | { op: 'state_lt'; path: string; value: number }
  | { op: 'state_le'; path: string; value: number }
  | { op: 'state_in'; path: string; values: any[] }
  | { op: 'state_truthy'; path: string }
  | { op: 'state_len_eq'; path: string; value: number }
  | { op: 'state_len_gt'; path: string; value: number }
  | { op: 'state_count_eq'; path: string; key: string; eq: any; count: number }
  | { op: 'state_every_eq'; path: string; key: string; eq: any }
  | { op: 'dom_exists'; selector: string }
  | { op: 'dom_missing'; selector: string }
  | { op: 'all'; preds: Predicate[] }
  | { op: 'any'; preds: Predicate[] }
  | { op: 'not'; pred: Predicate }
  | { op: 'read_eq'; name: string; value: any }       // String(read(name)) === String(value)
  | { op: 'read_mod_eq'; name: string; mod: number; value: number }
  | { op: 'expr'; code: string };                     // 逃生口:JS 表达式,作用域里有 store / read

// ---------- 值源 (ValueSource) — 返回任意值,给 read / dispatch 用 ----------

export type ValueSource =
  | { op: 'state_get'; path: string }
  | { op: 'state_len'; path: string }
  | { op: 'state_count'; path: string; key: string; eq: any }
  | { op: 'state_map'; path: string; key: string }
  | { op: 'expr'; code: string };

// ---------- IR 步骤 (与 StepIR 一一对应,差别是 fn → check/source/when) ----------

export type IRStep =
  | { kind: 'wait'; ms: number; label?: string; intent?: string }
  | { kind: 'wait_for'; name: string; check: Predicate; timeoutMs: number; intent?: string }
  | { kind: 'click'; target: TargetSpec; mark?: string; mode?: 'pointer' | 'native'; intent?: string }
  | { kind: 'drag'; from: TargetSpec; to: TargetSpec; durationMs?: number; mark?: string; intent?: string }
  | { kind: 'type'; text: string; clearFirst?: boolean; mark?: string; intent?: string }
  | { kind: 'key'; key: string; mark?: string; intent?: string }
  | { kind: 'mark'; name: string; meta?: Record<string, any>; intent?: string }
  | { kind: 'observe'; name: string; check: Predicate; intent?: string }
  | { kind: 'read'; name: string; source: ValueSource; intent?: string }
  | { kind: 'expect'; name: string; check: Predicate; intent?: string }
  | { kind: 'branch'; when: Predicate; then: IRStep[]; else?: IRStep[]; intent?: string }
  | { kind: 'loop'; times: number; body: IRStep[]; intent?: string };

export interface InlineScript {
  scenarioId: string;
  strategy: Strategy;
  continueOnExpectFail: boolean;
  sessionTimeoutMs: number;
  steps: IRStep[];
  /** 状态根的 window 全局名 (默认 'useGameStore')。state_* 谓词通过 window[store].getState() 取状态。 */
  store?: string;
}

// ---------- 求值器 ----------

const getPath = (obj: any, path: string): any => {
  if (!path) return obj;
  let cur = obj;
  for (const p of path.split('.')) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
};

const resolveDom = (sel: string): Element | null => {
  const css = (sel.startsWith('[') || sel.startsWith('.') || sel.startsWith('#'))
    ? sel : `[data-vt-id="${sel}"]`;
  return document.querySelector(css);
};

interface EvalCtx {
  state: () => any;
  read: ReadFn;
}

// expr 缓存:同一 code 只编译一次。Function 构造代价不算大但每次循环 step 都重新构造没必要。
const exprCache = new Map<string, Function>();
const runExpr = (code: string, ctx: EvalCtx): any => {
  let fn = exprCache.get(code);
  if (!fn) {
    // eslint-disable-next-line no-new-func
    fn = new Function('store', 'read', `return (${code})`);
    exprCache.set(code, fn);
  }
  return fn(ctx.state(), ctx.read);
};

function evalPred(p: Predicate, ctx: EvalCtx): boolean {
  switch (p.op) {
    case 'state_eq': return getPath(ctx.state(), p.path) === p.value;
    case 'state_ne': return getPath(ctx.state(), p.path) !== p.value;
    case 'state_gt': return (getPath(ctx.state(), p.path) as number) >  p.value;
    case 'state_ge': return (getPath(ctx.state(), p.path) as number) >= p.value;
    case 'state_lt': return (getPath(ctx.state(), p.path) as number) <  p.value;
    case 'state_le': return (getPath(ctx.state(), p.path) as number) <= p.value;
    case 'state_in': return p.values.includes(getPath(ctx.state(), p.path));
    case 'state_truthy': return !!getPath(ctx.state(), p.path);
    case 'state_len_eq': { const v = getPath(ctx.state(), p.path); return Array.isArray(v) && v.length === p.value; }
    case 'state_len_gt': { const v = getPath(ctx.state(), p.path); return Array.isArray(v) && v.length >  p.value; }
    case 'state_count_eq': {
      const arr = getPath(ctx.state(), p.path);
      return Array.isArray(arr) && arr.filter((x: any) => x?.[p.key] === p.eq).length === p.count;
    }
    case 'state_every_eq': {
      const arr = getPath(ctx.state(), p.path);
      return Array.isArray(arr) && arr.every((x: any) => x?.[p.key] === p.eq);
    }
    case 'dom_exists':  return !!resolveDom(p.selector);
    case 'dom_missing': return !resolveDom(p.selector);
    case 'all': return p.preds.every((q) => evalPred(q, ctx));
    case 'any': return p.preds.some((q) => evalPred(q, ctx));
    case 'not': return !evalPred(p.pred, ctx);
    case 'read_eq': return String(ctx.read(p.name)) === String(p.value);
    case 'read_mod_eq': return (Number(ctx.read(p.name)) % p.mod) === p.value;
    case 'expr': return !!runExpr(p.code, ctx);
  }
}

function evalSource(s: ValueSource, ctx: EvalCtx): any {
  switch (s.op) {
    case 'state_get': return getPath(ctx.state(), s.path);
    case 'state_len': { const v = getPath(ctx.state(), s.path); return Array.isArray(v) ? v.length : 0; }
    case 'state_count': {
      const arr = getPath(ctx.state(), s.path);
      return Array.isArray(arr) ? arr.filter((x: any) => x?.[s.key] === s.eq).length : 0;
    }
    case 'state_map': {
      const arr = getPath(ctx.state(), s.path);
      return Array.isArray(arr) ? arr.map((x: any) => x?.[s.key]) : [];
    }
    case 'expr': return runExpr(s.code, ctx);
  }
}

// ---------- 编译入口 ----------

export function compileIR(ir: InlineScript): CompiledScript {
  const storeName = ir.store ?? 'useGameStore';
  const stateGetter = (): any => {
    const w = window as any;
    const s = w[storeName];
    if (!s?.getState) {
      throw new Error(`[webops] window.${storeName}.getState() not found — did you forget to expose the store?`);
    }
    return s.getState();
  };
  // 非 branch 的 step 看不到 ReadFn (SessionRunner 只在 branch.predicate 注入)。
  // 给它们一个空 reader,read_eq / read_mod_eq 用在非 branch 处会拿 undefined → 通常失败,符合预期。
  const baseCtx: EvalCtx = { state: stateGetter, read: () => undefined };

  const compile = (steps: IRStep[]): StepIR[] => steps.map((s): StepIR => {
    switch (s.kind) {
      case 'wait':     return { kind: 'wait', ms: s.ms, label: s.label, intent: s.intent };
      case 'click':    return { kind: 'click', target: s.target, mark: s.mark, mode: s.mode, intent: s.intent };
      case 'drag':     return { kind: 'drag', from: s.from, to: s.to, durationMs: s.durationMs, mark: s.mark, intent: s.intent };
      case 'type':     return { kind: 'type', text: s.text, clearFirst: s.clearFirst, mark: s.mark, intent: s.intent };
      case 'key':      return { kind: 'key', key: s.key, mark: s.mark, intent: s.intent };
      case 'mark':     return { kind: 'mark', name: s.name, meta: s.meta, intent: s.intent };
      case 'wait_for': return { kind: 'wait_for', name: s.name, timeoutMs: s.timeoutMs, intent: s.intent,
                                fn: () => evalPred(s.check, baseCtx) };
      case 'observe':  return { kind: 'observe', name: s.name, required: false, intent: s.intent,
                                fn: () => evalPred(s.check, baseCtx) };
      case 'read':     return { kind: 'read', name: s.name, intent: s.intent,
                                fn: () => evalSource(s.source, baseCtx) };
      case 'expect':   return { kind: 'expect', name: s.name, intent: s.intent,
                                fn: () => evalPred(s.check, baseCtx) };
      case 'branch':   return { kind: 'branch', intent: s.intent,
                                predicate: (read) => evalPred(s.when, { state: stateGetter, read }),
                                thenSteps: compile(s.then),
                                elseSteps: compile(s.else ?? []) };
      case 'loop':     return { kind: 'loop', times: s.times, intent: s.intent, steps: compile(s.body) };
    }
  });

  return {
    scenarioId: ir.scenarioId,
    strategy: ir.strategy,
    continueOnExpectFail: ir.continueOnExpectFail,
    sessionTimeoutMs: ir.sessionTimeoutMs,
    steps: compile(ir.steps),
  };
}
