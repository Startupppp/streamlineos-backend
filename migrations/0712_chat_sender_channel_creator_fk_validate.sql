SET lock_timeout = '5s';
--> statement-breakpoint
ALTER TABLE chat_channels VALIDATE CONSTRAINT fk_chat_channels_org_creator_membership;
--> statement-breakpoint
ALTER TABLE chat_messages VALIDATE CONSTRAINT fk_chat_messages_org_sender_membership;
