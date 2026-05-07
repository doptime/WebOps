// react/zustand-telemetry.ts
// Zustand 中间件 — 让 store 的每次状态变化自动变成 VirtualChannel 信号。
//
// V3 中，业务代码需要手动 useSignalBinding 把每个想监控的字段挂上去。
// V4 改进：用 Zustand 的 middleware 一行接入，所有数值字段自动成为信号；
//          非数值字段（status: 'playing' | 'gameover'）也能通过 enum 映射变成数值。
//
// 用法：
//   import { withTelemetry } from '@/webops/react/zustand-telemetry';
//   const useGameStore = create<GameState>()(
//     withTelemetry({
//       targetId: 'game',
//       enums: { status: { playing: 0, gameover: -1, victory: 1 } },
//       skip: ['cards']  // 数组太大，跳过
//     })((set, get) => ({ /* normal store */ }))
//   );

import type { StateCreator, StoreMutatorIdentifier } from 'zustand';

export interface TelemetryConfig {
  targetId: string;
  /** 把字符串枚举映射成数字 */
  enums?: Record<string, Record<string, number>>;
  /** 跳过这些字段（典型：很大的数组） */
  skip?: string[];
  /** 仅追踪这些字段（默认追踪所有数值字段） */
  only?: string[];
  /** 推送 hook —— SessionRunner 在 setup 阶段会注入。如果未设置，则中间件空转。 */
  pushFn?: (targetId: string, key: string, value: number) => void;
}

/** 一个全局可变的中间件配置 —— 让 SessionRunner 在 runtime 注入 pushFn。 */
export const telemetryConfigRegistry = new Map<string, TelemetryConfig>();

export function setTelemetryPushFn(fn: (id: string, k: string, v: number) => void): void {
  for (const cfg of telemetryConfigRegistry.values()) cfg.pushFn = fn;
}

export function clearTelemetryPushFn(): void {
  for (const cfg of telemetryConfigRegistry.values()) cfg.pushFn = undefined;
}

type TelemetryMiddleware = <
  T,
  Mps extends [StoreMutatorIdentifier, unknown][] = [],
  Mcs extends [StoreMutatorIdentifier, unknown][] = []
>(
  config: TelemetryConfig
) => (creator: StateCreator<T, Mps, Mcs>) => StateCreator<T, Mps, Mcs>;

export const withTelemetry: TelemetryMiddleware = (config) => (creator) =>
  ((set: any, get: any, store: any) => {
    telemetryConfigRegistry.set(config.targetId, config);
    const tryPush = (key: string, value: any) => {
      const fn = config.pushFn;
      if (!fn) return;
      if (config.skip?.includes(key)) return;
      if (config.only && !config.only.includes(key)) return;
      if (typeof value === 'number') {
        fn(config.targetId, key, value);
      } else if (typeof value === 'boolean') {
        fn(config.targetId, key, value ? 1 : 0);
      } else if (typeof value === 'string' && config.enums?.[key]?.[value] !== undefined) {
        fn(config.targetId, key, config.enums[key][value]);
      } else if (Array.isArray(value)) {
        fn(config.targetId, `${key}_len`, value.length);
      }
    };

    const wrappedSet = (partial: any, replace?: boolean) => {
      const prev = get();
      set(partial, replace);
      const next = get();
      // 浅比较，把变化字段推过去
      for (const k of Object.keys(next)) {
        if (typeof next[k] === 'function') continue;
        if (prev[k] !== next[k]) tryPush(k, next[k]);
      }
    };

    return creator(wrappedSet as any, get, store);
  }) as any;
