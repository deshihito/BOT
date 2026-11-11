// 川渡りパズルの純粋ロジック（UI 非依存）。
// 農夫がボートで荷物を左岸から右岸へ運ぶ。ボートは農夫＋荷物 capacity 個まで。
// 農夫のいない岸に「危険なペア」がそろうと失敗（例: オオカミとヤギだけが残る）。
// 最短手数は全状態の幅優先探索で計算する（ボートの積み下ろしは手数に数えず、
// 川を渡る回数だけを数える古典的な数え方）。

export type RiverSide = "left" | "right";
export type RiverLoc = RiverSide | "boat";
export type RiverStatus = "playing" | "won" | "failed";

export type RiverItemDef = {
  id: string;
  name: string;
  emoji: string;
};

export type RiverProblem = {
  id: string;
  title: string;
  description: string;
  items: RiverItemDef[];
  /** 同じ岸に農夫なしでそろうと失敗するペア（item id の組）。 */
  dangerPairs: [string, string][];
  /** ボートに農夫と一緒に乗せられる荷物の上限。 */
  capacity: number;
};

export const RIVER_PROBLEMS: RiverProblem[] = [
  {
    id: "classic",
    title: "オオカミとヤギとキャベツ",
    description: "古典題。オオカミはヤギを、ヤギはキャベツを食べてしまう。ボートには荷物1つまで。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "goat", name: "ヤギ", emoji: "🐐" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
    ],
    dangerPairs: [
      ["wolf", "goat"],
      ["goat", "cabbage"],
    ],
    capacity: 1,
  },
  {
    id: "fox",
    title: "キツネとニワトリとトウモロコシ",
    description: "キツネはニワトリを、ニワトリはトウモロコシをつついてしまう。ボートには荷物1つまで。",
    items: [
      { id: "fox", name: "キツネ", emoji: "🦊" },
      { id: "chicken", name: "ニワトリ", emoji: "🐔" },
      { id: "corn", name: "トウモロコシ", emoji: "🌽" },
    ],
    dangerPairs: [
      ["fox", "chicken"],
      ["chicken", "corn"],
    ],
    capacity: 1,
  },
  {
    id: "bigboat",
    title: "大きなボート",
    description: "荷物2つまで乗せられる大きなボート。古典題も一気に短くなる。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "goat", name: "ヤギ", emoji: "🐐" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
    ],
    dangerPairs: [
      ["wolf", "goat"],
      ["goat", "cabbage"],
    ],
    capacity: 2,
  },
  {
    id: "pets",
    title: "イヌとネコとネズミとチーズ",
    description: "荷物2つまで。イヌはネコを、ネコはネズミを、ネズミはチーズを追いかける。",
    items: [
      { id: "dog", name: "イヌ", emoji: "🐶" },
      { id: "cat", name: "ネコ", emoji: "🐱" },
      { id: "mouse", name: "ネズミ", emoji: "🐭" },
      { id: "cheese", name: "チーズ", emoji: "🧀" },
    ],
    dangerPairs: [
      ["dog", "cat"],
      ["cat", "mouse"],
      ["mouse", "cheese"],
    ],
    capacity: 2,
  },
  {
    id: "catfish",
    title: "ネコとトリとサカナ",
    description: "ネコはトリもサカナも狙ってしまう。トリとサカナだけなら大丈夫。ボートには荷物1つまで。",
    items: [
      { id: "cat", name: "ネコ", emoji: "🐱" },
      { id: "bird", name: "トリ", emoji: "🐦" },
      { id: "fish", name: "サカナ", emoji: "🐟" },
    ],
    dangerPairs: [
      ["cat", "bird"],
      ["cat", "fish"],
    ],
    capacity: 1,
  },
  {
    id: "flower",
    title: "花といっしょに",
    description: "荷物2つまで。花は誰にも食べられないので、危ない組み合わせを避けるクッションにできる。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "goat", name: "ヤギ", emoji: "🐐" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
      { id: "flower", name: "花", emoji: "🌸" },
    ],
    dangerPairs: [
      ["wolf", "goat"],
      ["goat", "cabbage"],
    ],
    capacity: 2,
  },
  {
    id: "bear",
    title: "クマとハチミツとミツバチ",
    description: "クマはハチミツをなめてしまい、ミツバチには刺されてしまう。クマを他の2つと離しておく。ボートには荷物1つまで。",
    items: [
      { id: "bear", name: "クマ", emoji: "🐻" },
      { id: "honey", name: "ハチミツ", emoji: "🍯" },
      { id: "bee", name: "ミツバチ", emoji: "🐝" },
    ],
    dangerPairs: [
      ["bear", "honey"],
      ["bear", "bee"],
    ],
    capacity: 1,
  },
  {
    id: "farmpets",
    title: "ネコを中心に5匹",
    description: "荷物2つまで。イヌはネコを、ネコはネズミとトリを追いかけ、トリはタマゴをつついてしまう。",
    items: [
      { id: "dog", name: "イヌ", emoji: "🐶" },
      { id: "cat", name: "ネコ", emoji: "🐱" },
      { id: "mouse", name: "ネズミ", emoji: "🐭" },
      { id: "bird", name: "トリ", emoji: "🐦" },
      { id: "egg", name: "タマゴ", emoji: "🥚" },
    ],
    dangerPairs: [
      ["dog", "cat"],
      ["cat", "mouse"],
      ["cat", "bird"],
      ["bird", "egg"],
    ],
    capacity: 2,
  },
  {
    id: "doublechain",
    title: "オオカミ組とキツネ組",
    description: "荷物2つまで。オオカミはヤギを、ヤギはキャベツを、キツネはニワトリを、ニワトリはトウモロコシを狙う。2組のチェーンを同時にさばく。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "goat", name: "ヤギ", emoji: "🐐" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
      { id: "fox", name: "キツネ", emoji: "🦊" },
      { id: "chicken", name: "ニワトリ", emoji: "🐔" },
      { id: "corn", name: "トウモロコシ", emoji: "🌽" },
    ],
    dangerPairs: [
      ["wolf", "goat"],
      ["goat", "cabbage"],
      ["fox", "chicken"],
      ["chicken", "corn"],
    ],
    capacity: 2,
  },
  {
    id: "herd",
    title: "オオカミとイヌとヒツジ",
    description: "荷物2つまで。オオカミはヒツジとイヌを、イヌもヒツジを追いかけ、ヒツジはキャベツも草も食べてしまう。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "sheep", name: "ヒツジ", emoji: "🐑" },
      { id: "dog", name: "イヌ", emoji: "🐶" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
      { id: "grass", name: "草", emoji: "🌿" },
    ],
    dangerPairs: [
      ["wolf", "sheep"],
      ["wolf", "dog"],
      ["dog", "sheep"],
      ["sheep", "cabbage"],
      ["sheep", "grass"],
    ],
    capacity: 2,
  },
  {
    id: "pasture",
    title: "牧場の見張り",
    description: "荷物2つまで。オオカミはヒツジもヤギも狙い、ヒツジはキャベツを、ヤギはキャベツもニンジンも食べてしまう。",
    items: [
      { id: "wolf", name: "オオカミ", emoji: "🐺" },
      { id: "sheep", name: "ヒツジ", emoji: "🐑" },
      { id: "goat", name: "ヤギ", emoji: "🐐" },
      { id: "cabbage", name: "キャベツ", emoji: "🥬" },
      { id: "carrot", name: "ニンジン", emoji: "🥕" },
    ],
    dangerPairs: [
      ["wolf", "sheep"],
      ["wolf", "goat"],
      ["sheep", "cabbage"],
      ["goat", "cabbage"],
      ["goat", "carrot"],
    ],
    capacity: 2,
  },
  {
    id: "foxhole",
    title: "キツネと2つのエサ",
    description: "荷物2つまで。キツネはウサギもニワトリも狙い、ウサギはニンジンを、ニワトリはトウモロコシをつついてしまう。",
    items: [
      { id: "fox", name: "キツネ", emoji: "🦊" },
      { id: "rabbit", name: "ウサギ", emoji: "🐰" },
      { id: "chicken", name: "ニワトリ", emoji: "🐔" },
      { id: "carrot", name: "ニンジン", emoji: "🥕" },
      { id: "corn", name: "トウモロコシ", emoji: "🌽" },
    ],
    dangerPairs: [
      ["fox", "rabbit"],
      ["fox", "chicken"],
      ["rabbit", "carrot"],
      ["chicken", "corn"],
    ],
    capacity: 2,
  },
];

export type RiverState = {
  problemId: string;
  /** 農夫（とボート）のいる岸。 */
  farmerSide: RiverSide;
  /** 各荷物の場所。 */
  locations: Record<string, RiverLoc>;
  /** 川を渡った回数。 */
  crossings: number;
  status: RiverStatus;
  /** 失敗した理由（日本語）。 */
  failMessage: string | null;
};

export function getRiverProblem(problemId: string): RiverProblem {
  return RIVER_PROBLEMS.find((p) => p.id === problemId) ?? RIVER_PROBLEMS[0];
}

export function createRiverGame(problemId: string): RiverState {
  const problem = getRiverProblem(problemId);
  const locations: Record<string, RiverLoc> = {};
  for (const item of problem.items) locations[item.id] = "left";
  return {
    problemId: problem.id,
    farmerSide: "left",
    locations,
    crossings: 0,
    status: "playing",
    failMessage: null,
  };
}

/** 指定した岸にそろっている危険なペアを返す（無ければ null）。荷物の場所は left/right 前提。 */
function dangerOnSide(
  problem: RiverProblem,
  sides: Record<string, RiverSide>,
  side: RiverSide,
): [string, string] | null {
  for (const [x, y] of problem.dangerPairs) {
    if (sides[x] === side && sides[y] === side) return [x, y];
  }
  return null;
}

function dangerMessage(problem: RiverProblem, pair: [string, string]): string {
  const nameOf = (id: string) => problem.items.find((i) => i.id === id)?.name ?? id;
  return `農夫のいない岸で${nameOf(pair[0])}と${nameOf(pair[1])}が一緒になってしまいました。`;
}

/** 荷物をボートに乗せる／岸に降ろす。できない操作は同状態を返す。 */
export function toggleRiverItem(state: RiverState, itemId: string): RiverState {
  if (state.status !== "playing") return state;
  const problem = getRiverProblem(state.problemId);
  const loc = state.locations[itemId];
  if (loc === undefined) return state;
  const locations = { ...state.locations };
  if (loc === "boat") {
    locations[itemId] = state.farmerSide;
    return { ...state, locations };
  }
  if (loc !== state.farmerSide) return state; // 向こう岸の荷物は触れない
  const onBoat = problem.items.filter((i) => state.locations[i.id] === "boat").length;
  if (onBoat >= problem.capacity) return state;
  locations[itemId] = "boat";
  return { ...state, locations };
}

/** 川を渡る。渡った先で農夫のいない岸に危険なペアがそろえば失敗、全て右岸なら成功。 */
export function crossRiver(state: RiverState): RiverState {
  if (state.status !== "playing") return state;
  const problem = getRiverProblem(state.problemId);
  const nextSide: RiverSide = state.farmerSide === "left" ? "right" : "left";
  const locations: Record<string, RiverLoc> = {};
  for (const item of problem.items) {
    const loc = state.locations[item.id];
    locations[item.id] = loc === "boat" ? nextSide : loc;
  }
  const crossings = state.crossings + 1;
  // 農夫のいない岸（出発した岸）だけが危険になりうる。
  const sides: Record<string, RiverSide> = {};
  for (const item of problem.items) sides[item.id] = locations[item.id] as RiverSide;
  const danger = dangerOnSide(problem, sides, state.farmerSide);
  if (danger) {
    return {
      ...state,
      farmerSide: nextSide,
      locations,
      crossings,
      status: "failed",
      failMessage: dangerMessage(problem, danger),
    };
  }
  const won = problem.items.every((i) => locations[i.id] === "right");
  return {
    ...state,
    farmerSide: nextSide,
    locations,
    crossings,
    status: won ? "won" : "playing",
  };
}

/** 全状態を幅優先探索して最短の渡河回数を返す。解けない問題は -1。 */
export function riverMinCrossings(problem: RiverProblem): number {
  const n = problem.items.length;
  const indexOf = new Map(problem.items.map((item, i) => [item.id, i]));
  const pairs = problem.dangerPairs.map(
    ([x, y]) => [indexOf.get(x) as number, indexOf.get(y) as number] as [number, number],
  );
  const isSafeBank = (mask: number, farmerThere: boolean): boolean => {
    if (farmerThere) return true;
    for (const [x, y] of pairs) {
      if ((mask & (1 << x)) !== 0 && (mask & (1 << y)) !== 0) return false;
    }
    return true;
  };
  // 状態: (農夫の岸 0=左/1=右, 右岸にある荷物のビットマスク)
  const fullMask = (1 << n) - 1;
  const key = (farmer: number, mask: number) => farmer * (fullMask + 1) + mask;
  const dist = new Map<number, number>();
  const queue: [number, number][] = [[0, 0]];
  dist.set(key(0, 0), 0);
  while (queue.length > 0) {
    const [farmer, mask] = queue.shift() as [number, number];
    const d = dist.get(key(farmer, mask)) as number;
    if (farmer === 1 && mask === fullMask) return d;
    // 農夫のいる岸にある荷物から capacity 個までの部分集合を選んで一緒に渡る。
    const hereIndices: number[] = [];
    for (let i = 0; i < n; i++) {
      const onRight = (mask & (1 << i)) !== 0;
      if ((farmer === 1) === onRight) hereIndices.push(i);
    }
    const subsets: number[][] = [[]];
    for (const i of hereIndices) {
      const cur = subsets.length;
      for (let k = 0; k < cur; k++) {
        if (subsets[k].length < problem.capacity) subsets.push([...subsets[k], i]);
      }
    }
    for (const carry of subsets) {
      let nextMask = mask;
      for (const i of carry) {
        nextMask = farmer === 0 ? nextMask | (1 << i) : nextMask & ~(1 << i);
      }
      // 出発する岸に残る荷物が、農夫なしで安全かを確認する。
      const leftBehindMask = farmer === 0 ? (~nextMask & fullMask) : nextMask;
      if (!isSafeBank(leftBehindMask, false)) continue;
      const nk = key(1 - farmer, nextMask);
      if (!dist.has(nk)) {
        dist.set(nk, d + 1);
        queue.push([1 - farmer, nextMask]);
      }
    }
  }
  return -1;
}
