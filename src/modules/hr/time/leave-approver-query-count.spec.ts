process.env.APP_URL ??= "http://localhost:1000";

import { makeCountingDb } from "../../../db/__tests__/counting-db";
import type { Db } from "../../../db/drizzle.types";
import type { AccessService } from "../../access/access.service";
import type { DataScope } from "../../access/access.types";
import type { EmploymentFactsService } from "../../directory/employment-facts.service";
import { LeaveApproverService } from "./leave-approver.service";

/**
 * `resolve` scans a candidate list whose length is the number of `hr:leaves:approve`
 * holders in the organisation. Two things grow with that list and only one of them
 * is a database statement, so they are asserted separately.
 *
 * DATABASE statements are two — the membership check and one `inArray` read of every
 * candidate's user row — for one candidate and for fifty. The shape this replaced
 * ran one guaranteed-empty scope probe per candidate; the reintroduction test for
 * that is the count, not the result.
 *
 * PERMISSION RESOLUTIONS are still one per candidate. `Promise.all` made them
 * concurrent, not batched, and it also removed the loop's early exit, so the count
 * is now the full candidate list even when the first candidate wins. The bound is
 * the constant `APPROVER_CANDIDATE_LIMIT` the service passes to
 * `membersWithPermission`, which is asserted rather than assumed: without it the
 * fan-out would be O(organisation).
 */

const ORG = "org-leave-approver";
const SUBJECT = "employee-1";
const CANDIDATE_LIMIT = 100;
const BATCH_SIZES = [1, 50] as const;

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

function candidateRows(count: number) {
  return repeat(count, (index) => ({
    id: `hr-${String(index)}`,
    name: `Approver ${String(index)}`,
    firstName: "Approver",
    lastName: String(index),
    email: `hr-${String(index)}@example.test`,
    image: null,
  }));
}

function employmentDouble(managerUserId: string | null): EmploymentFactsService {
  return {
    getFacts: jest.fn().mockResolvedValue({
      userId: SUBJECT,
      employmentId: null,
      employeeNumber: null,
      designation: null,
      joiningDate: null,
      departmentId: null,
      locationId: null,
      managerUserId,
    }),
    getFactsBatch: jest.fn().mockResolvedValue(new Map()),
  } as unknown as EmploymentFactsService;
}

/**
 * `winnerIndex` decides how far the scan walks. The last candidate makes the loop
 * visit every one of them, which is what a per-candidate probe would scale with;
 * the first candidate makes the loop return immediately, which is what shows the
 * permission resolutions are no longer short-circuited.
 */
function harness(candidateCount: number, winnerIndex: number) {
  const rows = candidateRows(candidateCount);
  const winner = rows[winnerIndex];
  const counting = makeCountingDb({
    select: [[{ userId: SUBJECT }], rows],
  });
  const membersWithPermission = jest
    .fn()
    .mockResolvedValue(rows.map((row, index) => ({ userId: row.id, membershipId: index + 1 })));
  const resolveUserPermissions = jest.fn((_orgId: string, userId: string) =>
    Promise.resolve(
      new Map<string, DataScope>([["hr:leaves:approve", userId === winner?.id ? "all" : "own"]]),
    ),
  );
  const access = { membersWithPermission, resolveUserPermissions } as unknown as AccessService;

  return {
    ...counting,
    membersWithPermission,
    resolveUserPermissions,
    service: new LeaveApproverService(counting.db as Db, access, employmentDouble(null)),
    winner,
  };
}

describe("LeaveApproverService.resolve — statement count", () => {
  it("reads every candidate in the same two statements at 1 candidate as at 50", async () => {
    const counts: number[] = [];

    for (const size of BATCH_SIZES) {
      // The winner is last, so the loop examines every candidate before returning.
      const { service, statements, countOf, winner } = harness(size, size - 1);

      await expect(service.resolve(ORG, SUBJECT)).resolves.toEqual({
        ...winner,
        designation: null,
      });

      // Membership check + one inArray read of the whole candidate set.
      expect(countOf("select")).toBe(2);
      expect(statements()).toBe(2);
      counts.push(statements());
    }

    expect(counts[0]).toBe(counts[1]);
  });

  it("stops at the first covering candidate, and bounds the list by a constant", async () => {
    const resolutions: number[] = [];

    for (const size of BATCH_SIZES) {
      const { service, resolveUserPermissions, membersWithPermission } = harness(size, 0);

      await service.resolve(ORG, SUBJECT);

      // Short-circuited: the first candidate already holds `all`, so no other
      // candidate is resolved however many follow it.
      expect(resolveUserPermissions).toHaveBeenCalledTimes(1);
      // The only thing that bounds the walk when no early candidate covers.
      expect(membersWithPermission).toHaveBeenCalledWith(ORG, "hr:leaves:approve", {
        limit: CANDIDATE_LIMIT,
      });
      resolutions.push(resolveUserPermissions.mock.calls.length);
    }

    expect(resolutions).toEqual([1, 1]);
  });

  it("issues one statement and resolves no permissions when there is no candidate", async () => {
    const { service, statements, countOf, resolveUserPermissions } = harness(0, 0);

    await expect(service.resolve(ORG, SUBJECT)).resolves.toBeNull();

    expect(statements()).toBe(1);
    expect(countOf("select")).toBe(1);
    expect(resolveUserPermissions).not.toHaveBeenCalled();
  });
});
