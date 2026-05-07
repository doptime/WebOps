// src/visual-telemetry/index.ts
// [Manifest]
// Role: Public API Surface
// Philosophy: "One import to rule them all."

// === Phase 1: Sensing (感知) ===
export { DOMTelemetryRuntime } from './DOMTelemetryRuntime';
export { VirtualChannelManager, virtualChannel } from './VirtualChannelManager';
export * from './TelemetryPayloadSchema';

// React Integration
export { 
    TelemetryScope, 
    useTrack, 
    useSignalBinding, 
    useSignalBindings, 
    useHybridTelemetry,
    useSignalRef
} from './react/toolkit';

// === Phase 2: Orchestration (编排) ===
export { 
    TimelineExecutor, 
    choreography,
    type ActionTimeline 
} from './orchestration/TimelineExecutor';

// === Phase 3: Diagnosis (诊断) ===
export { 
    MarkerAlignmentAnalyzer, 
    diagnose,
    type DiagnosisReport 
} from './diagnosis/MarkerAlignmentAnalyzer';

export { 
    TopologyChecker, 
    topology,
    type RankContract 
} from './diagnosis/TopologyChecker';

// === Global Singleton Access ===
// 方便非模块化环境调试
import { DOMTelemetryRuntime } from './DOMTelemetryRuntime';
import { choreography } from './orchestration/TimelineExecutor';
import { diagnose } from './diagnosis/MarkerAlignmentAnalyzer';

if (typeof window !== 'undefined') {
    (window as any).WebOps = {
        runtime: DOMTelemetryRuntime.getInstance(),
        choreography,
        diagnose
    };
}