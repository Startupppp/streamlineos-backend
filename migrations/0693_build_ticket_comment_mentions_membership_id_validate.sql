SET lock_timeout = '5s';

ALTER TABLE build.ticket_comment_mentions
  VALIDATE CONSTRAINT fk_ticket_comment_mentions_mentioned_user_actor;
