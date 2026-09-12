import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { ApprovalsService } from "../approvals.service";
import { userDelegationPermissions } from "../../../../db/schema";

/**
 * A delegation is a header plus one row per permission it hands over. Acting
 * for an approver therefore means holding a delegation that carries
 * `timesheets:approvals:manage` — not any delegation from that person at all,
 * which is what a header-only read conferred.
 */
describe("a delegate acts for the approver only through a delegation that carries the approval key", () => {
  function build() {
    const captured: { join?: { table: unknown; on: SQL }; where?: SQL; limit?: number } = {};
    const chain = {
      from: () => chain,
      innerJoin: (table: unknown, on: SQL) => { captured.join = { table, on }; return chain; },
      where: (where: SQL) => { captured.where = where; return chain; },
      limit: (n: number) => { captured.limit = n; return Promise.resolve([{ delegatorMembershipId: 7 }]); },
    };
    const db = { selectDistinct: () => chain };
    const service = new ApprovalsService(db as never, {} as never, {} as never, {} as never, {} as never);
    return { service, captured };
  }

  it("joins the permission rows on the delegation and names the key", async () => {
    const { service, captured } = build();
    const delegators = await service.activeDelegationsToActor("org-1", 20, [7, 7, 8]);
    expect(delegators).toEqual(new Set([7]));
    expect(captured.join?.table).toBe(userDelegationPermissions);
    const on = new PgDialect().sqlToQuery(captured.join!.on);
    expect(on.sql).toContain('"permission_key" = ');
    expect(on.params).toContain("timesheets:approvals:manage");
  });

  it("keeps the header predicates: tenant, delegatee, ACTIVE, and the live window", async () => {
    const { service, captured } = build();
    await service.activeDelegationsToActor("org-1", 20, [7, 8]);
    const where = new PgDialect().sqlToQuery(captured.where!);
    expect(where.params).toEqual(expect.arrayContaining(["org-1", 7, 8, 20, "ACTIVE"]));
    expect(where.sql).toContain('"starts_at" <= ');
    expect(where.sql).toContain('"ends_at" > ');
    expect(captured.limit).toBe(2);
  });

  it("asks nothing when there is no approver to check", async () => {
    const { service, captured } = build();
    expect(await service.activeDelegationsToActor("org-1", 20, [])).toEqual(new Set());
    expect(captured.where).toBeUndefined();
  });
});
