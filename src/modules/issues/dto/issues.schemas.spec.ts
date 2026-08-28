import {
  createIssueSchema,
  escalateIssueSchema,
  listIssuesQuerySchema,
  transitionIssueSchema,
  updateIssueSchema,
  MAX_PAGE,
} from "./issues.schemas";
import { PAGE_SIZE_CAP } from "../../../common/pagination/list-query.schema";

/**
 * The boundary, asserted against the schemas directly.
 *
 * Not through the controller, for the reason the autonomy review spec records:
 * the tenant interceptor resolves an organisation's region before a handler
 * runs, so on a database missing a migration every request 500s before
 * validation is reached and a payload test proves nothing.
 */
describe("listing the three record types", () => {
  it("insists on a record type, because a list without one has no layout", () => {
    expect(listIssuesQuerySchema.safeParse({}).success).toBe(false);
    expect(listIssuesQuerySchema.safeParse({ recordType: "complaint" }).success).toBe(true);
  });

  it("clamps an over-large page to the platform cap instead of rejecting it", () => {
    const atOldCap = listIssuesQuerySchema.safeParse({ recordType: "task", limit: MAX_PAGE });
    const overCap = listIssuesQuerySchema.safeParse({ recordType: "task", limit: MAX_PAGE + 1 });

    expect(atOldCap.success && atOldCap.data.limit).toBe(PAGE_SIZE_CAP);
    expect(overCap.success && overCap.data.limit).toBe(PAGE_SIZE_CAP);
  });

  it("still serves a page smaller than the cap unchanged", () => {
    const under = listIssuesQuerySchema.safeParse({ recordType: "task", limit: 25 });

    expect(under.success && under.data.limit).toBe(25);
  });

  /**
   * `?openOnly=false` must mean false. `z.coerce.boolean()` is `Boolean(value)`
   * and every non-empty string is truthy, so the wrong helper silently leaves a
   * filter the caller turned off switched on.
   */
  it("reads a query-string boolean the way a query string means it", () => {
    const off = listIssuesQuerySchema.safeParse({ recordType: "issue", openOnly: "false" });
    expect(off.success && off.data.openOnly).toBe(false);
  });

  it("defaults to oldest first, so the oldest failure is not buried", () => {
    const parsed = listIssuesQuerySchema.safeParse({ recordType: "issue" });
    expect(parsed.success && parsed.data.order).toBe("oldest");
  });

  it("rejects an unknown filter rather than ignoring it", () => {
    expect(
      listIssuesQuerySchema.safeParse({ recordType: "issue", assignedTo: "user_1" }).success,
    ).toBe(false);
  });
});

describe("raising a record", () => {
  const complaint = {
    recordType: "complaint" as const,
    title: "Order arrived damaged",
    severity: "high" as const,
  };

  /** Criterion 2, refused at the boundary with a message naming the field. */
  it("refuses a complaint with no party", () => {
    const parsed = createIssueSchema.safeParse(complaint);
    expect(parsed.success).toBe(false);
    if (!parsed.success)
      expect(parsed.error.issues.some((issue) => issue.path.includes("partyId"))).toBe(true);
  });

  it("accepts a complaint anchored to a party, and to a deal as well", () => {
    expect(createIssueSchema.safeParse({ ...complaint, partyId: "party_1" }).success).toBe(true);
    expect(
      createIssueSchema.safeParse({ ...complaint, partyId: "party_1", dealId: 7 }).success,
    ).toBe(true);
  });

  it("refuses a deal anchor with no party behind it", () => {
    expect(
      createIssueSchema.safeParse({
        recordType: "task",
        title: "Chase the renewal",
        severity: "low",
        dealId: 7,
      }).success,
    ).toBe(false);
  });

  it("does not require a party for an internal issue or task", () => {
    expect(
      createIssueSchema.safeParse({ recordType: "issue", title: "Sync stuck", severity: "medium" })
        .success,
    ).toBe(true);
  });

  /**
   * A stage that could be set on create or on patch would be a second path that
   * leaves no ledger row — which is the whole failure the ledger closes.
   */
  it("accepts no stage on create and none on update", () => {
    expect(
      createIssueSchema.safeParse({ ...complaint, partyId: "p1", stage: "resolved" }).success,
    ).toBe(false);
    expect(updateIssueSchema.safeParse({ stage: "resolved" }).success).toBe(false);
  });

  /** A task is not a complaint with a different word on it. */
  it("accepts no record type on update", () => {
    expect(updateIssueSchema.safeParse({ recordType: "complaint" }).success).toBe(false);
  });

  it("refuses an empty patch rather than issuing a no-op write", () => {
    expect(updateIssueSchema.safeParse({}).success).toBe(false);
  });

  it("lets an owner, a due date and a deal anchor be cleared", () => {
    expect(
      updateIssueSchema.safeParse({ ownerUserId: null, dueAt: null, dealId: null }).success,
    ).toBe(true);
  });
});

describe("moving a record", () => {
  it("will not escalate through the ordinary stage route", () => {
    expect(transitionIssueSchema.safeParse({ toStage: "escalated" }).success).toBe(false);
    expect(transitionIssueSchema.safeParse({ toStage: "resolved" }).success).toBe(true);
  });

  /**
   * An escalation says somebody's handling was not good enough. Recording that
   * without saying why leaves the person it lands on with an accusation and no
   * case.
   */
  it("requires a reason to escalate and does not require one otherwise", () => {
    expect(escalateIssueSchema.safeParse({}).success).toBe(false);
    expect(escalateIssueSchema.safeParse({ reason: "   " }).success).toBe(false);
    expect(escalateIssueSchema.safeParse({ reason: "Third missed delivery" }).success).toBe(true);
    expect(transitionIssueSchema.safeParse({ toStage: "acknowledged" }).success).toBe(true);
  });
});
