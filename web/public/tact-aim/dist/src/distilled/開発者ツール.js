// 蒸留済み: 開発者ツール（作者の編集ツール群）
// 生成版 src/generated/開発者ツール.ts の置換。挙動は生成版と等価であり、
// tests/dev-tools.test.mjs（手計算の期待値）と npm test のダイジェストで担保する。
//
// 役割: ゲームデータ（アイテム / 弾丸 / マップ）を編集するための作者用ツール。
// 定義コード（"@" 区切り文字列）と G.Item_list / G.Bullet_list /
// G.Wall___object の相互変換、比較・一括編集、マップの保存整形を行う。
// 通常プレイからは G.開発者ツール（開発者モードフラグ、起動時に 0）で
// 隔離されており、script4 が起動時にフラグを落とす。
//
// データ形式:
//   Item_list: 1 アイテム 14 項目（13 フィールド + "" 終端）。
//     フィールド 1 = 名前、2..13 = 性能値。英語名は G.English_weapon_name に
//     アイテム順で別持ちする（Item_list には入らない）。
//   定義コード（AS アイテム / コード作成 の入出力）:
//     "Item@名前@英語名@フィールド2@…@フィールド13@" / "Bullet@名前@…"。
//     弾丸レコードはキーワード区間の可変長で "" 終端。
//   fieldLabels: フィールド 2 以降のラベル（ラベル k がフィールド k+1 に対応し、
//     アイテム比較は item(レコード先頭 + k) を引く）。
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, equals, letterOf } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class 開発者ツール extends Sprite {
    /** 共有カーソル（原作の a）。文字位置・レコード位置・itemNum の結果置き場を兼ねる。
     *  Pen/All が varByName("a") で読み、"0" かどうかを判定しているため分割しない。
     *  初期値 1650 は作者の保存値の残り。 */
    cursor = 1650;
    /** 対象レコードの種別（原作の c）: "Item" | "Bullet"。AS アイテムが先頭フィールドで決める。 */
    recordKind = "Item";
    /** パース中のフィールド番号（原作の d、1 始まり）。初期値 15 は保存値の残り。 */
    fieldIndex = 15;
    /** 作業変数（原作の b）。パース中のフィールド文字列の蓄積が主用途で、
     *  アイテムステータス変更ではアイテム名、弾丸パラメータ変更では逆順インデックスにも使う。 */
    fieldText = 1;
    /** AS アイテム "S"（置換）モードの挿入位置（原作の e）。初期値 5876 は保存値の残り。 */
    insertPos = 5876;
    /** フィールドラベル（原作の「番号と効果名」）。 */
    fieldLabels = new SList(["アイテムタイプ", "リロード時間（フレーム）", "コスト", "捜索力（構えてないときのカメラ）", "スコープパワー（ズーム、カメラ）", "スコープの有無", "ブレ（角度）", "重さ（0-100）", "音（0-100）", "弾丸名", "弾丸作成タイプ", "弾丸生成時のサウンド", "他のアクション名", "引数1　引数2...", "＜空白＞"]);
    /** 編集バッファ（原作のリスト「開発者ツール」）。比較・表示の結果が入り、
     *  変更系の手順はここを編集済みの値として読み戻す。
     *  初期値は作者のサンプル（武器「テラァシューター」の定義 36 項目）。 */
    editBuffer = new SList(["テラァシューター", "Mine stamp", "テラァシューター見た目", 100, "Step", 20, "Damage", 12, 20, 0, "-", "-", "-", "-", "-", "-", "Put buff", "耐爆減少", "150", "60", "Length", 6, 40, "-", "-", "-", "-", "-", "-", "Break wall", "-", "-", "-", "-", "-", "-"]);
    /** 生成した定義コード / セーブコードの置き場（item 1 に 1 本の文字列）。 */
    saveCode = new SList([]);
    /** マップエディタのパレット（種別番号と名前。Wall レコードの type 対応表）。 */
    mapPalette = new SList(["1 壁", "3 茂み", "6 トゲ壁", "7 復活地点", "18 格子", "19 ダッシュ", "20 爆破", "21 回復", "22 光線", "23 ワープ", "24 エネルギー", "25 シールド", "27 泥", "28 チームジェム"]);
    /** マップ保存用: 退避レコードの置き場。 */
    workList = new SList([]);
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
            case "a": return this.cursor;
            case "c": return this.recordKind;
            case "d": return this.fieldIndex;
            case "b": return this.fieldText;
            case "e": return this.insertPos;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script4());
    }
    // hat: procedures_call
    *script1() {
        /* モニター表示の切替のみ: 実行時は何もしない */
        this.editBuffer.deleteAll();
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
    // 定義コードを Item_list / Bullet_list へ取り込む。
    // A_S = "A": 末尾へ追加（Item は名前を G.Weapon_name へ、英語名を
    //   G.English_weapon_name へも登録し、Item_list には入れない）。
    // A_S = "S": フィールド 2 の名前で既存レコードを探し、その場で差し替える。
    //   見つからなければ stop all で打ち切る。
    *AS_アイテム(item_code, A_S) {
        this.rt.pushWarp();
        try {
            this.cursor = "0";
            this.recordKind = "0";
            this.fieldIndex = "0";
            while (!B(equals(letterOf(item_code, (N(this.cursor) + N(1))), ""))) {
                this.fieldIndex = N(this.fieldIndex) + N(1);
                this.fieldText = "";
                while (!B((B(equals(letterOf(item_code, (N(this.cursor) + N(1))), "@")) || B(equals(letterOf(item_code, (N(this.cursor) + N(1))), ""))))) {
                    this.cursor = N(this.cursor) + N(1);
                    this.fieldText = (S(this.fieldText) + S(letterOf(item_code, this.cursor)));
                    if (!this.rt.warpActive)
                        yield;
                }
                this.cursor = N(this.cursor) + N(1);
                if (B((B(equals(this.fieldIndex, "2")) && B((B(equals(A_S, "A")) && B(equals(this.recordKind, "Item"))))))) {
                    G.Weapon_name.add(this.fieldText);
                }
                if (B((B(equals(this.fieldIndex, "3")) && B((B(equals(A_S, "A")) && B(equals(this.recordKind, "Item"))))))) {
                    G.English_weapon_name.add(this.fieldText);
                }
                if (B((B(equals(this.fieldIndex, "2")) && B(equals(A_S, "S"))))) {
                    if (B(equals(this.recordKind, "Item"))) {
                        if (B(G.Item_list.contains(this.fieldText))) {
                            this.insertPos = (N(G.Item_list.itemNum(this.fieldText)) + N(1));
                            while (!B(equals(G.Item_list.item(this.insertPos), ""))) {
                                G.Item_list.delete(this.insertPos);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        else {
                            this.rt.stopAll();
                            return;
                        }
                    }
                    if (B(equals(this.recordKind, "Bullet"))) {
                        if (B(G.Bullet_list.contains(this.fieldText))) {
                            this.insertPos = (N(G.Bullet_list.itemNum(this.fieldText)) + N(1));
                            while (!B(equals(G.Bullet_list.item(this.insertPos), ""))) {
                                G.Bullet_list.delete(this.insertPos);
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
                    if (B((B(equals(this.recordKind, "Bullet")) || B((B(equals(this.recordKind, "Item")) && B((!B(equals(this.fieldIndex, "3"))))))))) {
                        if (B(equals(A_S, "S"))) {
                            if (B(equals(this.recordKind, "Item"))) {
                                G.Item_list.insert(this.fieldText, this.insertPos);
                            }
                            if (B(equals(this.recordKind, "Bullet"))) {
                                G.Bullet_list.insert(this.fieldText, this.insertPos);
                            }
                            this.insertPos = N(this.insertPos) + N(1);
                        }
                        else {
                            if (B(equals(this.recordKind, "Item"))) {
                                G.Item_list.add(this.fieldText);
                            }
                            if (B(equals(this.recordKind, "Bullet"))) {
                                G.Bullet_list.add(this.fieldText);
                            }
                        }
                    }
                }
                if (B(equals(this.fieldIndex, "1"))) {
                    this.recordKind = this.fieldText;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            if (B(equals(A_S, "A"))) {
                if (B(equals(this.recordKind, "Item"))) {
                    G.Item_list.add("");
                }
                if (B(equals(this.recordKind, "Bullet"))) {
                    G.Bullet_list.add("");
                }
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "アイテム比較 %s" (warp)
    // 全アイテムについて、指定フィールド（番号 → ラベル、値 = フィールド 番号+1）を
    // editBuffer へ [番号, "〜の比較", 名前, 値, 名前, 値, …] と並べる。
    *アイテム比較(番号) {
        this.rt.pushWarp();
        try {
            /* モニター表示の切替のみ: 実行時は何もしない */
            this.editBuffer.deleteAll();
            this.editBuffer.add(番号);
            this.editBuffer.add((S(this.fieldLabels.item(番号)) + S("の比較")));
            this.cursor = "1";
            const _cnt1 = Math.max(0, Math.floor(N((N(G.Item_list.length) / N(14)))));
            for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                if (B(equals(G.Item_list.item((N(this.cursor) - N(1))), ""))) {
                    this.editBuffer.add(G.Item_list.item(this.cursor));
                    this.editBuffer.add(G.Item_list.item((N(this.cursor) + N(番号))));
                }
                this.cursor = N(this.cursor) + N(14);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "アイテムステータス変更"
    // アイテム比較の結果（editBuffer）を Item_list へ書き戻す。
    // (名前, 値) の組を読み、名前のレコードの (先頭 + 番号) フィールドを置換する。
    *アイテムステータス変更() {
        if (B((!B(equals(this.editBuffer.length, "0"))))) {
            if (B(S(this.editBuffer.item(2)).toLowerCase().includes(S("の比較").toLowerCase()))) {
                this.cursor = "0";
                const _cnt2 = Math.max(0, Math.floor(N((N((N(this.editBuffer.length) / N(2))) - N(1)))));
                for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                    this.cursor = N(this.cursor) + N(2);
                    this.fieldText = this.editBuffer.item((N(this.cursor) + N(1)));
                    if (B((!B(equals(this.fieldText, ""))))) {
                        G.Item_list.replace((N(G.Item_list.itemNum(this.fieldText)) + N(this.editBuffer.item(1))), this.editBuffer.item((N(this.cursor) + N(2))));
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
            }
        }
    }
    // procedure: "複製: 弾丸名 %s 複製後弾丸名 %s" (warp)
    // 弾丸レコードを Bullet_list の末尾へコピーする（先頭の名前だけ差し替え）。
    *複製__弾丸名__複製後弾丸名(複製する弾丸, 複製後の弾丸) {
        this.rt.pushWarp();
        try {
            this.cursor = G.Bullet_list.itemNum(複製する弾丸);
            if (B((!B(equals(this.cursor, "0"))))) {
                while (!B(equals(G.Bullet_list.item(this.cursor), ""))) {
                    if (B(equals(this.cursor, G.Bullet_list.itemNum(複製する弾丸)))) {
                        G.Bullet_list.add(複製後の弾丸);
                    }
                    else {
                        G.Bullet_list.add(G.Bullet_list.item(this.cursor));
                    }
                    this.cursor = N(this.cursor) + N(1);
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
    // Wall & object を保存用に整形し、saveCode へ "@" 区切りで書き出す。
    // 種別ごとの初期化（フィールドは 1 始まり）:
    //   6 / 7（トゲ壁 / 復活地点）: レコードごと末尾へ移動（退避してから戻す）
    //   2: f5, f6 = 0、f7 = 100
    //   19 / 22（ダッシュ / 光線）: f6, f7 = 0（f5 は保持）
    //   23（ワープ）: f5, f6 = 0（f7 = 行き先は保持）
    //   その他: f5, f6, f7 = 0
    *マップ保存() {
        this.rt.pushWarp();
        try {
            this.cursor = "0";
            this.workList.deleteAll();
            const _cnt3 = Math.max(0, Math.floor(N((N(G.Wall___object.length) / N(7)))));
            for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                if (B((B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "6")) || B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "7"))))) {
                    const _cnt4 = Math.max(0, Math.floor(N(7)));
                    for (let _rep4 = 0; _rep4 < _cnt4; _rep4++) {
                        this.workList.add(G.Wall___object.item((N(this.cursor) + N(1))));
                        G.Wall___object.delete((N(this.cursor) + N(1)));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    if (B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "2"))) {
                        G.Wall___object.replace((N(this.cursor) + N(5)), "0");
                        G.Wall___object.replace((N(this.cursor) + N(6)), "0");
                        G.Wall___object.replace((N(this.cursor) + N(7)), "100");
                    }
                    else {
                        if (B((B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "19")) || B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "22"))))) {
                            G.Wall___object.replace((N(this.cursor) + N(6)), "0");
                            G.Wall___object.replace((N(this.cursor) + N(7)), "0");
                        }
                        else {
                            if (B(equals(G.Wall___object.item((N(this.cursor) + N(2))), "23"))) {
                                G.Wall___object.replace((N(this.cursor) + N(5)), "0");
                                G.Wall___object.replace((N(this.cursor) + N(6)), "0");
                            }
                            else {
                                G.Wall___object.replace((N(this.cursor) + N(5)), "0");
                                G.Wall___object.replace((N(this.cursor) + N(6)), "0");
                                G.Wall___object.replace((N(this.cursor) + N(7)), "0");
                            }
                        }
                    }
                    this.cursor = N(this.cursor) + N(7);
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.cursor = "0";
            const _cnt5 = Math.max(0, Math.floor(N(this.workList.length)));
            for (let _rep5 = 0; _rep5 < _cnt5; _rep5++) {
                this.cursor = N(this.cursor) + N(1);
                G.Wall___object.add(this.workList.item(this.cursor));
                if (!this.rt.warpActive)
                    yield;
            }
            this.saveCode.deleteAll();
            this.saveCode.add("");
            this.cursor = "0";
            const _cnt6 = Math.max(0, Math.floor(N(G.Wall___object.length)));
            for (let _rep6 = 0; _rep6 < _cnt6; _rep6++) {
                this.cursor = N(this.cursor) + N(1);
                this.saveCode.replace(1, (S(this.saveCode.item(1)) + S((S(G.Wall___object.item(this.cursor)) + S("@")))));
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
    // Wall & object を全消去し、符号化文字列を "@" 区切りでフィールド列へ戻す。
    *マップ読み込み(コード) {
        this.rt.pushWarp();
        try {
            G.Wall___object.deleteAll();
            this.cursor = "0";
            while (!B(equals(letterOf(コード, (N(this.cursor) + N(1))), ""))) {
                this.fieldText = "";
                while (!B((B(equals(letterOf(コード, (N(this.cursor) + N(1))), "@")) || B(equals(letterOf(コード, (N(this.cursor) + N(1))), ""))))) {
                    this.cursor = N(this.cursor) + N(1);
                    this.fieldText = (S(this.fieldText) + S(letterOf(コード, this.cursor)));
                    if (!this.rt.warpActive)
                        yield;
                }
                this.cursor = N(this.cursor) + N(1);
                G.Wall___object.add(this.fieldText);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "弾丸パラメータ表示 %s" (warp)
    // 弾丸レコードのフィールドを editBuffer へコピーする（名前を含む）。
    *弾丸パラメータ表示(弾丸名) {
        this.rt.pushWarp();
        try {
            this.cursor = G.Bullet_list.itemNum(弾丸名);
            this.editBuffer.deleteAll();
            if (B((!B(equals(this.cursor, "0"))))) {
                while (!B(equals(G.Bullet_list.item(this.cursor), ""))) {
                    this.editBuffer.add(G.Bullet_list.item(this.cursor));
                    this.cursor = N(this.cursor) + N(1);
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
    // editBuffer の内容を弾丸レコードへ書き戻す。レコードの 2 フィールド目以降を
    // 消し、editBuffer の末尾から逆順に insert することで元の並びに戻す。
    // 注意: cursor の "0" チェックは itemNum + 1 のため常に通過する（原作の挙動）。
    *弾丸パラメータ変更() {
        this.rt.pushWarp();
        try {
            if (B((!B(S(this.editBuffer.item(2)).toLowerCase().includes(S("の比較").toLowerCase()))))) {
                this.cursor = (N(G.Bullet_list.itemNum(this.editBuffer.item(1))) + N(1));
                if (B((!B(equals(this.cursor, "0"))))) {
                    while (!B(equals(G.Bullet_list.item(this.cursor), ""))) {
                        G.Bullet_list.delete(this.cursor);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.fieldText = this.editBuffer.length;
                    const _cnt7 = Math.max(0, Math.floor(N((N(this.editBuffer.length) - N(1)))));
                    for (let _rep7 = 0; _rep7 < _cnt7; _rep7++) {
                        G.Bullet_list.insert(this.editBuffer.item(this.fieldText), this.cursor);
                        this.fieldText = N(this.fieldText) + N(-1);
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
    // レコードから定義コードを組み立てる（AS アイテムの逆変換）。
    // Item の英語名は (itemNum - 1) / 14 + 1 で引く（14 刻みのレコード前提）。
    *コード作成(v_name, I_or_B) {
        this.saveCode.deleteAll();
        if (B(equals(I_or_B, "I"))) {
            this.saveCode.add((S("Item@") + S((S(v_name) + S("@")))));
            this.cursor = G.Item_list.itemNum(v_name);
            this.saveCode.replace(1, (S(this.saveCode.item(1)) + S((S(G.English_weapon_name.item((N((N((N(G.Item_list.itemNum(v_name)) - N(1))) / N(14))) + N(1)))) + S("@")))));
            while (!B(equals(G.Item_list.item((N(this.cursor) + N(1))), ""))) {
                this.cursor = N(this.cursor) + N(1);
                this.saveCode.replace(1, (S(this.saveCode.item(1)) + S((S(G.Item_list.item(this.cursor)) + S("@")))));
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            this.saveCode.add((S("Bullet@") + S((S(v_name) + S("@")))));
            this.cursor = G.Bullet_list.itemNum(v_name);
            while (!B(equals(G.Bullet_list.item((N(this.cursor) + N(1))), ""))) {
                this.cursor = N(this.cursor) + N(1);
                this.saveCode.replace(1, (S(this.saveCode.item(1)) + S((S(G.Bullet_list.item(this.cursor)) + S("@")))));
                if (!this.rt.warpActive)
                    yield;
            }
        }
    }
    // procedure: "ワープ地点の設定 %s %s"
    // (X, Y) のグリッド（50 単位）にあるワープレコードの f7（行き先）へ、
    // 現在位置のグリッド + 500 を 2 つ文字列連結した値を書き込む。
    // 例: 現在位置グリッド (250, 50) → "750550"。
    *ワープ地点の設定(X, Y) {
        if (B(G.Wall___object.contains((S(Math.round(N((N(X) / N(50))))) + S((S("/") + S(Math.round(N((N(Y) / N(50))))))))))) {
            G.Wall___object.replace((N(G.Wall___object.itemNum((S(Math.round(N((N(X) / N(50))))) + S((S("/") + S(Math.round(N((N(Y) / N(50)))))))))) + N(6)), (S((N(Math.round(N((N(G.X) / N(50))))) + N(500))) + S((N(Math.round(N((N(G.Y) / N(50))))) + N(500)))));
        }
    }
}
