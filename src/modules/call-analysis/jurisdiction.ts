/**
 * Where a call took place, and what that place requires before anybody may
 * record or read it.
 *
 * Ticket 03. Everything in this file is a constant, and that is the ticket's
 * fourth criterion rather than a stylistic preference: a two-party-consent
 * jurisdiction is a legal constraint, not a dial. There is no tenant column
 * behind any of it, no column on `crm_call_analyses` that could hold an
 * override, and no endpoint that reaches it — `jurisdiction-is-not-a-setting.spec.ts`
 * pins all three. The way a rule like this dies is that somebody adds an
 * exception "just for one customer", and the next person reads the exception as
 * the rule.
 *
 * The whole design is one decision repeated: **an undetermined jurisdiction
 * resolves to the stricter regime, never the looser one.** A number we cannot
 * place, a country we have no entry for, an organisation whose country nobody
 * filled in — each
 * lands on `all-party`, which means the call is not analysed unless somebody
 * actually recorded consent. That is what makes an incomplete table below safe
 * rather than dangerous, and it is why adding a country to it can only ever
 * loosen the rule and therefore has to be argued for.
 */

/** What the jurisdiction requires before a call may be recorded and read. */
export type ConsentRegime = "all-party" | "one-party";

/** How firmly we know where the call happened. Recorded on every analysis. */
export type JurisdictionBasis =
  /** The counterparty's own number placed them. The strongest claim available. */
  | "counterparty-number"
  /** Nothing placed the counterparty, so the organisation's country stood in. */
  | "organisation-country"
  /** Neither. The regime is `all-party` and this is why. */
  | "undetermined";

/** What is recorded when nothing placed the call. Never an empty string. */
export const UNDETERMINED_JURISDICTION = "UNDETERMINED";

/**
 * The jurisdictions that require every party's consent.
 *
 * Codes are ISO 3166-1 alpha-2 with two deliberate exceptions, both of which are
 * the fail-closed rule showing through:
 *
 * `NANP` is the North American Numbering Plan — `+1`, which is the United
 * States, Canada and twenty Caribbean territories sharing one calling code. A
 * `+1` number cannot be resolved further without an area-code table, and the
 * plan contains the United States, so `+1` is all-party.
 *
 * `US` is here for the same reason one step down. Federal law is one-party, but
 * California, Florida, Illinois, Maryland, Massachusetts, Michigan, Montana,
 * Nevada, New Hampshire, Oregon, Pennsylvania and Washington are not, and a
 * country-level determination cannot tell which state a call reached. Resolving
 * a US call to its state would *loosen* the rule for most of them, so it is
 * deliberately not attempted here: it is a change that needs the data to do it
 * correctly, and doing it approximately means recording somebody in Sacramento
 * on the strength of an area code they ported from Nevada. `AU` is the same
 * argument — its states disagree with each other in the same way.
 *
 * The European entries are the general position across the EEA that recording a
 * private conversation requires the agreement of those in it. This list is a
 * legal-review artefact rather than a developer's reading, and the fail-closed
 * default above is what makes it survive being out of date.
 */
export const ALL_PARTY_CONSENT_JURISDICTIONS = [
  "NANP",
  "US",
  "AU",
  "AT",
  "BE",
  "CH",
  "CZ",
  "DE",
  "DK",
  "ES",
  "FI",
  "FR",
  "GR",
  "HU",
  "IE",
  "IT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  UNDETERMINED_JURISDICTION,
] as const;

/**
 * Calling code to jurisdiction, longest prefix first.
 *
 * Sorted at module load rather than by hand, because a hand-sorted table stays
 * sorted exactly until the next person appends to the bottom of it — and the
 * failure that produces is silent: `+351` matching `+3` would place every
 * Portuguese call in a country that does not exist.
 */
const CALLING_CODES: readonly (readonly [prefix: string, jurisdiction: string])[] = [
  ["+1", "NANP"],
  ["+7", "RU"],
  ["+27", "ZA"],
  ["+30", "GR"],
  ["+31", "NL"],
  ["+32", "BE"],
  ["+33", "FR"],
  ["+34", "ES"],
  ["+36", "HU"],
  ["+39", "IT"],
  ["+40", "RO"],
  ["+41", "CH"],
  ["+43", "AT"],
  ["+44", "GB"],
  ["+45", "DK"],
  ["+46", "SE"],
  ["+47", "NO"],
  ["+48", "PL"],
  ["+49", "DE"],
  ["+52", "MX"],
  ["+55", "BR"],
  ["+61", "AU"],
  ["+64", "NZ"],
  ["+65", "SG"],
  ["+81", "JP"],
  ["+86", "CN"],
  ["+91", "IN"],
  ["+351", "PT"],
  ["+353", "IE"],
  ["+358", "FI"],
  ["+420", "CZ"],
  ["+971", "AE"],
];

const BY_LONGEST_PREFIX = [...CALLING_CODES].sort((a, b) => b[0].length - a[0].length);

const ALL_PARTY = new Set<string>(ALL_PARTY_CONSENT_JURISDICTIONS);

/**
 * What a jurisdiction requires.
 *
 * Anything not in the table above is `one-party`, which looks like the wrong
 * default until you read `determineJurisdiction`: a jurisdiction only ever
 * reaches this function once something has actually placed the call, and
 * everything that failed to place it arrives as `UNDETERMINED_JURISDICTION`,
 * which is in the set.
 */
export function regimeFor(jurisdiction: string): ConsentRegime {
  return ALL_PARTY.has(jurisdiction) ? "all-party" : "one-party";
}

export interface CallLocationFacts {
  /**
   * The other side's number, as the carrier gave it.
   *
   * `normaliseNumber` in the telephony adapter has already stripped formatting
   * by the time this is read, so a number that still has no `+` genuinely
   * arrived without a country code — and the adapter refuses to add one, for
   * the reason it states: `4155551212` is American or it is a local number in a
   * dozen other places, and choosing costs somebody their privacy rather than a
   * duplicate record.
   */
  readonly counterpartyNumber: string | null;
  /**
   * `organizations.country`, which is free text a human typed on a settings
   * page and is very often "India" rather than "IN".
   *
   * Only a two-letter alpha code is accepted as a jurisdiction — see
   * `jurisdictionOfCountry`. Accepting anything else would defeat the entire
   * design of this file: "India" is not in the all-party set, so it would
   * resolve to `one-party`, and every organisation with a spelled-out country
   * would silently get the *looser* rule. An unrecognised country has to fail
   * the way a missing one does.
   */
  readonly organisationCountry: string | null;
}

export interface JurisdictionDetermination {
  readonly jurisdiction: string;
  readonly basis: JurisdictionBasis;
  readonly regime: ConsentRegime;
}

/**
 * Where the call happened, and how confident that answer is.
 *
 * The counterparty's number comes first because the constraint belongs to the
 * person being recorded rather than to the company doing the recording: a
 * Berlin customer rung by a London office is a German call, and reading it the
 * other way round is precisely the mistake the ticket exists to prevent.
 *
 * The organisation's country stands in only when there was no number at all.
 *
 * The distinction is between a determination that failed and one that was never
 * attempted, and it matters because falling back is always the looser answer. A
 * number that arrived without a country code IS evidence about where the
 * customer was — evidence we cannot read — and overwriting it with the office's
 * country converts "we do not know where they were" into "they were where we
 * are", which is the one inference that is wrong in exactly the cases that
 * matter. A call with no counterparty number at all was never a determination in
 * the first place, and the organisation's own country is then the only thing
 * there is; it is recorded as the weaker basis so that the difference survives.
 */
export function determineJurisdiction(facts: CallLocationFacts): JurisdictionDetermination {
  const number = facts.counterpartyNumber?.trim();
  if (number) {
    const fromNumber = jurisdictionOfNumber(number);
    return fromNumber
      ? { jurisdiction: fromNumber, basis: "counterparty-number", regime: regimeFor(fromNumber) }
      : {
          jurisdiction: UNDETERMINED_JURISDICTION,
          basis: "undetermined",
          regime: regimeFor(UNDETERMINED_JURISDICTION),
        };
  }

  const country = jurisdictionOfCountry(facts.organisationCountry);
  if (country)
    return { jurisdiction: country, basis: "organisation-country", regime: regimeFor(country) };

  return {
    jurisdiction: UNDETERMINED_JURISDICTION,
    basis: "undetermined",
    regime: regimeFor(UNDETERMINED_JURISDICTION),
  };
}

/** The jurisdiction an E.164 number belongs to, or null if it is not E.164. */
export function jurisdictionOfNumber(raw: string | null): string | null {
  const number = raw?.trim();
  if (!number || !number.startsWith("+")) return null;

  const match = BY_LONGEST_PREFIX.find(([prefix]) => number.startsWith(prefix));
  return match ? match[1] : null;
}

/** A stored country, if and only if it is already an alpha-2 code. */
export function jurisdictionOfCountry(raw: string | null): string | null {
  const country = raw?.trim().toUpperCase();
  return country && /^[A-Z]{2}$/.test(country) ? country : null;
}
