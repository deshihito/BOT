// 蒸留済み: TEAMMODE（チーム戦モード）
// 生成版 src/generated/TEAMMODE.ts の置換。挙動は生成版と等価であり、
// tests/teammode.test.mjs（手計算の期待値）と npm test のダイジェストで担保する。
//
// 期間限定イベント: 有効なのは絶対日数（2000-01-01 起算 + 0.375 日 = 09:00 UTC
// 切り替わり）で 9584（2026-03-29）と 9697（2026-07-20）の 2 日だけ。
// それ以外の日は script1 が日付ゲートで待機し続け G.TEAMMODE は "0" のまま、
// script3 も Respawn して即終了する。Version_name への " Team" 追加もゲートの内側。
//
// マッチ進行は 10 分周期（Phase = floor(経過分 mod 10)）:
//   Phase 0: Result（結果） / Phase 1: Prepare（準備） / Phase 2..9: Battle（対戦）
//
// G.TEAMMODE_2 は全クライアント共有のマッチ状態（23 項目、script1 が初期化）:
//    1: R チーム人数（Process players が毎秒集計）
//    2: B チーム人数
//    3: R スコア / 4: B スコア
//    5: 状態（0 = 準備, 1 = 対戦, 2 = 結果）
//    6: 希望チーム（0 = おまかせ, 1 = R, 2 = B。Pen/All が書く）
//    7: 対戦タイマー表示 "M:SS"
//    8: R チームカラー（初期 3） / 9: B チームカラー（初期 6）
//   10: ゾーン中心 X（初期 3200、[2550, 3850] にクランプ）
//   11: ゾーン中心 Y（初期 0）
//   12: ゾーン幅（初期 250） / 13: ゾーン高さ（初期 250）
//   14: ゾーン占有の得点単価（初期 1）
//   15: 得点単価 2（初期 6。Pen/All が加算に使う）
//   16: 得点単価 3（初期 30。Pen/All が MVPpoint と併用）
//   17: MVP 表示名（4 文字）
//   18: R チーム MVP の表示値（そのプレイヤーのクラウド field 59）
//   19: B チーム MVP の表示値
//   20..23: 初期値 5 / 10 / 2 / 10（このスプライトでは未使用）
//
// チーム ID: R = "1000"、B = "2000"、ロビー = 自分の ID。
// クラウドレコード（59 フィールド）の参照: field 1 = 名前、3 = X、4 = Y、
// 12 = Team_ID、59 = 表示値。注意: Process players は field 60 / 61 も読むが、
// これは隣のレコードの field 1 / 2 にあたる（原作の挙動そのまま）。
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop, letterOf } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class TEAMMODE extends Sprite {
    /** マッチの Phase（0 = 結果, 1 = 準備, 2..9 = 対戦）。script1 が毎周更新する。 */
    Phase = 0;
    /** 走査位置（原作の process_a）。CLOUD のレコード先頭（0 始まり）と、
     *  [名前, 値] ペア列の添字（1 始まり）を兼ねる。初期値 59 は保存値の残り。 */
    scanIndex = 59;
    /** 作業変数（原作の process_b）。チーム桁・MVP キー・ペア位置・最大値を兼ねる。 */
    workValue = 6;
    /** 作業変数（原作の process_c）。ゾーン占有バランス（±集計）と、
     *  MVP 候補の "#名前" を兼ねる。 */
    workText = 0;
    /** Process players が毎秒 "1" にする再読み込みフラグ。
     *  script1 と Wait がこれで 1 秒周期に同期する。 */
    player_reload = 1;
    /** Battle の残り秒数（原作の a、Battle 内でのみ使用）。 */
    remainSeconds = 0;
    /** Battle の残り秒数の秒部分（原作の b、Battle 内でのみ使用）。 */
    secondsPart = 0;
    /** 最終チェック時刻（秒、原作の "world temp"）。120 秒ごとの再編成判定に使う。 */
    lastCheckSec = 0;
    /** プレイヤー間の平均スコア差。未集計の間は番兵 "-" が入る。 */
    Score_dif = 0;
    /** Score_dif の集計対象人数（原作の dif_count）。 */
    difCount = 0;
    /** 自チームのゾーン得点集計: ["#名前", 合計, …] のペア列。 */
    MVPcount = new SList([]);
    /** 全プレイヤーの出現回数集計: [キー, 回数, …] のペア列。
     *  キーはクラウド field 60（隣レコードの field 1）から取る。 */
    MVP = new SList([]);
    constructor(rt) {
        super(rt, "TEAMMODE");
        this.costumes = [
            { name: "costume1", assetFile: "576aeb8905e0b5685794e01ca28d417a.svg", rotationCenterX: 0, rotationCenterY: 0 },
        ];
        this.loadCostumeImages();
        this.sounds = [
            { name: "ワープ", assetFile: "ca59bd66b9a2dd04c17bd3658227b194.wav" },
            { name: "WIN", assetFile: "35b7f0e706d7ba8dd3305fd3c8146e7d.wav" },
            { name: "LOSE", assetFile: "fbaceb32264a17763bddb893240ff754.wav" },
        ];
        this.x = 36;
        this.y = 28;
        this.direction = 90;
        this.size = 100;
        this.visible = true;
    }
    varByName(name) {
        switch (name) {
            case "Phase": return this.Phase;
            case "process_a": return this.scanIndex;
            case "process_b": return this.workValue;
            case "process_c": return this.workText;
            case "player_reload": return this.player_reload;
            case "a": return this.remainSeconds;
            case "b": return this.secondsPart;
            case "world temp": return this.lastCheckSec;
            case "Score dif": return this.Score_dif;
            case "dif_count": return this.difCount;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script1());
        this.rt.registerHat(this, "broadcast:1 second", () => this.script2());
        this.rt.registerHat(this, "broadcast:TEAMMODE", () => this.script3());
    }
    // hat: event_whenflagclicked (flag)
    *script1() {
        G.TEAMMODE = "0";
        G.MVPpoint.deleteAll();
        this.MVPcount.deleteAll();
        G.TEAMMODE_2.deleteAll();
        const _cnt1 = Math.max(0, Math.floor(N(6)));
        for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
            G.TEAMMODE_2.add("0");
            if (!this.rt.warpActive)
                yield;
        }
        G.TEAMMODE_2.add("");
        G.TEAMMODE_2.add("3");
        G.TEAMMODE_2.add("6");
        G.TEAMMODE_2.add("3200");
        G.TEAMMODE_2.add("0");
        G.TEAMMODE_2.add("250");
        G.TEAMMODE_2.add("250");
        G.TEAMMODE_2.add("1");
        G.TEAMMODE_2.add("6");
        G.TEAMMODE_2.add("30");
        G.TEAMMODE_2.add("0000");
        const _cnt2 = Math.max(0, Math.floor(N(2)));
        for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
            G.TEAMMODE_2.add("");
            if (!this.rt.warpActive)
                yield;
        }
        G.TEAMMODE_2.add("5");
        G.TEAMMODE_2.add("10");
        G.TEAMMODE_2.add("2");
        G.TEAMMODE_2.add("10");
        yield { waitSeconds: N(0.5) };
        // 日付ゲート: 開催日（絶対日数 9584 / 9697）になるまでここで待機する。
        yield { waitUntil: () => B((B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9697")) || B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9584")))) };
        G.Version_name = (S(G.Version_name) + S(" Team"));
        G.TEAMMODE = "1";
        this.player_reload = "0";
        yield { waitUntil: () => B(equals(this.player_reload, "1")) };
        // 初回編成: 人数が互角ならランダム、そうでなければ少ない方へ。
        if (B(equals(G.TEAMMODE_2.item(1), G.TEAMMODE_2.item(2)))) {
            if (B(equals(random(1, 2), "1"))) {
                yield* this.Join_team("R");
            }
            else {
                yield* this.Join_team("B");
            }
        }
        else {
            if (B((compare(G.TEAMMODE_2.item(1), G.TEAMMODE_2.item(2)) < 0))) {
                yield* this.Join_team("R");
            }
            else {
                yield* this.Join_team("B");
            }
        }
        yield* this.Team_score_modify();
        this.Phase = mathop("floor", mod((N(this.rt.daysSince2000()) * N(1440)), 10));
        if (B(equals(this.Phase, "1"))) {
            G.TEAMMODE_2.replace(5, "0");
            while (!B((!B(equals(this.Phase, "1"))))) {
                this.Phase = mathop("floor", mod((N(this.rt.daysSince2000()) * N(1440)), 10));
                if (!this.rt.warpActive)
                    yield;
            }
        }
        this.rt.broadcast(S("TEAMMODE"));
        while (true) {
            this.Phase = mathop("floor", mod((N(this.rt.daysSince2000()) * N(1440)), 10));
            // 120 秒ごとに MVP とスコア状態をリセットし、チームを組み直す。
            if (B((compare((N(this.lastCheckSec) + N(120)), (N(this.rt.daysSince2000()) * N(86400))) < 0))) {
                G.MVPpoint.deleteAll();
                this.MVPcount.deleteAll();
                G.TEAMMODE_2.replace(5, "0");
                if (B((compare(G.TEAMMODE_2.item(1), G.TEAMMODE_2.item(2)) < 0))) {
                    yield* this.Join_team("R");
                }
                else {
                    yield* this.Join_team("B");
                }
                yield* this.Wait("5");
                yield* this.Team_score_modify();
            }
            this.lastCheckSec = (N(this.rt.daysSince2000()) * N(86400));
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenbroadcastreceived (broadcast:1 second)
    *script2() {
        yield* this.Process_players();
    }
    // hat: event_whenbroadcastreceived (broadcast:TEAMMODE)
    *script3() {
        while (true) {
            // 開催日以外は Respawn して終了（script1 のゲートと対）。
            if (B((!B((B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9697")) || B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9584"))))))) {
                yield* this.Respawn();
                return;
            }
            if (B(equals(this.Phase, "0"))) {
                yield* this.Result();
                yield { waitUntil: () => B((!B(equals(this.Phase, "0")))) };
            }
            else {
                if (B(equals(this.Phase, "1"))) {
                    yield* this.Prepare();
                    yield { waitUntil: () => B((!B(equals(this.Phase, "1")))) };
                }
                else {
                    yield* this.Battle();
                }
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // procedure: "Respawn" (warp)
    *Respawn() {
        this.rt.pushWarp();
        try {
            this.rt.soundPlay("ca59bd66b9a2dd04c17bd3658227b194.wav");
            G.X = "0";
            G.Y = "0";
            G.Speed_x = "0";
            G.Speed_y = "0";
            G.Health = G.Max_health;
            G.Menu.replace(2, "520");
            G.Menu.replace(22, "0");
            G.Menu.replace(56, "0");
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Process players" (warp)
    // 1 秒ごとの集計。CLOUD の全レコードを走査し、チーム人数・ゾーン占有・
    // スコア差分・MVP を更新する。
    *Process_players() {
        this.rt.pushWarp();
        try {
            this.player_reload = "1";
            this.scanIndex = "0";
            this.workText = "0";
            this.Score_dif = "-";
            this.difCount = "0";
            G.TEAMMODE_2.replace(1, "0");
            G.TEAMMODE_2.replace(2, "0");
            this.MVP.deleteAll();
            const _cnt3 = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B((!B(equals(G.CLOUD.item((N(this.scanIndex) + N(1))), ""))))) {
                    // スコア差分: X > 400 のプレイヤーの field 61 を集計（平均はループ後）。
                    if (B((compare("400", G.CLOUD.item((N(this.scanIndex) + N(3)))) < 0))) {
                        this.Score_dif = N(this.Score_dif) + N(G.CLOUD.item((N(this.scanIndex) + N(61))));
                        this.difCount = N(this.difCount) + N(1);
                    }
                    this.workValue = letterOf(G.CLOUD.item((N(this.scanIndex) + N(12))), 1);
                    // 人数集計: ロビー中か準備中は素のチーム別、対戦中は自チームを 1 側に数える。
                    if (B((B(equals(G.Team_ID, G.ID)) || B(equals(G.TEAMMODE_2.item(5), "0"))))) {
                        if (B(equals(this.workValue, "1"))) {
                            G.TEAMMODE_2.replace(1, (N(G.TEAMMODE_2.item(1)) + N(1)));
                        }
                        if (B(equals(this.workValue, "2"))) {
                            G.TEAMMODE_2.replace(2, (N(G.TEAMMODE_2.item(2)) + N(1)));
                        }
                    }
                    else {
                        if (B(equals(letterOf(G.Team_ID, 1), this.workValue))) {
                            G.TEAMMODE_2.replace(1, (N(G.TEAMMODE_2.item(1)) + N(1)));
                        }
                        else {
                            G.TEAMMODE_2.replace(2, (N(G.TEAMMODE_2.item(2)) + N(1)));
                        }
                    }
                    // ゾーン占有: 中心 (item 10, 11) ± (item 12, 13) / 2 の内側なら得点。
                    if (B((B((compare(mathop("abs", (N(G.CLOUD.item((N(this.scanIndex) + N(3)))) - N(G.TEAMMODE_2.item(10)))), (N(G.TEAMMODE_2.item(12)) / N(2))) < 0)) && B((compare(mathop("abs", (N(G.CLOUD.item((N(this.scanIndex) + N(4)))) - N(G.TEAMMODE_2.item(11)))), (N(G.TEAMMODE_2.item(13)) / N(2))) < 0))))) {
                        G.MVPpoint.add(G.CLOUD.item((N(this.scanIndex) + N(1))));
                        G.MVPpoint.add(G.TEAMMODE_2.item(14));
                        if (B(equals(this.workValue, "1"))) {
                            this.workText = N(this.workText) + N(1);
                        }
                        else {
                            this.workText = N(this.workText) + N(-1);
                        }
                    }
                    // 出現回数: キーは field 60（隣レコードの field 1）。
                    this.workValue = G.CLOUD.item((N(this.scanIndex) + N(60)));
                    if (B(this.MVP.contains(this.workValue))) {
                        this.workValue = (N(this.MVP.itemNum(this.workValue)) + N(1));
                        this.MVP.replace(this.workValue, (N(this.MVP.item(this.workValue)) + N(1)));
                    }
                    else {
                        this.MVP.add(this.workValue);
                        this.MVP.add("1");
                    }
                }
                this.scanIndex = N(this.scanIndex) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            // 対戦中はゾーン占有バランス（±5 にクランプ）をスコアへ換算する。
            if (B(equals(G.TEAMMODE_2.item(5), "1"))) {
                if (B((compare("5", this.workText) < 0))) {
                    this.workText = "5";
                }
                if (B((compare(this.workText, "-5") < 0))) {
                    this.workText = "-5";
                }
                if (B((compare("0", this.workText) < 0))) {
                    G.TEAMMODE_2.replace(3, (N(G.TEAMMODE_2.item(3)) + N((N(this.workText) * N(G.TEAMMODE_2.item(14))))));
                }
                if (B((compare(this.workText, "0") < 0))) {
                    G.TEAMMODE_2.replace(4, (N(G.TEAMMODE_2.item(4)) + N(mathop("abs", (N(this.workText) * N(G.TEAMMODE_2.item(14)))))));
                }
            }
            // スコア差分の平均が実スコア差と 200 以上ずれたら、平均側へ寄せ直す。
            this.Score_dif = (N(this.Score_dif) / N(this.difCount));
            if (B((compare(mathop("abs", this.Score_dif), "300") < 0))) {
                if (B((compare("200", mathop("abs", (N(this.Score_dif) - N((N(G.TEAMMODE_2.item(3)) - N(G.TEAMMODE_2.item(4))))))) < 0))) {
                    if (B((compare("3", this.difCount) < 0))) {
                        yield* this.Team_score_modify();
                    }
                }
            }
            // MVP 集計: MVPpoint のうち自チームの分だけを "#名前" で合算する。
            this.scanIndex = "1";
            const _cnt4 = Math.max(0, Math.floor(N((N(G.MVPpoint.length) / N(2)))));
            for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                if (B(equals(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.MVPpoint.item(this.scanIndex)))) + N(11))), G.Team_ID))) {
                    this.workValue = (S("#") + S(G.MVPpoint.item(this.scanIndex)));
                    if (B(this.MVPcount.contains(this.workValue))) {
                        this.workValue = (N(this.MVPcount.itemNum(this.workValue)) + N(1));
                        this.MVPcount.replace(this.workValue, (N(this.MVPcount.item(this.workValue)) + N(G.MVPpoint.item((N(this.scanIndex) + N(1))))));
                    }
                    else {
                        this.MVPcount.add(this.workValue);
                        this.MVPcount.add(G.MVPpoint.item((N(this.scanIndex) + N(1))));
                    }
                }
                this.scanIndex = N(this.scanIndex) + N(2);
                if (!this.rt.warpActive)
                    yield;
            }
            G.MVPpoint.deleteAll();
            // MVP 表示名: 合算トップの名前（"#" を除いた 4 文字）を item 17 へ。
            this.scanIndex = "1";
            this.workValue = "0";
            const _cnt5 = Math.max(0, Math.floor(N((N(this.MVPcount.length) / N(2)))));
            for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                if (B((compare(this.workValue, this.MVPcount.item((N(this.scanIndex) + N(1)))) < 0))) {
                    this.workValue = this.MVPcount.item((N(this.scanIndex) + N(1)));
                    this.workText = this.MVPcount.item(this.scanIndex);
                }
                this.scanIndex = N(this.scanIndex) + N(2);
                if (!this.rt.warpActive)
                    yield;
            }
            G.TEAMMODE_2.replace(17, (S(letterOf(this.workText, 2)) + S((S(letterOf(this.workText, 3)) + S((S(letterOf(this.workText, 4)) + S(letterOf(this.workText, 5))))))));
            yield* this.MVP_2("1");
            yield* this.MVP_2("2");
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Result"
    // 状態を結果 (2) にし、合計スコア 100 超かつ複数人なら勝ちチームに
    // Money x25 / Tektite x2（各 350）をドロップさせる。負けはサウンドのみ。
    *Result() {
        G.TEAMMODE_2.replace(5, "2");
        if (B((B((compare("100", (N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(4)))) < 0)) && B((compare("1", G.Active_players) < 0))))) {
            if (B((B((B(equals(letterOf(G.Team_ID, 1), "1")) && B((compare(G.TEAMMODE_2.item(4), G.TEAMMODE_2.item(3)) < 0)))) || B((B(equals(letterOf(G.Team_ID, 1), "2")) && B((compare(G.TEAMMODE_2.item(3), G.TEAMMODE_2.item(4)) < 0))))))) {
                this.rt.soundPlay("35b7f0e706d7ba8dd3305fd3c8146e7d.wav");
                const _cnt6 = Math.max(0, Math.floor(N(25)));
                for (let _rep6 = 0; _rep6 < _cnt6; _rep6++) {
                    G.Bullet_and_effect.add("0000");
                    G.Bullet_and_effect.add("Money");
                    G.Bullet_and_effect.add("350");
                    G.Bullet_and_effect.add("");
                    G.Bullet_and_effect.add(random(0, 360));
                    G.Bullet_and_effect.add(random(5, 10));
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    if (!this.rt.warpActive)
                        yield;
                }
                const _cnt7 = Math.max(0, Math.floor(N(2)));
                for (let _rep7 = 0; _rep7 < _cnt7; _rep7++) {
                    G.Bullet_and_effect.add("0000");
                    G.Bullet_and_effect.add("Tektite");
                    G.Bullet_and_effect.add("350");
                    G.Bullet_and_effect.add("");
                    G.Bullet_and_effect.add(random(0, 360));
                    G.Bullet_and_effect.add(random(5, 10));
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            else {
                this.rt.soundPlay("fbaceb32264a17763bddb893240ff754.wav");
            }
        }
    }
    // procedure: "Battle"
    // Phase 2..9 の間まわる。タイマー表示とゾーン中心のドリフト、
    // 片側が空になったときの稀な自動移動（1/150）を担う。
    *Battle() {
        while (!B((compare(this.Phase, "2") < 0))) {
            G.TEAMMODE_2.replace(5, "1");
            this.remainSeconds = (N((N(8) - N((N(mod((N(this.rt.daysSince2000()) * N(1440)), 10)) - N(2))))) * N(60));
            this.secondsPart = mathop("floor", (N(this.remainSeconds) - N((N(mathop("floor", (N(this.remainSeconds) / N(60)))) * N(60)))));
            if (B(equals(S(this.secondsPart).length, "1"))) {
                this.secondsPart = (S("0") + S(this.secondsPart));
            }
            G.TEAMMODE_2.replace(7, (S(mathop("floor", (N(this.remainSeconds) / N(60)))) + S((S(":") + S(this.secondsPart)))));
            if (B((B((compare("1", G.Active_players) < 0)) && B(equals((N(G.TEAMMODE_2.item(1)) * N(G.TEAMMODE_2.item(2))), "0"))))) {
                if (B(equals(random(1, 150), "1"))) {
                    if (B(equals(letterOf(G.Team_ID, 1), "1"))) {
                        yield* this.Join_team("B");
                    }
                    else {
                        yield* this.Join_team("R");
                    }
                }
            }
            G.TEAMMODE_2.replace(10, (N(G.TEAMMODE_2.item(10)) + N((N((N((N(3200) + N((N(650) / N((N(150) / N(this.Score_dif))))))) - N(G.TEAMMODE_2.item(10)))) / N(4)))));
            if (B((compare("3850", G.TEAMMODE_2.item(10)) < 0))) {
                G.TEAMMODE_2.replace(10, "3850");
            }
            if (B((compare(G.TEAMMODE_2.item(10), "2550") < 0))) {
                G.TEAMMODE_2.replace(10, "2550");
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Prepare"
    // スコア・希望チーム・MVP を消し、ロビーへ戻してから 30 秒待機し、
    // 希望チーム（item 6）か人数バランスで再編成する。最後に人数差が
    // 許容（1 + ceil(参加人数 / 7)）を超えたら自分が大きい側から小さい側へ移る。
    *Prepare() {
        G.TEAMMODE_2.replace(5, "0");
        if (B((compare("400", G.X) < 0))) {
            yield* this.Respawn();
        }
        G.TEAMMODE_2.replace(3, "0");
        G.TEAMMODE_2.replace(4, "0");
        G.TEAMMODE_2.replace(6, "0");
        G.TEAMMODE_2.replace(17, "0000");
        G.MVPpoint.deleteAll();
        this.MVPcount.deleteAll();
        yield* this.Join_team("L");
        yield* this.Wait("30");
        if (B(equals(G.TEAMMODE_2.item(6), "0"))) {
            yield* this.Wait("10");
            if (B((B(equals(random(1, 3), "1")) || B((compare(mathop("abs", (N(G.TEAMMODE_2.item(1)) - N(G.TEAMMODE_2.item(2)))), "3") < 0))))) {
                if (B(equals(random(1, 2), "1"))) {
                    yield* this.Join_team("R");
                }
                else {
                    yield* this.Join_team("B");
                }
            }
            else {
                if (B((compare(G.TEAMMODE_2.item(1), G.TEAMMODE_2.item(2)) < 0))) {
                    yield* this.Join_team("R");
                }
                else {
                    yield* this.Join_team("B");
                }
            }
        }
        else {
            yield* this.Wait("5");
            if (B(equals(G.TEAMMODE_2.item(6), "1"))) {
                yield* this.Join_team("R");
            }
            if (B(equals(G.TEAMMODE_2.item(6), "2"))) {
                yield* this.Join_team("B");
            }
            yield* this.Wait("5");
        }
        yield* this.Wait(random(5, 15));
        if (B((compare((N(1) + N(mathop("ceiling", (N(G.Active_players) / N(7))))), mathop("abs", (N(G.TEAMMODE_2.item(1)) - N(G.TEAMMODE_2.item(2))))) < 0))) {
            if (B((compare(G.TEAMMODE_2.item(2), G.TEAMMODE_2.item(1)) < 0))) {
                if (B(equals(letterOf(G.Team_ID, 1), "1"))) {
                    yield* this.Join_team("B");
                }
            }
            else {
                if (B(equals(letterOf(G.Team_ID, 1), "2"))) {
                    yield* this.Join_team("R");
                }
            }
        }
    }
    // procedure: "Join team %s"
    // "L" = ロビー（Team_ID は自分の ID）、"R" = "1000"、"B" = "2000"。
    // チームカラーは TEAMMODE_2 の item 8 / 9 から取る。
    *Join_team(LRB) {
        if (B(equals(LRB, "L"))) {
            G.Team_ID = G.ID;
            G.Team_color = "0";
            G.Team_menu = "0";
        }
        if (B(equals(LRB, "R"))) {
            G.Team_ID = "1000";
            G.Team_color = G.TEAMMODE_2.item(8);
            G.Team_menu = "1";
        }
        if (B(equals(LRB, "B"))) {
            G.Team_ID = "2000";
            G.Team_color = G.TEAMMODE_2.item(9);
            G.Team_menu = "1";
        }
    }
    // procedure: "Wait %s"
    // 1 秒ブロードキャスト（player_reload）で数える待機。ただし数えるのは
    // 状態が準備中（item 5 = "0"）の間だけ。対戦中は即座に抜ける（原作の挙動）。
    *Wait(seconds) {
        const _cnt8 = Math.max(0, Math.floor(N(seconds)));
        for (let _rep8 = 0; _rep8 < _cnt8; _rep8++) {
            if (B(equals(G.TEAMMODE_2.item(5), "0"))) {
                this.player_reload = "0";
                yield { waitUntil: () => B(equals(this.player_reload, "1")) };
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Team score modify"
    // 平均スコア差（Score_dif）で片側のスコアをもう片側へ寄せ直す。
    // Score_dif が番兵 "-" の間は何もしない。
    *Team_score_modify() {
        if (B((!B(equals(this.Score_dif, "-"))))) {
            if (B((compare("0", this.Score_dif) < 0))) {
                G.TEAMMODE_2.replace(3, (N(G.TEAMMODE_2.item(4)) + N(Math.round(N(this.Score_dif)))));
            }
            else {
                G.TEAMMODE_2.replace(4, (N(G.TEAMMODE_2.item(3)) + N(mathop("abs", Math.round(N(this.Score_dif))))));
            }
        }
    }
    // procedure: "MVP %s"
    // チーム別 MVP: 出現回数リスト（MVP）から、そのチームに属し回数最大の
    // プレイヤーを探し、そのクラウド field 59 を TEAMMODE_2 の 17 + team へ書く。
    *MVP_2(team) {
        this.scanIndex = "1";
        this.workValue = "0";
        const _cnt9 = Math.max(0, Math.floor(N((N(this.MVP.length) / N(2)))));
        for (let _rep9 = 0; _rep9 < _cnt9; _rep9++) {
            if (B((B(equals(letterOf(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.MVP.item(this.scanIndex)))) + N(11))), 1), team)) && B((compare(this.workValue, this.MVP.item((N(this.scanIndex) + N(1)))) < 0))))) {
                this.workValue = this.MVP.item((N(this.scanIndex) + N(1)));
                this.workText = this.MVP.item(this.scanIndex);
            }
            this.scanIndex = N(this.scanIndex) + N(2);
            if (!this.rt.warpActive)
                yield;
        }
        G.TEAMMODE_2.replace((N(17) + N(team)), G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.workText))) + N((N(G.Number_of_data) - N(1))))));
    }
}
