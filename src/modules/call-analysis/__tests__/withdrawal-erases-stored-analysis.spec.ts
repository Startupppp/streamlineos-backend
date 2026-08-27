import type { Db } from "../../../db/drizzle.types";
import type { AiGatewayService } from "../../ai/core/gateway/ai-gateway.service";
import { CallAnalysisWriterService } from "../analyse/call-analysis-writer.service";
import type { ObservedConsent } from "../consent-gate";

/**
 * Ticket 03's fifth criterion, through the service that performs it.
 *
 * `consent-gate.spec.ts` proves the rule; this proves the wiring. The two things
 * that could go wrong between them are that the pass computes the right list and
 * never issues the deletion, and that it issues a deletion every time whether or
 * not anything changed. Both are checked below.
 */

const NOW = new Date("2026-08-26T10:00:00.000Z");

interface ConsentRow {
  readonly crmCallAnalysisId: string;
  readonly regime: "all-party" | "one-party";
  readonly status: ObservedConsent | null;
  readonly expiresAt: Date | null;
}

/**
 * A database that answers the reconcile query and records deletions.
 *
 * Deliberately not a mock of the service's own methods: the query builder is
 * exercised as written, so a change to the join or the projection that stopped
 * returning consent would fail here rather than pass on a stubbed shape.
 */
function fakeDb(rows: readonly ConsentRow[]): { db: Db; deletes: number } {
  const state = { deletes: 0 };

  const query = {
    from: () => query,
    leftJoin: () => query,
    where: () => Promise.resolve(rows),
  };

  const db = {
    select: () => query,
    delete: () => ({
      where: () => {
        state.deletes += 1;
        return Promise.resolve();
      },
    }),
  } as unknown as Db;

  return {
    db,
    get deletes() {
      return state.deletes;
    },
  };
}

/** The pass never reaches a model on this path, so an unusable one is honest. */
const NO_MODEL = {} as AiGatewayService;

describe("a withdrawal removes the analysis that already exists", () => {
  it("erases the historical analysis of a customer who has since withdrawn", () => {
    /**
     * `march-call` was analysed while consent stood; the customer has since
     * opted out. The criterion is not "stop analysing their calls" — it is that
     * the reading of the call from March stops being held.
     */
    const store = fakeDb([
      {
        crmCallAnalysisId: "march-call",
        regime: "one-party",
        status: "OPTED_OUT",
        expiresAt: null,
      },
      {
        crmCallAnalysisId: "unaffected-call",
        regime: "one-party",
        status: "OPTED_IN",
        expiresAt: null,
      },
    ]);

    const service = new CallAnalysisWriterService(store.db, NO_MODEL);

    return service.reconcileConsent("org-1", NOW).then((result) => {
      expect(result.erased).toEqual(["march-call"]);
      expect(store.deletes).toBe(1);
    });
  });

  it("takes the most restrictive answer when several contacts share one party", () => {
    /**
     * A party can be reached through more than one contact row, so the query
     * returns several consent answers for one analysis. Taking whichever the
     * planner returned first would make a withdrawal effective or not depending
     * on join order — which is the worst possible property for this rule.
     */
    const store = fakeDb([
      {
        crmCallAnalysisId: "shared-party",
        regime: "one-party",
        status: "OPTED_IN",
        expiresAt: null,
      },
      {
        crmCallAnalysisId: "shared-party",
        regime: "one-party",
        status: "OPTED_OUT",
        expiresAt: null,
      },
    ]);

    const service = new CallAnalysisWriterService(store.db, NO_MODEL);

    return service
      .reconcileConsent("org-1", NOW)
      .then((result) => expect(result.erased).toEqual(["shared-party"]));
  });

  it("issues no deletion at all when nothing has been withdrawn", () => {
    /**
     * The other half of the claim. Without this, a pass that deleted
     * unconditionally would satisfy the test above and quietly destroy every
     * analysis in the organisation on each run.
     */
    const store = fakeDb([
      { crmCallAnalysisId: "fine", regime: "one-party", status: "UNKNOWN", expiresAt: null },
      {
        crmCallAnalysisId: "also-fine",
        regime: "all-party",
        status: "OPTED_IN",
        expiresAt: null,
      },
    ]);

    const service = new CallAnalysisWriterService(store.db, NO_MODEL);

    return service.reconcileConsent("org-1", NOW).then((result) => {
      expect(result.erased).toEqual([]);
      expect(store.deletes).toBe(0);
    });
  });

  it("treats a party with no consent row at all as unknown, not as agreement", () => {
    // A left join returns null where nobody ever recorded anything. In an
    // all-party jurisdiction "nothing" is not agreement, so the analysis goes.
    const store = fakeDb([
      { crmCallAnalysisId: "unmapped", regime: "all-party", status: null, expiresAt: null },
    ]);

    const service = new CallAnalysisWriterService(store.db, NO_MODEL);

    return service
      .reconcileConsent("org-1", NOW)
      .then((result) => expect(result.erased).toEqual(["unmapped"]));
  });
});
