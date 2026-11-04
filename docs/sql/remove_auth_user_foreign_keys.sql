-- Supabase Authを移行しないと確認した場合に限り適用する。
-- actor_idの値や行は削除せず、auth.usersへの外部キー制約だけを取り除く。
ALTER TABLE IF EXISTS public.api_operation_audit
  DROP CONSTRAINT IF EXISTS api_operation_audit_actor_id_fkey;

ALTER TABLE IF EXISTS public.api_operation_budgets
  DROP CONSTRAINT IF EXISTS api_operation_budgets_actor_id_fkey;
