/**
 * The hermetic half of the project-budget cost defect. No database.
 *
 * `projects-budget-actual-cost.db.spec.ts` proves the arithmetic against a real
 * Postgres, so it runs only in the `jest-db.json` suite and proves nothing on a
 * machine with no database. This file always runs and pins the one structural
 * fact the defect turned on: **where the money comes from**.
 *
 * `getBudget` used to cost billable hours at `project_members.hourly_rate_minor`.
 * Nothing in the repository writes that column — all six `insert/update(projectMembers)`
 * sites set only org/project/membership/role, and `addMemberSchema` is `.strict()`
 * with no rate field — so `actualCost` was structurally `0` for every project in
 * every org, beside real billable hours, and a PM read "full budget remaining".
 *
 * Reverting to that column fails the first two tests here with no database at
 * all, because the assertions are about which columns the query names.
 */
import { Column, SQL, getTableName } from "drizzle-orm";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { ProjectsBudgetService } from "./projects-budget.service";
import { MANAGER_STANDING, projectAccessRow, standingAccess } from "../project-crud/__tests__/project-access-doubles";

/**
 * Every `table.column` named anywhere in a projection, predicate or raw `sql`
 * fragment. Descends into `SQL.queryChunks`, arrays and plain objects only —
 * never into a Drizzle entity's internals, which would drag in every sibling
 * column of a table and make the assertions meaningless.
 */
function collectColumns(node: unknown, out: Set<string>): void {
  if (node instanceof Column) {
    out.add(`${getTableName(node.table)}.${node.name}`);
    return;
  }
  if (node instanceof SQL) {
    for (const chunk of node.queryChunks) collectColumns(chunk, out);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectColumns(item, out);
    return;
  }
  if (node !== null && typeof node === "object" && Object.getPrototypeOf(node) === Object.prototype) {
    for (const value of Object.values(node)) collectColumns(value, out);
  }
}

interface Recorded {
  /** Every column named by any query the call made, as `table.column`. */
  columns: Set<string>;
  projectMemberReads: number;
}

interface Rows {
  cost: unknown[];
  orgMembers: unknown[];
}

const CTX: CurrentUserContext = {
  userId: "u1",
  orgId: "org-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "s1",
  tokenScopes: null,
  principal: { kind: "human-session", membershipId: 1, isOrgOwner: true },
};

function makeService(
  rows: Rows,
  project: { budgetMinor: number | null; budgetCurrency: string | null },
): { service: ProjectsBudgetService; recorded: Recorded } {
  const recorded: Recorded = { columns: new Set(), projectMemberReads: 0 };
  let selectCount = 0;

  const makeChain = (result: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {};
    const settled = Promise.resolve(result);
    for (const method of ["from", "innerJoin", "leftJoin", "where", "groupBy", "orderBy", "limit"]) {
      chain[method] = (...args: unknown[]): unknown => {
        collectColumns(args, recorded.columns);
        return chain;
      };
    }
    chain.then = (fn: (v: unknown[]) => unknown): unknown => settled.then(fn);
    chain.catch = (fn: (e: unknown) => unknown): unknown => settled.catch(fn);
    chain.finally = (fn: () => void): unknown => settled.finally(fn);
    return chain;
  };

  const db = {
    query: {
      projects: {
        findFirst: (args: unknown): Promise<unknown> => {
          collectColumns(args, recorded.columns);
          return Promise.resolve({
            id: 7,
            budgetMinor: project.budgetMinor,
            budgetCurrency: project.budgetCurrency,
            managerMembershipId: 1,
          });
        },
      },
      projectMembers: {
        findMany: (): Promise<unknown[]> => {
          recorded.projectMemberReads += 1;
          return Promise.resolve([]);
        },
      },
    },
    select: (projection: unknown): unknown => {
      collectColumns(projection, recorded.columns);
      selectCount += 1;
      if (selectCount === 1) return makeChain([projectAccessRow({ manages: true })]);
      return makeChain(selectCount === 2 ? rows.cost : rows.orgMembers);
    },
  };

  const access = standingAccess(MANAGER_STANDING);

  return {
    // Both stand-ins implement exactly the surface `getBudget` touches; Nest
    // resolves these two constructor params at runtime, so the narrowing is on
    // the test's side of the seam.
    service: new ProjectsBudgetService(db as unknown as Db, access as unknown as AccessService),
    recorded,
  };
}

/** One `(membership, currency)` aggregate group, shaped as Postgres returns it. */
function group(fields: {
  membershipId: number;
  currency: string | null;
  hours: string;
  ratedHours: string;
  ratedEntries: number;
  costMinor: string;
}): unknown {
  return fields;
}

describe("project budget — cost is read from the stamped timesheet rate", () => {
  it("names timesheets.bill_rate and never project_members.hourly_rate_minor", async () => {
    const { service, recorded } = makeService(
      { cost: [], orgMembers: [] },
      { budgetMinor: 25_000_000, budgetCurrency: "INR" },
    );

    await service.getBudget(CTX, 7);

    expect([...recorded.columns]).toContain("timesheets.bill_rate");
    expect([...recorded.columns]).toContain("timesheets.hours");
    // The never-written column the defect costed hours at. If this reappears the
    // endpoint is back to reporting 0 for every project in every org.
    expect([...recorded.columns]).not.toContain("project_members.hourly_rate_minor");
    expect([...recorded.columns]).not.toContain("project_members.hourly_rate");
    expect(recorded.projectMemberReads).toBe(0);
  });

  it("scopes both sides of the ticket join to the caller's org and excludes voided entries", async () => {
    const { service, recorded } = makeService(
      { cost: [], orgMembers: [] },
      { budgetMinor: 0, budgetCurrency: null },
    );

    await service.getBudget(CTX, 7);

    expect([...recorded.columns]).toContain("timesheets.org_id");
    expect([...recorded.columns]).toContain("tickets.org_id");
    expect([...recorded.columns]).toContain("tickets.project_id");
    // A voided entry is cancelled work; every other money surface in the
    // repository filters it out, and this one now agrees with them.
    expect([...recorded.columns]).toContain("timesheets.voided_at");
  });

  it("converts the aggregate's minor units to the wire's major units", async () => {
    const { service } = makeService(
      {
        // 340.00 rated h costing 205,000.00 INR = 20,500,000 minor, plus 40.00 h
        // with no stamped rate.
        cost: [
          group({
            membershipId: 11,
            currency: "INR",
            hours: "340.00",
            ratedHours: "340.00",
            ratedEntries: 2,
            costMinor: "20500000",
          }),
          group({
            membershipId: 11,
            currency: null,
            hours: "40.00",
            ratedHours: "0",
            ratedEntries: 0,
            costMinor: "0",
          }),
        ],
        orgMembers: [{ id: 11, userId: "u-alice" }],
      },
      { budgetMinor: 25_000_000, budgetCurrency: "INR" },
    );

    const result = await service.getBudget(CTX, 7);

    expect(result.actualCost).toBe(205_000);
    expect(result.remaining).toBe(45_000);
    expect(result.utilizationPct).toBe(82);
    expect(result.totalHours).toBe(380);
    expect(result.unratedHours).toBe(40);
    expect(result.currencyMismatch).toBe(false);
    expect(result.memberBreakdown).toEqual([
      { userId: "u-alice", hours: 380, cost: 205_000, unratedHours: 40 },
    ]);
  });

  it("never folds a foreign-currency group into the budget currency's total", async () => {
    const { service } = makeService(
      {
        cost: [
          group({
            membershipId: 11,
            currency: "INR",
            hours: "100.00",
            ratedHours: "100.00",
            ratedEntries: 1,
            costMinor: "6000000",
          }),
          // 20.00 h at 100.00 USD/h. USD minor units are not INR minor units.
          group({
            membershipId: 11,
            currency: "USD",
            hours: "20.00",
            ratedHours: "20.00",
            ratedEntries: 1,
            costMinor: "200000",
          }),
        ],
        orgMembers: [{ id: 11, userId: "u-alice" }],
      },
      { budgetMinor: 25_000_000, budgetCurrency: "INR" },
    );

    const result = await service.getBudget(CTX, 7);

    expect(result.currency).toBe("INR");
    expect(result.actualCost).toBe(60_000);
    expect(result.currencyMismatch).toBe(true);
    expect(result.excludedCurrencyHours).toBe(20);
    expect(result.totalHours).toBe(120);
  });

  it("adopts the entries' currency when the project declares none", async () => {
    const { service } = makeService(
      {
        cost: [
          group({
            membershipId: 11,
            currency: "INR",
            hours: "50.00",
            ratedHours: "50.00",
            ratedEntries: 1,
            costMinor: "2000000",
          }),
        ],
        orgMembers: [{ id: 11, userId: "u-alice" }],
      },
      { budgetMinor: 25_000_000, budgetCurrency: null },
    );

    const result = await service.getBudget(CTX, 7);

    expect(result.currency).toBe("INR");
    expect(result.actualCost).toBe(20_000);
    expect(result.currencyMismatch).toBe(false);
  });

  it("refuses to pick a base currency when the project declares none and the entries disagree", async () => {
    const { service } = makeService(
      {
        cost: [
          group({
            membershipId: 11,
            currency: "INR",
            hours: "10.00",
            ratedHours: "10.00",
            ratedEntries: 1,
            costMinor: "500000",
          }),
          group({
            membershipId: 12,
            currency: "USD",
            hours: "10.00",
            ratedHours: "10.00",
            ratedEntries: 1,
            costMinor: "100000",
          }),
        ],
        orgMembers: [
          { id: 11, userId: "u-alice" },
          { id: 12, userId: "u-bob" },
        ],
      },
      { budgetMinor: 25_000_000, budgetCurrency: null },
    );

    const result = await service.getBudget(CTX, 7);

    expect(result.currency).toBeNull();
    expect(result.actualCost).toBe(0);
    expect(result.currencyMismatch).toBe(true);
    expect(result.excludedCurrencyHours).toBe(20);
  });
});
