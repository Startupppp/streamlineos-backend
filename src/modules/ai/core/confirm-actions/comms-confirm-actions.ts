import { BadRequestException } from "@nestjs/common";
import { EmailOutboxService } from "../../../email/email-outbox.service";
import { escapeHtml } from "../../../email/templates/base";
import { ChatMessagesService } from "../../../chat/chat-messages.service";
import { ChatChannelsService } from "../../../chat/chat-channels.service";
import { MailComposeService } from "../../../mail/mail-compose.service";
import { MailAccountsService } from "../../../mail/mail-accounts.service";
import {
  chatChannelPostPayloadSchema,
  mailReplyPayloadSchema,
  mailSendPayloadSchema,
  outboundEmailPayloadSchema,
  sendDirectMessagePayloadSchema,
} from "../dto/confirm-action-payloads.schemas";
import { defineConfirmableAction } from "./confirmable-action.types";

export const COMMS_CONFIRM_ACTIONS = [
  defineConfirmableAction({
    action: "email.send",
    permission: "chat:messages:write",
    payload: outboundEmailPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(EmailOutboxService, { strict: false }),
    execute: async ({ toEmail, subject, body }, _ctx, outbox) => {
      await outbox.enqueueAndTry({
        to: toEmail,
        subject,
        html: `<p>${escapeHtml(body)}</p>`,
        text: body,
      });
      return { result: { queued: true }, summary: `Email sent to ${toEmail}` };
    },
  }),

  defineConfirmableAction({
    action: "chat.postChannel",
    permission: "chat:messages:write",
    payload: chatChannelPostPayloadSchema,
    resolve: (moduleRef) => moduleRef.get(ChatMessagesService, { strict: false }),
    execute: async ({ channelId, channelName, message }, { actor }, messages) => {
      await messages.send(channelId, actor.userId, actor.orgId, { content: message });
      return {
        result: { sent: true, channelId },
        summary: `Message posted to #${channelName ?? channelId}`,
      };
    },
  }),

  defineConfirmableAction({
    action: "chat.sendDirect",
    permission: "chat:messages:write",
    payload: sendDirectMessagePayloadSchema,
    resolve: (moduleRef) => ({
      channels: moduleRef.get(ChatChannelsService, { strict: false }),
      messages: moduleRef.get(ChatMessagesService, { strict: false }),
    }),
    execute: async ({ targetUserId, message }, { actor }, { channels, messages }) => {
      const { channel } = await channels.createChannel(actor.orgId, actor.userId, {
        type: "DIRECT",
        targetUserId,
      });
      await messages.send(channel.id, actor.userId, actor.orgId, { content: message });
      return { result: { sent: true, channelId: channel.id }, summary: `Direct message sent` };
    },
  }),

  defineConfirmableAction({
    action: "mail.send",
    permission: "mail:messages:send",
    payload: mailSendPayloadSchema,
    resolve: (moduleRef) => ({
      accounts: moduleRef.get(MailAccountsService, { strict: false }),
      compose: moduleRef.get(MailComposeService, { strict: false }),
    }),
    execute: async ({ accountId, toEmail, subject, body }, { actor }, { accounts, compose }) => {
      await accounts.assertOwnedConnection(actor.orgId, actor.userId, accountId);
      await compose.sendMail(
        actor.orgId,
        actor.userId,
        accountId,
        [toEmail],
        subject,
        `<p>${escapeHtml(body)}</p>`,
      );
      return { result: { sent: true }, summary: `Email sent to ${toEmail}` };
    },
  }),

  defineConfirmableAction({
    action: "mail.reply",
    permission: "mail:messages:send",
    payload: mailReplyPayloadSchema,
    resolve: (moduleRef) => ({
      accounts: moduleRef.get(MailAccountsService, { strict: false }),
      compose: moduleRef.get(MailComposeService, { strict: false }),
    }),
    execute: async ({ threadId, body, accountEmail }, { actor }, { accounts, compose }) => {
      const owned = await accounts.listAccounts(actor.orgId, actor.userId);
      const account = accountEmail
        ? owned.find((candidate) => candidate.accountEmail === accountEmail)
        : (owned.find((candidate) => candidate.isPrimary) ?? owned[0]);
      if (!account) throw new BadRequestException("No connected mail account found");
      await compose.replyMail(
        actor.orgId,
        actor.userId,
        account.id,
        threadId,
        threadId,
        `<p>${escapeHtml(body)}</p>`,
      );
      return { result: { sent: true }, summary: `Reply sent to thread ${threadId}` };
    },
  }),
] as const;
