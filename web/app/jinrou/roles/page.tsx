import Link from "next/link";
import { JINROU_ROLES, type JinrouTeam } from "@/lib/jinrou-roles";

export const metadata = { title: "人狼 役職図鑑 | AGOBOT", alternates: { canonical: "/jinrou/roles" } };

const TEAMS: { team: JinrouTeam; label: string; note: string }[] = [
  { team: "village", label: "村人陣営", note: "人狼をすべて追放すれば勝ち。" },
  { team: "wolf", label: "人狼陣営", note: "人狼が村人と同じ数以上になれば勝ち。" },
  { team: "third", label: "第三者陣営", note: "どちらの陣営とも違う、自分だけの勝ち方をねらいます。" },
];

export default function JinrouRoles() {
  return (
    <>
      <section className="hero">
        <img src="/img/jinrou/jinrou.png" alt="人狼" />
        <div>
          <h1>人狼 役職図鑑</h1>
          <p className="muted" style={{ margin: 0 }}>
            AGOBOT の人狼に出てくる {JINROU_ROLES.length} の役職です。<code>/game</code> から人狼を選んで遊べます。
            役職を押すと、くわしい説明が見られます。
          </p>
        </div>
      </section>
      {TEAMS.map((t) => {
        const roles = JINROU_ROLES.filter((r) => r.team === t.team);
        return (
          <section key={t.team}>
            <h2>{t.label}（{roles.length}）</h2>
            <p className="muted">{t.note}</p>
            <div className="grid">
              {roles.map((r) => (
                <Link key={r.id} href={`/jinrou/roles/${encodeURIComponent(r.id)}`} className="card game-card">
                  <img src={r.image ?? "/img/nomal.png"} alt={r.image ? r.name : ""} />
                  <div>
                    <strong>{r.name}</strong>
                    <div className="muted">{r.ability}</div>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}
