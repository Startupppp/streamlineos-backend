import { Logger } from "@nestjs/common";
import { RecruitmentOffersService } from "./recruitment-offers.service";
import { RecruitmentOfferAcceptanceService } from "./recruitment-offer-acceptance.service";
import { TenantContextService } from "../../../common/tenant/tenant-context";
import type { AfterCommitHook } from "../../../common/tenant/tenant-context";

/**
 * Accepting an offer fires `handleOfferAccepted`, which creates the employment records the
 * accepted offer turns into. It was a discarded promise nested inside another discarded
 * promise, both with rejection handlers returning undefined, so a handoff that threw left the
 * candidate marked ACCEPTED with no employee record and nothing in any log. Ticket 35 box 5.
 */

const ORG_ID = "org-offers";
const CANDIDATE_ID = 7;
const OFFER_ID = 11;

const EXISTING_OFFER = {
  id: OFFER_ID,
  orgId: ORG_ID,
  candidateId: CANDIDATE_ID,
  offerStatus: "SENT",
  offeredSalary: "100000",
  offeredDesignation: "Engineer",
  joiningDate: "2026-10-01",
  validUntil: "2026-09-20",
  version: 1,
};

function build(handleOfferAccepted: jest.Mock) {
  const db = {
    /**
     * An internal accept now closes the seat in the same transaction, which
     * takes an aggregate-version lookup before the outbox emit.
     */
    execute: jest.fn().mockResolvedValue([{ next: "1" }]),
    query: {
      candidateOffers: { findFirst: jest.fn().mockResolvedValue(EXISTING_OFFER) },
      candidates: {
        findFirst: jest.fn().mockResolvedValue({
          id: CANDIDATE_ID,
          firstName: "Ada",
          lastName: "L",
          email: "ada@example.com",
        }),
      },
      candidateApplications: { findFirst: jest.fn().mockResolvedValue(null) },
    },
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ ...EXISTING_OFFER, offerStatus: "ACCEPTED" }]),
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockImplementation(() =>
        Object.assign(Promise.resolve(undefined), {
          returning: jest.fn().mockResolvedValue([{ id: 1 }]),
        }),
      ),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue([]) }),
          limit: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
  };

  const audit = { log: jest.fn(), logCritical: jest.fn().mockResolvedValue(undefined) };

  /**
   * The REAL acceptance service, with only its leaf collaborators doubled.
   * Constructing a stand-in for it here would let the dispatch this suite exists
   * to check be re-implemented by the test — the failure it was written for was
   * a discarded promise, which a double would happily "succeed" at.
   */
  const acceptance = new RecruitmentOfferAcceptanceService(
    db as never,
    { runAutomationsForEvent: jest.fn().mockResolvedValue(undefined) } as never,
    audit as never,
    { handleOfferAccepted } as never,
    { startForCandidate: jest.fn().mockResolvedValue({ started: true, replay: true }) } as never,
  );

  const service = new RecruitmentOffersService(db as never, audit as never, acceptance);
  return { service };
}

function accept(service: RecruitmentOffersService) {
  return service.updateOffer(ORG_ID, "actor-1", CANDIDATE_ID, OFFER_ID, {
    offerStatus: "ACCEPTED",
  });
}

describe("RecruitmentOffersService offer-accepted handoff", () => {
  it("reports a failed handoff instead of dropping it on the floor", async () => {
    const handoff = jest.fn().mockRejectedValue(new Error("handoff exploded"));
    const { service } = build(handoff);
    const reported = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);

    try {
      await accept(service);
      await new Promise((resolve) => setImmediate(resolve));

      expect(handoff).toHaveBeenCalledWith(ORG_ID, CANDIDATE_ID, OFFER_ID);
      const messages = reported.mock.calls.map((call) => String(call[0]));
      expect(messages.some((m) => m.includes("handoff exploded"))).toBe(true);
      expect(messages.some((m) => m.includes(ORG_ID))).toBe(true);
    } finally {
      reported.mockRestore();
    }
  });

  it("defers the whole dispatch to after commit when a tenant context is open", async () => {
    const handoff = jest.fn().mockResolvedValue(undefined);
    const { service } = build(handoff);
    const hooks: AfterCommitHook[] = [];
    const tenant = new TenantContextService();

    await tenant.run({ orgId: ORG_ID, afterCommit: hooks } as never, () => accept(service));

    expect(handoff).not.toHaveBeenCalled();
    expect(hooks).toHaveLength(1);

    /**
     * Run INSIDE a context, as `drainAfterCommitHooks` does. The hook registers
     * a second one of its own for onboarding, which must not run on the
     * transaction the handoff is writing: the person it creates is invisible to
     * any other transaction until this one commits.
     */
    const nested: AfterCommitHook[] = [];
    await tenant.run({ orgId: ORG_ID, afterCommit: nested } as never, () => hooks[0]!());

    expect(handoff).toHaveBeenCalledWith(ORG_ID, CANDIDATE_ID, OFFER_ID);
    expect(nested).toHaveLength(1);
  });
});
