// core/kline.ts
// 统一 K 线 (Universal K-Line) — 所有信号的最小公约数。
// V4 改动:抽离独立模块,移除哨兵值不一致问题(V3 中 -1 / null 两套并存)。
//          统一用 null 作为空指标的唯一表示,外部判断使用 isEmpty()。

export interface AggregatedMetric {
  o: number | null; // open
  h: number | null; // high
  l: number | null; // low
  c: number | null; // close
  n?: number;       // optional sample count
}

export const emptyMetric = (): AggregatedMetric => ({ o: null, h: null, l: null, c: null, n: 0 });

export const isEmpty = (m: AggregatedMetric): boolean => m.o === null;

/** 累加一个采样值到 K 线。 */
export function pushValue(m: AggregatedMetric, v: number): void {
  if (m.o === null) {
    m.o = m.h = m.l = m.c = v;
  } else {
    m.c = v;
    if (v > (m.h as number)) m.h = v;
    if (v < (m.l as number)) m.l = v;
  }
  m.n = (m.n ?? 0) + 1;
}

/** 把现成的另一根 K 线(如音频已经聚合好的)合并进来,避免二次聚合丢失极值。 */
export function mergeMetric(dst: AggregatedMetric, src: AggregatedMetric): void {
  if (isEmpty(src)) return;
  if (isEmpty(dst)) {
    dst.o = src.o; dst.h = src.h; dst.l = src.l; dst.c = src.c; dst.n = src.n;
    return;
  }
  dst.c = src.c;
  if ((src.h as number) > (dst.h as number)) dst.h = src.h;
  if ((src.l as number) < (dst.l as number)) dst.l = src.l;
  dst.n = (dst.n ?? 0) + (src.n ?? 0);
}

/** Activity = 波动幅度 (H-L) + 趋势变化 |C-O|。用于变化量度量。 */
export function activity(m: AggregatedMetric): number {
  if (isEmpty(m)) return 0;
  return ((m.h as number) - (m.l as number)) + Math.abs((m.c as number) - (m.o as number));
}

/** 把 K 线"翻页":把当前 close 作为下一根 K 线的 open,开启新窗口。 */
export function rollOver(m: AggregatedMetric): AggregatedMetric {
  if (isEmpty(m)) return emptyMetric();
  const c = m.c as number;
  return { o: c, h: c, l: c, c: c, n: 0 };
}
