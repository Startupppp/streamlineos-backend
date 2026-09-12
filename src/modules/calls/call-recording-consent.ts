/**
 * Whether a call may be analysed at all, decided by where it happened.
 *
 * In a two-party (all-party) consent jurisdiction, recording a conversation
 * without every participant's agreement is a criminal offence, and analysing a
 * recording that should never have existed compounds it. That is a legal
 * constraint on the product, not a preference a tenant expresses. So there is no
 * tenant column behind anything in this file, no field on any settings schema
 * that reaches it, and no argument to `callRecordingConsentVerdict` that a
 * request body could reach — the same shape `send-guardrails.ts` uses and for
 * the same reason, pinned by `consent-is-not-a-setting.spec.ts`. The way a rule
 * like this dies is that somebody adds an override "just for one customer" and
 * the next reader takes the override for the rule.
 *
 * The rule, in one sentence: everywhere is all-party until this file says
 * otherwise, and a call under an all-party regime is analysed only when there is
 * evidence — recorded before the call, and still standing now — that both sides
 * agreed.
 *
 * FAILING CLOSED IS THE DESIGN, not a conservative default that can be relaxed
 * later. A register of two-party places, consulted with "not listed means fine",
 * makes every omission a silent compliance hole: a jurisdiction nobody has
 * researched reads identically to one somebody has cleared. Inverting it makes
 * an omission a refusal, which is visible, appears in the ledger, and gets
 * fixed. `jurisdiction-unrecorded` exists for exactly the case where nobody said
 * where the call happened; it refuses rather than guessing from an area code.
 *
 * WHAT THIS FILE IS NOT. `CONSENT_REGIME_REGISTER` is a legal register, not a
 * derivation. Each entry carries the instrument it was entered under so that a
 * lawyer reviewing a diff can check the entry rather than the code. Nothing here
 * infers a regime from a country's neighbours, its trading bloc, or anything
 * else — an inferred regime is a legal opinion the code is not entitled to hold.
 * Adding a jurisdiction is a code change under review, which is the point:
 * relaxing the rule for a market has to be somebody's signed decision, and a
 * decision that has to be committed is a decision that can be found later.
 */

/**
 * Bumped when the meaning of a verdict changes, never for a register edit.
 *
 * It is stored on every refusal, so a ledger row says which rule refused. A
 * register edit is deliberately NOT a bump: adding a jurisdiction changes which
 * calls are refused, not what "refused" meant, and bumping on every edit would
 * make the ledger's unique key churn and lose the attempt counts.
 */
export const RECORDING_CONSENT_RULE_VERSION = 1;

/** Who has to agree before a conversation may be recorded and analysed. */
export type ConsentRegime = "one-party" | "two-party";

/** How a party's agreement was obtained. Recorded, never inferred. */
export const CONSENT_METHODS = [
  /** A standing opt-in on the contact's PHONE channel, in `crm_contact_channel_consent`. */
  "standing-consent",
  /** The recording notice was played and the party said yes, on the call itself. */
  "announced-and-acknowledged",
  /** A signed clause — an MSA, an order form, a recorded-calls addendum. */
  "written-agreement",
  /** The party is the organisation's own employee, and recording is their own act. */
  "own-recording",
] as const;
export type ConsentMethod = (typeof CONSENT_METHODS)[number];

interface RegimeEntry {
  readonly regime: ConsentRegime;
  /**
   * The instrument the entry was made under. Present so that reviewing this
   * register is reading citations rather than trusting a previous author, and
   * so a stale entry can be traced to something that can be re-checked.
   */
  readonly basis: string;
}

/**
 * The register. Absent means all-party — see the header.
 *
 * `US` is deliberately NOT an entry, and that absence is load-bearing enough
 * that `call-recording-consent.spec.ts` asserts it. Federal law is one-party,
 * but recording law in the United States is decided state by state and several
 * states are stricter; a country-level `US: one-party` entry would resolve
 * `US-CA` through the fallback below and clear California, which is the single
 * most-litigated all-party jurisdiction there is. A federation gets subdivision
 * entries or it gets nothing.
 *
 * The two-party entries below are redundant against the default and are here on
 * purpose: they are the ones somebody has actually checked, so a later author
 * can tell "researched and strict" from "never looked at", which the default
 * alone cannot express.
 */
export const CONSENT_REGIME_REGISTER: Readonly<Record<string, RegimeEntry>> = {
  // Checked and strict. Redundant against the default; see above.
  "US-CA": { regime: "two-party", basis: "Cal. Penal Code s 632" },
  "US-FL": { regime: "two-party", basis: "Fla. Stat. s 934.03" },
  "US-IL": { regime: "two-party", basis: "720 ILCS 5/14-2" },
  "US-MD": { regime: "two-party", basis: "Md. Cts & Jud Proc s 10-402" },
  "US-MA": { regime: "two-party", basis: "Mass. Gen. Laws ch. 272 s 99" },
  "US-PA": { regime: "two-party", basis: "18 Pa. C.S. s 5704" },
  "US-WA": { regime: "two-party", basis: "Wash. Rev. Code s 9.73.030" },

  // Checked and one-party. Each of these is a decision to analyse calls that
  // only one side agreed to record, so each needed its own citation.
  "US-NY": { regime: "one-party", basis: "N.Y. Penal Law s 250.00(2)" },
  "US-TX": { regime: "one-party", basis: "Tex. Penal Code s 16.02(c)(4)" },
  "US-NJ": { regime: "one-party", basis: "N.J. Stat. s 2A:156A-4(d)" },
  "US-GA": { regime: "one-party", basis: "O.C.G.A. s 16-11-66(a)" },
  "US-OH": { regime: "one-party", basis: "Ohio Rev. Code s 2933.52(B)(4)" },
  "US-CO": { regime: "one-party", basis: "Colo. Rev. Stat. s 18-9-303(1)" },
  CA: { regime: "one-party", basis: "Criminal Code (Canada) s 184(2)(a)" },
  IN: { regime: "one-party", basis: "Indian Telegraph Act 1885 s 5; IT Act 2000 s 69" },
};

/**
 * The facts the rule reads. A snapshot of the world, never a policy.
 *
 * Two clocks, and the pair is the substance of the rule rather than an
 * over-specification. `occurredAt` is when the conversation happened and is the
 * moment agreement had to already exist: consent captured on Tuesday cannot
 * authorise Monday's recording, and a system that accepted it would let anybody
 * legalise a recording after the fact by opening the contact and ticking a box.
 * `now` is when the analysis is being asked for, and is the moment a withdrawal
 * bites: a recording that was lawful when made must not keep being processed by
 * a model after the person has told us to stop.
 */
export interface CallConsentFacts {
  readonly now: Date;
  readonly occurredAt: Date;

  /**
   * Normalised by `normaliseJurisdiction`. Null when nobody recorded where the
   * call took place — which refuses, rather than being guessed at from a phone
   * number's country code. An area code is where a number was issued, not where
   * its holder was sitting.
   */
  readonly jurisdiction: string | null;

  /**
   * The organisation's side. One piece of evidence, because there is only one
   * place it can come from: the attestation somebody signed against this call.
   */
  readonly orgParty: PartyConsentEvidence | null;

  /** The customer's side, taken together — one refusal covers all of them. */
  readonly counterparty: CounterpartyConsent;
}

/**
 * The customer's side, which can be evidenced more than one way.
 *
 * A list rather than one record, because two independent stores can each answer
 * "did they agree": a standing PHONE opt-in in `crm_contact_channel_consent`,
 * and a per-call attestation that the recording notice was acknowledged.
 * Collapsing them in the caller would put a piece of the rule — which evidence
 * wins — outside this file, which is precisely the drift the file exists to
 * prevent. The fold is here: any one piece in force at the call is enough.
 *
 * `withdrawn` is a veto beside the list rather than a field on each entry. A
 * withdrawal is about the person, not about a particular piece of paper, and
 * one that only invalidated the evidence it happened to be attached to would let
 * a stale attestation outvote somebody's opt-out.
 */
export interface CounterpartyConsent {
  /**
   * When they told us to stop, if they have. A timestamp rather than a boolean
   * so the rule owns the comparison against `now`: a caller that reduced this to
   * a boolean would be deciding, in its own copy of the clock, when a
   * withdrawal starts to bite.
   */
  readonly withdrawnAt: Date | null;
  readonly evidence: readonly PartyConsentEvidence[];
}

/** One recorded agreement. */
export interface PartyConsentEvidence {
  /** When that side agreed. */
  readonly consentedAt: Date;
  readonly method: ConsentMethod;
  /** A time-boxed agreement. Null is open-ended, not "already expired". */
  readonly expiresAt: Date | null;
}

export type CallConsentRefusal =
  | "jurisdiction-unrecorded"
  | "org-consent-missing"
  | "counterparty-consent-missing"
  | "counterparty-consent-withdrawn"
  | "counterparty-consent-expired"
  | "counterparty-consent-after-the-call";

export type CallConsentVerdict =
  | {
      readonly allowed: true;
      readonly regime: ConsentRegime;
      readonly jurisdiction: string | null;
      readonly ruleVersion: number;
    }
  | {
      /**
       * `regime` is the literal `"two-party"` rather than the union, and that is
       * a statement in the type system: nothing under a one-party regime is ever
       * refused by this rule. A future author who wants to refuse a one-party
       * call has to change the type, which makes them notice they are changing
       * what this file is.
       */
      readonly allowed: false;
      readonly regime: "two-party";
      readonly jurisdiction: string | null;
      readonly reason: CallConsentRefusal;
      readonly note: string;
      readonly ruleVersion: number;
    };

const JURISDICTION_PATTERN = /^[A-Z]{2}(-[A-Z0-9]{1,3})?$/;

/**
 * A jurisdiction code, or null if it is not one.
 *
 * Uppercased and trimmed rather than rejected on case, because the value comes
 * from a human typing into a form and `us-ca` is not a different place from
 * `US-CA`. Everything past that is rejected: a free-text "California" would be
 * stored, would match no register entry, and would resolve to all-party — the
 * right answer arrived at by accident, which stops being the right answer the
 * day somebody adds a case-insensitive lookup.
 */
export function normaliseJurisdiction(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const upper = raw.trim().toUpperCase();
  return JURISDICTION_PATTERN.test(upper) ? upper : null;
}

/**
 * The regime for a jurisdiction. Most specific entry wins, then the country,
 * then all-party.
 *
 * The country fallback is what lets `CA` cover every Canadian province without
 * thirteen entries. It is also why `US` must never be an entry — see the
 * register's docblock.
 */
export function consentRegime(jurisdiction: string | null): ConsentRegime {
  if (jurisdiction === null) return "two-party";

  const exact = CONSENT_REGIME_REGISTER[jurisdiction];
  if (exact) return exact.regime;

  const country = jurisdiction.split("-")[0];
  if (country !== undefined && country !== jurisdiction) {
    const parent = CONSENT_REGIME_REGISTER[country];
    if (parent) return parent.regime;
  }

  return "two-party";
}

/** The citation behind a regime, for a compliance reviewer. Null when it defaulted. */
export function consentRegimeBasis(jurisdiction: string | null): string | null {
  if (jurisdiction === null) return null;
  const exact = CONSENT_REGIME_REGISTER[jurisdiction];
  if (exact) return exact.basis;
  const country = jurisdiction.split("-")[0];
  if (country !== undefined && country !== jurisdiction) {
    return CONSENT_REGIME_REGISTER[country]?.basis ?? null;
  }
  return null;
}

/**
 * May this call be analysed and its transcript kept as an analysis?
 *
 * One argument, and it is a snapshot of the world rather than a policy — the
 * property `consent-is-not-a-setting.spec.ts` asserts by arity. Every threshold
 * this function applies is a constant in this file.
 */
export function callRecordingConsentVerdict(facts: CallConsentFacts): CallConsentVerdict {
  const jurisdiction = facts.jurisdiction;
  const regime = consentRegime(jurisdiction);

  if (regime === "one-party") {
    return { allowed: true, regime, jurisdiction, ruleVersion: RECORDING_CONSENT_RULE_VERSION };
  }

  const refuse = (reason: CallConsentRefusal, note: string): CallConsentVerdict => ({
    allowed: false,
    regime: "two-party",
    jurisdiction,
    reason,
    note,
    ruleVersion: RECORDING_CONSENT_RULE_VERSION,
  });

  /**
   * Checked before the party evidence, so the ledger distinguishes "we do not
   * know where this happened" from "we know, and somebody did not agree". They
   * need different fixes: the first is a data-entry gap the team can close for
   * every call at once, the second is a conversation with a customer.
   */
  if (jurisdiction === null) {
    return refuse(
      "jurisdiction-unrecorded",
      "Nobody recorded where this call took place. Every jurisdiction is treated as all-party consent until it is named, so this call was not analysed.",
    );
  }

  /**
   * The organisation's own side, and it is not a formality. An adapter-delivered
   * call with nobody attributed has no identified participant on our side who
   * could have agreed to be recorded — and our rep is a party to the
   * conversation exactly as the customer is. Consenting on their behalf because
   * they are an employee is the assumption an all-party jurisdiction exists to
   * refuse.
   *
   * Note this is the opposite reading from `call-analysis-visibility.ts`, where
   * an unattributed call is *visible* because there is no named person to
   * protect. The two are consistent: visibility protects a person, so no person
   * means nothing to protect; consent is an act by a person, so no person means
   * no act. The same fact, read for two different questions.
   */
  if (facts.orgParty === null || !inForceAt(facts.orgParty, facts.occurredAt)) {
    return refuse(
      "org-consent-missing",
      "Nobody on this organisation's side is recorded as having agreed to this call being recorded. An unattributed call has no participant who could have agreed.",
    );
  }

  const other = facts.counterparty;

  /**
   * Withdrawal first, and it is judged at `now` rather than at the call — the
   * opposite of everything below it. A recording that was lawful when it was
   * made does not stay lawful to keep feeding to a model after the person has
   * told us to stop; that is the difference between the lawfulness of the
   * recording and the lawfulness of the processing, and only the second one is
   * still happening.
   */
  if (other.withdrawnAt !== null && other.withdrawnAt.getTime() <= facts.now.getTime()) {
    return refuse(
      "counterparty-consent-withdrawn",
      "The other party has withdrawn consent. A recording that was lawful when it was made is not lawful to keep feeding to a model afterwards.",
    );
  }

  if (other.evidence.length === 0) {
    return refuse(
      "counterparty-consent-missing",
      "There is no evidence the other party agreed to this call being recorded, and this is an all-party consent jurisdiction.",
    );
  }

  if (other.evidence.some((piece) => inForceAt(piece, facts.occurredAt))) {
    return { allowed: true, regime, jurisdiction, ruleVersion: RECORDING_CONSENT_RULE_VERSION };
  }

  /**
   * Evidence exists and none of it covers the call. Which of the two ways it
   * failed is worth distinguishing in the ledger: consent dated after the call
   * is somebody having ticked a box to unlock an analysis, and consent that had
   * expired is a renewal nobody chased. Different fixes, different people.
   */
  const allAfterTheCall = other.evidence.every(
    (piece) => piece.consentedAt.getTime() > facts.occurredAt.getTime(),
  );

  return allAfterTheCall
    ? refuse(
        "counterparty-consent-after-the-call",
        "The other party's consent was recorded only after the call took place, so it cannot be consent to this recording.",
      )
    : refuse(
        "counterparty-consent-expired",
        "The other party's consent had already expired when this call took place.",
      );
}

/**
 * Was this piece of evidence covering the conversation at the moment it
 * happened?
 *
 * `occurredAt` on both edges and never `now`. Consent has to predate the
 * conversation, or opening the contact afterwards and ticking "opted in" would
 * retroactively legalise the recording — the single easiest way for this rule to
 * be bypassed by somebody who means well. And expiry is judged at the call for
 * the mirror reason: a time-boxed agreement that has since run out was still in
 * force when the conversation happened, and refusing on that would make an
 * analysis disappear on a date nobody chose. Withdrawal is the one clause that
 * looks at `now`, because it is an act rather than a clock.
 */
function inForceAt(evidence: PartyConsentEvidence, occurredAt: Date): boolean {
  if (evidence.consentedAt.getTime() > occurredAt.getTime()) return false;
  if (evidence.expiresAt !== null && evidence.expiresAt.getTime() <= occurredAt.getTime())
    return false;
  return true;
}

/** A sentence per refusal, for a ledger a compliance officer reads. */
export function consentRefusalSummary(reason: CallConsentRefusal): string {
  const sentences: Record<CallConsentRefusal, string> = {
    "jurisdiction-unrecorded": "Where the call took place was never recorded.",
    "org-consent-missing": "Nobody on our side is recorded as a consenting participant.",
    "counterparty-consent-missing": "The other party never agreed to be recorded.",
    "counterparty-consent-withdrawn": "The other party has since withdrawn consent.",
    "counterparty-consent-expired": "The other party's consent had expired by the time of the call.",
    "counterparty-consent-after-the-call":
      "The other party's consent was recorded only after the call.",
  };
  return sentences[reason];
}
