-- Widen bump/up RTA event types for the services added after the initial split:
-- 鯖ちゃんねる (vote) / TakasumiBOT (takasumi) / Dicoall (dicoall) /
-- Discord Cafe (dcafe) / SharkBot (sharkbot).
-- Apply once per environment, like bump_rta_separate_types.sql.
ALTER TABLE public.bump_rta_events
    DROP CONSTRAINT IF EXISTS bump_rta_events_event_type_check;
ALTER TABLE public.bump_rta_events
    ADD CONSTRAINT bump_rta_events_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot'));

ALTER TABLE public.bump_rta_records
    DROP CONSTRAINT IF EXISTS bump_rta_records_event_type_check;
ALTER TABLE public.bump_rta_records
    ADD CONSTRAINT bump_rta_records_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot'));

ALTER TABLE public.bump_rta_pending
    DROP CONSTRAINT IF EXISTS bump_rta_pending_event_type_check;
ALTER TABLE public.bump_rta_pending
    ADD CONSTRAINT bump_rta_pending_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot'));

ALTER TABLE public.bump_rta_reminders
    DROP CONSTRAINT IF EXISTS bump_rta_reminders_event_type_check;
ALTER TABLE public.bump_rta_reminders
    ADD CONSTRAINT bump_rta_reminders_event_type_check CHECK (event_type IN ('bump', 'up', 'legacy', 'vote', 'takasumi', 'dicoall', 'dcafe', 'sharkbot'));
