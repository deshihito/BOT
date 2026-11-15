// AGO WORLD BOX のアイテム定義（純粋ロジック）。
// Discord ボット側の経済機能（core/general/items・workshop/craft・
// circulation/steal）の仕組みをワールドボックスに持ち込んだもの。
// カタログは「入口としての物量」を優先し、データ追加だけで厚くする:
// 食事・素材・合成品・特殊に加え、道具（斧/ツルハシ/剣/クワ×素材3段）、
// ブロック（耐久つき）、種と作物、家具を用意する。
// 効果が未実装のアイテムは作らない（ボット側 items.py と同じ方針）。

export type ItemCategory =
  | "food" | "material" | "crafted" | "special"
  | "tool" | "block" | "seed" | "crop" | "furniture";

/** 道具の種類。ワールド上の行為（伐採・採掘・耕作・戦闘）の前提になる。 */
export type ToolKind = "axe" | "pickaxe" | "sword" | "hoe";

export type ItemDef = {
  id: string;
  name: string;
  desc: string;
  category: ItemCategory;
  /** ショップの販売価格（コイン）。売却はこの割合（SELL_RATE）。 */
  price: number;
  /** 食べたときの空腹度回復量（food / crop のみ）。 */
  hunger?: number;
  /** 道具の種類（tool のみ）。 */
  tool?: ToolKind;
  /** 道具の素材段位 1=木 2=石 3=鉄（tool のみ）。 */
  tier?: number;
  /** 耐久の目安（block=壊されにくさ、tool=使用回数）。 */
  durability?: number;
};

export const ITEMS: readonly ItemDef[] = [
  // ---- 食事（食べると空腹度が回復する） -------------------------------
  { id: "wheat", name: "小麦", desc: "そのままでも少し食べられる素材", category: "food", price: 6, hunger: 5 },
  { id: "bread", name: "パン", desc: "軽くつまむ", category: "food", price: 10, hunger: 20 },
  { id: "onigiri", name: "おにぎり", desc: "手軽な携行食", category: "food", price: 15, hunger: 30 },
  { id: "energy_drink", name: "エナジードリンク", desc: "すばやく回復", category: "food", price: 25, hunger: 15 },
  { id: "meal", name: "定食", desc: "しっかり食べる", category: "food", price: 30, hunger: 55 },
  { id: "cake", name: "ケーキ", desc: "甘いごほうび", category: "food", price: 40, hunger: 45 },
  { id: "bento", name: "幕の内弁当", desc: "品数たっぷり", category: "food", price: 45, hunger: 80 },
  { id: "feast", name: "フルコース", desc: "満腹まで食べる", category: "food", price: 50, hunger: 100 },
  // ---- 素材（合成の材料） ---------------------------------------------
  { id: "wood", name: "木材", desc: "基本の素材", category: "material", price: 8 },
  { id: "stone", name: "石材", desc: "基本の素材", category: "material", price: 8 },
  { id: "herb", name: "薬草", desc: "薬の素材になる草", category: "material", price: 12 },
  { id: "cloth", name: "布", desc: "織物の素材", category: "material", price: 16 },
  { id: "glass", name: "ガラス", desc: "透明な素材", category: "material", price: 18 },
  { id: "iron_ore", name: "鉄鉱石", desc: "金属の素材", category: "material", price: 20 },
  { id: "gold_ore", name: "金鉱石", desc: "高価な金属の素材", category: "material", price: 60 },
  { id: "mithril", name: "ミスリル", desc: "希少な魔法金属", category: "material", price: 150 },
  // ---- 合成品（合成で作る。売ると素材代より高くなる） -----------------
  { id: "carving", name: "木彫りの置物", desc: "木材を彫った工芸品", category: "crafted", price: 45 },
  { id: "lantern", name: "石のランタン", desc: "石とガラスの明かり", category: "crafted", price: 60 },
  { id: "blanket", name: "毛布", desc: "布を重ねた防寒具", category: "crafted", price: 56 },
  { id: "potion", name: "薬草ポーション", desc: "飲むと空腹度が大きく回復", category: "crafted", price: 76, hunger: 60 },
  { id: "toolbox", name: "鉄の道具箱", desc: "鉄と木の実用品", category: "crafted", price: 85 },
  { id: "tent", name: "テント", desc: "布と木の野営道具", category: "crafted", price: 110 },
  { id: "accessory", name: "金のアクセサリー", desc: "金とガラスの装飾品", category: "crafted", price: 140 },
  { id: "special_course", name: "特上コース料理", desc: "定食を超える一品", category: "crafted", price: 130, hunger: 100 },
  // ---- 特殊（所持しているだけで効く） ---------------------------------
  { id: "guard_charm", name: "防犯チャーム", desc: "持っていると steal されなくなる", category: "special", price: 200 },
  { id: "thief_mask", name: "怪盗マスク", desc: "持っていると steal の成功率が上がる", category: "special", price: 200 },
  { id: "star_shard", name: "星の欠片", desc: "合成のレア結果でたまに手に入る", category: "special", price: 300 },
  { id: "crown", name: "王冠", desc: "最高峰の合成品", category: "special", price: 500 },
  // ---- 道具（斧=伐採、ツルハシ=採掘、剣=戦闘、クワ=耕作。木/石/鉄の3段） --
  { id: "wooden_axe", name: "木の斧", desc: "木を伐る道具", category: "tool", price: 60, tool: "axe", tier: 1, durability: 60 },
  { id: "stone_axe", name: "石の斧", desc: "木を伐る道具", category: "tool", price: 110, tool: "axe", tier: 2, durability: 130 },
  { id: "iron_axe", name: "鉄の斧", desc: "木を伐る道具", category: "tool", price: 220, tool: "axe", tier: 3, durability: 250 },
  { id: "wooden_pickaxe", name: "木のツルハシ", desc: "岩を掘る道具", category: "tool", price: 60, tool: "pickaxe", tier: 1, durability: 60 },
  { id: "stone_pickaxe", name: "石のツルハシ", desc: "岩を掘る道具", category: "tool", price: 110, tool: "pickaxe", tier: 2, durability: 130 },
  { id: "iron_pickaxe", name: "鉄のツルハシ", desc: "岩を掘る道具", category: "tool", price: 220, tool: "pickaxe", tier: 3, durability: 250 },
  { id: "wooden_sword", name: "木の剣", desc: "戦う道具", category: "tool", price: 60, tool: "sword", tier: 1, durability: 60 },
  { id: "stone_sword", name: "石の剣", desc: "戦う道具", category: "tool", price: 110, tool: "sword", tier: 2, durability: 130 },
  { id: "iron_sword", name: "鉄の剣", desc: "戦う道具", category: "tool", price: 220, tool: "sword", tier: 3, durability: 250 },
  { id: "wooden_hoe", name: "木のクワ", desc: "地面を耕す道具", category: "tool", price: 60, tool: "hoe", tier: 1, durability: 60 },
  { id: "stone_hoe", name: "石のクワ", desc: "地面を耕す道具", category: "tool", price: 110, tool: "hoe", tier: 2, durability: 130 },
  { id: "iron_hoe", name: "鉄のクワ", desc: "地面を耕す道具", category: "tool", price: 220, tool: "hoe", tier: 3, durability: 250 },
  // ---- ブロック（置く素材。耐久で壊されにくさが違う。設置は次フェーズ） --
  { id: "dirt_block", name: "土ブロック", desc: "置ける土", category: "block", price: 4, durability: 5 },
  { id: "sand_block", name: "砂ブロック", desc: "置ける砂", category: "block", price: 4, durability: 5 },
  { id: "snow_block", name: "雪ブロック", desc: "置ける雪", category: "block", price: 4, durability: 5 },
  { id: "mud_block", name: "泥ブロック", desc: "置ける泥", category: "block", price: 5, durability: 6 },
  { id: "grass_block", name: "草ブロック", desc: "置ける草地", category: "block", price: 6, durability: 8 },
  { id: "gravel_block", name: "砂利ブロック", desc: "置ける砂利", category: "block", price: 5, durability: 8 },
  { id: "moss_block", name: "苔ブロック", desc: "置ける苔", category: "block", price: 8, durability: 8 },
  { id: "clay_block", name: "粘土ブロック", desc: "置ける粘土", category: "block", price: 8, durability: 10 },
  { id: "packed_snow_block", name: "圧雪ブロック", desc: "固めた雪", category: "block", price: 8, durability: 12 },
  { id: "wool_block", name: "羊毛ブロック", desc: "柔らかい塊", category: "block", price: 58, durability: 12 },
  { id: "hay_bale", name: "干し草ブロック", desc: "干し草の束", category: "block", price: 45, durability: 10 },
  { id: "ice_block", name: "氷ブロック", desc: "置ける氷", category: "block", price: 12, durability: 15 },
  { id: "charcoal_block", name: "木炭ブロック", desc: "木炭の塊", category: "block", price: 72, durability: 15 },
  { id: "bamboo_block", name: "竹ブロック", desc: "竹を束ねた塊", category: "block", price: 14, durability: 18 },
  { id: "planks_block", name: "板材ブロック", desc: "木の板", category: "block", price: 30, durability: 20 },
  { id: "oak_log", name: "オークの原木", desc: "置ける原木", category: "block", price: 12, durability: 25 },
  { id: "pine_log", name: "松の原木", desc: "置ける原木", category: "block", price: 12, durability: 25 },
  { id: "birch_log", name: "白樺の原木", desc: "置ける原木", category: "block", price: 12, durability: 25 },
  { id: "bone_block", name: "骨ブロック", desc: "骨の塊", category: "block", price: 100, durability: 25 },
  { id: "sandstone_block", name: "砂岩ブロック", desc: "置ける砂岩", category: "block", price: 20, durability: 35 },
  { id: "stone_block", name: "石ブロック", desc: "置ける石", category: "block", price: 16, durability: 40 },
  { id: "cobblestone_block", name: "丸石ブロック", desc: "丸石の塊", category: "block", price: 18, durability: 45 },
  { id: "brick_block", name: "レンガブロック", desc: "焼いたレンガ", category: "block", price: 45, durability: 55 },
  { id: "stone_brick_block", name: "石レンガブロック", desc: "石を組んだ塊", category: "block", price: 56, durability: 60 },
  { id: "glass_block", name: "ガラスブロック", desc: "透明な塊（脆い）", category: "block", price: 65, durability: 10 },
  { id: "glowstone_block", name: "発光石ブロック", desc: "淡く光る石", category: "block", price: 45, durability: 30 },
  { id: "bookshelf_block", name: "本棚ブロック", desc: "本の詰まった棚", category: "block", price: 40, durability: 30 },
  { id: "slime_block", name: "スライムブロック", desc: "弾む塊", category: "block", price: 40, durability: 15 },
  { id: "crystal_block", name: "水晶ブロック", desc: "水晶の塊", category: "block", price: 90, durability: 80 },
  { id: "gold_block", name: "金ブロック", desc: "金の塊", category: "block", price: 120, durability: 100 },
  { id: "iron_block", name: "鉄ブロック", desc: "鉄の塊", category: "block", price: 80, durability: 120 },
  { id: "obsidian_block", name: "黒曜石ブロック", desc: "非常に硬い塊", category: "block", price: 150, durability: 300 },
  { id: "mithril_block", name: "ミスリルブロック", desc: "希少金属の塊", category: "block", price: 300, durability: 200 },
  // ---- 素材（追加分） ---------------------------------------------------
  { id: "stick", name: "棒", desc: "道具の柄になる", category: "material", price: 4 },
  { id: "fiber", name: "繊維", desc: "草から取れる素材", category: "material", price: 6 },
  { id: "clay", name: "粘土", desc: "焼くとレンガになる", category: "material", price: 6 },
  { id: "paper", name: "紙", desc: "本や記録の素材", category: "material", price: 7 },
  { id: "string", name: "糸", desc: "繊維を撚った素材", category: "material", price: 8 },
  { id: "bamboo", name: "竹", desc: "軽くて丈夫な素材", category: "material", price: 9 },
  { id: "charcoal", name: "木炭", desc: "燃料になる素材", category: "material", price: 10 },
  { id: "feather", name: "羽根", desc: "軽い素材", category: "material", price: 10 },
  { id: "bone", name: "骨", desc: "硬い素材", category: "material", price: 14 },
  { id: "slime", name: "スライム", desc: "粘る素材", category: "material", price: 22 },
  { id: "leather", name: "革", desc: "丈夫な素材", category: "material", price: 24 },
  { id: "iron_ingot", name: "鉄インゴット", desc: "精錬した鉄", category: "material", price: 34 },
  { id: "gold_ingot", name: "金インゴット", desc: "精錬した金", category: "material", price: 95 },
  // ---- 種（畑に植えると作物が育つ） -------------------------------------
  { id: "wheat_seed", name: "小麦の種", desc: "畑に植える種", category: "seed", price: 6 },
  { id: "carrot_seed", name: "ニンジンの種", desc: "畑に植える種", category: "seed", price: 8 },
  { id: "potato_seed", name: "ジャガイモの種", desc: "畑に植える種芋", category: "seed", price: 8 },
  { id: "cabbage_seed", name: "キャベツの種", desc: "畑に植える種", category: "seed", price: 8 },
  { id: "strawberry_seed", name: "イチゴの種", desc: "畑に植える種", category: "seed", price: 12 },
  { id: "tomato_seed", name: "トマトの種", desc: "畑に植える種", category: "seed", price: 12 },
  { id: "corn_seed", name: "トウモロコシの種", desc: "畑に植える種", category: "seed", price: 12 },
  { id: "rice_seed", name: "米の種", desc: "畑に植える種もみ", category: "seed", price: 12 },
  { id: "pumpkin_seed", name: "カボチャの種", desc: "畑に植える種", category: "seed", price: 16 },
  { id: "melon_seed", name: "メロンの種", desc: "畑に植える種", category: "seed", price: 18 },
  // ---- 作物（収穫物。そのまま食べられるものも多い） -----------------------
  { id: "carrot", name: "ニンジン", desc: "収穫した作物", category: "crop", price: 10, hunger: 12 },
  { id: "potato", name: "ジャガイモ", desc: "収穫した作物", category: "crop", price: 10, hunger: 12 },
  { id: "cabbage", name: "キャベツ", desc: "収穫した作物", category: "crop", price: 10, hunger: 8 },
  { id: "rice", name: "米", desc: "収穫した作物", category: "crop", price: 12, hunger: 5 },
  { id: "tomato", name: "トマト", desc: "収穫した作物", category: "crop", price: 12, hunger: 8 },
  { id: "corn", name: "トウモロコシ", desc: "収穫した作物", category: "crop", price: 14, hunger: 10 },
  { id: "strawberry", name: "イチゴ", desc: "収穫した作物", category: "crop", price: 16, hunger: 15 },
  { id: "pumpkin", name: "カボチャ", desc: "収穫した作物", category: "crop", price: 28, hunger: 6 },
  { id: "melon", name: "メロン", desc: "収穫した作物", category: "crop", price: 34, hunger: 8 },
  // ---- 食事（追加分。作物から作る） --------------------------------------
  { id: "grilled_corn", name: "焼きトウモロコシ", desc: "香ばしい一本", category: "food", price: 26, hunger: 25 },
  { id: "corn_soup", name: "コーンスープ", desc: "温かいスープ", category: "food", price: 50, hunger: 40 },
  { id: "salad", name: "サラダ", desc: "畑の盛り合わせ", category: "food", price: 56, hunger: 35 },
  { id: "pumpkin_pie", name: "パンプキンパイ", desc: "甘い焼き菓子", category: "food", price: 60, hunger: 50 },
  // ---- 家具・装飾（ロビーの調度と同じ系統。設置は次フェーズ） -------------
  { id: "bench", name: "ベンチ", desc: "座れる家具", category: "furniture", price: 30 },
  { id: "chair", name: "椅子", desc: "座れる家具", category: "furniture", price: 30 },
  { id: "sign_board", name: "看板", desc: "目印の板", category: "furniture", price: 35 },
  { id: "hedge", name: "生け垣", desc: "緑の仕切り", category: "furniture", price: 35 },
  { id: "planter", name: "プランター", desc: "花を植える箱", category: "furniture", price: 38 },
  { id: "barrel", name: "樽", desc: "物を入れる樽", category: "furniture", price: 45 },
  { id: "crate", name: "木箱", desc: "物を入れる箱", category: "furniture", price: 45 },
  { id: "fence_wood", name: "木の柵", desc: "区切りの柵", category: "furniture", price: 45 },
  { id: "lamp", name: "ランプ", desc: "明かり", category: "furniture", price: 50 },
  { id: "item_shelf", name: "棚", desc: "物を並べる棚", category: "furniture", price: 55 },
  { id: "table_round", name: "丸テーブル", desc: "囲める机", category: "furniture", price: 60 },
  { id: "tapestry", name: "タペストリー", desc: "壁に掛ける布", category: "furniture", price: 75 },
  { id: "bookshelf", name: "本棚", desc: "本を収める棚", category: "furniture", price: 70 },
  { id: "sofa", name: "ソファ", desc: "くつろぐ家具", category: "furniture", price: 120 },
  { id: "piano", name: "ピアノ", desc: "大きな楽器", category: "furniture", price: 200 },
];

const ITEM_BY_ID = new Map(ITEMS.map((item) => [item.id, item]));

export function itemById(id: unknown): ItemDef | null {
  return typeof id === "string" ? ITEM_BY_ID.get(id) ?? null : null;
}

/** 売却価格（販売価格の6割）。 */
export const SELL_RATE = 0.6;
export function sellPrice(item: ItemDef): number {
  return Math.max(1, Math.floor(item.price * SELL_RATE));
}

// ---------------------------------------------------------------- 合成
// ボット側 workshop/craft と同じ「2種の素材を組み合わせる」方式。
export type Recipe = {
  id: string;
  inputs: Readonly<Record<string, number>>;
  output: string;
  outputCount: number;
  /** 成功時に追加でレアアイテムが落ちる確率（0〜1）。 */
  rareItem?: string;
  rareChance?: number;
};

export const RECIPES: readonly Recipe[] = [
  { id: "carving", inputs: { wood: 3 }, output: "carving", outputCount: 1 },
  { id: "lantern", inputs: { stone: 2, glass: 1 }, output: "lantern", outputCount: 1 },
  { id: "blanket", inputs: { cloth: 2 }, output: "blanket", outputCount: 1 },
  { id: "potion", inputs: { herb: 2, glass: 1 }, output: "potion", outputCount: 1, rareItem: "star_shard", rareChance: 0.05 },
  { id: "toolbox", inputs: { iron_ore: 2, wood: 1 }, output: "toolbox", outputCount: 1 },
  { id: "tent", inputs: { cloth: 3, wood: 2 }, output: "tent", outputCount: 1 },
  { id: "accessory", inputs: { gold_ore: 1, glass: 1 }, output: "accessory", outputCount: 1, rareItem: "star_shard", rareChance: 0.08 },
  { id: "special_course", inputs: { meal: 1, wheat: 2, herb: 1 }, output: "special_course", outputCount: 1 },
  { id: "bread", inputs: { wheat: 2 }, output: "bread", outputCount: 1 },
  { id: "crown", inputs: { accessory: 1, mithril: 1 }, output: "crown", outputCount: 1 },
  // 道具（木/石/鉄 × 斧/ツルハシ/剣/クワ）
  { id: "wooden_axe", inputs: { wood: 3, stick: 2 }, output: "wooden_axe", outputCount: 1 },
  { id: "wooden_pickaxe", inputs: { wood: 3, stick: 2 }, output: "wooden_pickaxe", outputCount: 1 },
  { id: "wooden_sword", inputs: { wood: 2, stick: 1 }, output: "wooden_sword", outputCount: 1 },
  { id: "wooden_hoe", inputs: { wood: 2, stick: 2 }, output: "wooden_hoe", outputCount: 1 },
  { id: "stone_axe", inputs: { stone: 3, stick: 2 }, output: "stone_axe", outputCount: 1 },
  { id: "stone_pickaxe", inputs: { stone: 3, stick: 2 }, output: "stone_pickaxe", outputCount: 1 },
  { id: "stone_sword", inputs: { stone: 2, stick: 1 }, output: "stone_sword", outputCount: 1 },
  { id: "stone_hoe", inputs: { stone: 2, stick: 2 }, output: "stone_hoe", outputCount: 1 },
  { id: "iron_axe", inputs: { iron_ore: 3, stick: 2 }, output: "iron_axe", outputCount: 1 },
  { id: "iron_pickaxe", inputs: { iron_ore: 3, stick: 2 }, output: "iron_pickaxe", outputCount: 1 },
  { id: "iron_sword", inputs: { iron_ore: 2, stick: 1 }, output: "iron_sword", outputCount: 1 },
  { id: "iron_hoe", inputs: { iron_ore: 2, stick: 2 }, output: "iron_hoe", outputCount: 1 },
  // ブロック
  { id: "planks_block", inputs: { wood: 2 }, output: "planks_block", outputCount: 1 },
  { id: "stone_brick_block", inputs: { stone: 4 }, output: "stone_brick_block", outputCount: 1 },
  { id: "brick_block", inputs: { clay: 4 }, output: "brick_block", outputCount: 1 },
  { id: "glass_block", inputs: { glass: 2 }, output: "glass_block", outputCount: 1 },
  { id: "charcoal_block", inputs: { charcoal: 4 }, output: "charcoal_block", outputCount: 1 },
  { id: "hay_bale", inputs: { wheat: 4 }, output: "hay_bale", outputCount: 1 },
  { id: "bone_block", inputs: { bone: 4 }, output: "bone_block", outputCount: 1 },
  { id: "wool_block", inputs: { cloth: 2 }, output: "wool_block", outputCount: 1 },
  // 作物料理
  { id: "grilled_corn", inputs: { corn: 1 }, output: "grilled_corn", outputCount: 1 },
  { id: "corn_soup", inputs: { corn: 2 }, output: "corn_soup", outputCount: 1 },
  { id: "salad", inputs: { cabbage: 1, tomato: 1, carrot: 1 }, output: "salad", outputCount: 1 },
  { id: "pumpkin_pie", inputs: { pumpkin: 1, wheat: 1 }, output: "pumpkin_pie", outputCount: 1 },
  // 家具
  { id: "bench", inputs: { wood: 2 }, output: "bench", outputCount: 1 },
  { id: "chair", inputs: { wood: 2 }, output: "chair", outputCount: 1 },
  { id: "crate", inputs: { wood: 3 }, output: "crate", outputCount: 1 },
  { id: "barrel", inputs: { wood: 3 }, output: "barrel", outputCount: 1 },
  { id: "fence_wood", inputs: { wood: 2, stick: 2 }, output: "fence_wood", outputCount: 1 },
  { id: "sign_board", inputs: { wood: 2, stick: 1 }, output: "sign_board", outputCount: 1 },
  { id: "planter", inputs: { clay: 2, wood: 1 }, output: "planter", outputCount: 1 },
  { id: "table_round", inputs: { wood: 4 }, output: "table_round", outputCount: 1 },
  { id: "item_shelf", inputs: { wood: 3, stick: 2 }, output: "item_shelf", outputCount: 1 },
  { id: "bookshelf", inputs: { wood: 3, paper: 2 }, output: "bookshelf", outputCount: 1 },
  { id: "lamp", inputs: { glass: 1, charcoal: 1 }, output: "lamp", outputCount: 1 },
  { id: "hedge", inputs: { fiber: 3 }, output: "hedge", outputCount: 1 },
  { id: "sofa", inputs: { cloth: 3, wood: 2 }, output: "sofa", outputCount: 1 },
  { id: "tapestry", inputs: { cloth: 2, string: 1 }, output: "tapestry", outputCount: 1 },
  { id: "piano", inputs: { wood: 5, iron_ore: 2 }, output: "piano", outputCount: 1 },
];

export function recipeById(id: unknown): Recipe | null {
  return typeof id === "string" ? RECIPES.find((r) => r.id === id) ?? null : null;
}

// ---------------------------------------------------------------- steal
// ボット側 circulation/steal の規則をワールドボックスの経済規模に合わせて
// 縮小したもの（成功率・割合の考え方は同じ）。
/** steal の成功率。 */
export const STEAL_SUCCESS_RATE = 0.4;
/** 奪える額 = 対象の所持金 × この割合（上限つき）。 */
export const STEAL_BALANCE_RATE = 0.05;
/** 奪える額の絶対上限。 */
export const STEAL_MAX_AMOUNT = 50;
/** 対象の所持金がこれ未満なら保護されて盗めない。 */
export const STEAL_TARGET_MIN_COINS = 50;
/** 失敗時に相手へ払う罰金。 */
export const STEAL_FINE_AMOUNT = 20;
/** steal 実行者のクールダウン（秒）。 */
export const STEAL_ACTOR_COOLDOWN_SECONDS = 600;
/** steal された人の保護期間（秒）。 */
export const STEAL_TARGET_COOLDOWN_SECONDS = 3600;
/** 怪盗マスク所持時の成功率ボーナス。 */
export const THIEF_MASK_BONUS = 0.15;

// ---------------------------------------------------------------- 労働
/** 労働1回の空腹度コストと報酬（仕様書の「労働」）。 */
export const WORK_HUNGER_COST = 10;
export const WORK_REWARD_COINS = 20;

// ---------------------------------------------------------------- 作物
// 畑は「設置」ではなく、地面を耕して好きな作物を植える。種アイテムを
// 消費し、growthMinutes 経つと produceId を produceCount 個収穫できる。
export type CropDef = {
  id: string;
  /** 植える種アイテム。 */
  seedId: string;
  /** 収穫で得られるアイテム。 */
  produceId: string;
  /** 植えてから収穫できるまでの分数。 */
  growthMinutes: number;
  /** 1株からの収穫数。 */
  produceCount: number;
};

export const CROPS: readonly CropDef[] = [
  { id: "wheat", seedId: "wheat_seed", produceId: "wheat", growthMinutes: 10, produceCount: 2 },
  { id: "carrot", seedId: "carrot_seed", produceId: "carrot", growthMinutes: 12, produceCount: 2 },
  { id: "potato", seedId: "potato_seed", produceId: "potato", growthMinutes: 15, produceCount: 2 },
  { id: "cabbage", seedId: "cabbage_seed", produceId: "cabbage", growthMinutes: 16, produceCount: 2 },
  { id: "strawberry", seedId: "strawberry_seed", produceId: "strawberry", growthMinutes: 14, produceCount: 3 },
  { id: "tomato", seedId: "tomato_seed", produceId: "tomato", growthMinutes: 20, produceCount: 2 },
  { id: "corn", seedId: "corn_seed", produceId: "corn", growthMinutes: 18, produceCount: 2 },
  { id: "rice", seedId: "rice_seed", produceId: "rice", growthMinutes: 22, produceCount: 2 },
  { id: "pumpkin", seedId: "pumpkin_seed", produceId: "pumpkin", growthMinutes: 30, produceCount: 1 },
  { id: "melon", seedId: "melon_seed", produceId: "melon", growthMinutes: 30, produceCount: 1 },
];

export function cropById(id: unknown): CropDef | null {
  return typeof id === "string" ? CROPS.find((c) => c.id === id) ?? null : null;
}

export function cropBySeedId(seedId: unknown): CropDef | null {
  return typeof seedId === "string" ? CROPS.find((c) => c.seedId === seedId) ?? null : null;
}

/** その種類の道具アイテム（素材段位の昇順）。 */
export function itemsWithTool(kind: ToolKind): ItemDef[] {
  return ITEMS.filter((i) => i.tool === kind).sort((a, b) => (a.tier ?? 0) - (b.tier ?? 0));
}
