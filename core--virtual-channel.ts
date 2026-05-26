// core/virtual-channel.ts
// 虚拟信道 — 业务逻辑信号的统一入口。
//
// V4 改动:
//   - 移除 standalone tick 模式:V4 中所有 flush 都由 SessionRunner 主导,避免双 RAF 循环。
//   - 移除环形缓冲:V4 数据落地到内存中的 Recorder,没有"隧道未就绪"问题。
//   - 不再发送 JSON 字符串,直接吐对象给 Recorder。

import { AggregatedMetric, emptyMetric, isEmpty, pushValue, mergeMetric } from './core--kline';

export interface SignalContext {
  buffer: AggregatedMetric;
  lastUpdateTime: number;
}

export class VirtualChannel {
  private signals = new Map<string, SignalContext>();

  /** 推送一个原子值。 */
  pushMetric(targetId: string, metricKey: string, value: number): void {
    const key = `${targetId}:${metricKey}`;
    let ctx = this.signals.get(key);
    if (!ctx) {
      ctx = { buffer: emptyMetric(), lastUpdateTime: performance.now() };
      this.signals.set(key, ctx);
    }
    pushValue(ctx.buffer, value);
    ctx.lastUpdateTime = performance.now();
  }

  /** 批量推送 — Object.entries 形式更顺手。 */
  pushBatch(targetId: string, metrics: Record<string, number>): void {
    for (const [k, v] of Object.entries(metrics)) {
      this.pushMetric(targetId, k, v);
    }
  }

  /** 推送已经聚合好的 K 线(如 Audio 端 10Hz 采样的极值)。 */
  pushAggregated(targetId: string, metricKey: string, metric: AggregatedMetric): void {
    if (isEmpty(metric)) return;
    const key = `${targetId}:${metricKey}`;
    let ctx = this.signals.get(key);
    if (!ctx) {
      ctx = { buffer: { ...metric }, lastUpdateTime: performance.now() };
      this.signals.set(key, ctx);
    } else {
      mergeMetric(ctx.buffer, metric);
      ctx.lastUpdateTime = performance.now();
    }
  }

  /** 收割所有非空信号 — 收割后 buffer 翻页(用 close 续接,避免长尾断点)。 */
  harvest(): Record<string, Record<string, AggregatedMetric>> {
    const out: Record<string, Record<string, AggregatedMetric>> = {};
    for (const [key, ctx] of this.signals.entries()) {
      if (isEmpty(ctx.buffer)) continue;
      const idx = key.lastIndexOf(':');
      const targetId = idx === -1 ? key : key.substring(0, idx);
      const metricKey = idx === -1 ? 'value' : key.substring(idx + 1);
      if (!out[targetId]) out[targetId] = {};
      out[targetId][metricKey] = { ...ctx.buffer };
      // 翻页:close 作为下一窗口的 open,序列连续。
      const c = ctx.buffer.c as number;
      ctx.buffer = { o: c, h: c, l: c, c: c, n: 0 };
    }
    return out;
  }

  /** 清理超过 timeoutMs 没有更新的信号 — 防内存泄漏。 */
  pruneStale(timeoutMs = 10_000): number {
    const now = performance.now();
    let removed = 0;
    for (const [k, ctx] of this.signals.entries()) {
      if (now - ctx.lastUpdateTime > timeoutMs) {
        this.signals.delete(k);
        removed++;
      }
    }
    return removed;
  }

  reset(): void {
    this.signals.clear();
  }
}
