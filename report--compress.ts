// report/compress.ts
// K 线压缩 — 完整 frames 序列对 LLM 来说太长（一次 60 秒会话 = 600 帧 = 数十万 token）。
// 我们用三种压缩手段，让 LLM 既能看到全局趋势，又能在关键时刻看到细节。

import { TelemetryFrame, ActionRecord, SessionReport } from './session--SessionRunner';
import { AggregatedMetric, activity, mergeMetric, isEmpty } from './core--kline';

export interface CompressedTrack {
  /** 信号唯一名: "<targetId>:<metricKey>" 或 "dom:<vtId>:weight"。 */
  key: string;
  /** 全局 K 线（整个 session 合并到一根）—— 给 LLM 一个"这个信号到底动没动"的快速感知。 */
  overall: AggregatedMetric;
  /** 在每个动作 marker 前后 ±windowMs 的局部 K 线 —— 让 LLM 看到因果。 */
  windows: { centerName: string; centerTs: number; pre: AggregatedMetric; post: AggregatedMetric }[];
  /** 整体 activity（变化量），用于排序"哪些信号最值得关注"。 */
  totalActivity: number;
}

export interface CompressedReport {
  scenarioId: string;
  durationMs: number;
  frameCount: number;
  /** 按 totalActivity 倒序的 top N 个信号，足够 LLM 理解。 */
  topTracks: CompressedTrack[];
  /** 直接给原始动作 / marker / observation 时间线 —— 这部分小且关键，全留。 */
  actions: ActionRecord[];
  observations: SessionReport['observations'];
  markers: SessionReport['markers'];
  reads: Record<string, any>;
  errors: string[];
  abortedAt?: number;
}

export interface CompressOptions {
  /** 在每个 marker 前后取多少 ms 的窗口（默认 ±400ms）。 */
  windowMs?: number;
  /** 最多保留多少条信号轨道（默认 30）。 */
  topN?: number;
  /** 把哪些 marker 名字排除在窗口中心之外（防止噪声 marker 占用太多窗口）。 */
  excludeMarkers?: string[];
}

/** 收集所有 frames 中出现过的信号 key（"<targetId>:<metricKey>" 形式）。 */
function collectAllKeys(frames: TelemetryFrame[]): string[] {
  const set = new Set<string>();
  for (const f of frames) {
    for (const id of Object.keys(f.virtual)) {
      for (const m of Object.keys(f.virtual[id])) {
        set.add(`${id}:${m}`);
      }
    }
    for (const id of Object.keys(f.domNodes)) {
      set.add(`dom:${id}:weight`);
      const node = f.domNodes[id];
      if (node.attrs) {
        for (const a of Object.keys(node.attrs)) {
          set.add(`dom:${id}:${a}`);
        }
      }
    }
  }
  return Array.from(set);
}

/** 从一个 frame 中拿到指定 key 的 K 线（不存在则返回 null）。 */
function getMetric(frame: TelemetryFrame, key: string): AggregatedMetric | null {
  if (key.startsWith('dom:')) {
    const rest = key.slice(4);
    const lastIdx = rest.lastIndexOf(':');
    const id = rest.slice(0, lastIdx);
    const sub = rest.slice(lastIdx + 1);
    const node = frame.domNodes[id];
    if (!node) return null;
    if (sub === 'weight') return node.weight;
    if (sub === 'rank') return node.rank;
    if (sub === 'pos.x') return node.pos.x;
    if (sub === 'pos.y') return node.pos.y;
    return node.attrs?.[sub] ?? null;
  }
  const lastIdx = key.lastIndexOf(':');
  const id = key.slice(0, lastIdx);
  const m = key.slice(lastIdx + 1);
  return frame.virtual[id]?.[m] ?? null;
}

function mergeRange(frames: TelemetryFrame[], key: string, fromTs: number, toTs: number): AggregatedMetric {
  const out: AggregatedMetric = { o: null, h: null, l: null, c: null, n: 0 };
  for (const f of frames) {
    if (f.ts < fromTs || f.ts > toTs) continue;
    const m = getMetric(f, key);
    if (m && !isEmpty(m)) mergeMetric(out, m);
  }
  return out;
}

export function compressReport(report: SessionReport, opts: CompressOptions = {}): CompressedReport {
  const windowMs = opts.windowMs ?? 400;
  const topN = opts.topN ?? 30;
  const excludeMarkers = new Set(opts.excludeMarkers ?? ['__SCENARIO_START__', '__SCENARIO_END__']);

  const allKeys = collectAllKeys(report.frames);
  const fullStart = report.startTs;
  const fullEnd = report.endTs;

  // 选择窗口中心：所有非 excluded markers + 所有 actions 的 startTs
  const centers: { name: string; ts: number }[] = [];
  for (const m of report.markers) {
    if (!excludeMarkers.has(m.name)) centers.push({ name: m.name, ts: m.ts });
  }
  for (const a of report.actions) {
    if (a.kind === 'click' || a.kind === 'drag' || a.kind === 'key' || a.kind === 'type') {
      centers.push({ name: `${a.kind}@${a.index}`, ts: a.startTs });
    }
  }
  centers.sort((a, b) => a.ts - b.ts);

  // 对每个 key 计算 overall + windows + totalActivity
  const tracks: CompressedTrack[] = allKeys.map((key) => {
    const overall = mergeRange(report.frames, key, fullStart, fullEnd);
    const windows = centers.map((c) => ({
      centerName: c.name,
      centerTs: c.ts,
      pre: mergeRange(report.frames, key, c.ts - windowMs, c.ts),
      post: mergeRange(report.frames, key, c.ts, c.ts + windowMs)
    })).filter((w) => !isEmpty(w.pre) || !isEmpty(w.post));
    return {
      key,
      overall,
      windows,
      totalActivity: activity(overall)
    };
  });

  // 排序 + 截断
  tracks.sort((a, b) => b.totalActivity - a.totalActivity);
  const topTracks = tracks.slice(0, topN);

  return {
    scenarioId: report.scenarioId,
    durationMs: report.durationMs,
    frameCount: report.frames.length,
    topTracks,
    actions: report.actions,
    observations: report.observations,
    markers: report.markers,
    reads: report.reads,
    errors: report.errors,
    abortedAt: report.abortedAt
  };
}
