"use client";
// あみだくじの 3D はしご。縦棒は奥行き方向に伸びるレール、横棒は段の
// 中ほどで隣のレールをつなぐバーとして立体化する。参加者名と景品は
// 盤の両端に大きな文字のプレート（CanvasTexture）で置き、2D と同じく
// DOM 側の入力欄でも編集できる。
// 経路の計算は親が lib のトレースで行い、ここは受け取った経路を赤い
// チューブで描き、自分の駒（球）をその経路に沿って滑らかに追従させる
// だけ（段ごとの到達先や結果はここでは計算しない）。
// 入力はスタート位置のタップだけ: 参加者名プレート／開始マーカーを
// 押すと親の startTrace が走る（現行の「〜の経路」ボタンと同じ経路）。
// 結果テキスト・全員の結果一覧は親の DOM 併記が担う。
// WebGL が使えない場合は onFail で親へ知らせ、親は 2D 表示に切り替える。
import { useEffect, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import { createStage, type Stage } from "@/lib/three-kit/stage";
import { canvasTexture, createBall } from "@/lib/three-kit/primitives";
import { attachPickPointer } from "@/lib/three-kit/pointer";
import SceneBox from "@/lib/three-kit/SceneBox";
import type { AmidaState } from "@/lib/amida";

interface Props {
  amida: AmidaState;
  names: string[];
  prizes: string[];
  /** 選択中参加者の経路（親が lib で計算した結果）。未選択なら null。 */
  trace: { path: number[]; end: number } | null;
  /** 経路の描画済みステップ数（親のタイマーが進める）。 */
  step: number;
  /** スタート位置タップ（現行の startTrace ハンドラ）。 */
  onStart: (index: number) => void;
  onFail: () => void;
  fallback: ReactNode;
}

const X_STEP = 1.0;
const Z_STEP = 0.62;
const RAIL_COLOR = 0x8a90a3;
const TRACE_COLOR = 0xd8542e;
const TOKEN_COLORS = [0xd8542e, 0x3f7fbf, 0x46a758, 0xe09f3e, 0x8b5cf6, 0xec6fa5, 0x2aa7a0, 0xb0722f];

function colX(x: number, count: number): number {
  return (x - (count - 1) / 2) * X_STEP;
}
function levelZ(level: number, levels: number): number {
  return (level - levels / 2) * Z_STEP;
}

/** 盤の大きさと表示エリアのアスペクトから、全体が収まるカメラへ寄せる。 */
function fitCamera(stage: Stage, container: HTMLElement, count: number, levels: number) {
  const w = container.clientWidth || 560;
  const h = container.clientHeight || 520;
  const aspect = w / h;
  const vFov = (42 * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const extentX = count * X_STEP + 1.6;
  const extentZ = levels * Z_STEP + 2.4;
  const distW = (extentX / 2) / Math.tan(hFov / 2);
  const distD = ((extentZ / 2) / Math.tan(vFov / 2)) * 0.72;
  const dist = Math.max(distW, distD) + 1.2;
  stage.setCamera({
    position: [0, dist * 0.86, dist * 0.55],
    lookAt: [0, 0, 0.25],
    fov: 42,
  });
}

/** 2点間を結ぶ円柱セグメント（レール・横棒・経路チューブ共通）。 */
function createSegment(a: THREE.Vector3, b: THREE.Vector3, radius: number, mat: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a);
  const len = dir.length();
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, Math.max(len, 0.01), 10), mat);
  mesh.position.copy(a).addScaledVector(dir, 0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
  return mesh;
}

/** 名前／景品の大きな文字プレート（盤面に平置きし、傾斜カメラから読む）。 */
function createLabelPlate(text: string, bg: string, fg: string, keyPrefix: string): THREE.Mesh {
  const tex = canvasTexture(`${keyPrefix}-${bg}-${text}`, 256, 112, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 256, 112);
    g.fillStyle = fg;
    const fontSize = text.length <= 2 ? 56 : text.length <= 5 ? 46 : 34;
    g.font = `bold ${fontSize}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 128, 58);
  });
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(0.94, 0.42),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.6 }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

interface SceneRt {
  stage: Stage;
  root: THREE.Group;
  ladderGroup: THREE.Group | null;
  ladderSig: string;
  labelGroup: THREE.Group | null;
  labelSig: string;
  traceGroup: THREE.Group | null;
  traceSig: string;
  hits: THREE.Mesh[];
  marker: THREE.Mesh | null;
  markerPos: THREE.Vector3;
  markerTarget: THREE.Vector3;
  markerSel: number | null;
}

export default function AmidaScene3D({ amida, names, prizes, trace, step, onStart, onFail, fallback }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const rtRef = useRef<SceneRt | null>(null);
  const propsRef = useRef({ onStart });
  propsRef.current = { onStart };
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let detach: (() => void) | null = null;
    const stage = createStage(container, {
      background: 0xfbfcfe,
      camera: { position: [0, 8, 5.4], lookAt: [0, 0, 0.25], fov: 42 },
      onFrame: (dt) => {
        const rt = rtRef.current;
        if (!rt?.marker) return;
        // 駒は親が進めるステップの目標点へ指数追従で滑らかに動く。
        const k = 1 - Math.exp(-dt * 10);
        rt.markerPos.lerp(rt.markerTarget, k);
        rt.marker.position.copy(rt.markerPos);
      },
    });
    if (!stage) {
      setFailed(true);
      onFailRef.current();
      return;
    }
    const root = new THREE.Group();
    stage.scene.add(root);
    rtRef.current = {
      stage, root,
      ladderGroup: null, ladderSig: "",
      labelGroup: null, labelSig: "",
      traceGroup: null, traceSig: "",
      hits: [],
      marker: null,
      markerPos: new THREE.Vector3(),
      markerTarget: new THREE.Vector3(),
      markerSel: null,
    };
    detach = attachPickPointer(stage, () => rtRef.current?.hits ?? [], {
      onTap: (hit) => {
        const id = hit?.object.userData.pickId as string | undefined;
        if (id) propsRef.current.onStart(Number(id.slice(6)));
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

  // はしご本体の同期（構造が変わったときだけ作り直す）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = JSON.stringify(amida.bars);
    if (rt.ladderSig !== sig) {
      rt.ladderSig = sig;
      if (rt.ladderGroup) rt.root.remove(rt.ladderGroup);
      const grp = new THREE.Group();
      // 土台（現行 2D の白い盤）。
      const depth = amida.levels * Z_STEP + 2.2;
      const width = amida.count * X_STEP + 0.7;
      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(width, 0.24, depth),
        new THREE.MeshStandardMaterial({ color: 0xeef1f6, roughness: 0.9 }),
      );
      slab.position.y = -0.12;
      grp.add(slab);
      const railMat = new THREE.MeshStandardMaterial({ color: RAIL_COLOR, roughness: 0.45, metalness: 0.35 });
      // 縦棒（レール）。
      for (let x = 0; x < amida.count; x++) {
        grp.add(createSegment(
          new THREE.Vector3(colX(x, amida.count), 0.16, levelZ(0, amida.levels)),
          new THREE.Vector3(colX(x, amida.count), 0.16, levelZ(amida.levels, amida.levels)),
          0.045, railMat,
        ));
      }
      // 横棒（段の中ほどで隣をつなぐ）。
      amida.bars.forEach((row, level) => {
        row.forEach((bar, i) => {
          if (!bar) return;
          const z = levelZ(level, amida.levels) + Z_STEP / 2;
          grp.add(createSegment(
            new THREE.Vector3(colX(i, amida.count), 0.16, z),
            new THREE.Vector3(colX(i + 1, amida.count), 0.16, z),
            0.045, railMat,
          ));
        });
      });
      rt.root.add(grp);
      rt.ladderGroup = grp;
      // スタート位置の当たり判定（名前プレート＋開始マーカー帯）。
      rt.hits = [];
      const hitGeo = new THREE.BoxGeometry(X_STEP * 0.96, 0.9, 1.15);
      for (let x = 0; x < amida.count; x++) {
        const h = new THREE.Mesh(hitGeo, new THREE.MeshBasicMaterial({ visible: false }));
        h.position.set(colX(x, amida.count), 0.35, levelZ(0, amida.levels) - 0.62);
        h.userData.pickId = `start-${x}`;
        grp.add(h);
        rt.hits.push(h);
        // 開始マーカー: 参加者色の小球（ゴール側は景品プレートのみ）。
        const token = createBall(0.13, TOKEN_COLORS[x % TOKEN_COLORS.length]);
        token.position.set(colX(x, amida.count), 0.2, levelZ(0, amida.levels) - 0.18);
        grp.add(token);
      }
      const container = containerRef.current;
      if (container) fitCamera(rt.stage, container, amida.count, amida.levels);
    }
  }, [amida]);

  // 名前／景品プレートの同期（文言が変わったときだけ作り直す）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = JSON.stringify({ names, prizes, count: amida.count, levels: amida.levels });
    if (rt.labelSig === sig) return;
    rt.labelSig = sig;
    if (rt.labelGroup) rt.root.remove(rt.labelGroup);
    const grp = new THREE.Group();
    for (let x = 0; x < amida.count; x++) {
      const namePlate = createLabelPlate(names[x] || `${x + 1}`, "#ffffff", "#1c2333", "amida-name");
      namePlate.position.set(colX(x, amida.count), 0.02, levelZ(0, amida.levels) - 0.68);
      grp.add(namePlate);
      const prizePlate = createLabelPlate(prizes[x] || `景品 ${x + 1}`, "#fff3cf", "#1c2333", "amida-prize");
      prizePlate.position.set(colX(x, amida.count), 0.02, levelZ(amida.levels, amida.levels) + 0.62);
      grp.add(prizePlate);
    }
    rt.root.add(grp);
    rt.labelGroup = grp;
  }, [amida, names, prizes]);

  // 経路と駒の同期: 親から受けた経路を、2D と同じ「段の中ほどで横へ移る」
  // 折れ線に展開して描く（経路そのものは再計算しない）。
  useEffect(() => {
    const rt = rtRef.current;
    if (!rt) return;
    const sig = JSON.stringify({ trace, step });
    if (rt.traceSig === sig) return;
    rt.traceSig = sig;
    if (rt.traceGroup) rt.root.remove(rt.traceGroup);
    rt.traceGroup = null;
    if (!trace || trace.path.length === 0 || step <= 0) {
      rt.marker = null;
      rt.markerSel = null;
      return;
    }
    const grp = new THREE.Group();
    const pts: THREE.Vector3[] = [new THREE.Vector3(colX(trace.path[0], amida.count), 0.3, levelZ(0, amida.levels))];
    const shownLevels = Math.min(step - 1, amida.levels);
    for (let level = 0; level < shownLevels; level++) {
      const before = trace.path[level];
      const after = trace.path[level + 1];
      const zMid = levelZ(level, amida.levels) + Z_STEP / 2;
      if (after !== before) {
        pts.push(new THREE.Vector3(colX(before, amida.count), 0.3, zMid));
        pts.push(new THREE.Vector3(colX(after, amida.count), 0.3, zMid));
      }
      pts.push(new THREE.Vector3(colX(after, amida.count), 0.3, levelZ(level + 1, amida.levels)));
    }
    const mat = new THREE.MeshStandardMaterial({ color: TRACE_COLOR, roughness: 0.35, emissive: 0xd8542e, emissiveIntensity: 0.25 });
    for (let i = 0; i + 1 < pts.length; i++) grp.add(createSegment(pts[i], pts[i + 1], 0.06, mat));
    // 自分の駒: 経路の最新到達点へ追従する球。選択が変わったら開始点へ戻す。
    const marker = createBall(0.17, TRACE_COLOR, { roughness: 0.25 });
    const startPt = pts[0];
    const target = pts[pts.length - 1];
    if (rt.markerSel !== trace.path[0]) {
      rt.markerPos.copy(startPt);
      rt.markerSel = trace.path[0];
    }
    rt.markerTarget.copy(target);
    marker.position.copy(rt.markerPos);
    grp.add(marker);
    rt.marker = marker;
    rt.root.add(grp);
    rt.traceGroup = grp;
  }, [amida, trace, step]);

  return (
    <SceneBox
      height={520}
      label="あみだくじ（3D）。参加者名のプレートをタップすると経路をたどります"
      ready={ready}
      failed={failed}
      fallback={fallback}
      containerRef={containerRef}
      background="#fbfcfe"
    />
  );
}
