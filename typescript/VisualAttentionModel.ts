// src/visual-telemetry/VisualAttentionModel.ts
// [Manifest]
// Role: Visual Physics Engine
// Philosophy: "Visibility is a function of Physics (Area, Position, Opacity)."

export interface ElementPhysicalState {
    width: number;
    height: number;
    x: number;
    y: number;
    opacity: number;
    zIndex: number;
    
    // 环境上下文
    viewportW: number;
    viewportH: number;
}

/**
 * [Core] 计算单一元素的视觉绝对权重
 * 算法版本: v2.0 (Stable)
 * 逻辑: 面积 * 位置衰减 * 可见性系数
 */
export function computeVisualWeight(state: ElementPhysicalState): number {
    const { width, height, x, y, opacity, zIndex, viewportW, viewportH } = state;

    // 1. 面积权重 (Area Weight)
    // 过滤掉不可见元素
    if (width <= 0 || height <= 0 || opacity <= 0) return 0;
    const area = width * height;

    // 2. 位置衰减系数 (Position Decay Factor)
    // 模拟人眼聚焦中心区域的特性 (Foveal Vision Simulation)
    const centerX = x + width / 2;
    const centerY = y + height / 2;
    
    // 归一化距离 (0.0 = Center, 1.0 = Edge)
    const normX = (centerX - viewportW / 2) / (viewportW / 2);
    const normY = (centerY - viewportH / 2) / (viewportH / 2);
    
    // 距离平方 (Euclidean Distance Squared)
    const distSquared = normX * normX + normY * normY;
    
    // 衰减函数: 高斯分布模拟 (Center=1.0, Edge~=0.5)
    const positionFactor = Math.max(0.5, 1 - (distSquared * 0.4));

    // 3. 层级修正 (Z-Index Correction)
    // 微量修正，用于区分完全重叠的元素 (Rank Stability)
    // 限制 zIndex 权重影响不超过 10%
    const zIndexFactor = 1 + Math.max(-0.1, Math.min(0.1, zIndex * 0.001));

    return Math.floor(area * positionFactor * opacity * zIndexFactor);
}