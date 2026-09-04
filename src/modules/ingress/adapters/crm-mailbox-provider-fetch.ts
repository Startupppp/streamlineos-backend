import type { Logger } from "@nestjs/common";
import type { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import type { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import type { NormalizerConnectionMeta } from "../../mail/providers/mail-normalizers";
import { isPrivateMessage } from "./mail-ingress-privacy";
import { type MailMessageForIngress } from "./mail-to-inbound-event";
import type { MailMessageDetail } from "../../mail/dto/mail-schemas";
import {
  forIngress,
  GMAIL_EXCLUSIONS,
  MAX_DETAIL_FAILURES,
  MAX_DETAIL_FETCHES_PER_SWEEP,
  MAX_PAGES_PER_SWEEP,
  MAX_PER_PAGE,
  type SweepRead,
} from "./crm-mailbox-sweep-types";

export async function fetchGmailMessages(
  gmail: GmailMailProvider,
  userId: string,
  conn: NormalizerConnectionMeta,
  since: Date,
): Promise<SweepRead> {
  const query = `after:${Math.floor(since.getTime() / 1000)} ${GMAIL_EXCLUSIONS}`;

  const messages: MailMessageForIngress[] = [];
  let pageToken: string | undefined;
  let pages = 0;

  do {
    const page = await gmail.listMessages(userId, conn, "inbox", MAX_PER_PAGE, pageToken, query);
    for (const message of page.messages) messages.push(forIngress(message, null));
    pageToken = page.nextPageToken ?? undefined;
    pages += 1;
  } while (pageToken && pages < MAX_PAGES_PER_SWEEP);

  return { messages, privateLabelRule: "provider-query", truncated: Boolean(pageToken) };
}

export async function fetchOutlookMessages(
  outlook: OutlookMailProvider,
  userId: string,
  conn: NormalizerConnectionMeta,
  since: Date,
): Promise<SweepRead> {
  const messages: MailMessageForIngress[] = [];
  let skip = 0;
  let pages = 0;
  let drained = false;

  while (pages < MAX_PAGES_PER_SWEEP) {
    const page = await outlook.listMessagesForIngress(userId, conn, "inbox", MAX_PER_PAGE, skip);
    pages += 1;

    let crossedFloor = false;
    for (const message of page.messages) {
      const at = new Date(message.date).getTime();
      if (!Number.isNaN(at) && at < since.getTime()) {
        crossedFloor = true;
        continue;
      }
      messages.push(forIngress(message, message.labels));
    }

    if (crossedFloor || page.nextSkip === null) {
      drained = true;
      break;
    }
    skip = page.nextSkip;
  }

  return { messages, privateLabelRule: "message-labels", truncated: !drained };
}

export async function enrichWithDetail(
  provider: "gmail" | "outlook",
  gmail: GmailMailProvider,
  outlook: OutlookMailProvider,
  userId: string,
  conn: NormalizerConnectionMeta,
  messages: readonly MailMessageForIngress[],
  logger: Logger,
): Promise<MailMessageForIngress[]> {
  const enriched: MailMessageForIngress[] = [];
  let fetched = 0;
  let failures = 0;

  for (const message of messages) {
    if (
      fetched >= MAX_DETAIL_FETCHES_PER_SWEEP ||
      failures >= MAX_DETAIL_FAILURES ||
      isPrivateMessage(message)
    ) {
      enriched.push(message);
      continue;
    }

    try {
      fetched += 1;
      const detail: MailMessageDetail =
        provider === "gmail"
          ? await gmail.getMessage(userId, conn, message.id)
          : await outlook.getMessage(userId, conn, message.id);

      enriched.push({
        ...message,
        cc: detail.cc,
        bodyText: detail.bodyText,
        bodyHtml: detail.bodyHtml,
      });
    } catch (error) {
      failures += 1;
      logger.warn(
        `could not read ${message.id} in full: ${error instanceof Error ? error.message : String(error)}`,
      );
      enriched.push(message);
    }
  }

  return enriched;
}
