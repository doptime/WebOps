// src/visual-telemetry/diagnosis/TopologyChecker.ts
// [Manifest]
// Role: The Inspector (Phase 3)
// Philosophy: "Structure is Equilibrium. Rank defines Visibility."
// @solves Static_Layer_Correctness

import { AggregatedMetric } from '../TelemetryPayloadSchema';
import { TelemetrySnapshot } from './MarkerAlignmentAnalyzer'; // 复用快照定义

// === Contract Definitions ===

export type ContractType = 
    | 'STRICT_ORDER'      // A > B > C (严格顺序)
    | 'PARTIAL_ORDER'     // A > B (相对顺序，中间可插入其他)
    | 'TOP_N'             // A is in Top N (确保可见性)
    | 'NEVER_BELOW';      // A > B (A 永远不能被 B 遮挡)

export interface RankContract {
    id: string;
    type: ContractType;
    // 期望的 ID 列表 (按 Rank 从高到低，即 1, 2, 3...)
    expected: string[]; 
    
    // 容差配置
    tolerance: {
        frames: number; // 允许违规的持续帧数 (过滤动画抖动)
        margin?: number; // Rank 值允许的偏差
    };

    // 激活条件 (例如：只有当 Modal 可见时才检查)
    activeWhen?: {
        elementExists?: string;
    };
}

export interface Violation {
    contractId: string;
    frameIndex: number;
    ts: number;
    details: string;
    severity: 'warn' | 'error';
}

// === The Checker ===

export class TopologyChecker {
    private contracts: Map<string, RankContract> = new Map();
    
    constructor() {}

    /**
     * [Config] 注册契约
     */
    register(contract: RankContract) {
        this.contracts.set(contract.id, contract);
        return this;
    }

    /**
     * [Analyze] 执行静态拓扑检查
     */
    check(frames: TelemetrySnapshot[]): Violation[] {
        const violations: Violation[] = [];
        
        // 状态缓存：记录每个契约当前的连续违规帧数
        const violationStreaks = new Map<string, number>();

        frames.forEach((frame, idx) => {
            // 1. 提取当前帧的 Rank Map (ID -> Rank)
            const rankMap = this.extractRanks(frame);
            if (rankMap.size === 0) return;

            // 2. 检查所有契约
            this.contracts.forEach(contract => {
                // 检查激活条件
                if (contract.activeWhen?.elementExists) {
                    if (!rankMap.has(contract.activeWhen.elementExists)) {
                        violationStreaks.set(contract.id, 0);
                        return; // Skip
                    }
                }

                const isViolated = this.checkContract(contract, rankMap);
                
                if (isViolated) {
                    const streak = (violationStreaks.get(contract.id) || 0) + 1;
                    violationStreaks.set(contract.id, streak);

                    // 超过容差阈值，确认为违规
                    if (streak > contract.tolerance.frames) {
                        violations.push({
                            contractId: contract.id,
                            frameIndex: idx,
                            ts: frame.ts,
                            details: `Violation of ${contract.type}: Expected [${contract.expected.join(', ')}]`,
                            severity: 'error'
                        });
                    }
                } else {
                    violationStreaks.set(contract.id, 0); // Reset
                }
            });
        });

        return violations;
    }

    // === Core Logic ===

    private checkContract(c: RankContract, ranks: Map<string, number>): boolean {
        // 过滤出当前帧存在的相关元素
        const presentIds = c.expected.filter(id => ranks.has(id));
        if (presentIds.length < 2 && c.type !== 'TOP_N') return false; // 只有一个元素无法比较相对顺序

        switch (c.type) {
            case 'STRICT_ORDER':
                // 检查实际 Rank 是否严格递增
                for (let i = 0; i < presentIds.length - 1; i++) {
                    const curr = ranks.get(presentIds[i])!;
                    const next = ranks.get(presentIds[i+1])!;
                    if (curr >= next) return true; // 违规: 前者 Rank 数值应该更小 (1 is highest)
                }
                return false;

            case 'PARTIAL_ORDER':
            case 'NEVER_BELOW':
                // 只要相对关系正确即可 (A 的 Rank < B 的 Rank)
                for (let i = 0; i < presentIds.length - 1; i++) {
                    const a = presentIds[i];
                    // 只需要和后续所有元素比较
                    for (let j = i + 1; j < presentIds.length; j++) {
                        const b = presentIds[j];
                        if (ranks.get(a)! >= ranks.get(b)!) return true;
                    }
                }
                return false;

            case 'TOP_N':
                // 检查首个元素是否在前 N 名
                const target = c.expected[0];
                if (!ranks.has(target)) return false;
                // Margin 在这里解释为 N (e.g., margin=3 means Top 3)
                const limit = c.tolerance.margin || 1; 
                return ranks.get(target)! > limit;

            default:
                return false;
        }
    }

    private extractRanks(frame: TelemetrySnapshot): Map<string, number> {
        const map = new Map<string, number>();
        for (const [id, data] of Object.entries(frame.data)) {
            // 使用 Close 值作为这一帧的最终 Rank
            if (data.r && data.r.c !== -1) {
                map.set(id, data.r.c);
            }
        }
        return map;
    }
}

// === Factory / Presets ===

export const topology = {
    create: () => new TopologyChecker(),
    
    // 常用契约模板
    contracts: {
        /**
         * 确保 Modal 永远在 Mask 之上
         */
        modalAboveMask: (modalId: string, maskId: string): RankContract => ({
            id: `rule_modal_layer`,
            type: 'NEVER_BELOW',
            expected: [modalId, maskId], // Modal Rank(1) < Mask Rank(2)
            tolerance: { frames: 3 },    // 允许 3 帧(约30ms)的动画穿插
            activeWhen: { elementExists: modalId }
        }),

        /**
         * 确保关键按钮（如支付）是 Top 1 可点击的
         */
        criticalActionVisible: (btnId: string): RankContract => ({
            id: `rule_critical_vis`,
            type: 'TOP_N',
            expected: [btnId],
            tolerance: { frames: 5, margin: 1 } // 必须是 Rank 1
        })
    }
};