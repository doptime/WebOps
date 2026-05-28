// report/ReportBuilder.ts  (V6)
// 取代 V4 的 ReportBuilder + compress + analyzer。
//
// V4 在前端算 intervalScore/audioScore/intervalVerdict 这套数值判决,是因为文本 LLM
// 看不到画面、听不到声音,只能靠 K 线数字逼近"音画同步""有没有反应"。V6 既然把真画面、
// 真声音交给多模态模型,这套前端数值诊断就整体取消 —— 判决交给模型。
//
// 本文件只剩"组装"职责:把 MediaSessionReport(前端产出)+ 媒体文件引用(驱动器产出)
// 拼成 MediaPayload,并提供一个 console 用的人类可读小结。

import type { MediaSessionReport, MediaPayload, MediaRef, AudioRef } from './report--MediaPayload';

export interface BuildOptions {
  intent?: string;
  hypothesis?: string;
  tags?: string[];
  /** 驱动器侧 CDP 截帧 / ffmpeg mux 后回填的视频引用。 */
  video?: MediaRef | null;
  /** 驱动器侧把 report.audio.base64 解码 + ffmpeg 转码后回填的音频引用。 */
  audio?: AudioRef | null;
}

export function buildMediaPayload(report: MediaSessionReport, opts: BuildOptions = {}): MediaPayload {
  const audio: AudioRef | null = opts.audio ?? (report.audio.captured
    ? { path: '', captured: true, durationMs: report.audio.durationMs }   // 未转码:path 待驱动器填
    : { path: '', captured: false, durationMs: 0 });

  return {
    meta: {
      scenarioId: report.scenarioId,
      url: report.url,
      durationMs: report.durationMs,
      hadErrors: report.errors.length > 0,
      aborted: report.aborted,
      captureT0: report.startTs,
    },
    intent: opts.intent,
    hypothesis: opts.hypothesis,
    tags: opts.tags,
    media: {
      video: opts.video ?? null,
      audio,
    },
    timeline: report.timeline,
    state: report.state,
    observations: report.observations,
    errors: report.errors,
  };
}

/** console 小结(本地调试)。不含任何数值判决 —— 判决是模型的事。 */
export function summarize(report: MediaSessionReport): string {
  const lines: string[] = [];
  lines.push(`# Session [${report.scenarioId}] — ${report.durationMs}ms`);
  lines.push(`audio: ${report.audio.captured ? `captured ${report.audio.durationMs}ms (${report.audio.mimeType})` : 'none'}`);
  if (report.aborted) lines.push('ABORTED');
  lines.push('Timeline:');
  for (const e of report.timeline) {
    if (e.kind === 'cursor') continue;
    const flag = e.ok === false ? '✗' : (e.ok === true ? '✓' : ' ');
    const intentSuffix = e.intent ? ` // ${e.intent}` : '';
    const detail = e.detail !== undefined ? ` -- ${trunc(JSON.stringify(e.detail), 80)}` : '';
    lines.push(`  ${String(e.t).padStart(6)}ms ${flag} ${e.kind.padEnd(8)} ${e.name}${detail}${intentSuffix}`);
  }
  const fails = report.observations.filter((o) => o.required && !o.passed);
  if (fails.length) {
    lines.push('Failed expects:');
    fails.forEach((o) => lines.push(`  - ${o.name}`));
  }
  if (report.errors.length) {
    lines.push('Errors:');
    report.errors.forEach((e) => lines.push(`  - ${e}`));
  }
  return lines.join('\n');
}

function trunc(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}
