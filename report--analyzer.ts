// report/analyzer.ts
// 自动诊断 — V4 在前端就能跑出 verdict（V3 是后端 Go AnalysisEngine 跑）。
//
// 三件事：
//   1. 区间裁决：每对相邻 marker 之间，输入 vs 输出活跃度，判 HEALTHY / NO_RESPONSE / CHAOTIC / AUTONOMOUS / IDLE。
//   2. 音画同步：动作 marker 后 300ms 内有没有音频 peak。
//   3. 期望对齐：从 actions / observations 派生通过率。

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
    // 也算一份 DOM weight 的活跃度（输出端常常需要）
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
  return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length;
}

function correlation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return 0;
  const ax = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const ay = y.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = x[i] - ax, b = y[i] - ay;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den === 0 ? 0 : num / den;
}

function detectOutputs(frames: TelemetryFrame[], inputs: Set<string>): string[] {
  const seen = new Set<string>();
  for (const f of frames) {
    for (const id of Object.keys(f.virtual)) {
      if (id.startsWith('__')) continue; // skip __cursor__/__input__/__markers__
      for (const m of Object.keys(f.virtual[id])) {
        const k = `${id}:${m}`;
        if (!inputs.has(k)) seen.add(k);
      }
    }
  }
  // DOM weight 也作为输出
  seen.add('__dom_weight__');
  return Array.from(seen);
}

function diagnoseInterval(
  inActivity: number[], outActivity: number[], cfg: Config
): { verdict: Verdict; confidence: number; corr: number } {
  const iv = variance(inActivity);
  const ov = variance(outActivity);
  const corr = correlation(inActivity, outActivity);
  const hasIn = iv > cfg.thresholds.inputVar;
  const hasOut = ov > cfg.thresholds.outputVar;
  const correlated = Math.abs(corr) > cfg.thresholds.correlation;

  if (!hasIn && !hasOut) return { verdict: 'IDLE', confidence: 0.9, corr };
  if (hasIn && !hasOut) return { verdict: 'NO_RESPONSE', confidence: 0.95, corr };
  if (!hasIn && hasOut) return { verdict: 'AUTONOMOUS', confidence: 0.8, corr };
  if (correlated) return { verdict: 'HEALTHY', confidence: Math.min(0.99, 0.5 + Math.abs(corr)), corr };
  return { verdict: 'CHAOTIC', confidence: 0.7, corr };
}

export function diagnose(report: SessionReport, override?: Partial<Config>): DiagnosisReport {
  const cfg: Config = {
    ...DEFAULT_CFG,
    ...override,
    thresholds: { ...DEFAULT_CFG.thresholds, ...(override?.thresholds ?? {}) }
  };
  const inputs = new Set(cfg.inputSignals);
  const outputs = cfg.outputSignals ?? detectOutputs(report.frames, inputs);

  // 1. 区间分析
  const intervals: IntervalDiagnosis[] = [];
  const allMarkers = [
    { name: '__SCENARIO_START__', ts: report.startTs },
    ...report.markers,
    { name: '__SCENARIO_END__', ts: report.endTs }
  ].sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < allMarkers.length - 1; i++) {
    const a = allMarkers[i];
    const b = allMarkers[i + 1];
    if (b.ts - a.ts < 50) continue;
    const slice = report.frames.filter((f) => f.ts >= a.ts && f.ts <= b.ts);
    const inAct = aggregateActivity(slice, cfg.inputSignals);
    const outAct = aggregateActivity(slice, outputs);
    const { verdict, confidence, corr } = diagnoseInterval(inAct, outAct, cfg);
    intervals.push({
      fromMarker: a.name,
      toMarker: b.name,
      startTs: a.ts,
      endTs: b.ts,
      durationMs: b.ts - a.ts,
      inputActivity: inAct.reduce((s, x) => s + x, 0),
      outputActivity: outAct.reduce((s, x) => s + x, 0),
      correlation: corr,
      verdict,
      confidence
    });
  }

  // 2. 音画同步
  const audioSyncs: AudioSync[] = [];
  const hasAudio = report.frames.some((f) => f.virtual['__audio__']?.['peak']);
  for (const a of report.actions) {
    if (a.kind !== 'click' && a.kind !== 'key' && a.kind !== 'drag') continue;
    const ts = a.startTs;
    const window = report.frames.filter((f) => f.ts >= ts && f.ts <= ts + 600);
    let peakMax = 0;
    let peakTs = 0;
    for (const f of window) {
      const peak = f.virtual['__audio__']?.['peak'];
      if (peak && !isEmpty(peak) && (peak.h as number) > peakMax) {
        peakMax = peak.h as number;
        peakTs = f.ts;
      }
    }
    let verdict: AudioVerdict;
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
      alerts.push(`[${iv.fromMarker} -> ${iv.toMarker}] 死锁：输入活跃但屏幕无反应`);
    else if (iv.verdict === 'CHAOTIC')
      alerts.push(`[${iv.fromMarker} -> ${iv.toMarker}] 混乱：输入与输出方向不匹配（corr=${iv.correlation.toFixed(2)}）`);
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
