import { z } from "zod";

/**
 * What may be said about a call's consent, and — more to the point — what may
 * not.
 *
 * Every schema here is `.strict()`, and that is the enforcement half of the
 * ticket rather than tidiness. A two-party consent jurisdiction is a
 * criminal-law constraint, so there is no tenant setting that reaches it: no
 * `regime`, no `skipConsentCheck`, no `jurisdictionOverride`, no
 * `analyseAnyway`. Zod's default is to strip unknown keys, which would accept
 * such a field silently and leave the next reader of this file believing the
 * override worked and was ignored somewhere further down. `.strict()` makes the
 * request fail, and `consent-is-not-a-setting.spec.ts` fires exactly those keys
 * at these schemas so a future author who adds one finds out here.
 */

/**
 * An ISO 3166-1 alpha-2 code, optionally with an ISO 3166-2 subdivision.
 *
 * The same shape as the CHECK constraint in 0544 and as
 * `normaliseJurisdiction`. Uppercased rather than rejected on case, because a
 * human types `us-ca`; anything past that is rejected rather than stored,
 * because a free-text "California" matches no register entry and would resolve
 * to all-party — the right answer arrived at by accident, which stops being
 * right the day somebody adds a fuzzy lookup.
 */
const jurisdictionSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}(-[A-Z0-9]{1,3})?$/, "Use an ISO 3166 code such as DE or US-CA.");

/**
 * How the customer's agreement was obtained.
 *
 * `own-recording` is absent on purpose: it describes our own side, and offering
 * it here would let an attester mark the customer as having consented because we
 * pressed record, which is the assumption an all-party jurisdiction exists to
 * refuse. `standing-consent` is absent for a different reason — it is read from
 * `crm_contact_channel_consent`, so accepting it here would let somebody assert
 * a standing opt-in that the consent table does not have.
 */
const counterpartyMethodSchema = z.enum(["announced-and-acknowledged", "written-agreement"]);

/**
 * There is deliberately no `consentedAt` field.
 *
 * A caller-supplied timestamp is the one addition that would turn this route
 * into a way of retroactively legalising a recording: back-date the attestation
 * to before the call and the rule waves it through. The service stamps the
 * server's clock instead, which is why
 * `counterparty-consent-after-the-call` can be trusted to mean what it says.
 */
export const callRecordingConsentBodySchema = z
  .object({
    jurisdiction: jurisdictionSchema,

    /**
     * Our own side of the call agreed to it being recorded — in practice, the
     * rep pressed record. Recorded rather than assumed from the fact that a
     * transcript exists: our rep is a party to the conversation exactly as the
     * customer is, and an adapter-delivered call has no identified person on our
     * side at all.
     */
    orgPartyConsented: z.boolean(),

    counterpartyConsented: z.boolean(),
    counterpartyMethod: counterpartyMethodSchema.optional(),

    /**
     * They asked, on this call, that it not be processed. Separate from a
     * channel-wide opt-out because somebody can be happy to be phoned and
     * unhappy to be recorded.
     */
    counterpartyWithdrawn: z.boolean().default(false),

    /** Bounded to a sentence, matching the CHECK in 0544. Not a comment thread. */
    note: z.string().trim().max(500).optional(),
  })
  .strict()
  /**
   * A method without a yes is a claim about nothing; a yes without a method is
   * evidence nobody can review. The database says the same thing in
   * `chk_crm_call_recording_consent_other_pair`, and it is said here too so the
   * caller gets a 400 naming the field rather than a 23514 naming a constraint.
   */
  .refine(
    (body) => body.counterpartyConsented === (body.counterpartyMethod !== undefined),
    {
      message:
        "Say how the other party consented, and only when they did: counterpartyMethod goes with counterpartyConsented.",
      path: ["counterpartyMethod"],
    },
  );

export type CallRecordingConsentBody = z.infer<typeof callRecordingConsentBodySchema>;

/**
 * The window the refusal ledger covers.
 *
 * Defaulted rather than required, for the same reason the coaching digest's is:
 * somebody opening the page has not chosen a period and a 400 is a worse first
 * impression than a sensible month. Capped at 90 days and 200 rows because this
 * is a list read on an index, and an unbounded one is an unbounded read.
 */
export const consentRefusalQuerySchema = z
  .object({
    sinceDays: z.coerce.number().int().min(1).max(90).default(30),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  })
  .strict();

export type ConsentRefusalQuery = z.infer<typeof consentRefusalQuerySchema>;
