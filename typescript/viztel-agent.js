// webops/typescript/VisualAttentionModel.ts
function computeVisualWeight(state) {
  const { width, height, x, y, opacity, zIndex, viewportW, viewportH } = state;
  if (width <= 0 || height <= 0 || opacity <= 0)
    return 0;
  const area = width * height;
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const normX = (centerX - viewportW / 2) / (viewportW / 2);
  const normY = (centerY - viewportH / 2) / (viewportH / 2);
  const distSquared = normX * normX + normY * normY;
  const positionFactor = Math.max(0.5, 1 - distSquared * 0.4);
  const zIndexFactor = 1 + Math.max(-0.1, Math.min(0.1, zIndex * 0.001));
  return Math.floor(area * positionFactor * opacity * zIndexFactor);
}

// webops/typescript/VirtualChannelManager.ts
class VirtualChannelManager {
  static instance;
  signals = new Map;
  pendingFrames = [];
  MAX_PENDING = 200;
  onFlush;
  FLUSH_INTERVAL_MS = 100;
  lastFlushTime = 0;
  isActive = false;
  rafId = null;
  constructor() {}
  static getInstance() {
    if (!VirtualChannelManager.instance) {
      VirtualChannelManager.instance = new VirtualChannelManager;
    }
    return VirtualChannelManager.instance;
  }
  pushMetric(targetId, metricKey, value) {
    const compositeKey = `${targetId}:${metricKey}`;
    let ctx = this.signals.get(compositeKey);
    if (!ctx) {
      ctx = { buffer: this.createEmptyMetric(), lastUpdateTime: performance.now() };
      this.signals.set(compositeKey, ctx);
    }
    this.updateMetric(ctx.buffer, value);
    ctx.lastUpdateTime = performance.now();
  }
  pushBatch(targetId, metrics) {
    for (const [key, val] of Object.entries(metrics)) {
      this.pushMetric(targetId, key, val);
    }
  }
  pushAggregated(targetId, metricKey, metric) {
    const compositeKey = `${targetId}:${metricKey}`;
    this.signals.set(compositeKey, {
      buffer: { ...metric },
      lastUpdateTime: performance.now()
    });
  }
  harvest() {
    const result = {};
    const now = performance.now();
    for (const [compositeKey, ctx] of this.signals.entries()) {
      if (ctx.buffer.o === null) {
        if (now - ctx.lastUpdateTime > 5000) {
          this.signals.delete(compositeKey);
        }
        continue;
      }
      const [targetId, metricKey] = this.parseCompositeKey(compositeKey);
      if (!result[targetId])
        result[targetId] = {};
      result[targetId][metricKey] = { ...ctx.buffer };
      ctx.buffer = {
        o: ctx.buffer.c,
        h: ctx.buffer.c,
        l: ctx.buffer.c,
        c: ctx.buffer.c
      };
    }
    return result;
  }
  startStandalone() {
    if (this.isActive)
      return;
    this.isActive = true;
    this.lastFlushTime = performance.now();
    this.tickStandalone();
  }
  stopStandalone() {
    this.isActive = false;
    if (this.rafId !== null)
      cancelAnimationFrame(this.rafId);
    this.signals.clear();
  }
  tickStandalone = () => {
    if (!this.isActive)
      return;
    const now = performance.now();
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      this.flushStandalone(now);
      this.lastFlushTime = now;
    }
    this.rafId = requestAnimationFrame(this.tickStandalone);
  };
  flushStandalone(timestamp) {
    const harvested = this.harvest();
    if (Object.keys(harvested).length === 0)
      return;
    const payload = {
      ts: Math.floor(timestamp),
      sources: ["virtual"],
      data: {}
    };
    for (const [targetId, metrics] of Object.entries(harvested)) {
      payload.data[targetId] = { a: metrics };
    }
    this.send(payload);
  }
  send(payloadObj) {
    if (this.onFlush) {
      while (this.pendingFrames.length > 0) {
        const pending = this.pendingFrames.shift();
        if (pending)
          this.onFlush(pending);
      }
      this.onFlush(payloadObj);
    } else {
      if (this.pendingFrames.length >= this.MAX_PENDING) {
        this.pendingFrames.shift();
      }
      this.pendingFrames.push(payloadObj);
    }
  }
  updateMetric(metric, value) {
    if (metric.o === null) {
      metric.o = metric.h = metric.l = metric.c = value;
    } else {
      metric.c = value;
      if (value > metric.h)
        metric.h = value;
      if (value < metric.l)
        metric.l = value;
    }
  }
  createEmptyMetric() {
    return { o: null, h: null, l: null, c: null };
  }
  parseCompositeKey(key) {
    const lastIdx = key.lastIndexOf(":");
    return [key.substring(0, lastIdx), key.substring(lastIdx + 1)];
  }
}
var virtualChannel = VirtualChannelManager.getInstance();

// webops/typescript/DOMTelemetryRuntime.ts
function hashSemantic(str) {
  let hash = 2166136261;
  for (let i = 0;i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(36);
}
function getMortonCode2D(x, y) {
  x = Math.max(0, Math.min(Math.round(x + 5000), 65535));
  y = Math.max(0, Math.min(Math.round(y + 5000), 65535));
  let B = [1431655765, 858993459, 252645135, 16711935];
  let S = [1, 2, 4, 8];
  x = (x | x << S[3]) & B[3];
  x = (x | x << S[2]) & B[2];
  x = (x | x << S[1]) & B[1];
  x = (x | x << S[0]) & B[0];
  y = (y | y << S[3]) & B[3];
  y = (y | y << S[2]) & B[2];
  y = (y | y << S[1]) & B[1];
  y = (y | y << S[0]) & B[0];
  return x | y << 1;
}

class EntityTracker {
  pools = new Map;
  ingest(el, semantic, text, x, y, w, h) {
    const shortHash = hashSemantic(semantic);
    const currentIndex = getMortonCode2D(x, y);
    if (!this.pools.has(shortHash)) {
      const newEl = {
        instanceId: `${shortHash}_0`,
        indexValue: currentIndex,
        x,
        y,
        w,
        h,
        semantic: shortHash,
        text,
        element: el,
        lastWeight: 0
      };
      this.pools.set(shortHash, [newEl]);
      return newEl;
    }
    const group = this.pools.get(shortHash);
    const bestMatchIdx = this.binarySearchClosest(group, currentIndex);
    const bestMatch = group[bestMatchIdx];
    const distSq = Math.pow(x - bestMatch.x, 2) + Math.pow(y - bestMatch.y, 2);
    const sizeDiff = Math.abs(w - bestMatch.w) + Math.abs(h - bestMatch.h);
    if (distSq < 1e4 && sizeDiff < 50) {
      bestMatch.indexValue = currentIndex;
      bestMatch.x = x;
      bestMatch.y = y;
      bestMatch.w = w;
      bestMatch.h = h;
      bestMatch.element = el;
      group.sort((a, b) => a.indexValue - b.indexValue);
      return bestMatch;
    } else {
      const newEl = {
        instanceId: `${shortHash}_${group.length}`,
        indexValue: currentIndex,
        x,
        y,
        w,
        h,
        semantic: shortHash,
        text,
        element: el,
        lastWeight: 0
      };
      group.push(newEl);
      group.sort((a, b) => a.indexValue - b.indexValue);
      return newEl;
    }
  }
  binarySearchClosest(arr, target) {
    let left = 0, right = arr.length - 1;
    while (left < right) {
      let mid = Math.floor((left + right) / 2);
      if (arr[mid].indexValue === target)
        return mid;
      if (arr[mid].indexValue < target)
        left = mid + 1;
      else
        right = mid - 1;
    }
    return left;
  }
  getAllActive() {
    const active = [];
    for (const group of this.pools.values()) {
      for (const item of group) {
        if (item.element.isConnected) {
          active.push(item);
        }
      }
    }
    return active;
  }
}

class DOMTelemetryRuntime {
  static instance;
  tracker = new EntityTracker;
  virtualChannel;
  onFlush;
  isActive = false;
  observer = null;
  rafId = null;
  lastFlushTime = 0;
  FLUSH_INTERVAL_MS = 100;
  constructor() {
    this.virtualChannel = VirtualChannelManager.getInstance();
    this.observer = new MutationObserver(this.handleMutations);
  }
  static getInstance() {
    if (!DOMTelemetryRuntime.instance) {
      DOMTelemetryRuntime.instance = new DOMTelemetryRuntime;
    }
    return DOMTelemetryRuntime.instance;
  }
  start() {
    if (this.isActive)
      return;
    this.isActive = true;
    this.sniffSalientElements(document.body);
    this.observer?.observe(document.body, { childList: true, subtree: true });
    this.lastFlushTime = performance.now();
    this.tick();
  }
  stop() {
    this.isActive = false;
    if (this.observer)
      this.observer.disconnect();
    if (this.rafId !== null)
      cancelAnimationFrame(this.rafId);
  }
  hijackReactThreeFiber() {
    const canvas = document.querySelector("canvas");
    if (!canvas)
      return;
    let r3fState = null;
    if (canvas.__r3f && canvas.__r3f.root && typeof canvas.__r3f.root.getState === "function") {
      r3fState = canvas.__r3f.root.getState();
    } else if (canvas.__r3f && typeof canvas.__r3f.getState === "function") {
      r3fState = canvas.__r3f.getState();
    }
    if (!r3fState || !r3fState.scene || !r3fState.camera)
      return;
    const scene = r3fState.scene;
    const camera = r3fState.camera;
    const targets = new Map;
    scene.traverse((obj) => {
      const nodeId = obj.name || obj.userData && obj.userData.id;
      if (obj.isObject3D && nodeId && typeof nodeId === "string") {
        const isSystemNode = nodeId === "" || nodeId === "Scene" || nodeId.startsWith("Object_") || nodeId.includes("Camera") || nodeId.includes("Light");
        if (!isSystemNode && !targets.has(nodeId)) {
          targets.set(nodeId, obj);
        }
      }
    });
    if (targets.size === 0)
      return;
    const rect = canvas.getBoundingClientRect();
    targets.forEach((obj, id) => {
      if (!obj.position || typeof obj.position.clone !== "function")
        return;
      const vector = obj.position.clone();
      if (typeof obj.getWorldPosition === "function") {
        obj.getWorldPosition(vector);
      }
      vector.project(camera);
      const screenX = Math.round((vector.x * 0.5 + 0.5) * rect.width + rect.left);
      const screenY = Math.round((-vector.y * 0.5 + 0.5) * rect.height + rect.top);
      this.virtualChannel.pushMetric(id, "x_pos", screenX);
      this.virtualChannel.pushMetric(id, "y_pos", screenY);
      this.virtualChannel.pushMetric(id, "z_pos", vector.z);
    });
  }
  handleMutations = (mutations) => {
    mutations.forEach((m) => {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => {
          if (n instanceof HTMLElement)
            this.sniffSalientElements(n);
        });
      }
    });
  };
  sniffSalientElements(root) {
    const candidates = root.querySelectorAll('button, a, input, [class*="entity"], [class*="radical"], [class*="char"], canvas, svg, [aria-label]');
    const tryTag = (el) => {
      if (el.dataset.ouroborosId)
        return;
      const rect = el.getBoundingClientRect();
      if (rect.width < 5 || rect.height < 5)
        return;
      const ariaLabel = el.getAttribute("aria-label");
      if (ariaLabel)
        return this.registerNode(el, `a11y_${ariaLabel}`, ariaLabel, rect);
      const text = el.innerText?.trim().replace(/\n/g, "");
      if (text && text.length > 0 && text.length < 15) {
        return this.registerNode(el, `txt_${text}`, text, rect);
      }
      let businessClass = "";
      if (typeof el.className === "string") {
        const classes = el.className.split(" ");
        const found = classes.find((c) => c.includes("entity") || c.includes("radical") || c.includes("char"));
        if (found)
          businessClass = found;
      }
      const isSvg = el.tagName.toLowerCase() === "svg" || el.querySelector("svg") !== null;
      if (isSvg && businessClass)
        return this.registerNode(el, `svg_${businessClass}`, "", rect);
      if (isSvg)
        return this.registerNode(el, `svg_graphic`, "", rect);
      if (businessClass)
        return this.registerNode(el, `ui_${businessClass}`, "", rect);
      if (el.tagName === "CANVAS")
        return this.registerNode(el, "sys_canvas", "", rect);
    };
    if (root.matches && root.matches('button, a, input, [class*="entity"], [class*="radical"], [class*="char"], canvas, svg, [aria-label]')) {
      tryTag(root);
    }
    candidates.forEach((el) => tryTag(el));
  }
  registerNode(el, semantic, text, rect) {
    const cx = Math.round(rect.left + rect.width / 2);
    const cy = Math.round(rect.top + rect.height / 2);
    const tracked = this.tracker.ingest(el, semantic, text, cx, cy, Math.round(rect.width), Math.round(rect.height));
    el.setAttribute("data-ouroboros-id", tracked.instanceId);
  }
  tick = () => {
    if (!this.isActive)
      return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const activeElements = this.tracker.getAllActive();
    activeElements.forEach((item) => {
      const rect = item.element.getBoundingClientRect();
      const style = window.getComputedStyle(item.element);
      item.x = Math.round(rect.left + rect.width / 2);
      item.y = Math.round(rect.top + rect.height / 2);
      item.w = Math.round(rect.width);
      item.h = Math.round(rect.height);
      const state = {
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        opacity: parseFloat(style.opacity) || 1,
        zIndex: parseInt(style.zIndex) || 0,
        viewportW: vw,
        viewportH: vh
      };
      item.lastWeight = computeVisualWeight(state);
    });
    this.hijackReactThreeFiber();
    const now = performance.now();
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      this.flush(now, activeElements);
      this.lastFlushTime = now;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
  flush(ts, activeElements) {
    const payload = {
      ts: Math.floor(ts),
      dur: this.FLUSH_INTERVAL_MS,
      sources: [],
      data: {}
    };
    let hasDomData = false;
    activeElements.sort((a, b) => b.lastWeight - a.lastWeight);
    activeElements.forEach((item, index) => {
      if (item.lastWeight > 0) {
        hasDomData = true;
        payload.data[item.instanceId] = {
          semantic: item.semantic,
          x: item.x,
          y: item.y,
          w: item.w,
          h: item.h,
          rank: index + 1,
          ...item.text ? { text: item.text } : {}
        };
      }
    });
    if (hasDomData)
      payload.sources.push("dom");
    const vData = this.virtualChannel.harvest();
    if (Object.keys(vData).length > 0) {
      payload.sources.push("virtual");
      for (const [tid, metrics] of Object.entries(vData)) {
        if (!payload.data[tid]) {
          payload.data[tid] = { semantic: "virtual_node", x: 0, y: 0, w: 0, h: 0, rank: 999 };
        }
        payload.data[tid].a = metrics;
      }
    }
    if (payload.sources.length > 0 && this.onFlush) {
      this.onFlush(payload);
    }
  }
}

// webops/typescript/AudioTelemetryRuntime.ts
class AudioTelemetryRuntime {
  static instance;
  context = null;
  analyser = null;
  dataArray = null;
  isActive = false;
  rafId = null;
  FFT_SIZE = 256;
  FLUSH_INTERVAL_MS = 100;
  lastFlushTime = 0;
  bufferRMS;
  bufferPeak;
  constructor() {
    this.bufferRMS = this.createEmptyMetric();
    this.bufferPeak = this.createEmptyMetric();
  }
  static getInstance() {
    if (!AudioTelemetryRuntime.instance) {
      AudioTelemetryRuntime.instance = new AudioTelemetryRuntime;
    }
    return AudioTelemetryRuntime.instance;
  }
  attach(ctx, sourceNode) {
    if (this.context === ctx)
      return;
    this.context = ctx;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = this.FFT_SIZE;
    this.dataArray = new Uint8Array(this.analyser.frequencyBinCount);
    if (sourceNode) {
      sourceNode.connect(this.analyser);
    } else {
      console.warn("[WebOps] AudioRuntime needs a source node (e.g., MasterGain) to attach.");
    }
  }
  start() {
    if (this.isActive)
      return;
    this.isActive = true;
    this.loop();
  }
  stop() {
    this.isActive = false;
    if (this.rafId)
      cancelAnimationFrame(this.rafId);
  }
  loop = () => {
    if (!this.isActive || !this.analyser || !this.dataArray)
      return;
    this.analyser.getByteFrequencyData(this.dataArray);
    let sum = 0;
    let peak = 0;
    const len = this.dataArray.length;
    for (let i = 0;i < len; i++) {
      const val = this.dataArray[i] / 255;
      sum += val * val;
      if (val > peak)
        peak = val;
    }
    const rms = Math.sqrt(sum / len);
    this.updateMetric(this.bufferRMS, rms);
    this.updateMetric(this.bufferPeak, peak);
    const now = performance.now();
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      this.flush();
      this.lastFlushTime = now;
    }
    this.rafId = requestAnimationFrame(this.loop);
  };
  flush() {
    const channel = VirtualChannelManager.getInstance();
    if (this.bufferRMS.o !== null) {
      channel.pushAggregated("__audio__", "energy_rms", this.bufferRMS);
    }
    if (this.bufferPeak.o !== null) {
      channel.pushAggregated("__audio__", "peak_level", this.bufferPeak);
    }
    this.bufferRMS = this.createEmptyMetric();
    this.bufferPeak = this.createEmptyMetric();
  }
  updateMetric(metric, value) {
    if (metric.o === null) {
      metric.o = value;
      metric.h = value;
      metric.l = value;
      metric.c = value;
    } else {
      metric.c = value;
      if (value > metric.h)
        metric.h = value;
      if (value < metric.l)
        metric.l = value;
    }
  }
  createEmptyMetric() {
    return { o: null, h: -1, l: -1, c: -1 };
  }
}

// webops/typescript/orchestration/TimelineExecutor.ts
var FETCH_ORIGINAL = Symbol("WebOpsFetchOriginal");
function cubicBezier(t, p0, p1, p2, p3) {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3;
}
function humanLikePath(startX, startY, endX, endY, steps) {
  const path = [];
  const ctrl1X = startX + (endX - startX) * 0.3 + (Math.random() - 0.5) * 50;
  const ctrl1Y = startY + (endY - startY) * 0.1 + (Math.random() - 0.5) * 30;
  const ctrl2X = startX + (endX - startX) * 0.7 + (Math.random() - 0.5) * 50;
  const ctrl2Y = startY + (endY - startY) * 0.9 + (Math.random() - 0.5) * 30;
  for (let i = 0;i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    path.push({
      x: cubicBezier(eased, startX, ctrl1X, ctrl2X, endX),
      y: cubicBezier(eased, startY, ctrl1Y, ctrl2Y, endY)
    });
  }
  return path;
}

class TimelineExecutor {
  static instance;
  state = null;
  virtualChannel;
  cursorX = 0;
  cursorY = 0;
  isMouseDown = false;
  constructor(channel) {
    this.virtualChannel = channel || VirtualChannelManager.getInstance();
    this.trackCursor();
  }
  static getInstance() {
    if (!TimelineExecutor.instance) {
      TimelineExecutor.instance = new TimelineExecutor;
    }
    return TimelineExecutor.instance;
  }
  async execute(timeline) {
    if (this.state?.isRunning) {
      console.warn("[Timeline] Busy. Aborting previous run.");
      this.abort();
    }
    this.state = {
      scenarioId: timeline.scenario_id,
      startTime: performance.now(),
      isRunning: true,
      isPaused: false,
      activeMocks: new Map
    };
    this.pushMarker("__SCENARIO_START__", { id: timeline.scenario_id });
    try {
      for (const step of timeline.timeline) {
        if (!this.state.isRunning)
          break;
        while (this.state.isPaused)
          await this.sleep(100);
        const now = performance.now();
        const targetTime = this.state.startTime + step.offset_ms;
        if (targetTime > now) {
          await this.sleep(targetTime - now);
        }
        if (step.mock_context) {
          this.installMock(step.mock_context);
        }
        if (step.marker) {
          this.pushMarker(step.marker, { action: step.action });
        }
        await this.dispatchAction(step, timeline.strategy);
      }
    } catch (e) {
      console.error("[Timeline] Execution Failed:", e);
      this.pushMarker("__SCENARIO_ERROR__", { error: String(e) });
      return false;
    } finally {
      this.pushMarker("__SCENARIO_END__", { id: timeline.scenario_id });
      this.cleanup();
    }
    return true;
  }
  abort() {
    if (this.state) {
      this.state.isRunning = false;
      this.cleanup();
    }
  }
  async dispatchAction(step, strategy) {
    const params = step.params || {};
    switch (step.action) {
      case "POINTER_MOVE":
        await this.moveCursor(params, strategy);
        break;
      case "CLICK":
        await this.moveCursor(params, strategy);
        this.simulateClick(this.cursorX, this.cursorY);
        break;
      case "DRAG":
        await this.simulateDrag(params, strategy);
        break;
      case "TYPE":
        await this.simulateType(params, strategy);
        break;
      case "WAIT":
        await this.wait(params);
        break;
    }
  }
  async moveCursor(params, strategy) {
    const target = this.resolveCoordinates(params);
    if (!target)
      return;
    if (strategy === "human_like") {
      const path = humanLikePath(this.cursorX, this.cursorY, target.x, target.y, 20);
      for (const p of path) {
        this.dispatchPointerEvent("mousemove", p.x, p.y);
        this.cursorX = p.x;
        this.cursorY = p.y;
        await this.sleep(16);
      }
    } else {
      this.dispatchPointerEvent("mousemove", target.x, target.y);
      this.cursorX = target.x;
      this.cursorY = target.y;
    }
  }
  simulateClick(x, y) {
    this.isMouseDown = true;
    this.dispatchPointerEvent("mousedown", x, y);
    this.isMouseDown = false;
    this.dispatchPointerEvent("mouseup", x, y);
    this.dispatchPointerEvent("click", x, y);
    this.virtualChannel.pushMetric("__input__", "click", 1);
  }
  async simulateDrag(params, strategy) {
    const start = this.resolveCoordinates(params);
    if (!start || params.endX === undefined || params.endY === undefined)
      return;
    await this.moveCursor({ x: start.x, y: start.y }, strategy);
    this.isMouseDown = true;
    this.dispatchPointerEvent("mousedown", start.x, start.y);
    const duration = params.duration || 500;
    const steps = Math.max(10, Math.floor(duration / 16));
    const path = strategy === "human_like" ? humanLikePath(start.x, start.y, params.endX, params.endY, steps) : this.linearPath(start.x, start.y, params.endX, params.endY, steps);
    for (const p of path) {
      this.dispatchPointerEvent("mousemove", p.x, p.y);
      this.cursorX = p.x;
      this.cursorY = p.y;
      await this.sleep(16);
    }
    this.isMouseDown = false;
    this.dispatchPointerEvent("mouseup", this.cursorX, this.cursorY);
  }
  async simulateType(params, strategy) {
    const el = document.activeElement;
    if (!el || typeof el.value === "undefined")
      return;
    if (params.clearFirst)
      el.value = "";
    const text = params.text || "";
    for (const char of text) {
      el.value += char;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (strategy === "human_like")
        await this.sleep(50 + Math.random() * 100);
    }
  }
  async wait(params) {
    if (params.timeout)
      await this.sleep(params.timeout);
    if (params.condition) {
      const start = performance.now();
      while (!document.querySelector(params.condition)) {
        if (performance.now() - start > 5000)
          throw new Error("Wait timeout");
        await this.sleep(100);
      }
    }
  }
  installMock(ctx) {
    const win = window;
    if (!win[FETCH_ORIGINAL]) {
      win[FETCH_ORIGINAL] = win.fetch;
    }
    win.fetch = async (input, init) => {
      const url = input.toString();
      for (const [pattern, mock] of this.state?.activeMocks || []) {
        if (url.includes(pattern)) {
          if (mock.delay)
            await this.sleep(mock.delay);
          return new Response(JSON.stringify(mock.response_body), {
            status: mock.status || 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      }
      return win[FETCH_ORIGINAL](input, init);
    };
    this.state?.activeMocks.set(ctx.url_pattern, ctx);
  }
  cleanup() {
    const win = window;
    if (win[FETCH_ORIGINAL]) {
      win.fetch = win[FETCH_ORIGINAL];
    }
    this.state = null;
  }
  dispatchPointerEvent(type, x, y) {
    const el = document.elementFromPoint(x, y) || document.body;
    const pointerTypeMap = {
      mousedown: "pointerdown",
      mouseup: "pointerup",
      mousemove: "pointermove",
      click: "click"
    };
    const pType = pointerTypeMap[type] || type;
    const buttonsState = this.isMouseDown ? 1 : 0;
    const buttonState = type === "mousemove" ? -1 : 0;
    const eventInit = {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      view: window,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      button: buttonState,
      buttons: buttonsState
    };
    el.dispatchEvent(new PointerEvent(pType, eventInit));
    if (pType !== type && type !== "click") {
      el.dispatchEvent(new MouseEvent(type, eventInit));
    }
    if (type === "mousemove") {
      this.virtualChannel.pushBatch("__cursor__", { x, y });
    }
  }
  pushMarker(name, meta) {
    this.virtualChannel.pushMetric("__markers__", name, performance.now());
  }
  resolveCoordinates(params) {
    if (params.x !== undefined && params.y !== undefined)
      return { x: params.x, y: params.y };
    if (params.target) {
      const selector = params.target.startsWith("[") ? params.target : `[data-vt-id="${params.target}"]`;
      const el = document.querySelector(selector);
      if (el) {
        const rect = el.getBoundingClientRect();
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      }
    }
    return null;
  }
  linearPath(x1, y1, x2, y2, steps) {
    const path = [];
    for (let i = 0;i <= steps; i++) {
      path.push({
        x: x1 + (x2 - x1) * (i / steps),
        y: y1 + (y2 - y1) * (i / steps)
      });
    }
    return path;
  }
  trackCursor() {
    document.addEventListener("mousemove", (e) => {
      if (!this.state?.isRunning) {
        this.cursorX = e.clientX;
        this.cursorY = e.clientY;
      }
    });
  }
  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }
}
var choreography = TimelineExecutor.getInstance();

// webops/typescript/diagnosis/MarkerAlignmentAnalyzer.ts
class MarkerAlignmentAnalyzer {
  frames = [];
  markers = [];
  config;
  constructor(config) {
    this.config = {
      inputSignals: config?.inputSignals || ["__cursor__", "__input__"],
      outputSignals: config?.outputSignals || [],
      thresholds: {
        correlation: config?.thresholds?.correlation ?? 0.4,
        inputVariance: config?.thresholds?.inputVariance ?? 0.01,
        outputVariance: config?.thresholds?.outputVariance ?? 0.001
      }
    };
  }
  ingest(frame) {
    if (frame.data && frame.data["__markers__"]?.a) {
      const markers = frame.data["__markers__"].a;
      for (const [name, metric] of Object.entries(markers)) {
        this.markers.push({ name, timestamp: metric.c });
      }
    }
    this.frames.push({
      ts: frame.ts,
      data: frame.data
    });
  }
  analyze(scenarioId) {
    this.markers.sort((a, b) => a.timestamp - b.timestamp);
    const intervals = [];
    const alerts = [];
    for (let i = 0;i < this.markers.length - 1; i++) {
      const start = this.markers[i];
      const end = this.markers[i + 1];
      if (end.timestamp - start.timestamp < 50)
        continue;
      const diagnosis = this.diagnoseInterval(start, end);
      intervals.push(diagnosis);
      if (diagnosis.verdict === "NO_RESPONSE") {
        alerts.push(`[${diagnosis.name}] Deadlock detected: Input active but Output frozen.`);
      } else if (diagnosis.verdict === "CHAOTIC") {
        alerts.push(`[${diagnosis.name}] Logic chaotic: Response does not match Input pattern.`);
      }
    }
    const anomalyCount = intervals.filter((i) => ["NO_RESPONSE", "CHAOTIC"].includes(i.verdict)).length;
    const total = intervals.length || 1;
    const score = Math.max(0, 100 - anomalyCount / total * 100);
    return {
      scenarioId,
      score,
      intervals,
      alerts
    };
  }
  diagnoseInterval(start, end) {
    const slice = this.frames.filter((f) => f.ts >= start.timestamp && f.ts <= end.timestamp);
    const inputSeries = this.aggregateSeries(slice, this.config.inputSignals);
    const outputTargets = this.config.outputSignals.length > 0 ? this.config.outputSignals : this.detectActiveSignals(slice);
    const outputSeries = this.aggregateSeries(slice, outputTargets);
    const inputVar = this.computeVariance(inputSeries);
    const outputVar = this.computeVariance(outputSeries);
    const correlation = this.computeCorrelation(inputSeries, outputSeries);
    const { verdict, confidence } = this.deriveVerdict(inputVar, outputVar, correlation);
    return {
      name: `${start.name} -> ${end.name}`,
      duration: end.timestamp - start.timestamp,
      inputActivity: inputVar,
      outputActivity: outputVar,
      correlation,
      verdict,
      confidence
    };
  }
  deriveVerdict(inVar, outVar, corr) {
    const { inputVariance, outputVariance, correlation } = this.config.thresholds;
    const hasInput = inVar > inputVariance;
    const hasOutput = outVar > outputVariance;
    const isCorrelated = Math.abs(corr) > correlation;
    if (!hasInput && !hasOutput)
      return { verdict: "IDLE", confidence: 0.9 };
    if (hasInput && !hasOutput)
      return { verdict: "NO_RESPONSE", confidence: 0.95 };
    if (!hasInput && hasOutput)
      return { verdict: "AUTONOMOUS", confidence: 0.8 };
    if (isCorrelated)
      return { verdict: "HEALTHY", confidence: Math.min(0.99, 0.5 + Math.abs(corr)) };
    return { verdict: "CHAOTIC", confidence: 0.7 };
  }
  aggregateSeries(frames, keys) {
    return frames.map((f) => {
      let activity = 0;
      for (const key of keys) {
        const [id, subKey] = key.includes(":") ? key.split(":") : [key, null];
        const node = f.data[id];
        if (node) {
          if (!subKey && node.w && node.w.c !== -1) {
            activity += this.delta(node.w);
          }
          if (node.a) {
            if (subKey && node.a[subKey]) {
              activity += this.delta(node.a[subKey]);
            } else if (!subKey) {
              Object.values(node.a).forEach((m) => activity += this.delta(m));
            }
          }
        }
      }
      return activity;
    });
  }
  delta(m) {
    return m.h - m.l + Math.abs(m.c - m.o);
  }
  detectActiveSignals(frames) {
    const set = new Set;
    const samples = [frames[Math.floor(frames.length / 2)], frames[frames.length - 1]];
    samples.forEach((f) => {
      if (!f)
        return;
      Object.keys(f.data).forEach((id) => {
        if (this.config.inputSignals.some((s) => s.startsWith(id)))
          return;
        if (id.startsWith("__"))
          return;
        set.add(id);
      });
    });
    return Array.from(set);
  }
  computeVariance(data) {
    if (data.length < 2)
      return 0;
    const mean = data.reduce((a, b) => a + b, 0) / data.length;
    const sumSq = data.reduce((a, b) => a + Math.pow(b - mean, 2), 0);
    return sumSq / data.length;
  }
  computeCorrelation(x, y) {
    const n = Math.min(x.length, y.length);
    if (n < 2)
      return 0;
    const avgX = x.reduce((a, b) => a + b, 0) / n;
    const avgY = y.reduce((a, b) => a + b, 0) / n;
    let num = 0, denX = 0, denY = 0;
    for (let i = 0;i < n; i++) {
      const dx = x[i] - avgX;
      const dy = y[i] - avgY;
      num += dx * dy;
      denX += dx * dx;
      denY += dy * dy;
    }
    const den = Math.sqrt(denX * denY);
    return den === 0 ? 0 : num / den;
  }
}
var diagnose = new MarkerAlignmentAnalyzer;

// webops/typescript/AgentEntryPoint.ts
class WebOpsAgent {
  domRuntime = DOMTelemetryRuntime.getInstance();
  virtualChannel = VirtualChannelManager.getInstance();
  audioRuntime = AudioTelemetryRuntime.getInstance();
  choreography = TimelineExecutor.getInstance();
  analyzer = new MarkerAlignmentAnalyzer;
  originalAudioContext = null;
  async runScenario(scenarioJSON) {
    console.log("[WebOps] 收到后端下发的测试剧本:", scenarioJSON);
    this.start();
    try {
      if (this.choreography) {
        await this.choreography.execute(scenarioJSON);
      }
      await new Promise((r) => setTimeout(r, 1500));
      this.stop();
      if (this.analyzer) {
        const report = this.analyzer.analyze(scenarioJSON.scenario_id || "DEFAULT_SCENARIO");
        return JSON.stringify(report);
      }
    } catch (err) {
      console.error("[WebOps] 执行剧本发生异常:", err);
      return JSON.stringify({ score: 0, status: "error", alerts: [String(err)] });
    }
    return JSON.stringify({ score: 100, status: "completed", alerts: [] });
  }
  start() {
    console.log("[WebOps] Agent starting in Local Autonomous Mode...");
    this.domRuntime.onFlush = (frame) => this.analyzer.ingest(frame);
    this.virtualChannel.onFlush = (frame) => this.analyzer.ingest(frame);
    this.domRuntime.start();
    this.virtualChannel.startStandalone();
    this.hijackAudioContext();
    console.log("[WebOps] Agent running.");
  }
  stop() {
    this.domRuntime.stop();
    this.virtualChannel.stopStandalone();
    this.audioRuntime.stop();
    this.restoreAudioContext();
    console.log("[WebOps] Agent stopped.");
  }
  mark(markerName) {
    this.virtualChannel.pushMetric("__markers__", markerName, performance.now());
  }
  pushSignal(targetId, metricKey, value) {
    this.virtualChannel.pushMetric(targetId, metricKey, value);
  }
  hijackAudioContext() {
    if (this.originalAudioContext)
      return;
    const self = this;
    this.originalAudioContext = window.AudioContext || window.webkitAudioContext;
    if (!this.originalAudioContext)
      return;
    const PatchedAudioContext = function(...args) {
      const ctx = new self.originalAudioContext(...args);
      const interceptorGain = ctx.createGain();
      interceptorGain.connect(ctx.destination);
      self.audioRuntime.attach(ctx, interceptorGain);
      self.audioRuntime.start();
      Object.defineProperty(ctx, "destination", { get: () => interceptorGain });
      return ctx;
    };
    PatchedAudioContext.prototype = this.originalAudioContext.prototype;
    window.AudioContext = PatchedAudioContext;
    if (window.webkitAudioContext)
      window.webkitAudioContext = PatchedAudioContext;
  }
  restoreAudioContext() {
    if (this.originalAudioContext) {
      window.AudioContext = this.originalAudioContext;
      if (window.webkitAudioContext)
        window.webkitAudioContext = this.originalAudioContext;
      this.originalAudioContext = null;
    }
  }
}
if (typeof window !== "undefined") {
  window.WebOps = new WebOpsAgent;
}
