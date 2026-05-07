// examples/angle-sorting/scripts.ts
//
// 三个测试剧本，展示 V4 Script DSL 的不同用法：
//
//   1. perfectPlayer  —— 标准玩法：读 store 拿到当前焦点卡片的角度类型，按对应键。
//   2. randomPlayer   —— 模拟随机玩家：每次按一个固定键，预期会输。用来观察"游戏失败响应"。
//   3. raceCondition  —— 极端：连续按键，看 UI 会不会崩。

import { Script } from '@/webops';

// 假设业务侧暴露了 store 引用（一般在 dev 环境下挂上 window）。
declare const useGameStore: any;

// ----------------------------------------------------------------------------
// 1. 完美玩家：读 focusedAngleCode → 选对应按钮
// ----------------------------------------------------------------------------
export const perfectPlayer = Script('perfect_classify_20_cards')
  .strategy('human_like')
  .timeout(120_000)
  .continueOnExpectFail(true)
  .wait(1500, 'wait_for_first_spawn')
  .observe('first_card_appeared', () => useGameStore.getState().cards.length > 0)

  // 主循环：玩 20 张卡（MAX_CARDS）
  .loop(20, (s) =>
    s
      .waitFor('next_card_focused', () => useGameStore.getState().focusedAngleCode > 0, 4000)
      .read('current_type', () => useGameStore.getState().focusedAngleCode)  // 1=acute 2=right 3=obtuse
      .read('current_angle', () => useGameStore.getState().focusedAngleValue)
      .branch(
        (read) => read('current_type') === 1,
        (b) => b.key('a', { mark: 'CLICK_ACUTE_CORRECT' })
      )
      .branch(
        (read) => read('current_type') === 2,
        (b) => b.key('s', { mark: 'CLICK_RIGHT_CORRECT' })
      )
      .branch(
        (read) => read('current_type') === 3,
        (b) => b.key('d', { mark: 'CLICK_OBTUSE_CORRECT' })
      )
      .wait(900, 'wait_card_animation')   // 等卡片被击飞
  )

  // 终局断言
  .wait(2000, 'wait_for_victory')
  .read('final_score', () => useGameStore.getState().score)
  .read('final_status', () => useGameStore.getState().status)
  .read('final_lives', () => useGameStore.getState().lives)
  .expect('victory_reached', () => useGameStore.getState().status === 'victory')
  .expect('score_at_least_1500', () => useGameStore.getState().score >= 1500)
  .build();

// ----------------------------------------------------------------------------
// 2. 偷懒玩家：永远按 'a'，看游戏会不会让人输
// ----------------------------------------------------------------------------
export const lazyPlayer = Script('lazy_always_acute')
  .strategy('instant')
  .timeout(60_000)
  .wait(1500)
  .loop(15, (s) =>
    s
      .waitFor('card_appears', () => useGameStore.getState().cards.length > 0, 4000)
      .key('a', { mark: 'PRESS_A' })
      .wait(800)
  )
  .read('end_status', () => useGameStore.getState().status)
  .read('end_lives', () => useGameStore.getState().lives)
  .expect('eventually_gameover', () => useGameStore.getState().status === 'gameover')
  .build();

// ----------------------------------------------------------------------------
// 3. 鼠标点击玩家：用 click('btn_acute') 而不是 key —— 验证按钮的点击事件链
// ----------------------------------------------------------------------------
export const clickPlayer = Script('click_via_mouse')
  .strategy('human_like')
  .timeout(120_000)
  .wait(1500)
  .loop(20, (s) =>
    s
      .waitFor('focus_set', () => useGameStore.getState().focusedAngleCode > 0, 4000)
      .read('type', () => useGameStore.getState().focusedAngleCode)
      .branch(
        (read) => read('type') === 1,
        (b) => b.click('btn_acute', { mark: 'BTN_ACUTE_CLICK' })
      )
      .branch(
        (read) => read('type') === 2,
        (b) => b.click('btn_right', { mark: 'BTN_RIGHT_CLICK' })
      )
      .branch(
        (read) => read('type') === 3,
        (b) => b.click('btn_obtuse', { mark: 'BTN_OBTUSE_CLICK' })
      )
      .wait(1000)
  )
  .wait(1500)
  .expect('victory_via_mouse', () => useGameStore.getState().status === 'victory')
  .build();

// ----------------------------------------------------------------------------
// 4. 压力测试：快速连按，看键盘事件会不会丢失
// ----------------------------------------------------------------------------
export const stressTest = Script('stress_rapid_keypress')
  .strategy('instant')
  .timeout(30_000)
  .wait(1500)
  .loop(40, (s) =>
    s
      .key('a', { mark: 'STRESS_A' })
      .wait(50)
      .key('s', { mark: 'STRESS_S' })
      .wait(50)
      .key('d', { mark: 'STRESS_D' })
      .wait(50)
  )
  .wait(2000)
  .read('survived_status', () => useGameStore.getState().status)
  .read('total_clicks_processed', () =>
    /* 这个字段我们靠从 markers 计算，所以这里用一个 sentinel */
    1)
  .build();
