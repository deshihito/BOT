import { redirect } from "next/navigation";

// 音楽 Activity 画面は 2026-11-14 に廃止した（重すぎるための整理。
// Bot 本体の /vc 音楽再生は継続）。旧 URL を踏んだ利用者を 404 で
// 突き放さないよう、ゲームの入口へ寄せるだけのスタブとして残す。
export const metadata = { title: "Music Video Activity | AGOBOT" };

export default function MusicActivityPage() {
  redirect("/games");
}
