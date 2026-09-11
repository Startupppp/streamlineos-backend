import { isSigningType } from "../sign-envelope-validation.service";
import { remindableRecipients } from "../sign-envelope-sweeps.service";

/**
 * SIGN-P2-01. `in_person_host` is a label, and this pins the three facts that
 * make it safe to be only that.
 *
 * The dropdown offered an in-person ceremony the product does not have. There
 * is no host-led session route anywhere in the module — the only way to reach a
 * signing session is a token in an email — yet `in_person_host` counts as a
 * signing type, so the envelope waits for it before it can complete, and the
 * dispatch loop invites only recipients that have an email
 * (`shouldInviteNow && plan.email`).
 *
 * Those three together strand the envelope. It does not fail; it never
 * finishes, and nothing reports why. Requiring an email closes it: a host is
 * then an ordinary signing recipient wearing a label, and gets a link like
 * everyone else.
 *
 * The alternative — dropping it from the signing types — is worse. It would
 * let an envelope complete without the person the sender named as a signatory.
 */

describe("in-person host is a label on an ordinary signing recipient", () => {
  it("still counts as a signing recipient", () => {
    /**
     * Load-bearing: the envelope must wait for them. If this ever becomes
     * false, an envelope completes without a party the sender required.
     */
    expect(isSigningType("in_person_host")).toBe(true);
  });

  it("is reminded like any other signer once it has an email", () => {
    const host = {
      recipientType: "in_person_host",
      status: "invited",
      email: "host@example.test",
      signingTokenHash: "hash",
    };
    expect(remindableRecipients([host])).toHaveLength(1);
  });

  it("is skipped by reminders when it has no email, which is the stranded state", () => {
    /**
     * Documents the shape of the bug rather than the fix: rows created before
     * the email requirement still exist, and this is why they go quiet — no
     * invitation, no reminder, and an envelope that waits on them forever.
     * Validation now refuses to send such an envelope, naming the recipient.
     */
    const legacyHost = {
      recipientType: "in_person_host",
      status: "invited",
      email: null,
      signingTokenHash: "hash",
    };
    expect(remindableRecipients([legacyHost])).toHaveLength(0);
  });
});
