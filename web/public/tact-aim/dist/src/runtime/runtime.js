// Scratch 意味論ランタイム: スケジューラ（generator ベースのスレッド）、
// スプライト、入力、サウンド、クラウド変数。
//
// スレッドモデル（scratch-vm 相当）:
// - 各スクリプト/手順は generator 関数になる
// - 非 warp のループ境界では `yield` して次フレームへ回す
// - warp 手順内ではループ境界で yield しない（画面更新なしで最後まで走る）
// - wait 系は YieldCmd を返してスケジューラが再開条件を見る
import { toNumber, toString, setRngSource } from "./cast.js";
import { PenLayer, defaultPenState, setPenColorToColor, setPenParam, changePenParam } from "./pen.js";
const ASSET_BASE = "assets/";
export class Sprite {
    rt;
    name;
    x = 0;
    y = 0;
    direction = 90;
    size = 100;
    visible = true;
    rotationStyle = "all around";
    costumeIndex = 0;
    costumes = [];
    costumeImages = [];
    sounds = [];
    effects = new Map();
    pen = defaultPenState();
    constructor(rt, name) {
        this.rt = rt;
        this.name = name;
    }
    /** 生成クラスが override する。 */
    registerHats() { }
    /** sensing_of 用: 元の変数名でローカル変数を引く（生成クラスが override）。 */
    varByName(_name) {
        return 0;
    }
    /** 名前で音を鳴らす（引数で名前が渡る sound_play 用）。 */
    playSoundByName(name) {
        const s = this.sounds.find((snd) => snd.name === name);
        if (s)
            this.rt.soundPlay(s.assetFile);
    }
    // ---- 動き（ペン描画フック付き） ----
    moveTo(nx, ny) {
        const ox = this.x, oy = this.y;
        this.x = nx;
        this.y = ny;
        if (this.pen.penDown && (ox !== nx || oy !== ny)) {
            this.rt.penLayer.drawLine(this.pen, ox, oy, nx, ny);
        }
    }
    setX(v) { this.moveTo(toNumber(v), this.y); }
    setY(v) { this.moveTo(this.x, toNumber(v)); }
    changeXBy(v) { this.moveTo(this.x + toNumber(v), this.y); }
    changeYBy(v) { this.moveTo(this.x, this.y + toNumber(v)); }
    gotoXY(xv, yv) { this.moveTo(toNumber(xv), toNumber(yv)); }
    moveSteps(v) {
        const n = toNumber(v);
        const rad = (this.direction * Math.PI) / 180;
        this.moveTo(this.x + n * Math.sin(rad), this.y + n * Math.cos(rad));
    }
    pointInDirection(v) {
        let d = toNumber(v);
        // Scratch の向きは -180..180 に正規化される
        d = ((d + 180) % 360 + 360) % 360 - 180;
        if (d === -180)
            d = 180;
        this.direction = d;
    }
    turnRight(v) { this.pointInDirection(this.direction + toNumber(v)); }
    turnLeft(v) { this.pointInDirection(this.direction - toNumber(v)); }
    distanceToMouse() {
        const dx = this.x - this.rt.mouse.x;
        const dy = this.y - this.rt.mouse.y;
        return Math.sqrt(dx * dx + dy * dy);
    }
    // ---- 見た目 ----
    loadCostumeImages() {
        this.costumeImages = this.costumes.map((c) => {
            const img = new Image();
            img.src = ASSET_BASE + c.assetFile;
            return img;
        });
    }
    switchCostume(v) {
        if (this.costumes.length === 0)
            return;
        this.rt.redrawRequested = true;
        if (typeof v === "number" || (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v)))) {
            // 数値（または数値文字列）: 1始まり、範囲外は回り込む
            const n = Math.round(toNumber(v));
            const len = this.costumes.length;
            this.costumeIndex = (((n - 1) % len) + len) % len;
            return;
        }
        const idx = this.costumes.findIndex((c) => c.name === v);
        if (idx >= 0)
            this.costumeIndex = idx;
    }
    nextCostume() {
        if (this.costumes.length === 0)
            return;
        this.rt.redrawRequested = true;
        this.costumeIndex = (this.costumeIndex + 1) % this.costumes.length;
    }
    costumeNumberName(kind) {
        if (kind === "name")
            return this.costumes[this.costumeIndex]?.name ?? "";
        return this.costumeIndex + 1;
    }
    setEffect(name, v) { this.effects.set(name, toNumber(v)); }
    changeEffect(name, v) {
        this.effects.set(name, (this.effects.get(name) ?? 0) + toNumber(v));
    }
    clearEffects() { this.effects.clear(); }
    /** このスプライトの描画（ステージ座標→キャンバス変換は呼び出し側）。 */
    draw(ctx, scale) {
        if (!this.visible)
            return;
        const img = this.costumeImages[this.costumeIndex];
        const info = this.costumes[this.costumeIndex];
        if (!img || !info || !img.complete || img.naturalWidth === 0)
            return;
        const w = img.naturalWidth * (this.size / 100);
        const h = img.naturalHeight * (this.size / 100);
        const cx = (this.x + 240) * scale;
        const cy = (180 - this.y) * scale;
        ctx.save();
        ctx.translate(cx, cy);
        // 向き: Scratch は 90 度が右向き。コスチュームは右向きで描かれている前提
        let flipX = false;
        if (this.rotationStyle === "left-right") {
            flipX = this.direction < 0;
        }
        else if (this.rotationStyle === "all around") {
            ctx.rotate(((this.direction - 90) * Math.PI) / 180);
        }
        if (flipX)
            ctx.scale(-1, 1);
        const ghost = this.effects.get("ghost") ?? 0;
        ctx.globalAlpha = Math.max(0, Math.min(1, 1 - ghost / 100));
        const filters = [];
        const brightness = this.effects.get("brightness") ?? 0;
        if (brightness !== 0)
            filters.push(`brightness(${1 + brightness / 100})`);
        const color = this.effects.get("color") ?? 0;
        if (color !== 0)
            filters.push(`hue-rotate(${color * 1.8}deg)`);
        // fisheye / whirl / pixelate / mosaic は Canvas 2D では再現できない（WebGL シェーダ効果）。
        // 値だけ保持し描画は近似する。docs/COVERAGE.md の既知の差異を参照。
        if (filters.length > 0)
            ctx.filter = filters.join(" ");
        const rcx = (info.rotationCenterX - img.naturalWidth / 2) * (this.size / 100) * (flipX ? -1 : 1);
        const rcy = (info.rotationCenterY - img.naturalHeight / 2) * (this.size / 100);
        ctx.drawImage(img, (-w / 2 - rcx) * scale, (-h / 2 - rcy) * scale, w * scale, h * scale);
        ctx.restore();
    }
    // ---- ペン ----
    penDown() {
        this.pen.penDown = true;
        // Scratch 3 ではペンを下ろした時点で点が描かれる
        this.rt.penLayer.drawLine(this.pen, this.x, this.y, this.x, this.y);
    }
    penUp() { this.pen.penDown = false; }
    setPenColor(v) { setPenColorToColor(this.pen, v); }
    setPenParam(param, v) { setPenParam(this.pen, param, v); }
    changePenParam(param, v) { changePenParam(this.pen, param, v); }
    setPenSize(v) { this.pen.penSize = toNumber(v); }
    changePenSize(v) { this.pen.penSize += toNumber(v); }
    stamp() {
        const img = this.costumeImages[this.costumeIndex];
        const info = this.costumes[this.costumeIndex];
        if (!img || !info || !img.complete || img.naturalWidth === 0)
            return;
        const w = img.naturalWidth * (this.size / 100);
        const h = img.naturalHeight * (this.size / 100);
        let rot = 0;
        let flipX = false;
        if (this.rotationStyle === "all around")
            rot = ((this.direction - 90) * Math.PI) / 180;
        else if (this.rotationStyle === "left-right")
            flipX = this.direction < 0;
        this.rt.penLayer.stampImage(img, w, h, this.x, this.y, rot, flipX, 1);
    }
}
/** クラウド変数ストア。TurboWarp cloud-server と同一プロトコル（WebSocket/JSON）を話す。 */
export class CloudStore {
    values = new Map();
    ws = null;
    user = "";
    projectId = "";
    init(name, value) {
        if (!this.values.has(name))
            this.values.set(name, value);
    }
    get(name) {
        return this.values.get(name) ?? 0;
    }
    set(name, value) {
        this.values.set(name, value);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                method: "set", name, value: toString(value),
                user: this.user, project_id: this.projectId,
            }) + "\n");
        }
    }
    connect(url, user, projectId) {
        this.user = user;
        this.projectId = projectId;
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.onopen = () => {
            ws.send(JSON.stringify({ method: "handshake", user, project_id: projectId }) + "\n");
        };
        ws.onmessage = (ev) => {
            // プロトコルは改行区切りの JSON 行
            for (const line of String(ev.data).split("\n")) {
                if (!line.trim())
                    continue;
                try {
                    const msg = JSON.parse(line);
                    if ((msg.method === "set" || msg.method === "create") && typeof msg.name === "string") {
                        this.values.set(msg.name, msg.value);
                    }
                }
                catch { /* 不正な行は無視（公式プロトコル仕様どおり） */ }
            }
        };
    }
}
/** サウンド: "音を鳴らす" は非同期開始（終わるまで待たない）。 */
class SoundEngine {
    ctx = null;
    buffers = new Map();
    loading = new Set();
    play(assetFile) {
        if (!this.ctx) {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (!AC)
                return;
            this.ctx = new AC();
        }
        const ctx = this.ctx;
        if (ctx.state === "suspended")
            void ctx.resume();
        const buf = this.buffers.get(assetFile);
        if (buf) {
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start();
            return;
        }
        if (this.loading.has(assetFile))
            return;
        this.loading.add(assetFile);
        fetch(ASSET_BASE + assetFile)
            .then((r) => r.arrayBuffer())
            .then((ab) => ctx.decodeAudioData(ab))
            .then((decoded) => {
            this.buffers.set(assetFile, decoded);
            this.loading.delete(assetFile);
            const src = ctx.createBufferSource();
            src.buffer = decoded;
            src.connect(ctx.destination);
            src.start();
        })
            .catch(() => this.loading.delete(assetFile));
    }
}
export class Runtime {
    /** 1フレームの総ステップ数上限（決定論モードの作業予算。暴走防止）。 */
    static FRAME_STEP_BUDGET = 200000;
    sprites = [];
    penLayer = (() => {
        const pl = new PenLayer(2);
        pl.onDraw = () => { this.redrawRequested = true; };
        return pl;
    })();
    /** 描画要求: ペン描画やコスチューム変更が起きたら立つ (scratch-vm の redrawRequested)。 */
    redrawRequested = false;
    cloud = new CloudStore();
    sound = new SoundEngine();
    mouse = { x: 0, y: 0, down: false };
    keysDown = new Set();
    answer = "";
    username = "";
    /** translate 拡張の getViewerLanguage 相当（ブラウザ言語の主言語コード）。 */
    language = (typeof navigator !== "undefined" ? navigator.language : "en").split("-")[0];
    /** ステージの背景（ステージターゲットのコスチューム） */
    backdrop = { images: [], index: 0 };
    threads = [];
    hats = [];
    timerStart = null;
    rafId = 0;
    lastFrameAt = 0;
    /** 目標 FPS。TurboWarp の既定に合わせて 60（docs 参照、要オラクル実測で校正）。 */
    targetFps = 60;
    /** プレイヤーの一時停止（TurboWarp のポーズボタン相当）。true の間はスレッドを進めない。 */
    paused = false;
    // ---- 決定論モード（テスト用） ----
    // 有効時は仮想時計（1フレーム = 1/60 秒で進行）とシード付き RNG を使い、
    // 日時は固定エポック（2026-11-21 UTC）から仮想時刻で進む。同一入力列に対して
    // 状態ダイジェストが完全一致することが Phase 2 の蒸留回帰の前提になる。
    // greenFlag より前に enableDeterministic() を呼ぶこと。
    deterministic = false;
    virtualNow = 0;
    static VIRTUAL_EPOCH = Date.UTC(2026, 10, 21, 0, 0, 0);
    enableDeterministic(seed = 12345) {
        this.deterministic = true;
        let state = seed >>> 0;
        setRngSource(() => {
            state = (state + 0x6d2b79f5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        });
    }
    nowMs() {
        return this.deterministic ? this.virtualNow : performance.now();
    }
    unimplementedWarned = new Set();
    currentThread = null;
    // 質問（ask and wait）用: main 側が UI を描く
    askState = null;
    /** 生成コードからの音再生（名前でなく asset ファイル名で受ける）。 */
    soundPlay(assetFile) {
        this.sound.play(assetFile);
    }
    registerHat(sprite, hatKey, factory) {
        this.hats.push({ id: this.hats.length, sprite, hatKey, factory });
    }
    startThread(hat) {
        this.threads.push({
            gen: hat.factory(), sprite: hat.sprite, hatKey: hat.hatKey, hatId: hat.id,
            done: false, wakeAt: 0, waitUntil: null, warpDepth: 0,
        });
    }
    // ---- warp（画面更新なしで実行） ----
    // scratch-vm では warp は手順定義単位ではなくスレッドの実行状態であり、
    // warp 手順から呼ばれた非 warp 手順にも伝播する。本作の Cloud(warp) →
    // Load cloud data(非warp) のような設計はこの伝播が前提。
    stepStartedAt = 0;
    pushWarp() {
        if (this.currentThread)
            this.currentThread.warpDepth++;
    }
    popWarp() {
        if (this.currentThread && this.currentThread.warpDepth > 0)
            this.currentThread.warpDepth--;
    }
    get warpActive() {
        return (this.currentThread?.warpDepth ?? 0) > 0;
    }
    /** warp 中でも 100ms 以上連続実行したら 1 フレーム譲る（ブラウザ固着防止の安全弁）。 */
    warpBudgetExceeded() {
        if (this.deterministic)
            return false; // 決定論モードでは実時計で譲らない
        return performance.now() - this.stepStartedAt > 100;
    }
    greenFlag() {
        this.paused = false;
        this.threads = [];
        this.timerStart = this.nowMs();
        for (const hat of this.hats) {
            if (hat.hatKey === "flag")
                this.startThread(hat);
        }
    }
    broadcast(name) {
        const key = "broadcast:" + name;
        for (const hat of this.hats) {
            if (hat.hatKey !== key)
                continue;
            // 実行中の同スクリプトは再起動しない（scratch-vm の挙動）。
            // 判定はハット登録単位: 同じ受け取りハットを持つ別スクリプトは別々に起動する。
            const running = this.threads.some((t) => !t.done && t.hatId === hat.id);
            if (!running)
                this.startThread(hat);
        }
    }
    keyPressedEvent(keyName) {
        const key = "key:" + keyName;
        for (const hat of this.hats) {
            if (hat.hatKey === key)
                this.startThread(hat);
        }
    }
    stopAll() {
        this.paused = false;
        for (const t of this.threads)
            t.done = true;
        this.threads = [];
    }
    /** control_stop の "other scripts in sprite" / "this script" 用。 */
    stopOtherScriptsInSprite(sprite) {
        for (const t of this.threads) {
            if (t.sprite === sprite && t !== this.currentThread)
                t.done = true;
        }
    }
    stopThisScript() {
        if (this.currentThread)
            this.currentThread.done = true;
    }
    timer() {
        if (this.timerStart === null)
            this.timerStart = this.nowMs();
        return (this.nowMs() - this.timerStart) / 1000;
    }
    resetTimer() {
        this.timerStart = this.nowMs();
    }
    daysSince2000() {
        if (this.deterministic) {
            const epoch = Date.UTC(2000, 0, 1);
            return (Runtime.VIRTUAL_EPOCH + this.virtualNow - epoch) / (24 * 60 * 60 * 1000);
        }
        const now = new Date();
        const epoch = new Date(2000, 0, 1);
        return (now.getTime() - epoch.getTime()) / (24 * 60 * 60 * 1000);
    }
    current(field) {
        // 決定論モードでは UTC 基準（通常時はローカル時刻。テスト専用の差異として明示）
        const d = this.deterministic ? new Date(Runtime.VIRTUAL_EPOCH + this.virtualNow) : new Date();
        const get = (utc, local) => (this.deterministic ? utc() : local());
        switch (field) {
            case "YEAR": return get(() => d.getUTCFullYear(), () => d.getFullYear());
            case "MONTH": return get(() => d.getUTCMonth(), () => d.getMonth()) + 1;
            case "DATE": return get(() => d.getUTCDate(), () => d.getDate());
            case "DAYOFWEEK": return get(() => d.getUTCDay(), () => d.getDay()) + 1; // 1=日曜
            case "HOUR": return get(() => d.getUTCHours(), () => d.getHours());
            case "MINUTE": return get(() => d.getUTCMinutes(), () => d.getMinutes());
            case "SECOND": return get(() => d.getUTCSeconds(), () => d.getSeconds());
            default: return 0;
        }
    }
    keyIsPressed(key) {
        const k = key.toLowerCase();
        if (k === "any")
            return this.keysDown.size > 0;
        return this.keysDown.has(k);
    }
    unimplemented(opcode) {
        if (!this.unimplementedWarned.has(opcode)) {
            this.unimplementedWarned.add(opcode);
            console.warn(`[TACT-AIM] unimplemented opcode: ${opcode}`);
        }
    }
    /** ask and wait 用 generator: 回答が来るまで待つ。 */
    *askGen(question) {
        this.askState = { question, done: false };
        yield { waitUntil: () => this.askState === null || this.askState.done };
        this.askState = null;
    }
    submitAnswer(v) {
        this.answer = v;
        if (this.askState)
            this.askState.done = true;
    }
    /** 1フレーム分スレッドを進める。 */
    stepThreads() {
        if (this.paused)
            return;
        if (this.deterministic)
            this.virtualNow += 1000 / 60; // 仮想時計は 60fps 固定で進める
        const now = this.nowMs();
        this.redrawRequested = false;
        // TurboWarp (scratch-vm Sequencer) のフレーム意味論に合わせる:
        // - 1フレームは「全スレッドを1ステップずつ進めるパス」の繰り返し。
        // - ループ端の yield は STATUS_YIELD (ソフト yield) で、予算が残っていれば
        //   次のパスで同じフレームのまま再開される。wait 系はフレームをまたぐ
        //   (このフレームでは再評価しない)。
        // - パスの繰り返しは、フレーム時間の 75% を使い切るか、描画要求
        //   (redrawRequested) が立つか、ソフト yield したスレッドが
        //   無くなったら終わる。メインループ All() は先頭でペンを消すため
        //   描画要求が立ち、結果として 1フレームに約1回だけ進む。
        // 旧実装は全 yield をフレーム境界にしていたため、非 warp の反復1回が
        // 1フレームに固定され、起動時の走査ループ (約7,800回) に約7,800フレーム
        // かかっていた (TurboWarp では同じ走査が1フレーム未満で終わる)。
        const deadline = this.deterministic ? Infinity : performance.now() + (1000 / this.targetFps) * 0.75;
        let stepsLeft = Runtime.FRAME_STEP_BUDGET;
        const parked = new Set();
        while (true) {
            let anyYielded = false;
            let anyAlive = false;
            for (const t of this.threads) {
                if (t.done)
                    continue;
                anyAlive = true;
                if (parked.has(t))
                    continue;
                if (t.wakeAt > now || (t.waitUntil && !t.waitUntil())) {
                    parked.add(t);
                    continue;
                }
                if (stepsLeft <= 0)
                    break;
                t.wakeAt = 0;
                t.waitUntil = null;
                this.currentThread = t;
                this.stepStartedAt = performance.now();
                stepsLeft--;
                let result;
                try {
                    result = t.gen.next();
                }
                catch (e) {
                    console.error("[TACT-AIM] script error", e);
                    t.done = true;
                    this.currentThread = null;
                    continue;
                }
                this.currentThread = null;
                if (result.done) {
                    t.done = true;
                    continue;
                }
                const cmd = result.value;
                if (cmd && "waitSeconds" in cmd) {
                    t.wakeAt = now + cmd.waitSeconds * 1000;
                    parked.add(t);
                }
                else if (cmd && "waitUntil" in cmd) {
                    t.waitUntil = cmd.waitUntil;
                    parked.add(t);
                }
                else {
                    anyYielded = true; // ソフト yield: 次のパスで再開可能
                }
            }
            if (!anyAlive || !anyYielded)
                break;
            if (this.redrawRequested)
                break;
            if (stepsLeft <= 0)
                break;
            if (performance.now() >= deadline)
                break;
        }
        this.threads = this.threads.filter((t) => !t.done);
    }
    get activeThreadCount() {
        return this.threads.length;
    }
    /** sensing_of 用: スプライト名で引く。 */
    spriteNamed(name) {
        return this.sprites.find((s) => s.name === name);
    }
    /** 描画: 背景 → ペン → スプライト（ターゲット順が手前）。 */
    render(ctx, scale) {
        const bg = this.backdrop.images[this.backdrop.index];
        if (bg && bg.complete && bg.naturalWidth > 0) {
            ctx.drawImage(bg, 0, 0, 480 * scale, 360 * scale);
        }
        else {
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, 480 * scale, 360 * scale);
        }
        ctx.drawImage(this.penLayer.canvas, 0, 0, 480 * scale, 360 * scale);
        for (const s of this.sprites)
            s.draw(ctx, scale);
    }
    /** メインループ開始。render 先キャンバスを受け取る。 */
    startLoop(canvas) {
        const ctx = canvas.getContext("2d");
        if (!ctx)
            throw new Error("2d context unavailable");
        const scale = canvas.width / 480;
        const frameInterval = 1000 / this.targetFps;
        const loop = (t) => {
            this.rafId = requestAnimationFrame(loop);
            if (t - this.lastFrameAt < frameInterval - 1)
                return;
            this.lastFrameAt = t;
            this.stepThreads();
            this.render(ctx, scale);
        };
        this.rafId = requestAnimationFrame(loop);
    }
    stopLoop() {
        cancelAnimationFrame(this.rafId);
    }
}
