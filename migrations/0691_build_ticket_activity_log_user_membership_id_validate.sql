SET lock_timeout = '5s';

ALTER TABLE build_events.ticket_activity_log
  VALIDATE CONSTRAINT fk_ticket_activity_log_user_actor;
