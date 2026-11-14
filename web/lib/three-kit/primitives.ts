// three-kit のプリミティブ部品。造形はプリミティブ＋CanvasTexture 中心で、
// 重いテクスチャや外部アセットは使わない。数字・文字は正面から読める
// 大きさで CanvasTexture に描く（テクスチャ内にだけ小さく置かない）。
import * as THREE from "three";

const textureCache = new Map<string, THREE.CanvasTexture>();

/** CanvasTexture を作る（同一キーは使い回す）。 */
export function canvasTexture(key: string, w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const hit = textureCache.get(key);
  if (hit) return hit;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  draw(g, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  textureCache.set(key, tex);
  return tex;
}

function roundedRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// ---- サイコロ ----
// 面の値の割り当て（BoxGeometry の素材順 [+x, -x, +y, -y, +z, -z]）。
// 向かい合う面の合計が 7 になる標準配置。
export const DIE_FACE_VALUES = [3, 4, 1, 6, 2, 5] as const;
const DIE_FACE_NORMALS: THREE.Vector3[] = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
];

function pipTexture(value: number, pipColor: string, bg: string): THREE.CanvasTexture {
  return canvasTexture(`die-${value}-${pipColor}-${bg}`, 128, 128, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 128, 128);
    g.fillStyle = pipColor;
    const P = (x: number, y: number, r = 13) => {
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    };
    const lo = 32, mid = 64, hi = 96;
    if (value === 1) P(mid, mid, 20);
    else if (value === 2) { P(lo, lo); P(hi, hi); }
    else if (value === 3) { P(lo, lo); P(mid, mid); P(hi, hi); }
    else if (value === 4) { P(lo, lo); P(hi, lo); P(lo, hi); P(hi, hi); }
    else if (value === 5) { P(lo, lo); P(hi, lo); P(mid, mid); P(lo, hi); P(hi, hi); }
    else if (value === 6) { P(lo, lo); P(hi, lo); P(lo, mid); P(hi, mid); P(lo, hi); P(hi, hi); }
  });
}

/**
 * 指定の目が真上に来る向き（クォータニオン）。yaw は見た目のばらつき用に
 * 呼び出し側で Y 回転を重ねてよい。
 */
export function quaternionForDieValue(value: number, yaw = 0): THREE.Quaternion {
  const idx = DIE_FACE_VALUES.indexOf(value as (typeof DIE_FACE_VALUES)[number]);
  const normal = DIE_FACE_NORMALS[idx >= 0 ? idx : 2];
  const q = new THREE.Quaternion().setFromUnitVectors(normal, new THREE.Vector3(0, 1, 0));
  if (yaw !== 0) q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
  return q;
}

export interface DieMesh extends THREE.Mesh {
  userData: { dieValue: number };
}

/** 目つきサイコロ（角丸はジオメトリではなくテクスチャ側の余白で表現）。 */
export function createDie(size = 1, options: { body?: string; pip?: string; accentPip?: string } = {}): DieMesh {
  const body = options.body ?? "#ffffff";
  const pip = options.pip ?? "#23272e";
  const accent = options.accentPip ?? "#c0392b";
  const mats = DIE_FACE_VALUES.map((v) => {
    const tex = pipTexture(v, v === 1 || v === 4 ? accent : pip, body);
    // 面の周囲に余白（角丸っぽさ）を付けるため、テクスチャを面全体に使う素朴な構成にする。
    void roundedRect;
    return new THREE.MeshStandardMaterial({ map: tex, roughness: 0.38, metalness: 0.02 });
  });
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size, size, size), mats) as unknown as DieMesh;
  mesh.userData.dieValue = 1;
  return mesh;
}

// ---- 円盤・石 ----

/** 平たい円盤（リバーシの石・チェッカー駒など）。両面で色を変えられる。 */
export function createDisc(radius: number, height: number, topColor: number, bottomColor?: number): THREE.Group {
  const grp = new THREE.Group();
  const side = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.5 });
  const top = new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.35 });
  const bottom = new THREE.MeshStandardMaterial({ color: bottomColor ?? topColor, roughness: 0.35 });
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, height, 28), [side, top, bottom]);
  grp.add(cyl);
  const rim = new THREE.Mesh(
    new THREE.TorusGeometry(radius * 0.72, height * 0.16, 8, 28),
    new THREE.MeshStandardMaterial({ color: topColor, roughness: 0.3 }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = height / 2;
  grp.add(rim);
  return grp;
}

/** 碁石のような扁平な球。 */
export function createStone(radius: number, color: number): THREE.Mesh {
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(radius, 20, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.28, metalness: 0.05 }),
  );
  m.scale.y = 0.55;
  return m;
}

/** コイン型チップ（カジノチップ）。上面にリングと額面を描く。 */
export function createChip(radius: number, color: number, label?: string): THREE.Group {
  const grp = new THREE.Group();
  const tex = canvasTexture(`chip-${color}-${label ?? ""}`, 128, 128, (g) => {
    g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    g.fillRect(0, 0, 128, 128);
    g.strokeStyle = "rgba(255,255,255,0.85)";
    g.lineWidth = 7;
    g.beginPath();
    g.arc(64, 64, 46, 0, Math.PI * 2);
    g.stroke();
    if (label) {
      g.fillStyle = "#ffffff";
      g.font = "bold 44px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, 64, 66);
    }
  });
  const sideTex = canvasTexture(`chip-side-${color}`, 256, 32, (g) => {
    g.fillStyle = `#${color.toString(16).padStart(6, "0")}`;
    g.fillRect(0, 0, 256, 32);
    g.fillStyle = "rgba(255,255,255,0.9)";
    for (let i = 0; i < 6; i++) g.fillRect(i * 42 + 8, 0, 16, 32);
  });
  const mats = [
    new THREE.MeshStandardMaterial({ map: sideTex, roughness: 0.45 }),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.4 }),
  ];
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, radius * 0.32, 28), mats);
  grp.add(cyl);
  return grp;
}

// ---- カード ----

/** 薄いカード。表面には大きな文字/記号を1つ描ける。 */
export function createCard(width: number, height: number, options: { face?: string; back?: number; label?: string; labelColor?: string } = {}): THREE.Mesh {
  const face = options.face ?? "#ffffff";
  const label = options.label;
  const faceTex = canvasTexture(`card-${face}-${label ?? ""}-${options.labelColor ?? ""}`, 128, 176, (g) => {
    g.fillStyle = face;
    g.fillRect(0, 0, 128, 176);
    if (label) {
      g.fillStyle = options.labelColor ?? "#23272e";
      // 複合ラベル（ランク+スート等、例 "A♠" / "10♠"）がはみ出さないよう
      // 文字数に応じてフォントサイズを落とす（1文字は従来どおり大きく描く）。
      const fontSize = label.length <= 1 ? 84 : label.length === 2 ? 56 : 44;
      g.font = `bold ${fontSize}px sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, 64, 92);
    }
  });
  const backMat = new THREE.MeshStandardMaterial({ color: options.back ?? 0x31517d, roughness: 0.5 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xd8d8d8, roughness: 0.5 });
  const faceMat = new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.45 });
  const mats = [edge, edge, edge, edge, faceMat, backMat];
  return new THREE.Mesh(new THREE.BoxGeometry(width, height, 0.03), mats);
}

// ---- 立方体タイル（2048 等） ----

export const TILE_2048_COLORS: Record<number, string> = {
  2: "#eee4da", 4: "#ede0c8", 8: "#f2b179", 16: "#f59563", 32: "#f67c5f",
  64: "#f65e3b", 128: "#edcf72", 256: "#edcc61", 512: "#edc850",
  1024: "#edc53f", 2048: "#edc22e",
};

/** 上面に数字を大きく描いた立方体タイル。数字は上面いっぱいの大きさで読める。 */
export function createTileCube(size: number, value: number): THREE.Mesh {
  const bg = value > 2048 ? "#3c3a32" : TILE_2048_COLORS[value] ?? "#cdc1b4";
  const fg = value >= 8 ? "#f9f6f2" : "#776e65";
  const topTex = canvasTexture(`tile-${value}`, 160, 160, (g) => {
    g.fillStyle = bg;
    g.fillRect(0, 0, 160, 160);
    g.fillStyle = fg;
    const text = String(value);
    g.font = `bold ${text.length >= 4 ? 56 : text.length === 3 ? 72 : 92}px sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.fillText(text, 80, 84);
  });
  const side = new THREE.MeshStandardMaterial({ color: new THREE.Color(bg).multiplyScalar(0.82), roughness: 0.55 });
  const top = new THREE.MeshStandardMaterial({ map: topTex, roughness: 0.5 });
  const mats = [side, side, top, side, side, side];
  return new THREE.Mesh(new THREE.BoxGeometry(size, size * 0.62, size), mats);
}

// ---- 球・杭 ----

export function createBall(radius: number, color: number, options: { roughness?: number } = {}): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.SphereGeometry(radius, 24, 18),
    new THREE.MeshStandardMaterial({ color, roughness: options.roughness ?? 0.25, metalness: 0.1 }),
  );
}

/** ハノイの杭のような円柱。 */
export function createPeg(radius: number, height: number, color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius * 1.15, height, 16),
    new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
  );
}

/** ハノイの円盤（ドーナツ型ではなく中実円盤＋上面リング）。 */
export function createRingDisc(radius: number, height: number, color: number): THREE.Mesh {
  return new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, height, 36),
    new THREE.MeshStandardMaterial({ color, roughness: 0.42 }),
  );
}
