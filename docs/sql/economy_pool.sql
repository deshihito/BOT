-- economy_pool（損失還流プール＋国庫）の Postgres 化（コイン API 直接化 第2段）
--
-- 目的: EconomyPoolStore の正を data/economy_pool.json（Bot プロセス内の
-- メモリ＋JSON ファイル）から Postgres の単一行テーブルへ移し、Web 側が
-- bot-api の RPC 経由で pay_house / add_loss 等を原子的に呼べるようにする。
-- 状態は id=1 の1行だけが持つ（プール/国庫は全体で1つ）。
--
-- 適用: 一度だけ実行する（何度実行しても安全な形にしてある）。
--   Pi では SQL を /tmp へコピーしてから postgres ユーザーで適用すること
--   （botdb には Supabase 用ロールが無いため、本ファイルの GRANT/REVOKE は
--   ロールの存在を確認してから実行する形にしてある。そのまま適用できる）。
-- 適用後は bot-postgres-api.service の再起動が必要（api/app.py の許可
-- テーブル/RPC の追加と合わせて反映される）。
--
-- 初期値の移行: テーブルが空の間は Bot 起動後の初回利用時に
-- EconomyPoolStore が現在の economy_pool.json の値を economy_pool_seed で
-- 自動投入する（既に行があれば何もしない）。先に手で入れたい場合は
-- 下部の INSERT 例を値で埋めて実行すること。

begin;

create table if not exists public.economy_pool_state (
  id smallint primary key default 1 check (id = 1),
  pool bigint not null default 0,
  treasury bigint not null default 0,
  total_recycled bigint not null default 0,
  total_paid bigint not null default 0,
  total_released bigint not null default 0,
  total_boosted bigint not null default 0,
  lottery_boost_pending bigint not null default 0,
  total_house_paid bigint not null default 0,
  last_release_date text,
  updated_at timestamptz not null default now()
);

-- Bot API の接続ユーザー bot_api への権限（無いと API 経由が 42501 で落ちる）
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'bot_api') then
    grant select, insert, update, delete on public.economy_pool_state to bot_api;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- seed: 行が無ければ与えた値を初期値として作り、現在の状態を返す。
-- 既に行があれば値は変えず、現在の状態を返す（Bot の自動移行用）。
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_seed(
  p_pool bigint,
  p_treasury bigint,
  p_total_recycled bigint,
  p_total_paid bigint,
  p_total_released bigint,
  p_total_boosted bigint,
  p_lottery_boost_pending bigint,
  p_total_house_paid bigint,
  p_last_release_date text
)
returns table(
  pool bigint,
  treasury bigint,
  total_recycled bigint,
  total_paid bigint,
  total_released bigint,
  total_boosted bigint,
  lottery_boost_pending bigint,
  total_house_paid bigint,
  last_release_date text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.economy_pool_state (
    id, pool, treasury, total_recycled, total_paid, total_released,
    total_boosted, lottery_boost_pending, total_house_paid, last_release_date
  ) values (
    1,
    greatest(coalesce(p_pool, 0), 0),
    greatest(coalesce(p_treasury, 0), 0),
    greatest(coalesce(p_total_recycled, 0), 0),
    greatest(coalesce(p_total_paid, 0), 0),
    greatest(coalesce(p_total_released, 0), 0),
    greatest(coalesce(p_total_boosted, 0), 0),
    greatest(coalesce(p_lottery_boost_pending, 0), 0),
    greatest(coalesce(p_total_house_paid, 0), 0),
    p_last_release_date
  )
  on conflict (id) do nothing;
  return query
    select s.pool, s.treasury, s.total_recycled, s.total_paid, s.total_released,
           s.total_boosted, s.lottery_boost_pending, s.total_house_paid, s.last_release_date
      from public.economy_pool_state s
     where s.id = 1;
end;
$$;

-- ---------------------------------------------------------------------------
-- pay_house: バンクロール（プール→国庫の順）から払い、内訳を返す。
-- 残高が不足する場合はある分だけ払う（双方とも負にならない）。
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_pay_house(p_amount bigint)
returns table(paid bigint, pool_part bigint, treasury_part bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool bigint;
  v_treasury bigint;
  v_amount bigint := greatest(coalesce(p_amount, 0), 0);
begin
  insert into public.economy_pool_state (id) values (1) on conflict (id) do nothing;
  select s.pool, s.treasury into v_pool, v_treasury
    from public.economy_pool_state s where s.id = 1 for update;
  pool_part := least(v_pool, v_amount);
  treasury_part := least(v_treasury, v_amount - pool_part);
  paid := pool_part + treasury_part;
  if paid > 0 then
    update public.economy_pool_state s
       set pool = s.pool - pool_part,
           treasury = s.treasury - treasury_part,
           total_house_paid = s.total_house_paid + paid,
           updated_at = now()
     where s.id = 1;
  end if;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- refund_house: pay_house の内訳どおりに戻す。戻し後の total_house_paid を返す。
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_refund_house(
  p_pool_part bigint,
  p_treasury_part bigint
)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_total bigint;
  v_amount bigint := greatest(coalesce(p_pool_part, 0), 0) + greatest(coalesce(p_treasury_part, 0), 0);
begin
  insert into public.economy_pool_state (id) values (1) on conflict (id) do nothing;
  update public.economy_pool_state s
     set pool = s.pool + greatest(coalesce(p_pool_part, 0), 0),
         treasury = s.treasury + greatest(coalesce(p_treasury_part, 0), 0),
         total_house_paid = greatest(0, s.total_house_paid - v_amount),
         updated_at = now()
   where s.id = 1
  returning s.total_house_paid into v_total;
  return v_total;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_loss: 損失を還流する。70% をプール、端数込みの残りを国庫へ。
-- （Python 側の int(amount * 0.7) と同じ配分を整数演算で再現する）
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_add_loss(p_amount bigint)
returns table(pool_part bigint, treasury_part bigint)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_amount bigint := greatest(coalesce(p_amount, 0), 0);
begin
  pool_part := (v_amount * 7) / 10;
  treasury_part := v_amount - pool_part;
  insert into public.economy_pool_state (id) values (1) on conflict (id) do nothing;
  if v_amount > 0 then
    update public.economy_pool_state s
       set pool = s.pool + pool_part,
           treasury = s.treasury + treasury_part,
           total_recycled = s.total_recycled + v_amount,
           updated_at = now()
     where s.id = 1;
  end if;
  return next;
end;
$$;

-- ---------------------------------------------------------------------------
-- pay: 採掘用にプールからのみ払う。実際に払えた額を返す。
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_pay(p_amount bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool bigint;
  v_paid bigint;
  v_amount bigint := greatest(coalesce(p_amount, 0), 0);
begin
  insert into public.economy_pool_state (id) values (1) on conflict (id) do nothing;
  select s.pool into v_pool from public.economy_pool_state s where s.id = 1 for update;
  v_paid := least(v_pool, v_amount);
  if v_paid > 0 then
    update public.economy_pool_state s
       set pool = s.pool - v_paid,
           total_paid = s.total_paid + v_paid,
           updated_at = now()
     where s.id = 1;
  end if;
  return v_paid;
end;
$$;

-- ---------------------------------------------------------------------------
-- refund: pay で払った分をプールへ戻す。戻し後のプール残高を返す。
-- ---------------------------------------------------------------------------
create or replace function public.economy_pool_refund(p_amount bigint)
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pool bigint;
  v_amount bigint := greatest(coalesce(p_amount, 0), 0);
begin
  insert into public.economy_pool_state (id) values (1) on conflict (id) do nothing;
  update public.economy_pool_state s
     set pool = s.pool + v_amount,
         total_paid = greatest(0, s.total_paid - v_amount),
         updated_at = now()
   where s.id = 1
  returning s.pool into v_pool;
  return v_pool;
end;
$$;

-- 実行権限: 公開ロールからは剥がし、bot_api にだけ付ける（ロールが
-- 存在する環境でのみ実行されるようガードする）。
do $$
declare
  fn text;
  fns text[] := array[
    'public.economy_pool_seed(bigint,bigint,bigint,bigint,bigint,bigint,bigint,bigint,text)',
    'public.economy_pool_pay_house(bigint)',
    'public.economy_pool_refund_house(bigint,bigint)',
    'public.economy_pool_add_loss(bigint)',
    'public.economy_pool_pay(bigint)',
    'public.economy_pool_refund(bigint)'
  ];
begin
  foreach fn in array fns loop
    if exists (select 1 from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
      execute format('revoke all on function %s from authenticated', fn);
    end if;
    if exists (select 1 from pg_roles where rolname = 'bot_api') then
      execute format('grant execute on function %s to bot_api', fn);
    end if;
  end loop;
end $$;

commit;

-- 手動で初期値を入れる場合の例（economy_pool.json の現在値で埋める。
-- Bot の自動 seed より先に実行したときだけ有効。以後は実行しないこと）:
-- insert into public.economy_pool_state (
--   id, pool, treasury, total_recycled, total_paid, total_released,
--   total_boosted, lottery_boost_pending, total_house_paid, last_release_date
-- ) values (1, 0, 0, 0, 0, 0, 0, 0, 0, null)
-- on conflict (id) do nothing;
