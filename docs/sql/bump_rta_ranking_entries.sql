-- Entry-based rankings for bump/up RTA, 2026-11-10.
-- The combined boards no longer collapse each user into one row:
-- every (user, service) pair is its own ranking entry, so a user with
-- records on both bump and up appears once per service. The per-service
-- boards stay abolished; there is still exactly one board.
-- Fastest board = every row of bump_rta_records pooled, slowest board =
-- every row of bump_rta_worst_records pooled. legacy rows (pre-split
-- mixed history) are not a service and never become entries.
-- Apply once per existing environment (after bump_rta_combined_ranking
-- .sql); new environments get the same definitions from bump_rta.sql.
-- Safe to re-run.
--
-- Function names and parameter signatures do not change, so the bot
-- API allowlist (api/app.py) does not change either. The two global
-- board RPCs gain an event_type column in their result, which needs a
-- DROP + CREATE (CREATE OR REPLACE cannot change the return type).
CREATE OR REPLACE FUNCTION public.get_bump_rta_record_ranks(
    p_guild_id text, p_event_type text, p_elapsed_ms integer
) RETURNS TABLE(
    rank_fast_local integer, rank_fast_global integer,
    rank_slow_local integer, rank_slow_global integer
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
        WHERE g.worst_ms > p_elapsed_ms);
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) TO anon, service_role;

-- Combined global boards, entry-based: one row per (user, event_type),
-- attempts counted per (user, event_type).
DROP FUNCTION IF EXISTS public.get_bump_rta_global_combined_ranking(integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_global_combined_ranking(p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, event_type text, elapsed_ms integer, attempts bigint)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT e.user_id, e.event_type, min(e.elapsed_ms)::integer AS elapsed_ms,
           count(*)::bigint AS attempts
    FROM public.bump_rta_events AS e
    WHERE e.event_type <> 'legacy'
    GROUP BY e.user_id, e.event_type
    ORDER BY min(e.elapsed_ms) ASC
    LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_global_combined_ranking(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_global_combined_ranking(integer) TO anon, service_role;

DROP FUNCTION IF EXISTS public.get_bump_rta_global_combined_slowest_ranking(integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_global_combined_slowest_ranking(p_limit integer DEFAULT 10)
RETURNS TABLE(user_id text, event_type text, elapsed_ms integer, attempts bigint)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT e.user_id, e.event_type, max(e.elapsed_ms)::integer AS elapsed_ms,
           count(*)::bigint AS attempts
    FROM public.bump_rta_events AS e
    WHERE e.event_type <> 'legacy'
    GROUP BY e.user_id, e.event_type
    ORDER BY max(e.elapsed_ms) DESC
    LIMIT greatest(1, least(coalesce(p_limit, 10), 100));
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_global_combined_slowest_ranking(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_global_combined_slowest_ranking(integer) TO anon, service_role;
