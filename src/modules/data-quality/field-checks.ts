import { normaliseEmail } from "../party/party-duplicates";
import type { FindingSeverity } from "../../db/schema/crm/data-quality";

/**
 * Whether the organisation can actually reach this party.
 *
 * Pure, and separate from the sweep that runs it, because "what counts as an
 * unusable phone number" is a judgement that should be arguable against a test
 * rather than discovered from four hundred rows in somebody's queue.
 *
 * Every problem carries a `groupKey` describing the *shape* of the failure
 * rather than the value, and that is doing real work: an import that dropped the
 * country code produces hundreds of numbers that are all wrong the same way, and
 * grouping by shape is what turns that into one decision instead of four hundred.
 */

export interface ReachabilitySubject {
  readonly email: string | null;
  readonly phone: string | null;
  readonly whatsappPhone: string | null;
}

export interface ReachabilityProblem {
  /** `producer.detail`, the finding's finer label. */
  readonly kind:
    | "reachability.no-channel"
    | "reachability.malformed-email"
    | "reachability.malformed-phone";
  /** The shape of the failure, which is the axis a bulk decision slices on. */
  readonly groupKey: string;
  readonly severity: FindingSeverity;
  /** What is wrong, in the words a person would use. */
  readonly detail: string;
  /** The offending value, for the evidence. Absent when the problem is absence. */
  readonly value?: string;
}

/**
 * Digits only, all of them.
 *
 * `normalisePhone` in `party-duplicates` keeps the last ten so two spellings of
 * one line compare equal — exactly the wrong thing here, where the count of
 * digits is the evidence. Reusing it would report every long number as ten
 * digits and every short one as valid.
 */
function digitsOf(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * E.164 allows fifteen digits, and a subscriber number is not usefully shorter
 * than seven anywhere. Between those two a number may still be wrong, but it is
 * not wrong in a way a syntax check can prove — and a data-quality queue that
 * cries wolf gets ignored, which costs more than the findings it misses.
 */
const MIN_PLAUSIBLE_DIGITS = 7;
const MAX_E164_DIGITS = 15;

function emailFailure(raw: string): { groupKey: string; detail: string } | null {
  const value = normaliseEmail(raw);
  if (value.length === 0) return null;

  if (/\s/.test(raw.trim())) return { groupKey: "whitespace", detail: "contains whitespace" };

  const parts = value.split("@");
  if (parts.length !== 2)
    return {
      groupKey: "at-count",
      detail: parts.length < 2 ? "has no @" : "has more than one @",
    };

  const [local, domain] = parts;
  if (!local || !domain) return { groupKey: "empty-part", detail: "is missing a name or a domain" };
  if (!domain.includes(".")) return { groupKey: "no-domain-dot", detail: "has no domain suffix" };
  if (domain.startsWith(".") || domain.endsWith("."))
    return { groupKey: "domain-dot-edge", detail: "has a domain starting or ending in a dot" };

  return null;
}

function phoneFailure(raw: string): { groupKey: string; detail: string } | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  if (/[a-z]/i.test(trimmed)) return { groupKey: "letters", detail: "contains letters" };

  const digits = digitsOf(trimmed);
  if (digits.length === 0) return { groupKey: "no-digits", detail: "contains no digits" };

  /**
   * The count is in the group key on purpose. An export that lost its country
   * code leaves every affected row short by the same amount, so "412 numbers
   * with 9 digits" is one systematic error a person recognises on sight —
   * whereas "412 malformed numbers" is four hundred separate investigations.
   */
  if (digits.length < MIN_PLAUSIBLE_DIGITS)
    return { groupKey: `${digits.length}-digits`, detail: `has only ${digits.length} digits` };

  if (digits.length > MAX_E164_DIGITS)
    return {
      groupKey: "over-e164",
      detail: `has ${digits.length} digits, more than any dialable number`,
    };

  return null;
}

/**
 * Everything wrong with this party's contact details.
 *
 * Returns an empty array for a reachable party rather than a null or a boolean,
 * so the sweep folds the result the same way whatever it finds.
 */
export function assessReachability(subject: ReachabilitySubject): ReachabilityProblem[] {
  const problems: ReachabilityProblem[] = [];

  const email = subject.email?.trim() ?? "";
  const phone = subject.phone?.trim() ?? "";
  const whatsapp = subject.whatsappPhone?.trim() ?? "";

  /**
   * No channel at all outranks a malformed one, and it is reported alone: a
   * record with nothing to check cannot also have a malformed anything, and
   * saying so twice would double-count it in the health number.
   */
  if (email.length === 0 && phone.length === 0 && whatsapp.length === 0) {
    problems.push({
      kind: "reachability.no-channel",
      groupKey: "reachability:no-channel",
      severity: "high",
      detail: "has no e-mail address and no phone number",
    });
    return problems;
  }

  const emailProblem = email.length > 0 ? emailFailure(email) : null;
  if (emailProblem)
    problems.push({
      kind: "reachability.malformed-email",
      groupKey: `reachability:malformed-email:${emailProblem.groupKey}`,
      severity: "medium",
      detail: `the e-mail address ${emailProblem.detail}`,
      value: email,
    });

  const phoneProblem = phone.length > 0 ? phoneFailure(phone) : null;
  if (phoneProblem)
    problems.push({
      kind: "reachability.malformed-phone",
      groupKey: `reachability:malformed-phone:${phoneProblem.groupKey}`,
      severity: "medium",
      detail: `the phone number ${phoneProblem.detail}`,
      value: phone,
    });

  return problems;
}
