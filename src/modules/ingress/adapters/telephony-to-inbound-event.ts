import type {
  InboundChannel,
  InboundCommunicationEvent,
  InboundParticipant,
} from "../inbound-event";

/**
 * Turning a call-log entry into the one event shape.
 *
 * Same contract as `mail-to-inbound-event`: this file translates and stops. It
 * resolves no parties, writes nothing and calls nothing, because the seam exists
 * so that adding a channel needs no change below it.
 *
 * Read the docblock on `TelephonyCallFacts` before changing anything here. Three
 * of the four things a call *is* — how long it lasted, which way it went, and
 * where the recording lives — have nowhere to go on an
 * `InboundCommunicationEvent`, and this adapter deliberately does not smuggle
 * them into the fields that do exist.
 */

/** Which way the call went, as the provider states it. Never inferred. */
export type TelephonyDirection = "inbound" | "outbound";

/**
 * The subset of a provider's call-log entry this needs.
 *
 * Every field is required on the type and nullable in value, following the
 * lesson `MailMessageForIngress.labels` encodes: an optional field reads as
 * "absent means none", every caller that forgets it still compiles, and the
 * decision that turns on it is silently made on a default nobody chose. Here
 * that would be `direction` — and a call whose direction we guessed is a call
 * filed against the wrong person.
 */
export interface TelephonyCallForIngress {
  /** The provider's own identifier for the call. Half of the deduplication key. */
  readonly id: string;
  /** `null` when the provider did not say, which is refused rather than guessed. */
  readonly direction: TelephonyDirection | null;
  readonly fromNumber: string | null;
  readonly toNumber: string | null;
  /** When the call started, not when the log entry was written. */
  readonly startedAt: string | null;
  readonly durationSeconds: number | null;
  /** Wherever the provider keeps the audio — a URL, a resource path, an id. */
  readonly recordingReference: string | null;
  /**
   * The provider's transcript, or `null`.
   *
   * `null` means there is no transcript. It never means "produce one" — see
   * `bodyOf`.
   */
  readonly transcript: string | null;
  /** Caller ID name where the carrier supplied one. */
  readonly callerName: string | null;
}

export interface TelephonyIngressContext {
  readonly organizationId: string;
  /** The adapter label, e.g. `twilio`. Only used for the deduplication key. */
  readonly provider: string;
}

/**
 * What a call is, that the seam cannot carry.
 *
 * `InboundCommunicationEvent` has exactly nine fields, and none of them is
 * duration, direction or a recording reference. That is not an oversight in this
 * adapter — it is the finding ticket 12 exists to record, so these are returned
 * *beside* the event rather than folded into it, and nothing downstream reads
 * them today.
 *
 * The three fields that could have been abused, and why none of them was:
 *
 * `body` — forbidden outright. The extraction tier reads the body and can
 * advance a deal from it, so a body reading "Inbound call, 4m 12s" is an
 * invented reason to act on a call nobody has heard. A call with no transcript
 * is a call with no body.
 *
 * `subject` — the same objection, one step removed. `AutonomyService` builds its
 * prompt from `[subject, body].filter(Boolean).join("\n\n")` and spends a
 * provider call as soon as that says anything at all, so any descriptive
 * subject is a synthesised prompt wearing a different field's name.
 *
 * `providerThreadId` / `subject` for threading — `threadIdentity` falls back to
 * the subject when there is no provider thread id, so a constant subject like
 * "Inbound call" would put *every call in the organisation* on one thread.
 *
 * What the event actually needs is a channel-specific remainder that nothing
 * below the seam branches on — `activities.metadata` is already exactly that
 * column, and already documents itself as never read for a lifecycle decision.
 * The gap is that the event has no field to fill it from and the workflow's
 * activity writer never sets it.
 */
export interface TelephonyCallFacts {
  readonly direction: TelephonyDirection;
  /** `null` when the provider did not state one. Never defaulted to zero. */
  readonly durationSeconds: number | null;
  readonly recordingReference: string | null;
  /** Whether a transcript reached the event's body. Never whether one could be made. */
  readonly hasTranscript: boolean;
}

export type TelephonyIngressResult =
  | {
      readonly ok: true;
      readonly event: InboundCommunicationEvent;
      readonly unrepresented: TelephonyCallFacts;
    }
  | { readonly ok: false; readonly reason: TelephonySkipReason };

export type TelephonySkipReason =
  | "no-identifier"
  | "no-timestamp"
  | "direction-unknown"
  | "no-counterparty"
  | "outbound-unattributable";

/** The seam's own limit, matched so an in-process caller cannot exceed the wire's. */
const MAX_BODY_CHARS = 100_000;

/**
 * A phone number in one shape, so one caller is not three parties.
 *
 * Carriers hand the same number over as `+14155551212`, `+1 (415) 555-1212` and
 * `+1-415-555-1212`, and the party resolver matches on the exact string — so the
 * formatting has to come off here or the same person gets a record per carrier
 * habit.
 *
 * What it deliberately does NOT do is add a country code to a number that
 * arrived without one. `4155551212` could be American, and could equally be a
 * local number in a dozen other places; picking one would merge two strangers
 * onto a record on the strength of a guess. Such a number stays as it came, does
 * not match the same person's E.164 number, and produces a second party — which
 * is a visible duplicate rather than a silent wrong match, and is the trade this
 * function is making on purpose.
 */
export function normaliseNumber(raw: string): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return "";
  return trimmed.startsWith("+") ? `+${digits}` : digits;
}

/**
 * A call as an inbound communication event, or a reason it is not one.
 *
 * Refusing is most of this function, and each refusal has a name so a sweep can
 * count it and say so. The alternative — filing something plausible — is the
 * failure this whole module is built against: a timeline that looks complete and
 * is not.
 */
export function telephonyCallToInboundEvent(
  call: TelephonyCallForIngress,
  context: TelephonyIngressContext,
): TelephonyIngressResult {
  if (!call.id?.trim()) return { ok: false, reason: "no-identifier" };

  /**
   * No start time is a refusal, where the mail adapter estimates one.
   *
   * The difference is what the timestamp feeds. A mail sweep can hand its
   * watermark an "estimated" flag and exclude the message; a call sweep reads
   * its watermark back out of the events it has already delivered, so an
   * estimated `occurredAt` of *now* would go straight into the watermark and
   * claim every call up to this instant had been offered.
   */
  const occurredAt = call.startedAt ? new Date(call.startedAt) : null;
  if (!occurredAt || Number.isNaN(occurredAt.getTime()))
    return { ok: false, reason: "no-timestamp" };

  /**
   * A direction the provider did not state is refused, not assumed.
   *
   * Direction decides which of the two numbers is the customer. Assuming
   * "inbound" would file every outbound call against our own sales rep's phone
   * number, creating a party for the rep and a timeline entry claiming the
   * customer rang us.
   */
  if (call.direction === null) return { ok: false, reason: "direction-unknown" };

  /**
   * Outbound calls are refused, and this is the sharpest edge of the finding.
   *
   * The workflow resolves the party from `senderOf(event)` — the participant
   * with role `from`. On an outbound call that is our own number, so accepting
   * one would create a `business_parties` row for the rep who dialled and file
   * the call against it. The only way to avoid that within the current event
   * shape is to put the person we called in the `from` slot, which is a lie
   * about who rang whom written into a permanent record.
   *
   * So the channel delivers half a corpus, visibly, rather than a whole one
   * built on a falsehood. The fix is below the seam and belongs to ticket 12:
   * the event needs to state its direction, and the workflow needs to resolve
   * the party from the counterparty rather than from whoever spoke first.
   */
  if (call.direction === "outbound") return { ok: false, reason: "outbound-unattributable" };

  const from = participantFrom(call.fromNumber, call.callerName, "from");
  const to = participantFrom(call.toNumber, null, "to");

  // Without the caller's number there is nobody to resolve to a party, and the
  // seam refuses an event with no `from` anyway — named here so the sweep can
  // report it rather than discovering it as a validation failure.
  if (!from) return { ok: false, reason: "no-counterparty" };

  const participants: InboundParticipant[] = to ? [from, to] : [from];
  const body = bodyOf(call);

  return {
    ok: true,
    unrepresented: {
      direction: call.direction,
      durationSeconds: durationOf(call.durationSeconds),
      recordingReference: call.recordingReference?.trim() || null,
      hasTranscript: body !== null,
    },
    event: {
      organizationId: context.organizationId,
      channel: "call" satisfies InboundChannel,
      provider: context.provider,
      providerMessageId: call.id,
      /**
       * A call has no thread of its own, and none is invented.
       *
       * Left null so `threadIdentity` synthesises one per call from the
       * organisation, the channel and the call id. Grouping every call with the
       * same number onto one thread was the tempting alternative and is wrong
       * for the same reason the mail adapter refuses to thread on subject:
       * "the same number rang twice" is not evidence that the two conversations
       * are one, and a thread that never ends is a thread nothing can summarise.
       */
      providerThreadId: null,
      occurredAt: occurredAt.toISOString(),
      /**
       * Always null. A call has no subject, and the two things it would be
       * tempting to put here — a description of the call, or a constant label —
       * are a synthesised model prompt and an organisation-wide thread collapse
       * respectively. See `TelephonyCallFacts`.
       */
      subject: null,
      body,
      participants,
    },
  };
}

/**
 * The call as text, or nothing at all.
 *
 * The only source is a transcript the provider produced. There is no fallback,
 * no summary, no "call from +1… lasting four minutes" — because the extraction
 * tier reads this field and can advance a deal from it, and a body nobody said
 * is a reason to act that nobody gave. A call with no transcript is a call with
 * no body, and the tier below does nothing with it, which is the correct
 * outcome rather than a degraded one.
 */
function bodyOf(call: TelephonyCallForIngress): string | null {
  const transcript = call.transcript?.trim();
  return transcript ? transcript.slice(0, MAX_BODY_CHARS) : null;
}

/**
 * The duration, or nothing.
 *
 * A missing duration is not zero. Zero is a real and meaningful value — an
 * inbound call that rang out is a customer who tried to reach us — so defaulting
 * an absent one to zero would make "we do not know" indistinguishable from "they
 * hung up before we answered". A negative or non-finite figure is bad data, not
 * a call that lasted a negative time.
 */
function durationOf(seconds: number | null): number | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds);
}

function participantFrom(
  number: string | null,
  displayName: string | null,
  role: "from" | "to",
): InboundParticipant | null {
  const address = number ? normaliseNumber(number) : "";
  if (!address) return null;
  const name = displayName?.trim();
  /**
   * Every address on a call is a telephone number, and this is where that is
   * stated rather than inferred.
   *
   * The resolver keys `party_identifiers` on `(kind, value)`, and the kind has
   * to come from the adapter that knows what it read. Left to a guess, `+1-555…`
   * is just a string, and the guess that used to be made wrote it into
   * `business_parties.email`.
   */
  const identifierKind = "phone" as const;
  return name
    ? { address, displayName: name, role, identifierKind }
    : { address, role, identifierKind };
}
