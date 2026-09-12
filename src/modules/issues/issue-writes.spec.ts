import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../db/drizzle.types";
import { createIssueRecord, updateIssueRecord, type IssueWriteDeps } from "./lib/issue-writes";

/**
 * Filing and editing an issue, task or complaint had no test at all.
 *
 * Every one of the rules below could be deleted from `lib/issue-writes.ts` with
 * the issues suite green: the anchor check on create, the anchor check on
 * update, the org predicate on the party lookup, the org predicate on the deal
 * lookup, both not-found refusals, the org predicate on the edit's existence
 * read and on the UPDATE itself, the 404 for a missing record, "a complaint must
 * anchor to a party" and "a deal anchor needs its party". The only spec in the
 * module that touched `IssuesService` covered `list`.
 *
 * So these assert what never happened as much as what did — no INSERT, no
 * UPDATE — because a refusal that fires after the write is not a refusal. And
 * they assert the org reaches each predicate, because a mocked lookup returns
 * whatever the mock says regardless of its WHERE.
 */

function sqlValues(value: unknown, seen = new Set<object>()): unknown[] {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  )
    return [value];
  if (Array.isArray(value)) return value.flatMap((item) => sqlValues(item, seen));
  if (typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const record = value as { queryChunks?: unknown[]; value?: unknown };
  return [
    ...(record.queryChunks ? sqlValues(record.queryChunks, seen) : []),
    ...(Object.prototype.hasOwnProperty.call(record, "value")
      ? sqlValues(record.value, seen)
      : []),
  ];
}

const ORG = "org-writer-tenant";
const USER = "user-writer";

/**
 * Each queued result answers one `select().from().where().limit()` in order;
 * a select beyond the queue returns nothing, so an unexpected read fails loudly.
 */
function writeHarness(selectResults: unknown[][]) {
  const lookups: jest.Mock[] = [];
  const select = jest.fn();
  for (const rows of selectResults) {
    const where = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });
    lookups.push(where);
    select.mockReturnValueOnce({ from: jest.fn().mockReturnValue({ where }) });
  }
  const values = jest.fn().mockReturnValue({
    returning: jest.fn().mockResolvedValue([{ issueRecordId: "rec-new" }]),
  });
  const insert = jest.fn().mockReturnValue({ values });
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const update = jest.fn().mockReturnValue({
    set: jest.fn().mockReturnValue({ where: updateWhere }),
  });
  const recordOpening = jest.fn().mockResolvedValue(undefined);
  const deps: IssueWriteDeps = {
    db: { select, insert, update } as unknown as Db,
    transitions: { recordOpening },
  };
  return { deps, select, lookups, insert, values, update, updateWhere, recordOpening };
}

describe("filing a record — anchors must be real and must be ours", () => {
  it("files nothing when the party is not in the caller's org", async () => {
    const h = writeHarness([[]]);

    await expect(
      createIssueRecord(h.deps, ORG, USER, {
        recordType: "complaint",
        title: "Delivery arrived damaged",
        severity: "high",
        partyId: "party-elsewhere",
      }),
    ).rejects.toThrow(NotFoundException);

    expect(h.lookups[0]).toHaveBeenCalledTimes(1);
    expect(sqlValues(h.lookups[0]?.mock.calls[0]?.[0])).toContain(ORG);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("files nothing when the deal is not in the caller's org", async () => {
    const h = writeHarness([[{ partyId: "party-1" }], []]);

    await expect(
      createIssueRecord(h.deps, ORG, USER, {
        recordType: "issue",
        title: "Renewal stalled",
        severity: "medium",
        partyId: "party-1",
        dealId: 42,
      }),
    ).rejects.toThrow(NotFoundException);

    expect(h.lookups[1]).toHaveBeenCalledTimes(1);
    expect(sqlValues(h.lookups[1]?.mock.calls[0]?.[0])).toContain(ORG);
    expect(h.insert).not.toHaveBeenCalled();
  });

  it("files an anchored record in the caller's org and opens its ledger", async () => {
    const h = writeHarness([[{ partyId: "party-1" }], [{ id: 42 }]]);

    const id = await createIssueRecord(h.deps, ORG, USER, {
      recordType: "complaint",
      title: "Delivery arrived damaged",
      severity: "high",
      partyId: "party-1",
      dealId: 42,
    });

    expect(id).toBe("rec-new");
    expect(h.values).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, createdByUserId: USER, partyId: "party-1", dealId: 42 }),
    );
    expect(h.recordOpening).toHaveBeenCalledWith(ORG, "rec-new", { kind: "human", userId: USER });
  });
});

describe("editing a record — the same anchors, checked against the record as it will be", () => {
  const ISSUE = { partyId: "party-1", dealId: null, recordType: "issue" };

  it("404s an edit to a record outside the caller's org, and writes nothing", async () => {
    const h = writeHarness([[]]);

    await expect(
      updateIssueRecord(h.deps, ORG, "rec-elsewhere", { title: "renamed" }),
    ).rejects.toThrow(NotFoundException);

    expect(h.lookups[0]).toHaveBeenCalledTimes(1);
    expect(sqlValues(h.lookups[0]?.mock.calls[0]?.[0])).toContain(ORG);
    expect(h.update).not.toHaveBeenCalled();
  });

  /** Criterion 2. The patch looks innocuous; the row it would leave behind does not. */
  it("refuses to clear a complaint's party", async () => {
    const h = writeHarness([[{ partyId: "party-1", dealId: null, recordType: "complaint" }]]);

    await expect(
      updateIssueRecord(h.deps, ORG, "rec-1", { partyId: null }),
    ).rejects.toThrow(BadRequestException);

    expect(h.update).not.toHaveBeenCalled();
  });

  it("refuses a deal anchor with no party behind it", async () => {
    const h = writeHarness([[{ partyId: null, dealId: null, recordType: "issue" }]]);

    await expect(
      updateIssueRecord(h.deps, ORG, "rec-1", { dealId: 42 }),
    ).rejects.toThrow(BadRequestException);

    expect(h.select).toHaveBeenCalledTimes(1);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("re-checks a changed party inside the caller's org before writing it", async () => {
    const h = writeHarness([[ISSUE], []]);

    await expect(
      updateIssueRecord(h.deps, ORG, "rec-1", { partyId: "party-elsewhere" }),
    ).rejects.toThrow(NotFoundException);

    expect(h.lookups[1]).toHaveBeenCalledTimes(1);
    expect(sqlValues(h.lookups[1]?.mock.calls[0]?.[0])).toContain(ORG);
    expect(h.update).not.toHaveBeenCalled();
  });

  it("confines the UPDATE itself to the caller's org", async () => {
    const h = writeHarness([[ISSUE]]);

    await updateIssueRecord(h.deps, ORG, "rec-1", { title: "renamed" });

    expect(h.updateWhere).toHaveBeenCalledTimes(1);
    expect(sqlValues(h.updateWhere.mock.calls[0]?.[0])).toContain(ORG);
  });
});
