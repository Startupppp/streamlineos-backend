import { remindableRecipients } from "../sign-envelope-sweeps.service";

/**
 * SIGN-P1-01. The predicate the reminder sweep and its dry run share.
 *
 * It is a free function rather than a private method for exactly one reason:
 * a preview that reimplements this filter would report a count the real sweep
 * does not produce, and the whole value of a dry run in staging is that the
 * number it gives you is the number you will get. Sharing it is the guarantee;
 * this file is what keeps the shared thing correct.
 */

const recipient = (over: Partial<{
  recipientType: string;
  status: string;
  email: string | null;
  tokenExpiresAt: Date | null;
}> = {}) => ({
  recipientType: "signer",
  status: "invited",
  email: "signer@example.test",
  tokenExpiresAt: new Date("2030-01-01T00:00:00Z"),
  ...over,
});

describe("remindableRecipients", () => {
  it("reminds signers who have been invited, viewed, or authenticated", () => {
    const rows = [
      recipient({ status: "invited" }),
      recipient({ status: "viewed" }),
      recipient({ status: "authenticated" }),
    ];
    expect(remindableRecipients(rows)).toHaveLength(3);
  });

  it("does not chase someone who is already done with it", () => {
    for (const status of ["completed", "declined", "delegated", "expired", "pending"]) {
      expect(remindableRecipients([recipient({ status })])).toHaveLength(0);
    }
  });

  it("reminds every recipient type that has something to sign", () => {
    /**
     * Signers are not the only ones holding the envelope up. An approver or an
     * internal reviewer blocks completion just as effectively, and
     * `isSigningType` counts an in-person host too — the list is asserted here
     * so shrinking it silently stops reminding somebody.
     */
    for (const recipientType of ["signer", "approver", "in_person_host", "internal_reviewer"]) {
      expect(remindableRecipients([recipient({ recipientType })])).toHaveLength(1);
    }
  });

  it("skips recipients with nothing to sign", () => {
    /** A cc or a certified-delivery recipient is not waited on, so not chased. */
    for (const recipientType of ["cc", "certified_delivery", "witness"]) {
      expect(remindableRecipients([recipient({ recipientType })])).toHaveLength(0);
    }
  });

  it("skips a recipient with nowhere to send to", () => {
    expect(remindableRecipients([recipient({ email: null })])).toHaveLength(0);
    expect(remindableRecipients([recipient({ email: "" })])).toHaveLength(0);
  });

  it("skips a recipient who was never issued a token", () => {
    /**
     * No `signing_token_hash` means no signing link was ever minted for them.
     * Reminding them would mail a link to a session that does not exist.
     */
    expect(remindableRecipients([recipient({ tokenExpiresAt: null })])).toHaveLength(0);
  });

  it("narrows the type, so callers cannot mail a null address", () => {
    const [first] = remindableRecipients([recipient()]);
    /** Compile-time: `email` is `string` here, not `string | null`. */
    const address: string = first!.email;
    expect(address).toBe("signer@example.test");
  });
});
