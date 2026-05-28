// agent.ts  (V6)
// window.WebOps —— 暴露给 Go/chromedp 驱动器。两条路径都产出 MediaSessionReport(JSON):
//
//   V4 注册式:  webops.register(id, { build, intent, hypothesis, tags })
//               window.WebOps.run(id)        → JSON MediaSessionReport
//               window.WebOps.describe()     → { gameIntent, scenarios[] }
//   V5 脚本式:  window.WebOps.runScript(src, ctx) → JSON MediaSessionReport
//
// 两者都通过 SessionRunner / 同一套 EventSink + AudioCapture + 捕获握手采集媒体。
// 驱动器拿到 MediaSessionReport 后:截帧 + 解码音频 base64 + ffmpeg 转码,
// 再用 buildMediaPayload 拼成 MediaPayload 喂 Qwen3-Omni(见 serving/vllm_client.py)。

import { runSession, RunOptions } from './index';
import { Script as ScriptFactory, CompiledScript, TargetSpec } from './script--Script';
import { SessionRunner } from './session--SessionRunner';
import { EventSink } from './core--event-sink';
import { ActionDispatcher } from './script--actions';
import type { MediaSessionReport } from './report--MediaPayload';

export interface RegisteredScenario {
  build: () => CompiledScript;
  hypothesis: string;
  intent?: string;
  tags?: string[];
  options?: RunOptions;
}

export interface AgentDescription {
  gameIntent?: string;
  scenarios: Array<{ id: string; hypothesis: string; intent?: string; tags?: string[] }>;
}

interface V5ScenarioCtx {
  scenarioId: string;
  intent?: string;
  hypothesis?: string;
  tags?: string[];
}

class WebOpsAgent {
  private registry = new Map<string, RegisteredScenario>();
  private gameIntent: string | undefined;

  register(scenarioId: string, entry: RegisteredScenario): void {
    this.registry.set(scenarioId, entry);
  }

  setGameIntent(intent: string): void { this.gameIntent = intent; }

  list(): string[] { return Array.from(this.registry.keys()); }

  describe(): AgentDescription {
    const scenarios = Array.from(this.registry.entries()).map(([id, e]) => ({
      id, hypothesis: e.hypothesis, intent: e.intent, tags: e.tags,
    }));
    return { gameIntent: this.gameIntent, scenarios };
  }

  /** [V4] 跑一个已注册剧本 → JSON MediaSessionReport(+ 顶层 intent/hypothesis/tags 元字段)。 */
  async run(scenarioId: string, override?: Partial<RunOptions>): Promise<string> {
    const entry = this.registry.get(scenarioId);
    if (!entry) {
      return JSON.stringify({ error: 'SCENARIO_NOT_FOUND', scenarioId, available: this.list() });
    }
    try {
      const script = entry.build();
      const report = await runSession(script, {
        hypothesis: entry.hypothesis, intent: entry.intent, tags: entry.tags,
        ...entry.options, ...override,
      });
      return JSON.stringify(decorate(report, {
        scenarioId, intent: entry.intent, hypothesis: entry.hypothesis, tags: entry.tags,
      }));
    } catch (e) {
      return JSON.stringify({
        error: 'SESSION_FAILED', scenarioId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  /** [V5] 执行 Go 灌进来的 JS 脚本源码 → JSON MediaSessionReport。 */
  async runScript(source: string, ctx: V5ScenarioCtx): Promise<string> {
    if (typeof source !== 'string' || source.length === 0) {
      return JSON.stringify({ error: 'EMPTY_SCRIPT', scenarioId: ctx?.scenarioId });
    }
    try {
      const report = await runV5Script(source, ctx);
      return JSON.stringify(decorate(report, ctx));
    } catch (e) {
      return JSON.stringify({
        error: 'RUN_SCRIPT_FAILED', scenarioId: ctx?.scenarioId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }

  Script = ScriptFactory;
}

/** 把 scenario 级 intent/hypothesis/tags 贴到 report 顶层,便于驱动器直接读。 */
function decorate(report: MediaSessionReport, ctx: V5ScenarioCtx) {
  return { ...report, intent: ctx.intent, hypothesis: ctx.hypothesis, tags: ctx.tags };
}

declare global {
  interface Window {
    WebOps?: WebOpsAgent;
    useGameStore?: { getState: () => any };
    __WEBOPS_CAPTURE__?: { state: 'arm' | 'stop' };
    __WEBOPS_CAPTURE_ACK__?: boolean;
    __WEBOPS_AUDIO__?: unknown;
  }
}

export const webops = (() => {
  const g = (typeof window !== 'undefined' ? window : globalThis) as any;
  if (!g.WebOps) g.WebOps = new WebOpsAgent();
  return g.WebOps as WebOpsAgent;
})();

export { runSession } from './index';
export { Script as ScriptFactory } from './script--Script';
export type { MediaSessionReport, MediaPayload } from './report--MediaPayload';

// ============================================================================
// V5 解释器 —— 与 V4 共用 EventSink + AudioCapture + 捕获握手(经由 SessionRunner.run 的同款逻辑)。
// 为了不重复握手代码,V5 脚本被包成一个 CompiledScript-free 的执行体,
// 但仍借 SessionRunner 的 armCapture/anchor/音频生命周期 —— 这里用一个轻量包装实现。
// ============================================================================

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as
  new (...args: string[]) => (...args: any[]) => Promise<any>;

interface ScriptWebops {
  wait(ms: number): Promise<void>;
  waitFor(name: string, predicate: () => boolean, timeoutMs?: number, opts?: { intent?: string }): Promise<boolean>;
  state(): any;
  dom(selector: string): Element | null;
  observe(name: string, passed: boolean, opts?: { intent?: string }): void;
  expect(name: string, passed: boolean, opts?: { intent?: string }): void;
  read(name: string, value: any): void;
  click(target: string, opts?: { mark?: string; intent?: string; mode?: 'pointer' | 'native' }): Promise<boolean>;
  drag(from: string, to: string, opts?: { mark?: string; intent?: string; duration?: number }): Promise<boolean>;
  key(key: string, opts?: { mark?: string; intent?: string }): boolean;
  mark(name: string, opts?: { intent?: string }): void;
  abort(reason: string): void;
  readonly ctx: V5ScenarioCtx;
}

/**
 * V5 脚本执行:把脚本体塞进 SessionRunner 的捕获生命周期。
 * 实现手法:用一个只有一个 `wait_for(()=>scriptDone)` 的占位 CompiledScript 让 SessionRunner
 * 负责 armCapture / anchor / 音频起停,同时并行跑真正的脚本,脚本通过 helper 把事件记进
 * 同一个 sink。脚本跑完置 scriptDone=true,SessionRunner 收尾返回 MediaSessionReport。
 */
async function runV5Script(source: string, ctx: V5ScenarioCtx): Promise<MediaSessionReport> {
  let fn: (w: ScriptWebops) => Promise<any>;
  try {
    fn = new AsyncFunction('webops', source) as any;
  } catch (e) {
    throw new Error(`script compile failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const runner = new SessionRunner();
  // 借 SessionRunner 的内部 sink/dispatcher:V6 SessionRunner 在 runSession 里建立它们,
  // 这里改用 runner 暴露的执行钩子。为简单起见,V5 直接复用一个独立 sink + dispatcher,
  // 并通过 runner.runWith() 接管捕获生命周期。
  return runner.runWith(async (sink: EventSink, dispatcher: ActionDispatcher, state: Record<string, unknown>) => {
    let aborted: string | null = null;
    const observations: MediaSessionReport['observations'] = [];
    const helper = makeHelper(ctx, sink, dispatcher, state, observations, (r) => { aborted = r; });
    try {
      await fn(helper);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('__WEBOPS_ABORT__')) sink.push('error', 'script', { detail: msg });
    }
    return { aborted, observations };
  }, ctx);
}

function makeHelper(
  ctx: V5ScenarioCtx, sink: EventSink, dispatcher: ActionDispatcher,
  state: Record<string, unknown>, observations: MediaSessionReport['observations'],
  setAborted: (r: string) => void
): ScriptWebops {
  function sel(target: string): TargetSpec {
    if (target.startsWith('[') || target.startsWith('.') || target.startsWith('#')) return target;
    return { vtId: target };
  }
  return {
    ctx,
    state() {
      if (typeof window === 'undefined') return null;
      const s = window.useGameStore;
      try { return s && typeof s.getState === 'function' ? s.getState() : null; } catch { return null; }
    },
    dom(selector) {
      if (!selector) return null;
      const full = (selector.startsWith('[') || selector.startsWith('.') || selector.startsWith('#'))
        ? selector : `[data-vt-id="${selector}"]`;
      return document.querySelector(full);
    },
    async wait(ms) { await sleep(ms); },
    async waitFor(name, predicate, timeoutMs = 5000, opts) {
      const t0 = performance.now(); const deadline = t0 + timeoutMs; let passed = false;
      try {
        if (predicate()) passed = true;
        else while (performance.now() < deadline) { await sleep(50); if (predicate()) { passed = true; break; } }
      } catch (e) { sink.push('error', `waitFor:${name}`, { detail: String(e) }); }
      observations.push({ name, t: sink.relNow(), passed, required: false, intent: opts?.intent });
      sink.push('observe', name, { ok: passed, intent: opts?.intent });
      return passed;
    },
    observe(name, passed, opts) {
      observations.push({ name, t: sink.relNow(), passed, required: false, intent: opts?.intent });
      sink.push('observe', name, { ok: passed, intent: opts?.intent });
    },
    expect(name, passed, opts) {
      observations.push({ name, t: sink.relNow(), passed, required: true, intent: opts?.intent });
      sink.push('expect', name, { ok: passed, intent: opts?.intent });
    },
    read(name, value) { state[name] = value; sink.push('read', name, { detail: value }); },
    async click(target, opts) {
      const ok = await dispatcher.click(sel(target), 'human_like', opts?.mode || 'pointer');
      if (opts?.mark) sink.push('marker', opts.mark, { intent: opts?.intent });
      return ok;
    },
    async drag(from, to, opts) {
      const ok = await dispatcher.drag(sel(from), sel(to), opts?.duration ?? 300, 'human_like');
      if (opts?.mark) sink.push('marker', opts.mark, { intent: opts?.intent });
      return ok;
    },
    key(key, opts) {
      const ok = dispatcher.key(key);
      if (opts?.mark) sink.push('marker', opts.mark, { intent: opts?.intent });
      return ok;
    },
    mark(name, opts) { sink.push('marker', name, { intent: opts?.intent }); },
    abort(reason) { setAborted(reason); throw new Error(`__WEBOPS_ABORT__:${reason}`); },
  };
}
