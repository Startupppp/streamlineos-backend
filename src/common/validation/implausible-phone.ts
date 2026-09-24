/**
 * Numbers that are structurally valid and obviously not anybody's.
 *
 * `9999999999` passes every shape check an Indian mobile has: ten digits,
 * leading 6–9, correct length for the +91 plan. A library that checks the
 * numbering plan says yes, and QA typed exactly that into org setup and was let
 * through. Nothing downstream ever calls the number, so the organisation carries
 * a contact that cannot be reached and nobody finds out until someone tries.
 *
 * This is not verification — only an OTP is verification, and the product does
 * not send one here. It is the cheap half: refusing the placeholder people type
 * when a form demands a number they do not want to give.
 *
 * Deliberately narrow. A run like 9876543210 is just as obviously a placeholder,
 * and it was rejected here for a while — but it is also a number the numbering
 * plan can allocate, and the cost of being wrong is turning a real customer away
 * at signup. One digit repeated ten times cannot be anybody's, so that is where
 * the line sits.
 */

/** Ten of the same digit: 0000000000, 9999999999. */
const REPEATED_DIGIT = /^(\d)\1+$/;

/** The national part of a number, with punctuation and any +91 prefix removed. */
export function nationalDigitsOf(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

export const IMPLAUSIBLE_PHONE_MESSAGE =
  "That looks like a placeholder rather than a real number. Enter a number someone answers, or leave it blank.";

/** True when the number is a placeholder a person typed to get past a form. */
export function isImplausiblePhone(value: string | null | undefined): boolean {
  if (!value) return false;
  const digits = nationalDigitsOf(value);
  if (digits.length < 6) return false;
  return REPEATED_DIGIT.test(digits);
}
