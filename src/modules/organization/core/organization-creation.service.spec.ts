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
const persistedPlacements = new Map<
  string,
  { region: string; cellId: string }
>();

jest.mock("../../../common/region/cell-admission", () => ({
  chooseRegionForNewOrg: (...args: unknown[]) => chooseRegionForNewOrg(...args),
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
  runInNewTenantTransaction: (
    db: unknown,
    _orgId: string,
    fn: (tx: unknown) => unknown,
  ) => fn(db),
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
  compensate?: jest.Mock;
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
  const touchLastActivated = jest.fn().mockResolvedValue(undefined);
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
    claimExecution: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue(undefined),
    findByRequestKey: jest.fn().mockResolvedValue(null),
    findReservationValue: jest.fn().mockResolvedValue(null),
    runStep,
    reserve,
    release,
    complete: jest.fn().mockResolvedValue(undefined),
    claim: jest.fn().mockResolvedValue(undefined),
    compensate:
      options.compensate ?? jest.fn().mockResolvedValue(undefined),
  };

  const moduleRef = await Test.createTestingModule({
    providers: [
      OrganizationCreationService,
      { provide: DRIZZLE, useValue: db },
      { provide: CacheService, useValue: { invalidate } },
      {
        provide: AccountOrganizationIndexService,
        useValue: { refreshForUser, touchLastActivated },
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
      "bootstrap-owner-membership",
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
    expect(saga.complete).toHaveBeenCalledWith("saga-1");
    expect(saga.claim).toHaveBeenCalledWith("ORGANIZATION_ID", "org-fixed");
    expect(saga.claim).toHaveBeenCalledWith("SLUG", "acme-orgfixed");
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
    const compensate = jest.fn().mockImplementation(
      async (
        _sagaId: string,
        compensators: Record<string, () => Promise<void>>,
      ) => {
        await compensators["reserve-placement"]();
        await compensators["reserve-identity"]();
      },
    );
    const { service, saga, release, db } = await build({ compensate });
    db.query.organizations.findFirst.mockResolvedValue(undefined);

    await expect(
      service.createFromSetup({ userId: "user-1", name: "Acme" }),
    ).rejects.toBe(bootstrapError);

    expect(saga.compensate).toHaveBeenCalledWith(
      "saga-1",
      expect.objectContaining({
        "reserve-identity": expect.any(Function),
        "reserve-placement": expect.any(Function),
      }),
    );
    expect(unplaceOrganization).toHaveBeenCalledWith(expect.anything(), "org-fixed");
    expect(release).toHaveBeenCalledWith("SLUG", "acme-orgfixed");
    expect(release).toHaveBeenCalledWith("ORGANIZATION_ID", "org-fixed");
    expect(saga.complete).not.toHaveBeenCalled();
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
