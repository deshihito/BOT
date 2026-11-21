// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: Tutorial/Others
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop, letterOf } from "../runtime/cast.js";
import { G } from "./globals.js";
// var: "server change" -> this.server_change
// var: "Weapon festival" -> this.Weapon_festival
// list: "Server changer" -> this.Server_changer
// list: "item copy" -> this.item_copy
export class Tutorial_Others extends Sprite {
    a = 571.9202405202649;
    b = 0;
    c = 25;
    d = 0;
    detect_change1 = 1;
    detect_change2 = 2;
    prev_active = 1;
    server_change = 0;
    fps_stop = 5;
    fs_counter = 0;
    Weapon_festival = 0;
    Temp1 = 0;
    Temp2 = 12;
    Temp3 = 6;
    defender_a = 0;
    defender_b = 0;
    defender_c = 0;
    defender_d = 0;
    Server_changer = new SList([]);
    item_copy = new SList(["オーバーヒート", "バースト", "二丁拳銃"]);
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
            case "a": return this.a;
            case "b": return this.b;
            case "c": return this.c;
            case "d": return this.d;
            case "detect_change1": return this.detect_change1;
            case "detect_change2": return this.detect_change2;
            case "prev_active": return this.prev_active;
            case "server change": return this.server_change;
            case "fps_stop": return this.fps_stop;
            case "fs_counter": return this.fs_counter;
            case "Weapon festival": return this.Weapon_festival;
            case "Temp1": return this.Temp1;
            case "Temp2": return this.Temp2;
            case "Temp3": return this.Temp3;
            case "defender_a": return this.defender_a;
            case "defender_b": return this.defender_b;
            case "defender_c": return this.defender_c;
            case "defender_d": return this.defender_d;
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
    *script2() {
        this.a = "99999";
        while (!B((compare(this.a, "0") < 0))) {
            this.a = (N(mathop("sqrt", (N((N((N(-550) - N(G.X))) * N((N(-550) - N(G.X))))) + N((N((N(350) - N(G.Y))) * N((N(350) - N(G.Y)))))))) - N(80));
            G.Tutorial.replace(4, (N(58) - N((N(58) / N((N(572) / N((N(572) - N(this.a)))))))));
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
        this.a = "99999";
        this.b = "0";
        while (!B((compare(G.Tutorial.item(4), "0") < 0))) {
            this.a = (N(mathop("sqrt", (N((N((N(100) - N(G.X))) * N((N(100) - N(G.X))))) + N((N((N(350) - N(G.Y))) * N((N(350) - N(G.Y)))))))) - N(80));
            if (B((B((compare(this.a, "0") < 0)) && B((compare("0", G.Hide_ghost) < 0))))) {
                this.a = "0";
                this.b = N(this.b) + N(G.FPS_temp);
            }
            else {
                this.b = "0";
            }
            G.Tutorial.replace(4, (N(58) - N((N((N(29) / N((N(150) / N(this.b))))) + N((N(29) / N((N(520) / N((N(520) - N(this.a)))))))))));
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
        G.Menu.replace(92, "0");
        yield* this.Next();
        while (!B((compare("400", G.X) < 0))) {
            this.a = (N(mathop("sqrt", (N((N((N(300) - N(G.X))) * N((N(300) - N(G.X))))) + N((N((N(0) - N(G.Y))) * N((N(0) - N(G.Y)))))))) - N(80));
            if (B((compare(this.a, "0") < 0))) {
                this.a = "0";
            }
            G.Tutorial.replace(4, (N(10) + N((N(48) - N((N(48) / N((N(273) / N((N(273) - N(this.a)))))))))));
            if (B(equals(G.Tutorial.item(2), "10"))) {
                return;
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
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
    *script6() {
        while (true) {
            yield* this.Sp_sear();
            if (B((B((compare(G.X, "400") < 0)) && B(equals(this.d, "1"))))) {
                yield { waitSeconds: N(10) };
                yield* this.Sp_sear();
                if (B((B((compare(G.X, "400") < 0)) && B(equals(this.d, "1"))))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (B((B((compare("400", G.X) < 0)) && B((B(equals(G.Special_weapon, "0")) && B(equals(this.d, "1"))))))) {
                yield { waitSeconds: N(5) };
                yield* this.Sp_sear();
                if (B((B((compare("400", G.X) < 0)) && B((B(equals(G.Special_weapon, "0")) && B(equals(this.d, "1"))))))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
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
    *script11() {
        this.Server_changer.deleteAll();
        while (true) {
            if (B((compare("0", G.Respawned_player.length) < 0))) {
                this.detect_change1 = "0";
                const _cnt1 = Math.max(0, Math.floor(N(G.Respawned_player.length)));
                for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                    this.detect_change1 = N(this.detect_change1) + N(1);
                    if (B(this.Server_changer.contains(G.Respawned_player.item(this.detect_change1)))) {
                        this.detect_change2 = (N(this.Server_changer.itemNum(G.Respawned_player.item(this.detect_change1))) + N(1));
                        this.Server_changer.replace(this.detect_change2, (N(this.Server_changer.item(this.detect_change2)) + N(1)));
                        if (B((compare("3", this.Server_changer.item(this.detect_change2)) < 0))) {
                            if (B((!B(G.CSPID.contains(G.Respawned_player.item(this.detect_change1)))))) {
                                if (B(false)) {
                                    G.CSPID.add(G.Respawned_player.item(this.detect_change1));
                                }
                            }
                        }
                    }
                    else {
                        this.Server_changer.add(G.Respawned_player.item(this.detect_change1));
                        this.Server_changer.add("1");
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
    *script12() {
        while (true) {
            yield { waitSeconds: N(600) };
            this.server_change = "0";
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script13() {
        this.fps_stop = "0";
        this.fs_counter = "0";
        yield { waitUntil: () => B(equals(G.Menu.item(50), "1")) };
        while (true) {
            G.Date = (S(letterOf(mathop("floor", this.rt.daysSince2000()), (N(S(mathop("floor", this.rt.daysSince2000())).length) - N(1)))) + S(letterOf(mathop("floor", this.rt.daysSince2000()), S(mathop("floor", this.rt.daysSince2000())).length)));
            this.fps_stop = N(this.fps_stop) + N(1);
            if (B((compare((N(G.FPS) * N(1.2)), this.fps_stop) < 0))) {
                this.fs_counter = N(this.fs_counter) + N(1);
                if (B((compare("60", this.fs_counter) < 0))) {
                    this.rt.stopAll();
                    return;
                }
            }
            else {
                this.fs_counter = "0";
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
    *script14() {
        while (true) {
            yield { waitSeconds: N(1) };
            this.fps_stop = "0";
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenbroadcastreceived (broadcast:Warp)
    *script15() {
        if (B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9745"))) {
            yield* this.Weapon_festival_2();
        }
    }
    // hat: event_whenflagclicked (flag)
    *script16() {
        yield { waitUntil: () => B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9745")) };
        yield { waitUntil: () => B((compare("50", G.X) < 0)) };
        G.Version_name = (S(G.Version_name) + S(" InfintyKnives"));
        G.Got_weapon.add("投擲用ナイフ");
    }
    // hat: event_whenbroadcastreceived (broadcast:Warp)
    *script17() {
        if (B(equals(G.SURVIVAL, "1"))) {
            yield* this.Delete_weapon("Save");
            yield* this.Delete_weapon("2");
        }
    }
    // hat: event_whenflagclicked (flag)
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
    *script19() {
        while (true) {
            yield { waitSeconds: N(30) };
            yield* this.Defender_bu01("30");
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // procedure: "Next"
    *Next() {
        this.rt.soundPlay("7babfb34bcc9dcde7707448221b55c97.wav");
        G.Tutorial.replace(1, "-58");
        G.Tutorial.replace(2, (N(G.Tutorial.item(2)) + N(1)));
        G.Tutorial.replace(3, "58");
        G.Tutorial.replace(4, "58");
    }
    // procedure: "Leave stoper %s %s %s %s"
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
    *Creator_s_pet(user_name) {
        if (B(equals(this.rt.username, user_name))) {
            G.Pet_data.replace((N(G.Pet_data.itemNum(user_name)) + N(5)), "1");
        }
    }
    // procedure: "Sp sear"
    *Sp_sear() {
        this.c = "1";
        this.d = "0";
        const _cnt2 = Math.max(0, Math.floor(N(5)));
        for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
            if (B((!B(equals(G.Inventory_2.item(this.c), ""))))) {
                if (B((!B(G.Got_weapon.contains(G.Inventory_2.item(this.c)))))) {
                    if (B(equals(G.SURVIVAL, "0"))) {
                        this.d = "1";
                    }
                }
            }
            this.c = N(this.c) + N(6);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Weapon festival" (warp)
    *Weapon_festival_2() {
        this.rt.pushWarp();
        try {
            this.Weapon_festival = "0";
            const _cnt3 = Math.max(0, Math.floor(N(5)));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B(equals(G.Inventory_2.item((N(this.Weapon_festival) + N(1))), ""))) {
                    G.Inventory_2.replace((N(this.Weapon_festival) + N(1)), "投擲用ナイフ");
                    G.Inventory_2.replace((N(this.Weapon_festival) + N(2)), "サブ");
                    G.Inventory_2.replace((N(this.Weapon_festival) + N(3)), "450");
                    G.Inventory_2.replace((N(this.Weapon_festival) + N(4)), "150");
                }
                this.Weapon_festival = N(this.Weapon_festival) + N(6);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Delete weapon %s"
    *Delete_weapon(remain) {
        if (B(equals(remain, "Save"))) {
            G.Temp_inventory.deleteAll();
            this.Weapon_festival = "0";
            const _cnt4 = Math.max(0, Math.floor(N(31)));
            for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                this.Weapon_festival = N(this.Weapon_festival) + N(1);
                G.Temp_inventory.add(G.Inventory_2.item(this.Weapon_festival));
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            while (!B((compare((N(4) - N(remain)), (N(equals(G.Inventory_2.item(1), "")) + N((N(equals(G.Inventory_2.item(7), "")) + N((N(equals(G.Inventory_2.item(13), "")) + N((N(equals(G.Inventory_2.item(19), "")) + N(equals(G.Inventory_2.item(25), "")))))))))) < 0))) {
                this.Weapon_festival = (N(random(0, 4)) * N(6));
                G.Inventory_2.replace((N(this.Weapon_festival) + N(1)), "");
                G.Inventory_2.replace((N(this.Weapon_festival) + N(2)), "");
                G.Inventory_2.replace((N(this.Weapon_festival) + N(3)), "0");
                G.Inventory_2.replace((N(this.Weapon_festival) + N(4)), "0");
                G.Inventory_2.replace((N(this.Weapon_festival) + N(5)), "0");
                G.Inventory_2.replace((N(this.Weapon_festival) + N(6)), "0");
                if (!this.rt.warpActive)
                    yield;
            }
        }
    }
    // procedure: "Set inventory %s %s"
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
    *Defender_bu01(time) {
        this.rt.pushWarp();
        try {
            while (!B(equals(G.BU.length, "0"))) {
                this.defender_b = (S(G.BU.item(1)) + S(G.BU.item(3)));
                this.defender_c = G.BU.item(3);
                if (B((B(S(G.Item_list.item((N(this.defender_c) + N(1)))).toLowerCase().includes(S(this.item_copy.item(1)).toLowerCase())) || B((B(S(G.Item_list.item((N(this.defender_c) + N(1)))).toLowerCase().includes(S(this.item_copy.item(2)).toLowerCase())) || B(S(G.Item_list.item((N(this.defender_c) + N(1)))).toLowerCase().includes(S(this.item_copy.item(3)).toLowerCase()))))))) {
                    this.defender_c = "-";
                }
                else {
                    if (B(equals(G.BU.item(3), "weapon"))) {
                        this.defender_c = "15";
                    }
                    else {
                        if (B((B(equals(G.Item_list.item((N(this.defender_c) + N(1))), "サブ")) && B((compare(G.Item_list.item((N(this.defender_c) + N(4))), "1") > 0))))) {
                            this.defender_c = "-";
                        }
                        else {
                            this.defender_c = G.Item_list.item((N(this.defender_c) + N(2)));
                        }
                    }
                }
                this.defender_a = "3";
                this.defender_d = "1";
                const _cnt6 = Math.max(0, Math.floor(N((N(G.BU.length) / N(3)))));
                for (let _rep6 = 0; _rep6 < _cnt6; _rep6++) {
                    if (B(equals((S(G.BU.item((N(this.defender_a) + N(1)))) + S(G.BU.item((N(this.defender_a) + N(3))))), this.defender_b))) {
                        this.defender_d = N(this.defender_d) + N(1);
                        const _cnt7 = Math.max(0, Math.floor(N(3)));
                        for (let _rep7 = 0; _rep7 < _cnt7; _rep7++) {
                            G.BU.delete((N(this.defender_a) + N(1)));
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        this.defender_a = N(this.defender_a) + N(3);
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B((!B(equals(this.defender_c, "-"))))) {
                    if (B((compare((N((N(30) / N(this.defender_c))) * N(2.5)), (N(this.defender_d) / N(time))) < 0))) {
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
