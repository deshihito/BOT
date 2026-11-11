"use client";
// /features の絞り込みチップとジャンルカード一覧。
// カードは判断材料（何ができるか一文＋対象コマンド＋機能数）を先に、
// 機能名の列挙（詳しい説明）を後に置く。
import Link from "next/link";
import { useState } from "react";
import { COMMAND_GUIDES, type CommandGuide, type GenreGuide } from "@/lib/command-guides";

type GenreCard = { guide: CommandGuide; genre: GenreGuide };

const ALL_CARDS: GenreCard[] = COMMAND_GUIDES.flatMap((guide) =>
  guide.genres.map((genre) => ({ guide, genre })),
);

function cardLead(card: GenreCard): string {
  if (card.genre.description) return card.genre.description;
  const names = card.genre.functions.slice(0, 3).map((fn) => fn.title).join("、");
  return `${names}など、全${card.genre.functions.length}件の機能があります。`;
}

export default function FeaturesExplorer() {
  const [filter, setFilter] = useState<string>("all");
  const cards = filter === "all" ? ALL_CARDS : ALL_CARDS.filter((c) => c.guide.slug === filter);
  return (
    <>
      <div className="feature-chips" role="group" aria-label="コマンドで絞り込む">
        <button
          type="button"
          className="feature-chip"
          aria-pressed={filter === "all"}
          onClick={() => setFilter("all")}
        >
          すべて
        </button>
        {COMMAND_GUIDES.map((guide) => (
          <button
            key={guide.slug}
            type="button"
            className="feature-chip"
            aria-pressed={filter === guide.slug}
            onClick={() => setFilter(guide.slug)}
          >
            {guide.command}
          </button>
        ))}
      </div>
      <div className="genre-card-grid">
        {cards.map(({ guide, genre }) => (
          <article key={`${guide.slug}/${genre.slug}`} className="genre-feature-card">
            <h3>
              <span>{genre.title}</span>
            </h3>
            <p className="genre-card-lead">{cardLead({ guide, genre })}</p>
            <p className="genre-card-meta">
              <span>
                {guide.command} {guide.title}
              </span>
              <span>{genre.functions.length}機能</span>
              {guide.guildOnly ? <span>サーバー内のみ</span> : null}
            </p>
            <p className="genre-card-functions">
              {genre.functions.map((fn) => fn.title).join("、")}
            </p>
            <p>
              <Link href={`/commands/${guide.slug}/${genre.slug}`}>
                {genre.title}の詳しい使い方 →
              </Link>
            </p>
          </article>
        ))}
      </div>
    </>
  );
}
