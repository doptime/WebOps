// script/actions.ts  (V6)
// 动作执行器 — 把 StepIR 翻译为浏览器事件。
//
// V6 唯一改动:不再向 VirtualChannel 推 __input__/__cursor__ 数值 K 线
// (那是给文本 LLM 的数值轨道,已随 K 线一起取消)。改为向 EventSink 记一条
// 带毫秒时间戳的输入事件,作为多模态模型对齐视频帧的时间锚。
// 派发逻辑(linearPath / PointerEvent / KeyboardEvent)与 V4.1 完全一致。

import { TargetSpec, Strategy } from './script--Script';
import { EventSink } from './core--event-sink';

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
  private sink: EventSink;

  constructor(sink: EventSink) {
    this.sink = sink;
  }

  resolve(target: TargetSpec): { x: number; y: number; el: Element | null } | null {
    if (typeof target === 'object' && 'x' in target && 'y' in target) {
      return { x: target.x, y: target.y, el: null };
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
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, el };
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
      const sel = target.startsWith('[') || target.startsWith('.') || target.startsWith('#')
        ? target : `[data-vt-id="${target}"]`;
      const el = document.querySelector<HTMLElement>(sel);
      if (el) { el.click(); this.sink.push('click', String(target), { detail: pos }); return true; }
    }

    this.isMouseDown = true;
    this.dispatch('mousedown', pos.x, pos.y, pos.el);
    this.isMouseDown = false;
    this.dispatch('mouseup', pos.x, pos.y, pos.el);
    this.dispatch('click', pos.x, pos.y, pos.el);
    this.sink.push('click', targetName(target), { detail: pos });
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
    const path = linearPath(a.x, a.y, b.x, b.y, steps);
    for (const p of path) {
      this.dispatch('mousemove', p.x, p.y);
      this.cursorX = p.x;
      this.cursorY = p.y;
      await sleep(16);
    }
    this.isMouseDown = false;
    this.dispatch('mouseup', this.cursorX, this.cursorY);
    this.sink.push('drag', `${targetName(from)}→${targetName(to)}`, { detail: { from: a, to: b } });
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
    this.sink.push('type', text.slice(0, 24));
    return true;
  }

  key(key: string): boolean {
    const target = document.activeElement || document.body;
    const init: KeyboardEventInit = { key, bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent('keydown', init));
    target.dispatchEvent(new KeyboardEvent('keyup', init));
    this.sink.push('key', key);
    return true;
  }

  private dispatch(type: string, x: number, y: number, targetEl?: Element | null): void {
    const el = targetEl || document.elementFromPoint(x, y) || document.body;
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
      this.sink.push('cursor', 'move', { detail: { x, y } }); // 默认被 EventSink 丢弃
    }
  }
}

function targetName(t: TargetSpec): string {
  if (typeof t === 'string') return t;
  if ('vtId' in t) return t.vtId;
  if ('selector' in t) return t.selector;
  return `(${t.x},${t.y})`;
}
