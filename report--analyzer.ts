// report/analyzer.ts
// 自动诊断 — V4 在前端就能跑出 verdict(V3 是后端 Go AnalysisEngine 跑)。
//
// 三件事:
//   1. 区间裁决:每对相邻 marker 之间,输入 vs 输出活跃度,判 HEALTHY / NO_RESPONSE / CHAOTIC / AUTONOMOUS / IDLE。
//   2. 音画同步:动作 marker 后 300ms 内有没有音频 peak。
//   3. 期望对齐:从 actions / observations 派生通过率。

import { TelemetryFrame, SessionReport } from './session--SessionRunner';
import { activity, isEmpty } from './core--kline';

export type Verdict = 'HEALTHY' | 'NO_RESPONSE' | 'CHAOTIC' | 'AUTONOMOUS' | 'IDLE';
export type AudioVerdict = 'PASS' | 'FAIL_SILENT' | 'FAIL_LAG' | 'NO_AUDIO_TRACKED';

export interface IntervalDiagnosis {
  fromMarker: string;
  toMarker: string;
  startTs: number;
  endTs: number;
  durationMs: number;
  inputActivity: number;
  outputActivity: number;
  correlation: number;
  verdict: Verdict;
  confidence: number;
}

export interface AudioSync {
  actionName: string;
  ts: number;
  peakAfter: number;
  latencyMs: number;
  verdict: AudioVerdict;
}

export interface DiagnosisReport {
  intervalScore: number;
  expectScore: number;
  audioScore: number;
  intervals: IntervalDiagnosis[];
  audioSyncs: AudioSync[];
  alerts: string[];
}

interface Config {
  inputSignals: string[];
  outputSignals?: string[]; // 不传则自动检测
  thresholds: {
    inputVar: number;
    outputVar: number;
    correlation: number;
    audioPeak: number;
    audioLagMs: number;
  };
}

const DEFAULT_CFG: Config = {
  inputSignals: ['__cursor__:x', '__cursor__:y', '__input__:click', '__input__:key'],
  thresholds: {
    inputVar: 0.5,
    outputVar: 0.5,
    correlation: 0.4,
    audioPeak: 0.05,
    audioLagMs: 200
  }
};

function getMetric(frame: TelemetryFrame, fullKey: string) {
  const i = fullKey.lastIndexOf(':');
  const id = fullKey.slice(0, i);
  const m = fullKey.slice(i + 1);
  return frame.virtual[id]?.[m] ?? null;
}

function aggregateActivity(frames: TelemetryFrame[], keys: string[]): number[] {
  return frames.map((f) => {
    let acc = 0;
    for (const k of keys) {
      const m = getMetric(f, k);
      if (m && !isEmpty(m)) acc += activity(m);
    }
    // 也算一份 DOM weight 的活跃度(输出端常常需要)
    if (keys.includes('__dom_weight__')) {
      for (const node of Object.values(f.domNodes)) {
        if (!isEmpty(node.weight)) acc += activity(node.weight);
      }
    }
    return acc;
  });
}

function variance(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((s, v) => s + (v - m) * (v - m), 0) / arr.length;
}

function correlation(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ma = a.slice(0, n).reduce((x, y) => x + y, 0) / n;
  const mb = b.slice(0, n).reduce((x, y) => x + y, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  if (da === 0 || db === 0) return 0;
  return num / Math.sqrt(da * db);
}

export function diagnose(report: SessionReport, cfg: Config = DEFAULT_CFG): DiagnosisReport {
  // 1. interval 裁决:相邻 marker 之间
  const intervals: IntervalDiagnosis[] = [];
  const allMarkers = [
    { name: '__SCENARIO_START__', ts: report.startTs },
    ...report.markers,
    { name: '__SCENARIO_END__', ts: report.endTs }
  ].sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < allMarkers.length - 1; i++) {
    const from = allMarkers[i];
    const to = allMarkers[i + 1];
    const slice = report.frames.filter((f) => f.ts >= from.ts && f.ts <= to.ts);
    if (slice.length < 2) continue;

    const inAct = aggregateActivity(slice, cfg.inputSignals);
    const outAct = aggregateActivity(slice, ['__dom_weight__']);
    const inV = variance(inAct);
    const outV = variance(outAct);
    const corr = correlation(inAct, outAct);

    let verdict: Verdict = 'HEALTHY';
    if (inV < cfg.thresholds.inputVar && outV < cfg.thresholds.outputVar) verdict = 'IDLE';
    else if (inV < cfg.thresholds.inputVar && outV >= cfg.thresholds.outputVar) verdict = 'AUTONOMOUS';
    else if (inV >= cfg.thresholds.inputVar && outV < cfg.thresholds.outputVar) verdict = 'NO_RESPONSE';
    else if (corr < -cfg.thresholds.correlation) verdict = 'CHAOTIC';

    intervals.push({
      fromMarker: from.name,
      toMarker: to.name,
      startTs: from.ts,
      endTs: to.ts,
      durationMs: to.ts - from.ts,
      inputActivity: inAct.reduce((a, b) => a + b, 0),
      outputActivity: outAct.reduce((a, b) => a + b, 0),
      correlation: corr,
      verdict,
      confidence: Math.min(1, slice.length / 10)
    });
  }

  // 2. audio sync:每个 click/key/drag/type 动作后 300ms 内的 audio peak
  const audioSyncs: AudioSync[] = [];
  for (const a of report.actions) {
    if (a.kind !== 'click' && a.kind !== 'key' && a.kind !== 'drag' && a.kind !== 'type') continue;
    const ts = a.startTs;
    const winFrames = report.frames.filter((f) => f.ts >= ts && f.ts <= ts + 600);
    let peakMax = 0;
    let peakTs = 0;
    for (const f of winFrames) {
      const m = f.virtual['__audio__']?.peak;
      if (m && !isEmpty(m) && (m.h as number) > peakMax) {
        peakMax = m.h as number;
        peakTs = f.ts;
      }
    }
    let verdict: AudioVerdict = 'NO_AUDIO_TRACKED';
    const hasAudio = report.frames.some((f) => f.virtual['__audio__']);
    if (!hasAudio) verdict = 'NO_AUDIO_TRACKED';
    else if (peakMax < cfg.thresholds.audioPeak) verdict = 'FAIL_SILENT';
    else if (peakTs - ts > cfg.thresholds.audioLagMs) verdict = 'FAIL_LAG';
    else verdict = 'PASS';
    audioSyncs.push({
      actionName: a.name,
      ts,
      peakAfter: peakMax,
      latencyMs: peakTs > 0 ? peakTs - ts : -1,
      verdict
    });
  }

  // 3. 计分
  const totalIntervals = intervals.length || 1;
  const badIntervals = intervals.filter((i) => i.verdict === 'NO_RESPONSE' || i.verdict === 'CHAOTIC').length;
  const intervalScore = Math.max(0, 100 - (badIntervals / totalIntervals) * 100);

  const expects = report.observations.filter((o) => o.required);
  const expectScore = expects.length === 0 ? 100 : (expects.filter((e) => e.passed).length / expects.length) * 100;

  const audioFails = audioSyncs.filter((a) => a.verdict === 'FAIL_SILENT' || a.verdict === 'FAIL_LAG').length;
  const audioScore = audioSyncs.length === 0 ? 100 : Math.max(0, 100 - (audioFails / audioSyncs.length) * 100);

  const alerts: string[] = [];
  for (const iv of intervals) {
    if (iv.verdict === 'NO_RESPONSE')
      alerts.push(`[${iv.fromMarker} -> ${iv.toMarker}] 死锁:输入活跃但屏幕无反应`);
    else if (iv.verdict === 'CHAOTIC')
      alerts.push(`[${iv.fromMarker} -> ${iv.toMarker}] 混乱:输入与输出方向不匹配(corr=${iv.correlation.toFixed(2)})`);
  }
  for (const a of audioSyncs) {
    if (a.verdict === 'FAIL_SILENT') alerts.push(`[${a.actionName}] 关键动作后静音`);
    else if (a.verdict === 'FAIL_LAG') alerts.push(`[${a.actionName}] 音效延迟 ${a.latencyMs}ms`);
  }
  for (const o of report.observations) {
    if (o.required && !o.passed) alerts.push(`[expect] "${o.name}" 不成立`);
  }

  return { intervalScore, expectScore, audioScore, intervals, audioSyncs, alerts };
}
