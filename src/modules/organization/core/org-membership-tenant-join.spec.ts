import { OrgMembershipService } from "./org-membership.service";

function primitiveValues(value: unknown, seen = new WeakSet<object>()): unknown[] {
  if (value === null || typeof value !== "object") return [value];
  if (seen.has(value)) return [];
  seen.add(value);
  return Object.values(value).flatMap((entry) => primitiveValues(entry, seen));
}

describe("OrgMembershipService privileged-role tenant join", () => {
  it("correlates roles and assignments by org_id as well as role id", async () => {
    const joinPredicates: unknown[] = [];
    const where = jest.fn().mockResolvedValue([]);
    const innerJoin = jest.fn((_table: unknown, predicate: unknown) => {
      joinPredicates.push(predicate);
      return { where };
    });
    const db = { select: () => ({ from: () => ({ innerJoin }) }) };
    const service = new OrgMembershipService(
      db as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await (
      service as unknown as {
        queryPrivilegedRoleNames(db: unknown, orgId: string, membershipId: number): Promise<string[]>;
      }
    ).queryPrivilegedRoleNames(db, "org-1", 17);

    expect(innerJoin).toHaveBeenCalledTimes(1);
    const values = primitiveValues(joinPredicates[0]);
    // Both role_assignments.org_id and roles.org_id participate in the join.
    expect(values.filter((value) => value === "org_id").length).toBeGreaterThanOrEqual(2);
    expect(primitiveValues(where.mock.calls[0][0])).toEqual(
      expect.arrayContaining(["org-1", 17]),
    );
  });
});
