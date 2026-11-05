-- パーティーゲームの月次シーズンランキング（今月のゲーム王）
-- - 表 party_game_monthly_wins: (guild_id, user_id, month) ごとの全ゲーム合計勝利数。
-- - 既存の関数 party_game_record_win を差し替え、従来の累積テーブルと月次テーブルの
--   両方へ upsert する（Bot 側の RPC 呼び出しは無変更でよい）。
-- - ビュー party_game_monthly_ranking: 月次の読み取り用。
-- - 冪等（if not exists / create or replace）。適用は TYPETA のレビュー後に Luna が行う。
--   未適用の間、Bot はメモリの月次集計で表示する（再起動で消えるのは従来の設計どおり）。

begin;

create table if not exists public.party_game_monthly_wins (
  guild_id   bigint      not null check (guild_id > 0),
  user_id    bigint      not null check (user_id > 0),
  month      text        not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),
  wins       integer     not null default 0 check (wins >= 0),
  updated_at timestamptz not null default now(),
  primary key (guild_id, user_id, month)
);

alter table public.party_game_monthly_wins enable row level security;
revoke all on public.party_game_monthly_wins from public, anon, authenticated;

-- 累積側の game チェック制約を現行の全ゲームに揃える（追加ゲームぶんを含む）
alter table public.party_game_wins drop constraint if exists party_game_wins_game_check;
alter table public.party_game_wins add constraint party_game_wins_game_check
  check (game in ('ngword', 'shiritori', 'wordwolf', 'jinrou', 'uno', 'doubt', 'janken', 'wordle', 'shinkei', 'babanuki', 'daifugo', 'othello', 'shogi', 'chess', 'poker', 'quiz', 'bingo', 'majority', 'onenight'));

create or replace function public.party_game_record_win(p_guild_id bigint, p_user_id bigint, p_game text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_wins integer;
begin
  if p_guild_id is null or p_guild_id <= 0 then
    raise exception 'invalid guild_id' using errcode = '22023';
  end if;
  if p_user_id is null or p_user_id <= 0 then
    raise exception 'invalid user_id' using errcode = '22023';
  end if;
  if p_game is null or p_game not in ('ngword', 'shiritori', 'wordwolf', 'jinrou', 'uno', 'doubt', 'janken', 'wordle', 'shinkei', 'babanuki', 'daifugo', 'othello', 'shogi', 'chess', 'poker', 'quiz', 'bingo', 'majority', 'onenight') then
    raise exception 'unknown game: %', p_game using errcode = '22023';
  end if;

  insert into public.party_game_wins as w (guild_id, user_id, game, wins)
  values (p_guild_id, p_user_id, p_game, 1)
  on conflict (guild_id, user_id, game)
  do update set wins = w.wins + 1, updated_at = now()
  returning w.wins into v_wins;

  insert into public.party_game_monthly_wins as m (guild_id, user_id, month, wins)
  values (p_guild_id, p_user_id, to_char(now(), 'YYYY-MM'), 1)
  on conflict (guild_id, user_id, month)
  do update set wins = m.wins + 1, updated_at = now();

  return v_wins;
end;
$$;

revoke all on function public.party_game_record_win(bigint, bigint, text) from public, anon, authenticated;
grant execute on function public.party_game_record_win(bigint, bigint, text) to anon, service_role;

create or replace view public.party_game_monthly_ranking
with (security_invoker = false) as
select
  m.guild_id,
  m.month,
  m.user_id,
  m.wins
from public.party_game_monthly_wins as m;

commit;
