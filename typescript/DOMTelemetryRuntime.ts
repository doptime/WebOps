// src/visual-telemetry/DOMTelemetryRuntime.ts
// [Manifest]
// Role: The Sensing Engine (Phase 3.1)
// Philosophy: "Zero-Code Injection. Semantic Hashing + Spatial Indexing."

import { computeVisualWeight, ElementPhysicalState } from './VisualAttentionModel';
import { TelemetryFrame, AggregatedMetric, FlattenedElementTelemetry } from './TelemetryPayloadSchema';
import { VirtualChannelManager } from './VirtualChannelManager';

// ==========================================
// 1. 高性能空间索引与哈希算法
// ==========================================

function hashSemantic(str: string): string {
    let hash = 2166136261; // FNV-1a 32-bit
    for (let i = 0; i < str.length; i++) {
        hash ^= str.charCodeAt(i);
        hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    }
    return (hash >>> 0).toString(36); // 输出极短的 Base36 字符，如 "m9j2kq"
}

// Morton Code (Z-Order Curve) 1D 降维算法
function getMortonCode2D(x: number, y: number): number {
    // 防止负坐标（将屏幕坐标全部平移至正数域，假设场景不超过 10000x10000）
    x = Math.max(0, Math.min(Math.round(x + 5000), 0xFFFF));
    y = Math.max(0, Math.min(Math.round(y + 5000), 0xFFFF));

    let B = [0x55555555, 0x33333333, 0x0F0F0F0F, 0x00FF00FF];
    let S = [1, 2, 4, 8];

    x = (x | (x << S[3])) & B[3];
    x = (x | (x << S[2])) & B[2];
    x = (x | (x << S[1])) & B[1];
    x = (x | (x << S[0])) & B[0];

    y = (y | (y << S[3])) & B[3];
    y = (y | (y << S[2])) & B[2];
    y = (y | (y << S[1])) & B[1];
    y = (y | (y << S[0])) & B[0];

    return x | (y << 1);
}

// ==========================================
// 2. 实体追踪池 (Entity Tracker)
// ==========================================

interface TrackedElement {
    instanceId: string; // 最终呈现给 LLM 的编排 ID (e.g., m9j2kq_0)
    indexValue: number; // 当前时刻的一维空间定位 (Morton Code)
    semantic: string;
    text: string;

    // 实时物理缓存
    x: number; y: number; w: number; h: number;
    element: HTMLElement;
    lastWeight: number;
}

class EntityTracker {
    // 字典结构：ShortHash -> Array<TrackedElement> (永远按 indexValue 升序排列)
    private pools = new Map<string, TrackedElement[]>();

    public ingest(el: HTMLElement, semantic: string, text: string, x: number, y: number, w: number, h: number): TrackedElement {
        const shortHash = hashSemantic(semantic);
        const currentIndex = getMortonCode2D(x, y);

        if (!this.pools.has(shortHash)) {
            const newEl: TrackedElement = {
                instanceId: `${shortHash}_0`,
                indexValue: currentIndex, x, y, w, h, semantic: shortHash, text, element: el, lastWeight: 0
            };
            this.pools.set(shortHash, [newEl]);
            return newEl;
        }

        const group = this.pools.get(shortHash)!;

        // $O(\log N)$ 二分查找空间最近邻
        const bestMatchIdx = this.binarySearchClosest(group, currentIndex);
        const bestMatch = group[bestMatchIdx];

        // 空间防抖校验：欧式位移距离 < 100px 且 尺寸突变 < 50px
        const distSq = Math.pow(x - bestMatch.x, 2) + Math.pow(y - bestMatch.y, 2);
        const sizeDiff = Math.abs(w - bestMatch.w) + Math.abs(h - bestMatch.h);

        if (distSq < 10000 && sizeDiff < 50) {
            // 完美转世：继承身份
            bestMatch.indexValue = currentIndex;
            bestMatch.x = x; bestMatch.y = y; bestMatch.w = w; bestMatch.h = h;
            bestMatch.element = el;

            // 保证一维数组的稳定性
            group.sort((a, b) => a.indexValue - b.indexValue);
            return bestMatch;
        } else {
            // 基因变异：是一个凭空出现的新同类对象
            const newEl: TrackedElement = {
                instanceId: `${shortHash}_${group.length}`,
                indexValue: currentIndex, x, y, w, h, semantic: shortHash, text, element: el, lastWeight: 0
            };
            group.push(newEl);
            group.sort((a, b) => a.indexValue - b.indexValue);
            return newEl;
        }
    }

    private binarySearchClosest(arr: TrackedElement[], target: number): number {
        let left = 0, right = arr.length - 1;
        while (left < right) {
            let mid = Math.floor((left + right) / 2);
            if (arr[mid].indexValue === target) return mid;
            if (arr[mid].indexValue < target) left = mid + 1;
            else right = mid - 1;
        }
        return left;
    }

    public getAllActive(): TrackedElement[] {
        const active: TrackedElement[] = [];
        for (const group of this.pools.values()) {
            for (const item of group) {
                // 如果元素依然挂载在 DOM 树上，则存活
                if (item.element.isConnected) {
                    active.push(item);
                }
            }
        }
        return active;
    }
}

// ==========================================
// 3. 探针主干 (DOMTelemetryRuntime)
// ==========================================

export class DOMTelemetryRuntime {
    private static instance: DOMTelemetryRuntime;
    private tracker = new EntityTracker();
    private virtualChannel: VirtualChannelManager;

    public onFlush?: (frame: any) => void;

    private isActive: boolean = false;
    private observer: MutationObserver | null = null;
    private rafId: number | null = null;
    private lastFlushTime: number = 0;
    private readonly FLUSH_INTERVAL_MS = 100;

    private constructor() {
        this.virtualChannel = VirtualChannelManager.getInstance();
        this.observer = new MutationObserver(this.handleMutations);
    }

    static getInstance(): DOMTelemetryRuntime {
        if (!DOMTelemetryRuntime.instance) {
            DOMTelemetryRuntime.instance = new DOMTelemetryRuntime();
        }
        return DOMTelemetryRuntime.instance;
    }

    public start() {
        if (this.isActive) return;
        this.isActive = true;

        // 首次加载全量扫描
        this.sniffSalientElements(document.body);

        // 仅监听新增节点，不再监听属性变化引发的性能灾难
        this.observer?.observe(document.body, { childList: true, subtree: true });

        this.lastFlushTime = performance.now();
        this.tick();
    }

    public stop() {
        this.isActive = false;
        if (this.observer) this.observer.disconnect();
        if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    }

    // 💥 [新增核心]：零侵入式 3D 引擎劫持与 2D 降维投影
    hijackReactThreeFiber() {
        const canvas = document.querySelector('canvas');
        if (!canvas) return;

        // 💥 终极破壁：不走 React Fiber 树，直接窃取 R3F 的底层 Three.js 状态机！
        let r3fState = null;

        // 兼容 R3F v8+ 和 v7 版本的状态挂载点
        if (canvas.__r3f && canvas.__r3f.root && typeof canvas.__r3f.root.getState === 'function') {
            r3fState = canvas.__r3f.root.getState();
        } else if (canvas.__r3f && typeof canvas.__r3f.getState === 'function') {
            r3fState = canvas.__r3f.getState();
        }

        // 如果连官方后门都没有，说明 3D 还没初始化完毕
        if (!r3fState || !r3fState.scene || !r3fState.camera) return;

        const scene = r3fState.scene;
        const camera = r3fState.camera;
        const targets = new Map();

        // 放弃 Fiber 遍历，直接使用原生 Three.js API 遍历场景图
        scene.traverse((obj) => {
            // 兼容开发者可能使用 name="rad_火" 或是 userData={{id: "rad_火"}} 的情况
            const nodeId = obj.name || (obj.userData && obj.userData.id);

            if (obj.isObject3D && nodeId && typeof nodeId === 'string') {
                const isSystemNode = nodeId === '' ||
                    nodeId === 'Scene' ||
                    nodeId.startsWith('Object_') ||
                    nodeId.includes('Camera') ||
                    nodeId.includes('Light');

                if (!isSystemNode && !targets.has(nodeId)) {
                    targets.set(nodeId, obj);
                }
            }
        });

        if (targets.size === 0) return;

        const rect = canvas.getBoundingClientRect();

        targets.forEach((obj, id) => {
            if (!obj.position || typeof obj.position.clone !== 'function') return;

            const vector = obj.position.clone();
            if (typeof obj.getWorldPosition === 'function') {
                obj.getWorldPosition(vector);
            }

            // 3D 投影到 2D 屏幕坐标
            vector.project(camera);
            const screenX = Math.round((vector.x * 0.5 + 0.5) * rect.width + rect.left);
            const screenY = Math.round((-(vector.y) * 0.5 + 0.5) * rect.height + rect.top);

            // 高频推入 K 线信道
            this.virtualChannel.pushMetric(id, 'x_pos', screenX);
            this.virtualChannel.pushMetric(id, 'y_pos', screenY);
            this.virtualChannel.pushMetric(id, 'z_pos', vector.z);
        });
    }

    private handleMutations = (mutations: MutationRecord[]) => {
        mutations.forEach(m => {
            if (m.type === 'childList') {
                m.addedNodes.forEach(n => {
                    if (n instanceof HTMLElement) this.sniffSalientElements(n);
                });
            }
        });
    };

    // 🎯 语义嗅探器 (Semantic Extractor)
    private sniffSalientElements(root: HTMLElement) {
        // 只筛选可能具有业务意义的标签或类名
        const candidates = root.querySelectorAll('button, a, input, [class*="entity"], [class*="radical"], [class*="char"], canvas, svg, [aria-label]');

        const tryTag = (el: HTMLElement) => {
            if (el.dataset.ouroborosId) return; // 已被打烙印

            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return; // 剔除微小噪点

            // 1. A11y 优先
            const ariaLabel = el.getAttribute('aria-label');
            if (ariaLabel) return this.registerNode(el, `a11y_${ariaLabel}`, ariaLabel, rect);

            // 2. 文本特征
            const text = el.innerText?.trim().replace(/\n/g, '');
            if (text && text.length > 0 && text.length < 15) {
                return this.registerNode(el, `txt_${text}`, text, rect);
            }

            // 3. 业务 Class 提纯 (Kebab-case 或 CamelCase)
            let businessClass = '';
            if (typeof el.className === 'string') {
                const classes = el.className.split(' ');
                const found = classes.find(c => c.includes('entity') || c.includes('radical') || c.includes('char'));
                if (found) businessClass = found;
            }

            const isSvg = el.tagName.toLowerCase() === 'svg' || el.querySelector('svg') !== null;
            if (isSvg && businessClass) return this.registerNode(el, `svg_${businessClass}`, '', rect);
            if (isSvg) return this.registerNode(el, `svg_graphic`, '', rect);
            if (businessClass) return this.registerNode(el, `ui_${businessClass}`, '', rect);
            if (el.tagName === 'CANVAS') return this.registerNode(el, 'sys_canvas', '', rect);
        };

        if (root.matches && root.matches('button, a, input, [class*="entity"], [class*="radical"], [class*="char"], canvas, svg, [aria-label]')) {
            tryTag(root);
        }
        candidates.forEach(el => tryTag(el as HTMLElement));
    }

    private registerNode(el: HTMLElement, semantic: string, text: string, rect: DOMRect) {
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top + rect.height / 2);

        const tracked = this.tracker.ingest(el, semantic, text, cx, cy, Math.round(rect.width), Math.round(rect.height));

        // 烙印：反向将计算出的确定性 ID 写入 DOM，供 Playwright 抓取
        el.setAttribute('data-ouroboros-id', tracked.instanceId);
    }

    private tick = () => {
        if (!this.isActive) return;

        const vw = window.innerWidth;
        const vh = window.innerHeight;
        const activeElements = this.tracker.getAllActive();

        // 更新物理坐标与计算绝对视觉权重
        activeElements.forEach(item => {
            const rect = item.element.getBoundingClientRect();
            const style = window.getComputedStyle(item.element);

            // 更新缓存坐标
            item.x = Math.round(rect.left + rect.width / 2);
            item.y = Math.round(rect.top + rect.height / 2);
            item.w = Math.round(rect.width);
            item.h = Math.round(rect.height);

            const state: ElementPhysicalState = {
                width: rect.width, height: rect.height, x: rect.left, y: rect.top,
                opacity: parseFloat(style.opacity) || 1,
                zIndex: parseInt(style.zIndex) || 0,
                viewportW: vw, viewportH: vh
            };
            item.lastWeight = computeVisualWeight(state);
        });

        // 💥 [核心新增]：每一帧静默扫描 3D 引擎，产生极其丰富的坐标变动数据
        this.hijackReactThreeFiber();

        const now = performance.now();
        if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
            // 直接传递活动元素的排序数组去执行 Flush
            this.flush(now, activeElements);
            this.lastFlushTime = now;
        }

        this.rafId = requestAnimationFrame(this.tick);
    };

    private flush(ts: number, activeElements: TrackedElement[]) {
        const payload: TelemetryFrame = {
            ts: Math.floor(ts),
            dur: this.FLUSH_INTERVAL_MS,
            sources: [],
            data: {}
        };

        let hasDomData = false;

        // 依据注意力权重进行全局排行榜排序
        activeElements.sort((a, b) => b.lastWeight - a.lastWeight);

        activeElements.forEach((item, index) => {
            if (item.lastWeight > 0) {
                hasDomData = true;
                // 拍平输出
                payload.data[item.instanceId] = {
                    semantic: item.semantic,
                    x: item.x,
                    y: item.y,
                    w: item.w,
                    h: item.h,
                    rank: index + 1,
                    ...(item.text ? { text: item.text } : {})
                };
            }
        });

        if (hasDomData) payload.sources.push('dom');

        const vData = this.virtualChannel.harvest();
        if (Object.keys(vData).length > 0) {
            payload.sources.push('virtual');
            for (const [tid, metrics] of Object.entries(vData)) {
                if (!payload.data[tid]) {
                    // 若逻辑信道传来了没有物理实体的游离数据，单独挂载
                    payload.data[tid] = { semantic: 'virtual_node', x: 0, y: 0, w: 0, h: 0, rank: 999 };
                }
                payload.data[tid].a = metrics;
            }
        }

        if (payload.sources.length > 0 && this.onFlush) {
            this.onFlush(payload);
        }
    }
}