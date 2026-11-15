// AGO WORLD BOX のシード付き乱数（純粋ロジック）。
// 決定的生成（マップ・配置）の土台。同じシード → 同じ列。

/** mulberry32: シード付き疑似乱数。 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
