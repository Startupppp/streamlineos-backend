SET lock_timeout = '5s';
CREATE INDEX IF NOT EXISTS idx_mail_sync_checkpoints_org_account_folder ON public.mail_sync_checkpoints (org_id, account_id, folder);
