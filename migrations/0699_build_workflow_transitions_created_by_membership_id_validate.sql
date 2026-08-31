SET lock_timeout = '5s';

ALTER TABLE build.workflow_transitions
  VALIDATE CONSTRAINT fk_workflow_transitions_created_by_actor;
