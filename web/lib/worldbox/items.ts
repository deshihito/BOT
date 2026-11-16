// AGO WORLD BOX のアイテム定義（純粋ロジック）。
// Discord ボット側の経済機能（core/general/items・workshop/craft・
// circulation/steal）の仕組みをワールドボックスに持ち込んだもの。
// カタログは「入口としての物量」を優先し、データ追加だけで厚くする:
// 食事・素材・合成品・特殊に加え、道具（斧/ツルハシ/剣/クワ×素材4段）、
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
  /** 食べた・使ったときの HP 回復量（食事の一部と薬）。 */
  heal?: number;
  /** 使うと毒を治す（薬・一部の飲み物）。 */
  curePoison?: boolean;
  /** 食べると付く持続効果（warm=空腹が減りにくい / alert=満腹時に少しずつ回復）。 */
  buff?: { kind: "warm" | "alert"; minutes: number };
  /** 食べた/飲んだ後に手元へ戻る容器のアイテム ID（水入りバケツ→バケツ）。 */
  containerReturn?: string;
  /** 道具の種類（tool のみ）。 */
  tool?: ToolKind;
  /** 道具の素材段位 1=木 2=石 3=鉄（tool のみ）。 */
  tier?: number;
  /** 耐久の目安（block=壊されにくさ、tool=使用回数）。 */
  durability?: number;
  /**
   * 施設（作業台・家具など）: ブロック層に置くと、そのマスを占有する
   * （他のブロック/施設は置けない）が、移動の当たり判定は持たず
   * プレイヤーは通過できる。固体ブロックとの区別はこのデータで持つ。
   */
  facility?: boolean;
  /**
   * この素材はそのままこのブロックとして置ける（基本素材の直接設置）。
   * 消費は素材側、設置されるブロックは placesBlock の定義で描画・耐久・回収される。
   */
  placesBlock?: string;
  /** 硬いブロック（耐久50以上）を掘るのに要る道具（block のみ）。 */
  mineTool?: "axe" | "pickaxe";
  /** ドット絵アイコンのパス（public 配下）。無いアイテムは文字で出す。 */
  icon?: string;
};

export const ITEMS: readonly ItemDef[] = [
  // ---- 食事（食べると空腹度が回復する） -------------------------------
  { id: "wheat", name: "小麦", desc: "そのままでも少し食べられる素材", category: "food", price: 60, hunger: 5 },
  { id: "bread", name: "パン", desc: "軽くつまむ", category: "food", price: 100, hunger: 20 },
  { id: "onigiri", name: "おにぎり", desc: "手軽な携行食", category: "food", price: 150, hunger: 30 },
  { id: "energy_drink", name: "エナジードリンク", desc: "すばやく回復", category: "food", price: 250, hunger: 15 },
  { id: "water_bucket", name: "水入りバケツ", desc: "井戸で汲んだ水。飲むとバケツに戻る", category: "food", price: 100, hunger: 10, containerReturn: "bucket" },
  { id: "meal", name: "定食", desc: "しっかり食べる", category: "food", price: 300, hunger: 55, heal: 8 },
  { id: "cake", name: "ケーキ", desc: "甘いごほうび", category: "food", price: 400, hunger: 45 },
  { id: "bento", name: "幕の内弁当", desc: "品数たっぷり", category: "food", price: 450, hunger: 80 },
  { id: "feast", name: "フルコース", desc: "満腹まで食べる", category: "food", price: 500, hunger: 100, heal: 20 },
  // ---- 素材（合成の材料） ---------------------------------------------
  { id: "wood", name: "木材", desc: "基本の素材", category: "material", price: 80, placesBlock: "oak_log" },
  { id: "stone", name: "石材", desc: "基本の素材", category: "material", price: 80, placesBlock: "stone_block" },
  { id: "herb", name: "薬草", desc: "薬の素材になる草", category: "material", price: 120 },
  { id: "cloth", name: "布", desc: "織物の素材", category: "material", price: 160 },
  { id: "glass", name: "ガラス", desc: "透明な素材", category: "material", price: 180 },
  { id: "iron_ore", name: "鉄鉱石", desc: "金属の素材", category: "material", price: 200 },
  { id: "gold_ore", name: "金鉱石", desc: "高価な金属の素材", category: "material", price: 600 },
  { id: "mithril", name: "ミスリル", desc: "希少な魔法金属", category: "material", price: 1500 },
  // ---- 合成品（合成で作る。売ると素材代より高くなる） -----------------
  { id: "carving", name: "木彫りの置物", desc: "木材を彫った工芸品", category: "crafted", price: 450 },
  { id: "lantern", name: "石のランタン", desc: "石とガラスの明かり", category: "crafted", price: 600 },
  { id: "blanket", name: "毛布", desc: "布を重ねた防寒具", category: "crafted", price: 560 },
  { id: "potion", name: "薬草ポーション", desc: "飲むと空腹度とHPが回復し、毒も治す", category: "crafted", price: 760, hunger: 60, heal: 35, curePoison: true },
  { id: "antidote", name: "解毒薬", desc: "毒を治す薬", category: "crafted", price: 950, heal: 5, curePoison: true },
  { id: "bandage", name: "包帯", desc: "巻くとHPが回復する", category: "crafted", price: 600, heal: 25 },
  { id: "toolbox", name: "鉄の道具箱", desc: "鉄と木の実用品", category: "crafted", price: 850 },
  { id: "tent", name: "テント", desc: "布と木の野営道具", category: "crafted", price: 1100, facility: true },
  { id: "accessory", name: "金のアクセサリー", desc: "金とガラスの装飾品", category: "crafted", price: 1400 },
  { id: "special_course", name: "特上コース料理", desc: "定食を超える一品", category: "crafted", price: 1300, hunger: 100, heal: 20 },
  // ---- 特殊（所持しているだけで効く） ---------------------------------
  { id: "guard_charm", name: "防犯チャーム", desc: "持っていると steal されなくなる", category: "special", price: 2000 },
  { id: "thief_mask", name: "怪盗マスク", desc: "持っていると steal の成功率が上がる", category: "special", price: 2000 },
  { id: "star_shard", name: "星の欠片", desc: "合成のレア結果でたまに手に入る", category: "special", price: 3000 },
  { id: "crown", name: "王冠", desc: "最高峰の合成品", category: "special", price: 5000 },
  // ---- 道具（斧=伐採、ツルハシ=採掘、剣=戦闘、クワ=耕作。木/石/鉄の3段） --
  { id: "wooden_axe", name: "木の斧", desc: "木を伐る道具", category: "tool", price: 600, tool: "axe", tier: 1, durability: 60 },
  { id: "stone_axe", name: "石の斧", desc: "木を伐る道具", category: "tool", price: 1100, tool: "axe", tier: 2, durability: 130 },
  { id: "iron_axe", name: "鉄の斧", desc: "木を伐る道具", category: "tool", price: 2200, tool: "axe", tier: 3, durability: 250 },
  { id: "wooden_pickaxe", name: "木のツルハシ", desc: "岩を掘る道具", category: "tool", price: 600, tool: "pickaxe", tier: 1, durability: 60 },
  { id: "stone_pickaxe", name: "石のツルハシ", desc: "岩を掘る道具", category: "tool", price: 1100, tool: "pickaxe", tier: 2, durability: 130 },
  { id: "iron_pickaxe", name: "鉄のツルハシ", desc: "岩を掘る道具", category: "tool", price: 2200, tool: "pickaxe", tier: 3, durability: 250 },
  { id: "wooden_sword", name: "木の剣", desc: "戦う道具", category: "tool", price: 600, tool: "sword", tier: 1, durability: 60 },
  { id: "stone_sword", name: "石の剣", desc: "戦う道具", category: "tool", price: 1100, tool: "sword", tier: 2, durability: 130 },
  { id: "iron_sword", name: "鉄の剣", desc: "戦う道具", category: "tool", price: 2200, tool: "sword", tier: 3, durability: 250 },
  { id: "wooden_hoe", name: "木のクワ", desc: "地面を耕す道具", category: "tool", price: 600, tool: "hoe", tier: 1, durability: 60 },
  { id: "stone_hoe", name: "石のクワ", desc: "地面を耕す道具", category: "tool", price: 1100, tool: "hoe", tier: 2, durability: 130 },
  { id: "iron_hoe", name: "鉄のクワ", desc: "地面を耕す道具", category: "tool", price: 2200, tool: "hoe", tier: 3, durability: 250 },
  // ---- ブロック（置く素材。耐久で壊されにくさが違う。設置は次フェーズ） --
  { id: "dirt_block", name: "土ブロック", desc: "置ける土", category: "block", price: 40, durability: 5 },
  { id: "sand_block", name: "砂ブロック", desc: "置ける砂", category: "block", price: 40, durability: 5 },
  { id: "snow_block", name: "雪ブロック", desc: "置ける雪", category: "block", price: 40, durability: 5 },
  { id: "mud_block", name: "泥ブロック", desc: "置ける泥", category: "block", price: 50, durability: 6 },
  { id: "grass_block", name: "草ブロック", desc: "置ける草地", category: "block", price: 60, durability: 8 },
  { id: "gravel_block", name: "砂利ブロック", desc: "置ける砂利", category: "block", price: 50, durability: 8 },
  { id: "moss_block", name: "苔ブロック", desc: "置ける苔", category: "block", price: 80, durability: 8 },
  { id: "clay_block", name: "粘土ブロック", desc: "置ける粘土", category: "block", price: 80, durability: 10 },
  { id: "packed_snow_block", name: "圧雪ブロック", desc: "固めた雪", category: "block", price: 80, durability: 12 },
  { id: "wool_block", name: "羊毛ブロック", desc: "柔らかい塊", category: "block", price: 580, durability: 12 },
  { id: "hay_bale", name: "干し草ブロック", desc: "干し草の束", category: "block", price: 450, durability: 10 },
  { id: "ice_block", name: "氷ブロック", desc: "置ける氷", category: "block", price: 120, durability: 15 },
  { id: "charcoal_block", name: "木炭ブロック", desc: "木炭の塊", category: "block", price: 720, durability: 15 },
  { id: "bamboo_block", name: "竹ブロック", desc: "竹を束ねた塊", category: "block", price: 140, durability: 18 },
  { id: "planks_block", name: "板材ブロック", desc: "木の板", category: "block", price: 300, durability: 20 },
  { id: "oak_log", name: "オークの原木", desc: "置ける原木", category: "block", price: 120, durability: 25 },
  { id: "pine_log", name: "松の原木", desc: "置ける原木", category: "block", price: 120, durability: 25 },
  { id: "birch_log", name: "白樺の原木", desc: "置ける原木", category: "block", price: 120, durability: 25 },
  { id: "bone_block", name: "骨ブロック", desc: "骨の塊", category: "block", price: 1000, durability: 25 },
  { id: "sandstone_block", name: "砂岩ブロック", desc: "置ける砂岩", category: "block", price: 200, durability: 35 },
  { id: "stone_block", name: "石ブロック", desc: "置ける石", category: "block", price: 160, durability: 40 },
  { id: "cobblestone_block", name: "丸石ブロック", desc: "丸石の塊", category: "block", price: 180, durability: 45 },
  { id: "brick_block", name: "レンガブロック", desc: "焼いたレンガ", category: "block", price: 450, durability: 55, mineTool: "pickaxe" },
  { id: "stone_brick_block", name: "石レンガブロック", desc: "石を組んだ塊", category: "block", price: 560, durability: 60, mineTool: "pickaxe" },
  { id: "glass_block", name: "ガラスブロック", desc: "透明な塊（脆い）", category: "block", price: 650, durability: 10 },
  { id: "glowstone_block", name: "発光石ブロック", desc: "淡く光る石", category: "block", price: 450, durability: 30 },
  { id: "bookshelf_block", name: "本棚ブロック", desc: "本の詰まった棚", category: "block", price: 400, durability: 30 },
  { id: "slime_block", name: "スライムブロック", desc: "弾む塊", category: "block", price: 400, durability: 15 },
  { id: "crystal_block", name: "水晶ブロック", desc: "水晶の塊", category: "block", price: 900, durability: 80, mineTool: "pickaxe" },
  { id: "gold_block", name: "金ブロック", desc: "金の塊", category: "block", price: 1200, durability: 100, mineTool: "pickaxe" },
  { id: "iron_block", name: "鉄ブロック", desc: "鉄の塊", category: "block", price: 800, durability: 120, mineTool: "pickaxe" },
  { id: "obsidian_block", name: "黒曜石ブロック", desc: "非常に硬い塊", category: "block", price: 1500, durability: 300, mineTool: "pickaxe" },
  { id: "mithril_block", name: "ミスリルブロック", desc: "希少金属の塊", category: "block", price: 3000, durability: 200, mineTool: "pickaxe" },
  // ---- 素材（追加分） ---------------------------------------------------
  { id: "stick", name: "棒", desc: "道具の柄になる", category: "material", price: 40 },
  { id: "fiber", name: "繊維", desc: "草から取れる素材", category: "material", price: 60 },
  { id: "clay", name: "粘土", desc: "焼くとレンガになる", category: "material", price: 60 },
  { id: "paper", name: "紙", desc: "本や記録の素材", category: "material", price: 70 },
  { id: "string", name: "糸", desc: "繊維を撚った素材", category: "material", price: 80 },
  { id: "bamboo", name: "竹", desc: "軽くて丈夫な素材", category: "material", price: 90 },
  { id: "charcoal", name: "木炭", desc: "燃料になる素材", category: "material", price: 100 },
  { id: "feather", name: "羽根", desc: "軽い素材", category: "material", price: 100 },
  { id: "bone", name: "骨", desc: "硬い素材", category: "material", price: 140 },
  { id: "slime", name: "スライム", desc: "粘る素材", category: "material", price: 220 },
  // 合成の失敗作（PR-B）: レシピに無い組み合わせで台に入れると生まれる。
  // レシピの材料にはしない（RECIPES には一切載せない）。アイコンは新規
  // png を作らず、塊っぽいスライムの絵を明示指定で流用する
  // （ITEM_ICON_IDS には足さない: 足すと存在しない mystery_lump.png を指す）。
  { id: "mystery_lump", name: "なぞの塊", desc: "合成で生まれた正体不明の塊", category: "material", price: 50, icon: "/img/worldbox/items/slime.png" },
  { id: "leather", name: "革", desc: "丈夫な素材", category: "material", price: 240 },
  { id: "iron_ingot", name: "鉄インゴット", desc: "精錬した鉄", category: "material", price: 340 },
  { id: "gold_ingot", name: "金インゴット", desc: "精錬した金", category: "material", price: 950 },
  // ---- 種（畑に植えると作物が育つ） -------------------------------------
  { id: "wheat_seed", name: "小麦の種", desc: "畑に植える種", category: "seed", price: 60 },
  { id: "carrot_seed", name: "ニンジンの種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "potato_seed", name: "ジャガイモの種", desc: "畑に植える種芋", category: "seed", price: 80 },
  { id: "cabbage_seed", name: "キャベツの種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "strawberry_seed", name: "イチゴの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "tomato_seed", name: "トマトの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "corn_seed", name: "トウモロコシの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "rice_seed", name: "米の種", desc: "畑に植える種もみ", category: "seed", price: 120 },
  { id: "pumpkin_seed", name: "カボチャの種", desc: "畑に植える種", category: "seed", price: 160 },
  { id: "melon_seed", name: "メロンの種", desc: "畑に植える種", category: "seed", price: 180 },
  // ---- 作物（収穫物。そのまま食べられるものも多い） -----------------------
  { id: "carrot", name: "ニンジン", desc: "収穫した作物", category: "crop", price: 100, hunger: 12 },
  { id: "potato", name: "ジャガイモ", desc: "収穫した作物", category: "crop", price: 100, hunger: 12 },
  { id: "cabbage", name: "キャベツ", desc: "収穫した作物", category: "crop", price: 100, hunger: 8 },
  { id: "rice", name: "米", desc: "収穫した作物", category: "crop", price: 120, hunger: 5 },
  { id: "tomato", name: "トマト", desc: "収穫した作物", category: "crop", price: 120, hunger: 8 },
  { id: "corn", name: "トウモロコシ", desc: "収穫した作物", category: "crop", price: 140, hunger: 10 },
  { id: "strawberry", name: "イチゴ", desc: "収穫した作物", category: "crop", price: 160, hunger: 15 },
  { id: "pumpkin", name: "カボチャ", desc: "収穫した作物", category: "crop", price: 280, hunger: 6 },
  { id: "melon", name: "メロン", desc: "収穫した作物", category: "crop", price: 340, hunger: 8 },
  // ---- 食事（追加分。作物から作る） --------------------------------------
  { id: "grilled_corn", name: "焼きトウモロコシ", desc: "香ばしい一本", category: "food", price: 260, hunger: 25 },
  { id: "corn_soup", name: "コーンスープ", desc: "温かいスープ", category: "food", price: 500, hunger: 40 },
  { id: "salad", name: "サラダ", desc: "畑の盛り合わせ", category: "food", price: 560, hunger: 35 },
  { id: "pumpkin_pie", name: "パンプキンパイ", desc: "甘い焼き菓子", category: "food", price: 600, hunger: 50 },
  // ---- 家具・装飾（施設: 占有するが通過できる。当たり判定なし） -------
  { id: "bench", name: "ベンチ", desc: "座れる家具", category: "furniture", price: 300, facility: true },
  { id: "chair", name: "椅子", desc: "座れる家具", category: "furniture", price: 300, facility: true },
  { id: "sign_board", name: "看板", desc: "目印の板", category: "furniture", price: 350, facility: true },
  { id: "hedge", name: "生け垣", desc: "緑の仕切り", category: "furniture", price: 350, facility: true },
  { id: "planter", name: "プランター", desc: "花を植える箱", category: "furniture", price: 380, facility: true },
  { id: "barrel", name: "樽", desc: "物を入れる樽", category: "furniture", price: 450, facility: true },
  { id: "crate", name: "木箱", desc: "物を入れる箱", category: "furniture", price: 450, facility: true },
  { id: "fence_wood", name: "木の柵", desc: "区切りの柵", category: "furniture", price: 450, facility: true },
  { id: "lamp", name: "ランプ", desc: "明かり", category: "furniture", price: 500, facility: true },
  { id: "item_shelf", name: "棚", desc: "物を並べる棚", category: "furniture", price: 550, facility: true },
  { id: "table_round", name: "丸テーブル", desc: "囲める机", category: "furniture", price: 600, facility: true },
  { id: "tapestry", name: "タペストリー", desc: "壁に掛ける布", category: "furniture", price: 750, facility: true },
  { id: "bookshelf", name: "本棚", desc: "本を収める棚", category: "furniture", price: 700, facility: true },
  { id: "sofa", name: "ソファ", desc: "くつろぐ家具", category: "furniture", price: 1200, facility: true },
  { id: "piano", name: "ピアノ", desc: "大きな楽器", category: "furniture", price: 2000, facility: true },
  // ---- 道具（ミスリル段位: 鉄の上の4段目） ------------------------------
  { id: "mithril_axe", name: "ミスリルの斧", desc: "木を伐る道具", category: "tool", price: 8500, tool: "axe", tier: 4, durability: 500 },
  { id: "mithril_pickaxe", name: "ミスリルのツルハシ", desc: "岩を掘る道具", category: "tool", price: 8500, tool: "pickaxe", tier: 4, durability: 500 },
  { id: "mithril_sword", name: "ミスリルの剣", desc: "戦う道具", category: "tool", price: 8500, tool: "sword", tier: 4, durability: 500 },
  { id: "mithril_hoe", name: "ミスリルのクワ", desc: "地面を耕す道具", category: "tool", price: 8500, tool: "hoe", tier: 4, durability: 500 },
  // ---- 道具（特殊: 種別を持たない探索道具） ------------------------------
  // 開拓のコンパス: 所持している間、最も近い洞窟/ダンジョン入口の方向と
  // 距離がミニマップ付近に出る（効果は compass.ts とクライアント側）。
  // tool 種別は持たない（伐採等の道具判定には使わない）。tier が無いので
  // レア品の販売除外（tier 4）にも掛からず、道具屋で通常販売される。
  { id: "explorer_compass", name: "開拓のコンパス", desc: "最も近い洞窟とダンジョンの方向を示す", category: "tool", price: 10000 },
  // ---- 素材（追加分: 金属・宝石・自然素材） ------------------------------
  { id: "copper_ore", name: "銅鉱石", desc: "金属の素材", category: "material", price: 180 },
  { id: "copper_ingot", name: "銅インゴット", desc: "精錬した銅", category: "material", price: 300 },
  { id: "coal", name: "石炭", desc: "燃料になる素材", category: "material", price: 120 },
  { id: "flint", name: "火打石", desc: "火を起こす素材", category: "material", price: 90 },
  { id: "sulfur", name: "硫黄", desc: "洞窟で取れる素材", category: "material", price: 260 },
  { id: "salt", name: "塩", desc: "料理の素材", category: "material", price: 70 },
  { id: "ruby", name: "ルビー", desc: "赤い宝石", category: "material", price: 1800 },
  { id: "sapphire", name: "サファイア", desc: "青い宝石", category: "material", price: 1800 },
  { id: "emerald", name: "エメラルド", desc: "緑の宝石", category: "material", price: 2000 },
  { id: "diamond", name: "ダイヤモンド", desc: "最も硬い宝石", category: "material", price: 2600 },
  { id: "pearl", name: "真珠", desc: "水辺で取れる宝石", category: "material", price: 900 },
  { id: "honey", name: "はちみつ", desc: "甘い素材", category: "material", price: 280 },
  { id: "beeswax", name: "ミツロウ", desc: "巣から取れる素材", category: "material", price: 200 },
  { id: "flower", name: "花", desc: "野に咲く花", category: "material", price: 80 },
  // ---- ブロック（追加分: 防衛・装飾・特殊） ------------------------------
  { id: "copper_block", name: "銅ブロック", desc: "銅の塊", category: "block", price: 2300, durability: 90, mineTool: "pickaxe" },
  { id: "coal_block", name: "石炭ブロック", desc: "石炭の塊", category: "block", price: 950, durability: 20 },
  { id: "bedrock_block", name: "岩盤ブロック", desc: "ほぼ壊れない塊", category: "block", price: 4000, durability: 999, mineTool: "pickaxe" },
  { id: "cactus_block", name: "サボテンブロック", desc: "置けるサボテン", category: "block", price: 140, durability: 8 },
  { id: "leaves_block", name: "葉ブロック", desc: "葉の塊", category: "block", price: 60, durability: 4 },
  { id: "diamond_block", name: "ダイヤブロック", desc: "ダイヤの塊", category: "block", price: 19000, durability: 150, mineTool: "pickaxe" },
  { id: "emerald_block", name: "エメラルドブロック", desc: "エメラルドの塊", category: "block", price: 14500, durability: 130, mineTool: "pickaxe" },
  { id: "ruby_block", name: "ルビーブロック", desc: "ルビーの塊", category: "block", price: 13000, durability: 120, mineTool: "pickaxe" },
  { id: "sapphire_block", name: "サファイアブロック", desc: "サファイアの塊", category: "block", price: 13000, durability: 120, mineTool: "pickaxe" },
  { id: "magma_block", name: "マグマブロック", desc: "熱く光る塊", category: "block", price: 700, durability: 40 },
  { id: "honey_block", name: "はちみつブロック", desc: "はちみつの塊", category: "block", price: 2100, durability: 10 },
  { id: "mushroom_block", name: "キノコブロック", desc: "キノコの塊", category: "block", price: 950, durability: 10 },
  { id: "path_block", name: "小道ブロック", desc: "踏み固めた道", category: "block", price: 60, durability: 6 },
  { id: "flower_block", name: "花壇ブロック", desc: "花の咲く塊", category: "block", price: 160, durability: 6 },
  { id: "pumpkin_block", name: "カボチャブロック", desc: "カボチャの塊", category: "block", price: 400, durability: 12 },
  { id: "melon_block", name: "メロンブロック", desc: "メロンの塊", category: "block", price: 480, durability: 12 },
  // ---- 食事（追加分: 自然の恵みと調理品） --------------------------------
  { id: "egg", name: "たまご", desc: "そのままでも食べられる", category: "food", price: 90, hunger: 5 },
  { id: "raw_meat", name: "生肉", desc: "焼くとおいしい素材", category: "food", price: 140, hunger: 5 },
  { id: "mushroom", name: "キノコ", desc: "森で取れる食材", category: "food", price: 120, hunger: 8 },
  { id: "apple", name: "りんご", desc: "木になる果物", category: "food", price: 140, hunger: 12 },
  { id: "berry", name: "木の実", desc: "茂みで取れる果物", category: "food", price: 110, hunger: 10 },
  { id: "fish", name: "サカナ", desc: "水辺で取れる食材", category: "food", price: 160, hunger: 15 },
  { id: "cookie", name: "クッキー", desc: "甘い焼き菓子", category: "food", price: 750, hunger: 18 },
  { id: "grilled_meat", name: "焼き肉", desc: "焼いた肉", category: "food", price: 380, hunger: 40, heal: 6 },
  { id: "grilled_fish", name: "焼き魚", desc: "焼いた魚", category: "food", price: 300, hunger: 30 },
  { id: "omelette", name: "オムレツ", desc: "たまご料理", category: "food", price: 320, hunger: 35 },
  { id: "baked_potato", name: "ベイクドポテト", desc: "焼いたジャガイモ", category: "food", price: 200, hunger: 25 },
  { id: "stew", name: "シチュー", desc: "具だくさんの煮込み", category: "food", price: 700, hunger: 65, heal: 10, buff: { kind: "warm", minutes: 10 } },
  // ---- 種（追加分） -------------------------------------------------------
  { id: "onion_seed", name: "タマネギの種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "soybean_seed", name: "大豆の種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "cucumber_seed", name: "キュウリの種", desc: "畑に植える種", category: "seed", price: 100 },
  { id: "eggplant_seed", name: "ナスの種", desc: "畑に植える種", category: "seed", price: 100 },
  { id: "sweet_potato_seed", name: "サツマイモの種", desc: "畑に植える種芋", category: "seed", price: 100 },
  { id: "pepper_seed", name: "ピーマンの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "grape_seed", name: "ブドウの種", desc: "畑に植える種", category: "seed", price: 160 },
  { id: "turnip_seed", name: "カブの種", desc: "畑に植える種", category: "seed", price: 80 },
  // ---- 作物（追加分） -----------------------------------------------------
  { id: "onion", name: "タマネギ", desc: "収穫した作物", category: "crop", price: 100, hunger: 6 },
  { id: "soybean", name: "大豆", desc: "収穫した作物", category: "crop", price: 100, hunger: 8 },
  { id: "cucumber", name: "キュウリ", desc: "収穫した作物", category: "crop", price: 110, hunger: 8 },
  { id: "eggplant", name: "ナス", desc: "収穫した作物", category: "crop", price: 120, hunger: 8 },
  { id: "sweet_potato", name: "サツマイモ", desc: "収穫した作物", category: "crop", price: 130, hunger: 14 },
  { id: "pepper", name: "ピーマン", desc: "収穫した作物", category: "crop", price: 130, hunger: 6 },
  { id: "grape", name: "ブドウ", desc: "収穫した作物", category: "crop", price: 220, hunger: 14 },
  { id: "turnip", name: "カブ", desc: "収穫した作物", category: "crop", price: 100, hunger: 8 },
  // ---- 合成品（追加分: 宝石細工・日用品） ---------------------------------
  { id: "rope", name: "ロープ", desc: "糸を編んだ実用品", category: "crafted", price: 320 },
  { id: "stone_statue", name: "石像", desc: "石を彫った像", category: "crafted", price: 900 },
  { id: "flower_wreath", name: "花冠", desc: "花を編んだ飾り", category: "crafted", price: 580 },
  { id: "embroidered_cloth", name: "刺繍布", desc: "花を刺繍した布", category: "crafted", price: 850 },
  { id: "gem_ring", name: "宝石の指輪", desc: "金と宝石の指輪", category: "crafted", price: 5100 },
  { id: "pearl_necklace", name: "真珠のネックレス", desc: "真珠をつないだ首飾り", category: "crafted", price: 5200 },
  { id: "honey_candy", name: "はちみつ飴", desc: "甘い飴", category: "crafted", price: 1050, hunger: 20 },
  // ---- 特殊（追加分: 遺跡・洞窟・ダンジョンの宝） -------------------------
  { id: "ancient_coin", name: "古代のコイン", desc: "遺跡で見つかる古い硬貨", category: "special", price: 2400 },
  { id: "ancient_relic", name: "古代の遺物", desc: "遺跡の奥に眠る遺物", category: "special", price: 4200 },
  { id: "dragon_scale", name: "竜のうろこ", desc: "強敵が落とす希少なうろこ", category: "special", price: 3800 },
  { id: "ghost_tear", name: "幽霊の涙", desc: "ダンジョンで見つかる雫", category: "special", price: 3000 },
  { id: "golden_key", name: "金の鍵", desc: "宝箱を開ける鍵", category: "special", price: 3500 },
  { id: "dungeon_key", name: "ダンジョンの鍵", desc: "ダンジョンの扉を開ける鍵", category: "special", price: 1500 },
  { id: "star_map", name: "星の地図", desc: "星の位置を記した古地図", category: "special", price: 2800 },
  // ---- 施設（追加分: 作業台・鍛冶台・かまど等の特殊オブジェクト） --------
  { id: "workbench", name: "作業台", desc: "合成をする台", category: "furniture", price: 800, facility: true },
  { id: "smithing_table", name: "鍛冶台", desc: "道具を鍛える台", category: "furniture", price: 1600, facility: true },
  { id: "furnace", name: "かまど", desc: "精錬をするかまど", category: "furniture", price: 1200, facility: true },
  { id: "anvil", name: "金床", desc: "金属を打つ台", category: "furniture", price: 1800, facility: true },
  { id: "storage_chest", name: "収納箱", desc: "物をしまう箱", category: "furniture", price: 700, facility: true },
  { id: "bed", name: "ベッド", desc: "休める家具", category: "furniture", price: 1050, facility: true },
  { id: "torch", name: "松明", desc: "周りを照らす明かり", category: "furniture", price: 150, facility: true },
  { id: "campfire", name: "焚き火", desc: "調理と明かりの火", category: "furniture", price: 680, facility: true },
  { id: "well", name: "井戸", desc: "水を汲む施設", category: "furniture", price: 1500, facility: true },
  { id: "loom", name: "織り機", desc: "布を織る機械", category: "furniture", price: 1100, facility: true },
  { id: "cooking_pot", name: "調理鍋", desc: "煮込み料理の鍋", category: "furniture", price: 950, facility: true },
  { id: "auto_harvester", name: "自動収穫機", desc: "隣の畑が育ったら収穫する機械", category: "furniture", price: 8000, facility: true },
  { id: "flower_pot", name: "植木鉢", desc: "花を植える鉢", category: "furniture", price: 250, facility: true },
  // ---- ブロック（追加分2: 木種・石種・色ブロック） -----------------------
  { id: "sakura_log", name: "桜の原木", desc: "置ける原木", category: "block", price: 140, durability: 25 },
  { id: "dark_log", name: "黒木の原木", desc: "置ける原木", category: "block", price: 140, durability: 28 },
  { id: "mossy_stone_block", name: "苔石ブロック", desc: "苔むした石", category: "block", price: 420, durability: 40 },
  { id: "cracked_stone_block", name: "ひび石ブロック", desc: "ひびの入った石", category: "block", price: 140, durability: 30 },
  { id: "sand_brick_block", name: "砂レンガブロック", desc: "砂を固めたレンガ", category: "block", price: 320, durability: 35 },
  { id: "mud_brick_block", name: "泥レンガブロック", desc: "泥を焼いたレンガ", category: "block", price: 400, durability: 32 },
  { id: "snow_brick_block", name: "雪レンガブロック", desc: "雪を固めたレンガ", category: "block", price: 320, durability: 18 },
  { id: "red_block", name: "赤ブロック", desc: "赤く染めた塊", category: "block", price: 1250, durability: 12 },
  { id: "blue_block", name: "青ブロック", desc: "青く染めた塊", category: "block", price: 4400, durability: 12 },
  { id: "green_block", name: "緑ブロック", desc: "緑に染めた塊", category: "block", price: 4800, durability: 12 },
  { id: "white_block", name: "白ブロック", desc: "白く染めた塊", category: "block", price: 1250, durability: 12 },
  { id: "black_block", name: "黒ブロック", desc: "黒く染めた塊", category: "block", price: 1350, durability: 12 },
  // ---- 素材（追加分2） -----------------------------------------------------
  { id: "silk", name: "絹", desc: "なめらかな素材", category: "material", price: 360 },
  { id: "ceramic", name: "陶器", desc: "焼き物の素材", category: "material", price: 220 },
  { id: "gunpowder", name: "火薬", desc: "硫黄と石炭の粉", category: "material", price: 720 },
  { id: "milk", name: "ミルク", desc: "料理の素材", category: "material", price: 120 },
  // ---- 種・作物（追加分2） ---------------------------------------------------
  { id: "chili_seed", name: "トウガラシの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "lettuce_seed", name: "レタスの種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "radish_seed", name: "大根の種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "spinach_seed", name: "ホウレンソウの種", desc: "畑に植える種", category: "seed", price: 100 },
  { id: "chili", name: "トウガラシ", desc: "収穫した作物", category: "crop", price: 140, hunger: 4 },
  { id: "lettuce", name: "レタス", desc: "収穫した作物", category: "crop", price: 100, hunger: 8 },
  { id: "radish", name: "大根", desc: "収穫した作物", category: "crop", price: 120, hunger: 10 },
  { id: "spinach", name: "ホウレンソウ", desc: "収穫した作物", category: "crop", price: 120, hunger: 8 },
  // ---- 食事（追加分2） -------------------------------------------------------
  { id: "stir_fry", name: "野菜炒め", desc: "畑の炒め物", category: "food", price: 620, hunger: 42 },
  { id: "pickles", name: "漬物", desc: "塩漬けの野菜", category: "food", price: 350, hunger: 18 },
  { id: "fruit_punch", name: "フルーツポンチ", desc: "果物の盛り合わせ", category: "food", price: 880, hunger: 38 },
  { id: "veggie_soup", name: "野菜スープ", desc: "温かいスープ", category: "food", price: 640, hunger: 36 },
  { id: "honey_tea", name: "はちみつティー", desc: "甘い温かい飲み物。毒も流す", category: "food", price: 750, hunger: 16, heal: 5, curePoison: true, buff: { kind: "alert", minutes: 5 } },
  { id: "cheese", name: "チーズ", desc: "発酵した乳製品", category: "food", price: 460, hunger: 20 },
  // ---- 合成品（追加分2） -------------------------------------------------------
  { id: "ceramic_vase", name: "陶器の壺", desc: "焼き物の壺", category: "crafted", price: 1250 },
  { id: "silk_cloth", name: "絹布", desc: "絹を織った布", category: "crafted", price: 1350 },
  { id: "painting", name: "絵画", desc: "紙と花の絵", category: "crafted", price: 1100 },
  { id: "music_box", name: "オルゴール", desc: "音の出る小箱", category: "crafted", price: 1500 },
  // ---- 特殊（追加分2: モブの落とし物） -----------------------------------------
  { id: "slime_core", name: "スライムコア", desc: "スライムの核", category: "special", price: 1600 },
  { id: "wolf_fang", name: "狼の牙", desc: "狼が落とす牙", category: "special", price: 1900 },
  // ---- 家具（追加分2） -----------------------------------------------------------
  { id: "stone_fence", name: "石の柵", desc: "石の区切り", category: "furniture", price: 550, facility: true },
  { id: "iron_fence", name: "鉄の柵", desc: "鉄の区切り", category: "furniture", price: 1280, facility: true },
  { id: "wooden_gate", name: "木の門", desc: "出入りの門", category: "furniture", price: 650, facility: true },
  { id: "rug", name: "じゅうたん", desc: "敷く布", category: "furniture", price: 760, facility: true },

  // ---- 母数拡充 第2弾（並行便 251種への追加分） ----
  { id: "chicken_meat", name: "鶏肉", desc: "焼くと食べられる", category: "material", price: 120 },
  { id: "spider_eye", name: "蜘蛛の目", desc: "不気味な素材", category: "material", price: 450 },
  { id: "turtle_scute", name: "亀の甲片", desc: "硬い甲羅の欠片", category: "material", price: 550 },
  { id: "sugar", name: "砂糖", desc: "甘味の素材", category: "material", price: 100 },
  { id: "coal_ore_block", name: "石炭鉱石ブロック", desc: "石炭を含む塊", category: "block", price: 200, durability: 45, mineTool: "pickaxe" },
  { id: "copper_ore_block", name: "銅鉱石ブロック", desc: "銅を含む塊", category: "block", price: 300, durability: 50, mineTool: "pickaxe" },
  { id: "iron_ore_block", name: "鉄鉱石ブロック", desc: "鉄を含む塊", category: "block", price: 400, durability: 55, mineTool: "pickaxe" },
  { id: "gold_ore_block", name: "金鉱石ブロック", desc: "金を含む塊", category: "block", price: 900, durability: 60, mineTool: "pickaxe" },
  { id: "diamond_ore_block", name: "ダイヤ鉱石ブロック", desc: "ダイヤを含む塊", category: "block", price: 2000, durability: 90, mineTool: "pickaxe" },
  { id: "lava_block", name: "溶岩ブロック", desc: "熱い塊", category: "block", price: 600, durability: 20 },
  { id: "forest_floor_block", name: "森床ブロック", desc: "森の地面", category: "block", price: 60, durability: 8 },
  { id: "autumn_log", name: "紅葉の原木", desc: "置ける原木", category: "block", price: 140, durability: 25 },
  { id: "dead_log", name: "枯れ木の原木", desc: "置ける原木", category: "block", price: 100, durability: 20 },
  { id: "log_block", name: "丸太ブロック", desc: "丸太の塊", category: "block", price: 120, durability: 25 },
  { id: "glacier_block", name: "氷河ブロック", desc: "青い氷の塊", category: "block", price: 180, durability: 25 },
  { id: "stone_wall_block", name: "石壁ブロック", desc: "組んだ石壁", category: "block", price: 2180, durability: 70, mineTool: "pickaxe" },
  { id: "wood_gate_block", name: "木の門ブロック", desc: "木の門", category: "block", price: 1250, durability: 25 },
  { id: "bridge_block", name: "橋ブロック", desc: "渡れる板", category: "block", price: 1060, durability: 20 },
  { id: "yellow_block", name: "黄ブロック", desc: "色つきの塊", category: "block", price: 200, durability: 30 },
  { id: "daikon_seed", name: "大根の種", desc: "畑に植える種", category: "seed", price: 80 },
  { id: "apple_seed", name: "リンゴの種", desc: "畑に植える種", category: "seed", price: 120 },
  { id: "peach_seed", name: "桃の種", desc: "畑に植える種", category: "seed", price: 140 },
  { id: "cotton_seed", name: "綿花の種", desc: "畑に植える種", category: "seed", price: 100 },
  { id: "daikon", name: "大根", desc: "収穫した作物", category: "crop", price: 130, hunger: 10 },
  { id: "peach", name: "桃", desc: "収穫した作物", category: "crop", price: 220, hunger: 15 },
  { id: "cotton", name: "綿花", desc: "収穫した作物", category: "crop", price: 160 },
  { id: "cooked_meat", name: "焼き肉", desc: "香ばしく焼けた肉", category: "food", price: 300, hunger: 35 },
  { id: "grilled_chicken", name: "焼き鶏", desc: "香ばしく焼けた鶏", category: "food", price: 260, hunger: 30 },
  { id: "sashimi", name: "刺身盛り", desc: "新鮮な切り身", category: "food", price: 620, hunger: 40 },
  { id: "egg_rice", name: "卵かけご飯", desc: "ご飯と卵の一杯", category: "food", price: 420, hunger: 35 },
  { id: "honey_toast", name: "ハニートースト", desc: "甘い焼きパン", category: "food", price: 700, hunger: 45 },
  { id: "apple_pie", name: "アップルパイ", desc: "甘い焼き菓子", category: "food", price: 480, hunger: 40 },
  { id: "grape_juice", name: "ブドウジュース", desc: "果実の飲み物", category: "food", price: 750, hunger: 25 },
  { id: "peach_juice", name: "桃ジュース", desc: "果実の飲み物", category: "food", price: 820, hunger: 25 },
  { id: "curry", name: "カレーライス", desc: "畑の実りのカレー", category: "food", price: 880, hunger: 70, heal: 12 },
  { id: "miso_soup", name: "味噌汁", desc: "温かい汁物", category: "food", price: 440, hunger: 30 },
  { id: "tofu", name: "豆腐", desc: "大豆の白い塊", category: "food", price: 620, hunger: 30 },
  { id: "fruit_salad", name: "フルーツサラダ", desc: "果実の盛り合わせ", category: "food", price: 1020, hunger: 45 },
  { id: "roasted_sweet_potato", name: "焼き芋", desc: "ほくほくの芋", category: "food", price: 300, hunger: 30 },
  { id: "pepper_stirfry", name: "ピーマン炒め", desc: "野菜の炒め物", category: "food", price: 480, hunger: 35 },
  { id: "eggplant_miso", name: "ナス味噌", desc: "味噌で炒めたナス", category: "food", price: 460, hunger: 35 },
  { id: "cotton_candy", name: "わたあめ", desc: "ふわふわの菓子", category: "food", price: 400, hunger: 20 },
  { id: "caramel", name: "キャラメル", desc: "甘い飴菓子", category: "food", price: 720, hunger: 25 },
  { id: "jam", name: "ジャム", desc: "果実の甘い煮詰め", category: "food", price: 500, hunger: 25 },
  { id: "dried_fruit", name: "ドライフルーツ", desc: "乾かした果実", category: "food", price: 720, hunger: 30 },
  { id: "tomato_soup", name: "トマトスープ", desc: "温かいスープ", category: "food", price: 480, hunger: 35 },
  { id: "melon_bread", name: "メロンパン", desc: "甘い焼きパン", category: "food", price: 950, hunger: 50 },
  { id: "deluxe_meal", name: "贅沢御膳", desc: "品数たっぷりの御膳", category: "food", price: 1150, hunger: 100, heal: 20 },
  { id: "fishing_rod", name: "釣り竿", desc: "糸を垂らす道具", category: "crafted", price: 340 },
  { id: "bow", name: "弓", desc: "矢を放つ道具", category: "crafted", price: 340 },
  { id: "arrow", name: "矢", desc: "弓で放つ矢", category: "crafted", price: 120 },
  { id: "bucket", name: "バケツ", desc: "運ぶ容器", category: "crafted", price: 1300 },
  { id: "compass", name: "コンパス", desc: "方角を示す道具", category: "crafted", price: 1000 },
  { id: "map_item", name: "地図", desc: "辺りを描いた紙", category: "crafted", price: 420 },
  { id: "gold_key", name: "金の鍵", desc: "重い鍵", category: "crafted", price: 1800 },
  { id: "bomb", name: "爆弾", desc: "危ない玉", category: "crafted", price: 560 },
  { id: "dragon_charm", name: "竜鱗のお守り", desc: "鱗を編んだお守り", category: "crafted", price: 6490 },
  { id: "ghost_lantern", name: "幽霊提灯", desc: "青く光る提灯", category: "crafted", price: 5140 },
  { id: "spider_silk", name: "蜘蛛の糸玉", desc: "粘る糸の玉", category: "crafted", price: 1180 },
  { id: "turtle_shield", name: "亀甲の盾", desc: "甲羅の盾", category: "crafted", price: 2580 },
  { id: "chest_box", name: "宝箱", desc: "物を入れる箱", category: "furniture", price: 650, facility: true },
  { id: "market_stall", name: "屋台", desc: "店を開く台", category: "furniture", price: 950, facility: true },
  { id: "flag_red", name: "赤い旗", desc: "目印の旗", category: "furniture", price: 420, facility: true },
  { id: "flag_blue", name: "青い旗", desc: "目印の旗", category: "furniture", price: 420, facility: true },
  { id: "fountain", name: "噴水", desc: "水の出る飾り", category: "furniture", price: 1300, facility: true },
  { id: "stairs", name: "階段", desc: "段の家具", category: "furniture", price: 1180, facility: true },
  { id: "scepter", name: "王笏", desc: "王の持つ笏", category: "special", price: 8500 },
  { id: "tiara", name: "ティアラ", desc: "宝石の髪飾り", category: "special", price: 5700 },
  { id: "dragon_egg", name: "竜の卵", desc: "大きな卵", category: "special", price: 9000 },
  { id: "star_crown", name: "星の王冠", desc: "星を冠した王冠", category: "special", price: 15500 },
  { id: "world_seed", name: "世界の種", desc: "不思議な大きな種", category: "special", price: 6900 },
  { id: "ago_emblem", name: "アゴの紋章", desc: "アゴの印の飾り", category: "special", price: 4800 },
];



/**
 * ドット絵アイコンを持つアイテムの ID 一覧。実体は
 * public/img/worldbox/items/<id>.png（生成: ago-world-box/make_item_icons.py、
 * 素材はユーザー承認済みのドット絵セット＋家具はロビースプライト）。
 * ここに無いアイテムはアイコンなし（UI は名前ラベルで出す）。
 */
export const ITEM_ICON_IDS: readonly string[] = [
  // 道具（4種×3段すべて）
  "wooden_axe", "stone_axe", "iron_axe",
  "wooden_pickaxe", "stone_pickaxe", "iron_pickaxe",
  "wooden_sword", "stone_sword", "iron_sword",
  "wooden_hoe", "stone_hoe", "iron_hoe",
  // 素材（すべて）
  "wood", "stone", "herb", "cloth", "glass", "iron_ore", "gold_ore", "mithril",
  "stick", "fiber", "clay", "paper", "string", "bamboo", "charcoal", "feather",
  "bone", "slime", "leather", "iron_ingot", "gold_ingot",
  // ブロック（すべて）
  "dirt_block", "sand_block", "snow_block", "mud_block", "grass_block",
  "gravel_block", "moss_block", "clay_block", "packed_snow_block", "wool_block",
  "hay_bale", "ice_block", "charcoal_block", "bamboo_block", "planks_block",
  "oak_log", "pine_log", "birch_log", "bone_block", "sandstone_block",
  "stone_block", "cobblestone_block", "brick_block", "stone_brick_block",
  "glass_block", "glowstone_block", "bookshelf_block", "slime_block",
  "crystal_block", "gold_block", "iron_block", "obsidian_block", "mithril_block",
  // 種（すべて）
  "wheat_seed", "carrot_seed", "potato_seed", "cabbage_seed", "strawberry_seed",
  "tomato_seed", "corn_seed", "rice_seed", "pumpkin_seed", "melon_seed",
  // 作物・食事（一部）
  "wheat", "carrot", "tomato", "strawberry", "melon",
  "bread", "energy_drink", "meal", "cake",
  // 合成品・特殊（一部）
  "lantern", "blanket", "potion", "toolbox", "tent", "accessory", "star_shard",
  // 家具（すべて）
  "bench", "chair", "sign_board", "hedge", "planter", "barrel", "crate",
  "fence_wood", "lamp", "item_shelf", "table_round", "tapestry", "bookshelf",
  "sofa", "piano",
  // 拡張分（ミスリル道具・金属/宝石素材・特殊ブロック）
  "mithril_axe", "mithril_pickaxe", "mithril_sword", "mithril_hoe",
  "copper_ore", "copper_ingot", "coal", "flint", "sulfur", "salt",
  "ruby", "sapphire", "emerald", "diamond", "pearl", "honey", "beeswax", "flower",
  "copper_block", "coal_block", "bedrock_block", "cactus_block", "leaves_block",
  "diamond_block", "emerald_block", "ruby_block", "sapphire_block", "magma_block",
  "honey_block", "mushroom_block", "path_block", "flower_block", "pumpkin_block", "melon_block",
  // 拡張分（食事・種・作物）
  "egg", "raw_meat", "mushroom", "apple", "berry", "fish",
  "cookie", "grilled_meat", "grilled_fish", "omelette", "baked_potato", "stew",
  "onion_seed", "soybean_seed", "cucumber_seed", "eggplant_seed",
  "sweet_potato_seed", "pepper_seed", "grape_seed", "turnip_seed",
  "onion", "soybean", "cucumber", "eggplant", "sweet_potato", "pepper", "grape", "turnip",
  // 拡張分（合成品・特殊・施設）
  "rope", "stone_statue", "flower_wreath", "embroidered_cloth", "gem_ring",
  "pearl_necklace", "honey_candy",
  "ancient_coin", "ancient_relic", "dragon_scale", "ghost_tear", "golden_key", "dungeon_key", "star_map",
  "workbench", "smithing_table", "furnace", "anvil", "storage_chest", "bed",
  "torch", "campfire", "well", "loom", "cooking_pot", "flower_pot", "auto_harvester",
  // 拡張分2
  "sakura_log", "dark_log", "mossy_stone_block", "cracked_stone_block",
  "sand_brick_block", "mud_brick_block", "snow_brick_block",
  "red_block", "blue_block", "green_block", "white_block", "black_block",
  "silk", "ceramic", "gunpowder", "milk",
  "chili_seed", "lettuce_seed", "radish_seed", "spinach_seed",
  "chili", "lettuce", "radish", "spinach",
  "stir_fry", "pickles", "fruit_punch", "veggie_soup", "honey_tea", "cheese",
  "ceramic_vase", "silk_cloth", "painting", "music_box",
  "slime_core", "wolf_fang", "stone_fence", "iron_fence", "wooden_gate", "rug",
  // 母数拡充 第2弾（全種アイコンつき）
  "chicken_meat", "spider_eye", "turtle_scute", "sugar", "coal_ore_block",
  "copper_ore_block", "iron_ore_block", "gold_ore_block", "diamond_ore_block", "lava_block",
  "forest_floor_block", "autumn_log", "dead_log", "log_block", "glacier_block",
  "stone_wall_block", "wood_gate_block", "bridge_block", "yellow_block", "daikon_seed",
  "apple_seed", "peach_seed", "cotton_seed", "daikon", "peach",
  "cotton", "cooked_meat", "grilled_chicken", "sashimi", "egg_rice",
  "honey_toast", "apple_pie", "grape_juice", "peach_juice", "curry",
  "miso_soup", "tofu", "fruit_salad", "roasted_sweet_potato", "pepper_stirfry",
  "eggplant_miso", "cotton_candy", "caramel", "jam", "dried_fruit",
  "tomato_soup", "melon_bread", "deluxe_meal", "fishing_rod", "bow",
  "arrow", "bucket", "water_bucket", "compass", "map_item", "gold_key", "explorer_compass",
  "bomb", "dragon_charm", "ghost_lantern", "spider_silk", "turtle_shield",
  "chest_box", "market_stall", "flag_red", "flag_blue", "fountain",
  "stairs", "scepter", "tiara", "dragon_egg", "star_crown",
  "world_seed", "ago_emblem",
];



const ITEM_ICON_ID_SET = new Set(ITEM_ICON_IDS);
for (const item of ITEMS) {
  if (ITEM_ICON_ID_SET.has(item.id)) item.icon = `/img/worldbox/items/${item.id}.png`;
}

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
/** レシピの種別。どの設置物/施設で作れるかの判定に使う（未指定は "craft"）。 */
export type RecipeKind = "craft" | "smelt" | "cook" | "weave";

export type Recipe = {
  id: string;
  inputs: Readonly<Record<string, number>>;
  output: string;
  outputCount: number;
  /** 種別（未指定は "craft" = 作業台/鍛冶屋）。精錬は "smelt"、調理は "cook"、織りは "weave"。 */
  kind?: RecipeKind;
  /** 成功時に追加でレアアイテムが落ちる確率（0〜1）。 */
  rareItem?: string;
  rareChance?: number;
};

export const RECIPES: readonly Recipe[] = [
  { id: "carving", inputs: { wood: 3 }, output: "carving", outputCount: 1 },
  { id: "lantern", inputs: { stone: 2, glass: 1 }, output: "lantern", outputCount: 1 },
  { id: "blanket", inputs: { cloth: 2 }, output: "blanket", outputCount: 1 },
  { id: "potion", inputs: { herb: 2, glass: 1 }, output: "potion", outputCount: 1, rareItem: "star_shard", rareChance: 0.05 },
  { id: "antidote", inputs: { herb: 2, honey: 1 }, output: "antidote", outputCount: 1 },
  { id: "bandage", inputs: { cloth: 2 }, output: "bandage", outputCount: 1 },
  { id: "toolbox", inputs: { iron_ore: 2, wood: 1 }, output: "toolbox", outputCount: 1 },
  { id: "tent", inputs: { cloth: 3, wood: 2 }, output: "tent", outputCount: 1 },
  { id: "accessory", inputs: { gold_ore: 1, glass: 1 }, output: "accessory", outputCount: 1, rareItem: "star_shard", rareChance: 0.08 },
  { id: "special_course", inputs: { meal: 1, wheat: 2, herb: 1 }, output: "special_course", outputCount: 1, kind: "cook" },
  { id: "bread", inputs: { wheat: 2 }, output: "bread", outputCount: 1, kind: "cook" },
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
  { id: "grilled_corn", inputs: { corn: 1 }, output: "grilled_corn", outputCount: 1, kind: "cook" },
  { id: "corn_soup", inputs: { corn: 2 }, output: "corn_soup", outputCount: 1, kind: "cook" },
  { id: "salad", inputs: { cabbage: 1, tomato: 1, carrot: 1 }, output: "salad", outputCount: 1 },
  { id: "pumpkin_pie", inputs: { pumpkin: 1, wheat: 1 }, output: "pumpkin_pie", outputCount: 1, kind: "cook" },
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
  { id: "tapestry", inputs: { cloth: 2, string: 1 }, output: "tapestry", outputCount: 1, kind: "weave" },
  { id: "piano", inputs: { wood: 5, iron_ore: 2 }, output: "piano", outputCount: 1 },
  // 道具（ミスリル段位）
  { id: "mithril_axe", inputs: { mithril: 3, stick: 2 }, output: "mithril_axe", outputCount: 1 },
  { id: "mithril_pickaxe", inputs: { mithril: 3, stick: 2 }, output: "mithril_pickaxe", outputCount: 1 },
  { id: "mithril_sword", inputs: { mithril: 2, stick: 1 }, output: "mithril_sword", outputCount: 1 },
  { id: "mithril_sword_dragon", inputs: { dragon_scale: 1, stick: 1 }, output: "mithril_sword", outputCount: 1 },
  { id: "ghost_lantern_mithril", inputs: { ghost_tear: 1, mithril: 1 }, output: "ghost_lantern", outputCount: 2 },
  { id: "mithril_hoe", inputs: { mithril: 2, stick: 2 }, output: "mithril_hoe", outputCount: 1 },
  // ブロック（金属・宝石・自然素材）
  { id: "copper_block", inputs: { copper_ingot: 4 }, output: "copper_block", outputCount: 1 },
  { id: "coal_block", inputs: { coal: 4 }, output: "coal_block", outputCount: 1 },
  { id: "diamond_block", inputs: { diamond: 4 }, output: "diamond_block", outputCount: 1 },
  { id: "emerald_block", inputs: { emerald: 4 }, output: "emerald_block", outputCount: 1 },
  { id: "ruby_block", inputs: { ruby: 4 }, output: "ruby_block", outputCount: 1 },
  { id: "sapphire_block", inputs: { sapphire: 4 }, output: "sapphire_block", outputCount: 1 },
  { id: "honey_block", inputs: { honey: 4 }, output: "honey_block", outputCount: 1 },
  { id: "mushroom_block", inputs: { mushroom: 4 }, output: "mushroom_block", outputCount: 1 },
  // 調理（追加分）
  { id: "cookie", inputs: { wheat: 2, honey: 1 }, output: "cookie", outputCount: 1, kind: "cook" },
  { id: "grilled_meat", inputs: { raw_meat: 1 }, output: "grilled_meat", outputCount: 1, kind: "cook" },
  { id: "grilled_fish", inputs: { fish: 1 }, output: "grilled_fish", outputCount: 1, kind: "cook" },
  { id: "omelette", inputs: { egg: 2 }, output: "omelette", outputCount: 1, kind: "cook" },
  { id: "baked_potato", inputs: { potato: 1 }, output: "baked_potato", outputCount: 1, kind: "cook" },
  { id: "stew", inputs: { potato: 1, carrot: 1, raw_meat: 1 }, output: "stew", outputCount: 1, kind: "cook" },
  { id: "honey_candy", inputs: { honey: 2 }, output: "honey_candy", outputCount: 1, kind: "cook" },
  // 合成品（追加分）
  { id: "rope", inputs: { string: 2 }, output: "rope", outputCount: 1 },
  { id: "stone_statue", inputs: { stone: 5 }, output: "stone_statue", outputCount: 1 },
  { id: "flower_wreath", inputs: { flower: 3, fiber: 1 }, output: "flower_wreath", outputCount: 1 },
  { id: "embroidered_cloth", inputs: { cloth: 2, flower: 1 }, output: "embroidered_cloth", outputCount: 1, kind: "weave" },
  { id: "gem_ring", inputs: { gold_ingot: 1, ruby: 1 }, output: "gem_ring", outputCount: 1 },
  { id: "pearl_necklace", inputs: { pearl: 3, string: 1 }, output: "pearl_necklace", outputCount: 1 },
  // 施設（作業台・鍛冶台・かまど等）
  { id: "workbench", inputs: { wood: 4 }, output: "workbench", outputCount: 1 },
  { id: "smithing_table", inputs: { iron_ingot: 2, wood: 2 }, output: "smithing_table", outputCount: 1 },
  { id: "furnace", inputs: { stone: 5 }, output: "furnace", outputCount: 1 },
  { id: "anvil", inputs: { iron_ingot: 3 }, output: "anvil", outputCount: 1 },
  { id: "storage_chest", inputs: { wood: 5 }, output: "storage_chest", outputCount: 1 },
  { id: "bed", inputs: { cloth: 2, wood: 3 }, output: "bed", outputCount: 1 },
  { id: "torch", inputs: { stick: 1, coal: 1 }, output: "torch", outputCount: 2 },
  { id: "campfire", inputs: { wood: 3, coal: 1 }, output: "campfire", outputCount: 1 },
  { id: "well", inputs: { stone: 4, wood: 2 }, output: "well", outputCount: 1 },
  { id: "loom", inputs: { wood: 3, string: 2 }, output: "loom", outputCount: 1 },
  { id: "cooking_pot", inputs: { iron_ingot: 1, stone: 2 }, output: "cooking_pot", outputCount: 1 },
  { id: "auto_harvester", inputs: { iron_ingot: 3, wood: 4 }, output: "auto_harvester", outputCount: 1 },
  { id: "flower_pot", inputs: { clay: 2 }, output: "flower_pot", outputCount: 1 },
  // 拡張分2（ブロック・料理・合成品）
  { id: "mossy_stone_block", inputs: { stone: 2, fiber: 1 }, output: "mossy_stone_block", outputCount: 1 },
  { id: "sand_brick_block", inputs: { sand_block: 4 }, output: "sand_brick_block", outputCount: 1 },
  { id: "mud_brick_block", inputs: { mud_block: 4 }, output: "mud_brick_block", outputCount: 1 },
  { id: "snow_brick_block", inputs: { snow_block: 4 }, output: "snow_brick_block", outputCount: 1 },
  { id: "red_block", inputs: { wool_block: 1, flower: 1 }, output: "red_block", outputCount: 1 },
  { id: "blue_block", inputs: { wool_block: 1, sapphire: 1 }, output: "blue_block", outputCount: 1 },
  { id: "green_block", inputs: { wool_block: 1, emerald: 1 }, output: "green_block", outputCount: 1 },
  { id: "white_block", inputs: { wool_block: 1, salt: 1 }, output: "white_block", outputCount: 1 },
  { id: "black_block", inputs: { wool_block: 1, coal: 1 }, output: "black_block", outputCount: 1 },
  { id: "gunpowder", inputs: { sulfur: 1, coal: 1 }, output: "gunpowder", outputCount: 1 },
  { id: "ceramic", inputs: { clay: 2 }, output: "ceramic", outputCount: 1 },
  { id: "stir_fry", inputs: { cabbage: 1, pepper: 1, onion: 1 }, output: "stir_fry", outputCount: 1 },
  { id: "pickles", inputs: { cucumber: 1, salt: 1 }, output: "pickles", outputCount: 1 },
  { id: "fruit_punch", inputs: { apple: 1, grape: 1, berry: 1 }, output: "fruit_punch", outputCount: 1 },
  { id: "veggie_soup", inputs: { radish: 1, spinach: 1, onion: 1 }, output: "veggie_soup", outputCount: 1 },
  { id: "honey_tea", inputs: { honey: 1, herb: 1 }, output: "honey_tea", outputCount: 1 },
  { id: "cheese", inputs: { milk: 2 }, output: "cheese", outputCount: 1 },
  { id: "ceramic_vase", inputs: { ceramic: 3 }, output: "ceramic_vase", outputCount: 1 },
  { id: "silk_cloth", inputs: { silk: 2 }, output: "silk_cloth", outputCount: 1, kind: "weave" },
  { id: "painting", inputs: { paper: 2, flower: 1 }, output: "painting", outputCount: 1 },
  { id: "music_box", inputs: { wood: 3, iron_ingot: 1 }, output: "music_box", outputCount: 1 },
  { id: "stone_fence", inputs: { stone: 3 }, output: "stone_fence", outputCount: 1 },
  { id: "iron_fence", inputs: { iron_ingot: 2 }, output: "iron_fence", outputCount: 1 },
  { id: "wooden_gate", inputs: { wood: 3, stick: 2 }, output: "wooden_gate", outputCount: 1 },
  { id: "rug", inputs: { cloth: 2, string: 1 }, output: "rug", outputCount: 1 },

  // 母数拡充 第2弾のレシピ
  { id: "cooked_meat", inputs: { raw_meat: 1 }, output: "cooked_meat", outputCount: 1 },
  { id: "grilled_chicken", inputs: { chicken_meat: 1 }, output: "grilled_chicken", outputCount: 1 },
  { id: "sashimi", inputs: { fish: 2 }, output: "sashimi", outputCount: 1 },
  { id: "egg_rice", inputs: { rice: 1, egg: 1 }, output: "egg_rice", outputCount: 1 },
  { id: "honey_toast", inputs: { bread: 1, honey: 1 }, output: "honey_toast", outputCount: 1 },
  { id: "apple_pie", inputs: { apple: 1, wheat: 1 }, output: "apple_pie", outputCount: 1 },
  { id: "grape_juice", inputs: { grape: 2 }, output: "grape_juice", outputCount: 1 },
  { id: "peach_juice", inputs: { peach: 2 }, output: "peach_juice", outputCount: 1 },
  { id: "curry", inputs: { rice: 1, potato: 1, carrot: 1, chili: 1 }, output: "curry", outputCount: 1 },
  { id: "miso_soup", inputs: { soybean: 2 }, output: "miso_soup", outputCount: 1 },
  { id: "tofu", inputs: { soybean: 3 }, output: "tofu", outputCount: 1 },
  { id: "fruit_salad", inputs: { apple: 1, grape: 1, strawberry: 1 }, output: "fruit_salad", outputCount: 1 },
  { id: "roasted_sweet_potato", inputs: { sweet_potato: 1 }, output: "roasted_sweet_potato", outputCount: 1 },
  { id: "pepper_stirfry", inputs: { onion: 1, pepper: 1 }, output: "pepper_stirfry", outputCount: 1 },
  { id: "eggplant_miso", inputs: { eggplant: 1, soybean: 1 }, output: "eggplant_miso", outputCount: 1 },
  { id: "cotton_candy", inputs: { sugar: 2 }, output: "cotton_candy", outputCount: 1 },
  { id: "caramel", inputs: { sugar: 1, honey: 1 }, output: "caramel", outputCount: 1 },
  { id: "jam", inputs: { strawberry: 1, sugar: 1 }, output: "jam", outputCount: 1 },
  { id: "dried_fruit", inputs: { grape: 1, apple: 1 }, output: "dried_fruit", outputCount: 1 },
  { id: "tomato_soup", inputs: { tomato: 2 }, output: "tomato_soup", outputCount: 1 },
  { id: "melon_bread", inputs: { wheat: 1, sugar: 1, melon: 1 }, output: "melon_bread", outputCount: 1 },
  { id: "deluxe_meal", inputs: { meal: 1, cooked_meat: 1 }, output: "deluxe_meal", outputCount: 1 },
  { id: "fishing_rod", inputs: { stick: 2, string: 1 }, output: "fishing_rod", outputCount: 1 },
  { id: "bow", inputs: { stick: 2, string: 1 }, output: "bow", outputCount: 1 },
  { id: "arrow", inputs: { stick: 1, flint: 1, feather: 1 }, output: "arrow", outputCount: 4 },
  { id: "bucket", inputs: { iron_ingot: 2 }, output: "bucket", outputCount: 1 },
  { id: "compass", inputs: { iron_ingot: 1, glass: 1 }, output: "compass", outputCount: 1 },
  { id: "map_item", inputs: { paper: 3 }, output: "map_item", outputCount: 1 },
  { id: "gold_key", inputs: { gold_ingot: 1 }, output: "gold_key", outputCount: 1 },
  { id: "bomb", inputs: { charcoal: 2, flint: 1 }, output: "bomb", outputCount: 1 },
  { id: "dragon_charm", inputs: { dragon_scale: 1, string: 1 }, output: "dragon_charm", outputCount: 1, rareItem: "dragon_egg", rareChance: 0.03 },
  { id: "ghost_lantern", inputs: { ghost_tear: 1, paper: 1 }, output: "ghost_lantern", outputCount: 1 },
  { id: "spider_silk", inputs: { spider_eye: 1, string: 2 }, output: "spider_silk", outputCount: 1 },
  { id: "turtle_shield", inputs: { turtle_scute: 2, leather: 1 }, output: "turtle_shield", outputCount: 1 },
  { id: "chest_box", inputs: { wood: 4 }, output: "chest_box", outputCount: 1 },
  { id: "market_stall", inputs: { wood: 4, cloth: 1 }, output: "market_stall", outputCount: 1 },
  { id: "flag_red", inputs: { cloth: 1, stick: 1 }, output: "flag_red", outputCount: 1 },
  { id: "flag_blue", inputs: { cloth: 1, stick: 1 }, output: "flag_blue", outputCount: 1 },
  { id: "fountain", inputs: { stone: 6, glass: 1 }, output: "fountain", outputCount: 1 },
  { id: "stairs", inputs: { planks_block: 2 }, output: "stairs", outputCount: 1 },
  { id: "bridge_block", inputs: { planks_block: 1, rope: 1 }, output: "bridge_block", outputCount: 1 },
  { id: "wood_gate_block", inputs: { planks_block: 2, stick: 1 }, output: "wood_gate_block", outputCount: 1 },
  { id: "stone_wall_block", inputs: { stone_brick_block: 2 }, output: "stone_wall_block", outputCount: 1 },
  { id: "scepter", inputs: { gold_ingot: 2, diamond: 1 }, output: "scepter", outputCount: 1 },
  { id: "tiara", inputs: { gold_ingot: 1, emerald: 1 }, output: "tiara", outputCount: 1 },
  { id: "star_crown", inputs: { crown: 1, star_shard: 1 }, output: "star_crown", outputCount: 1 },
  { id: "world_seed", inputs: { star_shard: 1, melon: 1, grape: 1 }, output: "world_seed", outputCount: 1 },
  { id: "ago_emblem", inputs: { mithril: 1, gold_ingot: 1 }, output: "ago_emblem", outputCount: 1 },
  // 精錬（かまど）: 鉱石をインゴットにする。木炭は木を焼く
  { id: "iron_ingot", inputs: { iron_ore: 2, coal: 1 }, output: "iron_ingot", outputCount: 1, kind: "smelt" },
  { id: "gold_ingot", inputs: { gold_ore: 2, coal: 1 }, output: "gold_ingot", outputCount: 1, kind: "smelt" },
  { id: "copper_ingot", inputs: { copper_ore: 2, coal: 1 }, output: "copper_ingot", outputCount: 1, kind: "smelt" },
  { id: "charcoal", inputs: { wood: 2 }, output: "charcoal", outputCount: 1, kind: "smelt" },
  // 織り（織り機）: 繊維から糸と布を作る
  { id: "string", inputs: { fiber: 2 }, output: "string", outputCount: 1, kind: "weave" },
  { id: "cloth", inputs: { fiber: 3 }, output: "cloth", outputCount: 1, kind: "weave" },
];



export function recipeById(id: unknown): Recipe | null {
  return typeof id === "string" ? RECIPES.find((r) => r.id === id) ?? null : null;
}

/** レシピの種別（未指定は "craft"）。 */
export function recipeKind(recipe: Recipe): RecipeKind {
  return recipe.kind ?? "craft";
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
  /** 適季（この季節は速く育つ。反対の季節は遅い）。 */
  season?: "spring" | "summer" | "autumn" | "winter";
  /** 1株からの収穫数。 */
  produceCount: number;
};

export const CROPS: readonly CropDef[] = [
  { id: "wheat", seedId: "wheat_seed", produceId: "wheat", growthMinutes: 10, produceCount: 2, season: "spring" },
  { id: "carrot", seedId: "carrot_seed", produceId: "carrot", growthMinutes: 12, produceCount: 2, season: "autumn" },
  { id: "potato", seedId: "potato_seed", produceId: "potato", growthMinutes: 15, produceCount: 2, season: "autumn" },
  { id: "cabbage", seedId: "cabbage_seed", produceId: "cabbage", growthMinutes: 16, produceCount: 2, season: "winter" },
  { id: "strawberry", seedId: "strawberry_seed", produceId: "strawberry", growthMinutes: 14, produceCount: 3, season: "spring" },
  { id: "tomato", seedId: "tomato_seed", produceId: "tomato", growthMinutes: 20, produceCount: 2, season: "summer" },
  { id: "corn", seedId: "corn_seed", produceId: "corn", growthMinutes: 18, produceCount: 2, season: "summer" },
  { id: "rice", seedId: "rice_seed", produceId: "rice", growthMinutes: 22, produceCount: 2, season: "summer" },
  { id: "pumpkin", seedId: "pumpkin_seed", produceId: "pumpkin", growthMinutes: 30, produceCount: 1, season: "autumn" },
  { id: "melon", seedId: "melon_seed", produceId: "melon", growthMinutes: 30, produceCount: 1, season: "summer" },
  { id: "onion", seedId: "onion_seed", produceId: "onion", growthMinutes: 14, produceCount: 2, season: "spring" },
  { id: "soybean", seedId: "soybean_seed", produceId: "soybean", growthMinutes: 16, produceCount: 3, season: "summer" },
  { id: "cucumber", seedId: "cucumber_seed", produceId: "cucumber", growthMinutes: 15, produceCount: 2, season: "summer" },
  { id: "eggplant", seedId: "eggplant_seed", produceId: "eggplant", growthMinutes: 20, produceCount: 2, season: "summer" },
  { id: "sweet_potato", seedId: "sweet_potato_seed", produceId: "sweet_potato", growthMinutes: 18, produceCount: 2, season: "autumn" },
  { id: "pepper", seedId: "pepper_seed", produceId: "pepper", growthMinutes: 18, produceCount: 3, season: "summer" },
  { id: "grape", seedId: "grape_seed", produceId: "grape", growthMinutes: 26, produceCount: 2, season: "autumn" },
  { id: "turnip", seedId: "turnip_seed", produceId: "turnip", growthMinutes: 12, produceCount: 2, season: "autumn" },
  { id: "chili", seedId: "chili_seed", produceId: "chili", growthMinutes: 18, produceCount: 3, season: "summer" },
  { id: "lettuce", seedId: "lettuce_seed", produceId: "lettuce", growthMinutes: 12, produceCount: 2, season: "spring" },
  { id: "radish", seedId: "radish_seed", produceId: "radish", growthMinutes: 16, produceCount: 2, season: "winter" },
  { id: "spinach", seedId: "spinach_seed", produceId: "spinach", growthMinutes: 13, produceCount: 2, season: "winter" },
  // 母数拡充 第2弾
  { id: "daikon", seedId: "daikon_seed", produceId: "daikon", growthMinutes: 18, produceCount: 2, season: "winter" },
  { id: "apple", seedId: "apple_seed", produceId: "apple", growthMinutes: 28, produceCount: 2, season: "autumn" },
  { id: "peach", seedId: "peach_seed", produceId: "peach", growthMinutes: 30, produceCount: 2, season: "summer" },
  { id: "cotton", seedId: "cotton_seed", produceId: "cotton", growthMinutes: 24, produceCount: 3, season: "autumn" },
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
