// LLL バトルの逐次再生（クライアント専用の表示ロジック）。自己完結モジュール
// （import なし）。サーバーが1応答で返す最終状態と、その間に起きたイベント列
// （BattleEvent）から、「1イベント = 1拍」で見せる中間状態の列を組み立てる。
//
// 設計原則:
// - 計算は一切しない。HP / シールドの遷移はイベントの表示用メタ
//   （hpAfter / shieldAfter）が正。メタが無いイベント（旧形式）だけ
//   amount から加減算して補う。
// - 再生が終わった時点の状態は、必ずサーバーの最終状態と一致させる
//   （呼び出し側が最終ステップの後に実状態へ差し替える前提だが、
//   本モジュールの再構成も damage / heal / shield / death については
//   最終状態と一致する）。

export type PlaybackEventLike = {
  type: string;
  text: string;
  actorKey?: string;
  targetKey?: string;
  amount?: number;
  hpAfter?: number;
  shieldAfter?: number;
  affinity?: number;
  statusKind?: string;
  element?: string;
  skillName?: string;
  skillPower?: number;
  cutIn?: boolean;
};

export type PlaybackActorLike = {
  key: string;
  side: "player" | "cpu";
  hp: number;
  maxHp: number;
  shield: number;
  alive: boolean;
  statuses: { kind: string; turns: number }[];
};

export type PlaybackFloatKind =
  | "damage"
  | "weak"
  | "resist"
  | "heal"
  | "shield"
  | "shieldbreak"
  | "status"
  | "trait"
  | "burn"
  | "death";

export type PlaybackVfx = {
  kind: "attack" | "heal" | "shield" | "status" | "ko";
  element: string;
  fromKey?: string;
  toKey?: string;
  strong?: boolean;
};

export type PlaybackStep = {
  /** このステップで表示するイベント（元の列の index 付き）。 */
  event: PlaybackEventLike;
  eventIndex: number;
  /** このイベントを適用した直後のアクター列（新しい配列・新しい要素）。 */
  actors: PlaybackActorLike[];
  /** 1倍速での基準尺（ms）。 */
  durationMs: number;
  /** この拍で鳴らす SE 名（lll-sound の LllSeName）。無ければ null。 */
  se: string | null;
  /** この拍で発火させる振動パターン。自軍が対象の拍だけに付く。 */
  vibrate: number | number[] | null;
  /** 対象カードの上に1つだけ出すフロート。無ければ null。 */
  float: { targetKey: string; text: string; kind: PlaybackFloatKind } | null;
  /** この拍で点滅させるシールド/防御バッジの持ち主。無ければ null。 */
  shieldFlashKey: string | null;
  /** カットイン演出（技2やレジェンド技の開始時）。 */
  cutIn: { actorKey: string; skillName: string; element: string } | null;
  /** 2D/3D共通のビジュアルエフェクト指示。 */
  vfx: PlaybackVfx | null;
  /** 画面・カメラシェイクの強さ（0=なし, 1=弱, 2=中, 3=強）。 */
  shakeIntensity: 0 | 1 | 2 | 3;
};

/** 1倍速の基準尺（ms）。ダメージと回復が主拍、情報は最短。 */
export const PLAYBACK_DURATIONS: Record<string, number> = {
  damage: 560,
  heal: 560,
  shield: 420,
  status: 460,
  trait: 460,
  death: 720,
  info: 340,
  win: 900,
};

/** 状態付与の継続ターン（lll-battle の addStatus 呼び出しと一致させる）。 */
export const STATUS_DURATIONS: Record<string, number> = {
  burn: 2,
  stun: 1,
  guard_break: 2,
  overdrive: 2,
};

/** 状態付与フロートの文言。 */
export const STATUS_FLOAT_LABEL: Record<string, string> = {
  burn: "やけど付与",
  stun: "スタン",
  guard_break: "防御崩し",
  overdrive: "攻撃上昇",
};

function cloneActors<T extends PlaybackActorLike>(actors: T[]): T[] {
  return actors.map((actor) => ({ ...actor, statuses: actor.statuses.map((s) => ({ ...s })) }));
}

function findActor<T extends PlaybackActorLike>(actors: T[], key: string | undefined): T | undefined {
  if (!key) return undefined;
  return actors.find((actor) => actor.key === key);
}

function applyHp<T extends PlaybackActorLike>(target: T, event: PlaybackEventLike, sign: 1 | -1): void {
  if (typeof event.hpAfter === "number") {
    target.hp = event.hpAfter;
  } else if (typeof event.amount === "number") {
    target.hp = Math.max(0, Math.min(target.maxHp, target.hp + sign * event.amount));
  }
}

/**
 * 前状態とイベント列から再生ステップ列を組み立てる。
 * nextActors は参照しない（再構成が最終状態と一致することはテストで担保する）。
 */
export function buildPlaybackSteps<T extends PlaybackActorLike>(
  prevActors: T[],
  events: PlaybackEventLike[],
): PlaybackStep[] {
  const steps: PlaybackStep[] = [];
  let actors = cloneActors(prevActors);

  events.forEach((event, eventIndex) => {
    actors = cloneActors(actors);
    const target = findActor(actors, event.targetKey);
    const actor = findActor(actors, event.actorKey);
    let float: PlaybackStep["float"] = null;
    let se: string | null = null;
    let vibrate: number | number[] | null = null;
    let shieldFlashKey: string | null = null;
    let cutIn: PlaybackStep["cutIn"] = null;
    let vfx: PlaybackVfx | null = null;
    let shakeIntensity: 0 | 1 | 2 | 3 = 0;
    let durationMs = PLAYBACK_DURATIONS[event.type] ?? 400;

    if (event.cutIn && event.actorKey && event.skillName) {
      cutIn = {
        actorKey: event.actorKey,
        skillName: event.skillName,
        element: event.element ?? "light",
      };
      durationMs = Math.max(durationMs, 680);
    }

    switch (event.type) {
      case "damage": {
        if (target) {
          applyHp(target, event, -1);
          const kind: PlaybackFloatKind =
            typeof event.affinity === "number" && event.affinity >= 1.25
              ? "weak"
              : typeof event.affinity === "number" && event.affinity <= 0.8
                ? "resist"
                : "damage";
          float = {
            targetKey: target.key,
            text: kind === "weak" ? `弱点 -${event.amount ?? 0}` : `-${event.amount ?? 0}`,
            kind,
          };
          if (target.side === "player") vibrate = kind === "weak" ? [20, 20, 20] : 18;
          vfx = {
            kind: "attack",
            element: event.element ?? "fire",
            fromKey: event.actorKey,
            toKey: target.key,
            strong: kind === "weak" || (event.skillPower ?? 0) >= 80,
          };
          shakeIntensity = kind === "weak" || (event.skillPower ?? 0) >= 80 ? 3 : 1;
          se = kind === "weak" ? "weak" : "hit";
        } else {
          se = "hit";
        }
        break;
      }
      case "trait": {
        // 特性 thorns の反射ダメージ（対象は反射を受けた側）
        if (target) {
          applyHp(target, event, -1);
          float = { targetKey: target.key, text: `反射 -${event.amount ?? 0}`, kind: "trait" };
          if (target.side === "player") vibrate = 18;
          vfx = { kind: "attack", element: "fire", fromKey: event.actorKey, toKey: target.key };
          shakeIntensity = 1;
        }
        se = "status";
        break;
      }
      case "heal": {
        if (target) {
          applyHp(target, event, 1);
          float = { targetKey: target.key, text: `+${event.amount ?? 0}`, kind: "heal" };
          vfx = { kind: "heal", element: event.element ?? "water", fromKey: event.actorKey, toKey: target.key };
        }
        se = "heal";
        break;
      }
      case "shield": {
        if (target) {
          const before = target.shield;
          if (typeof event.shieldAfter === "number") target.shield = event.shieldAfter;
          else if (typeof event.amount === "number") {
            // 吸収か付与かは文面で判定する旧形式フォールバック
            target.shield = event.text.includes("吸収") ? Math.max(0, target.shield - event.amount) : target.shield + event.amount;
          }
          const granted = target.shield > before;
          const broke = !granted && target.shield === 0 && before > 0;
          float = {
            targetKey: target.key,
            text: granted ? `盾+${event.amount ?? 0}` : `盾-${event.amount ?? 0}`,
            kind: broke ? "shieldbreak" : "shield",
          };
          se = broke ? "break" : "guard";
          shieldFlashKey = target.key;
          if (granted) vfx = { kind: "shield", element: event.element ?? "earth", toKey: target.key };
          if (broke) shakeIntensity = 2;
        }
        break;
      }
      case "status": {
        if (typeof event.amount === "number" && target) {
          // やけどの経過ダメージ
          applyHp(target, event, -1);
          float = { targetKey: target.key, text: `やけど -${event.amount}`, kind: "burn" };
          if (target.side === "player") vibrate = 12;
          vfx = { kind: "status", element: "fire", toKey: target.key };
          se = "status";
        } else if (event.statusKind && target) {
          const kind = event.statusKind;
          const turns = STATUS_DURATIONS[kind] ?? 1;
          const existing = target.statuses.find((s) => s.kind === kind);
          if (existing) existing.turns = Math.max(existing.turns, turns);
          else target.statuses.push({ kind, turns });
          float = { targetKey: target.key, text: STATUS_FLOAT_LABEL[kind] ?? kind, kind: "status" };
          vfx = { kind: "status", element: event.element ?? "dark", toKey: target.key };
          se = "status";
        } else if (event.statusKind === "stun" && actor) {
          float = { targetKey: actor.key, text: "スタンで行動不能", kind: "status" };
          vfx = { kind: "status", element: "wind", toKey: actor.key };
          se = "status";
        }
        break;
      }
      case "death": {
        if (target) {
          target.hp = 0;
          target.alive = false;
          target.shield = 0;
          target.statuses = [];
          float = { targetKey: target.key, text: "撃破", kind: "death" };
          vibrate = target.side === "player" ? [40, 40, 40] : 25;
          vfx = { kind: "ko", element: "dark", toKey: target.key, strong: true };
          shakeIntensity = 3;
        }
        se = "ko";
        break;
      }
      case "info": {
        // 防御の宣言はバッジを1回膨らませる対象として拾う
        if (actor && event.text.includes("防御した")) {
          shieldFlashKey = actor.key;
          vfx = { kind: "shield", element: "earth", toKey: actor.key };
        } else if (cutIn) {
          se = "cutin";
        }
        break;
      }
      default:
        break;
    }

    steps.push({
      event,
      eventIndex,
      actors,
      durationMs,
      se,
      vibrate,
      float,
      shieldFlashKey,
      cutIn,
      vfx,
      shakeIntensity,
    });
  });

  return steps;
}

/** 速度モードに応じた実尺。2倍速は全拍0.5倍、撃破だけは360msを下限にする。 */
export function stepDurationMs(step: PlaybackStep, speed: "1x" | "2x"): number {
  if (speed === "1x") return step.durationMs;
  const halved = Math.round(step.durationMs / 2);
  return step.event.type === "death" ? Math.max(360, halved) : Math.max(150, halved);
}
