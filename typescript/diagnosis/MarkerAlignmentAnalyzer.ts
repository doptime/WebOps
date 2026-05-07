// src/visual-telemetry/diagnosis/MarkerAlignmentAnalyzer.ts
// [Manifest]
// Role: The Judge (Phase 3)
// Philosophy: "Correlation validates Causality. Variance proves Life."
// @solves Case_Input_Output_Correlation

import { AggregatedMetric } from '../TelemetryPayloadSchema';

// === Data Structures ===

/**
 * [Snapshot] 归一化的单帧快照
 * 解耦了传输协议，专注于分析所需的数值
 */
export interface TelemetrySnapshot {
    ts: number;
    // 拍平的数据视图: ID -> Metric
    data: Record<string, {
        w?: AggregatedMetric; // Visual Weight
        a?: Record<string, AggregatedMetric>; // Attributes / Virtual Signals
    }>;
}

/**
 * [Event] 语义标记
 * 来自 TimelineExecutor 的 Intent 注入
 */
export interface MarkerEvent {
    name: string;
    timestamp: number;
}

/**
 * [Config] 分析配置
 */
export interface AnalysisConfig {
    // 哪些信号被视为"输入" (通常是 __cursor__, __input__)
    inputSignals: string[];
    // 哪些信号被视为"输出" (空数组 = 自动检测所有非系统信号)
    outputSignals: string[];
    
    // 判定阈值
    thresholds: {
        correlation: number;   // 相关性合格线 (0.3 ~ 0.9)
        inputVariance: number; // 认定为"有输入"的最小方差
        outputVariance: number;// 认定为"有响应"的最小方差
    };
}

/**
 * [Report] 诊断结果
 */
export interface DiagnosisReport {
    scenarioId: string;
    score: number; // 0-100 健康分
    intervals: IntervalDiagnosis[];
    alerts: string[]; // 关键问题摘要
}

export interface IntervalDiagnosis {
    name: string; // "Start -> End"
    duration: number;
    
    // 核心指标
    inputActivity: number;  // 方差
    outputActivity: number; // 方差
    correlation: number;    // Pearson r
    
    // 结论
    verdict: 'HEALTHY' | 'NO_RESPONSE' | 'CHAOTIC' | 'AUTONOMOUS' | 'IDLE';
    confidence: number;
}

// === The Analyzer ===

export class MarkerAlignmentAnalyzer {
    private frames: TelemetrySnapshot[] = [];
    private markers: MarkerEvent[] = [];
    private config: AnalysisConfig;

    constructor(config?: Partial<AnalysisConfig>) {
        this.config = {
            inputSignals: config?.inputSignals || ['__cursor__', '__input__'],
            outputSignals: config?.outputSignals || [],
            thresholds: {
                correlation: config?.thresholds?.correlation ?? 0.4,
                inputVariance: config?.thresholds?.inputVariance ?? 0.01,
                outputVariance: config?.thresholds?.outputVariance ?? 0.001
            }
        };
    }

    /**
     * [Ingest] 摄入原始遥测帧
     * 自动提取其中的 Marker 信号，无需单独注册
     */
    ingest(frame: any): void {
        // 1. 提取 Marker
        if (frame.data && frame.data['__markers__']?.a) {
            const markers = frame.data['__markers__'].a;
            for (const [name, metric] of Object.entries(markers)) {
                // Metric.c 存储的是 timestamp
                this.markers.push({ name, timestamp: (metric as AggregatedMetric).c });
            }
        }

        // 2. 存储快照
        this.frames.push({
            ts: frame.ts,
            data: frame.data
        });
    }

    /**
     * [Analyze] 执行核心诊断逻辑
     */
    analyze(scenarioId: string): DiagnosisReport {
        // 按时间排序 Marker
        this.markers.sort((a, b) => a.timestamp - b.timestamp);

        const intervals: IntervalDiagnosis[] = [];
        const alerts: string[] = [];

        // 遍历相邻 Marker 形成的区间
        for (let i = 0; i < this.markers.length - 1; i++) {
            const start = this.markers[i];
            const end = this.markers[i + 1];
            
            // 排除过短的区间 (< 50ms)
            if (end.timestamp - start.timestamp < 50) continue;

            const diagnosis = this.diagnoseInterval(start, end);
            intervals.push(diagnosis);

            // 生成告警
            if (diagnosis.verdict === 'NO_RESPONSE') {
                alerts.push(`[${diagnosis.name}] Deadlock detected: Input active but Output frozen.`);
            } else if (diagnosis.verdict === 'CHAOTIC') {
                alerts.push(`[${diagnosis.name}] Logic chaotic: Response does not match Input pattern.`);
            }
        }

        // 计算总分
        const anomalyCount = intervals.filter(i => ['NO_RESPONSE', 'CHAOTIC'].includes(i.verdict)).length;
        const total = intervals.length || 1;
        const score = Math.max(0, 100 - (anomalyCount / total) * 100);

        return {
            scenarioId,
            score,
            intervals,
            alerts
        };
    }

    // === Core Diagnosis Logic ===

    private diagnoseInterval(start: MarkerEvent, end: MarkerEvent): IntervalDiagnosis {
        // 1. 切片 (Slicing)
        const slice = this.frames.filter(f => f.ts >= start.timestamp && f.ts <= end.timestamp);
        
        // 2. 提取信号序列 (Extraction)
        const inputSeries = this.aggregateSeries(slice, this.config.inputSignals);
        
        // 自动检测 Output 信号: 排除 inputSignals 和系统信号(__*)
        const outputTargets = this.config.outputSignals.length > 0 
            ? this.config.outputSignals
            : this.detectActiveSignals(slice);
        const outputSeries = this.aggregateSeries(slice, outputTargets);

        // 3. 计算统计量 (Statistics)
        const inputVar = this.computeVariance(inputSeries);
        const outputVar = this.computeVariance(outputSeries);
        const correlation = this.computeCorrelation(inputSeries, outputSeries);

        // 4. 裁决 (Verdict)
        const { verdict, confidence } = this.deriveVerdict(inputVar, outputVar, correlation);

        return {
            name: `${start.name} -> ${end.name}`,
            duration: end.timestamp - start.timestamp,
            inputActivity: inputVar,
            outputActivity: outputVar,
            correlation,
            verdict,
            confidence
        };
    }

    private deriveVerdict(inVar: number, outVar: number, corr: number) {
        const { inputVariance, outputVariance, correlation } = this.config.thresholds;
        
        const hasInput = inVar > inputVariance;
        const hasOutput = outVar > outputVariance;
        const isCorrelated = Math.abs(corr) > correlation;

        if (!hasInput && !hasOutput) 
            return { verdict: 'IDLE' as const, confidence: 0.9 };
        
        if (hasInput && !hasOutput) 
            return { verdict: 'NO_RESPONSE' as const, confidence: 0.95 }; // 严重错误
        
        if (!hasInput && hasOutput) 
            return { verdict: 'AUTONOMOUS' as const, confidence: 0.8 }; // 可能是动画
        
        if (isCorrelated) 
            return { verdict: 'HEALTHY' as const, confidence: Math.min(0.99, 0.5 + Math.abs(corr)) };
        
        return { verdict: 'CHAOTIC' as const, confidence: 0.7 }; // 有输入也有输出，但不相关
    }

    // === Math & Signal Processing ===

    /**
     * 将多个信号通道聚合为单一的"活动强度"序列
     * 算法：归一化后的变化量之和
     */
    private aggregateSeries(frames: TelemetrySnapshot[], keys: string[]): number[] {
        return frames.map(f => {
            let activity = 0;
            for (const key of keys) {
                // Handle complex extraction
                const [id, subKey] = key.includes(':') ? key.split(':') : [key, null];
                const node = f.data[id];
                
                if (node) {
                    // Visual Weight Activity
                    if (!subKey && node.w && node.w.c !== -1) {
                        activity += this.delta(node.w);
                    }
                    // Attribute / Virtual Activity
                    if (node.a) {
                        if (subKey && node.a[subKey]) {
                            activity += this.delta(node.a[subKey]);
                        } else if (!subKey) {
                            // Sum all attributes if specific key not provided
                            Object.values(node.a).forEach(m => activity += this.delta(m));
                        }
                    }
                }
            }
            return activity;
        });
    }

    private delta(m: AggregatedMetric): number {
        // K 线总长度 (High - Low) 代表该帧内的波动幅度
        // 加上 (Close - Open) 的绝对值代表趋势变化
        return (m.h - m.l) + Math.abs(m.c - m.o);
    }

    private detectActiveSignals(frames: TelemetrySnapshot[]): string[] {
        const set = new Set<string>();
        // 只采样中间一帧和最后一帧以提高性能
        const samples = [frames[Math.floor(frames.length/2)], frames[frames.length-1]];
        
        samples.forEach(f => {
            if(!f) return;
            Object.keys(f.data).forEach(id => {
                if (this.config.inputSignals.some(s => s.startsWith(id))) return;
                if (id.startsWith('__')) return; // 忽略系统信号
                set.add(id);
            });
        });
        return Array.from(set);
    }

    private computeVariance(data: number[]): number {
        if (data.length < 2) return 0;
        const mean = data.reduce((a, b) => a + b, 0) / data.length;
        const sumSq = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0);
        return sumSq / data.length;
    }

    private computeCorrelation(x: number[], y: number[]): number {
        const n = Math.min(x.length, y.length);
        if (n < 2) return 0;
        
        const avgX = x.reduce((a, b) => a + b, 0) / n;
        const avgY = y.reduce((a, b) => a + b, 0) / n;
        
        let num = 0, denX = 0, denY = 0;
        for (let i = 0; i < n; i++) {
            const dx = x[i] - avgX;
            const dy = y[i] - avgY;
            num += dx * dy;
            denX += dx * dx;
            denY += dy * dy;
        }
        
        const den = Math.sqrt(denX * denY);
        return den === 0 ? 0 : num / den;
    }
}

// === Exports ===
export const diagnose = new MarkerAlignmentAnalyzer();