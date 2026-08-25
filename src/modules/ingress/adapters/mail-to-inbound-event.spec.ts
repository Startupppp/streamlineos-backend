import {
  mailToInboundEvent,
  type MailIngressContext,
  type MailMessageForIngress,
} from "./mail-to-inbound-event";
import { validateInboundEvent } from "../inbound-event";

/**
 * Asserts the shape and nothing else, deliberately.
 *
 * The seam exists so that adding a channel requires no change below it. If this
 * file started asserting that a party was created or an activity logged, the
 * adapter would be coupled to the pipeline and every provider field rename
 * would mean re-testing the whole thing. Everything downstream is exercised by
 * driving a fixture event through the seam instead — which is why no test in
 * this repo mocks a provider SDK.
 */

const context: MailIngressContext = {
  organizationId: "org-1",
  provider: "gmail",
  mailboxAddress: "rep@ourcompany.example",
  privateLabelRule: "message-labels",
};

const message = (over: Partial<MailMessageForIngress> = {}): MailMessageForIngress => ({
  id: "msg-1",
  threadId: "thread-9",
  from: { email: "Priya@Example.com", name: "Priya Raman" },
  to: [{ email: "rep@ourcompany.example" }],
  subject: "Re: Quote for Q3",
  bodyText: "Looks good, please send the contract.",
  date: "2026-08-25T10:00:00.000Z",
  labels: [],
  ...over,
});

const ok = (result: ReturnType<typeof mailToInboundEvent>) => {
  if (!result.ok) throw new Error(`expected an event, got skip: ${result.reason}`);
  return result.event;
};

describe("mailToInboundEvent", () => {
  it("produces an event the seam accepts", () => {
    // The one assertion that matters: the seam is the contract, so validating
    // against it is stronger than checking fields by hand.
    expect(validateInboundEvent(ok(mailToInboundEvent(message(), context)))).toEqual([]);
  });

  it("carries the provider's identifiers through for deduplication", () => {
    const event = ok(mailToInboundEvent(message(), context));
    expect(event).toMatchObject({ provider: "gmail", providerMessageId: "msg-1", channel: "email" });
  });

  /**
   * Subjects are edited, translated and reused: two unrelated conversations
   * both called "Re: Invoice" become one thread if you infer from the subject,
   * and a renamed thread splits in two. The provider already knows.
   */
  it("threads on the provider's own thread id, not the subject", () => {
    expect(ok(mailToInboundEvent(message(), context)).providerThreadId).toBe("thread-9");

    const noThread = ok(mailToInboundEvent(message({ threadId: null }), context));
    // Absent rather than invented.
    expect(noThread.providerThreadId).toBeNull();
  });

  it("lower-cases addresses, so one person is one party", () => {
    const event = ok(mailToInboundEvent(message(), context));
    expect(event.participants[0]).toMatchObject({
      address: "priya@example.com",
      displayName: "Priya Raman",
      role: "from",
    });
  });

  it("keeps to and cc with their roles", () => {
    const event = ok(
      mailToInboundEvent(
        message({ to: [{ email: "rep@ourcompany.example" }], cc: [{ email: "boss@example.com" }] }),
        context,
      ),
    );
    expect(event.participants.map((p) => p.role)).toEqual(["from", "to", "cc"]);
  });

  it("prefers the text body and falls back to the snippet", () => {
    expect(ok(mailToInboundEvent(message({ bodyText: null, snippet: "short" }), context)).body).toBe("short");
  });

  describe("what it refuses", () => {
    /**
     * The criterion that cannot be got wrong. A person marking mail private is
     * doing it in their own mail client and has no idea this system exists.
     */
    it("never emits a message the person marked private", () => {
      for (const label of ["Private", "PERSONAL", "confidential", "CRM-Exclude", "no-crm"]) {
        const result = mailToInboundEvent(message({ labels: [label] }), context);
        expect(result).toEqual({ ok: false, reason: "private" });
      }
    });

    it("leaves spam, trash and drafts alone", () => {
      for (const folder of ["Spam", "Junk Email", "Trash", "Deleted Items", "Drafts"])
        expect(mailToInboundEvent(message({ labels: [folder] }), context).ok).toBe(false);
    });

    /**
     * The half a `as unknown as` cast used to hide. The provider type the sweep
     * handed over had no labels at all, so the private check ran against
     * `undefined`, answered "not private", and filed the message anyway.
     *
     * Unknown is not permission. A provider whose labels cannot be read yet
     * ingests nothing until it can, which is visible and recoverable; a private
     * message in a shared CRM is neither.
     */
    it("refuses a message whose labels the provider did not disclose", () => {
      expect(mailToInboundEvent(message({ labels: null }), context)).toEqual({
        ok: false,
        reason: "labels-unknown",
      });
    });

    /**
     * Unless the provider was asked to withhold the labelled mail itself, which
     * is what Gmail's query does — then absent labels are not a gap.
     */
    it("accepts unlabelled messages when the provider did the excluding", () => {
      const result = mailToInboundEvent(message({ labels: null }), {
        ...context,
        privateLabelRule: "provider-query",
      });
      expect(result.ok).toBe(true);
    });

    /** And still checks any labels that do come through, either way. */
    it("refuses a private message even when the provider was meant to have filtered it", () => {
      const result = mailToInboundEvent(message({ labels: ["Private"] }), {
        ...context,
        privateLabelRule: "provider-query",
      });
      expect(result).toEqual({ ok: false, reason: "private" });
    });

    it("skips a message with no sender, which cannot be attributed", () => {
      expect(mailToInboundEvent(message({ from: null }), context)).toEqual({
        ok: false,
        reason: "no-sender",
      });
      expect(mailToInboundEvent(message({ from: { email: "  " } }), context).ok).toBe(false);
    });

    it("skips a message with no provider id, which cannot be deduplicated", () => {
      expect(mailToInboundEvent(message({ id: "" }), context)).toEqual({
        ok: false,
        reason: "no-identifier",
      });
    });

    it("skips a note the owner sent only to themselves", () => {
      // No correspondent, so there is no party to file it against.
      const result = mailToInboundEvent(
        message({ from: { email: "rep@ourcompany.example" }, to: [{ email: "rep@ourcompany.example" }] }),
        context,
      );
      expect(result).toEqual({ ok: false, reason: "own-mailbox-noise" });
    });

    it("reports a skip rather than throwing, so one odd message cannot stop a mailbox", () => {
      expect(() => mailToInboundEvent(message({ from: null, id: "" }), context)).not.toThrow();
    });
  });

  describe("timestamps", () => {
    it("passes a real date through as ISO", () => {
      expect(ok(mailToInboundEvent(message({ date: "Mon, 25 Aug 2026 10:00:00 +0000" }), context)).occurredAt)
        .toBe("2026-08-25T10:00:00.000Z");
    });

    it("falls back to now rather than emitting an invalid date", () => {
      // Wrong by minutes beats losing when the conversation happened entirely.
      for (const date of [null, "not a date"]) {
        const event = ok(mailToInboundEvent(message({ date }), context));
        expect(Number.isNaN(new Date(event.occurredAt).getTime())).toBe(false);
      }
    });

    /**
     * And says so, because `occurredAt` moves a mailbox watermark. One
     * malformed `Date:` header would otherwise set "everything up to now has
     * been read" and skip whatever the provider had not yet indexed — the exact
     * gap the watermark exists to close.
     */
    it("reports a fallback timestamp as estimated, and a real one as not", () => {
      for (const date of [null, "not a date"]) {
        const result = mailToInboundEvent(message({ date }), context);
        expect(result).toMatchObject({ ok: true, occurredAtEstimated: true });
      }

      expect(mailToInboundEvent(message(), context)).toMatchObject({
        ok: true,
        occurredAtEstimated: false,
      });
    });
  });

  describe("the body", () => {
    /**
     * A timeline entry made of 160-character previews is a poor record of a
     * conversation and a worse input to anything that reads it afterwards.
     */
    it("flattens HTML when that is the only body the provider has", () => {
      const event = ok(
        mailToInboundEvent(
          message({
            bodyText: null,
            snippet: "Looks good, please s",
            bodyHtml: "<style>p{color:red}</style><p>Looks good.</p><p>Send the contract.</p>",
          }),
          context,
        ),
      );

      // The stylesheet is gone rather than flattened into the text with it.
      expect(event.body).toBe("Looks good.\nSend the contract.");
    });

    it("still prefers a real text body, and the snippet only when there is neither", () => {
      expect(ok(mailToInboundEvent(message({ bodyHtml: "<p>markup</p>" }), context)).body).toBe(
        "Looks good, please send the contract.",
      );
      expect(
        ok(mailToInboundEvent(message({ bodyText: null, bodyHtml: null, snippet: "short" }), context))
          .body,
      ).toBe("short");
    });
  });
});
