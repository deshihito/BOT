// TurboWarp 風プレイヤー: ランタイム + 生成コードを起動し、入力を Scratch 座標系で渡す。
// 流れは TurboWarp のプロジェクトページに合わせる:
//   赤い読み込み画面（進捗バー）→ 読み込み完了で初期フレーム表示 → 緑の旗で開始。
import { Runtime } from "./runtime/runtime.js";
import { createProject } from "./generated/project.js";
import { G } from "./generated/globals.js";
const canvas = document.getElementById("stage");
const stageWrap = document.getElementById("stage-wrap");
const rt = new Runtime();
const params = new URLSearchParams(location.search);
rt.username = params.get("user") ?? "";
createProject(rt);
// ---- 読み込み画面 ----
const loaderEl = document.getElementById("loader");
const loadFill = document.getElementById("loadbar-fill");
const toolbarEl = document.getElementById("toolbar");
const pauseBtn = document.getElementById("pause");
const allImages = [
    ...rt.backdrop.images,
    ...rt.sprites.flatMap((s) => s.costumeImages.filter((i) => i !== null)),
];
let settledImages = 0;
let loadFinished = false;
let loopStarted = false;
function renderLoadProgress() {
    const total = allImages.length;
    const pct = total === 0 ? 100 : Math.floor((settledImages / total) * 100);
    loadFill.style.width = `${pct}%`;
}
function finishLoad() {
    if (loadFinished)
        return;
    loadFinished = true;
    loadFill.style.width = "100%";
    // 読み込み完了: ループを開始して初期フレーム（タイトル画面）を表示する。
    // ゲームの開始は TurboWarp と同じく緑の旗で行う。
    if (!loopStarted) {
        loopStarted = true;
        rt.startLoop(canvas);
    }
    toolbarEl.classList.remove("loading");
    loaderEl.classList.add("done");
    setTimeout(() => loaderEl.remove(), 500);
}
if (allImages.length === 0) {
    finishLoad();
}
else {
    for (const img of allImages) {
        if (img.complete) {
            settledImages++;
        }
        else {
            const done = () => {
                settledImages++;
                renderLoadProgress();
                if (settledImages >= allImages.length)
                    finishLoad();
            };
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
        }
    }
    renderLoadProgress();
    if (settledImages >= allImages.length)
        finishLoad();
    setTimeout(finishLoad, 45000); // 保険: 一部アセットが詰まっても表示は進める
}
// [AGO patch] 既定で TurboWarp クラウドサーバーへ接続し、本家 TACT-AIM と
// 同じクラウドデータ (project_id=831274817) を共有する (オンライン)。
// ?cloud=off でオフライン、?cloud=wss://... で別サーバー、?project= で上書き。
// TACT-AIM-distilled 本体はコピーとして無変更。詳細は AGO_PATCHES.md。
const cloudParam = params.get("cloud");
if (cloudParam !== "off") {
    const cloudUrl = cloudParam ?? "wss://clouddata.turbowarp.org";
    const cloudProject = params.get("project") ?? (cloudParam ? "TACT-AIM-distilled" : "831274817");
    rt.cloud.connect(cloudUrl, rt.username || "player", cloudProject);
}
function normalizeKey(key) {
    if (key === " ")
        return "space";
    if (key === "ArrowUp")
        return "up arrow";
    if (key === "ArrowDown")
        return "down arrow";
    if (key === "ArrowLeft")
        return "left arrow";
    if (key === "ArrowRight")
        return "right arrow";
    if (key === "Enter")
        return "enter";
    if (key.length === 1)
        return key.toLowerCase();
    return key.toLowerCase();
}
canvas.addEventListener("mousemove", (e) => {
    const rect = canvas.getBoundingClientRect();
    rt.mouse.x = ((e.clientX - rect.left) / rect.width) * 480 - 240;
    rt.mouse.y = 180 - ((e.clientY - rect.top) / rect.height) * 360;
});
canvas.addEventListener("mousedown", () => { rt.mouse.down = true; });
window.addEventListener("mouseup", () => { rt.mouse.down = false; });
// タッチ操作（スマホ）: タップ位置をマウス座標として渡す
canvas.addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (!t)
        return;
    const rect = canvas.getBoundingClientRect();
    rt.mouse.x = ((t.clientX - rect.left) / rect.width) * 480 - 240;
    rt.mouse.y = 180 - ((t.clientY - rect.top) / rect.height) * 360;
    rt.mouse.down = true;
}, { passive: true });
canvas.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (!t)
        return;
    const rect = canvas.getBoundingClientRect();
    rt.mouse.x = ((t.clientX - rect.left) / rect.width) * 480 - 240;
    rt.mouse.y = 180 - ((t.clientY - rect.top) / rect.height) * 360;
}, { passive: true });
window.addEventListener("touchend", () => { rt.mouse.down = false; });
window.addEventListener("keydown", (e) => {
    const k = normalizeKey(e.key);
    if (!rt.keysDown.has(k)) {
        rt.keyPressedEvent(k);
        rt.keyPressedEvent("any");
    }
    rt.keysDown.add(k);
    if (["up arrow", "down arrow", "left arrow", "right arrow", "space"].includes(k))
        e.preventDefault();
});
window.addEventListener("keyup", (e) => {
    rt.keysDown.delete(normalizeKey(e.key));
});
// ---- ツールバー ----
document.getElementById("flag")?.addEventListener("click", () => {
    if (!loopStarted) {
        loopStarted = true;
        rt.startLoop(canvas);
    }
    pauseBtn.classList.remove("active");
    rt.greenFlag();
});
pauseBtn.addEventListener("click", () => {
    rt.paused = !rt.paused;
    pauseBtn.classList.toggle("active", rt.paused);
});
document.getElementById("stop")?.addEventListener("click", () => {
    pauseBtn.classList.remove("active");
    rt.stopAll();
});
document.getElementById("fullscreen")?.addEventListener("click", () => {
    if (document.fullscreenElement)
        void document.exitFullscreen();
    else
        void stageWrap.requestFullscreen();
});
// ---- ユーザー名（クラウド注意ボックス内の「ユーザー名を変更」） ----
const usernameInput = document.getElementById("username");
const usernameCurrent = document.getElementById("username-current");
const usernameRow = document.getElementById("username-row");
function renderUsername() {
    usernameCurrent.textContent = rt.username || "（未設定）";
}
usernameInput.value = rt.username;
renderUsername();
document.getElementById("username-change")?.addEventListener("click", () => {
    usernameRow.classList.toggle("open");
    if (usernameRow.classList.contains("open"))
        usernameInput.focus();
});
document.getElementById("username-set")?.addEventListener("click", () => {
    rt.username = usernameInput.value;
    renderUsername();
    usernameRow.classList.remove("open");
});
// ask and wait の UI
const askBox = document.getElementById("ask");
const askLabel = document.getElementById("ask-label");
const askInput = document.getElementById("ask-input");
document.getElementById("ask-send")?.addEventListener("click", () => {
    rt.submitAnswer(askInput.value);
    askInput.value = "";
});
setInterval(() => {
    if (rt.askState && askBox.style.display !== "flex") {
        askLabel.textContent = rt.askState.question;
        askBox.style.display = "flex";
        askInput.focus();
    }
    else if (!rt.askState && askBox.style.display === "flex") {
        askBox.style.display = "none";
    }
}, 100);
// ---- AGO パッチ: Fujimi 管理者モード（AGO_PATCHES.md 旧7） ----
// ユーザー名が "Fujimi"（大文字小文字は不問）の間だけ、原作の作者
// テストプレイ解禁（uk-400 / kz-104 が "u" キーで発動するもの）と同形で、
// コイン 20000 / キャラクターツリー全開放 / テクタイト 40 を維持する。
// 加えて防御と耐爆の 99% 軽減が常時付くよう、護身+ を 1 つだけ常駐させる
// （軽減率は Buff テーブル側の AGO パッチで護身+ の係数を -0.99 に変更）。
// さらにキャラステータスを直接補正する: 攻撃力（Character_2 の +3）を
// 100 倍、再生レート（+8）を 20 倍。キャラが変わったら元の値に戻してから
// 掛け直し、管理者モードを抜けたら元の値に戻す。
// 注意: 攻撃力はクラウド送信時に Pen_All.js 側の AGO パッチでワイヤ形式の
// 上限（係数 8.99 = 3 文字フィールド）にクランプされる。100 倍のまま送ると
// 桁あふれで受信側が 0.01 倍と誤読し、後続フィールドまでずれて攻撃が
// 通らなくなる（2026-11-24 ユーザー報告の原因）。
// 完全ノーダメージ化・強ホーミング・命中時確定キルは Pen_All.js 側の AGO パッチ。
let statBase = null;
let statOrigAtk = null;
let statOrigRegen = null;
function restoreAdminStats() {
    if (statBase === null)
        return;
    G.Character_2.replace(Number(statBase) + 3, statOrigAtk);
    G.Character_2.replace(Number(statBase) + 8, statOrigRegen);
    statBase = null;
}
setInterval(() => {
    if ((rt.username || "").toLowerCase() !== "fujimi") {
        restoreAdminStats();
        return;
    }
    G.Money = "20000";
    G.Tektite = "40";
    // キャラクターツリー全開放: 作者解禁と同じく、各レコード（10 項目）の
    // 6 項目目を 5 項目目（必要量）で上書きする
    for (let a = 6; a <= G.Character_tree.length; a += 10) {
        G.Character_tree.replace(a, G.Character_tree.item(a - 1));
    }
    // 護身+ は 1 つだけ維持する。重複すると軽減が 100% を超えて
    // ダメージが負になるため、2 つ目以降は取り除く
    let found = false;
    for (let i = G.Buff_Debuff.length; i >= 2; i -= 2) {
        if (G.Buff_Debuff.item(i - 1) === "護身+") {
            if (found) {
                G.Buff_Debuff.delete(i);
                G.Buff_Debuff.delete(i - 1);
            }
            else {
                found = true;
                G.Buff_Debuff.replace(i, "999999");
            }
        }
    }
    if (!found) {
        G.Buff_Debuff.add("護身+");
        G.Buff_Debuff.add("999999");
    }
    // 攻撃力 100 倍 / 再生 20 倍（Character_2 の現在キャラのレコードを補正）
    if (statBase !== String(G.Character)) {
        restoreAdminStats();
        statBase = String(G.Character);
        statOrigAtk = G.Character_2.item(Number(statBase) + 3);
        statOrigRegen = G.Character_2.item(Number(statBase) + 8);
    }
    G.Character_2.replace(Number(statBase) + 3, Number(statOrigAtk) * 100);
    G.Character_2.replace(Number(statBase) + 8, Number(statOrigRegen) * 20);
}, 500);
