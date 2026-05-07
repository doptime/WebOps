// typescript/VisualAttentionModel.ts
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

// typescript/VirtualChannelManager.ts
class VirtualChannelManager {
  static instance;
  signals = new Map;
  pendingFrames = [];
  MAX_PENDING = 200;
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
      ctx = {
        buffer: this.createEmptyMetric(),
        lastUpdateTime: 0
      };
      this.signals.set(compositeKey, ctx);
    }
    this.updateMetric(ctx.buffer, value);
    ctx.lastUpdateTime = performance.now();
  }
  pushAggregated(targetId, metricKey, metric) {
    if (metric.o === null)
      return;
    const compositeKey = `${targetId}:${metricKey}`;
    let ctx = this.signals.get(compositeKey);
    if (!ctx || ctx.buffer.o === null) {
      this.signals.set(compositeKey, {
        buffer: { ...metric },
        lastUpdateTime: performance.now()
      });
    } else {
      const b = ctx.buffer;
      b.h = Math.max(b.h, metric.h);
      b.l = Math.min(b.l, metric.l);
      b.c = metric.c;
      ctx.lastUpdateTime = performance.now();
    }
  }
  pushBatch(targetId, metrics) {
    for (const [key, value] of Object.entries(metrics)) {
      this.pushMetric(targetId, key, value);
    }
  }
  harvest() {
    const result = {};
    this.signals.forEach((ctx, compositeKey) => {
      if (ctx.buffer.o === null)
        return;
      const [targetId, metricKey] = this.parseCompositeKey(compositeKey);
      if (!result[targetId])
        result[targetId] = {};
      result[targetId][metricKey] = { ...ctx.buffer };
      ctx.buffer = this.createEmptyMetric();
    });
    return result;
  }
  pruneStaleSignals(timeoutMs = 1e4) {
    const now = performance.now();
    let removedCount = 0;
    this.signals.forEach((ctx, key) => {
      if (now - ctx.lastUpdateTime > timeoutMs) {
        this.signals.delete(key);
        removedCount++;
      }
    });
    return removedCount;
  }
  startStandalone() {
    if (this.isActive)
      return;
    this.isActive = true;
    this.lastFlushTime = performance.now();
    this.tick();
  }
  stopStandalone() {
    this.isActive = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
  tick = () => {
    if (!this.isActive)
      return;
    const now = performance.now();
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      this.flushStandalone(now);
      this.lastFlushTime = now;
    }
    this.rafId = requestAnimationFrame(this.tick);
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
    this.send(JSON.stringify(payload));
  }
  send(payloadStr) {
    const win = window;
    const tunnel = win.__OUROBOROS_TUNNEL__ || win.telemetryTunnel;
    if (tunnel) {
      while (this.pendingFrames.length > 0) {
        const pending = this.pendingFrames.shift();
        if (pending)
          tunnel(pending);
      }
      tunnel(payloadStr);
    } else {
      if (this.pendingFrames.length >= this.MAX_PENDING) {
        this.pendingFrames.shift();
      }
      this.pendingFrames.push(payloadStr);
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
    if (lastIdx === -1)
      return [key, "value"];
    return [key.substring(0, lastIdx), key.substring(lastIdx + 1)];
  }
}
var virtualChannel = VirtualChannelManager.getInstance();

// typescript/DOMTelemetryRuntime.ts
class DOMTelemetryRuntime {
  static instance;
  registry = new Map;
  virtualChannel;
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
    if (!DOMTelemetryRuntime.instance)
      DOMTelemetryRuntime.instance = new DOMTelemetryRuntime;
    return DOMTelemetryRuntime.instance;
  }
  start() {
    if (this.isActive)
      return;
    this.isActive = true;
    this.scanAndRegister(document.body);
    this.observer?.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-vt-id", "data-vt-watch", "style", "class"]
    });
    this.lastFlushTime = performance.now();
    this.tick();
  }
  stop() {
    this.isActive = false;
    if (this.observer)
      this.observer.disconnect();
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.registry.clear();
  }
  handleMutations = (mutations) => {
    mutations.forEach((m) => {
      if (m.type === "childList") {
        m.addedNodes.forEach((n) => n instanceof HTMLElement && this.scanAndRegister(n));
        m.removedNodes.forEach((n) => n instanceof HTMLElement && this.tryUnregister(n));
      } else if (m.type === "attributes" && m.target instanceof HTMLElement) {
        this.tryRegister(m.target);
      }
    });
  };
  tick = () => {
    if (!this.isActive)
      return;
    const now = performance.now();
    const viewport = { w: window.innerWidth, h: window.innerHeight };
    const snapshot = [];
    this.registry.forEach((ctx, id) => {
      if (!ctx.element.isConnected) {
        this.registry.delete(id);
        return;
      }
      const rect = ctx.element.getBoundingClientRect();
      const style = window.getComputedStyle(ctx.element);
      const opacity = parseFloat(style.opacity || "1");
      const zIndex = parseInt(style.zIndex || "0", 10) || 0;
      const weight = computeVisualWeight({
        width: rect.width,
        height: rect.height,
        x: rect.x,
        y: rect.y,
        opacity,
        zIndex,
        viewportW: viewport.w,
        viewportH: viewport.h
      });
      ctx.lastWeight = weight;
      snapshot.push({ id, weight });
      ctx.watchedAttrs.forEach((attr) => {
        let val = 0;
        if (attr === "rotation")
          val = this.parseRotation(style.transform);
        else if (attr === "scale")
          val = this.parseScale(style.transform);
        else {
          const sVal = style[attr];
          val = parseFloat(sVal) || 0;
        }
        this.updateMetric(ctx.bufferAttrs[attr], val);
      });
    });
    snapshot.sort((a, b) => b.weight - a.weight);
    snapshot.forEach((item, index) => {
      const ctx = this.registry.get(item.id);
      if (ctx) {
        this.updateMetric(ctx.bufferWeight, item.weight);
        this.updateMetric(ctx.bufferRank, item.weight > 0 ? index + 1 : -1);
      }
    });
    if (now - this.lastFlushTime >= this.FLUSH_INTERVAL_MS) {
      this.flush(now);
      this.lastFlushTime = now;
    }
    this.rafId = requestAnimationFrame(this.tick);
  };
  flush(ts) {
    const payload = {
      ts: Math.floor(ts),
      dur: this.FLUSH_INTERVAL_MS,
      sources: [],
      data: {}
    };
    this.registry.forEach((ctx, id) => {
      if (ctx.bufferWeight.o !== -1) {
        const node = {
          w: { ...ctx.bufferWeight },
          r: { ...ctx.bufferRank }
        };
        if (ctx.watchedAttrs.length > 0) {
          node.a = {};
          ctx.watchedAttrs.forEach((a) => {
            node.a[a] = { ...ctx.bufferAttrs[a] };
            ctx.bufferAttrs[a] = this.createEmptyMetric();
          });
        }
        payload.data[id] = node;
        ctx.bufferWeight = this.createEmptyMetric();
        ctx.bufferRank = this.createEmptyMetric();
      }
    });
    if (Object.keys(payload.data).length > 0)
      payload.sources.push("dom");
    const vData = this.virtualChannel.harvest();
    if (Object.keys(vData).length > 0) {
      payload.sources.push("virtual");
      for (const [tid, metrics] of Object.entries(vData)) {
        const target = payload.data[tid] || { a: {} };
        target.a = { ...target.a, ...metrics };
        payload.data[tid] = target;
      }
    }
    if (payload.sources.length > 0) {
      const tunnel = window.__OUROBOROS_TUNNEL__ || window.telemetryTunnel;
      tunnel?.(JSON.stringify(payload));
    }
  }
  updateMetric(metric, val) {
    if (metric.o === -1)
      metric.o = metric.h = metric.l = metric.c = val;
    else {
      metric.c = val;
      if (val > metric.h)
        metric.h = val;
      if (val < metric.l)
        metric.l = val;
    }
  }
  createEmptyMetric = () => ({ o: -1, h: -1, l: -1, c: -1 });
  scanAndRegister(root) {
    if (root.dataset.vtId)
      this.tryRegister(root);
    root.querySelectorAll("[data-vt-id]").forEach((el) => this.tryRegister(el));
  }
  tryRegister(el) {
    const id = el.dataset.vtId;
    if (!id)
      return;
    const watch = el.dataset.vtWatch?.split(",").filter(Boolean) || [];
    const ctx = this.registry.get(id);
    if (ctx) {
      ctx.watchedAttrs = watch;
      return;
    }
    const bufferAttrs = {};
    watch.forEach((a) => bufferAttrs[a] = this.createEmptyMetric());
    this.registry.set(id, {
      element: el,
      lastWeight: 0,
      bufferWeight: this.createEmptyMetric(),
      bufferRank: this.createEmptyMetric(),
      watchedAttrs: watch,
      bufferAttrs
    });
  }
  tryUnregister(node) {
    if (!(node instanceof HTMLElement))
      return;
    const id = node.dataset.vtId;
    if (id)
      this.registry.delete(id);
    node.querySelectorAll("[data-vt-id]").forEach((el) => {
      const subId = el.dataset.vtId;
      if (subId)
        this.registry.delete(subId);
    });
  }
  parseRotation(t) {
    if (!t || t === "none")
      return 0;
    const p = t.split("(")[1].split(")")[0].split(",");
    return Math.round(Math.atan2(parseFloat(p[1]), parseFloat(p[0])) * (180 / Math.PI));
  }
  parseScale(t) {
    if (!t || t === "none")
      return 1;
    const p = t.split("(")[1].split(")")[0].split(",");
    return Math.sqrt(Math.pow(parseFloat(p[0]), 2) + Math.pow(parseFloat(p[1]), 2));
  }
}

// typescript/AudioTelemetryRuntime.ts
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

// AgentEntryPoint.ts
class WebOpsAgent {
  domRuntime = DOMTelemetryRuntime.getInstance();
  virtualChannel = VirtualChannelManager.getInstance();
  audioRuntime = AudioTelemetryRuntime.getInstance();
  originalAudioContext = null;
  start() {
    console.log("[WebOps] Agent starting...");
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
      const originalDestination = ctx.destination;
      Object.defineProperty(ctx, "destination", {
        get: () => interceptorGain
      });
      return ctx;
    };
    PatchedAudioContext.prototype = this.originalAudioContext.prototype;
    window.AudioContext = PatchedAudioContext;
    if (window.webkitAudioContext) {
      window.webkitAudioContext = PatchedAudioContext;
    }
  }
  restoreAudioContext() {
    if (this.originalAudioContext) {
      window.AudioContext = this.originalAudioContext;
      if (window.webkitAudioContext) {
        window.webkitAudioContext = this.originalAudioContext;
      }
      this.originalAudioContext = null;
    }
  }
}
if (typeof window !== "undefined") {
  window.WebOps = new WebOpsAgent;
}
