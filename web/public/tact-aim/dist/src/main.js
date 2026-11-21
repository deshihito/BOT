// 開発用プレイヤー: ランタイム + 生成コードを起動し、入力を Scratch 座標系で渡す。
import { Runtime } from "./runtime/runtime.js";
import { createProject } from "./generated/project.js";
const canvas = document.getElementById("stage");
const rt = new Runtime();
const params = new URLSearchParams(location.search);
const userInput = document.getElementById("username");
rt.username = params.get("user") ?? "";
createProject(rt);
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
rt.startLoop(canvas);
rt.greenFlag();
