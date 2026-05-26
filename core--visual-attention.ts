// core/visual-attention.ts
// 视觉物理引擎 — 计算元素的"视觉吸引力权重"。
// 算法 v2.0 stable,与 V3 保持兼容。

export interface ElementPhysicalState {
  width: number;
  height: number;
  x: number;
  y: number;
  opacity: number;
  zIndex: number;
  viewportW: number;
  viewportH: number;
}

export function computeVisualWeight(s: ElementPhysicalState): number {
  if (s.width <= 0 || s.height <= 0 || s.opacity <= 0) return 0;
  const area = s.width * s.height;
  const cx = s.x + s.width / 2;
  const cy = s.y + s.height / 2;
  const nx = (cx - s.viewportW / 2) / (s.viewportW / 2);
  const ny = (cy - s.viewportH / 2) / (s.viewportH / 2);
  const distSq = nx * nx + ny * ny;
  const positionFactor = Math.max(0.5, 1 - distSq * 0.4);
  const zIndexFactor = 1 + Math.max(-0.1, Math.min(0.1, s.zIndex * 0.001));
  return Math.floor(area * positionFactor * s.opacity * zIndexFactor);
}
