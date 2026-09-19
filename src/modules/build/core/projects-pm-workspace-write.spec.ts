jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));
jest.mock("../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn().mockResolvedValue(
    new Map([["user-xyz", { membershipId: 1, organizationPersonId: "person-1" }]]),
  ),
}));

import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ProjectsProvisionService } from "./projects-provision.service";
import { ProjectsWriteService } from "./projects-write.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-abc";
const USER = "user-xyz";
const WS_A = "ws-A";
const WS_B = "ws-B";
const PRODUCT_ID = 7;
const PROJECT_ID = 42;

function makeProductSelectChain(row: { pmWorkspaceId: string } | null) {
  return {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue(row !== null ? [row] : []),
  };
}

function makeProjectInsertChain() {
  return {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG, key: "P-001", name: "P" }]),
  };
}

function makeProvisionDb(productRow: { pmWorkspaceId: string } | null) {
  const productChain = makeProductSelectChain(productRow);
  const txInsert = makeProjectInsertChain();
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue(txInsert),
  };
  return {
    db: {
      select: jest.fn().mockReturnValue(productChain),
      transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
      query: { deals: { findFirst: jest.fn() } },
    } as unknown as Db,
    tx,
  };
}

function makeProvisionSvc(db: Db) {
  const pmWorkspaces = {
    resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue(WS_A),
    resolveDefaultWorkspaceId: jest.fn().mockResolvedValue(WS_A),
    assertMemberOfWorkspace: jest.fn().mockResolvedValue(undefined),
  };
  return new ProjectsProvisionService(
    db,
    { log: jest.fn() } as never,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    pmWorkspaces as never,
  );
}

describe("ProjectsProvisionService — cross-workspace managed product guard", () => {
  it("rejects createProject when the managed product belongs to a different PM workspace", async () => {
    const { db } = makeProvisionDb({ pmWorkspaceId: WS_B });
    const svc = makeProvisionSvc(db);

    await expect(
      svc.createProject(ORG, USER, { name: "My Project", managedProductId: PRODUCT_ID }),
    ).rejects.toThrow(BadRequestException);
  });

  it("never calls db.transaction when the managed product workspace mismatches on create", async () => {
    const { db } = makeProvisionDb({ pmWorkspaceId: WS_B });
    const svc = makeProvisionSvc(db);

    await svc.createProject(ORG, USER, { name: "My Project", managedProductId: PRODUCT_ID }).catch(() => undefined);

    const dbMock = db as unknown as { transaction: jest.Mock };
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("rejects createProject when the managed product is not found in the caller's org", async () => {
    const { db } = makeProvisionDb(null);
    const svc = makeProvisionSvc(db);

    await expect(
      svc.createProject(ORG, USER, { name: "My Project", managedProductId: PRODUCT_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it("never calls db.transaction when the managed product is cross-tenant on create", async () => {
    const { db } = makeProvisionDb(null);
    const svc = makeProvisionSvc(db);

    await svc.createProject(ORG, USER, { name: "My Project", managedProductId: PRODUCT_ID }).catch(() => undefined);

    const dbMock = db as unknown as { transaction: jest.Mock };
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });
});

function makeWriteDb(opts: {
  projectRow: { id: number; pmWorkspaceId: string } | null;
  productRow: { managedProductId: number; pmWorkspaceId: string } | null;
}) {
  const productChain = makeProductSelectChain(opts.productRow);
  const updateChain = {
    set: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue(
      opts.projectRow ? [{ ...opts.projectRow, name: "P", key: "P-1", orgId: ORG, managedProductId: opts.productRow?.managedProductId ?? null }] : [],
    ),
  };
  return {
    query: {
      projects: { findFirst: jest.fn().mockResolvedValue(opts.projectRow) },
    },
    select: jest.fn().mockReturnValue(productChain),
    update: jest.fn().mockReturnValue(updateChain),
  } as unknown as Db;
}

function makeWriteSvc(db: Db) {
  return new ProjectsWriteService(
    db,
    { log: jest.fn() } as never,
    { resolveUserPermissions: jest.fn().mockResolvedValue(new Set(["build:manage"])) } as never,
    {} as never,
  );
}

const actorUser = {
  orgId: ORG,
  userId: USER,
  isOrgOwner: true,
  principal: { kind: "human-session" as const, membershipId: 1, isOrgOwner: true },
} as never;

describe("ProjectsWriteService — cross-workspace managed product guard on link", () => {
  it("rejects linkProjectToManagedProduct when the product belongs to a different PM workspace", async () => {
    const db = makeWriteDb({
      projectRow: { id: PROJECT_ID, pmWorkspaceId: WS_A },
      productRow: { managedProductId: PRODUCT_ID, pmWorkspaceId: WS_B },
    });
    const svc = makeWriteSvc(db);

    await expect(
      svc.linkProjectToManagedProduct(actorUser, PROJECT_ID, { managedProductId: PRODUCT_ID }),
    ).rejects.toThrow(BadRequestException);
  });

  it("never calls db.update when the product workspace mismatches on link", async () => {
    const db = makeWriteDb({
      projectRow: { id: PROJECT_ID, pmWorkspaceId: WS_A },
      productRow: { managedProductId: PRODUCT_ID, pmWorkspaceId: WS_B },
    });
    const svc = makeWriteSvc(db);

    await svc.linkProjectToManagedProduct(actorUser, PROJECT_ID, { managedProductId: PRODUCT_ID }).catch(() => undefined);

    const dbMock = db as unknown as { update: jest.Mock };
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("rejects linkProjectToManagedProduct when the managed product is not found (cross-tenant guard)", async () => {
    const db = makeWriteDb({
      projectRow: { id: PROJECT_ID, pmWorkspaceId: WS_A },
      productRow: null,
    });
    const svc = makeWriteSvc(db);

    await expect(
      svc.linkProjectToManagedProduct(actorUser, PROJECT_ID, { managedProductId: PRODUCT_ID }),
    ).rejects.toThrow(NotFoundException);
  });

  it("never calls db.update when the managed product is cross-tenant on link", async () => {
    const db = makeWriteDb({
      projectRow: { id: PROJECT_ID, pmWorkspaceId: WS_A },
      productRow: null,
    });
    const svc = makeWriteSvc(db);

    await svc.linkProjectToManagedProduct(actorUser, PROJECT_ID, { managedProductId: PRODUCT_ID }).catch(() => undefined);

    const dbMock = db as unknown as { update: jest.Mock };
    expect(dbMock.update).not.toHaveBeenCalled();
  });

  it("allows null managedProductId (unlinking) without checking product workspace, and calls db.update", async () => {
    const db = makeWriteDb({
      projectRow: { id: PROJECT_ID, pmWorkspaceId: WS_A },
      productRow: null,
    });
    const svc = makeWriteSvc(db);

    await expect(
      svc.linkProjectToManagedProduct(actorUser, PROJECT_ID, { managedProductId: null }),
    ).resolves.toBeDefined();

    const dbMock = db as unknown as { update: jest.Mock };
    expect(dbMock.update).toHaveBeenCalledTimes(1);
  });
});
