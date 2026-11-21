// このファイルは tools/transpile.py による自動生成。手で編集しないこと。
// 元ターゲット: Idea
import { Sprite } from "../runtime/runtime.js";
import { toString as S, toBoolean as B, compare, equals } from "../runtime/cast.js";
import { G } from "./globals.js";
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
    // hat: event_whenkeypressed (key:l)
    *script1() {
        if (B(false)) {
            yield* this.rt.askGen(S("プレイヤーの位置予測度を半角数字で入力してください。(0~100)"));
            if (B((B(equals(this.rt.answer, "0")) || B((B((B((compare("0", this.rt.answer) < 0)) && B((compare(this.rt.answer, "100") < 0)))) || B(equals(this.rt.answer, "100"))))))) {
                G.プレイヤー位置予測機能 = this.rt.answer;
            }
        }
    }
}
