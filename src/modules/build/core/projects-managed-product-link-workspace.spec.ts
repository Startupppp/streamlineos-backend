import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { Db } from "../../../db/drizzle.module";
import { ProjectsWriteService } from "./projects-write.service";

const audit = { log: jest.fn() } as never;
const access = {} as never;
const projectsQuery = {} as never;

const ORG = { orgId: "org-1", userId: "u1" } as never;
const PROJECT_ID = 11;

function makeDb(
  projectWorkspaceId: string | null,
  productRow: { managedProductId: number; pmWorkspaceId: string } | null,
) {
  const findFirst = jest.fn().mockResolvedValue(
    projectWorkspaceId === null
      ? undefined
      : { id: PROJECT_ID, pmWorkspaceId: projectWorkspaceId },
  );
  const limit = jest.fn().mockResolvedValue(productRow === null ? [] : [productRow]);
  const selectWhere = jest.fn().mockReturnValue({ limit });
  const from = jest.fn().mockReturnValue({ where: selectWhere });

  const returning = jest.fn().mockResolvedValue([
    { id: PROJECT_ID, orgId: "org-1", name: "P", key: "P", managedProductId: 7 },
  ]);
  const updateWhere = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where: updateWhere });
  const update = jest.fn().mockReturnValue({ set });

  const db = {
    query: { projects: { findFirst } },
    select: jest.fn().mockReturnValue({ from }),
    update,
  } as unknown as Db;
  return { db, update, returning };
}

function serviceFor(db: Db) {
  return new ProjectsWriteService(db, audit, access, projectsQuery);
}

describe("linkProjectToManagedProduct — same-workspace ownership", () => {
  it("links a project to a managed product in the same PM workspace", async () => {
    const { db, update } = makeDb("ws-1", {
      managedProductId: 7,
      pmWorkspaceId: "ws-1",
    });

    await expect(
      serviceFor(db).linkProjectToManagedProduct(ORG, PROJECT_ID, {
        managedProductId: 7,
      }),
    ).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });

  it("rejects linking a project to a managed product owned by a different PM workspace", async () => {
    const { db, update } = makeDb("ws-1", {
      managedProductId: 7,
      pmWorkspaceId: "ws-2",
    });

    await expect(
      serviceFor(db).linkProjectToManagedProduct(ORG, PROJECT_ID, {
        managedProductId: 7,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(update).not.toHaveBeenCalled();
  });

  it("names the PM workspace mismatch so the caller can correct the target", async () => {
    const { db } = makeDb("ws-1", { managedProductId: 7, pmWorkspaceId: "ws-2" });

    await expect(
      serviceFor(db).linkProjectToManagedProduct(ORG, PROJECT_ID, {
        managedProductId: 7,
      }),
    ).rejects.toThrow(/PM workspace/);
  });

  it("still rejects a managed product that does not exist in the organization", async () => {
    const { db } = makeDb("ws-1", null);

    await expect(
      serviceFor(db).linkProjectToManagedProduct(ORG, PROJECT_ID, {
        managedProductId: 999,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it("allows unlinking without consulting managed-product ownership", async () => {
    const { db, update } = makeDb("ws-1", null);

    await expect(
      serviceFor(db).linkProjectToManagedProduct(ORG, PROJECT_ID, {
        managedProductId: null,
      }),
    ).resolves.toBeDefined();
    expect(update).toHaveBeenCalled();
  });
});
