// src/visual-telemetry/AudioTelemetryRuntime.ts
// [Manifest]
// Role: The Ear (Sensing Phase)
// Philosophy: "Sound is Data. Silence is a Signal."
// @solves Case_Headless_Deafness, Case_AV_Desync, Case_Double_Aggregation

import { AggregatedMetric } from './TelemetryPayloadSchema';
import { VirtualChannelManager } from './VirtualChannelManager';

/**
 * 音频遥测运行时
 * 负责实时分析 AudioContext 的能量输出，生成听觉 K 线。
 */
export class AudioTelemetryRuntime {
    private static instance: AudioTelemetryRuntime;
    
    // Web Audio API 引用
    private context: AudioContext | null = null;
    private analyser: AnalyserNode | null = null;
    private dataArray: Uint8Array | null = null;
    
    // 运行状态
    private isActive: boolean = false;
    private rafId: number | null = null;
    
    // 采样配置
    private readonly FFT_SIZE = 256; // 低精度足以捕捉能量，性能开销小
    private readonly FLUSH_INTERVAL_MS = 100; // 10Hz 采样率 (与 Visual 对齐)
    private lastFlushTime: number = 0;

    // K 线缓冲区 (OHLC)
    private bufferRMS: AggregatedMetric;
    private bufferPeak: AggregatedMetric;

    private constructor() {
        this.bufferRMS = this.createEmptyMetric();
        this.bufferPeak = this.createEmptyMetric();
    }

    static getInstance(): AudioTelemetryRuntime {
        if (!AudioTelemetryRuntime.instance) {
            AudioTelemetryRuntime.instance = new AudioTelemetryRuntime();
        }
        return AudioTelemetryRuntime.instance;
    }

    public attach(ctx: AudioContext, sourceNode?: AudioNode) {
        if (this.context === ctx) return;
        this.context = ctx;
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = this.FFT_SIZE;
        this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);

        if (sourceNode) {
            sourceNode.connect(this.analyser);
        } else {
            // 如果没有指定源节点，尝试连接 destination 的前一级是不可能的 (WebAudio 限制)。
            // 必须由调用者显式传入 Master Gain Node。
            console.warn('[WebOps] AudioRuntime needs a source node (e.g., MasterGain) to attach.');
        }
    }

    public start() {
        if (this.isActive) return;
        this.isActive = true;
        this.loop();
    }

    public stop() {
        this.isActive = false;
        if (this.rafId) cancelAnimationFrame(this.rafId);
    }

    private loop = () => {
        if (!this.isActive || !this.analyser || !this.dataArray) return;
        
        this.analyser.getByteFrequencyData(this.dataArray);
        
        // 1. Compute RMS (Energy) & Peak
        let sum = 0;
        let peak = 0;
        const len = this.dataArray.length;
        
        for (let i = 0; i < len; i++) {
            const val = this.dataArray[i] / 255.0; // Normalize 0-1
            sum += val * val;
            if (val > peak) peak = val;
        }
        const rms = Math.sqrt(sum / len);

        // 2. Aggregate internally
        this.updateMetric(this.bufferRMS, rms);
        this.updateMetric(this.bufferPeak, peak);

        // 3. Flush Check
        const now = performance.now();
        if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
            this.flush();
            this.lastFlushTime = now;
        }

        this.rafId = requestAnimationFrame(this.loop);
    }

    private flush() {
        const channel = VirtualChannelManager.getInstance();

        // @fix Case_Double_Aggregation
        // 使用 pushAggregated 直接传输 OHLC 结构，而不是传一个单点值。
        // 这允许下游分析"音量的波动范围"。
        
        if (this.bufferRMS.o !== null) {
            channel.pushAggregated('__audio__', 'energy_rms', this.bufferRMS);
        }
        
        if (this.bufferPeak.o !== null) {
            channel.pushAggregated('__audio__', 'peak_level', this.bufferPeak);
        }

        this.bufferRMS = this.createEmptyMetric();
        this.bufferPeak = this.createEmptyMetric();
    }

    private updateMetric(metric: AggregatedMetric, value: number) {
        if (metric.o === null) {
            metric.o = value;
            metric.h = value;
            metric.l = value;
            metric.c = value;
        } else {
            metric.c = value;
            if (value > metric.h) metric.h = value;
            if (value < metric.l) metric.l = value;
        }
    }

    private createEmptyMetric(): AggregatedMetric {
        return { o: null, h: -1, l: -1, c: -1 };
    }
}