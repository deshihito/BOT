-- Record-time ranks for bump/up RTA: when a run is recorded, the bot also
-- stores where that run's elapsed lands in each ranking (fastest / slowest x
-- this-server / global) on the per-run row in bump_rta_events.
-- Apply once per existing environment; new environments get the same objects
-- from bump_rta.sql.
-- The columns are added to the existing bump_rta_events table, so no new
-- table privileges are needed: the bot API role already holds
-- SELECT/INSERT/UPDATE/DELETE on this table.
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_fast_local integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_fast_global integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_slow_local integer;
ALTER TABLE public.bump_rta_events ADD COLUMN IF NOT EXISTS rank_slow_global integer;

-- Rank definition: the position the given elapsed takes in each ranking after
-- the run has been recorded = (number of other users ranked above it) + 1.
-- Local rankings read the per-user best/worst tables (bump_rta_records /
-- bump_rta_worst_records for this guild); global rankings aggregate
-- bump_rta_events per user (min for fastest, max for slowest), matching the
-- boards. Ties share the better rank.
DROP FUNCTION IF EXISTS public.get_bump_rta_record_ranks(text, text, integer);
CREATE OR REPLACE FUNCTION public.get_bump_rta_record_ranks(
    p_guild_id text, p_event_type text, p_elapsed_ms integer
) RETURNS TABLE(
    rank_fast_local integer, rank_fast_global integer,
    rank_slow_local integer, rank_slow_global integer
)
LANGUAGE sql SECURITY INVOKER
AS $$
    SELECT
      (SELECT count(*)::integer + 1 FROM public.bump_rta_records AS r
        WHERE r.guild_id = p_guild_id AND r.event_type = p_event_type
          AND r.elapsed_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, min(elapsed_ms) AS best_ms
          FROM public.bump_rta_events
          WHERE event_type = p_event_type
          GROUP BY user_id) AS g
        WHERE g.best_ms < p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM public.bump_rta_worst_records AS w
        WHERE w.guild_id = p_guild_id AND w.event_type = p_event_type
          AND w.elapsed_ms > p_elapsed_ms),
      (SELECT count(*)::integer + 1 FROM (
          SELECT user_id, max(elapsed_ms) AS worst_ms
          FROM public.bump_rta_events
          WHERE event_type = p_event_type
          GROUP BY user_id) AS g
        WHERE g.worst_ms > p_elapsed_ms);
$$;
REVOKE ALL ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_bump_rta_record_ranks(text, text, integer) TO anon, service_role;
