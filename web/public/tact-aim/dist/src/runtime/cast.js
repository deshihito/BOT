// Scratch の値セマンティクス（scratch-vm の Cast 相当）。
// 移植の同一性はこの型変換規則にかかっているため、推測で変えないこと。
// 参照: scratch-vm src/util/cast.js
/** Scratch の toNumber: 数値化できないものは 0。NaN は 0。 */
export function toNumber(v) {
    if (typeof v === "number")
        return Number.isNaN(v) ? 0 : v;
    if (typeof v === "boolean")
        return v ? 1 : 0;
    const n = Number(v);
    return Number.isNaN(n) ? 0 : n;
}
/** Scratch の toString: 数値は JS の String() とほぼ同じ。真偽値は "true"/"false"。 */
export function toString(v) {
    if (typeof v === "string")
        return v;
    if (typeof v === "boolean")
        return v ? "true" : "false";
    return String(v);
}
/** Scratch の toBoolean: false になるのは false / 0 / "0" / "false" / "" のみ。 */
export function toBoolean(v) {
    if (typeof v === "boolean")
        return v;
    if (typeof v === "string") {
        if (v === "" || v === "0" || v.toLowerCase() === "false")
            return false;
        return true;
    }
    return v !== 0 && !Number.isNaN(v);
}
/**
 * Scratch の compare（scratch-vm Cast.compare の正確な移植）。
 * 両方とも数値として読める場合は数値比較、そうでない場合は
 * 大文字小文字を無視した文字列比較。戻り値は a<b で負、a==b で 0、a>b で正。
 *
 * 重要: 空白だけの文字列は Number() で 0 になるが、scratch-vm はこれを
 * NaN として扱い文字列比較に落とす。そのため "" と "0" は等しくない。
 * この規則がないと、letter of の終端判定（"" との比較）が "0" の文字で
 * 誤発し、"0" を含むフィールドのパース（Load map 等）が途中で止まる。
 */
export function compare(a, b) {
    let n1 = Number(a);
    let n2 = Number(b);
    if (n1 === 0 && String(a).trim().length === 0) {
        n1 = NaN;
    }
    else if (n2 === 0 && String(b).trim().length === 0) {
        n2 = NaN;
    }
    if (Number.isNaN(n1) || Number.isNaN(n2)) {
        const sa = String(a).toLowerCase();
        const sb = String(b).toLowerCase();
        if (sa < sb)
            return -1;
        if (sa > sb)
            return 1;
        return 0;
    }
    if (n1 < n2)
        return -1;
    if (n1 > n2)
        return 1;
    return 0;
}
export function equals(a, b) {
    return compare(a, b) === 0;
}
/** Scratch の mod は床除算方式（負数でも結果は除数の符号に従う）。 */
export function mod(a, b) {
    const na = toNumber(a);
    const nb = toNumber(b);
    return ((na % nb) + nb) % nb;
}
/** Scratch の乱数: 両端とも整数なら整数（両端含む）、そうでなければ実数。 */
/** 乱数源。ランタイムの決定論モードがシード付き RNG に差し替える。 */
let rngSource = Math.random;
export function setRngSource(fn) {
    rngSource = fn;
}
export function rng() {
    return rngSource();
}
export function random(from, to) {
    const nf = toNumber(from);
    const nt = toNumber(to);
    const lo = Math.min(nf, nt);
    const hi = Math.max(nf, nt);
    if (Number.isInteger(nf) && Number.isInteger(nt)) {
        return lo + Math.floor(rng() * (hi - lo + 1));
    }
    return lo + rng() * (hi - lo);
}
const MATHOPS = {
    abs: (n) => Math.abs(n),
    floor: (n) => Math.floor(n),
    ceiling: (n) => Math.ceil(n),
    sqrt: (n) => Math.sqrt(n),
    sin: (n) => Math.sin((n * Math.PI) / 180),
    cos: (n) => Math.cos((n * Math.PI) / 180),
    tan: (n) => Math.tan((n * Math.PI) / 180),
    asin: (n) => (Math.asin(n) * 180) / Math.PI,
    acos: (n) => (Math.acos(n) * 180) / Math.PI,
    atan: (n) => (Math.atan(n) * 180) / Math.PI,
    ln: (n) => Math.log(n),
    log: (n) => Math.log10(n),
    "e ^": (n) => Math.exp(n),
    "10 ^": (n) => Math.pow(10, n),
};
export function mathop(op, v) {
    const f = MATHOPS[op];
    return f ? f(toNumber(v)) : 0;
}
/** 文字列の letter of（1始まり、範囲外は空文字）。 */
export function letterOf(v, idx) {
    const s = toString(v);
    const i = Math.floor(toNumber(idx)) - 1;
    if (i < 0 || i >= s.length)
        return "";
    return s.charAt(i);
}
