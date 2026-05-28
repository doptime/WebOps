// runtime.ts — 轻量运行时入口,游戏组件静态 import 这个文件。
// V6 不变:useTrack 仍生成 data-vt-id(动作定位用),shouldEnableWebOps 仍是生产闸门。
// 重型审计单例(SessionRunner / AudioCapture / agent)仍由 Bootstrap 动态 import('@/webops')。
//
// 设计目标: 让 import "@/webops/runtime" 不会拖入 SessionRunner / ReportBuilder /
// analyzer / 6 个 core 探针等任何重量级模块,从而生产 bundle 不增加任何审计代码。
//
// 这里只导出三件东西:
//   1. useTrack / usePushSignal / useSignalBinding —— 给 React 组件用的追踪 hook。
//      生产环境无副作用:它们只生成 data-vt-id 属性,没有 push 函数时不推任何信号。
//   2. withTelemetry / setTelemetryPushFn / clearTelemetryPushFn —— zustand 中间件。
//      生产环境无副作用:没有 push 函数时全部 set() 走原路。
//   3. shouldEnableWebOps —— URL 闸门,Bootstrap 用它决定是否要 dynamic-import @/webops。
//
// 完整的 webops 单例(SessionRunner / Script / register / run / describe)在 @/webops 里,
// 由 Bootstrap 在 shouldEnableWebOps()=true 时 await import 进来。

export { useTrack, usePushSignal, useSignalBinding } from './react--useTrack';
export { withTelemetry, setTelemetryPushFn, clearTelemetryPushFn } from './react--zustand-telemetry';

/**
 * 生产安全闸:判断当前页面是否应该激活 WebOps 调试模式。
 *
 * 默认规则:
 *   1. URL 含 `?webops=1` → true     (Go chromedp 走这条路)
 *   2. NODE_ENV === 'development' → true   (本地手动 audit 方便)
 *   3. 否则 → false                  (生产用户不会带 ?webops=1,Bootstrap bail)
 *
 * 用法:
 *   useEffect(() => {
 *     if (!shouldEnableWebOps()) return;
 *     (async () => {
 *       const { webops } = await import('@/webops');
 *       webops.register('perfect-player', { ... });
 *     })();
 *   }, []);
 *
 * 参数与 webops.go 里的 const auditParam = "webops=1" 必须保持一致。
 * 要换名字(挡偶然访客),两边一起改。
 */
export function shouldEnableWebOps(opts: {
  param?: string;       // 默认 'webops'
  value?: string;       // 默认 '1'
  alsoInDev?: boolean;  // 默认 true
} = {}): boolean {
  const param = opts.param ?? 'webops';
  const value = opts.value ?? '1';
  const alsoInDev = opts.alsoInDev ?? true;

  if (typeof window === 'undefined') return false;

  if (alsoInDev && typeof process !== 'undefined' && process.env?.NODE_ENV === 'development') {
    return true;
  }

  const params = new URLSearchParams(window.location.search);
  return params.get(param) === value;
}
