// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: Combat rating
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, mathop } from "../runtime/cast.js";
import { G } from "./globals.js";
// var: "estimate CP" -> this.estimate_CP
// var: "prev CP" -> this.prev_CP
// var: "score p" -> this.score_p
// var: "score n" -> this.score_n
export class Combat_rating extends Sprite {
    a = 0;
    b = 0.8854961832061069;
    c = 0;
    OCP = 100;
    ECP = 120;
    type = "Hit";
    estimate_CP = 0;
    survive = 0;
    prev_CP = 0;
    score_p = 0;
    score_n = 0;
    time = 0;
    temp = new SList([]);
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
            case "a": return this.a;
            case "b": return this.b;
            case "c": return this.c;
            case "OCP": return this.OCP;
            case "ECP": return this.ECP;
            case "type": return this.type;
            case "estimate CP": return this.estimate_CP;
            case "survive": return this.survive;
            case "prev CP": return this.prev_CP;
            case "score p": return this.score_p;
            case "score n": return this.score_n;
            case "time": return this.time;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script1());
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script2());
    }
    // hat: event_whenbroadcastreceived (broadcast:Hide title)
    *script1() {
        G.Combat_Power = "100";
        this.prev_CP = "100";
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
            this.score_p = "0";
            this.score_n = "0";
            while (!B((compare(G.X, "400") < 0))) {
                yield { waitSeconds: N(1) };
                yield* this.Rate();
                yield* this.Ranking();
                if (!this.rt.warpActive)
                    yield;
            }
            if (B((compare("1800", this.time) < 0))) {
                this.score_p = N(this.score_p) + N(mathop("10 ^", (N(mathop("log", this.survive)) * N(1))));
                G.Combat_Power = (N((N((N((N((N((N(this.score_p) - N(this.score_n))) / N((N(this.time) / N(30))))) + N(100))) * N(3))) + N(this.prev_CP))) / N(4));
                this.prev_CP = G.Combat_Power;
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
    // hat: event_whenbroadcastreceived (broadcast:Hide title)
    *script2() {
        /* モニター表示の切替のみ: 実行時は何もしない */
        /* モニター表示の切替のみ: 実行時は何もしない */
        while (true) {
            yield { waitUntil: () => B(this.rt.keyIsPressed(S("k"))) };
            yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("k"))))) };
            /* モニター表示の切替のみ: 実行時は何もしない */
            /* モニター表示の切替のみ: 実行時は何もしない */
            yield { waitUntil: () => B(this.rt.keyIsPressed(S("k"))) };
            yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("k"))))) };
            /* モニター表示の切替のみ: 実行時は何もしない */
            /* モニター表示の切替のみ: 実行時は何もしない */
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // procedure: "Rate" (warp)
    *Rate() {
        this.rt.pushWarp();
        try {
            this.a = "0";
            const _cnt1 = Math.max(0, Math.floor(N((N(G.Combat_data.length) / N(7)))));
            for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                this.type = G.Combat_data.item((N(this.a) + N(1)));
                if (B((!B((B(equals(this.type, "Run")) || B(equals(this.type, "Back"))))))) {
                    if (B((!B(equals(G.Combat_data.item((N(this.a) + N(5))), ""))))) {
                        this.ECP = G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Combat_data.item((N(this.a) + N(5)))))) + N(58)));
                        if (B(equals(this.ECP, "0"))) {
                            this.ECP = "100";
                        }
                        if (B(equals(G.Combat_data.item((N(this.a) + N(7))), "1"))) {
                            this.ECP = (N(this.ECP) * N(1.8));
                        }
                    }
                    if (B(equals(G.Combat_data.item((N(this.a) + N(6))), "1"))) {
                        this.estimate_CP = (N(G.Combat_Power) * N(1.8));
                    }
                    else {
                        this.estimate_CP = G.Combat_Power;
                    }
                    if (B((compare(this.estimate_CP, "50") < 0))) {
                        this.estimate_CP = "50";
                    }
                    this.OCP = (N(mathop("floor", (N(G.Combat_data.item((N(this.a) + N(2)))) / N(10000)))) * N(100));
                    this.OCP = N(this.OCP) + N(mod(G.Combat_data.item((N(this.a) + N(2))), 10000));
                    this.survive = N(this.survive) + N((N((N((N(G.Combat_data.item((N(this.a) + N(3)))) / N(30))) * N((N(1) + N((N((N((N(this.OCP) / N(this.estimate_CP))) - N(1))) * N(0.2))))))) * N(3)));
                    this.time = N(this.time) + N(G.Combat_data.item((N(this.a) + N(3))));
                    this.b = (N((N((N(this.ECP) * N(0.8))) + N((N(this.OCP) * N(0.2))))) / N(this.estimate_CP));
                    if (B(equals(G.Combat_data.item((N(this.a) + N(6))), "1"))) {
                        this.ECP = (N(this.b) / N(3));
                    }
                    if (B(equals(this.type, "Hit"))) {
                        this.score_p = N(this.score_p) + N((N((N(G.Combat_data.item((N(this.a) + N(4)))) * N(this.b))) * N(5)));
                    }
                    if (B(equals(this.type, "Kill"))) {
                        this.score_p = N(this.score_p) + N((N((N(50) * N(this.b))) * N(10)));
                    }
                    if (B(equals(this.type, "Damage"))) {
                        this.score_n = N(this.score_n) + N((N((N(G.Combat_data.item((N(this.a) + N(4)))) / N(this.b))) * N(5)));
                    }
                    if (B(equals(this.type, "Death"))) {
                        this.score_n = N(this.score_n) + N((N((N(50) / N(this.b))) * N(10)));
                    }
                }
                this.a = N(this.a) + N(7);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Combat_data.deleteAll();
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Ranking" (warp)
    *Ranking() {
        this.rt.pushWarp();
        try {
            this.a = "0";
            this.temp.deleteAll();
            const _cnt2 = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
            for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                if (B((!B(equals(G.CLOUD.item((N(this.a) + N(1))), ""))))) {
                    this.temp.add(G.CLOUD.item((N(this.a) + N(G.Number_of_data))));
                    this.temp.add(G.CLOUD.item((N(this.a) + N(59))));
                }
                this.a = N(this.a) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Ranking.deleteAll();
            const _cnt3 = Math.max(0, Math.floor(N((N(this.temp.length) / N(2)))));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                this.a = "0";
                this.b = "0";
                this.c = "0";
                const _cnt4 = Math.max(0, Math.floor(N((N(this.temp.length) / N(2)))));
                for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                    if (B((compare(this.b, this.temp.item((N(this.a) + N(2)))) < 0))) {
                        this.b = this.temp.item((N(this.a) + N(2)));
                        this.c = this.a;
                    }
                    this.a = N(this.a) + N(2);
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Ranking.add(this.temp.item((N(this.c) + N(1))));
                G.Ranking.add(this.b);
                const _cnt5 = Math.max(0, Math.floor(N(2)));
                for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                    this.temp.delete((N(this.c) + N(1)));
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
