import { Test } from "@nestjs/testing";
import { DRIZZLE } from "../../../db/drizzle.constants";
import { CacheService } from "../../../common/cache/cache.service";
import { AccountOrganizationIndexService } from "./account-organization-index.service";
import { OrganizationSagaService } from "./lifecycle/organization-saga.service";
import { OrganizationCreationService } from "./organization-creation.service";

const chooseRegionForNewOrg = jest.fn();
const placeOrganization = jest.fn();
const placedOrganizationCoordinates = jest.fn();
const unplaceOrganization = jest.fn();
const bootstrapCellOrganization = jest.fn();
// V-021 drives the REAL bootstrap at the bottom of this file, so its own
// collaborators are stubbed here. The tests above never reach them.
const runInNewTenantTransaction = jest.fn(
  (db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(db),
);
const ensureManyFromUsers = jest.fn().mockResolvedValue({ rows: [], auditEntries: [] });
const persistedPlacements = new Map<
  string,
  { region: string; cellId: string }
>();

jest.mock("../../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: (...args: unknown[]) => chooseRegionForNewOrg(...args),
  regionPlacementCoordinates: (choice: { region: string; cellId: string }) => ({
    region: choice.region,
    cellId: choice.cellId,
  }),
}));
jest.mock("../../../common/region/placement-lookup", () => ({
  placeOrganization: (...args: unknown[]) => placeOrganization(...args),
  placedOrganizationCoordinates: (...args: unknown[]) =>
    placedOrganizationCoordinates(...args),
  unplaceOrganization: (...args: unknown[]) => unplaceOrganization(...args),
}));
jest.mock("./bootstrap-cell-organization", () => ({
  bootstrapCellOrganization: (...args: unknown[]) =>
    bootstrapCellOrganization(...args),
  generateOrgSlug: (name: string, suffix: string) =>
    `${name.toLowerCase()}-${suffix}`,
}));
jest.mock("../../../common/tenant/run-in-tenant-transaction", () => ({
  runInNewTenantTransaction: (...args: unknown[]) =>
    (runInNewTenantTransaction as (...a: unknown[]) => unknown)(...args),
}));
jest.mock("../../../common/org/membership-mutations", () => ({
  withMembershipMutations: (
    _cache: unknown,
    fn: (membership: unknown) => unknown,
  ) => fn({ allocateMembershipId: async () => 7, createOwnerMembership: async () => undefined }),
}));
jest.mock("../../billing/core/trial-subscription", () => ({
  insertTrialSubscription: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/org/provision-org-modules", () => ({
  DEFAULT_SKIP_MODULES: ["hr"],
  provisionOrgModules: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../../common/org/provision-employee-self-service", () => ({
  provisionEmployeeSelfService: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../rbac/seed-system-roles", () => ({
  seedSystemRolesForOrg: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../hr/core/person-employment-sync-batch", () => ({
  ensureManyFromUsers: (...args: unknown[]) =>
    (ensureManyFromUsers as (...a: unknown[]) => unknown)(...args),
}));

function selectOwner(rows: unknown[]) {
  const chain: Record<string, jest.Mock> = {};
  chain.from = jest.fn().mockReturnValue(chain);
  chain.where = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn().mockResolvedValue(rows);
  return jest.fn().mockReturnValue(chain);
}

async function build(options: {
  steps?: Array<{ stepName: string; state: string }>;
} = {}) {
  const db = {
    select: selectOwner([{ id: 1 }]),
    query: {
      organizations: {
        findFirst: jest.fn().mockResolvedValue({
          id: "org-fixed",
          name: "Acme",
          slug: "acme-orgfixed",
        }),
      },
      organizationMembers: {
        findFirst: jest.fn().mockResolvedValue({ id: 1 }),
      },
    },
  };
  const invalidate = jest.fn().mockResolvedValue(undefined);
  const refreshForUser = jest.fn().mockResolvedValue(undefined);
  const touchLastActivated = jest.fn().mockResolvedValue(true);
  const activate = jest.fn().mockResolvedValue({ status: "activated" });
  const reserve = jest.fn().mockResolvedValue(true);
  const release = jest.fn().mockResolvedValue(undefined);
  const runStep = jest
    .fn()
    .mockImplementation(
      async (_sagaId: string, _stepName: string, work: () => Promise<unknown>) =>
        work(),
    );
  const saga = {
    begin: jest.fn().mockResolvedValue({
      saga: { sagaId: "saga-1", organizationId: "org-fixed" },
      steps: options.steps ?? [],
    }),
    claimExecution: jest.fn().mockResolvedValue("exec-token"),
    ownsExecution: jest.fn().mockResolvedValue(true),
    markCompensated: jest.fn().mockResolvedValue(undefined),
    wasTerminallyDeleted: jest.fn().mockResolvedValue(false),
    markFailed: jest.fn().mockResolvedValue(undefined),
    findByRequestKey: jest.fn().mockResolvedValue(null),
    findReservationValue: jest.fn().mockResolvedValue(null),
    runStep,
    reserve,
    release,
    complete: jest.fn().mockResolvedValue(undefined),
    claim: jest.fn().mockResolvedValue(undefined),
    compensate: jest.fn().mockResolvedValue(undefined),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrganizationCreationService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: { invalidate } },
      {
        provide: AccountOrganizationIndexService,
        useValue: { refreshForUser, touchLastActivated, activate },
      },
      { provide: OrganizationSagaService, useValue: saga },
    ],
  }).compile();

  return {
    service: moduleRef.get(OrganizationCreationService),
    db,
    invalidate,
    refreshForUser,
    touchLastActivated,
    activate,
    saga,
    reserve,
    release,
    runStep,
  };
}

describe("OrganizationCreationService", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    persistedPlacements.clear();
    chooseRegionForNewOrg.mockResolvedValue({
      kind: "selected",
      region: "in",
      cellId: "in-1",
      rejections: [],
    });
    placeOrganization.mockImplementation(
      async (
        _db: unknown,
        input: { orgId: string; region: string; cellId?: string },
      ) => {
        if (!persistedPlacements.has(input.orgId))
          persistedPlacements.set(input.orgId, {
            region: input.region,
            cellId: input.cellId ?? "legacy-1",
          });
      },
    );
    placedOrganizationCoordinates.mockImplementation(
      async (_db: unknown, orgId: string) =>
        persistedPlacements.get(orgId) ?? null,
    );
    unplaceOrganization.mockImplementation(async (_db: unknown, orgId: string) => {
      persistedPlacements.delete(orgId);
    });
    bootstrapCellOrganization.mockResolvedValue(undefined);
  });

  it("runs setup creation through the CREATE saga with setup-specific provisioning", async () => {
    const { service, saga, invalidate } = await build();

    await expect(
      service.createFromSetup({ userId: "user-1", name: "Acme" }),
    ).resolves.toEqual({
      id: "org-fixed",
      name: "Acme",
      slug: "acme-orgfixed",
    });

    expect(saga.begin).toHaveBeenCalledWith(
      "CREATE",
      expect.any(String),
      "setup-create:user-1",
      "user-1",
      null,
    );
    expect(saga.runStep.mock.calls.map((call) => call[1])).toEqual([
      "reserve-identity",
      "reserve-placement",
      "bootstrap-cell-organization",
      "activate-directory-projection",
    ]);
    expect(placeOrganization).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-fixed",
      region: "in",
      cellId: "in-1",
    });
    expect(bootstrapCellOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      {
        orgId: "org-fixed",
        userId: "user-1",
        region: "in",
        name: "Acme",
        slug: "acme-orgfixed",
        billingEmail: null,
        onboardingCompletedAt: null,
        ownerActivatedAt: null,
        moduleKeys: [],
      },
    );
    expect(saga.complete).toHaveBeenCalledWith("saga-1", "exec-token");
    expect(saga.claim).toHaveBeenCalledWith("ORGANIZATION_ID", "org-fixed", "saga-1");
    expect(saga.claim).toHaveBeenCalledWith("SLUG", "acme-orgfixed", "saga-1");
    expect(invalidate).toHaveBeenCalledWith("user:session:user-1");
  });

  it("uses the persisted placement region when a setup saga resumes after placement", async () => {
    const { service, saga } = await build({
      steps: [
        { stepName: "reserve-identity", state: "DONE" },
        { stepName: "reserve-placement", state: "DONE" },
      ],
    });
    saga.findByRequestKey.mockResolvedValue({
      sagaId: "saga-1",
      organizationId: "org-fixed",
      state: "RUNNING",
    });
    persistedPlacements.set("org-fixed", { region: "eu", cellId: "eu-1" });

    await service.createFromSetup({ userId: "user-1", name: "Acme" });

    expect(chooseRegionForNewOrg).not.toHaveBeenCalled();
    expect(placeOrganization).not.toHaveBeenCalled();
    expect(bootstrapCellOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ region: "eu" }),
    );
  });

  it("uses an existing placement when its saga step was not marked done before a crash", async () => {
    const { service, saga } = await build({
      steps: [{ stepName: "reserve-identity", state: "DONE" }],
    });
    saga.findByRequestKey.mockResolvedValue({
      sagaId: "saga-1",
      organizationId: "org-fixed",
      state: "RUNNING",
    });
    persistedPlacements.set("org-fixed", { region: "ap", cellId: "ap-1" });

    await service.createFromSetup({ userId: "user-1", name: "Acme" });

    expect(chooseRegionForNewOrg).not.toHaveBeenCalled();
    expect(placeOrganization).toHaveBeenCalledWith(expect.anything(), {
      orgId: "org-fixed",
      region: "ap",
      cellId: "ap-1",
    });
    expect(bootstrapCellOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ region: "ap" }),
    );
  });

  it("starts a stable successor saga when the prior completed setup org is gone", async () => {
    const { service, saga, db } = await build();
    saga.findByRequestKey
      .mockResolvedValueOnce({
        sagaId: "saga-old",
        organizationId: "org-old",
        state: "COMPLETED",
      })
      .mockResolvedValueOnce(null);
    persistedPlacements.set("org-old", { region: "in", cellId: "in-1" });
    db.query.organizations.findFirst.mockResolvedValueOnce(undefined);

    await service.createFromSetup({ userId: "user-1", name: "Acme" });

    expect(saga.findByRequestKey).toHaveBeenNthCalledWith(
      1,
      "setup-create:user-1",
    );
    expect(saga.findByRequestKey).toHaveBeenNthCalledWith(
      2,
      "setup-create:user-1:after:saga-old",
    );
    expect(saga.begin).toHaveBeenCalledWith(
      "CREATE",
      expect.any(String),
      "setup-create:user-1:after:saga-old",
      "user-1",
      null,
    );
  });

  it("compensates reservations and placement when setup bootstrap fails", async () => {
    const bootstrapError = new Error("bootstrap failed");
    bootstrapCellOrganization.mockRejectedValueOnce(bootstrapError);
    const { service, saga, release, db } = await build();
    db.query.organizations.findFirst.mockResolvedValue(undefined);

    await expect(
      service.createFromSetup({ userId: "user-1", name: "Acme" }),
    ).rejects.toBe(bootstrapError);

    expect(unplaceOrganization).toHaveBeenCalledWith(expect.anything(), "org-fixed");
    expect(release).toHaveBeenCalledWith("SLUG", "acme-orgfixed", "saga-1");
    expect(release).toHaveBeenCalledWith("ORGANIZATION_ID", "org-fixed", "saga-1");
    expect(saga.markCompensated).toHaveBeenCalledWith("saga-1", "exec-token");
    expect(saga.markFailed).not.toHaveBeenCalled();
    expect(saga.complete).not.toHaveBeenCalled();
  });

  it("an unprojected directory activation fails the step instead of completing the saga", async () => {
    const { service, saga, activate, release } = await build();
    activate.mockResolvedValue({ status: "unprojected" });

    await expect(
      service.createFromSetup({ userId: "user-1", name: "Acme" }),
    ).rejects.toThrow(/not selected in the account directory \(unprojected\)/);

    expect(saga.complete).not.toHaveBeenCalled();
    expect(saga.markFailed).toHaveBeenCalledWith(
      "saga-1",
      expect.any(Error),
      "exec-token",
    );
    expect(saga.markCompensated).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(unplaceOrganization).not.toHaveBeenCalled();
  });

  it("a failed directory activation carries its reason into the step error", async () => {
    const { service, activate } = await build();
    activate.mockResolvedValue({ status: "failed", reason: "42501" });

    await expect(
      service.createFromSetup({ userId: "user-1", name: "Acme" }),
    ).rejects.toThrow(/\(failed: 42501\)/);
  });

  it("a resumed saga re-runs only the projection step and creates no second organization", async () => {
    const { service, saga, activate, runStep } = await build({
      steps: [
        { stepName: "reserve-identity", state: "DONE" },
        { stepName: "reserve-placement", state: "DONE" },
        { stepName: "bootstrap-cell-organization", state: "DONE" },
        { stepName: "bootstrap-owner-membership", state: "DONE" },
        { stepName: "activate-directory-projection", state: "FAILED" },
      ],
    });
    saga.findByRequestKey.mockResolvedValue({
      sagaId: "saga-1",
      organizationId: "org-fixed",
      state: "FAILED",
    });
    saga.findReservationValue.mockImplementation(async (kind: string) =>
      kind === "ORGANIZATION_ID" ? "org-fixed" : "acme-orgfixed",
    );
    persistedPlacements.set("org-fixed", { region: "in", cellId: "in-1" });

    await service.createFromSetup({ userId: "user-1", name: "Acme" });

    expect(runStep.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      "activate-directory-projection",
    ]);
    expect(bootstrapCellOrganization).not.toHaveBeenCalled();
    expect(placeOrganization).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith("user-1", "org-fixed");
    expect(saga.complete).toHaveBeenCalledWith("saga-1", "exec-token");
  });

  it("keeps profile creation defaults behind the same saga owner", async () => {
    const { service, saga } = await build();

    await service.createFromProfile({
      userId: "user-1",
      name: "Acme",
      slug: "acme",
      billingEmail: "billing@acme.test",
    });

    expect(saga.begin).toHaveBeenCalledWith(
      "CREATE",
      expect.any(String),
      "create:user-1:acme",
      "user-1",
      null,
    );
    expect(bootstrapCellOrganization).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        slug: "acme",
        billingEmail: "billing@acme.test",
        onboardingCompletedAt: expect.any(Date),
        ownerActivatedAt: expect.any(Date),
        moduleKeys: undefined,
      }),
    );
  });
});

/**
 * V-021. The owner's own employment record is what every HR surface reads to
 * answer "who is this person at work". Without one, a bulk file naming the
 * founder as `reportingManagerEmail` failed every dependent row, the leave
 * approval chain resolved to nobody, and the founder's directory export came
 * back with empty employment columns.
 *
 * `owner-employment-bootstrap.db.spec.ts` proves the write is idempotent, but
 * it re-implements the call rather than driving `bootstrapCellOrganization`, so
 * nothing failed if the bootstrap simply stopped making it. This drives the
 * real bootstrap — the module the tests above deliberately stub out — and
 * asserts the provisioning happens on the SAME transaction handle the rest of
 * the creation runs on, not after it commits.
 */
describe("bootstrapCellOrganization", () => {
  const realBootstrap = () =>
    jest.requireActual<typeof import("./bootstrap-cell-organization")>(
      "./bootstrap-cell-organization",
    ).bootstrapCellOrganization;

  function buildTx(ownerRow: Record<string, unknown> | undefined) {
    // First select is the "does this org already exist" probe (empty), the
    // second reads the owner off `users`.
    const selects = [[], ownerRow ? [ownerRow] : []];
    const tx = {
      execute: jest.fn().mockResolvedValue([{ id: 7 }]),
      select: jest.fn(() => {
        const rows = selects.shift() ?? [];
        const chain: Record<string, jest.Mock> = {};
        chain.from = jest.fn().mockReturnValue(chain);
        chain.where = jest.fn().mockReturnValue(chain);
        chain.limit = jest.fn().mockResolvedValue(rows);
        return chain;
      }),
      insert: jest.fn().mockReturnValue({ values: jest.fn().mockResolvedValue(undefined) }),
      update: jest.fn().mockReturnValue({
        set: jest.fn().mockReturnValue({ where: jest.fn().mockResolvedValue(undefined) }),
      }),
    };
    return tx;
  }

  const INPUT = {
    orgId: "org-fixed",
    userId: "user-1",
    region: "in",
    name: "Acme",
    slug: "acme-orgfixed",
  };

  beforeEach(() => jest.clearAllMocks());

  it("provisions the owner's employment inside the creation transaction", async () => {
    const tx = buildTx({
      email: "founder@example.test",
      name: "Asha Rao",
      firstName: "Asha",
      lastName: "Rao",
      phone: null,
    });
    runInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(tx),
    );

    await realBootstrap()({} as never, {} as never, INPUT);

    expect(ensureManyFromUsers).toHaveBeenCalledTimes(1);
    const [handle, orgId, inputs] = ensureManyFromUsers.mock.calls[0] as [
      unknown,
      string,
      Array<{ userId: string; workEmail: string; lifecycleStatus: string }>,
    ];
    // The same handle the organisation, membership and modules were written on:
    // provisioning after the commit would leave a founder with no employment
    // record whenever the transaction rolled back.
    expect(handle).toBe(tx);
    expect(orgId).toBe("org-fixed");
    expect(inputs).toEqual([
      expect.objectContaining({
        userId: "user-1",
        workEmail: "founder@example.test",
        // Not ACTIVE: the founder is on record as a person at work without
        // being counted as a hire in headcount or attrition.
        lifecycleStatus: "PRE_JOINING",
      }),
    ]);
  });

  it("does nothing at all when the organization already exists, so a replay creates no second record", async () => {
    const tx = buildTx(undefined);
    tx.select = jest.fn(() => {
      const chain: Record<string, jest.Mock> = {};
      chain.from = jest.fn().mockReturnValue(chain);
      chain.where = jest.fn().mockReturnValue(chain);
      chain.limit = jest.fn().mockResolvedValue([{ id: "org-fixed" }]);
      return chain;
    });
    runInNewTenantTransaction.mockImplementation(
      async (_db: unknown, _orgId: string, fn: (tx: unknown) => unknown) => fn(tx),
    );

    await realBootstrap()({} as never, {} as never, INPUT);

    expect(ensureManyFromUsers).not.toHaveBeenCalled();
  });
});
