jest.mock("../../email/app-url", () => ({ appUrl: "https://test.example.com" }));

const CREATOR = "user-xyz";
const CLIENT_USER = "client-user-1";
const CLIENT_MEMBERSHIP_ID = 5;

jest.mock("../../../common/organization/organization-actor", () => ({
  resolveOrganizationActorsByUserIds: jest.fn().mockResolvedValue(
    new Map([
      [CREATOR, { membershipId: 1, organizationPersonId: "person-1", orgId: "org-abc", userId: CREATOR, role: "MEMBER", isOwner: false, resolvedVia: "user" }],
      [CLIENT_USER, { membershipId: CLIENT_MEMBERSHIP_ID, organizationPersonId: null, orgId: "org-abc", userId: CLIENT_USER, role: "MEMBER", isOwner: false, resolvedVia: "user" }],
    ]),
  ),
}));

import { ProjectsProvisionService } from "./projects-provision.service";
import type { Db } from "../../../db/drizzle.module";

const ORG = "org-abc";

function makeDb() {
  const txInsert = {
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1, orgId: ORG, key: "TST-001", name: "Test Project" }]),
  };
  const tx = {
    execute: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnValue(txInsert),
  };
  const db = {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([]),
    }),
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb(tx)),
  } as unknown as Db;
  return { db, tx, txInsert };
}

function makeSvc(db: Db) {
  return new ProjectsProvisionService(
    db,
    { log: jest.fn() } as never,
    { assertWithinLimit: jest.fn().mockResolvedValue(undefined) } as never,
    { emit: jest.fn().mockResolvedValue(undefined) } as never,
    {
      resolveWorkspaceIdForWrite: jest.fn().mockResolvedValue("ws-default"),
      assertMemberOfWorkspace: jest.fn().mockResolvedValue(undefined),
    } as never,
  );
}

describe("ProjectsProvisionService.createProject — clientId membership resolution", () => {
  it("passes the resolved clientMembershipId to the INSERT when clientId is provided", async () => {
    const { db, txInsert } = makeDb();
    const svc = makeSvc(db);

    await svc.createProject(ORG, CREATOR, { name: "Test Project", clientId: CLIENT_USER });

    expect(txInsert.values).toHaveBeenCalled();
    const insertedRow = txInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow).toBeDefined();
    expect(insertedRow["clientMembershipId"]).toBe(CLIENT_MEMBERSHIP_ID);
  });

  it("leaves clientMembershipId undefined in the INSERT when clientId is not provided", async () => {
    const { db, txInsert } = makeDb();
    const svc = makeSvc(db);

    await svc.createProject(ORG, CREATOR, { name: "Test Project" });

    expect(txInsert.values).toHaveBeenCalled();
    const insertedRow = txInsert.values.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(insertedRow).toBeDefined();
    expect(insertedRow["clientMembershipId"]).toBeUndefined();
  });
});
