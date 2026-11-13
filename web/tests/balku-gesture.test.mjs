// BALKU ジェスチャ一本化＋ステージ固定比率の回帰（2026-11-13 ユーザー裁定）。
// - 対戦中のゲームアクションはタップ/スワイプ/ドラッグに一本化し、ボタン全廃
// - 対戦画面は固定比率のステージ（横 16:10 / 縦 3:4）で、市場は引き出し
// - 可読下限（手札 104px / 束 96px / 主要テキスト 12px）を絶対値で守り、
//   収まらない分は「縮小」ではなく「同時表示を減らす」（要約スタック＋
//   詳細シート＋拡大プレビュー＋中央帯1コンテキスト）で解く
// - 企画46種すべてに個別イラスト（ProjectArt）の対応がある
// を、クライアント実装と CSS の静的検査で固定する。
// エンジン側の各アクションの正しさ自体は balku.test.mjs が検証している。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dirname, "..");
const client = fs.readFileSync(path.join(root, "app", "games", "balku", "BalkuClient.tsx"), "utf8");
const css = fs.readFileSync(path.join(root, "app", "globals.css"), "utf8");
const gameLib = fs.readFileSync(path.join(root, "lib", "balku-game.ts"), "utf8");

// 対戦画面は最後の return（対戦画面コメント以降）
const gameScreen = client.slice(client.indexOf("対戦画面 ---"));
// ハンバーガーの中身は対戦外 chrome（ボタン可）。監査対象から外すために切り出す。
const menuStart = gameScreen.indexOf("BALKU-MENU-START");
const menuEnd = gameScreen.indexOf("BALKU-MENU-END");
const menuBlock = gameScreen.slice(menuStart, menuEnd);
const auditedScreen = gameScreen.slice(0, menuStart) + gameScreen.slice(menuEnd);

test("監査: 対戦画面（ハンバーガー内 chrome を除く）に <button> と balku-btn が残っていない", () => {
  assert.ok(menuStart > 0 && menuEnd > menuStart, "ハンバーガーの監査境界マーカーがない");
  assert.ok(!auditedScreen.includes("<button"), "対戦画面に button 要素が残っている");
  assert.ok(!auditedScreen.includes("balku-btn"), "対戦画面に balku-btn が残っている");
  // カードの見た目をした button も対象：手札ファンと素材は div + role=button に置換済み
  assert.ok(client.includes('data-hand-project={card.id}'));
  assert.ok(!/<button[^>]*balku-card/.test(client), "企画カードが button 要素のまま");
  assert.ok(!/<button[^>]*balku-matgroup/.test(client), "素材グループが button 要素のまま");
  assert.ok(!/<button[^>]*balku-shelf-tab/.test(client), "市場のタブが button 要素のまま");
  // 固定アスペクト＋overflow:hidden の束カード内に対話要素を置かない（旧BALKUボタンのクリップ事故対策）
  const bundleFn = client.slice(client.indexOf("const renderBundle"), client.indexOf("const renderSeat"));
  assert.ok(!bundleFn.includes("<button"), "束カード内に button が残っている");
});

test("ハンバーガーへ退避した項目（ログ全文・ルーム・サウンド・スコア・退出）", () => {
  assert.ok(menuBlock.includes("balku-menu-drawer"));
  assert.ok(menuBlock.includes("balku-menu-log"), "ログ全文がハンバーガーにない");
  assert.ok(menuBlock.includes("コードをコピー"), "ルームコードのコピーがハンバーガーにない");
  assert.ok(menuBlock.includes('toggleSound("bgm")') && menuBlock.includes('toggleSound("se")'), "サウンド設定がハンバーガーにない");
  assert.ok(menuBlock.includes("退出する"), "退出がハンバーガーにない");
  // 市場の入口はタブ1つだけ（二重化禁止）
  assert.ok(!menuBlock.includes("balku-shelf") && !menuBlock.includes("setMarketOpen"), "市場入口がハンバーガーと二重化している");
  assert.ok(client.includes("balku-shelf-tab"));
});

test("廃止した操作部品がクライアントに残っていない", () => {
  for (const gone of ["sellMode", "売却モード", "パスする", "renderBulkButtons", "balku-target-chip", "confirmKey", "まとめて売却", "balku-stepper", "選択をやめる", "balku-logcorner", "balku-hand-tools"]) {
    assert.ok(!client.includes(gone), `${gone} が残っている`);
  }
});

test("全 GameAction がジェスチャ経路から到達できる", () => {
  assert.ok(client.includes('source: "bundle"'));
  assert.ok(client.includes('"submit-open"') && client.includes('"submit-down"'));
  assert.ok(client.includes("submitSelected(zone === \"submit-open\")"));
  assert.ok(client.includes('source: "market-material"'));
  assert.ok(client.includes('type: "buyMaterial"'));
  assert.ok(client.includes('type: "sellCards"'));
  assert.ok(client.includes('data-drop="sell"'));
  assert.ok(client.includes('source: "bid-coin"'));
  assert.ok(client.includes('type: "bid"'));
  assert.ok(client.includes('source: "opponent-bundle"'));
  assert.ok(client.includes('type: "bulkCall"'));
  assert.ok(client.includes('source: "force-charge"'));
  assert.ok(client.includes('type: "forceBulk"'));
  assert.ok(client.includes("data-bulk-target"));
  assert.ok(client.includes('source: "turn-token"'));
  assert.ok(client.includes('type: "endTurn"'));
});

test("BALKU系は 409 競合時に最新盤面で1回だけ再送する（「押せない」救済）", () => {
  assert.ok(client.includes('action.type === "bulkCall" || action.type === "forceBulk"'));
  assert.ok(client.includes("postMove(fresh.revision)"));
});

test("フリック解決とファンの横スワイプが配線されている", () => {
  assert.ok(client.includes("flickZone"));
  assert.ok(client.includes('track.mode = "fan"'));
  assert.ok(client.includes("scrollLeft"));
  assert.ok(css.includes(".balku-fan { touch-action:pan-y; }"));
  assert.ok(css.includes(".balku-draggable { touch-action:none;"));
});

test("レイアウト: 固定比率ステージ・市場の引き出し・施工ゾーンと手札の隣接", () => {
  assert.ok(css.includes("aspect-ratio:16/10"), "横向きの固定比率がない");
  assert.ok(css.includes("aspect-ratio:3/4"), "縦持ちの固定比率（3:4）がない");
  assert.ok(css.includes("container-type:size"), "ステージがコンテナになっていない");
  assert.ok(css.includes("cqw"), "ステージ相対単位が使われていない");
  assert.ok(/\.balku-shelf \{[^}]*position:absolute/.test(css), "市場が通常フローに残っている");
  // 未選択時の施工バーは自分の領域（.balku-self）の中＝手札の真上にある
  const selfIdx = client.indexOf('className={`balku-self');
  const buildIdx = client.indexOf("balku-buildbar", selfIdx);
  const fanIdx = client.indexOf("balku-fan balku-fan-projects", buildIdx);
  assert.ok(selfIdx > 0 && buildIdx > selfIdx, "施工バーが自分の領域の中にない");
  assert.ok(buildIdx < fanIdx, "施工バーが手札ファンより前（上）にない");
  // 選択中の施工はステージ上のシート（行レイアウトに高さを足さない）
  assert.ok(client.includes("balku-buildsheet"), "施工シートがない");
  assert.ok(/\.balku-sheet \{[^}]*position:absolute/.test(css), "シートがステージ上の重なりになっていない");
});

test("可読下限: カード幅とテキストの下限を絶対値で守る", () => {
  // 手札の企画カードは縦・横とも最低 104px
  assert.ok(css.includes("clamp(104px, 30cqw, 126px)"), "縦持ちの手札カード下限がない");
  assert.ok(css.includes("clamp(104px, 13.5cqw, 140px)"), "横向きの手札カード下限がない");
  // ステージ予約は実測 chrome ベースの 96px、基準は svh（ツールバー裏まで
  // 数える dvh は Safari でステージを過大評価し、潰れの原因になった）
  assert.ok(css.includes("100svh - 96px"), "ステージ予約が svh 96px になっていない");
  assert.ok(!css.includes("100dvh"), "dvh 基準が残っている");
  // 高さ連動で束を潰す旧ルール（12.5cqh）は撤去済み
  assert.ok(!css.includes("12.5cqh"), "束の cqh 連動縮小が残っている");
  // 詳細表示の束は全サイズ（148px）で出す
  assert.ok(/\.balku-bundle \{[^}]*width:148px/.test(css), "束の全サイズ表示がない");
});

test("床: ゾーンの最低高が比率より優先され、席と中央帯は潰れて消えない", () => {
  // ステージ：高さの上限で比率を壊さず、min-height の床が比率由来の
  // 高さを上回ったらステージが伸びる（旧 max-height＋minmax(0,1fr) は
  // iPhone 横向きで席・場が0に潰れて消えた）
  const stageStart = css.indexOf(".balku-table-game {");
  const stageRule = css.slice(stageStart, css.indexOf("}", stageStart));
  assert.ok(stageRule.includes("grid-template-rows:minmax(86px, auto) minmax(128px, 1fr) auto"), "行の床（席86/中央128）がない");
  assert.ok(stageRule.includes("min-height:632px"), "ステージの床（横向き）がない");
  assert.ok(!stageRule.includes("max-height"), "ステージに高さ上限が残っている");
  assert.ok(!stageRule.includes("minmax(0,1fr)"), "中央行が0まで潰れる指定が残っている");
  // 列は minmax(0,1fr) で固定する（列定義がないと中身の min-content で
  // ステージ幅より列が広がり、席や自領域が右にはみ出して切れた）
  assert.ok(stageRule.includes("grid-template-columns:minmax(0, 1fr)"), "ステージの列固定がない");
  assert.ok(/\.balku-self \{[^}]*grid-template-columns:minmax\(0, 1fr\)/.test(css), "自領域の列固定がない（情報バーの min-content で列が広がる）");
  // 狭幅ではオークションが折り返す分、中央の床を上げる。縦持ちの床は
  // 中央228＋自領域の実測合計まで含めて固定する
  assert.ok(css.includes("minmax(228px, 1fr)"), "狭幅の中央の床（228）がない");
  assert.ok(css.includes("min-height:724px"), "ステージの床（縦持ち/狭幅）がない");
  // 情報バーは常に1行（折り返して自領域を押し上げない）
  assert.ok(/\.balku-infobar \{[^}]*flex-wrap:nowrap/.test(css), "情報バーが1行に固定されていない");
  // 席は固定高ストリップ（顔は小型版、名前と所持情報は右の列）
  assert.ok(/\.balku-seats \{[^}]*height:86px/.test(css), "席ストリップの固定高がない");
  assert.ok(/\.balku-seat \{[^}]*height:72px/.test(css), "席の固定高がない");
  assert.ok(/\.balku-seat \.balku-stackface \{[^}]*width:104px/.test(css), "席内の小型の顔がない");
  assert.ok(client.includes("balku-seat-meta") && client.includes("balku-seat-statsline"), "席の情報列がない");
  assert.ok(client.includes("balku-seat-noface"), "提出なし席のプレースホルダがない");
  // 手札ファンは固定高コンテナに完全収納し、重なりはカード幅の45%まで。
  // 名前とPTは左列に縦積みし、重なりの下に隠れない
  assert.ok(css.includes(".balku-fan-projects { height:140px; }"), "企画ファンの固定高がない");
  assert.ok(css.includes(".balku-fan-mats { height:100px; }"), "素材ファンの固定高がない");
  assert.ok(/\.balku-fan-projects \.balku-card \{[^}]*height:118px/.test(css), "手札カードの固定高がない");
  assert.ok(css.includes("--balku-fan-card-w:clamp(104px, 13.5cqw, 140px)"), "横向きのカード幅変数がない");
  assert.ok(css.includes("--balku-fan-card-w:clamp(104px, 30cqw, 126px)"), "縦持ちのカード幅変数がない");
  assert.ok(css.includes("* -0.45"), "重なりの上限（45%）がない");
  assert.ok(!css.includes("-17cqw") && !css.includes("-7.4cqw"), "旧の強い重なりが残っている");
  assert.ok(/\.balku-fan-projects \.balku-card-head \{[^}]*flex-direction:column/.test(css), "名前とPTの縦積みがない");
  // 情報バーの副次表示（同期状態）はハンバーガーへ。低丈の横向きでは
  // 情報バーを1行に畳み、市場タブは場の行（ステージ縦中央）に付く
  assert.ok(menuBlock.includes("ポーリングで同期中"), "同期状態がハンバーガーにない");
  assert.ok(!client.includes("balku-chip balku-sync-note"), "情報バーに同期チップが残っている");
  assert.ok(css.includes("@media (orientation: landscape) and (max-height: 600px)"), "低丈の横向きルールがない");
  assert.ok(/\.balku-shelf-tab \{[^}]*top:50%/.test(css), "市場タブが場の行の中央に付いていない");
});

test("同時表示の削減: 要約スタック・中央帯1コンテキスト・詳細シート", () => {
  // 席は最新の束だけを顔として出し、残りは件数バッジ
  assert.ok(client.includes("renderStackFace(p, p.submitted[p.submitted.length - 1])"), "席が要約スタックになっていない");
  assert.ok(client.includes("balku-stack-count"), "束数バッジがない");
  assert.ok(client.includes("renderStackFace(me, me.submitted[me.submitted.length - 1])"), "自分の提出が要約ストリップになっていない");
  // 中央帯は同時に1コンテキスト：オークション中は自分の提出を畳む
  const auctionGuard = gameScreen.indexOf("!st.auction");
  const myfieldIdx = gameScreen.indexOf("balku-myfield");
  assert.ok(auctionGuard > 0 && auctionGuard < myfieldIdx, "オークション中の提出ストリップ畳み込みがない");
  // 全束はタップで開く詳細シートで全サイズ表示し、BALKU のドラッグも中で成立する
  assert.ok(client.includes("renderDetailSheet"), "詳細シートがない");
  assert.ok(client.includes("setDetailSeat(p.seat)"), "席タップの詳細導線がない");
  assert.ok(client.includes("setDetailSeat(mySeat)"), "自分の提出の詳細導線がない");
});

test("拡大プレビューと情報ダイエット: 小カードは絵＋名前＋点数だけ", () => {
  // 手札ファンのカード本体に効果文・必要素材チップを置かない
  const fanBlock = client.slice(client.indexOf("balku-fan balku-fan-projects"), client.indexOf("balku-fan balku-fan-mats"));
  assert.ok(!fanBlock.includes("balku-card-effect"), "手札カードに効果文が残っている");
  assert.ok(!fanBlock.includes("balku-req-chips"), "手札カードに必要素材チップが残っている");
  // どの小カードからも拡大表示に到達できる
  assert.ok(client.includes('setPreview({ type: "project", card })'), "手札タップの拡大導線がない");
  assert.ok(client.includes('setPreview({ type: "material", kind, premium })'), "素材タップの拡大導線がない");
  assert.ok(client.includes("renderPreviewOverlay"), "拡大プレビューの描画がない");
  // 効果文と必要素材は施工シート（大カード）に集約される
  const sheetIdx = client.indexOf("const renderBuildSheet");
  const sheetBlock = client.slice(sheetIdx, client.indexOf("const latestLogEntry", sheetIdx));
  assert.ok(sheetBlock.includes("balku-build-effect"), "施工シートに効果文がない");
  assert.ok(sheetBlock.includes("balku-reqrow"), "施工シートに必要素材の行がない");
  // シートはハンドルのドラッグでも閉じられる
  assert.ok(client.includes("sheetHandle"), "シートのジェスチャ閉じがない");
});

test("ProjectArt: 企画46種すべてにモチーフ対応がある", () => {
  const names = [...gameLib.matchAll(/makeProject\("([^"]+)"/g)].map((m) => m[1]);
  const unique = [...new Set(names)];
  assert.equal(unique.length, 46, `企画が46種ではない: ${unique.length}`);
  const artBlock = client.slice(client.indexOf("const PROJECT_ART"), client.indexOf("const EFFECT_ART"));
  for (const name of unique) {
    assert.ok(artBlock.includes(`"${name}"`), `ProjectArt 対応表に ${name} がない`);
  }
  assert.ok(client.includes("function ProjectArt"));
  // 手札・提出束・オークションの表示に同じ絵が付く
  assert.ok((client.match(/<ProjectArt /g) ?? []).length >= 4, "ProjectArt の適用箇所が足りない");
});

test("感触とエフェクト: フリップ/タイマーバー/素材SVG/ドロー/落札バースト/脱落暗転/ヒビ", () => {
  assert.ok(client.includes("balku-bundle-flip"));
  assert.ok(client.includes("setRevealCard"));
  assert.ok(client.includes("function TimerBar"));
  assert.ok(client.includes("function MatIcon"));
  assert.ok(client.includes("balku-coin-pop"));
  assert.ok(client.includes("function CountUp"));
  assert.ok(client.includes("balku-deal"), "ドローの飛行がない");
  assert.ok(client.includes("balku-coinburst"), "落札バーストがない");
  assert.ok(client.includes("balku-seat-out"), "脱落の暗転がない");
  assert.ok(client.includes("balku-cracks"), "違法開示のヒビがない");
  assert.ok(client.includes("balku-self-hurt"), "BALKU失敗の崩れがない");
  assert.ok(css.includes("@keyframes balku-flip"));
  assert.ok(css.includes("@keyframes balku-deal"));
  assert.ok(css.includes("@keyframes balku-burst"));
  assert.ok(css.includes("@keyframes balku-seize"));
  assert.ok(css.includes("prefers-reduced-motion"));
});

test("対戦画面とカタログに絵文字が残っていない", () => {
  assert.ok(!client.includes("🎉"));
  const catalog = fs.readFileSync(path.join(root, "lib", "games-catalog.ts"), "utf8");
  assert.ok(!catalog.includes("🏗"));
});
