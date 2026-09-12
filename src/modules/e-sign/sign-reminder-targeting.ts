import { isSigningType } from "./sign-envelope-validation.service";

/**
 * Which of an envelope's recipients a reminder would go to.
 *
 * Shared by the sweep and its preview for the same reason the interval rule is:
 * the count a dry run reports has to be the count the real run produces, and
 * two copies of a filter are how those quietly diverge. A recipient with no
 * email or no issued token is skipped rather than failed — there is nothing to
 * remind them at. Issuance is read from `tokenExpiresAt`, which `send` and the
 * auto-advance stamp beside the token; the token's digest itself never leaves
 * the public authentication path.
 */
export function remindableRecipients<
  T extends {
    recipientType: string;
    status: string;
    email: string | null;
    tokenExpiresAt: Date | null;
  },
>(recipients: T[]): Array<T & { email: string; tokenExpiresAt: Date }> {
  return recipients.filter(
    (r): r is T & { email: string; tokenExpiresAt: Date } =>
      isSigningType(r.recipientType) &&
      (r.status === "invited" || r.status === "viewed" || r.status === "authenticated") &&
      r.email !== null &&
      r.email !== "" &&
      r.tokenExpiresAt !== null,
  );
}

export interface RemindableRecipient {
  readonly id: number;
  readonly name: string;
  readonly email: string;
}
