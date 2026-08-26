import { resolvePush, type PushMailboxRow } from "./mailbox-push-route";
import { signPayload } from "./mailbox-push";

/**
 * What an unauthenticated push endpoint is allowed to conclude.
 *
 * `mailbox-push.ts` verifies a signature against a secret it is handed. This
 * decides *which* secret — and that ordering is the whole security argument:
 * the mailbox row is found first, its own secret verifies the body, and the
 * tenant comes from the row rather than from anything the caller sent.
 *
 * The notification is a doorbell, not a delivery. Gmail and Graph both say
 * "something changed for this mailbox" and nothing more, so trusting the body
 * for content would let anyone who guessed an address write into a customer's
 * timeline.
 */
describe("resolvePush", () => {
  const SECRET = "mailbox-secret";
  const row: PushMailboxRow = {
    crmMailboxSyncId: "sync-1",
    organizationId: "org-1",
    provider: "gmail",
    mailboxAddress: "rep@acme.com",
    pushSecret: SECRET,
    enabled: true,
  };

  const body = JSON.stringify({ resource: "rep@acme.com", provider: "gmail" });

  it("accepts a correctly signed notification and names the mailbox to sweep", () => {
    const verdict = resolvePush(body, signPayload(SECRET, body), row);

    expect(verdict).toEqual({
      ok: true,
      organizationId: "org-1",
      crmMailboxSyncId: "sync-1",
    });
  });

  /**
   * The tenant is never taken from the body. A caller who signs correctly for
   * their own mailbox must not be able to name somebody else's organisation.
   */
  it("ignores an organisation named in the body", () => {
    const hostile = JSON.stringify({
      resource: "rep@acme.com",
      provider: "gmail",
      organizationId: "org-someone-else",
    });

    const verdict = resolvePush(hostile, signPayload(SECRET, hostile), row);

    expect(verdict).toMatchObject({ ok: true, organizationId: "org-1" });
  });

  it("refuses a body signed with the wrong secret", () => {
    expect(resolvePush(body, signPayload("not-the-secret", body), row)).toEqual({ ok: false });
  });

  /**
   * A mailbox that never registered a push subscription has no secret. It must
   * not become the one mailbox anybody can ring.
   */
  it("refuses a mailbox that has no secret", () => {
    const unregistered = { ...row, pushSecret: null };

    expect(resolvePush(body, signPayload(SECRET, body), unregistered)).toEqual({ ok: false });
  });

  it("refuses when no mailbox matched", () => {
    expect(resolvePush(body, signPayload(SECRET, body), null)).toEqual({ ok: false });
  });

  /**
   * Every refusal is the same refusal. Distinguishing "wrong signature" from
   * "no such mailbox" turns the endpoint into an oracle for which addresses
   * this deployment syncs.
   */
  it("says the same thing however it refuses", () => {
    const wrongSecret = resolvePush(body, signPayload("wrong", body), row);
    const noMailbox = resolvePush(body, signPayload(SECRET, body), null);
    const noSecret = resolvePush(body, signPayload(SECRET, body), { ...row, pushSecret: null });

    expect(wrongSecret).toEqual(noMailbox);
    expect(noMailbox).toEqual(noSecret);
  });

  it("refuses a disabled mailbox", () => {
    expect(resolvePush(body, signPayload(SECRET, body), { ...row, enabled: false })).toEqual({
      ok: false,
    });
  });
});
