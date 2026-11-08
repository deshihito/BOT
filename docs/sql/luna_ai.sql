-- Luna AI（チャンネル常駐AI）の記憶スキーマ。何度実行しても大丈夫です。
-- memories: 人格ごとに1つの、AI自身が維持する Markdown 記憶ドキュメント。
-- キーは (guild_id, persona_key)。persona_key は既定人格が 'default'、
-- カスタム人格は登録時に発行されるID（編集で継続、削除で記憶も削除）。
-- turns: チャンネル（部屋）単位の直近文脈と記憶統合待ちの保持用。
-- 統合済みの古いターンは Bot 側で剪定され、生ログは永久保存されない。
CREATE TABLE IF NOT EXISTS public.luna_ai_memories (
    guild_id bigint NOT NULL,
    persona_key text NOT NULL,
    memory_text text NOT NULL DEFAULT '',
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, persona_key)
);

CREATE TABLE IF NOT EXISTS public.luna_ai_turns (
    id bigserial PRIMARY KEY,
    channel_id bigint NOT NULL,
    guild_id bigint NOT NULL,
    author_name text NOT NULL,
    is_luna boolean NOT NULL DEFAULT false,
    content text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    integrated boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS luna_ai_turns_channel_idx
    ON public.luna_ai_turns (channel_id, id);
CREATE INDEX IF NOT EXISTS luna_ai_turns_unintegrated_idx
    ON public.luna_ai_turns (channel_id, integrated, id);

ALTER TABLE public.luna_ai_memories DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.luna_ai_turns DISABLE ROW LEVEL SECURITY;

-- The self-hosted API connects as bot_api; without table privileges every
-- call fails with 42501 (the bump_rta_worst_records lesson, PR #636).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bot_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.luna_ai_memories TO bot_api;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.luna_ai_turns TO bot_api;
    GRANT USAGE, SELECT ON SEQUENCE public.luna_ai_turns_id_seq TO bot_api;
  END IF;
END $$;
