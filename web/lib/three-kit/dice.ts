// サイコロ一式のアニメーション管理（チンチロ・ヤッツィー共通）。
// 転がり中は各ダイスがランダムな軸で回りながら小刻みに跳ね、
// 終盤に目標の目が上へ来る向きへ収束して静止位置へ収まる。
// 状態（出目）は呼び出し側の lib が決める。ここは表現だけを担う。
import * as THREE from "three";
import { createDie, quaternionForDieValue, type DieMesh } from "./primitives";

interface DieAnim {
  mesh: DieMesh;
  rest: THREE.Vector3;
  heldRest: THREE.Vector3 | null;
  held: boolean;
  // 転がり状態
  rolling: boolean;
  t: number;
  duration: number;
  axis: THREE.Vector3;
  speed: number;
  fromPos: THREE.Vector3;
  hopSeed: number;
  targetQuat: THREE.Quaternion;
  value: number;
}

export interface DiceSetOptions {
  size?: number;
  body?: string;
  pip?: string;
  /** 静止位置（個数分）。 */
  restPositions: THREE.Vector3[];
  /** 保持時に移動する位置（任意、個数分）。 */
  heldPositions?: THREE.Vector3[];
  /** 転がり中の散らばり半径。 */
  scatter?: number;
}

export class DiceSet {
  readonly group = new THREE.Group();
  private dice: DieAnim[] = [];
  private scatter: number;
  private size: number;

  constructor(options: DiceSetOptions) {
    this.size = options.size ?? 1;
    this.scatter = options.scatter ?? 0.35;
    options.restPositions.forEach((rest, i) => {
      const mesh = createDie(this.size, { body: options.body, pip: options.pip });
      mesh.position.copy(rest);
      this.group.add(mesh);
      this.dice.push({
        mesh,
        rest: rest.clone(),
        heldRest: options.heldPositions ? options.heldPositions[i].clone() : null,
        held: false,
        rolling: false,
        t: 0,
        duration: 0.8,
        axis: new THREE.Vector3(1, 0, 0),
        speed: 0,
        fromPos: rest.clone(),
        hopSeed: Math.random() * Math.PI * 2,
        targetQuat: quaternionForDieValue(1, Math.random() * Math.PI * 2),
        value: 1,
      });
    });
  }

  /** レイキャスト対象（全ダイスのメッシュ）。 */
  meshes(): THREE.Object3D[] {
    return this.dice.map((d) => d.mesh);
  }

  /** ダイス i の現在の値（描画上の目）。 */
  valueAt(i: number): number {
    return this.dice[i]?.value ?? 1;
  }

  /** アニメーションなしで即座に目を合わせる。 */
  setInstant(values: number[]) {
    values.forEach((v, i) => {
      const d = this.dice[i];
      if (!d) return;
      d.value = v;
      d.rolling = false;
      d.targetQuat = quaternionForDieValue(v, (i * 1.37) % (Math.PI * 2));
      d.mesh.quaternion.copy(d.targetQuat);
      d.mesh.position.copy(d.held && d.heldRest ? d.heldRest : d.rest);
    });
  }

  /**
   * 転がし始める。skip[i] が true のダイスは転がさずそのまま（保持ダイス用）。
   * duration は個体ごとに少しずらして自然に止まるようにする。
   */
  roll(values: number[], options: { skip?: boolean[]; duration?: number } = {}) {
    const base = options.duration ?? 0.85;
    values.forEach((v, i) => {
      const d = this.dice[i];
      if (!d || options.skip?.[i]) return;
      d.value = v;
      d.rolling = true;
      d.t = 0;
      d.duration = base + i * 0.09 + Math.random() * 0.08;
      d.axis = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).normalize();
      d.speed = 11 + Math.random() * 7;
      d.fromPos.copy(d.mesh.position);
      d.hopSeed = Math.random() * Math.PI * 2;
      d.targetQuat = quaternionForDieValue(v, Math.random() * Math.PI * 2);
    });
  }

  /** 保持状態を反映する（保持ダイスは heldPositions へ寄る）。 */
  setHeld(index: number, held: boolean) {
    const d = this.dice[index];
    if (!d) return;
    d.held = held;
  }

  isRolling(): boolean {
    return this.dice.some((d) => d.rolling);
  }

  update(dt: number) {
    for (const d of this.dice) {
      if (d.rolling) {
        d.t += dt;
        const k = Math.min(1, d.t / d.duration);
        const rest = d.held && d.heldRest ? d.heldRest : d.rest;
        if (k < 0.62) {
          // 転がりフェーズ: 回転 + 小刻みな跳ね + 散らばり位置を周回
          const spin = new THREE.Quaternion().setFromAxisAngle(d.axis, d.speed * dt * (1 - k * 0.4));
          d.mesh.quaternion.premultiply(spin);
          const wob = Math.sin(d.t * 17 + d.hopSeed) * this.scatter * (1 - k);
          const wob2 = Math.cos(d.t * 13 + d.hopSeed * 1.7) * this.scatter * (1 - k);
          d.mesh.position.set(
            rest.x + wob,
            rest.y + Math.abs(Math.sin(d.t * 11 + d.hopSeed)) * this.size * 0.34 * (1 - k),
            rest.z + wob2,
          );
        } else {
          // 収束フェーズ: 目標の向きと静止位置へ寄せる
          const e = (k - 0.62) / 0.38;
          const ease = 1 - Math.pow(1 - e, 3);
          d.mesh.quaternion.slerp(d.targetQuat, Math.min(1, ease * 1.6));
          d.mesh.position.lerp(rest, Math.min(1, dt * 10));
          if (k >= 1) {
            d.rolling = false;
            d.mesh.quaternion.copy(d.targetQuat);
            d.mesh.position.copy(rest);
          }
        }
      } else {
        // 静止中: 保持位置の切り替えなどをなめらかに寄せる
        const target = d.held && d.heldRest ? d.heldRest : d.rest;
        if (d.mesh.position.distanceToSquared(target) > 1e-6) {
          d.mesh.position.lerp(target, Math.min(1, dt * 12));
        }
      }
    }
  }
}
