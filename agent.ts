// agent.ts
// V4 + V5.1 双协议 Agent 入口 — 暴露 window.WebOps 给 Go 后端 / chromedp。
//
// V4 协议(原样保留,向后兼容):
//   - webops.register('scenarioId', { build, hypothesis, intent, tags })
//   - window.WebOps.run(scenarioId) → JSON LLMPayload(走 V4 SessionRunner)
//   - window.WebOps.describe() → { gameIntent, scenarios[] }
//
// V5.1 协议(脚本即源码,无 IR):
//   - window.WebOps.runScript(source, ctx) → JSON V5Payload
//   - source 是 JS 代码体;agent 用 AsyncFunction 包一层,把 webops 助手注入作用域
//   - 脚本里调 webops.wait/waitFor/observe/expect/read/click/drag/key/state/dom/abort 来驱动 + 采集
//   - 不再有 IR、不再有 walker。所有判断逻辑都是 native JS。

import { runSession, RunOptions } from './index';
import { Script as ScriptFactory, CompiledScript, TargetSpec } from './script--Script';
import type { LLMPayload } from './report--ReportBuilder';
import { ActionDispatcher } from './script--actions';
import { VirtualChannel } from './core--virtual-channel';

// ============================================================================
// V4 — 注册表与 LLMPayload(原样保留)
// ============================================================================

export interface RegisteredScenario {
  /** 工厂函数,每次 run 都重新构造一遍,避免跨 run 的 IR 共享。 */
  build: () => CompiledScript;
  /** 该剧本期望看到什么(测试断言层面的描述,会进 LLMPayload.hypothesis)。 */
  hypothesis: string;
  /** 该剧本在审计什么设计意图(目的层面的描述,与 hypothesis 互补)。 */
  intent?: string;
  /** 标签,便于按类型筛选: 'happy-path' / 'failure-path' / 'stress' / 'regression' 等。 */
  tags?: string[];
  /** 默认 run 参数。可被 run() 时的 override 覆盖。 */
  options?: RunOptions;
}

/** Go 一次握手就能拿到的全部上下文。 */
export interface AgentDescription {
  gameIntent?: string;
  scenarios: Array<{
    id: string;
    hypothesis: string;
    intent?: string;
    tags?: string[];
  }>;
}

// ============================================================================
// V5.1 — Payload 形态(由 webops 助手累积)
// ============================================================================

interface V5ScenarioCtx {
  scenarioId: string;
  intent?: string;
  hypothesis?: string;
  tags?: string[];
}

interface V5Observation {
  name: string;
  passed: boolean;
  ts: number;
  kind: 'observe' | 'expect' | 'wait_for';
  intent?: string;
  mark?: string;
}

interface V5ActionRecord {
  index: number;
  op: 'click' | 'drag' | 'key' | 'wait' | 'wait_for';
  startTs: number;
  endTs: number;
  ok: boolean;
  target?: string;
  source?: string;
  key?: string;
  mark?: string;
  intent?: string;
  error?: string;
}

interface V5Payload {
  scenarioId: string;
  intent?: string;
  hypothesis?: string;
  tags?: string[];
  startedAt: number;
  durationMs: number;
  finalStore: any;
  reads: Record<string, any>;
  observations: V5Observation[];
  actions: V5ActionRecord[];
  errors: string[];
  aborted?: string;
}

// ============================================================================
// Agent
// ============================================================================

class WebOpsAgent {
  private registry = new Map<string, RegisteredScenario>();
  private gameIntent: string | undefined;

  /** [V4] 注册一个剧本(脚本工厂 + 假设 + 可选意图/标签)。 */
  register(scenarioId: string, entry: RegisteredScenario): void {
    this.registry.set(scenarioId, entry);
  }

  /** [V4/V5] 设置整个游戏页面的设计意图,所有 scenario 共享。 */
  setGameIntent(intent: string): void {
    this.gameIntent = intent;
  }

  /** [V4] 查询当前已注册的剧本名(简单调试用)。 */
  list(): string[] {
    return Array.from(this.registry.keys());
  }

  /** [V4] 自描述协议: Go 后端一次握手拿到全部调度信息。 */
  describe(): AgentDescription {
    const scenarios = Array.from(this.registry.entries()).map(([id, e]) => ({
      id,
      hypothesis: e.hypothesis,
      intent: e.intent,
      tags: e.tags
    }));
    return { gameIntent: this.gameIntent, scenarios };
  }

  /** [V4] 跑一个已注册剧本,返回完整 LLMPayload(JSON 序列化串)。 */
  async run(scenarioId: string, override?: Partial<RunOptions>): Promise<string> {
    const entry = this.registry.get(scenarioId);
    if (!entry) {
      const err = { error: 'SCENARIO_NOT_FOUND', scenarioId, available: this.list() };
      return JSON.stringify(err);
    }
    try {
      const script = entry.build();
      const payload: LLMPayload = await runSession(script, {
        hypothesis: entry.hypothesis,
        intent: entry.intent,
        tags: entry.tags,
        ...entry.options,
        ...override
      });
      return JSON.stringify(payload);
    } catch (e) {
      return JSON.stringify({
        error: 'SESSION_FAILED',
        scenarioId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined
      });
    }
  }

  /**
   * [V5.1] 直接执行从 Go 灌进来的 JS 脚本源码。
   *
   * source 是脚本代码体(顶层支持 await),会被 AsyncFunction 包成
   *   async function(webops) { // source }
   * 然后用 webops 助手实例调用一次。
   *
   * ctx = { scenarioId, intent, hypothesis, tags } —— 透传给 payload 元字段。
   *
   * 返回 JSON 字符串(V5Payload),Go 端原样塞进 ScenarioResult.Payload。
   */
  async runScript(source: string, ctx: V5ScenarioCtx): Promise<string> {
    if (typeof source !== 'string' || source.length === 0) {
      return JSON.stringify({ error: 'EMPTY_SCRIPT', scenarioId: ctx?.scenarioId });
    }
    try {
      const payload = await runV5Script(source, ctx);
      return JSON.stringify(payload);
    } catch (e) {
      return JSON.stringify({
        error: 'RUN_SCRIPT_FAILED',
        scenarioId: ctx?.scenarioId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? e.stack : undefined,
      });
    }
  }

  /** 暴露原始构造器给业务代码(V4 路径用) */
  Script = ScriptFactory;
}

declare global {
  interface Window {
    WebOps?: WebOpsAgent;
    useGameStore?: { getState: () => any };
  }
}

/**
 * webops 单例。
 *
 * **重要**: 这个模块应该被 Bootstrap **动态 import**,而不是静态 import。
 * 静态 import 会让 SessionRunner / ReportBuilder / 6 个 core 探针进入生产 bundle,
 * 即使生产用户永远不审计也要下载 25-30KB(gzipped)。
 *
 * 正确姿势:
 *   import { shouldEnableWebOps } from '@/webops/runtime';  // 静态,轻量
 *   useEffect(() => {
 *     if (!shouldEnableWebOps()) return;
 *     (async () => {
 *       const { webops } = await import('@/webops');         // 动态,重量
 *       webops.register('perfect-player', { ... });          // V4 注册式(可选)
 *       // V5.1 模式不需要预注册:Go 端直接灌脚本源码
 *     })();
 *   }, []);
 */
export const webops = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as any;
  if (!g.WebOps) g.WebOps = new WebOpsAgent();
  return g.WebOps as WebOpsAgent;
})();

export { runSession } from './index';
export { Script as ScriptFactory } from './script--Script';
export type { LLMPayload } from './report--ReportBuilder';

// ============================================================================
// V5.1 解释器 — runScript + webops 助手
// ============================================================================

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// 在外部预捕获,避免 `async function(){}` 在 strict-mode 模块顶层求值的兼容性问题。
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...args: any[]) => Promise<any>;

/**
 * 助手对象的形状 —— 与脚本作者直接接触的 API。
 *
 * 设计取舍:
 *   - 同步记录类(observe / expect / read)不返回 Promise,脚本写起来更扁平。
 *   - 动作类(click / drag / wait / waitFor)返回 Promise,脚本必须 await。
 *   - state() 返回当前 store 快照,**调用时**取,不缓存,以应对脚本里反复读取。
 *   - dom(sel) 接受裸 vt-id 字符串("game-root")或显式 CSS("[data-id=foo]" / ".cls" / "#id"),
 *     裸名会自动包成 [data-vt-id="xxx"]。
 */
interface ScriptWebops {
  wait(ms: number): Promise<void>;
  waitFor(
    name: string,
    predicate: () => boolean,
    timeoutMs?: number,
    opts?: { intent?: string }
  ): Promise<boolean>;
  state(): any;
  dom(selector: string): Element | null;
  observe(name: string, passed: boolean, opts?: { intent?: string; mark?: string }): void;
  expect(name: string, passed: boolean, opts?: { intent?: string; mark?: string }): void;
  read(name: string, value: any): void;
  click(target: string, opts?: ClickOpts): Promise<boolean>;
  drag(from: string, to: string, opts?: DragOpts): Promise<boolean>;
  key(key: string, opts?: { mark?: string; intent?: string }): boolean;
  abort(reason: string): void;
  readonly ctx: V5ScenarioCtx;
}

interface ClickOpts {
  mark?: string;
  intent?: string;
  duration?: number;
  mode?: 'pointer' | 'native';
}
interface DragOpts {
  mark?: string;
  intent?: string;
  duration?: number;
}

async function runV5Script(source: string, scenarioCtx: V5ScenarioCtx): Promise<V5Payload> {
  const payload: V5Payload = {
    scenarioId: scenarioCtx.scenarioId,
    intent: scenarioCtx.intent,
    hypothesis: scenarioCtx.hypothesis,
    tags: scenarioCtx.tags,
    startedAt: performance.now(),
    durationMs: 0,
    finalStore: null,
    reads: {},
    observations: [],
    actions: [],
    errors: [],
  };

  const vc = new VirtualChannel();
  const dispatcher = new ActionDispatcher(vc);

  let aborted: string | null = null;
  let actionIdx = 0;

  function selectorFor(target: string): TargetSpec {
    if (typeof target !== 'string') return target as TargetSpec;
    // 显式 CSS:[xxx] / .xxx / #xxx → 原样;否则当 vt-id
    if (target.startsWith('[') || target.startsWith('.') || target.startsWith('#')) {
      return target;
    }
    return { vtId: target };
  }

  const helper: ScriptWebops = {
    ctx: scenarioCtx,

    state() {
      if (typeof window === 'undefined') return null;
      const s = window.useGameStore;
      if (!s || typeof s.getState !== 'function') return null;
      try { return s.getState(); } catch { return null; }
    },

    dom(selector: string): Element | null {
      if (!selector) return null;
      const full = (selector.startsWith('[') || selector.startsWith('.') || selector.startsWith('#'))
        ? selector
        : `[data-vt-id="${selector}"]`;
      return document.querySelector(full);
    },

    async wait(ms: number): Promise<void> {
      const i = actionIdx++;
      const t0 = performance.now();
      await sleep(ms);
      payload.actions.push({
        index: i, op: 'wait', startTs: t0, endTs: performance.now(), ok: true,
      });
    },

    async waitFor(name, predicate, timeoutMs = 5000, opts) {
      const i = actionIdx++;
      const t0 = performance.now();
      const deadline = t0 + timeoutMs;
      let passed = false;
      try {
        if (predicate()) {
          passed = true;
        } else {
          while (performance.now() < deadline) {
            await sleep(50);
            if (predicate()) { passed = true; break; }
          }
        }
      } catch (e) {
        payload.errors.push(`waitFor[${name}] predicate threw: ${e instanceof Error ? e.message : String(e)}`);
        passed = false;
      }
      const t1 = performance.now();
      payload.actions.push({
        index: i, op: 'wait_for', startTs: t0, endTs: t1, ok: passed,
        intent: opts?.intent, error: passed ? undefined : `timeout after ${timeoutMs}ms`,
      });
      payload.observations.push({
        name, passed, ts: t1, kind: 'wait_for', intent: opts?.intent,
      });
      return passed;
    },

    observe(name, passed, opts) {
      payload.observations.push({
        name, passed, ts: performance.now(), kind: 'observe',
        intent: opts?.intent, mark: opts?.mark,
      });
    },

    expect(name, passed, opts) {
      payload.observations.push({
        name, passed, ts: performance.now(), kind: 'expect',
        intent: opts?.intent, mark: opts?.mark,
      });
      // 不主动 abort —— 脚本想停就显式 webops.abort(...)。失败累计在 observations 里供 LLM 判决。
    },

    read(name, value) {
      payload.reads[name] = value;
    },

    async click(target, opts) {
      const i = actionIdx++;
      const t0 = performance.now();
      let ok = false;
      let err: string | undefined;
      try {
        ok = await dispatcher.click(selectorFor(target), 'human_like', opts?.mode || 'pointer');
        if (!ok) err = `click target not found: ${target}`;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      payload.actions.push({
        index: i, op: 'click', startTs: t0, endTs: performance.now(), ok,
        target, mark: opts?.mark, intent: opts?.intent, error: err,
      });
      return ok;
    },

    async drag(from, to, opts) {
      const i = actionIdx++;
      const t0 = performance.now();
      let ok = false;
      let err: string | undefined;
      try {
        ok = await dispatcher.drag(selectorFor(from), selectorFor(to), opts?.duration ?? 300, 'human_like');
        if (!ok) err = `drag target not found: ${from} → ${to}`;
      } catch (e) {
        err = e instanceof Error ? e.message : String(e);
      }
      payload.actions.push({
        index: i, op: 'drag', startTs: t0, endTs: performance.now(), ok,
        source: from, target: to, mark: opts?.mark, intent: opts?.intent, error: err,
      });
      return ok;
    },

    key(key, opts) {
      const i = actionIdx++;
      const t0 = performance.now();
      let ok = false;
      try {
        ok = dispatcher.key(key);
      } catch (e) {
        payload.errors.push(`key[${key}] threw: ${e instanceof Error ? e.message : String(e)}`);
      }
      payload.actions.push({
        index: i, op: 'key', startTs: t0, endTs: performance.now(), ok,
        key, mark: opts?.mark, intent: opts?.intent,
      });
      return ok;
    },

    abort(reason: string) {
      aborted = reason;
      throw new Error(`__WEBOPS_ABORT__:${reason}`);
    },
  };

  // 构造异步函数,把 webops 放进作用域。脚本里 `await webops.click(...)` 直接可用。
  let fn: (w: ScriptWebops) => Promise<any>;
  try {
    fn = new AsyncFunction('webops', source) as any;
  } catch (e) {
    // 编译错(SyntaxError 等)立刻短路,error 字段直接抛给 Go 端。
    throw new Error(`script compile failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  try {
    await fn(helper);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (typeof msg === 'string' && msg.includes('__WEBOPS_ABORT__')) {
      // 脚本主动 abort —— 不算错,只记 aborted 原因(已在 helper.abort 里写过)
    } else {
      payload.errors.push(`script runtime: ${msg}`);
    }
  }

  if (aborted) payload.aborted = aborted;
  payload.finalStore = {};
  payload.durationMs = Math.round(performance.now() - payload.startedAt);
  return JSON.stringify(payload);
}
