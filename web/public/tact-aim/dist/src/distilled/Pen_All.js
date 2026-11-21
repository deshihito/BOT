// Pen/All（全体の約 90% が集まるモノリス。手順 81 件 + スクリプト 17 本）— 蒸留完了。
// 生成版 src/generated/Pen_All.ts の置換。チャンク単位で手順を置き換えていく。
// 完了条件は各チャンク共通: 対応する単体テスト（手計算の期待値）+ 起動ダイジェスト不変。
//
// 蒸留済みチャンク:
//   チャンク1（クラウド・同期）: Cloud / Load cloud data / Pick up data /
//     Pick up user name / Find player / Add player movement / Static data / Create user ID
//   チャンク2（初期化・共通）: Set val / Set size / Search first / Data cut 3 to 2 /
//     ID check / Set pet position / Reset val / Add combat data
//   チャンク3a（戦闘・弾の前半）: Shot / Reload inventory / Damage / Delete / Create /
//     Distance to bullet / Player shot / Damage effect / Set bullet val / Weapon motion /
//     Direction to bullet / Laser sight / Set weapon / Reset dummy damage / Create guard
//   チャンク3b（戦闘・弾の後半）: Bullet action（Bullet_list の命令解釈系）/ Shot create
//   チャンク4（描画コア）: Draw players / Draw wall & object / Hit wall /
//     Draw bullet / Draw map object
//   チャンク5（UI）: Draw UI
//   チャンク6（メイン）: All / Button / Bullet wall
//   チャンク7（描画・テキスト残り）: Draw text / Pen mode / Set player data temp /
//     Draw square / Draw inventory / Draw lock on / Draw my combat status /
//     Draw screen effect / Draw NPC / Stamp / Draw character status bar /
//     Draw player search / Fix position / Draw skill gage / Draw teammate /
//     Draw screen stamp / Draw arrow / Arrow bar / Draw tutorial / Hand position /
//     Draw dummy rail / Draw ship / Laser detect / Draw character mission / Draw team point
//   チャンク8（メニュー・移動・その他）: Step / CS val / Break wall / Set motion /
//     CSM menu / Sound / Put buff / Get skill point / Get mission point / Make sound /
//     Respawn / Set inventory / Team invitation / Mobile + スクリプト 17 本
//   → Pen/All の全 81 手順 + 17 スクリプトの蒸留が完了した。
//
// 共有フィールドの方針（このスプライト特有）:
//   a〜i 等の 1 文字フィールドは手順間の受け渡しインターフェースそのもの
//   （例: デコーダのカーソル b と結果 c、[b,c] と手順名に明記される）であり、
//   他スプライトから varByName でも読まれるため改名しない。役割は各手順の冒頭で注記する。
//   a_2〜e_2 は原作 sb3 に同名変数（"a"〜"e"）が 2 組あることによる重複で、
//   手順本体が使うのは初期値のある 1 組目（a=2000, b=31, c=1, d=94, e=2.7）の方。
//   2 組目（a_2〜e_2、初期値 0）はどのブロックからも参照されない死んだ複製
//   （2026-11-21 に sb3 の変数 ID を実測して確定）。
import { Sprite } from "../runtime/runtime.js";
import { SList } from "../runtime/list.js";
import { toNumber as N, toString as S, toBoolean as B, compare, equals, mod, random, mathop, letterOf } from "../runtime/cast.js";
import { G } from "../generated/globals.js";
// var: "Mouse touch" -> this.Mouse_touch
// var: "Mouse wheel" -> this.Mouse_wheel
// var: "FPS counter" -> this.FPS_counter
// var: "Hold click" -> this.Hold_click
// var: "First number" -> this.First_number
// var: "First distance" -> this.First_distance
// var: "First type" -> this.First_type
// var: "Bomb damage" -> this.Bomb_damage
// var: "Bullet damage" -> this.Bullet_damage
// var: "DPS counter" -> this.DPS_counter
// var: "Hit ID" -> this.Hit_ID
// var: "IF()" -> this.IF
// var: "IF T/F" -> this.IF_T_F
// var: "IF ACT" -> this.IF_ACT
// var: "Attack power" -> this.Attack_power
// var: "Kill point" -> this.Kill_point
// var: "#Touch" -> this.Touch
// var: "Hit?" -> this.Hit
// var: "a" -> this.a_2
// var: "c" -> this.c_2
// var: "d" -> this.d_2
// var: "b" -> this.b_2
// var: "e" -> this.e_2
// var: "F key" -> this.F_key
// var: "@Bullet team ID" -> this.Bullet_team_ID
// var: "Drag x" -> this.Drag_x
// var: "Drag y" -> this.Drag_y
// var: "Drag touch" -> this.Drag_touch
// var: "Match damage" -> this.Match_damage
// var: "Dummy X" -> this.Dummy_X
// var: "Dummy Y" -> this.Dummy_Y
// var: "Frame cutter" -> this.Frame_cutter
// var: "Turreting?" -> this.Turreting
// var: "Bullet wall?" -> this.Bullet_wall
// var: "Mud?" -> this.Mud
// var: "timer temp" -> this.timer_temp
// list: "Font size / Draw" -> this.Font_size___Draw
// list: "@Pickupped" -> this.Pickupped
// list: "@Cloud check" -> this.Cloud_check
// list: "Temp1" -> this.Temp1_2
// list: "Delete bullet" -> this.Delete_bullet
// list: "Players shot" -> this.Players_shot
// list: "Players hit" -> this.Players_hit
// list: "Temp2" -> this.Temp2_2
// list: "Screen effect" -> this.Screen_effect
// list: "Delete screen effect" -> this.Delete_screen_effect
// list: "Laser sight" -> this.Laser_sight
// list: "#Bullet" -> this.Bullet
// list: "Bullet name" -> this.Bullet_name
// list: "Character status" -> this.Character_status
// list: "Wall position" -> this.Wall_position
// list: "Screen stamp" -> this.Screen_stamp
// list: "Buff name" -> this.Buff_name
// list: "Chat" -> this.Chat_2
// list: "Chat user" -> this.Chat_user
// list: "Inventory mode" -> this.Inventory_mode
// list: "Skill counter" -> this.Skill_counter
// list: "Team chat" -> this.Team_chat
// list: "Player movement" -> this.Player_movement
// list: "Player wall" -> this.Player_wall
// list: "Gimmick wall" -> this.Gimmick_wall
// list: "Quick chat" -> this.Quick_chat
export class Pen_All extends Sprite {
    a = 2000;
    c = 1;
    b = 31;
    Temp1 = 3;
    Mouse_touch = "Shot";
    Clicking = 0;
    IDX = 18;
    IDY = 99999;
    Mouse_wheel = "-1";
    FPS_counter = 15;
    Hold_click = 0;
    d = 94;
    First_number = "0000";
    First_distance = 99999;
    First_type = "E";
    Bomb_damage = 0;
    Bullet_damage = 0;
    e = 2.7;
    f = "";
    DPS_counter = 0;
    Hit_ID = 6802;
    IF = 0;
    IF_T_F = "T";
    IF_ACT = 1;
    Attack_power = 1;
    g = "-";
    Kill_point = 0;
    Touch = 0;
    Hit = 0;
    a_2 = 0;
    c_2 = 0;
    d_2 = 0;
    b_2 = 0;
    e_2 = 0;
    Temp2 = 0;
    F_key = 0;
    Temp3 = 300;
    h = 264.91499703224605;
    Bullet_team_ID = 6802;
    i = 0;
    j = -759.9136700477335;
    k = 0;
    Drag_x = "";
    Drag_y = "";
    Drag_touch = "";
    Match_damage = 0;
    Dummy_X = -437.5064719416598;
    Dummy_Y = 487.5064719416598;
    Chat = "00";
    Frame_cutter = 182;
    Turreting = 0;
    Temp4 = "レーザーギミック";
    Bullet_wall = 1;
    Temp5 = 0;
    OtherCP = 0;
    Mud = 0;
    timer_temp = 0;
    Font_size___Draw = new SList([6, 7, 6, 7, 7, 6, 7, 7, 3, 4, 7, 4, 10, 7, 7, 7, 7, 5, 6, 6, 7, 7, 11, 7, 7, 6, 10, 8, 8, 9, 7, 7, 9, 9, 3, 5, 8, 7, 10, 8, 9, 8, 9, 8, 8, 9, 8, 9, 13, 8, 8, 8, 7, 7, 7, 7, 8, 7, 7, 7, 8, 7, 5, 7, 6, 3, 7, 12, 9, 3, 4, 4, 5, 11, 4, 4, 6, 7, 3, 3, 3, 3, 5, 5, 7, 7, 7, 3, 20]);
    Pickupped = new SList(["", ""]);
    Cloud_check = new SList([0.57]);
    Temp1_2 = new SList(["ピストル"]);
    Delete_bullet = new SList([]);
    Players_shot = new SList([]);
    Players_hit = new SList([]);
    Temp2_2 = new SList([1, 2, 4, 4, 2, 3, 4, 2]);
    Screen_effect = new SList([]);
    Delete_screen_effect = new SList([]);
    Laser_sight = new SList([]);
    Bullet = new SList([1, 31, 61, 82, 103, 133, 160, 220, 158, 280, 328, 345, 386, 423, 440, 457, 478, 500, 533, 564, 574, 604, 635, 665, 695, 716, 746, 776, 829, 846, 874, 902, 932, 957, 974, 1004, 1034, 1065, 1095, 1125, 1155, 1185, 1232, 1286, 1320, 1344, 1384, 1418, 1442, 1477, 1507, 1574, 1627, 1660, 1690, 1720, 1767, 1796, 1833, 1887, 1940, 2006, 2042, 2066, 2107, 2148, 2165, 2201, 2226, 2258, 2301, 2347, 2377, 2421, 2487, 2497, 2515, 2546, 2591, 2608, 2625, 2662, 2698, 2714, 2730, 2801, 2837, 2854, 2889, 2953, 3002, 3005, 3037, 3048, 3066, 3156, 3192, 3222, 3253, 3350, 3392, 3428, 3464, 3491, 3561, 3591, 3627, 3650, 3671, 3701, 3722, 3768, 3804, 3840, 3872, 3900, 3936, 3969, 3992, 4019, 4040, 4075, 4085, 4121, 4151, 4182, 4223, 4253, 4278, 4311, 4356, 4391, 4402, 4413, 4424, 4435, 4446, 4486, 4520, 4556, 4576, 4597, 4622, 4658, 4698, 4738, 4790, 4817, 4857, 4912, 4932, 4959, 4970, 4990, 5037, 5068, 5096, 5149, 5169, 5180, 5191, 5202, 5243, 5260, 5300, 5327, 5344, 5381, 5417, 5451, 5473, 5507, 5543, 5588]);
    Bullet_name = new SList(["ピストル", "マシンガン", "アサルトライフル", "スナイパーライフル", "コンバットライフル", "Damage val", "My kill", "Other kill", "IF END", "爆発", "手榴弾", "中回復エフェクト", "フラッシュ爆発", "フラッシュボム", "ミニ手榴弾", "サイレンサ付スナイパーライフル", "レーザーサイト付スナイパーライフル", "自然回復短縮エフェクト", "Gobo spike", "Money", "サイレンサ付ピストル", "レーザーサイト付ピストル", "ハンドガン", "ウージー", "ヘビーアサルトライフル", "ショットガン", "タクティカルショットガン", "火炎爆発", "モロトフカクテル", "ポテトマッシャー", "強化型ポテトマッシャー", "早打ち銃", "銛スナイパー", "飛び散りボム", "空の魔導書", "マジックスティック", "幻夢のハープ", "コンパクトサブマシンガン", "FA-MAS", "火縄銃", "セミオートライフル", "ロケット", "カースバレット", "鉄球", "地雷", "自然の奇跡", "水晶玉", "クレイモア", "魔法の水", "ヘキサスコープカスタム", "Sマイン", "大地の杖", "テラァシューター", "ダブルバレルショットガン", "煙", "四連ロケットランチャー", "スキル発動", "スモーク", "ヒーリングゾーン", "破壊レーザー", "魔剣", "護身エフェクト", "Sシェアパック", "シェアパック", "回復爆発", "回復スプレー", "シールド3", "スーパーバリア", "シェアバリア", "Sシェアバリア", "ネット爆発", "ネットランチャー", "お祓いエフェクト", "擲弾発射機", "シールドキャノン", "戦車主砲", "戦車重機関銃", "スモーク爆発", "戦車火炎弾", "戦車発煙弾", "マキビシ", "ゼンマイ式ライフル", "大剣", "騎士の剣", "投擲用ナイフ", "シャドウスナイパー", "パワーボム", "スパイクボール", "神秘のトーテム", "死神の鎌", "Chat", "迫撃砲弾", "Tektite", "US-144", "TM-016", "力の塗り薬", "スイカSMG", "コインガン", "レーザートラップ", "スパークリングドリンク", "視野アップエフェクト", "トリート", "トリック", "Pumpkin soul", "スモークマイン", "リジェネタブレット", "力の祭壇", "ショットスナイパー", "バレットミニガン", "エンジンライフル", "パワーマイン", "絆創膏", "ソードポーション", "近接カウンター", "羽衣の加護", "炎の魔導書", "バッテリー", "雷の塔", "灯台", "スノードーム", "サンタ", "Present", "アイスブーツエフェクト", "雪玉", "かまくら", "粉雪爆発", "スノーボールキャノン", "つらら", "マジックインゴット", "救急箱", "ガード欠片", "Cクイックガード", "Cラージガード", "Sラージガード", "Cサークルガード", "Sサークルガード", "CS-M", "追尾ミサイル", "ガードレーザー", "Cレーザーガード", "ゴ棒", "シールドバッシュエフェクト", "シールドバッシュ", "シールドファンネル", "ファンネルポッドガード", "ポイズンチャクラム", "ファイヤーマイン", "デストロイヤーレーザー", "デストロイヤー", "JJ-100", "BS-0001エフェクト", "BSガード", "BS-0002", "BS-0001", "KIPI missile", "KIPI", "毒ガス", "Cポイズンガード", "Gウォールガード", "Cステルスガード", "Gライフクリスタル", "サンライト爆発", "サンライトボム", "レーザーキャノン", "ボールバズーカ", "マジックワープ", "回復フラッシュ爆発", "レーザーギミック", "ミサイル", "エネルギーボール", "AK-47", "BPレーザー", "GBP-080", "Team kill"]);
    Character_status = new SList([0.85, 1.2, 100, 250, 4.5, 6.2, 0.7, 1.5, 200, 2200, -2, -0.7]);
    Rank = new SList(["Wood I", 0, "Wood II", 1, "Wood III", 2, "Stone I", 5, "Stone II", 6, "Stone III", 7, "Iron I", 10, "Iron II", 13, "Iron III", 16, "Gold I", 20, "Gold II", 25, "Gold III", 30, "Ruby I", 50, "Ruby II", 65, "Ruby III", 80]);
    Wall_position = new SList([]);
    Screen_stamp = new SList([]);
    Buff_name = new SList(["怒り", "落石注意", "ダッシュ", "アサシン", "急速充電", "オーバークロック", "力の塗り薬2", "力のポーション", "お守り", "護身", "護身+", "シールド3", "シールド2", "シールド1", "リジェネ", "オーバーヒート", "毒", "負傷", "ネット", "アイスブーツ", "魔改造", "スタートダッシュ", "平和", "ショップ", "耐爆", "めまい", "疲労", "結束の代償", "呪詛", "力の塗り薬1", "防御力減少", "攻撃力アップ", "視野アップ", "ブースト", "トリート", "耐弾", "トーテムの加護", "シェアバリア", "力の祭壇", "鈍化", "再生", "羽衣の加護", "ソード3", "ソード2", "ソード1", "火傷", "灯台", "雷の塔", "スーパーバリア", "粉雪", "スノードーム", "クリスマス1", "クリスマス2", "クリスマス3", "クリスマス4", "クリスマス5", "クリスマス6", "クリスマス7", "クリスマス8", "クリスマス9", "凍傷", "回復中", "弾薬箱", "ポイズンチャクラム", "リジェネカース", "JJ-100", "テラ毒", "熱中症", "マップ開発", "貫通", "BP-080", "モバイル"]);
    Starter = new SList(["ピストル", "マシンガン", "アサルトライフル", "テラァシューター", "騎士の剣", "", "手榴弾", "ミニ手榴弾", "フラッシュボム", "パワーボム", 1, 7]);
    Chat_2 = new SList(["こんにちは", "装備いいね", "こっちにきて", "ちょっと待って", "抜けます", "一旦戻ります", "", "", "", "", "はい", "いいえ", "ありがとう！", "ごめんなさい", "間違えました", "", "", "", "", "", "チームを組もう", "チームに入れて", "パーティーしよう", "チーム抜けます", "ここを守ろう", "編成真似して", "", "", "", "", "ガントリック", "エンジョイ！", "ワイパー", "プロペラ", "拍手！", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "Hello!", "You look cool", "Come here", "Wait a minute", "I'll leave game", "I'll go to home", "", "", "", "", "Yes", "No", "Thank you!", "Sorry", "Wrong", "", "", "", "", "", "Team up", "May I join team?", "Let's party!", "I'll leave team", "Let's protect here", "Copy my weapon", "", "", "", "", "[Gun trick]", "[Enjoy!]", "[Wiper]", "[Propeller]", "[Clap!]", "", "", "", "", ""]);
    Chat_user = new SList([]);
    Inventory_mode = new SList([1, "", "", "", "", "", "", "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0, "", "", 0, 0, 0, 0]);
    Skill_counter = new SList([]);
    Team_chat = new SList([]);
    Player_movement = new SList([]);
    Player_wall = new SList(["-2/-2", "-2/-3", "2/-2", "2/-3", "-6/-3", "-6/-2", "2/3", "2/4", "-2/3", "-2/4", "-6/4", "-6/3", "8/1", "1/-4", "0/-4", "-1/-4", "-2/-4", "7/2", "6/2", "2/2", "1/4", "0/4", "-1/4", "-2/2", "-3/4", "-4/4", "-5/4", "-6/2", "-6/-4", "-5/-4", "-4/-4", "-3/-4", "5/2", "-13/2", "-13/-1", "-13/-2", "-13/-3", "-6/-5", "-6/-6", "-13/-5", "-13/-4", "5/4", "-13/9", "-13/8", "-13/7", "-13/5", "-13/4", "-11/2", "-12/2", "6/4", "8/4", "8/5", "8/6", "8/7", "8/8", "8/9", "8/12", "4/12", "3/12", "2/12", "0/12", "1/12", "-5/12", "-13/12", "-13/11", "8/11", "8/-4", "8/-5", "8/-6", "8/-7", "8/-8", "8/-9", "8/-10", "7/-10", "6/-10", "5/-10", "4/-10", "3/-10", "2/-10", "1/-10", "0/-10", "-1/-10", "-2/-10", "-3/-10", "-4/-10", "-5/-10", "-6/-10", "-7/-10", "-8/-10", "-9/-10", "-6/-7", "-5/-7", "-4/-7", "-13/-6", "-13/-7", "-13/-10", "-12/-10", "-11/-10", "-10/-10", "-10/-4", "-9/-4", "-9/-5", "-10/-5", "-15/0", "-15/1", "-15/2", "-15/3", "-15/4", "-14/4", "-13/0", "-14/0", "3/4", "4/4", "-15/-1", "-15/-2", "-15/-3", "-15/-4", "-15/-5", "-15/-6", "-15/-7", "-14/-6", "-14/-5", "-14/-4", "-14/-3", "-14/-2", "-14/-1", "-14/-10", "-15/-10", "-16/-10", "-17/-10", "-18/-10", "-19/-10", "-20/-10", "-21/-10", "-22/-10", "-23/-10", "-24/-10", "-25/-10", "-26/-10", "-27/-10", "-28/-10", "-29/-10", "-29/-9", "-22/-7", "-23/-7", "-21/-7", "-29/-8", "-29/-7", "-29/-6", "-29/-5", "-29/-4", "-29/-3", "-29/-2", "-29/-1", "-29/0", "-29/1", "-29/2", "-29/3", "-29/4", "-29/5", "-29/6", "-29/7", "-29/8", "-29/10", "-29/9", "-29/11", "-29/12", "-28/12", "-27/12", "-26/12", "-25/12", "-24/12", "-23/12", "-22/12", "-21/12", "-20/12", "-19/12", "-18/12", "-16/12", "-17/12", "-15/12", "-15/11", "-15/10", "-15/9", "-15/8", "-15/7", "-15/6", "-15/5", "-14/5", "-14/6", "-14/7", "-14/8", "-14/9", "-14/10", "-14/11", "-14/12", "-17/1", "-22/1", "-23/9", "-22/9", "-21/9", "-27/1", "-25/-3", "-19/-3", "-19/5", "-25/5", "-7/4", "-7/3", "-8/3", "-10/3", "-10/4", "-12/4", "5/8", "5/7", "2/5", "-15/-9", "-14/-7", "8/0", "8/-3", "-26/1", "-18/1", "-15/-8", "-8/2", "-9/2", "-10/2", "-7/2", "8/-2", "-9/-6", "-9/-3", "-4/12", "-6/12", "-7/12", "7/12", "5/12", "-12/12", "5/-2", "7/0", "6/-2", "7/-2", "6/-4", "7/-4", "7/-3", "6/-3", "-9/-2", "-10/-2", "2/-4", "5/-6", "6/-6", "7/-6", "7/-5", "-5/-5", "-10/-3", "1/10", "8/2", "8/3", "1/11", "0/8", "-11/12", "-10/12", "-8/12", "-9/4", "-8/4", "-9/3", "-9/12", "-13/6", "-13/10", "6/12", "8/10", "5/-4", "8/-1", "-1/12", "-2/12", "-3/12", "7/11", "-2/-2", "-2/-3", "2/-2", "2/-3", "-6/-3", "-6/-2", "2/3", "2/4", "-2/3", "-2/4", "-6/4", "-6/3", "8/1", "1/-4", "0/-4", "-1/-4", "-2/-4", "7/2", "6/2", "2/2", "1/4", "0/4", "-1/4", "-2/2", "-3/4", "-4/4", "-5/4", "-6/2", "-6/-4", "-5/-4", "-4/-4", "-3/-4", "5/2", "-13/2", "-13/-1", "-13/-2", "-13/-3", "-6/-5", "-6/-6", "-13/-5", "-13/-4", "5/4", "-13/9", "-13/8", "-13/7", "-13/5", "-13/4", "-11/2", "-12/2", "6/4", "8/4", "8/5", "8/6", "8/7", "8/8", "8/9", "8/12", "4/12", "3/12", "2/12", "0/12", "1/12", "-5/12", "-13/12", "-13/11", "8/11", "8/-4", "8/-5", "8/-6", "8/-7", "8/-8", "8/-9", "8/-10", "7/-10", "6/-10", "5/-10", "4/-10", "3/-10", "2/-10", "1/-10", "0/-10", "-1/-10", "-2/-10", "-3/-10", "-4/-10", "-5/-10", "-6/-10", "-7/-10", "-8/-10", "-9/-10", "-6/-7", "-5/-7", "-4/-7", "-13/-6", "-13/-7", "-13/-10", "-12/-10", "-11/-10", "-10/-10", "-10/-4", "-9/-4", "-9/-5", "-10/-5", "-15/0", "-15/1", "-15/2", "-15/3", "-15/4", "-14/4", "-13/0", "-14/0", "3/4", "4/4", "-15/-1", "-15/-2", "-15/-3", "-15/-4", "-15/-5", "-15/-6", "-15/-7", "-14/-6", "-14/-5", "-14/-4", "-14/-3", "-14/-2", "-14/-1", "-14/-10", "-15/-10", "-16/-10", "-17/-10", "-18/-10", "-19/-10", "-20/-10", "-21/-10", "-22/-10", "-23/-10", "-24/-10", "-25/-10", "-26/-10", "-27/-10", "-28/-10", "-29/-10", "-29/-9", "-22/-7", "-23/-7", "-21/-7", "-29/-8", "-29/-7", "-29/-6", "-29/-5", "-29/-4", "-29/-3", "-29/-2", "-29/-1", "-29/0", "-29/1", "-29/2", "-29/3", "-29/4", "-29/5", "-29/6", "-29/7", "-29/8", "-29/10", "-29/9", "-29/11", "-29/12", "-28/12", "-27/12", "-26/12", "-25/12", "-24/12", "-23/12", "-22/12", "-21/12", "-20/12", "-19/12", "-18/12", "-16/12", "-17/12", "-15/12", "-15/11", "-15/10", "-15/9", "-15/8", "-15/7", "-15/6", "-15/5", "-14/5", "-14/6", "-14/7", "-14/8", "-14/9", "-14/10", "-14/11", "-14/12", "-17/1", "-22/1", "-23/9", "-22/9", "-21/9", "-27/1", "-25/-3", "-19/-3", "-19/5", "-25/5", "-7/4", "-7/3", "-8/3", "-10/3", "-10/4", "-12/4", "5/8", "5/7", "2/5", "-15/-9", "-14/-7", "8/0", "8/-3", "-26/1", "-18/1", "-15/-8", "-8/2", "-9/2", "-10/2", "-7/2", "8/-2", "-9/-6", "-9/-3", "-4/12", "-6/12", "-7/12", "7/12", "5/12", "-12/12", "5/-2", "7/0", "6/-2", "7/-2", "6/-4", "7/-4", "7/-3", "6/-3", "-9/-2", "-10/-2", "2/-4", "5/-6", "6/-6", "7/-6", "7/-5", "-5/-5", "-10/-3", "1/10", "8/2", "8/3", "1/11", "0/8", "-11/12", "-10/12", "-8/12", "-9/4", "-8/4", "-9/3", "-9/12", "-13/6", "-13/10", "6/12", "8/10", "5/-4", "8/-1", "-1/12", "-2/12", "-3/12", "-2/-2", "-2/-3", "2/-2", "2/-3", "-6/-3", "-6/-2", "2/3", "2/4", "-2/3", "-2/4", "-6/4", "-6/3", "8/1", "1/-4", "0/-4", "-1/-4", "-2/-4", "7/2", "6/2", "2/2", "1/4", "0/4", "-1/4", "-2/2", "-3/4", "-4/4", "-5/4", "-6/2", "-6/-4", "-5/-4", "-4/-4", "-3/-4", "5/2", "-13/2", "-13/-1", "-13/-2", "-13/-3", "-6/-5", "-6/-6", "-13/-5", "-13/-4", "5/4", "-13/9", "-13/8", "-13/7", "-13/5", "-13/4", "-11/2", "-12/2", "6/4", "8/4", "8/5", "8/6", "8/7", "8/8", "8/9", "8/12", "4/12", "3/12", "2/12", "0/12", "1/12", "-1/12", "-2/12", "-5/12", "-13/12", "-13/11", "8/11", "8/-4", "8/-5", "8/-6", "8/-7", "8/-8", "8/-9", "8/-10", "7/-10", "6/-10", "5/-10", "4/-10", "3/-10", "2/-10", "1/-10", "0/-10", "-1/-10", "-2/-10", "-3/-10", "-4/-10", "-5/-10", "-6/-10", "-7/-10", "-8/-10", "-9/-10", "-6/-7", "-5/-7", "-4/-7", "-13/-6", "-13/-7", "-13/-10", "-12/-10", "-11/-10", "-10/-10", "-10/-4", "-9/-4", "-9/-5", "-10/-5", "-15/0", "-15/1", "-15/2", "-15/3", "-15/4", "-14/4", "-13/0", "-14/0", "3/4", "4/4", "-15/-1", "-15/-2", "-15/-3", "-15/-4", "-15/-5", "-15/-6", "-15/-7", "-14/-6", "-14/-5", "-14/-4", "-14/-3", "-14/-2", "-14/-1", "-14/-10", "-15/-10", "-16/-10", "-17/-10", "-18/-10", "-19/-10", "-20/-10", "-21/-10", "-22/-10", "-23/-10", "-24/-10", "-25/-10", "-26/-10", "-27/-10", "-28/-10", "-29/-10", "-29/-9", "-22/-7", "-23/-7", "-21/-7", "-29/-8", "-29/-7", "-29/-6", "-29/-5", "-29/-4", "-29/-3", "-29/-2", "-29/-1", "-29/0", "-29/1", "-29/2", "-29/3", "-29/4", "-29/5", "-29/6", "-29/7", "-29/8", "-29/10", "-29/9", "-29/11", "-29/12", "-28/12", "-27/12", "-26/12", "-25/12", "-24/12", "-23/12", "-22/12", "-21/12", "-20/12", "-19/12", "-18/12", "-16/12", "-17/12", "-15/12", "-15/11", "-15/10", "-15/9", "-15/8", "-15/7", "-15/6", "-15/5", "-14/5", "-14/6", "-14/7", "-14/8", "-14/9", "-14/10", "-14/11", "-14/12", "-17/1", "-22/1", "-23/9", "-22/9", "-21/9", "-27/1", "-25/-3", "-19/-3", "-19/5", "-25/5", "-7/4", "-7/3", "-8/3", "-10/3", "-10/4", "-12/4", "4/8", "5/8", "5/7", "2/5", "-15/-9", "93/0", "93/1", "93/2", "-14/-7", "8/0", "8/-3", "-26/1", "-18/1", "-15/-8", "-8/2", "-9/2", "-10/2", "-7/2", "8/-2", "35/4", "35/-4", "35/-10", "35/-6", "35/-11", "35/5", "93/-9", "93/-10", "93/-12", "-9/-6", "-9/-3", "-3/12", "-4/12", "-6/12", "-7/12", "7/12", "5/12", "-12/12", "5/-2", "7/0", "6/-2", "7/-2", "6/-4", "7/-4", "7/-3", "6/-3", "-9/-2", "-10/-2", "2/-4", "5/-6", "6/-6", "7/-6", "7/-5", "-5/-5", "-10/-3", "1/10", "35/2", "35/-5", "8/2", "8/3", "35/3", "93/-11", "1/11", "0/8", "-11/12", "-10/12", "-8/12", "-9/4", "-8/4", "-9/3", "-9/12", "-13/6", "-13/10", "6/12", "8/10", "5/-4", "8/-1", "35/-3", "35/-12", "35/-13", "35/-14", "35/-15", "35/-16", "35/-17", "35/-18", "93/-8", "93/-7", "93/-5", "93/-6", "93/3", "93/4", "93/6", "93/5", "93/7", "93/8", "93/9", "93/10", "93/11", "93/12", "93/13", "93/14", "93/15", "93/16", "35/-19", "35/-20", "36/-20", "37/-20", "61/-20", "64/-20", "63/-20", "62/-20", "60/-20", "59/-20", "58/-20", "57/-20", "56/-20", "44/-20", "43/-20", "42/-20", "41/-20", "40/-20", "39/-20", "38/-20", "52/20", "54/20", "55/20", "56/20", "58/20", "59/20", "60/20", "62/20", "64/20", "65/20", "67/20", "68/20", "80/20", "76/20", "75/20", "51/20", "53/20", "57/20", "61/20", "63/20", "66/20", "69/20", "77/20", "78/20", "79/20", "81/20", "81/-20", "80/-20", "78/-20", "77/-20", "72/-20", "71/-20", "67/-20", "66/-20", "65/-20", "68/-20", "73/-20", "70/-20", "69/-20", "79/-20", "59/-3", "61/-5", "67/-5", "69/-3", "69/3", "67/5", "61/5", "59/3", "58/-7", "57/-7", "57/-6", "57/-5", "57/-4", "57/-3", "59/-7", "61/-7", "60/-7", "57/3", "57/5", "57/6", "57/4", "59/7", "61/7", "60/7", "58/7", "67/7", "68/7", "69/7", "70/7", "71/7", "71/6", "71/4", "71/3", "71/5", "71/-3", "71/-4", "71/-5", "70/-7", "71/-6", "69/-7", "67/-7", "68/-7", "68/-5", "68/-4", "69/-4", "59/-4", "60/-4", "60/-5", "59/4", "60/4", "60/5", "68/5", "68/4", "69/4", "69/-13", "67/-18", "69/-18", "65/-18", "69/-12", "62/-18", "68/-18", "66/-18", "70/-18", "64/-18", "62/-19", "57/-14", "56/-15", "56/-14", "57/-13", "56/-13", "61/-19", "60/-18", "58/-15", "61/-18", "59/-17", "60/-17", "59/-16", "58/-16", "57/-15", "52/-13", "52/-14", "52/-18", "52/-17", "53/-18", "56/-18", "54/-18", "55/-18", "56/-19", "45/-20", "45/-19", "45/-18", "37/-10", "36/-10", "38/-10", "38/-9", "45/-17", "46/-17", "47/-17", "48/-17", "48/-14", "49/-14", "49/-13", "50/-13", "51/-13", "38/-6", "38/-8", "38/-7", "39/-16", "41/-16", "40/-16", "39/-14", "39/-15", "40/-15", "39/-10", "41/-10", "40/-10", "45/-14", "47/-14", "48/-15", "48/-16", "52/-15", "52/-16", "49/-17", "50/-17", "46/-14", "35/-7", "35/-9", "35/-8", "36/-3", "39/-6", "39/-3", "39/-5", "39/-4", "36/-2", "36/-1", "36/0", "36/1", "37/1", "52/-5", "50/-7", "48/-7", "52/-4", "52/-3", "49/-4", "51/-6", "49/-7", "47/-7", "46/-7", "45/-7", "48/-3", "45/-6", "47/-3", "40/-4", "44/-6", "46/-3", "45/-3", "44/-3", "40/1", "46/9", "43/12", "48/7", "47/8", "48/8", "47/7", "50/4", "51/5", "40/5", "39/5", "38/5", "36/5", "37/5", "35/1", "40/6", "40/8", "40/9", "40/10", "39/10", "39/11", "38/12", "38/11", "38/13", "38/15", "38/17", "38/14", "38/16", "40/17", "39/17", "41/17", "42/17", "43/17", "44/17", "44/16", "45/15", "45/16", "46/15", "47/15", "48/15", "49/15", "49/16", "49/17", "50/17", "51/18", "51/17", "51/19", "38/1", "39/1", "70/-13", "70/-12", "55/16", "55/14", "55/15", "56/16", "55/12", "56/12", "57/12", "57/13", "57/14", "57/16", "58/16", "59/16", "60/16", "61/14", "62/14", "62/16", "66/16", "66/14", "70/14", "70/16", "69/16", "71/14", "71/16", "72/16", "72/14", "73/14", "69/17", "60/14", "59/14", "58/14", "68/14", "67/14", "69/14", "71/-7", "57/7", "75/16", "75/14", "74/18", "74/20", "84/16", "82/20", "84/18", "85/16", "86/16", "86/19", "84/20", "83/20", "85/20", "86/20", "86/18", "87/18", "88/17", "88/18", "88/16", "89/16", "90/16", "91/16", "92/16", "89/12", "89/11", "86/14", "87/14", "81/18", "80/18", "79/18", "82/18", "66/15", "86/15", "78/18", "77/18", "83/18", "84/17", "76/18", "74/17", "74/16", "73/16", "73/20", "72/20", "71/20", "70/20", "69/19", "74/19", "74/14", "82/3", "78/7", "86/3", "87/3", "88/3", "89/4", "89/5", "89/6", "78/11", "81/14", "80/14", "78/13", "78/12", "79/14", "88/14", "89/13", "78/6", "78/5", "78/4", "79/3", "80/3", "81/3", "80/5", "81/5", "80/6", "87/12", "87/5", "80/12", "78/14", "89/14", "89/3", "81/-3", "78/-6", "79/-7", "79/-6", "79/-5", "80/-4", "82/-4", "81/-4", "79/-4", "86/-4", "83/-4", "84/-4", "85/-4", "82/-8", "82/-9", "82/-10", "84/-11", "85/-11", "83/-11", "89/-3", "89/-4", "90/-2", "91/-1", "92/0", "92/-1", "91/-2", "90/-3", "73/-19", "74/-19", "76/-19", "75/-19", "77/-19", "81/-19", "81/-18", "81/-17", "81/-15", "81/-16", "83/-15", "82/-15", "84/-15", "86/-15", "85/-15", "87/-15", "88/-15", "90/-15", "89/-15", "90/-14", "90/-13", "90/-12", "91/-12", "92/-12", "93/-1", "93/-2", "93/-3", "93/-4", "76/-15", "75/-15", "77/-12", "76/-12", "77/-14", "77/-13", "75/-13", "75/-14", "76/-13", "76/-14", "78/3", "51/4", "69/18", "85/-8", "84/9", "42/-13", "43/6", "40/7", "7/11", "7/11", "67/-13", "68/-14", "69/-14", "70/-14", "68/-13", "51/-7", "52/-6", "49/-3", "48/-4", "46/8", "45/9", "47/9", "46/10", "44/12", "45/11", "44/10", "43/11", "43/13", "42/13", "42/12", "82/-7", "78/-7", "82/-3", "82/-11", "86/-11"]);
    Gimmick_wall = new SList(["-11/12", "-8/12", "-9/4", "-13/6", "-13/10", "6/12", "8/10", "-1/12", "-2/12", "-3/12", "-11/12", "-8/12", "-9/4", "-13/6", "-13/10", "6/12", "8/10", "-1/12", "-2/12", "-3/12", "-11/12", "-8/12", "-9/4", "-13/6", "-13/10", "6/12", "8/10", "67/-18", "69/-18", "65/-18", "62/-19", "57/-14", "40/-16", "39/-15", "47/-14", "37/1", "51/-6", "49/-7", "46/9", "43/12", "48/7", "71/-7", "57/7", "66/15", "86/15", "74/17", "87/12", "87/5", "80/12", "78/14", "89/14", "89/3", "79/-4", "92/-1", "91/-2", "90/-3", "76/-13", "76/-14", "78/3", "51/4", "69/18", "40/7"]);
    Quick_chat = new SList([13, 14, "04", 15]);
    constructor(rt) {
        super(rt, "Pen/All");
        this.costumes = [
            { name: "Font a", assetFile: "70c02be05859b3b9fd4d4b85d9debd02.svg", rotationCenterX: 24.999999999999886, rotationCenterY: 25 },
            { name: "Font b", assetFile: "9f21b99dbc32e697ac9a981ed859e435.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font c", assetFile: "4fbb53a4c6e4174ee99ddf2bc4f2e31d.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font d", assetFile: "5ee82ec80e483da2f9a129e593747ac7.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font e", assetFile: "34f5024a3fee427303446fc09de1ad2d.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font f", assetFile: "79826a63a3d15c77497b60ade419ac49.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font g", assetFile: "0369545839f76cc1ec847d2bd1811659.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font h", assetFile: "53d1108a2ca2de7ff9f0ec45b4043988.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font i", assetFile: "3dd6493feb32678a5196f55ba1522b36.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font j", assetFile: "28eb590a5e5dc289824b5dc84ddb35f3.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font k", assetFile: "7049b2766da070b963d6c18c843359b3.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font l", assetFile: "aa006e4296ca9a5c105e95a74fbf20a8.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font m", assetFile: "5a530d2821de3eb76f137c09dacee728.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font n", assetFile: "b8c24aa67e703a40a973cdfae9a07f16.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font o", assetFile: "bdab1fd622cb908a9de34c0abb07262e.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font p", assetFile: "e2cf4d4c4c2403b5791e9a9f8450c2f2.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font q", assetFile: "bbc5474517c0fa3776f389b7fa597b6e.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font r", assetFile: "b401698216f9b52299dd388c540c5a6a.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font s", assetFile: "3b11572aac3127fe792aab2cb1d4f43e.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font t", assetFile: "7075dd0bcf783cf2be105917d3e47704.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font u", assetFile: "f9bf5dbbd918a0045961831c78146276.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font v", assetFile: "bb0d254ab4bf4efa8fca2001d886ebb2.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font w", assetFile: "7973e9d822cd6416fe52fb76d147c1da.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font x", assetFile: "6e46e364be393321821e7480e072a20e.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font y", assetFile: "6c3dd9ac0aaf2bd85fa6fd06974b8b92.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font z", assetFile: "fd92662de63e196d7678d1c70c8b140e.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font A", assetFile: "e77dcfa6830fa4a2834cfcb5824d2cff.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font B", assetFile: "a5a9f08bc730fb2ecbfb922bd8faac47.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font C", assetFile: "940ac0b1f9ec3b2c727b394fac904929.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font D", assetFile: "05d0074dd3a817016ea6ee98a9577b0c.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font E", assetFile: "e5c018afce4bb1fe5de48adaefaa4ce1.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font F", assetFile: "14481e62a5a218b0cf4d2606ca053c30.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font G", assetFile: "73111d20ae2a6681c46ec73a77820fda.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font H", assetFile: "036bf88764e314e7394e6dffe2778d18.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font I", assetFile: "9c339006fbaf3283938281fe4748e9de.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font J", assetFile: "80e55839baa0c4df4920104644882648.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font K", assetFile: "c53afb5b4a14b2307e7a251a35d6f44a.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font L", assetFile: "90d75ac928a34ca16016fd1f2ae76161.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font M", assetFile: "3c2e75b386e39ca0fb228cecba497821.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font N", assetFile: "221294422d3c5de7795bcbec0ddab311.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font O", assetFile: "dec7bf88772e17626e98b6e5a1ed4002.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font P", assetFile: "8e011a1fad4d6023341caecc057aacf5.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font Q", assetFile: "59a4698511737515596e1bf728da16c1.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font R", assetFile: "0a6d03800cc5bb1e4919cc7d3f5376c7.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font S", assetFile: "273c2b993c29a946bf2dffc3b7b4f202.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font T", assetFile: "f445a79a3b7ca97c49cad2bd53a77687.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font U", assetFile: "b4d1bd87baeb27863bba41aa70a9a028.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font V", assetFile: "ed54cefe1a3b5abec1806aa7d64793d9.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font W", assetFile: "14ad69f9b9955ca952bad52e0f6561bb.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font X", assetFile: "f7ed77dc7cdd8aac2cac70f6858cf758.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font Y", assetFile: "695699c6ac92ead86e5a92b2a17b4583.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font Z", assetFile: "d957df83001162b2d87c0334fc1af270.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 0", assetFile: "04f97d9f7e168aa5a9b0cb3b263e8b83.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 1", assetFile: "2994a34647075548c5425648f2c28852.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 2", assetFile: "1f321e940872b463c6338533a5eb91bb.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 3", assetFile: "f18ae36f839035dc9c295b532e824300.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 4", assetFile: "aaf15a03dde565bac3474426031d3e30.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 5", assetFile: "fd9158ee255b1557da30a4541a416918.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 6", assetFile: "b37ef4354ceb5d221111ba1072ae00d1.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 7", assetFile: "4c88cba4caf090a292689db6988f50ac.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 8", assetFile: "e85b6f70c629e1330ff99f59069a2767.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font 9", assetFile: "4a31a497be5e9d08b7ed7d502492011b.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font -", assetFile: "36a560e57fe4b6a89bb8af8ddee22225.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font ?", assetFile: "546a17b4b39929e51af5a23100b42478.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font _", assetFile: "2aae8b5c7b2bd4241ecc1fd70691a3dc.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font !", assetFile: "bf84198e5f35da2efc4bbce88b683536.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font #", assetFile: "9b9e2bcbe8e907b316ae079c96a584b1.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font %", assetFile: "e08f20e7399315e3d4863ae54d6d8534.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font &", assetFile: "80b02e37210a59d78d04eed7c826ac5d.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font '", assetFile: "186d758e9aabc25c96e14ebfda48bdae.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font (", assetFile: "4461a4f7d9896310037b15760f8de0f0.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font )", assetFile: "0598726622f12688a059287fdaa50907.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font \"", assetFile: "b1468689af05b173e4d8570d2794ff33.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font @", assetFile: "6824ce2ca0a0813dcd8ede8294433831.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font [", assetFile: "7062bcd9736a06efbde50a05d3484c30.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font ]", assetFile: "6a67d0cf4298e24d02c4acb137bc3a61.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font *", assetFile: "dcba6f58a2890860c0059a020157d095.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font +", assetFile: "27687028731e1cf6babff8151eb3da31.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font ;", assetFile: "cd5eb2e6c7b0e3ff418ee8d06b157aa2.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font :", assetFile: "c22fc317595e27fd78629f8cbca03573.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font ,", assetFile: "4d3ff3c33deadce50a0bc1ae58d630b6.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font .", assetFile: "e1520ce517a1b34653c5c2f15263a9bd.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font /", assetFile: "bd91ca7dcf95b6dd096b40edc8e014fa.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font \\", assetFile: "cb2b2e4a3eb09f0744ef31a2bd5a9486.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font <", assetFile: "6a3716b4c09173ae5d0764dd9a1c2e52.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font >", assetFile: "4d9bcd6d18c4575dd1e113ef1a1fb83b.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Font =", assetFile: "192e66499cb0a670d35a4a78801eb670.svg", rotationCenterX: 25, rotationCenterY: 25 },
            { name: "Pen", assetFile: "efa1619ec67239448c717a57422130f3.svg", rotationCenterX: 0, rotationCenterY: 0 },
            { name: "Small", assetFile: "e91a569e73211abfde05e332f53bbc55.svg", rotationCenterX: 265.5495512162164, rotationCenterY: 197.98198364864868 },
            { name: "Wall", assetFile: "4be7c2148d7fed2bc1a4e926538855f3.svg", rotationCenterX: 24.928572142857178, rotationCenterY: 24.92857214285712 },
            { name: "Grid wall", assetFile: "9567f7c6b4d1776904f1320a9aa78a27.svg", rotationCenterX: 24.92857166666667, rotationCenterY: 24.92857166666667 },
            { name: "Shield", assetFile: "eda1bc0bbfe6879ac3217f2e6780b118.svg", rotationCenterX: 24.303570000000065, rotationCenterY: 24.303570000000008 },
            { name: "Door", assetFile: "3afff584d20280c684d08fc4d6615072.svg", rotationCenterX: 24.928569999999837, rotationCenterY: 24.92856999999995 },
            { name: "Bush", assetFile: "153e33a73b4a4929ae1fde2177273efb.svg", rotationCenterX: 24.92857142857187, rotationCenterY: 24.92857035714286 },
            { name: "Mud", assetFile: "1bc26d1bfd0c61a12bc956014d0274ff.svg", rotationCenterX: 24.92857142857187, rotationCenterY: 24.92857035714283 },
            { name: "Booster", assetFile: "de79fc420cbe3cbc67c16cbf38032d8b.svg", rotationCenterX: 19.845236548284703, rotationCenterY: 14.869627321428652 },
            { name: "Map pointer", assetFile: "7ef544b13e1d5c4c07c732248e2edf98.svg", rotationCenterX: 25.0173199999999, rotationCenterY: 25.04334245454544 },
            { name: "PVP manager", assetFile: "fac25ccd95f89cf5eb31a03d14e2e4c5.svg", rotationCenterX: 25.063859999999977, rotationCenterY: 24.996800000000036 },
            { name: "Spike wall", assetFile: "ad45bca590a1fd2cfffbb712fb82c115.svg", rotationCenterX: 35.357144285714725, rotationCenterY: 35.35714321428574 },
            { name: "Warp1", assetFile: "cf197e7414501c7e929b1b415952144a.svg", rotationCenterX: 49.85432, rotationCenterY: 49.85432 },
            { name: "Auto buffer", assetFile: "905d4e68e78524fa6b246ce73dca2b75.svg", rotationCenterX: 24.428544999999986, rotationCenterY: 24.92855499999999 },
            { name: "Teaming machine", assetFile: "9a2d8cda506e2571f62e835927c15a58.svg", rotationCenterX: 24.928570000000036, rotationCenterY: 24.928570000000036 },
            { name: "Information base", assetFile: "a9a58a02f0caa3f3f2b08e69ff30a380.svg", rotationCenterX: 24.996800000000007, rotationCenterY: 25.043340000000057 },
            { name: "Locker", assetFile: "639026d7af722c7823c20d5ae7396229.svg", rotationCenterX: 24.928570000000008, rotationCenterY: 24.928570000000008 },
            { name: "Minigame hub1", assetFile: "458880cac2bd303e7e62dcaa6120e909.svg", rotationCenterX: 24.996800000000007, rotationCenterY: 25.043340000000057 },
            { name: "Minigame hub2", assetFile: "54cc95e355d6e19f32dac2cdd19ae799.svg", rotationCenterX: 24.996800000000007, rotationCenterY: 25.043340000000057 },
            { name: "Record player", assetFile: "cc380ed4cf4fcb94d8a2e396f269fbb7.svg", rotationCenterX: 25.02500137359661, rotationCenterY: 25.02500137359658 },
            { name: "Flash wall0", assetFile: "37190c943cc9ededa60456f1768b82ef.svg", rotationCenterX: 24.928570000000008, rotationCenterY: 24.92856999999995 },
            { name: "Flash wall1", assetFile: "68cdcc827d0a85480cb458d5ca3ec98f.svg", rotationCenterX: 24.928572142857178, rotationCenterY: 24.928572142857064 },
            { name: "Heal wall0", assetFile: "1604ff1a3e10e195a870727c9274b5d7.svg", rotationCenterX: 24.928570000000008, rotationCenterY: 24.928570000000008 },
            { name: "Heal wall1", assetFile: "20598a91b22f9c625effa8d99e3a0c85.svg", rotationCenterX: 24.928570000000008, rotationCenterY: 24.92856999999998 },
            { name: "Laser wall", assetFile: "53d5453e86fd3b082081110986f5802e.svg", rotationCenterX: 35.25432178456708, rotationCenterY: 35.254321784567026 },
            { name: "Laser wall0", assetFile: "ea51a4290f83e3631b91c9c95bdde974.svg", rotationCenterX: 18.7457, rotationCenterY: 12.550929999999937 },
            { name: "Laser wall1", assetFile: "6f5eaeb5cc21291e3d32091c72a90a75.svg", rotationCenterX: 18.7457, rotationCenterY: 12.550929999999994 },
            { name: "Energy wall0", assetFile: "0a8b3d4e861789e434d4d067648e5be4.svg", rotationCenterX: 24.928569822387715, rotationCenterY: 24.92856999999995 },
            { name: "Energy wall1", assetFile: "673c0693443af5f254cbd58da4a8583e.svg", rotationCenterX: 24.928569822387715, rotationCenterY: 24.928569999999894 },
            { name: "Warp floor0", assetFile: "d8e00dc92bba35c36525b2d40a8898ee.svg", rotationCenterX: 24.97262333333336, rotationCenterY: 24.972633333333278 },
            { name: "Warp floor1", assetFile: "57fb4150e17a81207c891101c58d4216.svg", rotationCenterX: 24.972624999999994, rotationCenterY: 24.972634999999997 },
            { name: "Warp light", assetFile: "38930ef4d61a9e6c8c5b622dfa148aa2.svg", rotationCenterX: 46.655864999999835, rotationCenterY: 46.65586499999995 },
            { name: "Team gem0", assetFile: "c0aa601b6f3d40d93dcf1da0dcd62c7d.svg", rotationCenterX: 20.107640000000004, rotationCenterY: 20.107639999999975 },
            { name: "Team gem1", assetFile: "4a1edd8cd62e3bf2718d3cb305ced7d3.svg", rotationCenterX: 24.555555555555515, rotationCenterY: 24.555555555555628 },
            { name: "Telescope", assetFile: "d04931997ca88072efea06967171b6fd.svg", rotationCenterX: 25.523509421828862, rotationCenterY: 25.468055578171203 },
            { name: "Skill spot0", assetFile: "551e6bcd857059dce94777abb0a8b6a1.svg", rotationCenterX: 21.8749999999998, rotationCenterY: 21.87500000000003 },
            { name: "Skill spot1", assetFile: "ccc85c7d891cc7b425d1f72311059892.svg", rotationCenterX: 21.8749999999998, rotationCenterY: 21.87500000000003 },
            { name: "Skill spot2", assetFile: "ccc85c7d891cc7b425d1f72311059892.svg", rotationCenterX: 21.8749999999998, rotationCenterY: 21.87500000000003 },
            { name: "Reporter", assetFile: "bed2aae8568c53d0d309e400fb74fd01.svg", rotationCenterX: 25.238718566902065, rotationCenterY: 25.200752053474048 },
            { name: "Computer", assetFile: "6f0efe39d94dac395383af2ccf9cbdc4.svg", rotationCenterX: 25.0173199999999, rotationCenterY: 25.04334245454544 },
            { name: "Turret base", assetFile: "2627fe14e4b900efede4c7e09caf72a3.svg", rotationCenterX: 50.14535000000001, rotationCenterY: 50.14535000000001 },
            { name: "Turret gage1", assetFile: "710e7ae8eacb82cbda9fa27ad9e892c5.svg", rotationCenterX: 45.39535000000001, rotationCenterY: 5.684341886080802e-14 },
            { name: "Turret gage2", assetFile: "db5df1f79be107164cfd70e63b9149f8.svg", rotationCenterX: 45.39535000000001, rotationCenterY: 0 },
            { name: "Turret1", assetFile: "54335a6280ab4cdfd47de502046fd334.svg", rotationCenterX: 35.49726000000001, rotationCenterY: 35.447810000000004 },
            { name: "Turret2", assetFile: "1816b03d9fa93e1ba96c28d46e2c86b2.svg", rotationCenterX: 35.90841499999999, rotationCenterY: 35.447810000000004 },
            { name: "Dart", assetFile: "3fd7b3ccb7850bb47119769e45fc84c7.svg", rotationCenterX: 24.92857142857187, rotationCenterY: 24.92857035714283 },
            { name: "Ice", assetFile: "c965e41bda2b6a884bdc9cb8a8b64d24.svg", rotationCenterX: 24.92857142857187, rotationCenterY: 24.928570357142803 },
            { name: "Poison", assetFile: "8e5fc4f971a8c0a2070bc88789544a3f.svg", rotationCenterX: 24.92857142857187, rotationCenterY: 24.928570357142775 },
            { name: "Warp2", assetFile: "7b69f97e3b98001a179226739c19bf11.svg", rotationCenterX: 39.802695, rotationCenterY: 39.802695 },
            { name: "Guy", assetFile: "1bb1b26b4a23adfe43c513e8ff0f7484.svg", rotationCenterX: 15.5, rotationCenterY: 32.499979999999994 },
            { name: "Schedule1", assetFile: "c1ae4094917b81757cf1a3261dd58a39.svg", rotationCenterX: 15.056350515339489, rotationCenterY: 48.25 },
            { name: "Schedule2", assetFile: "0191f8f9f0b6cfd93daa4faf02ef270a.svg", rotationCenterX: 15.056351030678968, rotationCenterY: 48.25 },
            { name: "Schedule3", assetFile: "b8fb026f9304212e269788415fb5482e.svg", rotationCenterX: 15.056351546018448, rotationCenterY: 48.25 },
            { name: "Display buff", assetFile: "b1e7653aacd8e845cd456360685222c4.svg", rotationCenterX: 12.662959999999998, rotationCenterY: 10.74190249999998 },
            { name: "Center lock on", assetFile: "abb89affeec25e492cdb7f4c8425a6a2.svg", rotationCenterX: 13.142857142857167, rotationCenterY: 13.142847142857107 },
            { name: "Center lock on0", assetFile: "f88f8789155ccab179bc7b8a1291de8f.svg", rotationCenterX: 13.142857142857167, rotationCenterY: 13.142847142857079 },
            { name: "Center lock on1", assetFile: "be90f4e7423002c664774de185800ec0.svg", rotationCenterX: 13.142857142857167, rotationCenterY: 13.142847142857022 },
            { name: "Center lock on2", assetFile: "b41c26d20263ecfc16aae00a53558951.svg", rotationCenterX: 13.142857142857167, rotationCenterY: 13.142847142857022 },
            { name: "Center lock on3", assetFile: "3299fc74647f2aa9886b40568aa2c049.svg", rotationCenterX: 13.142857142857167, rotationCenterY: 13.142847142856994 },
            { name: "Side lock on", assetFile: "c25af8198cecd7ac729cddf15abdbaa1.svg", rotationCenterX: 13.142824999999988, rotationCenterY: 13.142844999999966 },
            { name: "Buff", assetFile: "dc3d57b8ce2ba224a4c30fa74b30c003.svg", rotationCenterX: -19.875, rotationCenterY: 7.375 },
            { name: "Debuff", assetFile: "70cfb05d58d6df0206dc3f2ceaccb64d.svg", rotationCenterX: -19.875, rotationCenterY: 7.375000000000085 },
            { name: "Cat body", assetFile: "fbc02a52ca7b97d6c1828f6b1f75e83e.svg", rotationCenterX: 15.5, rotationCenterY: 21.416656507539926 },
            { name: "Cat body+", assetFile: "d1e79c50544d8f5eefb7b869c40cd303.svg", rotationCenterX: 23.753104854224915, rotationCenterY: 26.1824504165605 },
            { name: "Cat hand", assetFile: "5407eccaa6ce59631ab292d664d9f8e0.svg", rotationCenterX: 14.048053962371824, rotationCenterY: 14.048045323037002 },
            { name: "Cat Bot body", assetFile: "f8876206a0471ffb13456d10255bd4a7.svg", rotationCenterX: 16.8476, rotationCenterY: 23.278670000000005 },
            { name: "Cat Bot body+", assetFile: "f41a163264ae710c6d4a30232222c8fb.svg", rotationCenterX: 27.196439999999996, rotationCenterY: 23.278670000000005 },
            { name: "Cat Bot hand", assetFile: "e1c48e4d6ca2629cc504a64eb297ab2f.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Golden Bot body", assetFile: "8698cc55be79bfb4e840ccc65c7c8fcd.svg", rotationCenterX: 16.8476, rotationCenterY: 23.278670000000005 },
            { name: "Golden Bot body+", assetFile: "11e2342304a7dfdbf9a749adc6fa983d.svg", rotationCenterX: 19.528141561513763, rotationCenterY: 23.278670000000005 },
            { name: "Golden Bot hand", assetFile: "54314c10650fc5de1d14629788bb5d48.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Gobo body", assetFile: "55128909de1df13e2d354196852ee8e5.svg", rotationCenterX: 29.500048333333325, rotationCenterY: 21.41665499999999 },
            { name: "Gobo body+", assetFile: "471bb0db59bbaad276d7a9d15b9a64b4.svg", rotationCenterX: 29.500050000000073, rotationCenterY: 21.41664499999999 },
            { name: "Gobo hand", assetFile: "3d1c68f5f2fc129e0026eb12a12242cc.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Spiky Gobo body", assetFile: "ccfdbb7587dd672e8fcd044e26672953.svg", rotationCenterX: 31.130789127082437, rotationCenterY: 22.2467887625848 },
            { name: "Spiky Gobo body+", assetFile: "ca56d851736d05d3b8b037f8f79a4695.svg", rotationCenterX: 32.367476742028344, rotationCenterY: 24.1217887625848 },
            { name: "Spiky Gobo hand", assetFile: "5577d996385340dd1819f30c157a41c8.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Spiky Gobo hand+", assetFile: "57635f194ba51252a9e7da6a02a0f0d9.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Lava Gobo body", assetFile: "8c3b8fa33a970bd067b7cf2b39ae51ae.svg", rotationCenterX: 29.500049999999987, rotationCenterY: 21.514049999999997 },
            { name: "Lava Gobo body+", assetFile: "25a69c780c161eb444fb68b153023c6b.svg", rotationCenterX: 29.500049999999987, rotationCenterY: 21.51406 },
            { name: "Lava Gobo hand", assetFile: "63b7684198583a1b964a36d32fb65bdd.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Lava Gobo hand+", assetFile: "7cfa1296c4906617521823548b9f2b82.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Giga body", assetFile: "cb465c6d50fceba5de25ffeda980eccd.svg", rotationCenterX: 25.40328500000001, rotationCenterY: 21.456050000000005 },
            { name: "Giga body+", assetFile: "80198b3d2bb5c0ec64c7cba9bffae63c.svg", rotationCenterX: 25.403275000000008, rotationCenterY: 21.456050000000005 },
            { name: "Giga hand", assetFile: "c3f1687928ca0aa859e70f665bf0bb23.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Ninja Giga body", assetFile: "e98a7f437b25891362c3fd9542e2a504.svg", rotationCenterX: 29.5, rotationCenterY: 25.216340000000002 },
            { name: "Ninja Giga body+", assetFile: "755d8d11b65ee0012f900389f456ff9a.svg", rotationCenterX: 29.5, rotationCenterY: 25.216340000000002 },
            { name: "Ninja Giga hand", assetFile: "17c88a068d911084837e677fde224756.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Ninja Giga hand+", assetFile: "05dd326bce168cf1547f4adef9b00405.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Lightning Giga body", assetFile: "622ddb1fe677e9b6af8be38dfe44fa45.svg", rotationCenterX: 25.40321, rotationCenterY: 22.482920000000007 },
            { name: "Lightning Giga body+", assetFile: "be1964062db8754c96648e05a3a93255.svg", rotationCenterX: 25.40321, rotationCenterY: 22.482920000000007 },
            { name: "Lightning Giga hand", assetFile: "8576ee9dacbd06eee31ade96661cf8a7.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Lightning Giga hand+", assetFile: "a055e074e370099809e376c619050d0f.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Nano body", assetFile: "6458057550ec67addbedabdaf35adfec.svg", rotationCenterX: 17.894342376136734, rotationCenterY: 21.41664499999999 },
            { name: "Nano body+", assetFile: "5e93322c5f2dd9239d6c9a8766bc3a1e.svg", rotationCenterX: 17.8943463476011, rotationCenterY: 21.41664499999999 },
            { name: "Nano hand", assetFile: "03cf369c55300ec1bd403feb5bf41c92.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Dark Nano body", assetFile: "931561ffebdbec3ab440e918f18f3053.svg", rotationCenterX: 20.43356, rotationCenterY: 21.59044 },
            { name: "Dark Nano body+", assetFile: "b230928f25ad77888fc4eb09a6154e22.svg", rotationCenterX: 20.43356, rotationCenterY: 21.59044 },
            { name: "Dark Nano hand", assetFile: "03cf369c55300ec1bd403feb5bf41c92.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Combat Nano body", assetFile: "3b847c1cab131c615c17886a8b5b699d.svg", rotationCenterX: 20.11956357142836, rotationCenterY: 21.616664999999983 },
            { name: "Combat Nano body+", assetFile: "804e6fcae2ea6114986faa8b078ab98f.svg", rotationCenterX: 20.119544999999988, rotationCenterY: 21.865920008429953 },
            { name: "Combat Nano hand", assetFile: "c3feb502f8df013db7cf8dda03fcaeaf.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000018 },
            { name: "Pico body", assetFile: "f9aca47032784f1c5208f825f029e8e3.svg", rotationCenterX: 21.616404108830835, rotationCenterY: 24.33333166666668 },
            { name: "Pico body+", assetFile: "f25fd660edd1b1c227c690422e9e0403.svg", rotationCenterX: 21.616411163246255, rotationCenterY: 24.33333166666668 },
            { name: "Pico hand", assetFile: "8c000d39c67d7520353933dc0cbc754e.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Cyborg Pico body", assetFile: "b9d7659f30471a1774ef9ca7806e71cf.svg", rotationCenterX: 23.199990000000014, rotationCenterY: 24.33332999999999 },
            { name: "Cyborg Pico body+", assetFile: "44dd2711f4b9dd9452dc88b212c4300f.svg", rotationCenterX: 29.39999000000003, rotationCenterY: 24.33332999999999 },
            { name: "Cyborg Pico hand", assetFile: "54124db4067b833d88f08746f6296bdc.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Shield Pico body", assetFile: "7bc7a253dbd0443ededc832ba5845dd9.svg", rotationCenterX: 21.67183547246728, rotationCenterY: 26.061566430150094 },
            { name: "Shield Pico body+", assetFile: "b765bd3cf1f8e3a64c9999db48cb1641.svg", rotationCenterX: 21.64153205441545, rotationCenterY: 26.061558215075024 },
            { name: "Shield Pico hand", assetFile: "6316dbba0eee0fd0ce0be9c118455430.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Shield Pico hand+", assetFile: "8787dc84a67f7325642dab9f7f18c7b9.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000018 },
            { name: "Military Pico body", assetFile: "b21c920affd7b0d594d11f4fe77c3978.svg", rotationCenterX: 21.593917054415414, rotationCenterY: 24.33332999999999 },
            { name: "Military Pico body+", assetFile: "ef190067290dd14513fa605f4f0496da.svg", rotationCenterX: 21.593907054415467, rotationCenterY: 24.33332999999999 },
            { name: "Military Pico hand", assetFile: "4d6c7af37cf1ce76f3256f6ea5d31973.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000046 },
            { name: "Tera body", assetFile: "00fb42462fbdce21ef310ccaaffd8e99.svg", rotationCenterX: 25.646189487559894, rotationCenterY: 21.866343233582256 },
            { name: "Tera body+", assetFile: "b3be4d205eff3ed7c01c6734598cdefc.svg", rotationCenterX: 25.099999999999994, rotationCenterY: 26.916664999999995 },
            { name: "Tera hand", assetFile: "4e27a3a9690c25d3adb8f81ace753afd.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000018 },
            { name: "Bio Tera body", assetFile: "9bda55bd44989b2de510274359adf993.svg", rotationCenterX: 25.646189829186596, rotationCenterY: 21.866347744527445 },
            { name: "Bio Tera body+", assetFile: "1c81813a7dc02bd91ef9bef0f952a03e.svg", rotationCenterX: 27.60650000000001, rotationCenterY: 21.866347744527445 },
            { name: "Bio Tera hand", assetFile: "c95a7b98a04da98b726dca92700248f1.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Sacred Tera body", assetFile: "7a5ce60defb1d09c845a806f54cc845d.svg", rotationCenterX: 28.152479999999855, rotationCenterY: 25.352480000000014 },
            { name: "Sacred Tera body+", assetFile: "935f9d0a7a0a745ae57a1f4d95b1aac5.svg", rotationCenterX: 28.582864999999998, rotationCenterY: 25.352480000000014 },
            { name: "Sacred Tera hand", assetFile: "3e33733e9f5b60b2fc068b18fcca1a7e.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.04804999999999 },
            { name: "Pumpkin body", assetFile: "87758a11d0e0e46fbab209ea7badde6a.svg", rotationCenterX: 52.62178, rotationCenterY: 52.62178 },
            { name: "Pumpkin body+", assetFile: "119728a4e72baeea69029c4ea1193842.svg", rotationCenterX: 52.62178, rotationCenterY: 52.62178 },
            { name: "Pumpkin hand", assetFile: "ec793d98a23bd4697bf9ecd11d9527d4.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000046 },
            { name: "Snowman body", assetFile: "b1aa91d8ba20d3e180678d87f650c770.svg", rotationCenterX: 25.47204399551262, rotationCenterY: 21.41664499999999 },
            { name: "Snowman body+", assetFile: "dabf89615e99b1726079dce3d19acd8d.svg", rotationCenterX: 25.47205500000001, rotationCenterY: 21.41664499999999 },
            { name: "Snowman hand", assetFile: "4391d2fc6b984ad9c5e0318d335c8705.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000018 },
            { name: "April Cat body", assetFile: "a180bc7c8f7c10540039d19706b59cef.svg", rotationCenterX: 15.5, rotationCenterY: 21.41664499999999 },
            { name: "April Cat body+", assetFile: "c1d3fa9a9d5dd046d9b5ae45634c3278.svg", rotationCenterX: 23.547771943750092, rotationCenterY: 21.55949000000001 },
            { name: "April Cat hand", assetFile: "51d1a1e103b22735a674389886b37c1b.svg", rotationCenterX: 14.048055000000005, rotationCenterY: 14.048045000000002 },
            { name: "The Player body", assetFile: "61072d35af4beee812c0c464b4769cad.svg", rotationCenterX: 17.07504, rotationCenterY: 17.07504 },
            { name: "The Player body+", assetFile: "9d34ea8d8d19453d8fcd86a05e142ceb.svg", rotationCenterX: 17.07504, rotationCenterY: 17.07504 },
            { name: "Shield Cannon body", assetFile: "03cd8bb5181e4063bc28698802a03feb.svg", rotationCenterX: 36.00000000000003, rotationCenterY: 33.161287741935524 },
            { name: "Shield Cannon", assetFile: "c241b97d35efc81f58c2a6244f012e72.svg", rotationCenterX: 25.038320140584148, rotationCenterY: 30.448049999999995 },
            { name: "Tank body", assetFile: "8902f2899309cc28689f8ec738565fbc.svg", rotationCenterX: 48.82369, rotationCenterY: 18.8709199999999 },
            { name: "Tank hand1", assetFile: "78470fad9c54d00ca6263cefa1ee4c37.svg", rotationCenterX: -23.12104999999997, rotationCenterY: 4.774540000000002 },
            { name: "Tank hand2", assetFile: "00ce3a999a39fa41bbe55f966095c403.svg", rotationCenterX: 49.10944989061616, rotationCenterY: 21.850102838352853 },
            { name: "Alien body", assetFile: "36e0be55338a7d3bc08588d9f738f70d.svg", rotationCenterX: 16.8476, rotationCenterY: 23.278670000000005 },
            { name: "Alien hand", assetFile: "54124db4067b833d88f08746f6296bdc.svg", rotationCenterX: 14.04804999999999, rotationCenterY: 14.048050000000018 },
            { name: "^平和", assetFile: "efb832fdf01dca913e269a13ff5036de.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^スタートダッシュ", assetFile: "f0921a5934c4dbbd26198645bfc8da5f.svg", rotationCenterX: 11.374865, rotationCenterY: 11.375 },
            { name: "^モバイル", assetFile: "93e77551ac62ec2aee99ba863346d29b.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^ショップ", assetFile: "c399a6ab6399741c7b820195daada1a4.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^ジェムエネルギー", assetFile: "32fe6835f13ac84fa01d6b0a5a2ecf3c.svg", rotationCenterX: 11.374934999999994, rotationCenterY: 11.375 },
            { name: "^怒り", assetFile: "7f8bd22ab1b7d90bb4ce595ac5e00d73.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^落石注意", assetFile: "3e9a71d5ddc168b423ec0bc76a2cab16.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^ダッシュ", assetFile: "2f1a447f8649b41f861bcbd9a0813529.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^アサシン", assetFile: "1c20109f0f666cc6462d20a96b05145a.svg", rotationCenterX: 11.375004999999987, rotationCenterY: 11.375 },
            { name: "^急速充電", assetFile: "102746a038a4ce20bc9c1121e2b46382.svg", rotationCenterX: 11.3749966129744, rotationCenterY: 11.375001019037029 },
            { name: "^雷の塔", assetFile: "b4c81255ff9d085e604d326d19a5732a.svg", rotationCenterX: 11.3749966129744, rotationCenterY: 11.375001019037029 },
            { name: "^弾薬箱", assetFile: "ef96c27d6273b4908db922420a892523.svg", rotationCenterX: 11.37498500000001, rotationCenterY: 11.375 },
            { name: "^オーバークロック", assetFile: "a6aed09c5753a3ee77b83f173cf6aa4e.svg", rotationCenterX: 11.374995000000013, rotationCenterY: 11.375 },
            { name: "^メイジジェム", assetFile: "a93a9fc97827e46b1f0b69744da5716d.svg", rotationCenterX: 11.374975000000006, rotationCenterY: 11.375 },
            { name: "^力の塗り薬2", assetFile: "bc7ccb5d880fa13e943cdb52aae0af67.svg", rotationCenterX: 11.374965000000003, rotationCenterY: 11.375 },
            { name: "^お守り", assetFile: "395598a42e97cb263fac82f557678c10.svg", rotationCenterX: 11.374965000000003, rotationCenterY: 11.375 },
            { name: "^ブースト", assetFile: "af809f52ff1f723623f66aa95a941548.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^ライトニングダッシュ", assetFile: "fddb7f431ebeb12b05558cc770111d0f.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^護身", assetFile: "dedf7c04a3d913ca1e63f586cee3a807.svg", rotationCenterX: 11.374955, rotationCenterY: 11.375 },
            { name: "^護身+", assetFile: "96c73a4a55444c3abf8f3ba2f078db6b.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^シェアバリア", assetFile: "b5670fc7763239bd5e6f189e802f556d.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^スーパーバリア", assetFile: "18e996a2635f6f8f7a45c689d2c16705.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^耐爆", assetFile: "5d0f6ae75044677b75144e37704a7875.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^耐弾", assetFile: "c531badf9566cb55e5c1060d141bf33b.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^シールド3", assetFile: "d52dd92588e22d70bfe6fdb9fba4b208.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^シールド2", assetFile: "df885451a4f3a39987cc4f223ddf6e56.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^シールド1", assetFile: "512c59139dfcfa1226b3b1305c14096a.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^ソード3", assetFile: "4ec26086bead81ece50592784d78dda4.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^ソード2", assetFile: "785e86aef0f0738d271cf9e1a1b0b531.svg", rotationCenterX: 11.37492499999999, rotationCenterY: 11.375 },
            { name: "^ソード1", assetFile: "5ffbdf9382785cb92b0a129308b1d4f4.svg", rotationCenterX: 11.37492499999999, rotationCenterY: 11.375 },
            { name: "^トーテムの加護", assetFile: "b19b92c2b2b9c2418cb6b465fbc89f04.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^魔改造", assetFile: "02c3a00e4cc02cd23903bbdc1b69e555.svg", rotationCenterX: 11.374945000000025, rotationCenterY: 11.375 },
            { name: "^リジェネ", assetFile: "dca87d8a8e6d8f6a342fdb3ea28d8600.svg", rotationCenterX: 11.374934999999994, rotationCenterY: 11.375 },
            { name: "^再生", assetFile: "4680f6ff8e5cc1e661602d738b88c853.svg", rotationCenterX: 11.37492499999999, rotationCenterY: 11.375 },
            { name: "^羽衣の加護", assetFile: "0197dce2c634e30ff7d98ff151507999.svg", rotationCenterX: 11.374914999999987, rotationCenterY: 11.375 },
            { name: "^攻撃力アップ", assetFile: "5e39ef1059e15e33355eb23d61a6da8b.svg", rotationCenterX: 11.37492499999999, rotationCenterY: 11.375 },
            { name: "^力の祭壇", assetFile: "c271a505a9a8164887b12de5697b457d.svg", rotationCenterX: 11.374914999999987, rotationCenterY: 11.375 },
            { name: "^知覚上昇", assetFile: "2c7ba225934a9e4181dbe27fdf2e196b.svg", rotationCenterX: 11.374905000000012, rotationCenterY: 11.375 },
            { name: "^灯台", assetFile: "8b29f855af3d5391d0902819a3831f14.svg", rotationCenterX: 11.374905000000012, rotationCenterY: 11.375 },
            { name: "^爆破の塔", assetFile: "eb445fa941d3aa85d9e9a53ee0518567.svg", rotationCenterX: 11.37489500000001, rotationCenterY: 11.375 },
            { name: "^トリート", assetFile: "5c28a8134f0e0d3d1c265341c8a64b3b.svg", rotationCenterX: 11.37489499999998, rotationCenterY: 11.375 },
            { name: "^マップ開発", assetFile: "f37e05f45409cd491b1ab6ff6246238d.svg", rotationCenterX: 11.37489499999998, rotationCenterY: 11.375 },
            { name: "^クリスマス1", assetFile: "7ea7b2c6fa56168824a96c4adc79c8b4.svg", rotationCenterX: 11.37489499999998, rotationCenterY: 11.375 },
            { name: "^クリスマス2", assetFile: "11f461e21eded927e2af680af00df43e.svg", rotationCenterX: 11.37489500000001, rotationCenterY: 11.375 },
            { name: "^クリスマス3", assetFile: "dcb0fbc1f5b8d4f000a4f831708f7860.svg", rotationCenterX: 11.374885000000006, rotationCenterY: 11.375 },
            { name: "^クリスマス4", assetFile: "9ba6ea961040ba3e967a085c3bf68233.svg", rotationCenterX: 11.37483499999999, rotationCenterY: 11.375 },
            { name: "^クリスマス5", assetFile: "868cd403a97ef8680c1d08beb7cbfba2.svg", rotationCenterX: 11.374855000000025, rotationCenterY: 11.375 },
            { name: "^クリスマス6", assetFile: "c182f1adacda706005626434730459a7.svg", rotationCenterX: 11.374855000000025, rotationCenterY: 11.375 },
            { name: "^クリスマス7", assetFile: "7b49351cfa2bbf443e237fb9b869d492.svg", rotationCenterX: 11.374855000000025, rotationCenterY: 11.375 },
            { name: "^クリスマス8", assetFile: "6b4c18528de951f25e395d8ecf4f68de.svg", rotationCenterX: 11.374855000000025, rotationCenterY: 11.375 },
            { name: "^クリスマス9", assetFile: "cd82c6323be701aef87639e5e47db772.svg", rotationCenterX: 11.374855000000025, rotationCenterY: 11.375 },
            { name: "^アイスブーツ", assetFile: "e905946b72e1d89b7ebb02d45c49fc34.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^オーバーヒート", assetFile: "52b31bfe4776a9a1e6e2f5282c287bd2.svg", rotationCenterX: 11.374955, rotationCenterY: 11.375 },
            { name: "^リジェネカース", assetFile: "00174aac18c79fee71e79fea6db988c0.svg", rotationCenterX: 11.374944999999997, rotationCenterY: 11.375 },
            { name: "^毒", assetFile: "5c8a4a9332a1e7a80e60a4c75042e863.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^貫通", assetFile: "30adcffe6f89095df1292d10f08c941b.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^テラ毒", assetFile: "684f707cb6bb21372ca8c7309845ec96.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^ポイズンチャクラム", assetFile: "652f9739c4fbcde6201ac9c149b5731a.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^ダークデバフ", assetFile: "2849a84d713f43473192c1e3fb686330.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^呪詛", assetFile: "0eca45f86322f44b941ad6b8cd941233.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^BP-080", assetFile: "64d0e9b2f6fee60ce988331c126890fe.svg", rotationCenterX: 11.375, rotationCenterY: 11.375000000000057 },
            { name: "^火傷", assetFile: "93640b06cc68905cd760bb1397d6c99f.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^負傷", assetFile: "8c4a22a8ad17553a126db5f8fa05e51a.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^ネット", assetFile: "8696b4622563e4f29507f5a5780fb2cc.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^鈍化", assetFile: "ffa212e9e1f833fa5e13572615d2f436.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^凍傷", assetFile: "0b10448934c6ff3464263e1d484ac3d9.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^疲労", assetFile: "d49dfa279a0a658f48a3b11465438889.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^回復中", assetFile: "c44d7ec3baf89bc7108551bf4405b10b.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^結束の代償", assetFile: "621c8203f7788c4ee4c46e6da9314bb1.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^結束の代償+", assetFile: "8aba1f1ecf3059c31cb67ff80342e814.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^負のジェムエネルギー", assetFile: "16d6615f3549caac3e367a0f9027429f.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^めまい", assetFile: "78d7123d56046b791a62013a6c6272b7.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^視野ダウン", assetFile: "c9e94a05b10ebe95024eb04cdb88ea85.svg", rotationCenterX: 11.374904999999984, rotationCenterY: 11.375 },
            { name: "^熱中症", assetFile: "01fbdc2a795b7415c330c17cfd434abd.svg", rotationCenterX: 11.37489500000001, rotationCenterY: 11.375 },
            { name: "^粉雪", assetFile: "6d44a7136ef767ed9dfa3702d5533e6b.svg", rotationCenterX: 11.37489499999998, rotationCenterY: 11.375 },
            { name: "^スノードーム", assetFile: "41bb72bafcf8f28cb8768ea709b8ef2c.svg", rotationCenterX: 11.37489499999998, rotationCenterY: 11.375 },
            { name: "^JJ-100", assetFile: "901b5033dd407913cba76327e78e7598.svg", rotationCenterX: 11.37489500000001, rotationCenterY: 11.375 },
            { name: "^防御力減少", assetFile: "5b0e36cdf96e1adf2b9a05dd07357626.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^耐爆減少", assetFile: "e611a04d7eb56717fad0a4b8a8871661.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "^力の塗り薬1", assetFile: "859f14d63b228021425b58e6a30362cb.svg", rotationCenterX: 11.375, rotationCenterY: 11.375 },
            { name: "Chat menu1", assetFile: "df3e6030d7cd9a3385b9546a282319d9.svg", rotationCenterX: 0.428001472234115, rotationCenterY: -13.37156108108519 },
            { name: "Chat menu2", assetFile: "f51b6a2781941b5a333d06cde6d07af3.svg", rotationCenterX: 0.5452844167023443, rotationCenterY: -13.37156108108519 },
            { name: "Chat 呼びかけ1", assetFile: "c388bcaee6e97185543b83f8b31bd4b9.svg", rotationCenterX: 0.42800999999985834, rotationCenterY: -13.371557162170404 },
            { name: "Chat 呼びかけ2", assetFile: "9b74b413e1a8548db3a7dbf2331dea4e.svg", rotationCenterX: 0.44713487852743583, rotationCenterY: -13.371556182441708 },
            { name: "Chat 返事1", assetFile: "364bf1c711ba7a80b16a7d5ce1089f1f.svg", rotationCenterX: 0.42800499999987096, rotationCenterY: -13.3715581418991 },
            { name: "Chat 返事2", assetFile: "06a746995a6fb587e6f831647bb1e2c9.svg", rotationCenterX: 0.7100908889363495, rotationCenterY: -13.3715581418991 },
            { name: "Chat チーム1", assetFile: "0234d53dcdf34f5d37860224ba630e27.svg", rotationCenterX: 0.37443857142855563, rotationCenterY: -16.81389112739015 },
            { name: "Chat チーム2", assetFile: "4358f8e32ed1af725ae2de9664efd88b.svg", rotationCenterX: 0.42800147223394447, rotationCenterY: -13.371563243255594 },
            { name: "Chat エモート1", assetFile: "988e4cc2eacf1674c9d65b02ce385bce.svg", rotationCenterX: 0.3977866666666898, rotationCenterY: -15.722587625516269 },
            { name: "Chat エモート2", assetFile: "ac9d67fc11d3ae69e8a3e022e4026842.svg", rotationCenterX: 0.4280014722339729, rotationCenterY: -13.371555202713012 },
            { name: "Chat こんにちは", assetFile: "dd8bc3c790a952caee36f6dda6212b68.svg", rotationCenterX: 38.27140499999999, rotationCenterY: 11.981410979728679 },
            { name: "Chat 装備いいね", assetFile: "1b7feb0cd481bf286fe19e5d37ac779e.svg", rotationCenterX: 38.27140499999999, rotationCenterY: 11.981410979728679 },
            { name: "Chat こっちにきて", assetFile: "e20627579d226825193ad88959d83882.svg", rotationCenterX: 37.85387, rotationCenterY: 9.883770459136997 },
            { name: "Chat ちょっと待って", assetFile: "6f0a8da95cb770dc51cedf1254ddb23e.svg", rotationCenterX: 37.446060000000045, rotationCenterY: 8.38550677963255 },
            { name: "Chat 抜けます", assetFile: "f624457dcc4e86065c234da8047433ff.svg", rotationCenterX: 30.655204999999995, rotationCenterY: 11.981410979728707 },
            { name: "Chat 一旦戻ります", assetFile: "f71005713a9226e33cd84b2e702b2aab.svg", rotationCenterX: 37.85387, rotationCenterY: 9.88377522956847 },
            { name: "Chat はい", assetFile: "30b29477f3b106e59f4cd310a7efa7d2.svg", rotationCenterX: 15.422800000000024, rotationCenterY: 11.981411959457404 },
            { name: "Chat いいえ", assetFile: "4dd63a84f1c792be6d1c46b15dc52c4e.svg", rotationCenterX: 23.039005000000003, rotationCenterY: 11.981410979728707 },
            { name: "Chat ありがとう！", assetFile: "77cfb7fa1c7d0f952c246987a130b38a.svg", rotationCenterX: 38.105715000000004, rotationCenterY: 9.949532822456376 },
            { name: "Chat ごめんなさい", assetFile: "8f599ae0257c7a49f368b63bc94ae9a5.svg", rotationCenterX: 37.603229999999996, rotationCenterY: 9.818332266311643 },
            { name: "Chat 間違えました", assetFile: "2a6bfd64587dac059d147f60e3e19de1.svg", rotationCenterX: 37.85387, rotationCenterY: 9.8837752295685 },
            { name: "Chat チームを組もう", assetFile: "4762941859900c73987e36f3256cece0.svg", rotationCenterX: 38.450639999999964, rotationCenterY: 8.610468225479138 },
            { name: "Chat チームに入れて", assetFile: "279482f47857ef838ec53f34946ca60f.svg", rotationCenterX: 37.94905, rotationCenterY: 8.498142668914795 },
            { name: "Chat パーティーしよう", assetFile: "15fc056b8dd88400017e82f5a5374f13.svg", rotationCenterX: 37.97219443872572, rotationCenterY: 7.4095278110503955 },
            { name: "Chat チーム抜けます", assetFile: "71481c931fc111c436b28883423f58ac.svg", rotationCenterX: 37.697554999999994, rotationCenterY: 8.441827630500796 },
            { name: "Chat ここを守ろう", assetFile: "68cabc6372f2caeb83d21a2a128a6029.svg", rotationCenterX: 38.356359999999995, rotationCenterY: 10.014970785713189 },
            { name: "Chat 編成真似して", assetFile: "7df2dacc8de77890026a602fa8572941.svg", rotationCenterX: 38.35635500000001, rotationCenterY: 10.014966571426385 },
            { name: "Chat ガントリック", assetFile: "a467075596ed0f79155feffdb824a76d.svg", rotationCenterX: 42.83614, rotationCenterY: 10.080418748970033 },
            { name: "Chat エンジョイ！", assetFile: "e5431ed37036eb435c77dd0c7d6299e5.svg", rotationCenterX: 42.00051704132082, rotationCenterY: 9.88377522956847 },
            { name: "Chat ワイパー", assetFile: "37ad1c5a53d68923989b107a0a641bef.svg", rotationCenterX: 35.68189583786008, rotationCenterY: 11.981410979728707 },
            { name: "Chat プロペラ", assetFile: "a2eee2c29281c22d4f81c86f1ceabcec.svg", rotationCenterX: 35.68189583786008, rotationCenterY: 11.981410979728707 },
            { name: "Chat 拍手！", assetFile: "152f0b23262bddc75d3db8047dcf332f.svg", rotationCenterX: 28.06569583786012, rotationCenterY: 11.981410979728679 },
            { name: "TACT-AIM record", assetFile: "0b556eac9e874021bc6e9875c9407e3f.svg", rotationCenterX: 46.758890703032506, rotationCenterY: 46.739790703032554 },
            { name: "Calamity record", assetFile: "d8f52e44acb3d5f424bd77d80c4825e3.svg", rotationCenterX: 46.62514915714661, rotationCenterY: 46.62515035151628 },
            { name: "Nightmare record", assetFile: "7ac9802e8de55a2c9e7be19fa70de324.svg", rotationCenterX: 46.758888165371104, rotationCenterY: 46.73979123489792 },
            { name: "TACT-AIM banner", assetFile: "8685a70f817f812b2ed824e37ae64efc.svg", rotationCenterX: 264.308485, rotationCenterY: 327.92708 },
            { name: "Calamity banner", assetFile: "ddee31dfb086eb48374fb84ede4c3f62.svg", rotationCenterX: 264.308475, rotationCenterY: 327.92708 },
            { name: "Nightmare banner", assetFile: "a44832effd9cfcfa150666baecbdda3d.svg", rotationCenterX: 235, rotationCenterY: 75.25 },
            { name: "Status frame", assetFile: "abca44e8971d0fbae14c13729085ac9c.svg", rotationCenterX: 64.84999999999997, rotationCenterY: 85.50713999999995 },
            { name: "Status background", assetFile: "ab5ac009dd63d2b46c698210edb15542.svg", rotationCenterX: 61.94247999999999, rotationCenterY: 85.17077499999999 },
            { name: "Character info1", assetFile: "4c5c53e2956313dd61f6487cc85d2107.svg", rotationCenterX: 242.0167916806891, rotationCenterY: 180.85415 },
            { name: "Character info2", assetFile: "a25b6d00fa8932b2391992cfd44878a4.svg", rotationCenterX: 252.70599365234375, rotationCenterY: 180.85415 },
            { name: "Character info3", assetFile: "787bb4c9871b029b7393285788c364b2.svg", rotationCenterX: 242.01679356834373, rotationCenterY: 180.85415 },
            { name: "Character info4", assetFile: "5b4008398b3708598ca595c80031f6ec.svg", rotationCenterX: 242.01679852634376, rotationCenterY: 180.85415 },
            { name: "Character info5", assetFile: "6cd942bf13dddad08d7e1a5de007b9ad.svg", rotationCenterX: 241.0041841004184, rotationCenterY: 180.85415 },
            { name: "Character info6", assetFile: "9eaca7693c48f9b64520cc74c4f735e9.svg", rotationCenterX: 241.0041891213184, rotationCenterY: 180.85415 },
            { name: "Character info7", assetFile: "496d9b73ba42062f65fc2a37f12dd66b.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "Character info8", assetFile: "c5769c17bc1c23626920c554ebf1d855.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "Character info9", assetFile: "b50c72c93b10a537e0d039b8a1339e21.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "Character info10", assetFile: "2f618023b2dc59926260d56d3620c0e9.svg", rotationCenterX: 241.0041891631184, rotationCenterY: 180.85415 },
            { name: "Character info11", assetFile: "451c9a044dd77d258c8f34c4493660a3.svg", rotationCenterX: 241.00418920491842, rotationCenterY: 180.85415 },
            { name: "Character info12", assetFile: "b49e2502cf812ee0c83f199ad49d7d1e.svg", rotationCenterX: 241.00418933031844, rotationCenterY: 180.85415 },
            { name: "キャラUI説明1", assetFile: "fb88603ea8c29192ee6039b5441bfc99.svg", rotationCenterX: 242.0167915966891, rotationCenterY: 180.85415 },
            { name: "キャラUI説明2", assetFile: "ffab7b4fdedbca5a39fbcafc3f4cd15a.svg", rotationCenterX: 252.70599365234375, rotationCenterY: 180.85415 },
            { name: "キャラUI説明3", assetFile: "333009f79c79f71f9d9a79bb35a9e0da.svg", rotationCenterX: 242.01679852634376, rotationCenterY: 180.85415 },
            { name: "キャラUI説明4", assetFile: "44a3b83902d2e2363f5026f16bbcf453.svg", rotationCenterX: 242.01679852634376, rotationCenterY: 180.85415 },
            { name: "キャラUI説明5", assetFile: "09de72398dd0414c6fd85d4b1e930f7a.svg", rotationCenterX: 241.0041891213184, rotationCenterY: 180.85415 },
            { name: "キャラUI説明6", assetFile: "4fcf7fbde029f14eb3f1ccabb00e7b66.svg", rotationCenterX: 241.0041891631184, rotationCenterY: 180.85415 },
            { name: "キャラUI説明7", assetFile: "7ba7efa9a38e50efd4a09fe4472a8c06.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "キャラUI説明8", assetFile: "acfd45c9c9d28520f71cf7102d89c440.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "キャラUI説明9", assetFile: "136d56d2d136516b20853969ef8e1e3c.svg", rotationCenterX: 240, rotationCenterY: 180.85415 },
            { name: "キャラUI説明10", assetFile: "7f846a0be5302797051dc3ef8c279e15.svg", rotationCenterX: 241.00418920491842, rotationCenterY: 180.85415 },
            { name: "キャラUI説明11", assetFile: "bb968c7e32e3697f96221086c267a292.svg", rotationCenterX: 241.00418924671843, rotationCenterY: 180.85415 },
            { name: "キャラUI説明12", assetFile: "8fc1d0b4d4dd1f14b7636da6d1983b1e.svg", rotationCenterX: 241.00418937211845, rotationCenterY: 180.85415 },
            { name: "Weapon shop background", assetFile: "57ceead2b1ce6b462a51fa463fe904a7.svg", rotationCenterX: 235.26990641001484, rotationCenterY: 115.043945 },
            { name: "Sub weapon shop background", assetFile: "c20c982c0c9d8b55b03a07fbb29e62b9.svg", rotationCenterX: 235.26990641001484, rotationCenterY: 115.043945 },
            { name: "Cursed shop background", assetFile: "3b8ec5e174c25425b9f215cafb0dd87b.svg", rotationCenterX: 235.26990782002966, rotationCenterY: 115.043945 },
            { name: "Tektite icon", assetFile: "dcd0fb67716c39f9d07b07934a4b6dc6.svg", rotationCenterX: 18.967230000000086, rotationCenterY: 22.050705153126756 },
            { name: "*怒り", assetFile: "7059e171d7f477887670b0557c0dc35e.svg", rotationCenterX: 56.25, rotationCenterY: -4.559853152313224 },
            { name: "*オーバークロック", assetFile: "b940682a28950ca9e5f5944932b6e0b3.svg", rotationCenterX: 54.68642, rotationCenterY: -4.55987271743777 },
            { name: "*狙撃ワープ", assetFile: "3ab23046b6aee5450ce3d6406c3b771f.svg", rotationCenterX: 56.25, rotationCenterY: -4.55986278320313 },
            { name: "*落石注意", assetFile: "16795e7723020d421fd4a59126f1555a.svg", rotationCenterX: 56.25, rotationCenterY: -4.559853152313224 },
            { name: "*トゲトゲブースト", assetFile: "45526ec2f42081b8a994b71cfbc7dd89.svg", rotationCenterX: 56.25, rotationCenterY: -4.559880869750998 },
            { name: "*スーパーバリア", assetFile: "709a942935c65c695851454107beec16.svg", rotationCenterX: 56.25, rotationCenterY: -4.559867717437726 },
            { name: "*煙玉", assetFile: "1148f4281064c2b5f591a54f6d25271f.svg", rotationCenterX: 56.25, rotationCenterY: -4.559868152313243 },
            { name: "*マキビシショット", assetFile: "e52df80a490ed559e6e59ab81f6a5cbe.svg", rotationCenterX: 56.25, rotationCenterY: -4.559875434875494 },
            { name: "*ライトニングダッシュ", assetFile: "438d9d1085029246946da34641df30c2.svg", rotationCenterX: 56.25, rotationCenterY: -4.559875434875494 },
            { name: "*アサシン", assetFile: "fe8f8d1e6a22c1173e802c1e597b5c5f.svg", rotationCenterX: 56.25, rotationCenterY: -4.559862717437738 },
            { name: "*魔改造", assetFile: "1667e2c34487b5fa10f581fc578c5e03.svg", rotationCenterX: 56.25, rotationCenterY: -4.5598727832031045 },
            { name: "*近接カウンター", assetFile: "3296d6b9c66cecf17cc95af8cc0db4e0.svg", rotationCenterX: 56.25, rotationCenterY: -4.559875935516345 },
            { name: "*デストロイヤー", assetFile: "fbcded110c8a5d64c8ef23efdf80bd35.svg", rotationCenterX: 56.25, rotationCenterY: -4.559879087829586 },
            { name: "*ヒーリングゾーン", assetFile: "c48d8577cafe649dca100146618a07e5.svg", rotationCenterX: 56.25, rotationCenterY: -4.5598640220641755 },
            { name: "*神秘のトーテム", assetFile: "e8d16d2d17aa1a1631e801dc976ba373.svg", rotationCenterX: 56.25, rotationCenterY: -4.559867717437726 },
            { name: "*羽衣の加護", assetFile: "4fc6a63f9851adb3d4dd2d288247176f.svg", rotationCenterX: 56.25, rotationCenterY: -4.559868587188703 },
            { name: "*破壊レーザー", assetFile: "bfcd94c205b2c101b895bbc0e7cd8714.svg", rotationCenterX: 54.39168000000001, rotationCenterY: -4.559880434875538 },
            { name: "*死神の鎌", assetFile: "2c0ad74872663a45720f9075abe9dc32.svg", rotationCenterX: 56.25, rotationCenterY: -4.559877717437757 },
            { name: "*弾薬箱", assetFile: "d27a2f12d914767553bf27b8cb9ae25c.svg", rotationCenterX: 56.25, rotationCenterY: -4.559880869750998 },
            { name: "*ハロウィンの魂", assetFile: "1b3f881e92b3d2981dc6bf6ee6142715.svg", rotationCenterX: 56.25, rotationCenterY: -4.559874022064207 },
            { name: "*スノードーム", assetFile: "0403e2effd54167732b700d0a82b874c.svg", rotationCenterX: 56.25, rotationCenterY: -4.559877609252965 },
            { name: "*ゴ棒", assetFile: "263166f35ea4eb05dbbfcd9fef5fa08a.svg", rotationCenterX: 54.391650000000055, rotationCenterY: -4.559880761566205 },
            { name: "*KIPI", assetFile: "2cbe7f57032c396746017093970b9ac8.svg", rotationCenterX: 46.2528650000001, rotationCenterY: -4.559876196441678 },
            { name: "*Gun", assetFile: "c0acf0888bc1513b18eed6459836e8d2.svg", rotationCenterX: 224.969905, rotationCenterY: 106.5186030280639 },
            { name: "*ピストル", assetFile: "d5ffefa351a431481e2f81f47f78c5db.svg", rotationCenterX: 224.96991500000001, rotationCenterY: 106.51859988636016 },
            { name: "*サイレンサ付ピストル", assetFile: "168ffb3c8bf15708f94961c8f8e7decf.svg", rotationCenterX: 224.969905, rotationCenterY: 106.51859977272032 },
            { name: "*レーザーサイト付ピストル", assetFile: "7957f154ba5ec9f5f6b9909694dce96d.svg", rotationCenterX: 224.96991, rotationCenterY: 106.23352177268981 },
            { name: "*ハンドガン", assetFile: "d659b694640fc4c0fa5894808c13708a.svg", rotationCenterX: 224.96991, rotationCenterY: 106.51859977272032 },
            { name: "*テラァシューター", assetFile: "8d59d57e87a5f176823226bcf0a4e8d6.svg", rotationCenterX: 224.96991, rotationCenterY: 106.51859977272032 },
            { name: "*マシンガン", assetFile: "e8f7337718ebf0d56c76a3ba8da486bb.svg", rotationCenterX: 224.969905, rotationCenterY: 106.51859988636016 },
            { name: "*リボルバー", assetFile: "e328b5cbb3b0d2211d05b5a26b41fcb6.svg", rotationCenterX: 224.96991, rotationCenterY: 106.51859988636016 },
            { name: "*早打ち銃", assetFile: "9ed559c07747e839cf34a0893bd55848.svg", rotationCenterX: 224.969905, rotationCenterY: 106.51859818176253 },
            { name: "*コンパクトサブマシンガン", assetFile: "736be3fd07f638ee761ded749b51cfab.svg", rotationCenterX: 224.96991, rotationCenterY: 106.51859977272032 },
            { name: "*ウージー", assetFile: "b926fa089265bad14e2f993c602438a0.svg", rotationCenterX: 224.96991, rotationCenterY: 106.51859988636016 },
            { name: "*スイカSMG", assetFile: "15efd9585303df747a18a6a61ead78ae.svg", rotationCenterX: 224.969905, rotationCenterY: 106.51859931816095 },
            { name: "*Rifle", assetFile: "b4252ec8a739d3a781aa9f06f53cd427.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860454544064 },
            { name: "*アサルトライフル", assetFile: "9f0d444d41ab23f3004e7ef921abf408.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860488636017 },
            { name: "*ヘビーアサルトライフル", assetFile: "286db0fbf2bb8f7cc7080710a07585f1.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*CS-M", assetFile: "489bc7d4e01d9e8264861aca19763f45.svg", rotationCenterX: 224.969885, rotationCenterY: 106.3685628408432 },
            { name: "*AK-47", assetFile: "e0612f49eea9c4905d79c0c5631e3159.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859954544064 },
            { name: "*FA-MAS", assetFile: "b772581e745adc4b64805791e94b80a3.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*ゼンマイ式ライフル", assetFile: "4eed6d36627add96ddfc50b424feb76d.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860165904998 },
            { name: "*コインガン", assetFile: "5097948a7a6fb119a44d508afb91d1ed.svg", rotationCenterX: 224.96989, rotationCenterY: 106.23352177268981 },
            { name: "*火縄銃", assetFile: "810f0e93426d0102eacc8d7f991b2f03.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860165904998 },
            { name: "*セミオートライフル", assetFile: "9b9f948535fc2096630e966a4802e32a.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*コンバットライフル", assetFile: "0ac1514ae8fdc39c3a70012eaa1b1cb3.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860488636017 },
            { name: "*ヘキサスコープカスタム", assetFile: "50de094377ee2a32639355ae43502e08.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*エンジンライフル", assetFile: "63758d06dce21fa1fcfb0dc92c3b0d01.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*ショットガン", assetFile: "0b267dbf7df096d147131cf3f107a55c.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*タクティカルショットガン", assetFile: "69715fadbbf8850e9599a08d73f2ff66.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*ダブルバレルショットガン", assetFile: "c50f8bd545187b9fdc50a049f1f3281d.svg", rotationCenterX: 224.96989, rotationCenterY: 106.36855897724152 },
            { name: "*Sniper", assetFile: "0434bd57ea1116643acee2fc2d150061.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860477272032 },
            { name: "*スナイパーライフル", assetFile: "28d548d6fe605470085e48f0e4e35297.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*サイレンサ付スナイパーライフル", assetFile: "c4eb10313ec40d12aeac5b0ba5ab2515.svg", rotationCenterX: 224.96989, rotationCenterY: 106.23352177268981 },
            { name: "*レーザーサイト付スナイパーライフル", assetFile: "777e5abe880b7fec87ee2236d8868d48.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*シャドウスナイパー", assetFile: "0bb9b05e87b5469f0d43cfaf7b335c12.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*レーザーキャノン", assetFile: "332bbf034e4cb544aa50e7053b80b4e5.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*ショットスナイパー", assetFile: "e88ce7d54bdc9604d12119582e11d9eb.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859965908048 },
            { name: "*銛スナイパー", assetFile: "c3b8eeface412f45f5fee553c3159941.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*Magic", assetFile: "a3c185c85c52be5f7f98b71a35ec6863.svg", rotationCenterX: 224.969895, rotationCenterY: 106.5186044318008 },
            { name: "*空の魔導書", assetFile: "b2bb86570ad5b8f108c7621dc9dcb4a2.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860409088127 },
            { name: "*炎の魔導書", assetFile: "e8a6384fa3d1a7086930cb89a7e872be.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860386360158 },
            { name: "*幻夢のハープ", assetFile: "71a2ce745ae8df2af4a7788d97b6021d.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*マジックスティック", assetFile: "831ba7e5e2ce7204d642dd10fac1d492.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860386360158 },
            { name: "*自然の奇跡", assetFile: "519622eaf5425e8d685972107d11baad.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*ラピッドレーザー", assetFile: "8a18b243e99a899cc4e602f103ecd4ef.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859477272032 },
            { name: "*水晶玉", assetFile: "b6a57c916932449e6c6173e547183d87.svg", rotationCenterX: 224.96989, rotationCenterY: 106.23352177268981 },
            { name: "*大地の杖", assetFile: "2ea4be213a33a12e1adbfb634af3b00e.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*魔法の水", assetFile: "fe1ce147a4bdaf39db6f8716e9e049fc.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*Launcher", assetFile: "40a0ca7aec3b1f6ec12abd236c969fd2.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860306812269 },
            { name: "*ロケットランチャー", assetFile: "460ef5fec811e5a0a5a49bea66b6db5b.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860488636017 },
            { name: "*四連ロケットランチャー", assetFile: "e85dca3167badad04db334c25576c02a.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860165904998 },
            { name: "*擲弾発射機", assetFile: "eb513cc300e453106b035d273e30008a.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*ネットランチャー", assetFile: "2f7c62e33a6cfbe571fab9f923582487.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*バレットミニガン", assetFile: "00f3620484b317746254cb04bacee5e7.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*ボールバズーカ", assetFile: "69d908e08ed08b2ac8e1d6fc7e871ddc.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*イオンバズーカ", assetFile: "1a180f8bf98c696a4f5c0b75ad3a9534.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859965908048 },
            { name: "*スノーボールキャノン", assetFile: "ef404bbdbb59797102d2fc45e0d03165.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859965908048 },
            { name: "*Strike", assetFile: "9ed1b0aa2c21f0cc3aa7c3c3a1532eb6.svg", rotationCenterX: 224.969895, rotationCenterY: 106.518602840843 },
            { name: "*大剣", assetFile: "03839728fb6412e43e7a560e15838abc.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860272720316 },
            { name: "*騎士の剣", assetFile: "19e1159a5a958999485fa727d383d082.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*Dual", assetFile: "0e03c5d563a1365e86c2aba8400f8622.svg", rotationCenterX: 224.9699, rotationCenterY: 106.51859988636016 },
            { name: "*デュアルピストル", assetFile: "b386e5b29397affac0159e381b8142dc.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*デュアルショットガン", assetFile: "ff44f4f9996e46ae96d56006f475a141.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859954544064 },
            { name: "*Bomb", assetFile: "00a6cadf2724b0a4b499c7e18f6ebf0c.svg", rotationCenterX: 224.969895, rotationCenterY: 106.51860488636017 },
            { name: "*手榴弾", assetFile: "7e86ef11b65a3519447b3486e5bbe5b9.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*ポテトマッシャー", assetFile: "32080c7f9a4efed03a9d5b244bc21e72.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860409088127 },
            { name: "*強化型ポテトマッシャー", assetFile: "f1add011636cebc2f13cd734b73b26fa.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*ミニ手榴弾", assetFile: "f3252d2fd3068964be7d1515d3942301.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*フラッシュボム", assetFile: "347f7788bb3e0e953aac7be102b8a4d8.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*モロトフカクテル", assetFile: "f4bb609b1ddb19f9ebb00e0c36c2349a.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860420452111 },
            { name: "*パワーボム", assetFile: "fbbd5b29747a0fb18ec8580601561bbf.svg", rotationCenterX: 224.96989, rotationCenterY: 106.23352177268981 },
            { name: "*サンライトボム", assetFile: "71477500c4192427427c92b2b9b213c7.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*トリック", assetFile: "1f256f625f096961c146267379167ddd.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860154541014 },
            { name: "*Throw", assetFile: "57a732ba9f6d357cd870ef2a62c4f7ef.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*投擲用ナイフ", assetFile: "5ac1310eba81886df750a7bdb07c1769.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*ポイズンチャクラム", assetFile: "32cad4c002e3037ef057c52d984752ea.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860454544064 },
            { name: "*追尾ミサイル", assetFile: "219fd3a375885db9b0d5b2892d9ff781.svg", rotationCenterX: 224.969885, rotationCenterY: 106.36856181808471 },
            { name: "*つらら", assetFile: "dedaadc7580cc37104651e594cf5c7a9.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*Trap", assetFile: "d5c2e821ca7e24982354b0413af10b44.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860465908048 },
            { name: "*地雷", assetFile: "4426ef208545cf3af18f90f226c30186.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*Sマイン", assetFile: "b368602ccbcc452d49925465fd92e069.svg", rotationCenterX: 224.96989, rotationCenterY: 106.23352177268981 },
            { name: "*ファイヤーマイン", assetFile: "13730ff87932e6b68a9f1b1a085c1d36.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860165904998 },
            { name: "*パワーマイン", assetFile: "1c23de7a363148b864cc5b00bc76d757.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*スモークマイン", assetFile: "351c097b6a8cffce00fa5d65dc1507d1.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860154541014 },
            { name: "*クレイモア", assetFile: "87effad13f36d87588aad9b8ee8c8a79.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*レーザートラップ", assetFile: "ace3c9bc6943d00b1d4c25f30d6fcfca.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860165904998 },
            { name: "*かまくら", assetFile: "2c623d1cbbb221a53b6df6fc5092371a.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51860154541014 },
            { name: "*Heal", assetFile: "2358cd38d51e4bb4d44c6c30f98178a2.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860477272032 },
            { name: "*包帯", assetFile: "301a43c7f2ba4a0953e0b709c24de9af.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*救急箱", assetFile: "dc57e85111be602ebdfa4c7088717db6.svg", rotationCenterX: 224.96989, rotationCenterY: 106.36855693172456 },
            { name: "*リジェネタブレット", assetFile: "b3cf15293343d10ae37c39a775ff7a41.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860454544064 },
            { name: "*絆創膏", assetFile: "e70461736fc7f8c1db69e2a1adfb2055.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*Buff", assetFile: "d0649235c80fae6f96060a3aed751440.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860454544064 },
            { name: "*力の塗り薬", assetFile: "9c19591d72cfbc7b2590807468f9b898.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860420452111 },
            { name: "*スパークリングドリンク", assetFile: "5a3336243e14186571563260752c7117.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860420452111 },
            { name: "*ソードポーション", assetFile: "cab560ee1026f09ac7e6a8cb0c7620b2.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860409088127 },
            { name: "*護身のポーション", assetFile: "c579deac61bf65827d9239f2425f66e6.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860465908048 },
            { name: "*アーマーポーション", assetFile: "ca0a7206993e49247bb11dd29a3058b5.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636016 },
            { name: "*視界ポーション", assetFile: "edce3189a94c2f0ec4628182a2241e86.svg", rotationCenterX: 224.96989, rotationCenterY: 106.5185994318008 },
            { name: "*バッテリー", assetFile: "1c3e301b3d4eea4b972240466d63b0d8.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859931816095 },
            { name: "*トリート", assetFile: "c43d9d305d05bcede4b4ae51ebcfc43d.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859965908048 },
            { name: "*幸福のポーチ", assetFile: "7068dce5c25973c40e4d0c40bc07068c.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859954544064 },
            { name: "*アイスブーツ", assetFile: "a9667f41d1bd9340b8eceefcbf7310ea.svg", rotationCenterX: 224.96989, rotationCenterY: 106.5185994318008 },
            { name: "*Spell", assetFile: "10b014b7a8e4e9806146570bd0d09349.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859704521172 },
            { name: "*賢者の石", assetFile: "7aa1ac298733062769c37d4a3c51e123.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859477272032 },
            { name: "*マジックインゴット", assetFile: "ff08f822a1593f27ad80ba21d5db20e7.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*メイジジェム", assetFile: "7132a86bd4fe2bfa5cd913336de4d7d2.svg", rotationCenterX: 224.96988500000003, rotationCenterY: 106.51858977272029 },
            { name: "*ダークオーブ", assetFile: "2f14ec656abf8eb8baaf017d47e873cd.svg", rotationCenterX: 224.96989365234373, rotationCenterY: 106.51858735572813 },
            { name: "*Guard", assetFile: "5a7233200c31bc71d06466e16a14af12.svg", rotationCenterX: 224.969885, rotationCenterY: 106.36855738613124 },
            { name: "*クイックガード", assetFile: "4f3abc9e4f49c523657c2b5975f5af69.svg", rotationCenterX: 224.969885, rotationCenterY: 106.36855534061428 },
            { name: "*ラージガード", assetFile: "993f56542d32d75b9ccaf94d753aa4b5.svg", rotationCenterX: 224.969885, rotationCenterY: 106.36855738613124 },
            { name: "*サークルガード", assetFile: "8e5b88e4ab09346d150a701e4b5110b5.svg", rotationCenterX: 224.969885, rotationCenterY: 106.36856329509732 },
            { name: "*ウォールガード", assetFile: "a258a442a34019cc94ef70e5500e30fb.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*レーザーガード", assetFile: "97b79d76d0846b191769f7d409ac7d41.svg", rotationCenterX: 224.969885, rotationCenterY: 106.5186029541778 },
            { name: "*ポイズンガード", assetFile: "26de608416a343404eaf1fe906a81ca0.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*ステルスガード", assetFile: "91438f6a4da4314e5e25bcb459105c96.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*Team", assetFile: "34f8ce2e666549114de5379804e1161e.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859704521172 },
            { name: "*シェアパック", assetFile: "63f7e289a60cc43a7e06e0cebe44302f.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*回復スプレー", assetFile: "9d22f938ab5b3bf3cdfa523e6e32097e.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*力の祭壇", assetFile: "adb7ec8b3fee7ac71cfaeaed9fd133e2.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*シェアバリア", assetFile: "0e4d38648517c00d0f03e35db70edf6f.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*灯台", assetFile: "08ccd8ab0a51d22b53c5f9d82d122423.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*雷の塔", assetFile: "93e84eac32b84be7e83e117c252c393b.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*爆破の塔", assetFile: "1b29559c2f19d8ca2161eff48e833868.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859465908048 },
            { name: "*ライフクリスタル", assetFile: "877f378a48af4e123c03c0207b5125e0.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*お祓い棒", assetFile: "276313f9eab3bff8af82a7e9bcf70e10.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859488636016 },
            { name: "*Curse", assetFile: "ae05470ecb0f098034d315003e35e9fd.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*US-144", assetFile: "2df59a5d3ac0275c69ae289758e9c0c8.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860465908048 },
            { name: "*TM-016", assetFile: "ad08ccc380f95c7f44081160a6943ce7.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860454544064 },
            { name: "*JJ-100", assetFile: "56943508d4a90afc533ed37205b3bae1.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860409088127 },
            { name: "*BS-000", assetFile: "d7aab143d38b874d0c26945cf43f9b66.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "*BP-080", assetFile: "ee27a967f2a340b36ce32439f26453dd.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51860488636017 },
            { name: "Cat banner", assetFile: "612e7d3cf1ffda62e9e14e3ca0d4d283.svg", rotationCenterX: 235.5, rotationCenterY: 57.49999 },
            { name: "*ショルダーファン", assetFile: "3061ba374e539e41d1d6b227671d3b05.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859977272032 },
            { name: "*ワープボム", assetFile: "9570dd858a13c56fb3803043e17bf5b4.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859977272032 },
            { name: "*ラバーチャーム", assetFile: "bd4e5bab408d801107dc5f3d32b9c054.svg", rotationCenterX: 224.96989, rotationCenterY: 106.51859988636015 },
            { name: "*マジックワープ", assetFile: "b03aacb3560e24103b85a34e03160b94.svg", rotationCenterX: 224.969885, rotationCenterY: 106.51859454544064 },
            { name: "Cat Bot banner", assetFile: "f304f7c208984939d5ade22e5eac1b27.svg", rotationCenterX: 240.5, rotationCenterY: 180.5 },
            { name: "Golden Bot banner", assetFile: "481bcd4a2fc130b18f34586f3feb95d5.svg", rotationCenterX: 235.5, rotationCenterY: 57.61583999999996 },
            { name: "Gobo banner", assetFile: "2a9239130cd2905b544b21d5d5c243f2.svg", rotationCenterX: 235.50000000000006, rotationCenterY: 57.49999 },
            { name: "Spiky Gobo banner", assetFile: "e1bb6d70c9b880c2c99f3913e0100e51.svg", rotationCenterX: 235.5, rotationCenterY: 57.9606 },
            { name: "Lava Gobo banner", assetFile: "f6702464fe844a75deca8de1cd263443.svg", rotationCenterX: 235.83333, rotationCenterY: 58.24401 },
            { name: "Giga banner", assetFile: "1c1192e7af0f24039d5ed358f4b77916.svg", rotationCenterX: 235.5, rotationCenterY: 57.85740500000004 },
            { name: "Ninja Giga banner", assetFile: "fb22324e20187035a3a0b661fe24801e.svg", rotationCenterX: 235.5, rotationCenterY: 58.26623107347697 },
            { name: "Lightning Giga banner", assetFile: "49c3bbf789ffb46f17360e6468454a31.svg", rotationCenterX: 235.2945, rotationCenterY: 57.96556182799226 },
            { name: "Nano banner", assetFile: "345d88f5ae517d54d14320335720e107.svg", rotationCenterX: 235.5, rotationCenterY: 58.23949497205773 },
            { name: "Dark Nano banner", assetFile: "d47bfbed525157be4f52589ec76317ef.svg", rotationCenterX: 235.5, rotationCenterY: 58.759739999999994 },
            { name: "Combat Nano banner", assetFile: "f9ce27d59a19922f78ee71b6007a8534.svg", rotationCenterX: 235.5, rotationCenterY: 57.870090000000005 },
            { name: "Pico banner", assetFile: "cb6c0abef8e1917335a6fb7da842a1a3.svg", rotationCenterX: 235.5, rotationCenterY: 57.75425378011268 },
            { name: "Cyborg Pico banner", assetFile: "cedf0ef859b67a20cf74bce606c7025c.svg", rotationCenterX: 235.5, rotationCenterY: 57.54497342057314 },
            { name: "Shield Pico banner", assetFile: "009e5e90bc582223207df04e26e6ddf5.svg", rotationCenterX: 235.5, rotationCenterY: 57.883335 },
            { name: "Military Pico banner", assetFile: "ee8ff4fd137f1da9c9195beb54d23324.svg", rotationCenterX: 236.05189611111112, rotationCenterY: 57.750020000000006 },
            { name: "Tera banner", assetFile: "b8c123aa4039af4c11b1f836e355dfa7.svg", rotationCenterX: 235.5, rotationCenterY: 58.26622994164593 },
            { name: "Bio Tera banner", assetFile: "94f2fa90849510fe7c133a99a33b5c0e.svg", rotationCenterX: 235.5, rotationCenterY: 57.65490759487719 },
            { name: "Sacred Tera banner", assetFile: "9902e516484b177d32d7d49313029ca6.svg", rotationCenterX: 235.89563000000007, rotationCenterY: 61.63696500000002 },
            { name: "Pumpkin banner", assetFile: "4a10803eb7efb606223b23fce6ad68a1.svg", rotationCenterX: 235.5, rotationCenterY: 58.663465 },
            { name: "Snowman banner", assetFile: "50fa04785e252e81fac2839a66a230c5.svg", rotationCenterX: 235.5, rotationCenterY: 57.70354499999999 },
            { name: "April Cat banner", assetFile: "f969135d093b89f02837964c8655b97c.svg", rotationCenterX: 235.5, rotationCenterY: 66.33659013385774 },
            { name: "The Player banner", assetFile: "ddf0ecbc9710ad99e6b282c54b49fd1a.svg", rotationCenterX: 238.91753166666666, rotationCenterY: 63.96954833333329 },
            { name: "Cheat stopper info", assetFile: "09cc41f80f8f5ef2241466f11cef32fd.svg", rotationCenterX: 89.92847999999998, rotationCenterY: 103.3038400473633 },
            { name: "What's new", assetFile: "85600f668bd455b9d280b6a648946b33.svg", rotationCenterX: 226.31468756755692, rotationCenterY: 107.0849023692434 },
            { name: "What's festival", assetFile: "4cb1023786afca242f06d3ad23089bb5.svg", rotationCenterX: 225.18536646060943, rotationCenterY: 102.33122209472657 },
            { name: "What's maintenancing", assetFile: "ea6897d108e73bfd7b08ab7c1dea67f9.svg", rotationCenterX: 4.645370000000014, rotationCenterY: 114.83644500000008 },
            { name: "Rank bar", assetFile: "79df4586cd146632a116be102a9d5c90.svg", rotationCenterX: 187.53839000000002, rotationCenterY: 190.127305 },
            { name: "Rank background", assetFile: "fb8fcb3d243801ec8c22fe31af5f83e3.svg", rotationCenterX: 279.6706180646517, rotationCenterY: 198.627295 },
            { name: "Rank frame", assetFile: "8d521c833e297a667b7ad67f04b600b6.svg", rotationCenterX: 266.4699080646517, rotationCenterY: 183.127305 },
            { name: "Rank plate1", assetFile: "7c085929bad33e46756d81e9cf8353ed.svg", rotationCenterX: 66.66310532774347, rotationCenterY: 17.53222500000001 },
            { name: "Rank plate2", assetFile: "5dfe1e659cf4bd8b1657bcccf17b4647.svg", rotationCenterX: 66.66309565548707, rotationCenterY: 17.53222500000001 },
            { name: "Rank plate3", assetFile: "d4b96df74e2752f2c76db68c90602677.svg", rotationCenterX: 66.66309565548707, rotationCenterY: 17.53222500000001 },
            { name: "Rank plate4", assetFile: "657b6bcdd867a298ce6416fb96c58542.svg", rotationCenterX: 66.29807, rotationCenterY: 17.594414999999998 },
            { name: "Rank plate5", assetFile: "5fe27f4ca621b1e42193b4f784683dff.svg", rotationCenterX: 66.29807500000001, rotationCenterY: 17.558670000000006 },
            { name: "Rank plate6", assetFile: "ff470733667c331d730d59a473873320.svg", rotationCenterX: 66.29807500000001, rotationCenterY: 17.594414999999998 },
            { name: "Rank plate7", assetFile: "a167366796ed5b5fde1e445c030143ab.svg", rotationCenterX: 66.66362999999998, rotationCenterY: 17.5 },
            { name: "Rank plate8", assetFile: "1f8ec3b7abca4b50158bdcf31ac84dc2.svg", rotationCenterX: 66.66363000000001, rotationCenterY: 17.5 },
            { name: "Rank plate9", assetFile: "41c859e959a668e9b32d2830e7637605.svg", rotationCenterX: 66.66363000000001, rotationCenterY: 17.5 },
            { name: "Rank plate10", assetFile: "396a0f7eba027ee7f01592486dff4791.svg", rotationCenterX: 66.53827500000003, rotationCenterY: 17.50000000000003 },
            { name: "Rank plate11", assetFile: "228d4939d9b3dd26885af2310fa70c1e.svg", rotationCenterX: 66.538285, rotationCenterY: 17.50000000000003 },
            { name: "Rank plate12", assetFile: "099bc2860d085ffeea5533340979fd42.svg", rotationCenterX: 66.538275, rotationCenterY: 17.5 },
            { name: "Rank plate13", assetFile: "449b7acc0194a56983abb193105b6d72.svg", rotationCenterX: 66.64371499999999, rotationCenterY: 17.60766000000001 },
            { name: "Rank plate14", assetFile: "994df5159dfc0de92be49d47a8b3b883.svg", rotationCenterX: 66.64370500000001, rotationCenterY: 17.60766000000001 },
            { name: "Rank plate15", assetFile: "574518098904907b675657ea8c56f778.svg", rotationCenterX: 66.64369500000001, rotationCenterY: 17.60766000000001 },
            { name: "Tutorial frame", assetFile: "1932f0ebec78e9335fd822641254100e.svg", rotationCenterX: -8.79400499999997, rotationCenterY: -122.14585499999998 },
            { name: "Tutorial bar", assetFile: "c26b34223b1bffaf9c42685cbbe3e294.svg", rotationCenterX: -8.794004999999999, rotationCenterY: -122.14585499999998 },
            { name: "Tutorial1", assetFile: "040a4d1b0c691e4341d8be6ff2979c24.svg", rotationCenterX: -15.663669999999968, rotationCenterY: -124.59129679542536 },
            { name: "Tutorial2", assetFile: "7c7369f472039c90006f0319f72b983e.svg", rotationCenterX: -15.47055760525339, rotationCenterY: -124.59128859085075 },
            { name: "Tutorial3", assetFile: "fba008bff2a62310a70268c3dd83036f.svg", rotationCenterX: -15.663664999999895, rotationCenterY: -124.59129218170148 },
            { name: "Tutorial4", assetFile: "e8b47f09705d4fbdf20556c38c626f22.svg", rotationCenterX: -15.663664999999924, rotationCenterY: -124.59128859085075 },
            { name: "Tutorial5", assetFile: "50de0904889d73b803989e1cc34d2311.svg", rotationCenterX: -15.66366999999994, rotationCenterY: -124.81612717178348 },
            { name: "Tutorial6", assetFile: "8001cfb4fe4dc4d0c65948c3514d2bb2.svg", rotationCenterX: -15.663669999999911, rotationCenterY: -124.59129038627611 },
            { name: "Tutorial7", assetFile: "535088ab205fd3c7f2e361dacf11cff3.svg", rotationCenterX: -15.663669999999911, rotationCenterY: -124.59129038627611 },
            { name: "Tutorial8", assetFile: "a0224b65dbc3458d27640a0c6273c87b.svg", rotationCenterX: -15.663669999999968, rotationCenterY: -124.59129679542536 },
            { name: "Tutorial9", assetFile: "b6250020f5838af47708f3b2db45e9be.svg", rotationCenterX: -15.663664999999924, rotationCenterY: -124.59128859085075 },
            { name: "チュートリアル1", assetFile: "207cb121f6169601d2a558794535c392.svg", rotationCenterX: -15.47055760525339, rotationCenterY: -124.59128859085075 },
            { name: "チュートリアル2", assetFile: "085b2a1a96d056daa69394fa715d1164.svg", rotationCenterX: -15.663664999999924, rotationCenterY: -124.59128859085075 },
            { name: "チュートリアル3", assetFile: "435899fc0a6d77f9748fdca1effe0e5f.svg", rotationCenterX: -15.663664999999895, rotationCenterY: -124.59129218170148 },
            { name: "チュートリアル4", assetFile: "4841e6bd6512cb1fb970378c163d6bb5.svg", rotationCenterX: -15.663664999999924, rotationCenterY: -124.59128859085075 },
            { name: "チュートリアル5", assetFile: "4d21e67ea4e3596dee67c7fbcc65b12e.svg", rotationCenterX: -15.663664999999867, rotationCenterY: -124.8161281532287 },
            { name: "チュートリアル6", assetFile: "9dfb47689ded9fe7830a8240ced70138.svg", rotationCenterX: -15.663664999999952, rotationCenterY: -124.59128859085075 },
            { name: "チュートリアル7", assetFile: "4f4a5026a704cc846e07a2a244b4cd7d.svg", rotationCenterX: -15.663664999999924, rotationCenterY: -124.59129218170148 },
            { name: "チュートリアル8", assetFile: "fec5b807c4e10313a8cd71408692089d.svg", rotationCenterX: -15.663664999999895, rotationCenterY: -124.5912957725522 },
            { name: "チュートリアル9", assetFile: "2aa18de773e6801b3499ee161518f1aa.svg", rotationCenterX: -15.663664999999952, rotationCenterY: -124.59128859085075 },
            { name: "Mobile control", assetFile: "c0a95bbd38a3a08212b8df3c809efd48.svg", rotationCenterX: 91.75001, rotationCenterY: 56.19686500000002 },
            { name: "Mobile cursor", assetFile: "cc0829610d2ae9c91c00a0806407b9ad.svg", rotationCenterX: 15.5, rotationCenterY: 15.499995000000013 },
            { name: "Mobile command", assetFile: "45e0f814fa19c4ccae7ca7e770a34d89.svg", rotationCenterX: 62.000005000000016, rotationCenterY: 42.19687000000002 },
            { name: "Mobile", assetFile: "c77df1ce05e8994b1b91078e772521a2.svg", rotationCenterX: 28.58731508791712, rotationCenterY: 38.04754717334657 },
            { name: "~ウッドポット", assetFile: "e3db613137a83a3cc275f18ab60abf20.svg", rotationCenterX: 12.571394999999967, rotationCenterY: 16.56487333879008 },
            { name: "~ストーンゴーレム", assetFile: "08140f34b6230749b8ad4a24857947ff.svg", rotationCenterX: 17.598913559031615, rotationCenterY: 18.156220570509646 },
            { name: "~アイアンロケット", assetFile: "f92276d1f278a3d2a3daf13c7b30e719.svg", rotationCenterX: 19.01432428571428, rotationCenterY: 13.170492527199286 },
            { name: "~urukazu", assetFile: "529fa5ee79b56a125f70c7c35ef7efcb.svg", rotationCenterX: 20.2858709016958, rotationCenterY: 22.34914999999998 },
            { name: "~Takomaru-s", assetFile: "cff09a74d0f8bc74ec44bb0c1e938991.svg", rotationCenterX: 15.60987705400845, rotationCenterY: 17.876774164222297 },
            { name: "~011208tree", assetFile: "91706e3e1e5a0cf2d42aaa59d0f73844.svg", rotationCenterX: 23.510354999999976, rotationCenterY: 24.008137462490538 },
            { name: "~uk-400*", assetFile: "e80d55e3f0dfeb3348d0a44013a76291.svg", rotationCenterX: 19.72404590873981, rotationCenterY: 19.724045908739782 },
            { name: "~uk-4001", assetFile: "2a705ccf4bc0f3e69a232a8be56bafdd.svg", rotationCenterX: 19.72404304155478, rotationCenterY: 19.724042822438577 },
            { name: "~uk-4002", assetFile: "ab34a572ae3282aaca68f87bd31166e1.svg", rotationCenterX: 19.72404304155478, rotationCenterY: 19.724042822438577 },
            { name: "*ウッドポット", assetFile: "78a5aecba513e669b852936a7b2d3c6f.svg", rotationCenterX: 116.11850661566972, rotationCenterY: 101.99795322658534 },
            { name: "*ストーンゴーレム", assetFile: "5ecb088c043ddd76e243b6cca0a3f851.svg", rotationCenterX: 116.11850161566971, rotationCenterY: 101.99794496768948 },
            { name: "*アイアンロケット", assetFile: "d2f60f288b8795b5c7db27122879e2b2.svg", rotationCenterX: 116.11850661566972, rotationCenterY: 101.99794670879362 },
            { name: "*ゴールドエレメント", assetFile: "986588ffdb4714bb738a25332d6f470f.svg", rotationCenterX: 116.11850661566972, rotationCenterY: 102.46240689979552 },
            { name: "*ジェットユニコーン", assetFile: "cb4eccc47fe7bf20456cbdd52ff0f676.svg", rotationCenterX: 119.17417161566972, rotationCenterY: 102.46240844989777 },
            { name: "ピストル", assetFile: "6fd5839ab60ecc454313e8c51567958b.svg", rotationCenterX: 6.4642749999999864, rotationCenterY: 5.25 },
            { name: "サイレンサ付ピストル", assetFile: "9ade3b09fa2e4d072155cf99b84d464e.svg", rotationCenterX: 6.595237499999911, rotationCenterY: 5.666666666666657 },
            { name: "レーザーサイト付ピストル", assetFile: "9c222a15c13813c1ddf68f5c612d14c5.svg", rotationCenterX: 6.464229999999986, rotationCenterY: 5.25 },
            { name: "ハンドガン", assetFile: "8c5457cef8fefd1602a8ead5c19cd167.svg", rotationCenterX: 7.034909999999996, rotationCenterY: 6.467630000000014 },
            { name: "テラァシューター", assetFile: "92f12720cd0d688f6858ae95d16e25cd.svg", rotationCenterX: 8.888959999999997, rotationCenterY: 10.32038 },
            { name: "リボルバー", assetFile: "6a8f91f8bc86e33a87313da9a8029c67.svg", rotationCenterX: 12.949669999999998, rotationCenterY: 7.748639999999995 },
            { name: "早打ち銃", assetFile: "09b7dfdfd2fc3efe9e2269f38c92fc26.svg", rotationCenterX: 9.529082932352082, rotationCenterY: 6.698629363147461 },
            { name: "コンパクトサブマシンガン", assetFile: "0aa6252c003841612c550ca63eafc130.svg", rotationCenterX: 15.03313, rotationCenterY: 5.813050000000004 },
            { name: "×コンパクトサブマシンガン", assetFile: "ee5862849325df68db6fe86315b7cb90.svg", rotationCenterX: 14.417929898560146, rotationCenterY: 5.813050000000004 },
            { name: "ウージー", assetFile: "1a05778cdc125bb5ceb02ceb89ecd981.svg", rotationCenterX: 14.678570000000008, rotationCenterY: 5.813050000000004 },
            { name: "デュアルピストル", assetFile: "a1306853ec3ab70ac686dbf6adb78c98.svg", rotationCenterX: 6.464259999999996, rotationCenterY: 5.25 },
            { name: "<デュアルピストル", assetFile: "a1306853ec3ab70ac686dbf6adb78c98.svg", rotationCenterX: 6.464259999999996, rotationCenterY: 5.25 },
            { name: "デュアルショットガン", assetFile: "8363649011a7716ce3807a68ee7638c2.svg", rotationCenterX: 9.726184999999987, rotationCenterY: 6.357142857142918 },
            { name: "<デュアルショットガン", assetFile: "8fdd221131fab73e17b5079aae4d9c8f.svg", rotationCenterX: 9.726186428571395, rotationCenterY: 6.357142857142918 },
            { name: "BS-000", assetFile: "7e5a7d029b0d625f559e34db9205918a.svg", rotationCenterX: 11.851400000000012, rotationCenterY: 8.628387010344767 },
            { name: "<BS-000", assetFile: "7e5a7d029b0d625f559e34db9205918a.svg", rotationCenterX: 11.851400000000012, rotationCenterY: 8.628387010344767 },
            { name: "マシンガン", assetFile: "3c4a33d956bd81538cc563d3ac447fa1.svg", rotationCenterX: 6.345234999999917, rotationCenterY: 6.250000833333274 },
            { name: "スイカSMG", assetFile: "f128f7de23b10afe217f2d3573299158.svg", rotationCenterX: 6.464259999999996, rotationCenterY: 10.807841428580332 },
            { name: "アサルトライフル", assetFile: "80a5b123f76cbc365c76421d252e3d9e.svg", rotationCenterX: 16.107139999999987, rotationCenterY: 5.666664999999995 },
            { name: "ヘビーアサルトライフル", assetFile: "75ed266f237cbc6f48a4ef461f264421.svg", rotationCenterX: 23.892860000000013, rotationCenterY: 5.666629999999998 },
            { name: "CS-M", assetFile: "6212cabded80fc569c65389b48dc0c32.svg", rotationCenterX: 18.345235000000002, rotationCenterY: 5.666654999999963 },
            { name: "×CS-M", assetFile: "f59c81e96acfcf0acba0cb1395e95954.svg", rotationCenterX: 18.345235000000002, rotationCenterY: 5.666654999999992 },
            { name: "AK-47", assetFile: "81b4460ba60879d7f1410cda27de53ec.svg", rotationCenterX: 18.75, rotationCenterY: 5.666654999999963 },
            { name: "FA-MAS", assetFile: "09cd194d541ba1b325844188c999b572.svg", rotationCenterX: 16.728669999999994, rotationCenterY: 5.605169999999987 },
            { name: "ゼンマイ式ライフル", assetFile: "e8ab38b4b2ca247e3f7c21c7dc9c7e09.svg", rotationCenterX: 16.107139999999987, rotationCenterY: 6.257107502469296 },
            { name: "コインガン", assetFile: "5b5061f94e10e6f72e0f6632a45e2355.svg", rotationCenterX: 16.02221, rotationCenterY: 8.32958758636002 },
            { name: "火縄銃", assetFile: "b61fbd2b504965c2395de7dae02d527f.svg", rotationCenterX: 16.107139999999987, rotationCenterY: 5.683269154783176 },
            { name: "セミオートライフル", assetFile: "665ba138b7a2300e448b35bec71bb53b.svg", rotationCenterX: 18.24484000000001, rotationCenterY: 7.696319999999986 },
            { name: "コンバットライフル", assetFile: "e164ddce5ba273d72a9ebd84626b330e.svg", rotationCenterX: 16.25, rotationCenterY: 7.625 },
            { name: "ヘキサスコープカスタム", assetFile: "724c090c659922830427de8fac60835e.svg", rotationCenterX: 16.32670999999999, rotationCenterY: 8.743433816113424 },
            { name: "エンジンライフル", assetFile: "0964217955be12a1bed8dc200fb54a66.svg", rotationCenterX: 16.337015000000008, rotationCenterY: 10.278013636363625 },
            { name: "×エンジンライフル", assetFile: "ea2d32a615e16d6c7be6699b023df5a8.svg", rotationCenterX: 16.337005000000005, rotationCenterY: 10.278023636363628 },
            { name: "スナイパーライフル", assetFile: "c08ffc2c38265ed86ab669518786bc8c.svg", rotationCenterX: 16.148765000000026, rotationCenterY: 5.291654999999878 },
            { name: "レーザーサイト付スナイパーライフル", assetFile: "77e68f448a9e9eeb03fd50a0937b77ed.svg", rotationCenterX: 16.14874499999999, rotationCenterY: 5.29164499999996 },
            { name: "サイレンサ付スナイパーライフル", assetFile: "d74d0d4b0c24232055e294464bb0b151.svg", rotationCenterX: 16.134890000000013, rotationCenterY: 5.624959999999987 },
            { name: "銛スナイパー", assetFile: "4a258e84e24335eaaa3e16666180fe5c.svg", rotationCenterX: 22.45805999999999, rotationCenterY: 6.395679999999999 },
            { name: "シャドウスナイパー", assetFile: "c9c23ac2f3b0dc8c0bb9d9b9d0a1f2de.svg", rotationCenterX: 17.434480000000008, rotationCenterY: 8.455250000000007 },
            { name: "ショットスナイパー", assetFile: "af49f45978352dc27603e3176667c76d.svg", rotationCenterX: 20.920605000000023, rotationCenterY: 5.769402708276374 },
            { name: "レーザーキャノン", assetFile: "90b0a931d5ea37775635f46d55e31c24.svg", rotationCenterX: 22.713985953233504, rotationCenterY: 10.626103333333333 },
            { name: "US-144", assetFile: "008662d53add93df4a72f6bac83e9eba.svg", rotationCenterX: 26.749365178037976, rotationCenterY: 6.142029788830968 },
            { name: "ショットガン", assetFile: "bf8989013bc9af09a8417bdf1231b00d.svg", rotationCenterX: 19.440470000000005, rotationCenterY: 6.666659999999979 },
            { name: "タクティカルショットガン", assetFile: "8040d15a595f897611a29c7f257c9a9c.svg", rotationCenterX: 19.440470000000005, rotationCenterY: 6.8333299999999895 },
            { name: "ダブルバレルショットガン", assetFile: "8b0f1a281e8d2c74336102e62336959a.svg", rotationCenterX: 19.440470000000005, rotationCenterY: 7.180710000000005 },
            { name: "ロケットランチャー", assetFile: "eca97d35b0663836f134ff13f017534a.svg", rotationCenterX: 22.161193755356862, rotationCenterY: 10.295907203446632 },
            { name: "四連ロケットランチャー", assetFile: "cd9b9a46d26bb2f7affdb2741fad2868.svg", rotationCenterX: 18.12428, rotationCenterY: 15.006490000000014 },
            { name: "擲弾発射機", assetFile: "601fc4bb1a96367d2a991a763525cd46.svg", rotationCenterX: 21.994529999999997, rotationCenterY: 7.201989999999995 },
            { name: "ネットランチャー", assetFile: "9d6b0323ec47483da1a4c5399553a92a.svg", rotationCenterX: 16.84075999999999, rotationCenterY: 14.187531629438325 },
            { name: "バレットミニガン", assetFile: "2d6e786e60681152a3cd0ea37ba880ee.svg", rotationCenterX: 17.885088722167126, rotationCenterY: 13.346499999999992 },
            { name: "×バレットミニガン", assetFile: "8391f8d54a35e59e081765c76601a7ac.svg", rotationCenterX: 17.88508605131767, rotationCenterY: 13.346499999999992 },
            { name: "ボールバズーカ", assetFile: "1240478132ae799e3d078d55a6ae429e.svg", rotationCenterX: 22.84361000000004, rotationCenterY: 14.177674999999994 },
            { name: "イオンバズーカ", assetFile: "51760c23a42c8a361b38de50e103152d.svg", rotationCenterX: 15.021590254636635, rotationCenterY: 13.831192142857134 },
            { name: "スノーボールキャノン", assetFile: "6057ed7067aa9f7aadf037eb6f1bb5b5.svg", rotationCenterX: 14.985175000000083, rotationCenterY: 10.205017809151855 },
            { name: "×スノーボールキャノン", assetFile: "109acf99a0f887eaf7e2930bc1a121c4.svg", rotationCenterX: 14.985175000000083, rotationCenterY: 10.20501999999999 },
            { name: "ロケットフィスト", assetFile: "837cf612a288d7dbffcab61f6071419c.svg", rotationCenterX: 18.124281732537014, rotationCenterY: 20.67140051958529 },
            { name: "大剣", assetFile: "a1e7028cb10d16d458c93e456b0cbddf.svg", rotationCenterX: 15.088636726506536, rotationCenterY: 14.663149468821132 },
            { name: "騎士の剣", assetFile: "3f0aa5293c9aa7d42690986d80df7cbc.svg", rotationCenterX: 8.297036077553003, rotationCenterY: 10.640444778494043 },
            { name: "<騎士の剣", assetFile: "7e06b00419135f5d59dd4524e78ea12a.svg", rotationCenterX: 3.8000399999999956, rotationCenterY: 24.029608901082753 },
            { name: "手榴弾", assetFile: "34d660b325db76616e477dce5dcf618a.svg", rotationCenterX: 4.499932716828198, rotationCenterY: 9.454308333333387 },
            { name: "包帯", assetFile: "33b5278de17a6df5dd9589aa88f6c178.svg", rotationCenterX: 7.6799237131104405, rotationCenterY: 12.300805714285701 },
            { name: "救急箱", assetFile: "43daefc1e2fd174ab0148f22f8c147b6.svg", rotationCenterX: 5.067129999999992, rotationCenterY: 12.868509999999986 },
            { name: "回復スプレー", assetFile: "03dc32f3ef91b4932cd205dcf20144c8.svg", rotationCenterX: 8.80628999999999, rotationCenterY: 8.020559999999989 },
            { name: "賢者の石", assetFile: "111ff4005e645b77f8fb412a8fcd31db.svg", rotationCenterX: 4.541850000000011, rotationCenterY: 10.129809999999992 },
            { name: "絆創膏", assetFile: "b0a59e2c581754d94088f1785d8b16e8.svg", rotationCenterX: 12.420310216782923, rotationCenterY: 20.04531021678298 },
            { name: "マジックインゴット", assetFile: "086110dfdc0839f4d552e05a66f90df6.svg", rotationCenterX: 10.945419042712075, rotationCenterY: 9.426080488264574 },
            { name: "メイジジェム", assetFile: "9e68fa0ff845eecbb34bf74c76a07de2.svg", rotationCenterX: 10.748318363343571, rotationCenterY: 16.61202465516712 },
            { name: "ダークオーブ", assetFile: "378bd6998d1227faec6b3cc4a011d017.svg", rotationCenterX: 14.731740000000059, rotationCenterY: 14.731742500000024 },
            { name: "フラッシュボム", assetFile: "693a8fcaa0633fb8262884e54488a5d0.svg", rotationCenterX: 35.22460000000001, rotationCenterY: 35.22460000000001 },
            { name: "パワーボム", assetFile: "369cabdfb0b0c5c61825c8c412ff1a7e.svg", rotationCenterX: 16.891250000000014, rotationCenterY: 26.22460000000001 },
            { name: "ミニ手榴弾", assetFile: "37db25ea4c2b628bc106bf0f0c0e7949.svg", rotationCenterX: 4.133864545134799, rotationCenterY: 8.430421829910642 },
            { name: "投擲用ナイフ", assetFile: "677ab6020c5f0e17a583322ad0635c1d.svg", rotationCenterX: 6.546670000000006, rotationCenterY: 4.568189999999987 },
            { name: "ポイズンチャクラム", assetFile: "cd4229a20b02faa7fa5840d6dfd48fb8.svg", rotationCenterX: 7.4231462526118435, rotationCenterY: 14.982098384984539 },
            { name: "追尾ミサイル", assetFile: "371acfaa62834bb83d33e4b41f1a2692.svg", rotationCenterX: 8.271428571428629, rotationCenterY: 10.560408571428553 },
            { name: "つらら", assetFile: "31171759665645e8b07c54eb4a1b0767.svg", rotationCenterX: 12.604240353993475, rotationCenterY: 5.693325045617939 },
            { name: "空の魔導書", assetFile: "2b5336796298a4c1095b90d33c1e175a.svg", rotationCenterX: 6.993225000000024, rotationCenterY: 21.02270500000003 },
            { name: "炎の魔導書", assetFile: "6ca323c610d9291ded0bb7184f8eb937.svg", rotationCenterX: 33.375, rotationCenterY: 33.375 },
            { name: "×炎の魔導書", assetFile: "e94d2e683c205494f912e9793acc909c.svg", rotationCenterX: 33.375, rotationCenterY: 33.375 },
            { name: "水晶玉", assetFile: "cee975996be1208919b258fe468e12fd.svg", rotationCenterX: 4.03225744280482, rotationCenterY: 17.06522000000001 },
            { name: "マジックスティック", assetFile: "6f83289e97a00b3be2574c00f828123f.svg", rotationCenterX: 10.597264999999993, rotationCenterY: 6.209775000000008 },
            { name: "大地の杖", assetFile: "dd3c72846496ab29c063429534540ca6.svg", rotationCenterX: 14.501010000000008, rotationCenterY: 11.047650000000004 },
            { name: "幻夢のハープ", assetFile: "f6300354d4174af4ed30118ec3ff07f3.svg", rotationCenterX: 7.663399999999996, rotationCenterY: 16.970349999999996 },
            { name: "魔法の水", assetFile: "a11a75932ef3dd6767fa5581c1babfec.svg", rotationCenterX: -5.0851399999999956, rotationCenterY: 16.032610000000005 },
            { name: "自然の奇跡", assetFile: "8419531f2279ef0501f98f58077b7a60.svg", rotationCenterX: 8.35087999999999, rotationCenterY: 9.497960000000006 },
            { name: "ラピッドレーザー", assetFile: "3aededb56b4c33aa52a1232d70eeb263.svg", rotationCenterX: 25.17790041494584, rotationCenterY: 12.559452573275792 },
            { name: "TM-016", assetFile: "40f26541e4299a59a2046151c9c8d79d.svg", rotationCenterX: 13.625325000000004, rotationCenterY: 19.60143299455845 },
            { name: "JJ-100", assetFile: "7cf68f1d988782a696f1cf5bd75250b2.svg", rotationCenterX: 28.02682999999996, rotationCenterY: 12.53703999999999 },
            { name: "BP-080", assetFile: "2e2ec8dcb8336b7a8c312bde0885dbc7.svg", rotationCenterX: 8.808485979190607, rotationCenterY: 18.846132599987186 },
            { name: "モロトフカクテル", assetFile: "5d83d8c2b1b9e880911aeacdb2cabda3.svg", rotationCenterX: 3.744005900687455, rotationCenterY: 5.689578162147569 },
            { name: "サンライトボム", assetFile: "d7b8eefe1e70f07ec0ec5b64b7026cd3.svg", rotationCenterX: 3.870980000000003, rotationCenterY: 14.412399999999991 },
            { name: "トリック", assetFile: "ce3af809d4ce0934fa7a7409bd2a5f0c.svg", rotationCenterX: 8.717929999999996, rotationCenterY: 18.52839 },
            { name: "トリート", assetFile: "445fb15e1bbfbdf9fb2d4c47ca519b40.svg", rotationCenterX: 8.717929447448569, rotationCenterY: 18.528388616873826 },
            { name: "幸福のポーチ", assetFile: "b596260b941025c9e6c4ed9333595b8f.svg", rotationCenterX: 6.993363005614441, rotationCenterY: 10.02517231608931 },
            { name: "アイスブーツ", assetFile: "8aefff70c4575728199ce748aa0227b6.svg", rotationCenterX: 5.516737611681975, rotationCenterY: 18.2957846286063 },
            { name: "ポテトマッシャー", assetFile: "7c9819aebc2c06337bfd4f8dab54147c.svg", rotationCenterX: 11.709724999999992, rotationCenterY: 7.445715000000007 },
            { name: "強化型ポテトマッシャー", assetFile: "69a9ac1d597886ea88cdfcc2b6ce1dfe.svg", rotationCenterX: 10.092970000000008, rotationCenterY: 14.936388767016524 },
            { name: "地雷", assetFile: "a7ab5f3bbabad46e0bf0a7eaa89dae7d.svg", rotationCenterX: 9.822149972946391, rotationCenterY: 17.20040870388584 },
            { name: "Sマイン", assetFile: "80196fd3c9aa5c167b86802449e023a7.svg", rotationCenterX: 8.355193880475781, rotationCenterY: 8.428689999999989 },
            { name: "ファイヤーマイン", assetFile: "e3e66b5e45b1cb0af7d18a2db3b0137d.svg", rotationCenterX: 10.111023633981006, rotationCenterY: 15.843326869453364 },
            { name: "パワーマイン", assetFile: "06a1b9dbdd672a9e44dea510ae772533.svg", rotationCenterX: 7.213410000000039, rotationCenterY: 15.284838571428594 },
            { name: "スモークマイン", assetFile: "e08dc2a8df9ee636f56b0fd10fda5e52.svg", rotationCenterX: 3.277788034145857, rotationCenterY: 13.285119474206908 },
            { name: "レーザートラップ", assetFile: "2cf5daa854545bf388d67fdc0698328d.svg", rotationCenterX: 9.856349999999992, rotationCenterY: 10.403249467520482 },
            { name: "かまくら", assetFile: "54a18def42d63cb3c8b878da589613cf.svg", rotationCenterX: 9.069907847409894, rotationCenterY: 17.858621226452385 },
            { name: "クレイモア", assetFile: "8f05e564606edd3163cba33e42480e74.svg", rotationCenterX: 13.734340000000003, rotationCenterY: 14.558819208040575 },
            { name: "スイッチボム", assetFile: "8ce7adf7e5dc46bd18ebcb6e18ef752d.svg", rotationCenterX: 9.519278303961045, rotationCenterY: 15.832731552811765 },
            { name: "護身のポーション", assetFile: "2abb55c3bae025f802f1b5ada000f322.svg", rotationCenterX: 8.495290000000011, rotationCenterY: 15.154403734152936 },
            { name: "アーマーポーション", assetFile: "184736688879174037a6b41165708ec3.svg", rotationCenterX: 7.256409999999988, rotationCenterY: 13.129953670388232 },
            { name: "視界ポーション", assetFile: "c08c92b6a6a53044c31c9c074d0f0328.svg", rotationCenterX: 7.775491666666596, rotationCenterY: 12.144815986629226 },
            { name: "灯台", assetFile: "ebd7a3c072f0400817aa4e54de3664c3.svg", rotationCenterX: 11.366039999999998, rotationCenterY: 10.946850000000012 },
            { name: "バッテリー", assetFile: "1b3e051a222db28bc3d9a99e818ef991.svg", rotationCenterX: 11.343128571428565, rotationCenterY: 9.768760000000015 },
            { name: "雷の塔", assetFile: "9ccd1adcb4764014ca921a9661ff2128.svg", rotationCenterX: 9.471205000000026, rotationCenterY: 14.170210959322162 },
            { name: "爆破の塔", assetFile: "b42657d4facdc9f5814fd0374027f984.svg", rotationCenterX: 4.909879264859313, rotationCenterY: 12.560434999999984 },
            { name: "ライフクリスタル", assetFile: "20751c26b5c29414799809aa43571f59.svg", rotationCenterX: 18.02513122558591, rotationCenterY: 23.428571428571445 },
            { name: "お祓い棒", assetFile: "a2fcfb110b933540cf17555623f15201.svg", rotationCenterX: 5.737359999999995, rotationCenterY: 35.17221000000001 },
            { name: "力のポーション", assetFile: "656bc1c86cb830038dd1de9e335973ad.svg", rotationCenterX: 13.974116136991512, rotationCenterY: 13.225110080653764 },
            { name: "力の塗り薬", assetFile: "4fdf849d5b439f4da00e184de100e7e3.svg", rotationCenterX: 6.435154534389994, rotationCenterY: 10.222530000000006 },
            { name: "スパークリングドリンク", assetFile: "f7f2f868997a6d7c4b24aba1caeeeab4.svg", rotationCenterX: 6.141115102209767, rotationCenterY: 15.23433347011354 },
            { name: "ソードポーション", assetFile: "01e29d850d5de69d1561e22c9dd47988.svg", rotationCenterX: 7.64800377850537, rotationCenterY: 13.257555111634332 },
            { name: "力の祭壇", assetFile: "a08b704b3a36dfd74533d15e9965418d.svg", rotationCenterX: 9.971790705411678, rotationCenterY: 20.90360361963306 },
            { name: "リジェネタブレット", assetFile: "942aab16d971d0c933258a9b310aa375.svg", rotationCenterX: 6.555232095199159, rotationCenterY: 10.408156711010491 },
            { name: "シェアパック", assetFile: "fff56134dd0abfa22489f23069f9d7f9.svg", rotationCenterX: 8.47684000000001, rotationCenterY: 13.324295000000006 },
            { name: "シェアバリア", assetFile: "dadcaa646044efe6ee2dbf49e3ce845b.svg", rotationCenterX: 10.753620000000012, rotationCenterY: 10.75363999999999 },
            { name: "クイックガード", assetFile: "e3a76b182dec4b7ff132c98a11767fa7.svg", rotationCenterX: 16.96873429845752, rotationCenterY: 8.143442831364808 },
            { name: "ラージガード", assetFile: "2d0c725501028cb2b01efe4d2af5e46a.svg", rotationCenterX: 11.438107041902327, rotationCenterY: 11.008187769112766 },
            { name: "サークルガード", assetFile: "50b02fece07f33d054a20cfe85642ab7.svg", rotationCenterX: 9.619063344888474, rotationCenterY: 20.208395000000024 },
            { name: "ウォールガード", assetFile: "07c8b711647e5dc95989c641fe52c996.svg", rotationCenterX: 10.074885525430517, rotationCenterY: 15.457917476554456 },
            { name: "レーザーガード", assetFile: "1e6760b40598396856b08242850aec1f.svg", rotationCenterX: 10.19364185031796, rotationCenterY: 16.350819617439583 },
            { name: "ポイズンガード", assetFile: "fd4c65de749ae71b7cd40d8ab5ae9d58.svg", rotationCenterX: 8.294842826087006, rotationCenterY: 12.41774745341607 },
            { name: "ステルスガード", assetFile: "a2d88a871512c42bd812dc51a9d6d275.svg", rotationCenterX: 7.956889999999987, rotationCenterY: 11.916994999999986 },
            { name: "アキュレートスナイパー", assetFile: "02cd6964621364e1646037e98cac11c3.svg", rotationCenterX: 21.886259097135934, rotationCenterY: 5.416664999999995 },
            { name: "@ピストル", assetFile: "ba44592fd95fc06454305aa9a4e681ce.svg", rotationCenterX: 14.498945236206055, rotationCenterY: 16.50766944885254 },
            { name: "@サイレンサ付ピストル", assetFile: "131997c3f0998b9393e1553342ebd036.svg", rotationCenterX: 16.309166578947355, rotationCenterY: 16.73078289473682 },
            { name: "@レーザーサイト付ピストル", assetFile: "67f3fd3b9963316a43b5d00a88f79d42.svg", rotationCenterX: 15.071879999999993, rotationCenterY: 16.739810000000006 },
            { name: "@ハンドガン", assetFile: "3340654ae365281e966a080c4f97f04b.svg", rotationCenterX: 18.36819, rotationCenterY: 19.880770000000012 },
            { name: "@テラァシューター", assetFile: "c8c9168c7bdad349da3d9f2e23cdb653.svg", rotationCenterX: 17.205209999999994, rotationCenterY: 14.532549999999986 },
            { name: "@リボルバー", assetFile: "ac1896fc5374de465fa2a9370228f198.svg", rotationCenterX: 15.259453647239809, rotationCenterY: 16.8861 },
            { name: "@早打ち銃", assetFile: "abfd9a1d4da345cf67213204a4daa4f8.svg", rotationCenterX: 17.12066078186035, rotationCenterY: 16.91637420654297 },
            { name: "@コンパクトサブマシンガン", assetFile: "1b94ec4e0105c13604685018fa965329.svg", rotationCenterX: 17.291251986597842, rotationCenterY: 18.482830000000007 },
            { name: "@ウージー", assetFile: "2e9bba00e31a55322376f59f65e6e709.svg", rotationCenterX: 16.07480000000001, rotationCenterY: 17.57722000000001 },
            { name: "@デュアルピストル", assetFile: "c15068f4e8881f087da8104a1c6c2256.svg", rotationCenterX: 19.600580000000008, rotationCenterY: 16.389909999999986 },
            { name: "@デュアルショットガン", assetFile: "231ae599e960fe4f215c67d2a6fdf2d6.svg", rotationCenterX: 19.373127164132, rotationCenterY: 17.39593919015371 },
            { name: "@マシンガン", assetFile: "3cd2efda8a4132157a310c35283de2a0.svg", rotationCenterX: 13.118849754333496, rotationCenterY: 15.318229675292969 },
            { name: "@スイカSMG", assetFile: "ab85534bd21a2156a323b40b3675b5c2.svg", rotationCenterX: 19.160415, rotationCenterY: 18.788105 },
            { name: "@バーストサブマシンガン", assetFile: "b078acc6882b7e81f7bcc0d556ac3f88.svg", rotationCenterX: 12.579370000000011, rotationCenterY: 13.924433241966597 },
            { name: "@アサルトライフル", assetFile: "53c1251a78d60ae9ff673f4c0332d95d.svg", rotationCenterX: 16.248205184936523, rotationCenterY: 16.665279388427734 },
            { name: "@ヘビーアサルトライフル", assetFile: "fc2bf280efa0ea26fbb964bce8cdec08.svg", rotationCenterX: 17.34141645210636, rotationCenterY: 16.933723636363624 },
            { name: "@CS-M", assetFile: "ddabad1ff8d018e6a408c232d3d0748a.svg", rotationCenterX: 18.188116082892293, rotationCenterY: 18.233589999999992 },
            { name: "@AK-47", assetFile: "ec3e99a6ed66f8de7d9e023bd9ddf3fe.svg", rotationCenterX: 20.3125, rotationCenterY: 20.3125 },
            { name: "@FA-MAS", assetFile: "4d4b6afbe88ecc1ef1a0c233f526d0e7.svg", rotationCenterX: 17.79974999999999, rotationCenterY: 16.537080000000003 },
            { name: "@ゼンマイ式ライフル", assetFile: "bee6798ce6b196968dce00dbef180130.svg", rotationCenterX: 19.75872000000001, rotationCenterY: 20.229379999999992 },
            { name: "@コインガン", assetFile: "00ab2b4659b822aa4233bdb40046f05d.svg", rotationCenterX: 15.429651543409676, rotationCenterY: 17.868539999999996 },
            { name: "@火縄銃", assetFile: "7e32bd34a4809538c57583e556ca0eb0.svg", rotationCenterX: 17.19193999999999, rotationCenterY: 15.974670000000003 },
            { name: "@セミオートライフル", assetFile: "b2da2c752569393f4b02c53eb0cd0472.svg", rotationCenterX: 18.41772922666874, rotationCenterY: 13.745560000000012 },
            { name: "@コンバットライフル", assetFile: "63b9d984d1b7f702e8b9256d789c7476.svg", rotationCenterX: 17.341304779052734, rotationCenterY: 16.126070022583008 },
            { name: "@ヘキサスコープカスタム", assetFile: "9d7b06635842ee2b57eb7550b3f45e17.svg", rotationCenterX: 18.034539999999993, rotationCenterY: 16.725420000000014 },
            { name: "@エンジンライフル", assetFile: "af3d46de224af076d6b92368768fff96.svg", rotationCenterX: 18.952490658522663, rotationCenterY: 16.770285 },
            { name: "@スナイパーライフル", assetFile: "094f4dfee72f34d5690d5c4297a8aa67.svg", rotationCenterX: 17.53012000000001, rotationCenterY: 15.450377774487293 },
            { name: "@レーザーサイト付スナイパーライフル", assetFile: "a358b7505552e0e73aac8f8ec5d9403f.svg", rotationCenterX: 17.530120849609375, rotationCenterY: 15.568499565124512 },
            { name: "@サイレンサ付スナイパーライフル", assetFile: "6254c4d27833bb80b9bfd3e07e3f6b0a.svg", rotationCenterX: 18.46762000000001, rotationCenterY: 15.488409999999988 },
            { name: "@銛スナイパー", assetFile: "076ccdccedcf2badaaf7c0a0a7e3ea03.svg", rotationCenterX: 18.881741034000413, rotationCenterY: 17.239672822918465 },
            { name: "@シャドウスナイパー", assetFile: "439d71d181282276e19783d9c731ff44.svg", rotationCenterX: 17.51069000000001, rotationCenterY: 16.112349999999992 },
            { name: "@ショットスナイパー", assetFile: "f0674318e50c70d71f8dc2fdaa45b564.svg", rotationCenterX: 18.859918291941085, rotationCenterY: 18.72002356685806 },
            { name: "@レーザーキャノン", assetFile: "a80544bdaf19099fbb85b2a3ac6b409a.svg", rotationCenterX: 19.225638333333336, rotationCenterY: 17.463233333333363 },
            { name: "@US-144", assetFile: "12c4c2dbabc740d9b1873e43b5b34e20.svg", rotationCenterX: 31.87098499999999, rotationCenterY: 25.308234999999996 },
            { name: "@ショットガン", assetFile: "7a309933e348b734a543b07c1eaac05c.svg", rotationCenterX: 17.391040802001953, rotationCenterY: 15.481624603271484 },
            { name: "@タクティカルショットガン", assetFile: "20aef229f039c6e14882889434debe34.svg", rotationCenterX: 15.676240457763669, rotationCenterY: 15.683135032653809 },
            { name: "@ダブルバレルショットガン", assetFile: "d0edcd2c2b7b1b846b612cf4890f4a08.svg", rotationCenterX: 17.5103, rotationCenterY: 16.81989999999999 },
            { name: "@ロケットランチャー", assetFile: "0074750f351c5a2bbb166f5ea3bd900b.svg", rotationCenterX: 17.494965000000008, rotationCenterY: 19.096298759927635 },
            { name: "@四連ロケットランチャー", assetFile: "d5a2e4c09352a531acc1c601b94f3754.svg", rotationCenterX: 18.101010000000002, rotationCenterY: 16.95582999999999 },
            { name: "@擲弾発射機", assetFile: "52a8afb99dfd5f89ce8cf9a4b31a6ac5.svg", rotationCenterX: 17.15934114910641, rotationCenterY: 16.55967000000001 },
            { name: "@ネットランチャー", assetFile: "63c52a0930fe8debecb4617ae95b06e3.svg", rotationCenterX: 16.799620000000004, rotationCenterY: 17.751239999999996 },
            { name: "@バレットミニガン", assetFile: "1f1b404b99fb24579eae4a743ccd180f.svg", rotationCenterX: 18.346179693409027, rotationCenterY: 16.341977823591407 },
            { name: "@ボールバズーカ", assetFile: "a47b9d8f637b03b5531fabf7e79c7778.svg", rotationCenterX: 19.021244999999993, rotationCenterY: 19.983899999999835 },
            { name: "@イオンバズーカ", assetFile: "4a292ec0ff6536ae0ea42752fd17a6ef.svg", rotationCenterX: 21.50063499999999, rotationCenterY: 18.800625000000025 },
            { name: "@スノーボールキャノン", assetFile: "f6b8699753def91f26e45cf0a49888fc.svg", rotationCenterX: 18.704830000000015, rotationCenterY: 17.5796 },
            { name: "@大剣", assetFile: "85edd98ab5c613144d666f4b388ea98c.svg", rotationCenterX: 18.2272747315985, rotationCenterY: 16.969741862020214 },
            { name: "@騎士の剣", assetFile: "3b348c86e7fe49ee5cca2c52d9bf8f10.svg", rotationCenterX: 16.3647, rotationCenterY: 16.27546000000001 },
            { name: "@空の魔導書", assetFile: "dce507bb5e6d76cb9c3872ccf5f58841.svg", rotationCenterX: 14.791665077209473, rotationCenterY: 17.503378123750934 },
            { name: "@炎の魔導書", assetFile: "1941bdd38a213bd5d020d7700211978a.svg", rotationCenterX: 20.921054999999996, rotationCenterY: 20.921054999999996 },
            { name: "@水晶玉", assetFile: "2e5ae522f24bc896b7aba4eca8eb3513.svg", rotationCenterX: 17.06519, rotationCenterY: 14.264199999999988 },
            { name: "@マジックスティック", assetFile: "9c9004d364a3f6af82becc315d490bfc.svg", rotationCenterX: 19.558044999999993, rotationCenterY: 18.268040000000013 },
            { name: "@幻夢のハープ", assetFile: "7870852f0cee907d61ce7f990f46b57f.svg", rotationCenterX: 18.15351000000001, rotationCenterY: 19.155130000000014 },
            { name: "@大地の杖", assetFile: "4f96026df882248df6eff751549e5a92.svg", rotationCenterX: 13.428259999999995, rotationCenterY: 14.513530000000003 },
            { name: "@魔法の水", assetFile: "fd7850ea7d85901660a3cc46e79baa3b.svg", rotationCenterX: 16.032610000000005, rotationCenterY: 16.609289999999987 },
            { name: "@自然の奇跡", assetFile: "394d451c87fc50bdc9f352f25ba38482.svg", rotationCenterX: 16.79307, rotationCenterY: 16.77668 },
            { name: "@ラピッドレーザー", assetFile: "e6edc6c7931ea4ac8887078f159e1aa5.svg", rotationCenterX: 15.07189351136509, rotationCenterY: 17.932680766693863 },
            { name: "@TM-016", assetFile: "6dfde67ea66032732531120d07b0c9c6.svg", rotationCenterX: 21.056975021379714, rotationCenterY: 27.125335000000007 },
            { name: "@JJ-100", assetFile: "1b99a42cf0a4f836f8a7d4a9e1638b07.svg", rotationCenterX: 24.989292165836417, rotationCenterY: 25.017536349130694 },
            { name: "@BS-000", assetFile: "95a177678008c08623d04731c600548c.svg", rotationCenterX: 28.37912942535482, rotationCenterY: 22.038464425354846 },
            { name: "@BP-080", assetFile: "86354f0da1506830bf98788f29374121.svg", rotationCenterX: 17.278384197427727, rotationCenterY: 22.880740000000003 },
            { name: "@手榴弾", assetFile: "9b50e4491d594b5f109dfea41580f7f3.svg", rotationCenterX: 20.080644607543945, rotationCenterY: 20.080644607543945 },
            { name: "@ミニ手榴弾", assetFile: "9a22cb18bddf61bfa39f74d63e956086.svg", rotationCenterX: 15.976244926452637, rotationCenterY: 14.855215072631836 },
            { name: "@フラッシュボム", assetFile: "406e982740d54b8b1b080fcfaecd162e.svg", rotationCenterX: 35.22460000000001, rotationCenterY: 35.22460000000001 },
            { name: "@パワーボム", assetFile: "0af6dc082fa909d819f0186a3821d546.svg", rotationCenterX: 17.63687999999999, rotationCenterY: 16.654740000000004 },
            { name: "@ポテトマッシャー", assetFile: "5e4e6df271e69a7bb02931cfc58880b3.svg", rotationCenterX: 17.079315185546875, rotationCenterY: 17.072465896606445 },
            { name: "@強化型ポテトマッシャー", assetFile: "4880c9f95993b38d96c5f53274c54292.svg", rotationCenterX: 17.688919999999996, rotationCenterY: 18.22236000000001 },
            { name: "@モロトフカクテル", assetFile: "dfc9b6bf70a50b7545726b6e3646d9b2.svg", rotationCenterX: 17.41131591796875, rotationCenterY: 14.1233549118042 },
            { name: "@サンライトボム", assetFile: "e291c82d75e1f49ca00474558e8586ec.svg", rotationCenterX: 14.605065000000025, rotationCenterY: 17.16540205395674 },
            { name: "@トリック", assetFile: "c59a02e3736ab83c81d5d3fd69fb1959.svg", rotationCenterX: 19.77662000000001, rotationCenterY: 20.310587777777755 },
            { name: "@投擲用ナイフ", assetFile: "a9caaab04e30c5674b8db0b396b4f905.svg", rotationCenterX: 16.979070000000007, rotationCenterY: 14.48911000000001 },
            { name: "@ポイズンチャクラム", assetFile: "2978b02306ae5380da6301804f36108c.svg", rotationCenterX: 15.01494836861039, rotationCenterY: 14.831122701107688 },
            { name: "@追尾ミサイル", assetFile: "45cbcd347602ef2dbd45d8b0727419ef.svg", rotationCenterX: 20.493470000000002, rotationCenterY: 20.101074002754643 },
            { name: "@つらら", assetFile: "a4b42b8354ed8663b2018a14427cd950.svg", rotationCenterX: 17.648817658723686, rotationCenterY: 18.311382588048787 },
            { name: "@ミニタンク", assetFile: "83d8da50817407b0a7a26034528e2d6a.svg", rotationCenterX: 17.806510000000003, rotationCenterY: 15.180470000000014 },
            { name: "@地雷", assetFile: "402a871a4be636a5ac381f9a2cf16efc.svg", rotationCenterX: 15.478815078735352, rotationCenterY: 15.478815078735352 },
            { name: "@Sマイン", assetFile: "41f56c856cf354d1ddbf27a64cbfd9af.svg", rotationCenterX: 15.396852771939848, rotationCenterY: 15.49063000000001 },
            { name: "@ファイヤーマイン", assetFile: "e85ccf337c39667faa2277fd6e33b4ab.svg", rotationCenterX: 17.345646815236705, rotationCenterY: 18.42463336276427 },
            { name: "@パワーマイン", assetFile: "e94d38bf75f6c6bf88a059865958b9ff.svg", rotationCenterX: 14.21341000000001, rotationCenterY: 14.21341000000001 },
            { name: "@スモークマイン", assetFile: "3f7b5d922af714ceb4bd6ca4fc9c5257.svg", rotationCenterX: 13.804699750363511, rotationCenterY: 14.008933031381133 },
            { name: "@レーザートラップ", assetFile: "53b353a9fb654c655b9394d87c5a242d.svg", rotationCenterX: 15.652810117666974, rotationCenterY: 15.524804999999986 },
            { name: "@かまくら", assetFile: "258e93e08bfadc0f38c048d3fdd4c58c.svg", rotationCenterX: 17.858621226452442, rotationCenterY: 16.440344338094746 },
            { name: "@クレイモア", assetFile: "cf44d383cee6d0575c5bf65acc69b3d5.svg", rotationCenterX: 15.037980000000005, rotationCenterY: 17.314790573585356 },
            { name: "@包帯", assetFile: "d961121612b9f5a230e566323efe4018.svg", rotationCenterX: 24.586559295654297, rotationCenterY: 24.586559295654297 },
            { name: "@救急箱", assetFile: "e0ddab5624f05108493585efb23f6be6.svg", rotationCenterX: 16.904169999999993, rotationCenterY: 16.44618 },
            { name: "@シェアパック", assetFile: "beafabd90c9486eb428b71e70e5919ba.svg", rotationCenterX: 15.129449844360352, rotationCenterY: 16.641185760498047 },
            { name: "@賢者の石", assetFile: "c6ae4caea7595d11ee1557aadb92cd1a.svg", rotationCenterX: 16.012110000000007, rotationCenterY: 17.0539 },
            { name: "@絆創膏", assetFile: "4c26a66ca48e17b30ddba859ad8afdc5.svg", rotationCenterX: 15.75, rotationCenterY: 15.75 },
            { name: "@マジックインゴット", assetFile: "acf944f7fc39ba0ff16f36c77f65cc79.svg", rotationCenterX: 19.04302999999993, rotationCenterY: 12.522763670552365 },
            { name: "@メイジジェム", assetFile: "69ab96c9cc9d5c8a49f27df476e1434a.svg", rotationCenterX: 20.95804082969363, rotationCenterY: 20.95804082969363 },
            { name: "@ダークオーブ", assetFile: "c1c82f0e1540735ba3924695b8bcff74.svg", rotationCenterX: 20.95804000000001, rotationCenterY: 20.95804000000001 },
            { name: "@マジックワープ", assetFile: "df6de25a155c8f4e59e4fd115ff68bbf.svg", rotationCenterX: 15.577149999999989, rotationCenterY: 16.64381499999999 },
            { name: "@シェアバリア", assetFile: "b6635203ccde3567c47945971467d6e8.svg", rotationCenterX: 19.72095999999999, rotationCenterY: 18.999809999999997 },
            { name: "@回復スプレー", assetFile: "1db4bfa983a37d8314af9c4223ede609.svg", rotationCenterX: 17.956099999999992, rotationCenterY: 18.001193562373118 },
            { name: "@リジェネタブレット", assetFile: "e5071e1beb4a8a8422caf57fc616833d.svg", rotationCenterX: 11.836729999999989, rotationCenterY: 15.702529999999996 },
            { name: "@護身のポーション", assetFile: "90b2b676b72ba151a0699d20d0942589.svg", rotationCenterX: 15.867169999999987, rotationCenterY: 15.841285 },
            { name: "@アーマーポーション", assetFile: "ac2b8abcb770f5a727e19c3a98269e71.svg", rotationCenterX: 14.51163304161156, rotationCenterY: 14.69095999999999 },
            { name: "@視界ポーション", assetFile: "fa73e90e4c6bb3f282de9dd3501c693b.svg", rotationCenterX: 13.424245000000013, rotationCenterY: 17.108835 },
            { name: "@灯台", assetFile: "fb6e4c01e8fa122424221078a4b2f365.svg", rotationCenterX: 9.236790000000013, rotationCenterY: 19.82289499999999 },
            { name: "@バッテリー", assetFile: "f98aa98f79f880d111a62ed92854fa1d.svg", rotationCenterX: 16.76805999999999, rotationCenterY: 16.76805999999999 },
            { name: "@雷の塔", assetFile: "409934aefd5b3412da30cde3bca2e721.svg", rotationCenterX: 11.454549999999955, rotationCenterY: 19.72118499999999 },
            { name: "@爆破の塔", assetFile: "3ce755cc51f9868a5408e67ee82ac93e.svg", rotationCenterX: 19.62841457897602, rotationCenterY: 23.084194578975968 },
            { name: "@ライフクリスタル", assetFile: "315087ab7d464cf990609a91bbe346a7.svg", rotationCenterX: 21.166660000000007, rotationCenterY: 16.656065000000012 },
            { name: "@お祓い棒", assetFile: "fda9b496675ea370fa2381cbaeedf473.svg", rotationCenterX: 16.776990000000012, rotationCenterY: 16.28979000000001 },
            { name: "@力の塗り薬", assetFile: "13220d6a201f226bf9bdf53e51bf0cf4.svg", rotationCenterX: 10.923388115092678, rotationCenterY: 16.517390514764628 },
            { name: "@スパークリングドリンク", assetFile: "5720cd8991b8ba68a128c3e35e75525f.svg", rotationCenterX: 14.368638855383097, rotationCenterY: 15.953460384310745 },
            { name: "@ソードポーション", assetFile: "9d69945228500e8835bbee83b91b187d.svg", rotationCenterX: 14.511634124834671, rotationCenterY: 14.690960000000047 },
            { name: "@トリート", assetFile: "03be864bbd7f2ab5ccab4e4a75d19559.svg", rotationCenterX: 20.159445000000034, rotationCenterY: 18.905932777777707 },
            { name: "@幸福のポーチ", assetFile: "8e3d78c1efb75f0457c9ae265d09b7e6.svg", rotationCenterX: 13.388172935318067, rotationCenterY: 15.43189517833838 },
            { name: "@アイスブーツ", assetFile: "60b63adb02444fc0d1c395e87dd3d3cd.svg", rotationCenterX: 19.32357863818197, rotationCenterY: 15.849447535315534 },
            { name: "@力の祭壇", assetFile: "cdff1d08cf2425bdb8bb4316255bf3ef.svg", rotationCenterX: 13.727744288173625, rotationCenterY: 16.196633046992105 },
            { name: "@クイックガード", assetFile: "c789f29e52d918cfc9ddd38ca5ef2ff9.svg", rotationCenterX: 17.007454999999993, rotationCenterY: 17.007454999999993 },
            { name: "@ラージガード", assetFile: "16ed6818b31ec84e708a1366059e6fbc.svg", rotationCenterX: 17.856195000000014, rotationCenterY: 17.858859999999993 },
            { name: "@サークルガード", assetFile: "c22cb1d602f6ffe56f4e41a66cfead10.svg", rotationCenterX: 19.85062460669917, rotationCenterY: 19.97718688410913 },
            { name: "@ウォールガード", assetFile: "549a7116e5742452d93650ed9e4087d1.svg", rotationCenterX: 18.022019999999998, rotationCenterY: 19.643341030678982 },
            { name: "@レーザーガード", assetFile: "4525ccd2376298198cbb95734e8eb8b5.svg", rotationCenterX: 18.545905000000005, rotationCenterY: 18.545895 },
            { name: "@ポイズンガード", assetFile: "7e29de45ee18110558603dc65822deaf.svg", rotationCenterX: 18.413690000000003, rotationCenterY: 18.913689999999974 },
            { name: "@ステルスガード", assetFile: "eda5a084b5d0eb2970abfdd17626d6fb.svg", rotationCenterX: 17.91659323529413, rotationCenterY: 19.916587828698226 },
            { name: "@アキュレートスナイパー", assetFile: "20225c2cdfc19cd5d307e7fd06637358.svg", rotationCenterX: 16.902179999999987, rotationCenterY: 19.171359999999993 },
            { name: "@シールドキャノン", assetFile: "e6d3beea6f69101e91946a0a67d56f45.svg", rotationCenterX: 20.36434602409068, rotationCenterY: 20.911505508770148 },
            { name: "@シールドバッシュ", assetFile: "1e83f2f73f77b0381bc902a61b6878b5.svg", rotationCenterX: 19.777620000000013, rotationCenterY: 21.259269999999987 },
            { name: "@シールドファンネル", assetFile: "8798fcb9f7bbe98407da44568367c25c.svg", rotationCenterX: 15.403989999999993, rotationCenterY: 15.020100000000014 },
            { name: "@戦車主砲", assetFile: "e2fe75d36a8e3aa25a8a47190905cb60.svg", rotationCenterX: 55.17441371468763, rotationCenterY: 20.310024999999996 },
            { name: "@戦車重機関銃", assetFile: "758d62b4dba2c9c3b7e8282d0f775fff.svg", rotationCenterX: 19.720679999999987, rotationCenterY: 16.201359999999994 },
            { name: "@戦車発火弾", assetFile: "9034d948724ff944879619c0ff5c581a.svg", rotationCenterX: 20.46658172152209, rotationCenterY: 20.874071651571484 },
            { name: "@怒り", assetFile: "919a9be508abe4393d4c1b7df17d2c99.svg", rotationCenterX: 18.168415069580078, rotationCenterY: 18.147354125976562 },
            { name: "@オーバークロック", assetFile: "4e504b57a6e6e0ce94a4d26d7b8a177b.svg", rotationCenterX: 20.349199999999996, rotationCenterY: 20.851519999999994 },
            { name: "@狙撃ワープ", assetFile: "091b9fc76347e05a3fb8fc0bd12857fe.svg", rotationCenterX: 21.19999999999999, rotationCenterY: 21.19999999999999 },
            { name: "@落石注意", assetFile: "9c85cf9c61888bf643614511f7b55b96.svg", rotationCenterX: 18.550064086914062, rotationCenterY: 20.57201639811194 },
            { name: "@トゲトゲブースト", assetFile: "855451b53e13a5909a38424bf2917989.svg", rotationCenterX: 18.503537120764207, rotationCenterY: 20.34145847380225 },
            { name: "@スーパーバリア", assetFile: "c5e66579cc2df1df131e8e4606bba2aa.svg", rotationCenterX: 18.865022816349068, rotationCenterY: 18.84718972233526 },
            { name: "@煙玉", assetFile: "619dc93bbe4b2005410d5a1fa1e5989f.svg", rotationCenterX: 18.117666666666764, rotationCenterY: 16.202041782136234 },
            { name: "@マキビシショット", assetFile: "477c0a8f1bcff89295e1be653d76715d.svg", rotationCenterX: 19.285773463792083, rotationCenterY: 20.41156028200365 },
            { name: "@ライトニングダッシュ", assetFile: "f7a88fa692564ab86c4d14539390c5fc.svg", rotationCenterX: 20.158972194276686, rotationCenterY: 20.25218000000001 },
            { name: "@アサシン", assetFile: "c7d528dca69eff9834fa6d14e2de1800.svg", rotationCenterX: 20.84550999999999, rotationCenterY: 20.84550999999999 },
            { name: "@魔改造", assetFile: "448779738dcd5011927a7db337aca519.svg", rotationCenterX: 20.349189999999993, rotationCenterY: 20.851519999999994 },
            { name: "@近接カウンター", assetFile: "4e46fd5110648d0d188c3e0c340177ad.svg", rotationCenterX: 21.22057000000001, rotationCenterY: 21.22057000000001 },
            { name: "@デストロイヤー", assetFile: "811f433b5544d37756574ad3c176f227.svg", rotationCenterX: 21.957314999999994, rotationCenterY: 20.474491666666637 },
            { name: "@ヒーリングゾーン", assetFile: "abffc984f22b0047c94367bcc08950bc.svg", rotationCenterX: 13.615960000000001, rotationCenterY: 18.56674000000001 },
            { name: "@神秘のトーテム", assetFile: "85c787d703130614d2dee08520acfe4d.svg", rotationCenterX: 10.057639999999992, rotationCenterY: 19.039449999999988 },
            { name: "@羽衣の加護", assetFile: "0c741f425a68178ea626c88bc641f328.svg", rotationCenterX: 21.458145000000002, rotationCenterY: 19.924679999999995 },
            { name: "@破壊レーザー", assetFile: "89c046858fdea6abb4bb88d11bf8f525.svg", rotationCenterX: 17.19825553894043, rotationCenterY: 14.289227749375925 },
            { name: "@死神の鎌", assetFile: "f4f5b3a397171d383aebf3874a43f42c.svg", rotationCenterX: 18.484049999999996, rotationCenterY: 18.091430000000003 },
            { name: "@弾薬箱", assetFile: "1c0c0592e16cf4a830ea872c7b11a33c.svg", rotationCenterX: 17.655020000000007, rotationCenterY: 17.314965 },
            { name: "@ハロウィンの魂", assetFile: "6691ee4fd8cc09b7d63119962f656f0b.svg", rotationCenterX: 14.46085857142856, rotationCenterY: 19.823676843006496 },
            { name: "@スノードーム", assetFile: "31a5d4baeb73a20441b817b715948d7f.svg", rotationCenterX: 20.424810000000008, rotationCenterY: 20.42480999999998 },
            { name: "@ゴ棒", assetFile: "1b602a93de4491c44ba21a5be7a9083e.svg", rotationCenterX: 16.1745088667478, rotationCenterY: 19.08930077967767 },
            { name: "@KIPI", assetFile: "09d436dd49c2f1553089af7cefb0e6d6.svg", rotationCenterX: 15.531695815578047, rotationCenterY: 17.895393533286978 },
            { name: "+シールドキャノン", assetFile: "e6d3beea6f69101e91946a0a67d56f45.svg", rotationCenterX: 20.36434602409068, rotationCenterY: 20.911505508770148 },
            { name: "+戦車", assetFile: "3846a0384f92a862078e1e223742e30a.svg", rotationCenterX: 47.13226710174075, rotationCenterY: 21.660204459408817 },
            { name: ":ピストル", assetFile: "2754e54626791de36dd6990085451c97.svg", rotationCenterX: 25.62227999999999, rotationCenterY: 5.0248650000000055 },
            { name: ":レーザーサイト付ピストル", assetFile: "a073cac0a813fb639ed5a9ee7e601757.svg", rotationCenterX: 25.62227999999999, rotationCenterY: 5.0248499999999865 },
            { name: ":ハンドガン", assetFile: "68bb275cd37113ee675ba4e79064886a.svg", rotationCenterX: 36.22537545454543, rotationCenterY: 7.024850000000015 },
            { name: "テラァシューター見た目", assetFile: "60a8da88280a99ace5f37ebbf0447dec.svg", rotationCenterX: 20.37227999999999, rotationCenterY: 5.27485999999999 },
            { name: ":カースバレット", assetFile: "44f41bb568b0e9548bd1fb18e5cae75b.svg", rotationCenterX: 25.62227999999999, rotationCenterY: 5.024855000000002 },
            { name: ":マシンガン", assetFile: "652d2ffed65847df8980c698beb13e26.svg", rotationCenterX: 18.12227892439938, rotationCenterY: 3.0248629843864308 },
            { name: ":早打ち銃", assetFile: "ea7864dc192408f12f5069476525d4fa.svg", rotationCenterX: 25.12227999999999, rotationCenterY: 4.524855000000002 },
            { name: ":コンパクトサブマシンガン", assetFile: "ab0790f4bfa48b0dcf7523059131dd65.svg", rotationCenterX: 13.43692999999999, rotationCenterY: 2.0248599999999897 },
            { name: ":ウージー", assetFile: "74faebd572b8c64b45d6b82611ba2a7b.svg", rotationCenterX: 11.096069999999997, rotationCenterY: 3.0248599999999897 },
            { name: ":スイカSMG", assetFile: "26bf10b774ba55954a22e2881289eab0.svg", rotationCenterX: 19.243294482758586, rotationCenterY: 4.20447999999999 },
            { name: ":キューガン", assetFile: "c2d921e79922353b5e3ce27f318db5e3.svg", rotationCenterX: 20.103250000000003, rotationCenterY: 14.212608200246251 },
            { name: ":アサルトライフル", assetFile: "63fca3d3021938b702783458ca7796d8.svg", rotationCenterX: 37.12227999999999, rotationCenterY: 5.0248650000000055 },
            { name: ":ヘビーアサルトライフル", assetFile: "48c235257a78863692374dfc24b0cc18.svg", rotationCenterX: 45.37227999999999, rotationCenterY: 5.7748499999999865 },
            { name: ":CS-M", assetFile: "4d1ea6b8f54342050e8e50bdf7caa08c.svg", rotationCenterX: 47.12500000000003, rotationCenterY: 2 },
            { name: ":AK-47", assetFile: "5bfc0a3f28d4388fc163d533549cfb78.svg", rotationCenterX: 55.334489822387724, rotationCenterY: 5.054181388032845 },
            { name: ":FA-MAS", assetFile: "f89820a01102fbeaa8a0fe3c1c450d20.svg", rotationCenterX: 25.111088059962952, rotationCenterY: 9.9375 },
            { name: ":コインガン", assetFile: "1d2a05f366fd5db469b4f0f4eb8302c3.svg", rotationCenterX: 10.950423333333305, rotationCenterY: 4.55953161843442 },
            { name: ":火縄銃", assetFile: "2f001db2ef7391f9970a682cc6109255.svg", rotationCenterX: 17.11739, rotationCenterY: 7.5248499999999865 },
            { name: ":スナイパーライフル", assetFile: "d370fc0d6f6cea42212a580614c458ff.svg", rotationCenterX: 45.95561333333333, rotationCenterY: 4.5248450000000275 },
            { name: ":レーザーサイト付スナイパーライフル", assetFile: "d370fc0d6f6cea42212a580614c458ff.svg", rotationCenterX: 45.95561333333333, rotationCenterY: 4.5248450000000275 },
            { name: ":サイレンサ付スナイパーライフル", assetFile: "e1d905194ad747143ffa5022f8dc6f6e.svg", rotationCenterX: 39.733390000000014, rotationCenterY: 4.5248499999999865 },
            { name: ":銛スナイパー", assetFile: "dd3bd3e517d6a12d9924ad20aa5a73be.svg", rotationCenterX: 56.19542000000001, rotationCenterY: 7.591810924590305 },
            { name: ":ショットスナイパー", assetFile: "055be352c794a3cef1586251bf28f58e.svg", rotationCenterX: 29.872278333333355, rotationCenterY: 3.7748650000000055 },
            { name: ":US-144", assetFile: "c6b738529463d66aedfb7dc82aba337f.svg", rotationCenterX: 3.091199999999958, rotationCenterY: 9.835942499999959 },
            { name: ":BS-0001", assetFile: "73d6aafb3e24421b307d8373839c3c89.svg", rotationCenterX: 29.87227999999999, rotationCenterY: 6.785717142857152 },
            { name: "BS-0001エフェクト", assetFile: "4c9c1b5962aabadb5207e96c44813c2f.svg", rotationCenterX: 8.071428571428555, rotationCenterY: 7.285714285714306 },
            { name: ":BS-0002", assetFile: "7b8b9d4b31201d5f7722412ecdac6c13.svg", rotationCenterX: 9.21428571428575, rotationCenterY: 9.214285714285722 },
            { name: "BSガード", assetFile: "7156b95050aef176cabc3220473a885e.svg", rotationCenterX: 24.928570000000036, rotationCenterY: 24.928570000000008 },
            { name: ":ロケット", assetFile: "723ab7bafc7294727217b84b390bb3a2.svg", rotationCenterX: 50.26259726798054, rotationCenterY: 5.199003472891178 },
            { name: ":四連ロケットランチャー", assetFile: "910c89822382edd245d7faf3607548be.svg", rotationCenterX: 43.50466, rotationCenterY: 5.631930000000011 },
            { name: ":擲弾発射機", assetFile: "c6e72e7cb0951a2497b4a097a4e7b020.svg", rotationCenterX: 13.479150000000004, rotationCenterY: 12.5 },
            { name: ":ネットランチャー", assetFile: "a666498c0b1d737fe42b05ccae3124b0.svg", rotationCenterX: 10.979150000000004, rotationCenterY: 10 },
            { name: ":バレットミニガン", assetFile: "cc617503f54d46d2b57c373299fffd76.svg", rotationCenterX: 41.77198999999996, rotationCenterY: 4.750004999999987 },
            { name: "ボールバズーカ見た目", assetFile: "4dce7fc5a34a7633845512540658e191.svg", rotationCenterX: 105.74999999999994, rotationCenterY: 105.75 },
            { name: "イオンバズーカ見た目", assetFile: "cdd04450ae95472d08669c26a1adca09.svg", rotationCenterX: 105.74999999999994, rotationCenterY: 105.75 },
            { name: ":スノーボールキャノン", assetFile: "8046e66efe9f46880ea1d49849670879.svg", rotationCenterX: 9, rotationCenterY: 9 },
            { name: ":セミオートライフル", assetFile: "b6302cb63ca575beebab6b90d7b1b68b.svg", rotationCenterX: 37.62227999999999, rotationCenterY: 5.5248499999999865 },
            { name: ":コンバットライフル", assetFile: "c86fc2559aac39cbbd5ef92dd6b11f3b.svg", rotationCenterX: 21.681483562474142, rotationCenterY: 9.9375 },
            { name: ":ヘキサスコープカスタム", assetFile: "ed42f5a9113d3ec75fd8485833cc464a.svg", rotationCenterX: 15.969234973316304, rotationCenterY: 5.954780242580057 },
            { name: ":エンジンライフル", assetFile: "58eef98d250fe698495d4f40bf599344.svg", rotationCenterX: 57.39536777777778, rotationCenterY: 5.350004999999953 },
            { name: ":ショットガン", assetFile: "c2f266fca150ce92630d4402cdbb5295.svg", rotationCenterX: 24.538945591066067, rotationCenterY: 3.7748629843864308 },
            { name: ":タクティカルショットガン", assetFile: "e51f0bd5173adb53ee6e3b1baa6ad82f.svg", rotationCenterX: 28.12227892439938, rotationCenterY: 3.0248629843864308 },
            { name: ":ダブルバレルショットガン", assetFile: "71f2d986f0a95197a4c95cdcc7b5d6c1.svg", rotationCenterX: 17.30279999999999, rotationCenterY: 3.7748599999999897 },
            { name: ":手榴弾", assetFile: "9e7d6bcec3202484242ef88c384dec16.svg", rotationCenterX: 28.1666666666666, rotationCenterY: 16.989197530864203 },
            { name: ":フラッシュボム", assetFile: "32dc22f20882c4e5d2f9958d9c7f710c.svg", rotationCenterX: 26.22460000000001, rotationCenterY: 26.22459999999998 },
            { name: ":パワーボム", assetFile: "2bdb558177098f8b7147ac8b6f3cb295.svg", rotationCenterX: 26.22460000000001, rotationCenterY: 26.22460000000001 },
            { name: ":ミニ手榴弾", assetFile: "04a03b4542a9a4eaccce02893ced3fe3.svg", rotationCenterX: 12.094969163001196, rotationCenterY: 7.808188906456081 },
            { name: ":モロトフカクテル", assetFile: "85dcd894279a79a7157a22a904b255e2.svg", rotationCenterX: 16.022831717342456, rotationCenterY: 6.2178506614481535 },
            { name: ":ポテトマッシャー", assetFile: "5391719d3fdeaf2fed75ff6d1a3a4cc8.svg", rotationCenterX: 28.70973657925714, rotationCenterY: 7.445703712612811 },
            { name: ":強化型ポテトマッシャー", assetFile: "1f48b0710deff3098587ddb980538c50.svg", rotationCenterX: 28.84298000000001, rotationCenterY: 14.936398767016527 },
            { name: ":サンライトボム", assetFile: "2ccad6da3ecc1c7c2d982feaa30d761f.svg", rotationCenterX: 14.470672860275897, rotationCenterY: 14.41240120552834 },
            { name: ":トリック", assetFile: "9ed5cdd940d05547304dddba5ab5b3c7.svg", rotationCenterX: 20.778389999999973, rotationCenterY: 20.808983836873693 },
            { name: ":投擲用ナイフ", assetFile: "0a579574fda672c29793f816f530fd55.svg", rotationCenterX: 21.643357608217713, rotationCenterY: 5.297949869741217 },
            { name: "ポイズンチャクラム見た目", assetFile: "c891fe70361502477e2c505511a03b7a.svg", rotationCenterX: 17.81694999999999, rotationCenterY: 17.81694999999999 },
            { name: ":追尾ミサイル", assetFile: "e70ef7ba2b4a96a24df0a5d374b8cd83.svg", rotationCenterX: 44.398463685395114, rotationCenterY: 10.033849511889429 },
            { name: ":つらら", assetFile: "11caf4fa95f7041e01fe9e55a5a836d9.svg", rotationCenterX: 31.729240353993504, rotationCenterY: 5.693325045617939 },
            { name: ":回復スプレー", assetFile: "bd50cdcb92ec2d94daf902d45f48ae76.svg", rotationCenterX: 11.606290000000001, rotationCenterY: 8.020559999999989 },
            { name: "地雷 inv", assetFile: "402a871a4be636a5ac381f9a2cf16efc.svg", rotationCenterX: 15.478815078735352, rotationCenterY: 15.478815078735352 },
            { name: "Sマイン inv", assetFile: "47d82a853c97c65731c41dc761ddcfd9.svg", rotationCenterX: 11.328272951078247, rotationCenterY: 11.328272951078276 },
            { name: "ファイヤーマイン見た目", assetFile: "d20700667109e9db8514298cd1bd63b7.svg", rotationCenterX: 14.927969999999988, rotationCenterY: 14.927970000000045 },
            { name: "パワーマイン見た目", assetFile: "e94d38bf75f6c6bf88a059865958b9ff.svg", rotationCenterX: 14.21341000000001, rotationCenterY: 14.21341000000001 },
            { name: "スモークマイン見た目", assetFile: "71c3b7215be93950217f079379504470.svg", rotationCenterX: 11.91515950172419, rotationCenterY: 11.584459057595353 },
            { name: "レーザートラップ見た目", assetFile: "6cc648c272b775d15629618f4a4eb651.svg", rotationCenterX: 12.87059936523437, rotationCenterY: 13.099999999999994 },
            { name: ":かまくら", assetFile: "ef5b8e7bfd2097bae74d49bb246d8412.svg", rotationCenterX: 23.623740000000083, rotationCenterY: 23.62373999999997 },
            { name: ":雪玉", assetFile: "58bbfb845094734bb7961564bee44a4c.svg", rotationCenterX: 10.122396562478457, rotationCenterY: 10 },
            { name: "クレイモア inv", assetFile: "8a8f0a2476d3573484493361bad0c508.svg", rotationCenterX: 11.904560000000004, rotationCenterY: 13.17007000000001 },
            { name: "スイッチボム inv", assetFile: "b5c8d78baa889b43f4f4009f4b2e310d.svg", rotationCenterX: 12.550600000000003, rotationCenterY: 12.55060499999999 },
            { name: ":力の祭壇", assetFile: "f6707e38a412dfb9d8918fffbc9d0ae1.svg", rotationCenterX: 132.5, rotationCenterY: 132.5 },
            { name: ":灯台", assetFile: "1f52145eae456c7078b6f8edf6a9d02d.svg", rotationCenterX: 198.5, rotationCenterY: 198.5 },
            { name: ":雷の塔", assetFile: "412507e51c702fe0cbfa1888c46059ca.svg", rotationCenterX: 158.56635, rotationCenterY: 158.56635 },
            { name: ":爆破の塔", assetFile: "cc9c5b464ad0c8bc4c531dcc7e1c2ae2.svg", rotationCenterX: 132.5, rotationCenterY: 132.5 },
            { name: "Gライフクリスタル", assetFile: "cdcbfd65ea845785cc874f62f5bb393c.svg", rotationCenterX: 35.71427499999999, rotationCenterY: 35.71428499999999 },
            { name: "不活性クリスタル", assetFile: "dc05e78d1e8d695a83920262a221d4a0.svg", rotationCenterX: 14.775962987678952, rotationCenterY: 14.775962987679009 },
            { name: ":サイレンサ付ピストル", assetFile: "2754e54626791de36dd6990085451c97.svg", rotationCenterX: 25.62227999999999, rotationCenterY: 5.0248650000000055 },
            { name: ":ロケットフィスト", assetFile: "d5c0d0d33a7190d6dcca764a04896c2d.svg", rotationCenterX: 25.56396000000001, rotationCenterY: 14.802000555651063 },
            { name: ":マジックスティック", assetFile: "1b34e4ac20a1e2d4f304b3e29bfb4658.svg", rotationCenterX: 20.156499360259403, rotationCenterY: 4.994117647170441 },
            { name: ":魔法の水", assetFile: "4c9d521304b9c86050f1ef07cc50432c.svg", rotationCenterX: 17.588208553908856, rotationCenterY: 4.570549999999997 },
            { name: ":空の魔導書", assetFile: "6fa82e3bf829129c49670a210aa03a0a.svg", rotationCenterX: 21.85119499999999, rotationCenterY: 6.327045785568885 },
            { name: "大地の杖 inv", assetFile: "01eb7c7af31d37338f08723e96c88025.svg", rotationCenterX: 19.519270000000006, rotationCenterY: 19.519270000000006 },
            { name: ":水晶玉", assetFile: "b69924f1fbf4b08820ac32feede65275.svg", rotationCenterX: 10.707609999999988, rotationCenterY: 10.707609999999988 },
            { name: ":幻夢のハープ", assetFile: "dbde1e7127f2ed2e7b65f09eb4cd1879.svg", rotationCenterX: 13.02964, rotationCenterY: 16.336839999999995 },
            { name: ":自然の奇跡", assetFile: "63b41f01a02d0b0be700fb238f0def9f.svg", rotationCenterX: 23.664330000000007, rotationCenterY: 4.554931205326909 },
            { name: "ラピッドレーザーの光", assetFile: "817439faa833671f94eada4313a7981f.svg", rotationCenterX: 9.589523720178533, rotationCenterY: 9.589523720178562 },
            { name: ":ダークオーブ", assetFile: "48de3111cb70c334cdcb609cf98ea316.svg", rotationCenterX: 14.731740000000002, rotationCenterY: 14.731747499999983 },
            { name: "TM-016 B", assetFile: "8a6bcb31f00ec1a6dd3796fb3fd7dcc9.svg", rotationCenterX: 15.396420000000006, rotationCenterY: 14.89430333333334 },
            { name: "TM-016 S", assetFile: "4544405c3a82ca5855741c6de041e77d.svg", rotationCenterX: 52.21551500000001, rotationCenterY: 59.884885 },
            { name: ":JJ-100", assetFile: "c9e4465225cd52b81de5726566de1b41.svg", rotationCenterX: 159.0000000000001, rotationCenterY: 159 },
            { name: ":GBP-080", assetFile: "e4c37d68f5b353be53dc9676e9ca1181.svg", rotationCenterX: 55.74999999999997, rotationCenterY: 55.74999999999997 },
            { name: ":Sシェアパック", assetFile: "286969d2bd858489f3d66240e48643e0.svg", rotationCenterX: 10.834275952380949, rotationCenterY: 6.8820547619047545 },
            { name: ":シェアバリア", assetFile: "43ce16a7fc3746a3edeb30bc24c7ca4a.svg", rotationCenterX: 10.753600000000006, rotationCenterY: 10.753629999999987 },
            { name: ":Sシェアバリア", assetFile: "43ce16a7fc3746a3edeb30bc24c7ca4a.svg", rotationCenterX: 10.753600000000006, rotationCenterY: 10.753629999999987 },
            { name: "Cクイックガード", assetFile: "8833a2a67fb1537d813f10b546fe1212.svg", rotationCenterX: -11.562547526343792, rotationCenterY: 26.96453651543706 },
            { name: "Cラージガード", assetFile: "79001f3831785da6f10596b512b3c0cf.svg", rotationCenterX: -8.46110999999999, rotationCenterY: 28.311300865983384 },
            { name: "Sラージガード", assetFile: "3723c83609fa03c8444e181cfce5611a.svg", rotationCenterX: -8.46111000000002, rotationCenterY: 28.311300865983384 },
            { name: "Cサークルガード", assetFile: "772b98fc13f6b0043bd425cd2953945c.svg", rotationCenterX: -15.300940000000196, rotationCenterY: 28.601479985574827 },
            { name: "1Sサークルガード", assetFile: "426e4aeac9e47978552b42f98257bb33.svg", rotationCenterX: 4.357805000000013, rotationCenterY: 29.456274098990974 },
            { name: "2Sサークルガード", assetFile: "3a032691c5b3764102fcb96184052cbb.svg", rotationCenterX: 4.358482371328478, rotationCenterY: 37.07173520528329 },
            { name: "Gウォールガード", assetFile: "43729c785d836ed893a7c0747575f61c.svg", rotationCenterX: 24.972219999999993, rotationCenterY: 24.972219999999993 },
            { name: "Cレーザーガード", assetFile: "34c88c6fdd91615f5f5ea777aa9008d6.svg", rotationCenterX: -6.568186687917205, rotationCenterY: 31.48028653789754 },
            { name: "Cポイズンガード", assetFile: "a8943274344701f345a35901ca072236.svg", rotationCenterX: -6.4067346031746695, rotationCenterY: 26.25 },
            { name: "Cステルスガード", assetFile: "35a242d07bf91b3bf04eba016e8fb856.svg", rotationCenterX: -10.202675, rotationCenterY: 25.027780000000007 },
            { name: "ガード欠片見た目", assetFile: "3e0bc5b73afa63fa452f9584fefae2c5.svg", rotationCenterX: 7.458691524907863, rotationCenterY: 8.345340749161352 },
            { name: ":アキュレートスナイパー", assetFile: "37b0ba98088d7a1c1be871497f8953c6.svg", rotationCenterX: 52.19071175374091, rotationCenterY: 7.132787276186633 },
            { name: "シールドキャノン見た目", assetFile: "7455f99614f083beec6bec4f76789a62.svg", rotationCenterX: 62.61110499999998, rotationCenterY: 10.483150000000023 },
            { name: "シールドバッシュ見た目", assetFile: "4097e7a4111c9bce5b3901e848fdbf98.svg", rotationCenterX: 129.97550962035515, rotationCenterY: 42.148900000000026 },
            { name: "シールドバッシュエフェクト見た目", assetFile: "77ca7a4be915edc9543b3d811f7ccb7a.svg", rotationCenterX: 17.60811000000001, rotationCenterY: 40.900000000000006 },
            { name: "ファンネルポッド", assetFile: "85f23cd05cf0a2fd5f9fac06f3c02057.svg", rotationCenterX: 26.28268, rotationCenterY: 9.630009999999999 },
            { name: "ファンネルポッドガード", assetFile: "2ffa5d32aef89d84d35d6e4da10bf695.svg", rotationCenterX: 27.30000000000001, rotationCenterY: 27.30000000000001 },
            { name: ":シールドファンネル", assetFile: "efa1c5884aac631fc3eb9c7f414b0380.svg", rotationCenterX: 26.191331680203717, rotationCenterY: 8.721249999999998 },
            { name: ":戦車主砲", assetFile: "2110910a0a820ce06e22fc3f988c7ea1.svg", rotationCenterX: 3.750000000000057, rotationCenterY: 3.749994999999984 },
            { name: "戦車重機関銃見た目", assetFile: "12d27bde1744d99d2f8425d2d59d91db.svg", rotationCenterX: 2.4999999999999716, rotationCenterY: 2.499965000000003 },
            { name: "戦車発煙弾見た目", assetFile: "a93e3ea500f3dbc4365f1d3a6148842a.svg", rotationCenterX: 18.582759857177734, rotationCenterY: 4.850379943847656 },
            { name: "戦車火炎弾見た目", assetFile: "9a396bb564bf836293152a39012e941a.svg", rotationCenterX: 18.582759857177734, rotationCenterY: 4.850379943847656 },
            { name: ":Gobo spike", assetFile: "69a8b1b98ea2b4ce6a936b3db24f8f3c.svg", rotationCenterX: 20.25, rotationCenterY: 9.9375 },
            { name: ":飛び散りボム", assetFile: "c658c3ad754a2aa6ed7451d146bef3cf.svg", rotationCenterX: 11.541719999999998, rotationCenterY: 7.445709999999991 },
            { name: ":スパイクボール", assetFile: "353ae34b9e29c2ec54d30bdb88b3f773.svg", rotationCenterX: 18.469233941930412, rotationCenterY: 17.537019392278978 },
            { name: ":デストロイヤー", assetFile: "96c9a1e1511556e138bd584ac4014324.svg", rotationCenterX: 21.5641149999999, rotationCenterY: 19.357634999999988 },
            { name: "デストロイヤー光", assetFile: "2ede87279f2050c64e9810e7261e9720.svg", rotationCenterX: -32.82257500000003, rotationCenterY: 6.194784999999939 },
            { name: ":デストロイヤーレーザー", assetFile: "249d576f4cd457311209b09e63521b52.svg", rotationCenterX: 34.12499166666669, rotationCenterY: 4.666666666666686 },
            { name: "バリア見た目", assetFile: "eda2aabd6699c61713642e3d74f3ac89.svg", rotationCenterX: 105.9433747310805, rotationCenterY: 105.95964531342422 },
            { name: "ヒーリングゾーン本体見た目", assetFile: "31eb33728e62e40556a0fb2f5bc84fb2.svg", rotationCenterX: 132.5000000000001, rotationCenterY: 132.49999999999983 },
            { name: "ヒーリングゾーン見た目", assetFile: "80c81b87c5f89819a1bbd79ec7fe7d34.svg", rotationCenterX: 105.74999999999994, rotationCenterY: 105.74999999999994 },
            { name: "神秘のトーテム本体見た目", assetFile: "fc30f993e1a730e0d465ba010fa938e8.svg", rotationCenterX: 132.5, rotationCenterY: 132.5 },
            { name: "神秘のトーテム見た目", assetFile: "3017c1d8a58748ab180d8b3cd2a98a7e.svg", rotationCenterX: 105.75, rotationCenterY: 105.75 },
            { name: "死神の鎌見た目", assetFile: "c24971453dba6c4da2c2d1a119bcb7ed.svg", rotationCenterX: 34.90599, rotationCenterY: 8.922200000000004 },
            { name: "マキビシ見た目", assetFile: "70e8c225ec824ba74085324c64372be7.svg", rotationCenterX: 11.31586776369764, rotationCenterY: 13.055581188040577 },
            { name: "羽衣の加護見た目", assetFile: "4ae6239cdad355c4e7529bbf0180e461.svg", rotationCenterX: 104.79197613336842, rotationCenterY: 105.55799785792433 },
            { name: ":近接カウンター", assetFile: "9673bf35e36f63fc57b88ed6d927aa9e.svg", rotationCenterX: 54.94394782579772, rotationCenterY: 14.31740429326996 },
            { name: ":Pumpkin soul", assetFile: "27f4f48cb74ad1a70eb7bba9e104e128.svg", rotationCenterX: 32.979497612174754, rotationCenterY: 9.063864694041087 },
            { name: ":スノードーム", assetFile: "fb3c98c2943554a64d490be10716f2ce.svg", rotationCenterX: 133.5, rotationCenterY: 133.5 },
            { name: ":ゴ棒", assetFile: "f2f902679b762ebe6d6bdda832ca271c.svg", rotationCenterX: 31.119414213135855, rotationCenterY: 4.48965814591574 },
            { name: ":KIPI missile", assetFile: "6abea6fdbacaa2646462c83caf9105ed.svg", rotationCenterX: 48.98633878515966, rotationCenterY: 6.728812846487102 },
            { name: "迫撃砲弾見た目", assetFile: "c35b18002ce20edd7f26a7d3a86629b8.svg", rotationCenterX: 14.41666333333339, rotationCenterY: 14.41666333333336 },
            { name: "ミサイル見た目", assetFile: "3c667004daacd2600077ca3dd23c9f70.svg", rotationCenterX: 30.23966980769228, rotationCenterY: 7.334559999999982 },
            { name: "ジェム波動", assetFile: "99d6a1ea52c5c8df4a581d6c63984c5a.svg", rotationCenterX: 100.814055, rotationCenterY: 100.814055 },
            { name: "ジェム波動2", assetFile: "7e3f2d431a6cd5206a7845e389ae0692.svg", rotationCenterX: 122.13666499999998, rotationCenterY: 122.13666646071323 },
            { name: ":Money", assetFile: "4cfbb4aeb5f1440544113df979f88ea1.svg", rotationCenterX: 15.277780000000007, rotationCenterY: 15.277777777777771 },
            { name: ":Money star", assetFile: "64703942dcd1f81fc3d964ee5b817140.svg", rotationCenterX: 15.277780000000007, rotationCenterY: 15.277777777777771 },
            { name: ":Tektite", assetFile: "86878290d05de74315c73ff252c31f92.svg", rotationCenterX: 20.25, rotationCenterY: 16.333333333333343 },
            { name: ":Present", assetFile: "d684417e53b314dc4e7d78c7a45ae637.svg", rotationCenterX: 15.277780000000007, rotationCenterY: 15.277780000000007 },
            { name: "サンタ見た目", assetFile: "deade38bf33c1e4512b74daf43340de2.svg", rotationCenterX: 5.488024999999993, rotationCenterY: 11.630518022471279 },
            { name: "爆発見た目", assetFile: "d26ebd8a16aa7e47d3f144389e28f359.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "煙見た目", assetFile: "d62ff88809fde3db901b27382d0251e2.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "スモーク見た目", assetFile: "e41a2ae0971ed8ec1c257659995f14ad.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "フラッシュ爆発見た目", assetFile: "56c4da49d3374b82b6c0470e8ba9e57c.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "粉雪爆発見た目", assetFile: "e92d880bf3a377d09704041b7d5cb7c1.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "火炎爆発見た目", assetFile: "c367e239f77f859b966e37058ed5cb35.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "ダーク爆発見た目", assetFile: "0afd3bef81ef4026569aef9df3af0ed3.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "護身見た目", assetFile: "43c4c01ba3b1f8efa4a65e10b0230973.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "攻撃見た目", assetFile: "26d3e0d53dc4223de9ed3009ffcbb3c4.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "速度見た目", assetFile: "2f04ca33b177272cad2f68c59789ec9f.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "シールドエフェクト見た目", assetFile: "a154f7a8ab8839444067ad92331cff86.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "視野エフェクト見た目", assetFile: "cd0e48f7564ae61eb50f855bc92628df.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "回復エフェクト見た目", assetFile: "291c60edc10d1e621622ae71cc776587.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "自然回復短縮エフェクト見た目", assetFile: "b031fa70583f843ac43f1dfeebb06a4e.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "スパークリングドリンクエフェクト見た目", assetFile: "62780d0f72b9b8dffe4831229276f44b.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "エネルギーエフェクト見た目", assetFile: "6a0f81d6719b9ccf5e8e0c77d3d20f16.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "毒ガス見た目", assetFile: "f650c2b90034e38e37c5ab13e33cd4e3.svg", rotationCenterX: 106, rotationCenterY: 106 },
            { name: "弱バリア見た目", assetFile: "c739fa2740e15538eaedf1f92d497778.svg", rotationCenterX: 101, rotationCenterY: 101 },
            { name: "鉄球見た目", assetFile: "c96b5e6388cf7e595614229d387092ad.svg", rotationCenterX: 106.00000000000003, rotationCenterY: 106.00000000000003 },
            { name: "ネット見た目", assetFile: "472342955c54e8e9da849ebd7ffa6f60.svg", rotationCenterX: 105.7868, rotationCenterY: 105.7868 },
            { name: ":エネルギーボール", assetFile: "0a576b72be272a182048c1d66c3f6f03.svg", rotationCenterX: 14.115345183616398, rotationCenterY: 14.115340000000003 },
            { name: "自キル", assetFile: "446ecac9d4f4138d2e030919c267554e.svg", rotationCenterX: 23.25, rotationCenterY: 23.25 },
            { name: "チームキル", assetFile: "7592c484d829180fabd2b25d52cfb96a.svg", rotationCenterX: 23.25, rotationCenterY: 23.25 },
            { name: "他キル", assetFile: "8c85d0d46b06f8b9e47808c9c99b65c7.svg", rotationCenterX: 23.25, rotationCenterY: 23.25 },
            { name: "スキル発動", assetFile: "77883af21a214d9ededf1b96e52b8d0b.svg", rotationCenterX: 36.30348587036133, rotationCenterY: 36.30348587036133 },
            { name: "重心付正三角形", assetFile: "cb4185f88a582beed43ac8960aa0f9ce.svg", rotationCenterX: 17.80769076923073, rotationCenterY: 20.401708076923114 },
            { name: "帰還用ヘリコプター胴体", assetFile: "863361bb58a7ef637cf761b53d41adea.svg", rotationCenterX: 95.05491794554283, rotationCenterY: 25.526355000000024 },
            { name: "帰還用ヘリコプター羽", assetFile: "9990a5da5a1f93c79e40e72c9b9624e1.svg", rotationCenterX: 62.01799228333155, rotationCenterY: 60.46927499999998 },
            { name: "Report bell", assetFile: "0c19370d93b45d359b093dcc70b097ff.svg", rotationCenterX: 14.5, rotationCenterY: 17.16666666666663 },
            { name: "Kill effect", assetFile: "96f394a35e61cb9a8078f4f8c4936b02.svg", rotationCenterX: 70.92554191489364, rotationCenterY: 15.844017094017119 },
            { name: "狙撃センサー", assetFile: "4494d602078fe5ac579e43b12e891f30.svg", rotationCenterX: 55.75, rotationCenterY: 168.25 },
            { name: "スキルゲージアイコン", assetFile: "bdceb83c2dc35ad8b77d8ac07c7d329f.svg", rotationCenterX: 5.604173425748996, rotationCenterY: 8.908004637087515 },
            { name: ":魔剣", assetFile: "19d3250ac7fe5984a69b8bac9de92094.svg", rotationCenterX: 11.585203953414151, rotationCenterY: 4.025565700697086 },
        ];
        this.loadCostumeImages();
        this.sounds = [
            { name: "コイン", assetFile: "05eb8cce38b1e1449ade186a8e10c489.wav" },
            { name: "テクタイト", assetFile: "a9cc64d36bbf56f761c68197351d68e4.wav" },
            { name: "やられる", assetFile: "bcd300c69fdc64936c3c55eb90bca3c0.wav" },
            { name: "復活", assetFile: "365672256c97fa7a24e9d154f101cbd7.wav" },
            { name: "爆発", assetFile: "5f1f5f84028e548a1339c8981b52af71.wav" },
            { name: "食らう", assetFile: "93d6d2b73d6779247a2eb6a5011deb8a.wav" },
            { name: "シールド", assetFile: "2ac5bac411c5e9188ea18a37bc2cffca.wav" },
            { name: "投げる", assetFile: "5609fa84640109e06fdc5b050c70f3a5.wav" },
            { name: "ワープ", assetFile: "ca59bd66b9a2dd04c17bd3658227b194.wav" },
            { name: "サブ回復", assetFile: "f177de53591bce5e0f43d3c66eb3b2c9.wav" },
            { name: "倒す", assetFile: "39f57240772a731b293252916f63c4b2.wav" },
            { name: "ピストル", assetFile: "bad0ef826c14929e1084ab008f6229c3.wav" },
            { name: "アサルトライフル", assetFile: "9f13dfa15b0fc5a6c6410c214990582b.wav" },
            { name: "マシンガン", assetFile: "f0a1b20fad9204165b455943d5b89faf.wav" },
            { name: "スナイパーライフル", assetFile: "bba407b372a14c44d7ebe37e7a5c1bd2.wav" },
            { name: "デストロイヤー", assetFile: "412d4e0a2723c4dd3e3eb357399a2ef7.wav" },
            { name: "ロケットランチャー", assetFile: "153ccc1af27fa4da8656c5c20a93918c.wav" },
            { name: "シールドキャノン", assetFile: "1474735ec8b358c73bb6e4f7051fe267.wav" },
            { name: "シールドバッシュ", assetFile: "1fe2cffbf65abf5118aa176bd6ddaa78.wav" },
            { name: "シールドファンネル", assetFile: "abe24476b09d2584a2a82cc94fcc222d.wav" },
            { name: "ショットガン", assetFile: "236044ee90552efb2a433439dc22962f.wav" },
            { name: "ロックオン", assetFile: "d9a269b9ba0a83817ee0d027b1c83948.wav" },
            { name: "火炎放射器", assetFile: "d644002a1f5dd760194768a56b5d4c99.wav" },
            { name: "バフ", assetFile: "cd16a3c1d3f80a53e4251b72d8fb515a.wav" },
            { name: "投てき", assetFile: "718004b99351c21e4e0be6419f840213.wav" },
            { name: "銛スナイパー", assetFile: "56810bf7311970a9a4db92255766f0be.wav" },
            { name: "早打ち銃", assetFile: "ee71e135efe1ac2e3d7978962b0e031f.wav" },
            { name: "迫撃砲", assetFile: "e8c28ed5ac4a2e7c4a12bef8fffcfded.wav" },
            { name: "購入", assetFile: "d3d5c269f9e37590ac35c76640452f6d.wav" },
            { name: "回復", assetFile: "88c767230588cfacd395d32a7f633994.wav" },
            { name: "レーザー", assetFile: "3b97278872059e454b9f687952800376.wav" },
            { name: "ミサイル", assetFile: "8d2b27abe3dd60e5d71132e4ecbbbf20.wav" },
            { name: "ショットスナイパー", assetFile: "b69c68168a5f814245ee3ee1a33d4c52.wav" },
            { name: "ページ移動", assetFile: "3a89da68f158134b2d8d9672d6345026.wav" },
            { name: "コンバットライフル", assetFile: "626e36a481e1327f8580b6f071b36273.wav" },
            { name: "セレクト", assetFile: "34573c1f70d1d62826c1eefde526d9fd.wav" },
            { name: "CS-M", assetFile: "eb4db5875acaaeb78c7e215946c2b2c6.wav" },
            { name: "狙撃センサー", assetFile: "d0ab963ea363c6a032bab102bc9cdd76.wav" },
            { name: "重ヒット音", assetFile: "d62555f0390e0fd6615da150e06d21bc.wav" },
            { name: "軽ヒット音", assetFile: "576e79476fa71386cccbb6752c87d2f7.wav" },
            { name: "コンパクトサブマシンガン", assetFile: "2abae92132ef2986f086bfb99ea21f95.wav" },
            { name: "ヘキサスコープカスタム", assetFile: "ed866d1febee62d2e028c9795de28c40.wav" },
            { name: "FA-MAS", assetFile: "c59fa9a47122c614e543feb218057f02.wav" },
            { name: "ヘビーアサルトライフル", assetFile: "223ceb3cf4d1e40e496f49188486c9fa.wav" },
            { name: "セミオートライフル", assetFile: "8726d44564eb66422b1bb9a9f1a7e117.wav" },
            { name: "ハンドガン", assetFile: "08baacf74b9ddff0c48ced52f83644f4.wav" },
            { name: "バレットミニガン", assetFile: "5567c65bf0a46a3df9e220ab900f55cb.wav" },
            { name: "ヘリコプター", assetFile: "28ea5ee8bd2da53ecbdf46998c4af6d1.wav" },
            { name: "エンジンライフル", assetFile: "aad89f99ace81df994a9ed7cf43f7d68.wav" },
            { name: "ウージー", assetFile: "b98cb60c956747a07bd44cfca09f8f0c.wav" },
            { name: "ゼンマイ式ライフル", assetFile: "d960b00a73ee944e8a9d1241576a365f.wav" },
            { name: "タクティカルショットガン", assetFile: "b4f8b4bbd23a3adaf5c4df635ab6f57d.wav" },
            { name: "幻夢のハープ", assetFile: "aab3528f5a495860a918243e12a32e29.wav" },
            { name: "空の魔導書", assetFile: "1028e04757a63b39cdc689dbd7a9eaa8.wav" },
            { name: "マジックスティック", assetFile: "04243f6c5396942711044c6c9e93c2a1.wav" },
            { name: "火縄銃", assetFile: "27d668c7b8f5c31490358f7d542b10d4.wav" },
            { name: "スキル満タン", assetFile: "14a56b8ca2eb346d855817e5c1668bac.wav" },
            { name: "スキル使用", assetFile: "dc2c19587331ae8077fe126c3dea81da.wav" },
            { name: "ヒールウェーブ", assetFile: "9365856f46bdb9fc0e06d9e27fa65b11.wav" },
            { name: "回復ヒット音", assetFile: "c1a66603b7751884a0220e1cfec89054.wav" },
            { name: "破壊レーザー", assetFile: "6e52fc545d00f75c730416206d21f63a.wav" },
            { name: "液晶パネル", assetFile: "6fcd835bc0a7b83947a54e7ce3392b04.wav" },
            { name: "大地の杖", assetFile: "cea38b13d5c53fd7ccafec39328ea086.wav" },
            { name: "魔法の水", assetFile: "f0974f8f2a6c2b333c0723284908be72.wav" },
            { name: "自然の奇跡", assetFile: "7b7d143ebbc50b61bc9f665015e15b1c.wav" },
            { name: "水晶玉", assetFile: "a5fe69f1e240ec6da8c72b5de166e97b.wav" },
            { name: "バリア", assetFile: "917b71c31a6bc25dbb41008e49b88571.wav" },
            { name: "戦車主砲", assetFile: "52f4bbe5d49028a5f03f8fc4d86a123e.wav" },
            { name: "戦車重機関銃", assetFile: "32fe8730c1c0ffc944ff133c6c12fa92.wav" },
            { name: "戦車発火弾", assetFile: "7dc94a30f68abe266b14734fd0e7775a.wav" },
            { name: "走行", assetFile: "d31727a2238a60d2fb11f7e12ed14975.wav" },
            { name: "テラァシューター", assetFile: "22df2f63f7d7df7178fcf9630707e923.wav" },
            { name: "擲弾発射機", assetFile: "b7ca3eecbefeb7be36140f9598099443.wav" },
            { name: "斬撃", assetFile: "dbf738d98d4ee8f693803f18c8e84f59.wav" },
            { name: "設置", assetFile: "3d78eb44b3c268cbff9b55dd7223d3a7.wav" },
            { name: "シャドウスナイパー", assetFile: "a317811765ecb167af776c8dc7dff2ff.wav" },
            { name: "Pop", assetFile: "da819c36ddeee5a2a3adc081323c0711.wav" },
            { name: "迫撃砲ロックオン", assetFile: "afa5096b7ff0fdfd493c56f5ac46aed5.wav" },
            { name: "インベントリ切り替え", assetFile: "dd9e476450d39ece7af0777414c13cd7.wav" },
            { name: "US-144", assetFile: "02472eee570e17c7046459c5044e16f8.wav" },
            { name: "TM-016", assetFile: "f6f3fed0c3181defd748f43d65b6d92a.wav" },
            { name: "JJ-100", assetFile: "37919820ac92dd52bac6ad6ff7c33705.wav" },
            { name: "BS-000", assetFile: "54360bcf4722d7dd3b653c2a5e33c9bc.wav" },
            { name: "BSガード", assetFile: "32144ea85f1a6ee29347df42484ba0c8.wav" },
            { name: "スイカSMG", assetFile: "86bef2f7bda304080e9c1c157dac661f.wav" },
            { name: "炎の魔導書", assetFile: "7eda676e4b1a34062b2bb542cfa28a3a.wav" },
            { name: "ラピッドレーザー", assetFile: "7556b7b170b10b173b892c676ac5286b.wav" },
            { name: "ラピッドレーザー発射", assetFile: "ed16bdd15ee97e82fc62616458f7f2d4.wav" },
            { name: "エネルギー", assetFile: "f95bf1e0b72bcca5c5370af234971795.wav" },
            { name: "スノーボールキャノン", assetFile: "e7cd4d6f5e6ece401924c2b8a30c6d63.wav" },
            { name: "イオンバズーカ", assetFile: "c1cd499ada76eff981e3bb7fd3459d98.wav" },
            { name: "インゴット", assetFile: "e63f37908abaadafc710aed08a1628ca.wav" },
            { name: "ダークオーブ", assetFile: "9e5f75eb46fb6b72ea80083a44daa9a1.wav" },
            { name: "ブースト", assetFile: "2fb648a0cd07fbef0a8819d8e3bae0d9.wav" },
            { name: "ガード（小）", assetFile: "cd6f94b5c040697264437c0cf14a5ca1.wav" },
            { name: "ガード（大）", assetFile: "84198587e2331e0ea1750ddf4222d877.wav" },
            { name: "ガード破壊", assetFile: "2286f0f888553203c11ba378d93ea1c2.wav" },
            { name: "反撃レーザー", assetFile: "8bbb466f057660b1ccabcf899c44837b.wav" },
            { name: "クイックガード", assetFile: "43f0dae60d228bd617afba708b3d91d4.wav" },
            { name: "ラージガード", assetFile: "18811d4486e881acfa1e5c6f1708b989.wav" },
            { name: "サークルガード", assetFile: "8fc6c00aed66e80b2e0fb35d068ed563.wav" },
            { name: "レーザーガード", assetFile: "aaa2b53c3261adf1a3196add632f7498.wav" },
            { name: "ポイズンガード", assetFile: "cfe01ad48ebee14c42f3bb7b308a57b5.wav" },
            { name: "ウォールガード", assetFile: "13f2064ee66d11c4996ba18b8f6f5784.wav" },
            { name: "噴霧", assetFile: "cc0770d22f806814ab693575b5aada92.wav" },
            { name: "ボールバズーカ", assetFile: "0f61f6d7ea15d6015aa701f39af3ef20.wav" },
            { name: "レーザーキャノン", assetFile: "fb4b91e7ba6435b4e166667d2b6b6e6c.wav" },
            { name: "AK-47", assetFile: "8f65fa165dfb959205d4338a1f93ed5a.wav" },
            { name: "BP-080", assetFile: "2e57d35004d86e87e58e83455725524b.wav" },
            { name: "BPレーザー", assetFile: "8aae8264a8440ecbbd4ef7fe65a20874.wav" },
            { name: "アキュレートスナイパー", assetFile: "4912ab1042e85d17dd595528f841d473.wav" },
            { name: "チャージ完了", assetFile: "a6e6fc72f8ae8041291a30933682b661.wav" },
            { name: "チャージ中", assetFile: "37613abfa9192f6928021ff88984b2c1.wav" },
            { name: "起動", assetFile: "2ade7b42da7b72543a5c2d62782ddd13.wav" },
            { name: "招待", assetFile: "0bf59908f1bb1b945feca0669f19dbb1.wav" },
            { name: "クイックチャット", assetFile: "d25a124ca8be7240b5133da60ce8962b.wav" },
            { name: "ジェム破壊", assetFile: "14cc3a7be802dbb31d68119522114ce1.wav" },
        ];
        this.x = 0;
        this.y = 25;
        this.direction = 90;
        this.size = 0;
        this.visible = false;
    }
    varByName(name) {
        switch (name) {
            case "a": return this.a;
            case "c": return this.c;
            case "b": return this.b;
            case "Temp1": return this.Temp1;
            case "Mouse touch": return this.Mouse_touch;
            case "Clicking": return this.Clicking;
            case "IDX": return this.IDX;
            case "IDY": return this.IDY;
            case "Mouse wheel": return this.Mouse_wheel;
            case "FPS counter": return this.FPS_counter;
            case "Hold click": return this.Hold_click;
            case "d": return this.d;
            case "First number": return this.First_number;
            case "First distance": return this.First_distance;
            case "First type": return this.First_type;
            case "Bomb damage": return this.Bomb_damage;
            case "Bullet damage": return this.Bullet_damage;
            case "e": return this.e;
            case "f": return this.f;
            case "DPS counter": return this.DPS_counter;
            case "Hit ID": return this.Hit_ID;
            case "IF()": return this.IF;
            case "IF T/F": return this.IF_T_F;
            case "IF ACT": return this.IF_ACT;
            case "Attack power": return this.Attack_power;
            case "g": return this.g;
            case "Kill point": return this.Kill_point;
            case "#Touch": return this.Touch;
            case "Hit?": return this.Hit;
            case "a": return this.a_2;
            case "c": return this.c_2;
            case "d": return this.d_2;
            case "b": return this.b_2;
            case "e": return this.e_2;
            case "Temp2": return this.Temp2;
            case "F key": return this.F_key;
            case "Temp3": return this.Temp3;
            case "h": return this.h;
            case "@Bullet team ID": return this.Bullet_team_ID;
            case "i": return this.i;
            case "j": return this.j;
            case "k": return this.k;
            case "Drag x": return this.Drag_x;
            case "Drag y": return this.Drag_y;
            case "Drag touch": return this.Drag_touch;
            case "Match damage": return this.Match_damage;
            case "Dummy X": return this.Dummy_X;
            case "Dummy Y": return this.Dummy_Y;
            case "Chat": return this.Chat;
            case "Frame cutter": return this.Frame_cutter;
            case "Turreting?": return this.Turreting;
            case "Temp4": return this.Temp4;
            case "Bullet wall?": return this.Bullet_wall;
            case "Temp5": return this.Temp5;
            case "OtherCP": return this.OtherCP;
            case "Mud?": return this.Mud;
            case "timer temp": return this.timer_temp;
            default: return 0;
        }
    }
    registerHats() {
        this.rt.registerHat(this, "flag", () => this.script1());
        this.rt.registerHat(this, "flag", () => this.script2());
        this.rt.registerHat(this, "key:up arrow", () => this.script4());
        this.rt.registerHat(this, "key:down arrow", () => this.script5());
        this.rt.registerHat(this, "flag", () => this.script6());
        this.rt.registerHat(this, "flag", () => this.script7());
        this.rt.registerHat(this, "flag", () => this.script8());
        this.rt.registerHat(this, "flag", () => this.script9());
        this.rt.registerHat(this, "flag", () => this.script10());
        this.rt.registerHat(this, "flag", () => this.script11());
        this.rt.registerHat(this, "flag", () => this.script12());
        this.rt.registerHat(this, "flag", () => this.script13());
        this.rt.registerHat(this, "flag", () => this.script14());
        this.rt.registerHat(this, "flag", () => this.script15());
        this.rt.registerHat(this, "flag", () => this.script16());
    }
    // hat: event_whenflagclicked (flag)
    *script1() {
        // クリック検出: マウスを押した瞬間に Clicking = "1" にし、離すまで維持する。
        this.Clicking = "0";
        while (true) {
            if (B(this.rt.mouse.down)) {
                this.Clicking = "1";
                yield { waitUntil: () => B((!B(this.rt.mouse.down))) };
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script2() {
        // 起動 + メインループ。Set val のあと、クラウドへ接続して空き ID が確定するまで
        // Cloud("0") を回す（変化が無ければ ID タイマーを進め、30 超で確定）。ID_check を通し、
        // 作者（uk-400 / kz-104）は "u" キーでテストプレイ解禁（Character_tree 全解放、Money 500、Tektite 50）。
        // コスチュームと定義リスト（Bullet_list / Item_list）の全走査は初回ロードの重さの主因。
        // "Hide title" を送ってから All(UI_closed) を回し続ける。
        this.rt.penLayer.clear();
        yield* this.Set_val();
        if (B(false)) {
        }
        if (B(equals(this.Temp2, "0"))) {
            G.ID = "0";
            this.Temp1 = "0";
            while (!B((compare("30", G.ID) < 0))) {
                yield* this.Cloud("0");
                if (B(equals(G.Active_players, this.Temp1))) {
                    G.ID = N(G.ID) + N(G.FPS_temp);
                }
                else {
                    this.Temp1 = G.Active_players;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            yield* this.ID_check("1");
            G.Team_ID = G.ID;
            this.Temp2 = "1";
        }
        G.CLOUD.deleteAll();
        if (B((B((B(equals(this.rt.username, "uk-400")) || B(equals(this.rt.username, "kz-104")))) && B(this.rt.keyIsPressed(S("u")))))) {
            yield* this.rt.askGen(S("テストプレイモードにしました。"));
            this.a = "6";
            const treeRecs = Math.max(0, Math.floor(N((N(G.Character_tree.length) / N(10)))));
            for (let r = 0; r < treeRecs; r++) {
                G.Character_tree.replace(this.a, G.Character_tree.item((N(this.a) - N(1))));
                this.a = N(this.a) + N(10);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Money = "500";
            G.Tektite = "50";
        }
        this.switchCostume("Font b");
        while (!B(equals(this.costumeNumberName("name"), "Font a"))) {
            this.nextCostume();
            if (!this.rt.warpActive)
                yield;
        }
        this.a = "0";
        const bulletDefs = Math.max(0, Math.floor(N(G.Bullet_list.length)));
        for (let r = 0; r < bulletDefs; r++) {
            this.a = N(this.a) + N(1);
            this.b = G.Bullet_list.item(this.a);
            if (!this.rt.warpActive)
                yield;
        }
        this.a = "0";
        const itemDefs = Math.max(0, Math.floor(N(G.Item_list.length)));
        for (let r = 0; r < itemDefs; r++) {
            this.a = N(this.a) + N(1);
            this.b = G.Item_list.item(this.a);
            if (!this.rt.warpActive)
                yield;
        }
        this.rt.broadcast(S("Hide title"));
        while (true) {
            yield* this.All((B((compare("400", G.X) < 0)) || B((B((compare(G.X, "400") < 0)) && B((!B((B((B((B(equals(Math.round(N(G.Menu.item(2))), "160")) || B(equals(Math.round(N(G.Menu.item(86))), "160")))) && B(equals(G.Lag_cutter, "1")))) || B(equals(Math.round(N(G.Menu.item(20))), "160"))))))))));
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: data_setvariableto
    *script3() {
        // 空のハット（変数セットの残骸）。何もしない。
    }
    // hat: event_whenkeypressed (key:up arrow)
    *script4() {
        // ↑キーで Mouse_wheel = "1"（キーを離すまで再発しない）。
        if (B((!B(this.rt.keyIsPressed(S("up arrow")))))) {
            this.Mouse_wheel = "1";
        }
        yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("up arrow"))))) };
    }
    // hat: event_whenkeypressed (key:down arrow)
    *script5() {
        // ↓キーで Mouse_wheel = "-1"（キーを離すまで再発しない）。
        if (B((!B(this.rt.keyIsPressed(S("down arrow")))))) {
            this.Mouse_wheel = "-1";
        }
        yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("down arrow"))))) };
    }
    // hat: event_whenflagclicked (flag)
    *script6() {
        // FPS 計測。最初の 3 回（各 1 秒超）で FPS を決めて Lag_cutter を設定し、
        // その後は 1 秒ごとに FPS を更新して "1 second" を broadcast する。
        G.FPS = "30";
        for (let i = 0; i < 3; i++) {
            yield { waitUntil: () => B((compare("1", this.rt.timer()) < 0)) };
            this.rt.resetTimer();
            if (B((compare(this.FPS_counter, "15") < 0))) {
                G.FPS = "15";
            }
            else {
                if (B((compare("60", this.FPS_counter) < 0))) {
                    G.FPS = "60";
                }
                else {
                    G.FPS = this.FPS_counter;
                }
            }
            this.FPS_counter = "0";
            if (!this.rt.warpActive)
                yield;
        }
        if (B((compare(G.FPS, "28") < 0))) {
            G.Lag_cutter = "1";
        }
        else {
            G.Lag_cutter = "0";
        }
        this.timer_temp = "0";
        this.rt.resetTimer();
        while (true) {
            yield { waitUntil: () => B((compare((N(this.timer_temp) + N(1)), this.rt.timer()) < 0)) };
            this.timer_temp = this.rt.timer();
            G.FPS = this.FPS_counter;
            if (B((compare(this.FPS_counter, "15") < 0))) {
                G.FPS = "15";
            }
            else {
                G.FPS = this.FPS_counter;
            }
            this.FPS_counter = "0";
            this.rt.broadcast(S("1 second"));
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script7() {
        this.FPS_counter = "0";
        // FPS_counter を毎フレーム増やす（script6 が読む）。
        while (true) {
            this.FPS_counter = N(this.FPS_counter) + N(1);
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script8() {
        while (true) {
            // DPS_counter を 3 秒窓で DPS へ換算する。
            G.DPS = Math.round(N((N(this.DPS_counter) / N(3))));
            this.DPS_counter = "0";
            yield { waitSeconds: N(3) };
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script9() {
        G.Scoping = "0";
        // スペース（またはモバイルボタン）でスコープ切替。切替時に Sound("30") と Menu[21] = "100"。
        while (true) {
            if (B((B(this.rt.keyIsPressed(S("space"))) || B(equals(G.Mobile_2.item(10), "1"))))) {
                G.Menu.replace(21, "100");
                yield* this.Sound("30");
                if (B(equals(G.Scoping, "0"))) {
                    G.Scoping = "1";
                }
                else {
                    G.Scoping = "0";
                }
                G.Mobile_2.replace(10, "0");
                yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("space"))))) };
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script10() {
        G.Lag_cutter = "0";
        // P キー（またはモバイルボタン）で Lag_cutter 切替。
        while (true) {
            if (B((B(this.rt.keyIsPressed(S("p"))) || B(equals(G.Mobile_2.item(16), "1"))))) {
                if (B(equals(G.Lag_cutter, "0"))) {
                    G.Lag_cutter = "1";
                }
                else {
                    G.Lag_cutter = "0";
                }
                G.Mobile_2.replace(16, "0");
                yield { waitUntil: () => B((!B(this.rt.keyIsPressed(S("p"))))) };
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script11() {
        this.F_key = "0";
        // F / 0 キー（またはモバイルボタン）で F_key を立てる（Draw skill gage が消費する）。
        while (true) {
            if (B((B((B(this.rt.keyIsPressed(S("f"))) || B(this.rt.keyIsPressed(S("0"))))) || B(equals(G.Mobile_2.item(11), "1"))))) {
                this.F_key = "1";
                G.Mobile_2.replace(11, "0");
                yield { waitUntil: () => B((!B((B(this.rt.keyIsPressed(S("f"))) || B(this.rt.keyIsPressed(S("0"))))))) };
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script12() {
        G.Object_trigger = "0000000";
        // Object_trigger は 3 秒で自動的に "0000000" へ戻る。
        while (true) {
            if (B((!B(equals(G.Object_trigger, "0000000"))))) {
                yield { waitSeconds: N(3) };
                G.Object_trigger = "0000000";
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script13() {
        G.Dummy_damage = "0";
        // Dummy_damage の変化に追随して Reset_dummy_damage を回し続ける。
        while (true) {
            yield* this.Reset_dummy_damage(G.Dummy_damage);
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script14() {
        this.Quick_chat.deleteAll();
        // クイックチャット。T（またはモバイルボタン）で Menu[61] を開閉し、送信したチャットは
        // 1.5 秒表示する。Z/X/C/V は 4 つの登録スロット（開いている間に押すと上書き登録、
        // 閉じているときに押すと呼び出し）。Menu[72] が立つ間はチャットを閉じてカウントダウン。
        this.Quick_chat.add("13");
        this.Quick_chat.add("14");
        this.Quick_chat.add("04");
        this.Quick_chat.add("15");
        while (true) {
            if (B((B(this.rt.keyIsPressed(S("t"))) || B(equals(G.Mobile_2.item(14), "1"))))) {
                if (B(equals(G.Menu.item(61), "0"))) {
                    G.Menu.replace(61, "1");
                    G.Menu.replace(63, "-");
                }
                else {
                    G.Menu.replace(61, "0");
                }
                G.Mobile_2.replace(14, "0");
                yield { waitUntil: () => B((B((!B(this.rt.keyIsPressed(S("t"))))) || B((!B(equals(this.Chat, "00")))))) };
            }
            if (B((compare("0", G.Menu.item(72)) < 0))) {
                G.Menu.replace(61, "0");
                while (!B((compare(G.Menu.item(72), "0") < 0))) {
                    yield* this.CSM_menu("72", "-1", "C", "0");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            if (B((!B(equals(this.Chat, "00"))))) {
                const chatFrames = Math.max(0, Math.floor(N((N(45) / N(G.FPS_temp)))));
                for (let r = 0; r < chatFrames; r++) {
                    if (B((!B(this.Quick_chat.contains(this.Chat))))) {
                        if (B((B(this.rt.keyIsPressed(S("z"))) || B(equals(G.Mobile_2.item(17), "1"))))) {
                            this.rt.soundPlay("d25a124ca8be7240b5133da60ce8962b.wav");
                            this.Quick_chat.replace(1, this.Chat);
                        }
                        if (B((B(this.rt.keyIsPressed(S("x"))) || B(equals(G.Mobile_2.item(18), "1"))))) {
                            this.rt.soundPlay("d25a124ca8be7240b5133da60ce8962b.wav");
                            this.Quick_chat.replace(2, this.Chat);
                        }
                        if (B((B(this.rt.keyIsPressed(S("c"))) || B(equals(G.Mobile_2.item(19), "1"))))) {
                            this.rt.soundPlay("d25a124ca8be7240b5133da60ce8962b.wav");
                            this.Quick_chat.replace(3, this.Chat);
                        }
                        if (B((B(this.rt.keyIsPressed(S("v"))) || B(equals(G.Mobile_2.item(20), "1"))))) {
                            this.rt.soundPlay("d25a124ca8be7240b5133da60ce8962b.wav");
                            this.Quick_chat.replace(4, this.Chat);
                        }
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                yield { waitSeconds: N(1.5) };
                this.Chat = "00";
            }
            if (B((B(this.rt.keyIsPressed(S("z"))) || B(equals(G.Mobile_2.item(17), "1"))))) {
                this.Chat = this.Quick_chat.item(1);
            }
            if (B((B(this.rt.keyIsPressed(S("x"))) || B(equals(G.Mobile_2.item(18), "1"))))) {
                this.Chat = this.Quick_chat.item(2);
            }
            if (B((B(this.rt.keyIsPressed(S("c"))) || B(equals(G.Mobile_2.item(19), "1"))))) {
                this.Chat = this.Quick_chat.item(3);
            }
            if (B((B(this.rt.keyIsPressed(S("v"))) || B(equals(G.Mobile_2.item(20), "1"))))) {
                this.Chat = this.Quick_chat.item(4);
            }
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script15() {
        while (true) {
            // Sniping player の自動リセット（Reset_val を回し続ける）。
            yield* this.Reset_val("Sniping player", "1", G.Menu.item(90));
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: event_whenflagclicked (flag)
    *script16() {
        while (true) {
            // Team 所属の自動リセット（Reset_val を回し続ける）。
            yield* this.Reset_val("Team", "2", (N(G.Team.contains((S("1") + S(G.Team_ID)))) - N(0)));
            if (!this.rt.warpActive || this.rt.warpBudgetExceeded())
                yield;
        }
    }
    // hat: control_if
    *script17() {
    }
    // 空のハット（if の残骸）。何もしない。
    // procedure: "Draw text %s %s %s %s"
    *Draw_text(text, size, position, X) {
        // フォントコスチュームを1文字ずつスタンプして文字列を描く。
        // position "R"/"C" のときは先に計測パスで幅を測ってから本描画する（2パス）。
        // "`" は改行、空白は詰めるだけ。カウンタ Font_size___Draw[88] は
        // 呼び出し後も文字数を持ったまま残る（次の呼び出しの先頭で 0 に戻る）。
        this.rotationStyle = "don't rotate";
        if (B((B(equals(position, "R")) || B(equals(position, "C"))))) {
            this.setX(-220);
            this.Font_size___Draw.replace(88, "0");
            const textLen = Math.max(0, Math.floor(N(S(text).length)));
            for (let r = 0; r < textLen; r++) {
                this.Font_size___Draw.replace(88, (N(this.Font_size___Draw.item(88)) + N(1)));
                if (B(equals(letterOf(text, this.Font_size___Draw.item(88)), "`"))) {
                    yield* this.Pen_mode();
                    this.setX(X);
                    this.changeYBy((N(size) * N(-0.28)));
                }
                else {
                    if (B(equals(letterOf(text, this.Font_size___Draw.item(88)), " "))) {
                        yield* this.Pen_mode();
                        this.changeXBy((N(size) * N(0.08)));
                    }
                    else {
                        this.switchCostume((S("Font ") + S(letterOf(text, this.Font_size___Draw.item(88)))));
                        this.Font_size___Draw.replace(89, this.costumeNumberName("number"));
                        yield* this.Pen_mode();
                        this.changeXBy((N((N(size) / N(100))) * N(this.Font_size___Draw.item(this.Font_size___Draw.item(89)))));
                        yield* this.Pen_mode();
                        this.changeXBy((N((N((N(size) / N(100))) * N(this.Font_size___Draw.item(this.Font_size___Draw.item(89))))) + N((N(size) * N(0.02)))));
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
        }
        yield* this.Pen_mode();
        if (B(equals(position, "R"))) {
            this.setX((N(X) - N((N(this.x) + N(220)))));
        }
        if (B(equals(position, "C"))) {
            this.setX((N(X) - N((N((N(this.x) + N(220))) / N(2)))));
        }
        this.Font_size___Draw.replace(88, "0");
        // 本描画パス（計測パスと同じ走査でスタンプする）
        const textLen = Math.max(0, Math.floor(N(S(text).length)));
        for (let r = 0; r < textLen; r++) {
            this.Font_size___Draw.replace(88, (N(this.Font_size___Draw.item(88)) + N(1)));
            if (B(equals(letterOf(text, this.Font_size___Draw.item(88)), "`"))) {
                yield* this.Pen_mode();
                this.setX(X);
                this.changeYBy((N(size) * N(-0.28)));
            }
            else {
                if (B(equals(letterOf(text, this.Font_size___Draw.item(88)), " "))) {
                    yield* this.Pen_mode();
                    this.changeXBy((N(size) * N(0.08)));
                }
                else {
                    this.switchCostume((S("Font ") + S(letterOf(text, this.Font_size___Draw.item(88)))));
                    this.Font_size___Draw.replace(89, this.costumeNumberName("number"));
                    yield* this.Pen_mode();
                    this.changeXBy((N((N(size) / N(100))) * N(this.Font_size___Draw.item(this.Font_size___Draw.item(89)))));
                    this.switchCostume(this.Font_size___Draw.item(89));
                    this.size = N(size);
                    this.stamp();
                    yield* this.Pen_mode();
                    this.changeXBy((N((N((N(size) / N(100))) * N(this.Font_size___Draw.item(this.Font_size___Draw.item(89))))) + N((N(size) * N(0.02)))));
                }
            }
            if (!this.rt.warpActive)
                yield;
        }
        this.rotationStyle = "all around";
        this.setX(X);
        yield* this.Pen_mode();
    }
    // procedure: "All %b" (warp)
    *All(UI_closed) {
        this.rt.pushWarp();
        try {
            // メインループ本体（warp）。毎フレーム、描画と状態更新の全部をここから回す。
            // UI_closed は「UI が閉じている＝通常プレイ中」フラグで、開いている間は
            // 回復・バフ・武器モーション等の実処理を止めて描画だけにする箇所が多い。
            // 画面クリア: めまい（Buff_effect[13]）中は消さずに灰色のベールを重ねる
            if (B(equals(G.Buff_effect.item(13), "0"))) {
                this.rt.penLayer.clear();
            }
            else {
                this.gotoXY(0, 0);
                this.setPenColor("#9a9a9a");
                this.setPenSize(800);
                this.setPenParam(S("transparency"), 95);
                this.penDown();
                this.penUp();
            }
            // マップ差し替え（Menu[115]）で壁リスト 3 種を Wall___object から再構築する。
            // Bullet_wall=弾が当たる、Player_wall=人が当たる、Gimmick_wall=ギミック
            if (B(equals(G.Menu.item(115), "1"))) {
                G.Menu.replace(115, "0");
                G.Bullet_wall.deleteAll();
                this.Player_wall.deleteAll();
                this.Gimmick_wall.deleteAll();
                this.a = "0";
                const wallRecs = Math.max(0, Math.floor(N((N(G.Wall___object.length) / N(7)))));
                for (let r = 0; r < wallRecs; r++) {
                    this.b = G.Wall___object.item((N(this.a) + N(2)));
                    if (B(equals(S(this.b).length, "1"))) {
                        this.b = (S("0") + S(this.b));
                    }
                    if (B(S("01 02 06 20 21 22 24 25 28").toLowerCase().includes(S(this.b).toLowerCase()))) {
                        G.Bullet_wall.add(G.Wall___object.item((N(this.a) + N(1))));
                    }
                    if (B(S("01 04 05 06 08 09 10 11 12 13 16 17 18 20 21 22 24 26 28").toLowerCase().includes(S(this.b).toLowerCase()))) {
                        this.Player_wall.add(G.Wall___object.item((N(this.a) + N(1))));
                    }
                    if (B(S("20 21 22 24 28").toLowerCase().includes(S(this.b).toLowerCase()))) {
                        this.Gimmick_wall.add(G.Wall___object.item((N(this.a) + N(1))));
                    }
                    this.a = N(this.a) + N(7);
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            // フレーム基礎値: ズームは Target_zoom へイージング（開発者ツール中は固定）
            G.Frame = N(G.Frame) + N(1);
            if (B(equals(G.開発者ツール, "0"))) {
                if (B((compare(G.Target_zoom, "50") < 0))) {
                    G.Target_zoom = "50";
                }
                if (B((compare("300", G.Target_zoom) < 0))) {
                    G.Target_zoom = "300";
                }
                G.Zoom = N(G.Zoom) + N((N((N(G.Target_zoom) - N(G.Zoom))) / N((N(2) * N((N(G.FPS) / N(34)))))));
            }
            G.Zoom_temp = (N(Math.round(N((N((N(100) / N(G.Zoom))) * N(100))))) / N(100));
            G.Target_zoom = "100";
            G.FPS_temp = (N(mathop("ceiling", (N((N(34) / N(G.FPS))) * N(100)))) / N(100));
            G.Skill = (N(G.Skill_2.itemNum(G.Character_2.item((N(G.Character) + N(2))))) - N(1));
            G.Tree = (N((N(G.Character) / N(15))) * N(10));
            G.CP_freq = N(G.CP_freq) + N(G.FPS_temp);
            this.Frame_cutter = N(this.Frame_cutter) + N(1);
            if (B(equals(mod(this.Frame_cutter, 300), "0"))) {
                if (B(false)) {
                    yield* this.ID_check("2");
                }
            }
            if (B((compare("0", G.Menu.item(7)) < 0))) {
                yield* this.CSM_menu("7", "-5", "C", "0");
            }
            // 死亡タイマー（Menu[15]）: 尽きたらリスポーン、残り 135 未満では
            // 位置を原点へ戻し、カメラをキラー（Menu[16]）へ寄せる
            if (B((compare("0", G.Menu.item(15)) < 0))) {
                yield* this.CSM_menu("15", "-1", "C", "0");
                if (B((compare(G.Menu.item(15), "0.1") < 0))) {
                    this.rt.soundPlay("88c767230588cfacd395d32a7f633994.wav");
                    yield* this.Respawn();
                }
                if (B((compare(G.Menu.item(15), "135") < 0))) {
                    G.X = "0";
                    G.Y = "0";
                    G.Speed_x = "0";
                    G.Speed_y = "0";
                    G.Menu.replace(2, "520");
                }
                G.Camera_x = N(G.Camera_x) + N((N((N((N(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Menu.item(16)))) + N(2)))) - N(G.X))) - N(G.Camera_x))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                G.Camera_y = N(G.Camera_y) + N((N((N((N(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Menu.item(16)))) + N(3)))) - N(G.Y))) - N(G.Camera_y))) / N((N(2) * N((N(G.FPS) / N(34)))))));
            }
            if (B((compare(G.Menu.item(15), "1") < 0))) {
                // 生存中の処理
                if (B(UI_closed)) {
                    if (B((compare("0", G.Sound) < 0))) {
                        G.Sound = N(G.Sound) + N((N(-0.8) * N(G.FPS_temp)));
                    }
                    if (B((compare(G.Sound, "1") < 0))) {
                        G.Sound = "0";
                    }
                    if (B((compare("0", G.Menu.item(21)) < 0))) {
                        yield* this.CSM_menu("21", "-5", "C", "0");
                    }
                    // 回復レート a: キャラ固有値（Character_2[+8]、負値）×バフ。
                    // Health_timer は「回復待ちプール」で、溜まった分だけ体力が戻る
                    this.a = G.Character_2.item((N(G.Character) + N(8)));
                    this.a = (N(this.a) * N((N(1) - N(G.Buff_effect.item(6)))));
                    if (B(equals(G.Special_weapon, "1"))) {
                        this.a = (N(this.a) * N(0.3));
                    }
                    if (B((compare("0", this.a) < 0))) {
                        this.a = "0";
                    }
                    if (B((compare(G.Health_timer, "300") < 0))) {
                        if (B(equals(G.Character_name, "Shield Pico"))) {
                            G.Shield = N(G.Shield) + N((N(-0.5) * N((N(this.a) * N(G.FPS_temp)))));
                            if (B((compare((N(G.Max_health) / N(4)), G.Shield) < 0))) {
                                G.Shield = (N(G.Max_health) / N(4));
                            }
                        }
                    }
                    if (B((compare("0", G.Health_timer) < 0))) {
                        G.Health_timer = N(G.Health_timer) + N((N(this.a) * N(G.FPS_temp)));
                        if (B((compare(G.Health_timer, "0") < 0))) {
                            G.Health_timer = "0";
                        }
                    }
                    else {
                        if (B((compare(G.Health, G.Max_health) < 0))) {
                            if (B(equals(G.Character_name, "Sacred Tera"))) {
                                if (B((compare((N(G.Character_2.item((N(G.Character) + N(8)))) * N(40)), G.Health_timer) < 0))) {
                                    G.Health_timer = N(G.Health_timer) + N((N(0.1) * N((N(this.a) * N(G.FPS_temp)))));
                                    if (B((compare(G.Health_timer, (N(G.Character_2.item((N(G.Character) + N(8)))) * N(40))) < 0))) {
                                        G.Health_timer = (N(G.Character_2.item((N(G.Character) + N(8)))) * N(40));
                                    }
                                }
                            }
                            this.a = (N((N(-0.2) * N(this.a))) * N(G.FPS_temp));
                            G.Health = N(G.Health) + N(this.a);
                            if (B((compare(G.Max_health, G.Health) < 0))) {
                                G.Health = G.Max_health;
                            }
                            yield* this.Get_mission_point("Heal", this.a);
                            yield* this.CSM_menu("9", "150", "M", "4");
                            if (B(equals(Math.round(N(G.Menu.item(9))), "150"))) {
                                yield* this.CSM_menu("9", "0", "S", "0");
                            }
                        }
                    }
                    // カメラ: カットシーン（Menu[56]）中は指定座標へ、それ以外は
                    // 武器の照準係数（Item_list[+4]）だけマウス方向へ寄せる
                    if (B((B((B((compare("0", G.Menu.item(56)) < 0)) && B((compare(G.Menu.item(56), "90") < 0)))) || B(equals(G.Menu.item(56), "OK"))))) {
                        G.Camera_x = N(G.Camera_x) + N((N((N((N(G.Menu.item(57)) - N(G.X))) - N(G.Camera_x))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                        G.Camera_y = N(G.Camera_y) + N((N((N((N(G.Menu.item(58)) - N(G.Y))) - N(G.Camera_y))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                        G.Target_zoom = "135";
                    }
                    else {
                        if (B(equals(G.Mouse_camera_lock, "0"))) {
                            this.a = G.Inventory_2.item((N(G.Inventory) + N(1)));
                            if (B((B(equals(this.a, "")) || B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase()))))) {
                                // 素手/サブ武器: メイン武器（Menu[17] 切替中のみ）を見るか原点へ
                                this.b = G.Inventory_2.item((N((N((N(G.Menu.item(18)) - N(1))) * N(6))) + N(1)));
                                if (B((B(equals(G.Menu.item(17), "1")) && B((!B(equals(this.b, ""))))))) {
                                    this.b = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(this.b))) + N(4)));
                                    G.Camera_x = N(G.Camera_x) + N((N((N((N(this.rt.mouse.x) * N(this.b))) - N(G.Camera_x))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                    G.Camera_y = N(G.Camera_y) + N((N((N((N(this.rt.mouse.y) * N(this.b))) - N(G.Camera_y))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                }
                                else {
                                    G.Camera_x = N(G.Camera_x) + N((N((N(0) - N(G.Camera_x))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                    G.Camera_y = N(G.Camera_y) + N((N((N(0) - N(G.Camera_y))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                }
                                G.Target_zoom = "100";
                            }
                            else {
                                if (B(equals(G.X_Y, "6/-5"))) {
                                    // ショップ前の特定マスではマウス×4 の強い寄せ＋距離ズーム
                                    G.Camera_x = N(G.Camera_x) + N((N((N((N(this.rt.mouse.x) * N(4))) - N(G.Camera_x))) / N((N(5) * N((N(G.FPS) / N(34)))))));
                                    G.Camera_y = N(G.Camera_y) + N((N((N((N(this.rt.mouse.y) * N(4))) - N(G.Camera_y))) / N((N(5) * N((N(G.FPS) / N(34)))))));
                                    G.Target_zoom = (N(100) + N((N(mathop("sqrt", (N((N(this.rt.mouse.x) * N(this.rt.mouse.x))) + N((N(this.rt.mouse.y) * N(this.rt.mouse.y)))))) / N(12))));
                                }
                                else {
                                    if (B(equals(G.Item_list.item(G.Use_Item_ID), G.Inventory_2.item((N(G.Inventory) + N(1)))))) {
                                        if (B((B(equals(G.Scoping, "1")) && B(equals(G.Item_list.item((N(G.Use_Item_ID) + N(6))), "1"))))) {
                                            // スコープ対応武器: 係数 Item_list[+5] で寄せ、ズームも距離連動
                                            G.Camera_x = N(G.Camera_x) + N((N((N((N(this.rt.mouse.x) * N(G.Item_list.item((N(G.Use_Item_ID) + N(5)))))) - N(G.Camera_x))) / N((N(5) * N((N(G.FPS) / N(34)))))));
                                            G.Camera_y = N(G.Camera_y) + N((N((N((N(this.rt.mouse.y) * N(G.Item_list.item((N(G.Use_Item_ID) + N(5)))))) - N(G.Camera_y))) / N((N(5) * N((N(G.FPS) / N(34)))))));
                                            G.Target_zoom = (N(100) + N((N(mathop("sqrt", (N((N(this.rt.mouse.x) * N(this.rt.mouse.x))) + N((N(this.rt.mouse.y) * N(this.rt.mouse.y)))))) / N(12))));
                                        }
                                        else {
                                            if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("戦車").toLowerCase()))) {
                                                this.a = "1.2";
                                            }
                                            else {
                                                this.a = G.Item_list.item((N(G.Use_Item_ID) + N(4)));
                                            }
                                            G.Camera_x = N(G.Camera_x) + N((N((N((N(this.rt.mouse.x) * N(this.a))) - N(G.Camera_x))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                            G.Camera_y = N(G.Camera_y) + N((N((N((N(this.rt.mouse.y) * N(this.a))) - N(G.Camera_y))) / N((N(2) * N((N(G.FPS) / N(34)))))));
                                            if (B(equals(G.開発者ツール, "0"))) {
                                                if (B(equals(G.Scoping, "1"))) {
                                                    G.Target_zoom = G.Item_list.item((N(G.Use_Item_ID) + N(5)));
                                                }
                                                else {
                                                    G.Target_zoom = "100";
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                            if (B(equals(G.Menu.item(52), "1"))) {
                                G.Target_zoom = N(G.Target_zoom) + N(-15);
                            }
                        }
                    }
                }
                G.Target_zoom = (N(G.Target_zoom) * N(G.Buff_effect.item(14)));
                this.gotoXY((N(0) - N(G.Camera_x)), (N(0) - N(G.Camera_y)));
                this.pointInDirection(Math.atan2(this.rt.mouse.x - this.x, this.rt.mouse.y - this.y) * 180 / Math.PI);
                if (B(equals(G.gamePad, "1"))) {
                    this.pointInDirection((N(mathop("atan", (N((N(this.rt.mouse.x) - N(G.Menu.item(54)))) / N((N(this.rt.mouse.y) - N(G.Menu.item(55))))))) + N((N((compare(this.rt.mouse.y, G.Menu.item(55)) < 0)) * N(180)))));
                }
                // Motion[3] = 向き（"The player" は 45° 刻みに丸める）。
                // ゲームパッドのスティックがほぼ原点なら向きを維持する
                if (B((B(equals(G.gamePad, "0")) || B((B(equals(G.gamePad, "1")) && B((compare("4", mathop("sqrt", (N((N((N(this.rt.mouse.x) - N(G.Menu.item(54)))) * N((N(this.rt.mouse.x) - N(G.Menu.item(54)))))) + N((N((N(this.rt.mouse.y) - N(G.Menu.item(55)))) * N((N(this.rt.mouse.y) - N(G.Menu.item(55))))))))) < 0))))))) {
                    if (B(equals(G.Character_2.item((N(G.Character) + N(1))), "The player"))) {
                        G.Motion.replace(3, (N(Math.round(N((N(this.direction) / N(45))))) * N(45)));
                    }
                    else {
                        G.Motion.replace(3, this.direction);
                    }
                }
                yield* this.Set_motion();
                // チャージ（Motion[10]、負値）の回復: 戦車は 1/s、それ以外は 2/s
                if (B((compare(G.Motion.item(10), "0") < 0))) {
                    if (B(equals(G.Inventory_2.item((N(G.Inventory) + N(2))), "戦車"))) {
                        G.Motion.replace(10, (N(G.Motion.item(10)) + N((N(1) * N(G.FPS_temp)))));
                    }
                    else {
                        G.Motion.replace(10, (N(G.Motion.item(10)) + N((N(2) * N(G.FPS_temp)))));
                    }
                }
                else {
                    G.Motion.replace(10, "0");
                }
                this.Attack_power = G.Character_2.item((N(G.Character) + N(3)));
                this.Attack_power = N(this.Attack_power) + N(G.Buff_effect.item(1));
                if (B((compare(this.Attack_power, "0") < 0))) {
                    this.Attack_power = "0";
                }
                // 移動速度: キャラ固有値に所持品の鈍足（Item_list[+8]）、
                // スコープ中の補正、重火器の射撃中補正、バフを順に掛ける
                G.Speed = (N(G.Character_2.item((N(G.Character) + N(5)))) - N(1));
                if (B(equals(G.Use_item, "100"))) {
                    this.a = "0";
                }
                else {
                    this.a = G.Item_list.item((N(G.Use_Item_ID) + N(8)));
                }
                G.Speed = (N((N(G.Speed) / N((N(100) / N((N(100) - N(this.a))))))) + N(1));
                if (B(equals(G.Scoping, "1"))) {
                    if (B(equals(G.Character_name, "Ninja Giga"))) {
                        G.Hiding = "1";
                        G.Speed = (N(G.Speed) * N(1.1));
                    }
                    if (B(equals(G.Inventory_2.item((N(G.Inventory) + N(1))), "シールドキャノン"))) {
                        G.Speed = "0";
                        if (B(equals(mod(this.Frame_cutter, (N(50) + N((N((compare("45", G.FPS) < 0)) * N(50))))), "0"))) {
                            G.Shield = N(G.Shield) + N(4);
                        }
                        if (B((compare((N(G.Max_health) / N(4)), G.Shield) < 0))) {
                            G.Shield = (N(G.Max_health) / N(4));
                        }
                    }
                    else {
                        if (B((!B((B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())) || B(equals(G.Inventory_2.item((N(G.Inventory) + N(1))), ""))))))) {
                            G.Speed = (N(G.Speed) * N(0.7));
                        }
                    }
                }
                if (B((B(S(G.Item_list.item((N(G.Use_Item_ID) + N(1)))).toLowerCase().includes(S("重").toLowerCase())) && B(equals(G.Shooting, "1"))))) {
                    G.Speed = (N(G.Speed) * N(0.7));
                }
                if (B((compare(G.Buff_effect.item(2), "0.1") < 0))) {
                    G.Buff_effect.replace(2, "0");
                }
                G.Speed = (N(G.Speed) * N(G.Buff_effect.item(2)));
                if (B((B((compare("0", G.Menu.item(56)) < 0)) || B((compare("0", G.Menu.item(76)) < 0))))) {
                    G.Speed = "0";
                }
                // 移動入力（Menu[50]=="2" のプレイ画面のみ、Move_lock が無いとき）。
                // Buff_effect[11] が 0.15（通常）なら位置を直接、そうでなければ
                // 速度へ加算する（氷上など）。モバイルはスティック角度（45° 刻み）
                if (B((B(equals(G.Menu.item(50), "2")) && B(equals(G.Move_lock, "0"))))) {
                    if (B(equals(G.Mobile, "0"))) {
                        if (B(equals(G.Buff_effect.item(11), "0.15"))) {
                            G.X = N(G.X) + N((N((N((B(this.rt.keyIsPressed(S("right arrow"))) || B(this.rt.keyIsPressed(S("d"))))) - N((B(this.rt.keyIsPressed(S("left arrow"))) || B(this.rt.keyIsPressed(S("a"))))))) * N((N(G.Speed) * N(G.FPS_temp)))));
                            G.Y = N(G.Y) + N((N((N((B(this.rt.keyIsPressed(S("up arrow"))) || B(this.rt.keyIsPressed(S("w"))))) - N((B(this.rt.keyIsPressed(S("down arrow"))) || B(this.rt.keyIsPressed(S("s"))))))) * N((N(G.Speed) * N(G.FPS_temp)))));
                        }
                        else {
                            G.Speed = (N(G.Speed) * N(G.Buff_effect.item(11)));
                            G.Speed_x = N(G.Speed_x) + N((N((N((B(this.rt.keyIsPressed(S("right arrow"))) || B(this.rt.keyIsPressed(S("d"))))) - N((B(this.rt.keyIsPressed(S("left arrow"))) || B(this.rt.keyIsPressed(S("a"))))))) * N((N(G.Speed) * N(G.FPS_temp)))));
                            G.Speed_y = N(G.Speed_y) + N((N((N((B(this.rt.keyIsPressed(S("up arrow"))) || B(this.rt.keyIsPressed(S("w"))))) - N((B(this.rt.keyIsPressed(S("down arrow"))) || B(this.rt.keyIsPressed(S("s"))))))) * N((N(G.Speed) * N(G.FPS_temp)))));
                        }
                    }
                    else {
                        if (B((!B(equals(G.Mobile_2.item(5), "-"))))) {
                            this.a = mathop("sin", (N(Math.round(N((N(G.Mobile_2.item(5)) / N(45))))) * N(45)));
                            this.b = mathop("cos", (N(Math.round(N((N(G.Mobile_2.item(5)) / N(45))))) * N(45)));
                            if (B(equals(G.Buff_effect.item(11), "0.15"))) {
                                if (B((!B(equals(this.a, "0"))))) {
                                    G.X = N(G.X) + N((N((N((N((compare("0", this.a) < 0)) * N(2))) - N(1))) * N((N(G.Speed) * N(G.FPS_temp)))));
                                }
                                if (B((!B(equals(this.b, "0"))))) {
                                    G.Y = N(G.Y) + N((N((N((N((compare("0", this.b) < 0)) * N(2))) - N(1))) * N((N(G.Speed) * N(G.FPS_temp)))));
                                }
                            }
                            else {
                                G.Speed = (N(G.Speed) * N(G.Buff_effect.item(11)));
                                if (B((!B(equals(this.a, "0"))))) {
                                    G.Speed_x = N(G.Speed_x) + N((N((N((N((compare("0", this.a) < 0)) * N(2))) - N(1))) * N((N(G.Speed) * N(G.FPS_temp)))));
                                }
                                if (B((!B(equals(this.b, "0"))))) {
                                    G.Speed_y = N(G.Speed_y) + N((N((N((N((compare("0", this.b) < 0)) * N(2))) - N(1))) * N((N(G.Speed) * N(G.FPS_temp)))));
                                }
                            }
                        }
                    }
                }
                G.Move_lock = "0";
                G.X = N(G.X) + N((N(G.Speed_x) * N(G.FPS_temp)));
                G.Y = N(G.Y) + N((N(G.Speed_y) * N(G.FPS_temp)));
                this.a = (N(1) - N((N(G.Buff_effect.item(11)) * N(G.FPS_temp))));
                G.Speed_x = (N(G.Speed_x) * N(this.a));
                G.Speed_y = (N(G.Speed_y) * N(this.a));
                G.X_Y = (S(Math.round(N((N(G.X) / N(50))))) + S((S("/") + S(Math.round(N((N(G.Y) / N(50))))))));
                // 足音と無操作検出: 前フレーム位置（Menu[10]/[11]）からの移動量を見る
                this.a = mathop("sqrt", (N((N((N(G.X) - N(G.Menu.item(10)))) * N((N(G.X) - N(G.Menu.item(10)))))) + N((N((N(G.Y) - N(G.Menu.item(11)))) * N((N(G.Y) - N(G.Menu.item(11))))))));
                if (B((compare("0.5", this.a) < 0))) {
                    yield* this.Sound("10");
                    if (B(equals(G.Inventory_2.item(2), "戦車"))) {
                        this.rt.soundPlay("d31727a2238a60d2fb11f7e12ed14975.wav");
                    }
                }
                if (B((B((compare("0.5", this.a) < 0)) || B((compare("0.5", (N(mathop("abs", (N(this.rt.mouse.x) - N(G.Menu.item(54))))) + N(mathop("abs", (N(this.rt.mouse.y) - N(G.Menu.item(55))))))) < 0))))) {
                    G.Menu.replace(13, "0");
                    G.Menu.replace(54, this.rt.mouse.x);
                    G.Menu.replace(55, this.rt.mouse.y);
                }
                else {
                    yield* this.CSM_menu("13", "1", "C", "0");
                    if (B((B((B((compare(G.Tutorial.item(2), "2") < 0)) && B((compare("450", G.Menu.item(13)) < 0)))) || B((B((compare("1", G.Tutorial.item(2)) < 0)) && B((compare("10000", G.Menu.item(13)) < 0))))))) {
                        // 無操作が続いたら全停止（チュートリアル前 450、以降 10000 フレーム）
                        this.rt.stopAll();
                        return;
                    }
                }
                // 武器切替: Menu[12] は切替クールダウン。選択スロットは Inventory_2[31]。
                // キー 1–5 / e / q / ホイール / モバイル（Mobile_2[6]）で変わる
                this.a = "2";
                if (B((compare("0", G.Menu.item(12)) < 0))) {
                    yield* this.CSM_menu("12", "-1", "C", "0");
                }
                else {
                    if (B((B(equals(G.Menu.item(17), "0")) && B((compare(G.Menu.item(35), "1") < 0))))) {
                        this.b = "0";
                        this.c = "5";
                        if (B((B(this.rt.keyIsPressed(S("1"))) || B((B(this.rt.keyIsPressed(S("2"))) || B((B(this.rt.keyIsPressed(S("3"))) || B((B(this.rt.keyIsPressed(S("4"))) || B((B(this.rt.keyIsPressed(S("5"))) || B((B(this.rt.keyIsPressed(S("e"))) || B((B(this.rt.keyIsPressed(S("q"))) || B((B((!B(equals(this.Mouse_wheel, "0")))) || B((compare("0", G.Mobile_2.item(6)) < 0))))))))))))))))))) {
                            this.a = G.Item_list.item((N(G.Use_Item_ID) + N(6)));
                            this.b = G.Inventory_2.item(31);
                            if (B(equals(G.Special_weapon, "1"))) {
                                this.c = G.Special_weapon_2.item((N(G.Special_weapon_2.itemNum(G.Inventory_2.item(2))) + N(2)));
                            }
                            G.Menu.replace(12, "6");
                        }
                        G.Menu.replace(78, (N((B(this.rt.keyIsPressed(S("w"))) && B((B((B(equals(this.rt.username, "uk-400")) && B(this.rt.keyIsPressed(S("y"))))) || B((B((!B(equals(this.rt.username, "uk-400")))) && B(this.rt.keyIsPressed(S("o"))))))))) - N(0)));
                        if (B(UI_closed)) {
                            if (B(equals(G.Mobile, "0"))) {
                                if (B(this.rt.keyIsPressed(S("1")))) {
                                    G.Inventory_2.replace(31, "1");
                                }
                                if (B(this.rt.keyIsPressed(S("2")))) {
                                    G.Inventory_2.replace(31, "2");
                                }
                                if (B(this.rt.keyIsPressed(S("3")))) {
                                    G.Inventory_2.replace(31, "3");
                                }
                                if (B(this.rt.keyIsPressed(S("4")))) {
                                    G.Inventory_2.replace(31, "4");
                                }
                                if (B(this.rt.keyIsPressed(S("5")))) {
                                    G.Inventory_2.replace(31, "5");
                                }
                                if (B((B(this.rt.keyIsPressed(S("e"))) || B((B(equals(this.Mouse_wheel, (N(1) * N(G.Menu.item(110))))) && B(equals(this.Mouse_touch, "Shot"))))))) {
                                    G.Inventory_2.replace(31, (N(G.Inventory_2.item(31)) + N(1)));
                                    if (B((compare(this.c, G.Inventory_2.item(31)) < 0))) {
                                        G.Inventory_2.replace(31, "1");
                                    }
                                }
                                if (B((B(this.rt.keyIsPressed(S("q"))) || B((B(equals(this.Mouse_wheel, (N(-1) * N(G.Menu.item(110))))) && B(equals(this.Mouse_touch, "Shot"))))))) {
                                    G.Inventory_2.replace(31, (N(G.Inventory_2.item(31)) - N(1)));
                                    if (B((compare(G.Inventory_2.item(31), "1") < 0))) {
                                        G.Inventory_2.replace(31, this.c);
                                    }
                                }
                            }
                            else {
                                if (B((compare("0", G.Mobile_2.item(6)) < 0))) {
                                    G.Inventory_2.replace(31, G.Mobile_2.item(6));
                                    if (B((compare(G.Inventory_2.item(31), "1") < 0))) {
                                        G.Inventory_2.replace(31, this.c);
                                    }
                                    if (B((compare(this.c, G.Inventory_2.item(31)) < 0))) {
                                        G.Inventory_2.replace(31, "1");
                                    }
                                    G.Mobile_2.replace(6, "0");
                                }
                            }
                            if (B((!B(equals(this.b, "0"))))) {
                                if (B((!B(equals(this.b, G.Inventory_2.item(31)))))) {
                                    yield* this.Sound("30");
                                    this.b = (N((N(G.Inventory_2.item(31)) - N(1))) * N(6));
                                    // 切替先がサブ/オーバーヒート系でなければ熱量を 85% に抑える
                                    if (B((!B((B(S(G.Inventory_2.item((N(this.b) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())) || B(S(G.Inventory_2.item((N(this.b) + N(2)))).toLowerCase().includes(S("オーバーヒート").toLowerCase()))))))) {
                                        if (B((compare((N(G.Inventory_2.item((N(this.b) + N(4)))) * N(0.85)), G.Inventory_2.item((N(this.b) + N(3)))) < 0))) {
                                            G.Inventory_2.replace((N(this.b) + N(3)), (N(G.Inventory_2.item((N(this.b) + N(4)))) * N(0.85)));
                                        }
                                    }
                                }
                                if (B(equals(G.Special_weapon, "1"))) {
                                    if (B((compare(this.c, G.Inventory_2.item(31)) < 0))) {
                                        if (B((compare(this.c, this.b) < 0))) {
                                            G.Inventory_2.replace(31, "1");
                                        }
                                        else {
                                            G.Inventory_2.replace(31, this.b);
                                        }
                                    }
                                }
                            }
                        }
                        this.b = G.Inventory_2.item((N((N((N(G.Inventory_2.item(31)) - N(1))) * N(6))) + N(1)));
                        if (B(equals(this.b, ""))) {
                            G.Use_Item_ID = "0";
                        }
                        else {
                            G.Use_Item_ID = G.Weapon.item(G.Weapon_name.itemNum(this.b));
                        }
                        if (B((!B(equals(this.a, "2"))))) {
                            if (B((B(equals(this.a, "0")) && B(equals(G.Item_list.item((N(G.Use_Item_ID) + N(6))), "1"))))) {
                                G.Scoping = "0";
                            }
                            G.Menu.replace(53, "0");
                        }
                    }
                }
                G.Inventory = (N((N(G.Inventory_2.item(31)) - N(1))) * N(6));
                yield* this.Reload_inventory("0");
                yield* this.Reload_inventory("6");
                yield* this.Reload_inventory("12");
                yield* this.Reload_inventory("18");
                yield* this.Reload_inventory("24");
                // Combat Nano: スコープ中、チャージが満タンに近いとスキルポイントへ変換
                if (B(equals(G.Character_name, "Combat Nano"))) {
                    if (B((B(equals(G.Scoping, "1")) && B((compare("1", G.Skill_point) < 0))))) {
                        this.a = G.Inventory_2.item((N(G.Inventory) + N(3)));
                        if (B((compare("6", (N(G.Inventory_2.item((N(G.Inventory) + N(4)))) - N(mathop("abs", this.a)))) < 0))) {
                            G.Skill_point = N(G.Skill_point) + N((N(-0.2) * N(G.FPS_temp)));
                            if (B((compare("0", this.a) < 0))) {
                                G.Inventory_2.replace((N(G.Inventory) + N(3)), (N(this.a) + N((N(0.6) * N(G.FPS_temp)))));
                            }
                            else {
                                G.Inventory_2.replace((N(G.Inventory) + N(3)), (N(this.a) - N((N(0.6) * N(G.FPS_temp)))));
                            }
                        }
                    }
                }
            }
            G.Character_name = G.Character_2.item((N(G.Character) + N(1)));
            G.Mission = G.Character_tree.item((N(G.Tree) + N(4)));
            G.Mouse_camera_lock = "0";
            // 発射/被弾のリングバッファ: 3 フレームごとに先頭を落として末尾を補充
            if (B((compare(mod(this.Frame_cutter, 3), "1") < 0))) {
                G.My_shot.delete(1);
                if (B((compare(G.My_shot.length, "9") < 0))) {
                    G.My_shot.add("0000000");
                }
            }
            if (B(equals(mod(this.Frame_cutter, 3), "0"))) {
                G.My_hit.delete(1);
                if (B((compare(G.My_hit.length, "6") < 0))) {
                    G.My_hit.add("000000000");
                }
            }
            // 被弾記録（Players_hit）のエージング: [相手, 経過] の組、60 超で削除
            this.a = this.Players_hit.length;
            const hitPairs = Math.max(0, Math.floor(N((N(this.Players_hit.length) / N(2)))));
            for (let r = 0; r < hitPairs; r++) {
                this.a = N(this.a) + N(-2);
                this.Players_hit.replace((N(this.a) + N(2)), (N(this.Players_hit.item((N(this.a) + N(2)))) + N(1)));
                if (B((compare("60", this.Players_hit.item((N(this.a) + N(2)))) < 0))) {
                    for (let k = 0; k < 2; k++) {
                        this.Players_hit.delete((N(this.a) + N(1)));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.Mud = "0";
            yield* this.Hit_wall();
            if (B(UI_closed)) {
                yield* this.CSM_menu("38", "-1", "C", "0");
                // Buff_effect の再構築（基礎値）: [1]=攻撃補正 [2]=速度倍率（泥で低下）
                // [3..5]=弾/爆/回復係数 [6]=回復抑制 [7..9]=係数 [10]=ステップ（戦車 0.1/他 0.15）
                // [11]=摩擦 [12]=平和 [13]=めまい [14]=ズーム倍率
                G.Buff_effect.deleteAll();
                G.Buff_effect.add("0");
                G.Buff_effect.add((N(1) - N((N(this.Mud) * N(0.2)))));
                for (let i = 0; i < 3; i++) {
                    G.Buff_effect.add("1");
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Buff_effect.add("0");
                G.Buff_effect.add("0");
                for (let i = 0; i < 3; i++) {
                    G.Buff_effect.add("1");
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("戦車").toLowerCase()))) {
                    G.Buff_effect.add("0.1");
                }
                else {
                    G.Buff_effect.add("0.15");
                }
                for (let i = 0; i < 2; i++) {
                    G.Buff_effect.add("0");
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Buff_effect.add("1");
                // ショップエリア（X -750..400, Y -500..600）: 被弾無効。
                // 内側（X > -650 かつ Y < 200）は攻撃も可、それ以外は攻撃不可＋全回復
                if (B((B((B((compare("-750", G.X) < 0)) && B((compare(G.X, "400") < 0)))) && B((B((compare("-500", G.Y) < 0)) && B((compare(G.Y, "600") < 0))))))) {
                    yield* this.CSM_menu("92", "-1", "C", "0");
                    G.Not_hit = "1";
                    if (B((B((compare("-650", G.X) < 0)) && B((compare("200", G.Y) < 0))))) {
                        G.Not_attack = "0";
                    }
                    else {
                        G.Not_attack = "1";
                        G.Max_health = G.Character_2.item((N(G.Character) + N(4)));
                        G.Health = G.Max_health;
                        G.Max_skill_point = G.Skill_2.item((N(G.Skill) + N(2)));
                        G.Skill_point = (N(G.Max_skill_point) / N(2));
                        yield* this.Put_buff("ショップ", "5");
                        G.Buff_effect.replace(2, (N(G.Buff_effect.item(2)) + N(0.3)));
                    }
                }
                else {
                    G.Not_hit = "0";
                    G.Not_attack = "0";
                    if (B(equals(G.Menu.item(22), "1"))) {
                        yield* this.CSM_menu("23", "0", "M", "4");
                    }
                    else {
                        yield* this.CSM_menu("23", "40", "M", "4");
                    }
                    // "h" キー: カットシーン（Menu[56]）で自位置の 3000 左へカメラを飛ばす
                    if (B((B((B(this.rt.keyIsPressed(S("h"))) || B(equals(G.Mobile_2.item(15), "1")))) && B(equals(G.Menu.item(56), "0"))))) {
                        G.Menu.replace(56, "300");
                        G.Menu.replace(57, (N(G.X) - N(3000)));
                        G.Menu.replace(58, G.Y);
                        G.Menu.replace(60, G.X);
                    }
                    // タレット配置は 300 フレームごと、日付から決まる位置へ回る
                    if (B(equals(mod(this.Frame_cutter, 300), "0"))) {
                        this.a = mathop("floor", (N(this.rt.daysSince2000()) + N(0.2666)));
                        this.b = (N((S(letterOf(this.a, (N(S(this.a).length) - N(1)))) + S(letterOf(this.a, S(this.a).length)))) + N((N(letterOf(this.a, S(this.a).length)) - N(letterOf(this.a, (N(S(this.a).length) - N(1)))))));
                        this.b = (N(mod(this.a, 4)) * N(2));
                        G.Turrets.replace(16, G.Turret_position.item((N(this.b) + N(1))));
                        G.Turrets.replace(17, G.Turret_position.item((N(this.b) + N(2))));
                        if (B(equals(mod(this.a, 2), "0"))) {
                            G.Turrets.replace(6, "シールドキャノン");
                        }
                        else {
                            G.Turrets.replace(6, "戦車");
                        }
                        if (B((compare(mod((N(this.a) + N(1)), 4), "2") < 0))) {
                            G.Turrets.replace(26, "Missile");
                        }
                        else {
                            G.Turrets.replace(26, "Cannon");
                        }
                    }
                }
                if (B(equals(G.Not_attack, "0"))) {
                    // バフ/デバフの適用（攻撃可能なときだけ効果を出す）。
                    // Buff_Debuff は [名前, 残りフレーム] の組を後ろから処理する。
                    // 汎用バフは Buff テーブル（stride 20）の [+5..] を Buff_effect へ合成し、
                    // [+4] は定期回復/ダメージ、[+3] は終了時の下位バフへの連鎖
                    this.a = G.Buff_Debuff.length;
                    const buffPairs = Math.max(0, Math.floor(N((N(G.Buff_Debuff.length) / N(2)))));
                    for (let r = 0; r < buffPairs; r++) {
                        this.b = G.Buff_Debuff.item(this.a);
                        G.Buff_Debuff.replace(this.a, (N(G.Buff_Debuff.item(this.a)) - N(G.FPS_temp)));
                        this.c = G.Buff_Debuff.item((N(this.a) - N(1)));
                        if (B((B(S(this.c).toLowerCase().includes(S("シールド").toLowerCase())) && B(equals(G.Menu.item(44), "1"))))) {
                            G.Buff_Debuff.replace(this.a, "0");
                        }
                        if (B((B(S(this.c).toLowerCase().includes(S("ソード").toLowerCase())) && B(equals(G.Menu.item(99), "1"))))) {
                            G.Buff_Debuff.replace(this.a, "0");
                        }
                        if (B(equals(this.c, "アサシン"))) {
                            G.Buff_effect.replace(1, (N(G.Buff_effect.item(1)) + N((N(0.3) / N((N(100) / N((N(100) - N(G.Sound)))))))));
                            G.Buff_effect.replace(2, (N(G.Buff_effect.item(2)) + N((N(0.5) / N((N(100) / N((N(100) - N(G.Sound)))))))));
                        }
                        else {
                            if (B(equals(this.c, "めまい"))) {
                                G.Buff_effect.replace(13, "1");
                            }
                            else {
                                if (B(equals(this.c, "平和"))) {
                                    G.Buff_effect.replace(1, "-10");
                                    G.Buff_effect.replace(12, "1");
                                }
                                else {
                                    this.c = (N((N(this.Buff_name.itemNum(this.c)) - N(1))) * N(20));
                                    this.d = "4";
                                    const effLen = Math.max(0, Math.floor(N(G.Buff_effect.length)));
                                    for (let k = 0; k < effLen; k++) {
                                        this.d = N(this.d) + N(1);
                                        if (B((B(equals(this.d, "11")) || B(equals(this.d, "16"))))) {
                                            this.e = G.Buff.item((N(this.c) + N(this.d)));
                                            if (B(equals(this.e, "1"))) {
                                                G.Buff_effect.replace((N(this.d) - N(4)), this.e);
                                            }
                                        }
                                        else {
                                            if (B(equals(this.d, "15"))) {
                                                this.e = G.Buff.item((N(this.c) + N(this.d)));
                                                if (B((!B(equals(this.e, "0"))))) {
                                                    if (B((compare(this.e, G.Buff_effect.item((N(this.d) - N(4)))) < 0))) {
                                                        G.Buff_effect.replace((N(this.d) - N(4)), this.e);
                                                    }
                                                }
                                            }
                                            else {
                                                G.Buff_effect.replace((N(this.d) - N(4)), (N(G.Buff_effect.item((N(this.d) - N(4)))) + N(G.Buff.item((N(this.c) + N(this.d))))));
                                            }
                                        }
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                }
                            }
                        }
                        if (B((!B(equals(G.Buff.item((N(this.c) + N(4))), "0"))))) {
                            if (B((B((compare(G.Buff_Debuff.item(this.a), "1") < 0)) || B((compare("0", (N(mathop("floor", (N(this.b) / N(30)))) - N(mathop("floor", (N(G.Buff_Debuff.item(this.a)) / N(30)))))) < 0))))) {
                                if (B((compare("0", G.Buff.item((N(this.c) + N(4)))) < 0))) {
                                    G.Menu.replace(6, "2");
                                    G.Health = N(G.Health) + N(G.Buff.item((N(this.c) + N(4))));
                                    if (B((compare(G.Max_health, G.Health) < 0))) {
                                        G.Health = G.Max_health;
                                    }
                                }
                                else {
                                    G.Menu.replace(6, "1");
                                    if (B((compare("0", G.Health) < 0))) {
                                        G.Health = N(G.Health) + N(G.Buff.item((N(this.c) + N(4))));
                                        if (B((compare(G.Health, "1") < 0))) {
                                            G.Health = "1";
                                        }
                                    }
                                }
                                G.Menu.replace(7, "100");
                                G.Menu.replace(8, "5");
                            }
                        }
                        if (B((compare(G.Buff_Debuff.item(this.a), "1") < 0))) {
                            if (B((!B(equals(G.Buff.item((N(this.c) + N(3))), "0"))))) {
                                // 連鎖: 名前の末尾1文字を 1 段下げた名前で付け直す
                                this.d = "0";
                                this.e = "";
                                const nameLen = Math.max(0, Math.floor(N((N(S(G.Buff.item((N(this.c) + N(1)))).length) - N(1)))));
                                for (let k = 0; k < nameLen; k++) {
                                    this.d = N(this.d) + N(1);
                                    this.e = (S(this.e) + S(letterOf(G.Buff.item((N(this.c) + N(1))), this.d)));
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                yield* this.Put_buff((S(this.e) + S((N(letterOf(G.Buff.item((N(this.c) + N(1))), S(G.Buff.item((N(this.c) + N(1)))).length)) - N(1)))), G.Buff.item((N(this.c) + N(3))));
                            }
                            for (let k = 0; k < 2; k++) {
                                G.Buff_Debuff.delete((N(this.a) - N(1)));
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        this.a = N(this.a) + N(-2);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    // 攻撃不可エリアではタイマーだけ進めて期限切れを捨てる
                    this.a = G.Buff_Debuff.length;
                    const buffPairs2 = Math.max(0, Math.floor(N((N(G.Buff_Debuff.length) / N(2)))));
                    for (let r = 0; r < buffPairs2; r++) {
                        this.b = G.Buff_Debuff.item(this.a);
                        G.Buff_Debuff.replace(this.a, (N(G.Buff_Debuff.item(this.a)) - N(G.FPS_temp)));
                        this.c = G.Buff_Debuff.item((N(this.a) - N(1)));
                        if (B((compare(G.Buff_Debuff.item(this.a), "1") < 0))) {
                            for (let k = 0; k < 2; k++) {
                                G.Buff_Debuff.delete((N(this.a) - N(1)));
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        this.a = N(this.a) + N(-2);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
            }
            yield* this.Set_pet_position();
            // クラウド送信用パックの組み立て（Temp1_2）:
            // [1]=Motion[3..9] の 3 桁パック [2]=My_shot [3]=My_hit
            // [4]=Hide_ghost [5]=Sound（どちらも Data cut 3 to 2 で 2 桁化）
            // [6]=User_ID の 4 文字 + 抜き出し位置 [7]=リロード一致フラグ
            // [8]=ローテーション統計（下記） [9]=チームスコア差
            this.Mouse_touch = "Shot";
            this.Touch = "0";
            this.a = G.Inventory_2.item((N(G.Inventory) + N(1)));
            if (B(equals(this.a, ""))) {
                G.Use_item = "100";
            }
            else {
                G.Use_item = (N(G.Weapon_name.itemNum(this.a)) + N(100));
            }
            this.Temp1_2.deleteAll();
            this.a = "2";
            this.b = "";
            for (let i = 0; i < 7; i++) {
                this.a = N(this.a) + N(1);
                this.b = (S(this.b) + S((N(Math.round(N(G.Motion.item(this.a)))) + N(500))));
                if (!this.rt.warpActive)
                    yield;
            }
            this.Temp1_2.add(this.b);
            this.a = "0";
            this.b = "";
            for (let i = 0; i < 9; i++) {
                this.a = N(this.a) + N(1);
                if (B(equals(G.Block_num, "0"))) {
                    this.b = (S(this.b) + S(G.My_shot.item(this.a)));
                }
                else {
                    this.b = (S(this.b) + S("0000000"));
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.Temp1_2.add(this.b);
            this.a = "0";
            this.b = "";
            for (let i = 0; i < 6; i++) {
                this.a = N(this.a) + N(1);
                this.b = (S(this.b) + S(G.My_hit.item(this.a)));
                if (!this.rt.warpActive)
                    yield;
            }
            this.Temp1_2.add(this.b);
            yield* this.Data_cut_3_to_2(G.Hide_ghost);
            yield* this.Data_cut_3_to_2(G.Sound);
            // User_ID から 4 文字を抜く（位置はユーザー名の長さで変わる）
            if (B((compare("16", S(this.rt.username).length) < 0))) {
                this.a = random(0, 9);
            }
            else {
                this.a = random(0, mathop("ceiling", (N(S(this.rt.username).length) / N(2))));
            }
            this.Temp1_2.add((S(letterOf(G.User_ID, (N((N(this.a) * N(4))) + N(1)))) + S((S(letterOf(G.User_ID, (N((N(this.a) * N(4))) + N(2)))) + S((S(letterOf(G.User_ID, (N((N(this.a) * N(4))) + N(3)))) + S((S(letterOf(G.User_ID, (N((N(this.a) * N(4))) + N(4)))) + S(this.a)))))))));
            this.Temp1_2.add((N(equals(G.Inventory_2.item((N(G.Inventory) + N(3))), G.Inventory_2.item((N(G.Inventory) + N(4))))) - N(0)));
            // ローテーション統計: a = 10..25 のどれか 1 つだけを毎フレーム送る。
            // 作者アカウントなのに User_ID が作者のものでなければ全停止する（原作の保護）
            if (B(equals(G.User_ID, "3121736763630000000000000000000000000000"))) {
                this.a = random(10, 25);
            }
            else {
                this.a = random(10, 25);
                if (B(equals(this.rt.username, "uk-400"))) {
                    this.rt.stopAll();
                    return;
                }
            }
            if (B(equals(this.a, "10"))) {
                this.Temp1_2.add((S("10") + S((N(G.Max_rank) + N(1000)))));
            }
            if (B(equals(this.a, "11"))) {
                this.Temp1_2.add((S("11") + S((N(G.Max_kill) + N(1000)))));
            }
            if (B((B((compare("11", this.a) < 0)) && B((compare(this.a, "17") < 0))))) {
                this.Temp1_2.add((S(this.a) + S((N(G.Weapon_name.itemNum(G.Inventory_2.item((N((N((N(this.a) - N(12))) * N(6))) + N(1))))) + N(1000)))));
            }
            if (B(equals(this.a, "17"))) {
                this.Temp1_2.add((S("17") + S((N(G.Got_weapon.length) + N(1000)))));
            }
            if (B(equals(this.a, "18"))) {
                this.c = "5";
                this.b = "0";
                const treeNodes = Math.max(0, Math.floor(N((N(G.Character_tree.length) / N(10)))));
                for (let r = 0; r < treeNodes; r++) {
                    if (B((compare((N(G.Character_tree.item(this.c)) / N(10)), (N(G.Character_tree.item((N(this.c) + N(1)))) + N(1))) < 0))) {
                        this.b = N(this.b) + N(1);
                        if (B(equals(G.Character_tree.item(this.c), G.Character_tree.item((N(this.c) + N(1)))))) {
                            this.b = N(this.b) + N(1);
                        }
                    }
                    this.c = N(this.c) + N(10);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.Temp1_2.add((S("18") + S((N(this.b) + N(1000)))));
            }
            if (B(equals(this.a, "19"))) {
                this.b = G.Inventory_2.item((N(G.Inventory) + N(4)));
                if (B((compare(this.b, "900") < 0))) {
                    this.Temp1_2.add((S("19") + S((N(this.b) + N(1000)))));
                }
                else {
                    this.Temp1_2.add((S("19") + S((N(Math.round(N((N(this.b) / N(30))))) + N(1000)))));
                }
            }
            if (B(equals(this.a, "20"))) {
                this.Temp1_2.add((S("20") + S((N(G.Select_pet) + N(1001)))));
            }
            if (B(equals(this.a, "21"))) {
                this.Temp1_2.add((S("21") + S(G.Menu.item(85))));
            }
            if (B(equals(this.a, "22"))) {
                this.Temp1_2.add((S("22") + S((N(G.Mobile) + N(1000)))));
            }
            if (B(equals(this.a, "23"))) {
                this.Temp1_2.add((S("23") + S((N(G.Date) + N(1000)))));
            }
            if (B(equals(this.a, "24"))) {
                this.Temp1_2.add((S("24") + S((N(Math.round(N(G.Combat_Power))) + N(1000)))));
            }
            if (B(equals(this.a, "25"))) {
                this.Temp1_2.add((S("25") + S(G.TEAMMODE_2.item(17))));
            }
            this.a = (N((N(G.TEAMMODE_2.item(3)) - N(G.TEAMMODE_2.item(4)))) + N(550));
            if (B((compare(this.a, "100") < 0))) {
                this.a = "100";
            }
            if (B((compare("999", this.a) < 0))) {
                this.a = "999";
            }
            this.Temp1_2.add(this.a);
            // 速度推定（Menu[107]/[108]）: World_timer の差分から割り出す。
            // 差分の基準に Menu[108] を使うのは原作のまま（107 側も同じ a で割る）
            G.World_timer = (N(mod(mathop("floor", (N(this.rt.daysSince2000()) * N(8640000))), 90000)) + N(10000));
            this.a = (N(mod((N((N(G.World_timer) - N(G.Menu.item(108)))) + N(45000)), 89999)) - N(45000));
            G.Menu.replace(107, (N(mathop("floor", (N((N(G.X) - N(G.Menu.item(107)))) / N(this.a)))) + N(50)));
            G.Menu.replace(108, (N(mathop("floor", (N((N(G.Y) - N(G.Menu.item(108)))) / N(this.a)))) + N(50)));
            if (B((!B((B(equals(S(G.Menu.item(107)).length, "2")) && B(equals(S(G.Menu.item(108)).length, "2"))))))) {
                G.Menu.replace(107, "50");
                G.Menu.replace(108, "50");
            }
            // ワイヤ形式への連結（デコード順は Load cloud data と対）
            G.Cloud_data = (S(G.ID) + S((S(G.World_timer) + S((S(G.Version) + S((S((N(Math.round(N(G.X))) + N(5000))) + S((S((N(Math.round(N(G.Y))) + N(5000))) + S((S(this.Temp1_2.item(1)) + S((S(G.Team_ID) + S((S((N(G.Laser_sight_length) + N(1000))) + S((S(this.Temp1_2.item(2)) + S((S((N((N(G.Character) / N(15))) + N(10))) + S((S((N((B(equals(G.Not_hit, "1")) || B(equals(G.Buff_effect.item(12), "1")))) - N(0))) + S((S(G.Use_item) + S((S(G.Hiding) + S((S(this.Temp1_2.item(4)) + S((S(this.Temp1_2.item(3)) + S((S((N(Math.round(N(G.Health))) + N(2000))) + S((S((N(Math.round(N(G.Max_health))) + N(2000))) + S((S(this.Temp1_2.item(5)) + S((S(Math.round(N((N((N(this.Attack_power) * N(100))) + N(100))))) + S((S(G.Special_skin) + S((S(G.Scoping) + S((S(this.Temp1_2.item(7)) + S((S(G.Team_color) + S((S(G.Team_menu) + S((S((N(Math.round(N(G.Skill_point))) + N(100))) + S((S(G.Lock_on_player) + S((S(G.Object_trigger) + S((S(G.Menu.item(65)) + S((S(this.Chat) + S((S(this.Temp1_2.item(8)) + S((S(this.Turreting) + S((S(G.Special_weapon) + S((S((N(Math.round(N(G.Pet_x))) + N(500))) + S((S((N(Math.round(N(G.Pet_y))) + N(500))) + S((S((N(mod(Math.round(N(G.Pet_direction)), 360)) + N(500))) + S((S((N(Math.round(N(G.Pet_animation))) + N(100))) + S((S(G.Menu.item(105)) + S((S(G.Menu.item(106)) + S((S(G.Menu.item(107)) + S((S(G.Menu.item(108)) + S((S(G.Menu.item(111)) + S((S(this.Temp1_2.item(9)) + S(this.Temp1_2.item(6)))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))))));
            G.Menu.replace(107, G.X);
            G.Menu.replace(108, G.Y);
            G.Menu.replace(109, G.World_timer);
            G.Lock_on_player = "0000";
            this.Turreting = "0";
            G.Menu.replace(52, "0");
            // 隠れ（Hiding）: 茂み（Bush_buff）と連動。茂みは音で薄れる
            if (B(equals(G.Hiding, "0"))) {
                if (B((compare("0", G.Hide_ghost) < 0))) {
                    G.Hide_ghost = N(G.Hide_ghost) + N((N(-10) * N(G.FPS_temp)));
                }
                else {
                    G.Hide_ghost = "0";
                }
            }
            else {
                if (B((compare("0", G.Health) < 0))) {
                    if (B(UI_closed)) {
                        G.Menu.replace(52, "1");
                    }
                }
                if (B((compare(G.Hide_ghost, "100") < 0))) {
                    G.Hide_ghost = N(G.Hide_ghost) + N((N(10) * N(G.FPS_temp)));
                }
                else {
                    G.Hide_ghost = "100";
                }
            }
            G.Menu.replace(99, "0");
            if (B(equals(G.Bush, "1"))) {
                G.Bush_buff = N(G.Bush_buff) + N((N(2) * N(G.FPS_temp)));
            }
            G.Bush = "0";
            G.Bush_buff = N(G.Bush_buff) + N((N((N(-1) - N((N(G.Sound) * N(0.05))))) * N(G.FPS_temp)));
            if (B((compare(G.Bush_buff, "0") < 0))) {
                G.Bush_buff = "0";
            }
            if (B((compare("180", G.Bush_buff) < 0))) {
                G.Bush_buff = "180";
            }
            G.Hiding = (N((compare("0", G.Bush_buff) < 0)) + N(0));
            yield* this.Cloud("1");
            // ---- 描画フェーズ ----
            if (B(equals(G.Buff_effect.item(13), "0"))) {
                yield* this.Draw_square();
            }
            yield* this.Draw_wall___object((N(103) * N(G.Zoom_temp)), (N(6) * N((N(G.Zoom) / N(100)))), (N(5) * N((N(G.Zoom) / N(100)))), (N(G.All_camera_x) / N(50)), (N(G.All_camera_y) / N(50)), (N(50) * N(G.Zoom_temp)));
            if (B(equals(G.TEAMMODE, "0"))) {
                if (B(equals(G.SURVIVAL, "0"))) {
                    yield* this.Draw_map_object((N((N(3200) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.All_camera_y))) * N(G.Zoom_temp)), "0");
                }
            }
            else {
                // TEAMMODE のゾーン枠
                yield* this.Pen_mode();
                this.gotoXY((N((N((N(G.TEAMMODE_2.item(10)) - N((N(G.TEAMMODE_2.item(12)) / N(2))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(G.TEAMMODE_2.item(11)) - N((N(G.TEAMMODE_2.item(13)) / N(2))))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                this.setPenColor("#fbff19");
                this.setPenSize((N(5) * N(G.Zoom_temp)));
                this.setPenParam(S("saturation"), (N(90) + N((N(mathop("sin", (N(this.rt.timer()) * N(100)))) * N(10)))));
                this.setPenParam(S("transparency"), 100);
                this.penDown();
                this.setPenParam(S("transparency"), 50);
                this.changeXBy((N(G.TEAMMODE_2.item(12)) * N(G.Zoom_temp)));
                this.changeYBy((N(G.TEAMMODE_2.item(13)) * N(G.Zoom_temp)));
                this.changeXBy((N((N(0) - N(G.TEAMMODE_2.item(12)))) * N(G.Zoom_temp)));
                this.changeYBy((N((N(0) - N(G.TEAMMODE_2.item(13)))) * N(G.Zoom_temp)));
                this.penUp();
            }
            yield* this.Draw_map_object((N((N(G.Turrets.item(16)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.Turrets.item(17)) - N(G.All_camera_y))) * N(G.Zoom_temp)), "15");
            yield* this.Laser_sight_2();
            if (B((B((compare(G.X, "400") < 0)) && B(UI_closed)))) {
                yield* this.Draw_dummy_rail();
            }
            yield* this.Draw_arrow();
            if (B((compare("400", G.X) < 0))) {
                yield* this.Draw_player_search();
            }
            G.Menu.replace(116, "-");
            yield* this.Draw_bullet((N(100) * N(G.Zoom_temp)), equals(G.Character_name, "Golden Bot"));
            if (B((compare(G.X, "400") < 0))) {
                // ロビー（X < 400）の NPC と、ショップ/チーム UI の開閉位置の追随
                this.a = (N(62) + N((N(mathop("sin", (N(this.rt.timer()) * N(150)))) * N(5))));
                this.b = (N(100) * N(G.Zoom_temp));
                this.rotationStyle = "all around";
                this.c = "0";
                G.Menu.replace(77, (N((B((B((!B(equals(this.rt.username, "uk-400")))) && B(equals(G.X_Y, "2/1")))) || B((B(equals(this.rt.username, "uk-400")) && B(equals(G.X_Y, "-2/1")))))) - N(0)));
                yield* this.Draw_NPC("0", "150", "180", "Gobo", "1");
                yield* this.Draw_NPC("-200", "150", "180", "Nano", "2");
                yield* this.Draw_NPC("0", "-150", "0", "Cat", "3");
                yield* this.Draw_NPC("-200", "-150", "0", "Giga", "4");
                yield* this.Draw_NPC("350", "-400", "-90", "Alien", "6");
                if (B((B((B((compare(G.Menu.item(19), "5") < 0)) || B(equals(G.Menu.item(19), "6")))) && B(equals(this.c, "0"))))) {
                    G.Menu.replace(19, "0");
                }
                if (B(equals(G.Menu.item(19), "0"))) {
                    yield* this.CSM_menu("20", "520", "M", "4");
                }
                else {
                    yield* this.CSM_menu("20", "160", "M", "4");
                }
                if (B(equals(G.X_Y, "-8/-3"))) {
                    yield* this.CSM_menu("41", "160", "M", "4");
                }
                else {
                    yield* this.CSM_menu("41", "520", "M", "4");
                }
                if (B(equals(Math.round(N(G.Menu.item(41))), "520"))) {
                    G.Menu.replace(40, "0");
                }
            }
            if (B(equals((this.rt.spriteNamed("開発者ツール")?.varByName("a") ?? 0), "0"))) {
                G.Item_list.deleteAll();
            }
            yield* this.Draw_players(UI_closed);
            if (B(UI_closed)) {
                yield* this.Draw_screen_stamp();
                if (B(equals(G.Not_attack, "0"))) {
                    yield* this.Draw_lock_on();
                }
                yield* this.Draw_ship();
                yield* this.Damage_effect();
                yield* this.Pen_mode();
                // Golden Bot の狙撃センサー警告（点滅スタンプ＋音）
                if (B((B(equals(G.Character_2.item((N(G.Character) + N(1))), "Golden Bot")) && B((B((!B(equals(G.Sniping_player, "0000")))) && B((compare("400", G.X) < 0))))))) {
                    this.a = mod(Math.round(N((N(this.rt.timer()) * N(10)))), 8);
                    if (B((compare(this.a, "4") < 0))) {
                        this.gotoXY(0, 0);
                        this.pointInDirection(90);
                        this.switchCostume("狙撃センサー");
                        this.size = N(100);
                        this.stamp();
                        if (B(equals(G.Menu.item(47), "0"))) {
                            this.rt.soundPlay("d0ab963ea363c6a032bab102bc9cdd76.wav");
                        }
                        G.Menu.replace(47, "1");
                    }
                    else {
                        G.Menu.replace(47, "0");
                    }
                    yield* this.Pen_mode();
                }
                // インベントリ描画: 特殊武器はスロット数が可変
                this.gotoXY(-232, -133);
                if (B(equals(G.Special_weapon, "1"))) {
                    this.Temp1 = G.Special_weapon_2.item((N(G.Special_weapon_2.itemNum(G.Inventory_2.item(2))) + N(2)));
                    this.Temp2 = "0";
                    for (let r = 0; r < 5; r++) {
                        if (B((compare(this.Temp2, (N(this.Temp1) * N(6))) < 0))) {
                            if (B(equals(this.Temp2, "0"))) {
                                yield* this.Draw_inventory__a_b_c(this.Temp2, (N(40) + N((N((N(5) - N(this.Temp1))) * N(48)))));
                            }
                            else {
                                yield* this.Draw_inventory__a_b_c(this.Temp2, "40");
                            }
                        }
                        this.Temp2 = N(this.Temp2) + N(6);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    yield* this.Draw_inventory__a_b_c("0", "40");
                    yield* this.Draw_inventory__a_b_c("6", "40");
                    yield* this.Draw_inventory__a_b_c("12", "40");
                    yield* this.Draw_inventory__a_b_c("18", "40");
                    yield* this.Draw_inventory__a_b_c("24", "40");
                }
                if (B(equals(G.Not_attack, "0"))) {
                    this.gotoXY(202, -133);
                    yield* this.Draw_skill_gage();
                    yield* this.Draw_character_mission();
                }
                if (B(equals(G.TEAMMODE, "1"))) {
                    yield* this.Draw_team_point();
                }
                yield* this.Draw_my_combat_status();
                yield* this.Draw_screen_effect();
                G.Menu.replace(67, "1");
                G.Menu.replace(68, "0");
                // チーム結束バフ: 自チームが居れば常時、TEAMMODE では人数/スコア条件つき
                this.c = G.Team.itemNum((S("2") + S(G.Team_ID)));
                if (B((!B(equals(this.c, "0"))))) {
                    if (B(equals(G.TEAMMODE, "0"))) {
                        yield* this.Put_buff("結束の代償", "5");
                        if (B((compare("400", G.X) < 0))) {
                            yield* this.Draw_teammate();
                        }
                    }
                }
                if (B(equals(G.TEAMMODE, "1"))) {
                    if (B((compare((N(G.TEAMMODE_2.item(2)) * N(1.25)), G.TEAMMODE_2.item(1)) < 0))) {
                        yield* this.Put_buff("結束の代償", "5");
                    }
                    if (B((B((B(equals(letterOf(G.Team_ID, 1), "1")) && B((compare((N(G.TEAMMODE_2.item(4)) * N(1.5)), G.TEAMMODE_2.item(3)) < 0)))) || B((B(equals(letterOf(G.Team_ID, 1), "2")) && B((compare((N(G.TEAMMODE_2.item(3)) * N(1.5)), G.TEAMMODE_2.item(4)) < 0))))))) {
                        yield* this.Put_buff("結束の代償+", "5");
                    }
                }
                if (B(equals(G.Mobile, "1"))) {
                    yield* this.Put_buff("モバイル", "5");
                }
            }
            // 通報ボタン（死亡タイマー明け、6 人以上、まだ通報されていない相手）
            if (B((compare("15", G.Menu.item(15)) < 0))) {
                if (B((compare("5", G.Active_players) < 0))) {
                    if (B((compare("1", (N(S(G.Blocked_player.item((N(G.Blocked_player.itemNum((S("#") + S(G.Menu.item(16))))) + N(1)))).length) / N(4))) < 0))) {
                        this.gotoXY(-220, -150);
                        this.setPenSize(15);
                        if (B((B((compare(mathop("abs", (N(this.rt.mouse.x) - N(-180))), "48") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(-148))), "16") < 0))))) {
                            this.Mouse_touch = "Report player";
                        }
                        if (B(equals(G.Menu.item(16), G.Menu.item(85)))) {
                            this.setPenColor("#670000");
                        }
                        else {
                            this.setPenColor("#b30000");
                        }
                        this.penDown();
                        this.changeXBy(80);
                        this.changeYBy(-15);
                        this.changeXBy(-80);
                        this.changeYBy(15);
                        this.penUp();
                        this.setEffect("BRIGHTNESS", 100);
                        this.gotoXY(-190, -158);
                        yield* this.Draw_text("Report", "70", "C", "-190");
                        this.setEffect("BRIGHTNESS", 0);
                        yield* this.Stamp("-145", "-158", "50", "Report bell");
                    }
                }
            }
            yield* this.Draw_tutorial();
            yield* this.Draw_UI("Chat", G.Menu.item(62), "270");
            if (B((compare(G.X, "400") < 0))) {
                yield* this.Draw_UI("Map pointer", G.Menu.item(2), "520");
                yield* this.Draw_UI("Team", G.Menu.item(41), "520");
                yield* this.Draw_UI("Shop", G.Menu.item(20), "520");
                yield* this.Draw_UI("Cheat stopper", G.Menu.item(86), "520");
                yield* this.Draw_UI("Computer", G.Menu.item(94), "520");
            }
            else {
                yield* this.Draw_UI("Turret map pointer", G.Menu.item(69), "520");
            }
            if (B((!B(equals(Math.round(N(G.Menu.item(51))), "520"))))) {
                if (B((compare("1", G.Menu.item(50)) < 0))) {
                    yield* this.CSM_menu("51", "520", "M", "4");
                }
                yield* this.Draw_UI("What's new", G.Menu.item(51), "520");
            }
            G.Menu.replace(65, G.Menu.item(61));
            if (B(equals(G.Menu.item(61), "1"))) {
                yield* this.CSM_menu("62", "140", "M", "4");
            }
            else {
                yield* this.CSM_menu("62", "270", "M", "4");
            }
            this.Screen_stamp.deleteAll();
            // セッション時間制限: ロビー 7200 秒 / 対戦 1 秒（Menu[49] 起点）。
            // Creator は対象外。対戦側の 1 秒は実質「入室直後の再計測」の原作仕様
            this.a = (N((N(this.rt.daysSince2000()) * N(86400))) - N(G.Menu.item(49)));
            if (B((B((B((!B((compare("400", G.X) < 0)))) && B((compare("7200", this.a) < 0)))) || B((B((compare("400", G.X) < 0)) && B((compare("1", this.a) < 0))))))) {
                if (B(equals(G.Creator, "0"))) {
                    this.rt.stopAll();
                    return;
                }
            }
            G.Menu.replace(49, (N(this.rt.daysSince2000()) * N(86400)));
            // 自分の ID 履歴（My_IDs）: 10 個を超えたら Block_num が立つ（多重起動検出）
            if (B((!B(equals(G.My_IDs.item("last"), G.ID))))) {
                G.My_IDs.add(G.ID);
                if (B((compare("10", G.My_IDs.length) < 0))) {
                    G.Block_num = "1";
                }
            }
            yield* this.Team_invitation();
            if (B(equals(G.Mobile, "1"))) {
                yield* this.Mobile();
            }
            G.Charge = "00";
            yield* this.Button();
            this.Mouse_wheel = "0";
            G.Shooting = "0";
            if (B(equals(G.Menu.item(46), "0"))) {
                this.a = G.Inventory_2.item((N(G.Inventory) + N(2)));
                yield* this.Weapon_motion((B(equals(G.Not_attack, "0")) && B(equals(G.Buff_effect.item(12), "0"))), (!B((compare(G.Inventory_2.item((N(G.Inventory) + N(3))), G.Inventory_2.item((N(G.Inventory) + N(4)))) < 0))), (B((!B((B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase())) || B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("剣").toLowerCase())))))) && B(equals(G.Scoping, "1"))), (B(this.rt.mouse.down) && B(equals(this.Mouse_touch, "Shot"))));
            }
            G.Menu.replace(10, G.X);
            G.Menu.replace(11, G.Y);
            this.Clicking = "0";
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Cloud %s" (warp)
    *Cloud(Save) {
        this.rt.pushWarp();
        try {
            // クラウド同期の本体。毎フレーム All から呼ばれる。
            // 1. 全クラウド変数（CLOUD1..10）を読み直し、レコードを G.CLOUD へ反映する。
            //    Load cloud data へは "=" + 生文字列を渡す（先頭 "=" が番兵）。
            for (let n = 1; n <= 10; n++) {
                yield* this.Load_cloud_data(S(n), S("=") + S(G.cloudGet("☁ CLOUD" + n)));
            }
            // 2. スロットごとの最終確認タイマ（Cloud check）を進める。
            //    "" は「消失を確認済み」の印。消失したのに名前が残っていたら名前だけ消す。
            //    値がある間は FPS_temp ずつ加算し、90 を超えたらレコード全体を消去して "" に戻す。
            this.a = "0";
            this.c = "0";
            const slotCount = Math.max(0, Math.floor(N(this.Cloud_check.length)));
            for (let s = 0; s < slotCount; s++) {
                this.a = N(this.a) + 1;
                const recStart = (N(this.a) - 1) * N(G.Number_of_data);
                if (B(equals(this.Cloud_check.item(this.a), ""))) {
                    if (!B(equals(G.CLOUD.item(recStart + 1), ""))) {
                        G.CLOUD.replace(recStart + 1, "");
                    }
                }
                else {
                    this.Cloud_check.replace(this.a, N(this.Cloud_check.item(this.a)) + N(G.FPS_temp));
                    if (B(compare("90", this.Cloud_check.item(this.a)) < 0)) {
                        this.b = "0";
                        const fieldCount = Math.max(0, Math.floor(N(G.Number_of_data)));
                        for (let j = 0; j < fieldCount; j++) {
                            this.b = N(this.b) + 1;
                            G.CLOUD.replace(recStart + N(this.b), "");
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.Cloud_check.replace(this.a, "");
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
            // 3. 在席プレイヤー一覧（G.IDs / G.ID_num）を CLOUD から再構築する。
            this.a = "1";
            G.IDs.deleteAll();
            G.ID_num.deleteAll();
            const recordCount = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
            for (let r = 0; r < recordCount; r++) {
                if (!B(equals(G.CLOUD.item(this.a), ""))) {
                    G.IDs.add(G.CLOUD.item(this.a));
                    G.ID_num.add(this.a);
                }
                this.a = N(this.a) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            G.Active_players = G.IDs.length;
            // 4. 発射イベントの既読管理（Players shot = [キー, 経過] の組）を進め、150 超で組ごと消す。
            this.a = "0";
            const shotPairs = Math.max(0, Math.floor(N(this.Players_shot.length) / 2));
            for (let p = 0; p < shotPairs; p++) {
                this.a = N(this.a) + 2;
                this.Players_shot.replace(this.a, N(this.Players_shot.item(this.a)) + N(G.FPS_temp));
                if (B(compare("150", this.Players_shot.item(this.a)) < 0)) {
                    for (let j = 0; j < 2; j++) {
                        this.Players_shot.delete(N(this.a) - 1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.a = N(this.a) - 2;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            // 5. 3 フレームに 1 回だけ: チームチャットの表示寿命とスキルカウンタを進める。
            if (B(equals(mod(G.Frame, 3), "0"))) {
                // Team chat = [名前, コード, 幅, 残り寿命] の 4 つ組。寿命は 3 * FPS_temp ずつ減る。
                this.a = "0";
                const chatCount = Math.max(0, Math.floor(N(this.Team_chat.length) / 4));
                for (let p = 0; p < chatCount; p++) {
                    this.a = N(this.a) + 4;
                    this.Team_chat.replace(this.a, N(this.Team_chat.item(this.a)) - N(3) * N(G.FPS_temp));
                    if (B(compare(this.Team_chat.item(this.a), "0") < 0)) {
                        for (let j = 0; j < 4; j++) {
                            this.Team_chat.delete(N(this.a) - 3);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.a = N(this.a) - 4;
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                // Skill counter = [?, ?, 残り] の 3 つ組。3 つ目が 0 未満で組ごと消す。
                this.a = "0";
                const skillCount = Math.max(0, Math.floor(N(this.Skill_counter.length) / 3));
                for (let p = 0; p < skillCount; p++) {
                    this.Skill_counter.replace(N(this.a) + 3, N(this.Skill_counter.item(N(this.a) + 3)) - N(3) * N(G.FPS_temp));
                    if (B(compare(this.Skill_counter.item(N(this.a) + 3), "0") < 0)) {
                        for (let j = 0; j < 3; j++) {
                            this.Skill_counter.delete(N(this.a) + 1);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.a = N(this.a) - 3;
                    }
                    this.a = N(this.a) + 3;
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            // 6. 通報リスト（Blocked player = [対象 "#ID", 通報者 ID の連結, 経過] の 3 つ組）。
            //    経過を進めて 9000 超で消す。在席が 5 人を超え、通報者の数が
            //    (ceil(在席/3*2) - 1) * 2 文字（= ID の個数換算）を超えたら対象を CSPID へ入れる。
            //    自分が通報した対象（Menu[85]）が成立したら Menu[87] = "1"。
            this.a = "0";
            G.Menu.replace(87, "0");
            const blockedCount = Math.max(0, Math.floor(N(G.Blocked_player.length) / 3));
            for (let p = 0; p < blockedCount; p++) {
                const base = N(this.a);
                G.Blocked_player.replace(base + 3, N(G.Blocked_player.item(base + 3)) + N(G.FPS_temp));
                if (B(compare("5", G.Active_players) < 0) &&
                    B(compare((N(mathop("ceiling", N(G.Active_players) / N(3) * N(2))) - 1) * 2, S(G.Blocked_player.item(base + 2)).length) < 0)) {
                    if (B(equals(S("#") + S(G.Menu.item(85)), G.Blocked_player.item(base + 1)))) {
                        G.Menu.replace(87, "1");
                    }
                    // 対象文字列の 2..5 文字目 = 通報した相手のプレイヤー番号
                    this.b = S(letterOf(G.Blocked_player.item(base + 1), 2)) + S(S(letterOf(G.Blocked_player.item(base + 1), 3)) + S(S(letterOf(G.Blocked_player.item(base + 1), 4)) + S(letterOf(G.Blocked_player.item(base + 1), 5))));
                    if (!B(G.CSPID.contains(this.b))) {
                        G.CSPID.add(this.b);
                    }
                }
                if (B(compare("9000", G.Blocked_player.item(base + 3)) < 0)) {
                    for (let j = 0; j < 3; j++) {
                        G.Blocked_player.delete(base + 1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.a = N(this.a) - 3;
                }
                this.a = N(this.a) + 3;
                if (!this.rt.warpActive)
                    yield;
            }
            // 7. 補間キュー（Player movement）を消費する。
            //    目標との差が 2 未満、または自分のレコードなら即確定して組ごと消す。
            //    それ以外は角度フィールド（5 / 8 / 11）は差を ±180 に丸めて 2.6 で割り、
            //    それ以外は差の半分を、FPS_temp 倍して近づける（行き過ぎ防止のクランプつき）。
            this.a = "2";
            this.b = G.ID_num.item(G.IDs.itemNum(G.ID));
            const moveCount = Math.max(0, Math.floor(N(this.Player_movement.length) / 4));
            for (let p = 0; p < moveCount; p++) {
                this.c = this.Player_movement.item(N(this.a) + 1);
                this.f = N(this.Player_movement.item(this.a)) + N(this.c);
                this.e = G.CLOUD.item(this.f);
                this.d = N(this.Player_movement.item(N(this.a) + 2)) - N(this.e);
                if (B(compare(mathop("abs", this.d), "2") < 0) || B(equals(N(this.b) - 1, this.Player_movement.item(this.a)))) {
                    G.CLOUD.replace(this.f, N(this.d) + N(this.e));
                    for (let j = 0; j < 4; j++) {
                        this.Player_movement.delete(N(this.a) - 1);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.a = N(this.a) - 4;
                }
                else {
                    if (B(equals(this.c, "5")) || B(equals(this.c, "8")) || B(equals(this.c, "11"))) {
                        this.g = N(mod(N(this.d) + 180, 360) - 180) / N(2.6);
                    }
                    else {
                        this.g = N(this.d) / N(2);
                    }
                    this.g = N(this.g) * N(G.FPS_temp);
                    if (B(compare(mathop("abs", this.d), mathop("abs", this.g)) < 0)) {
                        this.g = this.d;
                    }
                    G.CLOUD.replace(this.f, N(this.e) + N(this.g));
                }
                this.a = N(this.a) + 4;
                if (!this.rt.warpActive)
                    yield;
            }
            // 8. 自分の位置とモーションを自分のレコードへ書き戻す。
            //    モーション 7 フィールド（レコードの 5..11 番 = Motion[3..9] に対応）は
            //    差の 1/2.6 を FPS_temp 倍して追従させ、a が 4 / 7 / 10 のときは角度として ±180 に丸める。
            G.CLOUD.replace(N(this.b) + 2, G.X);
            G.CLOUD.replace(N(this.b) + 3, G.Y);
            this.a = "3";
            for (let k = 0; k < 7; k++) {
                this.a = N(this.a) + 1;
                this.c = N(this.b) + N(this.a);
                this.d = N(G.Motion.item(N(this.a) - 1)) - N(G.CLOUD.item(this.c));
                if (B(equals(this.a, "4")) || B(equals(this.a, "7")) || B(equals(this.a, "10"))) {
                    this.d = mod(N(this.d) + 180, 360) - 180;
                }
                G.CLOUD.replace(this.c, N(G.CLOUD.item(this.c)) + N(this.d) / N(2.6) * N(G.FPS_temp));
                if (!this.rt.warpActive)
                    yield;
            }
            // 9. 保存: Save が "1" で自分の ID が 4 文字のときだけ、10 本のクラウド変数から
            //    ランダムな 1 本へ Cloud data を書く（書き込み競合の分散）。
            if (B(equals(Save, "1"))) {
                if (B(equals(S(G.ID).length, "4"))) {
                    this.Temp1 = random(1, 10);
                    for (let n = 1; n <= 10; n++) {
                        if (B(equals(this.Temp1, S(n)))) {
                            G.cloudSet("☁ CLOUD" + n, G.Cloud_data);
                        }
                    }
                }
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Pick up user name [b,c] %s %s"
    *Pick_up_user_name__b_c(number, data) {
        // 名前コードの復号: 2 桁コード ×2 + 末尾 1 文字で最大 3 文字の名前になる。
        // コード "00" は "="（詰め物）、それ以外はコスチューム (コード - 10) 番の
        // 名前の 6 文字目が復号文字（Create user ID の符号化と対）。
        // number が "b" のときは現在のカーソル b の続きから、数値ならその位置から読む。
        // 結果は c、カーソルは b に残る。
        this.b = N(this.b) - 1;
        if (!B(equals(number, "b"))) {
            this.b = number;
        }
        this.c = "";
        for (let i = 0; i < 2; i++) {
            const pair = S(letterOf(data, N(this.b) + 1)) + S(letterOf(data, N(this.b) + 2));
            if (B(equals(pair, "00"))) {
                this.c = S(this.c) + "=";
            }
            else {
                this.switchCostume(N(pair) - 10);
                this.c = S(this.c) + S(letterOf(this.costumeNumberName("name"), 6));
            }
            this.b = N(this.b) + 2;
            if (!this.rt.warpActive)
                yield;
        }
        this.c = S(this.c) + S(letterOf(data, N(this.b) + 1));
    }
    // procedure: "Button"
    *Button() {
        // 入力処理の本体。Draw UI が決めた Mouse_touch / Touch を読んで状態を書き換える。
        // 押し続け（ロッカーのスクロールとドラッグ）、ドラッグ終了時のドロップ、
        // クリック（Clicking == "1"、スクリプト側で立てる）の 3 種類を扱う
        if (B(this.rt.mouse.down)) {
            if (B(equals(this.Mouse_touch, "Locker camera1 right"))) {
                G.Menu.replace(26, (N(G.Menu.item(26)) + N((N(15) * N(G.FPS_temp)))));
            }
            if (B(equals(this.Mouse_touch, "Locker camera1 left"))) {
                G.Menu.replace(26, (N(G.Menu.item(26)) - N((N(15) * N(G.FPS_temp)))));
                if (B((compare(G.Menu.item(26), "0") < 0))) {
                    G.Menu.replace(26, "0");
                }
            }
            if (B(equals(this.Mouse_touch, "Locker camera2 right"))) {
                G.Menu.replace(27, (N(G.Menu.item(27)) + N((N(15) * N(G.FPS_temp)))));
            }
            if (B(equals(this.Mouse_touch, "Locker camera2 left"))) {
                G.Menu.replace(27, (N(G.Menu.item(27)) - N((N(15) * N(G.FPS_temp)))));
                if (B((compare(G.Menu.item(27), "0") < 0))) {
                    G.Menu.replace(27, "0");
                }
            }
            if (B(equals(this.Drag_touch, ""))) {
                this.Drag_touch = this.Mouse_touch;
                if (B((B(equals(this.Drag_touch, "Character display")) || B((B(equals(this.Drag_touch, "Mobile control drag")) || B(equals(this.Drag_touch, "Mobile command drag"))))))) {
                    this.Drag_x = this.rt.mouse.x;
                    this.Drag_y = this.rt.mouse.y;
                }
                if (B(equals(this.Drag_touch, "Inventory weapon"))) {
                    this.Drag_x = G.Inventory_2.item(this.Touch);
                    this.Drag_y = this.Touch;
                    G.Inventory_2.replace(this.Touch, "");
                    G.Inventory_2.replace((N(this.Touch) + N(1)), "");
                    G.Inventory_2.replace((N(this.Touch) + N(2)), "0");
                    G.Inventory_2.replace((N(this.Touch) + N(3)), "0");
                    G.Inventory_2.replace((N(this.Touch) + N(4)), "0");
                    G.Inventory_2.replace((N(this.Touch) + N(5)), "0");
                }
                if (B(equals(this.Drag_touch, "Got weapon"))) {
                    this.Drag_x = G.Got_weapon.item(this.Touch);
                }
            }
            else {
                if (B(equals(this.Drag_touch, "Character display"))) {
                    if (B(equals(G.Menu.item(19), "3"))) {
                        G.Menu.replace(27, (N(G.Menu.item(27)) + N((N(this.Drag_x) - N(this.rt.mouse.x)))));
                        G.Menu.replace(31, (N(G.Menu.item(31)) + N((N(this.Drag_y) - N(this.rt.mouse.y)))));
                        this.Drag_x = this.rt.mouse.x;
                        this.Drag_y = this.rt.mouse.y;
                    }
                }
                if (B(equals(this.Drag_touch, "Mobile control drag"))) {
                    G.Mobile_2.replace(1, (N(G.Mobile_2.item(1)) + N((N(this.rt.mouse.x) - N(this.Drag_x)))));
                    G.Mobile_2.replace(2, (N(G.Mobile_2.item(2)) + N((N(this.rt.mouse.y) - N(this.Drag_y)))));
                    this.Drag_x = this.rt.mouse.x;
                    this.Drag_y = this.rt.mouse.y;
                }
                if (B(equals(this.Drag_touch, "Mobile command drag"))) {
                    G.Mobile_2.replace(3, (N(G.Mobile_2.item(3)) + N((N(this.rt.mouse.x) - N(this.Drag_x)))));
                    G.Mobile_2.replace(4, (N(G.Mobile_2.item(4)) + N((N(this.rt.mouse.y) - N(this.Drag_y)))));
                    this.Drag_x = this.rt.mouse.x;
                    this.Drag_y = this.rt.mouse.y;
                }
            }
        }
        else {
            if (B((!B(equals(this.Drag_touch, ""))))) {
                if (B(equals(this.Mouse_touch, "Inventory weapon"))) {
                    if (B((!B(equals(this.Drag_x, ""))))) {
                        this.rt.soundPlay("dd9e476450d39ece7af0777414c13cd7.wav");
                        if (B(equals(this.Drag_touch, "Inventory weapon"))) {
                            if (B((!B(equals(G.Inventory_2.item(this.Touch), ""))))) {
                                yield* this.Set_inventory__T1__T2__T3((N(this.Drag_y) - N(1)), G.Inventory_2.item(this.Touch));
                            }
                        }
                        else {
                            if (B(equals(G.Menu.item(19), "5"))) {
                                this.a = G.Inventory_2.item(this.Touch);
                                if (B((!B(equals(this.a, ""))))) {
                                    this.b = G.Got_weapon.itemNum(this.a);
                                    if (B((compare(G.Menu.item(25), this.b) < 0))) {
                                        G.Got_weapon.insert(this.a, (N(G.Menu.item(25)) + N(1)));
                                    }
                                    else {
                                        G.Got_weapon.insert(this.a, 1);
                                    }
                                    G.Got_weapon.delete((N(this.b) + N(1)));
                                }
                            }
                        }
                        yield* this.Set_inventory__T1__T2__T3((N(this.Touch) - N(1)), this.Drag_x);
                    }
                }
                else {
                    if (B(equals(G.Menu.item(19), "5"))) {
                        if (B(equals(this.Drag_touch, "Inventory weapon"))) {
                            this.a = this.Drag_x;
                            if (B((!B(equals(this.a, ""))))) {
                                this.b = G.Got_weapon.itemNum(this.a);
                                if (B((compare(G.Menu.item(25), this.b) < 0))) {
                                    G.Got_weapon.insert(this.a, (N(G.Menu.item(25)) + N(1)));
                                }
                                else {
                                    G.Got_weapon.insert(this.a, 1);
                                }
                                G.Got_weapon.delete((N(this.b) + N(1)));
                            }
                        }
                    }
                }
                this.Drag_touch = "";
                this.Drag_x = "";
                this.Drag_y = "";
            }
        }
        if (B((B((B(equals(this.Clicking, "1")) && B(equals(this.Mouse_touch, "First UI next")))) || B((compare("0", mathop("abs", this.Mouse_wheel)) < 0))))) {
            if (B((compare(G.Menu.item(50), "2") < 0))) {
                this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                G.Menu.replace(50, (N(G.Menu.item(50)) + N(1)));
                if (B(equals(G.Menu.item(50), "2"))) {
                    if (B((B((compare(this.Starter.item((N(this.Starter.length) - N(1))), "4") < 0)) && B((compare(this.Starter.item("last"), (N(this.Starter.itemNum("")) + N(4))) < 0))))) {
                        yield* this.Put_buff("スタートダッシュ", "5400");
                        G.Money = N(G.Money) + N(8);
                    }
                    G.Got_weapon.add(this.Starter.item(this.Starter.item((N(this.Starter.length) - N(1)))));
                    G.Got_weapon.add(this.Starter.item(this.Starter.item("last")));
                    yield* this.Set_inventory__T1__T2__T3("0", G.Got_weapon.item(1));
                    yield* this.Set_inventory__T1__T2__T3("6", G.Got_weapon.item(2));
                    G.Menu.replace(110, (N(1) - N((N(equals(this.Mouse_wheel, "-1")) * N(2)))));
                }
            }
        }
        if (B(equals(this.Clicking, "1"))) {
            if (B(equals(G.開発者ツール, "1"))) {
                this.a = Math.round(N((N((N(G.X) + N((N(G.Camera_x) + N((N(this.rt.mouse.x) / N(G.Zoom_temp))))))) / N(50))));
                this.b = Math.round(N((N((N(G.Y) + N((N(G.Camera_y) + N((N(this.rt.mouse.y) / N(G.Zoom_temp))))))) / N(50))));
                if (B(G.Wall___object.contains((S(this.a) + S((S("/") + S(this.b))))))) {
                    this.a = G.Wall___object.itemNum((S(this.a) + S((S("/") + S(this.b)))));
                    for (let i = 0; i < 7; i++) {
                        G.Wall___object.delete(this.a);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    G.Wall___object.add((S(this.a) + S((S("/") + S(this.b)))));
                    G.Wall___object.add(G.開発者ツール_オブジェクト);
                    G.Wall___object.add(this.a);
                    G.Wall___object.add(this.b);
                    if (B((B(equals(G.開発者ツール_オブジェクト, "19")) || B(equals(G.開発者ツール_オブジェクト, "22"))))) {
                        G.Wall___object.add((N(Math.round(N((N(G.Motion.item(3)) / N(45))))) * N(45)));
                    }
                    else {
                        G.Wall___object.add("0");
                    }
                    G.Wall___object.add("0");
                    G.Wall___object.add("0");
                }
            }
            else {
                // スポーン確定: ワープ先へ移動してリスポーン扱い（体力・記録リセット）
                if (B(equals(this.Mouse_touch, "Spawn area"))) {
                    if (B((compare(G.Menu.item(92), "0") < 0))) {
                        this.rt.soundPlay("ca59bd66b9a2dd04c17bd3658227b194.wav");
                        this.rt.broadcast(S("Warp"));
                        G.X = G.Menu.item(3);
                        G.Y = G.Menu.item(4);
                        G.Health = G.Max_health;
                        G.Shield = "0";
                        G.Health_timer = "0";
                        G.Kill_counter = "0";
                        this.Kill_point = "0";
                        this.Match_damage = "0";
                        G.Menu.replace(6, "3");
                        G.Menu.replace(7, "100");
                        G.Menu.replace(8, "999");
                        yield* this.Put_buff("平和", "90");
                        yield* this.Add_combat_data("Run", "", "");
                    }
                }
                if (B(equals(this.Mouse_touch, "Turret shot"))) {
                    if (B(equals(G.Object_trigger, "0000000"))) {
                        this.rt.soundPlay("afa5096b7ff0fdfd493c56f5ac46aed5.wav");
                        G.Object_trigger = this.Touch;
                    }
                }
                if (B(S(this.Mouse_touch).toLowerCase().includes(S("Inventory mode").toLowerCase()))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Shield = "0";
                    G.Health_timer = "0";
                    this.a = letterOf(this.Mouse_touch, S(this.Mouse_touch).length);
                    this.Inventory_mode.replace(1, this.a);
                    if (B((!B(equals(this.Inventory_mode.item((N(this.a) + N(1))), ""))))) {
                        G.Character = (N(this.Inventory_mode.item((N(this.a) + N(1)))) * N(15));
                        G.Special_skin = this.Inventory_mode.item((N(this.a) + N(4)));
                        G.Inventory_2.deleteAll();
                        this.b = (N(7) + N((N((N(this.a) - N(1))) * N(30))));
                        for (let i = 0; i < 30; i++) {
                            this.b = N(this.b) + N(1);
                            G.Inventory_2.add(this.Inventory_mode.item(this.b));
                            if (!this.rt.warpActive)
                                yield;
                        }
                        G.Inventory_2.add("1");
                    }
                }
                if (B(equals(this.Mouse_touch, "Player profile"))) {
                    if (B(equals(G.Menu.item(19), "0"))) {
                        this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                        G.Menu.replace(19, this.Touch);
                    }
                }
                if (B(equals(this.Mouse_touch, "Close profile"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(19, "0");
                }
                if (B(equals(this.Mouse_touch, "Mobile stick"))) {
                    if (B((compare(this.Touch, "10") < 0))) {
                        G.Mobile_2.replace(12, "0");
                        G.Mobile_2.replace(13, "0");
                        G.Mobile_2.replace(5, "-");
                    }
                    else {
                        G.Mobile_2.replace(12, (N((N(this.rt.mouse.x) + N(39))) - N(G.Mobile_2.item(1))));
                        G.Mobile_2.replace(13, (N((N(this.rt.mouse.y) + N(5))) - N(G.Mobile_2.item(2))));
                        G.Mobile_2.replace(5, (N(mathop("atan", (N(G.Mobile_2.item(12)) / N(G.Mobile_2.item(13))))) + N((N((compare(G.Mobile_2.item(13), "0") < 0)) * N(180)))));
                    }
                }
                if (B(equals(this.Mouse_touch, "Mobile on/off"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    if (B(equals(G.Mobile, "0"))) {
                        G.Mobile = "1";
                    }
                    else {
                        G.Mobile = "0";
                    }
                }
                if (B(equals(this.Mouse_touch, "Chat menu"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(63, (N(this.Touch) - N(1)));
                    G.Menu.replace(91, "0");
                }
                if (B(equals(this.Mouse_touch, "Chat button"))) {
                    G.Menu.replace(61, "0");
                    this.Chat = (S(G.Menu.item(63)) + S(this.Touch));
                }
                if (B(equals(this.Mouse_touch, "Chat page"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    if (B(equals(G.Menu.item(91), "0"))) {
                        G.Menu.replace(91, "1");
                    }
                    else {
                        G.Menu.replace(91, "0");
                    }
                }
                if (B(equals(this.Mouse_touch, "Teammate marking"))) {
                    if (B(equals(G.Menu.item(114), this.Touch))) {
                        G.Menu.replace(114, "0");
                    }
                    else {
                        G.Menu.replace(114, this.Touch);
                    }
                }
                if (B(equals(this.Mouse_touch, "Pet page right"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    if (B((compare(G.Menu.item(25), (N(G.Menu.item(88)) - N(1))) < 0))) {
                        G.Menu.replace(25, (N(G.Menu.item(25)) + N(1)));
                        if (B((B((!B(equals(G.Menu.item(89), "0")))) && B(equals((N(G.Menu.item(25)) + N(1)), G.Menu.item(88)))))) {
                            G.Menu.replace(25, G.Menu.item(89));
                        }
                    }
                    else {
                        G.Menu.replace(25, "0");
                    }
                }
                if (B(equals(this.Mouse_touch, "Pet page left"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    if (B((compare("0", G.Menu.item(25)) < 0))) {
                        if (B((B((!B(equals(G.Menu.item(89), "0")))) && B(equals(G.Menu.item(25), G.Menu.item(89)))))) {
                            G.Menu.replace(25, (N(G.Menu.item(88)) - N(2)));
                        }
                        else {
                            G.Menu.replace(25, (N(G.Menu.item(25)) - N(1)));
                        }
                    }
                    else {
                        if (B(equals(G.Menu.item(89), "0"))) {
                            G.Menu.replace(25, (N(G.Menu.item(88)) - N(1)));
                        }
                        else {
                            G.Menu.replace(25, G.Menu.item(89));
                        }
                    }
                }
                if (B(equals(this.Mouse_touch, "Pet page button"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(25, this.Touch);
                }
                if (B(equals(this.Mouse_touch, "Pet buy"))) {
                    this.rt.soundPlay("d3d5c269f9e37590ac35c76640452f6d.wav");
                    G.Money = N(G.Money) + N((N(0) - N(G.Pet_data.item((N((N(G.Menu.item(25)) * N(10))) + N(2))))));
                    G.Pet_data.replace((N((N(G.Menu.item(25)) * N(10))) + N(3)), "1");
                }
                if (B(equals(this.Mouse_touch, "Pet remove"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Select_pet = "-1";
                }
                if (B(equals(this.Mouse_touch, "Pet set"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Select_pet = G.Menu.item(25);
                }
                if (B(equals(this.Mouse_touch, "Computer right"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(96, (N(G.Menu.item(96)) + N(1)));
                    if (B((compare("4", G.Menu.item(96)) < 0))) {
                        G.Menu.replace(96, "0");
                    }
                }
                if (B(equals(this.Mouse_touch, "Computer left"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(96, (N(G.Menu.item(96)) - N(1)));
                    if (B((compare(G.Menu.item(96), "0") < 0))) {
                        G.Menu.replace(96, "4");
                    }
                }
                if (B(equals(this.Mouse_touch, "First UI weapon"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    if (B((compare(this.Touch, this.Starter.itemNum("")) < 0))) {
                        this.Starter.replace((N(this.Starter.length) - N(1)), this.Touch);
                    }
                    else {
                        this.Starter.replace("last", this.Touch);
                    }
                }
                if (B(equals(this.Mouse_touch, "Character info start"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(76, "1");
                }
                if (B(equals(this.Mouse_touch, "Character info"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    if (B((compare("0", this.rt.mouse.x) < 0))) {
                        G.Menu.replace(76, (N(G.Menu.item(76)) + N(1)));
                    }
                    else {
                        G.Menu.replace(76, (N(G.Menu.item(76)) - N(1)));
                    }
                    if (B((compare(G.Menu.item(76), "1") < 0))) {
                        G.Menu.replace(76, "1");
                    }
                    if (B((compare("12", G.Menu.item(76)) < 0))) {
                        G.Menu.replace(76, "-1");
                    }
                }
                if (B(equals(this.Mouse_touch, "Character change page"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    if (B(equals(G.Menu.item(25), "1"))) {
                        G.Menu.replace(25, "2");
                    }
                    else {
                        G.Menu.replace(25, "1");
                    }
                }
                if (B(equals(this.Mouse_touch, "Character special skin"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    if (B(equals(G.Special_skin, "0"))) {
                        G.Special_skin = "1";
                    }
                    else {
                        G.Special_skin = "0";
                    }
                }
                if (B(equals(this.Mouse_touch, "Character set"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Character = (N((N(this.Touch) / N(10))) * N(15));
                    G.Special_skin = "0";
                    G.Shield = "0";
                    G.Health_timer = "0";
                }
                // 購入: ショップ画面が開いている（Menu[20] が 160）ときだけ。
                // 通貨は "6" 面が Tektite、それ以外は Money。買った武器名は this.c 経由で
                // Got_weapon の先頭へ入れ、Set weapon が装備まで面倒を見る
                if (B(equals(this.Mouse_touch, "Shop buy"))) {
                    if (B(equals(Math.round(N(G.Menu.item(20))), "160"))) {
                        if (B(equals(G.Menu.item(19), "6"))) {
                            this.Temp1 = (N(G.Tektite) + N(1));
                        }
                        else {
                            this.Temp1 = (N(G.Money) + N(1));
                        }
                        if (B((compare(this.Touch, this.Temp1) < 0))) {
                            this.rt.soundPlay("d3d5c269f9e37590ac35c76640452f6d.wav");
                            if (B(equals(G.Menu.item(19), "6"))) {
                                G.Tektite = N(G.Tektite) + N((N(0) - N(this.Touch)));
                            }
                            else {
                                G.Money = N(G.Money) + N((N(0) - N(this.Touch)));
                            }
                            this.c = G.Shop_menu.item(G.Menu.item(26));
                            G.Got_weapon.insert(this.c, 1);
                            yield* this.Set_weapon();
                        }
                    }
                }
                // 装備中（Inventory_2 に同名がある）なら 6 フィールドを消して外し、
                // 未装備なら this.c に名前を置いて Set weapon で装備する
                if (B(equals(this.Mouse_touch, "Shop set"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    this.a = G.Shop_menu.item(G.Menu.item(26));
                    if (B(G.Inventory_2.contains(this.a))) {
                        this.a = G.Inventory_2.itemNum(this.a);
                        G.Inventory_2.replace(this.a, "");
                        G.Inventory_2.replace((N(this.a) + N(1)), "");
                        G.Inventory_2.replace((N(this.a) + N(2)), "0");
                        G.Inventory_2.replace((N(this.a) + N(3)), "0");
                        G.Inventory_2.replace((N(this.a) + N(4)), "0");
                        G.Inventory_2.replace((N(this.a) + N(5)), "0");
                    }
                    else {
                        this.c = this.a;
                        yield* this.Set_weapon();
                    }
                }
                if (B(equals(this.Mouse_touch, "Shop scroll bar"))) {
                    G.Menu.replace(33, this.rt.mouse.y);
                    G.Menu.replace(34, G.Menu.item(28));
                }
                if (B(equals(this.Mouse_touch, "Shop weapon"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Menu.replace(26, this.Touch);
                }
                // ページ切替: ページ番号を Touch に変えた後、そのページの先頭項目を
                // Menu[26]/[27] にそろえる。先頭の探し方は武器店（"1"）が Shop_menu 先頭から
                // "Bomb" までの "" の数、サブ店は "Bomb" 以降の "" の数で数える
                if (B(equals(this.Mouse_touch, "Shop page button"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Menu.replace(25, this.Touch);
                    if (B(equals(G.Menu.item(19), "1"))) {
                        this.a = "0";
                        this.b = "0";
                        while (!B(equals(G.Shop_menu.item(this.a), "Bomb"))) {
                            this.a = N(this.a) + N(1);
                            if (B(equals(G.Shop_menu.item((N(this.a) - N(1))), ""))) {
                                this.b = N(this.b) + N(1);
                                if (B(equals(this.b, G.Menu.item(25)))) {
                                    this.c = this.a;
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        this.a = (N(G.Shop_menu.itemNum("Bomb")) - N(1));
                        this.b = "0";
                        const seps = Math.max(0, Math.floor(N((N(G.Shop_menu.length) - N(this.a)))));
                        for (let r = 0; r < seps; r++) {
                            this.a = N(this.a) + N(1);
                            if (B(equals(G.Shop_menu.item((N(this.a) - N(1))), ""))) {
                                this.b = N(this.b) + N(1);
                                if (B(equals(this.b, G.Menu.item(25)))) {
                                    this.c = this.a;
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    G.Menu.replace(26, this.c);
                    G.Menu.replace(27, this.c);
                    G.Menu.replace(28, "0");
                }
                if (B((B(equals(this.Mouse_touch, "Shop page right")) || B(equals(this.Mouse_touch, "Shop page left"))))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    // ページ送り（右/左）: 番号を進めて範囲外は巻き戻し（武器店は Menu[29]、
                    // サブ店は Menu[30] がページ数）、先頭項目の探し方はページ切替と同じ
                    if (B(equals(this.Mouse_touch, "Shop page right"))) {
                        G.Menu.replace(25, (N(G.Menu.item(25)) + N(1)));
                    }
                    else {
                        G.Menu.replace(25, (N(G.Menu.item(25)) - N(1)));
                    }
                    if (B(equals(G.Menu.item(19), "1"))) {
                        if (B(equals(this.Mouse_touch, "Shop page right"))) {
                            if (B((compare(G.Menu.item(29), G.Menu.item(25)) < 0))) {
                                G.Menu.replace(25, "1");
                            }
                        }
                        else {
                            if (B((compare(G.Menu.item(25), "1") < 0))) {
                                G.Menu.replace(25, G.Menu.item(29));
                            }
                        }
                        this.a = "0";
                        this.b = "0";
                        while (!B(equals(G.Shop_menu.item(this.a), "Bomb"))) {
                            this.a = N(this.a) + N(1);
                            if (B(equals(G.Shop_menu.item((N(this.a) - N(1))), ""))) {
                                this.b = N(this.b) + N(1);
                                if (B(equals(this.b, G.Menu.item(25)))) {
                                    this.c = this.a;
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        if (B(equals(this.Mouse_touch, "Shop page right"))) {
                            if (B((compare(G.Menu.item(30), G.Menu.item(25)) < 0))) {
                                G.Menu.replace(25, "1");
                            }
                        }
                        else {
                            if (B((compare(G.Menu.item(25), "1") < 0))) {
                                G.Menu.replace(25, G.Menu.item(30));
                            }
                        }
                        this.a = (N(G.Shop_menu.itemNum("Bomb")) - N(1));
                        this.b = "0";
                        const seps = Math.max(0, Math.floor(N((N(G.Shop_menu.length) - N(this.a)))));
                        for (let r = 0; r < seps; r++) {
                            this.a = N(this.a) + N(1);
                            if (B(equals(G.Shop_menu.item((N(this.a) - N(1))), ""))) {
                                this.b = N(this.b) + N(1);
                                if (B(equals(this.b, G.Menu.item(25)))) {
                                    this.c = this.a;
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    G.Menu.replace(26, this.c);
                    G.Menu.replace(27, this.c);
                    G.Menu.replace(28, "0");
                }
                // チーム設定の値エンコーディングは bit0=Private、bit1=スキルON。
                // Touch == "1" が自チーム（Team_menu）、それ以外は Menu[42]（他チーム/作成中）
                if (B(equals(this.Mouse_touch, "Turn on team skill"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    if (B(equals(this.Touch, "1"))) {
                        if (B(equals(mod(G.Team_menu, 2), "0"))) {
                            G.Team_menu = "2";
                        }
                        else {
                            G.Team_menu = "3";
                        }
                    }
                    else {
                        if (B(equals(mod(G.Menu.item(42), 2), "0"))) {
                            G.Menu.replace(42, "2");
                        }
                        else {
                            G.Menu.replace(42, "3");
                        }
                    }
                }
                if (B(equals(this.Mouse_touch, "Turn off team skill"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    if (B(equals(this.Touch, "1"))) {
                        if (B(equals(mod(G.Team_menu, 2), "0"))) {
                            G.Team_menu = "0";
                        }
                        else {
                            G.Team_menu = "1";
                        }
                    }
                    else {
                        if (B(equals(mod(G.Menu.item(42), 2), "0"))) {
                            G.Menu.replace(42, "0");
                        }
                        else {
                            G.Menu.replace(42, "1");
                        }
                    }
                }
                if (B(equals(this.Mouse_touch, "Change team type"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    if (B(equals(this.Touch, "1"))) {
                        if (B((compare(G.Team_menu, "2") < 0))) {
                            if (B(equals(mod(G.Team_menu, 2), "0"))) {
                                G.Team_menu = "1";
                            }
                            else {
                                G.Team_menu = "0";
                            }
                        }
                        else {
                            if (B(equals(mod(G.Team_menu, 2), "0"))) {
                                G.Team_menu = "3";
                            }
                            else {
                                G.Team_menu = "2";
                            }
                        }
                    }
                    else {
                        if (B((compare(G.Menu.item(42), "2") < 0))) {
                            if (B(equals(mod(G.Menu.item(42), 2), "0"))) {
                                G.Menu.replace(42, "1");
                            }
                            else {
                                G.Menu.replace(42, "0");
                            }
                        }
                        else {
                            if (B(equals(mod(G.Menu.item(42), 2), "0"))) {
                                G.Menu.replace(42, "3");
                            }
                            else {
                                G.Menu.replace(42, "2");
                            }
                        }
                    }
                }
                if (B((B(equals(this.Mouse_touch, "About team")) || B(equals(this.Mouse_touch, "Change color"))))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.Menu.replace(40, this.Touch);
                }
                if (B(equals(this.Mouse_touch, "Back team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.Menu.replace(40, "0");
                }
                if (B(equals(this.Mouse_touch, "Make team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.Team_color = G.Menu.item(40);
                    G.Team_menu = G.Menu.item(42);
                    G.Menu.replace(40, "0");
                    G.Menu.replace(43, "3600");
                }
                if (B((B(equals(this.Mouse_touch, "Join team")) || B(equals(this.Mouse_touch, "Confirm invitation"))))) {
                    if (B(equals(this.Mouse_touch, "Join team"))) {
                        this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    }
                    else {
                        this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    }
                    G.Team_ID = G.CLOUD.item((N(this.Touch) + N(11)));
                    G.Team_color = G.CLOUD.item((N(this.Touch) + N(27)));
                    G.Menu.replace(40, "0");
                    G.Menu.replace(112, "0");
                }
                if (B(equals(this.Mouse_touch, "Send invitation"))) {
                    this.rt.soundPlay("0bf59908f1bb1b945feca0669f19dbb1.wav");
                    G.Menu.replace(111, G.Menu.item(19));
                }
                if (B(equals(this.Mouse_touch, "Ignore invitation"))) {
                    this.rt.soundPlay("3a89da68f158134b2d8d9672d6345026.wav");
                    G.Ignored_invitation.add(G.Menu.item(112));
                    G.Menu.replace(112, "0");
                }
                if (B(equals(this.Mouse_touch, "Leave team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.Team_ID = G.ID;
                    G.Team_color = "0";
                    G.Menu.replace(40, "0");
                }
                // 作成開始: チーム一覧（5 件組）のリーダー行から各チームのカラー
                // （相手レコード field 27）を Temp1_2 に印し、空いている最初のカラーを Menu[40] へ
                if (B(equals(this.Mouse_touch, "New team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    this.Temp1_2.deleteAll();
                    for (let i = 0; i < 8; i++) {
                        this.Temp1_2.add("0");
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.a = "1";
                    for (let i = 0; i < 5; i++) {
                        if (B(equals(letterOf(G.Team.item(this.a), 1), "2"))) {
                            this.Temp1_2.replace(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum((N(G.Team.item(this.a)) - N(20000))))) + N(27))), "1");
                        }
                        this.a = N(this.a) + N(5);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    G.Menu.replace(40, this.Temp1_2.itemNum("0"));
                }
                if (B(equals(this.Mouse_touch, "Red team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.TEAMMODE_2.replace(6, "1");
                }
                if (B(equals(this.Mouse_touch, "Blue team"))) {
                    this.rt.soundPlay("6fcd835bc0a7b83947a54e7ce3392b04.wav");
                    G.TEAMMODE_2.replace(6, "2");
                }
                if (B(equals(this.Mouse_touch, "Report player"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    G.Menu.replace(85, G.Menu.item(16));
                }
                // ブロック切替: Menu[85] が "0000" なら対象（Menu[16]）を入れ、他は "0000" に戻す
                if (B(equals(this.Mouse_touch, "Player block"))) {
                    this.rt.soundPlay("34573c1f70d1d62826c1eefde526d9fd.wav");
                    if (B(equals(G.Menu.item(85), "0000"))) {
                        G.Menu.replace(85, G.Menu.item(16));
                    }
                    else {
                        G.Menu.replace(85, "0000");
                    }
                }
            }
        }
        if (B(equals(Math.round(N(G.Menu.item(20))), "160"))) {
            if (B((B(this.rt.mouse.down) && B((!B(equals(G.Menu.item(33), ""))))))) {
                G.Menu.replace(28, (N(G.Menu.item(34)) + N((N((N(this.rt.mouse.y) - N(G.Menu.item(33)))) * N(4)))));
            }
            else {
                G.Menu.replace(33, "");
            }
        }
    }
    // procedure: "Pen mode"
    *Pen_mode() {
        // ペン描画用のコスチュームに戻す。size = 1/0 = Infinity は原作の常套で、
        // スタンプ系の前後に挟んで描画状態をリセットする役割。
        this.switchCostume("Pen");
        this.size = N((N(1) / N(0)));
    }
    // procedure: "Load cloud data %s %s"
    *Load_cloud_data(number, v_var) {
        // クラウド変数 number の内容（"=" + 数字文字列）を解読し、G.CLOUD へ反映する。
        // G.DATA と一致する（変更なし）場合は即 return。解読結果は Pickupped に積まれ、
        // レコードとして配置・マージされる。レコードは 62 フィールド構成で、
        // G.Cloud_memo のフィールド名一覧と一致する（59=Combat Power, 60=MVP rec,
        // 61=Team score dif, 62=User name）。G.Number_of_data は起動時に Set val が
        // Cloud_memo の長さ（62）へ設定する（globals の初期値 59 は起動前の仮値）。
        //
        // ワイヤ形式（"=" の後ろ、デコード順）:
        //   ID(4) seq(5) version(1) X(4) Y(4) motion(3×7) Team_ID(4) f13(4)
        //   shots(7×9) f15(2) f16(1) f17(3) f18(1) f19(2) hits(9×6)
        //   f21(4) f22(4) f23(2) f24(3) f25..29(1×5) f30(3) f31(4) f32(7) f33(1)
        //   chat(2) skillType(2) skillVal(4) f44(1) f45(1) f47..49(3×3) f50(3)
        //   f52(1) f53(1) f54(2) f55(2) f56(4) f61(3) name(5)
        // Pickupped の主な項目: 1=ID, 2=seq, 3=X(-5000), 4=Y(-5000), 5..11=motion(-500),
        //   12=Team_ID, 13(-1000), 14=最後の発射文字列, 15=(v-10)*15, 17(-100), 19(+1),
        //   20=最後の被弾文字列, 21/22(-2000), 23(×Buff[10]), 24=(-100)/100, 30(-100),
        //   34=チャットコード, 35..43=スキル節（"-" 詰め）, 46/51/57..60=Static data 経由,
        //   61(-550), 62=表示名（復号済み）
        if (B(equals(v_var, G.DATA.item(number)))) {
            return;
        }
        G.DATA.replace(number, v_var);
        this.Pickupped.deleteAll();
        this.b = "2";
        // [1] プレイヤー ID。ついでに送信者の既存レコード位置（senderBase）と
        // 名前フィールド（IDX = 59 番）を引いておく
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Pickupped.add(this.c);
        const senderId = this.Pickupped.item(1);
        const senderBase = N(G.ID_num.item(G.IDs.itemNum(senderId)));
        this.IDX = G.CLOUD.item(senderBase + (N(G.Number_of_data) - 1));
        // [2] シーケンス番号。在席中なら前回値との差（±45000 でラップ）で鮮度を判定し、
        // 進んでいなければ棄却する（再送・遅延パケット対策）
        yield* this.Pick_up_data__b_c("5", v_var);
        this.Pickupped.add(this.c);
        if (B(G.IDs.contains(senderId))) {
            this.IDY = mod(N(this.Pickupped.item(2)) - N(G.CLOUD.item(senderBase + 1)) + 45000, 89999) - 45000;
            if (B(compare(this.IDY, "1") < 0)) {
                return;
            }
        }
        // バージョン（保存しない）。不一致なら打ち切り
        yield* this.Pick_up_data__b_c("1", v_var);
        if (!B(equals(this.c, G.Version))) {
            return;
        }
        // [3][4] X / Y
        for (let k = 0; k < 2; k++) {
            yield* this.Pick_up_data__b_c("4", v_var);
            this.Pickupped.add(N(this.c) - 5000);
            if (!this.rt.warpActive)
                yield;
        }
        // [5..11] モーション 7 つ
        for (let k = 0; k < 7; k++) {
            yield* this.Pick_up_data__b_c("3", v_var);
            this.Pickupped.add(N(this.c) - 500);
            if (!this.rt.warpActive)
                yield;
        }
        // [12] Team_ID
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Pickupped.add(this.c);
        // 棄却ゲート: 送信者が CSPID 入り / 自分の通報対象として成立済み /
        // 既存レコードの 58 番（日付）が 2 桁で今日と違う、のいずれかなら反映しない
        this.d = G.CLOUD.item(senderBase + 57);
        if (B(G.CSPID.contains(senderId)) ||
            (B(equals(this.c, G.Menu.item(85))) && B(equals(G.Menu.item(87), "1"))) ||
            (B(equals(S(this.d).length, "2")) && !B(equals(this.d, G.Date)))) {
            return;
        }
        // [13]
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Pickupped.add(N(this.c) - 1000);
        // 発射イベントの処理可否フラグ i: 送信者の名前フィールドに "!" を含む（特殊状態）か
        // 通報成立済みの相手なら 1 になり、発射は処理されない
        this.d = "";
        this.i = N(B(S(G.CLOUD.item(senderBase + (N(G.Number_of_data) - 1))).toLowerCase().includes("!") ||
            (B(equals(senderId, G.Menu.item(85))) && B(equals(G.Menu.item(87), "1")))));
        // 発射イベント ×9（7 文字のパック形式）。既読は Players shot で管理する。
        // 先頭が "7" なら投擲・特殊武器（チャージ=2..4 文字目、武器=5..7 文字目 - 100）、
        // それ以外は通常武器（チャージ=6..7 文字目、武器コード=1..3 文字目、700 未満なら
        // Weapon リストで名前へ変換）。どちらも BU（連射検出ログ）へ記録し Player shot を呼ぶ。
        for (let s = 0; s < 9; s++) {
            yield* this.Pick_up_data__b_c("7", v_var);
            if (B(equals(this.i, "0"))) {
                if (!B(equals(this.c, "0000000"))) {
                    this.d = S(senderId) + S(this.c);
                    if (!B(this.Players_shot.contains(this.d))) {
                        this.Players_shot.add(this.d);
                        this.Players_shot.add("0");
                        if (!B(G.CSPID.contains(senderId)) && !B(G.CSPID.contains(this.IDX))) {
                            if (B(equals(letterOf(this.c, 1), "7"))) {
                                this.f = "2";
                                G.Charge = S(letterOf(this.c, 2)) + S(S(letterOf(this.c, 3)) + S(letterOf(this.c, 4)));
                                this.c = N(S(letterOf(this.c, 5)) + S(S(letterOf(this.c, 6)) + S(letterOf(this.c, 7)))) - 100;
                                G.BU.add(senderId);
                                G.BU.add(this.IDX);
                                G.BU.add("weapon");
                            }
                            else {
                                this.f = "0";
                                G.Charge = S(letterOf(this.c, 6)) + S(letterOf(this.c, 7));
                                this.c = S(letterOf(this.c, 1)) + S(S(letterOf(this.c, 2)) + S(letterOf(this.c, 3)));
                                if (B(compare(this.c, "700") < 0)) {
                                    this.c = G.Weapon.item(N(this.c) - 100);
                                    this.f = "1";
                                    G.BU.add(senderId);
                                    G.BU.add(this.IDX);
                                    G.BU.add(this.c);
                                }
                                // 拡散 e: Item_list の +7。相手の 26 番が "0" で武器種別（+6）が "1"
                                // かつ拡散が 2 未満なら +25 する
                                this.e = G.Item_list.item(N(this.c) + 7);
                                if (B(equals(G.CLOUD.item(senderBase + 25), "0")) &&
                                    B(equals(G.Item_list.item(N(this.c) + 6), "1")) &&
                                    B(compare(this.e, "2") < 0)) {
                                    this.e = N(this.e) + 25;
                                }
                            }
                            yield* this.Player_shot(G.Item_list.item(N(this.c) + 10), G.Item_list.item(N(this.c) + 11), G.Item_list.item(N(this.c) + 12), N(this.Pickupped.item(5)) + N(random(0 - N(this.e), this.e)));
                        }
                    }
                }
            }
            if (!this.rt.warpActive)
                yield;
        }
        this.Pickupped.add(this.c); // [14] 最後の発射文字列（武器名等へ変換後の c）
        // [15] (v - 10) * 15
        yield* this.Pick_up_data__b_c("2", v_var);
        this.Pickupped.add((N(this.c) - 10) * 15);
        // [16]
        yield* this.Pick_up_data__b_c("1", v_var);
        this.Pickupped.add(this.c);
        // [17] -100
        yield* this.Pick_up_data__b_c("3", v_var);
        this.Pickupped.add(N(this.c) - 100);
        // [18]
        yield* this.Pick_up_data__b_c("1", v_var);
        this.Pickupped.add(this.c);
        // [19] +1
        yield* this.Pick_up_data__b_c("2", v_var);
        this.Pickupped.add(N(this.c) + 1);
        // 被弾イベント ×6（9 文字: [被弾者 ID(4)][ダメージ+300(3)][種別(2)、"00"=キル]）。
        // 既読は Players hit で管理する。g は攻撃者との距離で、初回の自分への被弾で
        // 計算して以後使い回す（"-" が未計算の印）。
        this.d = "";
        this.g = "-";
        for (let s = 0; s < 6; s++) {
            yield* this.Pick_up_data__b_c("9", v_var);
            if (!B(equals(this.c, "000000000"))) {
                if (!B(this.Players_hit.contains(this.c))) {
                    this.Players_hit.add(this.c);
                    this.Players_hit.add("0");
                    this.e = N(S(letterOf(this.c, 5)) + S(S(letterOf(this.c, 6)) + S(letterOf(this.c, 7)))) - 300;
                    // Spiky Gobo の棘反撃: 自分のキャラが Spiky Gobo でダメージ > 9 なら
                    // 種別下 2 桁 mod 3 で決まる向きから 72 度ずつ 5 方向へ棘を出す
                    if (B(equals(G.Character_2.item(N(this.Pickupped.item(15)) + 1), "Spiky Gobo"))) {
                        if (B(compare("9", this.e) < 0)) {
                            this.f = mod(S(letterOf(this.c, 8)) + S(letterOf(this.c, 9)), 3);
                            if (B(equals(this.f, "0"))) {
                                this.f = "0";
                            }
                            else if (B(equals(this.f, "1"))) {
                                this.f = "120";
                            }
                            else {
                                this.f = "240";
                            }
                            for (let k = 0; k < 5; k++) {
                                G.Bullet_and_effect.add(senderId);
                                G.Bullet_and_effect.add("Gobo spike");
                                G.Bullet_and_effect.add(this.Pickupped.item(3));
                                G.Bullet_and_effect.add(this.Pickupped.item(4));
                                G.Bullet_and_effect.add(this.f);
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                this.f = N(this.f) + 72;
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                    }
                    if (B(equals(S(letterOf(this.c, 1)) + S(S(letterOf(this.c, 2)) + S(S(letterOf(this.c, 3)) + S(letterOf(this.c, 4)))), G.ID))) {
                        // 被弾したのは自分
                        if (B(equals(this.g, "-"))) {
                            this.g = mathop("sqrt", (N(this.Pickupped.item(3)) - N(G.X)) * (N(this.Pickupped.item(3)) - N(G.X)) + (N(this.Pickupped.item(4)) - N(G.Y)) * (N(this.Pickupped.item(4)) - N(G.Y)));
                        }
                        if (B(equals(S(letterOf(this.c, 8)) + S(letterOf(this.c, 9)), "00"))) {
                            // キルされた。ただし IDX（送信者の名前フィールド）と自分のユーザー名が
                            // 一致する場合はブロック全体が無効（原作の判定のまま）
                            if (!B(equals(this.rt.username, this.IDX))) {
                                this.rt.soundPlay("39f57240772a731b293252916f63c4b2.wav");
                                if (B(equals(G.TEAMMODE_2.item(5), "1"))) {
                                    G.MVPpoint.add(G.ID);
                                    G.MVPpoint.add(G.TEAMMODE_2.item(21));
                                    if (B(equals(letterOf(G.Team_ID, 1), "1"))) {
                                        G.TEAMMODE_2.replace(3, N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(15)));
                                        if (B(compare(this.Pickupped.item(3), "2400") < 0)) {
                                            G.MVPpoint.add(G.ID);
                                            G.MVPpoint.add(G.TEAMMODE_2.item(20));
                                        }
                                    }
                                    else {
                                        G.TEAMMODE_2.replace(4, N(G.TEAMMODE_2.item(4)) + N(G.TEAMMODE_2.item(15)));
                                        if (B(compare("4000", this.Pickupped.item(3)) < 0)) {
                                            G.MVPpoint.add(G.ID);
                                            G.MVPpoint.add(G.TEAMMODE_2.item(20));
                                        }
                                    }
                                }
                                yield* this.Get_mission_point("Kill", "1");
                                this.Match_damage = N(this.Match_damage) + N(this.e);
                                yield* this.Get_mission_point("Damage", this.e);
                                if (B(compare("1", this.Pickupped.item(19)) < 0)) {
                                    yield* this.Get_mission_point("Surprise attack", this.g);
                                }
                                if (B(compare("49", this.e) < 0)) {
                                    yield* this.Get_mission_point("Big damage", "1");
                                    if (B(compare("400", this.g) < 0)) {
                                        yield* this.Get_mission_point("Snipe", "1");
                                    }
                                }
                                if (B(compare("0", G.Hide_ghost) < 0)) {
                                    yield* this.Get_mission_point("Assassin kill", "1");
                                }
                                yield* this.Get_skill_point("1", "0");
                                yield* this.Add_combat_data("Kill", this.e, senderId);
                                G.Kill_counter = N(G.Kill_counter) + 1;
                                if (B(compare(G.Max_kill, G.Kill_counter) < 0)) {
                                    G.Max_kill = G.Kill_counter;
                                    if (B(compare("899", G.Max_kill) < 0)) {
                                        G.Max_kill = "899";
                                    }
                                }
                                // キル報酬の回復（最大値を超えない）
                                if (B(compare(G.Health, G.Max_health) < 0)) {
                                    G.Health = N(G.Health) + 10;
                                    if (B(compare(G.Max_health, G.Health) < 0)) {
                                        G.Health = G.Max_health;
                                    }
                                }
                                G.Menu.replace(72, "150");
                                G.Bullet_and_effect.add("0000");
                                G.Bullet_and_effect.add("My kill");
                                G.Bullet_and_effect.add(this.Pickupped.item(3));
                                G.Bullet_and_effect.add(this.Pickupped.item(4));
                                G.Bullet_and_effect.add("120");
                                G.Bullet_and_effect.add("300");
                                G.Bullet_and_effect.add("100");
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("0");
                                // 12 月限定: 在席 4 人以上で 1/2 の確率でプレゼントを落とす
                                if (B(equals(this.rt.current("MONTH"), "12")) && B(compare("3", G.Active_players) < 0) && B(equals(random(1, 2), "1"))) {
                                    G.Bullet_and_effect.add("0000");
                                    G.Bullet_and_effect.add("Present");
                                    G.Bullet_and_effect.add(this.Pickupped.item(3));
                                    G.Bullet_and_effect.add(this.Pickupped.item(4));
                                    G.Bullet_and_effect.add(random(0, 360));
                                    G.Bullet_and_effect.add(random(5, 10));
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                }
                                // お金ドロップ（Menu[67] はドロップ倍率の逆数）
                                const moneyDrops = Math.max(0, Math.floor(N(mathop("ceiling", random(6, 8) / N(G.Menu.item(67))))));
                                for (let k = 0; k < moneyDrops; k++) {
                                    yield* this.Get_mission_point("Money", "1");
                                    G.Bullet_and_effect.add("0000");
                                    G.Bullet_and_effect.add("Money");
                                    G.Bullet_and_effect.add(this.Pickupped.item(3));
                                    G.Bullet_and_effect.add(this.Pickupped.item(4));
                                    G.Bullet_and_effect.add(random(0, 360));
                                    G.Bullet_and_effect.add(random(5, 10));
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                // 特殊武器キル、または相手の 45 番が "1" なら追加ドロップ + テクタイト
                                this.f = G.CLOUD.item(senderBase + 44);
                                if ((B(equals(G.Special_weapon, "1")) && B(equals(random(1, 3), "1"))) || B(equals(this.f, "1"))) {
                                    if (B(equals(this.f, "1"))) {
                                        const bonusDrops = Math.max(0, Math.floor(N(random(2, 3))));
                                        for (let k = 0; k < bonusDrops; k++) {
                                            yield* this.Get_mission_point("Money", "1");
                                            G.Bullet_and_effect.add("0000");
                                            G.Bullet_and_effect.add("Money");
                                            G.Bullet_and_effect.add(this.Pickupped.item(3));
                                            G.Bullet_and_effect.add(this.Pickupped.item(4));
                                            G.Bullet_and_effect.add(random(0, 360));
                                            G.Bullet_and_effect.add(random(5, 10));
                                            G.Bullet_and_effect.add("0");
                                            G.Bullet_and_effect.add("0");
                                            G.Bullet_and_effect.add("0");
                                            G.Bullet_and_effect.add("0");
                                            if (!this.rt.warpActive)
                                                yield;
                                        }
                                    }
                                    G.Bullet_and_effect.add("0000");
                                    G.Bullet_and_effect.add("Tektite");
                                    G.Bullet_and_effect.add(this.Pickupped.item(3));
                                    G.Bullet_and_effect.add(this.Pickupped.item(4));
                                    G.Bullet_and_effect.add(random(0, 360));
                                    G.Bullet_and_effect.add(random(5, 10));
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("0");
                                }
                                this.Screen_effect.add("0000");
                                this.Screen_effect.add("Kill message");
                                this.Screen_effect.add("0");
                                this.Screen_effect.add("0");
                                this.Screen_effect.add("90");
                                this.Screen_effect.add(G.CLOUD.item(senderBase + N(G.Number_of_data) - 1));
                                this.Screen_effect.add("-315");
                                this.Screen_effect.add("-85");
                                this.Screen_effect.add("0");
                                this.Screen_effect.add("0");
                            }
                        }
                        else {
                            // ダメージを受けただけの場合
                            if (B(compare(this.e, "0") < 0)) {
                                // ダメージが負なら何もしない（音は if(false) で無効化済み）
                                if (B(false)) {
                                    this.rt.soundPlay("c1a66603b7751884a0220e1cfec89054.wav");
                                }
                            }
                            else {
                                G.Menu.replace(99, "1");
                                this.Match_damage = N(this.Match_damage) + N(this.e);
                                yield* this.Get_mission_point("Damage", this.e);
                                yield* this.Add_combat_data("Hit", this.e, senderId);
                                if (B(compare("1", this.Pickupped.item(19)) < 0)) {
                                    yield* this.Get_mission_point("Surprise attack", this.g);
                                }
                                if (B(compare("49", this.e) < 0)) {
                                    yield* this.Get_mission_point("Big damage", "1");
                                    if (B(compare("400", this.g) < 0)) {
                                        yield* this.Get_mission_point("Snipe", "1");
                                    }
                                    this.rt.soundPlay("d62555f0390e0fd6615da150e06d21bc.wav");
                                }
                                else {
                                    this.rt.soundPlay("576e79476fa71386cccbb6752c87d2f7.wav");
                                }
                                if (B(equals(G.Lag_cutter, "0"))) {
                                    G.Bullet_and_effect.add("0");
                                    G.Bullet_and_effect.add("Damage val");
                                    G.Bullet_and_effect.add(this.Pickupped.item(3));
                                    G.Bullet_and_effect.add(this.Pickupped.item(4));
                                    G.Bullet_and_effect.add("90");
                                    G.Bullet_and_effect.add(this.e);
                                    G.Bullet_and_effect.add(70 + N(this.e) / 10);
                                    G.Bullet_and_effect.add(random(80, 100) / 10);
                                    G.Bullet_and_effect.add(random(-20, 20) / 10);
                                    G.Bullet_and_effect.add("0");
                                }
                            }
                            if (B(compare("1", G.Menu.item(67)) < 0)) {
                                yield* this.Get_skill_point("0", N(this.e) / N(G.Menu.item(67)) * 3);
                            }
                            else {
                                yield* this.Get_skill_point("0", this.e);
                            }
                        }
                    }
                    else {
                        // 他人同士の被弾。g は被弾者 ID、f は被弾者の Team_ID（12 番）
                        this.g = S(letterOf(this.c, 1)) + S(S(letterOf(this.c, 2)) + S(S(letterOf(this.c, 3)) + S(letterOf(this.c, 4))));
                        this.f = G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(this.g))) + 11);
                        if (B(compare("1", G.Menu.item(67)) < 0)) {
                            if (B(equals(this.f, G.Team_ID))) {
                                if (B(equals(S(letterOf(this.c, 8)) + S(letterOf(this.c, 9)), "00"))) {
                                    // 味方のキルへの報酬ドロップ
                                    const mateDrops = Math.max(0, Math.floor(N(mathop("ceiling", random(4, 6) / N(G.Menu.item(67))))));
                                    for (let k = 0; k < mateDrops; k++) {
                                        yield* this.Get_mission_point("Money", "1");
                                        G.Bullet_and_effect.add("0000");
                                        G.Bullet_and_effect.add("Money");
                                        G.Bullet_and_effect.add(this.Pickupped.item(3));
                                        G.Bullet_and_effect.add(this.Pickupped.item(4));
                                        G.Bullet_and_effect.add(random(0, 360));
                                        G.Bullet_and_effect.add(random(5, 10));
                                        G.Bullet_and_effect.add("0");
                                        G.Bullet_and_effect.add("0");
                                        G.Bullet_and_effect.add("0");
                                        G.Bullet_and_effect.add("0");
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                }
                                else {
                                    yield* this.Get_skill_point("0", N(this.e) / N(G.Menu.item(67)) * 3);
                                }
                            }
                        }
                        if (B(equals(S(letterOf(this.c, 8)) + S(letterOf(this.c, 9)), "00"))) {
                            // キルフィード表示（Players hit へ二重に登録されるのは原作通り）
                            this.Players_hit.add(this.c);
                            this.Players_hit.add("0");
                            G.Bullet_and_effect.add("0000");
                            if (B(equals(G.Team_ID, this.f))) {
                                G.Bullet_and_effect.add("Team kill");
                            }
                            else {
                                G.Bullet_and_effect.add("Other kill");
                            }
                            G.Bullet_and_effect.add(this.Pickupped.item(3));
                            G.Bullet_and_effect.add(this.Pickupped.item(4));
                            G.Bullet_and_effect.add("120");
                            G.Bullet_and_effect.add("300");
                            G.Bullet_and_effect.add("100");
                            G.Bullet_and_effect.add("0");
                            G.Bullet_and_effect.add("0");
                            G.Bullet_and_effect.add("0");
                            if (B(equals(G.TEAMMODE_2.item(5), "1"))) {
                                G.MVPpoint.add(this.g);
                                G.MVPpoint.add(G.TEAMMODE_2.item(21));
                                if (B(equals(letterOf(this.f, 1), "1"))) {
                                    G.TEAMMODE_2.replace(3, N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(15)));
                                    if (B(compare(this.Pickupped.item(3), "2400") < 0)) {
                                        G.MVPpoint.add(this.g);
                                        G.MVPpoint.add(G.TEAMMODE_2.item(20));
                                    }
                                }
                                else {
                                    G.TEAMMODE_2.replace(4, N(G.TEAMMODE_2.item(4)) + N(G.TEAMMODE_2.item(15)));
                                    if (B(compare("4000", this.Pickupped.item(3)) < 0)) {
                                        G.MVPpoint.add(this.g);
                                        G.MVPpoint.add(G.TEAMMODE_2.item(20));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            this.d = S(senderId) + S(this.c);
            if (!this.rt.warpActive)
                yield;
        }
        this.Pickupped.add(this.c); // [20] 最後の被弾文字列
        // [21][22]（-2000）。範囲チェック: 21 が 3000 を超える、または 22 < 21 なら棄却
        for (let k = 0; k < 2; k++) {
            yield* this.Pick_up_data__b_c("4", v_var);
            this.Pickupped.add(N(this.c) - 2000);
            if (!this.rt.warpActive)
                yield;
        }
        if (B(compare("3000", this.Pickupped.item(21)) < 0) || B(compare(this.Pickupped.item(22), this.Pickupped.item(21)) < 0)) {
            return;
        }
        // [23] × Buff[10]
        yield* this.Pick_up_data__b_c("2", v_var);
        this.Pickupped.add(N(this.c) * N(G.Buff_effect.item(10)));
        // [24] (-100) / 100
        yield* this.Pick_up_data__b_c("3", v_var);
        this.Pickupped.add((N(this.c) - 100) / 100);
        // [25..29]
        for (let k = 0; k < 5; k++) {
            yield* this.Pick_up_data__b_c("1", v_var);
            this.Pickupped.add(this.c);
            if (!this.rt.warpActive)
                yield;
        }
        // [30] -100
        yield* this.Pick_up_data__b_c("3", v_var);
        this.Pickupped.add(N(this.c) - 100);
        // [31]
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Pickupped.add(this.c);
        // [32]
        yield* this.Pick_up_data__b_c("7", v_var);
        this.Pickupped.add(this.c);
        // [33]
        yield* this.Pick_up_data__b_c("1", v_var);
        this.Pickupped.add(this.c);
        // [34] チャットコード。"00" 以外で初見の相手なら発言として処理し、
        // 同じチームなら Team chat へ（英語定型文はフォント幅から表示幅を計算する）
        yield* this.Pick_up_data__b_c("2", v_var);
        this.Pickupped.add(this.c);
        if (!B(equals(this.c, "00")) && !B(this.Chat_user.contains(senderId))) {
            this.f = "1";
            yield* this.Player_shot("Chat", "Chat", "Chat", "90");
            this.Chat_user.add(senderId);
            this.Chat_user.add("15");
            if (B(equals(G.Team_ID, this.Pickupped.item(12)))) {
                this.Team_chat.add(senderId);
                this.Team_chat.add(this.c);
                if (B(equals(G.Language, "1"))) {
                    this.Team_chat.add("0");
                }
                else {
                    this.Temp1 = this.Chat_2.item(N(this.c) + 100);
                    this.Temp2 = "0";
                    this.Temp3 = "-2";
                    const textLen = Math.max(0, Math.floor(N(S(this.Temp1).length)));
                    for (let k = 0; k < textLen; k++) {
                        this.Temp2 = N(this.Temp2) + 1;
                        this.switchCostume(S("Font ") + S(letterOf(this.Temp1, this.Temp2)));
                        this.Temp3 = N(this.Temp3) + (N(this.Font_size___Draw.item(this.costumeNumberName("number"))) * 2 + 2);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.Temp1 = 100 * (72 / N(this.Temp3));
                    if (B(compare("75", this.Temp1) < 0)) {
                        this.Temp1 = "75";
                    }
                    this.Team_chat.add(this.Temp1);
                }
                this.Team_chat.add("120");
            }
        }
        // スキル節: 種別 e（2 桁 - 10）と値（4 桁）から Pickupped[35..43] の 9 項目と
        // Temp1_2 の 6 項目（保留値キュー）を組み立てる。"-" は「前回値を保持」の印。
        yield* this.Pick_up_data__b_c("2", v_var);
        this.e = N(this.c) - 10;
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Temp1_2.deleteAll();
        if (B(compare(this.e, "10") < 0)) {
            this.c = N(this.c) - 1000;
            if (B(equals(this.e, "9"))) {
                // 武器の真正性チェック: [17] の武器の性能値（×30 の場合あり）と一致しなければ
                // 送信者を CSPID へ入れる（Menu[85] への記録は if(false) で無効化済み）
                if (!B(equals(this.Pickupped.item(17), "0"))) {
                    this.d = G.Item_list.item(N(G.Weapon.item(this.Pickupped.item(17))) + 2);
                    if (B(compare(this.d, "900") < 0)) {
                        if (!B(equals(this.c, this.d))) {
                            G.CSPID.add(this.Pickupped.item(12));
                            G.CSPID.add(this.IDX);
                        }
                    }
                    else if (!B(equals(N(this.c) * 30, this.d))) {
                        if (!B(equals(this.d, ""))) {
                            if (B(false)) {
                                G.Menu.replace(85, this.Pickupped.item(12));
                            }
                        }
                    }
                }
                for (let k = 0; k < 9; k++) {
                    this.Pickupped.add("-");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            else {
                const headCount = Math.max(0, Math.floor(N(this.e)));
                for (let k = 0; k < headCount; k++) {
                    this.Pickupped.add("-");
                    if (!this.rt.warpActive)
                        yield;
                }
                this.Pickupped.add(this.c);
                if (B(false)) {
                    // 無効化済みの特殊武器チェック（原作のまま保持）
                    if (B(compare("1", this.e) < 0) && B(compare(this.e, "7") < 0)) {
                        if (B(equals(letterOf(v_var, N(this.b) + 1), "0"))) {
                            if (!B(equals(this.Pickupped.item("last"), "0"))) {
                                if (B(G.Special_weapon_2.contains(G.Weapon_name.item(this.Pickupped.item("last"))))) {
                                    G.Menu.replace(85, senderId);
                                }
                            }
                        }
                    }
                }
                const tailCount = Math.max(0, Math.floor(N(8) - N(this.e)));
                for (let k = 0; k < tailCount; k++) {
                    this.Pickupped.add("-");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            for (let k = 0; k < 6; k++) {
                this.Temp1_2.add("-");
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            for (let k = 0; k < 9; k++) {
                this.Pickupped.add("-");
                if (!this.rt.warpActive)
                    yield;
            }
            if (!B(equals(this.e, "11")) && !B(equals(this.e, "15"))) {
                this.c = N(this.c) - 1000;
            }
            const headCount = Math.max(0, Math.floor(N(this.e) - 10));
            for (let k = 0; k < headCount; k++) {
                this.Temp1_2.add("-");
                if (!this.rt.warpActive)
                    yield;
            }
            this.Temp1_2.add(this.c);
            const tailCount = Math.max(0, Math.floor(N(15) - N(this.e)));
            for (let k = 0; k < tailCount; k++) {
                this.Temp1_2.add("-");
                if (!this.rt.warpActive)
                    yield;
            }
        }
        // [44][45]
        for (let k = 0; k < 2; k++) {
            yield* this.Pick_up_data__b_c("1", v_var);
            this.Pickupped.add(this.c);
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Static_data("-1"); // [46] 保留キューの先頭（-1 修飾）
        // [47..49] -500
        for (let k = 0; k < 3; k++) {
            yield* this.Pick_up_data__b_c("3", v_var);
            this.Pickupped.add(N(this.c) - 500);
            if (!this.rt.warpActive)
                yield;
        }
        // [50] -100
        yield* this.Pick_up_data__b_c("3", v_var);
        this.Pickupped.add(N(this.c) - 100);
        // 通報の集計: Temp1_2 の先頭（保留値の 2 つ目）が "0000" でなく IDX に "!" が
        // 無ければ、その相手への通報者として送信者を Blocked player へ記録する
        if (!B(equals(this.Temp1_2.item(1), "0000"))) {
            if (!B(S(this.IDX).toLowerCase().includes("!"))) {
                if (B(G.Blocked_player.contains(S("#") + S(this.Temp1_2.item(1))))) {
                    this.d = "0";
                    this.e = "0";
                    this.f = G.Blocked_player.itemNum(S("#") + S(this.Temp1_2.item(1)));
                    const voterChars = Math.max(0, Math.floor(N(S(G.Blocked_player.item(N(this.f) + 1)).length) / 4));
                    for (let k = 0; k < voterChars; k++) {
                        const voters = G.Blocked_player.item(N(this.f) + 1);
                        if (B(equals(S(letterOf(voters, N(this.d) + 1)) +
                            S(S(letterOf(voters, N(this.d) + 2)) +
                                S(S(letterOf(voters, N(this.d) + 3)) +
                                    S(letterOf(voters, N(this.d) + 4)))), senderId))) {
                            this.e = "1";
                        }
                        this.d = N(this.d) + 4;
                        if (!this.rt.warpActive)
                            yield;
                    }
                    if (B(equals(this.e, "0"))) {
                        G.Blocked_player.replace(N(this.f) + 1, S(G.Blocked_player.item(N(this.f) + 1)) + S(senderId));
                    }
                    G.Blocked_player.replace(N(this.f) + 2, "0");
                }
                else {
                    G.Blocked_player.add(S("#") + S(this.Temp1_2.item(1)));
                    G.Blocked_player.add(senderId);
                    G.Blocked_player.add("0");
                    if (B(false)) {
                    }
                }
            }
        }
        yield* this.Static_data(""); // [51]
        // [52][53]
        for (let k = 0; k < 2; k++) {
            yield* this.Pick_up_data__b_c("1", v_var);
            this.Pickupped.add(this.c);
            if (!this.rt.warpActive)
                yield;
        }
        // [54][55] -50（マージ時の位置予測にも使う）
        for (let k = 0; k < 2; k++) {
            yield* this.Pick_up_data__b_c("2", v_var);
            this.Pickupped.add(N(this.c) - 50);
            if (!this.rt.warpActive)
                yield;
        }
        // [56] 自分へのチーム招待なら通知する
        yield* this.Pick_up_data__b_c("4", v_var);
        this.Pickupped.add(this.c);
        if (B(equals(this.c, G.ID))) {
            if (B(compare("0", G.ID) < 0)) {
                if (!B(G.Team.contains(S("2") + S(G.Team_ID)))) {
                    if (!B(G.Ignored_invitation.contains(senderId))) {
                        if (!B(equals(G.Menu.item(112), senderId))) {
                            this.rt.soundPlay("0bf59908f1bb1b945feca0669f19dbb1.wav");
                            G.Menu.replace(112, senderId);
                        }
                    }
                }
            }
        }
        // [57..59][60] 保留値キューの残りを移す
        for (let k = 0; k < 3; k++) {
            yield* this.Static_data("0");
            if (!this.rt.warpActive)
                yield;
        }
        yield* this.Static_data("");
        // [61] -550
        yield* this.Pick_up_data__b_c("3", v_var);
        this.Pickupped.add(N(this.c) - 550);
        // [62] 表示名（カーソル継続で復号）
        yield* this.Pick_up_user_name__b_c("b", v_var);
        this.Pickupped.add(this.c);
        // 配置: 既存レコードがあればそこへ、無ければ空きスロットか末尾へ
        yield* this.Find_player__a();
        if (B(equals(this.a, "-1"))) {
            this.a = "1";
            this.b = "0";
            const slotCount = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
            for (let k = 0; k < slotCount; k++) {
                if (B(equals(G.CLOUD.item(this.a), ""))) {
                    this.b = this.a;
                }
                this.a = N(this.a) + N(G.Number_of_data);
                if (!this.rt.warpActive)
                    yield;
            }
            if (B(equals(this.b, "0"))) {
                // 末尾に追加: 1..58 は Pickupped そのまま、59 は名前パック
                // （3 文字目が前置する "!!" の個数、残りは後置して 20 文字に揃える）
                this.a = "0";
                const preCount = Math.max(0, Math.floor(N(G.Number_of_data) - 1));
                for (let k = 0; k < preCount; k++) {
                    this.a = N(this.a) + 1;
                    G.CLOUD.add(this.Pickupped.item(this.a));
                    if (!this.rt.warpActive)
                        yield;
                }
                this.a = N(this.a) + 1;
                this.b = letterOf(this.Pickupped.item(this.a), 3);
                this.c = S(letterOf(this.Pickupped.item(this.a), 1)) + S(letterOf(this.Pickupped.item(this.a), 2));
                const preBang = Math.max(0, Math.floor(N(this.b)));
                for (let k = 0; k < preBang; k++) {
                    this.c = S("!!") + S(this.c);
                    if (!this.rt.warpActive)
                        yield;
                }
                const postBang = Math.max(0, Math.floor(N(9) - N(this.b)));
                for (let k = 0; k < postBang; k++) {
                    this.c = S(this.c) + "!!";
                    if (!this.rt.warpActive)
                        yield;
                }
                G.CLOUD.add(this.c);
                this.Cloud_check.add("0");
                return;
            }
            else {
                // 空きスロットを再利用: 名前フィールドを "!" 埋めにしてマージへ合流する
                this.a = N(this.b) - 1;
                this.Cloud_check.replace(N(this.a) / N(G.Number_of_data) + 1, "0");
                G.CLOUD.replace(N(this.a) + N(G.Number_of_data), "!!!!!!!!!!!!!!!!!!!!");
                if (B(compare("400", this.Pickupped.item(3)) < 0)) {
                    G.Respawned_player.add(senderId);
                }
            }
        }
        else {
            this.Cloud_check.replace(N(this.a) / N(G.Number_of_data) + 1, "0");
        }
        // マージ: Pickupped の全項目をレコードへ反映する。
        //   3..11（位置・モーション）: 差が 500 を超えたら即反映、それ以外は補間キューへ。
        //     自分のレコードの 5..11 は対象外（自分のモーションは入力側が正）。
        //     3・4 には位置予測の補正（[54]/[55] × 経過 × 予測機能%）がかかる。
        //   59（名前）: 現在値が "!" を含む場合はパック形式のまま部分更新する。
        //   それ以外: "-" の項目は前回値を保持し、他はそのまま差し替える。
        this.b = "0";
        const totalFields = Math.max(0, Math.floor(N(this.Pickupped.length)));
        for (let k = 0; k < totalFields; k++) {
            this.b = N(this.b) + 1;
            this.f = G.CLOUD.item(N(this.a) + N(this.b));
            if (B(compare("2", this.b) < 0) && B(compare(this.b, "12") < 0)) {
                if (!B(B(equals(senderId, G.ID)) && B(compare("4", this.b) < 0))) {
                    if (B(compare("500", mathop("abs", N(this.f) - N(this.Pickupped.item(this.b)))) < 0)) {
                        G.CLOUD.replace(N(this.a) + N(this.b), this.Pickupped.item(this.b));
                    }
                    else {
                        this.c = this.Pickupped.item(this.b);
                        if (B(equals(this.b, "3")) || B(equals(this.b, "4"))) {
                            this.c = N(this.c) + N(this.Pickupped.item(N(this.b) + 51)) *
                                (mod(N(G.World_timer) - N(this.Pickupped.item(2)) + 45000, 89999) - 45000) *
                                (N(G.プレイヤー位置予測機能) / 100);
                        }
                        yield* this.Add_player_movement(S("@") + S(N(this.a) + N(this.b)));
                    }
                }
            }
            else if (B(equals(this.b, G.Number_of_data))) {
                if (B(S(this.f).toLowerCase().includes("!"))) {
                    this.c = "0";
                    this.d = "";
                    for (let j = 0; j < 10; j++) {
                        if (B(equals(this.c, letterOf(this.Pickupped.item(this.b), 3)))) {
                            this.d = S(this.d) + S(S(letterOf(this.Pickupped.item(this.b), 1)) + S(letterOf(this.Pickupped.item(this.b), 2)));
                        }
                        else if (B(equals(letterOf(this.f, N(this.c) * 2), "="))) {
                            this.d = S(this.d) + "==";
                        }
                        else {
                            this.d = S(this.d) + S(S(letterOf(this.f, N(this.c) * 2 + 1)) + S(letterOf(this.f, N(this.c) * 2 + 2)));
                        }
                        this.c = N(this.c) + 1;
                        if (!this.rt.warpActive)
                            yield;
                    }
                    if (B(S(this.d).toLowerCase().includes("!"))) {
                        G.CLOUD.replace(N(this.a) + N(this.b), this.d);
                    }
                    else {
                        // "!" が消えたら "=" を除いた実名だけを残す
                        this.c = "0";
                        this.e = "";
                        for (let j = 0; j < 20; j++) {
                            this.c = N(this.c) + 1;
                            if (!B(equals(letterOf(this.d, this.c), "="))) {
                                this.e = S(this.e) + S(letterOf(this.d, this.c));
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        G.CLOUD.replace(N(this.a) + N(this.b), this.e);
                    }
                }
            }
            else if (!B(equals(this.Pickupped.item(this.b), "-"))) {
                G.CLOUD.replace(N(this.a) + N(this.b), this.Pickupped.item(this.b));
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Pick up data [b,c] %s %s"
    *Pick_up_data__b_c(lange, data) {
        // デコーダの基本素子: 共有カーソル b（1 始まり）の位置から lange 文字を
        // 取り出して c に返す。b は読んだ分だけ進む。範囲外は "" が返る。
        this.c = "";
        const count = Math.max(0, Math.floor(N(lange)));
        for (let i = 0; i < count; i++) {
            this.c = S(this.c) + S(letterOf(data, this.b));
            this.b = N(this.b) + 1;
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Find player [a]"
    *Find_player__a() {
        // Pickupped[1] のプレイヤー ID を G.CLOUD（59 フィールド × n のレコード列）から探し、
        // レコード先頭のオフセット（0 始まり）を a に返す。見つからなければ -1。
        this.a = "0";
        const records = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
        for (let i = 0; i < records; i++) {
            if (B(equals(this.Pickupped.item(1), G.CLOUD.item(N(this.a) + 1)))) {
                return;
            }
            this.a = N(this.a) + N(G.Number_of_data);
            if (!this.rt.warpActive)
                yield;
        }
        this.a = "-1";
    }
    // procedure: "Draw players %b"
    *Draw_players(UI_closed) {
        // 全プレイヤーの走査と描画。CLOUD の 62 フィールドレコードを 1 件ずつ
        // Temp1_2 へ読み（Set player data temp)、次を処理する:
        //   - OtherCP 集計（距離 300 以内の敵の戦闘力。59 番が "0" なら 10000 で数える）
        //   - タレット操作（45 番 = "1" の位置を Menu[73]/[74] へ、32 番の操作文字列で遠隔照準）
        //   - ブロック集計（51 番 = 自分の ID が 5 件超で Block_num が立つ）
        //   - チーム名簿（Team リスト: "2"+リーダーID の見出し + メンバー 4 枠 = 5 件組）
        //   - UI_closed のとき各プレイヤーの本体・武器・ペット・名前を描画し、
        //     狙撃検知（IDY / Menu[90]）と最近接の敵（First number / distance）、
        //     ロックオン候補（IDX）を更新する
        // フィールド番号は Pickupped と同じ 62 項目（3=X, 4=Y, 12=Team, 21=Health,
        // 32=タレット操作， 51=ブロック元， 59=戦闘力， 62=名前）。
        this.rotationStyle = "all around";
        this.a = "0";
        this.First_distance = "99999";
        this.First_number = "0000";
        this.IDX = "99999";
        this.IDY = "99999";
        this.OtherCP = "0";
        G.Menu.replace(73, "-");
        G.Menu.replace(74, "-");
        G.Menu.replace(90, "0");
        G.Menu.replace(93, "0");
        G.Team.deleteAll();
        const records = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
        for (let r = 0; r < records; r++) {
            if (B(!B(equals(G.CLOUD.item((N(this.a) + N(1))), "")))) {
                yield* this.Set_player_data_temp__b();
                const T = this.Temp1_2;
                const dx = (N(T.item(3)) - N(G.X));
                const dy = (N(T.item(4)) - N(G.Y));
                if (B(compare((N((N(dx) * N(dx))) + N((N(dy) * N(dy)))), "90000") < 0)) {
                    if (B(!B(equals(G.Team_ID, T.item(12))))) {
                        if (B(equals(T.item(59), "0"))) {
                            this.OtherCP = N(this.OtherCP) + N(10000);
                        }
                        else {
                            this.OtherCP = N(this.OtherCP) + N(T.item(59));
                        }
                    }
                }
                if (B(compare("400", T.item(3)) < 0)) {
                    if (B(equals(T.item(45), "1"))) {
                        G.Menu.replace(73, T.item(3));
                        G.Menu.replace(74, T.item(4));
                    }
                    if (B(!B(equals(T.item(32), "0000000")))) {
                        // タレット遠隔操作: 32 番 = [番号][目標X 3桁][目標Y 3桁]（−500 オフセット、×50 でワールド座標）
                        const tBase = (N(letterOf(T.item(32), 1)) * N(15));
                        G.Turrets.replace((N(tBase) + N(7)), "0");
                        if (B(equals(letterOf(T.item(32), 1), "0"))) {
                            G.Turrets.replace((N(tBase) + N(5)), "0");
                        }
                        else {
                            G.Turrets.replace((N(tBase) + N(4)), T.item(1));
                            let tx = (N((N((S(letterOf(T.item(32), 2)) + S((S(letterOf(T.item(32), 3)) + S(letterOf(T.item(32), 4)))))) - N(500))) * N(50));
                            let ty = (N((N((S(letterOf(T.item(32), 5)) + S((S(letterOf(T.item(32), 6)) + S(letterOf(T.item(32), 7)))))) - N(500))) * N(50));
                            G.Turrets.replace((N(tBase) + N(12)), tx);
                            G.Turrets.replace((N(tBase) + N(13)), ty);
                            tx = (N(tx) - N(G.Turrets.item((N(tBase) + N(1)))));
                            ty = (N(ty) - N(G.Turrets.item((N(tBase) + N(2)))));
                            G.Turrets.replace((N(tBase) + N(8)), (N(mathop("atan", (N(tx) / N(ty)))) + N((N((compare(ty, "0") < 0)) * N(180)))));
                            G.Turrets.replace((N(tBase) + N(10)), "0");
                            const tDist = mathop("sqrt", (N((N(tx) * N(tx))) + N((N(ty) * N(ty)))));
                            if (B(equals(Math.round(N(tDist)), "0"))) {
                                G.Turrets.replace((N(tBase) + N(8)), G.Turrets.item((N(tBase) + N(3))));
                            }
                            if (B(equals(G.Turrets.item((N(tBase) + N(11))), "Cannon"))) {
                                // 仰角は射程（30 + 距離500 ごとに 30）から弾道の2段計算で解く
                                let range = (N(30) + N((N(mathop("floor", (N(tDist) / N(500)))) * N(30))));
                                G.Turrets.replace((N(tBase) + N(9)), range);
                                if (B(equals(Math.round(N(tDist)), "0"))) {
                                    G.Turrets.replace((N(tBase) + N(10)), "0");
                                }
                                else {
                                    range = (N((N(-1) * N((N(tDist) * N(tDist))))) / N((N(2) * N((N(range) * N(range))))));
                                    G.Turrets.replace((N(tBase) + N(10)), (N(90) - N(mathop("atan", (N(mathop("sqrt", (N((N((N(tDist) * N(tDist))) / N((N(4) * N((N(range) * N(range))))))) + N(-1)))) - N((N(tDist) / N((N(2) * N(range))))))))));
                                }
                            }
                        }
                    }
                }
                if (B(equals(T.item(51), G.ID))) {
                    G.Menu.replace(93, (N(G.Menu.item(93)) + N(1)));
                    if (B(compare("4", G.Menu.item(93)) < 0)) {
                        G.Block_num = "1";
                    }
                }
                if (B(!B(equals(T.item(28), "0")))) {
                    // チーム名簿: 見出し "1"+チームID（未確定）/ "2"+リーダーID（確定）+ 4 枠
                    if (B(G.Team.contains((S("1") + S(T.item(12)))))) {
                        let slot = G.Team.itemNum((S("1") + S(T.item(12))));
                        if (B(equals(T.item(1), T.item(12)))) {
                            G.Team.replace(slot, (S("2") + S(T.item(1))));
                        }
                        else {
                            let placed = "0";
                            for (let k = 0; k < 4; k++) {
                                slot = N(slot) + N(1);
                                if (B(equals(placed, "0"))) {
                                    if (B(equals(G.Team.item(slot), ""))) {
                                        placed = "1";
                                        G.Team.replace(slot, T.item(1));
                                    }
                                }
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                    }
                    else {
                        if (B(G.Team.contains((S("2") + S(T.item(12)))))) {
                            let slot = G.Team.itemNum((S("2") + S(T.item(12))));
                            let placed = "0";
                            for (let k = 0; k < 4; k++) {
                                slot = N(slot) + N(1);
                                if (B(equals(placed, "0"))) {
                                    if (B(equals(G.Team.item(slot), ""))) {
                                        placed = "1";
                                        G.Team.replace(slot, T.item(1));
                                    }
                                }
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        else {
                            if (B(equals(T.item(1), T.item(12)))) {
                                G.Team.add((S("2") + S(T.item(1))));
                                G.Team.add("");
                            }
                            else {
                                G.Team.add((S("1") + S(T.item(12))));
                                G.Team.add(T.item(1));
                            }
                            for (let k = 0; k < 3; k++) {
                                G.Team.add("");
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                    }
                }
                if (B(UI_closed)) {
                    if (B(equals(T.item(1), G.ID))) {
                        T.replace(3, G.X);
                        T.replace(4, G.Y);
                    }
                    if (B(compare("0", T.item(21)) < 0)) {
                        if (B(compare("400", G.X) < 0) && B(!B(equals(T.item(12), G.Team_ID)))) {
                            // 狙撃検知と最近接の敵（自分が対戦側 X > 400 のときだけ）
                            this.b = mathop("sqrt", (N((N((N(T.item(3)) - N(G.X))) * N((N(T.item(3)) - N(G.X))))) + N((N((N(T.item(4)) - N(G.Y))) * N((N(T.item(4)) - N(G.Y)))))));
                            if (B(equals(T.item(31), G.ID))) {
                                if (B(equals(T.item(44), "1")) || B((B((B(equals(T.item(18), "1")) || B(equals(T.item(26), "1")))) && B(compare(this.b, this.IDY) < 0)))) {
                                    if (B(equals(T.item(44), "1"))) {
                                        this.IDY = "0";
                                    }
                                    else {
                                        this.IDY = this.b;
                                    }
                                    G.Menu.replace(90, "1");
                                    G.Sniping_player = T.item(1);
                                }
                            }
                            if (B(compare(this.b, this.First_distance) < 0)) {
                                this.First_distance = this.b;
                                this.First_number = T.item(1);
                            }
                        }
                        this.b = (N(100) * N(G.Zoom_temp));
                        yield* this.Pen_mode();
                        if (B(compare("0", T.item(13)) < 0)) {
                            // レーザーサイトの線（US-144 は緑、それ以外は赤。ランチャーは手元オフセット 9）
                            this.setPenSize(4);
                            if (B(equals(G.Weapon_name.item(T.item(17)), "US-144"))) {
                                this.setPenColor("#00ff6a");
                                this.setPenParam(S("transparency"), 100);
                                this.gotoXY((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                            }
                            else {
                                this.setPenColor("#ff0000");
                                this.setPenParam(S("transparency"), 100);
                                if (B(S(G.Item_list.item((N(G.Weapon.item(T.item(17))) + N(1)))).toLowerCase().includes(S("ランチャー")))) {
                                    this.c = "9";
                                }
                                else {
                                    this.c = "7";
                                }
                                this.gotoXY((N((N((N(T.item(3)) + N((N(mathop("sin", (N(T.item(5)) + N(90)))) * N(this.c))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N((N(mathop("cos", (N(T.item(5)) + N(90)))) * N(this.c))))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                            }
                            this.pointInDirection(T.item(5));
                            this.moveSteps(35);
                            this.penDown();
                            this.setPenParam(S("transparency"), 40);
                            this.moveSteps((N(T.item(13)) * N(G.Zoom_temp)));
                            this.penUp();
                        }
                        this.gotoXY((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                        if (B(compare(mathop("abs", this.x), "280") < 0) && B(compare(mathop("abs", this.y), "200") < 0)) {
                            this.c = mathop("sqrt", (N((N((N(T.item(3)) - N(G.X))) * N((N(T.item(3)) - N(G.X))))) + N((N((N(T.item(4)) - N(G.Y))) * N((N(T.item(4)) - N(G.Y)))))));
                            if (B(compare("400", T.item(3)) < 0) && B(equals(T.item(16), "1"))) {
                                // 対戦中で行動中: 水色のオーラ
                                this.setPenColor("#00f2ff");
                                this.setPenSize((N(75) * N(G.Zoom_temp)));
                                this.setPenParam(S("transparency"), 50);
                                this.penDown();
                                this.penUp();
                            }
                            else {
                                if (B(equals(T.item(1), G.ID))) {
                                    this.setPenColor("#0f4d00");
                                    this.setPenSize((N(90) * N(G.Zoom_temp)));
                                    this.setPenParam(S("transparency"), (N(100) / N((N(180) / N((N(180) - N(G.Bush_buff)))))));
                                    this.penDown();
                                    this.penUp();
                                }
                                if (B(equals(T.item(18), "1"))) {
                                    this.setPenColor("#ff00dc");
                                    this.setPenSize((N(75) * N(G.Zoom_temp)));
                                    this.setPenParam(S("transparency"), (N((N(100) - N(T.item(23)))) + N((N(100) / N((N((N(G.Character_2.item((N(G.Character) + N(7)))) * N(G.Buff_effect.item(9)))) / N(this.c)))))));
                                    this.penDown();
                                    this.penUp();
                                }
                            }
                            // 透明度: 味方かロビー側なら 19 番 × 0.7、敵は距離で隠蔽が解ける式
                            if (B(equals(T.item(12), G.Team_ID)) || B(compare(G.X, "400") < 0)) {
                                this.e = (N(T.item(19)) * N(0.7));
                            }
                            else {
                                if (B(compare("75", this.c) < 0)) {
                                    this.c = "75";
                                }
                                this.e = (N((N(T.item(19)) + N(1))) - N((N(G.Hide_ghost) * N((N(0.3) / N((N(75) / N((N(75) - N(this.c))))))))));
                            }
                            this.setEffect("GHOST", this.e);
                            this.d = G.Character_2.item((N(T.item(15)) + N(1)));
                            if (B(!B(equals(T.item(46), "-1")))) {
                                // ペット: リード線 + コスチュームの存在確認でアニメフレームを探す
                                // （"~名前" が無ければ "~名前1", "2"... と連番を探す原作の方式）
                                this.c = "-";
                                this.gotoXY((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                                this.setPenColor("#000000");
                                this.setPenSize(5);
                                this.setPenParam(S("transparency"), 100);
                                this.penDown();
                                this.setPenParam(S("transparency"), (N(70) + N((N(30) / N((N(100) / N(this.e)))))));
                                if (B(equals(T.item(1), G.ID))) {
                                    this.gotoXY((N((N(G.Pet_x) - N(G.Camera_x))) * N(G.Zoom_temp)), (N((N(G.Pet_y) - N(G.Camera_y))) * N(G.Zoom_temp)));
                                }
                                else {
                                    this.gotoXY((N((N((N(T.item(3)) + N(T.item(47)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(48)))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                                }
                                this.penUp();
                                this.pointInDirection(T.item(49));
                                while (!B(equals(this.c, "0"))) {
                                    this.f = G.Pet_data.item((N((N(T.item(46)) * N(10))) + N(1)));
                                    if (B(equals(this.c, "1"))) {
                                        this.g = N(this.g) + N(1);
                                        this.switchCostume("Pen");
                                        this.switchCostume((S("~") + S((S(this.f) + S(this.g)))));
                                        if (B(equals(this.costumeNumberName("name"), "Pen"))) {
                                            this.c = "0";
                                        }
                                        else {
                                            if (B(equals(this.costumeNumberName("name"), "~uk-4002"))) {
                                                this.pointInDirection((N(0) - N(this.direction)));
                                            }
                                        }
                                    }
                                    if (B(equals(this.c, "-"))) {
                                        this.switchCostume("Pen");
                                        this.switchCostume((S("~") + S(this.f)));
                                        if (B(equals(this.costumeNumberName("name"), "Pen"))) {
                                            this.c = "1";
                                            this.g = "1";
                                            this.switchCostume("Pen");
                                            this.switchCostume((S("~") + S((S(this.f) + S("1")))));
                                        }
                                        else {
                                            this.c = "0";
                                        }
                                    }
                                    if (B(!B(equals(this.costumeNumberName("name"), "Pen")))) {
                                        yield* this.Stamp(this.x, this.y, this.b, this.costumeNumberName("name"));
                                    }
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                            }
                            this.gotoXY((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                            if (B(!B(equals(T.item(1), G.ID)))) {
                                if (B(compare("400", T.item(3)) < 0)) {
                                    // バフ/デバフの個数だけアイコンを回して置く
                                    this.pointInDirection((N(this.rt.timer()) * N(80)));
                                    if (B(compare("0", T.item(52)) < 0)) {
                                        const buffs = Math.max(0, Math.floor(N(T.item(52))));
                                        for (let k = 0; k < buffs; k++) {
                                            yield* this.Stamp(this.x, this.y, this.b, "Buff");
                                            this.turnRight(90);
                                            if (!this.rt.warpActive)
                                                yield;
                                        }
                                    }
                                    this.pointInDirection((N((N(this.rt.timer()) * N(80))) + N(45)));
                                    if (B(compare("0", T.item(53)) < 0)) {
                                        const debuffs = Math.max(0, Math.floor(N(T.item(53))));
                                        for (let k = 0; k < debuffs; k++) {
                                            yield* this.Stamp(this.x, this.y, this.b, "Debuff");
                                            this.turnRight(90);
                                            if (!this.rt.warpActive)
                                                yield;
                                        }
                                    }
                                }
                            }
                            this.c = G.Weapon_name.item(T.item(17));
                            this.pointInDirection(T.item(11));
                            if (B(equals(T.item(45), "1"))) {
                                // 特殊武器（車両・ガーディアン・シールドキャノン）は専用スプライトで描く
                                if (B(equals(this.c, "戦車主砲")) || B((B(equals(this.c, "戦車重機関銃")) || B(equals(this.c, "戦車発火弾"))))) {
                                    yield* this.Stamp((N((N((N(T.item(3)) + N(T.item(9)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(10)))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Tank hand2");
                                    this.pointInDirection(T.item(8));
                                    yield* this.Stamp((N((N((N(T.item(3)) + N(T.item(6)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(7)))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Tank hand1");
                                    this.pointInDirection(T.item(5));
                                    yield* this.Stamp((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Tank body");
                                }
                                else {
                                    if (B(equals(this.c, "ガーディアンスラッシュ")) || B((B(equals(this.c, "ガーディアンクイック")) || B(equals(this.c, "ガーディアンバースト"))))) {
                                        yield* this.Stamp((N((N((N(T.item(3)) + N((N(T.item(9)) * N(2))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N((N(T.item(10)) * N(2))))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Guardian hand2");
                                        this.pointInDirection(T.item(8));
                                        yield* this.Stamp((N((N((N(T.item(3)) + N((N(T.item(6)) * N(2))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N((N(T.item(7)) * N(2))))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Guardian hand1");
                                        this.pointInDirection(T.item(5));
                                        yield* this.Stamp((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Guardian body");
                                    }
                                    else {
                                        if (B(equals(this.c, "シールドキャノン")) || B((B(equals(this.c, "シールドバッシュ")) || B(equals(this.c, "シールドファンネル"))))) {
                                            this.pointInDirection(T.item(8));
                                            yield* this.Stamp((N((N((N(T.item(3)) + N(T.item(6)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(7)))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Shield Cannon");
                                            this.pointInDirection(T.item(5));
                                            yield* this.Stamp((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, "Shield Cannon body");
                                        }
                                        else {
                                        }
                                    }
                                }
                            }
                            else {
                                // 通常: 手（25 番で + 版）→ 武器 → 体の順に重ねる
                                this.switchCostume("Pen");
                                if (B(equals(T.item(25), "1"))) {
                                    this.switchCostume((S(this.d) + S(" hand+")));
                                }
                                if (B(equals(this.costumeNumberName("name"), "Pen"))) {
                                    this.f = "";
                                }
                                else {
                                    this.f = "+";
                                }
                                yield* this.Stamp((N((N((N(T.item(3)) + N(T.item(9)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(10)))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, (S(this.d) + S((S(" hand") + S(this.f)))));
                                if (B(!B(equals(this.d, "The Player")))) {
                                    yield* this.Stamp(this.x, this.y, this.b, (S("<") + S(this.c)));
                                }
                                this.gotoXY((N((N((N(T.item(3)) + N(T.item(6)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(T.item(4)) + N(T.item(7)))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                                this.pointInDirection(T.item(8));
                                yield* this.Stamp(this.x, this.y, this.b, (S(this.d) + S((S(" hand") + S(this.f)))));
                                if (B(!B(equals(this.d, "The Player")))) {
                                    this.h = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(this.c))) + N(1)));
                                    if (B(S(this.h).toLowerCase().includes(S("物理")))) {
                                        if (B(equals(T.item(27), "1"))) {
                                            this.moveSteps((N(35) * N(G.Zoom_temp)));
                                            this.switchCostume((S(":") + S(this.c)));
                                            this.size = N(this.b);
                                            this.stamp();
                                            yield* this.Pen_mode();
                                            this.moveSteps((N(-35) * N(G.Zoom_temp)));
                                        }
                                    }
                                    if (B(S(this.h).toLowerCase().includes(S("オーバーヒート")))) {
                                        if (B(equals(T.item(27), "0"))) {
                                            this.switchCostume((S("×") + S(this.c)));
                                        }
                                        else {
                                            this.switchCostume(this.c);
                                        }
                                    }
                                    else {
                                        this.switchCostume(this.c);
                                    }
                                    this.size = N(this.b);
                                    this.stamp();
                                    yield* this.Pen_mode();
                                }
                                this.pointInDirection(T.item(5));
                                if (B(equals(T.item(25), "1"))) {
                                    yield* this.Stamp((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, (S(this.d) + S(" body+")));
                                }
                                else {
                                    yield* this.Stamp((N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, (S(this.d) + S(" body")));
                                }
                            }
                            if (B(equals(Math.round(N(G.Menu.item(69))), "520"))) {
                                // ロックオン候補: マウスに一番近い敵
                                this.h = this.distanceToMouse();
                                if (B(!B(equals(T.item(12), G.Team_ID)))) {
                                    if (B(compare(this.h, (N(130) * N(G.Zoom_temp))) < 0)) {
                                        if (B(compare("0", G.Health) < 0)) {
                                            if (B(compare(this.h, this.IDX) < 0)) {
                                                this.IDX = this.h;
                                                G.Lock_on_player = T.item(1);
                                            }
                                        }
                                    }
                                }
                            }
                            this.changeYBy((N(35) * N(G.Zoom_temp)));
                            this.setEffect("BRIGHTNESS", -100);
                            // 名前の描画幅をフォント実測で積算（最小 94）
                            this.c = "0";
                            this.d = "0";
                            const nameLen = Math.max(0, Math.floor(N(S(T.item(G.Number_of_data)).length)));
                            for (let k = 0; k < nameLen; k++) {
                                this.c = N(this.c) + N(1);
                                this.switchCostume((S("Font ") + S(letterOf(T.item(G.Number_of_data), this.c))));
                                this.d = N(this.d) + N((N((N(this.Font_size___Draw.item(this.costumeNumberName("number"))) * N(2))) + N(2)));
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            if (B(compare(this.d, "94") < 0)) {
                                this.d = "94";
                            }
                            this.e = N(this.e) + N(2);
                            if (B(compare("400", T.item(3)) < 0) && B((B(!B(equals(T.item(1), G.ID))) && B((B(equals(T.item(12), G.Team_ID)) || B((B(equals(G.Character_name, "Cat Bot")) && B(equals(G.Scoping, "1"))))))))) {
                                // 味方（または Cat Bot でスコープ中）の体力バー
                                if (B(equals(T.item(12), G.Team_ID))) {
                                    this.f = "0";
                                    this.g = "0";
                                }
                                else {
                                    this.g = (N((N(3) / N((N(100) / N(G.Menu.item(21)))))) * N(G.Zoom_temp));
                                    this.f = random((N(0) - N(this.g)), this.g);
                                    this.g = random((N(0) - N(this.g)), this.g);
                                }
                                this.changeXBy(this.f);
                                this.changeYBy(this.g);
                                this.setPenColor("#272727");
                                this.setPenSize((N(12) * N(G.Zoom_temp)));
                                this.setPenParam(S("transparency"), 100);
                                this.changeXBy((N(-26) * N(G.Zoom_temp)));
                                this.penDown();
                                this.setPenParam(S("transparency"), this.e);
                                this.changeXBy((N(52) * N(G.Zoom_temp)));
                                this.penUp();
                                this.changeXBy((N(-52) * N(G.Zoom_temp)));
                                this.changeXBy((N(this.f) * N(-2)));
                                this.changeYBy((N(this.g) * N(-2)));
                                this.setPenColor("#2aff00");
                                this.setPenParam(S("transparency"), 100);
                                this.penDown();
                                this.setPenParam(S("transparency"), this.e);
                                this.changeXBy((N((N(52) / N((N(T.item(22)) / N(T.item(21)))))) * N(G.Zoom_temp)));
                                this.penUp();
                                this.changeXBy((N((N(26) + N((N(-52) / N((N(T.item(22)) / N(T.item(21)))))))) * N(G.Zoom_temp)));
                                this.changeXBy(this.f);
                                this.changeYBy(this.g);
                                this.changeYBy((N(13) * N(G.Zoom_temp)));
                            }
                            if (B(equals(T.item(34), "00"))) {
                                // チャット表示タイマーの減算と掃除（Chat_user は [ID, 残り] の組）
                                if (B(this.Chat_user.contains(T.item(1)))) {
                                    this.f = this.Chat_user.itemNum(T.item(1));
                                    this.Chat_user.replace((N(this.f) + N(1)), (N(this.Chat_user.item((N(this.f) + N(1)))) - N(G.FPS_temp)));
                                    if (B(compare(this.Chat_user.item((N(this.f) + N(1))), "1") < 0)) {
                                        for (let k = 0; k < 2; k++) {
                                            this.Chat_user.delete(this.f);
                                            if (!this.rt.warpActive)
                                                yield;
                                        }
                                    }
                                }
                            }
                            if (B(equals(T.item(33), "1"))) {
                                this.setPenColor("#ffffff");
                                this.setPenSize((N(18) * N(G.Zoom_temp)));
                                this.setPenParam(S("transparency"), 100);
                                this.changeXBy((N(-36) * N(G.Zoom_temp)));
                                this.penDown();
                                this.setPenParam(S("transparency"), this.e);
                                this.changeXBy((N(72) * N(G.Zoom_temp)));
                                this.penUp();
                                this.changeXBy((N(-36) * N(G.Zoom_temp)));
                            }
                            if (B(!B(S(T.item(G.Number_of_data)).toLowerCase().includes(S("!"))))) {
                                if (B(compare(this.h, "15") < 0) && B(equals(G.Not_hit, "1"))) {
                                    // マウスが近いダミーモード時: ランクプレート + クリックでプロフィール
                                    this.setEffect("BRIGHTNESS", 0);
                                    this.pointInDirection(90);
                                    yield* this.Stamp(this.x, this.y, (N(55) * N(G.Zoom_temp)), (S("Rank plate") + S(T.item(35))));
                                    if (B(compare(T.item(3), "400") < 0)) {
                                        if (B(equals(this.Clicking, "1"))) {
                                            this.Touch = T.item(1);
                                            this.Mouse_touch = "Player profile";
                                        }
                                    }
                                }
                                else {
                                    if (B(!B(equals(T.item(28), "0")))) {
                                        this.setEffect("BRIGHTNESS", 0);
                                        this.setEffect("COLOR", (N(G.Team_color_2.item(T.item(28))) * N(2)));
                                    }
                                    if (B(equals(G.Lag_cutter, "0")) || B((B(equals(G.Lag_cutter, "1")) && B(equals(T.item(12), G.Team_ID))))) {
                                        yield* this.Draw_text(T.item(G.Number_of_data), (N((N((N(65.8) / N(this.d))) * N(100))) * N(G.Zoom_temp)), "C", this.x);
                                    }
                                }
                            }
                            this.rotationStyle = "all around";
                            this.setEffect("BRIGHTNESS", 0);
                            this.setEffect("GHOST", 0);
                            this.setEffect("COLOR", 0);
                        }
                    }
                }
            }
            this.a = N(this.a) + N(G.Number_of_data);
            if (!this.rt.warpActive)
                yield;
        }
        // チームカラーの解散判定: リーダーの自分にメンバーが居なければ時間切れで解散
        if (B(!B(equals(G.Team_color, "0"))) && B(equals(G.ID, G.Team_ID))) {
            if (B(equals(G.Team.item((N(G.Team.itemNum((S("2") + S(G.ID)))) + N(1))), ""))) {
                if (B(equals(G.TEAMMODE, "0"))) {
                    yield* this.CSM_menu("43", "-1", "C", "0");
                    if (B(compare(G.Menu.item(43), "1") < 0)) {
                        G.Team_color = "0";
                        G.Team_ID = G.ID;
                    }
                }
            }
            else {
                G.Menu.replace(43, "3600");
            }
        }
        yield* this.Pen_mode();
    }
    // procedure: "Set player data temp [b]"
    *Set_player_data_temp__b() {
        // a が指すレコード（CLOUD の a+1 .. a+Number_of_data）を Temp1_2 へ丸ごとコピーする。
        this.Temp1_2.deleteAll();
        this.b = "0";
        const fields = Math.max(0, Math.floor(N(G.Number_of_data)));
        for (let r = 0; r < fields; r++) {
            this.b = N(this.b) + N(1);
            this.Temp1_2.add(G.CLOUD.item((N(this.a) + N(this.b))));
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Draw square" (warp)
    *Draw_square() {
        this.rt.pushWarp();
        try {
            // 画面にグリッド線（50px 間隔）を引く（warp）。カメラ位置の mod 50 でスクロールに追随する。
            this.a = mathop("floor", (N((N((N(-240) / N(G.Zoom_temp))) + N(25))) / N(50)));
            this.setPenColor("#b5b5b5");
            this.setPenSize((N(2) * N(G.Zoom_temp)));
            const vLines = Math.max(0, Math.floor(N((N((N(mathop("abs", this.a)) * N(2))) + N(1)))));
            for (let r = 0; r < vLines; r++) {
                this.gotoXY((N((N((N((N(this.a) * N(50))) - N(25))) + N(mod((N(0) - N(G.All_camera_x)), 50)))) * N(G.Zoom_temp)), 180);
                this.penDown();
                this.gotoXY((N((N((N((N(this.a) * N(50))) - N(25))) + N(mod((N(0) - N(G.All_camera_x)), 50)))) * N(G.Zoom_temp)), -180);
                this.penUp();
                this.a = N(this.a) + N(1);
                if (!this.rt.warpActive)
                    yield;
            }
            this.a = mathop("floor", (N((N((N(180) / N(G.Zoom_temp))) + N(25))) / N(50)));
            const hLines = Math.max(0, Math.floor(N((N((N(this.a) * N(2))) + N(1)))));
            for (let r = 0; r < hLines; r++) {
                this.gotoXY(-240, (N((N((N((N(this.a) * N(50))) - N(25))) + N(mod((N(0) - N(G.All_camera_y)), 50)))) * N(G.Zoom_temp)));
                this.penDown();
                this.gotoXY(240, (N((N((N((N(this.a) * N(50))) - N(25))) + N(mod((N(0) - N(G.All_camera_y)), 50)))) * N(G.Zoom_temp)));
                this.penUp();
                this.a = N(this.a) + N(-1);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Draw wall & object %s %s %s %s %s %s"
    *Draw_wall___object(size, Max_X, Max_Y, X, Y, Zoom_temp) {
        // 壁・オブジェクトの描画。Wall___object は 7 フィールドレコード
        // [キー "gridX/gridY", 種別， gridX, gridY, f5（角度・タイマー）, f6（状態）, f7（予備）]。
        // 引数 X/Y はカメラ中心のグリッド座標で、|grid − 中心| が Max_X/Max_Y 内のものだけ描く。
        // a はレコード先頭のオフセット（7 刻み）。ドアとワープは f5〜f7 が状態を持ち、
        // 描画のたびに更新されてレコードへ書き戻される。
        this.a = "0";
        yield* this.Pen_mode();
        const records = Math.max(0, Math.floor(N(G.Wall___object.length) / N(7)));
        for (let r = 0; r < records; r++) {
            const base = N(this.a);
            this.IDX = (N(G.Wall___object.item(base + 3)) - N(X));
            this.IDY = (N(G.Wall___object.item(base + 4)) - N(Y));
            if (B(compare(mathop("abs", this.IDX), Max_X) < 0) && B(compare(mathop("abs", this.IDY), Max_Y) < 0)) {
                this.gotoXY((N(this.IDX) * N(Zoom_temp)), (N(this.IDY) * N(Zoom_temp)));
                this.pointInDirection(90);
                let type = S(G.Wall___object.item(base + 2));
                if (B(equals(S(type).length, "1"))) {
                    type = (S("0") + S(type));
                }
                if (B(equals(type, "07"))) {
                    // ワープ: 本体 + Lag_cutter 0 のとき残像（GHOST は f5 で揺れる）。f5 は進み続ける
                    this.switchCostume("Warp1");
                    yield* this.Set_size(size, this.costumeNumberName("name"));
                    this.stamp();
                    if (B(equals(G.Lag_cutter, "0"))) {
                        this.switchCostume("Warp2");
                        this.setEffect("GHOST", (N((N(mathop("sin", G.Wall___object.item(base + 5))) * N(20))) + N(20)));
                        this.stamp();
                        this.setEffect("GHOST", 0);
                        G.Wall___object.replace(base + 5, (N(G.Wall___object.item(base + 5)) + N(5)));
                    }
                }
                else if (B(equals(type, "02"))) {
                    if (B(equals(G.Lag_cutter, "0"))) {
                        // ドア: 最寄りのプレイヤー（CLOUD 16 番 = "1"）が 130 未満なら開く側へ、
                        // 居なければ閉じる側へ f5（角度）/ f6（透明度）/ f7（サイズ）を動かす
                        this.Temp1_2.deleteAll();
                        for (let k = 1; k <= 7; k++) {
                            this.Temp1_2.add(G.Wall___object.item(base + k));
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.IDX = (N((N(this.Temp1_2.item(3)) * N(50))) - N(G.X));
                        this.IDY = (N((N(this.Temp1_2.item(4)) * N(50))) - N(G.Y));
                        let scan = "0";
                        this.First_distance = "99999";
                        const players = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
                        for (let p = 0; p < players; p++) {
                            const pbase = N(scan);
                            if (B(equals(G.CLOUD.item(pbase + 16), "1"))) {
                                const dx = (N(G.CLOUD.item(pbase + 3)) - N((N(this.Temp1_2.item(3)) * N(50))));
                                const dy = (N(G.CLOUD.item(pbase + 4)) - N((N(this.Temp1_2.item(4)) * N(50))));
                                const dist = mathop("sqrt", (N((N(dx) * N(dx))) + N((N(dy) * N(dy)))));
                                if (B(compare(dist, this.First_distance) < 0)) {
                                    this.First_distance = dist;
                                }
                            }
                            scan = N(scan) + N(G.Number_of_data);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B(compare(this.First_distance, "130") < 0)) {
                            if (B(compare(this.Temp1_2.item(6), "100") < 0)) {
                                this.Temp1_2.replace(5, (N(this.Temp1_2.item(5)) + N((N(810) / N(G.FPS)))));
                                this.Temp1_2.replace(6, (N(this.Temp1_2.item(6)) + N((N(300) / N(G.FPS)))));
                                this.Temp1_2.replace(7, (N(this.Temp1_2.item(7)) + N((N(-300) / N(G.FPS)))));
                            }
                            else {
                                this.Temp1_2.replace(5, "270");
                                this.Temp1_2.replace(6, "100");
                                this.Temp1_2.replace(7, "0");
                            }
                        }
                        else {
                            if (B(compare("0", this.Temp1_2.item(6)) < 0)) {
                                this.Temp1_2.replace(5, (N(this.Temp1_2.item(5)) + N((N(810) / N(G.FPS)))));
                                this.Temp1_2.replace(6, (N(this.Temp1_2.item(6)) + N((N(-300) / N(G.FPS)))));
                                this.Temp1_2.replace(7, (N(this.Temp1_2.item(7)) + N((N(300) / N(G.FPS)))));
                            }
                            else {
                                this.Temp1_2.replace(5, "0");
                                this.Temp1_2.replace(6, "0");
                                this.Temp1_2.replace(7, "100");
                            }
                        }
                        this.pointInDirection(this.Temp1_2.item(5));
                        this.setEffect("GHOST", this.Temp1_2.item(6));
                        this.switchCostume("Door");
                        yield* this.Set_size((N((N(this.Temp1_2.item(7)) + N(3))) * N(G.Zoom_temp)), this.costumeNumberName("name"));
                        this.stamp();
                        this.setEffect("GHOST", 0);
                        for (let k = 1; k <= 7; k++) {
                            G.Wall___object.replace(base + k, this.Temp1_2.item(k));
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                }
                else {
                    // 静物はコスチューム表で切り替えるだけ
                    const costumeByType = {
                        "01": "Wall", "03": "Bush", "04": "Map pointer", "05": "PVP manager",
                        "06": "Spike wall", "08": "Auto buffer", "09": "Teaming machine",
                        "10": "Information base", "11": "Locker", "12": "Minigame hub1",
                        "13": "Minigame hub2", "14": "Telescope", "16": "Reporter",
                        "17": "Computer", "18": "Grid wall", "25": "Shield",
                        "26": "Record player", "27": "Mud",
                    };
                    if (costumeByType[type]) {
                        this.switchCostume(costumeByType[type]);
                    }
                    if (B(equals(type, "15"))) {
                        // スキルスポット: クールダウン中は spot0 で減らし、満ちたら spot1。
                        // プレイヤーが同マス（±25）に居ればスキルポイント全回復 + 300 のクールダウン
                        if (B(compare("0", G.Wall___object.item(base + 5)) < 0)) {
                            this.switchCostume("Skill spot0");
                            G.Wall___object.replace(base + 5, (N(G.Wall___object.item(base + 5)) - N(G.FPS_temp)));
                        }
                        else {
                            this.switchCostume("Skill spot1");
                            if (B(compare(mathop("abs", (N((N(G.Wall___object.item(base + 3)) * N(50))) - N(G.X))), "25") < 0)
                                && B(compare(mathop("abs", (N((N(G.Wall___object.item(base + 4)) * N(50))) - N(G.Y))), "25") < 0)) {
                                G.Skill_point = G.Max_skill_point;
                                G.Wall___object.replace(base + 5, "300");
                            }
                        }
                    }
                    if (B(equals(type, "19"))) {
                        this.pointInDirection(G.Wall___object.item(base + 5));
                        this.switchCostume("Booster");
                    }
                    if (B(S("20 21 22 23 24 28").includes(S(type)))) {
                        // ギミック壁: 接尾辞は f6 の符号（負なら 1 = 作動側の見た目）
                        const suffix = (N((compare(G.Wall___object.item(base + 6), "0") < 0)) + N(0));
                        if (B(equals(type, "20"))) {
                            this.switchCostume((S("Flash wall") + S(suffix)));
                        }
                        if (B(equals(type, "21"))) {
                            this.switchCostume((S("Heal wall") + S(suffix)));
                        }
                        if (B(equals(type, "22"))) {
                            this.pointInDirection(G.Wall___object.item(base + 5));
                            if (B(equals(mod(this.direction, 90), "0"))) {
                                yield* this.Set_size(size, "Wall");
                            }
                            else {
                                yield* this.Set_size(size, "Laser wall");
                            }
                            this.stamp();
                            this.switchCostume((S("Laser wall") + S(suffix)));
                        }
                        if (B(equals(type, "23"))) {
                            this.switchCostume((S("Warp floor") + S(suffix)));
                            yield* this.Set_size(size, this.costumeNumberName("name"));
                            this.stamp();
                            this.pointInDirection(G.Wall___object.item(base + 5));
                            this.switchCostume("Warp light");
                            this.setEffect("GHOST", (N(100) - N((N(100) / N((N(2250) / N(G.Wall___object.item(base + 5))))))));
                        }
                        if (B(equals(type, "24"))) {
                            this.switchCostume((S("Energy wall") + S(suffix)));
                        }
                        if (B(equals(type, "28"))) {
                            yield* this.Set_size(size, "Wall");
                            this.stamp();
                            this.switchCostume((S("Team gem") + S(suffix)));
                            this.setEffect("COLOR", (N(G.Team_color_2.item(G.TEAMMODE_2.item((N(8) + N((compare("64", G.Wall___object.item(base + 3)) < 0)))))) * N(2)));
                        }
                    }
                    yield* this.Set_size(size, this.costumeNumberName("name"));
                    this.stamp();
                    this.setEffect("COLOR", 0);
                    this.setEffect("GHOST", 0);
                }
                yield* this.Pen_mode();
            }
            this.a = N(this.a) + N(7);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Hit wall"
    *Hit_wall() {
        // 壁との相互作用と移動補正を毎フレーム行う。
        // 前半: Wall___object を走査し、当たり判定キー（Wall_position）と
        //   近接オブジェクトの効果（茂み・トゲ・ブースター・泥・ジェム・ワープ床・
        //   ロッカー、施設メニューの接近アニメーション）を処理する。
        //   対象ゾーンは (X < 450 かつ gridX < 9) || (X > 400 かつ gridX > 8)
        //   （ロビー側と対戦側で見るグリッド範囲が切り替わる）。
        // 後半: 前フレーム位置（Menu[10]/[11]）からの移動量を小刻みに再現し、
        //   Fix position で壁へめり込まない位置まで進める。f/g は Fix position が
        //   読む共有フィールド（1 ステップの移動量）なので this.f / this.g のまま渡す。
        // ギミック壁（20〜24, 28）の f6 はゾーン外でも毎フレーム減衰する。
        this.Wall_position.deleteAll();
        this.a = "0";
        const records = Math.max(0, Math.floor(N(G.Wall___object.length) / N(7)));
        for (let r = 0; r < records; r++) {
            const base = N(this.a);
            const gridX = G.Wall___object.item(base + 3);
            let type = S(G.Wall___object.item(base + 2));
            if (B(equals(S(type).length, "1"))) {
                type = (S("0") + S(type));
            }
            const inZone = (B(compare(G.X, "450") < 0) && B(compare(gridX, "9") < 0))
                || (B(compare("400", G.X) < 0) && B(compare("8", gridX) < 0));
            if (inZone) {
                this.IDX = (N((N(gridX) * N(50))) - N(G.X));
                this.IDY = (N((N(G.Wall___object.item(base + 4)) * N(50))) - N(G.Y));
                if (B(S("01 04 05 06 08 09 10 11 12 13 16 17 18 20 21 22 24 26 28").includes(S(type)))) {
                    const key = G.Wall___object.item(base + 1);
                    if (B(S("01 06 20 21 22 24 28").includes(S(type)))) {
                        // レーザーで切断できる壁は、照準線（Laser_sight）に入った時点で
                        // そのキー以降の照準を全部打ち切る
                        if (B(this.Laser_sight.contains(key))) {
                            const cut = this.Laser_sight.itemNum(key);
                            const tail = Math.max(0, Math.floor(N((N(this.Laser_sight.length) - N(cut)) + N(1))));
                            for (let k = 0; k < tail; k++) {
                                this.Laser_sight.delete(cut);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                    }
                    if (B(compare(mathop("abs", this.IDX), "100") < 0) && B(compare(mathop("abs", this.IDY), "100") < 0)) {
                        this.Wall_position.add(key);
                    }
                }
                if (B(equals(type, "28"))) {
                    // 敵陣ジェム: 相手側の陣地に居ると負のジェムエネルギーが溜まる
                    if (B(compare(mathop("abs", this.IDX), "500") < 0) && B(compare(mathop("abs", this.IDY), "500") < 0)) {
                        if (B((B(equals(letterOf(G.Team_ID, 1), "1")) && B(compare("3200", G.X) < 0))
                            || (B(equals(letterOf(G.Team_ID, 1), "2")) && B(compare(G.X, "3200") < 0)))) {
                            yield* this.Put_buff("負のジェムエネルギー", "5");
                        }
                    }
                }
                if (B(compare(mathop("abs", this.IDX), "150") < 0) && B(compare(mathop("abs", this.IDY), "150") < 0)) {
                    if (B(equals(type, "03"))) {
                        // 茂み: 半径内（Military Pico は広い）で隠れる
                        const radius = (N(26) + N((N(equals(G.Character_name, "Military Pico")) * N(75))));
                        if (B(compare(mathop("abs", this.IDX), radius) < 0) && B(compare(mathop("abs", this.IDY), radius) < 0)) {
                            G.Bush = "1";
                            G.Hiding = "1";
                        }
                    }
                    if (B(equals(type, "06"))) {
                        // トゲ: 十字（60×25 / 25×60）内で毎フレーム 1 ダメージ。
                        // 1 未満から減ったときだけ 0 になり、1 からは 1 に戻る（トゲでは死なない）
                        if (B((B(compare(mathop("abs", this.IDX), "60") < 0) && B(compare(mathop("abs", this.IDY), "25") < 0))
                            || (B(compare(mathop("abs", this.IDX), "25") < 0) && B(compare(mathop("abs", this.IDY), "60") < 0)))) {
                            const wasBelow1 = B(compare(G.Health, "1") < 0) ? "1" : "0";
                            G.Health = N(G.Health) + N((N(-1) * N(G.FPS_temp)));
                            if (B(compare(G.Health, "1") < 0)) {
                                G.Health = B(equals(wasBelow1, "1")) ? "0" : "1";
                            }
                            this.rt.soundPlay("93d6d2b73d6779247a2eb6a5011deb8a.wav");
                            G.Menu.replace(6, "1");
                            G.Menu.replace(7, "100");
                            G.Menu.replace(8, "1");
                        }
                    }
                    if (B(equals(type, "19"))) {
                        // ブースター: f5 の向きへ加速
                        if (B(compare(mathop("abs", this.IDX), "25") < 0) && B(compare(mathop("abs", this.IDY), "25") < 0)) {
                            this.rt.soundPlay("2fb648a0cd07fbef0a8819d8e3bae0d9.wav");
                            G.Speed_x = N(G.Speed_x) + N((N(mathop("sin", G.Wall___object.item(base + 5))) * N((N(10) * N(G.FPS_temp)))));
                            G.Speed_y = N(G.Speed_y) + N((N(mathop("cos", G.Wall___object.item(base + 5))) * N((N(10) * N(G.FPS_temp)))));
                        }
                    }
                    if (B(equals(type, "27"))) {
                        if (B(compare(mathop("abs", this.IDX), "26") < 0) && B(compare(mathop("abs", this.IDY), "26") < 0)) {
                            this.Mud = "1";
                        }
                    }
                }
                if (B(equals(type, "23"))) {
                    // ワープ床: f6 が負のあいだ踏み続けると f5 が溜まり、2250 超で
                    // f7 の 6 桁（行き先グリッド×2、−500 オフセット）へ転送される
                    if (B(compare(mathop("abs", this.IDX), "25") < 0) && B(compare(mathop("abs", this.IDY), "25") < 0)) {
                        if (B(compare(G.Wall___object.item(base + 6), "0") < 0)) {
                            if (B(equals(G.Special_weapon, "0"))) {
                                G.Wall___object.replace(base + 5, (N(G.Wall___object.item(base + 5)) + N((N(15) * N(G.FPS_temp)))));
                                if (B(compare("2250", G.Wall___object.item(base + 5)) < 0)) {
                                    this.rt.soundPlay("ca59bd66b9a2dd04c17bd3658227b194.wav");
                                    yield* this.Put_buff("平和", "60");
                                    const dest = G.Wall___object.item(base + 7);
                                    const destX = (N((S(letterOf(dest, 1)) + S((S(letterOf(dest, 2)) + S(letterOf(dest, 3)))))) - N(500));
                                    const destY = (N((S(letterOf(dest, 4)) + S((S(letterOf(dest, 5)) + S(letterOf(dest, 6)))))) - N(500));
                                    G.X = (N(destX) * N(50));
                                    G.Y = (N(destY) * N(50));
                                    G.Wall___object.replace(base + 5, "0");
                                    G.Wall___object.replace(base + 6, "300");
                                    G.Wall___object.replace((N(G.Wall___object.itemNum((S(destX) + S((S("/") + S(destY)))))) + N(5)), "300");
                                }
                            }
                        }
                    }
                    else {
                        G.Wall___object.replace(base + 5, "0");
                    }
                }
                if (B(equals(type, "04"))) {
                    const near = B(compare(mathop("abs", this.IDX), "75") < 0) && B(compare(mathop("abs", this.IDY), "75") < 0);
                    yield* this.CSM_menu("2", near ? "160" : "520", "M", "5");
                }
                if (B(equals(type, "05"))) {
                    const near = B(compare(mathop("abs", this.IDX), "25") < 0) && B(compare(mathop("abs", this.IDY), "75") < 0);
                    yield* this.CSM_menu("95", near ? "160" : "520", "M", "4");
                }
                if (B(equals(type, "11"))) {
                    // ロッカー: 近づいたら所持武器をサブ武器が前へ来るよう並べ替える（1 回だけ）
                    if (B(compare(mathop("abs", this.IDX), "75") < 0) && B(compare(mathop("abs", this.IDY), "75") < 0)) {
                        if (B(equals(G.Menu.item(19), "0"))) {
                            let d = G.Got_weapon.length;
                            let moved = "0";
                            const count = Math.max(0, Math.floor(N(G.Got_weapon.length)));
                            for (let k = 0; k < count; k++) {
                                const isSub = (N(S(G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(G.Got_weapon.item(d)))) + N(1)))).toLowerCase().includes(S("サブ"))) + N(0));
                                if (B(equals(isSub, "1"))) {
                                    G.Got_weapon.insert(G.Got_weapon.item(d), (N((N(G.Got_weapon.length) - N(moved))) + N(1)));
                                    G.Got_weapon.delete(d);
                                    moved = N(moved) + N(1);
                                }
                                d = N(d) + N(-1);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            G.Menu.replace(25, (N(G.Got_weapon.length) - N(moved)));
                            G.Menu.replace(26, "0");
                            G.Menu.replace(27, "0");
                            G.Menu.replace(19, "5");
                        }
                    }
                    else {
                        if (B(equals(G.Menu.item(19), "5"))) {
                            G.Menu.replace(19, "0");
                        }
                    }
                }
                if (B(equals(type, "16"))) {
                    const near = B(compare(mathop("abs", this.IDX), "75") < 0) && B(compare(mathop("abs", this.IDY), "75") < 0);
                    yield* this.CSM_menu("86", near ? "160" : "520", "M", "4");
                }
                if (B(equals(type, "17"))) {
                    const near = B(compare(mathop("abs", this.IDX), "75") < 0) && B(compare(mathop("abs", this.IDY), "25") < 0);
                    yield* this.CSM_menu("94", near ? "160" : "520", "M", "4");
                }
            }
            if (B(S("20 21 22 23 24 28").includes(S(type)))) {
                G.Wall___object.replace(base + 6, (N(G.Wall___object.item(base + 6)) - N(G.FPS_temp)));
            }
            this.a = N(this.a) + N(7);
            if (!this.rt.warpActive)
                yield;
        }
        // 移動補正: 前フレーム位置からの差分を 1 ずつ刻んで Fix position に通す
        let dx = (N(G.X) - N(G.Menu.item(10)));
        let dy = (N(G.Y) - N(G.Menu.item(11)));
        const total = (N(mathop("abs", dx)) + N(mathop("abs", dy)));
        const speedSum = (N(mathop("abs", G.Speed_x)) + N(mathop("abs", G.Speed_y)));
        if (B(compare(G.FPS, "15") < 0) || B(compare("1.5", speedSum) < 0) || B(compare(total, "100") < 0)) {
            if (B(compare("10", speedSum) < 0) && B(compare("100", total) < 0)) {
                // 速すぎる移動は前位置へ戻す（壁抜け・テレポート対策）
                G.X = G.Menu.item(10);
                G.Y = G.Menu.item(11);
            }
            else {
                if (B(compare("7", (N(mathop("abs", dx)) / N(G.FPS_temp))) < 0) || B(compare("7", (N(mathop("abs", dy)) / N(G.FPS_temp))) < 0)) {
                    if (B(compare("15", total) < 0)) {
                        yield* this.Get_mission_point("Dash", "15");
                    }
                    else {
                        yield* this.Get_mission_point("Dash", total);
                    }
                }
                const steps = mathop("ceiling", (N(total) / N(1)));
                this.f = (N(dx) / N(steps));
                this.g = (N(dy) / N(steps));
                if (B(equals(dx, "0"))) {
                    dx = (N((N((compare(mod(G.X, 50), "25") < 0)) * N(2))) - N(1));
                }
                else {
                    dx = (N(dx) / N(mathop("abs", dx)));
                }
                if (B(equals(dy, "0"))) {
                    dy = (N((N((compare(mod(G.Y, 50), "25") < 0)) * N(2))) - N(1));
                }
                else {
                    dy = (N(dy) / N(mathop("abs", dy)));
                }
                G.X = G.Menu.item(10);
                G.Y = G.Menu.item(11);
                yield* this.Fix_position(steps, (N(this.Temp1_2.item(3)) * N(50)), (N(this.Temp1_2.item(4)) * N(50)), (N((N((compare("0", dx) < 0)) * N(30))) - N(15)), (N((N((compare("0", dy) < 0)) * N(30))) - N(15)));
            }
        }
        // カメラ: シェイク中（Menu[14] > 0）は乱数を足してカウンタを減らす
        if (B(compare("0", G.Menu.item(14)) < 0)) {
            G.All_camera_x = (N(G.X) + N((N(G.Camera_x) + N(random(-3, 3)))));
            G.All_camera_y = (N(G.Y) + N((N(G.Camera_y) + N(random(-3, 3)))));
            yield* this.CSM_menu("14", "-1", "C", "0");
        }
        else {
            G.All_camera_x = (N(G.X) + N(G.Camera_x));
            G.All_camera_y = (N(G.Y) + N(G.Camera_y));
        }
        if (B(compare("0", this.Laser_sight.length) < 0)) {
            G.Laser_sight_length = (N((N(this.Laser_sight.length) * N(50))) - N(5));
        }
        else {
            G.Laser_sight_length = "0";
        }
    }
    // procedure: "Draw inventory [a,b,c] %s %s"
    *Draw_inventory__a_b_c(number, v_length) {
        // インベントリ1スロットの描画: 枠（選択中は赤、呪いは色が明滅）、
        // 残量バー 18 段、アイコンのスタンプ、サブ武器のチャージピップ。
        // number はスロット先頭オフセット（0/6/12/18/24）、v_length は枠の横幅。
        this.c = (N(S(G.Inventory_2.item((N(number) + N(2)))).toLowerCase().includes(S("呪い").toLowerCase())) - N(0));
        if (B(equals(G.Inventory_2.item(31), (N((N(number) / N(6))) + N(1))))) {
            this.setPenColor("#ff0000");
            if (B(equals(this.c, "1"))) {
                this.setPenParam(S("color"), (N(40) + N((N(mathop("sin", (N(this.rt.timer()) * N(300)))) * N(5)))));
                this.setPenParam(S("saturation"), 75);
            }
        }
        else {
            this.setPenColor("#000000");
            if (B(equals(this.c, "1"))) {
                this.setPenColor("#009a3f");
                this.setPenParam(S("brightness"), (N(10) + N((N(mathop("sin", (N(this.rt.timer()) * N(300)))) * N(10)))));
            }
        }
        this.setPenParam(S("transparency"), 100);
        this.setPenSize(6);
        this.penDown();
        this.setPenParam(S("transparency"), 50);
        this.changeXBy(v_length);
        this.changeYBy(-40);
        this.changeXBy((N(0) - N(v_length)));
        this.changeYBy(40);
        this.penUp();
        this.changeXBy(4);
        this.changeYBy(-36);
        this.b = G.Inventory_2.item((N(number) + N(4)));
        this.c = G.Inventory_2.item((N(number) + N(3)));
        if (B(equals(G.Inventory_2.item((N(number) + N(4))), "0"))) {
            if (B(equals(G.Inventory_2.item((N(number) + N(1))), ""))) {
                this.a = "0";
            }
            else {
                this.a = "18";
            }
        }
        else {
            this.a = mathop("floor", (N(18) / N((N(this.b) / N(mathop("abs", this.c))))));
            if (B((compare("0", this.a) < 0))) {
                this.a = (N(mod((N(this.a) - N(1)), 18)) + N(1));
            }
        }
        if (B((compare("0", G.Inventory_2.item((N(number) + N(5)))) < 0))) {
            this.setPenColor("#00eaea");
            this.a = mathop("floor", (N(18) / N((N(100) / N(G.Inventory_2.item((N(number) + N(5))))))));
        }
        else {
            if (B((compare(this.c, "0") < 0))) {
                this.setPenColor("#158000");
            }
            else {
                this.setPenColor("#2aff00");
            }
        }
        this.setPenSize(3);
        const segs = Math.max(0, Math.floor(N(this.a)));
        for (let r = 0; r < segs; r++) {
            this.penDown();
            this.changeXBy((N(v_length) - N(9)));
            this.penUp();
            this.changeXBy((N(0) - N((N(v_length) - N(9)))));
            this.changeYBy(1.84);
            if (!this.rt.warpActive)
                yield;
        }
        if (B((compare("0", G.Inventory_2.item((N(number) + N(5)))) < 0))) {
            this.setPenColor("#23da00");
        }
        else {
            this.setPenColor("#9a9a9a");
        }
        const rest = Math.max(0, Math.floor(N((N(18) - N(this.a)))));
        for (let r = 0; r < rest; r++) {
            this.penDown();
            this.changeXBy((N(v_length) - N(9)));
            this.penUp();
            this.changeXBy((N(0) - N((N(v_length) - N(9)))));
            this.changeYBy(1.84);
            if (!this.rt.warpActive)
                yield;
        }
        this.changeXBy((N(16) + N((N((N(v_length) - N(40))) / N(2)))));
        this.changeYBy(-17.6);
        this.pointInDirection(90);
        this.switchCostume((S("@") + S(G.Inventory_2.item((N(number) + N(1))))));
        this.size = N(85);
        this.stamp();
        yield* this.Pen_mode();
        this.changeYBy(-20);
        if (B(S(G.Inventory_2.item((N(number) + N(2)))).toLowerCase().includes(S("サブ").toLowerCase()))) {
            this.a = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(G.Inventory_2.item((N(number) + N(1)))))) + N(4)));
            if (B((compare("1", this.a) < 0))) {
                this.changeXBy((N((N(this.a) - N(1))) * N(-6)));
                this.b = "0";
                const pips = Math.max(0, Math.floor(N(this.a)));
                for (let r = 0; r < pips; r++) {
                    this.b = N(this.b) + N(1);
                    if (B((compare(this.b, (N(mathop("floor", (N(G.Inventory_2.item((N(number) + N(3)))) / N(G.Inventory_2.item((N(number) + N(4))))))) + N(1))) < 0))) {
                        this.setPenColor("#ffb700");
                    }
                    else {
                        this.setPenColor("#4e3800");
                    }
                    this.setPenSize(10);
                    this.penDown();
                    this.penUp();
                    this.changeXBy(12);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.changeXBy((N((N((N(this.a) - N(1))) * N(-6))) - N(12)));
            }
        }
        this.changeYBy(40.5);
        this.changeXBy((N(28) + N((N((N(v_length) - N(40))) / N(2)))));
    }
    // procedure: "Shot [c] %s %b"
    *Shot__c(number, Full) {
        // 発射。number はインベントリのスロット位置（0始まりのオフセット）。
        // c は「音を鳴らしたか」のフラグ（Weapon motion が読む）。
        // My_shot へ [武器番号+100][連番2桁][チャージ2桁] を記録し、
        // クラウド経由で他プレイヤーへ伝わる。
        if (B(equals(G.Block_num, "0"))) {
            G.Shooting = "1";
            this.c = "0";
            const burstReady = B(Full) || (compare("0", G.Menu.item(35)) < 0 && compare(G.Menu.item(36), "1") < 0);
            if (burstReady) {
                G.Menu.replace(56, "0");
                if (B(compare(number, "800") < 0)) {
                    yield* this.Sound(G.Item_list.item(N(G.Item_list.itemNum(G.Inventory_2.item(N(number) + 1))) + 9));
                    this.c = "1";
                }
                // 連番は 00..99 で循環し、常に2桁
                G.Shot = N(G.Shot) + 1;
                if (B(compare("99", G.Shot) < 0))
                    G.Shot = "0";
                if (B(equals(S(G.Shot).length, "1")))
                    G.Shot = S("0") + S(G.Shot);
                if (B(compare(number, "800") < 0)) {
                    // チャージ: 蓄積が2以上なら floor(蓄積)-1 を消費して確定する
                    if (B(equals(G.Charge, "00"))) {
                        if (B(compare(G.Inventory_2.item(N(number) + 5), "2") < 0)) {
                            G.Charge = "00";
                        }
                        else {
                            G.Charge = N(mathop("floor", G.Inventory_2.item(N(number) + 5))) - 1;
                            if (B(compare(S(G.Charge).length, "2") < 0))
                                G.Charge = S("0") + S(G.Charge);
                        }
                    }
                    if (B(!B(equals(G.Inventory_2.item(N(number) + 1), "")))) {
                        G.My_shot.add(S(N(G.Weapon_name.itemNum(G.Inventory_2.item(N(number) + 1))) + 100) + S(S(G.Shot) + S(G.Charge)));
                    }
                    // 残弾消費: オーバーヒート武器は末尾2桁-10 を消費し -1 まで下がる
                    if (B(S(this.a).toLowerCase().includes(S("オーバーヒート").toLowerCase()))) {
                        const heatCost = N(S(letterOf(this.a, N(S(this.a).length) - 1)) + S(letterOf(this.a, S(this.a).length))) - 10;
                        G.Inventory_2.replace(N(number) + 3, N(G.Inventory_2.item(N(number) + 3)) - heatCost);
                        if (B(compare(G.Inventory_2.item(N(number) + 3), "1") < 0))
                            G.Inventory_2.replace(N(number) + 3, "-1");
                    }
                    else {
                        G.Inventory_2.replace(N(number) + 3, N(G.Inventory_2.item(N(number) + 3)) - N(G.Inventory_2.item(N(number) + 4)));
                        if (B(compare(G.Inventory_2.item(N(number) + 3), "1") < 0))
                            G.Inventory_2.replace(N(number) + 3, "0");
                    }
                    G.Inventory_2.replace(N(number) + 5, "0");
                }
                else {
                    // 800以上は投擲系: 番号そのまま + 連番 + "00"
                    G.My_shot.add(S(number) + S(S(G.Shot) + S("00")));
                }
            }
        }
    }
    // procedure: "Reload inventory %s"
    *Reload_inventory(number) {
        // 残弾の回復とチャージ蓄積（毎フレーム呼ばれる）。
        // スロットレイアウトは Set weapon と同じ [+1]=名前 [+2]=種別 [+3]=残弾
        // [+4]=容量（発射時は消費量も兼ねる） [+5]=チャージ蓄積。
        const type = S(G.Inventory_2.item(N(number) + 2));
        const ammoIdx = N(number) + 3, capIdx = N(number) + 4, chargeIdx = N(number) + 5;
        if (type.toLowerCase().includes(S("オーバーヒート").toLowerCase())) {
            // オーバーヒート: 負値が蓄熱中。冷え切るまで負方向へ進み、
            // 正値のまま非選択なら符号を反転して冷却を始める
            if (B(compare(G.Inventory_2.item(ammoIdx), "0") < 0)) {
                G.Inventory_2.replace(ammoIdx, N(G.Inventory_2.item(ammoIdx)) - N(G.FPS_temp));
                if (B(compare(G.Inventory_2.item(capIdx), mathop("abs", G.Inventory_2.item(ammoIdx))) < 0)) {
                    G.Inventory_2.replace(ammoIdx, G.Inventory_2.item(capIdx));
                }
            }
            else if (B(!B(equals(number, G.Inventory))) && B(!B(equals(G.Inventory_2.item(ammoIdx), G.Inventory_2.item(capIdx))))) {
                G.Inventory_2.replace(ammoIdx, 0 - N(G.Inventory_2.item(ammoIdx)));
            }
            return;
        }
        // 実効容量: サブ武器は Item_list の倍率（名前インデックス+4）が掛かる
        if (type.toLowerCase().includes(S("サブ").toLowerCase())) {
            this.b = G.Item_list.item(N(G.Weapon.item(G.Weapon_name.itemNum(G.Inventory_2.item(N(number) + 1)))) + 4);
            this.b = B(compare("1", this.b) < 0) ? N(G.Inventory_2.item(capIdx)) * N(this.b) : G.Inventory_2.item(capIdx);
        }
        else {
            this.b = G.Inventory_2.item(capIdx);
        }
        if (B(compare(G.Inventory_2.item(ammoIdx), G.Inventory_2.item(capIdx)) < 0)) {
            this.a = "0"; // 満タンでない
        }
        else {
            this.a = "1"; // 満タン: チャージ蓄積フェーズ
            if (type.toLowerCase().includes(S("チャージ").toLowerCase())) {
                this.d = G.Inventory_2.item(N(number) + 2);
                this.c = S(this.d).length;
                this.e = "0";
                if (type.toLowerCase().includes(S("サブ").toLowerCase())) {
                    this.e = "1";
                }
                else if (B(equals(G.Scoping, "0"))) {
                    G.Inventory_2.replace(chargeIdx, "0");
                }
                else {
                    this.e = "1";
                }
                if (B(equals(this.e, "1"))) {
                    // チャージ速度は種別名の末尾4桁-1000 で決まる
                    this.f = G.Inventory_2.item(chargeIdx);
                    this.g = this.f;
                    const tail4 = S(letterOf(this.d, N(this.c) - 3)) + S(S(letterOf(this.d, N(this.c) - 2)) + S(S(letterOf(this.d, N(this.c) - 1)) + S(letterOf(this.d, this.c))));
                    this.f = N(this.f) + N(100) / (N(tail4) - 1000) * N(G.FPS_temp);
                    if (B(compare("100", this.f) < 0))
                        this.f = "100";
                    G.Inventory_2.replace(chargeIdx, this.f);
                    // 33 ごとの区切りを跨いだらチャージ音
                    if (B(!type.toLowerCase().includes(S("サブ").toLowerCase()))) {
                        if (B(compare(mod(this.f, 33), mod(this.g, 33)) < 0)) {
                            this.rt.soundPlay(B(compare("99", this.f) < 0) ? "a6e6fc72f8ae8041291a30933682b661.wav" : "37613abfa9192f6928021ff88984b2c1.wav");
                        }
                    }
                }
            }
            else {
                G.Inventory_2.replace(chargeIdx, "0");
            }
        }
        // 回復: サブ武器か選択中スロットは FPS_temp ずつ、それ以外は 7/FPS ずつ
        const fastRecovery = type.toLowerCase().includes(S("サブ").toLowerCase()) || B(equals(number, G.Inventory));
        if (fastRecovery) {
            const rate = type.toLowerCase().includes(S("二丁拳銃").toLowerCase()) && B(equals(G.Scoping, "1")) ? 1.5 * N(G.FPS_temp) : N(G.FPS_temp);
            G.Inventory_2.replace(ammoIdx, N(G.Inventory_2.item(ammoIdx)) + rate);
        }
        else if (B(!type.toLowerCase().includes(S("呪い").toLowerCase()))) {
            G.Inventory_2.replace(ammoIdx, N(G.Inventory_2.item(ammoIdx)) + 7 / N(G.FPS));
            if (B(!type.toLowerCase().includes(S("サブ").toLowerCase())))
                G.Inventory_2.replace(chargeIdx, "0");
        }
        // 実効容量でクランプ。サブ武器が空から満タンになったら音
        if (B(compare(this.b, G.Inventory_2.item(ammoIdx)) < 0)) {
            G.Inventory_2.replace(ammoIdx, this.b);
            if (B(equals(this.a, "0")) && type.toLowerCase().includes(S("サブ").toLowerCase())) {
                this.rt.soundPlay("f177de53591bce5e0f43d3c66eb3b2c9.wav");
            }
        }
    }
    // procedure: "Set val" (warp)
    *Set_val() {
        this.rt.pushWarp();
        try {
            // 全体初期化。起動時に一度だけ呼ばれる。
            // レコード長は Cloud memo（フィールド名一覧）の項目数 = 62 が正。
            this.visible = false;
            G.Number_of_data = G.Cloud_memo.length;
            yield* this.Create_user_ID();
            // 作業用リストをすべて空にする
            G.CLOUD.deleteAll();
            this.Cloud_check.deleteAll();
            this.Player_movement.deleteAll();
            G.Bullet_and_effect.deleteAll();
            this.Delete_bullet.deleteAll();
            this.Screen_effect.deleteAll();
            this.Delete_screen_effect.deleteAll();
            this.Players_shot.deleteAll();
            this.Laser_sight.deleteAll();
            G.Got_weapon.deleteAll();
            G.Buff_Debuff.deleteAll();
            this.Chat_user.deleteAll();
            this.Screen_stamp.deleteAll();
            G.Blocked_player.deleteAll();
            this.Skill_counter.deleteAll();
            G.Ignored_invitation.deleteAll();
            G.My_IDs.deleteAll();
            // Menu（116 項目の状態配列）の初期値。[値, 個数] の並びで組み立てる。
            // 意味のある位置: 2=520（基準幅）, 23=40, 24=-250, 51=160, 62=270,
            // 63="-", 85="0000"（通報対象の初期値）, 98=100, 100..103="-352"。
            // 組み立て後に 49=経過秒数, 76="-1", 111="0000", 113="233", 116="-" を差し替え、
            // 29/30 はショップ集計、88 はペット集計で後から書く。
            G.Menu.deleteAll();
            const menuInit = [
                ["0", 1], ["520", 1], ["0", 17], ["520", 1], ["0", 2], ["40", 1], ["-250", 1],
                ["0", 16], ["520", 1], ["0", 9], ["160", 1], ["0", 10], ["270", 1], ["-", 1],
                ["0", 5], ["520", 2], ["0", 14], ["0000", 1], ["520", 1], ["0", 7], ["520", 2],
                ["0", 2], ["100", 1], ["0", 1], ["-352", 4], ["0", 13],
            ];
            for (const [value, count] of menuInit) {
                for (let i = 0; i < count; i++) {
                    G.Menu.add(value);
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            G.Menu.replace(49, N(this.rt.daysSince2000()) * 86400);
            G.Menu.replace(76, "-1");
            G.Menu.replace(111, "0000");
            G.Menu.replace(113, "233");
            G.Menu.replace(116, "-");
            // Inventory mode: 先頭 "1" + 空 6 + （"", "", 0, 0, 0, 0）× 15 = 97 項目
            this.Inventory_mode.deleteAll();
            this.Inventory_mode.add("1");
            for (let i = 0; i < 6; i++) {
                this.Inventory_mode.add("");
                if (!this.rt.warpActive)
                    yield;
            }
            for (let i = 0; i < 15; i++) {
                this.Inventory_mode.add("");
                this.Inventory_mode.add("");
                this.Inventory_mode.add("0");
                this.Inventory_mode.add("0");
                this.Inventory_mode.add("0");
                this.Inventory_mode.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            // Turrets: 15 フィールド × 2 基の初期配置（x, y, 向き, ?, ?, 名前, ...）
            G.Turrets.deleteAll();
            const turretInit = [
                "3200", "0", "90", "83", "0", "戦車", "0", "", "", "", "", "", "", "", "",
                "4300", "-750", "90", "83", "0", "0", "0", "-", "0", "0", "0", "0", "0", "0", "0",
            ];
            for (const v of turretInit)
                G.Turrets.add(v);
            this.Team_chat.deleteAll();
            // 自分の発射・被弾イベントの送信バッファ（空イベントで初期化）
            G.My_shot.deleteAll();
            for (let i = 0; i < 9; i++) {
                G.My_shot.add("0000000");
                if (!this.rt.warpActive)
                    yield;
            }
            this.Players_hit.deleteAll();
            G.My_hit.deleteAll();
            for (let i = 0; i < 6; i++) {
                G.My_hit.add("000000000");
                if (!this.rt.warpActive)
                    yield;
            }
            G.DATA.deleteAll();
            for (let i = 0; i < 10; i++) {
                G.DATA.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            G.Motion.deleteAll();
            for (let i = 0; i < 10; i++) {
                G.Motion.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            this.Buff_name.deleteAll();
            // Mobile_2: タッチ UI のレイアウト初期値
            G.Mobile_2.deleteAll();
            G.Mobile_2.add("-100");
            G.Mobile_2.add("0");
            G.Mobile_2.add("100");
            G.Mobile_2.add("0");
            G.Mobile_2.add("-");
            for (let i = 0; i < 19; i++) {
                G.Mobile_2.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            // Buff name: Buff（20 フィールド × n）から名前だけ抜く
            this.a = "1";
            const buffCount = Math.max(0, Math.floor(N(G.Buff.length) / 20));
            for (let i = 0; i < buffCount; i++) {
                this.Buff_name.add(G.Buff.item(this.a));
                this.a = N(this.a) + 20;
                if (!this.rt.warpActive)
                    yield;
            }
            // Bullet name: Bullet list の "" 区切りの直後にある名前を集める。
            // Bullet にはその名前の Bullet list 内の位置（先頭オフセット）を入れる。
            this.Bullet_name.deleteAll();
            this.a = "0";
            const bulletFields = Math.max(0, Math.floor(N(G.Bullet_list.length)));
            for (let i = 0; i < bulletFields; i++) {
                this.a = N(this.a) + 1;
                if (B(equals(G.Bullet_list.item(N(this.a) - 1), ""))) {
                    this.Bullet_name.add(G.Bullet_list.item(this.a));
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.Bullet.deleteAll();
            this.a = "0";
            const bulletNames = Math.max(0, Math.floor(N(this.Bullet_name.length)));
            for (let i = 0; i < bulletNames; i++) {
                this.a = N(this.a) + 1;
                this.Bullet.add(G.Bullet_list.itemNum(this.Bullet_name.item(this.a)));
                if (!this.rt.warpActive)
                    yield;
            }
            // Character tree の進行度（10 ごとに並ぶ 6 番目）を 0 に戻す
            this.a = "6";
            const treeCount = Math.max(0, Math.floor(N(G.Character_tree.length) / 10));
            for (let i = 0; i < treeCount; i++) {
                G.Character_tree.replace(this.a, "0");
                this.a = N(this.a) + 10;
                if (!this.rt.warpActive)
                    yield;
            }
            // Weapon name / Weapon: Item list（14 フィールド × n）から武器名と
            // レコード先頭オフセットを集める。ついでに期間限定武器の価格フィールド
            // （+3、"m" を含む形式）: 対象月なら "10"、それ以外は "60" に書き換える。
            G.Weapon_name.deleteAll();
            G.Weapon.deleteAll();
            this.a = "1";
            const itemCount = Math.max(0, Math.floor(N(G.Item_list.length) / 14));
            for (let i = 0; i < itemCount; i++) {
                this.b = G.Item_list.item(this.a);
                G.Weapon_name.add(this.b);
                this.b = G.Item_list.item(N(this.a) + 3);
                if (B(S(this.b).toLowerCase().includes("m"))) {
                    if (B(equals(this.rt.current("MONTH"), S(letterOf(this.b, 2)) + S(letterOf(this.b, 3))))) {
                        G.Item_list.replace(N(this.a) + 3, "10");
                    }
                    else {
                        G.Item_list.replace(N(this.a) + 3, "60");
                    }
                }
                G.Weapon.add(this.a);
                this.a = N(this.a) + 14;
                if (!this.rt.warpActive)
                    yield;
            }
            // Shop menu: "*カテゴリ名" コスチュームを順にたどり、先頭 1 文字を除いた
            // 名前を並べる。武器名簿に無いカテゴリの前には "" の区切りを入れ、
            // カテゴリ数を数える（通常は c、Bomb 系は d。e は現在のセクションを保持し、
            // Bomb で 1、Curse で 2 になる。Curse 系はどちらにも数えない）。
            // f は直前に区切りが入ったカテゴリ名で、"Team" の間は後続の全項目が
            // Team sub にも入る（原作の判定のまま）。
            G.Shop_menu.deleteAll();
            G.Team_sub.deleteAll();
            this.c = "1";
            this.d = "0";
            this.e = "0";
            this.f = "0";
            this.switchCostume("*Gun");
            while (!B(!B(S(this.costumeNumberName("name")).toLowerCase().includes("*")))) {
                this.a = "1";
                this.b = "";
                const nameLen = Math.max(0, Math.floor(N(S(this.costumeNumberName("name")).length) - 1));
                for (let i = 0; i < nameLen; i++) {
                    this.a = N(this.a) + 1;
                    this.b = S(this.b) + S(letterOf(this.costumeNumberName("name"), this.a));
                    if (!this.rt.warpActive)
                        yield;
                }
                if (!B(equals(this.b, "Gun")) && !B(G.Weapon_name.contains(this.b))) {
                    G.Shop_menu.add("");
                    this.f = this.b;
                    if (B(equals(this.b, "Bomb"))) {
                        this.e = "1";
                    }
                    if (B(equals(this.b, "Curse"))) {
                        this.e = "2";
                    }
                    if (B(equals(this.e, "0"))) {
                        this.c = N(this.c) + 1;
                    }
                    else if (B(equals(this.e, "1"))) {
                        this.d = N(this.d) + 1;
                    }
                }
                G.Shop_menu.add(this.b);
                if (B(equals(this.f, "Team"))) {
                    G.Team_sub.add(this.b);
                }
                this.nextCostume();
                if (!this.rt.warpActive)
                    yield;
            }
            G.Menu.replace(29, this.c);
            G.Menu.replace(30, this.d);
            // 作者（uk-400）だけが使えるキャラ。それ以外では "-" に潰す
            // （61 番への代入はどちらの分岐も if(false) で無効化済み）
            if (B(equals(this.rt.username, "uk-400"))) {
                if (B(false)) {
                    G.Character_tree.replace(61, "Spiky Gobo");
                }
                G.Character_tree.replace(231, "Crystal Gobo");
                G.Character_tree.replace(241, "Gem Cat");
            }
            else {
                if (B(false)) {
                    G.Character_tree.replace(61, "-");
                }
                G.Character_tree.replace(231, "-");
                G.Character_tree.replace(241, "-");
            }
            // 作者以外ではショップから一部の武器を外す
            if (!B(equals(this.rt.username, "uk-400"))) {
                G.Shop_menu.delete(G.Shop_menu.itemNum("コインガン"));
                G.Shop_menu.delete(G.Shop_menu.itemNum("ワープボム"));
                G.Shop_menu.delete(G.Shop_menu.itemNum("サンライトボム"));
                G.Shop_menu.delete(G.Shop_menu.itemNum("ショルダーファン"));
            }
            // Starter（初期所持品）: 固定枠 + 季節枠 + 日替わり枠で組み立てる
            this.Starter.deleteAll();
            this.Starter.add("ピストル");
            if (B(equals(this.rt.current("MONTH"), "8")) && B(equals(mod(this.rt.current("DATE"), 2), "1"))) {
                this.Starter.add("スイカSMG");
            }
            else {
                this.Starter.add("マシンガン");
            }
            if (B(equals(this.rt.current("MONTH"), "12")) && B(equals(mod(this.rt.current("DATE"), 2), "0"))) {
                this.Starter.add("スノーボールキャノン");
            }
            else {
                this.Starter.add("アサルトライフル");
            }
            // 日替わり枠 1: サブでも呪いでもない武器から 2 つ（候補プールは Temp1_2。
            // プール構築中は d を種別フィールドの一時置き場に使う）
            this.b = "0";
            this.Temp1_2.deleteAll();
            const weaponCount1 = Math.max(0, Math.floor(N(G.Weapon_name.length)));
            for (let i = 0; i < weaponCount1; i++) {
                this.b = N(this.b) + 1;
                this.c = G.Weapon_name.item(this.b);
                if (!B(equals(this.c, ""))) {
                    this.d = G.Item_list.item(N(G.Weapon.item(G.Weapon_name.itemNum(this.c))) + 1);
                    if (!B(S(this.d).toLowerCase().includes("サブ") || S(this.d).toLowerCase().includes("呪い")) &&
                        B(G.Shop_menu.contains(this.c)) && !B(this.Starter.contains(this.c))) {
                        this.Temp1_2.add(this.c);
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
            if (!B(0)) {
                this.Temp1_2.delete(this.Temp1_2.itemNum("コインガン"));
                this.Temp1_2.delete(this.Temp1_2.itemNum("ショルダーファン"));
                this.Temp1_2.delete(this.Temp1_2.itemNum("アキュレートスナイパー"));
            }
            // 日替わりインデックス d: 日数（2000 年からの経過 + 0.2666）の下 2 桁から作る
            this.b = mathop("floor", N(this.rt.daysSince2000()) + 0.2666);
            this.d = N(S(letterOf(this.b, N(S(this.b).length) - 1)) + S(letterOf(this.b, S(this.b).length))) + (N(letterOf(this.b, S(this.b).length)) - N(letterOf(this.b, N(S(this.b).length) - 1)));
            this.Starter.add(this.Temp1_2.item(N(mod(this.d, this.Temp1_2.length)) + 1));
            this.Starter.add(this.Temp1_2.item(N(mod(N(this.d) + (N(letterOf(this.b, S(this.b).length)) + 1), this.Temp1_2.length)) + 1));
            this.Starter.add("");
            this.a = N(this.Starter.length) + 1;
            if (B(equals(this.rt.current("MONTH"), "12")) && B(equals(mod(this.rt.current("DATE"), 2), "1"))) {
                this.Starter.add("幸福のポーチ");
                this.Starter.add("アイスブーツ");
                this.Starter.add("かまくら");
            }
            else {
                this.Starter.add("手榴弾");
                if (B(equals(this.rt.current("MONTH"), "10")) && B(equals(mod(this.rt.current("DATE"), 2), "1"))) {
                    this.Starter.add("トリック");
                    this.Starter.add("トリート");
                }
                else {
                    this.Starter.add("ミニ手榴弾");
                    this.Starter.add("フラッシュボム");
                }
            }
            // 日替わり枠 2: サブ武器から 1 つ
            this.b = "0";
            this.Temp1_2.deleteAll();
            const weaponCount2 = Math.max(0, Math.floor(N(G.Weapon_name.length)));
            for (let i = 0; i < weaponCount2; i++) {
                this.b = N(this.b) + 1;
                this.c = G.Weapon_name.item(this.b);
                if (!B(equals(this.c, ""))) {
                    if (B(S(G.Item_list.item(N(G.Weapon.item(G.Weapon_name.itemNum(this.c))) + 1)).toLowerCase().includes("サブ")) &&
                        B(G.Shop_menu.contains(this.c)) && !B(this.Starter.contains(this.c))) {
                        this.Temp1_2.add(this.c);
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
            if (!B(0)) {
                if (B(false)) {
                    this.Temp1_2.delete(this.Temp1_2.itemNum("賢者の石"));
                }
                this.Temp1_2.delete(this.Temp1_2.itemNum("ラバーチャーム"));
                this.Temp1_2.delete(this.Temp1_2.itemNum("ワープボム"));
                this.Temp1_2.delete(this.Temp1_2.itemNum("マジックワープ"));
                this.Temp1_2.delete(this.Temp1_2.itemNum("サンライトボム"));
            }
            this.b = mathop("floor", N(this.rt.daysSince2000()) + 0.2666);
            this.Starter.add(this.Temp1_2.item(N(mod(N(this.d) - (N(letterOf(this.b, S(this.b).length)) + 1), this.Temp1_2.length)) + 1));
            this.Starter.add("1");
            this.Starter.add(this.a);
            // ペット集計: Pet data（10 フィールド × n）の 3・6 番を 0 に戻しつつ、
            // Menu[88] に解放済みペット数を数える（作者のエントリより前は作者以外なら
            // 一律 3 に上書きされる。自分のエントリがあれば Menu[89] にその番号）
            G.Guard.deleteAll();
            this.a = "0";
            const petCount = Math.max(0, Math.floor(N(G.Pet_data.length) / 10));
            for (let i = 0; i < petCount; i++) {
                G.Pet_data.replace(N(this.a) + 3, "0");
                G.Pet_data.replace(N(this.a) + 6, "0");
                if (B(compare(N(this.a) + 1, G.Pet_data.itemNum("uk-400")) < 0)) {
                    G.Menu.replace(88, N(G.Menu.item(88)) + 1);
                    if (!B(equals(this.rt.username, "uk-400"))) {
                        G.Menu.replace(88, "3");
                    }
                }
                else if (B(equals(G.Pet_data.item(N(this.a) + 1), this.rt.username))) {
                    G.Menu.replace(88, N(G.Menu.item(88)) + 1);
                    G.Menu.replace(89, N(this.a) / 10);
                }
                this.a = N(this.a) + 10;
                if (!this.rt.warpActive)
                    yield;
            }
            // Character status: Character_2（15 フィールド × n）の属性列 3..8 ごとに
            // 最小値と最大値を集める（12 項目 = min/max × 6）
            this.Character_status.deleteAll();
            this.a = "2";
            for (let col = 0; col < 6; col++) {
                this.a = N(this.a) + 1;
                this.b = "0";
                this.c = "99999";
                this.d = "-99999";
                const charCount = Math.max(0, Math.floor(N(G.Character_2.length) / 15));
                for (let i = 0; i < charCount; i++) {
                    if (!B(equals(G.Character_2.item(N(mathop("floor", (N(this.b) + N(this.a)) / 15)) * 15 + 1), "-"))) {
                        this.e = G.Character_2.item(N(this.b) + N(this.a));
                        if (B(compare(this.e, this.c) < 0)) {
                            this.c = this.e;
                        }
                        if (B(compare(this.d, this.e) < 0)) {
                            this.d = this.e;
                        }
                    }
                    this.b = N(this.b) + 15;
                    if (!this.rt.warpActive)
                        yield;
                }
                this.Character_status.add(this.c);
                this.Character_status.add(this.d);
                if (!this.rt.warpActive)
                    yield;
            }
            // Inventory_2: 5 スロット × 6 フィールド（名前 2 + 数値 4）の空枠 + 末尾 "1"
            G.Inventory_2.deleteAll();
            for (let slot = 0; slot < 5; slot++) {
                for (let i = 0; i < 2; i++) {
                    G.Inventory_2.add("");
                    if (!this.rt.warpActive)
                        yield;
                }
                for (let i = 0; i < 4; i++) {
                    G.Inventory_2.add("0");
                    if (!this.rt.warpActive)
                        yield;
                }
                if (!this.rt.warpActive)
                    yield;
            }
            G.Inventory_2.add("1");
            G.Temp_inventory.deleteAll();
            // スカラーの初期値
            G.X = "0";
            G.Y = "0";
            G.X_Y = "0/0";
            G.Speed_x = "0";
            G.Speed_y = "0";
            G.Camera_x = "0";
            G.Camera_y = "0";
            G.Zoom = "100";
            this.Hold_click = "0";
            G.Shot = "0";
            G.Mobile = "0";
            G.Bush_buff = "0";
            this.Bullet_damage = "0";
            this.Bomb_damage = "0";
            G.Not_hit = "1";
            G.Not_attack = "1";
            G.Use_item = "100";
            G.Mouse_camera_lock = "0";
            this.Mouse_wheel = "0";
            G.Hide_ghost = "0";
            G.Max_health = "150";
            G.Health = "150";
            G.Health_timer = "0";
            G.Sound = "0";
            G.Character = "0";
            G.Special_skin = "0";
            G.Money = "0";
            G.Tektite = "0";
            G.Kill_counter = "0";
            G.Max_kill = "0";
            this.Kill_point = "0";
            G.Max_rank = "1";
            this.Match_damage = "0";
            G.Shield = "0";
            G.Team_color = "0";
            G.Team_menu = "0";
            G.Lock_on_player = "0000";
            this.Turreting = "0";
            G.Special_weapon = "0";
            G.Charge = "00";
            this.Drag_touch = "";
            this.Dummy_X = "-550";
            this.Dummy_Y = "400";
            this.Frame_cutter = "0";
            this.Chat = "00";
            G.Select_pet = "-1";
            G.Pet_animation = "0";
            G.Frame = "0";
            // Creator フラグ: 作者と協力者のユーザー名かどうか
            G.Creator = N(B(S(this.rt.username).toLowerCase().includes("k-400")) || B(equals(this.rt.username, "uk-300")) || B(equals(this.rt.username, "kz-104")) || B(equals(this.rt.username, "urukazu")) || B(equals(this.rt.username, "Takomaru-s")) || B(equals(this.rt.username, "011208tree")) || B(equals(this.rt.username, "TACT-AIM")) || B(equals(this.rt.username, "Nichium"))) - 0;
            if (B(equals(this.rt.language, "日本語"))) {
                G.Language = "1";
            }
            else {
                G.Language = "2";
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Set size %s %s"
    *Set_size(size, costume) {
        // サイズを設定する。100 未満なら "Small"、それ以外は "Pen" コスチュームに
        // 一瞬切り替えてから（当たり判定用のサイズ計測）目的のコスチュームへ戻す。
        if (B(compare(size, "100") < 0)) {
            this.switchCostume("Small");
        }
        else {
            this.switchCostume("Pen");
        }
        this.size = N(size);
        this.switchCostume(costume);
    }
    // procedure: "Draw bullet %s %b"
    *Draw_bullet(size, Golden_Bot) {
        // 弾・エフェクトの描画と解釈、それに被弾の決済までを担う中核手順。
        // Bullet_and_effect は 10 フィールドレコード [所有者， 種別， X, Y, 向き， 値1..5]。
        // 所有者が "0000"（地形・ギミック）か IDs に居る弾だけを処理する:
        //   コスチューム ":" + 種別 をスタンプし、Bullet_list の振る舞いスクリプトを
        //   Bullet action で 1 命令ずつ実行する（IF / IF_T_F / IF_ACT が実行ゲート）。
        // 画面外（|x| か |y| が 5000 超）か所有者不明の弾は解釈せず、
        //   スクリプトに "Guard" が含まれるか走査だけする（削除ブロックは
        //   equals("", "0") という常に偽の条件で、原作でも死んでいる）。
        // 後半は Delete_bullet の削除予約処理と、Bullet_damage / Bomb_damage の決済。
        this.rotationStyle = "all around";
        this.a = "0";
        const records = Math.max(0, Math.floor(N(G.Bullet_and_effect.length) / N(10)));
        for (let r = 0; r < records; r++) {
            const base = N(this.a);
            this.Temp1_2.deleteAll();
            for (let k = 1; k <= 10; k++) {
                this.Temp1_2.add(G.Bullet_and_effect.item(base + k));
                if (!this.rt.warpActive)
                    yield;
            }
            const T = this.Temp1_2;
            if (B(equals(T.item(1), "0000")) || B(G.IDs.contains(T.item(1)))) {
                yield* this.Pen_mode();
                this.IDX = (N((N(T.item(3)) - N(G.All_camera_x))) * N(G.Zoom_temp));
                this.IDY = (N((N(T.item(4)) - N(G.All_camera_y))) * N(G.Zoom_temp));
                this.pointInDirection(T.item(5));
                if (B(equals(T.item(2), "Money")) && B(equals(this.rt.current("MONTH"), "12"))) {
                    this.switchCostume(":Money star");
                }
                else {
                    this.switchCostume((S(":") + S(T.item(2))));
                }
                if (B(!B(equals(this.costumeNumberName("name"), "Pen")))) {
                    yield* this.Stamp(this.IDX, this.IDY, size, this.costumeNumberName("name"));
                }
                this.First_number = "-";
                this.First_type = "0";
                this.b = this.Bullet.item(this.Bullet_name.itemNum(T.item(2)));
                this.c = "0";
                this.IF = "0";
                this.IF_ACT = "1";
                this.Bullet_team_ID = G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + N(11)));
                this.Hit = "0";
                const orphan = (B(!B(equals(T.item(1), "0000"))) && B(!B(G.IDs.contains(T.item(1)))))
                    || B(compare("5000", mathop("abs", T.item(3))) < 0) || B(compare("5000", mathop("abs", T.item(4))) < 0);
                if (orphan) {
                    this.d = "0";
                    while (!B(equals(G.Bullet_list.item((N(this.b) + N((N(this.c) + N(1))))), ""))) {
                        this.c = N(this.c) + N(1);
                        if (B(equals(G.Bullet_list.item((N(this.b) + N(this.c))), "Guard"))) {
                            this.d = "1";
                        }
                        if (!this.rt.warpActive)
                            yield;
                    }
                    if (B(equals("", "0"))) {
                        yield* this.Delete("-", "-", "-", "-", "-", "-");
                    }
                }
                else {
                    while (!B(equals(G.Bullet_list.item((N(this.b) + N((N(this.c) + N(1))))), ""))) {
                        this.IF_ACT = (N((B(equals(this.IF, "0")) || B((B(equals(this.IF, "1")) && B(equals(this.IF_T_F, "T")))))) - N(0));
                        this.c = N(this.c) + N(1);
                        this.d = (N(this.b) + N(this.c));
                        yield* this.Bullet_action(G.Bullet_list.item(this.d), size, Golden_Bot);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                this.IF_ACT = "1";
                this.clearEffects();
                for (let k = 1; k <= 10; k++) {
                    G.Bullet_and_effect.replace(base + k, T.item(k));
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            this.a = N(this.a) + N(10);
            if (!this.rt.warpActive)
                yield;
        }
        // 削除予約を末尾から処理する（削除で位置がずれないように）
        this.a = this.Delete_bullet.length;
        const reservations = Math.max(0, Math.floor(N(this.Delete_bullet.length)));
        for (let r = 0; r < reservations; r++) {
            for (let k = 0; k < 10; k++) {
                G.Bullet_and_effect.delete((N(this.Delete_bullet.item(this.a)) + N(1)));
                if (!this.rt.warpActive)
                    yield;
            }
            this.a = N(this.a) + N(-1);
            if (!this.rt.warpActive)
                yield;
        }
        this.Delete_bullet.deleteAll();
        // ===== ダメージ決済 =====
        // b = バフ前の合計、a = バフ後の合計。差分は Block damage ミッションへ
        G.Menu.replace(44, "0");
        this.b = (N(this.Bullet_damage) + N(this.Bomb_damage));
        if (B(compare("0", this.Bullet_damage) < 0)) {
            this.Bullet_damage = (N(this.Bullet_damage) * N(G.Buff_effect.item(3)));
            if (B(compare(this.Bullet_damage, "1") < 0)) {
                this.Bullet_damage = "1";
            }
        }
        if (B(compare("0", this.Bomb_damage) < 0)) {
            this.Bomb_damage = (N(this.Bomb_damage) * N(G.Buff_effect.item(4)));
            if (B(compare(this.Bomb_damage, "0") < 0)) {
                this.Bomb_damage = "0";
            }
        }
        this.a = (N(this.Bullet_damage) + N(this.Bomb_damage));
        yield* this.Get_mission_point("Block damage", Math.round(N((N(this.b) - N(this.a)))));
        if (B(equals(G.Special_weapon, "1")) && B(compare(this.a, "0") < 0)) {
            this.a = "0";
        }
        if (B(!B(equals(this.a, "0")))) {
            if (B(equals(G.Not_hit, "0")) && B(equals(G.Buff_effect.item(12), "0"))) {
                // 本人モード
                if (B(compare("0", G.Health) < 0)) {
                    this.b = G.Health;
                    if (B(compare("0", this.Bullet_damage) < 0)) {
                        G.Menu.replace(44, "1");
                        if (B(Golden_Bot)) {
                            yield* this.Put_buff("ブースト", "30");
                        }
                    }
                    if (B(compare("0", G.Shield) < 0) && B(compare("0", this.a) < 0)) {
                        // シールドが全量吸収する（体力は減らない）
                        this.rt.soundPlay("2ac5bac411c5e9188ea18a37bc2cffca.wav");
                        G.Menu.replace(98, "0");
                        G.Shield = N(G.Shield) + N((N(0) - N(this.a)));
                        if (B(compare(G.Shield, "0") < 0)) {
                            G.Shield = "0";
                        }
                        G.Health_timer = N(G.Health_timer) + N(this.a);
                        if (B(compare("0", G.Health_timer) < 0)) {
                            G.Health_timer = "450";
                        }
                    }
                    else {
                        G.Health = N(G.Health) + N((N(0) - N(this.Bullet_damage)));
                        G.Health = N(G.Health) + N((N(0) - N(this.Bomb_damage)));
                        if (B(compare("0", this.a) < 0)) {
                            this.rt.soundPlay("93d6d2b73d6779247a2eb6a5011deb8a.wav");
                            G.Bush_buff = N(G.Bush_buff) + N((N(this.a) * N(-5)));
                            if (B(compare(G.Health, "0") < 0)) {
                                G.Health = "0";
                            }
                            else {
                                yield* this.Add_combat_data("Damage", Math.round(N(this.a)), this.Hit_ID);
                            }
                            G.Health_timer = N(G.Health_timer) + N(this.a);
                            if (B(compare("0", G.Health_timer) < 0)) {
                                G.Health_timer = "450";
                            }
                        }
                        else {
                            // 回復側: Max_health で頭打ち
                            this.rt.soundPlay("88c767230588cfacd395d32a7f633994.wav");
                            if (B(compare(G.Max_health, G.Health) < 0)) {
                                G.Health = G.Max_health;
                            }
                        }
                    }
                    if (B(compare("699", this.a) < 0)) {
                        this.a = "699";
                    }
                    if (B(compare(this.a, "-200") < 0)) {
                        this.a = "-200";
                    }
                    if (B(compare(G.Health, "1") < 0)) {
                        if (B(compare(G.Menu.item(15), "100") < 0)) {
                            // 死亡: 撃破記録・戦績・（SURVIVAL なら）武器ドロップ抽選
                            this.rt.soundPlay("bcd300c69fdc64936c3c55eb90bca3c0.wav");
                            G.My_hit.add((S(this.Hit_ID) + S((S((N(Math.round(N(this.a))) + N(300))) + S("00")))));
                            G.Menu.replace(15, "150");
                            G.Menu.replace(16, this.Hit_ID);
                            yield* this.Get_mission_point("Death", "1");
                            yield* this.Add_combat_data("Death", this.a, this.Hit_ID);
                            if (B(equals(G.SURVIVAL, "1"))) {
                                this.b = "1";
                                this.Temp1_2.deleteAll();
                                for (let s = 0; s < 5; s++) {
                                    if (B(!B(equals(G.Inventory_2.item(this.b), "")))) {
                                        this.Temp1_2.add(G.Inventory_2.item(this.b));
                                    }
                                    this.b = N(this.b) + N(6);
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                this.c = random(0, this.Temp1_2.length);
                                if (B(compare("3", this.c) < 0)) {
                                    this.c = "3";
                                }
                                const drops = Math.max(0, Math.floor(N(this.c)));
                                for (let s = 0; s < drops; s++) {
                                    this.b = random(1, this.Temp1_2.length);
                                    G.My_shot.insert((S("7") + S((S(random(0, 9)) + S((S(random(0, 9)) + S((S(random(0, 9)) + S((N(G.Weapon_name.itemNum(this.Temp1_2.item(this.b))) + N(100)))))))))), (N(10) - N(this.c)));
                                    this.Temp1_2.delete(this.b);
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                            }
                        }
                    }
                    else {
                        if (B(compare("5", this.a) < 0)) {
                            // 被弾記録 + 攻撃者キャラ固有のデバフ抽選。
                            // ※この代入で b（体力）がキャラ名に上書きされるため、後段の
                            //   体力変化量は「0 − 被弾後体力」になる（原作のクセ）
                            G.My_hit.add((S(this.Hit_ID) + S((S((N(Math.round(N(this.a))) + N(300))) + S((S(random(0, 9)) + S(random(1, 9))))))));
                            G.Menu.replace(14, "5");
                            this.b = G.Character_2.item((N(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.Hit_ID))) + N(14)))) + N(1)));
                            if (B(equals(this.b, "Bio Tera"))) {
                                if (B(equals(random(1, 2), "1"))) {
                                    yield* this.Put_buff("テラ毒", "130");
                                }
                            }
                            if (B(equals(this.b, "Snowman"))) {
                                if (B(equals(random(1, 3), "1"))) {
                                    yield* this.Put_buff("粉雪", "150");
                                }
                            }
                        }
                    }
                    this.b = (N(this.b) - N(G.Health));
                    if (B(!B(equals(this.b, "0")))) {
                        if (B(compare("0", this.a) < 0)) {
                            G.Menu.replace(6, "1");
                            G.Skill_point = N(G.Skill_point) + N((N(mathop("abs", this.b)) / N(4)));
                        }
                        else {
                            G.Menu.replace(6, "2");
                            G.Skill_point = N(G.Skill_point) + N((N(mathop("abs", this.b)) / N(10)));
                            yield* this.Get_mission_point("Heal", mathop("abs", this.b));
                        }
                        G.Menu.replace(7, "100");
                        G.Menu.replace(8, mathop("abs", this.a));
                    }
                    yield* this.Sound("15");
                }
            }
            else {
                // ダミーモード: ダミー人形への累積ダメージと数値表示レコード
                if (B(compare("0", this.a) < 0)) {
                    if (B(compare("49", this.a) < 0)) {
                        yield* this.Make_sound(this.Dummy_X, this.Dummy_Y, "重ヒット音");
                    }
                    else {
                        yield* this.Make_sound(this.Dummy_X, this.Dummy_Y, "軽ヒット音");
                    }
                }
                this.a = Math.round(N(this.a));
                this.DPS_counter = N(this.DPS_counter) + N(this.a);
                G.Dummy_damage = N(G.Dummy_damage) + N(this.a);
                if (B(compare("99999", G.Dummy_damage) < 0)) {
                    G.Dummy_damage = "99999";
                }
                if (B(compare(G.Dummy_damage, "-99999") < 0)) {
                    G.Dummy_damage = "-99999";
                }
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("Damage val");
                G.Bullet_and_effect.add(this.Dummy_X);
                G.Bullet_and_effect.add(this.Dummy_Y);
                G.Bullet_and_effect.add("90");
                if (B(compare(this.a, "0") < 0)) {
                    G.Bullet_and_effect.add((S("+") + S(mathop("abs", this.a))));
                }
                else {
                    G.Bullet_and_effect.add(mathop("abs", this.a));
                }
                G.Bullet_and_effect.add((N(70) + N((N(mathop("abs", this.a)) / N(10)))));
                G.Bullet_and_effect.add((N(random(80, 100)) / N(10)));
                G.Bullet_and_effect.add((N(random(-20, 20)) / N(10)));
                if (B(compare(this.a, "0") < 0)) {
                    G.Bullet_and_effect.add("60");
                }
                else {
                    G.Bullet_and_effect.add("0");
                }
            }
        }
        this.Bullet_damage = "0";
        this.Bomb_damage = "0";
        yield* this.Pen_mode();
        if (B(compare(G.X, "400") < 0)) {
            // ロビー側: ダミー人形・バフ一覧・スケジュール（Menu[49] の 2 分周期で 3 巡）を描く
            this.a = (N(mod(mathop("floor", (N(G.Menu.item(49)) / N(120))), 3)) + N(1));
            if (B(compare("0", G.Menu.item(1)) < 0)) {
                this.gotoXY((N((N((N(this.Dummy_X) + N(random(-2, 2)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(this.Dummy_Y) + N(random(-2, 2)))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            }
            else {
                this.gotoXY((N((N(this.Dummy_X) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(this.Dummy_Y) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            }
            G.Menu.replace(1, (N(G.Menu.item(1)) - N(G.FPS_temp)));
            this.switchCostume("Guy");
            this.size = N(size);
            this.pointInDirection(90);
            this.stamp();
            yield* this.Stamp((N((N(-650) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(400) - N(G.All_camera_y))) * N(G.Zoom_temp)), size, (S("Schedule") + S(this.a)));
            yield* this.Stamp((N((N(-755) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(480) - N(G.All_camera_y))) * N(G.Zoom_temp)), size, "Display buff");
            // バフ表示の対応表: [Buff_effect の番号， 表示変換（2/4 は −1、3/4 は符号反転）]
            this.Temp1_2.deleteAll();
            this.Temp2_2.deleteAll();
            const buffIdx = ["1", "2", "3", "4", "5", "6", "8", "14"];
            const buffKind = ["1", "2", "4", "4", "2", "3", "4", "2"];
            for (let k = 0; k < 8; k++) {
                this.Temp1_2.add(buffIdx[k]);
                this.Temp2_2.add(buffKind[k]);
            }
            this.gotoXY((N((N(-740) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(480) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            this.b = "0";
            for (let k = 0; k < 8; k++) {
                this.b = N(this.b) + N(1);
                this.c = G.Buff_effect.item(this.Temp1_2.item(this.b));
                if (B(equals(this.Temp2_2.item(this.b), "2")) || B(equals(this.Temp2_2.item(this.b), "4"))) {
                    this.c = (N(this.c) - N(1));
                }
                if (B(equals(this.Temp2_2.item(this.b), "3")) || B(equals(this.Temp2_2.item(this.b), "4"))) {
                    this.c = (N(0) - N(this.c));
                }
                this.c = Math.round(N((N(this.c) * N(100))));
                if (B(!B(compare(this.c, "0") < 0))) {
                    this.setEffect("BRIGHTNESS", 25);
                    this.setEffect("COLOR", 130);
                    this.c = (S("+") + S(this.c));
                }
                if (B(equals(this.c, "0"))) {
                    this.setEffect("BRIGHTNESS", 100);
                }
                this.c = (S(this.c) + S("%"));
                yield* this.Draw_text(this.c, (N(65) * N(G.Zoom_temp)), "L", this.x);
                this.setEffect("COLOR", 0);
                this.setEffect("BRIGHTNESS", 0);
                this.changeYBy((N(-22.4) * N(G.Zoom_temp)));
                if (!this.rt.warpActive)
                    yield;
            }
            this.gotoXY((N((N(this.Dummy_X) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(this.Dummy_Y) - N(45))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            if (B(compare(G.Dummy_damage, "0") < 0)) {
                this.setEffect("COLOR", 60);
                yield* this.Draw_text((S("+") + S(mathop("floor", mathop("abs", G.Dummy_damage)))), (N(80) * N(G.Zoom_temp)), "C", this.x);
                if (B(equals(this.a, "1"))) {
                    this.changeYBy(-20);
                    yield* this.Draw_text((S("DPS:") + S((S("+") + S(mathop("abs", G.DPS))))), (N(80) * N(G.Zoom_temp)), "C", this.x);
                }
            }
            else {
                this.setEffect("BRIGHTNESS", -100);
                yield* this.Draw_text(mathop("floor", G.Dummy_damage), (N(80) * N(G.Zoom_temp)), "C", this.x);
                if (B(equals(this.a, "1"))) {
                    this.changeYBy(-20);
                    yield* this.Draw_text((S("DPS:") + S(G.DPS)), (N(80) * N(G.Zoom_temp)), "C", this.x);
                }
            }
            // ダミーの移動パターン（スケジュール番号で切替。目標へ半分ずつ寄る）
            if (B(equals(this.a, "1"))) {
                this.Dummy_X = N(this.Dummy_X) + N((N((N(-550) - N(this.Dummy_X))) / N(2)));
                this.Dummy_Y = N(this.Dummy_Y) + N((N((N(400) - N(this.Dummy_Y))) / N(2)));
            }
            if (B(equals(this.a, "2"))) {
                this.b = mod((N(G.Menu.item(49)) * N(90)), 800);
                if (B(compare("400", this.b) < 0)) {
                    this.b = (N((N(0) - N(this.b))) + N(800));
                }
                if (B(compare("200", this.b) < 0)) {
                    this.Dummy_X = N(this.Dummy_X) + N((N((N((N((N(0) - N(this.b))) - N(150))) - N(this.Dummy_X))) / N(2)));
                }
                else {
                    this.Dummy_X = N(this.Dummy_X) + N((N((N((N(this.b) - N(550))) - N(this.Dummy_X))) / N(2)));
                }
                if (B(compare(this.b, "100") < 0)) {
                    this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(400) - N(this.b))) - N(this.Dummy_Y))) / N(2)));
                }
                else {
                    if (B(compare(this.b, "300") < 0)) {
                        this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(300) + N((N(this.b) - N(100))))) - N(this.Dummy_Y))) / N(2)));
                    }
                    else {
                        this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(500) - N((N(this.b) - N(300))))) - N(this.Dummy_Y))) / N(2)));
                    }
                }
            }
            if (B(equals(this.a, "3"))) {
                this.b = mod((N(G.Menu.item(49)) * N(90)), 1600);
                if (B(compare("800", this.b) < 0)) {
                    this.b = (N((N(0) - N(this.b))) + N(1600));
                }
                if (B(compare(this.b, "200") < 0)) {
                    this.Dummy_X = N(this.Dummy_X) + N((N((N((N(this.b) - N(550))) - N(this.Dummy_X))) / N(2)));
                }
                else {
                    if (B(compare("300", this.b) < 0)) {
                        if (B(compare(this.b, "400") < 0)) {
                            this.Dummy_X = N(this.Dummy_X) + N((N((N((N(-50) - N(this.b))) - N(this.Dummy_X))) / N(2)));
                        }
                        else {
                            if (B((compare("600", this.b) < 0)) && B(compare(this.b, "700") < 0)) {
                                this.Dummy_X = N(this.Dummy_X) + N((N((N((N(150) - N(this.b))) - N(this.Dummy_X))) / N(2)));
                            }
                        }
                    }
                }
                if (B(compare("200", this.b) < 0)) {
                    if (B(compare(this.b, "300") < 0)) {
                        this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(this.b) + N(200))) - N(this.Dummy_Y))) / N(2)));
                    }
                    else {
                        if (B(compare("400", this.b) < 0)) {
                            if (B(compare(this.b, "600") < 0)) {
                                this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(900) - N(this.b))) - N(this.Dummy_Y))) / N(2)));
                            }
                            else {
                                if (B(compare("700", this.b) < 0)) {
                                    this.Dummy_Y = N(this.Dummy_Y) + N((N((N((N(-400) + N(this.b))) - N(this.Dummy_Y))) / N(2)));
                                }
                            }
                        }
                    }
                }
            }
        }
        this.rotationStyle = "all around";
        this.setEffect("COLOR", 0);
        this.setEffect("BRIGHTNESS", 0);
    }
    // procedure: "Step %s %s"
    *Step(speed, num) {
        // Bullet_list 命令 "Step" の実体。IF_ACT のときだけ、弾の位置 Temp1_2[3..4] へ
        // 向き Temp1_2[num] 方向へ speed だけ進める（CS val の "C" なので FPS_temp 倍）。
        if (B(equals(this.IF_ACT, "1"))) {
            yield* this.CS_val("3", (N(mathop("sin", this.Temp1_2.item(num))) * N(speed)), "C");
            yield* this.CS_val("4", (N(mathop("cos", this.Temp1_2.item(num))) * N(speed)), "C");
        }
    }
    // procedure: "Search first [b] %s %s"
    *Search_first__b(type, sound) {
        // 最寄りのプレイヤーを探し、First number（ID）と First distance（距離）へ返す。
        // 結果はキャッシュされ、sound > 0 のとき、前回と type が違うとき、
        // または未探索（First number が "-"）のときだけ再探索する。
        // 探索は二乗距離で行い、最後に sqrt する（type "M" だけは早期 return のため
        // 二乗のまま返る。原作のクセ）。
        //   type "E": 敵（チームが違う） / "T": 味方（発射者以外） / "U": 同チーム /
        //   "M": 自分自身。候補は CLOUD の 16 番（Not hit）が "0" で、
        //   sound < 相手の 23 番（Sound）のものだけ。
        if (B(compare("0", sound) < 0) || B(equals(this.First_number, "-")) || !B(equals(this.First_type, type))) {
            const dist2 = (x1, y1, x2, y2) => (N(x1) - N(x2)) * (N(x1) - N(x2)) + (N(y1) - N(y2)) * (N(y1) - N(y2));
            this.First_number = "0";
            this.First_distance = "99999999";
            if (B(equals(type, "M"))) {
                this.First_number = G.ID;
                this.First_distance = dist2(G.X, G.Y, this.Temp1_2.item(3), this.Temp1_2.item(4));
                this.First_type = type;
                return;
            }
            if (B(equals(G.Not_hit, "0")) && B(equals(G.Buff_effect.item(12), "0"))) {
                this.e = "0";
                this.First_type = type;
                const records = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
                for (let i = 0; i < records; i++) {
                    const base = N(this.e);
                    if (B(equals(G.CLOUD.item(base + 16), "0"))) {
                        this.f = dist2(G.CLOUD.item(base + 3), G.CLOUD.item(base + 4), this.Temp1_2.item(3), this.Temp1_2.item(4));
                        const sameTeam = B(equals(this.Bullet_team_ID, G.CLOUD.item(base + 12)));
                        const matches = (B(equals(type, "E")) && !sameTeam) ||
                            (B(equals(type, "T")) && !B(equals(this.Temp1_2.item(1), G.CLOUD.item(base + 1))) && sameTeam) ||
                            (B(equals(type, "U")) && sameTeam);
                        if (B(compare(this.f, this.First_distance) < 0) && matches) {
                            if (B(compare(sound, G.CLOUD.item(base + 23)) < 0)) {
                                this.First_number = G.CLOUD.item(base + 1);
                                this.First_distance = this.f;
                            }
                        }
                    }
                    this.e = N(this.e) + N(G.Number_of_data);
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            else {
                // ダミーモード: ダミー人形との距離を返す
                this.First_number = G.ID;
                this.First_distance = dist2(this.Dummy_X, this.Dummy_Y, this.Temp1_2.item(3), this.Temp1_2.item(4));
            }
            this.First_distance = mathop("sqrt", this.First_distance);
        }
    }
    // procedure: "Damage %s %s %s %s %s %s %s %s %s"
    *Damage(damage, distance, all_attack, create_type, val1, val2, val3, val4, val5) {
        // 弾・爆発が自分に当たったかの判定とダメージ蓄積。
        // Temp1_2 は呼び出し側（Bullet action）が入れた弾レコードで、
        // [1]=所有者ID [3..4]=弾の位置。distance 0 は密着（判定なしで所有者を見て加算）、
        // all_attack 1 は範囲攻撃（Distance to bullet で測る）。
        // create_type "ND" は毎フレーム加算型（damage × FPS_temp）、"ON"/"ND" は
        // 末尾の Delete（＝生成物への変換）を呼ばない。
        if (B(equals(this.IF_ACT, "1"))) {
            if (B(compare(damage, "0") < 0)) {
                yield* this.Search_first__b("T", "-1");
            }
            else {
                yield* this.Search_first__b("E", "-1");
            }
            if (B(equals(distance, "0"))) {
                if (B(equals(this.Temp1_2.item(1), G.ID))) {
                    const hittable = B(equals(G.Not_hit, "0")) ||
                        (B(equals(G.Not_hit, "1")) && B(equals(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(this.Temp1_2.item(1)))) + 15), "1")));
                    if (hittable) {
                        if (B(equals(create_type, "ND"))) {
                            this.Bullet_damage = N(this.Bullet_damage) + N(damage) * N(G.FPS_temp);
                        }
                        else {
                            this.Bullet_damage = N(this.Bullet_damage) + N(damage);
                        }
                        this.Hit = "1";
                    }
                }
            }
            else if (B(equals(all_attack, "1"))) {
                yield* this.Distance_to_bullet__e();
                if (B(compare(this.e, distance) < 0)) {
                    const teamOk = (B(equals(this.First_number, G.ID)) && B(equals(G.Not_hit, "1"))) ||
                        (compare("0", damage) < 0 && !B(equals(G.Team_ID, this.Bullet_team_ID))) ||
                        (B(compare(damage, "0") < 0) && B(equals(G.Team_ID, this.Bullet_team_ID)));
                    if (teamOk) {
                        if (B(equals(create_type, "ND"))) {
                            this.Bomb_damage = N(this.Bomb_damage) + N(damage) * N(G.FPS_temp);
                        }
                        else {
                            this.Bomb_damage = N(this.Bomb_damage) + N(damage);
                        }
                        this.Hit = "1";
                        this.Hit_ID = this.Temp1_2.item(1);
                    }
                }
            }
            else {
                if (B(compare(this.First_distance, distance) < 0)) {
                    const teamOk = B(equals(this.First_number, G.ID)) &&
                        (B(equals(G.Not_hit, "1")) ||
                            (compare("0", damage) < 0 && !B(equals(G.Team_ID, this.Bullet_team_ID))) ||
                            (B(compare(damage, "0") < 0) && B(equals(G.Team_ID, this.Bullet_team_ID))));
                    if (teamOk) {
                        if (B(equals(create_type, "ND"))) {
                            this.Bullet_damage = N(this.Bullet_damage) + N(damage) * N(G.FPS_temp);
                        }
                        else {
                            this.Bullet_damage = N(this.Bullet_damage) + N(damage);
                        }
                        this.Hit = "1";
                        this.Hit_ID = this.Temp1_2.item(1);
                    }
                }
            }
            // 最寄りプレイヤーが範囲内なら被弾マーカーを立て、生成物へ変換する
            if (B(compare(this.First_distance, distance) < 0)) {
                if (B(equals(G.Not_hit, "1")))
                    G.Menu.replace(1, "5");
                if (B(!B(B(equals(create_type, "ND")) || B(equals(create_type, "ON"))))) {
                    yield* this.Delete(create_type, val1, val2, val3, val4, val5);
                }
            }
        }
    }
    // procedure: "Delete %s %s %s %s %s %s"
    *Delete(create_type, val1, val2, val3, val4, val5) {
        // 弾を削除予約（a = 弾レコードの位置。呼び出し側が入れる）し、
        // 代わりの生成物（爆発・アイテム等）を Create で置く。
        if (B(equals(this.IF_ACT, "1"))) {
            if (B(!this.Delete_bullet.contains(this.a))) {
                this.Delete_bullet.add(this.a);
            }
            yield* this.Create(create_type, val1, val2, val3, val4, val5);
        }
    }
    // procedure: "Create %s %s %s %s %s %s"
    *Create(create_type, temp1, temp2, temp3, temp4, temp5) {
        // 弾の消滅・命中時に生成物（爆発、ガード、ドロップ等）を Bullet_and_effect へ追加する。
        // レコードは10フィールド固定: [所有者, 種別, X, Y, 向き, 値1..値5]。
        // Temp1_2 は元の弾レコード（[1]=所有者 [3..4]=位置 [5]=向き）。
        // 特殊種別はここで分岐し、どれにも当たらなければ素通しで追加する。
        if (B(equals(this.IF_ACT, "1"))) {
            if (B(!B(B(equals(create_type, "")) || B(equals(create_type, "-"))))) {
                if (S(create_type).toLowerCase().includes(S("爆発").toLowerCase())) {
                    yield* this.Make_sound(this.Temp1_2.item(3), this.Temp1_2.item(4), "爆発");
                }
                if (S(create_type).toLowerCase().includes(S("ガス").toLowerCase())) {
                    yield* this.Make_sound(this.Temp1_2.item(3), this.Temp1_2.item(4), "噴霧");
                }
                const addRecord = (owner, type, x, y, dir, v1, v2, v3, v4, v5) => {
                    G.Bullet_and_effect.add(owner);
                    G.Bullet_and_effect.add(type);
                    G.Bullet_and_effect.add(x);
                    G.Bullet_and_effect.add(y);
                    G.Bullet_and_effect.add(dir);
                    G.Bullet_and_effect.add(v1);
                    G.Bullet_and_effect.add(v2);
                    G.Bullet_and_effect.add(v3);
                    G.Bullet_and_effect.add(v4);
                    G.Bullet_and_effect.add(v5);
                };
                const ox = this.Temp1_2.item(3), oy = this.Temp1_2.item(4), odir = this.Temp1_2.item(5), owner = this.Temp1_2.item(1);
                if (B(equals(create_type, "BSガード"))) {
                    yield* this.Make_sound(ox, oy, "BSガード");
                    this.Temp1 = "A";
                    // 50グリッドへスナップしたマスにガードを置く
                    this.Temp2 = Math.round(N((N(ox) - N(mathop("sin", odir)) * 20) / 50));
                    this.Temp3 = Math.round(N((N(oy) - N(mathop("cos", odir)) * 20) / 50));
                    // ここは9フィールドだけ追加し、10番目は Create guard がガード番号を入れる
                    G.Bullet_and_effect.add(owner);
                    G.Bullet_and_effect.add("BSガード");
                    G.Bullet_and_effect.add(N(this.Temp2) * 50);
                    G.Bullet_and_effect.add(N(this.Temp3) * 50);
                    G.Bullet_and_effect.add("90");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    yield* this.Create_guard(S(this.Temp2) + S(S("/") + S(this.Temp3)));
                    return;
                }
                if (B(equals(create_type, "シールドファンネル"))) {
                    yield* this.Make_sound(ox, oy, "シールドファンネル");
                    this.Temp1 = N(Math.round(N(N(odir) / 45))) * 45;
                    for (let i = 0; i < 2; i++) {
                        addRecord(owner, "シールドファンネル", N(ox) + N(mathop("sin", this.Temp1)) * 36, N(oy) + N(mathop("cos", this.Temp1)) * 36, this.Temp1, this.Temp1, "0", "0", "0", "0");
                        this.Temp1 = N(this.Temp1) + 180;
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "ガード破壊"))) {
                    if (B(equals(G.Lag_cutter, "0"))) {
                        for (let i = 0; i < 5; i++) {
                            addRecord(owner, "ガード欠片", N(ox) + N(N(mathop("sin", odir)) * 15 + N(random(-8, 8))), N(oy) + N(N(mathop("cos", odir)) * 15 + N(random(-8, 8))), random(0, 360), random(0, 360), random(8, 12), "0", random(90, 110), this.Temp2_2.item(8));
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    return;
                }
                if (B(equals(create_type, "ガードレーザー"))) {
                    yield* this.Make_sound(ox, oy, "反撃レーザー");
                    addRecord(owner, "ガードレーザー", N(ox) + N(mathop("sin", odir)) * 36, N(oy) + N(mathop("cos", odir)) * 36, N(odir) + N(random(-15, 15)), "15", "0", "0", "0", "0");
                    return;
                }
                if (B(equals(create_type, "BPレーザー"))) {
                    addRecord(owner, "BPレーザー", N(ox) + N(mathop("sin", odir)) * 36, N(oy) + N(mathop("cos", odir)) * 36, odir, temp1, "0", "0", "0", "0");
                    return;
                }
                if (B(equals(create_type, "トリック"))) {
                    yield* this.Make_sound(ox, oy, "爆発");
                    addRecord(owner, "フラッシュ爆発", N(ox) + N(random(-100, 100)), N(oy) + N(random(-100, 100)), "0", temp1, temp2, "0", "0", "0");
                    return;
                }
                if (B(equals(create_type, "Money"))) {
                    addRecord("0000", "Money", ox, oy, random(0, 360), random(5, 10), "0", "0", "0", "0");
                    return;
                }
                if (B(equals(create_type, "拡散爆発"))) {
                    this.Temp1 = odir;
                    const cnt = Math.max(0, Math.floor(N(temp2)));
                    for (let i = 0; i < cnt; i++) {
                        addRecord(owner, temp1, N(ox) + N(mathop("sin", this.Temp1)) * 20, N(oy) + N(mathop("cos", this.Temp1)) * 20, this.Temp1, "0", "0", "0", "0", "0");
                        this.Temp1 = N(this.Temp1) + 360 / N(temp2);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "スパイク爆発"))) {
                    this.Temp1 = odir;
                    for (let i = 0; i < 5; i++) {
                        addRecord(owner, "Gobo spike", ox, oy, this.Temp1, "0", "0", "0", "0", "0");
                        this.Temp1 = N(this.Temp1) + 72;
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "クレイモア爆発"))) {
                    for (let i = 0; i < 10; i++) {
                        this.Temp1 = N(odir) + N(random(-30, 30));
                        addRecord(owner, "鉄球", ox, oy, this.Temp1, temp1, temp2, N(temp3) + N(random(-20, 20)) / 10, temp4, "0");
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "鉄球爆発"))) {
                    const cnt = Math.max(0, Math.floor(N(temp5)));
                    for (let i = 0; i < cnt; i++) {
                        this.Temp1 = random(1, 360);
                        addRecord(owner, "鉄球", ox, oy, this.Temp1, temp1, temp2, N(temp3) + N(random(-20, 20)) / 10, temp4, "0");
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "飛び散り爆発"))) {
                    addRecord(owner, "爆発", ox, oy, odir, temp1, temp2, temp3, temp4, temp5);
                    for (let i = 0; i < 6; i++) {
                        this.Temp1 = random(1, 360);
                        addRecord(owner, "飛び散りボム", ox, oy, this.Temp1, this.Temp1, "2", "8", "10", "0");
                        if (!this.rt.warpActive)
                            yield;
                    }
                    return;
                }
                if (B(equals(create_type, "ラピッドレーザーの光"))) {
                    // X と Y で別々に乱数を振る（原作通り）
                    addRecord(owner, "ラピッドレーザーの光", N(ox) + N(mathop("sin", N(odir) + N(random(-120, 120)))) * N(random(-75, -10)), N(oy) + N(mathop("cos", N(odir) + N(random(-120, 120)))) * N(random(-75, -10)), odir, temp1, temp2, temp3, temp4, temp5);
                    return;
                }
                addRecord(owner, create_type, ox, oy, odir, temp1, temp2, temp3, temp4, temp5);
            }
        }
    }
    // procedure: "CS val %s %s %s"
    *CS_val(number, degree, type) {
        // Temp1_2 専用の値操作（IF_ACT が立つときだけ効く）。type の意味:
        // "C" = += degree × FPS_temp、"S" = 代入、"M" = += degree、"*" = 乗算、
        // "G<nn>" = degree 番の値を nn 刻みに丸めた先へスナップ（差が nn を超えるときだけ）、
        // 数値 = その数で割った割合で接近する。
        if (B(equals(this.IF_ACT, "1"))) {
            if (B(equals(type, "C"))) {
                this.Temp1_2.replace(number, (N(this.Temp1_2.item(number)) + N((N(degree) * N(G.FPS_temp)))));
            }
            else {
                if (B(equals(type, "S"))) {
                    this.Temp1_2.replace(number, degree);
                }
                else {
                    if (B(equals(type, "M"))) {
                        this.Temp1_2.replace(number, (N(this.Temp1_2.item(number)) + N(degree)));
                    }
                    else {
                        if (B(equals(type, "*"))) {
                            this.Temp1_2.replace(number, (N(this.Temp1_2.item(number)) * N(degree)));
                        }
                        else {
                            if (B(equals(letterOf(type, 1), "G"))) {
                                this.Temp1 = (S(letterOf(type, 2)) + S(letterOf(type, 3)));
                                this.Temp2 = (N(Math.round(N((N(this.Temp1_2.item(degree)) / N(this.Temp1))))) * N(this.Temp1));
                                if (B((compare(this.Temp1, mathop("abs", (N(this.Temp1_2.item(number)) - N(this.Temp1_2.item(degree))))) < 0))) {
                                    this.Temp1_2.replace(number, this.Temp2);
                                }
                            }
                            else {
                                this.Temp1_2.replace(number, (N(this.Temp1_2.item(number)) + N((N((N((N(degree) - N(this.Temp1_2.item(number)))) / N(type))) * N(G.FPS_temp)))));
                            }
                        }
                    }
                }
            }
        }
    }
    // procedure: "Distance to bullet [e]"
    *Distance_to_bullet__e() {
        // 自分（またはダミー）から弾（Temp1_2[3..4]）までの距離を e へ返す。
        if (B(equals(G.Not_hit, "0")) && B(equals(G.Buff_effect.item(12), "0"))) {
            this.e = mathop("sqrt", N(N(G.X) - N(this.Temp1_2.item(3))) * N(N(G.X) - N(this.Temp1_2.item(3))) + N(N(G.Y) - N(this.Temp1_2.item(4))) * N(N(G.Y) - N(this.Temp1_2.item(4))));
        }
        else {
            this.e = mathop("sqrt", N(N(this.Dummy_X) - N(this.Temp1_2.item(3))) * N(N(this.Dummy_X) - N(this.Temp1_2.item(3))) + N(N(this.Dummy_Y) - N(this.Temp1_2.item(4))) * N(N(this.Dummy_Y) - N(this.Temp1_2.item(4))));
        }
    }
    // procedure: "Player shot %s %s %s %s"
    *Player_shot(weapon, create_type, sound, direction) {
        // 他プレイヤー（またはスキル・ギミック）の発射を再現する。
        // モードは f で切り替わる: "0" はスキル/ギミック（c が種別番号）、
        // "2" はチャージ弾の後始末、"1" は通常発射（Load cloud data が使う）。
        // Pickupped は発射者のレコード（62フィールド）。
        if (B(equals(this.f, "0"))) {
            if (B(compare("899", this.c) < 0)) {
                // ---- スキル発動（c = 900 + スキル番号） ----
                if (this.Skill_counter.contains(this.Pickupped.item(1))) {
                    this.Temp1 = this.Skill_counter.itemNum(this.Pickupped.item(1));
                    this.Skill_counter.replace(N(this.Temp1) + 1, N(this.Skill_counter.item(N(this.Temp1) + 1)) + 1);
                    this.Temp2 = this.Skill_counter.item(N(this.Temp1) + 1);
                    // 10回目以降はクールダウンが 90 → 9000 に伸びる
                    this.Skill_counter.replace(N(this.Temp1) + 2, B(compare(this.Temp2, "10") < 0) ? "90" : "9000");
                }
                else {
                    this.Skill_counter.add(this.Pickupped.item(1));
                    this.Skill_counter.add("1");
                    this.Skill_counter.add("300");
                    this.Temp2 = "1";
                }
                if (B(compare(this.Temp2, "10") < 0)) {
                    yield* this.Make_sound(this.Pickupped.item(3), this.Pickupped.item(4), "スキル使用");
                    G.Bullet_and_effect.add(this.Pickupped.item(1));
                    G.Bullet_and_effect.add("スキル発動");
                    G.Bullet_and_effect.add(N(this.Pickupped.item(3)) + N(random(-20, 20)));
                    G.Bullet_and_effect.add(N(this.Pickupped.item(4)) + N(random(-20, 20)));
                    G.Bullet_and_effect.add(random(1, 360));
                    G.Bullet_and_effect.add("100");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    G.Bullet_and_effect.add("0");
                    // Skill_2 は1スキル15フィールド。偶数オフセットに効果名、奇数に値
                    this.c = N(N(this.c) - 900) * 15;
                    this.Temp2 = "2";
                    for (let i = 0; i < 3; i++) {
                        this.Temp2 = N(this.Temp2) + 2;
                        this.Temp1 = G.Skill_2.item(N(this.c) + N(this.Temp2));
                        if (B(!B(equals(this.Temp1, "")))) {
                            if (B(equals(this.Temp1, "狙撃ワープ"))) {
                                yield* this.Make_sound(this.Pickupped.item(3), this.Pickupped.item(4), "ワープ");
                                if (B(equals(this.Pickupped.item(1), G.ID)) && B(!B(equals(G.Sniping_player, "0000")))) {
                                    this.Temp3 = G.ID_num.item(G.IDs.itemNum(G.Sniping_player));
                                    if (B(compare("400", G.CLOUD.item(N(this.Temp3) + 2)) < 0)) {
                                        G.X = G.CLOUD.item(N(this.Temp3) + 2);
                                        G.Y = G.CLOUD.item(N(this.Temp3) + 3);
                                    }
                                }
                            }
                            else if (this.Bullet_name.contains(this.Temp1)) {
                                // 弾として撃てる効果は Player shot を再帰して撃つ
                                this.Temp3 = "";
                                if (B(equals(this.Temp1, "スモーク")))
                                    this.Temp3 = "爆発";
                                if (B(equals(this.Temp1, "スーパーバリア")))
                                    this.Temp3 = "バリア";
                                if (B(equals(this.Temp1, "マキビシ")) || B(equals(this.Temp1, "スパイクボール")) || B(equals(this.Temp1, "ゴ棒")))
                                    this.Temp3 = "投げる";
                                if (B(equals(this.Temp1, "ヒーリングゾーン")) || B(equals(this.Temp1, "神秘のトーテム")) || B(equals(this.Temp1, "デストロイヤー")))
                                    this.Temp3 = "設置";
                                this.f = "1";
                                yield* this.Player_shot(this.Temp1, G.Skill_2.item(N(this.c) + N(N(this.Temp2) + 1)), this.Temp3, this.Pickupped.item(5));
                            }
                            else if (B(equals(G.ID, this.Pickupped.item(1)))) {
                                yield* this.Put_buff(this.Temp1, G.Skill_2.item(N(this.c) + N(N(this.Temp2) + 1)));
                            }
                        }
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
            }
            else {
                // ---- マップギミック（c = 800 + ギミック番号） ----
                this.c = G.Wall___object.itemNum(this.Gimmick_wall.item(N(this.c) - 800));
                if (B(compare(G.Wall___object.item(N(this.c) + 5), "0") < 0)) {
                    this.Temp1 = G.Wall___object.item(N(this.c) + 1);
                    this.g = N(G.Wall___object.item(N(this.c) + 2)) * 50;
                    this.h = N(G.Wall___object.item(N(this.c) + 3)) * 50;
                    if (B(equals(this.Temp1, "20"))) {
                        this.Temp2 = "450";
                        this.Temp3 = "爆発";
                        this.Temp4 = "フラッシュ爆発";
                    }
                    if (B(equals(this.Temp1, "21"))) {
                        this.Temp2 = "600";
                        this.Temp3 = "爆発";
                        this.Temp4 = "回復フラッシュ爆発";
                    }
                    if (B(equals(this.Temp1, "22"))) {
                        this.Temp2 = "210";
                        this.Temp3 = "レーザーキャノン";
                        this.Temp4 = "レーザーギミック";
                    }
                    if (B(equals(this.Temp1, "24"))) {
                        this.Temp2 = "600";
                        this.Temp3 = "起動";
                        this.Temp4 = "エネルギーボール";
                    }
                    if (B(equals(this.Temp1, "28"))) {
                        this.Temp2 = "1200";
                        this.Temp3 = "ジェム破壊";
                        this.Temp4 = "ジェムエネルギー";
                        // ジェムは自陣側では壊せない（R は左半分 x<3200、B は右半分が自陣）
                        const ownSide = (B(equals(letterOf(this.Pickupped.item(12), 1), "1")) && B(compare(this.g, "3200") < 0)) ||
                            (B(equals(letterOf(this.Pickupped.item(12), 1), "2")) && B(compare("3200", this.g) < 0));
                        if (ownSide)
                            return;
                        G.MVPpoint.add(this.Pickupped.item(1));
                        G.MVPpoint.add(G.TEAMMODE_2.item(16));
                        if (B(equals(letterOf(this.Pickupped.item(12), 1), "1"))) {
                            G.TEAMMODE_2.replace(3, N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(16)));
                        }
                        else {
                            G.TEAMMODE_2.replace(4, N(G.TEAMMODE_2.item(4)) + N(G.TEAMMODE_2.item(16)));
                        }
                    }
                    yield* this.Make_sound(this.g, this.h, this.Temp3);
                    G.Wall___object.replace(N(this.c) + 5, this.Temp2);
                    if ((B(equals(this.Temp1, "24")) && B(equals(this.Pickupped.item(1), G.ID))) || B(!B(equals(this.Temp1, "24")))) {
                        if (B(equals(this.Pickupped.item(1), G.ID))) {
                            yield* this.Get_mission_point("Gimmick", "1");
                        }
                        G.Bullet_and_effect.add(this.Pickupped.item(1));
                        G.Bullet_and_effect.add(this.Temp4);
                        if (B(equals(this.Temp1, "22"))) {
                            G.Bullet_and_effect.add(N(this.g) + N(mathop("sin", G.Wall___object.item(N(this.c) + 4))) * 36);
                            G.Bullet_and_effect.add(N(this.h) + N(mathop("cos", G.Wall___object.item(N(this.c) + 4))) * 36);
                        }
                        else {
                            G.Bullet_and_effect.add(this.g);
                            G.Bullet_and_effect.add(this.h);
                        }
                        G.Bullet_and_effect.add(G.Wall___object.item(N(this.c) + 4));
                        if (B(equals(this.Temp1, "20"))) {
                            G.Bullet_and_effect.add("25");
                            G.Bullet_and_effect.add("170");
                        }
                        if (B(equals(this.Temp1, "21"))) {
                            G.Bullet_and_effect.add("-10");
                            G.Bullet_and_effect.add("140");
                        }
                        if (B(equals(this.Temp1, "22"))) {
                            G.Bullet_and_effect.add("30");
                            G.Bullet_and_effect.add("0");
                        }
                        if (B(equals(this.Temp1, "24"))) {
                            G.Bullet_and_effect.add("0");
                            G.Bullet_and_effect.add("0");
                        }
                        if (B(equals(this.Temp1, "28"))) {
                            G.Bullet_and_effect.add("0");
                            G.Bullet_and_effect.add("0");
                        }
                        G.Bullet_and_effect.add("0");
                        G.Bullet_and_effect.add("0");
                        G.Bullet_and_effect.add("0");
                    }
                }
            }
        }
        else if (B(equals(this.f, "2"))) {
            if (B(equals(this.c, "899"))) {
                // チャージ弾の消去: Charge が一致するレコードを1件削除する
                this.f = "0";
                const records = Math.max(0, Math.floor(N(G.Bullet_and_effect.length) / 10));
                for (let i = 0; i < records; i++) {
                    if (B(equals(G.Bullet_and_effect.item(N(this.f) + 6), G.Charge))) {
                        for (let j = 0; j < 10; j++) {
                            G.Bullet_and_effect.delete(N(this.f) + 1);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        return;
                    }
                    this.f = N(this.f) + 10;
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            else {
                // アイテムドロップ
                G.Bullet_and_effect.add(this.Pickupped.item(1));
                G.Bullet_and_effect.add("Drop item");
                G.Bullet_and_effect.add(this.Pickupped.item(3));
                G.Bullet_and_effect.add(this.Pickupped.item(4));
                G.Bullet_and_effect.add(360 / (100 / N(S(letterOf(G.Charge, 2)) + S(letterOf(G.Charge, 3)))));
                G.Bullet_and_effect.add(G.Charge);
                G.Bullet_and_effect.add(this.c);
                G.Bullet_and_effect.add(7 / (9 / N(letterOf(G.Charge, 1))) + 3);
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
            }
        }
        else {
            // ---- 通常発射: 音が届く/見える範囲か（g）で生成を間引く ----
            if (G.Remaining_bullet.contains(weapon)) {
                this.g = "1";
            }
            else if (B(equals(weapon, "Chat"))) {
                this.g = B(equals(N(compare(G.X, "400") < 0) - 0, N(compare(this.Pickupped.item(3), "400") < 0) - 0)) ? "1" : "0";
            }
            else {
                this.f = N(G.X) - N(this.Pickupped.item(3));
                this.h = N(G.Y) - N(this.Pickupped.item(4));
                if (B(compare(mathop("sqrt", N(this.f) * N(this.f) + N(this.h) * N(this.h)), "500") < 0)) {
                    this.g = "1";
                }
                else if (B(compare(mathop("abs", N(mod(N(N(mathop("atan", N(this.f) / N(this.h))) + N(compare(this.h, "0") < 0) * 180 - N(direction)) + 180, 360)) - 180), "60") < 0)) {
                    this.g = "1";
                }
                else {
                    this.g = "0";
                    if (B(compare(G.X, "400") < 0)) {
                        // Gライフクリスタルの近くで撃たれた弾は例外的に生成する
                        if (G.Bullet_damage.contains(weapon)) {
                            this.a = "0";
                            const records = Math.max(0, Math.floor(N(G.Bullet_and_effect.length) / 10));
                            for (let i = 0; i < records; i++) {
                                if (B(equals(G.Bullet_and_effect.item(N(this.a) + 2), "Gライフクリスタル"))) {
                                    if (B(compare(mathop("abs", N(this.Pickupped.item(3)) - N(G.Bullet_and_effect.item(N(this.a) + 3))), "350") < 0) &&
                                        B(compare(mathop("abs", N(this.Pickupped.item(4)) - N(G.Bullet_and_effect.item(N(this.a) + 4))), "350") < 0)) {
                                        this.g = "1";
                                    }
                                }
                                this.a = N(this.a) + 10;
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                    }
                    else if (B(equals(G.Lag_cutter, "0"))) {
                        if (B(compare("800", N(mathop("abs", G.Camera_x)) + N(mathop("abs", G.Camera_y))) < 0)) {
                            this.f = N(G.Camera_x) - N(this.Pickupped.item(3));
                            this.h = N(G.Camera_y) - N(this.Pickupped.item(4));
                            if (B(compare(mathop("sqrt", N(this.f) * N(this.f) + N(this.h) * N(this.h)), "500") < 0)) {
                                this.g = "1";
                            }
                        }
                    }
                }
            }
            if (B(equals(G.Not_attack, "0"))) {
                yield* this.Make_sound(this.Pickupped.item(3), this.Pickupped.item(4), sound);
            }
            if (B(equals(this.g, "1"))) {
                this.f = G.Bullet_and_effect.length;
                yield* this.Shot_create(weapon, create_type, direction);
                if (S(create_type).toLowerCase().includes(S("チャージ").toLowerCase())) {
                    // チャージ弾は生成後に威力フィールドへチャージ量を織り込む
                    this.Temp1 = G.Item_list.item(N(G.Weapon.item(G.Weapon_name.itemNum(weapon))) + 1);
                    this.Temp2 = S(this.Temp1).length;
                    const powerTail = S(letterOf(this.Temp1, N(this.Temp2) - 6)) + S(S(letterOf(this.Temp1, N(this.Temp2) - 5)) + S(letterOf(this.Temp1, N(this.Temp2) - 4)));
                    const baseVal = N(S(letterOf(create_type, 6)) + S(S(letterOf(create_type, 7)) + S(letterOf(create_type, 8)))) - 100;
                    G.Bullet_and_effect.replace(N(this.f) + N(letterOf(create_type, 5)), baseVal + N(G.Charge) * (N(powerTail) - 100) / 100);
                }
            }
        }
    }
    // procedure: "Break wall [b] %s %s %s %s %s %s"
    *Break_wall__b(create_type, val1, val2, val3, val4, val5) {
        // Bullet_list 命令 "Break wall" の実体。弾のグリッド位置が壁/ガードに当たれば
        // Delete（削除予約 + 生成物）へ渡す。
        if (B(equals(this.IF_ACT, "1"))) {
            yield* this.Bullet_wall_2((S(Math.round(N((N(this.Temp1_2.item(3)) / N(50))))) + S((S("/") + S(Math.round(N((N(this.Temp1_2.item(4)) / N(50)))))))), "1");
            if (B(equals(this.Bullet_wall, "1"))) {
                yield* this.Delete(create_type, val1, val2, val3, val4, val5);
            }
        }
    }
    // procedure: "Set motion"
    *Set_motion() {
        // 手のポーズ決定。Motion[2] がポーズ種別で、Hand_position 経由で Motion[4..9] を書く。
        // 0=待機の揺れ、1/2=構え、3/4=背負い、5=両手、6=照準、7=固定、8=盾、12=両手固定、13〜15=反動。
        // 9〜11/16/17 はチャージ系で、位相が上限を超えると Menu[66] = 1（打ち切り）と
        // Menu[46] = 0（武器モーション再開）を置く（マウスを押し続けていれば位相を巻き戻して継続）。
        G.Menu.replace(66, "0");
        if (B(equals(G.Motion.item(2), "0"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(170) / N(G.FPS)))));
            this.a = (N(62) + N((N(mathop("sin", G.Motion.item(1))) * N(5))));
            yield* this.Hand_position("0", "0", this.a, "30", (N(this.a) / N(2)), "4");
            if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("近接武装").toLowerCase()))) {
                yield* this.Hand_position("0", "0", (N(0) - N(this.a)), "30", (N(0) - N(this.a)), "7");
            }
            else {
                yield* this.Hand_position("0", "0", (N(0) - N(this.a)), "30", (N(this.a) / N(-2)), "7");
            }
            G.Motion.replace(10, "0");
        }
        if (B((B(equals(G.Motion.item(2), "1")) || B(equals(G.Motion.item(2), "2"))))) {
            this.a = (N(62) + N(G.Motion.item(1)));
            this.b = (N(30) + N(G.Motion.item(10)));
            yield* this.Hand_position("0", "0", this.a, this.b, (N(this.a) / N(2)), "4");
            if (B(equals(G.Motion.item(2), "1"))) {
                yield* this.Hand_position("0", "0", (N(0) - N(this.a)), this.b, (N(this.a) / N(-2)), "7");
            }
            if (B(equals(G.Motion.item(2), "2"))) {
                yield* this.Hand_position("0", "0", (N(0) - N(this.a)), (N(this.b) - N(10)), (N(this.a) / N(-2)), "7");
            }
        }
        if (B(equals(G.Motion.item(2), "3"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(170) / N(G.FPS)))));
            this.a = (N((N(mathop("sin", G.Motion.item(1))) * N(2.5))) - N(5));
            yield* this.Hand_position((N(mathop("sin", G.Motion.item(3))) * N(25)), (N(mathop("cos", G.Motion.item(3))) * N(25)), "-70", this.a, "-70", "4");
            G.Motion.replace(7, (N(G.Motion.item(4)) + N((N(mathop("sin", G.Motion.item(6))) * N(-10)))));
            G.Motion.replace(8, (N(G.Motion.item(5)) + N((N(mathop("cos", G.Motion.item(6))) * N(-10)))));
            G.Motion.replace(9, G.Motion.item(6));
            G.Motion.replace(10, "0");
        }
        if (B(equals(G.Motion.item(2), "4"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(170) / N(G.FPS)))));
            this.a = (N((N(mathop("sin", G.Motion.item(1))) * N(10))) + N(10));
            yield* this.Hand_position("0", "0", this.a, "25", (N(this.a) - N(70)), "4");
            G.Motion.replace(7, (N(G.Motion.item(4)) + N((N(mathop("sin", G.Motion.item(6))) * N(-10)))));
            G.Motion.replace(8, (N(G.Motion.item(5)) + N((N(mathop("cos", G.Motion.item(6))) * N(-10)))));
            G.Motion.replace(9, G.Motion.item(6));
            G.Motion.replace(10, "0");
        }
        if (B(equals(G.Motion.item(2), "5"))) {
            this.a = (N(62) + N(G.Motion.item(1)));
            this.b = (N(-62) + N((N(G.Motion.item(1)) / N(2))));
            yield* this.Hand_position("0", "0", this.a, "30", (N(this.a) / N(2)), "4");
            yield* this.Hand_position("0", "0", this.b, "30", this.b, "7");
        }
        if (B(equals(G.Motion.item(2), "6"))) {
            this.a = (N(62) + N(G.Motion.item(1)));
            this.b = (N(mathop("sin", G.Motion.item(3))) * N((N(G.Motion.item(10)) - N(5))));
            this.d = (N(mathop("cos", G.Motion.item(3))) * N((N(G.Motion.item(10)) - N(5))));
            this.c = (N(62) + N((N(G.Motion.item(1)) / N(2))));
            yield* this.Hand_position(this.b, this.d, this.c, "30", (N(this.a) / N(2)), "4");
            this.e = (N(30) + N((N(mathop("abs", G.Motion.item(1))) / N(5))));
            this.c = (N(62) + N((N(G.Motion.item(1)) * N(1.2))));
            yield* this.Hand_position(this.b, this.d, (N(0) - N(this.c)), this.e, (N(this.a) / N(-2)), "7");
        }
        if (B(equals(G.Motion.item(2), "7"))) {
            this.a = (N(mathop("sin", G.Motion.item(3))) * N((N(G.Motion.item(10)) + N(6))));
            this.b = (N(mathop("cos", G.Motion.item(3))) * N((N(G.Motion.item(10)) + N(6))));
            yield* this.Hand_position(this.a, this.b, "90", "23", "0", "4");
            G.Motion.replace(7, "0");
            G.Motion.replace(8, "0");
            G.Motion.replace(9, "0");
        }
        if (B(equals(G.Motion.item(2), "8"))) {
            yield* this.Hand_position("0", "0", "0", G.Motion.item(10), "0", "4");
            G.Motion.replace(7, "0");
            G.Motion.replace(8, "0");
            if (B((compare("0.5", (N(mathop("abs", G.Speed_x)) + N(mathop("abs", G.Speed_y)))) < 0))) {
                this.a = (N(mathop("atan", (N(G.Speed_x) / N(G.Speed_y)))) + N((N((compare(G.Speed_y, "0") < 0)) * N(180))));
                if (B((compare("130", mathop("abs", (N(mod((N((N(this.a) - N(G.Motion.item(9)))) + N(180)), 360)) - N(180)))) < 0))) {
                    this.a = N(this.a) + N(180);
                }
                G.Motion.replace(9, (N(G.Motion.item(9)) + N((N((N(mod((N((N(this.a) - N(G.Motion.item(9)))) + N(180)), 360)) - N(180))) / N(4)))));
            }
            G.Motion.replace(9, mod(G.Motion.item(9), 360));
        }
        if (B(equals(G.Motion.item(2), "9"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(-20) * N(G.FPS_temp)))));
            yield* this.Hand_position("0", "0", G.Motion.item(1), "30", (N(G.Motion.item(1)) * N(2.5)), "4");
            this.a = (N(G.Motion.item(1)) - N(124));
            yield* this.Hand_position("0", "0", this.a, "30", (N(this.a) * N(2.5)), "7");
            if (B((compare(G.Motion.item(1), "-298") < 0))) {
                if (B(this.rt.mouse.down)) {
                    G.Motion.replace(1, (N(G.Motion.item(1)) + N(360)));
                }
                else {
                    G.Menu.replace(66, "1");
                    G.Menu.replace(46, "0");
                }
            }
        }
        if (B(equals(G.Motion.item(2), "10"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(45) * N(G.FPS_temp)))));
            this.a = (N(mathop("sin", G.Motion.item(1))) * N(5));
            yield* this.Hand_position("0", "0", "62", (N(30) + N(this.a)), "31", "4");
            yield* this.Hand_position("0", "0", "-62", (N(30) - N(this.a)), "-31", "7");
            if (B((compare("2700", G.Motion.item(1)) < 0))) {
                if (B(this.rt.mouse.down)) {
                    G.Motion.replace(1, (N(G.Motion.item(1)) - N(2700)));
                }
                else {
                    G.Menu.replace(66, "1");
                    G.Menu.replace(46, "0");
                }
            }
        }
        if (B(equals(G.Motion.item(2), "11"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(20) * N(G.FPS_temp)))));
            this.a = (N(mathop("sin", G.Motion.item(1))) * N(62));
            yield* this.Hand_position("0", "0", this.a, "30", this.a, "4");
            yield* this.Hand_position("0", "0", "-62", "30", "-31", "7");
            if (B((compare("810", G.Motion.item(1)) < 0))) {
                if (B(this.rt.mouse.down)) {
                    G.Motion.replace(1, (N(G.Motion.item(1)) - N(720)));
                }
                else {
                    G.Menu.replace(66, "1");
                    G.Menu.replace(46, "0");
                }
            }
        }
        if (B(equals(G.Motion.item(2), "12"))) {
            yield* this.Hand_position("0", "0", "62", "30", "31", "4");
            yield* this.Hand_position("0", "0", "0", "30", "0", "7");
        }
        if (B((B((compare("12", G.Motion.item(2)) < 0)) && B((compare(G.Motion.item(2), "16") < 0))))) {
            if (B(equals(G.Scoping, "1"))) {
                this.a = (N(G.Motion.item(1)) * N(-0.1));
                this.c = "5";
            }
            else {
                this.a = (N(G.Motion.item(1)) * N(-0.3));
                this.c = "0";
            }
            this.b = (N((N(62) + N(G.Motion.item(1)))) / N(2));
            if (B(equals(G.Motion.item(2), "13"))) {
                yield* this.Hand_position((N(mathop("sin", G.Motion.item(3))) * N(G.Motion.item(10))), (N(mathop("cos", G.Motion.item(3))) * N(G.Motion.item(10))), this.a, (N(30) + N(this.c)), (N(this.b) + N(4)), "4");
            }
            else {
                yield* this.Hand_position("0", "0", this.a, (N(30) + N(this.c)), this.b, "4");
            }
            this.a = (N(0) - N(this.a));
            this.b = (N(0) - N(this.b));
            if (B(equals(G.Motion.item(2), "14"))) {
                yield* this.Hand_position((N(mathop("sin", G.Motion.item(3))) * N(G.Motion.item(10))), (N(mathop("cos", G.Motion.item(3))) * N(G.Motion.item(10))), this.a, (N(30) - N(this.c)), (N(this.b) - N(4)), "7");
            }
            else {
                yield* this.Hand_position("0", "0", this.a, (N(30) - N(this.c)), this.b, "7");
            }
        }
        if (B(equals(G.Motion.item(2), "16"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N((N(60) * N(G.FPS_temp)))));
            yield* this.Hand_position("0", "0", "0", "30", G.Motion.item(1), "4");
            yield* this.Hand_position("0", "0", "0", "30", (N(G.Motion.item(1)) + N(180)), "7");
            if (B((compare("1800", G.Motion.item(1)) < 0))) {
                if (B(this.rt.mouse.down)) {
                    G.Motion.replace(1, (N(G.Motion.item(1)) - N(1800)));
                }
                else {
                    G.Menu.replace(66, "1");
                    G.Menu.replace(46, "0");
                }
            }
        }
        if (B(equals(G.Motion.item(2), "17"))) {
            G.Motion.replace(1, (N(G.Motion.item(1)) + N(G.FPS_temp)));
            if (B((compare("6", mod(G.Motion.item(1), 13)) < 0))) {
                yield* this.Hand_position("0", "0", "0", "30", "0", "4");
                yield* this.Hand_position("0", "0", "0", "30", "0", "7");
            }
            else {
                yield* this.Hand_position((N(mathop("sin", (N(G.Motion.item(3)) + N(90)))) * N(10)), (N(mathop("cos", (N(G.Motion.item(3)) + N(90)))) * N(10)), "0", "30", "0", "4");
                yield* this.Hand_position((N(mathop("sin", (N(G.Motion.item(3)) - N(90)))) * N(10)), (N(mathop("cos", (N(G.Motion.item(3)) - N(90)))) * N(10)), "0", "30", "0", "7");
            }
            if (B((compare("90", G.Motion.item(1)) < 0))) {
                if (B(this.rt.mouse.down)) {
                    G.Motion.replace(1, (N(G.Motion.item(1)) - N(90)));
                }
                else {
                    G.Menu.replace(66, "1");
                    G.Menu.replace(46, "0");
                }
            }
        }
    }
    // procedure: "CSM menu %s %s %s %s"
    *CSM_menu(num, val, C_S_M, speed) {
        // Menu[num] への値操作。type: "S" = 代入、"C" = += val × FPS_temp、
        // それ以外（"M"）= ((val − 現在値) / speed) × FPS_temp だけ接近する。UI の開閉位置の追随が主な用途。
        if (B(equals(C_S_M, "S"))) {
            G.Menu.replace(num, val);
        }
        else {
            if (B(equals(C_S_M, "C"))) {
                G.Menu.replace(num, (N(G.Menu.item(num)) + N((N(val) * N(G.FPS_temp)))));
            }
            else {
                G.Menu.replace(num, (N(G.Menu.item(num)) + N((N((N((N(val) - N(G.Menu.item(num)))) / N(speed))) * N(G.FPS_temp)))));
            }
        }
    }
    // procedure: "Draw UI %s %s %s"
    *Draw_UI(UI_name, menu, always_menu) {
        // 全画面メニュー UI の描画と当たり判定。menu はパネル上端の Y 座標で、
        // round(menu) == always_menu のときは「閉じている」として何もしない。
        // 描画しながらマウス位置で Mouse_touch / Touch を決めるのが仕事で、
        // 実際の動作（購入・切替など）は Button 手順が Mouse_touch を読んで行う。
        // 面の種類: Chat / What's new / Shop（Menu[19] で
        //   1=武器店 2=サブ武器店 3=キャラ選択 4=ペット店 5=ロッカー 6=呪い店、
        //   4 文字ならプレイヤープロフィール）/ Team / Computer /
        //   Map pointer / Turret map pointer / Cheat stopper。
        if (B((!B(equals(Math.round(N(menu)), always_menu))))) {
            const my = N(menu); // パネル上端 Y（数値）
            // 半透明パネル地（Team / Computer / Map pointer 共通、色だけ違う）
            const panelFill = function* (color) {
                this.gotoXY(-215, (my - 30));
                this.setPenColor(color);
                this.setPenSize(31);
                this.setPenParam(S("transparency"), 100);
                this.penDown();
                this.setPenParam(S("transparency"), 5);
                for (let i = 0; i < 4; i++) {
                    this.changeXBy(430);
                    this.changeYBy(-30);
                    this.changeXBy(-430);
                    this.changeYBy(-30);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.changeXBy(430);
                this.changeYBy(-30);
                this.changeXBy(-430);
                this.penUp();
            }.bind(this);
            // パネルの灰色枠
            const panelBorder = () => {
                this.gotoXY(-220, menu);
                this.setPenColor("#676767");
                this.setPenSize(30);
                this.penDown();
                this.changeXBy(440);
                this.changeYBy(-320);
                this.changeXBy(-440);
                this.changeYBy(320);
                this.penUp();
            };
            // 武器/ペットのスロット枠（黒い菱形＋緑バー）。色は呼び出し側が先に設定する
            const slotFrame = function* () {
                this.setPenSize(5);
                this.setPenParam(S("transparency"), 100);
                this.changeYBy(12.5);
                this.penDown();
                this.setPenParam(S("transparency"), 50);
                this.changeXBy(35);
                this.changeYBy(-35);
                this.changeXBy(-35);
                this.changeYBy(35);
                this.penUp();
                this.changeYBy(-30);
                this.changeXBy(5);
                this.setPenColor("#29ff00");
                this.setPenSize(6);
                this.penDown();
                for (let i = 0; i < 5; i++) {
                    this.changeXBy(25);
                    this.changeXBy(-25);
                    this.changeYBy(5);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.changeXBy(25);
                this.changeYBy(-25);
                this.penUp();
                this.changeXBy(-12.5);
                this.changeYBy(11.5);
            }.bind(this);
            if (B(equals(UI_name, "Chat"))) {
                // Chat だけはパネルに触れたときだけ UI 扱い（他は開いていれば常に UI）
                if (B((B((compare((my - 12), this.rt.mouse.x) < 0)) && B((B((compare("-4", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "172") < 0))))))) {
                    this.Mouse_touch = "UI";
                }
            }
            else {
                this.Mouse_touch = "UI";
                G.Mouse_camera_lock = "1";
                G.Menu.replace(61, "0");
            }
            this.pointInDirection(90);
            if (B(equals(UI_name, "Chat"))) {
                // 定型文チャットの吹き出しパネル。Menu[63] がカテゴリ
                // （"-"=カテゴリ選択、0=呼びかけ、1=返事、2=チーム、3=エモート）
                this.gotoXY(menu, 160);
                this.setPenColor("#272727");
                this.setPenSize(25);
                this.penDown();
                this.changeXBy(140);
                this.changeYBy(-150);
                this.changeXBy(-140);
                this.changeYBy(150);
                for (let i = 0; i < 7; i++) {
                    this.changeYBy(-20);
                    this.changeXBy(140);
                    this.changeXBy(-140);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.penUp();
                this.setPenSize(20);
                this.gotoXY((my + 5), 136);
                if (B(equals(G.Menu.item(63), "-"))) {
                    this.b = (S("Chat menu") + S(G.Language));
                    this.c = "4";
                }
                if (B(equals(G.Menu.item(63), "0"))) {
                    this.b = (S("Chat 呼びかけ") + S(G.Language));
                    this.c = "6";
                }
                if (B(equals(G.Menu.item(63), "1"))) {
                    this.b = (S("Chat 返事") + S(G.Language));
                    this.c = "5";
                }
                if (B(equals(G.Menu.item(63), "2"))) {
                    this.b = (S("Chat チーム") + S(G.Language));
                    this.c = "6";
                }
                if (B(equals(G.Menu.item(63), "3"))) {
                    this.b = (S("Chat エモート") + S(G.Language));
                    this.c = "5";
                }
                this.a = "0";
                const rows = Math.max(0, Math.floor(N(this.c)));
                for (let r = 0; r < rows; r++) {
                    this.a = N(this.a) + N(1);
                    if (B((B((B((compare("-10", (N(this.rt.mouse.x) - N(this.x))) < 0)) && B((compare((N(this.rt.mouse.x) - N(this.x)), "90") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "10") < 0))))) {
                        this.Touch = this.a;
                        if (B(equals(G.Menu.item(63), "-"))) {
                            this.Mouse_touch = "Chat menu";
                        }
                        else {
                            this.Mouse_touch = "Chat button";
                        }
                    }
                    // Quick chat に登録済みの行は黄色
                    if (B(this.Quick_chat.contains((S(G.Menu.item(63)) + S(this.a))))) {
                        this.setPenColor("#fdffb0");
                    }
                    else {
                        this.setPenColor("#ffffff");
                    }
                    this.penDown();
                    this.changeXBy(80);
                    this.penUp();
                    this.changeXBy(-80);
                    this.changeYBy(-24);
                    if (!this.rt.warpActive)
                        yield;
                }
                yield* this.Stamp(menu, "160", "100", this.b);
                this.gotoXY((my - 6), 158);
                this.setEffect("BRIGHTNESS", 100);
                yield* this.Draw_text("Chat", "80", "L", this.x);
                this.setEffect("BRIGHTNESS", 0);
            }
            if (B((B(equals(UI_name, "Shop")) || B(equals(UI_name, "What's new"))))) {
                // 共通枠: ヘッダー帯＋本体＋罫線
                this.gotoXY(-220, menu);
                this.setPenColor("#333333");
                this.setPenSize(31);
                this.penDown();
                this.changeXBy(440);
                this.changeYBy(-23);
                this.changeXBy(-440);
                this.changeYBy(23);
                this.penUp();
                this.gotoXY(-220, (my - 60));
                this.setPenColor("#5a5a5a");
                this.setPenSize(31);
                this.penDown();
                this.changeXBy(440);
                this.changeYBy(-260);
                this.changeXBy(-440);
                this.changeYBy(260);
                for (let i = 0; i < 8; i++) {
                    this.changeYBy(-30);
                    this.changeXBy(440);
                    this.changeXBy(-440);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.penUp();
                this.gotoXY(-225, (my - 12));
                this.setEffect("BRIGHTNESS", 100);
                if (B(equals(UI_name, "What's new"))) {
                    if (B(equals(G.Menu.item(50), "0"))) {
                        // ニュース面: タイトルと Mobile 切替ボタン
                        if (B(equals(G.Festival, "0"))) {
                            yield* this.Draw_text("What's new", "120", "L", "-225");
                        }
                        else {
                            yield* this.Draw_text("Festival!", "120", "L", "-225");
                        }
                        if (B((B((B((compare("56", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "228") < 0)))) && B((B((compare("128", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "153") < 0))))))) {
                            this.setPenColor("#9a9a9a");
                            this.Mouse_touch = "Mobile on/off";
                        }
                        else {
                            this.setPenColor("#676767");
                        }
                        this.setPenSize(18);
                        this.gotoXY(65, (my - 24));
                        this.penDown();
                        this.changeXBy(155);
                        this.changeYBy(7);
                        this.changeXBy(-155);
                        this.changeYBy(-7);
                        this.penUp();
                        this.changeYBy(3);
                        if (B(equals(G.Mobile, "0"))) {
                            yield* this.Draw_text("Mobile: OFF", "80", "L", "65");
                        }
                        else {
                            yield* this.Draw_text("Mobile: ON", "80", "L", "65");
                        }
                    }
                    if (B(equals(G.Menu.item(50), "1"))) {
                        yield* this.Draw_text("Choose starter", "120", "L", "-225");
                    }
                    if (B(equals(G.Festival, "0"))) {
                        // Next ボタン（Festival 中は出ない）
                        if (B((B((B((compare("150", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "227") < 0)))) && B((B((compare("-167", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "-130") < 0))))))) {
                            this.setPenColor("#9a9a9a");
                            this.Mouse_touch = "First UI next";
                        }
                        else {
                            this.setPenColor("#333333");
                        }
                        this.setPenSize(23);
                        this.gotoXY(163, (my - 301));
                        this.penDown();
                        this.changeXBy(53);
                        this.changeYBy(-15);
                        this.changeXBy(-53);
                        this.changeYBy(15);
                        this.penUp();
                        this.setPenColor("#333333");
                        this.setPenSize(5);
                        this.gotoXY(-7, (my - 60));
                        this.penDown();
                        this.changeYBy(-260);
                        this.penUp();
                        this.gotoXY(189, (my - 309));
                        yield* this.Draw_text("Next", "88", "C", "189");
                    }
                    if (B(equals(G.Menu.item(50), "0"))) {
                        this.setEffect("BRIGHTNESS", 0);
                        if (B(equals(G.Festival, "0"))) {
                            yield* this.Stamp("0", (my - 160), "100", "What's new");
                        }
                        else {
                            yield* this.Stamp("0", (my - 160), "100", "What's festival");
                        }
                    }
                    if (B(equals(G.Menu.item(50), "1"))) {
                        // 初期武器の選択: Starter を Main 列 / Sub 列の 2 列に並べる。
                        // Starter の末尾2件が選択中スロット（[len-1]=Main、[len]=Sub）
                        this.gotoXY(-225, (my - 66));
                        yield* this.Draw_text("Main", "120", "L", "-225");
                        this.changeXBy(229);
                        yield* this.Draw_text("Sub", "120", "L", "4");
                        this.a = "0";
                        this.b = "0";
                        this.c = "60";
                        const starterRows = Math.max(0, Math.floor(N((N(this.Starter.length) - N(3)))));
                        for (let r = 0; r < starterRows; r++) {
                            this.a = N(this.a) + N(1);
                            this.gotoXY((N(this.b) - N(222)), this.c);
                            if (B((B(equals(this.Starter.item((N(this.Starter.length) - N(1))), this.a)) || B(equals(this.Starter.item("last"), this.a))))) {
                                this.setPenColor("#ff0000");
                            }
                            else {
                                this.setPenColor("#000000");
                            }
                            yield* slotFrame();
                            this.setEffect("BRIGHTNESS", 0);
                            yield* this.Stamp(this.x, this.y, "77", (S("@") + S(this.Starter.item(this.a))));
                            this.setEffect("BRIGHTNESS", 100);
                            this.changeXBy(40);
                            this.changeYBy(1);
                            // テキスト地色: 列の上側（メイン武器側）は黒、それ以外は暗緑
                            if (B((B((B(equals(this.b, "0")) && B((compare(this.a, "4") < 0)))) || B((B(equals(this.b, "229")) && B((compare(this.a, (N(this.Starter.itemNum("")) + N(4))) < 0))))))) {
                                this.setPenColor("#000000");
                            }
                            else {
                                this.setPenColor("#3f4200");
                            }
                            this.setPenSize(27);
                            this.setPenParam(S("transparency"), 100);
                            this.penDown();
                            this.setPenParam(S("transparency"), 10);
                            this.changeXBy(134);
                            this.penUp();
                            if (B((B((B((compare((N(this.b) - N(226)), this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, (N(this.b) - N(18))) < 0)))) && B((compare(mathop("abs", (N(this.y) - N(this.rt.mouse.y))), "20") < 0))))) {
                                this.Mouse_touch = "First UI weapon";
                                this.Touch = this.a;
                            }
                            this.changeXBy(-142);
                            yield* this.Draw_text(G.English_weapon_name.item(G.Weapon_name.itemNum(this.Starter.item(this.a))), "60", "L", this.x);
                            this.c = N(this.c) + N(-48);
                            if (B(equals(this.Starter.item((N(this.a) + N(1))), ""))) {
                                // "" 区切りで次の列へ
                                this.a = N(this.a) + N(1);
                                this.b = N(this.b) + N(229);
                                this.c = "60";
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B((B((compare(this.Starter.item((N(this.Starter.length) - N(1))), "4") < 0)) && B((compare(this.Starter.item("last"), (N(this.Starter.itemNum("")) + N(4))) < 0))))) {
                            this.gotoXY(45, -140);
                            yield* this.Draw_text("Starter buff`Money: 8", "60", "L", "45");
                        }
                        this.setEffect("BRIGHTNESS", 0);
                    }
                }
                else {
                    // Shop 面: Menu[19] でタイトルが変わる
                    if (B(equals(G.Menu.item(19), "1"))) {
                        yield* this.Draw_text("Weapon shop", "120", "L", "-225");
                    }
                    if (B(equals(G.Menu.item(19), "2"))) {
                        yield* this.Draw_text("Sub weapon shop", "120", "L", "-225");
                    }
                    if (B(equals(G.Menu.item(19), "3"))) {
                        yield* this.Draw_text("Character select", "120", "L", "-225");
                        // 右上の "?"（キャラ説明オーバーレイの入口）
                        this.gotoXY(215, (my - 20));
                        if (B((compare(this.distanceToMouse(), "15") < 0))) {
                            this.Mouse_touch = "Character info start";
                            this.setPenColor("#8e8e8e");
                        }
                        else {
                            this.setPenColor("#676767");
                        }
                        this.setPenSize(30);
                        this.penDown();
                        this.penUp();
                        this.changeXBy(-7);
                        yield* this.Draw_text("?", "100", "L", "210");
                    }
                    if (B(equals(G.Menu.item(19), "4"))) {
                        yield* this.Draw_text("Pet shop", "120", "L", "-225");
                    }
                    if (B(equals(G.Menu.item(19), "5"))) {
                        yield* this.Draw_text("Locker", "120", "L", "-225");
                    }
                    if (B(equals(G.Menu.item(19), "6"))) {
                        yield* this.Draw_text("@(#+/,%", "120", "L", "-225");
                    }
                    if (B(equals(S(G.Menu.item(19)).length, "4"))) {
                        // プレイヤープロフィール（Menu[19] が 4 文字のプレイヤー ID）
                        // a = 対象レコードの先頭位置（ID_num）
                        G.Move_lock = "1";
                        this.Mouse_touch = "Close player profile";
                        this.a = G.ID_num.item(G.IDs.itemNum(G.Menu.item(19)));
                        this.b = G.CLOUD.item((N(this.a) + N(27)));
                        if (B(equals(G.CLOUD.item((N(this.a) + N(44))), "1"))) {
                            G.Menu.replace(19, "0");
                        }
                        if (B((!B(equals(this.b, "0"))))) {
                            this.setEffect("BRIGHTNESS", 0);
                            this.setEffect("COLOR", (N(G.Team_color_2.item(this.b)) * N(2)));
                        }
                        // 名前の "*" 印: 自分自身でバッジ条件を満たすときだけ付く。
                        // ユニーク ID 数 < 4 の分岐は if(false) で無効化されている（原作のまま）
                        this.Temp1_2.deleteAll();
                        this.c = "0";
                        const recs = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
                        for (let r = 0; r < recs; r++) {
                            this.c = N(this.c) + N(G.Number_of_data);
                            this.d = G.CLOUD.item(this.c);
                            if (B((!B(equals(this.d, ""))))) {
                                if (B((!B(this.Temp1_2.contains(this.d))))) {
                                    this.Temp1_2.add(this.d);
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.c = "*";
                        if (B((compare(this.Temp1_2.length, "4") < 0))) {
                            if (B(false)) {
                                this.c = "";
                            }
                        }
                        if (B((!B(equals(G.ID, G.Menu.item(19)))))) {
                            this.c = "";
                        }
                        if (B(equals(G.Badge, "0"))) {
                            this.c = "";
                        }
                        yield* this.Draw_text((S(G.CLOUD.item((N(this.a) + N((N(G.Number_of_data) - N(1)))))) + S(this.c)), "120", "L", "-225");
                        if (B(equals(this.c, "*"))) {
                            this.changeYBy(-20);
                            yield* this.Draw_text(G.Version_name, "40", "R", "228");
                            this.changeYBy(10);
                            yield* this.Draw_text((S("#") + S(G.ID)), "40", "R", "228");
                        }
                        this.setEffect("COLOR", 0);
                    }
                    this.setEffect("BRIGHTNESS", 0);
                    if (B(equals(S(G.Menu.item(19)).length, "4"))) {
                        // プロフィール本体: ランクプレート、キャラ体と手、ロードアウト 5 件、
                        // 所持率バー、チーム招待ボタン
                        this.Mouse_touch = "Close profile";
                        if (B(equals(G.CLOUD.item((N(this.a) + N(56))), "1"))) {
                            if (B(equals(G.ID, G.Menu.item(19)))) {
                                yield* this.Stamp("215", (my - 2), "33", "Mobile");
                            }
                            else {
                                yield* this.Stamp("205", (my - 12), "45", "Mobile");
                            }
                        }
                        yield* this.Stamp("-110", (my - 86), "170", (S("Rank plate") + S(G.CLOUD.item((N(this.a) + N(34))))));
                        this.b = G.Character_2.item((N(G.CLOUD.item((N(this.a) + N(14)))) + N(1)));
                        if (B(equals(G.CLOUD.item((N(this.a) + N(24))), "1"))) {
                            yield* this.Stamp("-206", (my - 176), "65", (S(this.b) + S(" body+")));
                        }
                        else {
                            yield* this.Stamp("-206", (my - 176), "65", (S(this.b) + S(" body")));
                        }
                        // 手は "hand+" コスチュームが存在すればそちら（field24 が素手指定なら通常手）
                        this.switchCostume("Pen");
                        this.switchCostume((S(this.b) + S(" hand+")));
                        if (B((B(equals(this.costumeNumberName("name"), "Pen")) || B(equals(G.CLOUD.item((N(this.a) + N(24))), "0"))))) {
                            yield* this.Stamp("-195", (my - 160), "65", (S(this.b) + S(" hand")));
                            yield* this.Stamp("-195", (my - 192), "65", (S(this.b) + S(" hand")));
                        }
                        else {
                            yield* this.Stamp("-195", (my - 160), "65", (S(this.b) + S(" hand+")));
                            yield* this.Stamp("-195", (my - 192), "65", (S(this.b) + S(" hand+")));
                        }
                        this.b = "-180";
                        this.c = "0";
                        this.d = (my - 170);
                        for (let r = 0; r < 5; r++) {
                            this.gotoXY(this.b, this.d);
                            this.setPenColor("#000000");
                            yield* slotFrame();
                            yield* this.Stamp(this.x, this.y, "77", (S("@") + S(G.Weapon_name.item(G.CLOUD.item((N(this.a) + N((N(36) + N(this.c)))))))));
                            this.b = N(this.b) + N(45);
                            this.c = N(this.c) + N(1);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.setEffect("BRIGHTNESS", 100);
                        this.gotoXY(23, (my - 73));
                        yield* this.Draw_text((S("Max kill:`") + S(G.CLOUD.item((N(this.a) + N(35))))), "100", "L", "23");
                        this.gotoXY(-220, (my - 140));
                        yield* this.Draw_text("Loadout", "105", "L", "-220");
                        // 所持率の分母: Shop_menu のうち実在する武器名の件数
                        this.b = "0";
                        this.c = "0";
                        const shopLen = Math.max(0, Math.floor(N(G.Shop_menu.length)));
                        for (let r = 0; r < shopLen; r++) {
                            this.b = N(this.b) + N(1);
                            if (B((B((!B(equals(G.Shop_menu.item(this.b), "")))) && B(G.Weapon_name.contains(G.Shop_menu.item(this.b)))))) {
                                this.c = N(this.c) + N(1);
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.gotoXY(-220, (my - 220));
                        yield* this.Draw_text((S("Weapons (") + S((S(G.CLOUD.item((N(this.a) + N(41)))) + S((S("/") + S((S(this.c) + S(")")))))))), "105", "L", "-220");
                        this.gotoXY(-207, (my - 247));
                        this.setPenColor("#333333");
                        this.setPenSize(25);
                        this.penDown();
                        this.changeXBy(414);
                        this.penUp();
                        this.changeXBy(-414);
                        this.setPenColor("#ff0000");
                        this.penDown();
                        this.changeXBy((N(414) / N((N(this.c) / N(G.CLOUD.item((N(this.a) + N(41))))))));
                        this.penUp();
                        this.gotoXY(-220, (my - 286));
                        yield* this.Draw_text((S("Characters (") + S((S((N(G.CLOUD.item((N(this.a) + N(42)))) / N(2))) + S((S("/") + S((S((N(G.Character_tree.length) / N(10))) + S(")")))))))), "105", "L", "-220");
                        this.gotoXY(-207, (my - 313));
                        this.setPenColor("#333333");
                        this.setPenSize(25);
                        this.penDown();
                        this.changeXBy(414);
                        this.penUp();
                        this.changeXBy(-414);
                        this.setPenColor("#e6a800");
                        this.penDown();
                        this.changeXBy((N(414) / N((N((N(G.Character_tree.length) / N(5))) / N(G.CLOUD.item((N(this.a) + N(42))))))));
                        this.penUp();
                        // 招待ボタン: 相手が自チームに居らず、自分がチーム持ちのときだけ。
                        // c は自チームの人数（見出しの後 5 枠の非空数）
                        if (B((!B(G.Team.contains((S("2") + S(G.CLOUD.item((N(this.a) + N(11)))))))))) {
                            if (B(G.Team.contains((S("2") + S(G.ID))))) {
                                this.b = G.Team.itemNum((S("2") + S(G.ID)));
                                this.c = "0";
                                for (let r = 0; r < 5; r++) {
                                    this.b = N(this.b) + N(1);
                                    if (B((!B(equals(G.Team.item(this.b), ""))))) {
                                        this.c = N(this.c) + N(1);
                                    }
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                if (B((B((!B(equals(G.Menu.item(111), "0000")))) || B((compare("4", this.c) < 0))))) {
                                    this.setPenColor("#350000");
                                }
                                else {
                                    if (B((B((B((compare("35", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "210") < 0)))) && B((B((compare("-65", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "-45") < 0))))))) {
                                        this.Mouse_touch = "Send invitation";
                                        this.setPenColor("#158000");
                                    }
                                    else {
                                        this.setPenColor("#083500");
                                    }
                                }
                                this.setPenSize(22);
                                this.gotoXY(45, (my - 215));
                                this.penDown();
                                this.changeXBy(155);
                                this.penUp();
                                this.changeXBy(-155);
                                if (B((compare("4", this.c) < 0))) {
                                    yield* this.Draw_text("Team is full", "85", "L", "45");
                                }
                                else {
                                    if (B(equals(G.Menu.item(111), "0000"))) {
                                        yield* this.Draw_text("Team request", "85", "L", "45");
                                    }
                                    else {
                                        yield* this.Draw_text("Sending...", "85", "L", "45");
                                    }
                                }
                            }
                        }
                        this.setEffect("BRIGHTNESS", 0);
                        if (B(equals(this.a, ""))) {
                            G.Menu.replace(19, "0");
                        }
                    }
                    if (B(equals(G.Menu.item(19), "4"))) {
                        // ペット店: Temp1 = 選択中ペットの Pet_data オフセット（ページ×10）
                        // Pet_data の並び: [+1]=名前 [+2]=価格 [+3]=所持 [+5]=最大HP [+6]=現在HP
                        this.setPenColor("#333333");
                        this.setPenSize(5);
                        this.gotoXY(-220, (my - 160));
                        this.penDown();
                        this.changeXBy(440);
                        this.penUp();
                        this.Temp1 = (N(G.Menu.item(25)) * N(10));
                        this.switchCostume("Pen");
                        this.switchCostume((S("~") + S(G.Pet_data.item((N(this.Temp1) + N(1))))));
                        if (B(equals(this.costumeNumberName("name"), "Pen"))) {
                            yield* this.Stamp("-175", (my - 100), "200", (S(this.costumeNumberName("name")) + S("*")));
                        }
                        else {
                            yield* this.Stamp("-175", (my - 100), "200", this.costumeNumberName("name"));
                        }
                        yield* this.Stamp("0", (my - 160), "100", (S("*") + S(G.Pet_data.item((N(this.Temp1) + N(1))))));
                        this.setPenColor("#333333");
                        this.setPenSize(25);
                        this.gotoXY(-210, (my - 207));
                        this.penDown();
                        this.changeXBy(420);
                        this.penUp();
                        this.changeXBy(-420);
                        this.setPenColor("#9a9a9a");
                        this.setPenSize(15);
                        this.penDown();
                        this.changeXBy(420);
                        this.penUp();
                        this.changeXBy(-420);
                        this.setPenColor("#ff00dc");
                        this.penDown();
                        this.changeXBy((N(420) / N((N(G.Pet_data.item((N(this.Temp1) + N(5)))) / N(G.Pet_data.item((N(this.Temp1) + N(6))))))));
                        this.penUp();
                        // 購入/設定ボタンは HP が満タンのときだけ有効（原作の条件のまま）
                        if (B(equals(G.Pet_data.item((N(this.Temp1) + N(5))), G.Pet_data.item((N(this.Temp1) + N(6)))))) {
                            if (B((B((B((compare("-223", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-130") < 0)))) && B((B((compare("-109", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "-66") < 0))))))) {
                                if (B(equals(G.Pet_data.item((N(this.Temp1) + N(3))), "0"))) {
                                    if (B((compare((N(G.Pet_data.item((N(this.Temp1) + N(2)))) - N(1)), G.Money) < 0))) {
                                        this.Mouse_touch = "Pet buy";
                                    }
                                }
                                else {
                                    if (B(equals(G.Menu.item(25), G.Select_pet))) {
                                        this.Mouse_touch = "Pet remove";
                                    }
                                    else {
                                        this.Mouse_touch = "Pet set";
                                    }
                                }
                                this.Touch = G.Pet_data.item((N(this.Temp1) + N(2)));
                                this.setPenColor("#9a9a9a");
                            }
                            else {
                                this.setPenColor("#333333");
                            }
                        }
                        else {
                            this.setPenColor("#4e4b00");
                        }
                        this.setPenSize(28);
                        this.gotoXY(-209, (my - 240));
                        this.penDown();
                        this.changeXBy(65);
                        this.changeYBy(-15);
                        this.changeXBy(-65);
                        this.changeYBy(15);
                        this.penUp();
                        // ページ送り矢印（右）
                        this.gotoXY(196, (my - 317));
                        if (B((B((B((compare("185", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "227") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(157))), "11") < 0))))) {
                            this.Mouse_touch = "Pet page right";
                            this.setPenColor("#9a9a9a");
                        }
                        else {
                            this.setPenColor("#333333");
                        }
                        this.setPenSize(22);
                        this.penDown();
                        this.changeXBy(20);
                        this.penUp();
                        this.changeXBy(-13);
                        this.setPenColor("#ffffff");
                        this.setPenSize(4);
                        this.penDown();
                        this.changeYBy(5);
                        this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                        this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                        this.changeYBy(5);
                        this.changeXBy(4.5);
                        this.penUp();
                        // ページ送り矢印（左）
                        this.gotoXY(-216, (my - 317));
                        if (B((B((B((compare("-227", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-185") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(157))), "11") < 0))))) {
                            this.Mouse_touch = "Pet page left";
                            this.setPenColor("#9a9a9a");
                        }
                        else {
                            this.setPenColor("#333333");
                        }
                        this.setPenSize(22);
                        this.penDown();
                        this.changeXBy(20);
                        this.penUp();
                        this.changeXBy(-6);
                        this.setPenColor("#ffffff");
                        this.setPenSize(4);
                        this.penDown();
                        this.changeYBy(5);
                        this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                        this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                        this.changeYBy(5);
                        this.changeXBy(-4.5);
                        this.penUp();
                        // ページドット: Menu[88] 件。ホバー中のドットには吹き出しとペット名
                        this.setPenSize(10);
                        this.a = "0";
                        this.b = "-99999";
                        this.gotoXY((N((N(G.Menu.item(88)) - N(1))) * N(-7)), (my - 317));
                        const petPages = Math.max(0, Math.floor(N(G.Menu.item(88))));
                        for (let r = 0; r < petPages; r++) {
                            if (B((compare(this.distanceToMouse(), "5") < 0))) {
                                this.setPenColor("#ff7fed");
                                this.b = this.x;
                                this.Touch = this.a;
                                this.Mouse_touch = "Pet page button";
                            }
                            else {
                                this.setPenColor("#9a9a9a");
                            }
                            if (B(equals(G.Menu.item(25), this.a))) {
                                this.setPenColor("#ff00dc");
                            }
                            this.penDown();
                            this.penUp();
                            this.changeXBy(14);
                            this.a = N(this.a) + N(1);
                            if (B((!B(equals(G.Menu.item(89), "0"))))) {
                                if (B(equals(this.a, (N(G.Menu.item(88)) - N(1))))) {
                                    this.a = G.Menu.item(89);
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B((compare("-99999", this.b) < 0))) {
                            this.setX(this.b);
                            this.changeYBy(10);
                            this.setPenColor("#353535");
                            this.setPenSize(8);
                            this.penDown();
                            this.gotoXY((N(this.x) + N(5)), (N(this.y) + N(7)));
                            this.gotoXY((N(this.x) - N(5)), (N(this.y) - N(7)));
                            this.gotoXY((N(this.x) - N(5)), (N(this.y) + N(7)));
                            this.changeXBy(25);
                            this.changeYBy(25);
                            this.changeXBy(-40);
                            this.changeYBy(-25);
                            this.changeXBy(20);
                            for (let i = 0; i < 3; i++) {
                                this.changeYBy(7);
                                this.changeXBy(19);
                                this.changeXBy(-38);
                                this.changeXBy(19);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.penUp();
                            this.changeYBy(-9);
                            yield* this.Stamp(this.x, this.y, "70", (S("~") + S(G.Pet_data.item((N((N(this.Touch) * N(10))) + N(1))))));
                        }
                        this.setEffect("BRIGHTNESS", 100);
                        this.gotoXY(-220, (my - 180));
                        yield* this.Draw_text(G.Pet_data.item((N(this.Temp1) + N(4))), "110", "L", "-220");
                        this.gotoXY(-210, (my - 207));
                        yield* this.Draw_text((S(G.Pet_data.item((N(this.Temp1) + N(6)))) + S((S("/") + S(G.Pet_data.item((N(this.Temp1) + N(5))))))), "85", "L", "-220");
                        this.gotoXY(230, (my - 260));
                        yield* this.Draw_text((S("Money: ") + S(G.Money)), "70", "R", "230");
                        if (B((B((compare(G.Money, G.Pet_data.item((N(this.Temp1) + N(2)))) < 0)) && B(equals(G.Pet_data.item((N(this.Temp1) + N(3))), "0"))))) {
                            this.setEffect("BRIGHTNESS", 0);
                        }
                        this.gotoXY(-177, (my - 248));
                        if (B(equals(G.Pet_data.item((N(this.Temp1) + N(3))), "0"))) {
                            yield* this.Draw_text("Buy", "115", "C", "-177");
                        }
                        else {
                            if (B(equals(G.Menu.item(25), G.Select_pet))) {
                                yield* this.Draw_text("Remove", "75", "C", "-177");
                            }
                            else {
                                yield* this.Draw_text("Set", "115", "C", "-177");
                            }
                        }
                        this.gotoXY(-123, (my - 248));
                        yield* this.Draw_text((S("Cost: ") + S(G.Pet_data.item((N(this.Temp1) + N(2))))), "100", "L", "-123");
                        this.setEffect("BRIGHTNESS", 0);
                    }
                    if (B(equals(G.Menu.item(19), "5"))) {
                        // ロッカー: 装備中 5 スロット（Inventory_2、stride 6）、
                        // 所持武器 2 行（Menu[26]/[27] が各行のスクロール量）、
                        // モードタブ 3 つ。表示しながら Inventory_mode へ現在値を同期する
                        this.setPenColor("#9a9a9a");
                        this.setPenSize(35);
                        this.gotoXY(-216, (my - 215));
                        this.penDown();
                        this.changeXBy(432);
                        this.penUp();
                        this.changeYBy(-80);
                        this.changeXBy(-432);
                        this.penDown();
                        this.changeXBy(432);
                        this.penUp();
                        this.a = "1";
                        this.b = "-216";
                        this.c = (my - 115);
                        this.Temp1_2.deleteAll();
                        for (let r = 0; r < 5; r++) {
                            this.gotoXY(this.b, this.c);
                            this.setPenColor("#000000");
                            yield* slotFrame();
                            this.d = G.Inventory_2.item(this.a);
                            this.Temp1_2.add(this.d);
                            yield* this.Stamp(this.x, this.y, "77", (S("@") + S(this.d)));
                            if (B((compare(this.distanceToMouse(), "17") < 0))) {
                                this.Mouse_touch = "Inventory weapon";
                                this.Touch = this.a;
                            }
                            this.b = N(this.b) + N(45);
                            this.a = N(this.a) + N(6);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        // 所持武器 行1（先頭 Menu[25] 件）
                        this.a = "0";
                        this.b = "-180";
                        this.c = (my - 215);
                        const row1 = Math.max(0, Math.floor(N(G.Menu.item(25))));
                        for (let r = 0; r < row1; r++) {
                            this.a = N(this.a) + N(1);
                            this.d = G.Got_weapon.item(this.a);
                            if (B((!B(this.Temp1_2.contains(this.d))))) {
                                if (B((!B(equals(this.d, this.Drag_x))))) {
                                    if (B((compare(mathop("abs", (N(this.b) - N(G.Menu.item(26)))), "215") < 0))) {
                                        yield* this.Stamp((N(this.b) - N(G.Menu.item(26))), this.c, "77", (S("@") + S(this.d)));
                                        if (B((compare(this.distanceToMouse(), "17") < 0))) {
                                            this.Mouse_touch = "Got weapon";
                                            this.Touch = this.a;
                                        }
                                    }
                                    this.b = N(this.b) + N(35);
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        // 所持武器 行2（残り）
                        this.c = N(this.c) + N(-80);
                        this.b = "-180";
                        const row2 = Math.max(0, Math.floor(N((N(G.Got_weapon.length) - N(this.a)))));
                        for (let r = 0; r < row2; r++) {
                            this.a = N(this.a) + N(1);
                            this.d = G.Got_weapon.item(this.a);
                            if (B((!B(this.Temp1_2.contains(this.d))))) {
                                if (B((!B(equals(this.d, this.Drag_x))))) {
                                    if (B((compare(mathop("abs", (N(this.b) - N(G.Menu.item(27)))), "215") < 0))) {
                                        yield* this.Stamp((N(this.b) - N(G.Menu.item(27))), this.c, "77", (S("@") + S(this.d)));
                                        if (B((compare(this.distanceToMouse(), "17") < 0))) {
                                            this.Mouse_touch = "Got weapon";
                                            this.Touch = this.a;
                                        }
                                    }
                                    this.b = N(this.b) + N(35);
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        // 行スクロールの矢印 4 つ（camera1 = 行1、camera2 = 行2）
                        this.setPenColor("#5a5a5a");
                        this.setPenSize(35);
                        this.gotoXY(-218, (my - 195));
                        this.penDown();
                        this.changeYBy(-120);
                        this.penUp();
                        this.changeXBy(436);
                        this.changeYBy(120);
                        this.penDown();
                        this.changeYBy(-120);
                        this.penUp();
                        const lockerArrow = (x, dy, touch, mirror) => {
                            this.gotoXY(x, (my - dy));
                            const inX = mirror
                                ? (B((compare(mathop("abs", (N(this.rt.mouse.x) - N(215))), "9") < 0)))
                                : (B((compare(mathop("abs", (N(this.rt.mouse.x) + N(215))), "9") < 0)));
                            const yLo = dy === 221 ? "-70" : "-150";
                            const yHi = dy === 221 ? "-40" : "-120";
                            if (B((B(inX) && B((B((compare(yLo, this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, yHi) < 0))))))) {
                                this.Mouse_touch = touch;
                                this.setPenColor("#9a9a9a");
                            }
                            else {
                                this.setPenColor("#333333");
                            }
                            this.setPenSize(18);
                            this.penDown();
                            this.changeYBy(12);
                            this.penUp();
                            this.changeXBy(mirror ? -3 : 3);
                            this.changeYBy(-6);
                            this.setPenColor("#ffffff");
                            this.setPenSize(4);
                            this.penDown();
                            this.changeYBy(4);
                            if (mirror) {
                                this.gotoXY((N(this.x) + N(7)), (N(this.y) - N(4)));
                                this.gotoXY((N(this.x) - N(7)), (N(this.y) - N(4)));
                                this.changeYBy(4);
                                this.changeXBy(3.5);
                            }
                            else {
                                this.gotoXY((N(this.x) - N(7)), (N(this.y) - N(4)));
                                this.gotoXY((N(this.x) + N(7)), (N(this.y) - N(4)));
                                this.changeYBy(4);
                                this.changeXBy(-3.5);
                            }
                            this.penUp();
                        };
                        lockerArrow(-215, 221, "Locker camera1 left", false);
                        lockerArrow(215, 221, "Locker camera1 right", true);
                        lockerArrow(-215, 301, "Locker camera2 left", false);
                        lockerArrow(215, 301, "Locker camera2 right", true);
                        // Inventory_mode 同期: [現在モード+1] = キャラ番号、[+4] = スキン、
                        // その後 Inventory_2 の 30 項目をモード別領域へコピー
                        this.Inventory_mode.replace((N(this.Inventory_mode.item(1)) + N(1)), (N(G.Character) / N(15)));
                        this.Inventory_mode.replace((N(this.Inventory_mode.item(1)) + N(4)), G.Special_skin);
                        this.a = (N(7) + N((N((N(this.Inventory_mode.item(1)) - N(1))) * N(30))));
                        this.b = "0";
                        for (let i = 0; i < 30; i++) {
                            this.a = N(this.a) + N(1);
                            this.b = N(this.b) + N(1);
                            this.Inventory_mode.replace(this.a, G.Inventory_2.item(this.b));
                            if (!this.rt.warpActive)
                                yield;
                        }
                        // モードタブ（選択中は赤）とキャラプレビュー
                        this.gotoXY(35, (my - 70));
                        this.a = "0";
                        for (let r = 0; r < 3; r++) {
                            this.a = N(this.a) + N(1);
                            if (B(equals(this.Inventory_mode.item(1), this.a))) {
                                this.setPenColor("#ff0000");
                            }
                            else {
                                this.setPenColor("#000000");
                            }
                            this.setPenSize(35);
                            this.setPenParam(S("transparency"), 100);
                            this.penDown();
                            this.setPenParam(S("transparency"), 50);
                            this.changeXBy(160);
                            this.penUp();
                            this.changeXBy(-160);
                            this.setPenColor("#8e8e8e");
                            this.setPenSize(25);
                            if (B((B((B((compare("23", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "207") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "17") < 0))))) {
                                this.Mouse_touch = (S("Inventory mode") + S(this.a));
                            }
                            this.penDown();
                            this.changeXBy(160);
                            this.penUp();
                            this.changeXBy(-160);
                            if (B((!B(equals(this.Inventory_mode.item((N(this.a) + N(1))), ""))))) {
                                this.c = this.x;
                                this.d = this.y;
                                this.setEffect("BRIGHTNESS", 0);
                                this.b = G.Character_2.item((N((N(this.Inventory_mode.item((N(this.a) + N(1)))) * N(15))) + N(1)));
                                this.pointInDirection(90);
                                if (B(equals(this.Inventory_mode.item((N(this.a) + N(4))), "1"))) {
                                    yield* this.Stamp((N(this.x) + N(110)), this.y, "55", (S(this.b) + S(" body+")));
                                    this.switchCostume((S(this.b) + S(" hand+")));
                                    if (B(S(this.costumeNumberName("name")).toLowerCase().includes(S("+").toLowerCase()))) {
                                        this.b = (S(this.b) + S(" hand+"));
                                    }
                                    else {
                                        this.b = (S(this.b) + S(" hand"));
                                    }
                                }
                                else {
                                    yield* this.Stamp((N(this.x) + N(110)), this.y, "55", (S(this.b) + S(" body")));
                                    this.b = (S(this.b) + S(" hand"));
                                }
                                this.pointInDirection(60);
                                yield* this.Stamp((N(this.x) + N(8)), (N(this.y) + N(14)), "55", this.b);
                                this.pointInDirection(120);
                                yield* this.Stamp(this.x, (N(this.y) - N(28)), "55", this.b);
                                this.gotoXY(this.c, this.d);
                            }
                            this.setEffect("BRIGHTNESS", 100);
                            yield* this.Draw_text((S("Mode") + S(this.a)), "100", "L", "35");
                            this.changeYBy(-42);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.gotoXY(-216, (my - 85));
                        this.pointInDirection(90);
                        yield* this.Draw_text("Inventory", "115", "L", "-226");
                        this.gotoXY(-226, (my - 185));
                        yield* this.Draw_text("Main (Drag to set)", "90", "L", "-226");
                        this.gotoXY(-226, (my - 265));
                        yield* this.Draw_text("Sub", "90", "L", "-226");
                        this.setEffect("BRIGHTNESS", 0);
                        // ドラッグ中の武器はマウス位置に付いてくる
                        yield* this.Stamp(this.rt.mouse.x, this.rt.mouse.y, "77", (S("@") + S(this.Drag_x)));
                    }
                    if (B((B(equals(G.Menu.item(19), "1")) || B((B(equals(G.Menu.item(19), "2")) || B(equals(G.Menu.item(19), "6"))))))) {
                        // ショップの商品リスト: Shop_menu を Menu[27] から "" まで数え、
                        // Menu[28] のスクロールで流す。行色は 選択中=赤 / 装備中=水色 /
                        // 所持=黄色 / それ以外=黒
                        this.a = G.Menu.item(27);
                        this.c = "0";
                        while (!B(equals(G.Shop_menu.item((N(this.a) + N(1))), ""))) {
                            this.a = N(this.a) + N(1);
                            this.c = N(this.c) + N(1);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.Temp1 = this.c;
                        if (B((compare(this.Temp1, "5") < 0))) {
                            G.Menu.replace(28, "0");
                        }
                        else {
                            if (B((!B(equals(this.Mouse_wheel, "0"))))) {
                                G.Menu.replace(32, (N(this.Mouse_wheel) * N(25)));
                            }
                            yield* this.CSM_menu("28", G.Menu.item(32), "C", "0");
                            yield* this.CSM_menu("32", "0", "M", "4");
                            if (B((compare("0", G.Menu.item(28)) < 0))) {
                                G.Menu.replace(28, "0");
                            }
                            this.a = (N(-84) - N((N((N(this.Temp1) - N(6))) * N(48))));
                            if (B((compare(G.Menu.item(28), this.a) < 0))) {
                                G.Menu.replace(28, this.a);
                            }
                        }
                        this.a = "102";
                        this.b = G.Menu.item(27);
                        const shopRows = Math.max(0, Math.floor(N(this.c)));
                        for (let r = 0; r < shopRows; r++) {
                            this.a = N(this.a) + N(-48);
                            this.b = N(this.b) + N(1);
                            this.c = (N(this.a) - N(G.Menu.item(28)));
                            if (B((B((compare("-148", this.c) < 0)) && B((compare(this.c, "95") < 0))))) {
                                this.gotoXY(-224, (N(this.c) + N((my - 160))));
                                if (B(equals(G.Menu.item(26), this.b))) {
                                    this.setPenColor("#ff0000");
                                }
                                else {
                                    if (B(G.Got_weapon.contains(G.Shop_menu.item(this.b)))) {
                                        if (B(G.Inventory_2.contains(G.Shop_menu.item(this.b)))) {
                                            this.setPenColor("#00ffff");
                                        }
                                        else {
                                            this.setPenColor("#fff600");
                                        }
                                    }
                                    else {
                                        this.setPenColor("#000000");
                                    }
                                }
                                yield* slotFrame();
                                yield* this.Stamp(this.x, this.y, "77", (S("@") + S(G.Shop_menu.item(this.b))));
                                this.changeXBy(45);
                                this.changeYBy(1);
                                this.setPenColor("#000000");
                                this.setPenSize(40);
                                this.setPenParam(S("transparency"), 100);
                                this.penDown();
                                this.setPenParam(S("transparency"), 10);
                                this.changeXBy(190);
                                this.penUp();
                                if (B((B((B((compare("-226", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "50") < 0)))) && B((compare(mathop("abs", (N(this.y) - N(this.rt.mouse.y))), "20") < 0))))) {
                                    this.Mouse_touch = "Shop weapon";
                                    this.Touch = this.b;
                                }
                                this.changeXBy(-195);
                                this.changeYBy(8);
                                // 価格は Item_list の名前インデックス +3
                                this.c = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(G.Shop_menu.item(this.b)))) + N(3)));
                                if (B(equals(G.Menu.item(19), "6"))) {
                                    if (B((B((compare(this.c, (N(G.Tektite) + N(1))) < 0)) || B(G.Got_weapon.contains(G.Shop_menu.item(this.b)))))) {
                                        this.setEffect("BRIGHTNESS", 100);
                                    }
                                    yield* this.Draw_text((S(G.English_weapon_name.item(G.Weapon_name.itemNum(G.Shop_menu.item(this.b)))) + S((S("`Tektite: ") + S(this.c)))), "60", "L", this.x);
                                }
                                else {
                                    if (B((B((compare(this.c, (N(G.Money) + N(1))) < 0)) || B(G.Got_weapon.contains(G.Shop_menu.item(this.b)))))) {
                                        this.setEffect("BRIGHTNESS", 100);
                                    }
                                    yield* this.Draw_text((S(G.English_weapon_name.item(G.Weapon_name.itemNum(G.Shop_menu.item(this.b)))) + S((S("`Cost: ") + S(this.c)))), "60", "L", this.x);
                                }
                                this.setEffect("BRIGHTNESS", 0);
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B((B((B((compare("-236", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "50") < 0)))) && B((B((compare("70", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "115") < 0))))))) {
                            this.Mouse_touch = "Shop weapon";
                            this.Touch = G.Menu.item(27);
                        }
                        if (B(equals(G.Menu.item(19), "1"))) {
                            yield* this.Stamp("0", (my - 160), "100", "Weapon shop background");
                        }
                        else {
                            if (B(equals(G.Menu.item(19), "2"))) {
                                yield* this.Stamp("0", (my - 160), "100", "Sub weapon shop background");
                            }
                            else {
                                yield* this.Stamp("0", (my - 160), "100", "Cursed shop background");
                            }
                        }
                        yield* this.Stamp("0", (my - 160), "100", (S("*") + S(G.Shop_menu.item(G.Menu.item(26)))));
                        this.gotoXY(220, (my - 318));
                        this.setEffect("BRIGHTNESS", 100);
                        if (B(equals(G.Menu.item(19), "6"))) {
                            yield* this.Draw_text(G.Tektite, "82", "R", "220");
                            this.setEffect("BRIGHTNESS", 0);
                            yield* this.Stamp("165", (my - 318), "70", "Tektite icon");
                        }
                        else {
                            yield* this.Draw_text((S("Money: ") + S(G.Money)), "82", "R", "220");
                        }
                        this.setEffect("BRIGHTNESS", 0);
                        if (B((!B(equals(G.Menu.item(19), "6"))))) {
                            // ページ送り矢印とページドット（"6" の呪い店には無い）
                            this.gotoXY(8, (my - 314));
                            if (B((B((B((compare("-3", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "39") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(154))), "11") < 0))))) {
                                this.Mouse_touch = "Shop page right";
                                this.setPenColor("#9a9a9a");
                            }
                            else {
                                this.setPenColor("#737373");
                            }
                            this.setPenSize(22);
                            this.penDown();
                            this.changeXBy(20);
                            this.penUp();
                            this.changeXBy(-13);
                            this.setPenColor("#ffffff");
                            this.setPenSize(4);
                            this.penDown();
                            this.changeYBy(5);
                            this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                            this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                            this.changeYBy(5);
                            this.changeXBy(4.5);
                            this.penUp();
                            this.gotoXY(-210, (my - 314));
                            if (B((B((B((compare("-221", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-179") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(154))), "11") < 0))))) {
                                this.Mouse_touch = "Shop page left";
                                this.setPenColor("#9a9a9a");
                            }
                            else {
                                this.setPenColor("#737373");
                            }
                            this.setPenSize(22);
                            this.penDown();
                            this.changeXBy(20);
                            this.penUp();
                            this.changeXBy(-6);
                            this.setPenColor("#ffffff");
                            this.setPenSize(4);
                            this.penDown();
                            this.changeYBy(5);
                            this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                            this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                            this.changeYBy(5);
                            this.changeXBy(-4.5);
                            this.penUp();
                            if (B(equals(G.Menu.item(19), "1"))) {
                                this.a = G.Menu.item(29);
                            }
                            else {
                                this.a = G.Menu.item(30);
                            }
                            this.gotoXY((N(-91) - N((N((N(this.a) - N(1))) * N(7.5)))), (my - 314));
                            this.setPenColor("#5a5a5a");
                            this.setPenSize(10);
                            this.b = "0";
                            const pageDots = Math.max(0, Math.floor(N(this.a)));
                            for (let r = 0; r < pageDots; r++) {
                                this.b = N(this.b) + N(1);
                                if (B((compare(this.distanceToMouse(), "5") < 0))) {
                                    this.Mouse_touch = "Shop page button";
                                    this.Touch = this.b;
                                }
                                this.penDown();
                                this.penUp();
                                this.changeXBy(15);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            // 現在ページのスライダーは CSM_menu の "M"（割合接近）で滑らかに動く
                            this.setPenColor("#9a9a9a");
                            this.setX((N((N(-91) - N((N((N(this.a) - N(1))) * N(7.5))))) + N((N((N(G.Menu.item(25)) - N(1))) * N(15)))));
                            this.penDown();
                            yield* this.CSM_menu("31", this.x, "M", "4");
                            this.setX(G.Menu.item(31));
                            this.penUp();
                        }
                        // スクロールバー（x=63）
                        this.setPenColor("#9a9a9a");
                        this.setPenSize(8);
                        this.gotoXY(63, (my - 62));
                        if (B((compare(this.Temp1, "5") < 0))) {
                            this.penDown();
                            this.changeYBy(-260);
                            G.Menu.replace(28, "0");
                        }
                        else {
                            this.changeYBy((N(G.Menu.item(28)) / N(4)));
                            this.a = (N(-260) + N((N((N(-84) - N((N((N(this.Temp1) - N(6))) * N(48))))) / N(-4))));
                            if (B((B((compare(mathop("abs", (N(this.rt.mouse.x) - N(63))), "5") < 0)) && B((B((compare((N((N(this.y) + N(this.a))) - N(5)), this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, (N(this.y) + N(5))) < 0))))))) {
                                this.Mouse_touch = "Shop scroll bar";
                            }
                            this.penDown();
                            this.changeYBy(this.a);
                        }
                        this.penUp();
                        // 購入パネル: 先頭行以外を選択しているときだけ出る
                        this.gotoXY(95, (my - 267));
                        if (B((!B(equals(G.Menu.item(26), G.Menu.item(27)))))) {
                            this.a = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(G.Shop_menu.item(G.Menu.item(26))))) + N(3)));
                            this.b = (N(G.Got_weapon.contains(G.Shop_menu.item(G.Menu.item(26)))) - N(0));
                            if (B((B((B((compare("85", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "168") < 0)))) && B((B((compare("-132", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "-97") < 0))))))) {
                                if (B(equals(this.b, "0"))) {
                                    this.Mouse_touch = "Shop buy";
                                    this.Touch = this.a;
                                }
                                else {
                                    this.Mouse_touch = "Shop set";
                                }
                                this.setPenColor("#9a9a9a");
                            }
                            else {
                                this.setPenColor("#737373");
                            }
                            this.setPenSize(20);
                            this.penDown();
                            this.changeXBy(63);
                            this.changeYBy(-15);
                            this.changeXBy(-63);
                            this.changeYBy(15);
                            this.penUp();
                            this.gotoXY(126.5, (my - 274.5));
                            if (B(equals(G.Menu.item(19), "6"))) {
                                if (B((B((compare(this.a, (N(G.Tektite) + N(1))) < 0)) || B(G.Got_weapon.contains(G.Shop_menu.item(G.Menu.item(26))))))) {
                                    this.setEffect("BRIGHTNESS", 100);
                                }
                            }
                            else {
                                if (B((B((compare(this.a, (N(G.Money) + N(1))) < 0)) || B(G.Got_weapon.contains(G.Shop_menu.item(G.Menu.item(26))))))) {
                                    this.setEffect("BRIGHTNESS", 100);
                                }
                            }
                            if (B(equals(this.b, "0"))) {
                                yield* this.Draw_text("Buy", "95", "C", this.x);
                            }
                            else {
                                if (B(G.Inventory_2.contains(G.Shop_menu.item(G.Menu.item(26))))) {
                                    yield* this.Draw_text((S("Remove (") + S((S((N((N((N(G.Inventory_2.itemNum(G.Shop_menu.item(G.Menu.item(26)))) - N(1))) / N(6))) + N(1))) + S(")")))), "50", "C", this.x);
                                }
                                else {
                                    this.a = (N((N((N(G.Inventory_2.itemNum("")) - N(1))) / N(6))) + N(1));
                                    if (B(G.Inventory_2.contains(""))) {
                                        yield* this.Draw_text((S("Set (") + S((S(this.a) + S(")")))), "70", "C", this.x);
                                    }
                                    else {
                                        yield* this.Draw_text("Full", "90", "C", this.x);
                                    }
                                }
                            }
                            this.setEffect("BRIGHTNESS", 0);
                        }
                    }
                    if (B(equals(G.Menu.item(19), "3"))) {
                        // キャラ選択: Character_tree は 10 件組レコード
                        // [+1]=名前 [+2,+3]=ツリー座標 [+5]=現在値 [+6]=上限 [+7]=親ノード。
                        // Menu[25] がページ（1=ツリー、2=ステータス）
                        this.gotoXY(110, (my - 317));
                        if (B((B((B((compare("99", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "225") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(157))), "11") < 0))))) {
                            this.Mouse_touch = "Character change page";
                            this.setPenColor("#9a9a9a");
                        }
                        else {
                            this.setPenColor("#737373");
                        }
                        this.setPenSize(22);
                        this.penDown();
                        this.changeXBy(104);
                        this.penUp();
                        this.changeXBy(-104);
                        // 進捗バー共通の前計算: a=バー長（満タン 280）、c=表示文字列、d=上限到達の近さ
                        this.a = G.Character_tree.item((N(G.Tree) + N(5)));
                        this.b = G.Character_tree.item((N(G.Tree) + N(6)));
                        this.d = "0";
                        if (B(equals(this.a, this.b))) {
                            this.c = "Max";
                            this.a = "280";
                        }
                        else {
                            if (B((compare(this.b, (N(this.a) / N(10))) < 0))) {
                                this.a = (N(this.a) / N(10));
                                this.d = "1";
                            }
                            this.c = (S(mathop("floor", this.b)) + S((S("/") + S(Math.round(N(this.a))))));
                            this.a = (N(280) / N((N(this.a) / N(this.b))));
                        }
                        if (B(equals(G.Menu.item(25), "1"))) {
                            // ツリー面: 進捗バー、接続線、ノード
                            this.gotoXY(-205, (my - 313));
                            if (B(equals(this.d, "1"))) {
                                this.setPenColor("#424242");
                            }
                            else {
                                this.setPenColor("#423200");
                            }
                            this.setPenSize(25);
                            this.penDown();
                            this.changeXBy(280);
                            this.penUp();
                            this.changeXBy(-280);
                            this.setPenColor("#828282");
                            this.setPenSize(13);
                            this.penDown();
                            this.changeXBy(280);
                            this.penUp();
                            this.changeXBy(-280);
                            this.setPenColor("#e8aa00");
                            this.penDown();
                            this.changeXBy(this.a);
                            this.penUp();
                            this.changeXBy((N(0) - N(this.a)));
                            this.setEffect("BRIGHTNESS", 100);
                            yield* this.Draw_text(this.c, "100", "L", "-205");
                            this.setEffect("BRIGHTNESS", 0);
                            this.gotoXY(-220, (my - 60));
                            this.setPenColor("#0a4000");
                            this.setPenSize(31);
                            this.penDown();
                            for (let i = 0; i < 7; i++) {
                                this.changeYBy(-30);
                                this.changeXBy(440);
                                this.changeXBy(-440);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.penUp();
                            if (B((B((compare(mathop("abs", this.rt.mouse.x), "204") < 0)) && B((B((compare("-108", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "85") < 0))))))) {
                                this.Mouse_touch = "Character display";
                            }
                            // 接続線: ノードから親ノードへ 11 点の補間線。
                            // 解放条件は「親の現在値/10 < 親の上限+1」
                            this.setPenSize(12);
                            this.a = "0";
                            const linkCount = Math.max(0, Math.floor(N((N((N(G.Character_tree.length) / N(10))) - N(1)))));
                            for (let r = 0; r < linkCount; r++) {
                                this.a = N(this.a) + N(10);
                                if (B((!B((B(equals(G.Character_tree.item((N(this.a) + N(1))), "-")) || B(equals(letterOf(G.Character_tree.item((N(this.a) + N(7))), 1), "m"))))))) {
                                    this.d = G.Character_tree.item((N(this.a) + N(7)));
                                    if (B(equals((N((compare((N(G.Character_tree.item((N(this.d) + N(5)))) / N(10)), (N(G.Character_tree.item((N(this.d) + N(6)))) + N(1))) < 0)) - N(0)), "1"))) {
                                        this.setPenColor("#0e6700");
                                    }
                                    else {
                                        this.setPenColor("#031b00");
                                    }
                                    this.IDX = (N(G.Character_tree.item((N(this.a) + N(2)))) - N(G.Menu.item(27)));
                                    this.IDY = (N(G.Character_tree.item((N(this.a) + N(3)))) - N(G.Menu.item(31)));
                                    this.b = (N(G.Character_tree.item((N(this.d) + N(2)))) - N(G.Menu.item(27)));
                                    this.c = (N(G.Character_tree.item((N(this.d) + N(3)))) - N(G.Menu.item(31)));
                                    this.d = (my - 173);
                                    this.e = "0";
                                    for (let k = 0; k < 11; k++) {
                                        this.f = (N((N((N(this.IDX) * N(this.e))) + N((N(this.b) * N((N(10) - N(this.e))))))) / N(10));
                                        this.g = (N((N((N(this.IDY) * N(this.e))) + N((N(this.c) * N((N(10) - N(this.e))))))) / N(10));
                                        if (B((B((compare(mathop("abs", this.f), "220") < 0)) && B((compare(mathop("abs", this.g), "112") < 0))))) {
                                            this.gotoXY(this.f, (N(this.g) + N(this.d)));
                                            this.penDown();
                                        }
                                        else {
                                            this.penUp();
                                        }
                                        this.e = N(this.e) + N(1);
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                    this.penUp();
                                }
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            // ノード: 色は 状態（解放済み/選択中/到達可能/ロック）で決まる。
                            // d は到達可能フラグ（"m" 始まりの親は月替わり/所持条件の特殊判定）
                            this.a = "0";
                            const nodeCount = Math.max(0, Math.floor(N((N(G.Character_tree.length) / N(10)))));
                            for (let r = 0; r < nodeCount; r++) {
                                if (B((!B(equals(G.Character_tree.item((N(this.a) + N(1))), "-"))))) {
                                    this.IDX = (N(G.Character_tree.item((N(this.a) + N(2)))) - N(G.Menu.item(27)));
                                    this.IDY = (N(G.Character_tree.item((N(this.a) + N(3)))) - N(G.Menu.item(31)));
                                    if (B((B((compare(mathop("abs", this.IDX), "220") < 0)) && B((compare(mathop("abs", this.IDY), "112") < 0))))) {
                                        this.gotoXY(this.IDX, (N(this.IDY) + N((my - 173))));
                                        this.IDX = (N(220) - N(mathop("abs", this.IDX)));
                                        this.IDY = (N(112) - N(mathop("abs", this.IDY)));
                                        if (B((B((compare(this.IDX, "10") < 0)) || B((compare(this.IDY, "10") < 0))))) {
                                            if (B((compare(this.IDX, this.IDY) < 0))) {
                                                this.b = (N(30) + N(this.IDX));
                                            }
                                            else {
                                                this.b = (N(30) + N(this.IDY));
                                            }
                                        }
                                        else {
                                            this.b = "40";
                                        }
                                        if (B(equals(this.a, "0"))) {
                                            this.d = "1";
                                        }
                                        else {
                                            this.d = G.Character_tree.item((N(this.a) + N(7)));
                                            if (B(equals(letterOf(this.d, 1), "m"))) {
                                                if (B(equals((S(letterOf(this.d, 2)) + S(letterOf(this.d, 3))), this.rt.current("MONTH")))) {
                                                    this.d = "1";
                                                }
                                                else {
                                                    if (B((compare("1", G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.ID))) + N(42)))) < 0))) {
                                                        this.d = "1";
                                                    }
                                                    else {
                                                        this.d = "0";
                                                    }
                                                }
                                            }
                                            else {
                                                this.d = (N((compare((N(G.Character_tree.item((N(this.d) + N(5)))) / N(10)), (N(G.Character_tree.item((N(this.d) + N(6)))) + N(1))) < 0)) - N(0));
                                            }
                                        }
                                        if (B(equals(G.Character_tree.item((N(this.a) + N(5))), G.Character_tree.item((N(this.a) + N(6)))))) {
                                            if (B(equals((N(this.a) / N(10)), (N(G.Character) / N(15))))) {
                                                this.setPenColor("#fff600");
                                            }
                                            else {
                                                this.setPenColor("#676300");
                                                if (B((compare(this.distanceToMouse(), "20") < 0))) {
                                                    this.Mouse_touch = "Character set";
                                                    this.Touch = this.a;
                                                }
                                            }
                                        }
                                        else {
                                            if (B(equals((N(this.a) / N(10)), (N(G.Character) / N(15))))) {
                                                this.setPenColor("#27ff00");
                                            }
                                            else {
                                                if (B(equals(this.d, "1"))) {
                                                    this.setPenColor("#0e6700");
                                                    if (B((compare(this.distanceToMouse(), "20") < 0))) {
                                                        this.Mouse_touch = "Character set";
                                                        this.Touch = this.a;
                                                    }
                                                }
                                                else {
                                                    this.setPenColor("#031b00");
                                                }
                                            }
                                        }
                                        this.setPenSize(this.b);
                                        this.penDown();
                                        this.penUp();
                                        this.setPenColor("#333333");
                                        this.setPenSize((N(this.b) * N(0.7)));
                                        this.penDown();
                                        this.penUp();
                                        this.c = (N(this.b) / N(50));
                                        if (B(equals(this.d, "0"))) {
                                            this.setEffect("BRIGHTNESS", -100);
                                        }
                                        this.d = G.Character_tree.item((N(this.a) + N(1)));
                                        this.pointInDirection(0);
                                        yield* this.Stamp(this.x, this.y, (N(this.b) * N(1.5)), (S(this.d) + S(" body")));
                                        this.pointInDirection(30);
                                        yield* this.Stamp((N(this.x) + N((N(19) * N(this.c)))), (N(this.y) + N((N(10) * N(this.c)))), (N(this.b) * N(1.5)), (S(this.d) + S(" hand")));
                                        this.pointInDirection(-30);
                                        yield* this.Stamp((N(this.x) - N((N(38) * N(this.c)))), this.y, (N(this.b) * N(1.5)), (S(this.d) + S(" hand")));
                                        this.pointInDirection(90);
                                        this.setEffect("BRIGHTNESS", 0);
                                    }
                                }
                                this.a = N(this.a) + N(10);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.gotoXY(-220, (my - 60));
                            this.setPenColor("#5a5a5a");
                            this.setPenSize(31);
                            this.penDown();
                            this.changeXBy(440);
                            this.changeYBy(-225);
                            this.changeXBy(-440);
                            this.changeYBy(225);
                            this.penUp();
                            this.setEffect("BRIGHTNESS", 100);
                            this.gotoXY(162, (my - 317));
                            yield* this.Draw_text("Status", "85", "C", "162");
                            this.gotoXY(-227, (my - 60));
                            yield* this.Draw_text("Drag to scroll", "95", "L", "-227");
                            this.gotoXY(-215, (my - 285));
                            yield* this.Draw_text((S("Mission [") + S((S(G.Character_tree.item((N((N((N(G.Character) / N(15))) * N(10))) + N(4)))) + S("]")))), "95", "L", "-215");
                            this.setEffect("BRIGHTNESS", 0);
                        }
                        if (B(equals(G.Menu.item(25), "2"))) {
                            // ステータス面: 進捗バー（幅 168 に換算）、特殊スキン切替、
                            // キャラ立ち絵とスキル玉、6 本のステータスバー
                            this.gotoXY(-220, (my - 317));
                            if (B(equals(this.d, "1"))) {
                                this.setPenColor("#424242");
                            }
                            else {
                                this.setPenColor("#423200");
                            }
                            this.setPenSize(22);
                            this.penDown();
                            this.changeXBy(168);
                            this.penUp();
                            this.changeXBy(-168);
                            this.setPenColor("#828282");
                            this.setPenSize(11);
                            this.penDown();
                            this.changeXBy(168);
                            this.penUp();
                            this.changeXBy(-168);
                            this.setPenColor("#e8aa00");
                            this.penDown();
                            this.changeXBy((N(this.a) / N((N(280) / N(168)))));
                            this.penUp();
                            this.changeXBy((N((N(0) - N(this.a))) / N((N(280) / N(168)))));
                            this.setEffect("BRIGHTNESS", 100);
                            yield* this.Draw_text(this.c, "100", "L", "-205");
                            this.setEffect("BRIGHTNESS", 0);
                            this.gotoXY(-21, (my - 317));
                            if (B(equals(G.Character_tree.item((N(G.Tree) + N(5))), G.Character_tree.item((N(G.Tree) + N(6)))))) {
                                if (B((B((B((compare("-32", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "94") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(157))), "11") < 0))))) {
                                    this.Mouse_touch = "Character special skin";
                                    this.setPenColor("#9a9a9a");
                                }
                                else {
                                    this.setPenColor("#737373");
                                }
                            }
                            else {
                                this.setPenColor("#736f00");
                            }
                            this.setPenSize(22);
                            this.penDown();
                            this.changeXBy(104);
                            this.penUp();
                            this.gotoXY(-65, (my - 296));
                            this.setPenColor("#333333");
                            this.setPenSize(5);
                            this.penDown();
                            this.changeYBy(125);
                            this.penUp();
                            // 装飾の虹ライン
                            this.gotoXY(-54, (my - 168));
                            this.setPenColor("#000000");
                            this.setPenParam(S("transparency"), 100);
                            this.setPenSize(6);
                            this.penDown();
                            this.setPenParam(S("transparency"), 50);
                            this.changeXBy(40);
                            this.changeYBy(-40);
                            this.changeXBy(-40);
                            this.changeYBy(40);
                            this.penUp();
                            this.changeXBy(4);
                            this.changeYBy(-36);
                            this.setPenColor("#1d00ff");
                            this.setPenParam(S("saturation"), (N(80) + N((N(mathop("sin", (N(this.rt.timer()) * N(250)))) * N(20)))));
                            this.setPenSize(3);
                            for (let i = 0; i < 18; i++) {
                                this.penDown();
                                this.changeXBy(31);
                                this.penUp();
                                this.changeXBy(-31);
                                this.changeYBy(1.84);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.changeXBy(16);
                            this.changeYBy(-17.6);
                            this.pointInDirection(90);
                            this.a = G.Character_2.item((N(G.Character) + N(2)));
                            this.switchCostume((S("@") + S(this.a)));
                            this.size = N(85);
                            this.stamp();
                            yield* this.Pen_mode();
                            this.changeYBy(-20);
                            // スキル玉（Skill_2[Skill+3] 個）
                            this.b = G.Skill_2.item((N(G.Skill) + N(3)));
                            if (B((compare("1", this.b) < 0))) {
                                this.changeXBy((N((N(this.b) - N(1))) * N(-6)));
                                const orbs = Math.max(0, Math.floor(N(this.b)));
                                for (let r = 0; r < orbs; r++) {
                                    this.setPenColor("#00ffff");
                                    this.setPenSize(10);
                                    this.penDown();
                                    this.penUp();
                                    this.changeXBy(12);
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                this.changeXBy((N((N((N(this.b) - N(1))) * N(-6))) - N(12)));
                            }
                            yield* this.Stamp("0", (my - 160), "100", (S("*") + S(this.a)));
                            yield* this.Stamp("0", (my - 102), "100.2", (S(G.Character_name) + S(" banner")));
                            yield* this.Stamp("-180", (my - 233), "85", "Status background");
                            this.gotoXY(-232, (my - 164));
                            this.setEffect("BRIGHTNESS", 100);
                            this.setPenSize(4);
                            this.setPenColor("#ff0000");
                            yield* this.Draw_character_status_bar(G.Character_2.item((N(G.Character) + N(3))), this.Character_status.item(1), this.Character_status.item(2), "1");
                            this.setPenColor("#2aff00");
                            yield* this.Draw_character_status_bar(G.Character_2.item((N(G.Character) + N(4))), this.Character_status.item(3), this.Character_status.item(4), "150");
                            this.setPenColor("#00ffff");
                            yield* this.Draw_character_status_bar(G.Character_2.item((N(G.Character) + N(5))), this.Character_status.item(5), this.Character_status.item(6), "5");
                            this.setPenColor("#ff00dc");
                            yield* this.Draw_character_status_bar((N(1) - N(G.Character_2.item((N(G.Character) + N(6))))), (N(1) - N(this.Character_status.item(8))), (N(1) - N(this.Character_status.item(7))), "0");
                            this.setPenColor("#ff6e00");
                            yield* this.Draw_character_status_bar(G.Character_2.item((N(G.Character) + N(7))), this.Character_status.item(9), this.Character_status.item(10), "600");
                            this.setPenColor("#00ff6a");
                            yield* this.Draw_character_status_bar((N(0) - N(G.Character_2.item((N(G.Character) + N(8))))), (N(0) - N(this.Character_status.item(12))), (N(0) - N(this.Character_status.item(11))), "1");
                            this.gotoXY(162, (my - 317));
                            yield* this.Draw_text("Tree", "85", "C", "162");
                            this.gotoXY(31, (my - 317));
                            if (B(equals(G.Special_skin, "1"))) {
                                yield* this.Draw_text("Skin: ON", "75", "C", "31");
                            }
                            else {
                                yield* this.Draw_text("Skin: OFF", "75", "C", "31");
                            }
                            this.setEffect("BRIGHTNESS", 0);
                            yield* this.Stamp("-180", (my - 233), "85", "Status frame");
                        }
                        if (B((compare("0", G.Menu.item(76)) < 0))) {
                            // キャラ説明オーバーレイ（Menu[76] がページ番号、開くほど透明に）
                            this.setEffect("GHOST", (N(100) - N((N(100) / N((N(360) / N((N(520) - N(menu)))))))));
                            this.pointInDirection(90);
                            if (B(equals(G.Language, "1"))) {
                                yield* this.Stamp("0", (my - 160), "100", (S("キャラUI説明") + S(G.Menu.item(76))));
                            }
                            else {
                                yield* this.Stamp("0", (my - 160), "100", (S("Character info") + S(G.Menu.item(76))));
                            }
                            this.setEffect("GHOST", 0);
                            this.Mouse_touch = "Character info";
                        }
                    }
                }
            }
            if (B(equals(UI_name, "Team"))) {
                // チーム管理（TEAMMODE 中は出ない）。Team リストは 5 件組×5:
                // [見出し "2"+リーダーID, メンバー×4]。Menu[40] が "0" なら一覧、
                // それ以外はそのチーム（または新規作成）の詳細
                if (B(equals(G.TEAMMODE, "0"))) {
                    yield* panelFill("#00064d");
                    panelBorder();
                    if (B(equals(G.Menu.item(40), "0"))) {
                        // 一覧: 5 行のバーとチーム名
                        this.gotoXY(-173, (my - 45));
                        this.setPenColor("#333333");
                        this.setPenSize(46);
                        this.penDown();
                        this.changeXBy(173);
                        this.penUp();
                        this.gotoXY(-177, (my - 50));
                        this.setPenSize(36);
                        this.a = "1";
                        for (let r = 0; r < 5; r++) {
                            this.changeYBy(-45);
                            this.setX(-177);
                            if (B((B((compare(mathop("abs", this.rt.mouse.x), "195") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "18") < 0))))) {
                                this.setPenColor("#b3b3b3");
                                if (B(equals(letterOf(G.Team.item(this.a), 1), "2"))) {
                                    this.Mouse_touch = "About team";
                                    this.Touch = (N(G.Team.item(this.a)) - N(20000));
                                    const pad = Math.max(0, Math.floor(N((N(4) - N(S(this.Touch).length)))));
                                    for (let k = 0; k < pad; k++) {
                                        this.Touch = (S("0") + S(this.Touch));
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                }
                                else {
                                    if (B((B(equals(G.Team_color, "0")) && B((compare(G.Team.length, "25") < 0))))) {
                                        this.Mouse_touch = "New team";
                                    }
                                }
                            }
                            else {
                                this.setPenColor("#4d4d4d");
                            }
                            this.penDown();
                            this.changeXBy(354);
                            this.penUp();
                            this.a = N(this.a) + N(5);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.setEffect("BRIGHTNESS", 100);
                        this.gotoXY(-180, (my - 45));
                        yield* this.Draw_text("Team", "150", "L", "-180");
                        this.setEffect("BRIGHTNESS", 0);
                        this.a = "1";
                        this.b = (my - 95);
                        for (let r = 0; r < 5; r++) {
                            if (B(equals(letterOf(G.Team.item(this.a), 1), "2"))) {
                                this.c = G.ID_num.item(G.IDs.itemNum((N(G.Team.item(this.a)) - N(20000))));
                                this.gotoXY(-185, this.b);
                                this.setEffect("COLOR", (N(G.Team_color_2.item(G.CLOUD.item((N(this.c) + N(27))))) * N(2)));
                                this.d = G.CLOUD.item((N(this.c) + N((N(G.Number_of_data) - N(1)))));
                                if (B((compare("10", S(this.d).length) < 0))) {
                                    yield* this.Draw_text(this.d, (N(115) - N((N((N(S(this.d).length) - N(10))) * N(5.3)))), "L", "-185");
                                }
                                else {
                                    yield* this.Draw_text(this.d, "115", "L", "-185");
                                }
                                this.setEffect("COLOR", 0);
                                this.gotoXY(185, (N(this.b) - N(4)));
                                this.setEffect("BRIGHTNESS", 100);
                                if (B(equals(mod(G.CLOUD.item((N(this.c) + N(28))), 2), "0"))) {
                                    yield* this.Draw_text("Free", "66", "R", "185");
                                }
                                else {
                                    yield* this.Draw_text("Privete", "66", "R", "185");
                                }
                                this.setEffect("BRIGHTNESS", 0);
                            }
                            else {
                                this.setEffect("BRIGHTNESS", 100);
                                this.gotoXY(-185, this.b);
                                yield* this.Draw_text("New team+", "115", "L", "-185");
                                this.setEffect("BRIGHTNESS", 0);
                            }
                            this.a = N(this.a) + N(5);
                            this.b = N(this.b) + N(-45);
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    if (B((compare("0", G.Menu.item(40)) < 0))) {
                        // 詳細: Temp1 = 対象リーダーのレコード位置。
                        // スキル/タイプの値 a の出所は、自分のチームなら Team_menu、
                        // 新規（Menu[40] < 9）なら Menu[42]、他人のチームなら field 28
                        this.Temp1 = G.ID_num.item(G.IDs.itemNum(G.Menu.item(40)));
                        this.setPenColor("#676767");
                        this.setPenSize(45);
                        this.gotoXY(-173, (my - 45));
                        this.penDown();
                        this.setX(100);
                        this.penUp();
                        this.gotoXY(-185, (my - 45));
                        if (B(equals(S(G.Menu.item(40)).length, "4"))) {
                            this.setEffect("COLOR", (N(G.Team_color_2.item(G.CLOUD.item((N(this.Temp1) + N(27))))) * N(2)));
                            this.a = G.CLOUD.item((N(this.Temp1) + N((N(G.Number_of_data) - N(1)))));
                            if (B((compare("8", S(this.a).length) < 0))) {
                                yield* this.Draw_text(this.a, (N(140) - N((N((N(S(this.a).length) - N(8))) * N(6.5)))), "L", "-185");
                            }
                            else {
                                yield* this.Draw_text(this.a, "140", "L", "-185");
                            }
                            this.setEffect("COLOR", 0);
                            this.setEffect("BRIGHTNESS", 100);
                        }
                        else {
                            this.setEffect("BRIGHTNESS", 100);
                            yield* this.Draw_text("New team", "140", "L", "-185");
                        }
                        this.setPenColor("#4d4d4d");
                        this.setPenSize(20);
                        this.gotoXY(-188, (my - 88));
                        this.penDown();
                        this.setX(188);
                        this.setY((my - 286));
                        this.setX(-188);
                        this.setY((my - 88));
                        this.penUp();
                        this.gotoXY(-178, (my - 117));
                        this.setPenSize(40);
                        this.penDown();
                        for (let i = 0; i < 2; i++) {
                            this.changeXBy(356);
                            this.changeYBy(-38);
                            this.changeXBy(-356);
                            this.changeYBy(-38);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.changeXBy(356);
                        this.penUp();
                        this.setPenColor("#333333");
                        this.setPenSize(5);
                        this.gotoXY(60, (my - 89));
                        this.penDown();
                        this.setY((my - 230));
                        this.penUp();
                        this.gotoXY(70, (my - 96));
                        yield* this.Draw_text("Team skill", "80", "L", "70");
                        this.changeYBy(-66);
                        yield* this.Draw_text("Team type", "80", "L", "70");
                        if (B(equals(G.ID, G.Menu.item(40)))) {
                            this.a = G.Team_menu;
                        }
                        else {
                            if (B((compare(G.Menu.item(40), "9") < 0))) {
                                this.a = G.Menu.item(42);
                            }
                            else {
                                this.a = G.CLOUD.item((N(this.Temp1) + N(28)));
                            }
                        }
                        // スキル ON/OFF ボタン（a < 2 が OFF）。操作できるのは自チームか新規だけ
                        this.gotoXY(125, (my - 122));
                        if (B((B((compare(G.Menu.item(40), "9") < 0)) || B(equals(G.ID, G.Menu.item(40)))))) {
                            if (B((compare(this.a, "2") < 0))) {
                                if (B((B((B((compare("68.5", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "137.5") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "12.5") < 0))))) {
                                    this.setPenColor("#820000");
                                    this.Mouse_touch = "Turn on team skill";
                                    this.Touch = (N(equals(G.ID, G.Menu.item(40))) - N(0));
                                }
                                else {
                                    this.setPenColor("#330000");
                                }
                            }
                            else {
                                if (B((B((B((compare("68.5", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "137.5") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "12.5") < 0))))) {
                                    this.setPenColor("#158200");
                                    this.Mouse_touch = "Turn off team skill";
                                    this.Touch = (N(equals(G.ID, G.Menu.item(40))) - N(0));
                                }
                                else {
                                    this.setPenColor("#083300");
                                }
                            }
                        }
                        else {
                            this.setPenColor("#4e4a00");
                        }
                        this.setPenSize(25);
                        this.penDown();
                        this.setX(81);
                        this.penUp();
                        this.setX(103);
                        if (B((compare(this.a, "2") < 0))) {
                            yield* this.Draw_text("OFF", "80", "C", "103");
                        }
                        else {
                            yield* this.Draw_text("ON", "80", "C", "103");
                        }
                        // タイプ切替ボタン（a の偶奇が Free / Private）
                        this.gotoXY(160, (my - 188));
                        if (B((B((compare(G.Menu.item(40), "9") < 0)) || B(equals(G.ID, G.Menu.item(40)))))) {
                            if (B((B((B((compare("68.5", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "172.5") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "12.5") < 0))))) {
                                this.setPenColor("#b3b3b3");
                                this.Mouse_touch = "Change team type";
                                this.Touch = (N(equals(G.ID, G.Menu.item(40))) - N(0));
                            }
                            else {
                                this.setPenColor("#333333");
                            }
                        }
                        else {
                            this.setPenColor("#4e4a00");
                        }
                        this.penDown();
                        this.setX(81);
                        this.penUp();
                        this.setX(120);
                        if (B(equals(mod(this.a, 2), "0"))) {
                            yield* this.Draw_text("Free", "80", "C", "120");
                        }
                        else {
                            yield* this.Draw_text("Private", "80", "C", "120");
                        }
                        // 戻るボタン
                        this.setPenSize(46);
                        this.gotoXY(-165, (my - 265));
                        if (B((B((B((compare("-188", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-72") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "23") < 0))))) {
                            this.setPenColor("#b3b3b3");
                            this.Mouse_touch = "Back team";
                        }
                        else {
                            this.setPenColor("#333333");
                        }
                        this.penDown();
                        this.setX(-95);
                        this.penUp();
                        if (B(equals(S(G.Menu.item(40)).length, "4"))) {
                            // メンバー名簿 c（"`" 区切り、13 文字超は省略）と主ボタンの状態
                            this.a = G.Team.itemNum((S("2") + S(G.Menu.item(40))));
                            this.b = "1";
                            this.d = G.CLOUD.item((N(this.Temp1) + N((N(G.Number_of_data) - N(1)))));
                            if (B((compare("13", S(this.d).length) < 0))) {
                                this.e = "0";
                                this.f = "";
                                for (let k = 0; k < 12; k++) {
                                    this.e = N(this.e) + N(1);
                                    this.f = (S(this.f) + S(letterOf(this.d, this.e)));
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                this.d = (S(this.f) + S("..."));
                            }
                            this.c = (S(this.d) + S("`"));
                            if (B(equals(this.a, "0"))) {
                                G.Menu.replace(40, "0");
                            }
                            for (let r = 0; r < 4; r++) {
                                this.a = N(this.a) + N(1);
                                if (B((!B(equals(G.Team.item(this.a), ""))))) {
                                    this.b = N(this.b) + N(1);
                                    this.d = G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Team.item(this.a)))) + N((N(G.Number_of_data) - N(1)))));
                                    if (B((compare("13", S(this.d).length) < 0))) {
                                        this.e = "0";
                                        this.f = "";
                                        for (let k = 0; k < 12; k++) {
                                            this.e = N(this.e) + N(1);
                                            this.f = (S(this.f) + S(letterOf(this.d, this.e)));
                                            if (!this.rt.warpActive)
                                                yield;
                                        }
                                        this.d = (S(this.f) + S("..."));
                                    }
                                    this.c = (S(this.c) + S((S(this.d) + S("`"))));
                                }
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            if (B(equals(G.Team_ID, G.Menu.item(40)))) {
                                if (B((B((B((compare("-64", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "188") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "23") < 0))))) {
                                    this.setPenColor("#800000");
                                    this.Mouse_touch = "Leave team";
                                }
                                else {
                                    this.setPenColor("#330000");
                                }
                            }
                            else {
                                if (B((compare("4", this.b) < 0))) {
                                    this.setPenColor("#330000");
                                }
                                else {
                                    if (B((B((!B(equals(G.Team_color, "0")))) || B(equals(mod(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Menu.item(40)))) + N(28))), 2), "1"))))) {
                                        this.setPenColor("#4c4e00");
                                    }
                                    else {
                                        if (B((B((B((compare("-64", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "188") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "23") < 0))))) {
                                            this.setPenColor("#178000");
                                            this.Mouse_touch = "Join team";
                                            this.Touch = this.Temp1;
                                        }
                                        else {
                                            this.setPenColor("#0a3300");
                                        }
                                    }
                                }
                            }
                        }
                        else {
                            if (B((B((B((compare("-64", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "188") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "23") < 0))))) {
                                this.setPenColor("#178000");
                                if (B((compare(G.Team.length, "25") < 0))) {
                                    this.Mouse_touch = "Make team";
                                }
                            }
                            else {
                                this.setPenColor("#0a3300");
                            }
                        }
                        this.setX(-41);
                        this.penDown();
                        this.setX(165);
                        this.penUp();
                        this.gotoXY(-130, (my - 265));
                        yield* this.Draw_text("Back", "110", "C", "-130");
                        if (B(equals(S(G.Menu.item(40)).length, "4"))) {
                            this.gotoXY(62, (my - 265));
                            if (B(equals(G.Team_ID, G.Menu.item(40)))) {
                                if (B(equals(G.ID, G.Menu.item(40)))) {
                                    yield* this.Draw_text("Delete", "130", "C", "62");
                                }
                                else {
                                    yield* this.Draw_text("Leave", "130", "C", "62");
                                }
                            }
                            else {
                                if (B(equals(mod(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Menu.item(40)))) + N(28))), 2), "1"))) {
                                    yield* this.Draw_text("Private", "130", "C", "62");
                                }
                                else {
                                    if (B((compare("4", this.b) < 0))) {
                                        yield* this.Draw_text("Full", "130", "C", "62");
                                    }
                                    else {
                                        yield* this.Draw_text((S("Join(") + S((S(this.b) + S("/5)")))), "130", "C", "62");
                                    }
                                }
                            }
                            this.gotoXY(-185, (my - 100));
                            yield* this.Draw_text("Member", "130", "L", "-185");
                            this.gotoXY(-185, (my - 132));
                            yield* this.Draw_text(this.c, "75", "L", "-185");
                        }
                        else {
                            // 新規作成: 主ボタンは Make、下段はチームカラーの選択グリッド（3×3）。
                            // 使用中カラーは Temp1_2 に印を付け、選べない＆暗くする
                            this.gotoXY(62, (my - 265));
                            yield* this.Draw_text("Make", "130", "C", "62");
                            this.gotoXY(-185, (my - 100));
                            yield* this.Draw_text("Team color", "130", "L", "-185");
                            this.Temp1_2.deleteAll();
                            for (let i = 0; i < 8; i++) {
                                this.Temp1_2.add("0");
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.a = "1";
                            for (let r = 0; r < 5; r++) {
                                if (B(equals(letterOf(G.Team.item(this.a), 1), "2"))) {
                                    this.Temp1_2.replace(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum((N(G.Team.item(this.a)) - N(20000))))) + N(27))), "1");
                                }
                                this.a = N(this.a) + N(5);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.a = "0";
                            this.setPenColor("#ff0000");
                            this.setPenSize(20);
                            this.gotoXY(-171, (my - 136));
                            for (let row = 0; row < 3; row++) {
                                for (let col = 0; col < 3; col++) {
                                    this.a = N(this.a) + N(1);
                                    if (B((!B(equals(G.Team_color_2.item(this.a), ""))))) {
                                        if (B(equals(this.a, G.Menu.item(40)))) {
                                            this.setPenColor("#000000");
                                            this.setPenSize(30);
                                            this.setPenParam(S("transparency"), 100);
                                            this.penDown();
                                            this.setPenParam(S("transparency"), 20);
                                            this.changeXBy(42);
                                            this.penUp();
                                            this.changeXBy(-42);
                                            this.setPenColor("#ff0000");
                                            this.setPenSize(20);
                                        }
                                        this.setPenParam(S("color"), G.Team_color_2.item(this.a));
                                        if (B(equals(this.Temp1_2.item(this.a), "1"))) {
                                            this.setPenParam(S("brightness"), 50);
                                        }
                                        else {
                                            this.setPenParam(S("brightness"), 100);
                                        }
                                        this.penDown();
                                        this.changeXBy(42);
                                        if (B(equals(this.Temp1_2.item(this.a), "0"))) {
                                            if (B((B((B((compare((N(this.x) - N(52)), this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, (N(this.x) + N(10))) < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "10") < 0))))) {
                                                this.Mouse_touch = "Change color";
                                                this.Touch = this.a;
                                            }
                                        }
                                        this.penUp();
                                        this.changeXBy(34);
                                    }
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                this.setX(-171);
                                this.changeYBy(-44);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                        }
                        this.setEffect("BRIGHTNESS", 0);
                    }
                }
            }
            if (B(equals(UI_name, "Computer"))) {
                // 戦績コンピュータ: Menu[96] がタブ
                // （0=武器使用数、1=サブ使用数、2=キャラ使用数、3=MVP、4=平均キルと偏差値）。
                // 0–3 は CLOUD 全レコードを集計して [名前, 件数] を降順ソートする
                yield* panelFill("#004d4d");
                panelBorder();
                this.setEffect("BRIGHTNESS", 100);
                if (B((compare(G.Menu.item(96), "4") < 0))) {
                    this.Temp1_2.deleteAll();
                    this.a = "0";
                    const recs = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
                    for (let r = 0; r < recs; r++) {
                        if (B((!B(equals(G.CLOUD.item((N(this.a) + N(1))), ""))))) {
                            if (B(equals(G.Menu.item(96), "3"))) {
                                this.Temp1_2.add(G.CLOUD.item((N(this.a) + N(G.Number_of_data))));
                                this.Temp1_2.add(G.CLOUD.item((N(this.a) + N(36))));
                            }
                            else {
                                if (B(equals(G.Menu.item(96), "2"))) {
                                    this.c = (S(G.Character_2.item((N(G.CLOUD.item((N(this.a) + N(15)))) + N(1)))) + S(" body"));
                                    if (B(this.Temp1_2.contains(this.c))) {
                                        this.Temp1_2.replace((N(this.Temp1_2.itemNum(this.c)) + N(1)), (N(this.Temp1_2.item((N(this.Temp1_2.itemNum(this.c)) + N(1)))) + N(1)));
                                    }
                                    else {
                                        this.Temp1_2.add(this.c);
                                        this.Temp1_2.add("1");
                                    }
                                }
                                else {
                                    // 武器タブ: ロードアウト 5 件（field 37–41）のうち
                                    // Item_list の種別に「サブ」を含むかどうかで 0/1 タブに振り分ける。
                                    // 特殊武器（Special_weapon_2）は集計から外す
                                    this.b = "36";
                                    for (let k = 0; k < 5; k++) {
                                        this.b = N(this.b) + N(1);
                                        this.c = G.CLOUD.item((N(this.a) + N(this.b)));
                                        this.d = (N(S(G.Item_list.item((N(G.Weapon.item(this.c)) + N(1)))).toLowerCase().includes(S("サブ").toLowerCase())) + N(0));
                                        if (B(equals(G.Menu.item(96), this.d))) {
                                            if (B((!B(G.Special_weapon_2.contains(G.Weapon_name.item(this.c)))))) {
                                                this.c = (S("@") + S(G.Weapon_name.item(this.c)));
                                                if (B(this.Temp1_2.contains(this.c))) {
                                                    this.Temp1_2.replace((N(this.Temp1_2.itemNum(this.c)) + N(1)), (N(this.Temp1_2.item((N(this.Temp1_2.itemNum(this.c)) + N(1)))) + N(1)));
                                                }
                                                else {
                                                    this.Temp1_2.add(this.c);
                                                    this.Temp1_2.add("1");
                                                }
                                            }
                                        }
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                }
                            }
                        }
                        this.a = N(this.a) + N(G.Number_of_data);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    // 挿入ソート（件数降順）で Temp2_2 へ
                    this.Temp2_2.deleteAll();
                    this.a = "0";
                    const pairs = Math.max(0, Math.floor(N((N(this.Temp1_2.length) / N(2)))));
                    for (let r = 0; r < pairs; r++) {
                        this.a = N(this.a) + N(2);
                        this.b = "0";
                        this.c = "0";
                        const sorted = Math.max(0, Math.floor(N((N(this.Temp2_2.length) / N(2)))));
                        for (let k = 0; k < sorted; k++) {
                            if (B(equals(this.c, "0"))) {
                                this.b = N(this.b) + N(2);
                                if (B((compare(this.Temp2_2.item(this.b), this.Temp1_2.item(this.a)) < 0))) {
                                    this.c = "1";
                                    this.Temp2_2.insert(this.Temp1_2.item((N(this.a) - N(1))), (N(this.b) - N(1)));
                                    this.Temp2_2.insert(this.Temp1_2.item(this.a), this.b);
                                }
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        if (B(equals(this.c, "0"))) {
                            this.Temp2_2.add(this.Temp1_2.item((N(this.a) - N(1))));
                            this.Temp2_2.add(this.Temp1_2.item(this.a));
                        }
                        if (!this.rt.warpActive)
                            yield;
                    }
                    if (B((compare(G.Menu.item(96), "3") < 0))) {
                        // 棒グラフ（最大 8 件、最大値を高さ 230 に正規化）
                        this.gotoXY(-185, (my - 275));
                        this.a = "0";
                        this.setPenColor("#00b7b7");
                        this.setPenSize(20);
                        for (let r = 0; r < 8; r++) {
                            if (B((!B(equals(this.Temp2_2.item((N(this.a) + N(2))), "0"))))) {
                                this.b = (N(230) / N((N(this.Temp2_2.item(2)) / N(this.Temp2_2.item((N(this.a) + N(2)))))));
                                this.penDown();
                                this.changeYBy(this.b);
                                this.changeXBy(19);
                                this.penUp();
                                this.changeYBy(20);
                                yield* this.Draw_text(this.Temp2_2.item((N(this.a) + N(2))), "80", "C", (N(this.x) - N(9.5)));
                                this.changeYBy(-20);
                                this.changeXBy(9.5);
                                this.penDown();
                                this.changeYBy((N(0) - N(this.b)));
                                this.penUp();
                                this.setEffect("BRIGHTNESS", 0);
                                if (B(equals(G.Menu.item(96), "2"))) {
                                    this.pointInDirection(0);
                                    yield* this.Stamp((N(this.x) - N(9.5)), (N(this.y) + N((N(this.b) - N(7)))), "70", this.Temp2_2.item((N(this.a) + N(1))));
                                    this.pointInDirection(90);
                                }
                                else {
                                    yield* this.Stamp((N(this.x) - N(9.5)), (N(this.y) + N((N(this.b) - N(10)))), "80", this.Temp2_2.item((N(this.a) + N(1))));
                                }
                                this.setEffect("BRIGHTNESS", 100);
                                this.setY((my - 275));
                                this.changeXBy(40.5);
                                this.a = N(this.a) + N(2);
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        // MVP タブは名前リスト（10 文字超は省略）
                        this.gotoXY(-195, (my - 35));
                        this.a = "0";
                        for (let r = 0; r < 5; r++) {
                            if (B((compare("0", this.Temp2_2.item((N(this.a) + N(2)))) < 0))) {
                                if (B((compare("10", S(this.Temp2_2.item((N(this.a) + N(1)))).length) < 0))) {
                                    this.b = "";
                                    this.c = "0";
                                    for (let k = 0; k < 10; k++) {
                                        this.c = N(this.c) + N(1);
                                        this.b = (S(this.b) + S(letterOf(this.Temp2_2.item((N(this.a) + N(1))), this.c)));
                                        if (!this.rt.warpActive)
                                            yield;
                                    }
                                    this.b = (S(this.b) + S("..."));
                                }
                                else {
                                    this.b = this.Temp2_2.item((N(this.a) + N(1)));
                                }
                                yield* this.Draw_text((S(this.b) + S((S(": ") + S(this.Temp2_2.item((N(this.a) + N(2))))))), "110", "L", "-195");
                                this.changeYBy(-50);
                            }
                            this.a = N(this.a) + N(2);
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                }
                if (B(equals(G.Menu.item(96), "4"))) {
                    // 平均タブ: 全員の field 36（最大キル）の平均と標準偏差から
                    // 自分の偏差値 = 10×(Max_kill − 平均)/標準偏差 + 50
                    this.a = "0";
                    this.Temp1_2.deleteAll();
                    const recs = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
                    for (let r = 0; r < recs; r++) {
                        if (B((!B(equals(G.CLOUD.item((N(this.a) + N(1))), ""))))) {
                            this.Temp1_2.add(G.CLOUD.item((N(this.a) + N(36))));
                        }
                        this.a = N(this.a) + N(G.Number_of_data);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.a = "0";
                    this.b = "0";
                    const n1 = Math.max(0, Math.floor(N(this.Temp1_2.length)));
                    for (let r = 0; r < n1; r++) {
                        this.a = N(this.a) + N(1);
                        this.b = N(this.b) + N(this.Temp1_2.item(this.a));
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.b = (N(this.b) / N(this.Temp1_2.length));
                    this.a = "0";
                    this.c = "0";
                    for (let r = 0; r < n1; r++) {
                        this.a = N(this.a) + N(1);
                        this.c = N(this.c) + N((N((N(this.Temp1_2.item(this.a)) - N(this.b))) * N((N(this.Temp1_2.item(this.a)) - N(this.b)))));
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.c = mathop("sqrt", (N(this.c) / N(this.Temp1_2.length)));
                    this.c = (N((N((N(10) * N((N(G.Max_kill) - N(this.b))))) / N(this.c))) + N(50));
                    this.gotoXY(-190, (my - 100));
                    this.setPenColor("#00b7b7");
                    this.setPenSize(10);
                    this.penDown();
                    this.changeXBy(380);
                    this.penUp();
                    this.gotoXY(-195, (my - 75));
                    yield* this.Draw_text((S("Average kill: ") + S((N(Math.round(N((N(this.b) * N(10))))) / N(10)))), "120", "L", "-195");
                    this.gotoXY(-185, (my - 125));
                    yield* this.Draw_text((S("Your kill: ") + S((S(G.Max_kill) + S((S("`Your deviation: ") + S((N(Math.round(N((N(this.c) * N(10))))) / N(10)))))))), "100", "L", "-185");
                }
                // フッター: プレイヤー数とタブ名、左右のページ矢印
                this.gotoXY(-220, (my - 280));
                this.setPenColor("#676767");
                this.setPenSize(30);
                this.penDown();
                this.changeXBy(440);
                this.changeXBy(-440);
                this.changeYBy(-20);
                this.changeXBy(440);
                this.changeXBy(-440);
                this.penUp();
                this.gotoXY(-225, (my - 280));
                yield* this.Draw_text((S("Players: ") + S(G.Active_players)), "85", "L", "-225");
                this.gotoXY(0, (my - 310));
                if (B(equals(G.Menu.item(96), "0"))) {
                    yield* this.Draw_text("Weapon", "150", "C", "0");
                }
                if (B(equals(G.Menu.item(96), "1"))) {
                    yield* this.Draw_text("Sub", "150", "C", "0");
                }
                if (B(equals(G.Menu.item(96), "2"))) {
                    yield* this.Draw_text("Character", "150", "C", "0");
                }
                if (B(equals(G.Menu.item(96), "3"))) {
                    yield* this.Draw_text("MVP", "150", "C", "0");
                }
                if (B(equals(G.Menu.item(96), "4"))) {
                    yield* this.Draw_text("Average", "150", "C", "0");
                }
                this.setEffect("BRIGHTNESS", 0);
                this.gotoXY(215, (my - 305));
                if (B((B((compare(mathop("abs", (N(this.rt.mouse.x) - N(215))), "11") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(153))), "19") < 0))))) {
                    this.Mouse_touch = "Computer right";
                    this.setPenColor("#9a9a9a");
                }
                else {
                    this.setPenColor("#333333");
                }
                this.setPenSize(22);
                this.penDown();
                this.changeYBy(-15);
                this.penUp();
                this.changeXBy(-4);
                this.changeYBy(7);
                this.setPenColor("#ffffff");
                this.setPenSize(4);
                this.penDown();
                this.changeYBy(5);
                this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                this.changeYBy(5);
                this.changeXBy(4.5);
                this.penUp();
                this.gotoXY(-215, (my - 305));
                if (B((B((compare(mathop("abs", (N(this.rt.mouse.x) + N(215))), "11") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) + N(153))), "19") < 0))))) {
                    this.Mouse_touch = "Computer left";
                    this.setPenColor("#9a9a9a");
                }
                else {
                    this.setPenColor("#333333");
                }
                this.setPenSize(22);
                this.penDown();
                this.changeYBy(-15);
                this.penUp();
                this.changeXBy(4);
                this.changeYBy(7);
                this.setPenColor("#ffffff");
                this.setPenSize(4);
                this.penDown();
                this.changeYBy(5);
                this.gotoXY((N(this.x) - N(9)), (N(this.y) - N(5)));
                this.gotoXY((N(this.x) + N(9)), (N(this.y) - N(5)));
                this.changeYBy(5);
                this.changeXBy(-4.5);
                this.penUp();
            }
            if (B((B(equals(UI_name, "Map pointer")) || B(equals(UI_name, "Turret map pointer"))))) {
                // ミニマップ: 壁（タイプ 01 06 07 18 20 21 22 24、x > 8 のみ）、
                // ライフクリスタル、プレイヤーのドットを 1/7.25 縮尺で描く。
                // Map pointer はスポーン地点の選択（Menu[3]/[4] へ書き戻す）、
                // Turret map pointer はタレットの照準（Lock_on_player と Touch 符号化）
                yield* panelFill("#0f4d00");
                this.setEffect("BRIGHTNESS", 100);
                this.a = "0";
                this.c = "0";
                const wallRecs = Math.max(0, Math.floor(N((N(G.Wall___object.length) / N(7)))));
                for (let r = 0; r < wallRecs; r++) {
                    this.d = G.Wall___object.item((N(this.a) + N(2)));
                    if (B(equals(S(this.d).length, "1"))) {
                        this.d = (S("0") + S(this.d));
                    }
                    if (B(S("01 06 07 18 20 21 22 24").toLowerCase().includes(S(this.d).toLowerCase()))) {
                        if (B((compare("8", G.Wall___object.item((N(this.a) + N(3)))) < 0))) {
                            yield* this.Pen_mode();
                            this.gotoXY((N((N(G.Wall___object.item((N(this.a) + N(3)))) - N(64))) * N(6.9)), (N((N(G.Wall___object.item((N(this.a) + N(4)))) * N(6.9))) + N((my - 160))));
                            this.b = G.Wall___object.item((N(this.a) + N(2)));
                            if (B((B(equals(this.b, "1")) || B((B(equals(this.b, "20")) || B((B(equals(this.b, "21")) || B((B(equals(this.b, "22")) || B(equals(this.b, "24"))))))))))) {
                                this.switchCostume("Wall");
                            }
                            if (B(equals(this.b, "6"))) {
                                this.switchCostume("Spike wall");
                            }
                            if (B(equals(this.b, "18"))) {
                                this.switchCostume("Grid wall");
                            }
                            if (B((B(equals(this.b, "7")) && B(equals(UI_name, "Map pointer"))))) {
                                // ワープマスはドットで描き、自陣側のものに重ねると c が立つ
                                // （TEAMMODE 中は自チーム側だけ）
                                if (B((B(equals(G.TEAMMODE, "0")) || B((B(equals(G.TEAMMODE_2.item(5), "1")) && B((B((B(equals(letterOf(G.Team_ID, 1), "1")) && B((compare(this.x, "0") < 0)))) || B((B(equals(letterOf(G.Team_ID, 1), "2")) && B((compare("0", this.x) < 0))))))))))) {
                                    this.setPenColor("#00f2ff");
                                    this.setPenSize(7);
                                    this.penDown();
                                    this.penUp();
                                    this.setPenSize(30);
                                    this.setPenParam(S("transparency"), 50);
                                    this.penDown();
                                    this.penUp();
                                    if (B((compare(this.distanceToMouse(), "15") < 0))) {
                                        this.c = "1";
                                    }
                                }
                            }
                            else {
                                this.size = N(15);
                                this.stamp();
                            }
                        }
                    }
                    this.a = N(this.a) + N(7);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.setEffect("BRIGHTNESS", 0);
                yield* this.Pen_mode();
                if (B(equals(UI_name, "Map pointer"))) {
                    // 味方のライフクリスタル（残量 150 超）も同じく c を立てる
                    this.a = "0";
                    const beRecs = Math.max(0, Math.floor(N((N(G.Bullet_and_effect.length) / N(10)))));
                    for (let r = 0; r < beRecs; r++) {
                        if (B(equals(G.Bullet_and_effect.item((N(this.a) + N(2))), "Gライフクリスタル"))) {
                            if (B((compare("150", G.Bullet_and_effect.item((N(this.a) + N(8)))) < 0))) {
                                if (B(equals(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Bullet_and_effect.item((N(this.a) + N(1)))))) + N(11))), G.Team_ID))) {
                                    this.gotoXY((N((N(G.Bullet_and_effect.item((N(this.a) + N(3)))) - N(3200))) / N(7.25)), (N((N(G.Bullet_and_effect.item((N(this.a) + N(4)))) / N(7.25))) + N((my - 160))));
                                    this.setPenColor("#00f2ff");
                                    this.setPenSize(7);
                                    this.penDown();
                                    this.penUp();
                                    this.setPenSize(20);
                                    this.setPenParam(S("transparency"), 50);
                                    this.penDown();
                                    this.penUp();
                                    if (B((compare(this.distanceToMouse(), "10") < 0))) {
                                        this.c = "1";
                                    }
                                }
                            }
                        }
                        this.a = N(this.a) + N(10);
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                // プレイヤードット: 味方はチーム色、敵は体力で透明度。
                // Turret map pointer では最寄りの敵を Lock_on_player にする
                this.a = "0";
                this.b = "99999";
                const recs = Math.max(0, Math.floor(N((N(G.CLOUD.length) / N(G.Number_of_data)))));
                for (let r = 0; r < recs; r++) {
                    if (B((compare("400", G.CLOUD.item((N(this.a) + N(3)))) < 0))) {
                        this.gotoXY((N((N(G.CLOUD.item((N(this.a) + N(3)))) - N(3200))) / N(7.25)), (N((N(G.CLOUD.item((N(this.a) + N(4)))) / N(7.25))) + N((my - 160))));
                        if (B((B(equals(G.CLOUD.item((N(this.a) + N(12))), G.Team_ID)) && B((!B(equals(G.CLOUD.item((N(this.a) + N(1))), G.ID))))))) {
                            if (B(equals(G.CLOUD.item((N(this.a) + N(45))), "1"))) {
                                this.setPenColor("#00ffb6");
                                this.setPenSize(14);
                                this.setPenParam(S("transparency"), 50);
                                this.penDown();
                                this.penUp();
                            }
                            this.setPenColor("#ff0000");
                            this.setPenParam(S("color"), G.Team_color_2.item(G.Team_color));
                            this.setPenSize(7);
                            this.penDown();
                            this.penUp();
                        }
                        else {
                            if (B(equals(UI_name, "Turret map pointer"))) {
                                if (B((!B(equals(G.CLOUD.item((N(this.a) + N(1))), G.ID))))) {
                                    this.c = this.distanceToMouse();
                                    if (B((compare(this.c, "50") < 0))) {
                                        if (B((compare(this.c, this.b) < 0))) {
                                            this.b = this.c;
                                            G.Lock_on_player = G.CLOUD.item((N(this.a) + N(1)));
                                        }
                                    }
                                }
                            }
                            this.setPenColor("#ff00dc");
                            this.setPenSize(14);
                            this.setPenParam(S("transparency"), (N(100) - N((N(G.CLOUD.item((N(this.a) + N(23)))) - N(20)))));
                            this.penDown();
                            this.penUp();
                            if (B(equals(G.CLOUD.item((N(this.a) + N(45))), "1"))) {
                                this.setPenColor("#00ffb6");
                                this.setPenSize(7);
                                this.penDown();
                                this.penUp();
                            }
                        }
                    }
                    this.a = N(this.a) + N(G.Number_of_data);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.a = this.rt.mouse.x;
                this.b = this.rt.mouse.y;
                if (B(equals(UI_name, "Map pointer"))) {
                    // 照準位置をワールド座標へ戻して Menu[3]/[4] に書く。
                    // 緑（Spawn area）になるのはワープ/クリスタルに重ねて壁でないときだけ
                    if (B((compare("220", this.a) < 0))) {
                        this.a = "220";
                    }
                    if (B((compare(this.a, "-220") < 0))) {
                        this.a = "-220";
                    }
                    if (B((compare("160", this.b) < 0))) {
                        this.b = "160";
                    }
                    if (B((compare(this.b, "-160") < 0))) {
                        this.b = "-160";
                    }
                    yield* this.CSM_menu("3", (N((N(this.a) * N(7.25))) + N(3200)), "S", "0");
                    yield* this.CSM_menu("4", (N((N(this.b) - N((my - 160)))) * N(7.25)), "S", "0");
                    if (B(this.Player_wall.contains((S(Math.round(N((N(G.Menu.item(3)) / N(50))))) + S((S("/") + S(Math.round(N((N(G.Menu.item(4)) / N(50))))))))))) {
                        this.c = "0";
                    }
                    this.gotoXY(-220, (N(this.b) + N((my - 160))));
                    if (B(equals(this.c, "1"))) {
                        this.setPenColor("#2aff00");
                        this.Mouse_touch = "Spawn area";
                    }
                    else {
                        this.setPenColor("#ff0000");
                    }
                    this.setPenSize(5);
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 50);
                    this.changeXBy(440);
                    this.penUp();
                    this.gotoXY(this.a, (my - 320));
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 50);
                    this.changeYBy(320);
                }
                else {
                    // タレット照準: Touch に目標座標を符号化して Button 側へ渡す
                    this.Turreting = "1";
                    if (B((compare("165", this.a) < 0))) {
                        this.a = "165";
                    }
                    if (B((compare(this.a, "-165") < 0))) {
                        this.a = "-165";
                    }
                    if (B((compare("105", this.b) < 0))) {
                        this.b = "105";
                    }
                    if (B((compare(this.b, "-105") < 0))) {
                        this.b = "-105";
                    }
                    this.Mouse_touch = "Turret shot";
                    this.Touch = (S("1") + S((N(Math.round(N((N(this.a) * N(0.145))))) + N(564))) + S((N(Math.round(N(((N(this.b) - (my - 160))) * N(0.145)))) + N(500))));
                    this.a = Math.round(N((N(this.a) / N(6.89))));
                    this.b = Math.round(N((N(this.b) / N(6.89))));
                    this.d = (N(G.Turrets.item(16)) - N(3200));
                    this.c = (N(Math.round(N((N(mathop("sqrt", (N((N((N(this.a) - N((N(this.d) / N(50))))) * N((N(this.a) - N((N(this.d) / N(50))))))) + N((N((N(this.b) - N((N(G.Turrets.item(17)) / N(50))))) * N((N(this.b) - N((N(G.Turrets.item(17)) / N(50)))))))))) * N(10))))) / N(10));
                    this.a = (N(this.a) * N(6.89));
                    this.b = (N(this.b) * N(6.89));
                    this.gotoXY((N(this.d) / N(7.25)), (N((N(G.Turrets.item(17)) / N(7.25))) + N((my - 160))));
                    this.setPenColor("#ff0000");
                    this.setPenSize(5);
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 70);
                    this.gotoXY(this.a, (N(this.b) + N((my - 160))));
                    this.penUp();
                    this.changeXBy(-5);
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 50);
                    this.changeXBy(10);
                    this.penUp();
                    this.changeXBy(-5);
                    this.changeYBy(5);
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 50);
                    this.changeYBy(-10);
                    this.penUp();
                    this.changeYBy(5);
                    this.setPenColor("#ff0000");
                    this.setPenSize((N(800) / N(7.25)));
                    this.setPenParam(S("transparency"), 70);
                    this.penDown();
                    this.penUp();
                    this.changeYBy(20);
                    this.setEffect("BRIGHTNESS", mod((N(this.rt.timer()) * N(150)), 101));
                    yield* this.Draw_text((S(this.c) + S("m")), "70", "C", this.x);
                    this.setEffect("BRIGHTNESS", 0);
                }
                this.penUp();
                panelBorder();
                if (B(equals(UI_name, "Map pointer"))) {
                    this.setEffect("BRIGHTNESS", 100);
                    this.gotoXY(-225, menu);
                    yield* this.Draw_text((S("Players: ") + S(G.Active_players)), "95", "L", "-225");
                }
            }
            if (B(equals(UI_name, "Cheat stopper"))) {
                // チート検出時の全画面オーバーレイ。中央の円がブロックボタンで、
                // Menu[85] が対象 ID のときはブロック人数（Blocked_player の組数）を出す
                this.setPenColor("#333333");
                this.setPenSize(40);
                this.gotoXY(-300, menu);
                this.penDown();
                this.changeXBy(600);
                this.penUp();
                this.gotoXY(-300, (my - 320));
                this.penDown();
                this.changeXBy(600);
                this.penUp();
                this.setPenColor("#000a4e");
                this.setPenSize(281);
                this.setPenParam(S("transparency"), 10);
                this.gotoXY(-500, (my - 160));
                this.penDown();
                this.changeXBy(1000);
                this.penUp();
                yield* this.Stamp("-143", (my - 123), "100", "Cheat stopper info");
                this.gotoXY(0, (my - 160));
                if (B(equals(G.Menu.item(85), "0000"))) {
                    this.setPenColor("#ff0000");
                }
                else {
                    this.setPenColor("#b70000");
                }
                this.setPenSize(100);
                this.penDown();
                this.penUp();
                this.setEffect("BRIGHTNESS", 100);
                if (B((!B(equals(G.Menu.item(85), "0000"))))) {
                    yield* this.Draw_text((N(S(G.Blocked_player.item((N(G.Blocked_player.itemNum((S("#") + S(G.Menu.item(85))))) + N(1)))).length) / N(4)), "150", "C", "0");
                }
                if (B((compare(mathop("sqrt", (N((N(this.rt.mouse.x) * N(this.rt.mouse.x))) + N((N(this.rt.mouse.y) * N(this.rt.mouse.y))))), "50") < 0))) {
                    this.Mouse_touch = "Player block";
                }
            }
            this.setEffect("BRIGHTNESS", 0);
        }
    }
    // procedure: "Draw lock on"
    *Draw_lock_on() {
        // 照準マーカー。マウス方向へ d だけ進んだ位置に中央マーカーを置き、
        // 武器の拡散角（Item_list[+7]）があれば tan(拡散) × d で広がるサイドマーカーも描く。
        // 二丁拳銃は構え位置にもう1つ中央マーカーを出す。
        if (B((B(equals(G.Mouse_camera_lock, "0")) && B((B((compare(G.Menu.item(15), "1") < 0)) && B(equals(G.Menu.item(56), "0"))))))) {
            yield* this.Pen_mode();
            this.gotoXY((N((N(0) - N(G.Camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.Camera_y))) * N(G.Zoom_temp)));
            this.pointInDirection(G.Motion.item(3));
            this.d = (N(mathop("sqrt", (N((N((N(G.Camera_x) + N((N((N(this.rt.mouse.x) / N(100))) * N(G.Zoom))))) * N((N(G.Camera_x) + N((N((N(this.rt.mouse.x) / N(100))) * N(G.Zoom))))))) + N((N((N(G.Camera_y) + N((N((N(this.rt.mouse.y) / N(100))) * N(G.Zoom))))) * N((N(G.Camera_y) + N((N((N(this.rt.mouse.y) / N(100))) * N(G.Zoom)))))))))) - N(20));
            this.moveSteps((N((N(this.d) + N(20))) * N(G.Zoom_temp)));
            if (B(equals(G.Inventory_2.item((N(G.Inventory) + N(2))), "シールドキャノン"))) {
                this.turnRight(90);
                this.moveSteps((N(23) * N(G.Zoom_temp)));
                this.turnLeft(90);
            }
            else {
                if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("ランチャー").toLowerCase()))) {
                    this.turnRight(90);
                    this.moveSteps((N(15) * N(G.Zoom_temp)));
                    this.turnLeft(90);
                }
                else {
                    if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("二丁拳銃").toLowerCase()))) {
                        this.turnRight(90);
                        if (B(equals(G.Scoping, "1"))) {
                            this.moveSteps((N(3) * N(G.Zoom_temp)));
                        }
                        else {
                            this.moveSteps((N(10) * N(G.Zoom_temp)));
                        }
                        this.switchCostume("Center lock on");
                        this.size = N(100);
                        this.stamp();
                        yield* this.Pen_mode();
                        if (B(equals(G.Scoping, "1"))) {
                            this.moveSteps((N(-6) * N(G.Zoom_temp)));
                        }
                        else {
                            this.moveSteps((N(-20) * N(G.Zoom_temp)));
                        }
                        this.turnLeft(90);
                    }
                }
            }
            this.pointInDirection(G.Motion.item(3));
            this.a = G.Inventory_2.item((N(G.Inventory) + N(5)));
            if (B(equals(this.a, "0"))) {
                this.switchCostume("Center lock on");
            }
            else {
                if (B((compare(this.a, "33") < 0))) {
                    this.switchCostume("Center lock on0");
                }
                else {
                    if (B((compare(this.a, "66") < 0))) {
                        this.switchCostume("Center lock on1");
                    }
                    else {
                        if (B((compare(this.a, "100") < 0))) {
                            this.switchCostume("Center lock on2");
                        }
                        else {
                            this.switchCostume("Center lock on3");
                        }
                    }
                }
            }
            this.size = N(100);
            this.stamp();
            this.a = G.Item_list.item((N(G.Use_Item_ID) + N(7)));
            if (B((B(equals(G.Scoping, "0")) && B((B(equals(G.Item_list.item((N(G.Use_Item_ID) + N(6))), "1")) && B((compare(this.a, "2") < 0))))))) {
                this.a = N(this.a) + N(25);
            }
            if (B((compare("0", this.a) < 0))) {
                this.a = (N(mathop("tan", this.a)) * N(this.d));
                if (B((compare("6", this.a) < 0))) {
                    yield* this.Pen_mode();
                    this.turnRight(90);
                    if (B(S(G.Inventory_2.item((N(G.Inventory) + N(2)))).toLowerCase().includes(S("二丁拳銃").toLowerCase()))) {
                        if (B(equals(G.Scoping, "1"))) {
                            this.moveSteps((N(3) * N(G.Zoom_temp)));
                            this.a = N(this.a) + N(3);
                        }
                        else {
                            this.moveSteps((N(10) * N(G.Zoom_temp)));
                            this.a = N(this.a) + N(10);
                        }
                    }
                    this.moveSteps((N(this.a) * N(G.Zoom_temp)));
                    this.switchCostume("Side lock on");
                    this.size = N(100);
                    this.stamp();
                    yield* this.Pen_mode();
                    this.turnRight(180);
                    this.moveSteps((N((N(this.a) * N(2))) * N(G.Zoom_temp)));
                    this.switchCostume("Side lock on");
                    this.size = N(100);
                    this.stamp();
                }
            }
        }
    }
    // procedure: "Draw my combat status"
    *Draw_my_combat_status() {
        // 左下の体力バー + ランクプレート + バフアイコン列。
        // Menu[5] は表示用体力（実体力へ M 追随）、Menu[98] は被弾フラッシュの透明度。
        yield* this.CSM_menu("5", G.Health, "M", "4");
        if (B(equals(G.Not_attack, "0"))) {
            yield* this.CSM_menu("98", "10", "C", "0");
            this.gotoXY(-225, -119);
            this.setPenColor("#272727");
            this.setPenSize(20);
            this.penDown();
            this.changeXBy(150);
            this.penUp();
            this.changeXBy(-150);
            if (B(equals(G.Health_timer, "0"))) {
                if (B((compare(G.Health, G.Max_health) < 0))) {
                    if (B(equals(G.Special_weapon, "0"))) {
                        this.setPenColor("#189a00");
                    }
                    else {
                        this.setPenColor("#9a7600");
                    }
                    this.setPenParam(S("saturation"), (N(100) - N((N(100) / N((N(150) / N(G.Menu.item(9))))))));
                    this.setPenParam(S("brightness"), (N(60) - N((N(45) / N((N(150) / N(G.Menu.item(9))))))));
                    this.penDown();
                    this.changeXBy(G.Menu.item(9));
                    this.penUp();
                    this.changeXBy((N(0) - N(G.Menu.item(9))));
                }
            }
            else {
                if (B((compare(G.Health_timer, "0") < 0))) {
                    this.setPenColor("#807b00");
                    this.penDown();
                    this.changeXBy((N(150) / N((N((N(mathop("abs", G.Character_2.item((N(G.Character) + N(8))))) * N(40))) / N(mathop("abs", G.Health_timer))))));
                    this.penUp();
                    this.changeXBy((N(-150) / N((N((N(mathop("abs", G.Character_2.item((N(G.Character) + N(8))))) * N(40))) / N(mathop("abs", G.Health_timer))))));
                }
                else {
                    this.setPenColor("#670000");
                    this.penDown();
                    this.changeXBy((N(150) / N((N(450) / N(G.Health_timer)))));
                    this.penUp();
                    this.changeXBy((N(-150) / N((N(450) / N(G.Health_timer)))));
                }
            }
            this.setPenColor("#828282");
            this.setPenSize(10);
            this.penDown();
            this.changeXBy(150);
            this.penUp();
            this.changeXBy(-150);
            if (B((compare(G.Health, G.Menu.item(5)) < 0))) {
                this.setPenColor("#ff6e00");
                this.penDown();
                this.changeXBy((N(150) / N((N(G.Max_health) / N(G.Menu.item(5))))));
                this.penUp();
                this.changeXBy((N(-150) / N((N(G.Max_health) / N(G.Menu.item(5))))));
                if (B(equals(G.Special_weapon, "1"))) {
                    this.setPenColor("#ce9700");
                }
                else {
                    this.setPenColor("#21ce00");
                }
                this.penDown();
                this.changeXBy((N(150) / N((N(G.Max_health) / N(G.Health)))));
                this.penUp();
                this.changeXBy((N(-150) / N((N(G.Max_health) / N(G.Health)))));
            }
            else {
                if (B(equals(G.Special_weapon, "1"))) {
                    this.setPenColor("#b58400");
                }
                else {
                    this.setPenColor("#21ce00");
                }
                this.penDown();
                this.changeXBy((N(150) / N((N(G.Max_health) / N(G.Menu.item(5))))));
                this.penUp();
                this.changeXBy((N(-150) / N((N(G.Max_health) / N(G.Menu.item(5))))));
                if (B(equals(G.Special_weapon, "0"))) {
                    this.setPenColor("#2aff00");
                    this.setPenParam(S("transparency"), 50);
                    this.penDown();
                    this.changeXBy((N(150) / N((N(G.Max_health) / N(G.Health)))));
                    this.penUp();
                    this.changeXBy((N(-150) / N((N(G.Max_health) / N(G.Health)))));
                }
            }
            if (B((compare("0", G.Shield) < 0))) {
                this.setPenColor("#00f2ff");
                this.setPenParam(S("transparency"), 100);
                this.penDown();
                this.setPenParam(S("transparency"), 50);
                this.changeXBy((N(150) / N((N((N(G.Max_health) / N(4))) / N(G.Shield)))));
                this.penUp();
                this.changeXBy((N(-150) / N((N((N(G.Max_health) / N(4))) / N(G.Shield)))));
            }
            this.setPenColor("#ffffff");
            this.setPenParam(S("transparency"), 100);
            this.penDown();
            this.setPenParam(S("transparency"), G.Menu.item(98));
            this.changeXBy(150);
            this.penUp();
            this.changeXBy(-150);
            this.a = "1";
            this.b = "0";
            this.c = "0";
            // ランク走査: Rank は [名前, 閾値] の組。閾値 - 0.1 を Kill_point が超えた組が現在ランクで、
            // b/d はその組が属する大区分（6 項目）の上限/下限。Max_rank は到達した最大の組番号
            const rankPairs = Math.max(0, Math.floor(N((N(this.Rank.length) / N(2)))));
            for (let r = 0; r < rankPairs; r++) {
                if (B((compare((N(this.Rank.item((N(this.a) + N(1)))) - N(0.1)), this.Kill_point) < 0))) {
                    this.b = this.Rank.item((N((N(mathop("ceiling", (N(this.a) / N(6)))) * N(6))) + N(2)));
                    this.d = this.Rank.item((N((N(mathop("ceiling", (N(this.a) / N(6)))) * N(6))) - N(4)));
                    this.c = this.a;
                }
                this.a = N(this.a) + N(2);
                if (!this.rt.warpActive)
                    yield;
            }
            if (B(equals(this.b, ""))) {
                this.b = this.Rank.item("last");
            }
            if (B((compare(G.Max_rank, (N((N(this.c) + N(1))) / N(2))) < 0))) {
                G.Max_rank = (N((N(this.c) + N(1))) / N(2));
            }
            yield* this.CSM_menu("24", (N(-250) + N((N(250) / N((N((N(this.b) - N(this.d))) / N((N(this.Kill_point) - N(this.d)))))))), "M", "4");
            if (B((!B(equals(Math.round(N(G.Menu.item(23))), "40"))))) {
                yield* this.Stamp("0", G.Menu.item(23), "100", "Rank background");
                yield* this.Stamp(G.Menu.item(24), G.Menu.item(23), "100", "Rank bar");
                yield* this.Stamp("0", G.Menu.item(23), "100", "Rank frame");
                this.setEffect("BRIGHTNESS", 100);
                this.gotoXY(-237, (N(168) + N(G.Menu.item(23))));
                yield* this.Draw_text(this.Rank.item(this.c), "70", "L", "-237");
                this.gotoXY(-236, (N(153) + N(G.Menu.item(23))));
                yield* this.Draw_text((S((N(Math.round(N((N(this.Kill_point) * N(10))))) / N(10))) + S((S("/") + S(this.b)))), "50", "L", "-236");
                this.gotoXY(235, (N(170) + N(G.Menu.item(23))));
                yield* this.Draw_text((S("Money: ") + S(G.Money)), "65", "R", "235");
                this.gotoXY(234, (N(153) + N(G.Menu.item(23))));
                yield* this.Draw_text((S("Kill: ") + S(G.Kill_counter)), "65", "R", "234");
            }
            this.setEffect("BRIGHTNESS", 100);
            this.gotoXY(-225, -119);
            yield* this.Draw_text((S(Math.round(N(G.Health))) + S((S("/") + S(G.Max_health)))), "84", "L", "-225");
            this.setEffect("BRIGHTNESS", 0);
            this.c = "-97";
        }
        else {
            this.c = "-117";
        }
        this.a = "1";
        this.b = "-223";
        if (B(equals(mod(this.Frame_cutter, 15), "0"))) {
            G.Menu.replace(105, "0");
            G.Menu.replace(106, "0");
        }
        // バフアイコン列: 15 フレームごとに Menu[105]/[106]（バフ/デバフ数）も数え直す
        const buffPairs = Math.max(0, Math.floor(N((N(G.Buff_Debuff.length) / N(2)))));
        for (let r = 0; r < buffPairs; r++) {
            if (B((compare(G.Buff_Debuff.item((N(this.a) + N(1))), "150") < 0))) {
                this.setEffect("GHOST", (N(30) + N((N(mathop("sin", (N(this.rt.timer()) * N(450)))) * N(30)))));
            }
            yield* this.Stamp(this.b, this.c, "100", (S("^") + S(G.Buff_Debuff.item(this.a))));
            this.setEffect("GHOST", 0);
            if (B(equals(mod(this.Frame_cutter, 15), "0"))) {
                if (B(equals(G.Buff.item((N((N((N(this.Buff_name.itemNum(G.Buff_Debuff.item(this.a))) - N(1))) * N(20))) + N(2))), "1"))) {
                    if (B((compare(G.Menu.item(105), "4") < 0))) {
                        yield* this.CSM_menu("105", (N(G.Menu.item(105)) + N(1)), "S", "");
                    }
                }
                else {
                    if (B((compare(G.Menu.item(106), "4") < 0))) {
                        yield* this.CSM_menu("106", (N(G.Menu.item(106)) + N(1)), "S", "");
                    }
                }
            }
            this.a = N(this.a) + N(2);
            this.b = N(this.b) + N(25);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Damage effect"
    *Damage_effect() {
        // 被弾時の画面エフェクト。Menu[7] が強さ（0 で無効）、Menu[6] が色、
        // Menu[8] が 49 超なら画面枠、それ以下なら全面の点で描く。
        if (B(compare("0", G.Menu.item(7)) < 0)) {
            yield* this.Pen_mode();
            if (B(equals(G.Menu.item(6), "1")))
                this.setPenColor("#ff0000");
            if (B(equals(G.Menu.item(6), "2")))
                this.setPenColor("#2aff00");
            if (B(equals(G.Menu.item(6), "3")))
                this.setPenColor("#00f2ff");
            if (B(compare("49", G.Menu.item(8)) < 0)) {
                this.gotoXY(0, 0);
                this.setPenSize(800);
                this.setPenParam(S("transparency"), 100 - N(G.Menu.item(7)));
                this.penDown();
                this.penUp();
            }
            else {
                this.gotoXY(-240, 180);
                this.setPenSize(100);
                this.setPenParam(S("transparency"), 100);
                this.penDown();
                this.setPenParam(S("transparency"), 100 - N(G.Menu.item(7)));
                this.changeXBy(480);
                this.changeYBy(-360);
                this.changeXBy(-480);
                this.changeYBy(360);
                this.penUp();
            }
        }
    }
    // procedure: "Sound %s"
    *Sound(volume) {
        // 足音・物音の大きさ G.Sound を最大値で更新する。茂み（Bush == "1"）の外では 1.3 倍。
        // 係数は Character_2[+6] × Buff_effect[8]、上限は 150。
        if (B(equals(G.Bush, "0"))) {
            if (B((compare(G.Sound, (N(1.3) * N((N(volume) * N((N(G.Character_2.item((N(G.Character) + N(6)))) * N(G.Buff_effect.item(8)))))))) < 0))) {
                G.Sound = (N(1.3) * N((N(volume) * N((N(G.Character_2.item((N(G.Character) + N(6)))) * N(G.Buff_effect.item(8)))))));
            }
        }
        else {
            if (B((compare(G.Sound, (N(volume) * N((N(G.Character_2.item((N(G.Character) + N(6)))) * N(G.Buff_effect.item(8)))))) < 0))) {
                G.Sound = (N(volume) * N((N(G.Character_2.item((N(G.Character) + N(6)))) * N(G.Buff_effect.item(8)))));
            }
        }
        if (B((compare("150", G.Sound) < 0))) {
            G.Sound = "150";
        }
    }
    // procedure: "Set bullet val %s"
    *Set_bullet_val(v_length) {
        // Bullet_list の現在位置（d）から v_length 件を読み、Temp2_2 へ展開する。
        // "[nn" で始まる項目は Temp1_2 の nn 番への参照として解決する。
        // 読み終わると c（消費カウンタ）が v_length 進む。
        this.Temp2_2.deleteAll();
        this.e = "0";
        const cnt = Math.max(0, Math.floor(N(v_length)));
        for (let i = 0; i < cnt; i++) {
            this.e = N(this.e) + 1;
            this.f = G.Bullet_list.item(N(this.d) + N(this.e));
            if (B(equals(letterOf(this.f, 1), "["))) {
                this.Temp2_2.add(this.Temp1_2.item(S(letterOf(this.f, 2)) + S(letterOf(this.f, 3))));
            }
            else {
                this.Temp2_2.add(this.f);
            }
            if (!this.rt.warpActive)
                yield;
        }
        this.c = N(this.c) + N(v_length);
    }
    // procedure: "Data cut 3 to 2 %s"
    *Data_cut_3_to_2(data) {
        // 数値を round(data - 1) して [0, 99] に丸め、1 桁なら 0 埋めして
        // Temp1_2 の末尾へ追加する（クラウド送信用の 2 桁パック部品）。
        // 2 桁に整った場合は数値のまま、0 埋めした場合は文字列になる。
        this.a = Math.round(N(data) - 1);
        if (B(compare(this.a, "0") < 0)) {
            this.a = "0";
        }
        if (B(compare("99", this.a) < 0)) {
            this.a = "99";
        }
        if (B(equals(S(this.a).length, "1"))) {
            this.a = S("0") + S(this.a);
        }
        this.Temp1_2.add(this.a);
    }
    // procedure: "Weapon motion %b %b %b %b"
    *Weapon_motion(Attack_ok, Full, Scoping, Click) {
        // 武器の構え・発射・切替の状態機械（毎フレーム呼ばれる）。
        // a は現在の武器種別文字列（呼び出し側が入れる）、Motion は
        // [1]=構え位置 [2]=モーション種別 [3]=向き [10]=反動。
        // 発射可否は Shot の c フラグで受け取る。末尾で常に Menu[36]（バースト間隔）を進める。
        this.c = "0";
        if (B(equals(G.Menu.item(17), "1"))) {
            // ---- 武器切替中: Motion[1] が -62 に達したら Shot して持ち替える ----
            if (B(equals(this.a, "サブ"))) {
                G.Motion.replace(2, "5");
            }
            else if (B(equals(this.a, "戦車サブ"))) {
                G.Motion.replace(1, "-62");
                G.Motion.replace(2, "8");
            }
            else if (B(equals(this.a, "シールドキャノンサブ"))) {
                G.Motion.replace(1, "-62");
                G.Motion.replace(2, "7");
            }
            if (B(compare("-62", G.Motion.item(1)) < 0)) {
                G.Motion.replace(1, N(G.Motion.item(1)) - 510 / N(G.FPS));
            }
            else {
                G.Motion.replace(1, "-62");
                yield* this.Shot__c(G.Inventory, Full);
                G.Menu.replace(17, "0");
                G.Inventory_2.replace(31, G.Menu.item(18));
                G.Inventory = N(N(G.Inventory_2.item(31)) - 1) * 6;
            }
        }
        else {
            if (S(this.a).toLowerCase().includes(S("サブ").toLowerCase()) && B(Attack_ok) && B(Full) && B(Click)) {
                // ---- サブ武器の連射: Menu[75] の間隔で撃つ ----
                if (B(equals(this.a, "戦車サブ"))) {
                    G.Motion.replace(1, "-62");
                    G.Motion.replace(2, "8");
                }
                else if (B(equals(this.a, "シールドキャノンサブ"))) {
                    G.Motion.replace(1, "0");
                    G.Motion.replace(2, "7");
                }
                else {
                    if (B(!B(equals(G.Motion.item(2), "5"))))
                        G.Motion.replace(1, "0");
                    G.Motion.replace(2, "5");
                }
                G.Menu.replace(75, N(G.Menu.item(75)) - N(G.FPS_temp));
                if (B(compare(G.Menu.item(75), "0") < 0)) {
                    if (B(compare("-62", G.Motion.item(1)) < 0)) {
                        G.Motion.replace(1, N(G.Motion.item(1)) - 510 / N(G.FPS));
                    }
                    else {
                        G.Menu.replace(75, "3");
                        G.Motion.replace(1, "0");
                        yield* this.Shot__c(G.Inventory, Full);
                    }
                }
            }
            else if (B(!S(this.a).toLowerCase().includes(S("サブ").toLowerCase())) &&
                (compare("0", this.Hold_click) < 0 || (B(equals(this.Hold_click, "0")) && (B(Scoping) || B(equals(G.Menu.item(66), "1")) || B(Click))))) {
                // ---- メイン武器: 長押しで構えが進み、閾値を超えたら発射可能になる ----
                const gateOpen = compare("0", G.Menu.item(53)) < 0 ||
                    (((B(Attack_ok) || (B(!B(Attack_ok)) && B(equals(this.a, "パーティー")))) && B(Click)) || B(Scoping)) ||
                    compare("0", G.Menu.item(35)) < 0;
                if (gateOpen) {
                    this.Hold_click = N(this.Hold_click) + 1;
                    if (B(compare(N(0.118) * N(G.FPS), this.Hold_click) < 0)) {
                        this.b = G.Motion.item(2);
                        if (B(equals(S(this.b).length, "1")))
                            this.b = S("0") + S(this.b);
                        if (B(!S("01 02 05 06 13 14 15").toLowerCase().includes(S(this.b).toLowerCase()))) {
                            G.Motion.replace(1, "0");
                        }
                        if (S(this.a).toLowerCase().includes(S("剣").toLowerCase()) || S(this.a).toLowerCase().includes(S("近接").toLowerCase())) {
                            // 近接: Menu[53]（溜め）が残っていれば振り、無ければ構える
                            if (B(compare("0", G.Menu.item(53)) < 0)) {
                                yield* this.CSM_menu("53", "-1", "C", "0");
                                G.Motion.replace(1, N(G.Motion.item(1)) - 1500 / N(G.FPS));
                                G.Motion.replace(2, "5");
                                if (B(compare(G.Motion.item(1), "-124") < 0))
                                    G.Motion.replace(1, "-124");
                            }
                            else {
                                if (B(Scoping)) {
                                    yield* this.Put_buff("耐弾", "5");
                                    G.Motion.replace(2, "12");
                                }
                                else {
                                    G.Motion.replace(2, "5");
                                }
                                G.Motion.replace(1, "0");
                            }
                            if (B(Click) && B(Attack_ok)) {
                                yield* this.Shot__c(G.Inventory, Full);
                            }
                            if (B(equals(this.c, "1"))) {
                                G.Menu.replace(53, "8");
                                yield* this.Put_buff("疲労", G.Inventory_2.item(N(G.Inventory) + 4));
                            }
                        }
                        else {
                            // 種別ごとの構えモーション
                            if (S(this.a).toLowerCase().includes(S("片手銃").toLowerCase()))
                                G.Motion.replace(2, "1");
                            if (S(this.a).toLowerCase().includes(S("ライフル").toLowerCase()))
                                G.Motion.replace(2, "2");
                            if (S(this.a).toLowerCase().includes(S("ランチャー").toLowerCase()))
                                G.Motion.replace(2, "6");
                            if (S(this.a).toLowerCase().includes(S("二丁拳銃").toLowerCase())) {
                                G.Charge = "01";
                                if (B(equals(G.Motion.item(10), "0"))) {
                                    G.Motion.replace(2, "15");
                                }
                                else if (B(equals(G.Menu.item(35), "1"))) {
                                    G.Charge = "02";
                                    G.Motion.replace(2, "13");
                                }
                                else {
                                    G.Motion.replace(2, "14");
                                }
                            }
                            if (S(this.a).toLowerCase().includes(S("シールドキャノン").toLowerCase())) {
                                G.Motion.replace(1, "-62");
                                G.Motion.replace(2, "7");
                            }
                            if (S(this.a).toLowerCase().includes(S("戦車").toLowerCase())) {
                                G.Motion.replace(1, "-62");
                                G.Motion.replace(2, "8");
                            }
                            if (B(compare("-62", G.Motion.item(1)) < 0)) {
                                G.Motion.replace(1, N(G.Motion.item(1)) - 782 / N(G.FPS));
                            }
                            else {
                                G.Motion.replace(1, "-62");
                                const canFire = (B(Click) && B(Attack_ok) &&
                                    (B(equals(G.Mobile_2.item(23), "0")) || (B(equals(G.Mobile_2.item(23), "1")) && B(compare("100", G.Mobile_2.item(24)) < 0)))) ||
                                    (compare("0", G.Menu.item(35)) < 0 && compare(G.Menu.item(36), "1") < 0);
                                if (canFire) {
                                    if (S(this.a).toLowerCase().includes(S("オーバーヒート").toLowerCase())) {
                                        if (B(compare(G.Menu.item(36), "1") < 0)) {
                                            G.Menu.replace(36, N(S(letterOf(this.a, N(S(this.a).length) - 3)) + S(letterOf(this.a, N(S(this.a).length) - 2))) - 10);
                                            yield* this.Shot__c(G.Inventory, compare("0", G.Inventory_2.item(N(G.Inventory) + 3)) < 0);
                                        }
                                    }
                                    else {
                                        yield* this.Shot__c(G.Inventory, Full);
                                        // バースト/二丁拳銃は Menu[35] の残弾数で連射を管理する
                                        if (S(this.a).toLowerCase().includes(S("バースト").toLowerCase()) || S(this.a).toLowerCase().includes(S("二丁拳銃").toLowerCase())) {
                                            if (B(Full)) {
                                                G.Menu.replace(35, S(this.a).toLowerCase().includes(S("二丁拳銃").toLowerCase()) ? "2" : letterOf(this.a, N(S(this.a).length) - 1));
                                            }
                                            if (compare("0", G.Menu.item(35)) < 0 && compare(G.Menu.item(36), "1") < 0) {
                                                G.Menu.replace(35, N(G.Menu.item(35)) - 1);
                                                G.Menu.replace(36, letterOf(this.a, S(this.a).length));
                                            }
                                        }
                                    }
                                    if (B(equals(this.c, "1")) && B(!B(equals(G.Inventory_2.item(N(G.Inventory) + 1), "戦車重機関銃")))) {
                                        G.Motion.replace(10, "-10");
                                    }
                                }
                                else if (S(this.a).toLowerCase().includes(S("オーバーヒート").toLowerCase())) {
                                    if (B(!B(Full)) && compare("0", G.Inventory_2.item(N(G.Inventory) + 3)) < 0) {
                                        G.Inventory_2.replace(N(G.Inventory) + 3, 0 - N(G.Inventory_2.item(N(G.Inventory) + 3)));
                                    }
                                }
                            }
                        }
                    }
                }
                else {
                    // 短いタップで満タンのサブ武器へ切り替える
                    if (B(!B(B(equals(G.Menu.item(6), "3")) && compare("0", G.Menu.item(7)) < 0)) &&
                        compare("0", this.Hold_click) < 0 && compare(this.Hold_click, N(0.176) * N(G.FPS)) < 0) {
                        if (B(equals(this.Mouse_touch, "Shot")) && B(!this.rt.keyIsPressed(S("space")))) {
                            if (B(equals(G.Mobile_2.item(23), "0")) || (B(equals(G.Mobile_2.item(23), "1")) && B(compare(G.Mobile_2.item(24), "100") < 0))) {
                                this.c = "5";
                                this.d = "-1";
                                for (let i = 0; i < 5; i++) {
                                    this.c = N(this.c) - 1;
                                    const slotBase = N(this.c) * 6;
                                    if (S(G.Inventory_2.item(slotBase + 2)).toLowerCase().includes(S("サブ").toLowerCase()) &&
                                        B(!B(compare(G.Inventory_2.item(slotBase + 3), G.Inventory_2.item(slotBase + 4)) < 0))) {
                                        this.d = this.c;
                                    }
                                    if (!this.rt.warpActive)
                                        yield;
                                }
                                this.d = N(this.d) + 1;
                                if (B(!B(equals(this.d, "0")))) {
                                    this.b = N(N(this.d) - 1) * 6;
                                    this.a = G.Inventory_2.item(N(this.b) + 2);
                                    if (B(!B(equals(G.Motion.item(2), "5"))))
                                        G.Motion.replace(1, "0");
                                    G.Menu.replace(17, "1");
                                    G.Menu.replace(18, G.Inventory_2.item(31));
                                    G.Inventory_2.replace(31, this.d);
                                }
                            }
                        }
                    }
                    this.Hold_click = "0";
                }
            }
            // ---- 待機・特殊武器モーション ----
            const idleGate = B(equals(this.a, "")) ||
                (B(!B(Scoping)) && (((B(!B(Click)) || (B(Click) && B(equals(G.Special_weapon, "0")) && compare("0", G.Menu.item(64)) < 0)) || B(!B(Attack_ok))) && compare(G.Menu.item(36), "1") < 0));
            if (idleGate) {
                if (B(equals(G.Special_weapon, "0")) && compare("0", G.Menu.item(64)) < 0) {
                    // 特殊武器の使用モーション（Menu[64] が種別）
                    if (B(equals(G.Menu.item(64), "1"))) {
                        G.Motion.replace(1, "62");
                        G.Motion.replace(2, "9");
                    }
                    if (B(equals(G.Menu.item(64), "2"))) {
                        G.Motion.replace(1, "0");
                        G.Motion.replace(2, "10");
                    }
                    if (B(equals(G.Menu.item(64), "3"))) {
                        G.Motion.replace(1, "90");
                        G.Motion.replace(2, "11");
                    }
                    if (B(equals(G.Menu.item(64), "4"))) {
                        G.Motion.replace(1, "0");
                        G.Motion.replace(2, "16");
                    }
                    if (B(equals(G.Menu.item(64), "5"))) {
                        G.Motion.replace(1, "0");
                        G.Motion.replace(2, "17");
                    }
                    G.Menu.replace(46, "1");
                    G.Menu.replace(64, "0");
                }
                else {
                    if (S(this.a).toLowerCase().includes(S("オーバーヒート").toLowerCase())) {
                        if (B(!B(Full)) && compare("0", G.Inventory_2.item(N(G.Inventory) + 3)) < 0) {
                            G.Inventory_2.replace(N(G.Inventory) + 3, 0 - N(G.Inventory_2.item(N(G.Inventory) + 3)));
                        }
                    }
                    const rifleLike = S(this.a).toLowerCase().includes(S("ライフル").toLowerCase()) || S(this.a).toLowerCase().includes(S("ランチャー").toLowerCase());
                    if (rifleLike && (compare("0.5", mathop("abs", N(G.X) - N(G.Menu.item(10)))) < 0 || compare("0.5", mathop("abs", N(G.Y) - N(G.Menu.item(11)))) < 0)) {
                        G.Motion.replace(1, N(G.Motion.item(1)) + 442 / N(G.FPS));
                        G.Motion.replace(2, "3");
                    }
                    else {
                        if (B(!B(B(equals(G.Motion.item(2), "0")) || B(equals(G.Motion.item(2), "4"))))) {
                            G.Motion.replace(1, "0");
                        }
                        if (rifleLike) {
                            G.Motion.replace(1, N(G.Motion.item(1)) + N(G.FPS_temp));
                            G.Motion.replace(2, "4");
                        }
                        else if (S(this.a).toLowerCase().includes(S("シールドキャノン").toLowerCase())) {
                            G.Motion.replace(2, "7");
                        }
                        else if (S(this.a).toLowerCase().includes(S("戦車").toLowerCase())) {
                            if (B(equals(this.a, "戦車サブ"))) {
                                G.Motion.replace(1, "-62");
                                G.Motion.replace(2, "8");
                            }
                            else {
                                G.Motion.replace(2, "8");
                            }
                        }
                        else {
                            G.Motion.replace(1, N(G.Motion.item(1)) + 136 / N(G.FPS));
                            G.Motion.replace(2, "0");
                        }
                    }
                }
            }
        }
        yield* this.CSM_menu("36", "-1", "C", "0");
    }
    // procedure: "Draw screen effect"
    *Draw_screen_effect() {
        // 画面メッセージ（Kill / Money）の表示と決済。レコードは 10 フィールド組で
        // [2]=種別 [6]=相手名 [7..8]=表示位置 [9]=寿命カウンタ [10]=Kill の tier。
        // 位置と寿命は CS val で毎フレーム書き戻され、寿命 210 超で削除される。
        if (B((B((compare("225", this.rt.mouse.x) < 0)) && B((compare("165", this.rt.mouse.y) < 0))))) {
            G.Menu.replace(22, "1");
        }
        else {
            G.Menu.replace(22, "0");
        }
        this.rotationStyle = "all around";
        this.a = "0";
        const records = Math.max(0, Math.floor(N((N(this.Screen_effect.length) / N(10)))));
        for (let r = 0; r < records; r++) {
            this.b = "0";
            this.Temp1_2.deleteAll();
            for (let i = 0; i < 10; i++) {
                this.b = N(this.b) + N(1);
                this.Temp1_2.add(this.Screen_effect.item((N(this.a) + N(this.b))));
                if (!this.rt.warpActive)
                    yield;
            }
            yield* this.Pen_mode();
            if (B((B(equals(this.Temp1_2.item(2), "Kill message")) || B(equals(this.Temp1_2.item(2), "Money message"))))) {
                G.Menu.replace(22, "1");
                this.gotoXY(this.Temp1_2.item(7), this.Temp1_2.item(8));
                this.pointInDirection(90);
                this.size = N(100);
                this.switchCostume("Kill effect");
                this.stamp();
                if (B(equals(this.Temp1_2.item(2), "Kill message"))) {
                    this.b = "0";
                    this.c = "0";
                    const allRecords = Math.max(0, Math.floor(N((N(this.Screen_effect.length) / N(10)))));
                    for (let r = 0; r < allRecords; r++) {
                        if (B((!B(equals(this.a, this.b))))) {
                            if (B(equals(this.Screen_effect.item((N(this.b) + N(2))), "Kill message"))) {
                                if (B((compare(this.a, this.b) < 0))) {
                                    this.c = N(this.c) + N(1);
                                }
                                else {
                                    this.d = (N(this.Screen_effect.item((N(this.b) + N(10)))) + N(1));
                                    if (B((compare(this.Temp1_2.item(10), this.d) < 0))) {
                                        yield* this.CS_val("10", this.d, "S");
                                    }
                                }
                            }
                        }
                        this.b = N(this.b) + N(10);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    // Kill の決済は初回表示（[9] == 0）のときだけ: tier で Kill_point を加算（特殊武器は 0.5）
                    if (B(equals(this.Temp1_2.item(9), "0"))) {
                        if (B(equals(G.Special_weapon, "1"))) {
                            this.Kill_point = N(this.Kill_point) + N(0.5);
                        }
                        else {
                            if (B(equals(this.Temp1_2.item(10), "0"))) {
                                this.Kill_point = N(this.Kill_point) + N(1);
                            }
                            if (B(equals(this.Temp1_2.item(10), "1"))) {
                                this.Kill_point = N(this.Kill_point) + N(2);
                            }
                            if (B(equals(this.Temp1_2.item(10), "2"))) {
                                this.Kill_point = N(this.Kill_point) + N(2);
                            }
                            if (B(equals(this.Temp1_2.item(10), "3"))) {
                                this.Kill_point = N(this.Kill_point) + N(3);
                            }
                            if (B((compare("3", this.Temp1_2.item(10)) < 0))) {
                                this.Kill_point = N(this.Kill_point) + N(3);
                            }
                        }
                        if (B((compare(this.Rank.item("last"), this.Kill_point) < 0))) {
                            this.Kill_point = this.Rank.item("last");
                        }
                    }
                    if (B((compare(this.Temp1_2.item(9), "195") < 0))) {
                        yield* this.CS_val("7", (N((N(-165) - N(this.Temp1_2.item(7)))) / N(2)), "C");
                    }
                    else {
                        yield* this.CS_val("7", (N((N(-315) - N(this.Temp1_2.item(7)))) / N(2)), "C");
                    }
                    yield* this.CS_val("8", (N((N((N(-85) + N((N(this.c) * N(35))))) - N(this.Temp1_2.item(8)))) / N(2)), "C");
                    yield* this.CS_val("9", "1", "C");
                    if (B((compare("210", this.Temp1_2.item(9)) < 0))) {
                        this.Delete_screen_effect.add(this.a);
                    }
                    yield* this.Pen_mode();
                    this.changeXBy(-65);
                    this.changeYBy(5);
                    this.setEffect("BRIGHTNESS", 100);
                    if (B(equals(this.Temp1_2.item(10), "0"))) {
                        this.b = "KILL";
                    }
                    if (B(equals(this.Temp1_2.item(10), "1"))) {
                        this.b = "DOUBLE KILL";
                    }
                    if (B(equals(this.Temp1_2.item(10), "2"))) {
                        this.b = "SUPER KILL";
                    }
                    if (B(equals(this.Temp1_2.item(10), "3"))) {
                        this.b = "ULTRA KILL";
                    }
                    if (B((compare("3", this.Temp1_2.item(10)) < 0))) {
                        this.b = "MASTER KILL";
                    }
                    yield* this.Draw_text(this.b, "50", "L", this.x);
                    this.changeXBy(1);
                    this.changeYBy(-11);
                    if (B((compare("12", S(this.Temp1_2.item(6)).length) < 0))) {
                        yield* this.Draw_text(this.Temp1_2.item(6), (N(40) - N((N(15) / N((N(7) / N((N(S(this.Temp1_2.item(6)).length) - N(13)))))))), "L", this.x);
                    }
                    else {
                        yield* this.Draw_text(this.Temp1_2.item(6), "40", "L", this.x);
                    }
                    this.setEffect("BRIGHTNESS", 0);
                }
                else {
                    if (B((compare(this.Temp1_2.item(9), "195") < 0))) {
                        yield* this.CS_val("7", (N((N(-165) - N(this.Temp1_2.item(7)))) / N(2)), "C");
                    }
                    else {
                        yield* this.CS_val("7", (N((N(-315) - N(this.Temp1_2.item(7)))) / N(2)), "C");
                    }
                    yield* this.CS_val("8", (N((N(-85) - N(this.Temp1_2.item(8)))) / N(2)), "C");
                    yield* this.CS_val("9", "1", "C");
                    if (B((B((compare("210", this.Temp1_2.item(9)) < 0)) || B((compare("400", G.X) < 0))))) {
                        this.Delete_screen_effect.add(this.a);
                    }
                    yield* this.Pen_mode();
                    this.changeXBy(-65);
                    this.changeYBy(5);
                    this.setEffect("BRIGHTNESS", 100);
                    yield* this.Draw_text("DAMAGE BONUS", "50", "L", this.x);
                    this.changeXBy(1);
                    this.changeYBy(-11);
                    yield* this.Draw_text((S("Money: ") + S(mathop("floor", (N(this.Match_damage) / N(35))))), "40", "L", this.x);
                    this.setEffect("BRIGHTNESS", 0);
                }
            }
            this.clearEffects();
            this.b = "0";
            for (let i = 0; i < 10; i++) {
                this.b = N(this.b) + N(1);
                this.Screen_effect.replace((N(this.a) + N(this.b)), this.Temp1_2.item(this.b));
                if (!this.rt.warpActive)
                    yield;
            }
            this.a = N(this.a) + N(10);
            if (!this.rt.warpActive)
                yield;
        }
        this.a = this.Delete_screen_effect.length;
        const delCount = Math.max(0, Math.floor(N(this.Delete_screen_effect.length)));
        for (let r = 0; r < delCount; r++) {
            for (let i = 0; i < 10; i++) {
                this.Screen_effect.delete((N(this.Delete_screen_effect.item(this.a)) + N(1)));
                if (!this.rt.warpActive)
                    yield;
            }
            this.a = N(this.a) + N(-1);
            if (!this.rt.warpActive)
                yield;
        }
        this.Delete_screen_effect.deleteAll();
    }
    // procedure: "Draw NPC %s %s %s %s %s"
    *Draw_NPC(X, Y, direction, costume, num) {
        // ロビーの NPC 描画。プレイヤーが 75 以内かつショップ UI が閉じている
        // （Menu[20] が 520）とき、NPC ごとのショップ初期状態を Menu に書き込んで開く。
        // this.c は「触れた」フラグで、All が NPC 全体の表示可否に使う。
        yield* this.Pen_mode();
        this.gotoXY((N((N(X) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(Y) - N(G.All_camera_y))) * N(G.Zoom_temp)));
        if (B((B((compare(mathop("abs", (N(X) - N(G.X))), "75") < 0)) && B((compare(mathop("abs", (N(Y) - N(G.Y))), "75") < 0))))) {
            if (B(equals(Math.round(N(G.Menu.item(20))), "520"))) {
                if (B(equals(num, "1"))) {
                    G.Menu.replace(25, "1");
                    G.Menu.replace(26, "1");
                    G.Menu.replace(27, "1");
                    G.Menu.replace(31, (N(-91) - N((N((N(G.Menu.item(29)) - N(1))) * N(7.5)))));
                }
                if (B(equals(num, "2"))) {
                    G.Menu.replace(25, "1");
                    G.Menu.replace(26, G.Shop_menu.itemNum("Bomb"));
                    G.Menu.replace(27, G.Shop_menu.itemNum("Bomb"));
                    G.Menu.replace(31, (N(-91) - N((N((N(G.Menu.item(29)) - N(1))) * N(7.5)))));
                }
                if (B(equals(num, "3"))) {
                    G.Menu.replace(25, "2");
                    G.Menu.replace(26, "0");
                    G.Menu.replace(27, "0");
                    G.Menu.replace(31, "20");
                    if (B(equals(G.Menu.item(76), "0"))) {
                        G.Menu.replace(76, "1");
                    }
                }
                if (B(equals(num, "4"))) {
                    G.Menu.replace(25, "0");
                }
                if (B(equals(num, "6"))) {
                    G.Menu.replace(25, "1");
                    G.Menu.replace(26, G.Shop_menu.itemNum("Curse"));
                    G.Menu.replace(27, G.Shop_menu.itemNum("Curse"));
                    G.Menu.replace(31, (N(-91) - N((N((N(G.Menu.item(29)) - N(1))) * N(7.5)))));
                }
                G.Menu.replace(28, "0");
                G.Menu.replace(19, num);
            }
            this.c = "1";
        }
        if (B((B((compare(mathop("abs", this.x), (N(250) / N(G.Zoom_temp))) < 0)) && B((compare(mathop("abs", this.y), (N(190) / N(G.Zoom_temp))) < 0))))) {
            this.pointInDirection(direction);
            yield* this.Stamp(this.x, this.y, this.b, (S(costume) + S(" body")));
            yield* this.Stamp((N((N((N(X) + N((N(mathop("sin", (N(direction) + N(this.a)))) * N(30))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(Y) + N((N(mathop("cos", (N(direction) + N(this.a)))) * N(30))))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, (S(costume) + S(" hand")));
            yield* this.Stamp((N((N((N(X) + N((N(mathop("sin", (N(direction) - N(this.a)))) * N(30))))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N((N(Y) + N((N(mathop("cos", (N(direction) - N(this.a)))) * N(30))))) - N(G.All_camera_y))) * N(G.Zoom_temp)), this.b, (S(costume) + S(" hand")));
        }
    }
    // procedure: "Direction to bullet [e, f]"
    *Direction_to_bullet__e__f() {
        // 最寄りプレイヤー（First number）の方向を e へ返す（f は相手の Y）。
        // atan の象限補正つき。ダミーモードではダミーから測る。
        if (B(equals(G.Not_hit, "0")) && B(equals(G.Buff_effect.item(12), "0"))) {
            this.e = G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(this.First_number))) + 2);
            this.f = G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(this.First_number))) + 3);
            this.e = N(mathop("atan", N(N(this.e) - N(this.Temp1_2.item(3))) / N(N(this.f) - N(this.Temp1_2.item(4))))) + N(compare(this.f, this.Temp1_2.item(4)) < 0) * 180;
        }
        else {
            this.e = N(mathop("atan", N(N(this.Dummy_X) - N(this.Temp1_2.item(3))) / N(N(this.Dummy_Y) - N(this.Temp1_2.item(4))))) + N(compare(this.Dummy_Y, this.Temp1_2.item(4)) < 0) * 180;
        }
    }
    // procedure: "Laser sight"
    *Laser_sight_2() {
        // レーザーサイト装着時、照準方向へ50グリッド単位で40点を Laser_sight へ置く
        // （Draw 系がこの点を辿って線を引く）。ランチャーは照準が横に15ずれる。
        this.Laser_sight.deleteAll();
        if (B(equals(G.Not_attack, "0")) && B(equals(G.Scoping, "1"))) {
            if (S(G.Inventory_2.item(N(G.Inventory) + 2)).toLowerCase().includes(S("レーザーサイト").toLowerCase())) {
                if (B(equals(G.Motion.item(1), "-62"))) {
                    if (S(G.Inventory_2.item(N(G.Inventory) + 2)).toLowerCase().includes(S("ランチャー").toLowerCase())) {
                        this.c = N(mathop("sin", N(G.Motion.item(3)) + 90)) * 15;
                        this.d = N(mathop("cos", N(G.Motion.item(3)) + 90)) * 15;
                    }
                    else {
                        this.c = "0";
                        this.d = "0";
                    }
                    this.a = Math.round(N(N(N(G.X) + N(this.c)) / 50));
                    this.b = Math.round(N(N(N(G.Y) + N(this.d)) / 50));
                    for (let i = 0; i < 40; i++) {
                        this.a = N(this.a) + N(mathop("sin", G.Motion.item(3)));
                        this.b = N(this.b) + N(mathop("cos", G.Motion.item(3)));
                        this.Laser_sight.add(S(Math.round(N(this.a))) + S(S("/") + S(Math.round(N(this.b)))));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
            }
        }
    }
    // procedure: "Stamp %s %s %s %s"
    *Stamp(X, Y, size, costume) {
        // Pen_mode → 移動 → Set_size → スタンプ → Pen_mode の定型。
        yield* this.Pen_mode();
        this.gotoXY(X, Y);
        yield* this.Set_size(size, costume);
        this.stamp();
        yield* this.Pen_mode();
    }
    // procedure: "Draw character status bar %s %s %s %s"
    *Draw_character_status_bar(val, min, max, center) {
        // キャラステータスの偏差バー。center からの距離を 13/14 分割に量子化して描き、
        // 末尾で数値（小数2桁）も Draw_text する。
        if (B((compare(val, center) < 0))) {
            this.a = (N(13) - N(Math.round(N((N(13) / N((N((N(min) - N(center))) / N((N(val) - N(center))))))))));
        }
        else {
            this.a = (N(13) + N(Math.round(N((N(14) / N((N((N(max) - N(center))) / N((N(val) - N(center))))))))));
        }
        const bars = Math.max(0, Math.floor(N(this.a)));
        for (let r = 0; r < bars; r++) {
            this.penDown();
            this.changeYBy(-19);
            this.changeYBy(19);
            this.penUp();
            this.changeXBy(4);
            if (!this.rt.warpActive)
                yield;
        }
        this.setX(-122);
        this.a = (N(this.y) - N(24));
        this.changeYBy(-10);
        yield* this.Draw_text((N(Math.round(N((N(val) * N(100))))) / N(100)), "75", "L", this.x);
        this.gotoXY(-232, this.a);
    }
    // procedure: "Draw player search"
    *Draw_player_search() {
        // Menu[73]/[74] への探索線、Cyborg Pico のスコープ透視（相手の体力を透明度に）、
        // Menu[68]/[114] の追跡線。末尾の「My_shot が 40 件超で Inventory_2 全消去」は原作のクセ（そのまま保持）。
        if (B((!B(equals(G.Menu.item(73), "-"))))) {
            this.gotoXY((N((N(0) - N(G.Camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.Camera_y))) * N(G.Zoom_temp)));
            this.setPenColor("#00ff6a");
            this.setPenSize((N(7) * N(G.Zoom_temp)));
            this.setPenParam(S("transparency"), 80);
            this.penDown();
            this.gotoXY((N((N(G.Menu.item(73)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.Menu.item(74)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            this.penUp();
        }
        if (B((B(equals(G.Scoping, "1")) && B(equals(G.Character_name, "Cyborg Pico"))))) {
            if (B((!B(equals(this.First_number, "0000"))))) {
                this.a = G.ID_num.item(G.IDs.itemNum(this.First_number));
                if (B((compare("20", G.CLOUD.item((N(this.a) + N(22)))) < 0))) {
                    this.gotoXY((N((N(0) - N(G.Camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.Camera_y))) * N(G.Zoom_temp)));
                    this.setPenColor("#ff00dc");
                    this.setPenSize((N(10) * N(G.Zoom_temp)));
                    this.setPenParam(S("transparency"), (N(100) - N((N(G.CLOUD.item((N(this.a) + N(22)))) - N(20)))));
                    this.penDown();
                    this.gotoXY((N((N(G.CLOUD.item((N(this.a) + N(2)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.CLOUD.item((N(this.a) + N(3)))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                    this.penUp();
                }
            }
        }
        if (B((B((!B(equals(G.Menu.item(68), "0")))) || B((!B(equals(G.Menu.item(114), "0"))))))) {
            if (B(equals(G.Menu.item(114), "0"))) {
                this.a = G.Menu.item(68);
                this.a = G.ID_num.item(G.IDs.itemNum(this.a));
            }
            else {
                this.a = G.Menu.item(114);
                this.a = G.ID_num.item(G.IDs.itemNum(this.a));
                if (B((compare(G.CLOUD.item((N(this.a) + N(2))), "400") < 0))) {
                    G.Menu.replace(114, "0");
                }
            }
            this.gotoXY((N((N(0) - N(G.Camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.Camera_y))) * N(G.Zoom_temp)));
            this.setPenColor("#ff0000");
            this.setPenSize((N(10) * N(G.Zoom_temp)));
            this.setPenParam(S("color"), G.Team_color_2.item(G.CLOUD.item((N(this.a) + N(27)))));
            this.setPenParam(S("transparency"), 50);
            this.penDown();
            this.gotoXY((N((N(G.CLOUD.item((N(this.a) + N(2)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.CLOUD.item((N(this.a) + N(3)))) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            this.penUp();
        }
        if (B((compare("39", G.My_shot.length) < 0))) {
            G.Inventory_2.deleteAll();
        }
    }
    // procedure: "Fix position %s %s %s %s %s"
    *Fix_position(speed, X, Y, sen_x, sen_y) {
        // 共有フィールド f/g の1ステップ移動を speed 回試行し、Wall_position に当たる軸だけ巻き戻す。
        // 引数 X/Y は本体で使われない（原作のまま）。sen_x/sen_y は当たり判定の先読みオフセット。
        const steps = Math.max(0, Math.floor(N(speed)));
        for (let r = 0; r < steps; r++) {
            if (B((!B(equals(this.f, "0"))))) {
                this.e = G.X;
                G.X = N(G.X) + N(this.f);
                if (B((B(this.Wall_position.contains((S(Math.round(N((N((N(G.X) + N(sen_x))) / N(50))))) + S((S("/") + S(Math.round(N((N(G.Y) / N(50)))))))))) || B(this.Wall_position.contains((S(Math.round(N((N((N(G.X) + N(sen_x))) / N(50))))) + S((S("/") + S(Math.round(N((N((N(G.Y) + N(sen_y))) / N(50))))))))))))) {
                    G.X = this.e;
                }
            }
            if (B((!B(equals(this.g, "0"))))) {
                this.e = G.Y;
                G.Y = N(G.Y) + N(this.g);
                if (B((B(this.Wall_position.contains((S(Math.round(N((N(G.X) / N(50))))) + S((S("/") + S(Math.round(N((N((N(G.Y) + N(sen_y))) / N(50)))))))))) || B(this.Wall_position.contains((S(Math.round(N((N((N(G.X) + N(sen_x))) / N(50))))) + S((S("/") + S(Math.round(N((N((N(G.Y) + N(sen_y))) / N(50))))))))))))) {
                    G.Y = this.e;
                }
            }
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Set weapon"
    *Set_weapon() {
        // c に入れた武器名を、インベントリの最初の空きスロットへ Item_list から構築する。
        // スロットは [+1]=名前 [+2]=種別 [+3]=残弾 [+4]=容量 [+5..6]=0。
        // サブ武器は残弾が 容量×倍率（Item_list の名前+4）になる。
        // 注意: c は種別文字列で上書きされる（呼び出し側は毎回入れ直す）。
        this.a = "0";
        this.b = "";
        for (let i = 0; i < 5; i++) {
            if (B(equals(this.b, "")) && B(equals(G.Inventory_2.item(N(this.a) + 1), ""))) {
                this.b = this.a;
            }
            this.a = N(this.a) + 6;
            if (!this.rt.warpActive)
                yield;
        }
        if (B(!B(equals(this.b, "")))) {
            this.a = G.Weapon.item(G.Weapon_name.itemNum(this.c));
            G.Inventory_2.replace(N(this.b) + 1, this.c);
            this.c = G.Item_list.item(N(this.a) + 1);
            G.Inventory_2.replace(N(this.b) + 2, this.c);
            if (S(this.c).toLowerCase().includes(S("サブ").toLowerCase())) {
                G.Inventory_2.replace(N(this.b) + 3, N(G.Item_list.item(N(this.a) + 2)) * N(G.Item_list.item(N(this.a) + 4)));
                G.Inventory_2.replace(N(this.b) + 4, G.Item_list.item(N(this.a) + 2));
            }
            else {
                G.Inventory_2.replace(N(this.b) + 3, G.Item_list.item(N(this.a) + 2));
                G.Inventory_2.replace(N(this.b) + 4, G.Item_list.item(N(this.a) + 2));
            }
            G.Inventory_2.replace(N(this.b) + 5, "0");
            G.Inventory_2.replace(N(this.b) + 6, "0");
        }
    }
    // procedure: "Put buff %s %s"
    *Put_buff(buff_name, frame) {
        // バフ付与。Buff_Debuff は [名前, 残りフレーム] の組で、既存なら長い方を残す。
        // 新規付与は、Buff_effect[7] が立ち、かつ Buff 表の [+2] が "1" でないバフだけ半減する。
        if (B(G.Buff_Debuff.contains(buff_name))) {
            if (B((compare(G.Buff_Debuff.item((N(G.Buff_Debuff.itemNum(buff_name)) + N(1))), frame) < 0))) {
                G.Buff_Debuff.replace((N(G.Buff_Debuff.itemNum(buff_name)) + N(1)), frame);
            }
        }
        else {
            G.Buff_Debuff.add(buff_name);
            if (B(equals(G.Buff_effect.item(7), "0"))) {
                G.Buff_Debuff.add(frame);
            }
            else {
                if (B(equals(G.Buff.item((N((N((N(this.Buff_name.itemNum(buff_name)) - N(1))) * N(20))) + N(2))), "1"))) {
                    G.Buff_Debuff.add(frame);
                }
                else {
                    G.Buff_Debuff.add((N(frame) / N(2)));
                }
            }
        }
    }
    // procedure: "Draw skill gage"
    *Draw_skill_gage() {
        // スキルゲージの描画と F キー発動。ポイントは Max × Skill_2[+3] でクランプされる。
        if (B((compare((N(G.Max_skill_point) * N(G.Skill_2.item((N(G.Skill) + N(3))))), G.Skill_point) < 0))) {
            G.Skill_point = (N(G.Max_skill_point) * N(G.Skill_2.item((N(G.Skill) + N(3)))));
        }
        if (B((compare("0", G.Menu.item(38)) < 0))) {
            this.setPenColor("#0015ff");
        }
        else {
            this.setPenColor("#000000");
        }
        this.setPenParam(S("transparency"), 100);
        this.setPenSize(6);
        this.penDown();
        this.setPenParam(S("transparency"), 50);
        this.changeYBy(120);
        this.changeXBy(30);
        this.changeYBy(-160);
        this.changeXBy(-40);
        this.changeYBy(40);
        this.changeXBy(40);
        this.penUp();
        this.changeXBy(-36);
        this.changeYBy(-36);
        if (B((compare(G.Skill_point, G.Max_skill_point) < 0))) {
            this.setPenColor("#9a9a9a");
            this.d = "0";
        }
        else {
            this.setPenColor("#1d00ff");
            this.setPenParam(S("saturation"), (N(80) + N((N(mathop("sin", (N(this.rt.timer()) * N(250)))) * N(20)))));
            this.d = "1";
        }
        this.setPenSize(3);
        for (let i = 0; i < 18; i++) {
            this.penDown();
            this.changeXBy(31);
            this.penUp();
            this.changeXBy(-31);
            this.changeYBy(1.84);
            if (!this.rt.warpActive)
                yield;
        }
        this.changeXBy(16);
        this.changeYBy(-17.6);
        this.pointInDirection(90);
        this.switchCostume((S("@") + S(G.Skill_2.item((N(G.Skill) + N(1))))));
        this.size = N(85);
        this.stamp();
        yield* this.Pen_mode();
        this.changeYBy(-20);
        this.a = G.Skill_2.item((N(G.Skill) + N(3)));
        if (B((compare("1", this.a) < 0))) {
            this.changeXBy((N((N(this.a) - N(1))) * N(-6)));
            this.b = "0";
            const pips = Math.max(0, Math.floor(N(this.a)));
            for (let r = 0; r < pips; r++) {
                this.b = N(this.b) + N(1);
                if (B((compare(this.b, (N(mathop("floor", (N(G.Skill_point) / N(G.Max_skill_point)))) + N(1))) < 0))) {
                    this.setPenColor("#00ffff");
                }
                else {
                    this.setPenColor("#004e4e");
                }
                this.setPenSize(10);
                this.penDown();
                this.penUp();
                this.changeXBy(12);
                if (!this.rt.warpActive)
                    yield;
            }
            this.changeXBy((N((N((N(this.a) - N(1))) * N(-6))) - N(12)));
        }
        this.changeYBy(40.5);
        this.changeXBy(31);
        this.gotoXY(203.5, -129);
        this.setPenColor("#9a9a9a");
        this.setPenSize(3.3);
        for (let i = 0; i < 8; i++) {
            this.changeXBy(3);
            this.penDown();
            this.changeYBy(112);
            this.penUp();
            this.changeYBy(-112);
            if (!this.rt.warpActive)
                yield;
        }
        this.penDown();
        this.changeXBy(-21);
        this.changeYBy(112);
        this.changeXBy(21);
        this.penUp();
        this.gotoXY(203.5, -129);
        this.c = (N(112) / N((N(G.Max_skill_point) / N(G.Skill_point))));
        if (B(equals(this.c, "0"))) {
            yield* this.CSM_menu("37", "0", "M", "4");
        }
        else {
            yield* this.CSM_menu("37", (N(mod((N(this.c) - N(1)), 112)) + N(1)), "M", "4");
        }
        this.a = mathop("floor", (N(G.Skill_point) / N(G.Max_skill_point)));
        if (B((compare(G.Menu.item(39), this.a) < 0))) {
            this.rt.soundPlay("14a56b8ca2eb346d855817e5c1668bac.wav");
        }
        G.Menu.replace(39, this.a);
        this.setPenColor("#7664ff");
        for (let i = 0; i < 8; i++) {
            this.changeXBy(3);
            this.penDown();
            this.changeYBy(G.Menu.item(37));
            this.penUp();
            this.changeYBy((N(0) - N(G.Menu.item(37))));
            if (!this.rt.warpActive)
                yield;
        }
        this.penDown();
        this.changeXBy(-21);
        this.changeYBy(G.Menu.item(37));
        this.changeXBy(21);
        this.penUp();
        yield* this.Stamp("217", "-13", "120", "スキルゲージアイコン");
        if (B(equals(G.Skill_2.item((N(G.Skill) + N(1))), "狙撃ワープ"))) {
            this.a = G.ID_num.item(G.IDs.itemNum(G.Sniping_player));
            if (B((B((B(equals(G.CLOUD.item((N(this.a) + N(15))), "1")) || B((B((compare(G.CLOUD.item((N(this.a) + N(2))), "400") < 0)) || B((!B((compare("0", G.CLOUD.item((N(this.a) + N(20)))) < 0)))))))) || B(equals(G.Sniping_player, "0000"))))) {
                this.d = "0";
            }
        }
        // F キー発動: d == "1"（満タン表示中）かつ生存時のみ。全消費してスキル弾を撃ち、
        // クールダウン Menu[38] はスキル表 [+5/+7/+9] の最大値。X < 400 では Menu[92] = 600（ワープ待ち）
        if (B(equals(this.F_key, "1"))) {
            this.F_key = "0";
            if (B((B(equals(this.d, "1")) && B((compare("0", G.Health) < 0))))) {
                G.Skill_point = N(G.Skill_point) + N((N(0) - N(G.Max_skill_point)));
                yield* this.Get_mission_point("Skill", "1");
                yield* this.Shot__c((N(Math.round(N((N(G.Skill) / N(15))))) + N(900)), equals("", ""));
                this.a = "3";
                this.b = "0";
                for (let i = 0; i < 3; i++) {
                    this.a = N(this.a) + N(2);
                    this.c = (N((N(G.Skill_2.item((N(G.Skill) + N(this.a)))) + N(1))) - N(1));
                    if (B((compare(this.b, this.c) < 0))) {
                        this.b = this.c;
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                G.Menu.replace(38, this.b);
                if (B((compare(G.X, "400") < 0))) {
                    G.Menu.replace(92, "600");
                }
            }
        }
    }
    // procedure: "Get skill point %s %s"
    *Get_skill_point(kill, damage) {
        // スキルポイント加算。キルは 10、ダメージは damage / 10。どちらも Buff_effect[5] 倍。
        if (B(equals(kill, "1"))) {
            G.Skill_point = N(G.Skill_point) + N((N(10) * N(G.Buff_effect.item(5))));
        }
        else {
            G.Skill_point = N(G.Skill_point) + N((N((N(damage) / N(10))) * N(G.Buff_effect.item(5))));
        }
    }
    // procedure: "Draw teammate"
    *Draw_teammate() {
        // チームメンバーの行表示（最大5行）。this.c が Team リストの読み開始位置で、
        // All が自チーム見出しの位置を入れて呼ぶ。i は表示行番号。
        this.d = (N(163) + N((N(G.Menu.item(23)) - N(40))));
        this.h = (N((compare("1", G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Team_ID))) + N(28)))) < 0)) + N(0));
        this.i = "0";
        for (let i = 0; i < 5; i++) {
            this.e = G.Team.item(this.c);
            if (B(equals(this.e, ""))) {
                this.i = N(this.i) + N(1);
                G.Menu.replace((N(99) + N(this.i)), "-352");
            }
            else {
                if (B(equals(S(this.e).length, "5"))) {
                    this.e = N(this.e) + N(-20000);
                    // 名前が5文字組でない行は ID を4桁0埋めに直す
                    const pad = Math.max(0, Math.floor(N((N(4) - N(S(this.e).length)))));
                    for (let r = 0; r < pad; r++) {
                        this.e = (S("0") + S(this.e));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                if (B((!B(equals(this.e, G.ID))))) {
                    this.g = this.e;
                    this.e = G.ID_num.item(G.IDs.itemNum(this.e));
                    if (B((compare("400", G.CLOUD.item((N(this.e) + N(2)))) < 0))) {
                        this.i = N(this.i) + N(1);
                        if (B(equals(this.h, "1"))) {
                            G.Menu.replace(67, (N(G.Menu.item(67)) + N(1)));
                        }
                        if (B((B(equals(G.Menu.item(114), this.g)) || B((B((compare(this.rt.mouse.x, "-215") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.d))), "14") < 0))))))) {
                            yield* this.CSM_menu((N(99) + N(this.i)), "-237", "M", "4");
                            G.Menu.replace(68, this.g);
                            if (B((B((compare(this.rt.mouse.x, "-215") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.d))), "14") < 0))))) {
                                this.Mouse_touch = "Teammate marking";
                                this.Touch = this.g;
                            }
                        }
                        else {
                            yield* this.CSM_menu((N(99) + N(this.i)), "-352", "M", "4");
                        }
                        this.setPenColor("#252525");
                        this.setPenSize(28);
                        this.gotoXY(G.Menu.item((N(99) + N(this.i))), this.d);
                        this.penDown();
                        this.changeXBy(120);
                        this.penUp();
                        this.changeXBy(-120);
                        if (B(this.Team_chat.contains(this.g))) {
                            this.g = this.Team_chat.itemNum(this.g);
                            this.changeXBy(185);
                            this.setPenColor("#ffffff");
                            this.setPenSize(18);
                            this.changeXBy(-36);
                            this.penDown();
                            this.changeXBy(72);
                            this.penUp();
                            this.changeXBy(-36);
                            if (B(equals(G.Language, "1"))) {
                                yield* this.Stamp(this.x, this.y, "90", (S("Chat ") + S(this.Chat_2.item(this.Team_chat.item((N(this.g) + N(1)))))));
                            }
                            else {
                                this.setEffect("BRIGHTNESS", -100);
                                yield* this.Draw_text(this.Chat_2.item((N(this.Team_chat.item((N(this.g) + N(1)))) + N(100))), this.Team_chat.item((N(this.g) + N(2))), "C", this.x);
                                this.setEffect("BRIGHTNESS", 0);
                            }
                            this.changeXBy(-185);
                        }
                        this.g = G.Skill_2.itemNum(G.Character_2.item((N(G.CLOUD.item((N(this.e) + N(14)))) + N(2))));
                        this.setPenColor("#7664ff");
                        this.setPenSize(28);
                        this.penDown();
                        if (B((compare("0", G.CLOUD.item((N(this.e) + N(29)))) < 0))) {
                            this.changeXBy((N(120) / N((N(G.Skill_2.item((N(this.g) + N(1)))) / N((N(mod((N(G.CLOUD.item((N(this.e) + N(29)))) - N(1)), G.Skill_2.item((N(this.g) + N(1))))) + N(1)))))));
                        }
                        this.penUp();
                        if (B(equals(G.CLOUD.item((N(this.e) + N(24))), "1"))) {
                            yield* this.Stamp((N(G.Menu.item((N(99) + N(this.i)))) + N(15)), this.d, "60", (S(G.Character_2.item((N(G.CLOUD.item((N(this.e) + N(14)))) + N(1)))) + S(" body+")));
                        }
                        else {
                            yield* this.Stamp((N(G.Menu.item((N(99) + N(this.i)))) + N(15)), this.d, "60", (S(G.Character_2.item((N(G.CLOUD.item((N(this.e) + N(14)))) + N(1)))) + S(" body")));
                        }
                        this.f = G.CLOUD.item((N(this.e) + N((N(G.Number_of_data) - N(1)))));
                        this.a = "0";
                        this.b = "0";
                        const nameChars = Math.max(0, Math.floor(N(S(this.f).length)));
                        for (let r = 0; r < nameChars; r++) {
                            this.a = N(this.a) + N(1);
                            this.switchCostume((S("Font ") + S(letterOf(this.f, this.a))));
                            this.b = N(this.b) + N((N((N(this.Font_size___Draw.item(this.costumeNumberName("number"))) * N(2))) + N(2)));
                            if (!this.rt.warpActive)
                                yield;
                        }
                        this.b = N(this.b) + N(-2);
                        this.b = (N((N(84) / N(this.b))) * N(100));
                        this.changeXBy(18);
                        this.setY((N(this.d) + N(6)));
                        this.setEffect("COLOR", (N(G.Team_color_2.item(G.CLOUD.item((N(this.e) + N(27))))) * N(2)));
                        if (B((compare("65", this.b) < 0))) {
                            yield* this.Draw_text(this.f, "65", "L", this.x);
                        }
                        else {
                            yield* this.Draw_text(this.f, this.b, "L", this.x);
                        }
                        this.setEffect("COLOR", 0);
                        if (B((compare("-351", this.x) < 0))) {
                            this.setPenColor("#00f2ff");
                            this.setPenSize(7);
                            this.changeXBy(-32);
                            this.setY((N(this.d) - N(14)));
                            this.a = "0";
                            const pips = Math.max(0, Math.floor(N(G.Skill_2.item((N(this.g) + N(2))))));
                            for (let r = 0; r < pips; r++) {
                                this.a = N(this.a) + N(1);
                                if (B((compare(mathop("floor", (N(G.CLOUD.item((N(this.e) + N(29)))) / N(G.Skill_2.item((N(this.g) + N(1)))))), this.a) < 0))) {
                                    this.setPenColor("#252525");
                                }
                                this.penDown();
                                this.penUp();
                                this.changeXBy(9);
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            this.j = G.CLOUD.item((N(this.e) + N(20)));
                            this.k = G.CLOUD.item((N(this.e) + N(21)));
                            if (B((compare(this.j, (N(this.k) / N(4))) < 0))) {
                                this.setPenColor("#674747");
                            }
                            else {
                                if (B((compare(this.j, (N(this.k) / N(2))) < 0))) {
                                    this.setPenColor("#666747");
                                }
                                else {
                                    this.setPenColor("#4c6747");
                                }
                            }
                            this.setPenSize(8);
                            this.gotoXY((N(G.Menu.item((N(99) + N(this.i)))) + N(35)), (N(this.d) - N(7)));
                            this.penDown();
                            this.changeXBy(85);
                            this.penUp();
                            this.changeXBy(-85);
                            if (B((compare(this.j, (N(this.k) / N(4))) < 0))) {
                                this.setPenColor("#e60000");
                            }
                            else {
                                if (B((compare(this.j, (N(this.k) / N(2))) < 0))) {
                                    this.setPenColor("#faff00");
                                }
                                else {
                                    this.setPenColor("#2aff00");
                                }
                            }
                            this.penDown();
                            this.changeXBy((N(85) / N((N(this.k) / N(this.j)))));
                            this.penUp();
                        }
                        this.d = N(this.d) + N(-35);
                    }
                }
            }
            this.c = N(this.c) + N(1);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Draw screen stamp"
    *Draw_screen_stamp() {
        // Screen_stamp（6 フィールド組: [コスチューム, X, Y, 向き, サイズ, GHOST]）を
        // カメラ換算して一括スタンプする。
        this.a = "1";
        const records = Math.max(0, Math.floor(N((N(this.Screen_stamp.length) / N(6)))));
        for (let r = 0; r < records; r++) {
            this.setEffect("GHOST", this.Screen_stamp.item((N(this.a) + N(5))));
            this.pointInDirection(this.Screen_stamp.item((N(this.a) + N(3))));
            yield* this.Stamp((N((N(this.Screen_stamp.item((N(this.a) + N(1)))) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(this.Screen_stamp.item((N(this.a) + N(2)))) - N(G.All_camera_y))) * N(G.Zoom_temp)), (N(this.Screen_stamp.item((N(this.a) + N(4)))) * N(G.Zoom_temp)), this.Screen_stamp.item(this.a));
            this.setEffect("GHOST", 0);
            this.a = N(this.a) + N(6);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Draw map object %s %s %s"
    *Draw_map_object(X, Y, num) {
        // タレット / 車両パッドの状態更新と描画。G.Turrets は 15 フィールドレコードで、
        // num はその先頭オフセット（0 = 車両パッド、15 = 砲台）。
        // レコード: [1]=x [2]=y [3]=砲身の現在回転 [4]=仰角（搭載時は所有者 ID が入ることもある）
        //   [5]=透明度 [6]=車両名 or 仰角の現在値 [7]=タイマー（0..360 で 1 周）
        //   [8]=目標回転（"-" はアイドル） [9]=射程 [10]=発射クールダウン
        //   [11]=種別（Cannon / Missile） [12..13]=目標位置 [14]=リロード量
        // Temp1_2 へコピーして処理し、最後に書き戻す。引数 X/Y は描画用の画面座標。
        this.Temp1_2.deleteAll();
        for (let k = 1; k <= 15; k++) {
            this.Temp1_2.add(G.Turrets.item((N(num) + N(k))));
            if (!this.rt.warpActive)
                yield;
        }
        const T = this.Temp1_2;
        if (B(equals(this.rt.username, "uk-400"))) {
            if (B(this.rt.keyIsPressed(S("m")))) {
                T.replace(7, (N(T.item(7)) + N((N(5) * N(G.FPS_temp)))));
            }
        }
        if (B(equals(num, "0"))) {
            // 車両パッド: 操作者（Menu[73]）が居ない間タイマーが進む
            if (B(equals(G.Menu.item(73), "-")) && B((B(equals(this.rt.username, "uk-400")) || B(compare("3", G.Active_players) < 0)))) {
                T.replace(7, (N(T.item(7)) + N((N(0.133) * N(G.FPS_temp)))));
            }
            else {
                T.replace(3, "90");
                T.replace(4, "83");
                T.replace(7, "0");
            }
            if (B(compare("360", T.item(7)) < 0)) {
                // 搭乗: 同じグリッドセルに居て体力があれば車両の武器セットへ乗り換える
                if (B(equals(Math.round(N((N(T.item(1)) / N(50)))), Math.round(N((N(G.X) / N(50))))))
                    && B(equals(Math.round(N((N(T.item(2)) / N(50)))), Math.round(N((N(G.Y) / N(50))))))) {
                    if (B(compare("0", G.Health) < 0)) {
                        G.Object_trigger = (S((N(num) / N(10))) + S("100000"));
                        let sw = G.Special_weapon_2.itemNum(T.item(6));
                        G.Max_health = Math.round(N((N(G.Character_2.item((N(G.Character) + N(4)))) * N(G.Special_weapon_2.item((N(sw) + N(1)))))));
                        G.Health = G.Max_health;
                        G.Temp_inventory.deleteAll();
                        for (let k = 1; k <= 31; k++) {
                            G.Temp_inventory.add(G.Inventory_2.item(k));
                            if (!this.rt.warpActive)
                                yield;
                        }
                        G.Special_weapon = "1";
                        G.Inventory_2.deleteAll();
                        for (let s = 0; s < 5; s++) {
                            G.Inventory_2.add("");
                            G.Inventory_2.add("");
                            for (let k = 0; k < 4; k++) {
                                G.Inventory_2.add("0");
                                if (!this.rt.warpActive)
                                    yield;
                            }
                            if (!this.rt.warpActive)
                                yield;
                        }
                        G.Inventory_2.add("1");
                        sw = N(sw) + N(2);
                        let slot = "0";
                        const weapons = Math.max(0, Math.floor(N(G.Special_weapon_2.item(sw))));
                        for (let w = 0; w < weapons; w++) {
                            sw = N(sw) + N(1);
                            const wname = G.Special_weapon_2.item(sw);
                            G.Inventory_2.replace((N(slot) + N(1)), wname);
                            const wtype = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(wname))) + N(1)));
                            G.Inventory_2.replace((N(slot) + N(2)), wtype);
                            const capacity = G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(wname))) + N(2)));
                            if (B(S(wtype).toLowerCase().includes(S("サブ")))) {
                                G.Inventory_2.replace((N(slot) + N(3)), (N(capacity) * N(G.Item_list.item((N(G.Weapon.item(G.Weapon_name.itemNum(wname))) + N(4))))));
                            }
                            else {
                                G.Inventory_2.replace((N(slot) + N(3)), capacity);
                            }
                            G.Inventory_2.replace((N(slot) + N(4)), capacity);
                            slot = N(slot) + N(6);
                            if (!this.rt.warpActive)
                                yield;
                        }
                        T.replace(5, "0");
                        T.replace(7, "0");
                        G.Menu.replace(35, "0");
                        G.Menu.replace(36, "0");
                        yield* this.Put_buff("平和", "90");
                    }
                }
                if (B(compare(T.item(4), "82") < 0)) {
                    T.replace(4, (N(T.item(4)) + N((N(2) * N(G.FPS_temp)))));
                }
                else {
                    T.replace(4, "82");
                }
            }
            else {
                if (B(compare("348.933", T.item(7)) < 0)) {
                    // 搭乗直前: 仰角を 17 へ倒し、透明度を 100 へ
                    if (B(compare("17", T.item(4)) < 0)) {
                        T.replace(4, (N(T.item(4)) + N((N(-2) * N(G.FPS_temp)))));
                    }
                    else {
                        T.replace(4, "17");
                        if (B(compare(T.item(5), "100") < 0)) {
                            T.replace(5, (N(T.item(5)) + N((N(2) * N(G.FPS_temp)))));
                        }
                        else {
                            T.replace(5, "100");
                        }
                    }
                }
                else {
                    if (B(compare(T.item(7), "90") < 0)) {
                        if (B(compare(T.item(4), "82") < 0)) {
                            T.replace(4, (N(T.item(4)) + N((N(2) * N(G.FPS_temp)))));
                        }
                        else {
                            T.replace(4, "82");
                        }
                    }
                }
            }
        }
        else {
            T.replace(7, (N(T.item(7)) + N((N(0.25) * N(G.FPS_temp)))));
            this.c = "0";
            if (B(equals(T.item(8), "-"))) {
                // アイドル: 1 周したら同セルのプレイヤーを検知（c = "1" で接近表示）
                if (B(compare("360", T.item(7)) < 0)) {
                    if (B(equals(Math.round(N((N(T.item(1)) / N(50)))), Math.round(N((N(G.X) / N(50))))))
                        && B(equals(Math.round(N((N(T.item(2)) / N(50)))), Math.round(N((N(G.Y) / N(50))))))) {
                        this.c = "1";
                    }
                }
                else {
                    if (B(compare("328", T.item(7)) < 0)) {
                        // 328..360: 仰角 17 → 透明度 100 → 回転 90 の順に段階リセット
                        if (B(compare("17", T.item(4)) < 0)) {
                            T.replace(4, (N(T.item(4)) + N((N(-2) * N(G.FPS_temp)))));
                        }
                        else {
                            T.replace(4, "17");
                            if (B(compare(T.item(5), "100") < 0)) {
                                T.replace(5, (N(T.item(5)) + N((N(2) * N(G.FPS_temp)))));
                            }
                            else {
                                T.replace(5, "100");
                                if (B(compare(T.item(6), "90") < 0)) {
                                    T.replace(6, (N(T.item(6)) + N((N(2) * N(G.FPS_temp)))));
                                }
                                else {
                                    T.replace(6, "90");
                                }
                            }
                        }
                    }
                    else {
                        if (B(compare(T.item(7), "120") < 0)) {
                            // ..120: リロード → 仰角 → 透明度 → 82 の順に段階リセット
                            if (B(compare("0", T.item(14)) < 0)) {
                                T.replace(14, (N(T.item(14)) + N((N(-0.8) * N(G.FPS_temp)))));
                            }
                            else {
                                T.replace(14, "0");
                                if (B(compare("0", T.item(6)) < 0)) {
                                    T.replace(6, (N(T.item(6)) + N((N(-2) * N(G.FPS_temp)))));
                                }
                                else {
                                    T.replace(6, "0");
                                    if (B(compare("0", T.item(5)) < 0)) {
                                        T.replace(5, (N(T.item(5)) + N((N(-2) * N(G.FPS_temp)))));
                                    }
                                    else {
                                        T.replace(5, "0");
                                        if (B(compare(T.item(4), "82") < 0)) {
                                            T.replace(4, (N(T.item(4)) + N((N(2) * N(G.FPS_temp)))));
                                        }
                                        else {
                                            T.replace(4, "82");
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
            else {
                if (B(compare("-1", T.item(10)) < 0)) {
                    // 照準中: 砲身（3）と仰角（6、Cannon のみ）を目標（8 / 10）へ回す
                    let aligned = "0";
                    let diff = mod((N((N(T.item(8)) - N(T.item(3)))) + N(180)), 360);
                    if (B(compare(mathop("abs", (N(diff) - N(180))), mathop("ceiling", (N(2) * N(G.FPS_temp)))) < 0)) {
                        T.replace(3, T.item(8));
                        aligned = N(aligned) + N(1);
                        if (B(equals(T.item(11), "Missile"))) {
                            T.replace(14, (N(T.item(14)) + N((N(0.8) * N(G.FPS_temp)))));
                            if (B(compare("60", T.item(14)) < 0)) {
                                T.replace(14, "60");
                                T.replace(10, "-1");
                            }
                        }
                    }
                    else {
                        if (B(compare("180", diff) < 0)) {
                            T.replace(3, (N(T.item(3)) + N((N(2) * N(G.FPS_temp)))));
                        }
                        else {
                            T.replace(3, (N(T.item(3)) - N((N(2) * N(G.FPS_temp)))));
                        }
                    }
                    if (B(equals(T.item(11), "Cannon"))) {
                        diff = mod((N((N(T.item(10)) - N(T.item(6)))) + N(180)), 360);
                        if (B(compare(mathop("abs", (N(diff) - N(180))), mathop("ceiling", (N(2) * N(G.FPS_temp)))) < 0)) {
                            T.replace(6, T.item(10));
                            aligned = N(aligned) + N(1);
                        }
                        else {
                            if (B(compare("180", diff) < 0)) {
                                T.replace(6, (N(T.item(6)) + N((N(2) * N(G.FPS_temp)))));
                            }
                            else {
                                T.replace(6, (N(T.item(6)) - N((N(2) * N(G.FPS_temp)))));
                            }
                        }
                        if (B(equals(aligned, "2"))) {
                            T.replace(10, "-1");
                        }
                    }
                }
                else {
                    // 発射カウントダウン: item10 が下限を割ったら撃つ
                    const savedCd = T.item(10);
                    T.replace(10, (N(T.item(10)) - N(G.FPS_temp)));
                    if (B(equals(T.item(11), "Cannon"))) {
                        if (B(compare(T.item(10), "-60") < 0)) {
                            this.rt.soundPlay("e8c28ed5ac4a2e7c4a12bef8fffcfded.wav");
                            G.Bullet_and_effect.add(T.item(4));
                            G.Bullet_and_effect.add("迫撃砲弾");
                            G.Bullet_and_effect.add(T.item(1));
                            G.Bullet_and_effect.add(T.item(2));
                            G.Bullet_and_effect.add(T.item(3));
                            G.Bullet_and_effect.add((N(mathop("sin", T.item(6))) * N(T.item(9))));
                            G.Bullet_and_effect.add((N((N(mathop("cos", T.item(6))) * N(T.item(9)))) / N(2)));
                            G.Bullet_and_effect.add("100");
                            G.Bullet_and_effect.add("0");
                            G.Bullet_and_effect.add("0");
                            T.replace(4, "17");
                            T.replace(8, "-");
                        }
                    }
                    else {
                        if (B(compare(T.item(10), "-15") < 0)) {
                            // ミサイル: 10 フレーム周期の位相が進んだフレームだけ発射する
                            T.replace(10, (N(T.item(10)) - N(G.FPS_temp)));
                            const phaseB = (N((compare(mod((N(T.item(10)) + N(5)), 10), mod((N(savedCd) + N(5)), 10)) > 0)) + N(0));
                            const phaseA = (N((compare(mod(T.item(10), 10), mod(savedCd, 10)) > 0)) + N(0));
                            let ang = random(1, 360);
                            const spread = random(0, 400);
                            const fx = (N((N(T.item(12)) + N((N(mathop("sin", ang)) * N(spread))))) - N(T.item(1)));
                            const gy = (N((N(T.item(13)) + N((N(mathop("cos", ang)) * N(spread))))) - N(T.item(2)));
                            ang = (N(mathop("sqrt", (N((N(fx) * N(fx))) + N((N(gy) * N(gy)))))) / N(20));
                            if (B(compare("0", (N(phaseA) + N(phaseB))) < 0)) {
                                this.rt.soundPlay("8d2b27abe3dd60e5d71132e4ecbbbf20.wav");
                                G.Bullet_and_effect.add(T.item(4));
                                G.Bullet_and_effect.add("ミサイル");
                                G.Bullet_and_effect.add((N((N(T.item(1)) + N((N(mathop("sin", T.item(3))) * N(15))))) + N((N(mathop("sin", (N(T.item(3)) + N(90)))) * N((N(23) - N((N(phaseB) * N(46)))))))));
                                G.Bullet_and_effect.add((N((N(T.item(2)) + N((N(mathop("cos", T.item(3))) * N(15))))) + N((N(mathop("cos", (N(T.item(3)) + N(90)))) * N((N(23) - N((N(phaseB) * N(46)))))))));
                                G.Bullet_and_effect.add(T.item(3));
                                G.Bullet_and_effect.add(ang);
                                G.Bullet_and_effect.add((N(ang) / N(2)));
                                G.Bullet_and_effect.add((N(mathop("atan", (N(fx) / N(gy)))) + N((N((compare(gy, "0") < 0)) * N(180)))));
                                G.Bullet_and_effect.add("0");
                                G.Bullet_and_effect.add("100");
                            }
                            if (B(compare(T.item(10), "-165") < 0)) {
                                T.replace(4, "17");
                                T.replace(8, "-");
                            }
                        }
                    }
                }
            }
            if (B(equals(this.c, "1"))) {
                yield* this.CSM_menu("69", "160", "M", "4");
            }
            else {
                yield* this.CSM_menu("69", "520", "M", "4");
            }
        }
        if (B(compare("360", T.item(7)) < 0)) {
            T.replace(7, "360");
        }
        // 描画: 土台の円とタイマーの弧、土台スタンプ、ゲージ
        this.gotoXY(X, Y);
        this.pointInDirection(90);
        this.setPenColor("#000000");
        this.setPenSize((N(80) * N(G.Zoom_temp)));
        this.penDown();
        this.penUp();
        this.setPenColor("#737373");
        this.setPenSize((N(12.3) * N(G.Zoom_temp)));
        if (B(equals(S(T.item(4)).length, "4"))) {
            this.b = "17";
        }
        else {
            this.b = T.item(4);
        }
        this.a = this.b;
        this.c = mathop("floor", (N(this.a) / N(18)));
        for (let side = 0; side < 2; side++) {
            const ticks = Math.max(0, Math.floor(N(this.c)));
            for (let k = 0; k < ticks; k++) {
                this.gotoXY((N(X) + N((N(mathop("sin", this.a)) * N((N(43) * N(G.Zoom_temp)))))), (N(Y) + N((N(mathop("cos", this.a)) * N((N(43) * N(G.Zoom_temp)))))));
                this.penDown();
                this.gotoXY((N(X) + N((N(mathop("sin", this.a)) * N((N(-43) * N(G.Zoom_temp)))))), (N(Y) + N((N(mathop("cos", this.a)) * N((N(43) * N(G.Zoom_temp)))))));
                this.a = N(this.a) + N(-18);
                if (!this.rt.warpActive)
                    yield;
            }
            this.penUp();
            this.a = (N(this.b) + N(180));
            if (!this.rt.warpActive)
                yield;
        }
        this.penUp();
        yield* this.Stamp(X, Y, (N(100) * N(G.Zoom_temp)), "Turret base");
        this.a = T.item(7);
        if (B(compare("180", this.a) < 0)) {
            this.pointInDirection((N(this.a) - N(180)));
            yield* this.Stamp(X, Y, (N(100) * N(G.Zoom_temp)), "Turret gage1");
        }
        else {
            this.pointInDirection(this.a);
            yield* this.Stamp(X, Y, (N(100) * N(G.Zoom_temp)), "Turret gage2");
        }
        this.a = (N((N(50) + N((N(T.item(5)) / N(2))))) * N(G.Zoom_temp));
        if (B(equals(num, "0"))) {
            if (B(compare("353.35", T.item(7)) < 0)) {
                this.rotationStyle = "don't rotate";
                this.setEffect("GHOST", (N(100) - N(T.item(5))));
                if (B(equals(T.item(6), "戦車"))) {
                    yield* this.Stamp(X, Y, this.a, (S("+") + S(T.item(6))));
                }
                else {
                    yield* this.Stamp(X, Y, (N(this.a) * N((N(1.3) + N((N(mathop("sin", (N(this.rt.timer()) * N(150)))) * N(0.05)))))), (S("+") + S(T.item(6))));
                }
                this.setEffect("GHOST", 0);
                this.rotationStyle = "all around";
            }
        }
        else {
            if (B(equals(Math.round(N(this.b)), "17"))) {
                const scale = (N(this.a) / N(100));
                this.c = scale;
                this.pointInDirection(T.item(3));
                if (B(equals(T.item(11), "Missile"))) {
                    this.moveSteps((N(-17) * N(scale)));
                    this.turnLeft(90);
                    this.moveSteps((N((N(20) - N((N(14) / N((N(60) / N(T.item(14)))))))) * N(scale)));
                    this.turnRight(90);
                    this.setPenColor("#5a5a5a");
                    this.setPenSize((N(18) * N(scale)));
                    for (let k = 0; k < 2; k++) {
                        this.penDown();
                        this.moveSteps((N(34) * N(scale)));
                        this.moveSteps((N(-34) * N(scale)));
                        this.penUp();
                        this.turnRight(90);
                        this.moveSteps((N((N(2) * N((N(20) - N((N(14) / N((N(60) / N(T.item(14)))))))))) * N(scale)));
                        this.turnLeft(90);
                        if (!this.rt.warpActive)
                            yield;
                    }
                    yield* this.Stamp(X, Y, this.a, "Turret2");
                    this.moveSteps((N(17) * N(scale)));
                    if (B(compare("0", T.item(14)) < 0)) {
                        this.d = (N(0) - N(T.item(14)));
                        this.moveSteps((N(T.item(14)) * N(scale)));
                        if (B(compare("30", T.item(14)) < 0)) {
                            if (B(equals(T.item(14), "60"))) {
                                // 満タン時は目標へ赤い照準線を引く
                                this.setPenColor("#ff0000");
                                this.setPenSize((N(15) * N(scale)));
                                this.setPenParam(S("transparency"), 100);
                                this.penDown();
                                this.d = this.x;
                                this.e = this.y;
                                this.gotoXY((N((N(T.item(12)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(T.item(13)) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                                this.setPenParam(S("transparency"), 50);
                                this.gotoXY(this.d, this.e);
                                this.penUp();
                            }
                            this.setPenColor("#404040");
                            this.setPenSize((N(10) * N(scale)));
                            this.penDown();
                            this.moveSteps((N((N((N(0) - N(T.item(14)))) + N(30))) * N(scale)));
                            this.penUp();
                            this.d = "-30";
                        }
                        this.setPenColor("#5a5a5a");
                        this.setPenSize((N(15) * N(scale)));
                        this.penDown();
                        this.moveSteps((N(this.d) * N(scale)));
                        this.penUp();
                    }
                    this.moveSteps((N(-24) * N(scale)));
                    this.setPenColor("#737373");
                    this.setPenSize((N(20) * N(scale)));
                    this.penDown();
                    for (let k = 0; k < 20; k++) {
                        this.moveSteps((N(mathop("sin", T.item(6))) * N((N(1.2) * N(scale)))));
                        this.changePenParam(S("brightness"), (N(mathop("cos", T.item(6))) * N(1.25)));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                else {
                    yield* this.Stamp(X, Y, this.a, "Turret1");
                    this.setPenColor("#737373");
                    this.setPenSize((N(16) * N(scale)));
                    this.penDown();
                    for (let k = 0; k < 20; k++) {
                        this.moveSteps((N(mathop("sin", T.item(6))) * N((N(2) * N(scale)))));
                        this.changePenParam(S("brightness"), (N(mathop("cos", T.item(6))) * N(1.25)));
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
                this.penUp();
                this.gotoXY(X, Y);
                this.setPenColor("#000000");
                this.setPenSize((N(70.5) * N(G.Zoom_temp)));
                this.setPenParam(S("transparency"), T.item(5));
                this.penDown();
                this.penUp();
            }
        }
        for (let k = 1; k <= 15; k++) {
            G.Turrets.replace((N(num) + N(k)), T.item(k));
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Draw arrow"
    *Draw_arrow() {
        // チュートリアル用の誘導矢印。Menu[48] が位相（毎フレーム -1、負で 180 に巻き戻し）、
        // Menu[45] = (cos(位相)+1) × 距離 が矢印の進行量。ステップ 1/8/9 で経路が違う。
        // Menu[79] は作成者チェック用のカウンタで、90 に達すると Create_user_ID を作り直す。
        if (B((compare(G.Tutorial.item(2), "10") < 0))) {
            if (B(S("1 8 9").toLowerCase().includes(S(G.Tutorial.item(2)).toLowerCase()))) {
                yield* this.Pen_mode();
                this.setPenColor("#ff0000");
                this.setPenSize((N(8) * N(G.Zoom_temp)));
                yield* this.CSM_menu("48", "-1", "C", "0");
                if (B((compare(G.Menu.item(48), "0") < 0))) {
                    G.Menu.replace(45, "0");
                    G.Menu.replace(48, "180");
                }
                if (B(equals(G.Tutorial.item(2), "1"))) {
                    G.Menu.replace(45, (N((N(mathop("cos", G.Menu.item(48))) + N(1))) * N(600)));
                    this.gotoXY((N((N(0) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(0) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                    this.penDown();
                    yield* this.Arrow_bar("0", "0", "50");
                    yield* this.Arrow_bar("-90", "50", "750");
                    yield* this.Arrow_bar("0", "750", "850");
                    yield* this.Arrow_bar("90", "850", "1000");
                    yield* this.Arrow_bar("0", "1000", "1200");
                }
                if (B(equals(G.Tutorial.item(2), "8"))) {
                    G.Menu.replace(45, (N((N(mathop("cos", G.Menu.item(48))) + N(1))) * N(325)));
                    this.gotoXY((N((N(-550) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(350) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                    this.penDown();
                    yield* this.Arrow_bar("90", "0", "650");
                    this.setPenColor("#ff0000");
                    this.setPenSize((N(160) * N(G.Zoom_temp)));
                    this.setPenParam(S("transparency"), 80);
                    this.penDown();
                    this.penUp();
                    this.a = (N(100) / N((N(29) / N((N(58) - N((N(G.Tutorial.item(4)) + N(29))))))));
                    if (B((compare(this.a, "0") < 0))) {
                        this.a = "0";
                    }
                    this.setEffect("BRIGHTNESS", 100);
                    yield* this.Draw_text((S((N(Math.round(N((N(this.a) * N(10))))) / N(10))) + S("%")), (N(120) * N(G.Zoom_temp)), "C", this.x);
                    this.setEffect("BRIGHTNESS", 0);
                    this.setPenColor("#ff0000");
                    this.setPenSize((N(8) * N(G.Zoom_temp)));
                    this.penDown();
                }
                if (B(equals(G.Tutorial.item(2), "9"))) {
                    G.Menu.replace(45, (N((N(mathop("cos", G.Menu.item(48))) + N(1))) * N(425)));
                    this.gotoXY((N((N(100) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(350) - N(G.All_camera_y))) * N(G.Zoom_temp)));
                    this.penDown();
                    yield* this.Arrow_bar("90", "0", "100");
                    yield* this.Arrow_bar("180", "100", "200");
                    yield* this.Arrow_bar("90", "200", "350");
                    yield* this.Arrow_bar("180", "350", "450");
                    yield* this.Arrow_bar("-90", "450", "600");
                    yield* this.Arrow_bar("180", "600", "750");
                    yield* this.Arrow_bar("90", "750", "850");
                }
                this.setPenParam(S("transparency"), 60);
                this.turnRight(135);
                this.moveSteps((N(15) * N(G.Zoom_temp)));
                this.penUp();
                this.moveSteps((N(-15) * N(G.Zoom_temp)));
                this.turnRight(90);
                this.penDown();
                this.moveSteps((N(15) * N(G.Zoom_temp)));
                this.penUp();
            }
        }
        if (B((!B(equals(G.Menu.item(79), "-"))))) {
            if (B((compare(G.Menu.item(79), "90") < 0))) {
                if (B(equals(G.Menu.item(50), "2"))) {
                    G.Menu.replace(79, (N(G.Menu.item(79)) + N(G.FPS_temp)));
                }
            }
            else {
                if (B((B(equals(G.Creator, "1")) && B((compare((N(G.Menu.item(77)) + N(G.Menu.item(78))), "2") < 0))))) {
                    this.rt.stopAll();
                    return;
                }
                yield* this.Create_user_ID();
                G.Menu.replace(79, "-");
            }
        }
    }
    // procedure: "Arrow bar %s %s %s"
    *Arrow_bar(direction, start, finish) {
        // 矢印の1区間。Menu[45] が区間内なら矢じりを描いて残りを進み、外なら区間全長を素通りする。
        this.pointInDirection(direction);
        if (B((compare(start, G.Menu.item(45)) < 0))) {
            if (B((compare(G.Menu.item(45), finish) < 0))) {
                this.moveSteps((N((N(G.Menu.item(45)) - N(start))) * N(G.Zoom_temp)));
                this.turnRight(135);
                this.moveSteps((N(15) * N(G.Zoom_temp)));
                this.penUp();
                this.moveSteps((N(-15) * N(G.Zoom_temp)));
                this.turnRight(90);
                this.penDown();
                this.moveSteps((N(15) * N(G.Zoom_temp)));
                this.penUp();
                this.moveSteps((N(-15) * N(G.Zoom_temp)));
                this.turnRight(135);
                this.setPenParam(S("transparency"), 60);
                this.penDown();
                this.moveSteps((N((N(finish) - N(G.Menu.item(45)))) * N(G.Zoom_temp)));
            }
            else {
                this.moveSteps((N((N(finish) - N(start))) * N(G.Zoom_temp)));
            }
        }
        else {
            this.setPenParam(S("transparency"), 60);
            this.moveSteps((N((N(finish) - N(start))) * N(G.Zoom_temp)));
        }
    }
    // procedure: "Draw tutorial"
    *Draw_tutorial() {
        // チュートリアル枠のスタンプ。末尾の Check != "TACT-AIM" での stopAll は改竄検出（原作のまま）。
        if (B((compare(G.Tutorial.item(2), "10") < 0))) {
            this.pointInDirection(90);
            yield* this.Stamp("0", G.Tutorial.item(1), "100", "Tutorial frame");
            yield* this.Stamp("0", (N(G.Tutorial.item(1)) - N(G.Tutorial.item(3))), "100", "Tutorial bar");
            if (B(equals(G.Language, "1"))) {
                yield* this.Stamp("0", G.Tutorial.item(1), "100", (S("チュートリアル") + S(G.Tutorial.item(2))));
            }
            else {
                yield* this.Stamp("0", G.Tutorial.item(1), "100", (S("Tutorial") + S(G.Tutorial.item(2))));
            }
        }
        if (B((!B(equals(G.Check, "TACT-AIM"))))) {
            this.rt.stopAll();
            return;
        }
    }
    // procedure: "Reset dummy damage %s"
    *Reset_dummy_damage(damage) {
        // 2秒後に、ダミーダメージ表示がそのままなら 0 へ戻す。
        yield { waitSeconds: N(2) };
        if (B(equals(damage, G.Dummy_damage))) {
            G.Dummy_damage = "0";
        }
    }
    // procedure: "Hand position %s %s %s %s %s %s"
    *Hand_position(X, Y, direction, distance, hand_direction, num) {
        // 手の位置を Motion[num .. num+2] へ書く: 向き Motion[3] 基準で sin/cos 配置し、手の向きも記録する。
        G.Motion.replace(num, (N(X) + N((N(mathop("sin", (N(G.Motion.item(3)) + N(direction)))) * N(distance)))));
        G.Motion.replace((N(num) + N(1)), (N(Y) + N((N(mathop("cos", (N(G.Motion.item(3)) + N(direction)))) * N(distance)))));
        G.Motion.replace((N(num) + N(2)), mod((N(G.Motion.item(3)) + N(hand_direction)), 360));
    }
    // procedure: "Bullet action %s %s %b"
    *Bullet_action(v_name, size, Golden_Bot) {
        // 弾の振る舞いスクリプト（Bullet_list のデータ列）を1命令ずつ実行する解釈系。
        // 呼び出し側が d（読み位置）をセットし、各命令は Set bullet val で
        // 引数を Temp2_2 へ読み込んでから処理する。Temp1_2 は対象の弾レコード
        // （[1]=所有者 [2]=種別 [3..4]=位置 [5]=向き [6]=汎用値 [10]=ガード番号）。
        // IF 系は IF / IF_T_F の組で条件分岐を構成する（IF はラッチ）。
        const V = this.Temp2_2; // 引数レジスタ（Set bullet val が毎回作り直す）
        const T = this.Temp1_2; // 弾レコード
        if (B(equals(v_name, "IF END"))) {
            this.IF = "0";
            return;
        }
        if (B(equals(v_name, "IF"))) {
            yield* this.Set_bullet_val("3");
            const op = V.item(3);
            const cond = (B(equals(op, "<")) && compare(V.item(1), V.item(2)) < 0) ||
                (B(equals(op, "=")) && B(equals(V.item(1), V.item(2)))) ||
                (B(equals(op, "%")) && B(equals(mod(Math.round(N(V.item(1))), V.item(2)), "0")) &&
                    B(equals(mod(Math.round(N(N(V.item(1)) + N(G.FPS_temp))), V.item(2)), "1")));
            if (cond) {
                if (B(equals(this.IF, "0")))
                    this.IF_T_F = "T";
            }
            else {
                this.IF_T_F = "F";
            }
            this.IF = "1";
            return;
        }
        if (B(equals(v_name, "ELSE"))) {
            this.IF_T_F = B(equals(this.IF_T_F, "T")) ? "F" : "T";
            return;
        }
        if (B(equals(v_name, "Distance IF"))) {
            yield* this.Set_bullet_val("2");
            yield* this.Search_first__b(V.item(2), "-1");
            if (B(compare(this.First_distance, V.item(1)) < 0)) {
                if (B(equals(this.IF, "0")))
                    this.IF_T_F = "T";
            }
            else {
                this.IF_T_F = "F";
            }
            this.IF = "1";
            return;
        }
        if (B(equals(v_name, "CS val"))) {
            yield* this.Set_bullet_val("3");
            yield* this.CS_val(V.item(1), V.item(2), V.item(3));
            return;
        }
        if (B(equals(v_name, "Sound"))) {
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1"))) {
                yield* this.Make_sound(T.item(3), T.item(4), V.item(1));
            }
            return;
        }
        if (B(equals(v_name, "Step"))) {
            yield* this.Set_bullet_val("1");
            yield* this.Step(V.item(1), "5");
            return;
        }
        if (B(equals(v_name, "Roll step"))) {
            yield* this.Set_bullet_val("1");
            yield* this.Step(V.item(1), "6");
            return;
        }
        if (B(equals(v_name, "Length"))) {
            // 汎用値（引数1のフィールド）を進め、制限を超えたら生成物へ変換する
            yield* this.Set_bullet_val("8");
            if (B(equals(this.IF_ACT, "1"))) {
                yield* this.CS_val(V.item(1), "1", "C");
                if (B(compare(V.item(2), T.item(V.item(1))) < 0)) {
                    yield* this.Delete(V.item(3), V.item(4), V.item(5), V.item(6), V.item(7), V.item(8));
                }
            }
            return;
        }
        if (B(equals(v_name, "Damage"))) {
            // ダメージ1以上は所有者レコードの24番（CP頻度係数）が倍率になる
            yield* this.Set_bullet_val("9");
            this.Hit = "0";
            if (B(compare(V.item(1), "1") < 0)) {
                yield* this.Damage(V.item(1), V.item(2), V.item(3), V.item(4), V.item(5), V.item(6), V.item(7), V.item(8), V.item(9));
            }
            else {
                const scaled = N(V.item(1)) * N(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + 23));
                yield* this.Damage(scaled, V.item(2), V.item(3), V.item(4), V.item(5), V.item(6), V.item(7), V.item(8), V.item(9));
            }
            return;
        }
        if (B(equals(v_name, "Sword damage"))) {
            // 近接攻撃: 壁に当たれば跳ね返り、範囲と扇角で命中を判定する
            yield* this.Set_bullet_val("4");
            yield* this.Break_wall__b("", "", "", "", "", "");
            if (B(equals(this.Bullet_wall, "1"))) {
                G.Speed_x = 0 - N(G.Speed_x);
                G.Speed_y = 0 - N(G.Speed_y);
            }
            this.Hit = "0";
            this.e = G.ID_num.item(G.IDs.itemNum(T.item(1)));
            yield* this.CS_val("3", G.CLOUD.item(N(this.e) + 2), "S");
            yield* this.CS_val("4", G.CLOUD.item(N(this.e) + 3), "S");
            yield* this.CS_val("5", G.CLOUD.item(N(this.e) + 4), "S");
            if (B(equals(G.Not_hit, "1")) || (B(equals(G.Not_hit, "0")) && B(!B(equals(G.Team_ID, this.Bullet_team_ID))))) {
                if (B(equals(G.Not_hit, "1"))) {
                    this.e = N(this.Dummy_X) - N(T.item(3));
                    this.f = N(this.Dummy_Y) - N(T.item(4));
                }
                else {
                    this.e = N(G.X) - N(T.item(3));
                    this.f = N(G.Y) - N(T.item(4));
                }
                this.g = mathop("sqrt", N(this.e) * N(this.e) + N(this.f) * N(this.f));
                if (B(compare(this.g, V.item(2)) < 0)) {
                    if (B(compare(this.g, "30") < 0))
                        this.Hit = "1";
                    this.g = N(mathop("atan", N(this.e) / N(this.f))) + N(compare(this.f, "0") < 0) * 180;
                    if (B(equals(this.Hit, "0"))) {
                        const arc = mathop("abs", N(mod(N(N(this.g) - N(T.item(5))) + 180, 360)) - 180);
                        if (B(compare(arc, V.item(3)) < 0))
                            this.Hit = "1";
                    }
                    if (B(equals(this.Hit, "1"))) {
                        if (B(compare(V.item(1), "1") < 0)) {
                            this.Bullet_damage = N(this.Bullet_damage) + N(V.item(1));
                        }
                        else {
                            this.Bullet_damage = N(this.Bullet_damage) + N(V.item(1)) * N(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + 23));
                        }
                        if (B(equals(G.Not_hit, "1"))) {
                            G.Menu.replace(1, "5");
                        }
                        else if (B(equals(G.Buff_effect.item(12), "0"))) {
                            this.Hit_ID = T.item(1);
                            G.Speed_x = N(G.Speed_x) + N(mathop("sin", this.g)) * N(V.item(4));
                            G.Speed_y = N(G.Speed_y) + N(mathop("cos", this.g)) * N(V.item(4));
                        }
                        yield* this.Delete("-", "-", "-", "-", "-", "-");
                    }
                }
            }
            return;
        }
        if (B(equals(v_name, "Break wall"))) {
            yield* this.Set_bullet_val("6");
            yield* this.Break_wall__b(V.item(1), V.item(2), V.item(3), V.item(4), V.item(5), V.item(6));
            return;
        }
        if (B(equals(v_name, "Delete"))) {
            yield* this.Set_bullet_val("6");
            yield* this.Delete(V.item(1), V.item(2), V.item(3), V.item(4), V.item(5), V.item(6));
            return;
        }
        if (B(equals(v_name, "Stamp")) || B(equals(v_name, "Team stamp"))) {
            yield* this.Set_bullet_val("3");
            if (B(equals(this.IF_ACT, "1"))) {
                if (B(equals(v_name, "Team stamp"))) {
                    // マップ中央（x=3200）で R/B のチームカラーが切り替わる
                    if (B(compare(T.item(3), "3200") < 0)) {
                        this.setEffect("COLOR", N(G.Team_color_2.item(G.TEAMMODE_2.item(8))) * 2);
                    }
                    else {
                        this.setEffect("COLOR", N(G.Team_color_2.item(G.TEAMMODE_2.item(9))) * 2);
                    }
                }
                this.setEffect("GHOST", V.item(3));
                yield* this.Stamp(this.IDX, this.IDY, N(V.item(2)) * N(G.Zoom_temp), V.item(1));
                this.setEffect("GHOST", 0);
            }
            this.setEffect("COLOR", 0);
            return;
        }
        if (B(equals(v_name, "Create"))) {
            // 向きを一時的にずらして生成し、戻す
            yield* this.Set_bullet_val("7");
            if (B(equals(this.IF_ACT, "1"))) {
                T.replace(5, N(T.item(5)) + N(V.item(2)));
                yield* this.Create(V.item(1), V.item(3), V.item(4), V.item(5), V.item(6), V.item(7));
                T.replace(5, N(T.item(5)) - N(V.item(2)));
            }
            return;
        }
        if (B(equals(v_name, "Set length"))) {
            // 向き方向へ50刻みで壁を辿り、5刻みで戻って到達距離を引数1のフィールドへ書く
            yield* this.Set_bullet_val("2");
            if (B(equals(this.IF_ACT, "1"))) {
                this.e = T.item(3);
                this.f = T.item(4);
                this.g = "-50";
                this.Bullet_wall = "0";
                while (!B(compare(V.item(2), this.g) < 0 || B(equals(this.Bullet_wall, "1")))) {
                    this.g = N(this.g) + 50;
                    yield* this.Bullet_wall_2(S(Math.round(N(N(this.e) / 50))) + S(S("/") + S(Math.round(N(N(this.f) / 50)))), "1");
                    if (B(equals(this.Bullet_wall, "0"))) {
                        this.e = N(this.e) + N(mathop("sin", T.item(5))) * 50;
                        this.f = N(this.f) + N(mathop("cos", T.item(5))) * 50;
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
                while (!B(compare(this.g, "1") < 0 || B(equals(this.Bullet_wall, "0")))) {
                    this.e = N(this.e) + N(mathop("sin", T.item(5))) * -5;
                    this.f = N(this.f) + N(mathop("cos", T.item(5))) * -5;
                    this.g = N(this.g) - 5;
                    yield* this.Bullet_wall_2(S(Math.round(N(N(this.e) / 50))) + S(S("/") + S(Math.round(N(N(this.f) / 50)))), "0");
                    if (!this.rt.warpActive)
                        yield;
                }
                T.replace(V.item(1), this.g);
            }
            return;
        }
        if (B(equals(v_name, "Bush"))) {
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1"))) {
                const dist = mathop("sqrt", N(N(T.item(3)) - N(G.X)) * N(N(T.item(3)) - N(G.X)) + N(N(T.item(4)) - N(G.Y)) * N(N(T.item(4)) - N(G.Y)));
                if (B(compare(dist, V.item(1)) < 0)) {
                    G.Bush = "1";
                    G.Hiding = "1";
                }
            }
            return;
        }
        if (B(equals(v_name, "Set position"))) {
            // 所有者の座標 + 向きオフセットへ弾を置く
            yield* this.Set_bullet_val("2");
            if (B(equals(this.IF_ACT, "1"))) {
                const base = G.ID_num.item(G.IDs.itemNum(T.item(1)));
                yield* this.CS_val("3", N(G.CLOUD.item(N(base) + 2)) + N(mathop("sin", V.item(1))) * N(V.item(2)), "S");
                yield* this.CS_val("4", N(G.CLOUD.item(N(base) + 3)) + N(mathop("cos", V.item(1))) * N(V.item(2)), "S");
            }
            return;
        }
        if (B(equals(v_name, "Round slide"))) {
            // 対象フィールドが負なら条件成立、正なら滑らせて反転させる
            yield* this.Set_bullet_val("3");
            if (B(compare(T.item(V.item(2)), "0") < 0)) {
                if (B(equals(this.IF, "0")))
                    this.IF_T_F = "T";
            }
            else {
                this.IF_T_F = "F";
                if (B(equals(this.IF_ACT, "1"))) {
                    yield* this.Step(T.item(V.item(2)), V.item(1));
                    yield* this.CS_val(V.item(2), 0 - N(V.item(3)), "C");
                }
            }
            this.IF = "1";
            return;
        }
        if (B(equals(v_name, "Draw laser")) || B(equals(v_name, "Laser"))) {
            if (B(equals(v_name, "Draw laser"))) {
                yield* this.Set_bullet_val("4");
            }
            else {
                yield* this.Set_bullet_val("6");
            }
            if (B(equals(this.IF_ACT, "1"))) {
                if (B(!B(equals(V.item(1), "-")))) {
                    if (B(equals(V.item(1), "Fire"))) {
                        // 炎レーザー: 太さが細りながら色が変わる10重描画
                        this.setPenColor("#ff0000");
                        this.f = "1";
                        for (let i = 0; i < 10; i++) {
                            this.gotoXY(this.IDX, this.IDY);
                            this.setPenSize(N(V.item(3)) * N(this.f) * N(G.Zoom_temp));
                            this.setPenParam(S("transparency"), 100);
                            this.penDown();
                            this.setPenParam(S("transparency"), V.item(4));
                            this.moveSteps(N(V.item(2)) * N(G.Zoom_temp));
                            this.penUp();
                            this.f = N(this.f) - 0.08;
                            this.changePenParam(S("color"), 1.5);
                            this.changePenParam(S("brightness"), 10);
                            if (!this.rt.warpActive)
                                yield;
                        }
                    }
                    else {
                        this.gotoXY(this.IDX, this.IDY);
                        this.setPenColor(V.item(1));
                        this.setPenSize(N(V.item(3)) * N(G.Zoom_temp));
                        this.setPenParam(S("transparency"), 100);
                        this.penDown();
                        if (B(equals(V.item(4), "T"))) {
                            // チームレーザーは味方に薄く、敵には Golden_Bot 時のみ見える
                            if (B(equals(this.Bullet_team_ID, G.Team_ID))) {
                                this.setPenParam(S("transparency"), 50);
                            }
                            else if (B(Golden_Bot)) {
                                this.setPenParam(S("transparency"), 70);
                            }
                        }
                        else {
                            this.setPenParam(S("transparency"), V.item(4));
                        }
                        this.moveSteps(N(V.item(2)) * N(G.Zoom_temp));
                        this.penUp();
                    }
                }
                if (B(equals(v_name, "Laser"))) {
                    if (B(equals(V.item(4), "0")) || B(equals(V.item(5), "0"))) {
                        this.Hit = "0";
                        if (B(equals(V.item(5), "0"))) {
                            // 全プレイヤー対象: Laser detect が f を走査カウンタとして使う
                            this.f = N(G.CLOUD.length) / N(G.Number_of_data) + 1;
                            this.i = this.Dummy_X;
                            this.j = this.Dummy_Y;
                            yield* this.Laser_detect();
                        }
                        else {
                            this.f = "1";
                            if (B(equals(G.Not_hit, "1"))) {
                                this.i = this.Dummy_X;
                                this.j = this.Dummy_Y;
                            }
                            else {
                                this.i = G.X;
                                this.j = G.Y;
                            }
                            if (B(equals(G.Not_hit, "1")) || B(!B(equals(this.Bullet_team_ID, G.Team_ID)))) {
                                yield* this.Laser_detect();
                            }
                        }
                        if (B(equals(this.e, "-"))) {
                            this.Hit = "1";
                            if (B(!B(equals(V.item(5), "0")))) {
                                this.Hit_ID = T.item(1);
                                this.e = B(equals(V.item(6), "1")) ? N(V.item(5)) * N(G.FPS_temp) : V.item(5);
                                if (B(compare("1", V.item(5)) < 0)) {
                                    this.e = N(this.e) * N(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + 23));
                                }
                                this.Bullet_damage = N(this.Bullet_damage) + N(this.e);
                                if (B(equals(G.Not_hit, "1"))) {
                                    G.Menu.replace(1, "5");
                                }
                            }
                        }
                    }
                }
            }
            return;
        }
        if (B(equals(v_name, "Put buff"))) {
            // 命中時に確率でバフを付ける
            yield* this.Set_bullet_val("3");
            if (B(equals(this.IF_ACT, "1")) && B(equals(this.Hit, "1"))) {
                if ((compare(G.X, "400") < 0 || B(equals(G.Not_hit, "0"))) && B(equals(G.Buff_effect.item(12), "0"))) {
                    if (B(compare(N(random(1, 1000)) / 10, N(V.item(3)) + 0.01) < 0)) {
                        yield* this.Put_buff(V.item(1), V.item(2));
                    }
                }
            }
            return;
        }
        if (B(equals(v_name, "Put buff+"))) {
            // 範囲バフ: 引数4が 0 なら所有者本人、他は距離と対象（T=味方/E=敵）で判定
            yield* this.Set_bullet_val("5");
            if (B(equals(this.IF_ACT, "1"))) {
                if ((compare(G.X, "400") < 0 || B(equals(G.Not_hit, "0"))) && B(equals(G.Buff_effect.item(12), "0"))) {
                    if (B(equals(V.item(4), "0"))) {
                        if (B(equals(G.ID, T.item(1)))) {
                            if (B(compare(N(random(1, 1000)) / 10, N(V.item(3)) + 0.01) < 0)) {
                                yield* this.Put_buff(V.item(1), V.item(2));
                            }
                        }
                    }
                    else {
                        const targetOk = compare(G.X, "400") < 0 ||
                            (B(equals(V.item(5), "T")) && B(equals(G.Team_ID, this.Bullet_team_ID))) ||
                            (B(equals(V.item(5), "E")) && B(!B(equals(G.Team_ID, this.Bullet_team_ID))));
                        if (targetOk) {
                            yield* this.Distance_to_bullet__e();
                            if (B(compare(this.e, V.item(4)) < 0)) {
                                if (B(compare(N(random(1, 1000)) / 10, N(V.item(3)) + 0.01) < 0)) {
                                    yield* this.Put_buff(V.item(1), V.item(2));
                                }
                            }
                        }
                    }
                }
            }
            return;
        }
        if (B(equals(v_name, "Guard"))) {
            // ガードとの衝突: 耐久（弾レコードの引数2番フィールド）を削り、
            // 壊れたら生成物へ、耐えたら跳ね返し量をガード側へ蓄える
            yield* this.Set_bullet_val("8");
            this.Hit = "0";
            if (B(equals(this.IF_ACT, "1"))) {
                if (B(equals(V.item(4), "1"))) {
                    G.Guard.replace(N(T.item(10)) + 2, "A");
                }
                yield* this.CS_val(V.item(5), "-10", "C");
                if (B(compare(T.item(V.item(5)), "0") < 0)) {
                    yield* this.CS_val(V.item(5), "0", "S");
                }
                if (B(equals(random(1, 60), "1"))) {
                    if (G.Bullet_wall.contains(S(N(T.item(3)) / 50) + S(S("/") + S(N(T.item(4)) / 50)))) {
                        G.Guard.replace(N(T.item(10)) + 1, "");
                        if (B(equals(V.item(4), "0")) || B(equals(V.item(4), "1"))) {
                            yield* this.Make_sound(T.item(3), T.item(4), "ガード破壊");
                            yield* this.Delete("ガード破壊", "-", "-", "-", "-", "-");
                        }
                        else {
                            yield* this.Delete(V.item(4), "-", "-", "-", "-", "-");
                        }
                    }
                }
                this.e = N(T.item(10)) + 3;
                if (B(compare("0", G.Guard.item(this.e)) < 0)) {
                    this.Hit = "1";
                    yield* this.Make_sound(T.item(3), T.item(4), B(compare(G.Guard.item(this.e), "50") < 0) ? "ガード（小）" : "ガード（大）");
                    yield* this.CS_val(V.item(5), "50", "S");
                    yield* this.CS_val(V.item(2), G.Guard.item(this.e), "M");
                    G.Guard.replace(this.e, "0");
                }
                yield* this.CS_val(V.item(2), V.item(3), "C");
                if (B(compare(V.item(1), T.item(V.item(2))) < 0)) {
                    G.Guard.replace(N(T.item(10)) + 1, "");
                    if (B(equals(V.item(4), "0")) || B(equals(V.item(4), "1"))) {
                        yield* this.Make_sound(T.item(3), T.item(4), "ガード破壊");
                        yield* this.Delete("ガード破壊", "-", "-", "-", "-", "-");
                    }
                    else {
                        yield* this.Delete(V.item(4), "-", "-", "-", "-", "-");
                    }
                }
                // ガード設置者が自分で敵の弾なら押し戻す
                if (B(equals(G.X_Y, G.Guard.item(N(T.item(10)) + 1)))) {
                    if (B(!B(equals(G.Team_ID, this.Bullet_team_ID)))) {
                        if (B(compare("400", G.X) < 0)) {
                            G.Speed_x = N(G.Speed_x) + N(mathop("sin", T.item(5))) * N(N(V.item(7)) * N(G.FPS_temp));
                            G.Speed_y = N(G.Speed_y) + N(mathop("cos", T.item(5))) * N(N(V.item(7)) * N(G.FPS_temp));
                        }
                    }
                }
                if (B(equals(V.item(6), "-"))) {
                    this.e = "";
                }
                else {
                    this.e = V.item(6);
                }
                if (B(equals(V.item(8), "S")) && B(!B(equals(G.Team_ID, this.Bullet_team_ID)))) {
                    this.setEffect("GHOST", 100);
                }
                else {
                    this.setEffect("COLOR", V.item(8));
                    this.setEffect("BRIGHTNESS", T.item(V.item(5)));
                    this.setEffect("GHOST", 70 / (N(V.item(1)) / N(T.item(V.item(2)))));
                }
                yield* this.Stamp(this.IDX, this.IDY, 100 * N(G.Zoom_temp), S(this.e) + S(T.item(2)));
                this.setEffect("COLOR", 0);
                this.setEffect("BRIGHTNESS", 0);
                this.setEffect("GHOST", 0);
            }
            return;
        }
        if (B(equals(v_name, "Screen stamp"))) {
            yield* this.Set_bullet_val("3");
            if (B(equals(this.IF_ACT, "1"))) {
                this.Screen_stamp.add(V.item(1));
                this.Screen_stamp.add(T.item(3));
                this.Screen_stamp.add(T.item(4));
                this.Screen_stamp.add(T.item(5));
                this.Screen_stamp.add(V.item(2));
                this.Screen_stamp.add(V.item(3));
            }
            return;
        }
        if (B(equals(v_name, "Mine stamp"))) {
            // 地雷は味方（と Golden_Bot）にだけ見える
            yield* this.Set_bullet_val("2");
            if (B(equals(this.IF_ACT, "1"))) {
                if (B(equals(this.Bullet_team_ID, G.Team_ID)) || B(Golden_Bot)) {
                    this.setEffect("GHOST", B(Golden_Bot) ? 70 : 50);
                    yield* this.Stamp(this.IDX, this.IDY, N(V.item(2)) * N(G.Zoom_temp), V.item(1));
                    this.setEffect("GHOST", 0);
                }
            }
            return;
        }
        if (B(equals(v_name, "Color"))) {
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1"))) {
                this.setEffect("COLOR", V.item(1));
            }
            return;
        }
        if (B(equals(v_name, "Homing")) || B(equals(v_name, "Team homing")) || B(equals(v_name, "Roll homing"))) {
            // 最寄り（敵/味方）へ旋回しながら進む。回収アイテム類は自分へ直行する
            yield* this.Set_bullet_val("2");
            if (B(equals(this.IF_ACT, "1"))) {
                const pickupType = B(equals(T.item(2), "Money")) || B(equals(T.item(2), "Tektite")) ||
                    B(equals(T.item(2), "Present")) || B(equals(T.item(2), "エネルギーボール"));
                if (pickupType) {
                    this.e = N(mathop("atan", N(N(G.X) - N(T.item(3))) / N(N(G.Y) - N(T.item(4))))) + N(compare(G.Y, T.item(4)) < 0) * 180;
                }
                else {
                    if (B(equals(T.item(2), "シェアバリア"))) {
                        this.First_number = T.item(1);
                    }
                    else if (B(equals(v_name, "Team homing"))) {
                        yield* this.Search_first__b("T", "-1");
                    }
                    else {
                        yield* this.Search_first__b("E", "-1");
                    }
                    yield* this.Direction_to_bullet__e__f();
                }
                this.g = B(equals(v_name, "Roll homing")) ? "6" : "5";
                this.f = N(mod(N(N(this.e) - N(T.item(this.g))) + 180, 360)) - 180;
                if (B(compare(mathop("abs", this.f), N(V.item(2)) * N(G.FPS_temp)) < 0)) {
                    yield* this.CS_val(this.g, this.e, "S");
                }
                else if (B(compare("0", this.f) < 0)) {
                    yield* this.CS_val(this.g, V.item(2), "C");
                }
                else {
                    yield* this.CS_val(this.g, 0 - N(V.item(2)), "C");
                }
                yield* this.Step(V.item(1), this.g);
            }
            return;
        }
        if (B(equals(v_name, "Hit IF"))) {
            if (B(equals(this.Hit, "1"))) {
                if (B(equals(this.IF, "0")))
                    this.IF_T_F = "T";
            }
            else {
                this.IF_T_F = "F";
            }
            this.IF = "1";
            return;
        }
        if (B(equals(v_name, "Search first"))) {
            yield* this.Set_bullet_val("2");
            if (B(equals(this.IF_ACT, "1"))) {
                yield* this.Search_first__b(V.item(1), V.item(2));
            }
            return;
        }
        if (B(equals(v_name, "Skill point"))) {
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1")) && B(equals(T.item(1), G.ID))) {
                G.Skill_point = N(G.Skill_point) + N(V.item(1));
            }
            return;
        }
        if (B(equals(v_name, "Shield"))) {
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1"))) {
                yield* this.Search_first__b("T", "-1");
                if (B(equals(T.item(1), G.ID))) {
                    G.Shield = N(G.Shield) + N(V.item(1));
                    const cap = N(G.Character_2.item(N(G.Character) + 4)) / 4;
                    if (B(compare(cap, G.Shield) < 0))
                        G.Shield = cap;
                }
            }
            return;
        }
        if (B(equals(v_name, "Auto heal"))) {
            // 回復は Health_timer（残り回復量プール）へ積む。正の即時分と
            // 負の継続分（15%ずつ）で積み方が違う
            yield* this.Set_bullet_val("1");
            if (B(equals(this.IF_ACT, "1"))) {
                yield* this.Search_first__b("T", "-1");
                if (B(equals(T.item(1), G.ID))) {
                    this.e = V.item(1);
                    if (B(compare("0", G.Health_timer) < 0)) {
                        G.Health_timer = N(G.Health_timer) + N(this.e);
                        this.e = N(this.e) + N(G.Health_timer);
                        if (B(compare(G.Health_timer, "0") < 0))
                            G.Health_timer = "0";
                    }
                    if (B(compare(this.e, "0") < 0)) {
                        G.Health_timer = N(G.Health_timer) + N(this.e) * 0.15;
                        const cap = N(G.Character_2.item(N(G.Character) + 8)) * 40;
                        if (B(compare(G.Health_timer, cap) < 0))
                            G.Health_timer = cap;
                    }
                }
            }
            return;
        }
        if (S(v_name).toLowerCase().includes(S("About").toLowerCase())) {
            // About 系は「オブジェクトの振る舞い」: 描画と取得判定を兼ねる
            if (B(equals(v_name, "About damage val"))) {
                // ダメージ数値の表示
                this.setEffect("COLOR", T.item(10));
                this.gotoXY(this.IDX, this.IDY);
                yield* this.Draw_text(T.item(6), N(T.item(7)) * N(G.Zoom_temp), "C", this.x);
                this.rotationStyle = "all around";
                this.setEffect("COLOR", 0);
                return;
            }
            if (B(equals(v_name, "About drop item"))) {
                // ドロップ武器のアイコンと、近づいたときの取得キー案内
                this.pointInDirection(90);
                yield* this.Stamp(this.IDX, this.IDY, N(90 + N(mathop("sin", N(T.item(9)) * 5)) * 7) * N(G.Zoom_temp), S("@") + S(G.Weapon_name.item(T.item(7))));
                this.e = mathop("sqrt", N(N(G.X) - N(T.item(3))) * N(N(G.X) - N(T.item(3))) + N(N(G.Y) - N(T.item(4))) * N(N(G.Y) - N(T.item(4))));
                if (B(compare(this.e, "35") < 0) && B(equals(G.Menu.item(116), "-"))) {
                    G.Menu.replace(116, this.a);
                    this.changeYBy(25 * N(G.Zoom_temp));
                    this.setEffect("BRIGHTNESS", 100);
                    yield* this.Draw_text("R key", 65 * N(G.Zoom_temp), "C", this.x);
                    this.setEffect("BRIGHTNESS", 0);
                    this.rotationStyle = "all around";
                }
                return;
            }
            if (B(equals(v_name, "About money")) || B(equals(v_name, "About tektite")) || B(equals(v_name, "About present"))) {
                // 回収物: 25以内に入ったら取得して消える
                if (B(equals(this.IF_ACT, "1"))) {
                    this.e = mathop("sqrt", N(N(G.X) - N(T.item(3))) * N(N(G.X) - N(T.item(3))) + N(N(G.Y) - N(T.item(4))) * N(N(G.Y) - N(T.item(4))));
                    if (B(compare(this.e, "25") < 0)) {
                        if (B(equals(v_name, "About money"))) {
                            this.rt.soundPlay("05eb8cce38b1e1449ade186a8e10c489.wav");
                            G.Money = N(G.Money) + 1;
                        }
                        else if (B(equals(v_name, "About tektite"))) {
                            this.rt.soundPlay("a9cc64d36bbf56f761c68197351d68e4.wav");
                            G.Tektite = N(G.Tektite) + 1;
                        }
                        else {
                            this.rt.soundPlay("cd16a3c1d3f80a53e4251b72d8fb515a.wav");
                            this.f = B(equals(T.item(1), "0000")) ? random(1, 10) : random(1, 9);
                            if (B(equals(this.f, "10"))) {
                                yield* this.Create("サンタ", "0", "0", "0", "0", "0");
                            }
                            else {
                                yield* this.Put_buff(S("クリスマス") + S(this.f), "450");
                            }
                        }
                        yield* this.Delete("-", "-", "-", "-", "-", "-");
                    }
                    return;
                }
            }
            if (B(equals(v_name, "About shield cannon"))) {
                // シールドキャノンの一連の振る舞い: 前進、範囲爆発、溜め、炎の描画
                yield* this.Step("8", "5");
                yield* this.Damage("50", "35", "0", "爆発", "10", "8", "5", "0", "0");
                yield* this.CS_val("6", "10", "C");
                if (B(compare("120", T.item(6)) < 0)) {
                    yield* this.CS_val("6", "0", "S");
                }
                this.e = this.IDX;
                this.f = this.IDY;
                this.g = N(T.item(6)) + 180;
                this.k = "0";
                for (let rep = 0; rep < 3; rep++) {
                    this.k = N(this.k) + 1;
                    this.h = this.e;
                    this.i = this.f;
                    this.setPenColor("#ff0000");
                    this.setPenSize(9 * N(G.Zoom_temp));
                    for (let rep2 = 0; rep2 < 10; rep2++) {
                        this.j = N(mathop("sin", this.g)) * 18 * N(G.Zoom_temp);
                        this.gotoXY(N(this.h) + N(mathop("sin", N(T.item(5)) + 90)) * N(this.j), N(this.i) + N(mathop("cos", N(T.item(5)) + 90)) * N(this.j));
                        this.penDown();
                        this.changePenParam(S("color"), 1);
                        this.changePenParam(S("transparency"), 10);
                        this.setPenParam(S("brightness"), 70 + N(mathop("cos", this.g)) * 30);
                        this.changePenSize(-0.8 * N(G.Zoom_temp));
                        this.g = N(this.g) - 12;
                        this.h = N(this.h) + N(mathop("sin", T.item(5))) * -6;
                        this.i = N(this.i) + N(mathop("cos", T.item(5))) * -6;
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.penUp();
                    if ((B(equals(this.k, "1")) && B(compare("-0.3", mathop("cos", N(T.item(6)) + 60)) < 0)) ||
                        (B(equals(this.k, "2")) && B(compare(mathop("cos", N(T.item(6)) + 60), "-0.3") < 0))) {
                        yield* this.Stamp(this.e, this.f, size, "シールドキャノン見た目");
                    }
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            if (B(equals(v_name, "About JJ-100"))) {
                // 電撃のランダムウォーク描画（半径125まで）
                this.setPenColor("#00ffb6");
                const cnt = Math.max(0, Math.floor(N(random(5, 10))));
                for (let rep = 0; rep < cnt; rep++) {
                    this.gotoXY(this.IDX, this.IDY);
                    this.setPenSize(N(random(5, 10)) * N(G.Zoom_temp));
                    this.setPenParam(S("transparency"), 100);
                    this.penDown();
                    this.setPenParam(S("transparency"), 70);
                    this.g = random(0, 360);
                    while (!B(compare(N(125) * N(G.Zoom_temp), mathop("sqrt", N(N(this.x) - N(this.IDX)) * N(N(this.x) - N(this.IDX)) + N(N(this.y) - N(this.IDY)) * N(N(this.y) - N(this.IDY)))) < 0)) {
                        this.f = random(-60, 60);
                        this.pointInDirection(N(this.g) + N(this.f));
                        this.moveSteps(N(random(5, 20)) * N(G.Zoom_temp));
                        if (!this.rt.warpActive)
                            yield;
                    }
                    this.penUp();
                    if (!this.rt.warpActive)
                        yield;
                }
                return;
            }
            if (B(equals(v_name, "About Chat"))) {
                // チャット吹き出し: フェードしながら持ち主を追い、寿命で消える
                this.gotoXY(this.IDX, this.IDY);
                this.setPenColor("#ffffff");
                this.setPenSize(18 * N(G.Zoom_temp));
                this.setPenParam(S("transparency"), 100);
                this.changeXBy(-36 * N(G.Zoom_temp));
                this.penDown();
                this.e = N(mathop("abs", mathop("cos", T.item(7)))) * 100;
                this.setPenParam(S("transparency"), this.e);
                this.changeXBy(72 * N(G.Zoom_temp));
                this.penUp();
                this.changeXBy(-36 * N(G.Zoom_temp));
                this.setEffect("GHOST", this.e);
                if (B(equals(G.Language, "1"))) {
                    yield* this.Stamp(this.x, this.y, 90 * N(G.Zoom_temp), S("Chat ") + S(this.Chat_2.item(T.item(6))));
                }
                else {
                    this.setEffect("BRIGHTNESS", -100);
                    yield* this.Draw_text(this.Chat_2.item(N(T.item(6)) + 100), N(T.item(10)) * N(G.Zoom_temp), "C", this.x);
                    this.setEffect("BRIGHTNESS", 0);
                }
                this.setEffect("GHOST", 0);
                if (compare(T.item(7), "89") < 0 || compare("89", T.item(8)) < 0) {
                    yield* this.CS_val("7", "6", "C");
                    yield* this.CS_val("9", N(mathop("abs", mathop("cos", T.item(7)))) * 2, "C");
                }
                else {
                    yield* this.CS_val("8", "1", "C");
                }
                if (B(equals(G.ID, T.item(1)))) {
                    this.IDX = G.X;
                    this.IDY = G.Y;
                }
                else {
                    this.IDX = G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + 2);
                    this.IDY = G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(T.item(1)))) + 3);
                }
                yield* this.CS_val("3", this.IDX, "S");
                yield* this.CS_val("4", N(this.IDY) + N(T.item(9)), "S");
                if (B(compare("180", T.item(7)) < 0)) {
                    yield* this.Delete("-", "-", "-", "-", "-", "-");
                }
            }
            return;
        }
    }
    // procedure: "Get mission point %s %s"
    *Get_mission_point(mission_name, point) {
        // ミッション進捗。G.Mission が一致し point > 0 のときだけ加算する。
        // Money 以外は対戦エリア（X > 400）限定。Character_tree[Tree+6] へ加え、[+5] で頭打ち。
        if (B(equals(G.Mission, mission_name))) {
            if (B((compare("0", point) < 0))) {
                if (B((B(equals(mission_name, "Money")) || B((B((!B(equals(mission_name, "Money")))) && B((compare("400", G.X) < 0))))))) {
                    if (B((compare(G.Character_tree.item((N(G.Tree) + N(6))), G.Character_tree.item((N(G.Tree) + N(5)))) < 0))) {
                        G.Character_tree.replace((N(G.Tree) + N(6)), (N(G.Character_tree.item((N(G.Tree) + N(6)))) + N(point)));
                        if (B((compare(G.Character_tree.item((N(G.Tree) + N(5))), G.Character_tree.item((N(G.Tree) + N(6)))) < 0))) {
                            G.Character_tree.replace((N(G.Tree) + N(6)), G.Character_tree.item((N(G.Tree) + N(5))));
                        }
                    }
                }
            }
        }
    }
    // procedure: "Shot create %s %s %s"
    *Shot_create(weapon, create_type, direction) {
        // 発射された弾・設置物を Bullet_and_effect へ生成する。create_type の
        // キーワードで分岐する（武器データ側の文字列がそのまま仕様）。
        // レコードは Create と同じ10フィールド。Pickupped は発射者レコード。
        // マズル位置は「向き方向へ dist、横へ side」が基本形。
        const P = this.Pickupped;
        const addRecord = (type, x, y, dir, v1, v2, v3, v4, v5) => {
            G.Bullet_and_effect.add(P.item(1));
            G.Bullet_and_effect.add(type);
            G.Bullet_and_effect.add(x);
            G.Bullet_and_effect.add(y);
            G.Bullet_and_effect.add(dir);
            G.Bullet_and_effect.add(v1);
            G.Bullet_and_effect.add(v2);
            G.Bullet_and_effect.add(v3);
            G.Bullet_and_effect.add(v4);
            G.Bullet_and_effect.add(v5);
        };
        const muzzle = (dist, side) => [
            N(P.item(3)) + N(mathop("sin", P.item(5))) * dist + N(mathop("sin", N(P.item(5)) + 90)) * side,
            N(P.item(4)) + N(mathop("cos", P.item(5))) * dist + N(mathop("cos", N(P.item(5)) + 90)) * side,
        ];
        const isMagic = S(create_type).toLowerCase().includes(S("魔法").toLowerCase());
        // ---- 設置・中央（魔法でないもの）: その場に置く ----
        if (!isMagic && (S(create_type).toLowerCase().includes(S("中央").toLowerCase()) || S(create_type).toLowerCase().includes(S("設置").toLowerCase()))) {
            let x = P.item(3), y = P.item(4);
            if (S(create_type).toLowerCase().includes(S("方眼").toLowerCase())) {
                this.Temp2 = Math.round(N(N(P.item(3)) / 50));
                this.Temp3 = Math.round(N(N(P.item(4)) / 50));
                x = N(this.Temp2) * 50;
                y = N(this.Temp3) * 50;
            }
            const dir = S(create_type).toLowerCase().includes(S("設置").toLowerCase()) ? "90" : direction;
            G.Bullet_and_effect.add(P.item(1));
            G.Bullet_and_effect.add(weapon);
            G.Bullet_and_effect.add(x);
            G.Bullet_and_effect.add(y);
            G.Bullet_and_effect.add(dir);
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            if (S(create_type).toLowerCase().includes(S("ガード").toLowerCase())) {
                this.Temp1 = "A";
                yield* this.Create_guard(S(this.Temp2) + S(S("/") + S(this.Temp3)));
            }
            else {
                G.Bullet_and_effect.add("0");
            }
            return;
        }
        // ---- 通常射撃（魔法でないもの）: 反動・呪い・煙つき ----
        const isNormalShot = !isMagic &&
            (S(create_type).toLowerCase().includes(S("普通").toLowerCase()) ||
                S(create_type).toLowerCase().includes(S("片手反動").toLowerCase()) ||
                S(create_type).toLowerCase().includes(S("呪い").toLowerCase()) ||
                S(create_type).toLowerCase().includes(S("戦車反動").toLowerCase()) ||
                S(create_type).toLowerCase().includes(S("近接反動").toLowerCase()) ||
                S(create_type).toLowerCase().includes(S("ランチャー").toLowerCase()) ||
                B(equals(create_type, "シールドキャノン")));
        if (isNormalShot) {
            if (B(equals(P.item(1), G.ID))) {
                if (S(create_type).toLowerCase().includes(S("呪い").toLowerCase())) {
                    if (B(equals(weapon, "US-144")))
                        yield* this.Put_buff("疲労", "90");
                    if (B(equals(weapon, "TM-016")))
                        yield* this.Put_buff("呪詛", "150");
                }
                if (S(create_type).toLowerCase().includes(S("反動").toLowerCase())) {
                    // 反動値は種別名の数字（ランチャーは8-9文字目、他は5-6文字目）-50 の逆向き
                    if (S(create_type).toLowerCase().includes(S("ランチャー").toLowerCase())) {
                        this.Temp1 = (N(S(letterOf(create_type, 8)) + S(letterOf(create_type, 9))) - 50) * -1;
                    }
                    else {
                        this.Temp1 = (N(S(letterOf(create_type, 5)) + S(letterOf(create_type, 6))) - 50) * -1;
                    }
                    if (S(create_type).toLowerCase().includes(S("戦車").toLowerCase())) {
                        this.Temp1 = N(mathop("cos", N(direction) - N(G.Motion.item(9)))) * N(this.Temp1);
                        G.Speed_x = N(G.Speed_x) + N(mathop("sin", G.Motion.item(9))) * N(this.Temp1);
                        G.Speed_y = N(G.Speed_y) + N(mathop("cos", G.Motion.item(9))) * N(this.Temp1);
                    }
                    else {
                        G.Speed_x = N(G.Speed_x) + N(mathop("sin", direction)) * N(this.Temp1);
                        G.Speed_y = N(G.Speed_y) + N(mathop("cos", direction)) * N(this.Temp1);
                    }
                }
            }
            let mx, my;
            if (S(create_type).toLowerCase().includes(S("ランチャー").toLowerCase())) {
                [mx, my] = muzzle(50, 15);
            }
            else if (B(equals(create_type, "シールドキャノン"))) {
                [mx, my] = muzzle(60, 23);
            }
            else if (S(create_type).toLowerCase().includes(S("近接").toLowerCase())) {
                mx = P.item(3);
                my = P.item(4);
            }
            else {
                [mx, my] = muzzle(50, 0);
            }
            addRecord(weapon, mx, my, direction, "0", "0", "0", "0", "0");
            // 煙（Lag_cutter 有効時は省略）
            if (B(equals(create_type, "シールドキャノン")) && B(equals(G.Lag_cutter, "0"))) {
                for (let i = 0; i < 8; i++) {
                    const [sx, sy] = muzzle(30, 23);
                    addRecord("煙", sx, sy, N(direction) + N(random(160, 200)), N(random(120, 150)) / 10, "0", "0", "0", "0");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            if (B(equals(create_type, "煙ランチャー")) && B(equals(G.Lag_cutter, "0"))) {
                for (let i = 0; i < 5; i++) {
                    const [sx, sy] = muzzle(30, 15);
                    addRecord("煙", sx, sy, N(direction) + N(random(160, 200)), N(random(110, 140)) / 10, "0", "0", "0", "0");
                    if (!this.rt.warpActive)
                        yield;
                }
            }
            return;
        }
        // ---- 二丁拳銃・二種拳銃: 左右交互、拡散つき ----
        if (S(create_type).toLowerCase().includes(S("二丁拳銃").toLowerCase()) || S(create_type).toLowerCase().includes(S("二種拳銃").toLowerCase())) {
            // 手の横オフセットは発射者レコードの26番で変わる
            this.Temp1 = B(equals(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(P.item(1)))) + 25), "1")) ? "3" : "10";
            this.Temp2 = S(create_type).toLowerCase().includes(S("拡散").toLowerCase())
                ? N(S(letterOf(create_type, 7)) + S(letterOf(create_type, 8))) - 10
                : "1";
            const cnt = Math.max(0, Math.floor(N(this.Temp2)));
            for (let i = 0; i < cnt; i++) {
                let name = weapon;
                if (S(create_type).toLowerCase().includes(S("二種拳銃").toLowerCase())) {
                    name = S(weapon) + S(B(equals(G.Charge, "01")) ? "1" : "2");
                }
                const [mx, my] = B(equals(G.Charge, "01")) ? muzzle(50, N(this.Temp1)) : muzzle(50, -N(this.Temp1));
                const dir = B(equals(this.Temp2, "1")) ? direction : N(P.item(5)) + N(random(0 - N(this.e), this.e));
                addRecord(name, mx, my, dir, "0", "0", "0", "0", "0");
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        // ---- チャット: 頭上に吹き出し（この分岐だけ return せず後続へ落ちる） ----
        if (B(equals(create_type, "Chat"))) {
            yield* this.Make_sound(P.item(3), P.item(4), "Pop");
            if (B(equals(G.ID, P.item(1)))) {
                if (B(equals(letterOf(this.c, 1), "3"))) {
                    G.Menu.replace(64, letterOf(this.c, 2));
                }
            }
            G.Bullet_and_effect.add(P.item(1));
            G.Bullet_and_effect.add(weapon);
            G.Bullet_and_effect.add(P.item(3));
            G.Bullet_and_effect.add(N(P.item(4)) + 35);
            G.Bullet_and_effect.add("90");
            G.Bullet_and_effect.add(this.c);
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add(B(equals(G.Character_name, "Cat Bot")) && B(equals(G.Scoping, "1")) ? "45" : "35");
            if (B(equals(G.Language, "1"))) {
                G.Bullet_and_effect.add("0");
            }
            else {
                // 他言語は文字幅を測って吹き出し幅を決める
                this.Temp1 = this.Chat_2.item(N(this.c) + 100);
                this.Temp2 = "0";
                this.Temp3 = "-2";
                const len = Math.max(0, Math.floor(N(S(this.Temp1).length)));
                for (let i = 0; i < len; i++) {
                    this.Temp2 = N(this.Temp2) + 1;
                    this.switchCostume(S("Font ") + S(letterOf(this.Temp1, this.Temp2)));
                    this.Temp3 = N(this.Temp3) + N(N(this.Font_size___Draw.item(this.costumeNumberName("number"))) * 2 + 2);
                    if (!this.rt.warpActive)
                        yield;
                }
                this.Temp1 = 100 * (72 / N(this.Temp3));
                if (B(compare("75", this.Temp1) < 0))
                    this.Temp1 = "75";
                G.Bullet_and_effect.add(this.Temp1);
            }
        }
        if (B(equals(create_type, "戦車重機関銃"))) {
            const [mx, my] = muzzle(10, -2);
            addRecord(weapon, mx, my, direction, "0", "0", "0", "0", "0");
            return;
        }
        if (B(equals(create_type, "戦車発火弾"))) {
            // 発煙弾（±15°）→ 火炎弾（±20°）を左右1発ずつ
            this.Temp1 = "15";
            this.Temp2 = "戦車発煙弾";
            for (let i = 0; i < 2; i++) {
                const [lx, ly] = muzzle(15, 12);
                addRecord(this.Temp2, lx, ly, N(direction) + N(this.Temp1), "0", "0", "0", "0", "0");
                const [rx, ry] = muzzle(15, -12);
                addRecord(this.Temp2, rx, ry, N(direction) - N(this.Temp1), "0", "0", "0", "0", "0");
                this.Temp1 = "20";
                this.Temp2 = "戦車火炎弾";
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        if (S(create_type).toLowerCase().includes(S("番設定").toLowerCase())) {
            // 「N番設定VVV」: 値 VVV-500 を N 番目の値フィールドへ置く（残りは 0）
            G.Bullet_and_effect.add(P.item(1));
            G.Bullet_and_effect.add(weapon);
            G.Bullet_and_effect.add(P.item(3));
            G.Bullet_and_effect.add(P.item(4));
            G.Bullet_and_effect.add(direction);
            const before = Math.max(0, Math.floor(N(letterOf(create_type, 1)) - 6));
            for (let i = 0; i < before; i++) {
                G.Bullet_and_effect.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            G.Bullet_and_effect.add(N(S(letterOf(create_type, 5)) + S(S(letterOf(create_type, 6)) + S(letterOf(create_type, 7)))) - 500);
            const after = Math.max(0, Math.floor(N(10 - N(letterOf(create_type, 1)))));
            for (let i = 0; i < after; i++) {
                G.Bullet_and_effect.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        // ---- 魔法: 体力をコスト（末尾3桁-100）として払う ----
        if (isMagic) {
            this.Temp1 = N(S(letterOf(create_type, N(S(create_type).length) - 2)) + S(S(letterOf(create_type, N(S(create_type).length) - 1)) + S(letterOf(create_type, S(create_type).length)))) - 100;
            this.Temp2 = B(equals(G.ID, P.item(1))) ? G.Health : G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(P.item(1)))) + 20);
            if (B(compare(this.Temp1, this.Temp2) < 0)) {
                if (B(equals(G.ID, P.item(1)))) {
                    G.Health = N(G.Health) - N(this.Temp1);
                    if (B(compare(G.Health, "1") < 0))
                        G.Health = "1";
                    if (S(create_type).toLowerCase().includes(S("呪い").toLowerCase()) && B(equals(weapon, "JJ-100"))) {
                        yield* this.Put_buff("リジェネカース", "150");
                    }
                }
                if (S(create_type).toLowerCase().includes(S("中央").toLowerCase())) {
                    addRecord(weapon, P.item(3), P.item(4), direction, "0", "0", "0", "0", "0");
                }
                if (S(create_type).toLowerCase().includes(S("普通").toLowerCase()) || S(create_type).toLowerCase().includes(S("回転").toLowerCase())) {
                    const [mx, my] = muzzle(50, 0);
                    const spin = S(create_type).toLowerCase().includes(S("回転").toLowerCase()) ? direction : "0";
                    addRecord(weapon, mx, my, direction, spin, "0", "0", "0", "0");
                }
                if (S(create_type).toLowerCase().includes(S("背面").toLowerCase())) {
                    for (let i = 0; i < 2; i++) {
                        const bx = N(P.item(3)) + N(N(mathop("sin", P.item(5))) * -50 + N(random(N(mathop("abs", mathop("cos", P.item(5)))) * 20, N(mathop("abs", mathop("cos", P.item(5)))) * -20)));
                        const by = N(P.item(4)) + N(N(mathop("cos", P.item(5))) * -50 + N(random(N(mathop("abs", mathop("sin", P.item(5)))) * 20, N(mathop("abs", mathop("sin", P.item(5)))) * -20)));
                        addRecord(weapon, bx, by, direction, "0", "0", "0", "0", "0");
                        if (!this.rt.warpActive)
                            yield;
                    }
                }
            }
            return;
        }
        // ---- 左右: 横へ40ずらして2発 ----
        if (S(create_type).toLowerCase().includes(S("左右").toLowerCase())) {
            addRecord(weapon, N(P.item(3)) + N(mathop("sin", N(P.item(5)) + 90)) * 40, N(P.item(4)) + N(mathop("cos", N(P.item(5)) + 90)) * 40, direction, "0", "0", "0", "0", "0");
            addRecord(weapon, N(P.item(3)) + N(mathop("sin", N(P.item(5)) - 90)) * 40, N(P.item(4)) + N(mathop("cos", N(P.item(5)) - 90)) * 40, direction, "0", "0", "0", "0", "0");
            return;
        }
        // ---- ショット: 「ショットNN」の NN-10 発を拡散 e でばらまく ----
        if (S(create_type).toLowerCase().includes(S("ショット").toLowerCase())) {
            this.Temp1 = N(S(letterOf(create_type, 5)) + S(letterOf(create_type, 6))) - 10;
            const cnt = Math.max(0, Math.floor(N(this.Temp1)));
            for (let i = 0; i < cnt; i++) {
                const [mx, my] = muzzle(50, 0);
                addRecord(weapon, mx, my, N(P.item(5)) + N(random(0 - N(this.e), this.e)), "0", "0", "0", "0", "0");
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        if (B(equals(create_type, "1マスガード"))) {
            // 45°刻みに丸めた正面1マスへ C付きガードを置く
            this.Temp1 = N(Math.round(N(N(P.item(5)) / 45))) * 45;
            G.Bullet_and_effect.add(P.item(1));
            G.Bullet_and_effect.add(S("C") + S(weapon));
            G.Bullet_and_effect.add(N(Math.round(N(N(P.item(3)) + N(mathop("sin", this.Temp1)) * 50) / 50)) * 50);
            G.Bullet_and_effect.add(N(Math.round(N(N(P.item(4)) + N(mathop("cos", this.Temp1)) * 50) / 50)) * 50);
            G.Bullet_and_effect.add(this.Temp1);
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            G.Bullet_and_effect.add("0");
            yield* this.Create_guard(S(Math.round(N(N(G.Bullet_and_effect.item(N(G.Bullet_and_effect.length) - 6)) / 50))) + S(S("/") + S(Math.round(N(N(G.Bullet_and_effect.item(N(G.Bullet_and_effect.length) - 5)) / 50)))));
            return;
        }
        if (B(equals(create_type, "3マスガード")) || B(equals(create_type, "半円ガード"))) {
            // 正面マスを中心に横3マス（半円は45°刻みで扇形に）
            this.Temp1 = N(Math.round(N(N(P.item(5)) / 90))) * 90;
            this.Temp2 = N(Math.round(N(N(P.item(3)) + N(mathop("sin", this.Temp1)) * 50) / 50)) * 50;
            this.Temp3 = N(Math.round(N(N(P.item(4)) + N(mathop("cos", this.Temp1)) * 50) / 50)) * 50;
            this.Temp4 = "-50";
            this.Temp5 = this.Temp1;
            if (B(equals(create_type, "半円ガード"))) {
                this.Temp1 = N(this.Temp1) - 90;
            }
            for (let i = 0; i < 3; i++) {
                if (B(equals(create_type, "半円ガード"))) {
                    this.Temp1 = N(this.Temp1) + 45;
                }
                G.Bullet_and_effect.add(P.item(1));
                G.Bullet_and_effect.add(S(B(equals(this.Temp4, "0")) ? "C" : "S") + S(weapon));
                G.Bullet_and_effect.add(N(this.Temp2) + N(mathop("sin", N(this.Temp5) + 90)) * N(this.Temp4));
                G.Bullet_and_effect.add(N(this.Temp3) + N(mathop("cos", N(this.Temp5) + 90)) * N(this.Temp4));
                G.Bullet_and_effect.add(this.Temp1);
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
                if (B(equals(create_type, "半円ガード"))) {
                    G.Bullet_and_effect.add(B(equals(this.Temp4, "0")) ? "0" : N(1) + N(compare("0", this.Temp4) < 0));
                }
                else {
                    G.Bullet_and_effect.add("0");
                }
                yield* this.Create_guard(S(Math.round(N(N(G.Bullet_and_effect.item(N(G.Bullet_and_effect.length) - 6)) / 50))) + S(S("/") + S(Math.round(N(N(G.Bullet_and_effect.item(N(G.Bullet_and_effect.length) - 5)) / 50)))));
                this.Temp4 = N(this.Temp4) + 50;
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        if (B(equals(create_type, "ばらまき"))) {
            this.Temp1 = direction;
            for (let i = 0; i < 5; i++) {
                addRecord(weapon, P.item(3), P.item(4), this.Temp1, this.Temp1, "10", "0", "0", "0");
                this.Temp1 = N(this.Temp1) + 72;
                if (!this.rt.warpActive)
                    yield;
            }
            return;
        }
        if (S(create_type).toLowerCase().includes(S("回転投げ").toLowerCase())) {
            if (B(equals(G.ID, P.item(1))) && B(equals(weapon, "TM-016"))) {
                yield* this.Put_buff("呪詛", "300");
            }
            const [mx, my] = muzzle(50, 0);
            addRecord(weapon, mx, my, direction, direction, "0", "0", "0", "0");
            return;
        }
        if (S(create_type).toLowerCase().includes(S("特殊投げ").toLowerCase())) {
            const [mx, my] = muzzle(50, 0);
            addRecord(weapon, mx, my, direction, direction, "20", "-20", "0", "0");
            return;
        }
        if (B(equals(create_type, "シェア投げ"))) {
            addRecord(weapon, P.item(3), P.item(4), direction, "0", "0", "0", "0", "0");
            const [mx, my] = muzzle(50, 0);
            addRecord(S("S") + S(weapon), mx, my, direction, B(equals(weapon, "シェアバリア")) ? "15" : "0", "0", "0", "0", "0");
            return;
        }
        if (B(equals(create_type, "自分"))) {
            if (B(equals(P.item(1), G.ID))) {
                const [mx, my] = muzzle(50, 0);
                addRecord(weapon, mx, my, direction, "0", "0", "0", "0", "0");
            }
            return;
        }
    }
    // procedure: "Draw dummy rail"
    *Draw_dummy_rail() {
        // ダミーの移動レール。Menu[49] の 120 フレーム周期で形が 3 種（なし/四角/ジグザグ）に変わる。
        this.a = (N(mod(mathop("floor", (N(G.Menu.item(49)) / N(120))), 3)) + N(1));
        if (B((compare("1", this.a) < 0))) {
            this.gotoXY((N((N(-550) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(400) - N(G.All_camera_y))) * N(G.Zoom_temp)));
            this.setPenColor("#272727");
            this.setPenSize((N(8) * N(G.Zoom_temp)));
            this.setPenParam(S("transparency"), 100);
            this.penDown();
            this.setPenParam(S("transparency"), 20);
        }
        if (B(equals(this.a, "2"))) {
            this.gotoXY((N(this.x) + N((N(100) * N(G.Zoom_temp)))), (N(this.y) + N((N(100) * N(G.Zoom_temp)))));
            this.gotoXY((N(this.x) + N((N(100) * N(G.Zoom_temp)))), (N(this.y) - N((N(100) * N(G.Zoom_temp)))));
            this.gotoXY((N(this.x) - N((N(100) * N(G.Zoom_temp)))), (N(this.y) - N((N(100) * N(G.Zoom_temp)))));
            this.gotoXY((N(this.x) - N((N(100) * N(G.Zoom_temp)))), (N(this.y) + N((N(100) * N(G.Zoom_temp)))));
        }
        if (B(equals(this.a, "3"))) {
            this.changeXBy((N(200) * N(G.Zoom_temp)));
            this.changeYBy((N(100) * N(G.Zoom_temp)));
            this.changeXBy((N(-100) * N(G.Zoom_temp)));
            this.changeYBy((N(-200) * N(G.Zoom_temp)));
            this.changeXBy((N(-100) * N(G.Zoom_temp)));
            this.changeYBy((N(100) * N(G.Zoom_temp)));
        }
        this.penUp();
    }
    // procedure: "Make sound %s %s %s"
    *Make_sound(X, Y, sound) {
        // 距離が聞き取り範囲（Character_2[+7]）未満なら、名前付きサウンドを鳴らす。
        if (B((compare(mathop("sqrt", (N((N((N(X) - N(G.X))) * N((N(X) - N(G.X))))) + N((N((N(Y) - N(G.Y))) * N((N(Y) - N(G.Y))))))), G.Character_2.item((N(G.Character) + N(7)))) < 0))) {
            this.playSoundByName(S(sound));
        }
    }
    // procedure: "Draw ship"
    *Draw_ship() {
        // 帰還ヘリのカットシーン。Menu[56] が残り時間で、1 未満になると "OK"（着陸完了:
        // プレイヤーを原点へ戻し、カメラをヘリ位置へ）。Menu[57] が Menu[60] から 900 進んだら Respawn。
        if (B((compare("0", G.Menu.item(56)) < 0))) {
            this.pointInDirection(90);
            yield* this.Stamp((N((N(G.Menu.item(57)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.Menu.item(58)) - N(G.All_camera_y))) * N(G.Zoom_temp)), "120", "帰還用ヘリコプター胴体");
            this.pointInDirection(G.Menu.item(59));
            yield* this.Stamp((N((N(G.Menu.item(57)) - N(G.All_camera_x))) * N(G.Zoom_temp)), (N((N(G.Menu.item(58)) - N(G.All_camera_y))) * N(G.Zoom_temp)), "120", "帰還用ヘリコプター羽");
            this.pointInDirection(90);
            G.Menu.replace(57, (N(G.Menu.item(57)) + N((N(10) * N(G.FPS_temp)))));
            G.Menu.replace(59, (N(G.Menu.item(59)) + N((N(30) * N(G.FPS_temp)))));
            if (B((B((compare(mod(G.Menu.item(59), 180), "90") < 0)) && B((compare("90", mod((N(G.Menu.item(59)) - N((N(30) * N(G.FPS_temp)))), 180)) < 0))))) {
                this.rt.soundPlay("28ea5ee8bd2da53ecbdf46998c4af6d1.wav");
            }
            if (B((!B(equals(G.Menu.item(56), "OK"))))) {
                G.Menu.replace(56, (N(G.Menu.item(56)) - N(G.FPS_temp)));
                if (B((compare(G.Menu.item(56), "1") < 0))) {
                    G.Menu.replace(56, "OK");
                    G.Menu.replace(2, "520");
                    G.X = "0";
                    G.Y = "0";
                    G.Speed_x = "0";
                    G.Speed_y = "0";
                    G.Camera_x = G.Menu.item(57);
                    G.Camera_y = G.Menu.item(58);
                }
            }
            // ヘリが発進位置から 900 進んだら帰還完了として Respawn
            if (B((compare("900", (N(G.Menu.item(57)) - N(G.Menu.item(60)))) < 0))) {
                this.rt.soundPlay("ca59bd66b9a2dd04c17bd3658227b194.wav");
                yield* this.Respawn();
                G.Menu.replace(56, "0");
                yield* this.Add_combat_data("Back", "", "");
            }
            this.gotoXY((N((N((N(0) - N(G.Camera_x))) - N(40))) * N(G.Zoom_temp)), (N((N((N(0) - N(G.Camera_y))) - N(60))) * N(G.Zoom_temp)));
            this.setPenColor("#272727");
            this.setPenSize((N(20) * N(G.Zoom_temp)));
            this.penDown();
            this.changeXBy((N(80) * N(G.Zoom_temp)));
            this.penUp();
            this.changeXBy((N(-80) * N(G.Zoom_temp)));
            this.setPenColor("#828282");
            this.setPenSize((N(10) * N(G.Zoom_temp)));
            this.penDown();
            this.changeXBy((N(80) * N(G.Zoom_temp)));
            this.penUp();
            this.changeXBy((N(-80) * N(G.Zoom_temp)));
            this.setPenColor("#00f2ff");
            this.penDown();
            this.changeXBy((N((N(80) - N((N(80) / N((N(300) / N(G.Menu.item(56)))))))) * N(G.Zoom_temp)));
            this.penUp();
        }
    }
    // procedure: "Respawn"
    *Respawn() {
        // 死亡からの復帰。無キル（Kill_counter < 1）かつ Match_damage > 29 なら
        // floor(Match_damage / 35) 個のお金が落ち、Money message がキューに入る。
        // 体力は全回復し、特殊武器 / SURVIVAL 中は Temp_inventory から装備を復元する。
        if (B((B((compare(G.Kill_counter, "1") < 0)) && B((compare("29", this.Match_damage) < 0))))) {
            const moneyDrops = Math.max(0, Math.floor(N(mathop("floor", (N(this.Match_damage) / N(35))))));
            for (let r = 0; r < moneyDrops; r++) {
                yield* this.Get_mission_point("Money", "1");
                G.Bullet_and_effect.add("0000");
                G.Bullet_and_effect.add("Money");
                G.Bullet_and_effect.add("350");
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add(random(0, 360));
                G.Bullet_and_effect.add(random(5, 10));
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
                G.Bullet_and_effect.add("0");
                if (!this.rt.warpActive)
                    yield;
            }
            this.Screen_effect.add("0000");
            this.Screen_effect.add("Money message");
            this.Screen_effect.add("0");
            this.Screen_effect.add("0");
            this.Screen_effect.add("90");
            this.Screen_effect.add("0");
            this.Screen_effect.add("-315");
            this.Screen_effect.add("-85");
            this.Screen_effect.add("0");
            this.Screen_effect.add("0");
        }
        G.Menu.replace(22, "0");
        G.Menu.replace(56, "0");
        G.Health = G.Max_health;
        if (B((B(equals(G.Special_weapon, "1")) || B(equals(G.SURVIVAL, "1"))))) {
            this.a = "0";
            for (let i = 0; i < 31; i++) {
                this.a = N(this.a) + N(1);
                G.Inventory_2.replace(this.a, G.Temp_inventory.item(this.a));
                if (!this.rt.warpActive)
                    yield;
            }
            G.Special_weapon = "0";
        }
    }
    // procedure: "Set inventory [T1, T2, T3] %s %s"
    *Set_inventory__T1__T2__T3(num, weapon_name) {
        // スロット（オフセット num）へ武器を Item_list から構築する。
        // [+1]=名前 [+2]=種別 [+3]=残量（サブは 容量 × 倍率、他は容量） [+4]=容量 [+5..6]=0。
        this.Temp1 = G.Weapon.item(G.Weapon_name.itemNum(weapon_name));
        G.Inventory_2.replace((N(num) + N(1)), weapon_name);
        this.Temp2 = G.Item_list.item((N(this.Temp1) + N(1)));
        G.Inventory_2.replace((N(num) + N(2)), this.Temp2);
        this.Temp3 = G.Item_list.item((N(this.Temp1) + N(2)));
        if (B(S(this.Temp2).toLowerCase().includes(S("サブ").toLowerCase()))) {
            G.Inventory_2.replace((N(num) + N(3)), (N(this.Temp3) * N(G.Item_list.item((N(this.Temp1) + N(4))))));
        }
        else {
            G.Inventory_2.replace((N(num) + N(3)), this.Temp3);
        }
        G.Inventory_2.replace((N(num) + N(4)), this.Temp3);
        G.Inventory_2.replace((N(num) + N(5)), "0");
        G.Inventory_2.replace((N(num) + N(6)), "0");
    }
    // procedure: "ID check %s" (warp)
    *ID_check(level) {
        this.rt.pushWarp();
        try {
            // 自分のプレイヤー ID（4 桁）の重複チェックと振り直し。
            // 禁止 ID は "0000" とチーム ID の "1000" / "2000"。
            // level "1": まず振り直し、CLOUD に同 ID が無くなるまで繰り返す。
            // level "2": 同 ID のレコードがちょうど 1 つ（自分だけ）なら維持し、
            //   それ以外なら 1 回だけ振り直して終わる。
            const rt = this.rt;
            const rollId = function* () {
                G.ID = "0000";
                while (B(equals(G.ID, "0000")) || B(equals(G.ID, "1000")) || B(equals(G.ID, "2000"))) {
                    G.ID = S(random(0, 9)) + S(S(random(0, 9)) + S(S(random(0, 9)) + S(random(0, 9))));
                    if (!rt.warpActive)
                        yield;
                }
            };
            this.b = "1";
            while (!B(equals(this.b, "0"))) {
                if (B(equals(level, "1"))) {
                    yield* rollId();
                }
                // CLOUD 内で同じ ID のレコード数を数える（b がその数になる）
                this.a = "0";
                this.b = "0";
                const records = Math.max(0, Math.floor(N(G.CLOUD.length) / N(G.Number_of_data)));
                for (let i = 0; i < records; i++) {
                    if (B(equals(G.CLOUD.item(N(this.a) + 1), G.ID))) {
                        this.b = N(this.b) + 1;
                    }
                    this.a = N(this.a) + N(G.Number_of_data);
                    if (!this.rt.warpActive)
                        yield;
                }
                if (B(equals(level, "2"))) {
                    if (!B(equals(this.b, "1"))) {
                        yield* rollId();
                    }
                    this.b = "0";
                }
                if (!this.rt.warpActive)
                    yield;
            }
        }
        finally {
            this.rt.popWarp();
        }
    }
    // procedure: "Set pet position"
    *Set_pet_position() {
        // 選択中のペットの表示位置（Menu[80..84]）を更新する。
        // Pet data の 7 番がモード: "2" は頭上追従（角度 Menu[84] の周囲 50 px）、
        // それ以外は一定間隔でランダムな近傍へ。実際の座標は CSM menu の
        // "M"（目標へ speed 分の 1 ずつ FPS_temp 倍で接近）で Menu[82]/[83] に滑らかに入り、
        // Pet x / Pet y は自分との相対位置（±400 でクランプ）。
        if (!B(equals(G.Select_pet, "-1"))) {
            this.a = G.Pet_data.item(N(G.Select_pet) * 10 + 7);
            if (B(equals(this.a, "2"))) {
                G.Menu.replace(80, N(G.X) + N(mathop("sin", G.Menu.item(84))) * 50);
                G.Menu.replace(81, N(G.Y) + N(mathop("cos", G.Menu.item(84))) * 50);
                this.b = "8";
            }
            else {
                if (B(equals(mod(this.Frame_cutter, N(0.75) * N(G.FPS)), "0"))) {
                    G.Menu.replace(80, N(G.X) + N(random(-75, 75)));
                    G.Menu.replace(81, N(G.Y) + N(random(-75, 75)));
                }
                this.b = "6";
            }
            yield* this.CSM_menu("82", G.Menu.item(80), "M", this.b);
            yield* this.CSM_menu("83", G.Menu.item(81), "M", this.b);
            G.Pet_x = N(G.Menu.item(82)) - N(G.X);
            G.Pet_y = N(G.Menu.item(83)) - N(G.Y);
            if (B(compare(G.Pet_x, "-400") < 0)) {
                G.Pet_x = "-400";
            }
            if (B(compare("400", G.Pet_x) < 0)) {
                G.Pet_x = "400";
            }
            if (B(compare(G.Pet_y, "-400") < 0)) {
                G.Pet_y = "-400";
            }
            if (B(compare("400", G.Pet_y) < 0)) {
                G.Pet_y = "400";
            }
            if (B(equals(this.a, "0"))) {
                // モード 0 は目標方向へ Pet direction を 1/4 ずつ回す
                this.b = N(G.Menu.item(80)) - N(G.Menu.item(82));
                this.c = N(G.Menu.item(81)) - N(G.Menu.item(83));
                this.b = N(mathop("atan", N(this.b) / N(this.c))) + N(compare(this.c, "0") < 0) * 180;
                G.Pet_direction = N(G.Pet_direction) + (mod(N(this.b) - N(G.Pet_direction) + 180, 360) - 180) / 4;
            }
            if (B(equals(this.a, "1")) || B(equals(this.a, "2"))) {
                yield* this.CSM_menu("84", "2", "C", "");
                G.Pet_direction = G.Menu.item(84);
            }
        }
    }
    // procedure: "Laser detect"
    *Laser_detect() {
        // レーザーの遮断判定（Bullet action の Laser から）。i/j は呼び出し側が入れた目標点。
        // 最初の1周（k = -Number_of_data）は CLOUD を見ず、目標点との幾何判定だけを行う。
        // レーザー帯に目標が入れば e = "-" で return し、途中のプレイヤーが帯に居れば i/j を差し替えて判定し直す。
        this.e = "0";
        this.k = (N(0) - N(G.Number_of_data));
        const steps = Math.max(0, Math.floor(N(this.f)));
        for (let r = 0; r < steps; r++) {
            if (B(equals(this.Temp2_2.item(5), "0"))) {
                if (B((compare("-1", this.k) < 0))) {
                    this.f = "0";
                    if (B(equals(G.CLOUD.item((N(this.k) + N(16))), "0"))) {
                        if (B((!B(equals(this.Bullet_team_ID, G.CLOUD.item((N(this.k) + N(12)))))))) {
                            if (B((compare(mathop("sqrt", (N((N((N(G.CLOUD.item((N(this.k) + N(3)))) - N(this.Temp1_2.item(3)))) * N((N(G.CLOUD.item((N(this.k) + N(3)))) - N(this.Temp1_2.item(3)))))) + N((N((N(G.CLOUD.item((N(this.k) + N(4)))) - N(this.Temp1_2.item(4)))) * N((N(G.CLOUD.item((N(this.k) + N(4)))) - N(this.Temp1_2.item(4)))))))), (N(this.Temp2_2.item(2)) + N(30))) < 0))) {
                                this.i = G.CLOUD.item((N(this.k) + N(3)));
                                this.j = G.CLOUD.item((N(this.k) + N(4)));
                                this.f = "1";
                            }
                        }
                    }
                }
                else {
                    this.f = "1";
                }
            }
            else {
                this.f = "1";
            }
            if (B(equals(this.f, "1"))) {
                this.e = (N(this.Temp1_2.item(3)) + N((N(mathop("sin", this.Temp1_2.item(5))) * N(this.Temp2_2.item(2)))));
                this.f = (N(this.Temp1_2.item(4)) + N((N(mathop("cos", this.Temp1_2.item(5))) * N(this.Temp2_2.item(2)))));
                this.g = (N((B((compare(mathop("abs", (N(this.j) - N((N((N(this.Temp1_2.item(4)) + N(this.f))) / N(2))))), (N((N(mathop("abs", (N(this.Temp1_2.item(4)) - N(this.f)))) + N((N(this.Temp2_2.item(3)) + N(25))))) / N(2))) < 0)) && B((compare(mathop("abs", (N(this.i) - N((N((N(this.Temp1_2.item(3)) + N(this.e))) / N(2))))), (N((N(mathop("abs", (N(this.Temp1_2.item(3)) - N(this.e)))) + N((N(this.Temp2_2.item(3)) + N(25))))) / N(2))) < 0)))) - N(0));
                this.h = (N((compare((N(mathop("abs", (N((N((N(this.Temp1_2.item(3)) - N(this.i))) * N((N(this.f) - N(this.j))))) - N((N((N(this.Temp1_2.item(4)) - N(this.j))) * N((N(this.e) - N(this.i)))))))) / N(mathop("sqrt", (N((N((N(this.Temp1_2.item(3)) - N(this.e))) * N((N(this.Temp1_2.item(3)) - N(this.e))))) + N((N((N(this.Temp1_2.item(4)) - N(this.f))) * N((N(this.Temp1_2.item(4)) - N(this.f))))))))), (N((N(this.Temp2_2.item(3)) + N(25))) / N(2))) < 0)) - N(0));
                if (B((B(equals(this.g, "1")) && B(equals(this.h, "1"))))) {
                    this.e = "-";
                    return;
                }
            }
            this.k = N(this.k) + N(G.Number_of_data);
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Reset val %s %s %s"
    *Reset_val(v_name, sec, before) {
        // 遅延リセット: sec 秒待ってから、値が before のまま変わっていなければ戻す。
        // スクリプト側が broadcast 等で並行に起動する前提の手順。
        yield { waitSeconds: N(sec) };
        if (B(equals(v_name, "Sniping player"))) {
            if (B(equals(before, "0"))) {
                if (B(equals(G.Menu.item(90), "0"))) {
                    G.Sniping_player = "0000";
                }
            }
        }
        if (B(equals(v_name, "Team"))) {
            if (B(equals(before, "1"))) {
                // チームに自分 1 人だけが残っていたら解散してソロに戻る
                if (B(equals(N(G.Team.contains(S("1") + S(G.Team_ID))) - 0, "1"))) {
                    if (B(equals(G.TEAMMODE, "0"))) {
                        G.Team_color = "0";
                        G.Team_ID = G.ID;
                    }
                }
            }
        }
    }
    // procedure: "Draw character mission"
    *Draw_character_mission() {
        // 画面下端のミッション進捗バー。Character_tree[Tree+5] が上限、[+6] が現在値。
        this.a = G.Character_tree.item((N(G.Tree) + N(5)));
        this.b = G.Character_tree.item((N(G.Tree) + N(6)));
        if (B((!B(equals(this.a, this.b))))) {
            if (B((compare(this.b, (N(this.a) / N(10))) < 0))) {
                this.setPenColor("#424242");
            }
            else {
                this.setPenColor("#423200");
            }
            this.setPenSize(4);
            this.gotoXY(-240, -180);
            this.penDown();
            this.changeXBy(480);
            this.penUp();
            this.setPenColor("#e8aa00");
            this.gotoXY(-240, -180);
            this.penDown();
            this.changeXBy((N(480) / N((N(this.a) / N(this.b)))));
            this.penUp();
        }
    }
    // procedure: "Create user ID"
    *Create_user_ID() {
        // ユーザー名を「Font <文字>」コスチューム番号 + 10 の 2 桁コード列に変換し、
        // 20 文字分（40 桁）になるまで "00" で埋めて G.User_ID にする。
        // Pick up user name の復号と対になる符号化。
        this.a = "0";
        G.User_ID = "";
        const nameLen = Math.max(0, Math.floor(N(S(this.rt.username).length)));
        for (let i = 0; i < nameLen; i++) {
            this.a = N(this.a) + 1;
            this.switchCostume(S("Font ") + S(letterOf(this.rt.username, this.a)));
            G.User_ID = S(G.User_ID) + S(N(this.costumeNumberName("number")) + 10);
            if (!this.rt.warpActive)
                yield;
        }
        const pad = Math.max(0, Math.floor(N(20) - N(S(this.rt.username).length)));
        for (let i = 0; i < pad; i++) {
            G.User_ID = S(G.User_ID) + "00";
            if (!this.rt.warpActive)
                yield;
        }
    }
    // procedure: "Create guard %s"
    *Create_guard(position) {
        // ガード設置マス（Guard リストは [位置, 向き, 状態] の3つ組）を登録する。
        // 空き（"" の位置）があれば再利用し、Bullet_and_effect へはガード番号を積む。
        // Temp1 が "A" なら向きは "A"（BSガード）、それ以外は Temp1+180。
        if (G.Guard.contains("")) {
            G.Bullet_and_effect.add(N(G.Guard.itemNum("")) - 1);
            if (B(equals(this.Temp1, "A"))) {
                G.Guard.replace(N(G.Guard.itemNum("")) + 1, "A");
            }
            else {
                G.Guard.replace(N(G.Guard.itemNum("")) + 1, N(this.Temp1) + 180);
            }
            G.Guard.replace(N(G.Guard.itemNum("")) + 2, "0");
            G.Guard.replace(G.Guard.itemNum(""), position);
        }
        else {
            G.Bullet_and_effect.add(G.Guard.length);
            G.Guard.add(position);
            if (B(equals(this.Temp1, "A"))) {
                G.Guard.add("A");
            }
            else {
                G.Guard.add(N(this.Temp1) + 180);
            }
            G.Guard.add("0");
        }
    }
    // procedure: "Bullet wall %s %s"
    *Bullet_wall_2(position, damage) {
        // 弾が壁/ギミック/ガードに当たったかの判定（Bullet action から呼ばれる）。
        // 呼び出し前提: Temp1_2 = 弾レコード（[1]=所有者 [2]=種別）、
        // position = 弾のグリッド位置キー、damage = 弾量フラグ。結果は this.Bullet_wall。
        if (B(G.Bullet_wall.contains(position))) {
            this.Bullet_wall = "1";
            // ギミック壁なら、自分が撃った記録として My_shot にも残す
            // （Shot は 00..99 の 2 桁連番）
            if (B(equals(G.ID, this.Temp1_2.item(1)))) {
                if (B(equals(damage, "1"))) {
                    if (B(this.Gimmick_wall.contains(position))) {
                        G.Shot = N(G.Shot) + N(1);
                        if (B((compare("99", G.Shot) < 0))) {
                            G.Shot = "0";
                        }
                        if (B(equals(S(G.Shot).length, "1"))) {
                            G.Shot = (S("0") + S(G.Shot));
                        }
                        G.My_shot.add((S((N(this.Gimmick_wall.itemNum(position)) + N(800))) + S((S(G.Shot) + S("00")))));
                    }
                }
            }
        }
        else {
            this.Bullet_wall = "0";
            // ガード判定: Guard は [位置, 向き, 耐久] の 3 件組（走査位置は Menu[104]）。
            // 向きが "A"（全方位）か、弾の向きとの角度差 60 未満のときだけ弾を受け、
            // 耐久へ 弾量 × 所有者の field 24 を加算して即 return する。
            // 弾の向きは Bullet_damage テーブルの [+2] が指す Temp1_2 フィールド
            G.Menu.replace(104, "0");
            const guardSlots = Math.max(0, Math.floor(N((N(G.Guard.length) / N(3)))));
            for (let r = 0; r < guardSlots; r++) {
                if (B(equals(G.Guard.item((N(G.Menu.item(104)) + N(1))), position))) {
                    if (B((B(equals(G.Guard.item((N(G.Menu.item(104)) + N(2))), "A")) || B((compare(mathop("abs", (N(mod((N((N(G.Guard.item((N(G.Menu.item(104)) + N(2)))) - N(this.Temp1_2.item(G.Bullet_damage.item((N(G.Bullet_damage.itemNum(this.Temp1_2.item(2))) + N(2))))))) + N(180)), 360)) - N(180))), "60") < 0))))) {
                        this.Bullet_wall = "1";
                        if (B(equals(damage, "1"))) {
                            G.Guard.replace((N(G.Menu.item(104)) + N(3)), (N(G.Guard.item((N(G.Menu.item(104)) + N(3)))) + N((N(G.Bullet_damage.item((N(G.Bullet_damage.itemNum(this.Temp1_2.item(2))) + N(1)))) * N(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(this.Temp1_2.item(1)))) + N(23))))))));
                        }
                        return;
                    }
                }
                G.Menu.replace(104, (N(G.Menu.item(104)) + N(3)));
                if (!this.rt.warpActive)
                    yield;
            }
        }
    }
    // procedure: "Add player movement %s"
    *Add_player_movement(ID) {
        // 位置・モーションの補間キュー Player_movement への登録。
        // レコードは [キー "@<CLOUD 絶対位置>", レコードオフセット a, フィールド番号 b, 目標値 c] の
        // 4 つ組で、呼び出し時点の共有フィールド a / b / c をそのまま記録する。
        // 同じキーが既にあれば目標値（4 つ目）だけ差し替える。消費は Cloud が行う。
        if (B(this.Player_movement.contains(ID))) {
            this.Player_movement.replace(N(this.Player_movement.itemNum(ID)) + 3, this.c);
        }
        else {
            this.Player_movement.add(ID);
            this.Player_movement.add(this.a);
            this.Player_movement.add(this.b);
            this.Player_movement.add(this.c);
        }
    }
    // procedure: "Team invitation"
    *Team_invitation() {
        // チーム招待パネル。Menu[112] が招待元 ID（"0" でなし）、Menu[113] はパネルの
        // Y 位置（招待なし 233 / あり 183 へ M 追随）。表示中に対象チームのメンバーが
        // 5 人を超えたら招待を自動で破棄する。Confirm / Ignore のホバー判定もここ。
        if (B(equals(G.Menu.item(112), "0"))) {
            if (B((compare(G.Menu.item(113), "232") < 0))) {
                yield* this.CSM_menu("113", "233", "M", "3");
            }
        }
        else {
            yield* this.CSM_menu("113", "183", "M", "3");
        }
        if (B((compare(G.Menu.item(113), "232") < 0))) {
            this.a = G.Team.itemNum((S("2") + S(G.Menu.item(112))));
            this.b = "0";
            for (let i = 0; i < 5; i++) {
                this.a = N(this.a) + N(1);
                if (B((!B(equals(G.Team.item(this.a), ""))))) {
                    this.b = N(this.b) + N(1);
                    if (B((compare("4", this.b) < 0))) {
                        G.Menu.replace(112, "0");
                    }
                }
                if (!this.rt.warpActive)
                    yield;
            }
            this.gotoXY(-220, G.Menu.item(113));
            this.setPenColor("#404040");
            this.setPenSize(20);
            this.penDown();
            for (let i = 0; i < 4; i++) {
                this.changeXBy(150);
                this.changeXBy(-150);
                this.changeYBy(-10);
                if (!this.rt.warpActive)
                    yield;
            }
            this.changeXBy(150);
            this.changeYBy(40);
            this.penUp();
            this.changeXBy(-155);
            this.changeYBy(-12);
            if (B((!B(equals(G.Menu.item(112), "0"))))) {
                this.setEffect("COLOR", (N(G.Team_color_2.item(G.CLOUD.item((N(G.ID_num.item(G.IDs.itemNum(G.Menu.item(112)))) + N(27))))) * N(2)));
                yield* this.Draw_text("Team invitation", "65", "L", "-225");
                this.setEffect("COLOR", 0);
            }
            this.changeXBy(10);
            this.changeYBy(-18);
            if (B((B((B((compare("-221", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-148") < 0)))) && B((B((compare("140", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "160") < 0))))))) {
                if (B((!B(equals(G.Menu.item(112), "0"))))) {
                    this.Touch = G.ID_num.item(G.IDs.itemNum(G.Menu.item(112)));
                    this.Mouse_touch = "Confirm invitation";
                }
                this.setPenColor("#138200");
            }
            else {
                this.setPenColor("#083500");
            }
            this.setPenSize(12);
            this.penDown();
            this.changeXBy(60);
            this.changeYBy(-8);
            this.changeXBy(-60);
            this.changeYBy(8);
            this.penUp();
            this.changeXBy(80);
            if (B((B((B((compare("-141", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "-68") < 0)))) && B((B((compare("140", this.rt.mouse.y) < 0)) && B((compare(this.rt.mouse.y, "160") < 0))))))) {
                if (B((!B(equals(G.Menu.item(112), "0"))))) {
                    this.Mouse_touch = "Ignore invitation";
                }
                this.setPenColor("#820000");
            }
            else {
                this.setPenColor("#350000");
            }
            this.penDown();
            this.changeXBy(60);
            this.changeYBy(-8);
            this.changeXBy(-60);
            this.changeYBy(8);
            this.penUp();
            this.changeYBy(-4);
            this.setEffect("BRIGHTNESS", 100);
            yield* this.Draw_text("Ignore", "65", "C", "-105");
            yield* this.Draw_text("Confirm", "60", "C", "-185");
            this.setEffect("BRIGHTNESS", 0);
        }
    }
    // procedure: "Mobile"
    *Mobile() {
        // モバイル UI の描画と入力。左が移動スティック（Mobile_2[1..2] が基点、[12..13] が
        // スティック変位、[5] が角度）、右がコマンドボタン群（[3..4] が基点）。
        // ボタンの状態は Mobile_2[6..24] の各フラグへ書かれ、All や他スクリプトが読む。
        // 末尾はフリック計測（二乗距離 / FPS_temp → [24]）。
        this.gotoXY(0, 0);
        yield* this.Stamp(G.Mobile_2.item(1), G.Mobile_2.item(2), "100", "Mobile control");
        yield* this.Stamp((N((N(G.Mobile_2.item(1)) - N(39))) + N(G.Mobile_2.item(12))), (N((N(G.Mobile_2.item(2)) - N(5))) + N(G.Mobile_2.item(13))), "100", "Mobile cursor");
        this.a = (N(this.rt.mouse.x) - N(G.Mobile_2.item(1)));
        this.b = (N(this.rt.mouse.y) - N(G.Mobile_2.item(2)));
        if (B((B((compare(mathop("abs", this.a), "92") < 0)) && B((compare(mathop("abs", this.b), "56") < 0))))) {
            this.Mouse_touch = "Mobile control";
            if (B((compare("45", this.b) < 0))) {
                this.Mouse_touch = "Mobile control drag";
            }
            this.c = mathop("sqrt", (N((N((N(this.a) + N(39))) * N((N(this.a) + N(39))))) + N((N((N(this.b) + N(5))) * N((N(this.b) + N(5)))))));
            if (B((compare(this.c, "39") < 0))) {
                this.Mouse_touch = "Mobile stick";
                this.Touch = this.c;
            }
        }
        this.setY((N(G.Mobile_2.item(2)) + N(35)));
        this.setPenSize(20);
        this.a = "7";
        for (let i = 0; i < 3; i++) {
            this.setX((N(G.Mobile_2.item(1)) + N(17)));
            this.setPenColor("#828282");
            this.penDown();
            this.changeXBy(40);
            this.penUp();
            this.changeXBy(20);
            if (B(equals(G.Mobile_2.item(this.a), "1"))) {
                this.setPenColor("#9a0000");
            }
            if (B((B(equals(this.Clicking, "1")) && B((compare(this.distanceToMouse(), "10") < 0))))) {
                if (B(equals(G.Mobile_2.item(this.a), "1"))) {
                    G.Mobile_2.replace(this.a, "0");
                }
                else {
                    G.Mobile_2.replace(this.a, "1");
                }
            }
            this.penDown();
            this.penUp();
            this.changeYBy(-26);
            this.a = N(this.a) + N(1);
            if (!this.rt.warpActive)
                yield;
        }
        this.setEffect("BRIGHTNESS", 100);
        this.setX((N(G.Mobile_2.item(1)) + N(7)));
        this.setPenColor("#828282");
        this.a = "10";
        for (let i = 0; i < 4; i++) {
            this.penDown();
            if (B((B(equals(this.Clicking, "1")) && B((compare(this.distanceToMouse(), "10") < 0))))) {
                if (B((compare("11", this.a) < 0))) {
                    G.Mobile_2.replace(6, (N(this.a) - N(8)));
                }
                else {
                    G.Mobile_2.replace(this.a, "1");
                }
            }
            this.penUp();
            yield* this.Draw_text(letterOf("         SF45", this.a), "65", "C", (N(this.x) + N(1)));
            this.changeXBy(22);
            this.a = N(this.a) + N(1);
            if (!this.rt.warpActive)
                yield;
        }
        this.gotoXY((N(G.Mobile_2.item(1)) + N(37)), (N(G.Mobile_2.item(2)) + N(35)));
        this.a = "0";
        for (let i = 0; i < 3; i++) {
            this.a = N(this.a) + N(1);
            if (B((B(equals(this.Clicking, "1")) && B((B((compare(mathop("abs", (N(this.rt.mouse.x) - N(this.x))), "30") < 0)) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "10") < 0))))))) {
                G.Mobile_2.replace(6, this.a);
            }
            yield* this.Draw_text(this.a, "65", "C", (N(this.x) + N(1)));
            this.changeXBy(-1);
            this.changeYBy(-26);
            if (!this.rt.warpActive)
                yield;
        }
        this.setEffect("BRIGHTNESS", 0);
        yield* this.Stamp(G.Mobile_2.item(3), G.Mobile_2.item(4), "100", "Mobile command");
        this.setY((N(G.Mobile_2.item(4)) + N(17)));
        this.setPenColor("#828282");
        this.setPenSize(13);
        this.a = "3";
        for (let i = 0; i < 2; i++) {
            this.setX((N(G.Mobile_2.item(3)) + N(-53)));
            const cells = Math.max(0, Math.floor(N(this.a)));
            for (let r = 0; r < cells; r++) {
                this.penDown();
                this.changeXBy(13);
                this.changeYBy(-13);
                this.changeXBy(-13);
                this.changeYBy(13);
                this.penUp();
                this.changeXBy(30);
                if (!this.rt.warpActive)
                    yield;
            }
            this.changeYBy(-30);
            this.a = N(this.a) + N(1);
            if (!this.rt.warpActive)
                yield;
        }
        this.a = "3";
        this.b = "0";
        this.setY((N(G.Mobile_2.item(4)) + N(10)));
        this.setEffect("BRIGHTNESS", 100);
        for (let i = 0; i < 2; i++) {
            this.setX((N(G.Mobile_2.item(3)) + N(-53)));
            const cells = Math.max(0, Math.floor(N(this.a)));
            for (let r = 0; r < cells; r++) {
                this.b = N(this.b) + N(1);
                if (B((B(equals(this.b, "2")) || B((compare("3", this.b) < 0))))) {
                    G.Mobile_2.replace((N(this.b) + N(13)), "0");
                }
                if (B((B(this.rt.mouse.down) && B((B((B((compare((N(this.x) - N(7)), this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, (N(this.x) + N(19))) < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(this.y))), "13") < 0))))))) {
                    if (B((B(equals(this.b, "1")) || B(equals(this.b, "3"))))) {
                        if (B(equals(this.Clicking, "1"))) {
                            G.Mobile_2.replace((N(this.b) + N(13)), "1");
                        }
                    }
                    else {
                        G.Mobile_2.replace((N(this.b) + N(13)), "1");
                    }
                }
                yield* this.Draw_text(letterOf("THPZXCV", this.b), "80", "L", this.x);
                this.changeXBy(30);
                if (!this.rt.warpActive)
                    yield;
            }
            this.changeYBy(-30);
            this.a = N(this.a) + N(1);
            if (!this.rt.warpActive)
                yield;
        }
        this.setEffect("BRIGHTNESS", 0);
        this.a = (N(this.rt.mouse.x) - N(G.Mobile_2.item(3)));
        this.b = (N(this.rt.mouse.y) - N(G.Mobile_2.item(4)));
        if (B((B((compare(mathop("abs", this.a), "61") < 0)) && B((compare(mathop("abs", this.b), "43") < 0))))) {
            this.Mouse_touch = "Mobile command";
            if (B((compare("31", this.b) < 0))) {
                this.Mouse_touch = "Mobile command drag";
            }
        }
        if (B((B(this.rt.mouse.down) && B(equals(this.Mouse_touch, "Shot"))))) {
            G.Mobile_2.replace(24, (N((N((N((N(this.rt.mouse.x) - N(G.Mobile_2.item(21)))) * N((N(this.rt.mouse.x) - N(G.Mobile_2.item(21)))))) + N((N((N(this.rt.mouse.y) - N(G.Mobile_2.item(22)))) * N((N(this.rt.mouse.y) - N(G.Mobile_2.item(22)))))))) / N(G.FPS_temp)));
            G.Mobile_2.replace(21, this.rt.mouse.x);
            G.Mobile_2.replace(22, this.rt.mouse.y);
        }
        else {
            G.Mobile_2.replace(24, "0");
        }
        G.Mobile_2.replace(23, "0");
        if (B((compare(G.Inventory_2.item(31), "4") < 0))) {
            G.Mobile_2.replace(23, G.Mobile_2.item((N(G.Inventory_2.item(31)) + N(6))));
        }
    }
    // procedure: "Add combat data %s %s %s"
    *Add_combat_data(type, val1, val2) {
        // 戦闘レコードを G.Combat data へ 7 フィールドで追加する
        // [種別, OtherCP, CP_freq, val1, val2（相手 ID）, Special weapon,
        //  相手レコードの 45 番フィールド]。Combat rating が集計に使う。
        // 追加のたびに CP_freq は 0 に戻る。
        G.Combat_data.add(type);
        G.Combat_data.add(this.OtherCP);
        G.Combat_data.add(G.CP_freq);
        G.Combat_data.add(val1);
        G.Combat_data.add(val2);
        G.Combat_data.add(G.Special_weapon);
        G.Combat_data.add(G.CLOUD.item(N(G.ID_num.item(G.IDs.itemNum(val2))) + 44));
        G.CP_freq = "0";
    }
    // procedure: "Draw team point"
    *Draw_team_point() {
        // TEAMMODE の上部表示。TEAMMODE_2[5] が "0" のときはチーム選択
        // （ホバーで Mouse_touch = "Red team" / "Blue team"）、他はスコアバーと勝敗表示。
        this.setPenColor("#000000");
        this.setPenSize(50);
        this.setPenParam(S("transparency"), 100);
        this.gotoXY(-240, 170);
        this.penDown();
        this.setPenParam(S("transparency"), 80);
        this.changeXBy(480);
        this.changeXBy(-480);
        this.penUp();
        if (B(equals(G.TEAMMODE_2.item(5), "0"))) {
            this.gotoXY(-230, 160);
            this.setEffect("BRIGHTNESS", 100);
            yield* this.Draw_text("Team select", "100", "L", "-230");
            this.setEffect("BRIGHTNESS", 0);
            this.a = "0";
            this.gotoXY(-30, 160);
            for (let i = 0; i < 2; i++) {
                if (B(equals(G.TEAMMODE_2.item(6), (N(this.a) + N(1))))) {
                    this.setPenColor("#ff0000");
                }
                else {
                    if (B((B((B(equals(this.a, "0")) && B((B((B((compare("-40", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "80") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(160))), "11") < 0)))))) || B((B(equals(this.a, "1")) && B((B((B((compare("100", this.rt.mouse.x) < 0)) && B((compare(this.rt.mouse.x, "220") < 0)))) && B((compare(mathop("abs", (N(this.rt.mouse.y) - N(160))), "11") < 0))))))))) {
                        if (B(equals(this.a, "0"))) {
                            this.Mouse_touch = "Red team";
                        }
                        else {
                            this.Mouse_touch = "Blue team";
                        }
                        this.setPenColor("#c10000");
                    }
                    else {
                        this.setPenColor("#820000");
                    }
                }
                this.setPenSize(20);
                this.setPenParam(S("color"), G.Team_color_2.item(G.TEAMMODE_2.item((N(this.a) + N(8)))));
                this.penDown();
                this.changeXBy(100);
                this.penUp();
                this.changeXBy(40);
                this.a = N(this.a) + N(1);
                if (!this.rt.warpActive)
                    yield;
            }
        }
        else {
            this.a = (N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(4)));
            if (B((compare(this.a, "200") < 0))) {
                this.a = "200";
            }
            this.setPenColor("#000000");
            this.setPenSize(6);
            this.gotoXY(-220, 155);
            this.penDown();
            this.changeXBy(440);
            this.changeXBy(-440);
            this.penUp();
            this.setPenColor("#9a0000");
            this.setPenParam(S("color"), G.Team_color_2.item(G.TEAMMODE_2.item(8)));
            this.penDown();
            this.changeXBy((N(440) / N((N(this.a) / N(G.TEAMMODE_2.item(3))))));
            this.penUp();
            this.setPenParam(S("color"), G.Team_color_2.item(G.TEAMMODE_2.item(9)));
            this.gotoXY(220, 155);
            this.penDown();
            this.changeXBy((N(-440) / N((N(this.a) / N(G.TEAMMODE_2.item(4))))));
            this.penUp();
            this.gotoXY(-220, 165);
            this.setEffect("COLOR", (N(G.Team_color_2.item(G.TEAMMODE_2.item(8))) * N(2)));
            yield* this.Draw_text(G.TEAMMODE_2.item(3), "100", "L", "-220");
            this.gotoXY(220, 165);
            this.setEffect("COLOR", (N(G.Team_color_2.item(G.TEAMMODE_2.item(9))) * N(2)));
            yield* this.Draw_text(G.TEAMMODE_2.item(4), "100", "R", "220");
            this.setEffect("COLOR", 0);
            this.gotoXY(0, 165);
            this.setEffect("BRIGHTNESS", 100);
            if (B(equals(G.TEAMMODE_2.item(5), "2"))) {
                if (B((compare("400", G.X) < 0))) {
                    yield* this.Put_buff("平和", "5");
                }
                if (B((B(equals(G.TEAMMODE_2.item(3), G.TEAMMODE_2.item(4))) || B((compare((N(G.TEAMMODE_2.item(3)) + N(G.TEAMMODE_2.item(4))), "100") < 0))))) {
                    this.b = "DRAW";
                }
                else {
                    if (B((B((B(equals(letterOf(G.Team_ID, 1), "1")) && B((compare(G.TEAMMODE_2.item(4), G.TEAMMODE_2.item(3)) < 0)))) || B((B(equals(letterOf(G.Team_ID, 1), "2")) && B((compare(G.TEAMMODE_2.item(3), G.TEAMMODE_2.item(4)) < 0))))))) {
                        this.b = "WIN";
                    }
                    else {
                        this.b = "LOSE";
                    }
                }
                yield* this.Draw_text(this.b, (N(90) + N((N(mathop("sin", (N(this.rt.timer()) * N(300)))) * N(5)))), "C", "0");
                if (B((!B(equals(this.b, "DRAW"))))) {
                    this.gotoXY(0, 150);
                    if (B((compare(G.TEAMMODE_2.item(4), G.TEAMMODE_2.item(3)) < 0))) {
                        yield* this.Draw_text((S("MVP: ") + S(G.TEAMMODE_2.item(18))), "50", "C", "0");
                    }
                    else {
                        yield* this.Draw_text((S("MVP: ") + S(G.TEAMMODE_2.item(19))), "50", "C", "0");
                    }
                }
            }
            else {
                yield* this.Draw_text(G.TEAMMODE_2.item(7), "100", "C", "0");
            }
            this.setEffect("BRIGHTNESS", 0);
        }
    }
    // procedure: "Static data %s"
    *Static_data(modificate) {
        // Temp1_2（Load cloud data のスキル節で積んだ保留値キュー）の先頭を
        // Pickupped の末尾へ移す。modificate が "" のとき、または値が "-"
        // （プレースホルダ）のときはそのまま、それ以外は modificate を加算して移す。
        // 移した分はキューから消える（シフトレジスタとして働く）。
        if (B(equals(modificate, "")) || B(equals(this.Temp1_2.item(1), "-"))) {
            this.Pickupped.add(this.Temp1_2.item(1));
        }
        else {
            this.Pickupped.add(N(this.Temp1_2.item(1)) + N(modificate));
        }
        this.Temp1_2.delete(1);
    }
}
