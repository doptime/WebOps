// core/r3f-bridge.ts
// React Three Fiber 桥接 — 把 3D 场景中的对象投影成 VirtualChannel 信号。
//
// 工作原理:从 canvas.__r3f.root.getState() 拿到 scene 和 camera,
//          遍历有名字的 Object3D,把世界坐标 project 到屏幕坐标,
//          作为 x/y/z 三个 K 线信号推到 VirtualChannel。

import { VirtualChannel } from './core--virtual-channel';

/** 哪些对象是 R3F 自动生成的"系统节点",应该跳过。 */
function isSystemNode(name: string): boolean {
  return !name
    || name === 'Scene'
    || name.startsWith('Object_')
    || name.includes('Camera')
    || name.includes('Light');
}

export class R3FBridge {
  private virtualChannel: VirtualChannel;
  private idPrefix: string;

  constructor(virtualChannel: VirtualChannel, idPrefix = 'r3f') {
    this.virtualChannel = virtualChannel;
    this.idPrefix = idPrefix;
  }

  /** 单帧采样 — 由 SessionRunner 驱动,不存在则空操作。 */
  sample(): void {
    if (typeof document === 'undefined') return;
    const canvases = document.querySelectorAll('canvas');
    if (canvases.length === 0) return;

    for (const canvas of Array.from(canvases)) {
      const r3f = (canvas as any).__r3f;
      if (!r3f) continue;
      const state = r3f.root?.getState?.() ?? r3f.getState?.();
      if (!state?.scene || !state?.camera) continue;

      const rect = canvas.getBoundingClientRect();
      const scene = state.scene;
      const camera = state.camera;

      scene.traverse((obj: any) => {
        if (!obj.isObject3D) return;
        const name: string = obj.name || obj.userData?.id || '';
        if (isSystemNode(name)) return;
        if (typeof obj.getWorldPosition !== 'function') return;

        const v = obj.position.clone();
        obj.getWorldPosition(v);
        v.project(camera);

        const sx = Math.round((v.x * 0.5 + 0.5) * rect.width + rect.left);
        const sy = Math.round((-v.y * 0.5 + 0.5) * rect.height + rect.top);

        const id = `${this.idPrefix}:${name}`;
        this.virtualChannel.pushBatch(id, { sx, sy, sz: v.z });

        // 如果对象有 userData.signals,把它们一起推过来 — 业务可控
        if (obj.userData?.signals && typeof obj.userData.signals === 'object') {
          for (const [k, val] of Object.entries(obj.userData.signals)) {
            if (typeof val === 'number') this.virtualChannel.pushMetric(id, k, val);
          }
        }
      });
    }
  }
}
