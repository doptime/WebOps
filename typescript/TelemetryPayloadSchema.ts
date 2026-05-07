// src/visual-telemetry/TelemetryPayloadSchema.ts
// [Manifest]
// Role: Data Protocol Definition
// Philosophy: "Flat is better than nested. The Shape of Truth."

// === 基础 K 线单元 (Universal K-Line) ===
// 仅保留给音频和虚拟信道使用（例如音量峰值、游戏逻辑分数）
export interface AggregatedMetric {
    o: number | null; // Open
    h: number | null; // High
    l: number | null; // Low
    c: number | null; // Close
    cnt?: number;
}

// === 扁平化物理遥测快照 (The Flattened Node) ===
// @solves LLM_Token_Overhead, Object_Permanence
export interface FlattenedElementTelemetry {
    // 基础语义与身份
    semantic: string;   // 短哈希语义 (e.g. "svg_radical")
    text?: string;      // 提取到的文本 (e.g. "火")
    
    // 绝对物理坐标与体积
    x: number;
    y: number;
    w: number;
    h: number;
    
    // 视觉绝对权重与注意力排行榜
    rank: number;
    
    // 逻辑挂载点 (音频/虚拟属性依然可以通过此挂载)
    a?: Record<string, AggregatedMetric>;
}

// === 传输帧 (The Frame) ===
export interface TelemetryFrame {
    ts: number;         // Timestamp (ms)
    dur: number;        // Flush 间隔
    sources: ('dom' | 'virtual' | 'audio')[]; 
    
    // 拍平的节点字典，Key 为纯净的编排 ID (e.g. "m9j2kq_0")
    data: Record<string, FlattenedElementTelemetry>;
}