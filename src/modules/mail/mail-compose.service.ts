import { BadRequestException, Injectable } from "@nestjs/common";
import { CacheService } from "../../common/cache/cache.service";
import { GmailMailProvider } from "./providers/gmail-mail.provider";
import { OutlookMailProvider } from "./providers/outlook-mail.provider";
import { type NormalizerConnectionMeta } from "./providers/mail-normalizers";
import { MailAccountsService } from "./mail-accounts.service";
import { MailMetadataService } from "./mail-metadata.service";
import type { MailDownloadResponse } from "./dto/mail-response.schemas";

@Injectable()
export class MailComposeService {
  constructor(
    private readonly accounts: MailAccountsService,
    private readonly gmail: GmailMailProvider,
    private readonly outlook: OutlookMailProvider,
    private readonly cache: CacheService,
    private readonly metadata: MailMetadataService,
  ) {}

  async sendMail(
    orgId: string,
    userId: string,
    accountId: number,
    to: string[],
    subject: string,
    bodyHtml: string,
    cc?: string[],
    bcc?: string[],
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    if (acc.provider === "gmail") {
      await this.gmail.sendEmail(userId, conn, to, subject, bodyHtml, cc, bcc);
    } else {
      await this.outlook.sendEmail(
        userId,
        conn,
        to,
        subject,
        bodyHtml,
        cc,
        bcc,
      );
    }
  }

  /**
   * Send `bodyHtml` as a reply to `messageId`.
   *
   * `to` is the recipient the sender chose in the compose sheet. It used to have
   * nowhere to go: the reply form collected a required, validated To address and
   * the request body had no field for it, so a sender who changed the recipient
   * got a "Reply sent" toast for a message delivered to whoever the server
   * derived instead. Both providers can be told a recipient — Gmail through
   * `recipient_email`, Graph through the `message.toRecipients` of the reply
   * action it already uses for `ccRecipients` — so the address is carried
   * through rather than the field being removed.
   *
   * Absent `to`, the derivation stays exactly as it was: the original sender,
   * unless this account IS the original sender, in which case the message's
   * first To address (replying to something you sent goes to the person you sent
   * it to, not back to yourself).
   */
  async replyMail(
    orgId: string,
    userId: string,
    accountId: number,
    messageId: string,
    threadId: string | undefined,
    bodyHtml: string,
    cc?: string[],
    to?: string[],
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    const requestedRecipient = to?.[0];
    if (acc.provider === "gmail") {
      if (!threadId)
        throw new BadRequestException("threadId is required for Gmail replies");
      let recipientEmail = requestedRecipient;
      if (!recipientEmail) {
        const original = await this.gmail.getMessage(userId, conn, messageId);
        recipientEmail =
          original.from.email !== acc.accountEmail
            ? original.from.email
            : original.to[0]?.email;
      }
      if (!recipientEmail)
        throw new BadRequestException(
          "Cannot determine reply recipient: original message has no resolvable address",
        );
      await this.gmail.replyToThread(userId, conn, {
        threadId,
        recipientEmail,
        bodyHtml,
        cc,
      });
    } else {
      await this.outlook.replyToMessage(
        userId,
        conn,
        messageId,
        bodyHtml,
        cc,
        requestedRecipient,
      );
    }
  }

  async performAction(
    orgId: string,
    userId: string,
    membershipId: number | null,
    messageId: string,
    accountId: number,
    action: "markRead" | "markUnread" | "star" | "unstar" | "archive" | "trash",
    threadId?: string,
  ): Promise<void> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };

    if (acc.provider === "gmail") {
      if (action === "trash") {
        await this.gmail.moveToTrash(userId, conn, messageId);
      } else {
        if (!threadId) {
          throw new BadRequestException(
            "threadId is required for Gmail label operations",
          );
        }
        switch (action) {
          case "markRead":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["UNREAD"],
            );
            break;
          case "markUnread":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              ["UNREAD"],
              [],
            );
            break;
          case "star":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              ["STARRED"],
              [],
            );
            break;
          case "unstar":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["STARRED"],
            );
            break;
          case "archive":
            await this.gmail.modifyThreadLabels(
              userId,
              conn,
              threadId,
              [],
              ["INBOX"],
            );
            break;
        }
      }
    } else {
      switch (action) {
        case "markRead":
          await this.outlook.markRead(conn, messageId, true);
          break;
        case "markUnread":
          await this.outlook.markRead(conn, messageId, false);
          break;
        case "star":
          await this.outlook.setFlag(conn, messageId, "flagged");
          break;
        case "unstar":
          await this.outlook.setFlag(conn, messageId, "notFlagged");
          break;
        case "archive":
          await this.outlook.moveMessage(userId, conn, messageId, "archive");
          break;
        case "trash":
          await this.outlook.moveMessage(
            userId,
            conn,
            messageId,
            "deleteditems",
          );
          break;
      }
    }

    await this.cache.invalidateNamespace(`mail:messages:${acc.id}`);

    const stateUpdate: {
      isRead?: boolean;
      isStarred?: boolean;
      folder?: string;
    } = {};
    if (action === "markRead") stateUpdate.isRead = true;
    else if (action === "markUnread") stateUpdate.isRead = false;
    else if (action === "star") stateUpdate.isStarred = true;
    else if (action === "unstar") stateUpdate.isStarred = false;
    else if (action === "archive") stateUpdate.folder = "archive";
    else if (action === "trash") stateUpdate.folder = "trash";

    if (Object.keys(stateUpdate).length > 0 && membershipId !== null) {
      this.metadata.deferUpdateState(
        acc.id,
        membershipId,
        orgId,
        messageId,
        stateUpdate,
      );
    }
  }

  async getAttachment(
    orgId: string,
    userId: string,
    messageId: string,
    attachmentId: string,
    accountId: number,
    fileName: string,
  ): Promise<MailDownloadResponse> {
    const acc = await this.accounts.assertOwnedConnection(
      orgId,
      userId,
      accountId,
    );
    const conn: NormalizerConnectionMeta = {
      id: acc.id,
      composioAccountId: acc.composioConnectedAccountId,
      provider: acc.provider,
      accountEmail: acc.accountEmail,
    };
    if (acc.provider === "gmail") {
      return this.gmail.getAttachment(
        userId,
        conn,
        messageId,
        attachmentId,
        fileName,
      );
    }
    return this.outlook.getAttachment(
      userId,
      conn,
      messageId,
      attachmentId,
      fileName,
    );
  }
}
