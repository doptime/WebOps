// react/useTrack.ts
// React 端的两个轻量 helper：
//   1. useTrack(id, opts) — 给 JSX 元素生成 data-vt-id / data-vt-watch 属性。
//   2. usePushSignal()    — 在组件中手动推自定义信号（如分数变化、关键事件）。
//
// 这些 hook 在没有 SessionRunner 跑的时候完全空转，安全可生产环境保留。

import { useMemo, useEffect, useRef } from 'react';

export interface TrackOptions {
  /** 监听 CSS 属性：rotation / scale / opacity / width / height 等 */
  watch?: string[];
}

export function useTrack(id: string, opts: TrackOptions = {}) {
  return useMemo(() => ({
    'data-vt-id': id,
    ...(opts.watch?.length ? { 'data-vt-watch': opts.watch.join(',') } : {})
  }), [id, opts.watch?.join(',')]);
}

/** 业务侧手动推送一个自定义信号 — 比如"得分发生了变化"。 */
export function usePushSignal() {
  return useRef((targetId: string, key: string, value: number) => {
    const w = window as any;
    const push = w.__WEBOPS_PUSH_FN__;
    if (push) push(targetId, key, value);
  }).current;
}

/** 在某个值变化时自动推一次（节流到 React 渲染节奏）。 */
export function useSignalBinding(
  targetId: string,
  key: string,
  value: number | string | boolean,
  enums?: Record<string, number>
) {
  const lastRef = useRef<any>(undefined);
  useEffect(() => {
    if (lastRef.current === value) return;
    lastRef.current = value;
    const w = window as any;
    const push = w.__WEBOPS_PUSH_FN__;
    if (!push) return;
    let v: number | undefined;
    if (typeof value === 'number') v = value;
    else if (typeof value === 'boolean') v = value ? 1 : 0;
    else if (typeof value === 'string' && enums?.[value] !== undefined) v = enums[value];
    if (v !== undefined) push(targetId, key, v);
  }, [targetId, key, value, enums]);
}
