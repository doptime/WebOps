// core/dom-telemetry.ts
// DOM 探针 — 60fps 物理采样，结合视觉权重和 Rank 排序。
//
// V4 改动：
//   - 不再独立 RAF，sample() 由 SessionRunner 在统一时钟下驱动。
//   - 收紧到声明式 (data-vt-id) 模式：避免 V3 的 "smart sniffer" 在复杂 R3F 场景误识别。
//   - 渲染不可见时 (rect 全 0) 仍保留 registry 条目，不再误删 — 因为 R3F 元素短暂出场是正常的。

import { computeVisualWeight } from './core--visual-attention';
import { AggregatedMetric, emptyMetric, pushValue } from './core--kline';
import { VirtualChannel } from './core--virtual-channel';

export interface DOMNode {
  element: HTMLElement;
  watchedAttrs: string[];
  bufferWeight: AggregatedMetric;
  bufferRank: AggregatedMetric;
  bufferAttrs: Record<string, AggregatedMetric>;
  bufferPos: { x: AggregatedMetric; y: AggregatedMetric };
}

export interface DOMSnapshot {
  /** 当前帧每个 vt-id 的 K 线快照（之后会被 harvest 清空翻页）。 */
  nodes: Record<string, {
    weight: AggregatedMetric;
    rank: AggregatedMetric;
    pos: { x: AggregatedMetric; y: AggregatedMetric };
    attrs?: Record<string, AggregatedMetric>;
  }>;
}

export class DOMTelemetry {
  private registry = new Map<string, DOMNode>();
  private observer: MutationObserver;
  private active = false;
  private virtualChannel: VirtualChannel;

  constructor(virtualChannel: VirtualChannel) {
    this.virtualChannel = virtualChannel;
    this.observer = new MutationObserver(this.handleMutations);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.scanRoot(document.body);
    this.observer.observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['data-vt-id', 'data-vt-watch']
    });
  }

  stop(): void {
    this.active = false;
    this.observer.disconnect();
    this.registry.clear();
  }

  /** 单帧采样 — 由 SessionRunner 在 RAF 循环内调用。 */
  sample(): void {
    if (!this.active) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const visible: { id: string; weight: number }[] = [];

    for (const [id, ctx] of this.registry.entries()) {
      if (!ctx.element.isConnected) {
        this.registry.delete(id);
        continue;
      }
      const rect = ctx.element.getBoundingClientRect();
      const style = window.getComputedStyle(ctx.element);
      const opacity = parseFloat(style.opacity || '1');
      const zIndex = parseInt(style.zIndex || '0', 10) || 0;
      const weight = computeVisualWeight({
        width: rect.width, height: rect.height,
        x: rect.x, y: rect.y,
        opacity, zIndex,
        viewportW: vw, viewportH: vh
      });
      visible.push({ id, weight });

      // 位置 K 线
      pushValue(ctx.bufferPos.x, rect.left + rect.width / 2);
      pushValue(ctx.bufferPos.y, rect.top + rect.height / 2);

      // 监控属性
      for (const attr of ctx.watchedAttrs) {
        let v = 0;
        if (attr === 'rotation') v = this.parseRotation(style.transform);
        else if (attr === 'scale') v = this.parseScale(style.transform);
        else if (attr === 'width') v = rect.width;
        else if (attr === 'height') v = rect.height;
        else v = parseFloat(style[attr as keyof CSSStyleDeclaration] as string) || 0;
        if (!ctx.bufferAttrs[attr]) ctx.bufferAttrs[attr] = emptyMetric();
        pushValue(ctx.bufferAttrs[attr], v);
      }
    }

    // 排序得到 Rank
    visible.sort((a, b) => b.weight - a.weight);
    visible.forEach((item, idx) => {
      const ctx = this.registry.get(item.id);
      if (!ctx) return;
      pushValue(ctx.bufferWeight, item.weight);
      pushValue(ctx.bufferRank, item.weight > 0 ? idx + 1 : -1);
    });
  }

  /** 收割并翻页 — 与 VirtualChannel 一致的语义。 */
  harvest(): DOMSnapshot {
    const snap: DOMSnapshot = { nodes: {} };
    for (const [id, ctx] of this.registry.entries()) {
      const node: DOMSnapshot['nodes'][string] = {
        weight: { ...ctx.bufferWeight },
        rank: { ...ctx.bufferRank },
        pos: { x: { ...ctx.bufferPos.x }, y: { ...ctx.bufferPos.y } }
      };
      if (ctx.watchedAttrs.length > 0) {
        node.attrs = {};
        for (const a of ctx.watchedAttrs) {
          node.attrs[a] = { ...ctx.bufferAttrs[a] };
          ctx.bufferAttrs[a] = emptyMetric();
        }
      }
      snap.nodes[id] = node;
      ctx.bufferWeight = emptyMetric();
      ctx.bufferRank = emptyMetric();
      ctx.bufferPos = { x: emptyMetric(), y: emptyMetric() };
    }
    return snap;
  }

  /** 主动注册一个外部追踪点（如 R3F 的 invisible-tracker）。 */
  register(id: string, element: HTMLElement, watch: string[] = []): void {
    if (this.registry.has(id)) return;
    this.registry.set(id, {
      element,
      watchedAttrs: watch,
      bufferWeight: emptyMetric(),
      bufferRank: emptyMetric(),
      bufferAttrs: Object.fromEntries(watch.map((a) => [a, emptyMetric()])),
      bufferPos: { x: emptyMetric(), y: emptyMetric() }
    });
  }

  private handleMutations = (mutations: MutationRecord[]) => {
    for (const m of mutations) {
      if (m.type === 'childList') {
        m.addedNodes.forEach((n) => n instanceof HTMLElement && this.scanRoot(n));
        m.removedNodes.forEach((n) => n instanceof HTMLElement && this.unregisterTree(n));
      } else if (m.type === 'attributes' && m.target instanceof HTMLElement) {
        this.tryRegister(m.target);
      }
    }
  };

  private scanRoot(root: HTMLElement): void {
    if (root.dataset?.vtId) this.tryRegister(root);
    root.querySelectorAll<HTMLElement>('[data-vt-id]').forEach((el) => this.tryRegister(el));
  }

  private tryRegister(el: HTMLElement): void {
    const id = el.dataset.vtId;
    if (!id) return;
    const watch = el.dataset.vtWatch?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
    const existing = this.registry.get(id);
    if (existing) {
      existing.element = el;
      existing.watchedAttrs = watch;
      return;
    }
    this.registry.set(id, {
      element: el,
      watchedAttrs: watch,
      bufferWeight: emptyMetric(),
      bufferRank: emptyMetric(),
      bufferAttrs: Object.fromEntries(watch.map((a) => [a, emptyMetric()])),
      bufferPos: { x: emptyMetric(), y: emptyMetric() }
    });
  }

  private unregisterTree(node: HTMLElement): void {
    const id = node.dataset?.vtId;
    if (id) this.registry.delete(id);
    node.querySelectorAll<HTMLElement>('[data-vt-id]').forEach((el) => {
      const subId = el.dataset.vtId;
      if (subId) this.registry.delete(subId);
    });
  }

  /** 把 computed transform 解析成 DOMMatrix。'none' / 解析失败 → 单位矩阵。
   *  原生 DOMMatrix 由浏览器 C++ 解析，天然兼容 matrix3d，
   *  不会像手写 split(',') 那样在 3D 变换（R3F 常态）下取错分量或崩。 */
  private toMatrix(t?: string): DOMMatrix {
    if (!t || t === 'none') return new DOMMatrix();
    try {
      return new DOMMatrix(t);
    } catch {
      return new DOMMatrix();
    }
  }

  /** 旋转角（度，整数）— 等价于 atan2(b, a)。 */
  private parseRotation(t?: string): number {
    const m = this.toMatrix(t);
    return Math.round(Math.atan2(m.b, m.a) * (180 / Math.PI));
  }

  /** X 轴缩放系数 — 等价于 hypot(a, b)。scale(0) 会如实返回 0。 */
  private parseScale(t?: string): number {
    const m = this.toMatrix(t);
    return Math.hypot(m.a, m.b);
  }
}
