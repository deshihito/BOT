// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: TEAMMODE
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop, letterOf } from "../runtime/cast.js";
import { G } from "./globals.js";
// var: "world temp" -> this.world_temp
// var: "Score dif" -> this.Score_dif
export class TEAMMODE extends Sprite {
    Phase = 0;
    process_a = 59;
    process_b = 6;
    process_c = 0;
    player_reload = 1;
    a = 0;
    b = 0;
    world_temp = 0;
    Score_dif = 0;
    dif_count = 0;
    MVPcount = new SList([]);
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
            case "process_a": return this.process_a;
            case "process_b": return this.process_b;
            case "process_c": return this.process_c;
            case "player_reload": return this.player_reload;
            case "a": return this.a;
            case "b": return this.b;
            case "world temp": return this.world_temp;
            case "Score dif": return this.Score_dif;
            case "dif_count": return this.dif_count;
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
        yield { waitUntil: () => B((B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9697")) || B(equals(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9584")))) };
        G.Version_name = (S(G.Version_name) + S(" Team"));
        G.TEAMMODE = "1";
        this.player_reload = "0";
        yield { waitUntil: () => B(equals(this.player_reload, "1")) };
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
            if (B((compare((N(this.world_temp) + N(120)), (N(this.rt.daysSince2000()) * N(86400))) < 0))) {
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
            this.world_temp = (N(this.rt.daysSince2000()) * N(86400));
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
    *Process_players() {
        this.rt.pushWarp();
        try {
            this.player_reload = "1";
            this.process_a = "0";
            this.process_c = "0";
            this.Score_dif = "-";
            this.dif_count = "0";
            G.TEAMMODE_2.replace(1, "0");
            G.TEAMMODE_2.replace(2, "0");
            this.MVP.deleteAll();
            const _cnt3 = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B((!B(equals(G.CLOUD.item((N(this.process_a) + N(1))), ""))))) {
                    if (B((compare("400", G.CLOUD.item((N(this.process_a) + N(3)))) < 0))) {
                        this.Score_dif = N(this.Score_dif) + N(G.CLOUD.item((N(this.process_a) + N(61))));
                        this.dif_count = N(this.dif_count) + N(1);
                    }
                    this.process_b = letterOf(G.CLOUD.item((N(this.process_a) + N(12))), 1);
                    if (B((B(equals(G.Team_ID, G.ID)) || B(equals(G.TEAMMODE_2.item(5), "0"))))) {
                        if (B(equals(this.process_b, "1"))) {
                            G.TEAMMODE_2.replace(1, (N(G.TEAMMODE_2.item(1)) + N(1)));
                        }
                        if (B(equals(this.process_b, "2"))) {
                            G.TEAMMODE_2.replace(2, (N(G.TEAMMODE_2.item(2)) + N(1)));
                        }
                    }
                    else {
                        if (B(equals(letterOf(G.Team_ID, 1), this.process_b))) {
                            G.TEAMMODE_2.replace(1, (N(G.TEAMMODE_2.item(1)) + N(1)));
                        }
                        else {
                            G.TEAMMODE_2.replace(2, (N(G.TEAMMODE_2.item(2)) + N(1)));
                        }
                    }
                    if (B((B((compare(mathop("abs", (N(G.CLOUD.item((N(this.process_a) + N(3)))) - N(G.TEAMMODE_2.item(10)))), (N(G.TEAMMODE_2.item(12)) / N(2))) < 0)) && B((compare(mathop("abs", (N(G.CLOUD.item((N(this.process_a) + N(4)))) - N(G.TEAMMODE_2.item(11)))), (N(G.TEAMMODE_2.item(13)) / N(2))) < 0))))) {
                        G.MVPpoint.add(G.CLOUD.item((N(this.process_a) + N(1))));
                        G.MVPpoint.add(G.TEAMMODE_2.item(14));
                        if (B(equals(this.process_b, "1"))) {
                            this.process_c = N(this.process_c) + N(1);
                        }
                        else {
                            this.process_c = N(this.process_c) + N(-1);
                        }
                    }
                    this.process_b = G.CLOUD.item((N(this.process_a) + N(60)));
                    if (B(this.MVP.contains(this.process_b))) {
                        this.process_b = (N(this.MVP.itemNum(this.process_b)) + N(1));
                        this.MVP.replace(this.process_b, (N(this.MVP.item(this.process_b)) + N(1)));
                    }
                    else {
                        this.MVP.add(this.process_b);
                        this.MVP.add("1");
                    }
                }
                this.process_a = N(this.process_a) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            if (B(equals(G.TEAMMODE_2.item(5), "1"))) {
                if (B((compare("5", this.process_c) < 0))) {
                    this.process_c = "5";
                }
                if (B((compare(this.process_c, "-5") < 0))) {
                    this.process_c = "-5";
                }
                if (B((compare("0", this.process_c) < 0))) {
                    G.TEAMMODE_2.replace(3, (N(G.TEAMMODE_2.item(3)) + N((N(this.process_c) * N(G.TEAMMODE_2.item(14))))));
                }
                if (B((compare(this.process_c, "0") < 0))) {
                    G.TEAMMODE_2.replace(4, (N(G.TEAMMODE_2.item(4)) + N(mathop("abs", (N(this.process_c) * N(G.TEAMMODE_2.item(14)))))));
                }
            }
            this.Score_dif = (N(this.Score_dif) / N(this.dif_count));
            if (B((compare(mathop("abs", this.Score_dif), "300") < 0))) {
                if (B((compare("200", mathop("abs", (N(this.Score_dif) - N((N(G.TEAMMODE_2.item(3)) - N(G.TEAMMODE_2.item(4))))))) < 0))) {
                    if (B((compare("3", this.dif_count) < 0))) {
                        yield* this.Team_score_modify();
                    }
                }
            }
            this.process_a = "1";
            const _cnt4 = Math.max(0, Math.floor(N((N(G.MVPpoint.length) / N(2)))));
            for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                if (B(equals(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.MVPpoint.item(this.process_a)))) + N(11))), G.Team_ID))) {
                    this.process_b = (S("#") + S(G.MVPpoint.item(this.process_a)));
                    if (B(this.MVPcount.contains(this.process_b))) {
                        this.process_b = (N(this.MVPcount.itemNum(this.process_b)) + N(1));
                        this.MVPcount.replace(this.process_b, (N(this.MVPcount.item(this.process_b)) + N(G.MVPpoint.item((N(this.process_a) + N(1))))));
                    }
                    else {
                        this.MVPcount.add(this.process_b);
                        this.MVPcount.add(G.MVPpoint.item((N(this.process_a) + N(1))));
                    }
                }
                this.process_a = N(this.process_a) + N(2);
                if (!this.rt.warpActive)
                    yield;
            }
            G.MVPpoint.deleteAll();
            this.process_a = "1";
            this.process_b = "0";
            const _cnt5 = Math.max(0, Math.floor(N((N(this.MVPcount.length) / N(2)))));
            for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                if (B((compare(this.process_b, this.MVPcount.item((N(this.process_a) + N(1)))) < 0))) {
                    this.process_b = this.MVPcount.item((N(this.process_a) + N(1)));
                    this.process_c = this.MVPcount.item(this.process_a);
                }
                this.process_a = N(this.process_a) + N(2);
                if (!this.rt.warpActive)
                    yield;
            }
            G.TEAMMODE_2.replace(17, (S(letterOf(this.process_c, 2)) + S((S(letterOf(this.process_c, 3)) + S((S(letterOf(this.process_c, 4)) + S(letterOf(this.process_c, 5))))))));
            yield* this.MVP_2("1");
            yield* this.MVP_2("2");
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Result"
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
    *Battle() {
        while (!B((compare(this.Phase, "2") < 0))) {
            G.TEAMMODE_2.replace(5, "1");
            this.a = (N((N(8) - N((N(mod((N(this.rt.daysSince2000()) * N(1440)), 10)) - N(2))))) * N(60));
            this.b = mathop("floor", (N(this.a) - N((N(mathop("floor", (N(this.a) / N(60)))) * N(60)))));
            if (B(equals(S(this.b).length, "1"))) {
                this.b = (S("0") + S(this.b));
            }
            G.TEAMMODE_2.replace(7, (S(mathop("floor", (N(this.a) / N(60)))) + S((S(":") + S(this.b)))));
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
    *MVP_2(team) {
        this.process_a = "1";
        this.process_b = "0";
        const _cnt9 = Math.max(0, Math.floor(N((N(this.MVP.length) / N(2)))));
        for (let _rep9 = 0; _rep9 < _cnt9; _rep9++) {
            if (B((B(equals(letterOf(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.MVP.item(this.process_a)))) + N(11))), 1), team)) && B((compare(this.process_b, this.MVP.item((N(this.process_a) + N(1)))) < 0))))) {
                this.process_b = this.MVP.item((N(this.process_a) + N(1)));
                this.process_c = this.MVP.item(this.process_a);
            }
            this.process_a = N(this.process_a) + N(2);
            if (!this.rt.warpActive)
                yield;
        }
        G.TEAMMODE_2.replace((N(17) + N(team)), G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.process_c))) + N((N(G.Number_of_data) - N(1))))));
    }
}
