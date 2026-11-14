// ゲーム共通の 3D ステージ土台（three.js）。
// bowling / crocodile で重複していた「renderer 生成・ライト・リサイズ・
// レイキャスト・破棄」をここへ集約する。新しく 3D シーンを作るゲームは
// renderer を自前で書かず、必ず createStage を使うこと。
// このモジュールは three を import するため、import する側は
// next/dynamic (ssr: false) で遅延読み込みし、three を対象ゲームの
// チャンクだけに閉じること（共通 First Load JS を太らせない）。
import * as THREE from "three";

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

  const clock = new THREE.Clock();
  let raf = 0;
  let disposed = false;
  const animate = () => {
    if (disposed) return;
    raf = requestAnimationFrame(animate);
    const dt = Math.min(0.05, clock.getDelta());
    options.onFrame?.(dt, clock.elapsedTime);
    const w = container.clientWidth || 1;
    const h = container.clientHeight || 1;
    const pr = renderer.getPixelRatio();
    if (canvas.width !== Math.floor(w * pr) || canvas.height !== Math.floor(h * pr)) {
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
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
      camera.lookAt(...p.lookAt);
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
