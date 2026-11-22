// TurboWarp 風プレイヤー: ランタイム + 生成コードを起動し、入力を Scratch 座標系で渡す。
// 流れは TurboWarp のプロジェクトページに合わせる:
//   赤い読み込み画面（進捗バー）→ 読み込み完了で初期フレーム表示 → 緑の旗で開始。
import { Runtime } from "./runtime/runtime.js";
import { createProject } from "./generated/project.js";
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
