-- Combined (all-services) rankings for bump/up RTA, 2026-11-10.
-- The boards and the record-time ranks are now aggregated across every
-- service: per user, fastest = min over all services, slowest = max over
-- all services. Records themselves stay per-service (event_type kept).
-- Apply once per existing environment; new environments get the same
-- definitions from bump_rta.sql. Safe to re-run.
--
-- get_bump_rta_record_ranks keeps its name and signature (the bot API
-- allowlist does not change); only the rank basis becomes combined.
-- p_event_type is still accepted for compatibility but no longer used:
-- local ranks compare against each user's combined best/worst in the
-- guild (min/max over their per-service rows), global ranks against
-- each user's combined best/worst over all events.
CREATE OR REPLACE FUNCTION public.get_bump_rta_record_ranks(
    p_guild_id text, p_event_type text, p_elapsed_ms integer
) RETURNS TABLE(
    rank_fast_local integer, rank_fast_global integer,
    rank_slow_local integer, rank_slow_global integer
)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_records
          WHERE guild_id = p_guild_id
          GROUP BY user_id) AS l
        WHERE l.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_events
          GROUP BY user_id) AS g
        WHERE g.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_worst_records
          WHERE guild_id = p_guild_id
          GROUP BY user_id) AS l
        WHERE l.worst_ms > p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_events
          GROUP BY user_id) AS g
        WHERE g.worst_ms > p_elapsed_ms);
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) TO anon, service_role;

-- Combined global boards: same return shape as the per-service
-- get_bump_rta_global_ranking / get_bump_rta_global_slowest_ranking,
-- aggregated over every event_type (attempts = the user's total runs).
DROP FUNCTION IF EXISTS public.get_bump_rta_global_combined_ranking(integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_global_combined_ranking(p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, elapsed_ms integer, attempts bigint)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT e.user_id, min(e.elapsed_ms)::integer AS elapsed_ms, count(*)::bigint AS attempts
    FROM public.bump_rta_events AS e
    GROUP BY e.user_id
    ORDER BY min(e.elapsed_ms) ASC
    LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_global_combined_ranking(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_global_combined_ranking(integer) TO anon, service_role;

DROP FUNCTION IF EXISTS public.get_bump_rta_global_combined_slowest_ranking(integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_global_combined_slowest_ranking(p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, elapsed_ms integer, attempts bigint)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT e.user_id, max(e.elapsed_ms)::integer AS elapsed_ms, count(*)::bigint AS attempts
    FROM public.bump_rta_events AS e
    GROUP BY e.user_id
    ORDER BY max(e.elapsed_ms) DESC
    LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_global_combined_slowest_ranking(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_global_combined_slowest_ranking(integer) TO anon, service_role;
