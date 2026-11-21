// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: 開発者ツール
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, equals, letterOf } from "../runtime/cast.js";
import { G } from "./globals.js";
export class 開発者ツール extends Sprite {
    a = 1650;
    c = "Item";
    d = 15;
    b = 1;
    e = 5876;
    番号と効果名 = new SList(["アイテムタイプ", "リロード時間（フレーム）", "コスト", "捜索力（構えてないときのカメラ）", "スコープパワー（ズーム、カメラ）", "スコープの有無", "ブレ（角度）", "重さ（0-100）", "音（0-100）", "弾丸名", "弾丸作成タイプ", "弾丸生成時のサウンド", "他のアクション名", "引数1　引数2...", "＜空白＞"]);
    開発者ツール = new SList(["テラァシューター", "Mine stamp", "テラァシューター見た目", 100, "Step", 20, "Damage", 12, 20, 0, "-", "-", "-", "-", "-", "-", "Put buff", "耐爆減少", "150", "60", "Length", 6, 40, "-", "-", "-", "-", "-", "-", "Break wall", "-", "-", "-", "-", "-", "-"]);
    セーブコード = new SList([]);
    マップ開発用 = new SList(["1 壁", "3 茂み", "6 トゲ壁", "7 復活地点", "18 格子", "19 ダッシュ", "20 爆破", "21 回復", "22 光線", "23 ワープ", "24 エネルギー", "25 シールド", "27 泥", "28 チームジェム"]);
    temp = new SList([]);
    constructor(rt) {
        super(rt, "開発者ツール");
        this.costumes = [
            { name: "開発者ツール", assetFile: "efa1619ec67239448c717a57422130f3.svg", rotationCenterX: 0, rotationCenterY: 0 },
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
            case "c": return this.c;
            case "d": return this.d;
            case "b": return this.b;
            case "e": return this.e;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script4());
    }
    // hat: procedures_call
    *script1() {
        /* モニター表示の切替のみ: 実行時は何もしない */
        this.開発者ツール.deleteAll();
    }
    // hat: procedures_call
    *script2() {
    }
    // hat: data_hidelist
    *script3() {
    }
    // hat: event_whenflagclicked (flag)
    *script4() {
        G.開発者ツール = "0";
        /* モニター表示の切替のみ: 実行時は何もしない */
        /* モニター表示の切替のみ: 実行時は何もしない */
    }
    // hat: procedures_call
    *script5() {
    }
    // hat: procedures_call
    *script6() {
    }
    // hat: control_if_else
    *script7() {
    }
    // hat: procedures_call
    *script8() {
        /* モニター表示の切替のみ: 実行時は何もしない */
    }
    // hat: procedures_call
    *script9() {
    }
    // procedure: "AS アイテム %s %s" (warp)
    *AS_アイテム(item_code, A_S) {
        this.rt.pushWarp();
        try {
            this.a = "0";
            this.c = "0";
            this.d = "0";
            while (!B(equals(letterOf(item_code, (N(this.a) + N(1))), ""))) {
                this.d = N(this.d) + N(1);
                this.b = "";
                while (!B((B(equals(letterOf(item_code, (N(this.a) + N(1))), "@")) || B(equals(letterOf(item_code, (N(this.a) + N(1))), ""))))) {
                    this.a = N(this.a) + N(1);
                    this.b = (S(this.b) + S(letterOf(item_code, this.a)));
                    if (!this.rt.warpActive)
                        yield;
                }
                this.a = N(this.a) + N(1);
                if (B((B(equals(this.d, "2")) && B((B(equals(A_S, "A")) && B(equals(this.c, "Item"))))))) {
                    G.Weapon_name.add(this.b);
                }
                if (B((B(equals(this.d, "3")) && B((B(equals(A_S, "A")) && B(equals(this.c, "Item"))))))) {
                    G.English_weapon_name.add(this.b);
                }
                if (B((B(equals(this.d, "2")) && B(equals(A_S, "S"))))) {
                    if (B(equals(this.c, "Item"))) {
                        if (B(G.Item_list.contains(this.b))) {
                            this.e = (N(G.Item_list.itemNum(this.b)) + N(1));
                            while (!B(equals(G.Item_list.item(this.e), ""))) {
                                G.Item_list.delete(this.e);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        else {
                            this.rt.stopAll();
                            return;
                        }
                    }
                    if (B(equals(this.c, "Bullet"))) {
                        if (B(G.Bullet_list.contains(this.b))) {
                            this.e = (N(G.Bullet_list.itemNum(this.b)) + N(1));
                            while (!B(equals(G.Bullet_list.item(this.e), ""))) {
                                G.Bullet_list.delete(this.e);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        else {
                            this.rt.stopAll();
                            return;
                        }
                    }
                }
                else {
                    if (B((B(equals(this.c, "Bullet")) || B((B(equals(this.c, "Item")) && B((!B(equals(this.d, "3"))))))))) {
                        if (B(equals(A_S, "S"))) {
                            if (B(equals(this.c, "Item"))) {
                                G.Item_list.insert(this.b, this.e);
                            }
                            if (B(equals(this.c, "Bullet"))) {
                                G.Bullet_list.insert(this.b, this.e);
                            }
                            this.e = N(this.e) + N(1);
                        }
                        else {
                            if (B(equals(this.c, "Item"))) {
                                G.Item_list.add(this.b);
                            }
                            if (B(equals(this.c, "Bullet"))) {
                                G.Bullet_list.add(this.b);
                            }
                        }
                    }
                }
                if (B(equals(this.d, "1"))) {
                    this.c = this.b;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            if (B(equals(A_S, "A"))) {
                if (B(equals(this.c, "Item"))) {
                    G.Item_list.add("");
                }
                if (B(equals(this.c, "Bullet"))) {
                    G.Bullet_list.add("");
                }
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "アイテム比較 %s" (warp)
    *アイテム比較(番号) {
        this.rt.pushWarp();
        try {
            /* モニター表示の切替のみ: 実行時は何もしない */
            this.開発者ツール.deleteAll();
            this.開発者ツール.add(番号);
            this.開発者ツール.add((S(this.番号と効果名.item(番号)) + S("の比較")));
            this.a = "1";
            const _cnt1 = Math.max(0, Math.floor(N((N(G.Item_list.length) / N(14)))));
            for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                if (B(equals(G.Item_list.item((N(this.a) - N(1))), ""))) {
                    this.開発者ツール.add(G.Item_list.item(this.a));
                    this.開発者ツール.add(G.Item_list.item((N(this.a) + N(番号))));
                }
                this.a = N(this.a) + N(14);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "アイテムステータス変更"
    *アイテムステータス変更() {
        if (B((!B(equals(this.開発者ツール.length, "0"))))) {
            if (B(S(this.開発者ツール.item(2)).toLowerCase().includes(S("の比較").toLowerCase()))) {
                this.a = "0";
                const _cnt2 = Math.max(0, Math.floor(N((N((N(this.開発者ツール.length) / N(2))) - N(1)))));
                for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                    this.a = N(this.a) + N(2);
                    this.b = this.開発者ツール.item((N(this.a) + N(1)));
                    if (B((!B(equals(this.b, ""))))) {
                        G.Item_list.replace((N(G.Item_list.itemNum(this.b)) + N(this.開発者ツール.item(1))), this.開発者ツール.item((N(this.a) + N(2))));
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
            }
        }
    }
    // procedure: "複製: 弾丸名 %s 複製後弾丸名 %s" (warp)
    *複製__弾丸名__複製後弾丸名(複製する弾丸, 複製後の弾丸) {
        this.rt.pushWarp();
        try {
            this.a = G.Bullet_list.itemNum(複製する弾丸);
            if (B((!B(equals(this.a, "0"))))) {
                while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                    if (B(equals(this.a, G.Bullet_list.itemNum(複製する弾丸)))) {
                        G.Bullet_list.add(複製後の弾丸);
                    }
                    else {
                        G.Bullet_list.add(G.Bullet_list.item(this.a));
                    }
                    this.a = N(this.a) + N(1);
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Bullet_list.add("");
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "マップ保存" (warp)
    *マップ保存() {
        this.rt.pushWarp();
        try {
            this.a = "0";
            this.temp.deleteAll();
            const _cnt3 = Math.max(0, Math.floor(N((N(G.Wall___object.length) / N(7)))));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B((B(equals(G.Wall___object.item((N(this.a) + N(2))), "6")) || B(equals(G.Wall___object.item((N(this.a) + N(2))), "7"))))) {
                    const _cnt4 = Math.max(0, Math.floor(N(7)));
                    for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                        this.temp.add(G.Wall___object.item((N(this.a) + N(1))));
                        G.Wall___object.delete((N(this.a) + N(1)));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    if (B(equals(G.Wall___object.item((N(this.a) + N(2))), "2"))) {
                        G.Wall___object.replace((N(this.a) + N(5)), "0");
                        G.Wall___object.replace((N(this.a) + N(6)), "0");
                        G.Wall___object.replace((N(this.a) + N(7)), "100");
                    }
                    else {
                        if (B((B(equals(G.Wall___object.item((N(this.a) + N(2))), "19")) || B(equals(G.Wall___object.item((N(this.a) + N(2))), "22"))))) {
                            G.Wall___object.replace((N(this.a) + N(6)), "0");
                            G.Wall___object.replace((N(this.a) + N(7)), "0");
                        }
                        else {
                            if (B(equals(G.Wall___object.item((N(this.a) + N(2))), "23"))) {
                                G.Wall___object.replace((N(this.a) + N(5)), "0");
                                G.Wall___object.replace((N(this.a) + N(6)), "0");
                            }
                            else {
                                G.Wall___object.replace((N(this.a) + N(5)), "0");
                                G.Wall___object.replace((N(this.a) + N(6)), "0");
                                G.Wall___object.replace((N(this.a) + N(7)), "0");
                            }
                        }
                    }
                    this.a = N(this.a) + N(7);
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.a = "0";
            const _cnt5 = Math.max(0, Math.floor(N(this.temp.length)));
            for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                this.a = N(this.a) + N(1);
                G.Wall___object.add(this.temp.item(this.a));
                if (!this.rt.warpActive)
                    yield;
            }
            this.セーブコード.deleteAll();
            this.セーブコード.add("");
            this.a = "0";
            const _cnt6 = Math.max(0, Math.floor(N(G.Wall___object.length)));
            for (let _rep6 = 0; _rep6 < _cnt6; _rep6++) {
                this.a = N(this.a) + N(1);
                this.セーブコード.replace(1, (S(this.セーブコード.item(1)) + S((S(G.Wall___object.item(this.a)) + S("@")))));
                if (!this.rt.warpActive)
                    yield;
            }
            /* モニター表示の切替のみ: 実行時は何もしない */
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "マップ読み込み %s" (warp)
    *マップ読み込み(コード) {
        this.rt.pushWarp();
        try {
            G.Wall___object.deleteAll();
            this.a = "0";
            while (!B(equals(letterOf(コード, (N(this.a) + N(1))), ""))) {
                this.b = "";
                while (!B((B(equals(letterOf(コード, (N(this.a) + N(1))), "@")) || B(equals(letterOf(コード, (N(this.a) + N(1))), ""))))) {
                    this.a = N(this.a) + N(1);
                    this.b = (S(this.b) + S(letterOf(コード, this.a)));
                    if (!this.rt.warpActive)
                        yield;
                }
                this.a = N(this.a) + N(1);
                G.Wall___object.add(this.b);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "弾丸パラメータ表示 %s" (warp)
    *弾丸パラメータ表示(弾丸名) {
        this.rt.pushWarp();
        try {
            this.a = G.Bullet_list.itemNum(弾丸名);
            this.開発者ツール.deleteAll();
            if (B((!B(equals(this.a, "0"))))) {
                while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                    this.開発者ツール.add(G.Bullet_list.item(this.a));
                    this.a = N(this.a) + N(1);
                    if (!this.rt.warpActive)
                        yield;
                }
                /* モニター表示の切替のみ: 実行時は何もしない */
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "弾丸パラメータ変更" (warp)
    *弾丸パラメータ変更() {
        this.rt.pushWarp();
        try {
            if (B((!B(S(this.開発者ツール.item(2)).toLowerCase().includes(S("の比較").toLowerCase()))))) {
                this.a = (N(G.Bullet_list.itemNum(this.開発者ツール.item(1))) + N(1));
                if (B((!B(equals(this.a, "0"))))) {
                    while (!B(equals(G.Bullet_list.item(this.a), ""))) {
                        G.Bullet_list.delete(this.a);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.b = this.開発者ツール.length;
                    const _cnt7 = Math.max(0, Math.floor(N((N(this.開発者ツール.length) - N(1)))));
                    for (let _rep7 = 0; _rep7 < _cnt7; _rep7++) {
                        G.Bullet_list.insert(this.開発者ツール.item(this.b), this.a);
                        this.b = N(this.b) + N(-1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "コード作成 %s %s"
    *コード作成(v_name, I_or_B) {
        this.セーブコード.deleteAll();
        if (B(equals(I_or_B, "I"))) {
            this.セーブコード.add((S("Item@") + S((S(v_name) + S("@")))));
            this.a = G.Item_list.itemNum(v_name);
            this.セーブコード.replace(1, (S(this.セーブコード.item(1)) + S((S(G.English_weapon_name.item((N((N((N(G.Item_list.itemNum(v_name)) - N(1))) / N(14))) + N(1)))) + S("@")))));
            while (!B(equals(G.Item_list.item((N(this.a) + N(1))), ""))) {
                this.a = N(this.a) + N(1);
                this.セーブコード.replace(1, (S(this.セーブコード.item(1)) + S((S(G.Item_list.item(this.a)) + S("@")))));
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            this.セーブコード.add((S("Bullet@") + S((S(v_name) + S("@")))));
            this.a = G.Bullet_list.itemNum(v_name);
            while (!B(equals(G.Bullet_list.item((N(this.a) + N(1))), ""))) {
                this.a = N(this.a) + N(1);
                this.セーブコード.replace(1, (S(this.セーブコード.item(1)) + S((S(G.Bullet_list.item(this.a)) + S("@")))));
                if (!this.rt.warpActive)
                    yield;
            }
        }
    }
    // procedure: "ワープ地点の設定 %s %s"
    *ワープ地点の設定(X, Y) {
        if (B(G.Wall___object.contains((S(Math.round(N((N(X) / N(50))))) + S((S("/") + S(Math.round(N((N(Y) / N(50))))))))))) {
            G.Wall___object.replace((N(G.Wall___object.itemNum((S(Math.round(N((N(X) / N(50))))) + S((S("/") + S(Math.round(N((N(Y) / N(50)))))))))) + N(6)), (S((N(Math.round(N((N(G.X) / N(50))))) + N(500))) + S((N(Math.round(N((N(G.Y) / N(50))))) + N(500)))));
        }
    }
}
