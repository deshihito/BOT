// Scratch のリスト（1始まり、特殊インデックス "all" / "last" / "random" 対応）。
// 参照: scratch-vm のリスト操作セマンティクス。
import { toNumber, toString, equals, rng } from "./cast.js";
export class SList {
    items = [];
    constructor(initial = []) {
        this.items = initial.slice();
    }
    /** インデックスを 0 始まりに解決する。無効なら -1。 */
    resolveIndex(index, forInsert = false) {
        if (typeof index === "string") {
            const lower = index.toLowerCase();
            if (lower === "last")
                return this.items.length - 1;
            if (lower === "random") {
                if (this.items.length === 0)
                    return -1;
                return Math.floor(rng() * this.items.length);
            }
            if (lower === "all")
                return -2; // 呼び出し側で特別扱い
        }
        const n = Math.floor(toNumber(index));
        const max = forInsert ? this.items.length + 1 : this.items.length;
        if (n < 1 || n > max)
            return -1;
        return n - 1;
    }
    add(item) {
        this.items.push(item);
    }
    delete(index) {
        if (typeof index === "string" && index.toLowerCase() === "all") {
            this.items = [];
            return;
        }
        const i = this.resolveIndex(index);
        if (i >= 0)
            this.items.splice(i, 1);
    }
    deleteAll() {
        this.items = [];
    }
    insert(item, index) {
        const i = this.resolveIndex(index, true);
        if (i >= 0)
            this.items.splice(i, 0, item);
    }
    replace(index, item) {
        const i = this.resolveIndex(index);
        if (i >= 0)
            this.items[i] = item;
    }
    /** item of list: 範囲外は空文字（Scratch の挙動）。 */
    item(index) {
        const i = this.resolveIndex(index);
        if (i < 0)
            return "";
        return this.items[i];
    }
    /** item # of list: 見つからなければ 0。比較は Scratch の equals。 */
    itemNum(item) {
        for (let i = 0; i < this.items.length; i++) {
            if (equals(this.items[i], item))
                return i + 1;
        }
        return 0;
    }
    contains(item) {
        return this.itemNum(item) > 0;
    }
    get length() {
        return this.items.length;
    }
    /** リストを文字列化するとき（変数表示や join 用）。Scratch は要素をそのまま連結する。 */
    toScratchString() {
        return this.items.map((v) => toString(v)).join("");
    }
}
