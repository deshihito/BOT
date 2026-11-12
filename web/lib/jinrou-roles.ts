// このファイルは scripts/export_jinrou_roles.py が core/game/jinrou/common.py から自動生成しています。手で編集しないでください。
export type JinrouTeam = "village" | "wolf" | "third";

export type JinrouRole = {
  id: string;
  name: string;
  team: JinrouTeam;
  teamLabel: string;
  ability: string;
  win: string;
  image: string | null;
};

export const JINROU_ROLES: JinrouRole[] = [
  {
    "id": "villager",
    "name": "一般通過あごむに",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "空気。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/nomal.png"
  },
  {
    "id": "tough-muni",
    "name": "タフむに",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "殺された時に最後の一撃で相手を道連れにする根性の一般通過。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/tahumuni.png"
  },
  {
    "id": "seer",
    "name": "占い師",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "毎晩1人を占える。安物のビー玉を使って白か黒かを見抜く。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/uranai.png"
  },
  {
    "id": "medium",
    "name": "霊媒師",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "昨日追放された者が白か黒か分かる。占い師とは商売敵なので中が悪い。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/reibai.png"
  },
  {
    "id": "great-medium",
    "name": "大霊媒師",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "霊媒師の上位職。追放者の白黒を自動通知に加え、夜に死者ならば誰でも調べられ役職まで判明する。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/daireibai.png"
  },
  {
    "id": "knight",
    "name": "騎士",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "毎晩1人をつまようじで守る。自分は守れない不器用なやつ。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/kishi.png"
  },
  {
    "id": "trapper",
    "name": "罠師",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "騎士の上位職。対象を守るだけでなく、狼が守った対象を襲撃した場合にその狼を返り討ちにする。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/wanasi.png"
  },
  {
    "id": "nyurou",
    "name": "入狼",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "人狼のような名前の村人。占われると黒判定が出る不幸なやつ。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/nyurou.png"
  },
  {
    "id": "baker",
    "name": "パン屋",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "生きていれば朝にパンを配る。飯を食え。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/panya.png"
  },
  {
    "id": "maasai",
    "name": "マサイ族",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "夜に1人を観察する。もし対象が人狼なら襲撃を50%で回避する準備を整える。真偽は誰にもわからない。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/masai.png"
  },
  {
    "id": "chairman",
    "name": "議長",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "会議中に『スキップ』で議論を即終了→通常投票へ。ゲーム中一回だけ『強制投票』と発言すると議長専用の投票箱が設置され、議長が直接追放対象を選べる。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/gityo.png"
  },
  {
    "id": "marble-breaker",
    "name": "ビー玉ブレイカー",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "占い師の判定が30%の確率でひっくり返る。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/bi-bure.png"
  },
  {
    "id": "lovers",
    "name": "リア充",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "2人1組で存在し、お互いが誰かを知っている。片方が死ぬともう片方も道連れになる。実は片方が不倫しているが見た目が同じにしか見えないのでどちらかかは分からない",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/riajuu.png"
  },
  {
    "id": "noble",
    "name": "貴族",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "奴隷とセットで発生。死亡判定を自動的に奴隷に肩代わりさせることができる（奴隷が存在する場合）。奴隷が誰か分かる。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/kizoku.png"
  },
  {
    "id": "slave",
    "name": "奴隷",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "貴族とセットで発生。貴族が死ぬと代わりに死ぬ。貴族が誰か分かる。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/dorei.png"
  },
  {
    "id": "party-person",
    "name": "陽キャ",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "毎晩1人をℳ𝓎𝒽ℴ𝓂ℯに連れ込む。相手が人狼/デカ狼なら陽キャが死ぬ。相手がメンヘラなら2人ともリア充に変化。それ以外は酔い潰してそのプレイヤーの夜のアクションをキャンセルする。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/765f556c89af682d.png"
  },
  {
    "id": "musician",
    "name": "ミュージシャン",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "陽キャの発展職。ゲーム中1度だけ夜にパーティを開催してランダムに4人を招待できる。招待者は殺されなくなり夜のアクションもキャンセル。ただし人狼/デカ狼が混じっていた場合30%で招待者の中の非狼陣営が1人死亡。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/246d72bdb68e5372.png"
  },
  {
    "id": "werewolf",
    "name": "人狼",
    "team": "wolf",
    "teamLabel": "人狼陣営",
    "ability": "村人を食べる。仲間同士は誰が人狼か知っている。",
    "win": "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。",
    "image": "/img/jinrou/jinrou.png"
  },
  {
    "id": "big-wolf",
    "name": "デカ狼",
    "team": "wolf",
    "teamLabel": "人狼陣営",
    "ability": "占い師を賄賂で黙らせる人狼。占い師に白判定を出させる。霊媒師には黒と出る。",
    "win": "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。",
    "image": "/img/jinrou/dekarou.png"
  },
  {
    "id": "madman",
    "name": "狂人",
    "team": "wolf",
    "teamLabel": "人狼陣営",
    "ability": "人狼の味方をする人間。人狼が誰かは知らないが、とにかく場を乱す。",
    "win": "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。",
    "image": "/img/jinrou/kyojin.png"
  },
  {
    "id": "fanatic",
    "name": "狂信者",
    "team": "wolf",
    "teamLabel": "人狼陣営",
    "ability": "人狼とデカ狼が誰かを知っている熱狂的なファン。人狼陣営の参謀。",
    "win": "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。",
    "image": "/img/jinrou/kyousinsya.png"
  },
  {
    "id": "hage",
    "name": "ハゲ",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "追放されたら勝利。髪の毛が観測できないバグのせいで目立ちすぎる。",
    "win": "投票で追放されたら、あなたの勝ち。陣営の勝敗には含まれません。",
    "image": "/img/jinrou/hage.png"
  },
  {
    "id": "bat-muni",
    "name": "コウモリむに",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "ハゲの上位職。ただし最後まで生き残れば追加勝利できる。",
    "win": "最後まで生き残れば、どちらの陣営が勝っても追加で勝ち。追放では勝てません。",
    "image": "/img/jinrou/koumori.png"
  },
  {
    "id": "menhera",
    "name": "メンヘラ",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "自分に関与した（占う、守る、食べる）者を物理的に消去する。占うと黒判定が出る。",
    "win": "人狼が全滅すれば勝ち（勝敗の判定では村人側として数えられます）。",
    "image": "/img/jinrou/menhera.png"
  },
  {
    "id": "agomuni-cannon",
    "name": "あごむに破道砲",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "自爆して対象を道連れにする。さらにもう1人も誤発で巻き込む。（※3日目の夜以降に使用可能）",
    "win": "人狼が全滅すれば勝ち（勝敗の判定では村人側として数えられます）。",
    "image": "/img/jinrou/agomunihadohou.png"
  },
  {
    "id": "wankoro",
    "name": "ワンころ",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "最初に飼い主を決める。飼い主が死ぬかいない場合は野良化して人狼になる。占うと黒判定が出る。",
    "win": "飼い主が生きていれば村人陣営と一緒に勝ちます。飼い主が死ぬかいないと人狼側になります。",
    "image": "/img/jinrou/wankoro.png"
  },
  {
    "id": "mokumoku",
    "name": "もくもく",
    "team": "third",
    "teamLabel": "第三者陣営",
    "ability": "ビー玉ブレイカーの発展職。3フェーズ全員の役職構成が非公開になる。死ぬと即時に役職構成が公開される。夜の行動ログももくもくになる",
    "win": "人狼が全滅すれば勝ち（勝敗の判定では村人側として数えられます）。",
    "image": "/img/jinrou/cd60d2fa8afdb21f.png"
  },
  {
    "id": "yandere",
    "name": "ヤンデレ",
    "team": "wolf",
    "teamLabel": "人狼陣営",
    "ability": "メンヘラの発展職、人狼1人をランダムに選びその人狼に夜干渉した人間を殺す。",
    "win": "人狼の数が村人と同じ以上になれば、人狼陣営の勝ちです。",
    "image": null
  },
  {
    "id": "netizen",
    "name": "ネット民",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "一般の役職と違い夜に発言でき昼に発言できない。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/af863387bd48b0f5.png"
  },
  {
    "id": "aho",
    "name": "アホ",
    "team": "village",
    "teamLabel": "村人陣営",
    "ability": "役職効果はなく村人陣営。占うと白判定となる。表示上はメンヘラ、ハゲ、狂人のいずれかに偽装されている。",
    "win": "人狼を全員追放・退治すれば、村人陣営の勝ちです。",
    "image": "/img/jinrou/nomal.png"
  }
];
