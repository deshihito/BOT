// 蒸留済み: Combat rating（戦闘レーティング）
// 生成版 src/generated/Combat_rating.ts の置換。挙動は生成版と等価であり、
// tests/combat-rating.test.mjs（手計算の期待値）と npm test のダイジェストで担保する。
//
// 役割: 戦闘中のイベント記録（G.Combat_data）を集計してプレイヤーの
// Combat Power（CP、G.Combat_Power）を更新し、全プレイヤーの CP ランキング
// （G.Ranking、原作ではリストモニター表示用）を生成する。
//
// G.Combat_data のレコード形式（1 イベント 7 フィールド、書き込み側は Pen/All）:
//   1: type          "Hit" | "Kill" | "Damage" | "Death" | "Run" | "Back"（Run/Back は集計外）
//   2: OtherCP       イベント時点の相手 CP（下記の packed 形式）
//   3: CP_freq       イベントの継続フレーム数（time / survive の元）
//   4: amount        与えた/受けたダメージ量
//   5: opponentId    相手の ID（クラウドレコード参照用。空なら参照しない）
//   6: Special_weapon "1" のとき特殊武器（自 CP 推定を 1.8 倍、相手 CP を b/3 に置換）
//   7: cloudField44  相手クラウドレコードの 44 番フィールド（"1" なら相手 CP を 1.8 倍）
//
// OtherCP の packed 形式: floor(v / 10000) * 100 + (v mod 10000) で復号する。
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, mathop } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class Combat_rating extends Sprite {
    /** Rate 用: Combat_data の読み取り位置（7 フィールド刻み） */
    recordOffset = 0;
    /** Ranking 用: 走査位置 */
    scanIndex = 0;
    /** Ranking 用: 選抜中の最大値の位置 */
    bestIndex = 0;
    /** Ranking 用: 選抜中の最大値 */
    bestValue = 0;
    /** Rate 用: 相手の強さ比率 b = (enemyCp*0.8 + otherCp*0.2) / estimatedCp */
    strengthRatio = 0.8854961832061069;
    /** イベント時点の相手 CP（レコード 2 番フィールドを復号した値） */
    otherCp = 100;
    /** 現在の相手 CP（クラウドレコード 58 番フィールドから引く。0 のとき 100） */
    enemyCp = 120;
    /** 集計中のイベント種別 */
    type = "Hit";
    /** 自 CP の推定値（特殊武器で 1.8 倍、下限 50） */
    estimatedCp = 0;
    /** 生存スコアの蓄積（Rate が加算し、script1 が戦闘終了時に使う） */
    survive = 0;
    /** 前回の確定 CP（更新式の平滑化に使う） */
    prevCp = 0;
    /** プラス側スコア（Hit / Kill） */
    scorePlus = 0;
    /** マイナス側スコア（Damage / Death） */
    scoreMinus = 0;
    /** 戦闘時間の蓄積（CP_freq の合計） */
    time = 0;
    /** Ranking 用: (CP, CP) の組の候補リスト。生成版の temp に相当 */
    candidates = new SList([]);
    constructor(rt) {
        super(rt, "Combat rating");
        this.costumes = [
            { name: "costume1", assetFile: "576aeb8905e0b5685794e01ca28d417a.svg", rotationCenterX: 0, rotationCenterY: 0 },
        ];
        this.loadCostumeImages();
        this.x = 0;
        this.y = 0;
        this.direction = 90;
        this.size = 100;
        this.visible = true;
    }
    varByName(name) {
        switch (name) {
            // 生成版の a/b/c は用途ごとに分割した（recordOffset / strengthRatio / bestIndex）
            case "a": return this.recordOffset;
            case "b": return this.strengthRatio;
            case "c": return this.bestIndex;
            case "OCP": return this.otherCp;
            case "ECP": return this.enemyCp;
            case "type": return this.type;
            case "estimate CP": return this.estimatedCp;
            case "survive": return this.survive;
            case "prev CP": return this.prevCp;
            case "score p": return this.scorePlus;
            case "score n": return this.scoreMinus;
            case "time": return this.time;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script1());
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script2());
    }
    // タイトルを抜けたあと常駐するメインスクリプト。
    // 戦闘中かどうかはプレイヤー座標 G.X > 400 で判定する（原作の方式）。
    // 非戦闘時: 1 秒ごとに Ranking だけ更新する。
    // 戦闘時: 1 秒ごとに Rate + Ranking。戦闘が終わって time > 1800 なら CP を確定する。
    *script1() {
        G.Combat_Power = "100";
        this.prevCp = "100";
        G.Combat_data.deleteAll();
        yield* this.Ranking();
        while (true) {
            while (!B((compare("400", G.X) < 0))) {
                yield { waitSeconds: N(1) };
                yield* this.Ranking();
                if (!this.rt.warpActive)
                    yield;
            }
            this.survive = "0";
            this.time = "0";
            this.scorePlus = "0";
            this.scoreMinus = "0";
            while (!B((compare(G.X, "400") < 0))) {
                yield { waitSeconds: N(1) };
                yield* this.Rate();
                yield* this.Ranking();
                if (!this.rt.warpActive)
                    yield;
            }
            if (B((compare("1800", this.time) < 0))) {
                // 10 ^ log(survive) は数学的には survive そのもの（log は常用対数）。原作の式のまま保持。
                this.scorePlus = N(this.scorePlus) + N(mathop("10 ^", (N(mathop("log", this.survive)) * N(1))));
                // CP 更新式: 推定値 = (スコア差 / (time/30)) + 100 とし、prevCp と 3:1 で平滑化する
                G.Combat_Power = (N((N((N((N((N((N(this.scorePlus) - N(this.scoreMinus))) / N((N(this.time) / N(30))))) + N(100))) * N(3))) + N(this.prevCp))) / N(4));
                this.prevCp = G.Combat_Power;
                G.Combat_Power = (N(Math.round(N((N(G.Combat_Power) * N(100))))) / N(100));
                if (B((compare("899", G.Combat_Power) < 0))) {
                    G.Combat_Power = "899";
                }
                if (B((compare(G.Combat_Power, "0") < 0))) {
                    G.Combat_Power = "0";
                }
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // "k" キーで変数モニターの表示を切り替えるだけのスクリプト。
    // モニター描画自体が未実装のランタイムでは何もしない（原作では表示切替のみ）。
    *script2() {
        while (true) {
            yield { waitUntil: () => B(this.rt.keyIsPressed(S("k"))) };
            yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("k"))))) };
            yield { waitUntil: () => B(this.rt.keyIsPressed(S("k"))) };
            yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("k"))))) };
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // 戦闘イベントの集計（warp）。G.Combat_data を全件処理して空にする。
    *Rate() {
        this.rt.pushWarp();
        try {
            this.recordOffset = "0";
            for (let _rep1 = 0, _cnt1 = Math.max(0, Math.floor(N((N(G.Combat_data.length) / N(7))))); _rep1 < _cnt1; _rep1++) {
                this.type = G.Combat_data.item((N(this.recordOffset) + N(1)));
                if (B((!B((B(equals(this.type, "Run")) || B(equals(this.type, "Back"))))))) {
                    if (B((!B(equals(G.Combat_data.item((N(this.recordOffset) + N(5))), ""))))) {
                        this.enemyCp = G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Combat_data.item((N(this.recordOffset) + N(5)))))) + N(58)));
                        if (B(equals(this.enemyCp, "0"))) {
                            this.enemyCp = "100";
                        }
                        if (B(equals(G.Combat_data.item((N(this.recordOffset) + N(7))), "1"))) {
                            this.enemyCp = (N(this.enemyCp) * N(1.8));
                        }
                    }
                    if (B(equals(G.Combat_data.item((N(this.recordOffset) + N(6))), "1"))) {
                        this.estimatedCp = (N(G.Combat_Power) * N(1.8));
                    }
                    else {
                        this.estimatedCp = G.Combat_Power;
                    }
                    if (B((compare(this.estimatedCp, "50") < 0))) {
                        this.estimatedCp = "50";
                    }
                    this.otherCp = (N(mathop("floor", (N(G.Combat_data.item((N(this.recordOffset) + N(2)))) / N(10000)))) * N(100));
                    this.otherCp = N(this.otherCp) + N(mod(G.Combat_data.item((N(this.recordOffset) + N(2))), 10000));
                    this.survive = N(this.survive) + N((N((N((N(G.Combat_data.item((N(this.recordOffset) + N(3)))) / N(30))) * N((N(1) + N((N((N((N(this.otherCp) / N(this.estimatedCp))) - N(1))) * N(0.2))))))) * N(3)));
                    this.time = N(this.time) + N(G.Combat_data.item((N(this.recordOffset) + N(3))));
                    this.strengthRatio = (N((N((N(this.enemyCp) * N(0.8))) + N((N(this.otherCp) * N(0.2))))) / N(this.estimatedCp));
                    if (B(equals(G.Combat_data.item((N(this.recordOffset) + N(6))), "1"))) {
                        this.enemyCp = (N(this.strengthRatio) / N(3));
                    }
                    if (B(equals(this.type, "Hit"))) {
                        this.scorePlus = N(this.scorePlus) + N((N((N(G.Combat_data.item((N(this.recordOffset) + N(4)))) * N(this.strengthRatio))) * N(5)));
                    }
                    if (B(equals(this.type, "Kill"))) {
                        this.scorePlus = N(this.scorePlus) + N((N((N(50) * N(this.strengthRatio))) * N(10)));
                    }
                    if (B(equals(this.type, "Damage"))) {
                        this.scoreMinus = N(this.scoreMinus) + N((N((N(G.Combat_data.item((N(this.recordOffset) + N(4)))) / N(this.strengthRatio))) * N(5)));
                    }
                    if (B(equals(this.type, "Death"))) {
                        this.scoreMinus = N(this.scoreMinus) + N((N((N(50) / N(this.strengthRatio))) * N(10)));
                    }
                }
                this.recordOffset = N(this.recordOffset) + N(7);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Combat_data.deleteAll();
        }
        finally {
            this.rt.popWarp();
        }
    }
    // CP ランキングの生成（warp）。G.CLOUD の全プレイヤーレコードから
    // 59 番フィールド（CP）を集め、選抜ソートで降順に G.Ranking へ出す。
    // 注意: 生成版の式は item(a + Number_of_data) と item(a + 59) の2回読みで、
    // Number_of_data = 59 の現行値では同じフィールドを2回読む（組の両要素が CP になる）。
    // 原作のこの形をそのまま保持する。
    *Ranking() {
        this.rt.pushWarp();
        try {
            this.scanIndex = "0";
            this.candidates.deleteAll();
            for (let _rep2 = 0, _cnt2 = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data))))); _rep2 < _cnt2; _rep2++) {
                if (B((!B(equals(G.CLOUD.item((N(this.scanIndex) + N(1))), ""))))) {
                    this.candidates.add(G.CLOUD.item((N(this.scanIndex) + N(G.Number_of_data))));
                    this.candidates.add(G.CLOUD.item((N(this.scanIndex) + N(59))));
                }
                this.scanIndex = N(this.scanIndex) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Ranking.deleteAll();
            for (let _rep3 = 0, _cnt3 = Math.max(0, Math.floor(N((N(this.candidates.length) / N(2))))); _rep3 < _cnt3; _rep3++) {
                this.scanIndex = "0";
                this.bestValue = "0";
                this.bestIndex = "0";
                for (let _rep4 = 0, _cnt4 = Math.max(0, Math.floor(N((N(this.candidates.length) / N(2))))); _rep4 < _cnt4; _rep4++) {
                    if (B((compare(this.bestValue, this.candidates.item((N(this.scanIndex) + N(2)))) < 0))) {
                        this.bestValue = this.candidates.item((N(this.scanIndex) + N(2)));
                        this.bestIndex = this.scanIndex;
                    }
                    this.scanIndex = N(this.scanIndex) + N(2);
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Ranking.add(this.candidates.item((N(this.bestIndex) + N(1))));
                G.Ranking.add(this.bestValue);
                for (let _rep5 = 0, _cnt5 = Math.max(0, Math.floor(N(2))); _rep5 < _cnt5; _rep5++) {
                    this.candidates.delete((N(this.bestIndex) + N(1)));
                    if (!this.rt.warpActive)
                        yield;
                }
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
}
