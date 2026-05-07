// src/visual-telemetry/VirtualChannelManager.ts
// [Manifest]
// Role: The Universal Signal Socket
// Philosophy: "Logic is Signal. All signals can be aggregated into K-Lines."

import { AggregatedMetric, TelemetryFrame } from './TelemetryPayloadSchema';

interface VirtualSignalContext {
    buffer: AggregatedMetric;
    lastUpdateTime: number; 
}

export class VirtualChannelManager {
    private static instance: VirtualChannelManager;
    
    // 【修复 1】：放开权限，允许 AgentEntryPoint 和外部 Go 脚本读取最新的状态 K 线
    public signals: Map<string, VirtualSignalContext> = new Map();
    private pendingFrames: any[] = []; 
    private readonly MAX_PENDING = 200;

    public onFlush?: (frame: any) => void;

    private readonly FLUSH_INTERVAL_MS = 100;
    private lastFlushTime: number = 0;
    private isActive: boolean = false;
    private rafId: number | null = null; 

    constructor() {}

    static getInstance(): VirtualChannelManager {
        if (!VirtualChannelManager.instance) {
            VirtualChannelManager.instance = new VirtualChannelManager();
        }
        return VirtualChannelManager.instance;
    }

    public pushMetric(targetId: string, metricKey: string, value: number) {
        const compositeKey = `${targetId}:${metricKey}`;
        let ctx = this.signals.get(compositeKey);
        
        if (!ctx) {
            ctx = { buffer: this.createEmptyMetric(), lastUpdateTime: performance.now() };
            this.signals.set(compositeKey, ctx);
        }
        
        this.updateMetric(ctx.buffer, value);
        ctx.lastUpdateTime = performance.now();
    }

    public pushBatch(targetId: string, metrics: Record<string, number>) {
        for (const [key, val] of Object.entries(metrics)) {
            this.pushMetric(targetId, key, val);
        }
    }

    public pushAggregated(targetId: string, metricKey: string, metric: AggregatedMetric) {
        const compositeKey = `${targetId}:${metricKey}`;
        this.signals.set(compositeKey, {
            buffer: { ...metric },
            lastUpdateTime: performance.now()
        });
    }

    public harvest(): Record<string, Record<string, AggregatedMetric>> {
        const result: Record<string, Record<string, AggregatedMetric>> = {};
        const now = performance.now();

        for (const [compositeKey, ctx] of this.signals.entries()) {
            if (ctx.buffer.o === null) {
                if (now - ctx.lastUpdateTime > 5000) {
                    this.signals.delete(compositeKey);
                }
                continue;
            }

            const [targetId, metricKey] = this.parseCompositeKey(compositeKey);
            if (!result[targetId]) result[targetId] = {};
            
            result[targetId][metricKey] = { ...ctx.buffer };
            
            // 【修复 2】：绝对不能置空！用当前的收盘价 (c) 作为下一个周期的开盘/最高/最低
            // 确保物理引擎的坐标断点续传，不被吞没
            ctx.buffer = {
                o: ctx.buffer.c,
                h: ctx.buffer.c,
                l: ctx.buffer.c,
                c: ctx.buffer.c
            };
        }

        return result;
    }

    public startStandalone() {
        if (this.isActive) return;
        this.isActive = true;
        this.lastFlushTime = performance.now();
        this.tickStandalone();
    }

    public stopStandalone() {
        this.isActive = false;
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
        this.signals.clear();
    }

    private tickStandalone = () => {
        if (!this.isActive) return;
        const now = performance.now();

        if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
            this.flushStandalone(now);
            this.lastFlushTime = now;
        }

        this.rafId = requestAnimationFrame(this.tickStandalone);
    };

    private flushStandalone(timestamp: number) {
        const harvested = this.harvest();
        if (Object.keys(harvested).length === 0) return;

        const payload: any = {
            ts: Math.floor(timestamp),
            sources: ['virtual'],
            data: {}
        };

        for (const [targetId, metrics] of Object.entries(harvested)) {
            payload.data[targetId] = { a: metrics };
        }

        this.send(payload);
    }

    private send(payloadObj: any) {
        if (this.onFlush) {
            while (this.pendingFrames.length > 0) {
                const pending = this.pendingFrames.shift();
                if (pending) this.onFlush(pending);
            }
            this.onFlush(payloadObj);
        } else {
            if (this.pendingFrames.length >= this.MAX_PENDING) {
                this.pendingFrames.shift(); 
            }
            this.pendingFrames.push(payloadObj);
        }
    }

    private updateMetric(metric: AggregatedMetric, value: number) {
        if (metric.o === null) {
            metric.o = metric.h = metric.l = metric.c = value;
        } else {
            metric.c = value;
            if (value > metric.h!) metric.h = value;
            if (value < metric.l!) metric.l = value;
        }
    }

    private createEmptyMetric(): AggregatedMetric {
        return { o: null, h: null, l: null, c: null };
    }

    private parseCompositeKey(key: string): [string, string] {
        const lastIdx = key.lastIndexOf(':');
        return [key.substring(0, lastIdx), key.substring(lastIdx + 1)];
    }
}

export const virtualChannel = VirtualChannelManager.getInstance();