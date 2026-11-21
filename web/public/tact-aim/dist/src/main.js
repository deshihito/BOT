// 開発用プレイヤー: ランタイム + 生成コードを起動し、入力を Scratch 座標系で渡す。
import { Runtime } from "./runtime/runtime.js";
import { createProject } from "./generated/project.js";
const canvas = document.getElementById("stage");
const rt = new Runtime();
const params = new URLSearchParams(location.search);
const userInput = document.getElementById("username");
rt.username = params.get("user") ?? "";
createProject(rt);
// ---- ローディング画面（TurboWarp 風） ----
// コスチューム画像の読み込み進捗を表示し、全て揃ってから起動する。
// 起動後もゲーム側の描画が始まるまで「起動中」表示（経過秒・描画回数）を出す。
const loaderEl = document.getElementById("loader");
const loadFill = document.getElementById("loadbar-fill");
const loadPct = document.getElementById("load-pct");
const loadStatus = document.getElementById("load-status");
const loadHint = document.getElementById("load-hint");
const flagBtn = document.getElementById("flag");
let drawCount = 0;
const penLayer = rt.penLayer;
const origDrawLine = penLayer.drawLine.bind(penLayer);
penLayer.drawLine = (...args) => { drawCount++; return origDrawLine(...args); };
const origStampImage = penLayer.stampImage.bind(penLayer);
penLayer.stampImage = (...args) => { drawCount++; return origStampImage(...args); };
const allImages = [
    ...rt.backdrop.images,
    ...rt.sprites.flatMap((s) => s.costumeImages.filter((i) => i !== null)),
];
let settledImages = 0;
let gameStarted = false;
function renderLoadProgress() {
    const total = allImages.length;
    const pct = total === 0 ? 100 : Math.floor((settledImages / total) * 100);
    loadFill.style.width = `${pct}%`;
    loadPct.textContent = `${pct}%`;
    loadStatus.textContent = `アセット読み込み中 ${settledImages} / ${total}`;
}
function startGame() {
    if (gameStarted)
        return;
    gameStarted = true;
    flagBtn.disabled = false;
    loaderEl.classList.add("booting");
    loadFill.style.width = "100%";
    loadPct.textContent = "";
    loadHint.textContent = "起動シーケンスは原作仕様で 1〜3 分かかります（タップで閉じる）";
    const t0 = performance.now();
    rt.startLoop(canvas);
    rt.greenFlag();
    const hideLoader = () => {
        clearInterval(timer);
        loaderEl.classList.add("done");
        setTimeout(() => loaderEl.remove(), 700);
    };
    const timer = setInterval(() => {
        const sec = Math.floor((performance.now() - t0) / 1000);
        loadStatus.textContent = `起動中… ${sec} 秒 / 描画 ${drawCount} 回 / threads ${rt.activeThreadCount}`;
        if (drawCount >= 200 || sec >= 12)
            hideLoader();
    }, 250);
    loaderEl.addEventListener("click", hideLoader);
}
if (allImages.length === 0) {
    startGame();
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
                    startGame();
            };
            img.addEventListener("load", done, { once: true });
            img.addEventListener("error", done, { once: true });
        }
    }
    renderLoadProgress();
    if (settledImages >= allImages.length)
        startGame();
    setTimeout(startGame, 45000); // 保険: 一部アセットが詰まっても起動はする
}
// クラウドサーバーが指定されていれば接続する（TurboWarp cloud-server 互換プロトコル）
const cloudUrl = params.get("cloud");
if (cloudUrl) {
    rt.cloud.connect(cloudUrl, rt.username || "player", params.get("project") ?? "TACT-AIM-distilled");
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
document.getElementById("flag")?.addEventListener("click", () => {
    rt.username = userInput.value;
    rt.greenFlag();
});
document.getElementById("stop")?.addEventListener("click", () => rt.stopAll());
userInput.addEventListener("change", () => { rt.username = userInput.value; });
// ask and wait の UI
const askBox = document.getElementById("ask");
const askLabel = document.getElementById("ask-label");
const askInput = document.getElementById("ask-input");
document.getElementById("ask-send")?.addEventListener("click", () => {
    rt.submitAnswer(askInput.value);
    askInput.value = "";
});
setInterval(() => {
    if (rt.askState && askBox.style.display === "none") {
        askLabel.textContent = rt.askState.question;
        askBox.style.display = "block";
        askInput.focus();
    }
    else if (!rt.askState && askBox.style.display !== "none") {
        askBox.style.display = "none";
    }
}, 100);
// スレッド数の表示（デバッグ用）
const dbg = document.getElementById("debug");
setInterval(() => {
    dbg.textContent = `threads: ${rt.activeThreadCount}`;
}, 500);
// 起動はローディング画面側（アセット完了後）が startLoop + greenFlag を行う。
