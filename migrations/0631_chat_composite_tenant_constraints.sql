SET lock_timeout = '5s';

ALTER TABLE chat_channel_members
  ADD CONSTRAINT fk_chat_channel_members_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_messages
  ADD CONSTRAINT fk_chat_messages_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_attachments
  ADD CONSTRAINT fk_chat_attachments_org_message
  FOREIGN KEY (org_id, message_id) REFERENCES chat_messages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_pinned_messages
  ADD CONSTRAINT fk_chat_pins_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_pinned_messages
  ADD CONSTRAINT fk_chat_pins_org_message
  FOREIGN KEY (org_id, message_id) REFERENCES chat_messages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_saved_messages
  ADD CONSTRAINT fk_chat_saved_messages_org_message
  FOREIGN KEY (org_id, message_id) REFERENCES chat_messages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_reply_reminders
  ADD CONSTRAINT fk_chat_reply_reminders_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_reply_reminders
  ADD CONSTRAINT fk_chat_reply_reminders_org_message
  FOREIGN KEY (org_id, message_id) REFERENCES chat_messages (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_huddles
  ADD CONSTRAINT fk_chat_huddles_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_huddle_participants
  ADD CONSTRAINT fk_chat_huddle_participants_org_huddle
  FOREIGN KEY (org_id, huddle_id) REFERENCES chat_huddles (org_id, id) ON DELETE CASCADE NOT VALID;
ALTER TABLE chat_channel_invite_links
  ADD CONSTRAINT fk_chat_invite_links_org_channel
  FOREIGN KEY (org_id, channel_id) REFERENCES chat_channels (org_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE chat_channel_members VALIDATE CONSTRAINT fk_chat_channel_members_org_channel;
ALTER TABLE chat_messages VALIDATE CONSTRAINT fk_chat_messages_org_channel;
ALTER TABLE chat_attachments VALIDATE CONSTRAINT fk_chat_attachments_org_message;
ALTER TABLE chat_pinned_messages VALIDATE CONSTRAINT fk_chat_pins_org_channel;
ALTER TABLE chat_pinned_messages VALIDATE CONSTRAINT fk_chat_pins_org_message;
ALTER TABLE chat_saved_messages VALIDATE CONSTRAINT fk_chat_saved_messages_org_message;
ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_channel;
ALTER TABLE chat_reply_reminders VALIDATE CONSTRAINT fk_chat_reply_reminders_org_message;
ALTER TABLE chat_huddles VALIDATE CONSTRAINT fk_chat_huddles_org_channel;
ALTER TABLE chat_huddle_participants VALIDATE CONSTRAINT fk_chat_huddle_participants_org_huddle;
ALTER TABLE chat_channel_invite_links VALIDATE CONSTRAINT fk_chat_invite_links_org_channel;
