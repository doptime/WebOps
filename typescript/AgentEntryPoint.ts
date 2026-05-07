// src/visual-telemetry/AgentEntryPoint.ts
import { DOMTelemetryRuntime } from './DOMTelemetryRuntime';
import { VirtualChannelManager } from './VirtualChannelManager';
import { AudioTelemetryRuntime } from './AudioTelemetryRuntime';
import { TimelineExecutor } from './orchestration/TimelineExecutor';
import { MarkerAlignmentAnalyzer } from './diagnosis/MarkerAlignmentAnalyzer';

class WebOpsAgent {
    public domRuntime = DOMTelemetryRuntime.getInstance();
    public virtualChannel = VirtualChannelManager.getInstance();
    public audioRuntime = AudioTelemetryRuntime.getInstance();
    public choreography = TimelineExecutor.getInstance();
    public analyzer = new MarkerAlignmentAnalyzer();

    private originalAudioContext: typeof AudioContext | null = null;
    
    // 【修复合并】：剔除多余定义，确保启动、打游戏、截流、返回 JSON 的原子性闭环
    public async runScenario(scenarioJSON: any): Promise<string> {
        console.log('[WebOps] 收到后端下发的测试剧本:', scenarioJSON);

        // 1. 唤醒所有环境嗅探探针（如果不启动，Go evaluator 在 evaluate 的时候全是空数据）
        this.start(); 

        try {
            if (this.choreography) {
                await this.choreography.execute(scenarioJSON);
            }

            // 2. 给物理引擎和 React 动画预留落地时间
            await new Promise(r => setTimeout(r, 1500));

            // 3. 截断探针
            this.stop(); 

            if (this.analyzer) {
                const report = this.analyzer.analyze(scenarioJSON.scenario_id || "DEFAULT_SCENARIO");
                return JSON.stringify(report);
            }
        } catch (err) {
            console.error('[WebOps] 执行剧本发生异常:', err);
            return JSON.stringify({ score: 0, status: "error", alerts: [String(err)] });
        }

        return JSON.stringify({ score: 100, status: "completed", alerts: [] });
    }

    public start() {
        console.log('[WebOps] Agent starting in Local Autonomous Mode...');

        this.domRuntime.onFlush = (frame) => this.analyzer.ingest(frame);
        this.virtualChannel.onFlush = (frame) => this.analyzer.ingest(frame);

        this.domRuntime.start();
        this.virtualChannel.startStandalone();
        this.hijackAudioContext();

        console.log('[WebOps] Agent running.');
    }

    public stop() {
        this.domRuntime.stop();
        this.virtualChannel.stopStandalone();
        this.audioRuntime.stop();
        this.restoreAudioContext();
        console.log('[WebOps] Agent stopped.');
    }

    public mark(markerName: string) {
        this.virtualChannel.pushMetric('__markers__', markerName, performance.now());
    }

    public pushSignal(targetId: string, metricKey: string, value: number) {
        this.virtualChannel.pushMetric(targetId, metricKey, value);
    }

    private hijackAudioContext() {
        if (this.originalAudioContext) return;
        const self = this;
        this.originalAudioContext = window.AudioContext || (window as any).webkitAudioContext;
        if (!this.originalAudioContext) return;
        const PatchedAudioContext = function (this: AudioContext, ...args: any[]) {
            const ctx = new (self.originalAudioContext as any)(...args);
            const interceptorGain = ctx.createGain();
            interceptorGain.connect(ctx.destination);
            self.audioRuntime.attach(ctx, interceptorGain);
            self.audioRuntime.start();
            Object.defineProperty(ctx, 'destination', { get: () => interceptorGain });
            return ctx;
        };
        PatchedAudioContext.prototype = this.originalAudioContext.prototype;
        window.AudioContext = PatchedAudioContext as any;
        if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = PatchedAudioContext;
    }

    private restoreAudioContext() {
        if (this.originalAudioContext) {
            window.AudioContext = this.originalAudioContext;
            if ((window as any).webkitAudioContext) (window as any).webkitAudioContext = this.originalAudioContext;
            this.originalAudioContext = null;
        }
    }
}

if (typeof window !== 'undefined') {
    (window as any).WebOps = new WebOpsAgent();
}