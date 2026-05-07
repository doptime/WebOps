// examples/angle-sorting/run.ts
//
// 在浏览器开发者工具或 Next.js 测试页面里跑 session，输出可以直接喂给 LLM。
//
// 快速使用（在浏览器 console）：
//   import('./run').then(m => m.runPerfect().then(console.log))
//
// 推荐做法：在游戏所在的 Next.js 页面，加一个 dev-only 的 floating button：
//   <button onClick={runPerfect}>Run perfect player + LLM diagnosis</button>

import { runSession } from '@/webops';
import { perfectPlayer, lazyPlayer, clickPlayer, stressTest } from './examples--angle-sorting--scripts';
import { useGameStore } from './examples--angle-sorting--Angle_SortingChaos.instrumented';

// 把 store 暴露给 script.ts 里的 declare 引用 — dev 环境用
if (typeof window !== 'undefined') {
  (window as any).useGameStore = useGameStore;
}

const HYPOTHESIS_PERFECT = `
角度分类游戏的设计假设：
- 焦点卡片的角度类型 (acute / right / obtuse) 应当与玩家按下的键 (a / s / d) 一一对应。
- 当玩家持续做出正确选择时，应当：
  1. 每次得分 +100，最终得分 ≥ 1500（20 张卡 × 100 = 2000，允许部分卡掉落扣分）。
  2. 最终状态进入 'victory' (status=1)。
  3. 不应该有任何卡片掉到屏幕外造成 lives 减少 — 但允许偶发延迟。
  4. 每次成功消除应当伴随 SFX_SUCCESS 音效（peak > 0.05）。
请检查实际表现是否符合这些设计意图。
`;

const HYPOTHESIS_LAZY = `
"懒惰玩家"剧本：玩家始终按 'a'（acute），不论焦点卡片是什么角度。
设计假设：
- 当卡片是 right 或 obtuse 时，按 a 应被判错，触发 SFX_FAIL，并 lives -1。
- 3 次错误后，应进入 gameover 状态。
- 在还没 gameover 时，得分应当只在 acute 卡片时增长。
请检查游戏失败逻辑是否健康，错误反馈是否及时。
`;

const HYPOTHESIS_CLICK = `
"鼠标点击玩家"剧本：和完美玩家一样，但全部用鼠标点击三个分类按钮。
设计假设：
- 鼠标点击 btn_acute / btn_right / btn_obtuse 应等价于按 a/s/d。
- 如果鼠标事件被 React onClick 链正确处理，结果应与 perfectPlayer 完全一致。
- 检查点：是否所有 click 都成功命中（resolveCoordinates 不返回 null）。
请检查鼠标事件链是否健康。
`;

const HYPOTHESIS_STRESS = `
"压力测试"剧本：快速连按 a/s/d，间隔 50ms。
设计假设：
- 游戏不应崩溃或冻结。
- 即使按键随机不一定对，应在内存与状态层面保持一致（lives / score / status 不出现异常值，比如负的 score）。
请检查游戏在高频输入下的鲁棒性。
`;

export async function runPerfect() {
  const payload = await runSession(perfectPlayer, {
    hypothesis: HYPOTHESIS_PERFECT,
    enableAudio: true,
    enableR3F: true,
    flushIntervalMs: 100
  });
  console.log('[Perfect] ', payload);
  return payload;
}

export async function runLazy() {
  const payload = await runSession(lazyPlayer, {
    hypothesis: HYPOTHESIS_LAZY,
    enableAudio: true,
    enableR3F: true
  });
  console.log('[Lazy] ', payload);
  return payload;
}

export async function runClick() {
  const payload = await runSession(clickPlayer, {
    hypothesis: HYPOTHESIS_CLICK
  });
  console.log('[Click] ', payload);
  return payload;
}

export async function runStress() {
  const payload = await runSession(stressTest, {
    hypothesis: HYPOTHESIS_STRESS
  });
  console.log('[Stress] ', payload);
  return payload;
}

// 把所有入口挂到 window 上，方便在浏览器 console 直接调用。
if (typeof window !== 'undefined') {
  (window as any).WebOpsRun = { runPerfect, runLazy, runClick, runStress };
}
