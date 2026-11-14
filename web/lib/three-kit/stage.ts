// ゲーム共通の 3D ステージ土台（three.js）。
// bowling / crocodile で重複していた「renderer 生成・ライト・リサイズ・
// レイキャスト・破棄」をここへ集約する。新しく 3D シーンを作るゲームは
// renderer を自前で書かず、必ず createStage を使うこと。
// このモジュールは three を import するため、import する側は
// next/dynamic (ssr: false) で遅延読み込みし、three を対象ゲームの
// チャンクだけに閉じること（共通 First Load JS を太らせない）。
import * as THREE from "three";
import { clampIntensity, hitstopDurationMs, shakeOffsetAt, SHAKE_MS, type JuiceIntensity } from "../juice";

export interface CameraPreset {
  position: [number, number, number];
  lookAt: [number, number, number];
  fov: number;
}

/** 標準カメラプリセット。盤面系は boardTilt を基本にする。 */
export const CAMERA_PRESETS: Record<"boardTilt" | "topDown" | "front" | "lowAngle", CameraPreset> = {
  // 盤面を斜め上から見る（盤面・駒系の標準）。
  boardTilt: { position: [0, 7.2, 6.4], lookAt: [0, 0, 0.3], fov: 42 },
  // ほぼ真上（パズル盤面向け）。
  topDown: { position: [0, 10.5, 2.2], lookAt: [0, 0, 0.4], fov: 40 },
  // 正面寄り（スロット等の筐体系）。
  front: { position: [0, 2.2, 8.2], lookAt: [0, 0.6, 0], fov: 42 },
  // 低い角度（丼・ホイール等の物体系）。
  lowAngle: { position: [0, 4.4, 6.8], lookAt: [0, 0.2, 0], fov: 44 },
};

export interface StageOptions {
  background?: number;
  camera?: CameraPreset;
  /** devicePixelRatio の上限。モバイル性能のため既定 2、重いシーンは下げる。 */
  pixelRatioCap?: number;
  /** 毎フレーム呼ばれる（dt は 0.05 秒でクランプ済み、t は経過秒）。 */
  onFrame?: (dt: number, t: number) => void;
}

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  container: HTMLElement;
  /** スクリーン座標から targets へのレイキャスト。最も近いヒットを返す。 */
  pick: (targets: THREE.Object3D[], clientX: number, clientY: number) => THREE.Intersection | null;
  /** スクリーン座標と y=const 平面の交点を返す（ドラッグ移動用）。 */
  planePoint: (planeY: number, clientX: number, clientY: number) => THREE.Vector3 | null;
  /** カメラを即座にプリセット位置へ置く。 */
  setCamera: (preset: CameraPreset) => void;
  /**
   * ヒットストップ（櫻井流バッチ1、#003/#047）: アニメーションクロックを
   * 強さ3段（40/70/120ms）で一時停止する。描画自体は続け、onFrame には
   * dt=0・凍結した t が渡る。呼ばなければ従来動作のまま（オプトイン）。
   */
  hitstop: (intensity?: JuiceIntensity | number, power?: number) => void;
  /**
   * カメラシェイク（#103）: 強さでパターンを変え、振幅はカメラ距離で
   * 補正する。distanceScale は追加の倍率（既定1）。呼ばなければ無効。
   */
  shake: (intensity?: JuiceIntensity | number, distanceScale?: number) => void;
  dispose: () => void;
}

/**
 * ステージを生成する。WebGL が使えない環境では null を返すので、
 * 呼び出し側はその場合に既存 2D 表示へフォールバックすること。
 */
export function createStage(container: HTMLElement, options: StageOptions = {}): Stage | null {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true });
  } catch {
    return null;
  }
  const cap = options.pixelRatioCap ?? 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, cap));
  const canvas = renderer.domElement;
  canvas.style.display = "block";
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  canvas.style.touchAction = "none";
  container.appendChild(canvas);

  const scene = new THREE.Scene();
  if (options.background !== undefined) scene.background = new THREE.Color(options.background);

  const preset = options.camera ?? CAMERA_PRESETS.boardTilt;
  const camera = new THREE.PerspectiveCamera(preset.fov, 1, 0.1, 100);
  camera.position.set(...preset.position);
  camera.lookAt(...preset.lookAt);

  // 標準ライト（bowling / crocodile と同じ構成: 半球 + 主光 + 補助は任意）。
  scene.add(new THREE.HemisphereLight(0xffffff, 0x44505c, 1.05));
  const dir = new THREE.DirectionalLight(0xfff2d8, 1.55);
  dir.position.set(3.5, 7, 3);
  scene.add(dir);
  const back = new THREE.DirectionalLight(0xbfd4ff, 0.45);
  back.position.set(-2, 4, -6);
  scene.add(back);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const setNdc = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -(((clientY - rect.top) / rect.height) * 2 - 1));
  };
  const pick = (targets: THREE.Object3D[], clientX: number, clientY: number) => {
    setNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(targets, true);
    return hits.length > 0 ? hits[0] : null;
  };
  const planePoint = (planeY: number, clientX: number, clientY: number) => {
    setNdc(clientX, clientY);
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin;
    const d = raycaster.ray.direction;
    if (Math.abs(d.y) < 1e-6) return null;
    const t = (planeY - o.y) / d.y;
    if (t < 0) return null;
    return new THREE.Vector3(o.x + d.x * t, planeY, o.z + d.z * t);
  };

  // 手応え層（ヒットストップ/シェイク）はオプトイン。時刻は自前で積算し、
  // 凍結中は dt=0・t 固定で onFrame を呼び続ける（描画は止めない）。
  const lookTarget = new THREE.Vector3(...preset.lookAt);
  let lastNow = performance.now();
  let elapsed = 0;
  let freezeUntil = 0;
  let shakeStart = -1;
  let shakeDuration = 0;
  let shakeIntensity: JuiceIntensity = 2;
  let shakeScale = 1;
  const reducedMotion = () => {
    try {
      return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    } catch {
      return false;
    }
  };

  let raf = 0;
  let disposed = false;
  const animate = () => {
    if (disposed) return;
    raf = requestAnimationFrame(animate);
    const now = performance.now();
    const rawDt = Math.min(0.05, Math.max(0, (now - lastNow) / 1000));
    lastNow = now;
    const frozen = now < freezeUntil;
    const dt = frozen ? 0 : rawDt;
    if (!frozen) elapsed += dt;
    options.onFrame?.(dt, elapsed);
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    // カメラシェイク: 描画の間だけオフセットを足し、描画後に戻す
    // （カメラの基準位置は壊さない）。振幅はカメラ距離で補正する（#103）。
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (shakeStart >= 0) {
      const p = (now - shakeStart) / shakeDuration;
      if (p >= 1) {
        shakeStart = -1;
      } else {
        const off = shakeOffsetAt(shakeIntensity, p);
        const dist = camera.position.distanceTo(lookTarget);
        const k = 0.012 * shakeScale * (dist / 9);
        ox = off.x * k;
        oy = off.y * k;
        oz = shakeIntensity === 3 ? off.y * k * 0.5 : 0;
      }
    }
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      camera.position.x += ox;
      camera.position.y += oy;
      camera.position.z += oz;
    }
    renderer.render(scene, camera);
    if (ox !== 0 || oy !== 0 || oz !== 0) {
      camera.position.x -= ox;
      camera.position.y -= oy;
      camera.position.z -= oz;
    }
  };
  animate();

  return {
    renderer,
    scene,
    camera,
    canvas,
    container,
    pick,
    planePoint,
    setCamera: (p: CameraPreset) => {
      camera.position.set(...p.position);
      camera.fov = p.fov;
      camera.updateProjectionMatrix();
      lookTarget.set(...p.lookAt);
      camera.lookAt(...p.lookAt);
    },
    hitstop: (intensity: JuiceIntensity | number = 2, power = 1) => {
      const ms = hitstopDurationMs(clampIntensity(intensity), power);
      freezeUntil = Math.max(freezeUntil, performance.now() + ms);
    },
    shake: (intensity: JuiceIntensity | number = 2, distanceScale = 1) => {
      if (reducedMotion()) return;
      shakeIntensity = clampIntensity(intensity);
      shakeScale = Number.isFinite(distanceScale) && distanceScale > 0 ? distanceScale : 1;
      shakeDuration = SHAKE_MS[shakeIntensity];
      shakeStart = performance.now();
    },
    dispose: () => {
      disposed = true;
      cancelAnimationFrame(raf);
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const mat = (mesh as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) mat.dispose();
      });
      renderer.dispose();
      if (canvas.parentElement === container) container.removeChild(canvas);
    },
  };
}
