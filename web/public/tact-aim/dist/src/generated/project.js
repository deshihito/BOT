import { G } from "./globals.js";
import { Idea } from "../distilled/Idea.js";
import { Pen_All } from "../distilled/Pen_All.js";
import { Tutorial_Others } from "../distilled/Tutorial_Others.js";
import { Title } from "../distilled/Title.js";
import { Map } from "../distilled/Map.js";
import { April } from "../distilled/April.js";
import { Combat_rating } from "../distilled/Combat_rating.js";
import { TEAMMODE } from "../distilled/TEAMMODE.js";
import { 開発者ツール } from "../distilled/開発者ツール.js";
export function createProject(rt) {
    G.bindCloud(rt.cloud);
    rt.backdrop.images = [
        (() => { const img = new Image(); img.src = "assets/4f034c594e645bd0d35da0c0c37c2490.svg"; return img; })(),
    ];
    const sprites = [
        new Idea(rt),
        new Pen_All(rt),
        new Tutorial_Others(rt),
        new Title(rt),
        new Map(rt),
        new April(rt),
        new Combat_rating(rt),
        new TEAMMODE(rt),
        new 開発者ツール(rt),
    ];
    rt.sprites = sprites;
    for (const s of sprites)
        s.registerHats();
}
