// The provider classes reach the Composio SDK, which ships ESM that jest does
// not transform. Mocked at the door, as every other spec that touches a
// provider does — nothing here goes near a real client.
jest.mock("@composio/core", () => ({ Composio: jest.fn() }));

import type { Db } from "../../../db/drizzle.types";
import type { MailMessageDetail, MailMessageSummary } from "../../mail/dto/mail-response.schemas";
import type { GmailMailProvider } from "../../mail/providers/gmail-mail.provider";
import type { OutlookMailProvider } from "../../mail/providers/outlook-mail.provider";
import type { OutlookMessageWithLabels } from "../../mail/providers/outlook-mail-wire";
import type { InboundIngressService } from "../inbound-ingress.service";
import type { InboundCommunicationEvent } from "../inbound-event";
import { CrmMailboxService } from "./crm-mailbox.service";
import { INITIAL_LOOKBACK_MS, OVERLAP_MS } from "./mailbox-sync";

/**
 * The sweep as its callers meet it.
 *
 * `mailbox-sync.spec.ts` proves the watermark arithmetic, which is pure and
 * cannot be got wrong on its own — `advanceWatermark` can only return one of
 * the two dates it was handed. Every way the watermark has actually been got
 * wrong lives here instead, in what the sweep decides to hand it: a page of the
 * newest 100 out of 500 while the rest fall below the floor forever, and a
 * message whose `Date:` header would not parse moving it to this instant.
 *
 * No provider SDK is mocked — there is none in this repo to mock. What is
 * substituted is this module's own two provider classes, at their own
 * interfaces.
 */

const NOW = Date.now();
const MINUTE = 60 * 1000;

function summary(over: Partial<MailMessageSummary> = {}): MailMessageSummary {
  return {
    id: "msg-1",
    threadId: "thread-1",
    accountId: 0,
    provider: "gmail",
    from: { name: "Priya Raman", email: "priya@example.com" },
    to: [{ name: null, email: "rep@ourcompany.example" }],
    subject: "Re: Quote for Q3",
    snippet: "Looks good, please send",
    date: new Date(NOW - MINUTE).toISOString(),
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    ...over,
  };
}

function detail(of: MailMessageSummary): MailMessageDetail {
  return {
    ...of,
    cc: [{ name: null, email: "boss@example.com" }],
    bodyHtml: null,
    bodyText: "The whole message, not the preview.",
    attachments: [],
  };
}

/** `count` messages, newest first, one minute apart — as both providers return them. */
function newestFirst(count: number, prefix = "msg"): MailMessageSummary[] {
  return Array.from({ length: count }, (_, index) =>
    summary({
      id: `${prefix}-${index}`,
      date: new Date(NOW - index * MINUTE).toISOString(),
    }),
  );
}

interface MailboxRow {
  crmMailboxSyncId: string;
  organizationId: string;
  connectionId: number;
  mailboxAddress: string;
  provider: "gmail" | "outlook";
  syncedThrough: Date | null;
  enabled: boolean;
  consecutiveFailures: number;
}

function mailbox(over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    crmMailboxSyncId: "mailbox-1",
    organizationId: "org-1",
    connectionId: 7,
    mailboxAddress: "rep@ourcompany.example",
    provider: "gmail",
    syncedThrough: null,
    enabled: true,
    consecutiveFailures: 0,
    ...over,
  };
}

interface Recorder {
  updates: Record<string, unknown>[];
}

/**
 * Answers the two reads the sweep makes — the sync row, then its connection —
 * and records what it is asked to write.
 */
function makeDb(row: MailboxRow, recorder: Recorder): Db {
  let selectCall = 0;

  return {
    select: jest.fn().mockImplementation(() => ({
      from: jest.fn().mockImplementation(() => ({
        where: jest.fn().mockImplementation(() => ({
          limit: jest.fn().mockImplementation(async () => {
            selectCall += 1;
            if (selectCall === 1) return [row];
            return [{ userId: "user-1", composioAccountId: "acct-1", status: "active" }];
          }),
        })),
      })),
    })),
    update: jest.fn().mockImplementation(() => ({
      set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
        recorder.updates.push(values);
        return { where: jest.fn().mockResolvedValue(undefined) };
      }),
    })),
  } as unknown as Db;
}

interface GmailStub {
  provider: GmailMailProvider;
  queries: (string | undefined)[];
  pageTokens: (string | undefined)[];
}

/** Gmail, paginating by opaque token. `pages` is what each call returns. */
function makeGmail(pages: { messages: MailMessageSummary[]; nextPageToken: string | null }[]): GmailStub {
  const queries: (string | undefined)[] = [];
  const pageTokens: (string | undefined)[] = [];
  let call = 0;

  const provider = {
    listMessages: jest
      .fn()
      .mockImplementation(
        async (
          _userId: string,
          _conn: unknown,
          _folder: string,
          _limit: number,
          pageToken?: string,
          query?: string,
        ) => {
          queries.push(query);
          pageTokens.push(pageToken);
          return pages[Math.min(call++, pages.length - 1)];
        },
      ),
    getMessage: jest
      .fn()
      .mockImplementation(async (_userId: string, _conn: unknown, messageId: string) =>
        detail(summary({ id: messageId })),
      ),
  } as unknown as GmailMailProvider;

  return { provider, queries, pageTokens };
}

interface OutlookStub {
  provider: OutlookMailProvider;
  skips: number[];
  searched: number;
}

/** Outlook, paginating by numeric skip. */
function makeOutlook(
  pages: { messages: OutlookMessageWithLabels[]; nextSkip: number | null }[],
): OutlookStub {
  const stub: OutlookStub = { provider: null as unknown as OutlookMailProvider, skips: [], searched: 0 };
  let call = 0;

  stub.provider = {
    listMessagesForIngress: jest
      .fn()
      .mockImplementation(
        async (_userId: string, _conn: unknown, _folder: string, _limit: number, skip: number) => {
          stub.skips.push(skip);
          return pages[Math.min(call++, pages.length - 1)];
        },
      ),
    // The path that used to be taken, and must not be: it is a keyword search.
    listMessages: jest.fn().mockImplementation(async () => {
      stub.searched += 1;
      return { messages: [], nextSkip: null };
    }),
    getMessage: jest
      .fn()
      .mockImplementation(async (_userId: string, _conn: unknown, messageId: string) =>
        detail(summary({ id: messageId, provider: "outlook" })),
      ),
  } as unknown as OutlookMailProvider;

  return stub;
}

function withLabels(
  message: MailMessageSummary,
  labels: string[] | null,
): OutlookMessageWithLabels {
  return { ...message, provider: "outlook", labels };
}

function makeService(row: MailboxRow, gmail: GmailMailProvider, outlook: OutlookMailProvider) {
  const recorder: Recorder = { updates: [] };
  const events: InboundCommunicationEvent[] = [];
  const ingress = {
    accept: jest.fn().mockImplementation(async (event: InboundCommunicationEvent) => {
      events.push(event);
      return { status: "accepted", inboundEventId: "receipt-1", workflowRunId: null };
    }),
  } as unknown as InboundIngressService;

  return {
    service: new CrmMailboxService(makeDb(row, recorder), ingress, gmail, outlook),
    recorder,
    events,
    accepted: { get ids() { return events.map((event) => event.providerMessageId); } },
  };
}

describe("the mailbox sweep", () => {
  describe("how much of the window it reads", () => {
    /**
     * The failure this replaces. The sweep read one page, and both providers
     * return newest first — so 500 messages in a first sync became the newest
     * hundred, and the watermark then moved to the newest of those. The other
     * 400 were below the floor of every sweep after it, permanently. The person
     * saw one day of history and was never told the rest was not coming.
     */
    it("follows the provider's pages to the floor before it offers anything up", async () => {
      const gmail = makeGmail([
        { messages: newestFirst(100, "a"), nextPageToken: "page-2" },
        { messages: newestFirst(100, "b"), nextPageToken: "page-3" },
        { messages: newestFirst(100, "c"), nextPageToken: null },
      ]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service, accepted, recorder } = makeService(mailbox(), gmail.provider, outlook.provider);

      const result = await service.sync("org-1", "mailbox-1");

      expect(result).toMatchObject({ swept: true, delivered: 300, truncated: false });
      expect(accepted.ids).toHaveLength(300);
      // Resumed from the token it was given rather than asking for page one again.
      expect(gmail.pageTokens).toEqual([undefined, "page-2", "page-3"]);
      expect(recorder.updates[0]?.syncedThrough).toBeInstanceOf(Date);
    });

    /**
     * Past the page budget the watermark is a scalar that cannot describe a
     * hole, so a sweep that could not reach the floor of its window must not
     * claim it did. Holding it means the messages below stay above the floor of
     * the next sweep.
     */
    it("holds the watermark when a backlog outruns one sweep", async () => {
      const syncedThrough = new Date(NOW - 60 * MINUTE);
      const gmail = makeGmail([{ messages: newestFirst(100), nextPageToken: "endless" }]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service, recorder } = makeService(
        mailbox({ syncedThrough }),
        gmail.provider,
        outlook.provider,
      );

      const result = await service.sync("org-1", "mailbox-1");

      expect(result).toMatchObject({ swept: true, truncated: true });
      expect(recorder.updates[0]?.syncedThrough).toBe(syncedThrough);
      expect(String(recorder.updates[0]?.lastError)).toContain("Nothing has been skipped");
    });

    /**
     * The one case where it does move anyway. A first sweep's lookback window
     * is a courtesy backfill rather than a delivery promise, and holding the
     * watermark there would mean a busy mailbox re-read the same newest pages
     * every few minutes forever and never filed a message that arrived after it
     * was connected. The note says what was left behind.
     */
    it("still moves on a first sweep that could not drain the lookback, and says so", async () => {
      const gmail = makeGmail([{ messages: newestFirst(100), nextPageToken: "endless" }]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service, recorder } = makeService(
        mailbox({ syncedThrough: null }),
        gmail.provider,
        outlook.provider,
      );

      await service.sync("org-1", "mailbox-1");

      expect(recorder.updates[0]?.syncedThrough).toBeInstanceOf(Date);
      expect(String(recorder.updates[0]?.lastError)).toContain("older mail was left");
    });
  });

  describe("what the watermark is allowed to become", () => {
    /**
     * One malformed `Date:` header used to set "everything up to now has been
     * read", skipping whatever the provider had not yet indexed — the exact gap
     * the watermark exists to close.
     */
    it("ignores a message whose date the provider could not give", async () => {
      const real = new Date(NOW - 30 * MINUTE);
      const gmail = makeGmail([
        {
          messages: [
            summary({ id: "undated", date: "not a date" }),
            summary({ id: "dated", date: real.toISOString() }),
          ],
          nextPageToken: null,
        },
      ]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service, recorder } = makeService(mailbox(), gmail.provider, outlook.provider);

      const result = await service.sync("org-1", "mailbox-1");

      // Both were filed — the message is not lost, only its claim on the clock.
      expect(result).toMatchObject({ delivered: 2 });
      expect(recorder.updates[0]?.syncedThrough).toEqual(real);
    });

    it("leaves the watermark alone when every message it read was undated", async () => {
      const syncedThrough = new Date(NOW - 60 * MINUTE);
      const gmail = makeGmail([
        { messages: [summary({ id: "undated", date: "not a date" })], nextPageToken: null },
      ]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service, recorder } = makeService(
        mailbox({ syncedThrough }),
        gmail.provider,
        outlook.provider,
      );

      await service.sync("org-1", "mailbox-1");

      expect(recorder.updates[0]?.syncedThrough).toBe(syncedThrough);
    });

    /**
     * A message the sweep judged and refused counts: it was offered, and
     * re-reading it forever would be pointless. One refused for want of labels
     * was never judged at all, so moving past it would mean it never is.
     */
    it("counts a message it refused on the merits, but not one it could not judge", async () => {
      const older = new Date(NOW - 90 * MINUTE);
      const newer = new Date(NOW - 30 * MINUTE);
      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([
        {
          messages: [
            withLabels(summary({ id: "unknowable", date: newer.toISOString() }), null),
            withLabels(summary({ id: "private", date: older.toISOString() }), ["Private"]),
          ],
          nextSkip: null,
        },
      ]);
      const { service, recorder, accepted } = makeService(
        mailbox({ provider: "outlook" }),
        gmail.provider,
        outlook.provider,
      );

      const result = await service.sync("org-1", "mailbox-1");

      expect(accepted.ids).toHaveLength(0);
      expect(result).toMatchObject({ skipped: 2 });
      // The private one, not the unknowable one that is newer than it.
      expect(recorder.updates[0]?.syncedThrough).toEqual(older);
    });
  });

  describe("the private-label rule", () => {
    /**
     * Gmail cannot show a sweep a message's labels, so it is asked to withhold
     * the labelled mail instead — in the same query that carries the date
     * bound, which is the mechanism the sweep already depends on.
     */
    it("asks Gmail to withhold every label the adapter would have refused", async () => {
      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
      const { service } = makeService(mailbox(), gmail.provider, outlook.provider);

      await service.sync("org-1", "mailbox-1");

      const query = gmail.queries[0] ?? "";
      for (const label of ["private", "personal", "confidential", "crm-exclude", "no-crm"])
        expect(query).toContain(`-label:${label}`);
      expect(query).toContain("-label:junk-email");
      expect(query).toMatch(/^after:\d+ /);
    });

    /**
     * Outlook can, so it is held to the stronger rule: a message whose
     * categories did not come back is refused rather than assumed public.
     */
    it("refuses to file an Outlook message whose categories did not come back", async () => {
      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([
        {
          messages: [
            withLabels(summary({ id: "known" }), []),
            withLabels(summary({ id: "unknowable" }), null),
            withLabels(summary({ id: "categorised" }), ["Private"]),
          ],
          nextSkip: null,
        },
      ]);
      const { service, accepted } = makeService(
        mailbox({ provider: "outlook" }),
        gmail.provider,
        outlook.provider,
      );

      const result = await service.sync("org-1", "mailbox-1");

      expect(accepted.ids).toEqual(["known"]);
      expect(result).toMatchObject({ delivered: 1, skipped: 2, unjudged: 1 });
    });

    /**
     * And says so on the row. A mailbox that reads mail and files none of it
     * must not report itself healthy — that is the shape of the bug this module
     * has already had once, where every sweep returned `delivered: 0`, reset the
     * failure count, and left somebody believing their mail was in the CRM.
     */
    it("does not report a mailbox healthy while it is refusing everything", async () => {
      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([
        { messages: [withLabels(summary({ id: "unknowable" }), null)], nextSkip: null },
      ]);
      const { service, recorder } = makeService(
        mailbox({ provider: "outlook" }),
        gmail.provider,
        outlook.provider,
      );

      await service.sync("org-1", "mailbox-1");

      expect(String(recorder.updates[0]?.lastError)).toContain("did not say which labels");
    });
  });

  describe("reading Outlook at all", () => {
    /**
     * The sweep used to hand an OData `$filter` string to `listMessages`, which
     * routes any query to a keyword search — so every sweep searched the
     * mailbox for the literal text "receivedDateTime ge 2026-08-25T…", matched
     * nothing, reported `delivered: 0`, reset the failure count, and left the
     * mailbox looking healthy while no Outlook mail ever arrived.
     */
    it("never takes the keyword-search path", async () => {
      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([
        { messages: [withLabels(summary({ id: "m-1" }), [])], nextSkip: null },
      ]);
      const { service, accepted } = makeService(
        mailbox({ provider: "outlook" }),
        gmail.provider,
        outlook.provider,
      );

      await service.sync("org-1", "mailbox-1");

      expect(outlook.searched).toBe(0);
      expect(accepted.ids).toEqual(["m-1"]);
    });

    /**
     * With no date filter at the provider, the floor is applied to the
     * server-assigned `receivedDateTime` here — and crossing it ends the sweep,
     * because the order was requested newest first.
     */
    it("stops at the floor of the window instead of reading the mailbox out", async () => {
      const syncedThrough = new Date(NOW - 10 * MINUTE);
      const floor = syncedThrough.getTime() - OVERLAP_MS;

      const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
      const outlook = makeOutlook([
        {
          messages: [withLabels(summary({ id: "inside", date: new Date(NOW).toISOString() }), [])],
          nextSkip: 100,
        },
        {
          messages: [
            withLabels(summary({ id: "still-inside", date: new Date(floor + MINUTE).toISOString() }), []),
            withLabels(summary({ id: "below", date: new Date(floor - MINUTE).toISOString() }), []),
          ],
          nextSkip: 200,
        },
        { messages: [withLabels(summary({ id: "older-still" }), [])], nextSkip: null },
      ]);
      const { service, accepted } = makeService(
        mailbox({ provider: "outlook", syncedThrough }),
        gmail.provider,
        outlook.provider,
      );

      await service.sync("org-1", "mailbox-1");

      expect(accepted.ids).toEqual(["inside", "still-inside"]);
      // Two pages asked for, and the third never requested.
      expect(outlook.skips).toEqual([0, 100]);
    });
  });

  /**
   * A listing carries a ~160-character preview and no cc at all, and a timeline
   * entry made of previews is a poor record of a conversation.
   */
  it("reads the newest messages in full, so the body and cc are the real ones", async () => {
    const gmail = makeGmail([{ messages: [summary({ id: "m-1" })], nextPageToken: null }]);
    const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
    const { service, events } = makeService(mailbox(), gmail.provider, outlook.provider);

    await service.sync("org-1", "mailbox-1");

    expect(events[0]?.body).toBe("The whole message, not the preview.");
    expect(events[0]?.participants).toContainEqual({
      role: "cc",
      address: "boss@example.com",
      identifierKind: "email",
    });
  });

  it("does not fetch the body of a message somebody marked private", async () => {
    const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
    const outlook = makeOutlook([
      { messages: [withLabels(summary({ id: "private" }), ["Private"])], nextSkip: null },
    ]);
    const { service } = makeService(mailbox({ provider: "outlook" }), gmail.provider, outlook.provider);

    await service.sync("org-1", "mailbox-1");

    expect(outlook.provider.getMessage).not.toHaveBeenCalled();
  });

  it("asks for the window the plan named, not for the whole mailbox", async () => {
    const gmail = makeGmail([{ messages: [], nextPageToken: null }]);
    const outlook = makeOutlook([{ messages: [], nextSkip: null }]);
    const { service } = makeService(mailbox(), gmail.provider, outlook.provider);

    await service.sync("org-1", "mailbox-1");

    const after = Number(/after:(\d+)/.exec(gmail.queries[0] ?? "")?.[1]);
    const expected = Math.floor((NOW - INITIAL_LOOKBACK_MS) / 1000);
    expect(Math.abs(after - expected)).toBeLessThan(5);
  });
});
