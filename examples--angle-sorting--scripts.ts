// examples/angle-sorting/scripts.ts
//
// 三个测试剧本,展示 V4.1 Script DSL 的不同用法:
//
//   1. perfectPlayer — 标准玩法,用 dispatch 一行做"读 angleCode → 按对应键"分发。
//   2. lazyPlayer    — 永远按 'a',验证错误反馈与 gameover 逻辑(failure path)。
//   3. clickPlayer   — 用鼠标点击 btn_acute 等,验证 onClick 链路与键盘等价。
//
// 看脚本时关注:
//   - hypothesis 写在 register 时(见 README 接入示例),不放这里。
//   - 每个动作步骤的 intent 字段是给 LLM 看的语义注解,不影响 analyzer。

import { Script } from '@/webops';

// 业务侧把 store 暴露到 window,让脚本能拿到状态(dev 环境约定)。
declare const useGameStore: any;

// ----------------------------------------------------------------------------
// 1. 完美玩家:dispatch 把"读类型 → 按对应键"压成单一语句
// ----------------------------------------------------------------------------
export const perfectPlayer = () =>
  Script('perfect_classify_20_cards')
    .strategy('human_like')
    .timeout(120_000)
    .continueOnExpectFail(true)
    .wait(1500, 'wait_for_first_spawn')
    .observe('first_card_appeared', () => useGameStore.getState().cards.length > 0)

    // 主循环:玩 20 张卡(MAX_CARDS)
    .loop(20, (s) =>
      s
        .waitFor('next_card_focused', () => useGameStore.getState().focusedAngleCode > 0, 4000)
        .read('current_angle', () => useGameStore.getState().focusedAngleValue)
        .dispatch(
          () => useGameStore.getState().focusedAngleCode, // 1=acute 2=right 3=obtuse
          {
            1: (b) =>
              b.key('a', {
                mark: 'CLICK_ACUTE_CORRECT',
                intent: '焦点是锐角,按 a 应被判正确并 +100 分,触发 SFX_SUCCESS'
              }),
            2: (b) =>
              b.key('s', {
                mark: 'CLICK_RIGHT_CORRECT',
                intent: '焦点是直角,按 s 应被判正确并 +100 分,触发 SFX_SUCCESS'
              }),
            3: (b) =>
              b.key('d', {
                mark: 'CLICK_OBTUSE_CORRECT',
                intent: '焦点是钝角,按 d 应被判正确并 +100 分,触发 SFX_SUCCESS'
              })
          },
          { name: 'angle_type' }
        )
        .wait(900, 'wait_card_animation')
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
// 2. 偷懒玩家:永远按 'a',预期 lives→0 触发 gameover
// ----------------------------------------------------------------------------
export const lazyPlayer = () =>
  Script('lazy_always_acute')
    .strategy('instant')
    .timeout(60_000)
    .wait(1500)
    .loop(15, (s) =>
      s
        .waitFor('card_appears', () => useGameStore.getState().cards.length > 0, 4000)
        .key('a', {
          mark: 'PRESS_A',
          intent: '盲按 a:焦点是 right 或 obtuse 时应判错并扣 lives,焦点是 acute 时应得分'
        })
        .wait(800)
    )
    .read('end_status', () => useGameStore.getState().status)
    .read('end_lives', () => useGameStore.getState().lives)
    .expect('eventually_gameover', () => useGameStore.getState().status === 'gameover')
    .build();

// ----------------------------------------------------------------------------
// 3. 鼠标点击玩家:验证 onClick 链路与键盘等价
// ----------------------------------------------------------------------------
export const clickPlayer = () =>
  Script('click_via_mouse')
    .strategy('human_like')
    .timeout(120_000)
    .wait(1500)
    .loop(20, (s) =>
      s
        .waitFor('focus_set', () => useGameStore.getState().focusedAngleCode > 0, 4000)
        .dispatch(
          () => useGameStore.getState().focusedAngleCode,
          {
            1: (b) =>
              b.click('btn_acute', {
                mark: 'BTN_ACUTE_CLICK',
                intent: '点击锐角按钮,应等价于按 a'
              }),
            2: (b) =>
              b.click('btn_right', {
                mark: 'BTN_RIGHT_CLICK',
                intent: '点击直角按钮,应等价于按 s'
              }),
            3: (b) =>
              b.click('btn_obtuse', {
                mark: 'BTN_OBTUSE_CLICK',
                intent: '点击钝角按钮,应等价于按 d'
              })
          }
        )
        .wait(1000)
    )
    .wait(1500)
    .expect('victory_via_mouse', () => useGameStore.getState().status === 'victory')
    .build();
