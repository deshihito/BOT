import { loadNation } from "@/lib/nation";
import { calcBounds, countByGuild, guildColor } from "@/lib/nation-map";

// Supabaseが応答しないとビルドを止めるため、マップはリクエスト時に描画する。
export const dynamic = "force-dynamic";
export const metadata = { title: "マップ | AGOBOT" };

const CELL = 24;

export default async function MapPage() {
  const data = await loadNation();
  const tiles = data.ok ? data.tiles : [];
  const guilds = data.ok ? data.guilds : [];
  const capitals = guilds.filter((g) => g.capital_x != null && g.capital_y != null);
  const b = calcBounds([...tiles, ...capitals.map((g) => ({ x: g.capital_x!, y: g.capital_y! }))]);
  const counts = countByGuild(tiles);
  const owned = new Map(tiles.map((t) => [`${t.x},${t.y}`, t]));
  const cells = [];
  for (let y = b.minY; y <= b.maxY; y++)
    for (let x = b.minX; x <= b.maxX; x++) {
      const t = owned.get(`${x},${y}`);
      cells.push(
        <rect key={`${x},${y}`} x={(x - b.minX) * CELL} y={(y - b.minY) * CELL} width={CELL} height={CELL}
          fill={guildColor(t?.owner_guild_id)} stroke="#e6e4df" strokeWidth={1}>
          <title>{`(${x}, ${y})${t ? ` ${t.tile_type}${t.owner_guild_id ? ` / ${t.owner_guild_id}` : ""} HP ${t.hp}/${t.max_hp}` : ""}`}</title>
        </rect>,
      );
    }

  return (
    <>
      <h1>マップ</h1>
      <p className="muted">国づくりの共有マップです。色は国（サーバー）ごと、★ は首都です。1 分ごとに更新されます。</p>
      {(!data.ok || tiles.length === 0) && (
        <div className="card notice">まだデータがありません / 準備中です。国が建国されると、ここに表示されます。</div>
      )}
      <div className="map-wrap card">
        <svg className="nation-map" viewBox={`0 0 ${b.width * CELL} ${b.height * CELL}`} role="img" aria-label="国づくりマップ">
          {cells}
          {capitals.map((g) => (
            <text key={g.guild_id} x={(g.capital_x! - b.minX + 0.5) * CELL} y={(g.capital_y! - b.minY + 0.5) * CELL}
              textAnchor="middle" dominantBaseline="central" fontSize={CELL * 0.7} fill="#2b2b2b">★</text>
          ))}
        </svg>
      </div>
      <h2>国の一覧</h2>
      {counts.length === 0 ? <p className="muted">まだ国はありません。</p> : (
        <table>
          <thead><tr><th>国</th><th>タイル数</th><th>首都</th></tr></thead>
          <tbody>
            {counts.map((c) => {
              const g = guilds.find((x) => x.guild_id === c.guild_id);
              return (
                <tr key={c.guild_id}>
                  <td><span className="swatch" style={{ background: guildColor(c.guild_id) }} />{c.guild_id}</td>
                  <td>{c.count}</td>
                  <td>{g?.capital_x != null ? `(${g.capital_x}, ${g.capital_y})` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
