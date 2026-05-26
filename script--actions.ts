// script/actions.ts
// 动作执行器 — 把 StepIR 翻译为浏览器事件。
// V3 中这部分逻辑在 TimelineExecutor 里。V4 把它拆出来,让 SessionRunner 直接调用。

import { TargetSpec, Strategy } from './script--Script';
import { VirtualChannel } from './core--virtual-channel';

// V4.1: 删除手写三阶贝塞尔 + 拟人轨迹。
//   本工具是第一方内部审计器(headless chromedp 跑自家游戏),没有反爬对抗需求。
//   humanLikePath 的控制点掺了 Math.random(),对审计而言随机抖动是在主动破坏可复现性。
//   一切移动统一走确定性 linearPath:既可复现,又仍逐点派发 pointermove,
//   让游戏侧的 hover / drag 监听照样被触发。
function linearPath(sx: number, sy: number, ex: number, ey: number, steps: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    out.push({ x: sx + (ex - sx) * (i / steps), y: sy + (ey - sy) * (i / steps) });
  }
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ActionDispatcher {
  private cursorX = 0;
  private cursorY = 0;
  private isMouseDown = false;
  private vc: VirtualChannel;

  constructor(virtualChannel: VirtualChannel) {
    this.vc = virtualChannel;
    // V4.1: 不再在构造期向 document 挂全局 mousemove 监听。
    //   原监听只为捕获"真人"光标位置,但 headless 审计里没有真人,
    //   光标位置完全由 moveCursor / dispatch 自己维护。该监听是纯死重,
    //   且因从不注销,在多 tab 反复冷启动场景下是潜在泄漏源。
  }

  resolve(target: TargetSpec): { x: number; y: number } | null {
    if (typeof target === 'object' && 'x' in target && 'y' in target) {
      return { x: target.x, y: target.y };
    }
    let selector: string | null = null;
    if (typeof target === 'string') {
      selector = target.startsWith('[') || target.startsWith('.') || target.startsWith('#')
        ? target
        : `[data-vt-id="${target}"]`;
    } else if ('vtId' in target) {
      selector = `[data-vt-id="${target.vtId}"]`;
    } else if ('selector' in target) {
      selector = target.selector;
    }
    if (!selector) return null;
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  async moveCursor(to: { x: number; y: number }, strategy: Strategy): Promise<void> {
    if (strategy === 'instant') {
      this.dispatch('mousemove', to.x, to.y);
      this.cursorX = to.x;
      this.cursorY = to.y;
      return;
    }
    const path = linearPath(this.cursorX, this.cursorY, to.x, to.y, 20);
    for (const p of path) {
      this.dispatch('mousemove', p.x, p.y);
      this.cursorX = p.x;
      this.cursorY = p.y;
      await sleep(16);
    }
  }

  async click(target: TargetSpec, strategy: Strategy, mode: 'pointer' | 'native' = 'pointer'): Promise<boolean> {
    const pos = this.resolve(target);
    if (!pos) return false;
    await this.moveCursor(pos, strategy);

    if (mode === 'native' && typeof target === 'string') {
      // 直接调 DOM .click(),跳过 PointerEvent —— 适合普通 button
      const sel = target.startsWith('[') || target.startsWith('.') || target.startsWith('#')
        ? target : `[data-vt-id="${target}"]`;
      const el = document.querySelector<HTMLElement>(sel);
      if (el) { el.click(); this.vc.pushMetric('__input__', 'click', 1); return true; }
    }

    this.isMouseDown = true;
    this.dispatch('mousedown', pos.x, pos.y);
    this.isMouseDown = false;
    this.dispatch('mouseup', pos.x, pos.y);
    this.dispatch('click', pos.x, pos.y);
    this.vc.pushMetric('__input__', 'click', 1);
    return true;
  }

  async drag(from: TargetSpec, to: TargetSpec, durationMs = 500, strategy: Strategy = 'human_like'): Promise<boolean> {
    const a = this.resolve(from);
    const b = this.resolve(to);
    if (!a || !b) return false;
    await this.moveCursor(a, strategy);
    this.isMouseDown = true;
    this.dispatch('mousedown', a.x, a.y);
    const steps = Math.max(10, Math.floor(durationMs / 16));
    // strategy 仍保留在签名里以兼容 Script DSL,但路径恒为确定性 linear。
    const path = linearPath(a.x, a.y, b.x, b.y, steps);
    for (const p of path) {
      this.dispatch('mousemove', p.x, p.y);
      this.cursorX = p.x;
      this.cursorY = p.y;
      await sleep(16);
    }
    this.isMouseDown = false;
    this.dispatch('mouseup', this.cursorX, this.cursorY);
    return true;
  }

  async type(text: string, clearFirst: boolean, strategy: Strategy): Promise<boolean> {
    const el = document.activeElement as HTMLInputElement | null;
    if (!el || typeof el.value === 'undefined') return false;
    if (clearFirst) el.value = '';
    for (const ch of text) {
      el.value += ch;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      if (strategy === 'human_like') await sleep(50 + Math.random() * 80);
    }
    return true;
  }

  /** 派发 keydown + keyup,适合像 SortingChaos 那样的 a/s/d 按键玩法。 */
  key(key: string): boolean {
    const target = document.activeElement || document.body;
    const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    this.vc.pushMetric('__input__', 'key', 1);
    return true;
  }

  private dispatch(type: string, x: number, y: number): void {
    const el = document.elementFromPoint(x, y) || document.body;
    const map: Record<string, string> = {
      mousedown: 'pointerdown',
      mouseup: 'pointerup',
      mousemove: 'pointermove',
      click: 'click'
    };
    const pType = map[type] || type;
    const buttons = this.isMouseDown ? 1 : 0;
    const button = type === 'mousemove' ? -1 : 0;
    const init: PointerEventInit = {
      bubbles: true, cancelable: true,
      clientX: x, clientY: y, view: window,
      pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button, buttons
    };
    el.dispatchEvent(new PointerEvent(pType, init));
    if (pType !== type && type !== 'click') {
      el.dispatchEvent(new MouseEvent(type, init));
    }
    if (type === 'mousemove') {
      this.vc.pushBatch('__cursor__', { x, y });
    }
  }
}
