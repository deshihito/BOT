// 蒸留済み: April（エイプリルフールの猫）
// 生成版 src/generated/April.ts の置換。挙動は生成版と等価であり、
// tests/april-idea.test.mjs と npm test のダイジェストで担保する。
//
// 4/1 の日付ゲートの奥にあるイースターエッグ。タイトルが消えたあと、
// 画面左下に猫が常駐し（戦闘中は隠れる）、60〜120 秒ごとにせり上がって
// 左右をきょろきょろ見てから戻る。
import { Sprite } from "../runtime/runtime.js";
import { toNumber as N, toBoolean as B, compare, equals, random } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class April extends Sprite {
    /** 猫の縦位置（-230 = 隠れた位置、せり上がると -180 まで） */
    pos_y = -230;
    constructor(rt) {
        super(rt, "April");
        this.costumes = [
            { name: "Move", assetFile: "efa1619ec67239448c717a57422130f3.svg", rotationCenterX: 0, rotationCenterY: 0 },
            { name: "Cat", assetFile: "e80512623914c2476b4565fd55fbd78f.svg", rotationCenterX: 21.009090000000015, rotationCenterY: 23.209619833965917 },
        ];
        this.loadCostumeImages();
        this.x = -170;
        this.y = -230;
        this.direction = 90;
        this.size = 200;
        this.visible = true;
    }
    varByName(name) {
        switch (name) {
            case "pos_y": return this.pos_y;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script1());
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script2());
        this.rt.registerHat(this, "broadcast:Hide title", () => this.script3());
    }
    *script1() {
        this.visible = true;
    }
    // 猫の表示ループ（4/1 のみ）。"Move" コスチューム＋サイズ無限大で位置を合わせてから
    // "Cat" に切り替えて描く、原作の位置合わせの常套。戦闘中（G.X > 400）は隠す。
    *script2() {
        if (B((B(equals(this.rt.current("MONTH"), "4")) && B(equals(this.rt.current("DATE"), "1"))))) {
            while (true) {
                this.switchCostume("Move");
                this.size = N((N(1) / N(0)));
                this.gotoXY(-170, this.pos_y);
                this.switchCostume("Cat");
                this.size = N(200);
                if (B((compare("400", G.X) < 0))) {
                    this.visible = false;
                }
                else {
                    this.visible = true;
                }
                if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                    yield;
            }
        }
    }
    // 猫のせり上がりアニメーション（4/1 のみ）。
    // 60〜120 秒待つ → +2 × 25 フレームでせり上がる → 1 秒静止 →
    // 確率で左右を向く（0.5 秒間隔で 1〜2 回）→ 元の高さへ戻る、の繰り返し。
    *script3() {
        if (B((B(equals(this.rt.current("MONTH"), "4")) && B(equals(this.rt.current("DATE"), "1"))))) {
            this.rotationStyle = "left-right";
            this.pos_y = "-230";
            while (true) {
                yield { waitSeconds: N(random(60, 120)) };
                this.pos_y = "-230";
                const _cnt1 = Math.max(0, Math.floor(N(25)));
                for (let _rep1 = 0; _rep1 < _cnt1; _rep1++) {
                    this.pos_y = N(this.pos_y) + N(2);
                    if (!this.rt.warpActive)
                        yield;
                }
                yield { waitSeconds: N(1) };
                if (B(equals(random(1, 2), "1"))) {
                    const _cnt2 = Math.max(0, Math.floor(N(random(1, 2))));
                    for (let _rep2 = 0; _rep2 < _cnt2; _rep2++) {
                        this.pointInDirection(-90);
                        yield { waitSeconds: N(0.5) };
                        this.pointInDirection(90);
                        yield { waitSeconds: N(0.5) };
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                const _cnt3 = Math.max(0, Math.floor(N(25)));
                for (let _rep3 = 0; _rep3 < _cnt3; _rep3++) {
                    this.pos_y = N(this.pos_y) + N(-2);
                    if (!this.rt.warpActive)
                        yield;
                }
                if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                    yield;
            }
        }
    }
}
