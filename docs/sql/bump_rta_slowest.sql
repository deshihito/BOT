-- Slowest ranking (最遅ランキング) for bump/up RTA: same elapsed metric as the
-- fastest board (time from "became available" to actually executed), kept as
-- the per-(guild, user, type) maximum in a separate table so the fastest
-- records keep their meaning. Apply once per existing environment; new
-- environments get the same objects from bump_rta.sql.
CREATE TABLE IF NOT EXISTS public.bump_rta_worst_records (
    guild_id text NOT NULL,
    user_id text NOT NULL,
    event_type text NOT NULL CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot')),
    elapsed_ms integer NOT NULL CHECK (elapsed_ms > 0),
    completed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, user_id, event_type)
);
CREATE INDEX IF NOT EXISTS bump_rta_worst_records_type_ranking_idx
    ON public.bump_rta_worst_records (guild_id, event_type, elapsed_ms DESC);
ALTER TABLE public.bump_rta_worst_records DISABLE ROW LEVEL SECURITY;
-- The self-hosted API connects as bot_api; without table privileges every
-- worst-record call fails with 42501 (this bit production on 2026-11-08,
-- where the table was created by postgres and no grant existed).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bot_api') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.bump_rta_worst_records TO bot_api;
  END IF;
END $$;

DROP FUNCTION IF EXISTS public.record_bump_rta_worst(text, text, text, integer, timestamptz);
CREATE OR REPLACE FUNCTION public.record_bump_rta_worst(
    p_guild_id text, p_user_id text, p_event_type text, p_elapsed_ms integer, p_completed_at timestamptz
) RETURNS void
LANGUAGE sql SECURITY INVOKER
AS $$
    INSERT INTO public.bump_rta_worst_records (guild_id, user_id, event_type, elapsed_ms, completed_at)
    VALUES (p_guild_id, p_user_id, p_event_type, p_elapsed_ms, p_completed_at)
    ON CONFLICT (guild_id, user_id, event_type) DO UPDATE
      SET elapsed_ms = EXCLUDED.elapsed_ms, completed_at = EXCLUDED.completed_at
      WHERE EXCLUDED.elapsed_ms > public.bump_rta_worst_records.elapsed_ms;
$$;
REVOKE ALL ON FUNCTION public.record_bump_rta_worst(text, text, text, integer, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_bump_rta_worst(text, text, text, integer, timestamptz) TO anon, service_role;

DROP FUNCTION IF EXISTS public.get_bump_rta_global_slowest_ranking(text, integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_global_slowest_ranking(p_event_type text, p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, elapsed_ms integer, attempts bigint)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT e.user_id, max(e.elapsed_ms)::integer AS elapsed_ms, count(*)::bigint AS attempts
    FROM public.bump_rta_events AS e
    WHERE e.event_type = p_event_type
    GROUP BY e.user_id
    ORDER BY max(e.elapsed_ms) DESC
    LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_global_slowest_ranking(text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_global_slowest_ranking(text, integer) TO anon, service_role;
