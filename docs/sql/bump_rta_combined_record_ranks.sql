-- Combined (all-services, per-user) record-time ranks for bump/up RTA.
-- The record message gains 総合最速 / 総合最遅 lines: where the run's
-- elapsed lands when every user counts as a single entry — fastest =
-- their min over all services, slowest = their max over all services
-- (the same definition as docs/sql/bump_rta_combined_ranking.sql).
-- The existing entry-based ranks stay untouched; the function keeps its
-- name and arguments (the bot API allowlist does not change) and now
-- returns the combined ranks as four additional columns.
-- Apply once per existing environment; new environments get the same
-- objects from bump_rta.sql. Safe to re-run.
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_all_fast_local integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_all_fast_global integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_all_slow_local integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_all_slow_global integer;

DROP FUNCTION IF EXISTS public.get_bump_rta_record_ranks(text, text, integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_record_ranks(
    p_guild_id text, p_event_type text, p_elapsed_ms integer
) RETURNS TABLE(
    rank_fast_local integer, rank_fast_global integer,
    rank_slow_local integer, rank_slow_global integer,
    rank_all_fast_local integer, rank_all_fast_global integer,
    rank_all_slow_local integer, rank_all_slow_global integer
)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT
      (SELECT count(*)::integer + 1 FROM public.bump_rta_records
        WHERE guild_id = p_guild_id AND event_type <> 'legacy'
          AND elapsed_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, event_type, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_events
          WHERE event_type <> 'legacy'
          GROUP BY user_id, event_type) AS g
        WHERE g.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM public.bump_rta_worst_records
        WHERE guild_id = p_guild_id AND event_type <> 'legacy'
          AND elapsed_ms > p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, event_type, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_events
          WHERE event_type <> 'legacy'
          GROUP BY user_id, event_type) AS g
        WHERE g.worst_ms > p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_records
          WHERE guild_id = p_guild_id AND event_type <> 'legacy'
          GROUP BY user_id) AS l
        WHERE l.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_events
          WHERE event_type <> 'legacy'
          GROUP BY user_id) AS g
        WHERE g.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_worst_records
          WHERE guild_id = p_guild_id AND event_type <> 'legacy'
          GROUP BY user_id) AS l
        WHERE l.worst_ms > p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_events
          WHERE event_type <> 'legacy'
          GROUP BY user_id) AS g
        WHERE g.worst_ms > p_elapsed_ms);
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) TO anon, service_role;
