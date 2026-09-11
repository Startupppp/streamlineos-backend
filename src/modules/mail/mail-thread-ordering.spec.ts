import { MailService } from "./mail.service";
import { sortThreadChronologically } from "./providers/mail-normalizers";
import type { MailMessageDetail } from "./dto/mail-response.schemas";

/**
 * "Indexed conversation ordering" — the conversation half. `getThread` handed
 * the provider's own order straight to the caller: Gmail applies no sort at all
 * (`GMAIL_FETCH_MESSAGE_BY_THREAD_ID` is mapped and filtered, never sorted)
 * while Outlook pushes `receivedDateTime asc` to Graph. The same conversation
 * therefore rendered in two different orders depending on the account, and the
 * two AI callers — thread summarisation and reply drafting — were reading an
 * unordered transcript and treating its last element as the newest message.
 *
 * These drive the real MailService with provider doubles answering in the shape
 * the real providers produce, per AGENT-BRIEF rule 11: a typecheck cannot see
 * an ordering contract, only the returned value can.
 */

const ORG = "org-thread";
const USER = "user-thread";
const THREAD = "thread-1";

function message(id: string, date: string, subject = "Re: quarterly review"): MailMessageDetail {
  return {
    id,
    threadId: THREAD,
    accountId: 1,
    provider: "gmail",
    from: { email: "sender@example.com", name: "Sender" },
    to: [{ email: "me@example.com", name: "Me" }],
    subject,
    snippet: `snippet ${id}`,
    date,
    isRead: true,
    isStarred: false,
    hasAttachments: false,
    cc: [],
    bodyHtml: null,
    bodyText: `body ${id}`,
    attachments: [],
  };
}

function buildService(provider: "gmail" | "outlook", thread: MailMessageDetail[]) {
  const getThread = jest.fn().mockResolvedValue(thread);
  const accounts = {
    assertOwnedConnection: jest.fn().mockResolvedValue({
      id: 1,
      composioConnectedAccountId: "conn-1",
      provider,
      accountEmail: "me@example.com",
    }),
    markNeedsReauth: jest.fn(),
  };
  const gmail = { getThread: provider === "gmail" ? getThread : jest.fn() };
  const outlook = { getThread: provider === "outlook" ? getThread : jest.fn() };

  const service = new MailService(
    accounts as never,
    gmail as never,
    outlook as never,
    {} as never,
    {} as never,
    {} as never,
    { ENCRYPTION_KEY: "mail-thread-ordering-secret" },
  );
  return { service, getThread };
}

const idsOf = (messages: MailMessageDetail[]): string[] => messages.map((m) => m.id);

describe("getThread orders the conversation, whatever the provider returned", () => {
  it("sorts a Gmail thread the provider handed back unordered", async () => {
    const unordered = [
      message("m3", "2024-06-05T12:00:00.000Z"),
      message("m1", "2024-06-05T09:00:00.000Z"),
      message("m4", "2024-06-05T15:30:00.000Z"),
      message("m2", "2024-06-05T10:15:00.000Z"),
    ];
    const { service } = buildService("gmail", unordered);

    const result = await service.getThread(ORG, USER, THREAD, 1);

    expect(idsOf(result)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("BITE: the double really does answer out of order, so the assertion above means something", () => {
    const unordered = [
      message("m3", "2024-06-05T12:00:00.000Z"),
      message("m1", "2024-06-05T09:00:00.000Z"),
    ];
    expect(idsOf(unordered)).toEqual(["m3", "m1"]);
  });

  it("leaves an already-ordered Outlook thread untouched", async () => {
    const ordered = [
      message("o1", "2024-06-05T09:00:00Z"),
      message("o2", "2024-06-05T10:15:00Z"),
      message("o3", "2024-06-05T12:00:00Z"),
    ];
    const { service } = buildService("outlook", ordered);

    const result = await service.getThread(ORG, USER, THREAD, 1);

    expect(idsOf(result)).toEqual(["o1", "o2", "o3"]);
  });

  it("the two providers agree on the same conversation, which is the whole point", async () => {
    const instants = [
      "2024-06-05T09:00:00.000Z",
      "2024-06-05T10:15:00.000Z",
      "2024-06-05T12:00:00.000Z",
    ];
    const gmailOrder = [message("b", instants[1]!), message("c", instants[2]!), message("a", instants[0]!)];
    const outlookOrder = [message("a", instants[0]!), message("b", instants[1]!), message("c", instants[2]!)];

    const gmail = await buildService("gmail", gmailOrder).service.getThread(ORG, USER, THREAD, 1);
    const outlook = await buildService("outlook", outlookOrder).service.getThread(ORG, USER, THREAD, 1);

    expect(idsOf(gmail)).toEqual(idsOf(outlook));
  });

  it("the newest message is last, which is what the AI reply drafter treats as current", async () => {
    const { service } = buildService("gmail", [
      message("old", "2024-06-01T08:00:00.000Z"),
      message("newest", "2024-06-09T18:45:00.000Z"),
      message("middle", "2024-06-04T11:00:00.000Z"),
    ]);

    const result = await service.getThread(ORG, USER, THREAD, 1);

    expect(result.at(-1)?.id).toBe("newest");
  });
});

describe("sortThreadChronologically handles the formats Graph actually emits", () => {
  it("orders by instant, not by text — Graph's 7-digit fractional seconds sort backwards as strings", () => {
    const plain = "2024-06-05T10:15:30Z";
    const fractional = "2024-06-05T10:15:30.5000000Z";

    // The instant order and the TEXT order disagree: '.' sorts below 'Z', so
    // the later message compares as the earlier string. This is what a
    // `localeCompare` sort — the one `mergeMessagesByDate` uses — gets wrong.
    expect(Date.parse(plain)).toBeLessThan(Date.parse(fractional));
    expect(plain.localeCompare(fractional)).toBeGreaterThan(0);

    const sorted = sortThreadChronologically([
      { id: "later", date: fractional },
      { id: "earlier", date: plain },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["earlier", "later"]);
  });

  it("orders a non-UTC offset against a UTC instant correctly", () => {
    const sorted = sortThreadChronologically([
      { id: "utc-1200", date: "2024-06-05T12:00:00Z" },
      { id: "ist-1600", date: "2024-06-05T16:00:00+05:30" },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["ist-1600", "utc-1200"]);
  });

  it("breaks a tie on id so the order is stable rather than arbitrary", () => {
    const same = "2024-06-05T10:00:00.000Z";
    const sorted = sortThreadChronologically([
      { id: "b", date: same },
      { id: "a", date: same },
      { id: "c", date: same },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("BITE: an unparseable date sorts last instead of poisoning the comparator with NaN", () => {
    expect(Number.isNaN(Date.parse("not a date"))).toBe(true);

    const sorted = sortThreadChronologically([
      { id: "broken", date: "not a date" },
      { id: "second", date: "2024-06-05T11:00:00.000Z" },
      { id: "first", date: "2024-06-05T09:00:00.000Z" },
    ]);
    expect(sorted.map((m) => m.id)).toEqual(["first", "second", "broken"]);
  });

  it("does not mutate the array it was given", () => {
    const input = [
      { id: "b", date: "2024-06-05T11:00:00.000Z" },
      { id: "a", date: "2024-06-05T09:00:00.000Z" },
    ];
    sortThreadChronologically(input);
    expect(input.map((m) => m.id)).toEqual(["b", "a"]);
  });
});
