// react/zustand-telemetry.ts
// Zustand 接入 — 让 store 的每次状态变化自动变成 VirtualChannel 信号。
//
// V4.1 改动(替换 V4 的 set-劫持中间件):
//   - 不再包裹 set / 不再侵入 StateCreator:withTelemetry 只在 store 创建时
//     登记一个 store 引用,set 原样透传,业务的类型推导零污染。
//   - 用 Zustand 原生 store.subscribe(state, prev) 做 diff,是开箱即用的能力,
//     无需手写 get() 前后取值。
//   - 用 subscribe/unsubscribe 的对称生命周期替代"全局可变 pushFn 注入":
//     session 开始 attach、结束 detach,不再有跨 session 残留的全局可变状态。
//
// 对外契约保持不变(index.ts / runtime.ts 仍按老名字 re-export):
//   - withTelemetry(config)        —— store 创建期登记
//   - setTelemetryPushFn(pushFn)   —— session 开始时调用,开始向 vc 推信号
//   - clearTelemetryPushFn()       —— session 结束时调用,停止并解绑
//
// 用法(与 V4 完全一致):
//   import { withTelemetry } from '@/webops/runtime';
//   const useGameStore = create<GameState>()(
//     withTelemetry({
//       targetId: 'game',
//       enums: { status: { playing: 0, gameover: -1, victory: 1 } },
//       skip: ['cards']  // 数组太大,跳过
//     })((set, get) => ({ /* normal store */ }))
//   );

import type { StateCreator, StoreMutatorIdentifier } from 'zustand';

export interface TelemetryConfig {
  targetId: string;
  /** 把字符串枚举映射成数字 */
  enums?: Record<string, Record<string, number>>;
  /** 跳过这些字段(典型:很大的数组) */
  skip?: string[];
  /** 仅追踪这些字段(默认追踪所有数值字段) */
  only?: string[];
}

type PushFn = (targetId: string, key: string, value: number) => void;
type Unsub = () => void;

interface RegisteredStore {
  config: TelemetryConfig;
  /** Zustand 原生 store.subscribe,已 bind 到对应 store。 */
  subscribe: (listener: (state: any, prev: any) => void) => Unsub;
}

/** store 创建期登记的 store 引用表(targetId → store)。 */
const registry = new Map<string, RegisteredStore>();

/** 当前 session 活跃的解绑句柄;detach 时逐个调用。 */
let activeUnsubs: Unsub[] = [];

/** 把单个字段值按类型规则推成数值信号。语义与 V4 的 tryPush 完全一致。 */
function emit(config: TelemetryConfig, push: PushFn, key: string, value: unknown): void {
  if (config.skip?.includes(key)) return;
  if (config.only && !config.only.includes(key)) return;
  if (typeof value === 'number') {
    push(config.targetId, key, value);
  } else if (typeof value === 'boolean') {
    push(config.targetId, key, value ? 1 : 0);
  } else if (typeof value === 'string' && config.enums?.[key]?.[value] !== undefined) {
    push(config.targetId, key, config.enums[key][value]);
  } else if (Array.isArray(value)) {
    push(config.targetId, `${key}_len`, value.length);
  }
}

type TelemetryMiddleware = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(
  config: TelemetryConfig
) => (creator: StateCreator<T, Mps, Mcs>) => StateCreator<T, Mps, Mcs>;

/**
 * 中间件 —— 注意:它**不包裹 set**,只登记 store 引用,creator 原样返回。
 * 真正的信号采集发生在 setTelemetryPushFn() 之后的 store.subscribe 里。
 */
export const withTelemetry: TelemetryMiddleware = (config) => (creator) =>
  ((set: any, get: any, store: any) => {
    registry.set(config.targetId, {
      config,
      subscribe: store.subscribe.bind(store),
    });
    return creator(set, get, store);
  }) as any;

/**
 * session 开始时由 SessionRunner/runSession 调用:
 * 对所有已登记的 store 挂上 subscribe,把状态变化 diff 后推给 vc。
 */
export function setTelemetryPushFn(push: PushFn): void {
  clearTelemetryPushFn(); // 幂等:先解绑上一轮残留
  for (const { config, subscribe } of registry.values()) {
    const unsub = subscribe((state, prev) => {
      for (const k of Object.keys(state)) {
        if (typeof state[k] === 'function') continue;
        if (prev[k] !== state[k]) emit(config, push, k, state[k]);
      }
    });
    activeUnsubs.push(unsub);
  }
}

/** session 结束时调用:解绑全部 subscribe,不留全局可变残留。 */
export function clearTelemetryPushFn(): void {
  for (const unsub of activeUnsubs) unsub();
  activeUnsubs = [];
}
