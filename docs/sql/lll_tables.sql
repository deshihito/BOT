-- LLL（/games/lll）の専用テーブル。
-- それまでプロフィールと対戦は共有 bot_kv の namespace（lll_profiles /
-- lll_battles）に保存していた。web/lib/lll-server.ts が Bot API
-- （許可テーブル）経由で読み書きする。何度実行しても大丈夫です。
CREATE TABLE IF NOT EXISTS public.lll_profiles (
    token text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.lll_battles (
    id text PRIMARY KEY,
    data jsonb NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);

-- Bot API の接続ユーザー bot_api への権限（無いと API 経由の読み書きが
-- 42501 で落ちる。bump_rta_worst_records の前例）。
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lll_profiles TO bot_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.lll_battles TO bot_api;

-- 既存データの移行（bot_kv の同名 namespace から）。
-- updated_at が新しい方を正として取り込むため、デプロイ前後に
-- 2回実行しても古いコピーで新しいデータを上書きしない。
INSERT INTO public.lll_profiles (token, data, updated_at)
SELECT key, value, updated_at FROM public.bot_kv WHERE namespace = 'lll_profiles'
ON CONFLICT (token) DO UPDATE
SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
WHERE EXCLUDED.updated_at > public.lll_profiles.updated_at;

INSERT INTO public.lll_battles (id, data, updated_at)
SELECT key, value, updated_at FROM public.bot_kv WHERE namespace = 'lll_battles'
ON CONFLICT (id) DO UPDATE
SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
WHERE EXCLUDED.updated_at > public.lll_battles.updated_at;
