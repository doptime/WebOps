'use client';

// examples/angle-sorting/Angle_SortingChaos.instrumented.tsx
//
// 这是 Angle_SortingChaos.tsx 的接入 V4 探针后版本。
// 与原版相比，仅做"声明式埋点"，不改业务逻辑：
//
//   1. Zustand store 通过 withTelemetry middleware 包裹，
//      score / lives / status / spawnedCount 等数值字段自动成为信号。
//   2. 三个分类按钮加上 data-vt-id，让 Script 可以 click('btn_acute') 定位。
//   3. 在 R3F 场景里，每张卡片暴露 userData.signals.angle 让 R3FBridge 抓取。
//   4. 在 useFrame 中暴露 focusedCard 的 angle/type 作为信号，
//      让大模型能在帧级别看到"当前需要分类的角是什么"。
//
// 业务逻辑、视觉、布局、音频接入全部保持原样。

import React, { useEffect, useRef, useMemo, Suspense } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Text, Line, RoundedBox, OrthographicCamera, Environment, Loader } from '@react-three/drei';
import { Physics, RigidBody, RapierRigidBody, CuboidCollider } from '@react-three/rapier';
import { create } from 'zustand';
import { Triangle, Square, Circle, Activity, Zap, RefreshCw, Home, CheckCircle2, Keyboard } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';

import { usePlaySound } from '@/hooks/usePlaySound';
import { audioManager } from '@/lib/audio/audio-manager';

// [WebOps V4 接入]
import { withTelemetry, useTrack, usePushSignal } from '@/webops';

// ==========================================
// 0. 多语言契约 — 保持原状
// ==========================================
export interface SortingChaosVocab {
  ui: {
    progress: string;
    victoryTitle: string;
    finalScore: string;
    playAgain: string;
    quit: string;
    gameOverTitle: string;
    retry: string;
    keyboardHint: string;
    loading: string;
  };
  game: {
    acute: string;       acuteDesc: string;
    right: string;       rightDesc: string;
    obtuse: string;      obtuseDesc: string;
  };
  guideline: { title: string; text: string; };
  fontUrl: string;
}

const MAX_CARDS = 20;
type AngleType = 'acute' | 'right' | 'obtuse';
type GameStatus = 'playing' | 'gameover' | 'victory';
interface CardData { id: string; type: AngleType; angle: number; x: number; }

// ==========================================
// 2. Store —— 用 withTelemetry 包裹
// ==========================================

interface GameState {
  status: GameStatus;
  score: number;
  lives: number;
  cards: CardData[];
  focusedId: string | null;
  spawnedCount: number;
  /** [V4 新增] 把当前焦点卡片的 angle 类型解码成数值，便于 LLM 看到"应该选哪个" */
  focusedAngleCode: number;  // 0=none, 1=acute, 2=right, 3=obtuse
  focusedAngleValue: number; // 实际度数（0 if none）

  spawnCard: () => void;
  removeCard: (id: string) => void;
  setFocusedId: (id: string | null) => void;
  attemptClear: (type: AngleType) => 'success' | 'fail' | 'empty';
  loseLife: () => void;
  checkWinCondition: () => void;
  reset: () => void;
}

const ANGLE_CODE: Record<AngleType, number> = { acute: 1, right: 2, obtuse: 3 };

export const useGameStore = create<GameState>()(
  withTelemetry({
    targetId: 'game',
    enums: {
      status: { playing: 0, gameover: -1, victory: 1 }
    },
    skip: ['cards']  // 数组太大，用 cards_len 代替
  })((set, get) => ({
    status: 'playing',
    score: 0,
    lives: 3,
    cards: [],
    focusedId: null,
    spawnedCount: 0,
    focusedAngleCode: 0,
    focusedAngleValue: 0,

    spawnCard: () => {
      const { spawnedCount } = get();
      if (spawnedCount >= MAX_CARDS) return;
      audioManager.playSFX('SFX_POP');

      const types: AngleType[] = ['acute', 'right', 'obtuse'];
      const type = types[Math.floor(Math.random() * types.length)];
      let angle = 90;
      if (type === 'acute')  angle = Math.floor(Math.random() * 80) + 5;
      if (type === 'obtuse') angle = Math.floor(Math.random() * 80) + 95;
      const x = (Math.random() - 0.5) * 4;

      set((state) => ({
        spawnedCount: state.spawnedCount + 1,
        cards: [...state.cards, { id: Math.random().toString(36).substring(7), type, angle, x }]
      }));
    },

    removeCard: (id) => {
      set((state) => ({
        cards: state.cards.filter((c) => c.id !== id),
        focusedId: state.focusedId === id ? null : state.focusedId
      }));
      get().checkWinCondition();
    },

    setFocusedId: (id) => {
      const cards = get().cards;
      const card = id ? cards.find((c) => c.id === id) : null;
      set({
        focusedId: id,
        focusedAngleCode: card ? ANGLE_CODE[card.type] : 0,
        focusedAngleValue: card?.angle ?? 0
      });
    },

    loseLife: () => {
      audioManager.playSFX('SFX_FAIL');
      set((state) => {
        const newLives = state.lives - 1;
        return { lives: newLives, status: newLives <= 0 ? 'gameover' : 'playing' };
      });
    },

    checkWinCondition: () => {
      const { spawnedCount, cards, status, lives } = get();
      if (spawnedCount >= MAX_CARDS && cards.length === 0 && lives > 0 && status === 'playing') {
        set({ status: 'victory' });
      }
    },

    attemptClear: (selectedType) => {
      const { focusedId, cards, status } = get();
      if (status !== 'playing') return 'empty';
      if (!focusedId) return 'empty';
      const card = cards.find((c) => c.id === focusedId);
      if (!card) return 'empty';

      if (card.type === selectedType) {
        audioManager.playSFX('SFX_SUCCESS');
        set((state) => ({ score: state.score + 100 }));
        return 'success';
      } else {
        get().loseLife();
        return 'fail';
      }
    },

    reset: () => set({
      status: 'playing', score: 0, lives: 3,
      cards: [], focusedId: null, spawnedCount: 0,
      focusedAngleCode: 0, focusedAngleValue: 0
    }),
  }))
);

// ==========================================
// 3. 3D 组件 —— FallingCard 加 R3F userData.signals
// ==========================================

const AngleVisual = ({ angle, type }: { angle: number; type: AngleType }) => {
  const rad = (angle * Math.PI) / 180;
  const len = 1.2;
  const endX = len * Math.cos(rad);
  const endY = len * Math.sin(rad);
  const color = type === 'acute' ? '#3b82f6' : (type === 'right' ? '#a855f7' : '#f97316');
  const points = useMemo(() => [
    new THREE.Vector3(1.2, 0, 0),
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(endX, endY, 0)
  ], [endX, endY]);

  return (
    <group position={[-0.4, -0.4, 0.1]}>
      <Line points={points} color="#1e293b" lineWidth={3} />
      <mesh position={[0, 0, 0]}>
        <circleGeometry args={[0.15, 16]} />
        <meshBasicMaterial color={color} />
      </mesh>
      {type === 'right' && (
        <Line points={[new THREE.Vector3(0.3, 0, 0), new THREE.Vector3(0.3, 0.3, 0), new THREE.Vector3(0, 0.3, 0)]} color={color} lineWidth={2} />
      )}
    </group>
  );
};

const FallingCard = ({ data, fontUrl }: { data: CardData, fontUrl: string }) => {
  const rigidBodyRef = useRef<RapierRigidBody>(null);
  const groupRef = useRef<THREE.Group>(null);
  const { removeCard, focusedId, loseLife, score } = useGameStore();
  const isFocused = focusedId === data.id;
  const prevScore = useRef(score);

  // [V4] 给 group 设置 name + userData.signals，让 R3FBridge 抓得到。
  useEffect(() => {
    if (groupRef.current) {
      groupRef.current.name = `card_${data.id}`;
      groupRef.current.userData = {
        id: `card_${data.id}`,
        signals: {
          angle: data.angle,
          angleCode: ANGLE_CODE[data.type],
          isFocused: isFocused ? 1 : 0
        }
      };
    }
  }, [data.id, data.angle, data.type, isFocused]);

  useFrame(() => {
    const currentScore = useGameStore.getState().score;
    if (currentScore > prevScore.current && isFocused) {
      if (rigidBodyRef.current) {
        rigidBodyRef.current.applyImpulse({ x: (Math.random() - 0.5) * 5, y: 10, z: 0 }, true);
        rigidBodyRef.current.applyTorqueImpulse({ x: 0, y: 0, z: Math.random() * 2 }, true);
        setTimeout(() => removeCard(data.id), 400);
      }
    }
    prevScore.current = currentScore;

    if (rigidBodyRef.current) {
      const pos = rigidBodyRef.current.translation();
      if (pos.y < -15) {
        loseLife();
        removeCard(data.id);
      }
    }
  });

  return (
    <RigidBody
      ref={rigidBodyRef}
      position={[data.x, 15, 0]}
      gravityScale={1}
      linearDamping={1}
      angularDamping={0.5}
      friction={0.5}
      restitution={0.2}
    >
      <CuboidCollider args={[1, 1.2, 0.1]} />
      <group ref={groupRef}>
        <RoundedBox args={[2, 2.4, 0.2]} radius={0.1}>
          <meshStandardMaterial color="white" />
        </RoundedBox>
        <group position={[0, 0, 0.11]}>
          <AngleVisual angle={data.angle} type={data.type} />
          <Text position={[0, -0.8, 0]} fontSize={0.6} color="#334155" fontWeight="bold" font={fontUrl}>
            {data.angle}°
          </Text>
        </group>
      </group>
    </RigidBody>
  );
};

const GameSystem = () => {
  const { spawnCard, status, cards, setFocusedId, spawnedCount } = useGameStore();
  const timer = useRef(0);
  const getInterval = () => {
    const baseInterval = 3.0;
    const minInterval = 1.5;
    const reduction = spawnedCount * 0.1;
    return Math.max(minInterval, baseInterval - reduction);
  };

  useFrame((state, delta) => {
    if (status !== 'playing') return;
    timer.current += delta;
    if (timer.current > getInterval()) {
      spawnCard();
      timer.current = 0;
    }
    if (spawnedCount === 0 && timer.current > 0.5) {
      spawnCard();
      timer.current = 0;
    }
    if (cards.length > 0) setFocusedId(cards[0].id);
  });
  return null;
};

// ==========================================
// 4. 主 UI —— 三个按钮加 data-vt-id
// ==========================================

export const Angle_SortingChaos = ({ onInteract, vocab }: { onInteract: any, vocab: SortingChaosVocab }) => {
  const router = useRouter();
  const { score, lives, status, attemptClear, reset, spawnedCount } = useGameStore();
  const { playSFX, playBGM, stopVoice } = usePlaySound();

  // [V4] 给三个分类按钮分别绑定 vt-id；watch 的属性供 DOM K 线追踪
  const acuteTrack = useTrack('btn_acute', { watch: ['opacity'] });
  const rightTrack = useTrack('btn_right', { watch: ['opacity'] });
  const obtuseTrack = useTrack('btn_obtuse', { watch: ['opacity'] });
  const hudTrack = useTrack('hud_score', {});
  const livesTrack = useTrack('hud_lives', {});
  const victoryTrack = useTrack('overlay_victory', {});
  const gameoverTrack = useTrack('overlay_gameover', {});

  useEffect(() => {
    reset();
    return () => stopVoice();
  }, []);

  useEffect(() => {
    if (status === 'playing') playBGM('BGM_GAME');
    else if (status === 'victory') playSFX('SFX_WIN');
  }, [status, playBGM, playSFX]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (status !== 'playing') return;
      if (e.key === 'a' || e.key === 'ArrowLeft')  attemptClear('acute');
      if (e.key === 's' || e.key === 'ArrowDown')  attemptClear('right');
      if (e.key === 'd' || e.key === 'ArrowRight') attemptClear('obtuse');
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [status, attemptClear]);

  const handleBtnClick = (action: () => void) => {
    playSFX('SFX_CLICK');
    action();
  };

  return (
    <div className="relative w-full h-full bg-slate-950 overflow-hidden select-none">
      <Suspense fallback={<div className="text-white flex items-center justify-center h-full font-mono">{vocab.ui.loading}</div>}>
        <Canvas className="absolute inset-0 z-0">
          <OrthographicCamera makeDefault position={[0, 0, 20]} zoom={35} />
          <color attach="background" args={['#020617']} />
          <ambientLight intensity={0.8} />
          <directionalLight position={[5, 5, 5]} intensity={1} />
          <Environment preset="city" />
          <Physics gravity={[0, -2, 0]}>
            <GameSystem />
            {useGameStore.getState().cards.map(c => (
              <FallingCard key={c.id} data={c} fontUrl={vocab.fontUrl} />
            ))}
            <RigidBody type="fixed" position={[-10, 0, 0]}><CuboidCollider args={[1, 20, 1]} /></RigidBody>
            <RigidBody type="fixed" position={[10, 0, 0]}><CuboidCollider args={[1, 20, 1]} /></RigidBody>
          </Physics>
        </Canvas>
      </Suspense>

      <Loader />

      {/* HUD */}
      <div className="absolute inset-0 z-10 pointer-events-none flex flex-col justify-between p-6">
        <div className="flex justify-between items-start">
          <div className="bg-slate-900/80 p-4 rounded-xl flex gap-6 text-white font-mono border border-white/10 backdrop-blur-md">
            <div {...hudTrack} className="flex items-center gap-2">
              <Activity size={18} className="text-blue-400" /> {score}
            </div>
            <div {...livesTrack} className="flex gap-1">
              {[...Array(3)].map((_, i) => <Zap key={i} size={18} className={i < lives ? "text-yellow-400 fill-yellow-400" : "text-gray-700"} />)}
            </div>
            <div className="text-gray-500 text-sm flex items-center border-l border-white/10 pl-4">
              {vocab.ui.progress.replace('{current}', spawnedCount.toString()).replace('{max}', MAX_CARDS.toString())}
            </div>
          </div>
          <button onClick={() => handleBtnClick(() => router.push('/'))} className="pointer-events-auto bg-slate-800 p-3 rounded-xl text-white hover:bg-slate-700 border border-white/10">
            <Home size={20} />
          </button>
        </div>

        {status === 'victory' && (
          <div {...victoryTrack} className="absolute inset-0 bg-slate-900/90 flex flex-col items-center justify-center pointer-events-auto z-50 backdrop-blur-md">
            <CheckCircle2 size={80} className="text-green-500 mb-6 drop-shadow-[0_0_15px_rgba(34,197,94,0.6)]" />
            <h2 className="text-5xl text-white font-bold mb-2 tracking-tighter">{vocab.ui.victoryTitle}</h2>
            <p className="text-gray-400 mb-8 font-mono text-lg">{vocab.ui.finalScore.replace('{score}', score.toString())}</p>
            <div className="flex gap-4">
              <button onClick={() => handleBtnClick(reset)} className="bg-white text-black hover:scale-105 transition-transform px-8 py-3 rounded-xl font-bold flex gap-2 items-center">
                <RefreshCw size={18} /> {vocab.ui.playAgain}
              </button>
              <button onClick={() => handleBtnClick(() => router.push('/'))} className="bg-slate-800 text-white hover:bg-slate-700 px-8 py-3 rounded-xl font-bold border border-white/10">
                {vocab.ui.quit}
              </button>
            </div>
          </div>
        )}

        {status === 'gameover' && (
          <div {...gameoverTrack} className="absolute inset-0 bg-red-950/90 flex flex-col items-center justify-center pointer-events-auto z-50 backdrop-blur-md">
            <h2 className="text-4xl text-white font-bold mb-4">{vocab.ui.gameOverTitle}</h2>
            <button onClick={() => handleBtnClick(reset)} className="bg-red-600 hover:bg-red-500 text-white px-8 py-3 rounded-xl font-bold flex gap-2">
              <RefreshCw /> {vocab.ui.retry}
            </button>
          </div>
        )}

        <div className="flex flex-col items-center pb-8 pointer-events-auto">
          <div className="flex gap-2 text-gray-500 text-xs font-mono mb-2 opacity-60">
            <Keyboard size={12} /> {vocab.ui.keyboardHint}: &larr; &darr; &rarr; / A S D
          </div>
          <div className="flex gap-3">
            <button {...acuteTrack} onClick={() => handleBtnClick(() => attemptClear('acute'))}
              className="w-32 h-24 bg-blue-900/60 hover:bg-blue-800 border-b-4 border-blue-500 rounded-xl flex flex-col items-center justify-center text-blue-100 active:border-b-0 active:translate-y-1 transition-all shadow-lg backdrop-blur-sm">
              <Triangle className="mb-2" size={28} />
              <span className="font-bold text-lg">{vocab.game.acute}</span>
              <span className="text-[10px] opacity-50">{vocab.game.acuteDesc}</span>
            </button>
            <button {...rightTrack} onClick={() => handleBtnClick(() => attemptClear('right'))}
              className="w-32 h-24 bg-purple-900/60 hover:bg-purple-800 border-b-4 border-purple-500 rounded-xl flex flex-col items-center justify-center text-purple-100 active:border-b-0 active:translate-y-1 transition-all shadow-lg backdrop-blur-sm">
              <Square className="mb-2" size={28} />
              <span className="font-bold text-lg">{vocab.game.right}</span>
              <span className="text-[10px] opacity-50">{vocab.game.rightDesc}</span>
            </button>
            <button {...obtuseTrack} onClick={() => handleBtnClick(() => attemptClear('obtuse'))}
              className="w-32 h-24 bg-orange-900/60 hover:bg-orange-800 border-b-4 border-orange-500 rounded-xl flex flex-col items-center justify-center text-orange-100 active:border-b-0 active:translate-y-1 transition-all shadow-lg backdrop-blur-sm">
              <Circle className="mb-2" size={28} />
              <span className="font-bold text-lg">{vocab.game.obtuse}</span>
              <span className="text-[10px] opacity-50">{vocab.game.obtuseDesc}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Angle_SortingChaos;
