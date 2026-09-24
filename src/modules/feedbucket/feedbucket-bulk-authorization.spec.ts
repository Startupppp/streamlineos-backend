import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { ScopedRead } from "../access/scoped-read";
import type { AccessService } from "../access/access.service";
import type { DataScope } from "../access/access.types";
import { bulkMutateFeedbucketSubmissions } from "./feedbucket-submissions-bulk";
import type { BulkSubmissionsInput } from "./feedbucket.schemas";
import {
  BULK_ACTOR,
  BULK_MEMBERSHIP,
  BULK_ORG,
  bulkActor,
  bulkBody,
  makeBulkAccess,
  makeBulkHarness,
  sqlValues,
  type BulkHarness,
} from "./feedbucket-bulk-test-doubles";

function runBulk(
  harness: BulkHarness,
  access: AccessService,
  input: BulkSubmissionsInput,
  scope: DataScope = "all",
) {
  return bulkMutateFeedbucketSubmissions(
    harness.db,
    access,
    bulkActor,
    ScopedRead.of(BULK_ORG, BULK_ACTOR, scope),
    BULK_MEMBERSHIP,
    input,
  );
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("bulkMutateFeedbucketSubmissions — cross-tenant ids", () => {
  it("does not mutate an id the tenant predicate excludes", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 999], action: { type: "status", status: "resolved" } }),
    );
    expect(sqlValues(harness.updateWhere.mock.calls[0]?.[0])).not.toContain(999);
  });

  it("reports a foreign id as skipped with a reason that does not confirm whether it exists", async () => {
    const harness = makeBulkHarness([1]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 999], action: { type: "status", status: "resolved" } }),
    );
    expect(result.results).toContainEqual({
      submissionId: 999,
      outcome: "skipped",
      reason: "not_found_or_filtered",
    });
    expect(result.results).toContainEqual({
      submissionId: 1,
      outcome: "updated",
      reason: null,
    });
  });

  it("uses the same skipped reason for a filtered-out in-tenant id as for a foreign id", async () => {
    const harness = makeBulkHarness([]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({
        submissionIds: [1],
        action: { type: "status", status: "resolved" },
        filters: { status: "archived" },
      }),
    );
    expect(result.results).toEqual([
      { submissionId: 1, outcome: "skipped", reason: "not_found_or_filtered" },
    ]);
  });

  it("writes nothing and reports every id skipped when the actor's data scope is none", async () => {
    const harness = makeBulkHarness([1, 2]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 2], action: { type: "status", status: "resolved" } }),
      "none",
    );
    expect(harness.transaction).not.toHaveBeenCalled();
    expect(result.skipped).toBe(2);
    expect(result.succeeded).toBe(0);
  });
});

describe("bulkMutateFeedbucketSubmissions — per-action permission gates", () => {
  it("denies a bulk assign when the actor lacks feedbucket:submissions:assign", async () => {
    const harness = makeBulkHarness([1]);
    await expect(
      runBulk(
        harness,
        makeBulkAccess({ "feedbucket:submissions:assign": "none" }),
        bulkBody({ submissionIds: [1], action: { type: "assign", assigneeId: "user-b" } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("performs a bulk assign when the actor does hold feedbucket:submissions:assign", async () => {
    const harness = makeBulkHarness([1]);
    const result = await runBulk(
      harness,
      makeBulkAccess({ "feedbucket:submissions:assign": "all" }),
      bulkBody({ submissionIds: [1], action: { type: "assign", assigneeId: "user-b" } }),
    );
    expect(result.succeeded).toBe(1);
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeMembershipId: 77 }),
    );
  });

  it("does not consult the assign key for a status-only bulk, so status is gated by update alone", async () => {
    const harness = makeBulkHarness([1]);
    const access = makeBulkAccess({ "feedbucket:submissions:assign": "none" });
    await runBulk(
      harness,
      access,
      bulkBody({ submissionIds: [1], action: { type: "status", status: "resolved" } }),
    );
    expect(access.scopeFor).not.toHaveBeenCalled();
  });

  it("denies a bulk delete when the actor lacks feedbucket:submissions:delete", async () => {
    const harness = makeBulkHarness([1]);
    await expect(
      runBulk(
        harness,
        makeBulkAccess({ "feedbucket:submissions:delete": "none" }),
        bulkBody({ submissionIds: [1], action: { type: "delete" } }),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("soft-deletes rather than hard-deletes when the actor does hold feedbucket:submissions:delete", async () => {
    const harness = makeBulkHarness([1]);
    const result = await runBulk(
      harness,
      makeBulkAccess({ "feedbucket:submissions:delete": "all" }),
      bulkBody({ submissionIds: [1], action: { type: "delete" } }),
    );
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({ deletedAt: expect.any(Date) }),
    );
    expect(result.results[0]?.outcome).toBe("deleted");
  });

  it("404s a bulk assign to someone who is not a member of this organization", async () => {
    const harness = makeBulkHarness([1]);
    harness.membershipFindFirst.mockResolvedValue(undefined);
    await expect(
      runBulk(
        harness,
        makeBulkAccess(),
        bulkBody({ submissionIds: [1], action: { type: "assign", assigneeId: "outsider" } }),
      ),
    ).rejects.toThrow(NotFoundException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("clears the assignee on a null bulk assign without looking up a membership", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1], action: { type: "assign", assigneeId: null } }),
    );
    expect(harness.membershipFindFirst).not.toHaveBeenCalled();
    expect(harness.set).toHaveBeenCalledWith(
      expect.objectContaining({ assigneeMembershipId: null }),
    );
  });
});
