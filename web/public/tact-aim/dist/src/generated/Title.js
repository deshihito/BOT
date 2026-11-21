// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: Title
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop } from "../runtime/cast.js";
import { G } from "./globals.js";
export class Title extends Sprite {
    a = 345;
    b = 0;
    c = 5648;
    d = 5;
    Temp = new SList([]);
    constructor(rt) {
        super(rt, "Title");
        this.costumes = [
            { name: "Title", assetFile: "5c6bed87f34944b7f75b76f6d9a7a7e0.svg", rotationCenterX: 265.090565, rotationCenterY: 253.3112938745556 },
            { name: "Xmas Title", assetFile: "ef6d9b72a6c3e88d95ae8ec8c44b296c.svg", rotationCenterX: 265.090565, rotationCenterY: 253.3112994372778 },
            { name: "Logo", assetFile: "c67bcfe40aed0ad8715fceeec4bd809e.svg", rotationCenterX: 152, rotationCenterY: 22.761066178179533 },
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
            case "d": return this.d;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script1());
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script3());
        this.rt.registerHat(this, "flag", () => this.script4());
        this.rt.registerHat(this, "flag", () => this.script5());
        this.rt.registerHat(this, "flag", () => this.script6());
    }
    // hat: event_whenflagclicked (flag)
    *script1() {
        G.Version_name = "v16.8";
        if (B(equals(this.rt.current("MONTH"), "12"))) {
            this.switchCostume("Xmas Title");
            G.Version_name = (S(G.Version_name) + S(" Xmas"));
        }
        else {
            this.switchCostume("Title");
        }
        if (B((B(equals(this.rt.current("MONTH"), "4")) && B(equals(this.rt.current("DATE"), "1"))))) {
            G.Version_name = (S(G.Version_name) + S(" April"));
        }
        this.visible = true;
        yield* this.Check_bullet_damage();
        yield { waitSeconds: N(0.5) };
        G.Inventory_2.replace(31, "1");
        if (B(equals(G.Festival, "1"))) {
            /* モニター表示の切替のみ: 実行時は何もしない */
        }
        else {
            /* モニター表示の切替のみ: 実行時は何もしない */
        }
        const _cnt1 = Math.max(0, Math.floor(N(8)));
        for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
            yield { waitSeconds: N(0.1) };
            if (B(equals(G.Festival, "0"))) {
                if (B((!B(/* arg is turbowarp? */ 0)))) {
                    /* モニター表示の切替のみ: 実行時は何もしない */
                }
            }
            if (!this.rt.warpActive)
                yield;
        }
        yield { waitSeconds: N(10) };
        /* モニター表示の切替のみ: 実行時は何もしない */
    }
    // hat: data_hidelist
    *script2() {
    }
    // hat: event_whenbroadcastreceived (broadcast:Hide title)
    *script3() {
        this.setEffect("GHOST", 100);
    }
    // hat: event_whenflagclicked (flag)
    *script4() {
        if (B(false)) {
            yield { waitSeconds: N(0.2) };
            if (B(equals(G.Festival, "0"))) {
                /* モニター表示の切替のみ: 実行時は何もしない */
                yield { waitUntil: () => B(equals(G.Menu.item(50), "1")) };
                /* モニター表示の切替のみ: 実行時は何もしない */
            }
        }
    }
    // hat: event_whenflagclicked (flag)
    *script5() {
        yield { waitSeconds: N(1) };
        if (B((B(equals(this.rt.current("MONTH"), "4")) && B(equals(this.rt.current("DATE"), "1"))))) {
            this.Temp.deleteAll();
            this.a = "0";
            const _cnt2 = Math.max(0, Math.floor(N((N(G.Character_2.length) / N(15)))));
            for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                this.Temp.add(G.Character_2.item((N(this.a) + N(2))));
                this.a = N(this.a) + N(15);
                if (!this.rt.warpActive)
                    yield;
            }
            this.Temp.delete(this.Temp.itemNum("狙撃ワープ"));
            if (B(equals(this.Temp.length, (N((N(G.Character_2.length) / N(15))) - N(1))))) {
                this.a = "0";
                const _cnt3 = Math.max(0, Math.floor(N((N(G.Character_2.length) / N(15)))));
                for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                    if (B((!B(equals(G.Character_2.item((N(this.a) + N(1))), "April Cat"))))) {
                        G.Character_2.replace((N(this.a) + N(2)), this.Temp.item(random(1, this.Temp.length)));
                    }
                    this.a = N(this.a) + N(15);
                    if (!this.rt.warpActive)
                        yield;
                }
            }
        }
    }
    // hat: event_whenflagclicked (flag)
    *script6() {
        const _cnt4 = Math.max(0, Math.floor(N(30)));
        for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
            if (B((B((compare("9820", mathop("floor", (N(this.rt.daysSince2000()) + N(0.375)))) < 0)) && B((compare(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), "9852") < 0))))) {
                if (B(equals(mod(mathop("floor", (N(this.rt.daysSince2000()) + N(0.375))), 2), "0"))) {
                    G.Festival = "0";
                }
                else {
                    G.Festival = "1";
                }
            }
            yield { waitSeconds: N(0.1) };
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Check bullet damage" (warp)
    *Check_bullet_damage() {
        this.rt.pushWarp();
        try {
            G.Bullet_damage.deleteAll();
            this.a = "0";
            while (!B((compare(G.Bullet_list.length, this.a) < 0))) {
                this.a = N(this.a) + N(1);
                this.c = this.a;
                this.b = "0";
                this.d = "5";
                while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                    if (B((B(equals(G.Bullet_list.item(this.a), "Roll step")) || B(equals(G.Bullet_list.item(this.a), "Roll homing"))))) {
                        this.d = "6";
                    }
                    if (B((B(equals(G.Bullet_list.item(this.a), "Break wall")) || B((B(equals(G.Bullet_list.item(this.a), "Set length")) || B(equals(G.Bullet_list.item(this.a), "Sword damage"))))))) {
                        this.b = "1";
                    }
                    this.a = N(this.a) + N(1);
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B((B((compare("1", this.c) < 0)) && B(equals(G.Bullet_list.item((N(this.c) - N(2))), ""))))) {
                    this.b = "0";
                }
                if (B(G.Remaining_bullet.contains(G.Bullet_list.item(this.c)))) {
                    this.b = "0";
                }
                if (B(equals(this.b, "1"))) {
                    this.a = this.c;
                    while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                        this.b = "-";
                        if (B((B(equals(G.Bullet_list.item(this.a), "Damage")) || B(equals(G.Bullet_list.item(this.a), "Sword damage"))))) {
                            this.b = G.Bullet_list.item((N(this.a) + N(1)));
                        }
                        if (B(equals(G.Bullet_list.item(this.a), "Laser"))) {
                            this.b = G.Bullet_list.item((N(this.a) + N(5)));
                        }
                        if (B((!B(equals(this.b, "-"))))) {
                            if (B(G.Bullet_damage.contains(G.Bullet_list.item(this.c)))) {
                                this.c = (N(G.Bullet_damage.itemNum(G.Bullet_list.item(this.c))) + N(1));
                                G.Bullet_damage.replace(this.c, (N((N(this.b) + N(G.Bullet_damage.item(this.c)))) / N(2)));
                            }
                            else {
                                G.Bullet_damage.add(G.Bullet_list.item(this.c));
                                G.Bullet_damage.add(this.b);
                            }
                            G.Bullet_damage.add(this.d);
                        }
                        this.a = N(this.a) + N(1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                    this.a = N(this.a) + N(1);
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
