// report/ReportBuilder.ts
// 把完整 SessionReport 加工为 LLM-ready 的 payload。
//
// V4.1 改动:
//   - timeline 里每条事件透传 ActionRecord.intent / StepIR.intent,LLM 能看到"作者为何这么做"。
//   - 顶层 payload 携带 hypothesis(来自 setHypothesis,会被 agent 在 run() 入口注入)。
//   - tags 直接透传:让 LLM 知道这次 scenario 属于 happy-path / failure-path 等分类。
//
// 用法:
//   const report = await runner.runSession(script);
//   const payload = buildLLMPayload(report, { hypothesis, intent, tags });
//   await fetch('/api/llm', { method: 'POST', body: JSON.stringify(payload) });

import { SessionReport, ActionRecord } from './session--SessionRunner';
import { compressReport, CompressedReport, CompressedTrack } from './report--compress';
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
  /** 业务侧透传的假设/意图/标签 — 让 LLM 知道这次 scenario 想验证什么。 */
  hypothesis?: string;
  intent?: string;
  tags?: string[];
  /** 客观事实 — 由 SessionRunner 采集,无主观判断。 */
  facts: {
    timeline: TimelineEvent[];
    state: Record<string, any>;
    tracks: TrackSummary[];
  };
  /** 自动判决 — 由 analyzer 输出,LLM 可以选择采纳 / 反驳。 */
  verdict: {
    intervalScore: number;
    expectScore: number;
    audioScore: number;
    overallScore: number;
    intervals: IntervalSummary[];
    audioSyncs: AudioSummary[];
    alerts: string[];
  };
  /** 可选:完整原始报告 — 调试用,默认不附,LLM payload 一般不需要。 */
  raw?: { compressed: CompressedReport; diagnosis: DiagnosisReport };
}

interface TimelineEvent {
  t: number; // 相对开始 ms
  type: string;
  name: string;
  ok?: boolean;
  intent?: string;
  detail?: string;
}

interface TrackSummary {
  key: string;
  /** "open=.. high=.. low=.. close=.." 人类可读摘要。 */
  overall: string;
  /** 在关键动作前后的局部 K 线。 */
  windows: { around: string; pre: string; post: string; delta: number }[];
  totalActivity: number;
}

interface IntervalSummary {
  range: string; // "marker_a -> marker_b"
  durationMs: number;
  verdict: string;
  inputActivity: number;
  outputActivity: number;
  correlation: number;
}

interface AudioSummary {
  action: string;
  latencyMs: number;
  peak: number;
  verdict: string;
}

function fmtKline(m: AggregatedMetric): string {
  if (isEmpty(m)) return 'IDLE';
  return `O=${fmt(m.o)} H=${fmt(m.h)} L=${fmt(m.l)} C=${fmt(m.c)}`;
}

function fmt(v: number | null): string {
  if (v === null) return '_';
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(2);
}

function summarizeTrack(track: CompressedTrack, baseTs: number): TrackSummary {
  return {
    key: track.key,
    overall: fmtKline(track.overall),
    windows: track.windows.map((w) => {
      const preC = w.pre.c;
      const postC = w.post.c;
      const delta = (preC !== null && postC !== null) ? Math.round(((postC as number) - (preC as number)) * 100) / 100 : 0;
      return {
        around: `${w.centerName} @ ${Math.floor(w.centerTs - baseTs)}ms`,
        pre: fmtKline(w.pre),
        post: fmtKline(w.post),
        delta
      };
    }),
    totalActivity: Math.floor(track.totalActivity)
  };
}

function buildTimeline(report: SessionReport): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  const base = report.startTs;

  for (const a of report.actions) {
    events.push({
      t: Math.floor(a.startTs - base),
      type: a.kind,
      name: a.name,
      ok: a.ok,
      intent: a.intent,
      detail: a.result !== undefined ? JSON.stringify(a.result).slice(0, 80) : undefined
    });
  }
  for (const m of report.markers) {
    events.push({ t: Math.floor(m.ts - base), type: 'marker', name: m.name });
  }
  for (const o of report.observations) {
    events.push({
      t: Math.floor(o.ts - base),
      type: o.required ? 'expect' : 'observe',
      name: o.name,
      ok: o.passed
    });
  }
  events.sort((a, b) => a.t - b.t);
  return events;
}

export interface BuildOptions {
  hypothesis?: string;
  intent?: string;
  tags?: string[];
  includeRaw?: boolean;
  topN?: number;
  windowMs?: number;
}

export function buildLLMPayload(report: SessionReport, opts: BuildOptions = {}): LLMPayload {
  const compressed = compressReport(report, { topN: opts.topN ?? 30, windowMs: opts.windowMs ?? 400 });
  const diag = diagnose(report);

  const payload: LLMPayload = {
    meta: {
      scenarioId: report.scenarioId,
      durationMs: Math.floor(report.durationMs),
      url: report.url,
      frameCount: report.frames.length,
      hadErrors: report.errors.length > 0,
      aborted: report.abortedAt !== undefined,
      framesTruncated: report.framesTruncated || undefined
    },
    hypothesis: opts.hypothesis,
    intent: opts.intent,
    tags: opts.tags,
    facts: {
      timeline: buildTimeline(report),
      state: report.reads,
      tracks: compressed.topTracks.map((t) => summarizeTrack(t, report.startTs))
    },
    verdict: {
      intervalScore: Math.round(diag.intervalScore),
      expectScore: Math.round(diag.expectScore),
      audioScore: Math.round(diag.audioScore),
      overallScore: Math.round((diag.intervalScore + diag.expectScore + diag.audioScore) / 3),
      intervals: diag.intervals.map((iv) => ({
        range: `${iv.fromMarker} -> ${iv.toMarker}`,
        durationMs: Math.floor(iv.durationMs),
        verdict: iv.verdict,
        inputActivity: Math.floor(iv.inputActivity),
        outputActivity: Math.floor(iv.outputActivity),
        correlation: Math.round(iv.correlation * 100) / 100
      })),
      audioSyncs: diag.audioSyncs.map((a) => ({
        action: a.actionName,
        latencyMs: a.latencyMs,
        peak: Math.round(a.peakAfter * 100) / 100,
        verdict: a.verdict
      })),
      alerts: diag.alerts
    }
  };

  if (opts.includeRaw) payload.raw = { compressed, diagnosis: diag };
  return payload;
}

/** 仅给开发人员看的人类可读摘要。 */
export function summarize(payload: LLMPayload): string {
  const lines: string[] = [];
  lines.push(`### Scenario: ${payload.meta.scenarioId}`);
  if (payload.hypothesis) lines.push(`hypothesis: ${payload.hypothesis}`);
  if (payload.intent) lines.push(`intent: ${payload.intent}`);
  if (payload.tags?.length) lines.push(`tags: ${payload.tags.join(', ')}`);
  lines.push(`duration: ${payload.meta.durationMs}ms, frames: ${payload.meta.frameCount}, aborted: ${payload.meta.aborted}`);
  lines.push('');
  lines.push(`scores: overall=${payload.verdict.overallScore} interval=${payload.verdict.intervalScore} expect=${payload.verdict.expectScore} audio=${payload.verdict.audioScore}`);
  lines.push('');
  if (payload.verdict.alerts.length > 0) {
    lines.push('alerts:');
    for (const a of payload.verdict.alerts) lines.push(`  • ${a}`);
    lines.push('');
  }
  lines.push('intervals:');
  for (const iv of payload.verdict.intervals) {
    lines.push(`  ${iv.range} [${iv.verdict}] dur=${iv.durationMs}ms corr=${iv.correlation}`);
  }
  return lines.join('\n');
}
