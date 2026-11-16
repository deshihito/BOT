// BALKU ジェスチャ一本化＋ステージ形状の回帰（2026-11-13 ユーザー裁定、
// 2026-11-15 ユーザー報告で形状方針を改訂）。
// - 対戦中のゲームアクションはタップ/スワイプ/ドラッグに一本化し、ボタン全廃
// - 対戦画面の固定比率は廃止（2026-11-15: 比率と床と svh 幅が喧嘩して
//   ステージが歪み、ほとんどのムーブができなくなった）。形は比率でなく
//   ゾーンの床（最低高）で守り、幅100%・高さは自然高・市場は引き出し
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
const gameLib = fs.readFileSync(path.join(root, "lib", "balku/balku-game.ts"), "utf8");

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
  assert.ok(client.includes("submitSelected(zone === \"submit-open\", true)"));
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

test("レイアウト: 比率固定を廃止したステージ・市場の引き出し・施工ゾーンと手札の隣接", () => {
  // 固定比率（16:10 / 3:4）と min-height の床、svh 由来の幅は三つ巴で
  // ステージを歪ませたため全廃（2026-11-15）。幅100%＋自然高＋床で守る
  const stageStart = css.indexOf(".balku-table-game {");
  const stageRule = css.slice(stageStart, css.indexOf("}", stageStart));
  assert.ok(!stageRule.includes("aspect-ratio"), "ステージに固定比率が残っている");
  assert.ok(!stageRule.includes("min-height"), "ステージに比率と喧嘩する床が残っている");
  assert.ok(stageRule.includes("width:100%"), "ステージ幅が100%でない");
  assert.ok(css.includes("container-type:inline-size"), "ステージが幅コンテナになっていない（size だと高さが中身に依存できない）");
  // どのブレークポイントの .balku-table-game ルールにも比率と床を戻さない
  for (const m of css.matchAll(/\.balku-table-game \{[^}]*\}/g)) {
    assert.ok(!m[0].includes("aspect-ratio"), "どこかのステージルールに固定比率が残っている");
    assert.ok(!m[0].includes("min-height"), "どこかのステージルールに床が残っている");
    assert.ok(!m[0].includes("100svh"), "どこかのステージルールに svh 由来の寸法が残っている");
  }
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
  // ステージ寸法は svh/dvh 由来にしない（2026-11-15: svh 由来の幅が
  // 比率・床と喧嘩して歪みの原因になった）
  assert.ok(!css.includes("100dvh"), "dvh 基準が残っている");
  // 高さ連動で束を潰す旧ルール（12.5cqh）は撤去済み
  assert.ok(!css.includes("12.5cqh"), "束の cqh 連動縮小が残っている");
  // 詳細表示の束は全サイズ（148px）で出す
  assert.ok(/\.balku-bundle \{[^}]*width:148px/.test(css), "束の全サイズ表示がない");
});

test("床: ゾーンの最低高で形を守り、席と中央帯は潰れて消えない", () => {
  // ステージ全体の寸法は固定しない（比率も全体の床も廃止）。形を守るのは
  // 行ごとの床だけ：席86/中央128 があれば、どの画面でも席と場は消えない
  // （旧 max-height＋minmax(0,1fr) は iPhone 横向きで席・場が0に潰れた）
  const stageStart = css.indexOf(".balku-table-game {");
  const stageRule = css.slice(stageStart, css.indexOf("}", stageStart));
  assert.ok(stageRule.includes("grid-template-rows:minmax(86px, auto) minmax(128px, 1fr) auto"), "行の床（席86/中央128）がない");
  assert.ok(!stageRule.includes("max-height"), "ステージに高さ上限が残っている");
  assert.ok(!stageRule.includes("minmax(0,1fr)"), "中央行が0まで潰れる指定が残っている");
  // 列は minmax(0,1fr) で固定する（列定義がないと中身の min-content で
  // ステージ幅より列が広がり、席や自領域が右にはみ出して切れた）
  assert.ok(stageRule.includes("grid-template-columns:minmax(0, 1fr)"), "ステージの列固定がない");
  assert.ok(/\.balku-self \{[^}]*grid-template-columns:minmax\(0, 1fr\)/.test(css), "自領域の列固定がない（情報バーの min-content で列が広がる）");
  // 狭幅ではオークションが折り返す分、中央の行の床を上げる
  assert.ok(css.includes("minmax(228px, 1fr)"), "狭幅の中央の床（228）がない");
  // 情報バーは常に1行（折り返して自領域を押し上げない）
  assert.ok(/\.balku-infobar \{[^}]*flex-wrap:nowrap/.test(css), "情報バーが1行に固定されていない");
  // 席は固定高ストリップ（顔は小型版、名前と所持情報は右の列）
  assert.ok(/\.balku-seats \{[^}]*height:86px/.test(css), "席ストリップの固定高がない");
  assert.ok(/\.balku-seat \{[^}]*height:72px/.test(css), "席の固定高がない");
  assert.ok(/\.balku-seat \.balku-stackface \{[^}]*width:104px/.test(css), "席内の小型の顔がない");
  assert.ok(client.includes("balku-seat-meta") && client.includes("balku-seat-statsline"), "席の情報列がない");
  assert.ok(client.includes("balku-seat-noface"), "提出なし席のプレースホルダがない");
  // 手札ファンは固定高コンテナに完全収納し、重なりはカード幅の30%まで
  // （掴める帯＝露出7割を確保する。2026-11-15 第3弾で 45%→30% に浅くした）。
  // 名前とPTは左列に縦積みし、重なりの下に隠れない
  assert.ok(css.includes(".balku-fan-projects { height:140px; }"), "企画ファンの固定高がない");
  assert.ok(css.includes(".balku-fan-mats { height:100px; }"), "素材ファンの固定高がない");
  assert.ok(/\.balku-fan-projects \.balku-card \{[^}]*height:118px/.test(css), "手札カードの固定高がない");
  assert.ok(css.includes("--balku-fan-card-w:clamp(104px, 13.5cqw, 140px)"), "横向きのカード幅変数がない");
  assert.ok(css.includes("--balku-fan-card-w:clamp(104px, 30cqw, 126px)"), "縦持ちのカード幅変数がない");
  assert.ok(css.includes("* -0.3)"), "重なりの上限（30%）がない");
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
  assert.ok(sheetBlock.includes("balku-reqchips"), "施工シートに必要素材チップがない");
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

test("施工シート: ステージ上の重なりで、TSX のクラスに CSS が一致する", () => {
  // 2026-11-15 回帰: 施工シートが通常フローに入ってステージを歪ませ、
  // 提出パッドが切れていた。シートは absolute の重なりでなければならない
  assert.ok(/\.balku-buildsheet \{[^}]*position:absolute/.test(css), "施工シートがステージ上の重なりになっていない");
  assert.ok(/\.balku-buildsheet \{[^}]*max-height:calc\(100% - 16px\)/.test(css), "施工シートの高さ上限がない");
  // TSX が使う部品クラス（body/card/main/effect/info/timer）に実ルールがある
  for (const cls of ["balku-buildsheet-body", "balku-build-card", "balku-build-card-main", "balku-build-effect", "balku-build-info", "balku-build-timer"]) {
    assert.ok(css.includes(`.${cls} {`) || css.includes(`.${cls},`), `${cls} の CSS ルールがない（無スタイル部品）`);
    assert.ok(client.includes(cls), `${cls} がクライアントで使われていない`);
  }
});

test("ムーブの受け付け: 判定は広め・近接とフリックの救済・タップ代替（桜井 #223）", () => {
  // ドロップ判定はゾーン矩形より四方 44px 広い（第4弾で 24→44 に拡大）
  assert.ok(client.includes("const DROP_PAD = 44"), "ドロップ判定の拡大がない");
  assert.ok(client.includes("r.left - DROP_PAD"), "zoneAt が判定を広げていない");
  // ゾーン外でも近くのゾーンへ寄せる近接解決があり、フリックより先に試す
  assert.ok(client.includes("const nearestZone"), "近接解決がない");
  assert.ok(client.includes("const DROP_NEAR = 160"), "近接解決の距離がない");
  const endIdx = client.indexOf("const endDrag");
  const endBlock = client.slice(endIdx, client.indexOf("const cancelDrag", endIdx));
  assert.ok(endBlock.indexOf("nearestZone(") > 0 && endBlock.indexOf("nearestZone(") < endBlock.indexOf("flickZone("), "近接→フリックの順で救済していない");
  // フリックの閾値は緩い方に固定（速さ 0.28 / 向き 0.42、引き寄せ 32px）
  assert.ok(client.includes("speed < 0.28"), "フリック速度の閾値が緩んでいない");
  assert.ok(client.includes("dot > 0.42"), "フリック方向の閾値が緩んでいない");
  assert.ok(client.includes("dy > 32 && vy > 0.03"), "BALKU 引き寄せの閾値が緩んでいない");
  // ファンの横スワイプからドラッグへの昇格（途中で縦に切ったら持ち上がる）
  assert.ok(client.includes('track.mode = "drag";\n      } else {') || client.includes("ドラッグへ昇格"), "fan→drag 昇格がない");
  // 押して何も起きない面を作らない: 提出パッド/市場/入札コイン/手番
  // トークンはタップでも同じムーブが成立する（ドラッグ後の click は
  // suppressClick で二重実行を防ぐ）
  // 提出先に専用の受け皿は置かない（第4弾）: 場そのものを左右に割って
  // 判定し、タップ提出も場のタップ位置（左=公開/右=伏せ）で決まる。
  // 束はタップで持ち上げられる
  assert.ok(!client.includes("balku-submitpad"), "旧・提出パッドが残っている");
  assert.ok(!client.includes("balku-fieldhalves") && !css.includes(".balku-fieldhalves"), "提出先の専用スペースが残っている");
  assert.ok(client.includes("const zoneRect"), "場を割る仮想ゾーン（zoneRect）がない");
  assert.ok(client.includes("submitSelected(e.clientX < r.left + r.width / 2)"), "場タップの左右判定（タップ提出）がない");
  assert.ok(client.includes("bundleHeld"), "束のタップ持ち上げがない");
  // 関係ないゾーンが行き先を遮らない: zoneAt はそのドラッグに
  // 関係するゾーンだけを見る（施工シート全体が "build" で遮っていた）
  const zoneAtBlock = client.slice(client.indexOf("const zoneAt"), client.indexOf("const directionZone"));
  assert.ok(zoneAtBlock.includes("wanted.includes(id)"), "zoneAt が関係ないゾーンに遮蔽される");
  // 方向スワイプ解決（移動の向きで受ける）が近接の後・フリックの前に試される
  assert.ok(client.includes("const directionZone"), "方向スワイプ解決がない");
  assert.ok(client.includes("dist < 24") && client.includes("dot > 0.2"), "方向スワイプの閾値（24px / dot 0.2）が固定されていない");
  assert.ok(endBlock.indexOf("directionZone(") > endBlock.indexOf("nearestZone(") && endBlock.indexOf("directionZone(") < endBlock.indexOf("flickZone("), "近接→方向→フリックの順で救済していない");
  // ドラッグ中の着地予測（dropHot）も同じ解決順で光る
  const moveBlock = client.slice(client.indexOf("const moveDrag"), client.indexOf("const endDrag"));
  assert.ok(moveBlock.includes("nearestZone(track.payload, e.clientX, e.clientY)"), "ドラッグ中の着地予測に近接解決が使われていない");
  const marketIdx = client.indexOf("balku-market-card");
  assert.ok(client.slice(marketIdx, marketIdx + 1400).includes('type: "buyMaterial"'), "市場のタップ購入がない");
  assert.ok(client.includes('aria-label="手番トークン（相手の席へ放つとパス）"'), "手番トークンがない");
});

test("演出と認知負荷: パーティクル/シェイクと、チップ化した施工情報", () => {
  // ムーブ解決でパーティクルが弾け、BALKU では画面が揺れる
  assert.ok(client.includes("const burstAt"), "パーティクル発火がない");
  assert.ok(client.includes("balku-fx balku-fx-"), "パーティクル層がない");
  assert.ok(client.includes('burstAt(e.clientX, e.clientY, "balku")'), "BALKU のパーティクルがない");
  assert.ok(client.includes('burstAt(e.clientX, e.clientY, "coin")'), "購入/入札のパーティクルがない");
  assert.ok(css.includes(".balku-fx span") && css.includes("@keyframes balku-fx-fly"), "パーティクルの CSS がない");
  assert.ok(css.includes(".balku-shake {"), "画面シェイクのクラスがない");
  // 提出の予測は専用スペースでなく、場全体の薄い光とクローンの色で返す
  assert.ok(css.includes(".balku-field-openhot {") && css.includes(".balku-field-downhot {"), "場の予測の光がない");
  assert.ok(css.includes(".balku-clone-open {") && css.includes(".balku-clone-down {"), "クローンの予測色がない");
  assert.ok(client.includes("balku-field-openhot") && client.includes("balku-clone-open"), "予測の光/色がクライアントで使われていない（無スタイル部品）");
  // 施工情報は行＋文章ではなくチップとバッジ（構造で状態が分かる形）
  assert.ok(client.includes("balku-reqchips"), "必要素材がチップ化されていない");
  assert.ok(!client.includes("balku-reqrows"), "必要素材の行表示が残っている");
  assert.ok(!client.includes("素材条件を満たしています（正規完成）。"), "長い合法説明文が残っている");
  assert.ok(client.includes("balku-legal-badge"), "合法バッジがない");
  // 情報バーはターンと山札を1チップに統合（常時表示の要素を減らす）
  assert.ok(/第\{st\.turn\}ターン ・ 山札/.test(client), "情報バーのチップ統合がない");
});

test("取る側のバランス: 掴みは大きく、提出先の専用スペースは置かない", () => {
  // ファンの重なりは浅く（露出7割で掴める帯を広く保つ）
  assert.ok(css.includes("* -0.3)"), "ファンの重なりが深いまま（掴める帯が狭い）");
  // ドラッグ中のゴーストは手札カードより大きく浮く
  assert.ok(/\.balku-drag-clone \.balku-card-small \{ width:156px/.test(css), "ドラッグゴーストが小さいまま");
  // 施工の大カード（束の掴み元）も一回り大きく
  assert.ok(css.includes("width:min(264px, 76cqw)"), "施工カードが小さいまま");
  // 提出先は場そのもの（第3弾の「場の下部56%の半分」も第4弾で廃止。
  // 狭くて邪魔な受け皿は置かず、場へ放る動き自体で判定する）
  assert.ok(!css.includes(".balku-fieldhalves") && !client.includes("balku-fieldhalves"), "提出先の専用スペースが残っている");
});

test("対戦画面とカタログに絵文字が残っていない", () => {
  assert.ok(!client.includes("🎉"));
  const catalog = fs.readFileSync(path.join(root, "lib", "games-catalog.ts"), "utf8");
  assert.ok(!catalog.includes("🏗"));
});

test("第4弾: パスボタン明示・境界は緩く薄く・モーションの繋ぎ目", () => {
  // パスは隠れたジェスチャでなく明示ボタン（情報バーの先頭側＝自分の
  // 手番の間は横スクロールなしで必ず届く位置）。トークンの放る/タップ
  // でも等価にパスできる導線は残す
  assert.ok(client.includes("balku-passbtn"), "パスボタンがない");
  assert.ok(client.includes('aria-label="パス（手番を次の人へ渡す）"'), "パスボタンのラベルがない");
  const passIdx = client.indexOf("balku-passbtn");
  assert.ok(client.slice(passIdx, passIdx + 1200).includes('type: "endTurn"'), "パスボタンが endTurn に繋がっていない");
  assert.ok(passIdx < client.indexOf("balku-chip-deck"), "パスボタンが情報バーの先頭側にない（山札チップより後ろだと狭幅で画面外に流れる）");
  assert.ok(css.includes(".balku-passbtn {"), "パスボタンの CSS がない（無スタイル部品）");
  assert.ok(/\.balku-passbtn \{[^}]*min-height:44px/.test(css), "パスボタンのタップ下限（44px）がない");
  assert.ok(/\.balku-passbtn \{[^}]*var\(--balku-spring\)/.test(css), "パスボタンにバネの弾力がない");
  // 境界は薄く: 席と自領域の区切り線は最小限まで減衰させる
  assert.ok(/\.balku-seat \{[^}]*rgba\(233,242,244,\.06\)/.test(css), "席の境界が薄くなっていない");
  assert.ok(/\.balku-self \{[^}]*rgba\(233,242,244,\.06\)/.test(css), "自領域の境界が薄くなっていない");
  // 「ここへドラッグ」の導線は置かない: 受け皿・ヒント文・引き寄せ
  // ヒントを全廃し、判定は動き自体が担う（説明はハンバーガーの進め方だけ）
  assert.ok(!client.includes("balku-build-hint") && !css.includes(".balku-build-hint"), "施工シートの導線文が残っている");
  assert.ok(!client.includes("balku-bundle-pullhint") && !css.includes(".balku-bundle-pullhint"), "束の引き寄せヒントが残っている");
  assert.ok(client.includes("相手の伏せ束は自分の側へ引くと BALKU"), "ハンバーガーの進め方から BALKU の説明が消えた");
  // 重なった判定は「中心への近さ」で滲ませて決める（先勝ちの線引きにしない）
  const zoneAtBlock = client.slice(client.indexOf("const zoneAt"), client.indexOf("const directionZone"));
  assert.ok(zoneAtBlock.includes("dist < best.dist"), "zoneAt が中心への近さで決めていない");
  // 繋ぎ目1: ドラッグ中は追随 transition を付けない（指とカードのズレの元）
  assert.ok(!/\.balku-drag-clone \{[^}]*transition/.test(css), "ドラッグクローンに追随 transition が残っている");
  assert.ok(css.includes("@keyframes balku-lift"), "掴んだ瞬間のバネ（lift）がない");
  // 繋ぎ目2: 外して戻る時だけバネで滑らせる
  assert.ok(client.includes("returning: true"), "スナップバックの帰還状態がない");
  assert.ok(/\.balku-drag-clone\.balku-drag-return \{[^}]*transition:transform 260ms var\(--balku-spring\)/.test(css), "帰還のバネ transition がない");
  // 繋ぎ目3: 離した地点から行き先へカードが飛び、着地で消える（寸断しない）
  assert.ok(client.includes("const flyFromPoint"), "地点→行き先の飛行がない");
  const endIdx = client.indexOf("const endDrag");
  const endBlock = client.slice(endIdx, client.indexOf("const cancelDrag", endIdx));
  assert.ok(endBlock.includes("flyFromPoint(track.label"), "ドロップ時に離した地点から飛んでいない");
  assert.ok(client.includes("opacity: fly.go ? 0 : 1"), "飛行カードが着地でフェードしていない（消える瞬間が跳ねる）");
});
