"use client";
// ラッシュアワーの 3D 盤。車=長さ2/3の直方体（自車は赤、他車は現行 2D と
// 同じ色分け、縦横の向き保持、上に少し小さい屋根を載せて車らしく見せる）。
// 出口は盤の右端の開口＋赤い色帯で表す（矢印は使わない）。
// 操作は現行のタップ選択＋車のドラッグ（軸方向のみ）:
//   車タップ = 親の onTapCar（選択の付け外しは親が決める）
//   車ドラッグ = 掴んだ車を軸方向へ視覚的に追従させ、離した時点で
//     セル単位の delta を親の onSlide へ1回だけ渡す。現行仕様どおり
//     「距離を問わない1回のスライド = 1手」を守るため、ドラッグ中に
//     逐次確定はしない。動ける範囲は親が lib の rushSlideRange で計算して
//     ranges として渡し、3D 側では合法判定を再実装しない。
//   移動ボタン（DOM）からのスライドも同じ差分同期で補間追従する。
// 手数・ベスト・状態文は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import { RUSH_EXIT_ROW, RUSH_SIZE, type RushCar } from "@/lib/rushhour";

interface Props {
  cars: RushCar[];
  selected: number | null;
  status: "playing" | "won";
  /** 車ごとのスライド可能範囲（親が lib の rushSlideRange で計算）。 */
  ranges: Record<number, { min: number; max: number }>;
  /** 車タップ（現行の選択トグル ハンドラ）。 */
  onTapCar: (carId: number) => void;
  /** ドラッグ開始で車を掴んだとき（選択をその車へ寄せる）。 */
  onGrabCar: (carId: number) => void;
  /** ドラッグ確定（delta セル分を1回のスライドとして親の rushSlide へ）。 */
  onSlide: (carId: number, delta: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const PITCH = 1.0;
/** 現行 2D の CAR_COLORS と同じ色分け。 */
const CAR_COLORS = [
  0x3b82f6, 0x22c55e, 0xa855f7, 0xf59e0b, 0x06b6d4,
  0x84cc16, 0xec4899, 0x6366f1, 0xf97316, 0x14b8a6, 0xeab308,
];
const TARGET_COLOR = 0xdc2626;

function carCenter(car: RushCar): [number, number] {
  const cx = car.dir === "h" ? car.col + (car.len - 1) / 2 : car.col;
  const cz = car.dir === "v" ? car.row + (car.len - 1) / 2 : car.row;
  return [(cx - (RUSH_SIZE - 1) / 2) * PITCH, (cz - (RUSH_SIZE - 1) / 2) * PITCH];
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement) {
  const w = container.clientWidth || 480;
  const h = container.clientHeight || 460;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const distW = (RUSH_SIZE / 2 + 1.1) / Math.tan(hFov / 2);
  const distD = ((RUSH_SIZE / 2 + 0.9) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.4;
  stage.setCamera({
    position: [0, dist * 0.82, dist * 0.58],
    lookAt: [0, 0, 0.2],
    fov: 42,
  });
}

/** 車の造形（直方体のボディ＋屋根）。選択枠は別メッシュで付け外しする。 */
function createCarMesh(car: RushCar): { grp: THREE.Group; selFrame: THREE.Mesh } {
  const grp = new THREE.Group();
  const color = car.target ? TARGET_COLOR : CAR_COLORS[car.id % CAR_COLORS.length];
  const alongX = car.dir === "h";
  const bodyLen = car.len * PITCH - 0.14;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(alongX ? bodyLen : 0.8, 0.4, alongX ? 0.8 : bodyLen),
    new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.08 }),
  );
  body.position.y = 0.26;
  grp.add(body);
  const roofLen = bodyLen * 0.52;
  const roof = new THREE.Mesh(
    new THREE.BoxGeometry(alongX ? roofLen : 0.62, 0.2, alongX ? 0.62 : roofLen),
    new THREE.MeshStandardMaterial({
      color: new THREE.Color(color).multiplyScalar(0.72),
      roughness: 0.3,
      metalness: 0.1,
    }),
  );
  roof.position.y = 0.56;
  grp.add(roof);
  // 選択枠（現行 2D の琥珀色の太枠に相当。普段は隠す）。
  const selFrame = new THREE.Mesh(
    new THREE.BoxGeometry(alongX ? bodyLen + 0.14 : 0.94, 0.06, alongX ? 0.94 : bodyLen + 0.14),
    new THREE.MeshStandardMaterial({ color: 0xf59e0b, roughness: 0.4, emissive: 0xf59e0b, emissiveIntensity: 0.35 }),
  );
  selFrame.position.y = 0.04;
  selFrame.visible = false;
  grp.add(selFrame);
  return { grp, selFrame };
}

interface CarRt {
  grp: THREE.Group;
  selFrame: THREE.Mesh;
  sig: string;
  tx: number;
  tz: number;
}

interface DragRt {
  carId: number;
  basePoint: THREE.Vector3 | null;
  origX: number;
  origZ: number;
  min: number;
  max: number;
  curDelta: number;
}

interface SceneRt {
  stage: Stage;
  boardGroup: THREE.Group;
  hits: THREE.Mesh[];
  hitsBuilt: boolean;
  carsRt: Map<number, CarRt>;
  drag: DragRt | null;
}

export default function RushHourScene3D({
  cars, selected, status, ranges, onTapCar, onGrabCar, onSlide, onFail, fallback,
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ cars, status, ranges, onTapCar, onGrabCar, onSlide });
  propsRef.current = { cars, status, ranges, onTapCar, onGrabCar, onSlide };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0x3a4550,
      camera: { position: [0, 8, 5.6], lookAt: [0, 0, 0.2], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt) return;
        // ドラッグ中の車以外は目標セルへ滑らかに追従させる。
        const k = 1 - Math.exp(-dt * 12);
        for (const [id, c] of rt.carsRt) {
          if (rt.drag && rt.drag.carId === id) continue;
          c.grp.position.x += (c.tx - c.grp.position.x) * k;
          c.grp.position.z += (c.tz - c.grp.position.z) * k;
        }
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const { scene } = stage;
    const boardGroup = new THREE.Group();
    scene.add(boardGroup);

    // 床（現行 2D の薄いグレー盤）。
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(RUSH_SIZE * PITCH + 0.3, 0.24, RUSH_SIZE * PITCH + 0.3),
      new THREE.MeshStandardMaterial({ color: 0xe8edf2, roughness: 0.9 }),
    );
    floor.position.y = -0.12;
    boardGroup.add(floor);
    // マス目の溝。
    const grooveMat = new THREE.MeshStandardMaterial({ color: 0xcbd5e1, roughness: 0.9 });
    for (let i = 1; i < RUSH_SIZE; i++) {
      const gx = (i - RUSH_SIZE / 2) * PITCH;
      const gv = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.02, RUSH_SIZE * PITCH), grooveMat);
      gv.position.set(gx, 0.012, 0);
      boardGroup.add(gv);
      const gh = new THREE.Mesh(new THREE.BoxGeometry(RUSH_SIZE * PITCH, 0.02, 0.035), grooveMat);
      gh.position.set(0, 0.012, gx);
      boardGroup.add(gh);
    }
    // 外周の壁。右端だけ出口行に開口を空ける。
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x94a3b8, roughness: 0.7 });
    const wallH = 0.5;
    const edge = RUSH_SIZE * PITCH / 2 + 0.22;
    const mkWall = (w: number, d: number, x: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
      m.position.set(x, wallH / 2, z);
      boardGroup.add(m);
    };
    mkWall(0.14, RUSH_SIZE * PITCH + 0.6, -edge, 0); // 左
    mkWall(RUSH_SIZE * PITCH + 0.6, 0.14, 0, -edge); // 奥
    mkWall(RUSH_SIZE * PITCH + 0.6, 0.14, 0, edge); // 手前
    // 右: 出口行の上下に分割して開口を作る。
    const exitZ = (RUSH_EXIT_ROW - (RUSH_SIZE - 1) / 2) * PITCH;
    const segLenTop = exitZ - PITCH / 2 + RUSH_SIZE * PITCH / 2;
    const segLenBottom = RUSH_SIZE * PITCH / 2 - (exitZ + PITCH / 2);
    if (segLenTop > 0.01) mkWall(0.14, segLenTop, edge, -RUSH_SIZE * PITCH / 2 + segLenTop / 2);
    if (segLenBottom > 0.01) mkWall(0.14, segLenBottom, edge, RUSH_SIZE * PITCH / 2 - segLenBottom / 2);
    // 出口の色帯（床の延長＋右端の帯。矢印ではなく色で示す）。
    const bandMat = new THREE.MeshStandardMaterial({ color: 0xef4444, roughness: 0.55 });
    const bandFloor = new THREE.Mesh(new THREE.BoxGeometry(0.85, 0.05, PITCH * 0.92), bandMat);
    bandFloor.position.set(RUSH_SIZE * PITCH / 2 + 0.42, 0.03, exitZ);
    boardGroup.add(bandFloor);
    const bandPost = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.62, PITCH * 0.92), bandMat);
    bandPost.position.set(edge + 0.55, 0.31, exitZ);
    boardGroup.add(bandPost);

    rtRef.current = { stage, boardGroup, hits: [], hitsBuilt: false, carsRt: new Map(), drag: null };

    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onTapCar(Number(id.slice(4)));
      },
      onDragStart: (hit) => {
        const rt = rtRef.current;
        const id = hit.object.userData.pickId as string | undefined;
        if (!rt || !id) return;
        const carId = Number(id.slice(4));
        const car = propsRef.current.cars.find((c) => c.id === carId);
        const range = propsRef.current.ranges[carId];
        const crt = rt.carsRt.get(carId);
        if (!car || !range || !crt || propsRef.current.status !== "playing") return;
        propsRef.current.onGrabCar(carId);
        rt.drag = {
          carId,
          basePoint: null,
          origX: crt.grp.position.x,
          origZ: crt.grp.position.z,
          min: range.min,
          max: range.max,
          curDelta: 0,
        };
      },
      onDragMove: (point) => {
        const rt = rtRef.current;
        if (!rt?.drag) return;
        const drag = rt.drag;
        const car = propsRef.current.cars.find((c) => c.id === drag.carId);
        const crt = rt.carsRt.get(drag.carId);
        if (!car || !crt) return;
        if (!drag.basePoint) {
          drag.basePoint = point.clone();
          return;
        }
        // 軸方向の移動量だけをセル単位へ丸め、親から渡された範囲で止める。
        const raw = car.dir === "h"
          ? (point.x - drag.basePoint.x) / PITCH
          : (point.z - drag.basePoint.z) / PITCH;
        const delta = Math.max(drag.min, Math.min(drag.max, Math.round(raw)));
        drag.curDelta = delta;
        if (car.dir === "h") crt.grp.position.x = drag.origX + delta * PITCH;
        else crt.grp.position.z = drag.origZ + delta * PITCH;
      },
      onDragEnd: () => {
        const rt = rtRef.current;
        if (!rt?.drag) return;
        const { carId, curDelta } = rt.drag;
        rt.drag = null;
        // 確定は1回だけ（距離を問わず1手）。0 なら差分同期で元の位置へ戻る。
        if (curDelta !== 0) propsRef.current.onSlide(carId, curDelta);
      },
    });
    setReady(true);
    return () => {
      detach?.();
      stage.dispose();
      rtRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 車の差分同期: 構造（長さ・向き・対象）が変わった車だけ作り直し、
  // 位置は目標セルとして保持して onFrame で追従させる。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const { stage, boardGroup } = rt;
    if (!rt.hitsBuilt) {
      rt.hitsBuilt = true;
      const container = containerRef.current;
      if (container) fitCamera(stage, container);
    }
    const seen = new Set<number>();
    for (const car of cars) {
      seen.add(car.id);
      const sig = `${car.len}|${car.dir}|${car.target ? 1 : 0}`;
      let crt = rt.carsRt.get(car.id);
      if (!crt || crt.sig !== sig) {
        if (crt) {
          boardGroup.remove(crt.grp);
          rt.hits = rt.hits.filter((h) => h.userData.pickId !== `car-${car.id}`);
        }
        const { grp, selFrame } = createCarMesh(car);
        const [x, z] = carCenter(car);
        grp.position.set(x, 0, z);
        boardGroup.add(grp);
        // 当たり判定は車の占有範囲に合わせた見えない箱。
        const hit = new THREE.Mesh(
          new THREE.BoxGeometry(
            car.dir === "h" ? car.len * PITCH * 0.98 : PITCH * 0.98,
            0.95,
            car.dir === "v" ? car.len * PITCH * 0.98 : PITCH * 0.98,
          ),
          new THREE.MeshBasicMaterial({ visible: false }),
        );
        hit.position.set(x, 0.4, z);
        hit.userData.pickId = `car-${car.id}`;
        hit.userData.carId = car.id;
        boardGroup.add(hit);
        rt.hits.push(hit);
        crt = { grp, selFrame, sig, tx: x, tz: z };
        rt.carsRt.set(car.id, crt);
      }
      const [x, z] = carCenter(car);
      crt.tx = x;
      crt.tz = z;
      crt.selFrame.visible = selected === car.id;
      // ドラッグ中でない車の当たり判定は車の現在位置へ追従させる。
      if (!rt.drag || rt.drag.carId !== car.id) {
        const hit = rt.hits.find((h) => h.userData.pickId === `car-${car.id}`);
        if (hit) hit.position.set(crt.grp.position.x, 0.4, crt.grp.position.z);
      }
    }
    for (const [id, crt] of [...rt.carsRt]) {
      if (seen.has(id)) continue;
      boardGroup.remove(crt.grp);
      rt.carsRt.delete(id);
      rt.hits = rt.hits.filter((h) => h.userData.pickId !== `car-${id}`);
    }
  }, [cars, selected, status]);

  return (
    <SceneBox
      height={460}
      label="ラッシュアワーの盤（3D）。車をタップで選択、ドラッグでスライドします"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#3a4550"
    />
  );
}
