import { Test } from "@nestjs/testing";
import { OrgSetupService } from "../org-setup.service";
import { OrgSetupResolverService } from "../org-setup-resolver.service";
import { OrganizationCreationService } from "../../core/organization-creation.service";
import { DRIZZLE } from "../../../../db/drizzle.constants";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { OnboardingSessionService } from "../../../hr/onboarding/flow/onboarding-session.service";
import { NotificationDispatchService } from "../../../notifications/notification-dispatch.service";
import { AuditService } from "../../../../common/audit/audit.service";
import { CacheService } from "../../../../common/cache/cache.service";
import { ModuleChecklistService } from "../../../hr/onboarding/flow/module-checklist.service";
import { ACCESS_MANAGED_MODULES } from "../../../rbac/permissions";
import { ForbiddenException } from "@nestjs/common";

jest.mock("../../../../common/rbac/access-invalidate", () => ({
  bumpPermissionsVersion: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));

function ownerActor(orgId = "org-1"): CurrentUserContext {
  return {
    userId: "user-1",
    orgId,
    role: "OWNER",
    isOrgOwner: true,
    sessionId: "s1",
    tokenScopes: null,
    principal: humanSessionPrincipal(1, true),
  };
}

function noOrgActor(): CurrentUserContext {
  return {
    ...ownerActor(""),
    role: "",
    isOrgOwner: false,
    principal: humanSessionPrincipal(1, false),
  };
}

type TxMock = {
  execute: jest.Mock;
  insert: jest.Mock;
  update: jest.Mock;
  select: jest.Mock;
};

const CATALOG_ROWS = [
  { moduleKey: "hr", isCore: false },
  { moduleKey: "crm", isCore: false },
  { moduleKey: "build", isCore: false },
  { moduleKey: "payroll", isCore: false },
  { moduleKey: "inventory", isCore: false },
  { moduleKey: "kb", isCore: true },
  { moduleKey: "chat", isCore: true },
];

function buildTxMock(ownerMembershipId: number | null) {
  const onConflictDoUpdate = jest.fn().mockResolvedValue(undefined);
  const returning = jest.fn().mockResolvedValue([]);
  const onConflictDoNothing = jest.fn().mockReturnValue({ returning });
  const values = jest.fn().mockReturnValue({ onConflictDoUpdate, onConflictDoNothing });
  const insert = jest.fn().mockReturnValue({ values });

  // `claimOnboardingStamp` reads `.returning()` off the same `update(...).set(...).where(...)`
  // chain that the plain `users` update awaits directly, so the double has to be both.
  const returningUpdate = jest.fn().mockResolvedValue([{ id: "org-1" }]);
  const whereUpdate = jest.fn().mockReturnValue({
    returning: returningUpdate,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  });
  const set = jest.fn().mockReturnValue({ where: whereUpdate });
  const update = jest.fn().mockReturnValue({ set });

  const limit = jest.fn().mockResolvedValue(
    ownerMembershipId !== null ? [{ ownerMembershipId }] : [],
  );
  const where = jest.fn().mockReturnValue({ limit });
  // `.from(modulesCatalog)` is awaited directly (no `.where`), so the builder has
  // to be thenable as well as chainable.
  const from = jest.fn().mockReturnValue({
    where,
    then: (resolve: (rows: { moduleKey: string; isCore: boolean }[]) => unknown) =>
      resolve(CATALOG_ROWS),
  });
  const select = jest.fn().mockReturnValue({ from });

  const execute = jest.fn().mockResolvedValue(undefined);
  const tx: TxMock = { execute, insert, update, select };
  return { tx, mocks: { insert, values, onConflictDoUpdate, onConflictDoNothing, returning, returningUpdate, update, select, limit } };
}

function buildDb(ownerMembershipId: number | null) {
  const { tx, mocks: txMocks } = buildTxMock(ownerMembershipId);

  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const outerValues = jest.fn().mockReturnValue({ onConflictDoNothing });
  const outerInsert = jest.fn().mockReturnValue({ values: outerValues });

  const transaction = jest.fn().mockImplementation(
    async (fn: (t: TxMock) => Promise<unknown>) => fn(tx),
  );

  const orgFindFirst = jest.fn().mockResolvedValue({ id: "org-1", name: "Acme" });
  const memberFindFirst = jest.fn().mockResolvedValue({
    status: "ACTIVE",
    isOwner: true,
  });

  const db = {
    query: {
      organizations: { findFirst: orgFindFirst },
      organizationMembers: { findFirst: memberFindFirst },
    },
    insert: outerInsert,
    transaction,
  };

  return { db, txMocks, outerMocks: { insert: outerInsert, values: outerValues, onConflictDoNothing } };
}

async function buildService(db: unknown) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      OrgSetupService,
      OrgSetupResolverService,
      {
        provide: OrganizationCreationService,
        useValue: { createFromSetup: jest.fn() },
      },
      { provide: DRIZZLE, useValue: db },
      { provide: AuditService, useValue: { log: jest.fn() } },
      { provide: CacheService, useValue: { invalidate: jest.fn() } },
      {
        provide: OnboardingSessionService,
        useValue: {
          getOrCreateSession: jest.fn().mockResolvedValue({ id: 42 }),
          skipSession: jest.fn().mockResolvedValue(undefined),
          completeSession: jest.fn().mockResolvedValue(undefined),
        },
      },
      { provide: ModuleChecklistService, useValue: { ensureChecklistsForModules: jest.fn().mockResolvedValue(undefined) } },
      { provide: NotificationDispatchService, useValue: { emit: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return moduleRef.get(OrgSetupService);
}

describe("OrgSetupService — provisionOrgModules ownership seeding", () => {
  it("inserts one ownership row per access-managed module when provisioning via skipSetup", async () => {
    const { db, txMocks } = buildDb(99);
    const svc = await buildService(db);

    await svc.skipSetup(ownerActor());

    expect(txMocks.onConflictDoNothing).toHaveBeenCalledTimes(2);

    const ownershipCall = txMocks.values.mock.calls.find(
      (args: unknown[]) =>
        Array.isArray(args[0]) &&
        (args[0] as Record<string, unknown>[])[0]?.ownerMembershipId !== undefined,
    );
    expect(ownershipCall).toBeDefined();

    const insertedRows = ownershipCall?.[0] as { orgId: string; moduleKey: string; ownerMembershipId: number }[];
    expect(insertedRows.every((r) => r.orgId === "org-1")).toBe(true);
    expect(insertedRows.every((r) => r.ownerMembershipId === 99)).toBe(true);

    const insertedKeys = new Set(insertedRows.map((r) => r.moduleKey));
    for (const key of ["hr", "crm", "build"]) {
      expect(insertedKeys).toContain(key);
    }
    expect(insertedKeys).not.toContain("kb");
    expect(insertedKeys).not.toContain("chat");
  });

  it("does not seed ownership for module keys not in ACCESS_MANAGED_MODULES", async () => {
    const { db, txMocks } = buildDb(99);
    const svc = await buildService(db);

    await svc.skipSetup(ownerActor());

    const ownershipCall = txMocks.values.mock.calls.find(
      (args: unknown[]) =>
        Array.isArray(args[0]) &&
        (args[0] as Record<string, unknown>[])[0]?.ownerMembershipId !== undefined,
    );
    const insertedRows = ownershipCall?.[0] as { moduleKey: string }[] | undefined;
    const insertedKeys = insertedRows ? insertedRows.map((r) => r.moduleKey) : [];

    for (const key of insertedKeys) {
      expect(ACCESS_MANAGED_MODULES).toContain(key);
    }
  });

  it("skips ownership seeding when the org has no owner membership set", async () => {
    const { db, txMocks } = buildDb(null);
    const svc = await buildService(db);

    await svc.skipSetup(ownerActor());

    expect(txMocks.limit).toHaveBeenCalledTimes(1);
    expect(txMocks.onConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("records unselected catalog modules as disabled so the org runs only what was chosen", async () => {
    const { db, txMocks } = buildDb(99);
    const svc = await buildService(db);

    await svc.skipSetup(ownerActor());

    const moduleCall = txMocks.values.mock.calls.find(
      (args: unknown[]) =>
        Array.isArray(args[0]) &&
        (args[0] as Record<string, unknown>[])[0]?.enabled !== undefined,
    );
    expect(moduleCall).toBeDefined();

    const rows = moduleCall?.[0] as { moduleKey: string; enabled: boolean }[];
    const state = new Map(rows.map((r) => [r.moduleKey, r.enabled]));

    expect(state.get("hr")).toBe(true);
    expect(state.get("crm")).toBe(true);
    expect(state.get("build")).toBe(true);
    expect(state.get("payroll")).toBe(false);
    expect(state.get("inventory")).toBe(false);
    expect(state.get("kb")).toBe(true);
    expect(state.get("chat")).toBe(true);
  });

  it("uses onConflictDoNothing so re-provisioning the same modules does not cause duplicate-key errors", async () => {
    const { db, txMocks } = buildDb(99);
    const svc = await buildService(db);

    await svc.skipSetup(ownerActor());

    expect(txMocks.onConflictDoNothing).toHaveBeenCalledTimes(2);
    expect(txMocks.onConflictDoUpdate).toHaveBeenCalledTimes(1);
  });
});

/**
 * Decision D14: the setup routes are made naturally idempotent rather than decorated with
 * `@Idempotent`, which 400s any caller that sends no `Idempotency-Key` header. The stamp is
 * claimed by a conditional UPDATE, so a replay writes nothing at all — no second
 * `organization.setup.completed` with `sendWelcome: true`, and no second `magic_link_tokens` row.
 */
describe("OrgSetupService — replay of a completed setup", () => {
  it("control — the first call claims the stamp and writes the token and the event", async () => {
    const { db, txMocks } = buildDb(99);
    const svc = await buildService(db);

    const result = await svc.skipSetup(ownerActor());

    expect(result).toMatchObject({ success: true, orgId: "org-1" });
    expect(result).toHaveProperty("autoLoginToken");
    expect(txMocks.insert).toHaveBeenCalled();
  });

  it("writes nothing and mints no login token when the stamp was already claimed", async () => {
    const { db, txMocks } = buildDb(99);
    txMocks.returningUpdate.mockResolvedValue([]);
    const svc = await buildService(db);

    await expect(svc.skipSetup(ownerActor())).resolves.toEqual({
      success: true,
      orgId: "org-1",
    });

    expect(txMocks.insert).not.toHaveBeenCalled();
  });

  it("does not re-run completeSetup either", async () => {
    const { db, txMocks } = buildDb(99);
    txMocks.returningUpdate.mockResolvedValue([]);
    const svc = await buildService(db);

    await expect(
      svc.completeSetup(ownerActor(), {
        industry: "IT Services",
        companySize: "1-10",
        enabledModules: ["hr"],
      } as Parameters<OrgSetupService["completeSetup"]>[1]),
    ).resolves.toEqual({ success: true, orgId: "org-1" });

    expect(txMocks.insert).not.toHaveBeenCalled();
  });
});

describe("OrgSetupService stale-session membership guards", () => {
  function buildMembershipDb(rows: Record<string, unknown>[]) {
    const chain: Record<string, jest.Mock> = {};
    chain.from = jest.fn().mockReturnValue(chain);
    chain.leftJoin = jest.fn().mockReturnValue(chain);
    chain.where = jest.fn().mockReturnValue(chain);
    chain.orderBy = jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) });

    const tx = {
      execute: jest.fn().mockResolvedValue([]),
      select: jest.fn().mockReturnValue(chain),
    };

    return {
      identityTx: tx,
      query: {
        organizations: { findFirst: jest.fn() },
        organizationMembers: { findFirst: jest.fn() },
      },
      transaction: jest
        .fn()
        .mockImplementation(
          async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx),
        ),
    };
  }

  it("blocks organization setup when the only valid membership is suspended", async () => {
    const db = buildMembershipDb([
      {
        id: 7,
        orgId: "org-suspended",
        existingOrgId: "org-suspended",
        orgName: "Original workspace",
        orgStatus: "ACTIVE",
        orgDeletedAt: null,
        status: "SUSPENDED",
        isOwner: false,
      },
    ]);
    const svc = await buildService(db);

    const error = await svc
      .skipSetup(noOrgActor())
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: "ORG_MEMBERSHIP_SUSPENDED",
      details: { organizationName: "Original workspace" },
    });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.identityTx.execute).toHaveBeenCalledTimes(1);
  });

  it("uses database membership ownership instead of stale token claims", async () => {
    const db = buildMembershipDb([
      {
        id: 8,
        orgId: "org-active",
        existingOrgId: "org-active",
        orgName: "Existing workspace",
        orgStatus: "ACTIVE",
        orgDeletedAt: null,
        status: "ACTIVE",
        isOwner: false,
      },
    ]);
    const svc = await buildService(db);

    await expect(svc.skipSetup(ownerActor(""))).resolves.toEqual({
      success: true,
      orgId: "org-active",
    });
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.identityTx.execute).toHaveBeenCalledTimes(2);
  });

  it("opens the active sibling's tenant context before reading its setup session", async () => {
    const db = buildMembershipDb([
      {
        id: 9,
        orgId: "org-active",
        existingOrgId: "org-active",
        orgName: "Existing workspace",
        orgStatus: "ACTIVE",
        orgDeletedAt: null,
        status: "ACTIVE",
        isOwner: false,
      },
    ]);
    const svc = await buildService(db);

    await expect(svc.getSetupSession(noOrgActor())).resolves.toEqual({ id: 42 });
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(db.identityTx.execute).toHaveBeenCalledTimes(2);
  });
});
