// 蒸留済み: Idea（無効化された設定入力）
// 生成版 src/generated/Idea.ts の置換。挙動は生成版と等価であり、
// tests/april-idea.test.mjs と npm test のダイジェストで担保する。
//
// これは作者が無効化したまま残した機能: 'l' キーで「プレイヤーの位置予測度」を
// 0〜100 で入力させ、G.プレイヤー位置予測機能 に保存する想定だった。
// スクリプト全体が恒 false の条件で囲まれており、原作でも一切動作しない。
// 到達しない形のまま保持する。
import { Sprite } from "../runtime/runtime.js";
import { toString as S, toBoolean as B, compare, equals } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
export class Idea extends Sprite {
    constructor(rt) {
        super(rt, "Idea");
        this.costumes = [
            { name: "Idea", assetFile: "efa1619ec67239448c717a57422130f3.svg", rotationCenterX: 0, rotationCenterY: 0 },
        ];
        this.loadCostumeImages();
        this.x = 0;
        this.y = 0;
        this.direction = 90;
        this.size = 100;
        this.visible = false;
    }
    registerHats() {
        this.rt.registerHat(this, "key:l", () => this.script1());
    }
    // 'l' キー: 位置予測度の入力（無効化済み — 条件が恒 false）
    *script1() {
        if (B(false)) {
            yield* this.rt.askGen(S("プレイヤーの位置予測度を半角数字で入力してください。(0~100)"));
            if (B((B(equals(this.rt.answer, "0")) || B((B((B((compare("0", this.rt.answer) < 0)) && B((compare(this.rt.answer, "100") < 0)))) || B(equals(this.rt.answer, "100"))))))) {
                G.プレイヤー位置予測機能 = this.rt.answer;
            }
        }
    }
}
