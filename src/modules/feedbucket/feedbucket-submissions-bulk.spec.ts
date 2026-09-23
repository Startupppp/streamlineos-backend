import { BadRequestException } from "@nestjs/common";
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
  unvalidatedBulkBody,
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

describe("bulkMutateFeedbucketSubmissions — record cap", () => {
  it("rejects more than 100 ids even when the Zod bound is bypassed, so the runtime guard is not decorative", async () => {
    const harness = makeBulkHarness([]);
    const ids = Array.from({ length: 101 }, (_, index) => index + 1);
    await expect(
      runBulk(
        harness,
        makeBulkAccess(),
        unvalidatedBulkBody({ submissionIds: ids, action: { type: "status", status: "open" } }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });

  it("accepts exactly 100 ids so the cap is inclusive and not off by one", async () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    const harness = makeBulkHarness(ids);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: ids, action: { type: "status", status: "open" } }),
    );
    expect(result.succeeded).toBe(100);
  });

  it("rejects an empty id list at runtime rather than opening a transaction that writes nothing", async () => {
    const harness = makeBulkHarness([]);
    await expect(
      runBulk(
        harness,
        makeBulkAccess(),
        unvalidatedBulkBody({ submissionIds: [], action: { type: "status", status: "open" } }),
      ),
    ).rejects.toThrow(BadRequestException);
    expect(harness.transaction).not.toHaveBeenCalled();
  });
});

describe("bulkMutateFeedbucketSubmissions — one transaction, deterministic lock order", () => {
  it("opens exactly one transaction and issues exactly one UPDATE for many rows", async () => {
    const harness = makeBulkHarness([1, 2, 3]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [3, 1, 2], action: { type: "status", status: "resolved" } }),
    );
    expect(harness.transaction).toHaveBeenCalledTimes(1);
    expect(harness.update).toHaveBeenCalledTimes(1);
    expect(harness.set).toHaveBeenCalledTimes(1);
  });

  it("locks the target rows FOR UPDATE in ascending id order so two concurrent bulks cannot deadlock", async () => {
    const harness = makeBulkHarness([1, 2, 3]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [3, 1, 2], action: { type: "status", status: "resolved" } }),
    );
    expect(harness.forUpdate).toHaveBeenCalledWith("update");
    const orderBy = sqlValues(harness.selectOrderBy.mock.calls[0]?.[0]).join("");
    expect(orderBy).toContain("asc");
    expect(orderBy).not.toContain("desc");
  });

  it("caps the locking SELECT at the bulk ceiling so the read is bounded in the statement itself", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1], action: { type: "status", status: "resolved" } }),
    );
    expect(harness.selectLimit).toHaveBeenCalledWith(100);
  });

  it("excludes already soft-deleted rows from the lock so a re-run of a bulk delete is a no-op", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess({ "feedbucket:submissions:delete": "all" }),
      bulkBody({ submissionIds: [1], action: { type: "delete" } }),
    );
    const where = sqlValues(harness.selectWhere.mock.calls[0]?.[0]).join(" ");
    expect(where).toContain("is null");
  });

  it("does not open a transaction at all when no row survives the predicate", async () => {
    const harness = makeBulkHarness([]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 2], action: { type: "status", status: "resolved" } }),
    );
    expect(harness.update).not.toHaveBeenCalled();
    expect(result.succeeded).toBe(0);
  });
});

describe("bulkMutateFeedbucketSubmissions — same predicate as the list", () => {
  it("puts the tenant org id in the locking SELECT's WHERE clause", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1], action: { type: "status", status: "resolved" } }),
    );
    expect(sqlValues(harness.selectWhere.mock.calls[0]?.[0])).toContain(BULK_ORG);
  });

  it("applies the caller's list filters to the bulk target so bulk and list resolve the same set", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({
        submissionIds: [1, 2],
        action: { type: "status", status: "resolved" },
        filters: { status: "open", search: "crash", widgetId: 7 },
      }),
    );
    const values = sqlValues(harness.selectWhere.mock.calls[0]?.[0]);
    expect(values).toContain("open");
    expect(values).toContain("%crash%");
    expect(values).toContain(7);
  });

  it("scopes the UPDATE to the tenant and to the ids the locking SELECT returned", async () => {
    const harness = makeBulkHarness([1]);
    await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 2], action: { type: "status", status: "resolved" } }),
    );
    const values = sqlValues(harness.updateWhere.mock.calls[0]?.[0]);
    expect(values).toContain(BULK_ORG);
    expect(values).toContain(1);
    expect(values).not.toContain(2);
  });
});

describe("bulkMutateFeedbucketSubmissions — partial outcome reporting", () => {
  it("reports requested, succeeded and skipped counts that add up", async () => {
    const harness = makeBulkHarness([1, 2]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 2, 3, 4], action: { type: "priority", priority: "high" } }),
    );
    expect(result.requested).toBe(4);
    expect(result.succeeded).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.results).toHaveLength(4);
  });

  it("de-duplicates repeated ids so one row is never counted twice", async () => {
    const harness = makeBulkHarness([1]);
    const result = await runBulk(
      harness,
      makeBulkAccess(),
      bulkBody({ submissionIds: [1, 1, 1], action: { type: "priority", priority: "low" } }),
    );
    expect(result.requested).toBe(1);
    expect(result.results).toHaveLength(1);
  });
});
