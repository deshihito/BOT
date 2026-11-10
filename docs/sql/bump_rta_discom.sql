-- Widen bump/up RTA event types for DISCOM (discom), added 2026-11-10.
-- Apply once per environment, after bump_rta_dsio.sql.
-- Until this is applied, discom detections still notify via the in-memory
-- reminder; only the durable record / reminder-restore writes fail soft
-- (they are caught and logged by the caller), so existing services are
-- unaffected either way.
ALTER TABLE public.bump_rta_events
    DROP CONSTRAINT IF EXISTS bump_rta_events_event_type_check;
ALTER TABLE public.bump_rta_events
    ADD CONSTRAINT bump_rta_events_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot', 'dsio', 'discom'));

ALTER TABLE public.bump_rta_records
    DROP CONSTRAINT IF EXISTS bump_rta_records_event_type_check;
ALTER TABLE public.bump_rta_records
    ADD CONSTRAINT bump_rta_records_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot', 'dsio', 'discom'));

ALTER TABLE public.bump_rta_pending
    DROP CONSTRAINT IF EXISTS bump_rta_pending_event_type_check;
ALTER TABLE public.bump_rta_pending
    ADD CONSTRAINT bump_rta_pending_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot', 'dsio', 'discom'));

ALTER TABLE public.bump_rta_reminders
    DROP CONSTRAINT IF EXISTS bump_rta_reminders_event_type_check;
ALTER TABLE public.bump_rta_reminders
    ADD CONSTRAINT bump_rta_reminders_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot', 'dsio', 'discom'));

ALTER TABLE public.bump_rta_worst_records
    DROP CONSTRAINT IF EXISTS bump_rta_worst_records_event_type_check;
ALTER TABLE public.bump_rta_worst_records
    ADD CONSTRAINT bump_rta_worst_records_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot', 'dsio', 'discom'));
