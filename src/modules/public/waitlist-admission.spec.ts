import { mayAdmit, mayClaim } from "./waitlist-admission";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-08-26T12:00:00.000Z");

describe("mayAdmit", () => {
  it("admits somebody who is waiting", () => {
    expect(mayAdmit({ status: "PENDING", claimedAt: null })).toEqual({ ok: true });
  });

  /**
   * How somebody who lost the email gets another one.
   *
   * Refusing this would make a lost invitation recoverable only by editing the
   * database, which is not a support process anybody should have.
   */
  it("re-admits an entry that was invited but never claimed", () => {
    expect(mayAdmit({ status: "INVITED", claimedAt: null })).toEqual({ ok: true });
  });

  /**
   * The one that must not be a resend.
   *
   * Minting a second token for somebody who already has an organisation creates
   * a *second* organisation, and the support conversation that follows is about
   * which of the two holds their data.
   */
  it("refuses an entry that already became an organisation", () => {
    expect(mayAdmit({ status: "INVITED", claimedAt: NOW }).ok).toBe(false);
    expect(mayAdmit({ status: "CLAIMED", claimedAt: null }).ok).toBe(false);
  });

  it("refuses a declined entry rather than quietly reversing the decision", () => {
    const check = mayAdmit({ status: "DECLINED", claimedAt: null });

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/re-open/i);
  });
});

describe("mayClaim", () => {
  const valid = {
    status: "INVITED",
    claimedAt: null,
    tokenExpiresAt: new Date(NOW.getTime() + HOUR),
  };

  it("lets a live invitation through", () => {
    expect(mayClaim(valid, NOW)).toEqual({ ok: true });
  });

  it("refuses a token that was already spent", () => {
    expect(mayClaim({ ...valid, claimedAt: NOW }, NOW).ok).toBe(false);
  });

  it("refuses a token past its expiry", () => {
    expect(
      mayClaim({ ...valid, tokenExpiresAt: new Date(NOW.getTime() - 1) }, NOW).ok,
    ).toBe(false);
  });

  it("refuses at the moment of expiry, not a millisecond after", () => {
    expect(mayClaim({ ...valid, tokenExpiresAt: NOW }, NOW).ok).toBe(false);
  });

  /**
   * A token with no expiry is a permanent key for creating organisations.
   *
   * Rows can reach INVITED by hand or from before this column existed, and the
   * safe reading of a missing expiry is refusal rather than "never expires".
   */
  it("refuses an invitation with no expiry at all", () => {
    expect(mayClaim({ ...valid, tokenExpiresAt: null }, NOW).ok).toBe(false);
  });

  it("refuses an entry that is not in the invited state", () => {
    expect(mayClaim({ ...valid, status: "PENDING" }, NOW).ok).toBe(false);
    expect(mayClaim({ ...valid, status: "DECLINED" }, NOW).ok).toBe(false);
  });

  /**
   * Order matters for the message, not just the verdict.
   *
   * Somebody clicking an old email twice needs "already used"; telling them it
   * expired sends them to ask for a replacement they do not need.
   */
  it("says already-used rather than expired when both are true", () => {
    const check = mayClaim(
      { status: "INVITED", claimedAt: NOW, tokenExpiresAt: new Date(NOW.getTime() - HOUR) },
      NOW,
    );

    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/already been used/i);
  });
});
