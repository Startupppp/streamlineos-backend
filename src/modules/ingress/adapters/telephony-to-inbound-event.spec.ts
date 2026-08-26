import { activityKindFor, threadIdentity, validateInboundEvent } from "../inbound-event";
import { hasEligibleContext } from "../../autonomy/decision-record";
import { NORMALISED_INBOUND_CALL } from "./telephony-call-log.spec-fixtures";
import {
  normaliseNumber,
  telephonyCallToInboundEvent,
  type TelephonyCallForIngress,
  type TelephonyIngressContext,
} from "./telephony-to-inbound-event";

/**
 * Asserts the shape and the refusals, and nothing downstream.
 *
 * Same discipline as `mail-to-inbound-event.spec`: if this file started asserting
 * that a party was created, the adapter would be coupled to the pipeline and
 * every carrier field rename would mean re-testing the whole thing.
 *
 * One exception, and it is deliberate. Two tests below reach for
 * `hasEligibleContext` and `threadIdentity` — both pure, both downstream — because
 * the two behaviours this channel has to guarantee are *only* observable there.
 * "No transcript is synthesised" is not a claim about a null field; it is a claim
 * that the extraction tier does nothing, and the tier's own gate is the only
 * honest way to say so.
 */

const context: TelephonyIngressContext = {
  organizationId: "org-1",
  provider: "twilio",
};

const call = (over: Partial<TelephonyCallForIngress> = {}): TelephonyCallForIngress => ({
  ...NORMALISED_INBOUND_CALL,
  ...over,
});

const ok = (result: ReturnType<typeof telephonyCallToInboundEvent>) => {
  if (!result.ok) throw new Error(`expected an event, got skip: ${result.reason}`);
  return result;
};

const skip = (result: ReturnType<typeof telephonyCallToInboundEvent>) => {
  if (result.ok) throw new Error("expected a skip, got an event");
  return result.reason;
};

describe("telephonyCallToInboundEvent", () => {
  it("produces an event the seam accepts", () => {
    expect(validateInboundEvent(ok(telephonyCallToInboundEvent(call(), context)).event)).toEqual([]);
  });

  it("carries the provider's identifiers through for deduplication", () => {
    const { event } = ok(telephonyCallToInboundEvent(call(), context));
    expect(event).toMatchObject({
      channel: "call",
      provider: "twilio",
      providerMessageId: NORMALISED_INBOUND_CALL.id,
    });
    expect(activityKindFor(event.channel)).toBe("call");
  });

  it("files the call at the moment it happened", () => {
    const { event } = ok(telephonyCallToInboundEvent(call(), context));
    expect(event.occurredAt).toBe("2026-08-25T10:00:00.000Z");
  });

  describe("no transcript is synthesised", () => {
    it("gives a call with no transcript no body and no subject", () => {
      const { event } = ok(telephonyCallToInboundEvent(call({ transcript: null }), context));
      expect(event.body).toBeNull();
      expect(event.subject).toBeNull();
    });

    /**
     * The claim behind the null, asserted against the gate that enforces it.
     *
     * `AutonomyService` builds its prompt from `[subject, body]` and spends a
     * provider call as soon as that says anything at all. A "helpful" subject —
     * "Inbound call from +14155551212, 4m 12s" — would say plenty, and the
     * autonomy layer can advance a deal from what it reads. An invented
     * transcript is an invented reason to act. (The gate used to be twenty
     * characters; ticket 23 replaced it with a judgement about meaning, and this
     * subject would have cleared either one.)
     */
    it("leaves the extraction tier with nothing to work with", () => {
      const { event } = ok(telephonyCallToInboundEvent(call({ transcript: null }), context));
      expect(hasEligibleContext([event.subject, event.body])).toBe(false);
    });

    it("passes a provider's own transcript through verbatim", () => {
      const transcript = "Agent: thanks for calling. Caller: I want to renew the annual plan.";
      const { event } = ok(telephonyCallToInboundEvent(call({ transcript }), context));
      expect(event.body).toBe(transcript);
      expect(hasEligibleContext([event.subject, event.body])).toBe(true);
    });

    it("treats a whitespace-only transcript as no transcript", () => {
      const { event, unrepresented } = ok(
        telephonyCallToInboundEvent(call({ transcript: "   \n  " }), context),
      );
      expect(event.body).toBeNull();
      expect(unrepresented.hasTranscript).toBe(false);
    });
  });

  /**
   * `threadIdentity` falls back to the subject when there is no provider thread
   * id, so any constant subject — "Inbound call", "Missed call" — would put every
   * call in the organisation on one thread. Null subject, null thread id, and the
   * seam synthesises one per call.
   */
  it("gives each call its own thread rather than collapsing them onto one", () => {
    const first = ok(telephonyCallToInboundEvent(call({ id: "CA-1" }), context)).event;
    const second = ok(telephonyCallToInboundEvent(call({ id: "CA-2" }), context)).event;
    expect(threadIdentity(first)).not.toBe(threadIdentity(second));
  });

  describe("the facts a call is made of", () => {
    it("reports duration, direction and the recording reference", () => {
      const { unrepresented } = ok(telephonyCallToInboundEvent(call(), context));
      expect(unrepresented).toEqual({
        direction: "inbound",
        durationSeconds: 252,
        recordingReference: NORMALISED_INBOUND_CALL.recordingReference,
        hasTranscript: false,
      });
    });

    /**
     * The finding, as an assertion.
     *
     * `InboundCommunicationEvent` has nowhere to put any of these, and this
     * adapter does not smuggle them into the fields that do exist. When the seam
     * gains somewhere for them, this test is the one that has to change — which
     * is the point of writing it this way round.
     */
    it("keeps every one of them off the event, because the event cannot carry them", () => {
      const { event, unrepresented } = ok(telephonyCallToInboundEvent(call(), context));
      const recording = unrepresented.recordingReference;
      if (recording === null) throw new Error("the fixture is meant to carry a recording reference");

      const serialised = JSON.stringify(event);
      expect(serialised).not.toContain(String(unrepresented.durationSeconds));
      expect(serialised).not.toContain(recording);
      expect(serialised).not.toContain("inbound");
    });

    it("distinguishes a call that rang out from one whose length is unknown", () => {
      expect(ok(telephonyCallToInboundEvent(call({ durationSeconds: 0 }), context)).unrepresented)
        .toMatchObject({ durationSeconds: 0 });
      expect(
        ok(telephonyCallToInboundEvent(call({ durationSeconds: null }), context)).unrepresented,
      ).toMatchObject({ durationSeconds: null });
    });

    it("refuses a negative duration rather than recording it", () => {
      const { unrepresented } = ok(
        telephonyCallToInboundEvent(call({ durationSeconds: -3 }), context),
      );
      expect(unrepresented.durationSeconds).toBeNull();
    });
  });

  describe("refusals", () => {
    it("refuses a call with no identifier, which could never be deduplicated", () => {
      expect(skip(telephonyCallToInboundEvent(call({ id: "  " }), context))).toBe("no-identifier");
    });

    /**
     * The mail adapter estimates a missing timestamp and flags it. This one
     * cannot: the call sweep reads its watermark back out of the events it has
     * already delivered, so an estimated `occurredAt` of *now* would go straight
     * into the watermark and claim every call up to this instant was offered.
     */
    it("refuses a call with no start time rather than estimating one", () => {
      expect(skip(telephonyCallToInboundEvent(call({ startedAt: null }), context))).toBe(
        "no-timestamp",
      );
      expect(skip(telephonyCallToInboundEvent(call({ startedAt: "not a date" }), context))).toBe(
        "no-timestamp",
      );
    });

    it("refuses a call whose direction the provider did not state", () => {
      expect(skip(telephonyCallToInboundEvent(call({ direction: null }), context))).toBe(
        "direction-unknown",
      );
    });

    /**
     * The sharpest edge of the finding. The workflow resolves the party from the
     * `from` participant, which on an outbound call is our own number — so
     * accepting one would create a party for the rep who dialled.
     */
    it("refuses an outbound call, which the seam cannot attribute to the right person", () => {
      expect(skip(telephonyCallToInboundEvent(call({ direction: "outbound" }), context))).toBe(
        "outbound-unattributable",
      );
    });

    it("refuses a call with no caller number, which has nobody to resolve to", () => {
      expect(skip(telephonyCallToInboundEvent(call({ fromNumber: null }), context))).toBe(
        "no-counterparty",
      );
    });
  });

  describe("participants", () => {
    it("puts the caller on as the sender and our number as the recipient", () => {
      const { event } = ok(telephonyCallToInboundEvent(call(), context));
      expect(event.participants).toEqual([
        {
          address: "+14155551212",
          displayName: "Priya Raman",
          role: "from",
          // Every address on a call is a telephone number, and the adapter says
          // so rather than leaving the resolver to guess from the characters.
          identifierKind: "phone",
        },
        { address: "+14155559000", role: "to", identifierKind: "phone" },
      ]);
    });

    it("still produces an event when the carrier did not say which number was dialled", () => {
      const { event } = ok(telephonyCallToInboundEvent(call({ toNumber: null }), context));
      expect(event.participants).toHaveLength(1);
      expect(validateInboundEvent(event)).toEqual([]);
    });

    it("omits a caller ID name the carrier did not supply, rather than inventing one", () => {
      const { event } = ok(telephonyCallToInboundEvent(call({ callerName: null }), context));
      expect(event.participants[0]).toEqual({
        address: "+14155551212",
        role: "from",
        identifierKind: "phone",
      });
    });
  });

  describe("normaliseNumber", () => {
    /** The party resolver matches on the exact string, so one caller must be one string. */
    it("reduces every formatting a carrier uses to one address", () => {
      const forms = ["+14155551212", "+1 (415) 555-1212", "+1-415-555-1212", " +1.415.555.1212 "];
      expect(new Set(forms.map(normaliseNumber)).size).toBe(1);
    });

    it("does not invent a country code for a number that arrived without one", () => {
      expect(normaliseNumber("(415) 555-1212")).toBe("4155551212");
      expect(normaliseNumber("(415) 555-1212")).not.toBe(normaliseNumber("+14155551212"));
    });

    it("has nothing to say about a value with no digits in it", () => {
      expect(normaliseNumber("anonymous")).toBe("");
    });
  });
});
