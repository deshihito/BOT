// クイズの純粋ロジック（UI 非依存・シード決定的）。
// 問題バンクから10問を抽選し、選択肢もシャッフルして出題する。
// 採点: 正解で100点＋連続正解ボーナス（連続数-1）×20点（上限+100）。
// 回答は answerQuestion で確定し（revealed フェーズ）、nextQuestion で次へ進む。

export type QuizCategory = "雑学" | "科学" | "歴史" | "スポーツ" | "アニメ・ゲーム";

export type QuizQuestion = {
  category: QuizCategory;
  question: string;
  /** 選択肢（バンク時点では answer が正解の位置）。出題時にシャッフルされる。 */
  choices: string[];
  answer: number;
};

export const QUIZ_QUESTIONS: QuizQuestion[] = [
  // ---- 雑学 ----
  { category: "雑学", question: "日本で一番面積が大きい都道府県はどこ？", choices: ["北海道", "青森県", "岩手県", "長野県"], answer: 0 },
  { category: "雑学", question: "富士山の標高は約何メートル？", choices: ["3,776m", "3,376m", "3,976m", "4,076m"], answer: 0 },
  { category: "雑学", question: "日本の国鳥に指定されている鳥は？", choices: ["キジ", "ツル", "トキ", "ハト"], answer: 0 },
  { category: "雑学", question: "うるう年は基本的に何年ごとにやってくる？", choices: ["4年", "2年", "5年", "10年"], answer: 0 },
  { category: "雑学", question: "ジャイアントパンダの主食は？", choices: ["竹・笹", "ユーカリ", "リンゴ", "ニンジン"], answer: 0 },
  { category: "雑学", question: "日本の硬貨で、穴が開いているのは5円玉ともう1種類。もう1種類は何円玉？", choices: ["50円玉", "10円玉", "100円玉", "500円玉"], answer: 0 },
  { category: "雑学", question: "ハチミツを作る昆虫は？", choices: ["ミツバチ", "アリ", "チョウ", "カブトムシ"], answer: 0 },
  { category: "雑学", question: "日本の都道府県の数はいくつ？", choices: ["47", "45", "43", "50"], answer: 0 },
  { category: "雑学", question: "1週間は何日ある？", choices: ["7日", "5日", "6日", "8日"], answer: 0 },
  { category: "雑学", question: "日本で一番長い川は？", choices: ["信濃川", "利根川", "石狩川", "木曽川"], answer: 0 },
  { category: "雑学", question: "世界で一番面積が大きい国は？", choices: ["ロシア", "カナダ", "中国", "アメリカ"], answer: 0 },
  { category: "雑学", question: "干支（えと）の動物は全部で何種類？", choices: ["12種類", "10種類", "24種類", "60種類"], answer: 0 },
  { category: "雑学", question: "オリンピックの五輪の輪の色は青・黄・黒・緑ともう1色。もう1色は？", choices: ["赤", "白", "紫", "オレンジ"], answer: 0 },
  { category: "雑学", question: "うるう日にあたる日付は？", choices: ["2月29日", "4月31日", "6月31日", "11月31日"], answer: 0 },
  { category: "雑学", question: "東京スカイツリーの高さは？", choices: ["634m", "333m", "553m", "828m"], answer: 0 },
  { category: "雑学", question: "世界で一番小さい国は？", choices: ["バチカン市国", "モナコ", "ナウル", "サンマリノ"], answer: 0 },
  { category: "雑学", question: "日本の国歌のタイトルは？", choices: ["君が代", "ふるさと", "さくらさくら", "海ゆかば"], answer: 0 },
  { category: "雑学", question: "トランプのカードは、ジョーカーを除いて全部で何枚？", choices: ["52枚", "48枚", "54枚", "40枚"], answer: 0 },
  { category: "雑学", question: "ジャイアントパンダのしっぽの色は？", choices: ["白", "黒", "茶色", "ピンク"], answer: 0 },
  { category: "雑学", question: "日本で一番人口が多い都道府県は？", choices: ["東京都", "大阪府", "愛知県", "神奈川県"], answer: 0 },
  { category: "雑学", question: "世界で一番高い山は？", choices: ["エベレスト", "富士山", "K2", "マッターホルン"], answer: 0 },
  { category: "雑学", question: "2024年に発行された新千円札の肖像になっている人物は？", choices: ["北里柴三郎", "野口英世", "津田梅子", "渋沢栄一"], answer: 0 },
  { category: "雑学", question: "世界で一番深い海溝は？", choices: ["マリアナ海溝", "日本海溝", "ジャワ海溝", "トンガ海溝"], answer: 0 },
  { category: "雑学", question: "日本で一番南にある都道府県は？", choices: ["沖縄県", "鹿児島県", "高知県", "宮崎県"], answer: 0 },
  { category: "雑学", question: "サイコロの向かい合う面の数字の合計は常にいくつ？", choices: ["7", "6", "8", "9"], answer: 0 },
  { category: "雑学", question: "日本で一番面積が小さい都道府県は？", choices: ["香川県", "大阪府", "東京都", "沖縄県"], answer: 0 },
  { category: "雑学", question: "虹の色は基本的に何色とされる？", choices: ["7色", "5色", "6色", "8色"], answer: 0 },
  { category: "雑学", question: "干支（えと）で、子（ね）の次に来る動物は？", choices: ["丑（うし）", "寅（とら）", "卯（うさぎ）", "辰（たつ）"], answer: 0 },
  { category: "雑学", question: "一般的なピアノの鍵盤は全部でいくつ？", choices: ["88鍵", "76鍵", "61鍵", "108鍵"], answer: 0 },
  { category: "雑学", question: "うるう年でない年（365日）は、全部で何週間と何日？", choices: ["52週と1日", "50週と5日", "48週と3日", "60週"], answer: 0 },
  { category: "雑学", question: "ことわざ「石の上にも」で、石の上に座り続ける年数は？", choices: ["3年", "1年", "5年", "10年"], answer: 0 },
  { category: "雑学", question: "日本で一番北にある都道府県は？", choices: ["北海道", "青森県", "岩手県", "秋田県"], answer: 0 },
  { category: "雑学", question: "トランプの4つのマーク（スート）に含まれないのはどれ？", choices: ["月（つき）", "ハート", "ダイヤ", "スペード"], answer: 0 },
  { category: "雑学", question: "世界で一番人口が多い国は？", choices: ["インド", "中国", "アメリカ", "インドネシア"], answer: 0 },
  { category: "雑学", question: "信号機で「進め」を表すランプの色は、日本では何色と呼ばれる？", choices: ["青", "緑", "黄", "白"], answer: 0 },
  { category: "雑学", question: "七夕（たなばた）は何月何日？", choices: ["7月7日", "3月3日", "5月5日", "12月25日"], answer: 0 },
  { category: "雑学", question: "日本の祝日「海の日」があるのは何月？", choices: ["7月", "8月", "6月", "9月"], answer: 0 },
  // ---- 科学 ----
  { category: "科学", question: "水の化学式はどれ？", choices: ["H2O", "CO2", "O2", "H2O2"], answer: 0 },
  { category: "科学", question: "太陽系で一番大きい惑星は？", choices: ["木星", "土星", "地球", "海王星"], answer: 0 },
  { category: "科学", question: "人間の体で一番大きな臓器（器官）は？", choices: ["皮膚", "肝臓", "心臓", "肺"], answer: 0 },
  { category: "科学", question: "光の速さは秒速でおよそどれくらい？", choices: ["約30万km", "約3万km", "約300万km", "約1,500km"], answer: 0 },
  { category: "科学", question: "植物が光合成で吸収する気体は？", choices: ["二酸化炭素", "酸素", "窒素", "水素"], answer: 0 },
  { category: "科学", question: "月が地球の周りを1周する期間はおよそ何日？", choices: ["約27日", "約7日", "約90日", "約365日"], answer: 0 },
  { category: "科学", question: "鉄の元素記号はどれ？", choices: ["Fe", "Ir", "In", "Te"], answer: 0 },
  { category: "科学", question: "音の速さは空気中でおよそ秒速何メートル？（気温15℃）", choices: ["約340m", "約150m", "約1,500m", "約3,000m"], answer: 0 },
  { category: "科学", question: "大人の人間の骨の数はおよそ何本？", choices: ["約206本", "約106本", "約306本", "約520本"], answer: 0 },
  { category: "科学", question: "空気の約78%を占める気体は？", choices: ["窒素", "酸素", "二酸化炭素", "アルゴン"], answer: 0 },
  { category: "科学", question: "人間の血液で酸素を運ぶ細胞は？", choices: ["赤血球", "白血球", "血小板", "リンパ球"], answer: 0 },
  { category: "科学", question: "地球から月までの距離はおよそどれくらい？", choices: ["約38万km", "約3万km", "約10万km", "約150万km"], answer: 0 },
  { category: "科学", question: "金の元素記号はどれ？", choices: ["Au", "Ag", "Cu", "Fe"], answer: 0 },
  { category: "科学", question: "水が凍る温度は摂氏何度？", choices: ["0℃", "4℃", "-10℃", "-273℃"], answer: 0 },
  { category: "科学", question: "人間の永久歯は全部で何本？（親知らずを含む）", choices: ["32本", "28本", "36本", "24本"], answer: 0 },
  { category: "科学", question: "酸素の元素記号はどれ？", choices: ["O", "Ox", "On", "Or"], answer: 0 },
  { category: "科学", question: "太陽の表面温度はおよそ何度？", choices: ["約6,000℃", "約600℃", "約60,000℃", "約1,500℃"], answer: 0 },
  { category: "科学", question: "月の重力は地球のおよそ何分の1？", choices: ["約6分の1", "約2分の1", "約10分の1", "約100分の1"], answer: 0 },
  { category: "科学", question: "ダイヤモンドは主に何という元素でできている？", choices: ["炭素", "ケイ素", "鉄", "カルシウム"], answer: 0 },
  { category: "科学", question: "地球から一番近い恒星は？", choices: ["太陽", "シリウス", "プロキシマ・ケンタウリ", "北極星"], answer: 0 },
  { category: "科学", question: "地震の規模（大きさ）を表す単位は？", choices: ["マグニチュード", "震度", "ヘルツ", "デシベル"], answer: 0 },
  { category: "科学", question: "惑星の中で「赤い惑星」と呼ばれるのは？", choices: ["火星", "金星", "水星", "木星"], answer: 0 },
  { category: "科学", question: "電流の単位は？", choices: ["アンペア", "ボルト", "ワット", "オーム"], answer: 0 },
  { category: "科学", question: "青いリトマス試験紙が酸性で変化する色は？", choices: ["赤", "黄", "緑", "変化しない"], answer: 0 },
  { category: "科学", question: "人間の歯で、食べ物をすりつぶす働きをする奥の歯を何という？", choices: ["臼歯", "犬歯", "切歯", "乳歯"], answer: 0 },
  { category: "科学", question: "水が沸騰する温度は摂氏何度？（1気圧）", choices: ["100℃", "90℃", "80℃", "120℃"], answer: 0 },
  { category: "科学", question: "銀の元素記号はどれ？", choices: ["Ag", "Au", "Si", "Al"], answer: 0 },
  { category: "科学", question: "昆虫の脚は全部で何本？", choices: ["6本", "8本", "4本", "10本"], answer: 0 },
  { category: "科学", question: "地球が1回自転するのにかかる時間はおよそ何時間？", choices: ["約24時間", "約12時間", "約36時間", "約48時間"], answer: 0 },
  { category: "科学", question: "太陽系で、太陽に一番近い惑星は？", choices: ["水星", "金星", "地球", "火星"], answer: 0 },
  { category: "科学", question: "植物の葉が緑色に見えるのは、主にどの色素のはたらき？", choices: ["葉緑素（クロロフィル）", "カロテン", "アントシアニン", "メラニン"], answer: 0 },
  { category: "科学", question: "氷が水に浮くのは、氷の密度が液体の水と比べてどうだから？", choices: ["小さいから", "大きいから", "同じだから", "季節で変わるから"], answer: 0 },
  { category: "科学", question: "音がまったく伝わらないのは、どんな空間？", choices: ["真空", "水中", "金属の中", "空気中"], answer: 0 },
  { category: "科学", question: "水素の元素記号はどれ？", choices: ["H", "He", "Hy", "W"], answer: 0 },
  { category: "科学", question: "人間の体で、血液の細胞を作る主な場所は？", choices: ["骨髄", "心臓", "肝臓", "脾臓"], answer: 0 },
  { category: "科学", question: "地震の揺れの強さを表す階級は？", choices: ["震度", "マグニチュード", "ヘクトパスカル", "ガル"], answer: 0 },
  { category: "科学", question: "クモの脚は全部で何本？", choices: ["8本", "6本", "10本", "4本"], answer: 0 },
  // ---- 歴史 ----
  { category: "歴史", question: "江戸幕府を開いた人物は？", choices: ["徳川家康", "織田信長", "豊臣秀吉", "源頼朝"], answer: 0 },
  { category: "歴史", question: "第二次世界大戦が終わったのは何年？", choices: ["1945年", "1918年", "1939年", "1953年"], answer: 0 },
  { category: "歴史", question: "織田信長が明智光秀に討たれた事件は？", choices: ["本能寺の変", "大坂の陣", "関ヶ原の戦い", "桶狭間の戦い"], answer: 0 },
  { category: "歴史", question: "「いい国作ろう鎌倉幕府」の語呂で知られる、源頼朝が征夷大将軍になった年は？", choices: ["1192年", "1185年", "1274年", "1333年"], answer: 0 },
  { category: "歴史", question: "明治時代が始まったのは何年？", choices: ["1868年", "1603年", "1853年", "1889年"], answer: 0 },
  { category: "歴史", question: "古代エジプトで使われた象形文字を何という？", choices: ["ヒエログリフ", "くさび形文字", "甲骨文字", "ローマ字"], answer: 0 },
  { category: "歴史", question: "人類で初めて月面に着陸した宇宙船は？", choices: ["アポロ11号", "ボストーク1号", "ソユーズ1号", "アポロ8号"], answer: 0 },
  { category: "歴史", question: "日本で最初とされる天皇は？", choices: ["神武天皇", "天智天皇", "聖徳太子", "桓武天皇"], answer: 0 },
  { category: "歴史", question: "日本国憲法が施行されたのは何年？", choices: ["1947年", "1945年", "1952年", "1960年"], answer: 0 },
  { category: "歴史", question: "アメリカ合衆国の初代大統領は？", choices: ["ジョージ・ワシントン", "リンカーン", "ジェファーソン", "ルーズベルト"], answer: 0 },
  { category: "歴史", question: "「万里の長城」がある国は？", choices: ["中国", "インド", "モンゴル", "韓国"], answer: 0 },
  { category: "歴史", question: "日本で最初のオリンピック（東京大会）が開催されたのは何年？", choices: ["1964年", "1940年", "1972年", "1988年"], answer: 0 },
  { category: "歴史", question: "『モナ・リザ』を描いた画家は？", choices: ["レオナルド・ダ・ヴィンチ", "ミケランジェロ", "ラファエロ", "ゴッホ"], answer: 0 },
  { category: "歴史", question: "『源氏物語』の作者は？", choices: ["紫式部", "清少納言", "小野小町", "和泉式部"], answer: 0 },
  { category: "歴史", question: "大化の改新が起きたのは何年？", choices: ["645年", "710年", "794年", "1192年"], answer: 0 },
  { category: "歴史", question: "ナポレオンが皇帝になった国は？", choices: ["フランス", "イタリア", "ドイツ", "イギリス"], answer: 0 },
  { category: "歴史", question: "1877年に設立された、日本で最初とされる大学は？", choices: ["東京大学", "京都大学", "慶應義塾大学", "早稲田大学"], answer: 0 },
  { category: "歴史", question: "平安京に都を移した天皇は？", choices: ["桓武天皇", "聖武天皇", "天武天皇", "文武天皇"], answer: 0 },
  { category: "歴史", question: "ベルリンの壁が崩壊したのは何年？", choices: ["1989年", "1945年", "1961年", "2001年"], answer: 0 },
  { category: "歴史", question: "1600年に起きた「天下分け目の戦い」と呼ばれる戦いは？", choices: ["関ヶ原の戦い", "長篠の戦い", "川中島の戦い", "壇ノ浦の戦い"], answer: 0 },
  { category: "歴史", question: "『枕草子』の作者は？", choices: ["清少納言", "紫式部", "小野小町", "和泉式部"], answer: 0 },
  { category: "歴史", question: "日本で最初の女性天皇とされるのは？", choices: ["推古天皇", "持統天皇", "卑弥呼", "光明皇后"], answer: 0 },
  { category: "歴史", question: "ペリーが黒船で浦賀に来航したのは何年？", choices: ["1853年", "1803年", "1868年", "1903年"], answer: 0 },
  { category: "歴史", question: "織田信長が今川義元を破った戦いは？", choices: ["桶狭間の戦い", "長篠の戦い", "川中島の戦い", "厳島の戦い"], answer: 0 },
  { category: "歴史", question: "日本で最初の鉄道が開通したのは、新橋とどこの間？", choices: ["横浜", "品川", "大宮", "上野"], answer: 0 },
  { category: "歴史", question: "1590年に豊臣秀吉が攻め落とし、天下統一の仕上げとなった城は？", choices: ["小田原城", "安土城", "大坂城", "岐阜城"], answer: 0 },
  { category: "歴史", question: "第二次世界大戦が始まったのは何年？", choices: ["1939年", "1941年", "1914年", "1945年"], answer: 0 },
  { category: "歴史", question: "聖徳太子が制定したとされる憲法は、何条からなる？", choices: ["十七条", "五条", "十条", "二十五条"], answer: 0 },
  { category: "歴史", question: "大日本帝国憲法が発布されたのは何年？", choices: ["1889年", "1868年", "1946年", "1902年"], answer: 0 },
  { category: "歴史", question: "鎌倉時代に日本へ2度にわたって来襲した外国の軍勢は？", choices: ["元（モンゴル）", "清", "唐", "高句麗"], answer: 0 },
  { category: "歴史", question: "『古事記』と『日本書紀』が編まれたのは、主に何時代？", choices: ["奈良時代", "平安時代", "鎌倉時代", "江戸時代"], answer: 0 },
  { category: "歴史", question: "豊臣秀吉が行った、百姓や寺社から刀や鉄砲を取り上げた政策は？", choices: ["刀狩", "楽市楽座", "参勤交代", "太閤検地"], answer: 0 },
  { category: "歴史", question: "日本で最初の内閣総理大臣は？", choices: ["伊藤博文", "大隈重信", "山県有朋", "板垣退助"], answer: 0 },
  { category: "歴史", question: "発明王エジソンが電球のフィラメントに使ったことで知られる、日本産の素材は？", choices: ["竹", "絹糸", "和紙", "木炭"], answer: 0 },
  { category: "歴史", question: "鎌倉時代、将軍に代わって政治の実権を握った北条氏の役職は？", choices: ["執権", "管領", "老中", "大老"], answer: 0 },
  // ---- スポーツ ----
  { category: "スポーツ", question: "サッカーで1チームがフィールドに出す選手の数は？", choices: ["11人", "9人", "10人", "12人"], answer: 0 },
  { category: "スポーツ", question: "オリンピックのシンボルマークにある輪の数は？", choices: ["5つ", "4つ", "6つ", "7つ"], answer: 0 },
  { category: "スポーツ", question: "マラソンの距離はおよそ何km？", choices: ["約42km", "約26km", "約50km", "約100km"], answer: 0 },
  { category: "スポーツ", question: "テニスの得点で「ラブ」は何点を表す？", choices: ["0点", "15点", "1点", "40点"], answer: 0 },
  { category: "スポーツ", question: "相撲の力士の最高位は？", choices: ["横綱", "大関", "関脇", "大将"], answer: 0 },
  { category: "スポーツ", question: "バスケットボールのリングの高さはおよそ何m？", choices: ["約3.05m", "約2.5m", "約3.5m", "約4m"], answer: 0 },
  { category: "スポーツ", question: "野球の試合（プロ野球）で通常のイニング数は？", choices: ["9回", "7回", "8回", "12回"], answer: 0 },
  { category: "スポーツ", question: "柔道や空手などの「段位」の下にあたる級の単位は？", choices: ["級", "品", "位", "階"], answer: 0 },
  { category: "スポーツ", question: "ゴルフで通常回るホールの数は？", choices: ["18ホール", "9ホール", "12ホール", "27ホール"], answer: 0 },
  { category: "スポーツ", question: "ラグビーで1チームがフィールドに出す選手の数は？", choices: ["15人", "11人", "13人", "7人"], answer: 0 },
  { category: "スポーツ", question: "箱根駅伝で走者が肩からかけてつなぐものは？", choices: ["たすき", "バトン", "タオル", "リボン"], answer: 0 },
  { category: "スポーツ", question: "水泳の泳法で最も速いとされるのは？", choices: ["クロール", "平泳ぎ", "背泳ぎ", "バタフライ"], answer: 0 },
  { category: "スポーツ", question: "囲碁の正式な盤は縦横それぞれ何路？", choices: ["19路", "13路", "15路", "21路"], answer: 0 },
  { category: "スポーツ", question: "サッカーのPK戦で、両チームがまず蹴る人数（ずつ）は？", choices: ["5人", "3人", "6人", "11人"], answer: 0 },
  { category: "スポーツ", question: "バレーボール（屋内）で1チームがコートに出す選手の数は？", choices: ["6人", "5人", "7人", "9人"], answer: 0 },
  { category: "スポーツ", question: "卓球の試合で、1ゲームを取るために必要な点数（通常）は？", choices: ["11点", "21点", "15点", "25点"], answer: 0 },
  { category: "スポーツ", question: "ボウリングで全てのピンを1投目で倒すことを何という？", choices: ["ストライク", "スペア", "ガーター", "ターキー"], answer: 0 },
  { category: "スポーツ", question: "剣道で使う、竹を束ねて作られた刀を何という？", choices: ["竹刀", "木刀", "竹剣", "模擬刀"], answer: 0 },
  { category: "スポーツ", question: "サッカーのワールドカップに日本代表が初出場したのは何年？", choices: ["1998年", "2002年", "1994年", "2010年"], answer: 0 },
  { category: "スポーツ", question: "バドミントンで打ち合う、羽根のついた球を何という？", choices: ["シャトル", "パック", "ピンポン球", "ブーメラン"], answer: 0 },
  { category: "スポーツ", question: "アイスホッケーで使う、硬いゴム製の円盤を何という？", choices: ["パック", "シャトル", "ボール", "リング"], answer: 0 },
  { category: "スポーツ", question: "野球で打者がフォアボールで歩くのは、ボールが何個になったとき？", choices: ["4個", "3個", "2個", "5個"], answer: 0 },
  { category: "スポーツ", question: "夏季オリンピックは通常何年ごとに開催される？", choices: ["4年", "2年", "3年", "5年"], answer: 0 },
  { category: "スポーツ", question: "競泳の個人メドレーで、最初に泳ぐ泳法は？", choices: ["バタフライ", "背泳ぎ", "平泳ぎ", "自由形"], answer: 0 },
  { category: "スポーツ", question: "ボクシングで、相手を倒して勝つことを何という？", choices: ["ノックアウト", "ドロー", "スプリット", "イップス"], answer: 0 },
  { category: "スポーツ", question: "アーチェリーで狙う的の、一番中心の部分の色は？", choices: ["黄色（金色）", "赤色", "白色", "青色"], answer: 0 },
  { category: "スポーツ", question: "フィギュアスケートのジャンプで、3回転半回るジャンプは？", choices: ["トリプルアクセル", "トリプルループ", "トリプルトウループ", "トリプルサルコウ"], answer: 0 },
  { category: "スポーツ", question: "ラグビーで「トライ」を決めると何点入る？", choices: ["5点", "3点", "2点", "7点"], answer: 0 },
  { category: "スポーツ", question: "バレーボールで、通常のセットを取るために必要な点数は？", choices: ["25点", "21点", "15点", "11点"], answer: 0 },
  { category: "スポーツ", question: "将棋の駒で、成っても金と同じ動きにならないのはどれ？", choices: ["角", "歩", "香", "桂"], answer: 0 },
  { category: "スポーツ", question: "ゴルフで、規定打数より1打少なくホールを終えることを何という？", choices: ["バーディー", "イーグル", "ボギー", "パー"], answer: 0 },
  { category: "スポーツ", question: "大相撲の本場所は、1年に何回開かれる？", choices: ["6回", "4回", "12回", "3回"], answer: 0 },
  { category: "スポーツ", question: "ゴルフで、規定打数より2打少なくホールを終えることを何という？", choices: ["イーグル", "バーディー", "アルバトロス", "コンドル"], answer: 0 },
  { category: "スポーツ", question: "バタフライ（蝶泳ぎ）は、もともとどの泳法の一部から生まれた？", choices: ["平泳ぎ", "クロール", "背泳ぎ", "犬かき"], answer: 0 },
  { category: "スポーツ", question: "野球で、走者のいない場面でホームランを打つと何点入る？", choices: ["1点", "2点", "3点", "4点"], answer: 0 },
  // ---- アニメ・ゲーム ----
  { category: "アニメ・ゲーム", question: "漫画『ドラゴンボール』の主人公は？", choices: ["孫悟空", "ベジータ", "孫悟飯", "ピッコロ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ポケットモンスター 赤・緑』の最初のパートナー（御三家）に含まれないのは？", choices: ["ピカチュウ", "フシギダネ", "ヒトカゲ", "ゼニガメ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "映画『となりのトトロ』で、トトロがバス停で差していたものは？", choices: ["傘", "帽子", "ステッキ", "風船"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ゲームキャラクター「マリオ」の弟の名前は？", choices: ["ルイージ", "ワリオ", "ヨッシー", "ドンキーコング"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『名探偵コナン』の主人公・江戸川コナンの本名は？", choices: ["工藤新一", "服部平次", "黒羽快斗", "毛利小五郎"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『風の谷のナウシカ』『天空の城ラピュタ』の監督は？", choices: ["宮崎駿", "高畑勲", "庵野秀明", "新海誠"], answer: 0 },
  { category: "アニメ・ゲーム", question: "落ち物パズル『テトリス』が生まれた国は？", choices: ["旧ソビエト連邦（ロシア）", "日本", "アメリカ", "イギリス"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ONE PIECE』の主人公ルフィが食べた悪魔の実は？", choices: ["ゴムゴムの実", "メラメラの実", "バラバラの実", "ヒトヒトの実"], answer: 0 },
  { category: "アニメ・ゲーム", question: "アニメ『ポケットモンスター』でサトシが最初に選んだポケモンは？", choices: ["ピカチュウ", "イーブイ", "フシギダネ", "リザードン"], answer: 0 },
  { category: "アニメ・ゲーム", question: "映画『魔女の宅急便』の主人公の名前は？", choices: ["キキ", "ナウシカ", "シータ", "メイ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『マインクラフト』で近づくと自爆する緑色の敵は？", choices: ["クリーパー", "ゾンビ", "スケルトン", "エンダーマン"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『スプラトゥーン』で地面や敵に塗りつけるものは？", choices: ["インク", "水", "絵の具", "墨汁"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『鬼滅の刃』の主人公・炭治郎の妹の名前は？", choices: ["禰豆子", "カナヲ", "しのぶ", "珠世"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラゴンクエスト』シリーズの代表的なモンスターは？", choices: ["スライム", "ゴブリン", "オーク", "トロール"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『スーパーマリオブラザーズ』で、踏んで倒せるキノコのような敵の名前は？", choices: ["クリボー", "ノコノコ", "パタパタ", "カメック"], answer: 0 },
  { category: "アニメ・ゲーム", question: "アニメ『サザエさん』のサザエの名字（結婚後）は？", choices: ["フグ田", "磯野", "波野", "伊佐坂"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『マインクラフト』で、ダイヤモンド鉱石を掘るために最低限必要なツルハシの素材は？", choices: ["鉄", "金", "石", "木"], answer: 0 },
  { category: "アニメ・ゲーム", question: "映画『千と千尋の神隠し』で、千尋が働くことになる場所は？", choices: ["湯屋", "旅館", "銭湯", "食堂"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ポケットモンスター』のピカチュウの全国図鑑番号は？", choices: ["25番", "1番", "151番", "133番"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ボードゲーム『人生ゲーム』でマスを進めるために回すものは？", choices: ["ルーレット", "サイコロ", "コイン", "カード"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラえもん』のドラえもんが大好物の食べ物は？", choices: ["どら焼き", "たい焼き", "大判焼き", "カステラ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ポケットモンスター 赤・緑』で最初に選べるポケモンは何匹？", choices: ["3匹", "2匹", "4匹", "5匹"], answer: 0 },
  { category: "アニメ・ゲーム", question: "漫画『SLAM DUNK』の主人公・桜木花道のポジションは？", choices: ["パワーフォワード", "センター", "ポイントガード", "シューティングガード"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ファイナルファンタジー』シリーズで、騎乗できる黄色い大きな鳥は？", choices: ["チョコボ", "モーグリ", "トンベリ", "サボテンダー"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『クレヨンしんちゃん』の主人公のフルネームは？", choices: ["野原しんのすけ", "野原ひろし", "風間トオル", "佐藤マサオ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "ゲーム『あつまれ どうぶつの森』で、島の案内役をするタヌキは？", choices: ["たぬきち", "しずえ", "まめきち", "つぶきち"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『鋼の錬金術師』で、錬金術の基本とされる原則は？", choices: ["等価交換", "質量保存", "因果応報", "等量交換"], answer: 0 },
  { category: "アニメ・ゲーム", question: "初代『ポケットモンスター 赤・緑』が発売された携帯ゲーム機は？", choices: ["ゲームボーイ", "ゲームボーイアドバンス", "ニンテンドーDS", "バーチャルボーイ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『どうぶつの森』シリーズで、品物を売って得られる通貨の単位は？", choices: ["ベル", "ルピー", "ギル", "ゼニー"], answer: 0 },
  { category: "アニメ・ゲーム", question: "アニメ『ちびまる子ちゃん』の主人公・まる子の名字は？", choices: ["さくら", "野原", "磯野", "フグ田"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『スーパーマリオ』シリーズで、マリオが大きくなるアイテムは？", choices: ["スーパーキノコ", "スーパースター", "ファイアフラワー", "1UPキノコ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "パズルゲーム『ぷよぷよ』で、消すために同じ色をいくつつなげる？", choices: ["4個", "3個", "5個", "6個"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラえもん』の野比のび太の特技として知られるものは？", choices: ["あやとり", "野球", "ピアノ", "水泳"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『スーパーマリオブラザーズ』で、マリオがクッパから救い出すお姫様は？", choices: ["ピーチ姫", "デイジー姫", "ゼルダ姫", "ロゼッタ"], answer: 0 },
  { category: "アニメ・ゲーム", question: "『ドラゴンクエスト』シリーズで、HPを回復する呪文は？", choices: ["ホイミ", "メラ", "ギラ", "ヒャド"], answer: 0 },
  { category: "アニメ・ゲーム", question: "漫画『ONE PIECE』の主人公ルフィが目指している称号は？", choices: ["海賊王", "海軍大将", "四皇", "王下七武海"], answer: 0 },
];

export const QUIZ_TOTAL_QUESTIONS = 10;
export const QUIZ_BASE_SCORE = 100;
/** 連続正解1つごとのボーナス（上限あり）。 */
export const QUIZ_STREAK_BONUS = 20;
export const QUIZ_STREAK_BONUS_CAP = 100;

export type QuizPhase = "answering" | "revealed" | "finished";

export type QuizAnswerRecord = {
  /** バンク内の問題インデックス。 */
  bankIndex: number;
  category: QuizCategory;
  picked: number;
  correct: boolean;
  /** この回答で得た得点。 */
  gained: number;
  /** 回答直後の連続正解数。 */
  streak: number;
};

export type QuizState = {
  seed: number;
  /** 出題順（バンク内インデックス）。 */
  order: number[];
  /** 出題用に選択肢をシャッフル済みの問題（order と同じ順）。 */
  deck: QuizQuestion[];
  /** 現在の問題番号（0始まり）。 */
  current: number;
  phase: QuizPhase;
  score: number;
  streak: number;
  bestStreak: number;
  answers: QuizAnswerRecord[];
  /** 直近の回答結果（revealed フェーズの表示用）。 */
  last: { picked: number; correct: boolean; gained: number; correctIndex: number } | null;
};

/** mulberry32。状態を数値で持ち回り、決定的に再現できるようにする。 */
function nextRandom(rng: number): { value: number; rng: number } {
  let t = (rng + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, rng: t | 0 };
}

function shuffledIndexes(count: number, rng: number): { order: number[]; rng: number } {
  const order = Array.from({ length: count }, (_, i) => i);
  let r = rng;
  for (let i = order.length - 1; i > 0; i--) {
    const nr = nextRandom(r);
    r = nr.rng;
    const j = Math.floor(nr.value * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return { order, rng: r };
}

export function createQuizGame(seed: number, total: number = QUIZ_TOTAL_QUESTIONS): QuizState {
  const take = Math.max(1, Math.min(Math.floor(total) || QUIZ_TOTAL_QUESTIONS, QUIZ_QUESTIONS.length));
  let rng = seed | 0;
  const picked = shuffledIndexes(QUIZ_QUESTIONS.length, rng);
  rng = picked.rng;
  const order = picked.order.slice(0, take);
  const deck: QuizQuestion[] = order.map((bankIndex) => {
    const q = QUIZ_QUESTIONS[bankIndex];
    const sh = shuffledIndexes(q.choices.length, rng);
    rng = sh.rng;
    const choices = sh.order.map((i) => q.choices[i]);
    return { category: q.category, question: q.question, choices, answer: sh.order.indexOf(q.answer) };
  });
  return {
    seed: seed | 0,
    order,
    deck,
    current: 0,
    phase: "answering",
    score: 0,
    streak: 0,
    bestStreak: 0,
    answers: [],
    last: null,
  };
}

/** 現在の問題（終了時は null）。 */
export function currentQuizQuestion(state: QuizState): QuizQuestion | null {
  if (state.phase === "finished") return null;
  return state.deck[state.current] ?? null;
}

/** 連続正解数（この回答を含む）から得点を計算する。 */
export function quizGainForStreak(streak: number): number {
  const s = Math.max(1, Math.floor(streak));
  return QUIZ_BASE_SCORE + Math.min((s - 1) * QUIZ_STREAK_BONUS, QUIZ_STREAK_BONUS_CAP);
}

/** 選択肢を確定する。不正な入力・フェーズ違いは同状態を返す。 */
export function answerQuestion(state: QuizState, choice: number): QuizState {
  if (state.phase !== "answering") return state;
  const q = state.deck[state.current];
  if (!q) return state;
  if (!Number.isInteger(choice) || choice < 0 || choice >= q.choices.length) return state;
  const correct = choice === q.answer;
  const streak = correct ? state.streak + 1 : 0;
  const gained = correct ? quizGainForStreak(streak) : 0;
  const record: QuizAnswerRecord = {
    bankIndex: state.order[state.current],
    category: q.category,
    picked: choice,
    correct,
    gained,
    streak,
  };
  return {
    ...state,
    phase: "revealed",
    score: state.score + gained,
    streak,
    bestStreak: Math.max(state.bestStreak, streak),
    answers: [...state.answers, record],
    last: { picked: choice, correct, gained, correctIndex: q.answer },
  };
}

/** 次の問題へ進む。最後の問題の後は finished。 */
export function nextQuestion(state: QuizState): QuizState {
  if (state.phase !== "revealed") return state;
  const next = state.current + 1;
  if (next >= state.deck.length) {
    return { ...state, phase: "finished", last: null };
  }
  return { ...state, current: next, phase: "answering", last: null };
}

export type QuizCategoryStat = { category: QuizCategory; total: number; correct: number };

/** カテゴリ別の出題数と正解数（回答済み分のみ）。出題順のカテゴリ出現順。 */
export function quizCategoryStats(state: QuizState): QuizCategoryStat[] {
  const map = new Map<QuizCategory, QuizCategoryStat>();
  for (const a of state.answers) {
    const entry = map.get(a.category) ?? { category: a.category, total: 0, correct: 0 };
    entry.total += 1;
    if (a.correct) entry.correct += 1;
    map.set(a.category, entry);
  }
  return [...map.values()];
}

export function quizCorrectCount(state: QuizState): number {
  return state.answers.filter((a) => a.correct).length;
}

/** 正解率に応じた評価ラベルと一言。 */
export function quizGrade(state: QuizState): { label: string; comment: string } {
  const total = state.answers.length;
  if (total === 0) return { label: "未挑戦", comment: "まずは1問解いてみましょう。" };
  const ratio = quizCorrectCount(state) / total;
  if (ratio >= 1) return { label: "全問正解！", comment: "完璧です。クイズマスターの称号ものです。" };
  if (ratio >= 0.8) return { label: "優秀", comment: "あと少しで全問正解。素晴らしい知識量です。" };
  if (ratio >= 0.6) return { label: "良好", comment: "安定した成績です。苦手カテゴリを潰すとさらに伸びます。" };
  if (ratio >= 0.4) return { label: "あと一歩", comment: "得意カテゴリは見えてきました。連続正解でボーナスを狙いましょう。" };
  return { label: "修行中", comment: "まずは得意なカテゴリから正解を重ねていきましょう。" };
}
