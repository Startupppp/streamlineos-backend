SET lock_timeout = '5s';

ALTER TABLE build.ticket_related_links
  VALIDATE CONSTRAINT fk_ticket_related_links_created_by_actor;
