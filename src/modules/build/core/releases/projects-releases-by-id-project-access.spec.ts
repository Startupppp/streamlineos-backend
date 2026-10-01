import { ForbiddenException } from "@nestjs/common";
import type { Db } from "../../../../db/drizzle.module";
import type { AccessService } from "../../../access/access.service";
import type { CurrentUserContext } from "../../../../common/auth/backend-claims";
import { humanSessionPrincipal } from "../../../../common/auth/principal";
import { ProjectsReleasesService } from "./projects-releases.service";
import { lifecycleAuditDouble } from "../../lifecycle/audit-double";

const MEMBERSHIP_ID = 7;
const ORG = "org-1";
const PROJECT_ID = 7;
const OTHER_MANAGER_MEMBERSHIP_ID = 999;

function makeU(): CurrentUserContext {
  return {
    userId: "user-7",
    orgId: ORG,
    role: "MEMBER",
    isOrgOwner: false,
    sessionId: "session-1",
    tokenScopes: null,
    principal: humanSessionPrincipal(MEMBERSHIP_ID, false),
  };
}

function makeAccessWithoutBuildManage(): AccessService {
  return {
    resolveUserPermissions: jest.fn().mockResolvedValue(new Set<string>()),
  } as unknown as AccessService;
}

function membershipProbe(rows: Array<{ role: string }>) {
  const limit = jest.fn().mockResolvedValue(rows);
  const where = jest.fn().mockReturnValue({ limit });
  const innerJoin = jest
    .fn()
    .mockReturnValue({ innerJoin: jest.fn().mockReturnValue({ where }), where });
  return { from: jest.fn().mockReturnValue({ innerJoin, where }) };
}

function updateChain(returned: unknown[]) {
  const returning = jest.fn().mockResolvedValue(returned);
  const where = jest.fn().mockReturnValue({ returning });
  const set = jest.fn().mockReturnValue({ where });
  return jest.fn().mockReturnValue({ set });
}

function insertChain(returned: unknown[]) {
  const onConflictDoNothing = jest.fn().mockResolvedValue(undefined);
  const returning = jest.fn().mockResolvedValue(returned);
  const values = jest.fn().mockReturnValue({ onConflictDoNothing, returning });
  return jest.fn().mockReturnValue({ values });
}

function deleteChain() {
  const where = jest.fn().mockResolvedValue(undefined);
  return jest.fn().mockReturnValue({ where });
}

interface NonMemberFixture {
  db: Db;
  rowFindFirst: jest.Mock;
  update: jest.Mock;
  insert: jest.Mock;
  dbDelete: jest.Mock;
  transaction: jest.Mock;
}

function makeNonMemberDb(): NonMemberFixture {
  const rowFindFirst = jest.fn();
  const update = jest.fn();
  const insert = jest.fn();
  const dbDelete = jest.fn();
  const transaction = jest.fn();
  const db = {
    query: {
      projects: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
      },
      projectReleases: { findFirst: rowFindFirst },
      tickets: { findFirst: rowFindFirst },
    },
    select: jest.fn().mockImplementation(() => membershipProbe([])),
    update,
    insert,
    delete: dbDelete,
    transaction,
  } as unknown as Db;
  return { db, rowFindFirst, update, insert, dbDelete, transaction };
}

function memberSelect(bodyChains: Array<() => unknown>) {
  let call = 0;
  return jest.fn().mockImplementation(() => {
    call += 1;
    if (call === 1) return membershipProbe([{ role: "MEMBER" }]);
    const chain = bodyChains[call - 2];
    return chain ? chain() : membershipProbe([]);
  });
}

describe("ProjectsReleasesService — by-id routes gate on project membership, not only orgId", () => {
  it("refuses updateRelease for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update, transaction } = makeNonMemberDb();
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.updateRelease(makeU(), PROJECT_ID, 5, { name: "hijacked", rowVersion: 1, releaseDate: null })).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("updates the release for a project member (control for the updateRelease denial)", async () => {
    const updatedRelease = { id: 5, orgId: ORG, projectId: PROJECT_ID, name: "v2", version: null, description: null, status: "draft", releaseDate: null, createdBy: "u", createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
    const txUpdate = jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([updatedRelease]) }),
      }),
    });
    const transaction = jest.fn(async (cb: (t: unknown) => Promise<unknown>) =>
      cb({ update: txUpdate }),
    );
    const countChain = () => ({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockResolvedValue([{ ticketCount: 0 }]),
      }),
    });
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        projectReleases: { findFirst: jest.fn().mockResolvedValue({ rowVersion: 1 }) },
      },
      select: jest.fn()
        .mockImplementationOnce(() => membershipProbe([{ role: "MEMBER" }]))
        .mockImplementationOnce(() => membershipProbe([]))
        .mockImplementationOnce(countChain),
      transaction,
    } as unknown as Db;
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.updateRelease(makeU(), PROJECT_ID, 5, { name: "v2", rowVersion: 1, releaseDate: null })).resolves.toMatchObject({
      id: 5,
      name: "v2",
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("refuses deleteRelease for an in-tenant non-member of the project before it writes", async () => {
    const { db, rowFindFirst, update } = makeNonMemberDb();
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.deleteRelease(makeU(), PROJECT_ID, 5)).rejects.toThrow(ForbiddenException);
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("deletes the release for a project member (control for the deleteRelease denial)", async () => {
    const update = updateChain([{ id: 5 }]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
      },
      select: memberSelect([]),
      update,
    } as unknown as Db;
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.deleteRelease(makeU(), PROJECT_ID, 5)).resolves.toEqual({ success: true });
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("refuses addTicketToRelease for an in-tenant non-member of the project before it reads the release", async () => {
    const { db, rowFindFirst, insert } = makeNonMemberDb();
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.addTicketToRelease(makeU(), PROJECT_ID, 5, 99)).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("adds a ticket to a release for a project member (control for the addTicketToRelease denial)", async () => {
    const releaseRow = { id: 5 };
    const ticketRow = { id: 99 };
    let findFirstCall = 0;
    const findFirst = jest.fn().mockImplementation(() => {
      findFirstCall += 1;
      if (findFirstCall === 1) return Promise.resolve(releaseRow);
      return Promise.resolve(ticketRow);
    });
    const insert = insertChain([]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        projectReleases: { findFirst },
        tickets: { findFirst },
      },
      select: memberSelect([]),
      insert,
    } as unknown as Db;
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.addTicketToRelease(makeU(), PROJECT_ID, 5, 99)).resolves.toEqual({
      success: true,
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("refuses removeTicketFromRelease for an in-tenant non-member of the project before it reads the release", async () => {
    const { db, rowFindFirst, dbDelete } = makeNonMemberDb();
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.removeTicketFromRelease(makeU(), PROJECT_ID, 5, 99)).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(dbDelete).not.toHaveBeenCalled();
  });

  it("removes a ticket from a release for a project member (control for the removeTicketFromRelease denial)", async () => {
    const releaseRow = { id: 5 };
    const findFirst = jest.fn().mockResolvedValue(releaseRow);
    const dbDelete = deleteChain();
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
        projectReleases: { findFirst },
      },
      select: memberSelect([]),
      delete: dbDelete,
    } as unknown as Db;
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.removeTicketFromRelease(makeU(), PROJECT_ID, 5, 99)).resolves.toEqual({
      success: true,
    });
    expect(dbDelete).toHaveBeenCalledTimes(1);
  });

  it("refuses createRelease for an in-tenant non-member of the project before it inserts", async () => {
    const { db, rowFindFirst, insert } = makeNonMemberDb();
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.createRelease(makeU(), PROJECT_ID, { name: "hijacked release", version: "1.0.0", status: "draft", releaseDate: null })).rejects.toThrow(
      ForbiddenException,
    );
    expect(rowFindFirst).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("creates a release for a project member (control for the createRelease denial)", async () => {
    const newRelease = { id: 10, orgId: ORG, projectId: PROJECT_ID, name: "v1", version: null, description: null, status: "draft", releaseDate: null, createdBy: "user-7", createdAt: new Date(), updatedAt: new Date(), deletedAt: null };
    const insert = insertChain([newRelease]);
    const db = {
      query: {
        projects: {
          findFirst: jest
            .fn()
            .mockResolvedValue({ managerMembershipId: OTHER_MANAGER_MEMBERSHIP_ID }),
        },
      },
      select: memberSelect([]),
      insert,
    } as unknown as Db;
    const svc = new ProjectsReleasesService(db, makeAccessWithoutBuildManage(), lifecycleAuditDouble());

    await expect(svc.createRelease(makeU(), PROJECT_ID, { name: "release v1", version: "1.0.0", status: "draft", releaseDate: null })).resolves.toMatchObject({
      id: 10,
      name: "v1",
    });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
