// AGO WORLD BOX の競馬（LHA 統合）: 登録馬100頭の静的データ。
// 出典: ユーザー提供 LHA.md §5（形式: No.馬名｜性齢・毛色｜能力｜脚質｜馬場・距離｜個性）。
// 能力は原文の数値そのまま。並びは原文の No. 順。

export type RunningStyle = "大逃げ" | "逃げ" | "先行" | "差し" | "追込" | "マクリ";
export type Surface = "芝" | "ダート" | "兼用";
export type DistanceBand = "スプリント" | "マイル" | "中距離" | "中長距離" | "ステイヤー";
export type Trait = "標準" | "道悪巧者" | "左回り巧者" | "右回り・小回り巧者" | "鉄砲巧者" | "夏馬・冬馬";

export const DISTANCE_BANDS: readonly DistanceBand[] = ["スプリント", "マイル", "中距離", "中長距離", "ステイヤー"];

export interface Horse {
  id: number;
  name: string;
  sex: "牡" | "牝" | "セン";
  age: number;
  coat: string;
  ability: number;
  style: RunningStyle;
  surface: Surface;
  distance: DistanceBand;
  trait: Trait;
}

export const HORSES: readonly Horse[] = [
  { id: 1, name: "マーシャルゴール", sex: "牡", age: 6, coat: "栗毛", ability: 68, style: "先行", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 2, name: "アイランリング", sex: "牡", age: 3, coat: "鹿毛", ability: 79, style: "先行", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 3, name: "イワーダーク", sex: "牝", age: 3, coat: "栗毛", ability: 67, style: "差し", surface: "芝", distance: "中距離", trait: "右回り・小回り巧者" },
  { id: 4, name: "アサリーカル", sex: "牡", age: 2, coat: "黒鹿毛", ability: 62, style: "大逃げ", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 5, name: "アマゾンサイー", sex: "牡", age: 4, coat: "青鹿毛", ability: 73, style: "先行", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 6, name: "アマゴサイクロン", sex: "セン", age: 5, coat: "芦毛", ability: 58, style: "差し", surface: "ダート", distance: "マイル", trait: "標準" },
  { id: 7, name: "ソースポモドーロ", sex: "牡", age: 3, coat: "鹿毛", ability: 83, style: "追込", surface: "ダート", distance: "中長距離", trait: "標準" },
  { id: 8, name: "クルクルムーラン", sex: "牝", age: 4, coat: "黒鹿毛", ability: 69, style: "差し", surface: "芝", distance: "中長距離", trait: "道悪巧者" },
  { id: 9, name: "ハルヌルボン", sex: "牝", age: 4, coat: "鹿毛", ability: 77, style: "先行", surface: "兼用", distance: "マイル", trait: "標準" },
  { id: 10, name: "トルユーロ", sex: "牡", age: 3, coat: "栗毛", ability: 64, style: "差し", surface: "芝", distance: "中距離", trait: "左回り巧者" },
  { id: 11, name: "ギンガミルキー", sex: "牡", age: 5, coat: "鹿毛", ability: 71, style: "逃げ", surface: "芝", distance: "ステイヤー", trait: "標準" },
  { id: 12, name: "ドレミンビラ", sex: "牡", age: 3, coat: "鹿毛", ability: 89, style: "先行", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 13, name: "ホーングズ", sex: "牝", age: 4, coat: "青鹿毛", ability: 66, style: "先行", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 14, name: "カップヲトル", sex: "牡", age: 6, coat: "芦毛", ability: 74, style: "マクリ", surface: "芝", distance: "中長距離", trait: "鉄砲巧者" },
  { id: 15, name: "オリジナルシュート", sex: "牝", age: 3, coat: "栗毛", ability: 54, style: "追込", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 16, name: "ニシキノアケボノ", sex: "牡", age: 3, coat: "黒鹿毛", ability: 70, style: "先行", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 17, name: "セントラルオ", sex: "牡", age: 3, coat: "鹿毛", ability: 72, style: "先行", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 18, name: "ワサビスル", sex: "牝", age: 4, coat: "栗毛", ability: 65, style: "先行", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 19, name: "リュミエールアル", sex: "牝", age: 3, coat: "芦毛", ability: 85, style: "差し", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 20, name: "マジマンマミーア", sex: "牡", age: 5, coat: "黒鹿毛", ability: 61, style: "追込", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 21, name: "ルートヴィクトリー", sex: "牡", age: 4, coat: "青鹿毛", ability: 76, style: "先行", surface: "芝", distance: "中長距離", trait: "道悪巧者" },
  { id: 22, name: "フォースヨコル", sex: "セン", age: 6, coat: "鹿毛", ability: 68, style: "差し", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 23, name: "ローマキルタンサス", sex: "牝", age: 3, coat: "鹿毛", ability: 70, style: "先行", surface: "芝", distance: "ステイヤー", trait: "標準" },
  { id: 24, name: "インタースペース", sex: "牡", age: 2, coat: "黒鹿毛", ability: 57, style: "逃げ", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 25, name: "アルコールワット", sex: "牡", age: 4, coat: "黒鹿毛", ability: 75, style: "先行", surface: "ダート", distance: "マイル", trait: "標準" },
  { id: 26, name: "カントウーヤ", sex: "牝", age: 3, coat: "鹿毛", ability: 68, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 27, name: "キイノキバシヒワ", sex: "牡", age: 2, coat: "青毛", ability: 64, style: "差し", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 28, name: "キハデンセンコウ", sex: "牡", age: 5, coat: "栗毛", ability: 78, style: "逃げ", surface: "芝", distance: "中長距離", trait: "標準" },
  { id: 29, name: "ハイローガリカ", sex: "牝", age: 4, coat: "鹿毛", ability: 60, style: "追込", surface: "ダート", distance: "中距離", trait: "左回り巧者" },
  { id: 30, name: "スイヘイアーク", sex: "牡", age: 3, coat: "芦毛", ability: 82, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 31, name: "ラベンダーツヨシ", sex: "牡", age: 6, coat: "鹿毛", ability: 71, style: "先行", surface: "芝", distance: "マイル", trait: "夏馬・冬馬" },
  { id: 32, name: "ニッケルカケル", sex: "セン", age: 4, coat: "栗毛", ability: 66, style: "先行", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 33, name: "ヌーベルウェーブ", sex: "牝", age: 3, coat: "鹿毛", ability: 76, style: "先行", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 34, name: "ボストンノーベル", sex: "牡", age: 4, coat: "黒鹿毛", ability: 69, style: "差し", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 35, name: "ウメノアーノルド", sex: "牡", age: 5, coat: "栗毛", ability: 72, style: "先行", surface: "芝", distance: "中距離", trait: "右回り・小回り巧者" },
  { id: 36, name: "ゲンジノダイマオウ", sex: "牡", age: 4, coat: "青鹿毛", ability: 88, style: "先行", surface: "ダート", distance: "中長距離", trait: "標準" },
  { id: 37, name: "ヒノウマライジング", sex: "牡", age: 3, coat: "栗毛", ability: 81, style: "逃げ", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 38, name: "ガガーアオイ", sex: "牝", age: 3, coat: "芦毛", ability: 64, style: "差し", surface: "兼用", distance: "マイル", trait: "標準" },
  { id: 39, name: "スターブルースカイ", sex: "牡", age: 3, coat: "鹿毛", ability: 88, style: "差し", surface: "芝", distance: "中長距離", trait: "標準" },
  { id: 40, name: "キリミナミジャロ", sex: "セン", age: 6, coat: "鹿毛", ability: 67, style: "差し", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 41, name: "クルーレッド", sex: "牡", age: 4, coat: "栗毛", ability: 74, style: "先行", surface: "ダート", distance: "マイル", trait: "標準" },
  { id: 42, name: "トロントマスキー", sex: "牡", age: 2, coat: "黒鹿毛", ability: 59, style: "追込", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 43, name: "ココパーミャトニク", sex: "牝", age: 4, coat: "鹿毛", ability: 71, style: "先行", surface: "芝", distance: "ステイヤー", trait: "標準" },
  { id: 44, name: "カエルウルス", sex: "牡", age: 3, coat: "青毛", ability: 66, style: "差し", surface: "芝", distance: "中距離", trait: "道悪巧者" },
  { id: 45, name: "エルブコシキー", sex: "牝", age: 3, coat: "白毛", ability: 78, style: "先行", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 46, name: "ユンオール", sex: "牡", age: 5, coat: "鹿毛", ability: 63, style: "先行", surface: "ダート", distance: "スプリント", trait: "鉄砲巧者" },
  { id: 47, name: "ヨルミルコーヒー", sex: "牝", age: 4, coat: "黒鹿毛", ability: 70, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 48, name: "シルクヘッド", sex: "牡", age: 3, coat: "芦毛", ability: 84, style: "追込", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 49, name: "イケゴーモスクワ", sex: "牡", age: 4, coat: "黒鹿毛", ability: 75, style: "先行", surface: "ダート", distance: "中長距離", trait: "標準" },
  { id: 50, name: "イワーニコラス", sex: "牡", age: 3, coat: "鹿毛", ability: 70, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 51, name: "アースルート", sex: "牝", age: 4, coat: "栗毛", ability: 67, style: "差し", surface: "芝", distance: "マイル", trait: "左回り巧者" },
  { id: 52, name: "エアストレングス", sex: "牡", age: 5, coat: "鹿毛", ability: 84, style: "先行", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 53, name: "ベクトルマイル", sex: "牡", age: 3, coat: "鹿毛", ability: 77, style: "差し", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 54, name: "マニマニタレント", sex: "セン", age: 6, coat: "芦毛", ability: 63, style: "差し", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 55, name: "ナイボーダー", sex: "牝", age: 3, coat: "栃栗毛", ability: 72, style: "先行", surface: "兼用", distance: "マイル", trait: "標準" },
  { id: 56, name: "ナンカイバイパス", sex: "牡", age: 4, coat: "黒鹿毛", ability: 83, style: "逃げ", surface: "ダート", distance: "マイル", trait: "標準" },
  { id: 57, name: "サンコーサイエンス", sex: "牡", age: 3, coat: "青鹿毛", ability: 68, style: "追込", surface: "芝", distance: "ステイヤー", trait: "標準" },
  { id: 58, name: "ルクラトブトル", sex: "牝", age: 5, coat: "鹿毛", ability: 74, style: "差し", surface: "芝", distance: "中長距離", trait: "道悪巧者" },
  { id: 59, name: "ケチャップドーム", sex: "牡", age: 2, coat: "栗毛", ability: 61, style: "先行", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 60, name: "エーツーミール", sex: "牡", age: 4, coat: "鹿毛", ability: 69, style: "差し", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 61, name: "スキトオルミズイロ", sex: "牝", age: 3, coat: "芦毛", ability: 76, style: "先行", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 62, name: "アスカブレイク", sex: "牡", age: 6, coat: "栗毛", ability: 65, style: "逃げ", surface: "芝", distance: "スプリント", trait: "鉄砲巧者" },
  { id: 63, name: "フユカゼラザーニャ", sex: "牝", age: 4, coat: "黒鹿毛", ability: 71, style: "先行", surface: "ダート", distance: "スプリント", trait: "夏馬・冬馬" },
  { id: 64, name: "ヨノミヤスミス", sex: "牡", age: 3, coat: "鹿毛", ability: 58, style: "追込", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 65, name: "シキサイエベレスト", sex: "牡", age: 4, coat: "黒鹿毛", ability: 78, style: "先行", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 66, name: "ツルガリーグ", sex: "牝", age: 3, coat: "鹿毛", ability: 83, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 67, name: "シャドールビー", sex: "牡", age: 5, coat: "栗毛", ability: 69, style: "差し", surface: "芝", distance: "ステイヤー", trait: "標準" },
  { id: 68, name: "レッズアース", sex: "牡", age: 3, coat: "芦毛", ability: 73, style: "先行", surface: "芝", distance: "マイル", trait: "左回り巧者" },
  { id: 69, name: "キョキファースト", sex: "牝", age: 4, coat: "鹿毛", ability: 64, style: "逃げ", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 70, name: "クォーターハリー", sex: "牡", age: 3, coat: "鹿毛", ability: 75, style: "先行", surface: "芝", distance: "中長距離", trait: "標準" },
  { id: 71, name: "ダイムイラスト", sex: "セン", age: 6, coat: "青鹿毛", ability: 67, style: "追込", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 72, name: "ハーツサーバー", sex: "牡", age: 4, coat: "黒鹿毛", ability: 82, style: "先行", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 73, name: "ショーリベスト", sex: "牝", age: 3, coat: "栗毛", ability: 61, style: "差し", surface: "芝", distance: "マイル", trait: "鉄砲巧者" },
  { id: 74, name: "バンガーリーチ", sex: "牡", age: 5, coat: "鹿毛", ability: 71, style: "先行", surface: "ダート", distance: "中長距離", trait: "道悪巧者" },
  { id: 75, name: "イワーゴッホ", sex: "牡", age: 2, coat: "黒鹿毛", ability: 65, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 76, name: "ノースディスク", sex: "牝", age: 4, coat: "芦毛", ability: 76, style: "先行", surface: "兼用", distance: "中距離", trait: "標準" },
  { id: 77, name: "ノルディックシルク", sex: "牡", age: 6, coat: "鹿毛", ability: 56, style: "追込", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 78, name: "ツキムーンカード", sex: "牝", age: 3, coat: "青毛", ability: 70, style: "先行", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 79, name: "シンドルコイン", sex: "牡", age: 4, coat: "栗毛", ability: 74, style: "先行", surface: "ダート", distance: "マイル", trait: "右回り・小回り巧者" },
  { id: 80, name: "ユニバクローザー", sex: "牡", age: 3, coat: "鹿毛", ability: 68, style: "先行", surface: "芝", distance: "中長距離", trait: "夏馬・冬馬" },
  { id: 81, name: "コウショウトレイン", sex: "牡", age: 4, coat: "鹿毛", ability: 72, style: "先行", surface: "ダート", distance: "中距離", trait: "標準" },
  { id: 82, name: "シンシュンダーツ", sex: "牡", age: 3, coat: "栗毛", ability: 77, style: "先行", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 83, name: "スモールメモリアル", sex: "牝", age: 3, coat: "黒鹿毛", ability: 66, style: "差し", surface: "芝", distance: "マイル", trait: "右回り・小回り巧者" },
  { id: 84, name: "ワンスアキノハラ", sex: "牡", age: 5, coat: "鹿毛", ability: 84, style: "先行", surface: "芝", distance: "中長距離", trait: "標準" },
  { id: 85, name: "ツーテンセント", sex: "セン", age: 6, coat: "芦毛", ability: 62, style: "差し", surface: "ダート", distance: "スプリント", trait: "標準" },
  { id: 86, name: "シャイニードロー", sex: "牝", age: 3, coat: "白毛", ability: 75, style: "差し", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 87, name: "スイジョーキネン", sex: "牡", age: 4, coat: "青鹿毛", ability: 70, style: "逃げ", surface: "芝", distance: "ステイヤー", trait: "道悪巧者" },
  { id: 88, name: "ロンドンウォッチ", sex: "牡", age: 3, coat: "鹿毛", ability: 82, style: "差し", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 89, name: "センチュリーグアム", sex: "牡", age: 4, coat: "黒鹿毛", ability: 69, style: "先行", surface: "ダート", distance: "マイル", trait: "標準" },
  { id: 90, name: "ソウコウムーン", sex: "牝", age: 3, coat: "青毛", ability: 64, style: "追込", surface: "芝", distance: "中距離", trait: "左回り巧者" },
  { id: 91, name: "アンダークロック", sex: "牡", age: 5, coat: "栗毛", ability: 74, style: "先行", surface: "ダート", distance: "中長距離", trait: "標準" },
  { id: 92, name: "スロットナンバー", sex: "牡", age: 2, coat: "鹿毛", ability: 59, style: "逃げ", surface: "芝", distance: "スプリント", trait: "標準" },
  { id: 93, name: "ニューネームキー", sex: "牝", age: 4, coat: "鹿毛", ability: 71, style: "先行", surface: "兼用", distance: "マイル", trait: "標準" },
  { id: 94, name: "キロメーターマスク", sex: "牡", age: 3, coat: "黒鹿毛", ability: 68, style: "差し", surface: "芝", distance: "マイル", trait: "鉄砲巧者" },
  { id: 95, name: "ハスノハナメロン", sex: "牝", age: 4, coat: "栗毛", ability: 65, style: "差し", surface: "ダート", distance: "中距離", trait: "夏馬・冬馬" },
  { id: 96, name: "アルタイルヘイセイ", sex: "牡", age: 6, coat: "芦毛", ability: 76, style: "マクリ", surface: "芝", distance: "中距離", trait: "標準" },
  { id: 97, name: "セカンドオーロラ", sex: "牝", age: 3, coat: "芦毛", ability: 75, style: "差し", surface: "芝", distance: "マイル", trait: "標準" },
  { id: 98, name: "スミレハナマル", sex: "牝", age: 4, coat: "黒鹿毛", ability: 68, style: "先行", surface: "ダート", distance: "スプリント", trait: "右回り・小回り巧者" },
  { id: 99, name: "キンモクセイワタル", sex: "牡", age: 5, coat: "栗毛", ability: 73, style: "先行", surface: "芝", distance: "中距離", trait: "夏馬・冬馬" },
  { id: 100, name: "ストックホライズン", sex: "牡", age: 3, coat: "鹿毛", ability: 89, style: "先行", surface: "芝", distance: "中長距離", trait: "標準" },
];

export function horseById(id: number): Horse | null {
  return HORSES.find((h) => h.id === id) ?? null;
}
