-- パーティーゲーム月次ランキング（今月のゲーム王）の統合版。
--
-- 背景: party_game_monthly_ranking.sql（月次テーブル＋ビュー＋月次へも書く関数）と
-- party_game_ranking_add_round*_games.sql（ゲーム追加ごとの関数差し替え）は、
-- どちらも関数 party_game_record_win を作り直すため、流す順番で壊れる:
--   - monthly を後に流す → 関数のゲーム一覧が初期19種に戻り、新しめのゲームの勝利が弾かれる。
--   - add 系を後に流す   → 関数が月次テーブルへ書かなくなり、ゲーム王が DB に溜まらない。
-- このファイルは両者を統合した最終形（全33種＋月次書き込み）で、冪等。
-- どちらを先に流していても、最後にこれを流せば正しい状態になる。
-- 適用はレビューの後に行う。本番では試さないこと。
-- （botdb には Supabase 用ロールが無いため、適用時は REVOKE/GRANT 行を
--   適用コピー側で除去すること。既存の適用手順と同じ。）

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

-- 累積側の game チェック制約を現行の全ゲーム（33種）に揃える
alter table public.party_game_wins drop constraint if exists party_game_wins_game_check;
alter table public.party_game_wins add constraint party_game_wins_game_check
  check (game in ('ngword', 'shiritori', 'wordwolf', 'jinrou', 'uno', 'doubt', 'janken', 'wordle', 'shinkei', 'babanuki', 'daifugo', 'othello', 'shogi', 'chess', 'poker', 'quiz', 'bingo', 'majority', 'onenight', 'loveletter', 'codenames', 'thirtyone', 'koikoi', 'gomoku', 'connect4', 'insider', 'hoshi', 'liequiz', 'gauge', 'ruins', 'cipher', 'liardice', 'mendou'));

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
  if p_game is null or p_game not in ('ngword', 'shiritori', 'wordwolf', 'jinrou', 'uno', 'doubt', 'janken', 'wordle', 'shinkei', 'babanuki', 'daifugo', 'othello', 'shogi', 'chess', 'poker', 'quiz', 'bingo', 'majority', 'onenight', 'loveletter', 'codenames', 'thirtyone', 'koikoi', 'gomoku', 'connect4', 'insider', 'hoshi', 'liequiz', 'gauge', 'ruins', 'cipher', 'liardice', 'mendou') then
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
