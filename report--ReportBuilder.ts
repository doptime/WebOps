// report/ReportBuilder.ts
// 把 SessionReport (原始) → CompressedReport (压缩) → LLMPayload (面向 LLM 的最终结构)
//
// LLMPayload 是给大模型看的"事实+verdict"双层结构：
//   meta:   场景说什么、多长、有没有错
//   facts:  动作时间线、观测断言、关键 K 线窗口
//   verdict: 自动诊断结果（区间 verdict、音画同步、计分）
//
// V4.1 新增：
//   - timeline 事件携带 `intent` 字段（来自 ActionRecord.intent）—— LLM 一眼看到"做这一步是为啥"。
//   - meta 多 framesTruncated 字段，告诉 LLM frames 是否被中段丢弃。
//
// 大模型只需看 facts + verdict 就能给出"游戏设计是否实现正确"的高级判断。

import { SessionReport } from './session--SessionRunner';
import { compressReport, CompressOptions, CompressedTrack } from './report--compress';
import { diagnose, DiagnosisReport } from './report--analyzer';
import { AggregatedMetric, isEmpty } from './core--kline';

export interface LLMPayload {
  meta: {
    scenarioId: string;
    durationMs: number;
    url: string;
    frameCount: number;
    hadErrors: boolean;
    aborted: boolean;
    framesTruncated?: boolean;
  };
  /** 测试假设 — 由调用方提供，告诉 LLM "你期望看到什么"。 */
  hypothesis?: string;
  /** 该 scenario 在审计什么设计意图（与 hypothesis 互补:hypothesis 偏断言,intent 偏目的）。 */
  intent?: string;
  /** 标签,便于 LLM 分类聚合（happy-path / failure-path / stress / ...）。 */
  tags?: string[];
  facts: {
    /** 动作时间线（精简版） */
    timeline: TimelineEvent[];
    /** read() 收集到的状态值。 */
    state: Record<string, any>;
    /** 关键信号轨道（按 activity 排序的 top N）。 */
    tracks: LLMTrack[];
  };
  verdict: {
    intervalScore: number;
    expectScore: number;
    audioScore: number;
    overallScore: number;
    intervals: { range: string; durationMs: number; verdict: string; correlation: number }[];
    audioSyncs: { action: string; latencyMs: number; verdict: string }[];
    alerts: string[];
  };
  /** 完整原始数据 — 默认不发给 LLM，但便于二次分析。 */
  raw?: SessionReport;
}

interface TimelineEvent {
  t: number;          // 相对开始时间 ms
  type: string;       // step kind / marker / observe / expect
  name: string;
  ok?: boolean;
  /** 自然语言注解,从 StepIR.intent 透传过来。 */
  intent?: string;
  detail?: string;
}

interface LLMTrack {
  key: string;
  /** 整段 K 线的人类可读摘要 */
  overall: string;
  /** 在每个动作/marker 前后的局部 K 线。 */
  windows: { around: string; pre: string; post: string; delta: number }[];
  totalActivity: number;
}

const fmt = (m: AggregatedMetric, digits = 2): string => {
  if (isEmpty(m)) return '∅';
  const r = (n: number | null) => (n === null ? '∅' : Number(n).toFixed(digits));
  return `O=${r(m.o)} H=${r(m.h)} L=${r(m.l)} C=${r(m.c)}`;
};

const deltaActivity = (pre: AggregatedMetric, post: AggregatedMetric): number => {
  if (isEmpty(post)) return 0;
  if (isEmpty(pre)) return ((post.h as number) - (post.l as number)) + Math.abs((post.c as number) - (post.o as number));
  // 用 close 的位移作为"动作前后差"的近似
  return Math.abs((post.c as number) - (pre.c ?? pre.o ?? 0));
};

function compactTrack(t: CompressedTrack): LLMTrack {
  return {
    key: t.key,
    overall: fmt(t.overall),
    windows: t.windows.slice(0, 8).map((w) => ({
      around: w.centerName,
      pre: fmt(w.pre),
      post: fmt(w.post),
      delta: Number(deltaActivity(w.pre, w.post).toFixed(2))
    })),
    totalActivity: Number(t.totalActivity.toFixed(2))
  };
}

export function buildLLMPayload(
  report: SessionReport,
  opts: {
    hypothesis?: string;
    intent?: string;
    tags?: string[];
    compressOpts?: CompressOptions;
    includeRaw?: boolean;
  } = {}
): LLMPayload {
  const compressed = compressReport(report, opts.compressOpts);
  const diagReport: DiagnosisReport = diagnose(report);

  // 时间线 — 把 actions、markers、observations、errors 按时间排序成一条
  const timeline: TimelineEvent[] = [];
  for (const a of report.actions) {
    timeline.push({
      t: Math.round(a.startTs - report.startTs),
      type: a.kind,
      name: a.name,
      ok: a.ok,
      intent: a.intent,
      detail: a.error ?? (a.result !== undefined ? JSON.stringify(a.result).slice(0, 120) : undefined)
    });
  }
  for (const m of report.markers) {
    timeline.push({
      t: Math.round(m.ts - report.startTs),
      type: 'marker',
      name: m.name,
      detail: m.meta ? JSON.stringify(m.meta) : undefined
    });
  }
  for (const o of report.observations) {
    timeline.push({
      t: Math.round(o.ts - report.startTs),
      type: o.required ? 'expect' : 'observe',
      name: o.name,
      ok: o.passed
    });
  }
  timeline.sort((a, b) => a.t - b.t);

  const overallScore = Math.round(
    (diagReport.intervalScore + diagReport.expectScore + diagReport.audioScore) / 3
  );

  const payload: LLMPayload = {
    meta: {
      scenarioId: report.scenarioId,
      durationMs: Math.round(report.durationMs),
      url: report.url,
      frameCount: report.frames.length,
      hadErrors: report.errors.length > 0,
      aborted: report.abortedAt !== undefined,
      framesTruncated: report.framesTruncated
    },
    hypothesis: opts.hypothesis,
    intent: opts.intent,
    tags: opts.tags,
    facts: {
      timeline,
      state: report.reads,
      tracks: compressed.topTracks.map(compactTrack)
    },
    verdict: {
      intervalScore: Math.round(diagReport.intervalScore),
      expectScore: Math.round(diagReport.expectScore),
      audioScore: Math.round(diagReport.audioScore),
      overallScore,
      intervals: diagReport.intervals.map((i) => ({
        range: `${i.fromMarker} → ${i.toMarker}`,
        durationMs: Math.round(i.durationMs),
        verdict: i.verdict,
        correlation: Number(i.correlation.toFixed(2))
      })),
      audioSyncs: diagReport.audioSyncs.map((a) => ({
        action: a.actionName,
        latencyMs: a.latencyMs,
        verdict: a.verdict
      })),
      alerts: diagReport.alerts
    }
  };

  if (opts.includeRaw) payload.raw = report;
  return payload;
}

/** 一个最小化的人类可读摘要（用于打 console，便于本地调试）。 */
export function summarize(payload: LLMPayload): string {
  const lines: string[] = [];
  lines.push(`# Session [${payload.meta.scenarioId}] — ${payload.meta.durationMs}ms / ${payload.meta.frameCount} frames`);
  if (payload.intent) lines.push(`Intent: ${payload.intent}`);
  if (payload.hypothesis) lines.push(`Hypothesis: ${payload.hypothesis}`);
  lines.push(`Score: ${payload.verdict.overallScore}/100 (interval=${payload.verdict.intervalScore} expect=${payload.verdict.expectScore} audio=${payload.verdict.audioScore})`);
  if (payload.verdict.alerts.length) {
    lines.push('Alerts:');
    payload.verdict.alerts.forEach((a) => lines.push(`  - ${a}`));
  }
  lines.push('Timeline:');
  payload.facts.timeline.forEach((e) => {
    const flag = e.ok === false ? '✗' : (e.ok === true ? '✓' : ' ');
    const intentSuffix = e.intent ? ` // ${e.intent}` : '';
    lines.push(`  ${String(e.t).padStart(5)}ms ${flag} ${e.type.padEnd(8)} ${e.name}${e.detail ? ` -- ${e.detail}` : ''}${intentSuffix}`);
  });
  lines.push('Top signals (by activity):');
  payload.facts.tracks.slice(0, 8).forEach((t) => {
    lines.push(`  ${t.key.padEnd(40)} ${t.overall} (act=${t.totalActivity})`);
  });
  return lines.join('\n');
}
