// 蒸留済み: Tutorial/Others（チュートリアルと雑多な常駐処理）
// 生成版 src/generated/Tutorial_Others.ts の置換。挙動は生成版と等価であり、
// tests/tutorial-others.test.mjs（手計算の期待値）と npm test のダイジェストで担保する。
//
// 役割の束:
//   チュートリアル: script1（パネル UI）/ script2（進行シーケンス）/ Next
//   ペット解放: script3 / Creator_s_pet（ランク到達と作者本人特典）
//   離席検出: script4 / Leave_stoper（無操作 600 秒で stop all）
//   定期クリーンアップ: script5（CSPID）/ script7・8（Menu フラグ）/ script9（招待）
//   不正検出ウォッチドッグ: script6（未取得武器の所持）/ script10（サーバ移動と
//     マップ外）/ script11（リスポーン集計）/ script13・14（FPS 操作）
//     うち CSPID への追加は script10 / 11 / Defender とも if (false) で無効化済みで、
//     実際に効くのは script6 / 10 / 13 の stop all 系だけ。
//   イベント（いずれも絶対日数の等値ゲートで、その日だけ有効）:
//     9745 = 2026-09-06: script15 / 16（InfinityKnives、投擲用ナイフ配布）
//     9759 = 2026-09-20: script18（Survival 開始）
//   サバイバル: script17 / 18 / Delete_weapon / Set_inventory / Drop_item / Swap_item
//   連射検出: script19 / Defender_bu01（BU ログの頻度チェック）
//
// G.Tutorial はチュートリアル UI の状態 [パネル位置, ステップ, 右端, 進捗ゲージ]。
// G.Inventory_2 は 5 スロット x 6 フィールド（名前は 1, 7, 13, 19, 25）。
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop, letterOf } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class Tutorial_Others extends Sprite {
    /** チュートリアル用の距離（原作の a）。目標点までの距離 - 80。
     *  初期値 571.92… は作者の保存値の残り。 */
    distance = 571.9202405202649;
    /** 隠れ継続時間（原作の b）。script2 のステルス段階でのみ使う。 */
    hideTime = 0;
    /** Sp sear のスロット走査位置（原作の c、1/7/13/19/25）。初期値 25 は保存値の残り。 */
    slotIndex = 25;
    /** Sp sear の疑いフラグ（原作の d、0/1）。 */
    suspicious = 0;
    /** script11 のリスポーン走査位置（原作の detect_change1）。 */
    respawnIndex = 1;
    /** script11 の集計ペア位置（原作の detect_change2）。 */
    respawnCountPos = 2;
    /** 前回確認時の参加人数（script10 のサーバ移動検出用）。 */
    prev_active = 1;
    /** サーバ移動の累積回数（原作の "server change"、script12 が 600 秒で消す）。 */
    server_change = 0;
    /** 直近 1 秒間のフレーム数（script14 が毎秒 0 に戻す）。 */
    fps_stop = 5;
    /** FPS 超過が続いた秒数（原作の fs_counter）。 */
    overLimitSec = 0;
    /** Weapon festival / Delete weapon のスロット基準位置（原作の "Weapon festival"）。 */
    slotOffset = 0;
    /** 共有の作業変数（原作の Temp1）。主にスロット基準位置。 */
    Temp1 = 0;
    /** 共有の作業変数（原作の Temp2）。アイテム種別文字列や走査位置。 */
    Temp2 = 12;
    /** 共有の作業変数（原作の Temp3）。性能値や空スロットの番兵 "-"。 */
    Temp3 = 6;
    /** Defender の重複走査位置（原作の defender_a、3 刻み）。 */
    defScan = 0;
    /** Defender の照合キー（原作の defender_b、プレイヤー + アイテムの連結）。 */
    defKey = 0;
    /** Defender の想定発射間隔（原作の defender_c、除外時は "-"）。 */
    defInterval = 0;
    /** Defender の重複数（原作の defender_d）。 */
    defCount = 0;
    /** リスポーン回数の集計 [プレイヤー, 回数, …]（原作の "Server changer"）。 */
    respawnCounts = new SList([]);
    /** 連射検出の除外キーワード（原作の "item copy"）。
     *  この連射モード名を含む武器は間隔チェックの対象外。 */
    exemptKeywords = new SList(["オーバーヒート", "バースト", "二丁拳銃"]);
    constructor(rt) {
        super(rt, "Tutorial/Others");
        this.costumes = [
            { name: "Tutorial", assetFile: "576aeb8905e0b5685794e01ca28d417a.svg", rotationCenterX: 0, rotationCenterY: 0 },
        ];
        this.loadCostumeImages();
        this.sounds = [
            { name: "クリア", assetFile: "7babfb34bcc9dcde7707448221b55c97.wav" },
            { name: "スワップ", assetFile: "6cb83f21f9b56c4d5725c8761fdcb934.wav" },
        ];
        this.x = 0;
        this.y = 0;
        this.direction = 90;
        this.size = 100;
        this.visible = false;
    }
    varByName(name) {
        switch (name) {
            case "a": return this.distance;
            case "b": return this.hideTime;
            case "c": return this.slotIndex;
            case "d": return this.suspicious;
            case "detect_change1": return this.respawnIndex;
            case "detect_change2": return this.respawnCountPos;
            case "prev_active": return this.prev_active;
            case "server change": return this.server_change;
            case "fps_stop": return this.fps_stop;
            case "fs_counter": return this.overLimitSec;
            case "Weapon festival": return this.slotOffset;
            case "Temp1": return this.Temp1;
            case "Temp2": return this.Temp2;
            case "Temp3": return this.Temp3;
            case "defender_a": return this.defScan;
            case "defender_b": return this.defKey;
            case "defender_c": return this.defInterval;
            case "defender_d": return this.defCount;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script1());
        this.rt.registerHat(this, "flag", () => this.script2());
        this.rt.registerHat(this, "flag", () => this.script3());
        this.rt.registerHat(this, "flag", () => this.script4());
        this.rt.registerHat(this, "flag", () => this.script5());
        this.rt.registerHat(this, "flag", () => this.script6());
        this.rt.registerHat(this, "flag", () => this.script7());
        this.rt.registerHat(this, "flag", () => this.script8());
        this.rt.registerHat(this, "flag", () => this.script9());
        this.rt.registerHat(this, "flag", () => this.script10());
        this.rt.registerHat(this, "flag", () => this.script11());
        this.rt.registerHat(this, "flag", () => this.script12());
        this.rt.registerHat(this, "flag", () => this.script13());
        this.rt.registerHat(this, "flag", () => this.script14());
        this.rt.registerHat(this, "broadcast:Warp", () => this.script15());
        this.rt.registerHat(this, "flag", () => this.script16());
        this.rt.registerHat(this, "broadcast:Warp", () => this.script17());
        this.rt.registerHat(this, "flag", () => this.script18());
        this.rt.registerHat(this, "flag", () => this.script19());
    }
    // hat: event_whenflagclicked (flag)
    // チュートリアルパネルのイージング。ロビー（X < 400）にいる間だけ表示側へ寄せ、
    // 戦闘エリアへ出るかキャラクター選択中になったら畳んでステップを 10（終了）にする。
    *script1() {
        G.Tutorial.deleteAll();
        G.Tutorial.add("-58");
        G.Tutorial.add("1");
        G.Tutorial.add("58");
        G.Tutorial.add("58");
        yield { waitUntil: () => B((compare(G.X, "400") < 0)) };
        while (true) {
            G.Tutorial.replace(1, (N(G.Tutorial.item(1)) + N((N((N((N(0) - N(G.Tutorial.item(1)))) / N(4))) * N(G.FPS_temp)))));
            G.Tutorial.replace(3, (N(G.Tutorial.item(3)) + N((N((N((N(G.Tutorial.item(4)) - N(G.Tutorial.item(3)))) / N(4))) * N(G.FPS_temp)))));
            if (B((B((compare("400", G.X) < 0)) || B((!B(equals(G.Character, "0"))))))) {
                while (!B((compare(G.Tutorial.item(1), "-57") < 0))) {
                    G.Tutorial.replace(1, (N(G.Tutorial.item(1)) + N((N((N((N(-58) - N(G.Tutorial.item(1)))) / N(4))) * N(G.FPS_temp)))));
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Tutorial.replace(2, "10");
                return;
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // チュートリアル進行シーケンス。プレイヤーの操作（サブ武器の装備、リロード、
    // スコープ、スキル、ステルス、エリア移動）を待ち、段階ごとに Next で進める。
    // どの段階でもステップが 10（script1 が畳んだ印）になったら中断する。
    // 進捗ゲージは Tutorial item 4 で、部分達成ごとに 58 / 3 ずつ減る。
    *script2() {
        this.distance = "99999";
        while (!B((compare(this.distance, "0") < 0))) {
            this.distance = (N(mathop("sqrt", (N((N((N(-550) - N(G.X))) * N((N(-550) - N(G.X))))) + N((N((N(350) - N(G.Y))) * N((N(350) - N(G.Y)))))))) - N(80));
            G.Tutorial.replace(4, (N(58) - N((N(58) / N((N(572) / N((N(572) - N(this.distance)))))))));
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        G.Tutorial.replace(4, "58");
        while (!B((compare(G.Tutorial.item(4), "1") < 0))) {
            while (!B((B((!B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())))) && B((compare(G.Inventory_2.item((N(G.Inventory) + N(3))), (N(G.Inventory_2.item((N(G.Inventory) + N(4)))) / N(2))) < 0))))) {
                if (B(equals(G.Tutorial.item(2), "10"))) {
                    return;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            yield { waitUntil: () => B((compare((N(G.Inventory_2.item((N(G.Inventory) + N(4)))) / N(2)), G.Inventory_2.item((N(G.Inventory) + N(3)))) < 0)) };
            G.Tutorial.replace(4, (N(G.Tutorial.item(4)) - N((N(58) / N(3)))));
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        while (!B((compare("1", G.Inventory_2.item(31)) < 0))) {
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        while (!B((B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())) && B((!B(equals(mod(G.Inventory_2.item((N(G.Inventory) + N(3))), G.Inventory_2.item((N(G.Inventory) + N(4)))), "0"))))))) {
            if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase()))) {
                G.Tutorial.replace(4, "29");
            }
            else {
                G.Tutorial.replace(4, "58");
            }
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        G.Inventory_2.replace((N(G.Inventory) + N(3)), (N(G.Inventory_2.item((N(G.Inventory) + N(4)))) - N(30)));
        yield* this.Next();
        while (!B(equals(G.Menu.item(17), "1"))) {
            if (B((!B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase()))))) {
                G.Tutorial.replace(4, "29");
            }
            else {
                G.Tutorial.replace(4, "58");
            }
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        while (!B((compare(G.Tutorial.item(4), "1") < 0))) {
            while (!B(equals(G.Scoping, "0"))) {
                if (B(equals(G.Tutorial.item(2), "10"))) {
                    return;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            while (!B(equals(G.Scoping, "1"))) {
                if (B(equals(G.Tutorial.item(2), "10"))) {
                    return;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            G.Tutorial.replace(4, (N(G.Tutorial.item(4)) - N((N(58) / N(3)))));
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        while (!B((compare(G.Tutorial.item(4), "1") < 0))) {
            while (!B((B((!B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())))) && B((compare(G.Inventory_2.item((N(G.Inventory) + N(3))), (N(G.Inventory_2.item((N(G.Inventory) + N(4)))) / N(2))) < 0))))) {
                if (B((!B(G.Buff_Debuff.contains("怒り"))))) {
                    if (B((compare(G.X, "400") < 0))) {
                        if (B((compare(G.Skill_point, "100") < 0))) {
                            if (B(equals(G.Not_attack, "0"))) {
                                G.Skill_point = "100";
                            }
                            else {
                                G.Skill_point = "50";
                            }
                        }
                    }
                }
                if (B(equals(G.Tutorial.item(2), "10"))) {
                    return;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            yield { waitUntil: () => B((compare((N(G.Inventory_2.item((N(G.Inventory) + N(4)))) / N(2)), G.Inventory_2.item((N(G.Inventory) + N(3)))) < 0)) };
            if (B(G.Buff_Debuff.contains("怒り"))) {
                G.Tutorial.replace(4, (N(G.Tutorial.item(4)) - N((N(58) / N(3)))));
            }
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Next();
        this.distance = "99999";
        this.hideTime = "0";
        while (!B((compare(G.Tutorial.item(4), "0") < 0))) {
            this.distance = (N(mathop("sqrt", (N((N((N(100) - N(G.X))) * N((N(100) - N(G.X))))) + N((N((N(350) - N(G.Y))) * N((N(350) - N(G.Y)))))))) - N(80));
            if (B((B((compare(this.distance, "0") < 0)) && B((compare("0", G.Hide_ghost) < 0))))) {
                this.distance = "0";
                this.hideTime = N(this.hideTime) + N(G.FPS_temp);
            }
            else {
                this.hideTime = "0";
            }
            G.Tutorial.replace(4, (N(58) - N((N((N(29) / N((N(150) / N(this.hideTime))))) + N((N(29) / N((N(520) / N((N(520) - N(this.distance)))))))))));
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        G.Menu.replace(92, "0");
        yield* this.Next();
        while (!B((compare("400", G.X) < 0))) {
            this.distance = (N(mathop("sqrt", (N((N((N(300) - N(G.X))) * N((N(300) - N(G.X))))) + N((N((N(0) - N(G.Y))) * N((N(0) - N(G.Y)))))))) - N(80));
            if (B((compare(this.distance, "0") < 0))) {
                this.distance = "0";
            }
            G.Tutorial.replace(4, (N(10) + N((N(48) - N((N(48) / N((N(273) / N((N(273) - N(this.distance)))))))))));
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // ペット解放: 最大ランク 3 / 6 / 9 / 12 到達で Pet_data のフラグを立て、
    // 作者と協力者 3 名には専用ペットを付ける。5 秒ごとに再評価する。
    *script3() {
        while (true) {
            if (B((compare("2", G.Max_rank) < 0))) {
                G.Pet_data.replace(6, "1");
            }
            if (B((compare("5", G.Max_rank) < 0))) {
                G.Pet_data.replace(16, "1");
            }
            if (B((compare("8", G.Max_rank) < 0))) {
                G.Pet_data.replace(26, "1");
            }
            if (B((compare("11", G.Max_rank) < 0))) {
                G.Pet_data.replace(36, "1");
            }
            yield* this.Creator_s_pet("uk-400");
            yield* this.Creator_s_pet("urukazu");
            yield* this.Creator_s_pet("Takomaru-s");
            yield* this.Creator_s_pet("011208tree");
            yield { waitSeconds: N(5) };
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // 離席検出: 毎秒 Leave stoper を呼び続ける。
    *script4() {
        G.Leave_timer = "0";
        G.Badge = "1";
        while (true) {
            yield* this.Leave_stoper(this.rt.mouse.x, this.rt.mouse.y, G.X, G.Y);
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // CSPID（不正疑いリスト）が溜まったら 300 秒ごとに空にする。
    *script5() {
        while (true) {
            yield { waitUntil: () => B((compare("0", G.CSPID.length) < 0)) };
            G.CSPID.deleteAll();
            G.Respawned_player.deleteAll();
            yield { waitSeconds: N(300) };
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // 未取得武器の所持チェック（Sp sear）。ロビーでは 10 秒後、戦闘中は
    // 特殊武器なしで 5 秒後に再確認し、なお該当すれば stop all する。
    *script6() {
        while (true) {
            yield* this.Sp_sear();
            if (B((B((compare(G.X, "400") < 0)) && B(equals(this.suspicious, "1"))))) {
                yield { waitSeconds: N(10) };
                yield* this.Sp_sear();
                if (B((B((compare(G.X, "400") < 0)) && B(equals(this.suspicious, "1"))))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (B((B((compare("400", G.X) < 0)) && B((B(equals(G.Special_weapon, "0")) && B(equals(this.suspicious, "1"))))))) {
                yield { waitSeconds: N(5) };
                yield* this.Sp_sear();
                if (B((B((compare("400", G.X) < 0)) && B((B(equals(G.Special_weapon, "0")) && B(equals(this.suspicious, "1"))))))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // Menu 111 の自動リセット（5 秒）。
    *script7() {
        while (true) {
            yield { waitUntil: () => B((!B(equals(G.Menu.item(111), "0000")))) };
            yield { waitSeconds: N(5) };
            G.Menu.replace(111, "0000");
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // Menu 112 の自動リセット（15 秒）。
    *script8() {
        while (true) {
            yield { waitUntil: () => B((!B(equals(G.Menu.item(112), "0")))) };
            yield { waitSeconds: N(15) };
            G.Menu.replace(112, "0");
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // 無視した招待は 30 秒で古いものから消す。
    *script9() {
        while (true) {
            yield { waitUntil: () => B((compare("0", G.Ignored_invitation.length) < 0)) };
            yield { waitSeconds: N(30) };
            G.Ignored_invitation.delete(1);
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // サーバ移動検出（5 秒で参加人数が 8 以上変動したら移動とみなす）と
    // マップ外検出: 開発者モードでなく、戦闘エリア（X > 400）にいるのに
    // マップ境界（1750 < X < 4650, -1000 < Y < 1000）の外なら stop all。
    // サーバ移動への対処（体力 1 化など）は if (false) で無効化済み。
    *script10() {
        this.prev_active = G.Active_players;
        this.server_change = "0";
        while (true) {
            yield { waitSeconds: N(5) };
            if (B((compare("7", mathop("abs", (N(G.Active_players) - N(this.prev_active)))) < 0))) {
                this.server_change = N(this.server_change) + N(1);
                if (B((compare("5", this.server_change) < 0))) {
                    if (B(false)) {
                        G.Health = "1";
                        G.Health_timer = "450";
                        if (B((compare(G.Active_players, "2") < 0))) {
                            G.Kill_counter = "0";
                        }
                    }
                }
            }
            this.prev_active = G.Active_players;
            if (B(equals(G.開発者ツール, "0"))) {
                if (B((B((compare("400", G.X) < 0)) && B((!B((B((B((compare("1750", G.X) < 0)) && B((compare(G.X, "4650") < 0)))) && B((B((compare("-1000", G.Y) < 0)) && B((compare(G.Y, "1000") < 0))))))))))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // リスポーン回数の集計。同一プレイヤーが 4 回以上で CSPID 追加の対象だが、
    // 追加自体は if (false) で無効化済み。3 秒ごとに Respawned_player を消費する。
    *script11() {
        this.respawnCounts.deleteAll();
        while (true) {
            if (B((compare("0", G.Respawned_player.length) < 0))) {
                this.respawnIndex = "0";
                const _cnt1 = Math.max(0, Math.floor(N(G.Respawned_player.length)));
                for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                    this.respawnIndex = N(this.respawnIndex) + N(1);
                    if (B(this.respawnCounts.contains(G.Respawned_player.item(this.respawnIndex)))) {
                        this.respawnCountPos = (N(this.respawnCounts.itemNum(G.Respawned_player.item(this.respawnIndex))) + N(1));
                        this.respawnCounts.replace(this.respawnCountPos, (N(this.respawnCounts.item(this.respawnCountPos)) + N(1)));
                        if (B((compare("3", this.respawnCounts.item(this.respawnCountPos)) < 0))) {
                            if (B((!B(G.CSPID.contains(G.Respawned_player.item(this.respawnIndex)))))) {
                                if (B(false)) {
                                    G.CSPID.add(G.Respawned_player.item(this.respawnIndex));
                                }
                            }
                        }
                    }
                    else {
                        this.respawnCounts.add(G.Respawned_player.item(this.respawnIndex));
                        this.respawnCounts.add("1");
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Respawned_player.deleteAll();
            }
            yield { waitSeconds: N(3) };
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // サーバ移動カウントは 600 秒でリセットする。
    *script12() {
        while (true) {
            yield { waitSeconds: N(600) };
            this.server_change = "0";
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // FPS ウォッチドッグ（script14 と対）。Menu 50 が "1" で開始し、毎フレーム
    // G.Date（絶対日数の下 2 桁）を更新する。1 秒間のフレーム数が FPS の
    // 1.2 倍を超える状態が 60 秒続いたら stop all（速度操作の検出）。
    // あわせて特殊武器所持でロビー寄り（50 < X < 400）にいたら stop all。
    *script13() {
        this.fps_stop = "0";
        this.overLimitSec = "0";
        yield { waitUntil: () => B(equals(G.Menu.item(50), "1")) };
        while (true) {
            G.Date = (S(letterOf(mathop("floor", this.rt.daysSince2000()), (N(S(mathop("floor", this.rt.daysSince2000())).length) - N(1)))) + S(letterOf(mathop("floor", this.rt.daysSince2000()), S(mathop("floor", this.rt.daysSince2000())).length)));
            this.fps_stop = N(this.fps_stop) + N(1);
            if (B((compare((N(G.FPS) * N(1.2)), this.fps_stop) < 0))) {
                this.overLimitSec = N(this.overLimitSec) + N(1);
                if (B((compare("60", this.overLimitSec) < 0))) {
                    this.rt.stopAll();
                    return;
                }
            }
            else {
                this.overLimitSec = "0";
            }
            if (B((B(equals(G.Special_weapon, "1")) && B((B((compare("50", G.X) < 0)) && B((compare(G.X, "400") < 0))))))) {
                this.rt.stopAll();
                return;
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    // script13 のフレームカウンタを毎秒リセットする。
    *script14() {
        while (true) {
            yield { waitSeconds: N(1) };
            this.fps_stop = "0";
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenbroadcastreceived (broadcast:Warp)
    // 2026-09-06（絶対日数 9745）だけ Weapon festival を発動する。
    *script15() {
        if (B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9745"))) {
            yield* this.Weapon_festival_2();
        }
    }
    // hat: event_whenflagclicked (flag)
    // 2026-09-06 に戦闘エリアへ出たら InfinityKnives として投擲用ナイフを配る。
    *script16() {
        yield { waitUntil: () => B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9745")) };
        yield { waitUntil: () => B((compare("50", G.X) < 0)) };
        G.Version_name = (S(G.Version_name) + S(" InfintyKnives"));
        G.Got_weapon.add("投擲用ナイフ");
    }
    // hat: event_whenbroadcastreceived (broadcast:Warp)
    // サバイバル中ならインベントリを退避し、武器を 2 本まで減らす。
    *script17() {
        if (B(equals(G.SURVIVAL, "1"))) {
            yield* this.Delete_weapon("Save");
            yield* this.Delete_weapon("2");
        }
    }
    // hat: event_whenflagclicked (flag)
    // サバイバル本体。2026-09-20（絶対日数 9759）に SURVIVAL を有効化し、
    // R キー（モバイルはタップ）で足元の武器と手持ちを入れ替えるループに入る。
    *script18() {
        G.SURVIVAL = "0";
        yield { waitSeconds: N(0.5) };
        yield { waitUntil: () => B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9759")) };
        G.SURVIVAL = "1";
        G.Version_name = (S(G.Version_name) + S(" Survival"));
        if (B(equals(G.SURVIVAL, "1"))) {
            while (true) {
                if (B(equals(G.Mobile, "1"))) {
                    yield { waitUntil: () => B(this.rt.mouse.down) };
                }
                if (B((B(this.rt.keyIsPressed(S("r"))) || B((B(equals(G.Mobile, "1")) && B((compare((N((N((N((N(0) - N(G.Camera_x))) - N(this.rt.mouse.x))) * N((N((N(0) - N(G.Camera_x))) - N(this.rt.mouse.x))))) + N((N((N((N(0) - N(G.Camera_y))) - N(this.rt.mouse.y))) * N((N((N(0) - N(G.Camera_y))) - N(this.rt.mouse.y)))))), "900") < 0))))))) {
                    if (B((B((compare("400", G.X) < 0)) && B((B((compare("0", G.Health) < 0)) && B((B(equals(G.Buff_effect.item(12), "0")) && B((B(equals(G.Menu.item(17), "0")) && B((B(equals(G.Menu.item(35), "0")) && B(equals(G.Menu.item(56), "0"))))))))))))) {
                        this.Temp1 = (N((N(G.Inventory_2.item(31)) - N(1))) * N(6));
                        if (B((B((!B(equals(G.Inventory_2.item((N(this.Temp1) + N(1))), "")))) || B((!B(equals(G.Menu.item(116), "-"))))))) {
                            this.rt.soundPlay("6cb83f21f9b56c4d5725c8761fdcb934.wav");
                            yield* this.Swap_item();
                            yield { waitSeconds: N(0.5) };
                            yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("r"))))) };
                        }
                    }
                }
                if (B(equals(G.Mobile, "1"))) {
                    yield { waitUntil: () => B((!B(this.rt.mouse.down))) };
                }
                if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                    yield;
            }
        }
    }
    // hat: event_whenflagclicked (flag)
    // 30 秒ごとに連射検出（Defender）を回す。
    *script19() {
        while (true) {
            yield { waitSeconds: N(30) };
            yield* this.Defender_bu01("30");
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // procedure: "Next"
    // チュートリアルのステップを 1 つ進め、クリア音を鳴らす。
    *Next() {
        this.rt.soundPlay("7babfb34bcc9dcde7707448221b55c97.wav");
        G.Tutorial.replace(1, "-58");
        G.Tutorial.replace(2, (N(G.Tutorial.item(2)) + N(1)));
        G.Tutorial.replace(3, "58");
        G.Tutorial.replace(4, "58");
    }
    // procedure: "Leave stoper %s %s %s %s"
    // 1 秒待って離席タイマーを進める。マウスが動いたらタイマーを戻し、
    // ステージ外（|x| > 240 または |y| > 180）へ出ていたら Badge を落とす。
    // タイマーが 600（= 10 分）を超えたら stop all。引数 x / y は未使用。
    *Leave_stoper(mx, my, x, y) {
        yield { waitSeconds: N(1) };
        G.Leave_timer = N(G.Leave_timer) + N(1);
        if (B((!B((B(equals(mx, this.rt.mouse.x)) && B(equals(my, this.rt.mouse.y))))))) {
            G.Leave_timer = "0";
            if (B((B((compare("240", mathop("abs", this.rt.mouse.x)) < 0)) || B((compare("180", mathop("abs", this.rt.mouse.y)) < 0))))) {
                G.Badge = "0";
            }
        }
        if (B((compare("600", G.Leave_timer) < 0))) {
            this.rt.stopAll();
            return;
        }
    }
    // procedure: "Creator's pet %s"
    // ログイン中のユーザーが指定名と一致したら、そのペットフラグ
    // （Pet_data の名前位置 + 5）を立てる。
    *Creator_s_pet(user_name) {
        if (B(equals(this.rt.username, user_name))) {
            G.Pet_data.replace((N(G.Pet_data.itemNum(user_name)) + N(5)), "1");
        }
    }
    // procedure: "Sp sear"
    // 全スロットの武器名を Got_weapon と照合し、取得していない武器があれば
    // suspicious = "1"。サバイバル中の拾得は正当なので対象外。
    *Sp_sear() {
        this.slotIndex = "1";
        this.suspicious = "0";
        const _cnt2 = Math.max(0, Math.floor(N(5)));
        for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
            if (B((!B(equals(G.Inventory_2.item(this.slotIndex), ""))))) {
                if (B((!B(G.Got_weapon.contains(G.Inventory_2.item(this.slotIndex)))))) {
                    if (B(equals(G.SURVIVAL, "0"))) {
                        this.suspicious = "1";
                    }
                }
            }
            this.slotIndex = N(this.slotIndex) + N(6);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Weapon festival" (warp)
    // 空スロットすべてに投擲用ナイフ（サブ、450 / 150）を配る。
    *Weapon_festival_2() {
        this.rt.pushWarp();
        try {
            this.slotOffset = "0";
            const _cnt3 = Math.max(0, Math.floor(N(5)));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B(equals(G.Inventory_2.item((N(this.slotOffset) + N(1))), ""))) {
                    G.Inventory_2.replace((N(this.slotOffset) + N(1)), "投擲用ナイフ");
                    G.Inventory_2.replace((N(this.slotOffset) + N(2)), "サブ");
                    G.Inventory_2.replace((N(this.slotOffset) + N(3)), "450");
                    G.Inventory_2.replace((N(this.slotOffset) + N(4)), "150");
                }
                this.slotOffset = N(this.slotOffset) + N(6);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Delete weapon %s"
    // remain = "Save": Inventory_2 の 31 項目を Temp_inventory へ退避する。
    // それ以外: 空スロットが (5 - remain) を超えるまでランダムにスロットを消し、
    // 武器を remain 本だけ残す。
    *Delete_weapon(remain) {
        if (B(equals(remain, "Save"))) {
            G.Temp_inventory.deleteAll();
            this.slotOffset = "0";
            const _cnt4 = Math.max(0, Math.floor(N(31)));
            for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                this.slotOffset = N(this.slotOffset) + N(1);
                G.Temp_inventory.add(G.Inventory_2.item(this.slotOffset));
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            while (!B((compare((N(4) - N(remain)), (N(equals(G.Inventory_2.item(1), "")) + N((N(equals(G.Inventory_2.item(7), "")) + N((N(equals(G.Inventory_2.item(13), "")) + N((N(equals(G.Inventory_2.item(19), "")) + N(equals(G.Inventory_2.item(25), "")))))))))) < 0))) {
                this.slotOffset = (N(random(0, 4)) * N(6));
                G.Inventory_2.replace((N(this.slotOffset) + N(1)), "");
                G.Inventory_2.replace((N(this.slotOffset) + N(2)), "");
                G.Inventory_2.replace((N(this.slotOffset) + N(3)), "0");
                G.Inventory_2.replace((N(this.slotOffset) + N(4)), "0");
                G.Inventory_2.replace((N(this.slotOffset) + N(5)), "0");
                G.Inventory_2.replace((N(this.slotOffset) + N(6)), "0");
                if (!this.rt.warpActive)
                    yield;
            }
        }
    }
    // procedure: "Set inventory %s %s"
    // 武器名から Item_list の性能を引き、スロット（基準 num、6 フィールド）を構築する。
    // 種別にオーバーヒートを含む場合はフィールド 3（残弾カウンタ）を -1 から始める。
    *Set_inventory(num, wepon_name) {
        this.Temp1 = G.Weapon.item(G.Weapon_name.itemNum(wepon_name));
        G.Inventory_2.replace((N(num) + N(1)), wepon_name);
        this.Temp2 = G.Item_list.item((N(this.Temp1) + N(1)));
        G.Inventory_2.replace((N(num) + N(2)), this.Temp2);
        this.Temp3 = G.Item_list.item((N(this.Temp1) + N(2)));
        if (B(S(this.Temp2).toLowerCase().includes(S("オーバーヒート").toLowerCase()))) {
            G.Inventory_2.replace((N(num) + N(3)), "-1");
        }
        else {
            G.Inventory_2.replace((N(num) + N(3)), "0");
        }
        G.Inventory_2.replace((N(num) + N(4)), this.Temp3);
        G.Inventory_2.replace((N(num) + N(5)), "0");
        G.Inventory_2.replace((N(num) + N(6)), "0");
    }
    // procedure: "Drop item"
    // Temp1 のスロットの武器を地面へ落とす。ドロップは My_shot へ
    // "7" + ランダム 3 桁 + (武器番号 + 100) のコードで登録する。
    *Drop_item() {
        if (B((!B(equals(G.Inventory_2.item((N(this.Temp1) + N(1))), ""))))) {
            G.My_shot.add((S("7") + S((S(random(0, 9)) + S((S(random(0, 9)) + S((S(random(0, 9)) + S((N(G.Weapon_name.itemNum(G.Inventory_2.item((N(this.Temp1) + N(1))))) + N(100)))))))))));
            G.Inventory_2.replace((N(this.Temp1) + N(1)), "");
            G.Inventory_2.replace((N(this.Temp1) + N(2)), "");
            G.Inventory_2.replace((N(this.Temp1) + N(3)), "0");
            G.Inventory_2.replace((N(this.Temp1) + N(4)), "0");
            G.Inventory_2.replace((N(this.Temp1) + N(5)), "0");
            G.Inventory_2.replace((N(this.Temp1) + N(6)), "0");
        }
    }
    // procedure: "Swap item" (warp)
    // 足元に武器がない（Menu 116 = "-")なら手持ちを落とすだけ。
    // ある場合は拾得を My_shot へ登録し、対象スロットが空ならそこへ、
    // 埋まっていれば最初の空スロットへ Set_inventory する。
    // 空きがなければ手持ちを落としてから対象スロットへ入れる。
    // （if (false) の直接セットは作者が無効化した旧経路。）
    *Swap_item() {
        this.rt.pushWarp();
        try {
            if (B(equals(G.Menu.item(116), "-"))) {
                yield* this.Drop_item();
            }
            else {
                G.My_shot.add((S("7") + S((S(G.Bullet_and_effect.item((N(G.Menu.item(116)) + N(6)))) + S("999")))));
                if (B(false)) {
                    yield* this.Set_inventory(this.Temp1, G.Weapon_name.item(G.Bullet_and_effect.item((N(G.Menu.item(116)) + N(7)))));
                }
                else {
                    if (B(equals(G.Inventory_2.item((N(this.Temp1) + N(1))), ""))) {
                        yield* this.Set_inventory(this.Temp1, G.Weapon_name.item(G.Bullet_and_effect.item((N(G.Menu.item(116)) + N(7)))));
                    }
                    else {
                        this.Temp2 = "0";
                        this.Temp3 = "-";
                        const _cnt5 = Math.max(0, Math.floor(N(5)));
                        for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                            if (B(equals(this.Temp3, "-"))) {
                                if (B(equals(G.Inventory_2.item((N(this.Temp2) + N(1))), ""))) {
                                    this.Temp3 = this.Temp2;
                                    yield* this.Set_inventory(this.Temp3, G.Weapon_name.item(G.Bullet_and_effect.item((N(G.Menu.item(116)) + N(7)))));
                                }
                                this.Temp2 = N(this.Temp2) + N(6);
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B(equals(this.Temp3, "-"))) {
                            yield* this.Drop_item();
                            yield* this.Set_inventory(this.Temp1, G.Weapon_name.item(G.Bullet_and_effect.item((N(G.Menu.item(116)) + N(7)))));
                        }
                    }
                }
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Defender_bu01 %s" (warp)
    // 連射検出。G.BU（発射ログ [プレイヤー, ?, アイテム] の 3 つ組）を先頭から処理し、
    // 同一プレイヤー + 同一アイテムの重複数を数える。想定間隔は Item_list から引き、
    // 除外キーワードを含む武器・"weapon"（間隔 15）・サブで性能値 1 超は対象外。
    // 頻度が (30 / 間隔) * 2.5 を超えたら CSPID 追加の対象だが、追加は
    // if (false) で無効化済み。処理したエントリは BU から消える。
    *Defender_bu01(time) {
        this.rt.pushWarp();
        try {
            while (!B(equals(G.BU.length, "0"))) {
                this.defKey = (S(G.BU.item(1)) + S(G.BU.item(3)));
                this.defInterval = G.BU.item(3);
                if (B((B(S(G.Item_list.item((N(this.defInterval) + N(1)))).toLowerCase().includes(S(this.exemptKeywords.item(1)).toLowerCase())) || B((B(S(G.Item_list.item((N(this.defInterval) + N(1)))).toLowerCase().includes(S(this.exemptKeywords.item(2)).toLowerCase())) || B(S(G.Item_list.item((N(this.defInterval) + N(1)))).toLowerCase().includes(S(this.exemptKeywords.item(3)).toLowerCase()))))))) {
                    this.defInterval = "-";
                }
                else {
                    if (B(equals(G.BU.item(3), "weapon"))) {
                        this.defInterval = "15";
                    }
                    else {
                        if (B((B(equals(G.Item_list.item((N(this.defInterval) + N(1))), "サブ")) && B((compare(G.Item_list.item((N(this.defInterval) + N(4))), "1") > 0))))) {
                            this.defInterval = "-";
                        }
                        else {
                            this.defInterval = G.Item_list.item((N(this.defInterval) + N(2)));
                        }
                    }
                }
                this.defScan = "3";
                this.defCount = "1";
                const _cnt6 = Math.max(0, Math.floor(N((N(G.BU.length) / N(3)))));
                for (let _rep6 = 0; _rep6 < _cnt6; _rep6++) {
                    if (B(equals((S(G.BU.item((N(this.defScan) + N(1)))) + S(G.BU.item((N(this.defScan) + N(3))))), this.defKey))) {
                        this.defCount = N(this.defCount) + N(1);
                        const _cnt7 = Math.max(0, Math.floor(N(3)));
                        for (let _rep7 = 0; _rep7 < _cnt7; _rep7++) {
                            G.BU.delete((N(this.defScan) + N(1)));
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        this.defScan = N(this.defScan) + N(3);
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B((!B(equals(this.defInterval, "-"))))) {
                    if (B((compare((N((N(30) / N(this.defInterval))) * N(2.5)), (N(this.defCount) / N(time))) < 0))) {
                        if (B((!B(equals(G.ID, G.BU.item(1)))))) {
                            if (B(false)) {
                                G.CSPID.add(G.BU.item(1));
                                G.CSPID.add(G.BU.item(2));
                            }
                        }
                    }
                }
                const _cnt8 = Math.max(0, Math.floor(N(3)));
                for (let _rep8 = 0; _rep8 < _cnt8; _rep8++) {
                    G.BU.delete(1);
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
