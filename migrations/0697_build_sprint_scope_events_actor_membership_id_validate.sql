SET lock_timeout = '5s';

ALTER TABLE build_events.sprint_scope_events
  VALIDATE CONSTRAINT fk_sprint_scope_events_actor;
