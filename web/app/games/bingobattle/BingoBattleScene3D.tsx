"use client";
// ビンゴ対戦の 3D シーン。抽選機シーンは bingo の BingoScene3D をそのまま
// 再利用する（対戦側に複製を作らない）。対戦はオンライン基盤が自動で
// 抽選を進めるため、ここは drawn（全員共通の抽選済み番号列）を渡して
// 表示するだけ。送るアクションは無く、タップで状態は変わらない。
// 現在の番号・履歴は親 DOM の併記が担う。
import type { ReactNode } from "react";
import BingoScene3D from "../bingo/BingoScene3D";

interface Props {
  /** 抽選済み番号列（引いた順、全員共通）。 */
  drawn: number[];
  onFail: () => void;
  fallback: ReactNode;
}

export default function BingoBattleScene3D({ drawn, onFail, fallback }: Props) {
  return <BingoScene3D drawn={drawn} onFail={onFail} fallback={fallback} />;
}
