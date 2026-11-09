import Link from "next/link";
import { notFound } from "next/navigation";
import { JINROU_ROLES } from "@/lib/jinrou-roles";

export const dynamicParams = false;

export function generateStaticParams() {
  return JINROU_ROLES.map((r) => ({ id: r.id }));
}

function findRole(id: string) {
  let decoded = id;
  try { decoded = decodeURIComponent(id); } catch {}
  return JINROU_ROLES.find((r) => r.id === id || r.id === decoded);
}

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const role = findRole((await params).id);
  if (!role) return { title: "人狼 役職図鑑" };
  return {
    title: `${role.name} | 人狼 役職図鑑`,
    description: `${role.name}（${role.teamLabel}）：${role.ability}`,
    alternates: { canonical: `/jinrou/roles/${encodeURIComponent(role.id)}` },
  };
}

export default async function JinrouRolePage({ params }: { params: Promise<{ id: string }> }) {
  const role = findRole((await params).id);
  if (!role) notFound();
  return (
    <>
      <p><Link href="/jinrou/roles">← 役職図鑑にもどる</Link></p>
      <section className="hero">
        <img src={role.image ?? "/img/nomal.png"} alt={role.image ? role.name : ""} />
        <div>
          <span className="badge">{role.teamLabel}</span>
          <h1>{role.name}</h1>
          {!role.image && <p className="muted" style={{ margin: 0 }}>この役職の絵はまだありません。</p>}
        </div>
      </section>
      <div className="grid">
        <div className="card"><strong>陣営</strong><div className="muted">{role.teamLabel}</div></div>
        <div className="card"><strong>能力</strong><div className="muted">{role.ability}</div></div>
        <div className="card"><strong>勝ち方</strong><div className="muted">{role.win}</div></div>
      </div>
    </>
  );
}
