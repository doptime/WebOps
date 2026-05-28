// report/MediaPayload.ts  (V6)
// 取代 V4 的 LLMPayload。V4 的 facts.tracks 是 K 线轨道,verdict 是前端数值诊断。
// V6 把"事实"从数值轨道换成媒体引用 + 时间锚,把"判决"整段交给多模态模型,
// 前端不再算 intervalScore/audioScore(那是 K 线时代的产物)。
//
// MediaPayload 是"给 Qwen3-Omni 看的输入清单":
//   - media:    视频帧序列(或 mp4)+ 一段音频,以及帧率/时长等对齐信息
//   - timeline: 毫秒锚定的动作/marker/observe/expect 事件,每条带 intent
//   - state:    read() 收集的业务状态值(屏幕上看不到的上下文,如内部分数)
//   - intent/hypothesis/tags: 三层意图,直接进 prompt
//
// 模型据此回答:"脚本在 t=1240ms 按了 a 键并期望加分 —— 视频里那一刻屏幕发生了什么?
//               有没有听到成功音效?业务状态对得上吗?" 这正是 V4 audioScore /
//               intervalScore 想用数字逼近、但只有真正"看+听"才能可靠判断的事。

import type { TimedEvent } from './core--event-sink';

export interface MediaRef {
  /** 'frames' = 一组 JPEG 帧(推荐:vLLM 对 Qwen3-VL/Omni 本就按帧采样);
   *  'video'  = 已 mux 的 mp4(便于人工回看,模型侧仍会被重新抽帧)。 */
  kind: 'frames' | 'video';
  /** 帧目录 / mp4 文件在驱动器产物目录里的相对路径。 */
  path: string;
  /** kind==='frames' 时每帧文件名(按时间升序)。 */
  frameFiles?: string[];
  /** 帧率(驱动器 CDP 截帧或 mux 时设定)。 */
  fps: number;
}

export interface AudioRef {
  /** 转码后的音频文件(wav/flac/mp3 之一)相对路径。空字符串=本次没采到声音。 */
  path: string;
  /** 是否真的采到了声音(应用没建 AudioContext 时为 false)。 */
  captured: boolean;
  durationMs: number;
}

export interface MediaPayload {
  meta: {
    scenarioId: string;
    url: string;
    durationMs: number;
    hadErrors: boolean;
    aborted: boolean;
    /** 媒体捕获起点对应的 performance.now(),用于核对 timeline.t 的零点。 */
    captureT0: number;
  };
  intent?: string;
  hypothesis?: string;
  tags?: string[];
  media: {
    video: MediaRef | null;   // 由驱动器(CDP 截帧 / ffmpeg)回填;前端阶段为 null
    audio: AudioRef | null;   // 由驱动器解码 base64 + ffmpeg 转码后回填
  };
  /** 毫秒锚定事件流(已按 t 升序)。 */
  timeline: TimedEvent[];
  /** read() 的业务状态快照。 */
  state: Record<string, unknown>;
  /** observe/expect 的汇总(也在 timeline 里,这里给个去噪的小结)。 */
  observations: { name: string; t: number; passed: boolean; required: boolean; intent?: string }[];
  errors: string[];
}

/** 前端阶段产出的中间结果:已含 timeline/state/音频 base64,但视频帧由驱动器侧补。 */
export interface MediaSessionReport {
  scenarioId: string;
  url: string;
  startTs: number;       // performance.now() at capture start (== captureT0)
  endTs: number;
  durationMs: number;
  timeline: TimedEvent[];
  state: Record<string, unknown>;
  observations: MediaPayload['observations'];
  errors: string[];
  aborted: boolean;
  /** 前端 AudioCapture 的产物:base64 + mime + 时长。驱动器解码转码后填进 MediaPayload.media.audio。 */
  audio: { mimeType: string; base64: string; durationMs: number; captured: boolean };
}
