// 蒸留済み: Title（タイトル画面と初期化まわり）
// 生成版 src/generated/Title.ts の置換。挙動は生成版と等価であり、
// tests/title.test.mjs と npm test のダイジェストで担保する。
//
// 役割:
// - バージョン名とタイトル画像の季節切り替え（12月は Xmas、4/1 は April 表記）
// - 起動時の武器ダメージ表（G.Bullet_damage）の構築（Check bullet damage）
// - 4/1 のエイプリルフール処理（キャラ名シャッフル）
// - Festival フラグの期間判定（2000年からの通算日数による絶対ウィンドウ）
// - "Hide title" でタイトルをゴースト化して消す
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class Title extends Sprite {
    /** 走査位置（Check bullet damage と script5 で共用。生成版の a） */
    scanIndex = 345;
    /** Check bullet damage 用: 前段では「ダメージ源があるか」のフラグ（"0"/"1"）、
     *  後段ではダメージ値そのもの（"-" は未発見の番兵）。生成版の b */
    damage = 0;
    /** Check bullet damage 用: 武器レコードの開始位置。
     *  平均化の場面では G.Bullet_damage 内の位置にも転用される。生成版の c */
    recordStart = 5648;
    /** Check bullet damage 用: 射程種別（既定 "5"、Roll step / Roll homing は "6"）。生成版の d */
    rangeType = 5;
    /** script5 用: シャッフル候補の名前プール。生成版の Temp */
    namePool = new SList([]);
    constructor(rt) {
        super(rt, "Title");
        this.costumes = [
            { name: "Title", assetFile: "5c6bed87f34944b7f75b76f6d9a7a7a7e0.svg", rotationCenterX: 265.090565, rotationCenterY: 253.3112938745556 },
            { name: "Xmas Title", assetFile: "ef6d9b72a6c3e88d95ae8ec8c44b296c.svg", rotationCenterX: 265.090565, rotationCenterY: 253.3112994372778 },
            { name: "Logo", assetFile: "c67bcfe40aed8715fceeec4bd809e.svg", rotationCenterX: 152, rotationCenterY: 22.761066178179533 },
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
            case "a": return this.scanIndex;
            case "b": return this.damage;
            case "c": return this.recordStart;
            case "d": return this.rangeType;
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
    // 起動時: バージョン表記とタイトル画像を日付で切り替え、ダメージ表を構築する。
    // 後半はモニター表示の切替と待機のみ（モニター未実装のランタイムでは no-op）。
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
    // hat: data_hidelist（生成版でも空）
    *script2() {
    }
    // タイトルを消す合図でゴースト効果 100（透明化）にする
    *script3() {
        this.setEffect("GHOST", 100);
    }
    // 原作でも条件が恒 false で到達しないデッドコード。到達しない形のまま保持する。
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
    // 4/1 のみ: キャラの第2フィールド（名前系）をプール内でシャッフルする。
    // "狙撃ワープ" はプールから除外され、"April Cat" のレコードは書き換えない。
    // プールが (キャラ数 - 1) 件にならなければ（＝除外が起きなければ）何もしない。
    *script5() {
        yield { waitSeconds: N(1) };
        if (B((B(equals(this.rt.current("MONTH"), "4")) && B(equals(this.rt.current("DATE"), "1"))))) {
            this.namePool.deleteAll();
            this.scanIndex = "0";
            const _cnt2 = Math.max(0, Math.floor(N((N(G.Character_2.length) / N(15)))));
            for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                this.namePool.add(G.Character_2.item((N(this.scanIndex) + N(2))));
                this.scanIndex = N(this.scanIndex) + N(15);
                if (!this.rt.warpActive)
                    yield;
            }
            this.namePool.delete(this.namePool.itemNum("狙撃ワープ"));
            if (B(equals(this.namePool.length, (N((N(G.Character_2.length) / N(15))) - N(1))))) {
                this.scanIndex = "0";
                const _cnt3 = Math.max(0, Math.floor(N((N(G.Character_2.length) / N(15)))));
                for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                    if (B((!B(equals(G.Character_2.item((N(this.scanIndex) + N(1))), "April Cat"))))) {
                        G.Character_2.replace((N(this.scanIndex) + N(2)), this.namePool.item(random(1, this.namePool.length)));
                    }
                    this.scanIndex = N(this.scanIndex) + N(15);
                    if (!this.rt.warpActive)
                        yield;
                }
            }
        }
    }
    // Festival 期間の判定: 2000年からの通算日数（+0.375 は日境界の調整）が
    // 9821〜9851（2026年の 11/24〜12/24 相当）の間だけ、その日の偶奇で Festival を切り替える。
    // 絶対日数のウィンドウなので他年では発動しない。原作の実装のまま保持する。
    *script6() {
        // [AGO patch] フェス日判定を無効化 (2026-11-22 ユーザー指示)。
        // 原作は 2026-11-24〜12-24 の間、日数の偶奇で Festival を切り替え
        // 「今日はMODの日」として MOD 側へ誘導する。AGO 側ではこのブロックを
        // 外し、Festival は初期値 0 (通常モード) のままにする。
        // TACT-AIM-distilled 本体はコピーとして無変更。詳細は AGO_PATCHES.md。
        return;
    }
    // 武器ダメージ表の構築（warp）。
    // G.Bullet_list は "" 区切りの武器レコード列。各レコードについて:
    // - "Break wall" / "Set length" / "Sword damage" を含むレコードだけが登録対象
    // - "Roll step" / "Roll homing" を含むと rangeType が "6" になる
    // - ただし G.Remaining_bullet に載っている武器は対象外
    // 登録は (武器名, ダメージ, rangeType) の組。"Damage" の次フィールド、
    // "Laser" の +5 フィールドがダメージ値で、同名武器が再び出たらダメージは平均され、
    // rangeType はヒットのたびに追加される（原作の形のまま）。
    *Check_bullet_damage() {
        this.rt.pushWarp();
        try {
            G.Bullet_damage.deleteAll();
            this.scanIndex = "0";
            while (!B((compare(G.Bullet_list.length, this.scanIndex) < 0))) {
                this.scanIndex = N(this.scanIndex) + N(1);
                this.recordStart = this.scanIndex;
                this.damage = "0";
                this.rangeType = "5";
                while (!B(equals(G.Bullet_list.item(this.scanIndex), ""))) {
                    if (B((B(equals(G.Bullet_list.item(this.scanIndex), "Roll step")) || B(equals(G.Bullet_list.item(this.scanIndex), "Roll homing"))))) {
                        this.rangeType = "6";
                    }
                    if (B((B(equals(G.Bullet_list.item(this.scanIndex), "Break wall")) || B((B(equals(G.Bullet_list.item(this.scanIndex), "Set length")) || B(equals(G.Bullet_list.item(this.scanIndex), "Sword damage"))))))) {
                        this.damage = "1";
                    }
                    this.scanIndex = N(this.scanIndex) + N(1);
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B((B((compare("1", this.recordStart) < 0)) && B(equals(G.Bullet_list.item((N(this.recordStart) - N(2))), ""))))) {
                    this.damage = "0";
                }
                if (B(G.Remaining_bullet.contains(G.Bullet_list.item(this.recordStart)))) {
                    this.damage = "0";
                }
                if (B(equals(this.damage, "1"))) {
                    this.scanIndex = this.recordStart;
                    while (!B(equals(G.Bullet_list.item(this.scanIndex), ""))) {
                        this.damage = "-";
                        if (B((B(equals(G.Bullet_list.item(this.scanIndex), "Damage")) || B(equals(G.Bullet_list.item(this.scanIndex), "Sword damage"))))) {
                            this.damage = G.Bullet_list.item((N(this.scanIndex) + N(1)));
                        }
                        if (B(equals(G.Bullet_list.item(this.scanIndex), "Laser"))) {
                            this.damage = G.Bullet_list.item((N(this.scanIndex) + N(5)));
                        }
                        if (B((!B(equals(this.damage, "-"))))) {
                            if (B(G.Bullet_damage.contains(G.Bullet_list.item(this.recordStart)))) {
                                this.recordStart = (N(G.Bullet_damage.itemNum(G.Bullet_list.item(this.recordStart))) + N(1));
                                G.Bullet_damage.replace(this.recordStart, (N((N(this.damage) + N(G.Bullet_damage.item(this.recordStart)))) / N(2)));
                            }
                            else {
                                G.Bullet_damage.add(G.Bullet_list.item(this.recordStart));
                                G.Bullet_damage.add(this.damage);
                            }
                            G.Bullet_damage.add(this.rangeType);
                        }
                        this.scanIndex = N(this.scanIndex) + N(1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                while (!B(equals(G.Bullet_list.item(this.scanIndex), ""))) {
                    this.scanIndex = N(this.scanIndex) + N(1);
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
