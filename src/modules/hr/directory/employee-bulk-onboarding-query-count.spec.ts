import { makeCountingDb, type CountingOp } from "../../../db/__tests__/counting-db";
import type { Db } from "../../../db/drizzle.types";
import { runWithTenantContext } from "../../../common/tenant/tenant-context";
import type { TenantTx } from "../../../db/drizzle.types";
import { HrAuditService } from "../core/hr-audit.service";
import { PersonEmploymentSyncService } from "../core/person-employment-sync.service";
import { SeatLedgerService } from "../../billing/core/seat-ledger.service";
import { EmployeeBulkOnboardingService } from "./employee-bulk-onboarding.service";
import type { BulkOnboardEmployeeRow } from "./dto/hr-directory.schemas";
import type { CurrentUserContext } from "../../../common/auth/backend-claims";
import { ACCOUNT_ONLY_PRINCIPAL } from "../../../common/auth/principal";

/**
 * The proof that the import stopped running one complete onboarding workflow per
 * uploaded row.
 *
 * "It created the right people" does not distinguish the two shapes — the per-row
 * loop created them too. Only the statement count does, measured while the row
 * count changes: 1 row and 50 rows must cost the same, because every read is one
 * `inArray` for the batch and every write is one multi-row statement.
 */

const ORG = "org-bulk-onboard";
const ACTOR: CurrentUserContext = {
  orgId: ORG,
  userId: "actor-1",
  role: "OWNER",
  isOrgOwner: true,
  sessionId: "session-1",
  tokenScopes: null,
  principal: ACCOUNT_ONLY_PRINCIPAL,
};
const DEPARTMENT_ID = "dept-engineering";

function repeat<T>(count: number, make: (index: number) => T): T[] {
  return Array.from({ length: count }, (_unused, index) => make(index));
}

function uploadRows(count: number): BulkOnboardEmployeeRow[] {
  return repeat(count, (index) => ({
    firstName: "Ada",
    lastName: `Lovelace${String(index + 1)}`,
    email: ` Ada.Lovelace${String(index + 1)}@Example.COM `,
    designation: "Engineer",
    department: "Engineering",
    whatsappSameAsPhone: true,
  }));
}

function userId(index: number): string {
  return `user-${String(index + 1)}`;
}

function collaborators() {
  const cache = {
    invalidate: jest.fn(),
    invalidateMany: jest.fn(),
    invalidateNamespace: jest.fn(),
    invalidateNamespaceMany: jest.fn(),
    invalidateNamespaceForOrg: jest.fn(),
  };
  return {
    cache,
    audit: { logCritical: jest.fn() },
    hierarchyCache: { invalidateAfterMutation: jest.fn() },
    access: { canManageOrganizationMembership: jest.fn().mockResolvedValue(true) },
    planLimits: { assertWithinLimit: jest.fn().mockResolvedValue(undefined) },
    email: { sendWelcomeEmail: jest.fn() },
    automation: { runAutomationsForEvent: jest.fn() },
    webhooks: { dispatch: jest.fn() },
  };
}

interface Harness {
  run: () => Promise<{ total: number; created: number; failed: number }>;
  statements: () => number;
  countOf: (op: CountingOp) => number;
  planLimits: { assertWithinLimit: jest.Mock };
}

/**
 * Every row names a user that already exists but is not yet a member, so the
 * userIds are known up front and each `returning()` can be queued deterministically.
 */
function harness(count: number): Harness {
  const rows = uploadRows(count);
  const existingUsers = repeat(count, (index) => ({
    id: userId(index),
    email: `ada.lovelace${String(index + 1)}@example.com`,
  }));

  const counting = makeCountingDb({
    select: [
      [],
      existingUsers,
      [],
      [{ id: 7, slug: "MEMBER" }],
      [],
      [],
      [],
      [],
      [{ id: 42 }],
    ],
    insert: [
      [{ id: DEPARTMENT_ID, name: "Engineering", code: "ENGINEERING" }],
      repeat(count, (index) => ({ id: index + 1, userId: userId(index) })),
      [],
      [],
      [],
      [],
      repeat(count, (index) => ({
        organizationPersonId: `op-${String(index + 1)}`,
        userId: userId(index),
      })),
      repeat(count, (index) => ({ id: index + 1, userId: userId(index) })),
      repeat(count, (index) => ({ id: 100 + index, personId: index + 1 })),
      [],
    ],
    execute: [[], [], [{ count: 5 }]],
  });
  const db: Db = counting.db as Db;
  const deps = collaborators();
  const service = new EmployeeBulkOnboardingService(
    db,
    deps.audit as never,
    deps.hierarchyCache as never,
    deps.cache as never,
    deps.access as never,
    deps.planLimits as never,
    new SeatLedgerService(db),
    deps.email as never,
    deps.automation as never,
    deps.webhooks as never,
    new PersonEmploymentSyncService(db, new HrAuditService(db)),
  );

  return {
    run: () =>
      // `afterCommit: []` keeps `registerAfterCommit` truthy, so delivery is
      // deferred and never drains here — the count measures the request only.
      runWithTenantContext(
        { orgId: ORG, audience: "INTERNAL", tx: counting.db as TenantTx, afterCommit: [] },
        () => service.onboardEmployeesBulk(ACTOR, rows),
      ),
    statements: counting.statements,
    countOf: counting.countOf,
    planLimits: deps.planLimits,
  };
}

describe("EmployeeBulkOnboardingService.onboardEmployeesBulk — statement count", () => {
  it("costs one department read and nothing else for an empty upload", async () => {
    const { run, statements, countOf } = harness(0);

    await expect(run()).resolves.toMatchObject({ total: 0, created: 0, failed: 0 });

    expect(statements()).toBe(1);
    expect(countOf("select")).toBe(1);
    expect(countOf("insert")).toBe(0);
    expect(countOf("update")).toBe(0);
  });

  it("spends the same statements on 50 rows as on 1", async () => {
    const one = harness(1);
    await expect(one.run()).resolves.toMatchObject({ total: 1, created: 1, failed: 0 });
    const oneRow = one.statements();

    const fifty = harness(50);
    await expect(fifty.run()).resolves.toMatchObject({ total: 50, created: 50, failed: 0 });
    const fiftyRows = fifty.statements();

    expect(fiftyRows).toBe(oneRow);
    expect([oneRow, fiftyRows]).toEqual([23, 23]);
    expect(fifty.countOf("select")).toBe(one.countOf("select"));
    expect(fifty.countOf("insert")).toBe(one.countOf("insert"));
    expect(fifty.countOf("update")).toBe(one.countOf("update"));
    expect(fifty.countOf("execute")).toBe(one.countOf("execute"));
  });

  it("reserves the whole batch's quota once, not once per row", async () => {
    const { run, planLimits } = harness(50);
    await run();

    expect(planLimits.assertWithinLimit).toHaveBeenCalledTimes(1);
    expect(planLimits.assertWithinLimit).toHaveBeenCalledWith(
      ORG,
      "members",
      50,
      expect.anything(),
    );
  });

  it("canonicalises and de-duplicates emails at this boundary", async () => {
    const rows = uploadRows(1);
    const duplicate: BulkOnboardEmployeeRow[] = [
      rows[0],
      { ...rows[0], email: "ADA.LOVELACE1@example.com" },
    ];
    const counting = makeCountingDb({
      select: [[], [], [], [{ id: 7, slug: "MEMBER" }], [], [], [], [], [{ id: 42 }]],
      insert: [
        [{ id: DEPARTMENT_ID, name: "Engineering", code: "ENGINEERING" }],
        [{ id: 1, userId: "created-1" }],
        [],
        [],
        [],
        [],
        [{ organizationPersonId: "op-1", userId: "created-1" }],
        [{ id: 1, userId: "created-1" }],
        [{ id: 100, personId: 1 }],
        [],
      ],
      execute: [[], [], [{ count: 5 }]],
    });
    const db: Db = counting.db as Db;
    const deps = collaborators();
    const service = new EmployeeBulkOnboardingService(
      db,
      deps.audit as never,
      deps.hierarchyCache as never,
      deps.cache as never,
      deps.access as never,
      deps.planLimits as never,
      new SeatLedgerService(db),
      deps.email as never,
      deps.automation as never,
      deps.webhooks as never,
      new PersonEmploymentSyncService(db, new HrAuditService(db)),
    );

    const result = await runWithTenantContext(
      { orgId: ORG, audience: "INTERNAL", tx: counting.db as TenantTx, afterCommit: [] },
      () => service.onboardEmployeesBulk(ACTOR, duplicate),
    );

    expect(result.created).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.results[1]).toMatchObject({
      row: 2,
      email: "ada.lovelace1@example.com",
      success: false,
      error: "Duplicate email in this upload",
    });
  });
});
